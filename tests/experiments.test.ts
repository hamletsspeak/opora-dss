import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseCsv, toCsv, CsvError } from '../shared/csv.js';
import { ImportError, tableCsvToProblem } from '../shared/import/table.js';
import { supplierDemo, thresholdControl, validateProblem } from '../shared/problem/index.js';
import { DraftNotConfirmedError, repeatExperiment, runExperiment } from '../server/experiments/runner.js';
import { exportCsv, rankingRows } from '../server/experiments/export.js';
import { runBatch } from '../server/experiments/batch.js';
import { FileRunStore, MemoryRunStore } from '../server/experiments/store.js';
import type { AppInfo } from '../server/appInfo.js';
import { clone } from './helpers.js';

const app: AppInfo = { name: 'opora-dss', version: '1.0.0-test', commit: 'abc123', commit_source: 'env', worktree_dirty: null, node: process.version, platform: 'test' };
const ctx = { app };

const CSV = `Поставщик;Цена;Срок;Брак
#direction;min;min;min
#id;price;lead;defect
#unit;руб.;дн.;%
#weight;0,4;0,35;0,25
#weight_lower;0,3;0,25;0,15
#weight_upper;0,5;0,45;0,35
#missing_policy;reject;reject;worst_observed
Альфа;480..500;5;1,5
Бета;450;6..8;
"Гамма ""Плюс""";470..475..490;7;97@0,7|88@0,3
`;

describe('CSV', () => {
  test('RFC 4180: кавычки, экранирование, CRLF, BOM, точка с запятой', () => {
    const rows = parseCsv('\ufeffa;b\r\n"x;1";"he said ""hi"""\r\n"multi\nline";2\r\n');
    assert.deepEqual(rows, [['a', 'b'], ['x;1', 'he said "hi"'], ['multi\nline', '2']]);
  });

  test('лимиты и незакрытая кавычка', () => {
    assert.throws(() => parseCsv('a,"b'), CsvError);
    assert.throws(() => parseCsv('a,b\n1,2\n3,4', { limits: { maxRows: 1 } }), CsvError);
    assert.throws(() => parseCsv('x'.repeat(100), { limits: { maxBytes: 10 } }), CsvError);
  });

  test('экспорт нейтрализует формулы, числа не трогает', () => {
    const out = toCsv(['a', 'b'], [{ a: '=HYPERLINK("http://x")', b: -0.5 }, { a: '+1', b: '@SUM(A1)' }]);
    assert.ok(out.includes(`"'=HYPERLINK(""http://x"")"`));
    assert.ok(out.includes(',-0.5'));
    assert.ok(out.includes("'+1"));
    assert.ok(out.includes("'@SUM(A1)"));
  });
});

describe('импорт таблицы', () => {
  test('синтаксис ячеек: точное, интервал, треугольное, сценарии, пропуск; десятичная запятая', () => {
    const { problem } = tableCsvToProblem(CSV, { problemId: 'csv-test' });
    const rep = validateProblem(problem, { forRun: true });
    assert.equal(rep.ok, true, JSON.stringify(rep.issues.filter((i) => i.severity === 'error')));
    const ev = (a: string, c: string) => problem.evaluations.find((e) => e.alternative_id === a && e.criterion_id === c)!.value;
    assert.deepEqual(ev('альфа', 'price'), { kind: 'interval', lower: 480, upper: 500 });
    assert.deepEqual(ev('альфа', 'defect'), { kind: 'exact', value: 1.5 });
    assert.equal(ev('бета', 'defect').kind, 'missing');
    assert.deepEqual(ev('гамма_плюс', 'price'), { kind: 'interval', lower: 470, upper: 490, distribution: 'triangular', mode: 475 });
    assert.equal(ev('гамма_плюс', 'defect').kind, 'scenarios');
    assert.deepEqual(problem.weights.items.map((w) => w.value), [0.4, 0.35, 0.25]);
    assert.equal(problem.uncertainty.mode, 'MU_WU');
    assert.equal(problem.alternatives[2].name, 'Гамма "Плюс"');
  });

  test('ошибки перечисляются, данные не исполняются', () => {
    const bad = 'alt,c1,c2\n#direction,min,up\nA,=1+1,2\nB,3,x';
    try {
      tableCsvToProblem(bad);
      assert.fail('ожидалась ошибка');
    } catch (e) {
      assert.ok(e instanceof ImportError);
      assert.ok(e.errors.some((m) => m.includes('#direction')));
      assert.ok(e.errors.some((m) => m.includes('=1+1')));
      assert.ok(e.errors.some((m) => m.includes('«x»')));
    }
  });
});

describe('эксперимент: 4 режима, паспорт, повтор', () => {
  test('все четыре режима; паспорт содержит версии, seed, N, хеши', () => {
    const rec = runExperiment({ problem: clone(supplierDemo), overrides: { iterations: 400 } }, ctx);
    assert.deepEqual(rec.runs.map((r) => [r.mode, r.status]), [['MF_WF', 'ok'], ['MU_WF', 'ok'], ['MF_WU', 'ok'], ['MU_WU', 'ok']]);
    const p = rec.passport;
    assert.equal(p.app.version, '1.0.0-test');
    assert.equal(p.app.commit, 'abc123');
    assert.equal(p.engine.name, 'opora-mcda');
    assert.equal(p.seed, 42);
    assert.deepEqual(p.iterations, { MF_WF: 1, MU_WF: 400, MF_WU: 400, MU_WU: 400 });
    assert.match(p.dataset.problem_sha256, /^[0-9a-f]{64}$/);
    assert.match(p.result_sha256, /^[0-9a-f]{64}$/);
    assert.ok(p.methods.topsis);
    assert.ok(rec.comparison && rec.sensitivity);
  });

  test('повтор с тем же seed даёт идентичный результат; другой seed — другой', () => {
    const rec = runExperiment({ problem: clone(supplierDemo), overrides: { iterations: 300 } }, ctx);
    const rep = repeatExperiment(rec, ctx);
    assert.equal(rep.verification!.same_result, true);
    assert.equal(rep.verification!.same_dataset, true);
    assert.equal(rep.verification!.same_config, true);
    assert.deepEqual(rep.verification!.differences, []);
    const other = runExperiment({ problem: clone(supplierDemo), overrides: { iterations: 300, seed: 7 } }, ctx);
    assert.notEqual(other.passport.result_sha256, rec.passport.result_sha256);
    assert.equal(other.passport.dataset.problem_sha256, rec.passport.dataset.problem_sha256);
  });

  test('невозможный режим даёт ошибку режима, остальные считаются', () => {
    const p = clone(supplierDemo);
    for (const w of p.weights.items) delete w.value;
    const rec = runExperiment({ problem: p, overrides: { iterations: 200 } }, ctx);
    const st = Object.fromEntries(rec.runs.map((r) => [r.mode, r.status]));
    assert.equal(st.MF_WF, 'error');
    assert.equal(st.MU_WU, 'ok');
    assert.ok(rec.passport.errors.some((e) => e.mode === 'MF_WF'));
  });

  test('вырожденные режимы помечаются предупреждением', () => {
    const rec = runExperiment({ problem: clone(thresholdControl), modes: ['MU_WF'] }, ctx);
    assert.ok(rec.passport.warnings.some((w) => w.code.startsWith('mode_degenerate')));
  });

  test('неподтверждённый черновик LLM нельзя рассчитать', () => {
    const p = clone(supplierDemo);
    p.metadata = { ...p.metadata, origin: 'llm', status: 'draft' };
    assert.throws(() => runExperiment({ problem: p }, ctx), DraftNotConfirmedError);
  });

  test('экспорт: строки рейтинга по режимам и методам, паспорт', () => {
    const rec = runExperiment({ problem: clone(supplierDemo), overrides: { iterations: 200 }, extra_methods: [{ id: 'wsm' }] }, ctx);
    assert.equal(rankingRows(rec).length, 4 * 2 * 4);
    const csv = exportCsv(rec, 'ranking');
    assert.ok(csv.startsWith('experiment_id,mode,mode_label,method'));
    assert.ok(exportCsv(rec, 'passport').includes('dataset.problem_sha256'));
    assert.ok(exportCsv(rec, 'comparison').includes('p_best_MU_WU'));
  });
});

describe('пакетный запуск и хранилище', () => {
  test('ошибка в одном файле не останавливает пакет', () => {
    const store = new MemoryRunStore();
    const { batch, records } = runBatch(
      [
        { name: 'ok.csv', format: 'csv', content: CSV },
        { name: 'bad.csv', format: 'csv', content: 'a,b\n1,2' },
        { name: 'two.json', format: 'json', content: JSON.stringify([supplierDemo, thresholdControl]) },
      ],
      { overrides: { iterations: 200 }, sensitivity: false },
      ctx,
      store,
    );
    assert.deepEqual(batch.items.map((i) => i.status), ['ok', 'error', 'ok', 'ok']);
    assert.equal(records.length, 3);
    assert.equal(store.list().length, 3);
    assert.ok(store.getBatch(batch.batch_id));
  });

  test('файловое хранилище: запись, чтение, список; защита от обхода пути', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opora-'));
    try {
      const store = new FileRunStore(dir);
      const rec = runExperiment({ problem: clone(thresholdControl) }, ctx);
      store.save(rec);
      assert.equal(store.get(rec.experiment_id)?.passport.result_sha256, rec.passport.result_sha256);
      assert.equal(new FileRunStore(dir).list()[0].experiment_id, rec.experiment_id);
      assert.equal(store.get('../../etc/passwd'), null);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
