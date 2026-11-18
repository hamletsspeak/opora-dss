import { quantileSorted } from '../engine/ranking.js';
import { PERIOD_DAYS, periodLabel, periodMonth, type PeriodKind, type PeriodRow, type SkuSeries } from './dataset.js';

export interface FeatureConfig {
  period: PeriodKind;
  /** number of most recent train periods used for demand statistics */
  window: number;
  /** estimate monthly seasonal indices when the train part covers at least this many full years */
  seasonality_min_years: number;
}

export const DEFAULT_FEATURES: Omit<FeatureConfig, 'period'> = { window: 12, seasonality_min_years: 2 };

export interface TrainFeatures {
  sku: string;
  name: string | null;
  period: PeriodKind;
  /** first test period (exclusive end of train) */
  cutoff: number;
  cutoff_label: string;
  train_from: string;
  train_to: string;
  train_periods: number;
  window_periods: number;
  demand: {
    /** de-seasonalised demand of the window, oldest → newest */
    window: number[];
    window_months: number[];
    mean: number;
    sd: number;
    q10: number;
    q50: number;
    q90: number;
    /** monthly indices (12 values, mean 1) or null when history is too short */
    seasonal_index: number[] | null;
    /** share of window periods with zero stock at period end (sales may be censored) */
    censored_share: number | null;
  };
  price: number | null;
  unit_cost: number | null;
  unit_margin: number | null;
  stock_now: number | null;
  cover_periods: number | null;
  turnover_per_period: number | null;
  ad: { spend_per_period: number; attributed_roas: number | null } | null;
  returns_rate: number | null;
  lead_time_days: number[] | null;
  storage_cost_per_unit_period: number | null;
  notes: string[];
}

function mean(xs: number[]): number {
  return xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0;
}

function lastValue<T>(rows: PeriodRow[], f: (r: PeriodRow) => T | null): T | null {
  for (let i = rows.length - 1; i >= 0; i--) {
    const v = f(rows[i]);
    if (v !== null) return v;
  }
  return null;
}

/**
 * Features of one SKU computed from periods strictly before `cutoff`. Rows at or after the cutoff
 * are removed before any computation, so test data cannot influence the result.
 */
export function computeFeatures(series: SkuSeries, cutoff: number, cfg: FeatureConfig): TrainFeatures {
  const train = series.rows.filter((r) => r.p < cutoff);
  if (train.length < 3) throw new Error(`SKU ${series.sku}: меньше 3 периодов истории до ${periodLabel(cutoff, cfg.period)}`);
  if (!Number.isInteger(cfg.window) || cfg.window < 3 || !Number.isInteger(cfg.seasonality_min_years) || cfg.seasonality_min_years < 1)
    throw new Error('Окно признаков должно быть ≥ 3, число лет сезонности ≥ 1');
  if (train.some((r) => r.gap)) throw new Error('В train есть пропущенные периоды: нулевые продажи не считаются наблюдениями');
  const notes: string[] = [];
  const W = Math.min(cfg.window, train.length);
  const win = train.slice(-W);

  let seasonal: number[] | null = null;
  if (cfg.period === 'month' && train.length >= 12 * cfg.seasonality_min_years) {
    const sums = Array(12).fill(0);
    const cnt = Array(12).fill(0);
    const full = train.slice(train.length - 12 * Math.floor(train.length / 12));
    for (const r of full) {
      const m = periodMonth(r.p, cfg.period);
      sums[m] += r.units;
      cnt[m]++;
    }
    const avg = sums.map((s, m) => (cnt[m] ? s / cnt[m] : 0));
    const overall = mean(avg);
    if (overall > 0 && avg.every((a) => a > 0)) {
      seasonal = avg.map((a) => a / overall);
      notes.push(`сезонные индексы по месяцам оценены по ${full.length} периодам train`);
    } else notes.push('сезонность не оценена: есть месяцы без продаж');
  } else notes.push(cfg.period === 'month' ? `сезонность не оценена: train короче ${cfg.seasonality_min_years} лет` : 'сезонность оценивается только для помесячных данных');

  const months = win.map((r) => periodMonth(r.p, cfg.period));
  const demand = win.map((r, i) => (seasonal ? r.units / seasonal[months[i]] : r.units));
  const sorted = [...demand].sort((a, b) => a - b);
  const mu = mean(demand);
  const sd = Math.sqrt(mean(demand.map((x) => (x - mu) ** 2)));
  const stocks = win.map((r) => r.stock);
  const knownStock = stocks.filter((s): s is number => s !== null);
  const censored = knownStock.length ? knownStock.filter((s) => s <= 0).length / knownStock.length : null;
  if (censored && censored > 0) notes.push(`в ${Math.round(censored * 100)}% периодов окна остаток был нулевым — продажи могли быть ограничены наличием (спрос недооценён)`);

  const price = lastValue(win, (r) => r.price);
  const cost = lastValue(win, (r) => r.cost);
  const stockNow = lastValue(train.slice(-1), (r) => r.stock);
  if (stockNow === null && knownStock.length) notes.push('остаток на дату решения неизвестен (нет значения в последнем периоде train)');
  const avgStock = knownStock.length ? mean(knownStock) : null;
  const unitsWin = win.reduce((s, r) => s + r.units, 0);

  const adRows = win.filter((r) => r.ad_spend !== null);
  let ad: TrainFeatures['ad'] = null;
  if (adRows.length) {
    const spend = adRows.reduce((s, r) => s + (r.ad_spend ?? 0), 0);
    const adRev = adRows.filter((r) => r.ad_revenue !== null).reduce((s, r) => s + (r.ad_revenue ?? 0), 0);
    ad = { spend_per_period: spend / adRows.length, attributed_roas: spend > 0 && adRows.some((r) => r.ad_revenue !== null) ? adRev / spend : null };
  }
  const retRows = win.filter((r) => r.returns !== null);
  const retUnits = retRows.reduce((s, r) => s + (r.returns ?? 0), 0);
  const soldForRet = retRows.reduce((s, r) => s + r.units, 0);
  const leads = train.map((r) => r.lead_time_days).filter((x): x is number => x !== null && x >= 0);
  const storRows = win.filter((r) => r.storage_cost !== null && r.stock !== null && r.stock > 0);
  const storage = storRows.length ? mean(storRows.map((r) => (r.storage_cost as number) / (r.stock as number))) : null;

  return {
    sku: series.sku,
    name: series.name,
    period: cfg.period,
    cutoff,
    cutoff_label: periodLabel(cutoff, cfg.period),
    train_from: periodLabel(train[0].p, cfg.period),
    train_to: periodLabel(train.at(-1)!.p, cfg.period),
    train_periods: train.length,
    window_periods: W,
    demand: {
      window: demand,
      window_months: months,
      mean: mu,
      sd,
      q10: quantileSorted(sorted, 0.1),
      q50: quantileSorted(sorted, 0.5),
      q90: quantileSorted(sorted, 0.9),
      seasonal_index: seasonal,
      censored_share: censored,
    },
    price,
    unit_cost: cost,
    unit_margin: price !== null && cost !== null ? price - cost : null,
    stock_now: stockNow,
    cover_periods: stockNow !== null && mu > 0 ? stockNow / mu : null,
    turnover_per_period: avgStock && avgStock > 0 ? unitsWin / W / avgStock : null,
    ad,
    returns_rate: soldForRet > 0 ? retUnits / soldForRet : null,
    lead_time_days: leads.length ? leads.slice(-24) : null,
    storage_cost_per_unit_period: storage,
    notes,
  };
}

export function periodDays(kind: PeriodKind): number {
  return PERIOD_DAYS[kind];
}
