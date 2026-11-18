import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createApp } from '../server/app.js';
import type { AppConfig } from '../server/deps.js';
import { MemoryRunStore } from '../server/experiments/store.js';
import { silentLogger } from '../server/http/logger.js';
import { serviceFromEnv } from '../server/llm/registry.js';
import { applyDemoSuppliers } from '../shared/demo.js';
import { supplierDemo } from '../shared/problem/index.js';
import { emptySession } from '../shared/types.js';
import { clone } from './helpers.js';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { demoDataset } from '../shared/ecommerce/demo.js';
import { csvToObjects } from '../shared/csv.js';
import { suggestMapping } from '../shared/ecommerce/fields.js';

const appInfo = { name: 'opora-dss', version: '1.0.0-test', commit: null, commit_source: null, worktree_dirty: null, node: process.version, platform: 'test' } as const;

function config(over: Partial<AppConfig> = {}): AppConfig {
  return { corsOrigins: null, apiToken: null, jsonLimit: '64kb', uploadLimit: '1mb', llmRatePerMinute: 0, distDir: null, dataDir: null, trustProxy: false, ...over };
}

async function start(over: Partial<AppConfig> = {}, env: Record<string, string> = { LLM_PROVIDER: 'mock' }) {
  const app = createApp({
    app: { ...appInfo },
    llm: serviceFromEnv(env),
    store: new MemoryRunStore(),
    logger: silentLogger,
    config: config(over),
    startedAt: new Date(),
  });
  const server: Server = await new Promise((r) => {
    const s = app.listen(0, '127.0.0.1', () => r(s));
  });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { server, base };
}

async function call(base: string, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(base + path, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  });
  const text = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* csv or text */
  }
  return { status: res.status, json, text, headers: res.headers };
}

describe('HTTP API v1', () => {
  let srv: Awaited<ReturnType<typeof start>>;
  before(async () => {
    srv = await start();
  });
  after(() => srv.server.close());

  test('benchmark API: контрольный набор, mock-сравнение и проверка выбранных случаев', async () => {
    const cases = await call(srv.base, 'GET', '/api/v1/llm-benchmark/cases');
    assert.equal(cases.status, 200);
    assert.equal(cases.json.cases.length, 36);
    const report = await call(srv.base, 'POST', '/api/v1/llm-benchmark', { providers: ['mock'], case_ids: [cases.json.cases[0].case_id] });
    assert.equal(report.status, 200, report.text);
    assert.equal(report.json.rows.length, 1);
    assert.equal(report.json.rows[0].provider, 'mock');
    assert.equal(report.json.settings.fallback, false);
    assert.equal((await call(srv.base, 'POST', '/api/v1/llm-benchmark', { providers: ['mock'], case_ids: ['unknown'] })).status, 400);
    assert.equal((await call(srv.base, 'POST', '/api/v1/llm-benchmark', { providers: ['mock'], case_ids: [] })).status, 400);
  });

  test('ecommerce: demo → inspect → mapping → problem → rolling backtest без LLM', async () => {
    const demo = await call(srv.base, 'GET', '/api/v1/ecommerce/demo-dataset');
    assert.equal(demo.status, 200);
    assert.equal(demo.text.replace(/^\ufeff/, ''), demoDataset());
    const content = demoDataset();
    const inspect = await call(srv.base, 'POST', '/api/v1/ecommerce/inspect', { content });
    assert.equal(inspect.status, 200);
    assert.equal(inspect.json.rows, 144);
    const mapping = suggestMapping(csvToObjects(content).header);
    const body = { content, mapping, period: 'month' };
    assert.equal((await call(srv.base, 'POST', '/api/v1/ecommerce/mapping', body)).status, 200);
    const p = await call(srv.base, 'POST', '/api/v1/ecommerce/problem', { ...body, sku: 'SYNTH-1', cutoff: '2023-01', config: { assumptions: { bootstrap: 40 } } });
    assert.equal(p.status, 200, p.text);
    assert.equal(p.json.problem.metadata.status, 'draft');
    const bt = await call(srv.base, 'POST', '/api/v1/ecommerce/backtest', { ...body, backtest: { sku: 'SYNTH-1', first_test: '2023-01', last_test: '2023-01', iterations: 20 }, config: { assumptions: { bootstrap: 40 } } });
    assert.equal(bt.status, 200, bt.text);
    assert.equal(bt.json.folds[0].runs.length, 4);
    const bad = await call(srv.base, 'POST', '/api/v1/ecommerce/backtest', { ...body, backtest: { sku: 'missing', first_test: '2023-01' } });
    assert.equal(bad.status, 400);
    assert.equal(bad.json.code, 'dataset_invalid');
    assert.equal((await call(srv.base, 'POST', '/api/v1/ecommerce/problem', { ...body, sku: 'SYNTH-1', cutoff: '2023-01', config: { assumptions: { horizon: 0 } } })).status, 400);
  });

  test('health: версия, ядро, статус LLM без секретов; заголовки безопасности', async () => {
    const r = await call(srv.base, 'GET', '/api/health');
    assert.equal(r.status, 200);
    assert.equal(r.json.version, '1.0.0-test');
    assert.equal(r.json.llm.default, 'mock');
    assert.equal(r.json.llm.default_configured, true);
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
    assert.ok(r.headers.get('content-security-policy')?.includes("default-src 'self'"));
    assert.ok(r.headers.get('x-request-id'));
  });

  test('схема, примеры, валидация с понятной ошибкой весов', async () => {
    assert.equal((await call(srv.base, 'GET', '/api/v1/problems/schema')).json.type, 'object');
    const ex = await call(srv.base, 'GET', '/api/v1/problems/examples');
    assert.ok(ex.json.examples.length >= 3);
    const p = clone(supplierDemo);
    for (const w of p.weights.items) Object.assign(w, { value: undefined, lower: 0.3, upper: 0.5 });
    const v = await call(srv.base, 'POST', '/api/v1/problems/validate', { problem: p, for_run: true });
    assert.equal(v.json.ok, false);
    assert.ok(v.json.issues.some((i: { message: string }) => /допустимого нормированного вектора весов не существует/.test(i.message)));
  });

  test('расчёт → получение → повтор → экспорт', async () => {
    const run = await call(srv.base, 'POST', '/api/v1/runs', { problem: supplierDemo, overrides: { iterations: 300 } });
    assert.equal(run.status, 201);
    const id = run.json.experiment_id;
    assert.equal(run.json.runs.length, 4);
    assert.equal((await call(srv.base, 'GET', `/api/v1/experiments/${id}`)).json.experiment_id, id);
    const rep = await call(srv.base, 'POST', `/api/v1/experiments/${id}/repeat`);
    assert.equal(rep.json.verification.same_result, true);
    const csv = await call(srv.base, 'GET', `/api/v1/experiments/${id}/export?format=csv&table=ranking`);
    assert.equal(csv.status, 200);
    assert.match(csv.headers.get('content-type') ?? '', /text\/csv/);
    assert.ok(csv.text.includes('p_best_mcse'));
    const list = await call(srv.base, 'GET', '/api/v1/experiments');
    assert.equal(list.json.experiments.length, 2);
  });

  test('чувствительность: порог смены лидера по весу', async () => {
    const r = await call(srv.base, 'POST', '/api/v1/sensitivity', { analysis: 'weight', problem: supplierDemo, criterion_id: 'lead_time' });
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(r.json.statements));
  });

  test('черновик LLM: формализация → 409 без подтверждения → подтверждение → расчёт', async () => {
    const text = 'Выбор поставщика.\nАльфа: цена 480 руб., срок 5 дней\nБета: цена 450 руб., срок 7 дней';
    const f = await call(srv.base, 'POST', '/api/v1/problems/formalize', { text });
    assert.equal(f.status, 200);
    assert.equal(f.json.problem.metadata.status, 'draft');
    assert.match(f.json.provider_notice, /mock/);
    const blocked = await call(srv.base, 'POST', '/api/v1/runs', { problem: f.json.problem, overrides: { iterations: 100 } });
    assert.equal(blocked.status, 409);
    const conf = await call(srv.base, 'POST', '/api/v1/problems/confirm', { problem: f.json.problem, resolved: [] });
    assert.equal(conf.status, 200, JSON.stringify(conf.json));
    const ok = await call(srv.base, 'POST', '/api/v1/runs', { problem: conf.json.problem, overrides: { iterations: 100 }, modes: ['MF_WU'] });
    assert.equal(ok.status, 201);
  });

  test('импорт CSV и пакет', async () => {
    const csv = 'alt,price,quality\n#direction,min,max\nA,10,5\nB,12,7\n';
    const imp = await call(srv.base, 'POST', '/api/v1/problems/import', { format: 'csv', content: csv });
    assert.equal(imp.json.problems[0].alternatives.length, 2);
    const b = await call(srv.base, 'POST', '/api/v1/experiments/batch', { items: [{ name: 'a.csv', format: 'csv', content: csv }], sensitivity: false, overrides: { iterations: 100 } });
    assert.equal(b.status, 201);
    const exp = await call(srv.base, 'GET', `/api/v1/batches/${b.json.batch.batch_id}/export`);
    assert.ok(exp.text.includes('tau_vs_mode1'));
  });

  test('ошибки запросов: неверный JSON, лишние поля, размер, неизвестный маршрут', async () => {
    assert.equal((await call(srv.base, 'POST', '/api/v1/problems/validate', '{bad')).status, 400);
    const extra = await call(srv.base, 'POST', '/api/v1/runs', { problem: supplierDemo, hack: 1 });
    assert.equal(extra.status, 400);
    assert.equal(extra.json.code, 'bad_request');
    assert.equal((await call(srv.base, 'POST', '/api/v1/problems/validate', { problem: 'x'.repeat(70_000) })).status, 413);
    assert.equal((await call(srv.base, 'GET', '/api/v1/nope')).status, 404);
    assert.equal((await call(srv.base, 'GET', '/api/v1/experiments/..%2F..%2Fetc')).status, 404);
  });

  test('провайдеры LLM: список без секретов', async () => {
    const r = await call(srv.base, 'GET', '/api/v1/llm/providers');
    assert.ok(r.json.providers.some((p: { id: string }) => p.id === 'yandexgpt'));
    const h = await call(srv.base, 'POST', '/api/v1/llm/health', { provider: 'mock' });
    assert.equal(h.json.ok, true);
  });

  test('legacy-чат и анализ: использованный провайдер указан явно', async () => {
    const chat = await call(srv.base, 'POST', '/api/chat', { message: 'Нужно выбрать поставщика по цене и сроку', session: emptySession() });
    assert.equal(chat.status, 200);
    assert.ok(chat.json.llm);
    const an = await call(srv.base, 'POST', '/api/analyze', { session: applyDemoSuppliers(emptySession()), samples: 300 });
    assert.equal(an.status, 200);
    assert.ok(an.json.analysis.mode);
    assert.ok(['llm', 'deterministic'].includes(an.json.explanation_meta.source));
  });
});

describe('HTTP API: защита', () => {
  test('SPA /lab: index из dist под скрытым каталогом; API не подменяется HTML', async () => {
    const distDir = await mkdtemp(path.join(tmpdir(), '.lab-static-'));
    await writeFile(path.join(distDir, 'index.html'), '<html><body>lab fixture</body></html>');
    const s = await start({ distDir });
    try {
      const lab = await call(s.base, 'GET', '/lab');
      assert.equal(lab.status, 200);
      assert.ok(lab.text.includes('lab fixture'));
      assert.equal((await call(s.base, 'GET', '/api/unknown')).status, 404);
    } finally {
      await new Promise<void>((resolve) => s.server.close(() => resolve()));
      if (path.dirname(distDir) === tmpdir() && path.basename(distDir).startsWith('.lab-static-')) await rm(distDir, { recursive: true, force: true });
    }
  });
  test('API_TOKEN: без токена 401, health открыт', async () => {
    const s = await start({ apiToken: 'tok-123456' });
    try {
      assert.equal((await call(s.base, 'GET', '/api/health')).status, 200);
      assert.equal((await call(s.base, 'GET', '/api/v1/experiments')).status, 401);
      assert.equal((await call(s.base, 'GET', '/api/v1/llm-benchmark/cases')).status, 401);
      assert.equal((await call(s.base, 'GET', '/api/v1/ecommerce/demo-dataset')).status, 401);
      assert.equal((await call(s.base, 'POST', '/api/v1/llm-benchmark', { providers: ['mock'], case_ids: ['sourcing-exact'] })).status, 401);
      assert.equal((await call(s.base, 'GET', '/api/v1/experiments', undefined, { authorization: 'Bearer tok-123456' })).status, 200);
    } finally {
      s.server.close();
    }
  });

  test('ограничение частоты для LLM-маршрутов', async () => {
    const s = await start({ llmRatePerMinute: 2 });
    try {
      const body = { text: 'Альфа: цена 1 руб.\nБета: цена 2 руб.' };
      assert.equal((await call(s.base, 'POST', '/api/v1/problems/formalize', body)).status, 200);
      assert.equal((await call(s.base, 'POST', '/api/v1/problems/formalize', body)).status, 200);
      const third = await call(s.base, 'POST', '/api/v1/problems/formalize', body);
      assert.equal(third.status, 429);
      assert.ok(third.headers.get('retry-after'));
    } finally {
      s.server.close();
    }
  });

  test('LLM не настроена: чат работает по правилам и сообщает об этом', async () => {
    const s = await start({}, { LLM_PROVIDER: 'openai' });
    try {
      const chat = await call(s.base, 'POST', '/api/chat', { message: 'выбор поставщика: цена, срок, брак', session: emptySession() });
      assert.equal(chat.status, 200);
      assert.equal(chat.json.llm.mode, 'rules');
      assert.match(chat.json.llm.notice, /не настроен|недоступна/);
    } finally {
      s.server.close();
    }
  });
});
