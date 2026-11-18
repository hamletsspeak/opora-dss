import { test } from 'node:test';
import assert from 'node:assert/strict';
import { csvToObjects, toCsv } from '../shared/csv.js';
import { demoDataset } from '../shared/ecommerce/demo.js';
import { mappingErrors, suggestMapping } from '../shared/ecommerce/fields.js';
import { parseDate, parseEcomCsv } from '../shared/ecommerce/dataset.js';
import { prepareSku, runBacktest, cutoffIndex } from '../shared/ecommerce/backtest.js';
import { buildSkuProblem, resolveAssumptions } from '../shared/ecommerce/problem.js';
import { validateProblem } from '../shared/problem/index.js';

const content = demoDataset();
const { header, rows } = csvToObjects(content);
const mapping = suggestMapping(header);
const dataset = parseEcomCsv(content, mapping, { period: 'month' });
const config = { sku: 'SYNTH-1', first_test: '2023-01', last_test: '2023-04', train_periods: 24, test_periods: 3, step: 3, iterations: 40, seed: 23 };
const problemConfig = { assumptions: { bootstrap: 80 } };

test('ecommerce: воспроизводимое синтетическое демо, маппинг и агрегация', () => {
  assert.equal(demoDataset(), content);
  assert.notEqual(demoDataset(1), content);
  assert.equal(dataset.stats.rows, 144);
  assert.equal(dataset.skus.length, 3);
  assert.equal(dataset.skus[0].rows.length, 48);
  assert.equal(mapping.stock, 'stock');
  assert.equal(mappingErrors(mapping, header).length, 0);
  assert.ok(mappingErrors({ ...mapping, stock: 'price' }, header).length);
  const ru = suggestMapping(['Артикул', 'Дата', 'Продано', 'Выручка', 'Остаток']);
  assert.equal(ru.sku, 'Артикул');
  assert.equal(ru.units_sold, 'Продано');
});

test('ecommerce: признаки, интервалы и ranking неизменны при замене будущих значений', () => {
  const altered = rows.map((r) => r.date >= '2023-01' ? { ...r, units_sold: '999999', price: '999999', stock: '0', unit_cost: '1', ad_spend: '999999', lead_time_days: '300', returns_units: '999999' } : r);
  const future = parseEcomCsv(toCsv(header, altered), mapping, { period: 'month' });
  const a = runBacktest(dataset, { ...config, last_test: config.first_test }, problemConfig);
  const b = runBacktest(future, { ...config, last_test: config.first_test }, problemConfig);
  assert.deepEqual(a.folds[0].problem, b.folds[0].problem);
  assert.deepEqual(a.folds[0].runs, b.folds[0].runs);
  assert.deepEqual(a.folds[0].forecast, b.folds[0].forecast);
  assert.notDeepEqual(a.folds[0].observed, b.folds[0].observed);
});

test('ecommerce: поле, появившееся только в test, не включает критерий на train', () => {
  const sparse = rows.map((r) => r.date < '2023-01' ? { ...r, price: '', revenue: '', unit_cost: '', stock: '' } : r);
  const ds = parseEcomCsv(toCsv(header, sparse), mapping, { period: 'month' });
  const { features, fields } = prepareSku(ds, 'SYNTH-1', cutoffIndex('2023-01', ds), 24);
  assert.equal(fields.includes('unit_cost'), false);
  const built = buildSkuProblem(features, { fields_present: fields, ...problemConfig });
  assert.equal(built.problem.criteria.some((c) => c.criterion_id === 'gross_profit'), false);
  assert.equal(built.problem.criteria.some((c) => c.criterion_id === 'stockout_risk'), false);
});

test('ecommerce: rolling, четыре режима, метрики и seed воспроизводимы', () => {
  const result = runBacktest(dataset, config, problemConfig);
  assert.deepEqual(result, runBacktest(dataset, config, problemConfig));
  assert.equal(result.folds.length, 2);
  for (const f of result.folds) {
    assert.ok(f.train_to < f.cutoff);
    assert.equal(f.runs.length, 4);
    assert.ok(validateProblem(f.problem, { forRun: true }).ok);
    for (const r of f.runs) {
      assert.equal(r.mode, r.result.mode);
      assert.ok(Math.abs(r.result.primary.alternatives.reduce((s, a) => s + a.p_best, 0) - 1) < 1e-8);
    }
  }
  const errors = result.folds.map((f) => f.forecast.point - f.observed.units_sold);
  assert.equal(result.metrics.mae, errors.reduce((s, e) => s + Math.abs(e), 0) / errors.length);
  assert.equal(result.metrics.rmse, Math.sqrt(errors.reduce((s, e) => s + e * e, 0) / errors.length));
  assert.ok(result.limitations.some((s) => s.includes('не доказывает')));
});

test('ecommerce: пропуски train/test и короткая история отклоняются', () => {
  const missing = rows.filter((r) => r.sku !== 'SYNTH-1' || r.date !== '2022-10-01');
  const ds = parseEcomCsv(toCsv(header, missing), mapping, { period: 'month' });
  assert.throws(() => runBacktest(ds, config, problemConfig), /train/);
  assert.throws(() => runBacktest(dataset, { ...config, first_test: '2021-02' }, problemConfig), /train/);
  assert.throws(() => runBacktest(dataset, { ...config, last_test: '2025-01' }, problemConfig), /test/);
  const missingTest = rows.filter((r) => r.sku !== 'SYNTH-1' || r.date !== '2023-02-01');
  assert.throws(() => runBacktest(parseEcomCsv(toCsv(header, missingTest), mapping, { period: 'month' }), config, problemConfig), /test/);
});

test('ecommerce: даты, допущения, нагрузка и отрицательные продажи проверяются', () => {
  assert.equal(parseDate('2023-02-30'), null);
  assert.equal(parseDate('2023-13'), null);
  assert.equal(parseDate('2023-01-01junk'), null);
  assert.equal(parseDate('29.02.2024')?.toISOString().slice(0, 10), '2024-02-29');
  assert.throws(() => resolveAssumptions({ quantiles: [0.9, 0.1] }));
  assert.throws(() => resolveAssumptions({ bootstrap: 0 }));
  assert.throws(() => runBacktest(dataset, { ...config, train_periods: 0 }));
  assert.throws(() => runBacktest(dataset, { ...config, last_test: '2025-06', iterations: 10000, step: 1 }, problemConfig), /Слишком большой/);
  assert.throws(() => parseEcomCsv('sku,date,units_sold\nx,2023-01,-2', { sku: 'sku', date: 'date', units_sold: 'units_sold' }, { period: 'month' }), /неотрицательным/);
});
