import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { OpenAiCompatibleProvider } from '../server/llm/providers/openaiCompatible.js';
import { YandexGptProvider } from '../server/llm/providers/yandex.js';
import { OllamaProvider } from '../server/llm/providers/ollama.js';
import { MockProvider } from '../server/llm/providers/mock.js';
import { ProviderRegistry, registryFromEnv } from '../server/llm/registry.js';
import { LlmCallFailed, LlmService } from '../server/llm/service.js';
import { CallLog } from '../server/llm/callLog.js';
import { LlmError } from '../server/llm/types.js';
import { confirmDraft, formalize } from '../server/llm/formalize.js';
import { verifyExplanation, explainRun, plainExplanation } from '../server/llm/explain.js';
import { heuristicDraft } from '../server/llm/heuristic.js';
import { solve, type SensitivityReport } from '../shared/engine/index.js';
import { supplierDemo, validateProblem } from '../shared/problem/index.js';
import { clone, exactProblem } from './helpers.js';

const KEY = 'sk-test-SECRET-0123456789abcdef';

type Call = { url: string; init: RequestInit };
function fakeFetch(respond: (c: Call) => Response | Promise<Response>): { fetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const f = (async (url: string | URL, init?: RequestInit) => {
    const c = { url: String(url), init: init ?? {} };
    calls.push(c);
    return respond(c);
  }) as typeof fetch;
  return { fetch: f, calls };
}
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

function openai(f: typeof fetch, timeoutMs = 5000) {
  return new OpenAiCompatibleProvider({
    id: 'openai', kind: 'openai', title: 'OpenAI', baseUrl: 'https://api.example.test/v1', model: 'gpt-test',
    apiKey: KEY, requireKey: true, timeoutMs, pricing: { input_per_1m: 1, output_per_1m: 2, currency: 'USD' }, local: false, fetchImpl: f,
  });
}

async function rejects(p: Promise<unknown>, code: string): Promise<LlmError> {
  try {
    await p;
  } catch (e) {
    assert.ok(e instanceof LlmError, `ожидалась LlmError, получено ${e}`);
    assert.equal(e.code, code);
    assert.ok(!e.message.includes(KEY), 'секрет попал в сообщение об ошибке');
    return e;
  }
  assert.fail(`ожидалась ошибка ${code}`);
}

describe('адаптеры провайдеров (контракт)', () => {
  test('OpenAI: формат запроса, JSON-режим, разбор usage и версии модели', async () => {
    const ff = fakeFetch(() =>
      json({ id: 'req-1', model: 'gpt-test-2026-01-01', choices: [{ message: { content: '{"a":1}' }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }),
    );
    const r = await openai(ff.fetch).complete({ messages: [{ role: 'user', content: 'hi' }], json: true, temperature: 0, maxTokens: 50 });
    const c = ff.calls[0];
    assert.equal(c.url, 'https://api.example.test/v1/chat/completions');
    assert.equal((c.init.headers as Record<string, string>).Authorization, `Bearer ${KEY}`);
    const body = JSON.parse(String(c.init.body));
    assert.deepEqual(body.response_format, { type: 'json_object' });
    assert.equal(body.model, 'gpt-test');
    assert.equal(body.max_tokens, 50);
    assert.equal(r.text, '{"a":1}');
    assert.equal(r.model_version, 'gpt-test-2026-01-01');
    assert.deepEqual(r.usage, { input_tokens: 10, output_tokens: 5, total_tokens: 15 });
  });

  test('ошибки HTTP классифицируются; ключ не попадает в сообщение', async () => {
    const cases: [number, string][] = [[401, 'auth'], [403, 'auth'], [429, 'rate_limit'], [500, 'unavailable'], [503, 'unavailable'], [400, 'bad_request']];
    for (const [status, code] of cases) {
      const ff = fakeFetch(() => json({ error: { message: `bad key ${KEY} Bearer ${KEY}` } }, status, status === 429 ? { 'retry-after': '3' } : {}));
      const e = await rejects(openai(ff.fetch).complete({ messages: [{ role: 'user', content: 'x' }] }), code);
      if (status === 429) assert.equal(e.retryAfterSec, 3);
    }
  });

  test('тайм-аут и некорректный ответ', async () => {
    const hang = fakeFetch(
      (c) =>
        new Promise<Response>((_res, rej) => {
          c.init.signal?.addEventListener('abort', () => rej(new DOMException('aborted', 'AbortError')));
        }),
    );
    await rejects(openai(hang.fetch, 50).complete({ messages: [{ role: 'user', content: 'x' }] }), 'timeout');
    const notJson = fakeFetch(() => new Response('<html>', { status: 200 }));
    await rejects(openai(notJson.fetch).complete({ messages: [{ role: 'user', content: 'x' }] }), 'bad_response');
    const noContent = fakeFetch(() => json({ choices: [] }));
    await rejects(openai(noContent.fetch).complete({ messages: [{ role: 'user', content: 'x' }] }), 'bad_response');
    const net = fakeFetch(() => {
      throw new TypeError('fetch failed');
    });
    await rejects(openai(net.fetch).complete({ messages: [{ role: 'user', content: 'x' }] }), 'unavailable');
  });

  test('не настроенный провайдер даёт ошибку config без сетевого вызова', async () => {
    const ff = fakeFetch(() => json({}));
    const p = new OpenAiCompatibleProvider({ id: 'openai', kind: 'openai', title: 'x', baseUrl: 'https://a.test/v1', model: 'm', requireKey: true, timeoutMs: 1000, pricing: null, local: false, fetchImpl: ff.fetch });
    assert.deepEqual(p.info.missing, ['OPENAI_API_KEY']);
    await rejects(p.complete({ messages: [{ role: 'user', content: 'x' }] }), 'config');
    assert.equal(ff.calls.length, 0);
  });

  test('YandexGPT: modelUri, Api-Key, x-folder-id, jsonObject; usage строками', async () => {
    const ff = fakeFetch(() =>
      json({ result: { alternatives: [{ message: { role: 'assistant', text: '{"ok":true}' }, status: 'ALTERNATIVE_STATUS_FINAL' }], usage: { inputTextTokens: '12', completionTokens: '3', totalTokens: '15' }, modelVersion: '23.10.2026' } }),
    );
    const p = new YandexGptProvider({ baseUrl: 'https://llm.example.test', folderId: 'b1gfolder', apiKey: KEY, model: 'yandexgpt-lite/latest', timeoutMs: 5000, pricing: null, fetchImpl: ff.fetch });
    const r = await p.complete({ messages: [{ role: 'system', content: 's' }, { role: 'user', content: 'u' }], json: true, maxTokens: 100 });
    const c = ff.calls[0];
    assert.equal(c.url, 'https://llm.example.test/foundationModels/v1/completion');
    const h = c.init.headers as Record<string, string>;
    assert.equal(h.Authorization, `Api-Key ${KEY}`);
    assert.equal(h['x-folder-id'], 'b1gfolder');
    const body = JSON.parse(String(c.init.body));
    assert.equal(body.modelUri, 'gpt://b1gfolder/yandexgpt-lite/latest');
    assert.equal(body.jsonObject, true);
    assert.equal(body.completionOptions.maxTokens, '100');
    assert.deepEqual(body.messages[1], { role: 'user', text: 'u' });
    assert.equal(r.text, '{"ok":true}');
    assert.deepEqual(r.usage, { input_tokens: 12, output_tokens: 3, total_tokens: 15 });
    assert.equal(r.model_version, '23.10.2026');
  });

  test('YandexGPT: фильтр контента и отсутствие каталога', async () => {
    const ff = fakeFetch(() => json({ result: { alternatives: [{ message: { text: '' }, status: 'ALTERNATIVE_STATUS_CONTENT_FILTER' }] } }));
    const p = new YandexGptProvider({ baseUrl: 'https://llm.example.test', folderId: 'f', apiKey: KEY, model: 'm', timeoutMs: 5000, pricing: null, fetchImpl: ff.fetch });
    await rejects(p.complete({ messages: [{ role: 'user', content: 'x' }] }), 'content_filter');
    const q = new YandexGptProvider({ baseUrl: 'https://llm.example.test', apiKey: KEY, model: 'm', timeoutMs: 5000, pricing: null });
    assert.equal(q.info.configured, false);
    assert.ok(q.info.missing.includes('YANDEX_FOLDER_ID'));
  });

  test('Ollama: /api/chat с format=json и проверка модели через /api/tags', async () => {
    const ff = fakeFetch((c) =>
      c.url.endsWith('/api/tags')
        ? json({ models: [{ name: 'qwen2.5:7b-instruct' }] })
        : json({ model: 'qwen2.5:7b-instruct', message: { content: '{"x":2}' }, done_reason: 'stop', prompt_eval_count: 7, eval_count: 4 }),
    );
    const p = new OllamaProvider({ baseUrl: 'http://ollama.test:11434', model: 'qwen2.5:7b-instruct', timeoutMs: 5000, fetchImpl: ff.fetch });
    const r = await p.complete({ messages: [{ role: 'user', content: 'x' }], json: true });
    const body = JSON.parse(String(ff.calls[0].init.body));
    assert.equal(body.format, 'json');
    assert.equal(body.stream, false);
    assert.deepEqual(r.usage, { input_tokens: 7, output_tokens: 4, total_tokens: 11 });
    const h = await p.health();
    assert.equal(h.ok, true);
    assert.equal(h.spends_tokens, false);
    const missing = new OllamaProvider({ baseUrl: 'http://ollama.test:11434', model: 'llama3', timeoutMs: 5000, fetchImpl: ff.fetch });
    assert.equal((await missing.health()).ok, false);
  });

  test('реестр из env: секреты не отражаются в описании провайдеров', () => {
    const reg = registryFromEnv({ LLM_PROVIDER: 'yandexgpt', LLM_FALLBACK: 'ollama,mock', OPENAI_API_KEY: KEY, YANDEX_API_KEY: KEY, YANDEX_FOLDER_ID: 'f' });
    assert.equal(reg.defaultId, 'yandexgpt');
    assert.deepEqual(reg.fallback, ['ollama', 'mock']);
    assert.ok(!JSON.stringify(reg.list()).includes(KEY));
    const bad = registryFromEnv({ LLM_PROVIDER: 'gpt5' });
    assert.ok(bad.configErrors.length > 0);
  });
});

function service(providers: MockProvider[], def: string, fallback: string[] = []) {
  return new LlmService(new ProviderRegistry(providers, def, fallback), new CallLog(), { maxRetries: 1, retryDelayMs: 0 });
}

describe('сервис вызовов: явный fallback и метаданные', () => {
  test('без LLM_FALLBACK ошибка не маскируется', async () => {
    const svc = service([new MockProvider({ id: 'a', failWith: 'auth' })], 'a');
    await assert.rejects(svc.call('chat', { messages: [{ role: 'user', content: 'x' }] }), (e) => e instanceof LlmCallFailed && e.last.code === 'auth');
    assert.equal(svc.log.list().length, 1);
    assert.equal(svc.log.list()[0].status, 'error');
  });

  test('повтор при 429/тайм-ауте, затем явный fallback с отметкой fallback_from', async () => {
    const a = new MockProvider({ id: 'a', script: [{ error: 'timeout' }, { error: 'timeout' }] });
    const b = new MockProvider({ id: 'b', script: ['{"ok":1}'] });
    const svc = service([a, b], 'a', ['b']);
    const out = await svc.call('formalize', { messages: [{ role: 'user', content: 'x' }] });
    assert.equal(out.record.provider, 'b');
    assert.equal(out.record.fallback_from, 'a');
    assert.equal(out.record.fallback_reason, 'timeout');
    assert.equal(out.attempts.length, 3);
    assert.equal(a.calls.length, 2, 'тайм-аут повторяется один раз');
  });

  test('явно выбранный провайдер не подменяется резервным', async () => {
    const svc = service([new MockProvider({ id: 'a', failWith: 'unavailable' }), new MockProvider({ id: 'b' })], 'b', ['b']);
    await assert.rejects(svc.call('benchmark', { messages: [{ role: 'user', content: 'x' }] }, { provider: 'a' }));
  });

  test('метаданные вызова: хеши вместо текста, токены, оценка стоимости', async () => {
    const svc = service([new MockProvider({ id: 'a', script: ['ответ'] })], 'a');
    const out = await svc.call('chat', { messages: [{ role: 'user', content: 'секретные данные клиента' }], temperature: 0.3, maxTokens: 99 });
    const rec = out.record;
    assert.match(rec.prompt_sha256, /^[0-9a-f]{64}$/);
    assert.equal(rec.temperature, 0.3);
    assert.equal(rec.max_tokens, 99);
    assert.ok(!JSON.stringify(rec).includes('секретные данные'));
  });
});

const SOURCE = `Выбираем поставщика упаковки.
Альфа: цена 480–500 руб., срок 5 дней, брак 1,5%
Бета: цена 450 руб., срок 7 дней
Цена важнее срока. Бюджет не дороже 520 руб.`;

describe('формализация: черновик, трассировка, подтверждение', () => {
  test('выдуманные альтернативы и числа отбрасываются и попадают в отчёт', async () => {
    const reply = JSON.stringify({
      context: { title: 'Поставщик упаковки' },
      alternatives: [
        { id: 'alfa', name: 'Альфа', source_quote: 'Альфа: цена 480–500 руб.' },
        { id: 'beta', name: 'Бета', source_quote: 'Бета: цена 450 руб.' },
        { id: 'gamma', name: 'Гамма', source_quote: 'Гамма лучший' },
      ],
      criteria: [
        { id: 'price', name: 'Цена', direction: 'min', direction_basis: 'domain_default', unit: 'руб.', source_quote: 'цена 480–500 руб.' },
        { id: 'lead', name: 'Срок', direction: 'min', direction_basis: 'domain_default', source_quote: 'срок 5 дней' },
        { id: 'defect', name: 'Брак', direction: 'min', direction_basis: 'domain_default', source_quote: 'брак 1,5%' },
      ],
      evaluations: [
        { alternative: 'alfa', criterion: 'price', lower: 480, upper: 500, source_quote: 'цена 480–500 руб.' },
        { alternative: 'alfa', criterion: 'lead', value: 5, source_quote: 'срок 5 дней' },
        { alternative: 'alfa', criterion: 'defect', value: 1.5, source_quote: 'брак 1,5%' },
        { alternative: 'beta', criterion: 'price', value: 450, source_quote: 'цена 450 руб.' },
        { alternative: 'beta', criterion: 'lead', value: 7, source_quote: 'срок 7 дней' },
        { alternative: 'beta', criterion: 'defect', value: 2.1, source_quote: 'брак 2.1%' },
        { alternative: 'gamma', criterion: 'price', value: 400 },
      ],
      weights: [],
      weight_order: [{ greater: 'price', lesser: 'lead', source_quote: 'Цена важнее срока' }],
      constraints: [{ kind: 'threshold', criterion: 'price', op: '<=', value: 520, source_quote: 'не дороже 520 руб.' }],
      unknowns: ['брак Беты'],
      questions: ['Каков процент брака у Беты?'],
    });
    const svc = service([new MockProvider({ id: 'm', script: [reply] })], 'm');
    const out = await formalize(svc, SOURCE);
    assert.equal(out.status, 'ok');
    if (out.status !== 'ok') return;
    const p = out.problem;
    assert.equal(p.metadata.status, 'draft');
    assert.equal(p.metadata.origin, 'llm');
    assert.deepEqual(p.alternatives.map((a) => a.alternative_id), ['alfa', 'beta']);
    assert.ok(out.hallucinations.some((h) => h.element === 'alternative' && h.value === 'Гамма'));
    assert.ok(out.hallucinations.some((h) => h.element === 'evaluation' && h.value === 2.1));
    const betaDefect = p.evaluations.find((e) => e.alternative_id === 'beta' && e.criterion_id === 'defect')!;
    assert.equal(betaDefect.value.kind, 'missing');
    assert.ok(out.unknown_fields.some((u) => u.path === 'evaluations[beta,defect]'));
    assert.deepEqual(p.evaluations.find((e) => e.alternative_id === 'alfa' && e.criterion_id === 'price')!.value, { kind: 'interval', lower: 480, upper: 500 });
    assert.deepEqual(p.weights.ordinal, [{ greater: 'price', lesser: 'lead' }]);
    assert.equal(p.constraints.length, 1);
    assert.equal(out.schema_valid, true);
    assert.equal((p.metadata.llm as { provider: string }).provider, 'm');
    assert.ok(out.trace.every((t) => t.status === 'dropped' || t.quote_verified || t.element === 'weight_order'));
  });

  test('проценты весов переводятся в доли, сумма ≠ 1 не нормируется и блокирует подтверждение', async () => {
    const reply = JSON.stringify({
      alternatives: [{ name: 'Альфа', source_quote: 'Альфа' }, { name: 'Бета', source_quote: 'Бета' }],
      criteria: [{ id: 'price', name: 'Цена', direction: 'min', direction_basis: 'explicit', source_quote: 'цена' }, { id: 'lead', name: 'Срок', direction: 'min', direction_basis: 'explicit', source_quote: 'срок' }],
      evaluations: [],
      weights: [{ criterion: 'price', value: 60, unit: 'percent', source_quote: 'вес цены 60%' }, { criterion: 'lead', value: 30, unit: 'percent', source_quote: 'срока 30%' }],
    });
    const text = 'Альфа и Бета. Критерии: цена и срок, вес цены 60%, срока 30%.';
    const svc = service([new MockProvider({ id: 'm', script: [reply] })], 'm');
    const out = await formalize(svc, text);
    assert.equal(out.status, 'ok');
    if (out.status !== 'ok') return;
    assert.deepEqual(out.problem.weights.items.map((w) => w.value), [0.6, 0.3]);
    assert.ok(out.normalization_log.some((l) => l.includes('НЕ нормированы')));
    const blocked = confirmDraft(out.problem, []);
    assert.equal(blocked.ok, false);
    assert.ok(blocked.unresolved.some((u) => u.path === 'weights'));
  });

  test('некорректный JSON и ошибка провайдера возвращаются явно', async () => {
    const bad = await formalize(service([new MockProvider({ id: 'm', script: ['это не json'] })], 'm'), SOURCE);
    assert.equal(bad.status, 'invalid_json');
    const down = await formalize(service([new MockProvider({ id: 'm', failWith: 'rate_limit' })], 'm'), SOURCE);
    assert.equal(down.status, 'llm_error');
    assert.match(down.provider_notice, /LLM недоступна/);
  });

  test('офлайн-режим (mock = эталон по правилам) даёт подтверждаемую задачу, которую можно решить', async () => {
    const out = await formalize(service([new MockProvider()], 'mock'), SOURCE);
    assert.equal(out.status, 'ok');
    if (out.status !== 'ok') return;
    assert.equal(out.hallucinations.length, 0);
    const p = clone(out.problem);
    for (const c of p.criteria) c.missing_policy = 'worst_observed';
    const conf = confirmDraft(p, out.unknown_fields.filter((u) => u.blocking).map((u) => u.path));
    assert.equal(conf.ok, true, JSON.stringify(conf.unresolved));
    assert.equal(conf.problem!.metadata.status, 'confirmed');
    const run = solve(conf.problem!, { overrides: { mode: 'MU_WU', iterations: 300 } });
    assert.equal(run.alternatives_kept.length, 2);
  });

  test('эвристика: десятичная запятая, интервалы, ограничение, порядок важности', () => {
    const d = heuristicDraft(SOURCE);
    assert.deepEqual(d.alternatives!.map((a) => a.name), ['Альфа', 'Бета']);
    const defect = d.evaluations!.find((e) => e.alternative === 'Альфа' && e.criterion === 'defect_rate');
    assert.equal(defect?.value, 1.5);
    assert.equal(d.evaluations!.find((e) => e.alternative === 'Альфа' && e.criterion === 'price')?.lower, 480);
    assert.ok(d.constraints!.some((c) => c.criterion === 'price' && c.value === 520));
    assert.deepEqual(d.weight_order, [{ greater: 'price', lesser: 'lead_time', source_quote: 'Цена важнее срока.' }]);
  });
});

describe('объяснение не может менять результаты', () => {
  test('понятное объяснение различает частоту побед и отдельную проверку чувствительности', () => {
    const run = solve(clone(supplierDemo), { overrides: { iterations: 300 } });
    const [first, second] = run.primary.ranking.map((id) => run.primary.alternatives.find((a) => a.alternative_id === id)!);
    first.name = 'Дельта Партнёр';
    first.p_best = 0.331;
    second.name = 'Гамма Трейд';
    const sens: SensitivityReport = {
      base: { method: run.settings.method, weights: {}, weights_source: 'sample_mean', leader_ids: [first.alternative_id] },
      weights: [], summary: [], notes: [], scanned_cells: 0,
      critical: [{ type: 'weight', criterion_id: 'lead', label: 'w(Срок поставки)', base_value: 0.3974,
        flip_at: 0.4155, abs_delta: 0.0181, relative_delta: 0.0181, new_leader_ids: [second.alternative_id] }],
    };
    const text = plainExplanation(run, sens);
    assert.match(text, /Дельта Партнёр — примерно в 33% проверенных сценариев/);
    assert.match(text, /Ближайший конкурент — Гамма Трейд/);
    assert.match(text, /не гарантируют успех/);
    assert.match(text, /отдельной проверке.*важность критерия «Срок поставки».*остальные исходные данные/);
    assert.doesNotMatch(text, /pBest|TOPSIS|seed|Монте|0\.4155|w\(/);
  });

  test('фиксированный расчёт с ничьей не обещает устойчивость и не назначает единственного лидера', () => {
    const run = solve(exactProblem({ matrix: [[1, 2], [1, 2]], directions: ['min', 'max'], weights: [0.5, 0.5] }));
    const text = plainExplanation(run);
    assert.match(text, /одинаковый лучший результат/);
    assert.match(text, /не показывает, сохранится ли результат/);
    assert.doesNotMatch(text, /%|чаще всего побеждает/);
  });

  test('mock и недоступная модель дают понятный текст с честным источником', async () => {
    const run = solve(clone(supplierDemo), { overrides: { iterations: 300 } });
    for (const llm of [null, service([new MockProvider()], 'mock'), service([new MockProvider({ failWith: 'auth' })], 'mock')]) {
      const e = await explainRun(llm, run, null);
      assert.equal(e.source, 'deterministic');
      assert.equal(e.text, plainExplanation(run));
      assert.doesNotMatch(e.text, /pBest|seed|Принято|"reply"/);
    }
  });

  test('понятный ответ модели сохраняется, а техническая сводка заменяется', async () => {
    const run = solve(clone(supplierDemo), { overrides: { iterations: 300 } });
    for (const [reply, source] of [['Вывод зависит от исходных данных.', 'llm'], ['TOPSIS: pBest = 1.', 'deterministic']] as const) {
      const provider = new MockProvider({ script: [reply] });
      // Exercise model output validation through the same service without network calls.
      provider.info.kind = 'openai';
      const e = await explainRun(service([provider], 'mock'), run, null);
      assert.equal(e.source, source);
      assert.equal(e.text, source === 'llm' ? reply : plainExplanation(run));
      if (source === 'deterministic') assert.match(e.rejected!.reason, /техническую сводку/);
    }
  });

  test('числа вне результата отклоняются', () => {
    const payload = { ranking: [{ name: 'A', p_best: 0.617 }], iterations: 2000 };
    assert.equal(verifyExplanation('A лидирует в 61.7% сценариев из 2000.', payload).ok, true);
    assert.equal(verifyExplanation('A лидирует в 62% случаев.', payload).ok, true);
    const bad = verifyExplanation('A лидирует в 75% случаев и сэкономит 120 тыс.', payload);
    assert.equal(bad.ok, false);
    assert.deepEqual(bad.unknown_numbers, [75, 120]);
  });

  test('при выдуманных числах используется детерминированная сводка', async () => {
    const run = solve(clone(supplierDemo), { overrides: { iterations: 300 } });
    const svc = service([new MockProvider({ id: 'm', script: ['Лидер выигрывает в 99.9% случаев.'] })], 'm');
    const e = await explainRun(svc, run, null);
    assert.equal(e.source, 'deterministic');
    assert.ok(e.rejected);
    assert.ok(e.text.length > 0);
  });

  test('ядро работает без LLM', () => {
    const rep = validateProblem(clone(supplierDemo), { forRun: true });
    assert.equal(rep.ok, true);
    assert.ok(solve(clone(supplierDemo), { overrides: { iterations: 200 } }).primary.ranking.length === 4);
  });
});
