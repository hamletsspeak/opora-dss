import { z } from 'zod';
import { solve } from '../engine/solve.js';
import { ALL_MODES } from '../problem/settings.js';
import type { DecisionProblem, ModeId } from '../problem/schema.js';
import type { RunResult } from '../engine/types.js';
import { AssumptionsSchema, summarizeDraws } from './actions.js';
import { DatasetError, parseDate, periodIndex, periodLabel, type EcomDataset, type PeriodRow } from './dataset.js';
import { computeFeatures, DEFAULT_FEATURES } from './features.js';
import type { FieldKey } from './fields.js';
import { buildSkuProblem, ECOM_LIMITATIONS, resolveAssumptions, type SkuProblemConfig } from './problem.js';

export const BacktestConfig = z.strictObject({
  sku: z.string().min(1).max(200),
  first_test: z.string().min(1).max(10),
  last_test: z.string().min(1).max(10).optional(),
  train_periods: z.number().int().min(3).max(3660).default(12),
  test_periods: z.number().int().min(1).max(60).default(3),
  step: z.number().int().min(1).max(60).default(3),
  window: z.number().int().min(3).max(3660).default(12),
  seasonality_min_years: z.number().int().min(1).max(20).default(2),
  modes: z.array(z.enum(['MF_WF', 'MU_WF', 'MF_WU', 'MU_WU'])).min(1).max(4).default([...ALL_MODES]),
  iterations: z.number().int().min(1).max(10_000).default(500),
  seed: z.number().int().min(0).max(4294967295).default(42),
});
export type BacktestConfigInput = z.input<typeof BacktestConfig>;

export function cutoffIndex(date: string, dataset: EcomDataset): number {
  const d = parseDate(date);
  if (!d) throw new DatasetError([`Некорректная дата: ${date}`]);
  return periodIndex(d, dataset.period);
}

// Availability is a property of the selected train window, never of full-file coverage.
export function trainFields(rows: PeriodRow[]): FieldKey[] {
  const out: FieldKey[] = ['sku', 'date', 'units_sold'];
  const fields: [FieldKey, keyof PeriodRow][] = [
    ['price', 'price'], ['unit_cost', 'cost'], ['ad_spend', 'ad_spend'],
    ['ad_revenue', 'ad_revenue'], ['returns_units', 'returns'],
    ['lead_time_days', 'lead_time_days'], ['storage_cost', 'storage_cost'],
  ];
  for (const [field, key] of fields) if (rows.some((r) => r[key] !== null)) out.push(field);
  if (rows.at(-1)?.stock != null) out.push('stock');
  return out;
}

export function prepareSku(dataset: EcomDataset, sku: string, cutoff: number, trainPeriods: number, window = DEFAULT_FEATURES.window, seasonalityMinYears = DEFAULT_FEATURES.seasonality_min_years) {
  const series = dataset.skus.find((s) => s.sku === sku);
  if (!series) throw new DatasetError([`SKU ${sku} отсутствует`]);
  const rows = series.rows.filter((r) => r.p >= cutoff - trainPeriods && r.p < cutoff);
  if (rows.length !== trainPeriods || rows.some((r) => r.gap))
    throw new DatasetError([`SKU ${sku}: требуется ${trainPeriods} наблюдаемых периодов train без пропусков`]);
  // Names/categories in an imported file may first appear after the cutoff.
  const features = computeFeatures({ sku, name: null, category: null, rows }, cutoff, {
    period: dataset.period, window, seasonality_min_years: seasonalityMinYears,
  });
  return { features, fields: trainFields(rows.slice(-window)) };
}

export interface BacktestFold {
  cutoff: string;
  train_from: string;
  train_to: string;
  test_to: string;
  problem: DecisionProblem;
  runs: { mode: ModeId; result: RunResult }[];
  forecast: { target: string; point: number; lower: number; upper: number };
  observed: { units_sold: number; revenue: number | null; gross_margin: number | null; logged_actions: string[] };
  errors: { signed: number; absolute: number; squared: number; interval_covered: boolean };
}

/** Forward validation of a sales proxy, not a causal evaluation of unperformed actions. */
export function runBacktest(dataset: EcomDataset, input: BacktestConfigInput, problemConfig: Omit<SkuProblemConfig, 'fields_present'> = {}) {
  const cfg = BacktestConfig.parse(input);
  const first = cutoffIndex(cfg.first_test, dataset);
  const last = cfg.last_test ? cutoffIndex(cfg.last_test, dataset) : dataset.last_period - cfg.test_periods + 1;
  if (last < first) throw new DatasetError(['Нет полного test-окна в заданном диапазоне']);
  const foldsCount = Math.floor((last - first) / cfg.step) + 1;
  const A = AssumptionsSchema.parse({ ...resolveAssumptions(problemConfig.assumptions), horizon: cfg.test_periods, seed: cfg.seed });
  if (foldsCount > 100 || foldsCount * cfg.iterations * new Set(cfg.modes).size > 1_000_000 || foldsCount * A.bootstrap * A.horizon > 2_000_000)
    throw new DatasetError(['Слишком большой backtest: уменьшите число окон, bootstrap или iterations']);
  const folds: BacktestFold[] = [];
  const series = dataset.skus.find((s) => s.sku === cfg.sku);
  if (!series) throw new DatasetError([`SKU ${cfg.sku} отсутствует`]);
  for (let cutoff = first; cutoff <= last; cutoff += cfg.step) {
    const { features, fields } = prepareSku(dataset, cfg.sku, cutoff, cfg.train_periods, cfg.window, cfg.seasonality_min_years);
    const built = buildSkuProblem(features, { ...problemConfig, fields_present: fields, assumptions: A, seed: cfg.seed, iterations: cfg.iterations });
    const runs = [...new Set(cfg.modes)].map((mode) => ({ mode, result: solve(built.problem, { overrides: { mode } }) }));
    const draws = built.simulations[0]?.demand_total;
    if (!draws?.length) throw new DatasetError(['Нет доступных действий для расчёта']);
    const forecast = summarizeDraws(draws, A.quantiles);
    // Only after the problem and ranking have been fixed do we inspect test observations.
    const test = series.rows.filter((r) => r.p >= cutoff && r.p < cutoff + cfg.test_periods);
    if (test.length !== cfg.test_periods || test.some((r) => r.gap))
      throw new DatasetError([`SKU ${cfg.sku}: неполное test-окно ${periodLabel(cutoff, dataset.period)}`]);
    const actual = test.reduce((s, r) => s + r.units, 0);
    const revenue = test.every((r) => r.revenue !== null) ? test.reduce((s, r) => s + r.revenue!, 0) : null;
    const margin = test.every((r) => r.revenue !== null && r.cost !== null) ? test.reduce((s, r) => s + r.revenue! - r.units * r.cost!, 0) : null;
    const error = forecast.median - actual;
    folds.push({
      cutoff: features.cutoff_label, train_from: features.train_from, train_to: features.train_to,
      test_to: periodLabel(cutoff + cfg.test_periods - 1, dataset.period), problem: built.problem, runs,
      forecast: { target: 'Продажи как прокси спроса; без моделирования эффекта действия', point: forecast.median, lower: forecast.lo, upper: forecast.hi },
      observed: { units_sold: actual, revenue, gross_margin: margin, logged_actions: [...new Set(test.flatMap((r) => r.action ? [r.action] : []))] },
      errors: { signed: error, absolute: Math.abs(error), squared: error ** 2, interval_covered: actual >= forecast.lo && actual <= forecast.hi },
    });
  }
  const totalActual = folds.reduce((s, f) => s + Math.abs(f.observed.units_sold), 0);
  const totalError = folds.reduce((s, f) => s + f.errors.absolute, 0);
  return {
    protocol: 'rolling-sales-proxy-v1', config: cfg, assumptions: A, folds,
    metrics: { mae: totalError / folds.length, rmse: Math.sqrt(folds.reduce((s, f) => s + f.errors.squared, 0) / folds.length), wape: totalActual > 0 ? totalError / totalActual : null, interval_coverage: folds.filter((f) => f.errors.interval_covered).length / folds.length },
    limitations: [...ECOM_LIMITATIONS, 'Прогноз спроса сравнивается с наблюдаемыми продажами; дефицит, цена и реклама могут нарушать сопоставимость.', 'При step < test_periods test-окна перекрываются: ошибки зависимы; сводные метрики описательные.'],
  };
}

