import { quantileSorted } from '../engine/ranking.js';
import { deriveSeed, mulberry32, type Rng } from '../engine/rng.js';
import { FIELD_BY_KEY, type FieldKey } from './fields.js';
import { PERIOD_DAYS, periodMonth } from './dataset.js';
import type { TrainFeatures } from './features.js';
import { z } from 'zod';

export type ActionId = 'increase_purchase' | 'keep' | 'price_cut' | 'promote' | 'reduce_purchase' | 'delist';
export type EcomCriterionId =
  | 'gross_profit'
  | 'lost_sales_share'
  | 'stockout_risk'
  | 'ending_cover'
  | 'capital_tied'
  | 'holding_cost'
  | 'turnover'
  | 'return_cost';

export interface ActionDef {
  id: ActionId;
  name: string;
  requires: FieldKey[];
  /** effect on demand is not observable in ordinary sales history → scenario/expert assumption */
  scenario: boolean;
  description: string;
}

export const ACTIONS: ActionDef[] = [
  { id: 'increase_purchase', name: 'Увеличить закупку', requires: ['units_sold', 'stock'], scenario: false, description: 'Заказ больше базового на долю purchase_increase' },
  { id: 'keep', name: 'Сохранить текущий объём закупки', requires: ['units_sold'], scenario: false, description: 'Базовая политика пополнения до прогноза спроса на горизонт + срок поставки' },
  { id: 'price_cut', name: 'Снизить цену', requires: ['units_sold', 'price'], scenario: true, description: 'Цена × (1 − price_cut); спрос × (1 − price_cut)^ε, ε — экспертный интервал эластичности' },
  { id: 'promote', name: 'Усилить продвижение', requires: ['units_sold'], scenario: true, description: 'Дополнительный рекламный бюджет; прирост спроса — экспертный интервал promo_uplift' },
  { id: 'reduce_purchase', name: 'Сократить закупку', requires: ['units_sold', 'stock'], scenario: false, description: 'Заказ меньше базового на долю purchase_decrease' },
  { id: 'delist', name: 'Вывести позицию из ассортимента', requires: ['units_sold', 'stock'], scenario: true, description: 'Без новых закупок; распродажа остатка со скидкой delist_discount, остаток списывается по доле salvage_share' },
];

/** Maps a logged action (id or Russian wording) to an action id; null when not recognised. */
export function parseActionLabel(raw: string): ActionId | null {
  const s = raw.trim().toLowerCase().replace(/ё/g, 'е');
  const byId = ACTIONS.find((a) => a.id === s || a.name.toLowerCase() === s);
  if (byId) return byId.id;
  if (/вывод|вывест|делист|delist/.test(s)) return 'delist';
  if (/сниж|сниз|скидк|price/.test(s) && /цен|скидк|price/.test(s)) return 'price_cut';
  if (/продвиж|реклам|promo/.test(s)) return 'promote';
  if (/увелич|нараст|increase/.test(s)) return 'increase_purchase';
  if (/сократ|уменьш|reduce/.test(s)) return 'reduce_purchase';
  if (/сохран|без изменен|keep|status quo/.test(s)) return 'keep';
  return null;
}

export interface EcomCriterionDef {
  id: EcomCriterionId;
  name: string;
  direction: 'min' | 'max';
  unit: string;
  requires: FieldKey[];
  formula: string;
  /** interval = [q_lo; q_hi] of bootstrap draws; probability = share of draws (exact value) */
  summary: 'interval' | 'probability';
}

export const ECOM_CRITERIA: EcomCriterionDef[] = [
  { id: 'gross_profit', name: 'Валовая прибыль за горизонт', direction: 'max', unit: 'руб.', requires: ['units_sold', 'price', 'unit_cost'], formula: 'Σ продано × (цена действия − себестоимость) − доп. реклама − хранение − потери списания', summary: 'interval' },
  { id: 'lost_sales_share', name: 'Доля неудовлетворённого спроса', direction: 'min', unit: 'доля', requires: ['units_sold', 'stock'], formula: 'Σ (спрос − продано) / Σ спрос', summary: 'interval' },
  { id: 'stockout_risk', name: 'Риск дефицита', direction: 'min', unit: 'вероятность', requires: ['units_sold', 'stock'], formula: 'доля бутстрэп-траекторий, где хотя бы в одном периоде спрос превысил остаток (учитывает разброс сроков поставки)', summary: 'probability' },
  { id: 'ending_cover', name: 'Покрытие остатком на конец горизонта', direction: 'min', unit: 'периодов', requires: ['units_sold', 'stock'], formula: 'остаток на конец / базовый прогноз спроса за период', summary: 'interval' },
  { id: 'capital_tied', name: 'Капитал в запасах', direction: 'min', unit: 'руб.', requires: ['units_sold', 'stock', 'unit_cost'], formula: 'средний остаток за горизонт × себестоимость', summary: 'interval' },
  { id: 'holding_cost', name: 'Затраты на хранение', direction: 'min', unit: 'руб.', requires: ['units_sold', 'stock', 'unit_cost'], formula: 'Σ остаток на конец периода × ставка хранения (из данных о хранении или допущение holding_rate × себестоимость)', summary: 'interval' },
  { id: 'turnover', name: 'Оборачиваемость за горизонт', direction: 'max', unit: 'раз', requires: ['units_sold', 'stock'], formula: 'Σ продано / max(средний остаток, 1)', summary: 'interval' },
  { id: 'return_cost', name: 'Потери от возвратов', direction: 'min', unit: 'руб.', requires: ['units_sold', 'returns_units', 'price'], formula: 'доля возвратов (train) × продано × цена × return_loss_share', summary: 'interval' },
];

export interface Availability<T extends string> {
  id: T;
  name: string;
  available: boolean;
  missing: FieldKey[];
  reason: string | null;
}

/** Which actions/criteria can be evaluated with the mapped fields (coverage ≥ threshold). */
export function availability(present: Partial<Record<FieldKey, number>> | FieldKey[], minCoverage = 0.3) {
  const ok = (f: FieldKey) =>
    Array.isArray(present) ? present.includes(f) : f === 'units_sold' ? (present[f] ?? 0) > 0 : (present[f] ?? 0) >= minCoverage;
  const check = <T extends string>(id: T, name: string, req: FieldKey[]): Availability<T> => {
    const missing = req.filter((f) => !ok(f));
    return {
      id,
      name,
      available: missing.length === 0,
      missing,
      reason: missing.length ? `нет данных: ${missing.map((f) => FIELD_BY_KEY[f].title).join(', ')}` : null,
    };
  };
  return {
    actions: ACTIONS.map((a) => check(a.id, a.name, a.requires)),
    criteria: ECOM_CRITERIA.map((c) => check(c.id, c.name, c.requires)),
  };
}

/** All behavioural parameters. Defaults are expert assumptions and are labelled as such everywhere. */
export interface ActionAssumptions {
  horizon: number;
  bootstrap: number;
  quantiles: [number, number];
  purchase_increase: number;
  purchase_decrease: number;
  price_cut: number;
  elasticity: [number, number];
  promo_budget_per_period: number | null;
  promo_uplift: [number, number];
  delist_discount: number;
  salvage_share: number;
  holding_rate_per_period: number;
  default_lead_time_days: number;
  return_loss_share: number;
  seed: number;
}

export const DEFAULT_ASSUMPTIONS: ActionAssumptions = {
  horizon: 3,
  bootstrap: 1000,
  quantiles: [0.1, 0.9],
  purchase_increase: 0.3,
  purchase_decrease: 0.3,
  price_cut: 0.1,
  elasticity: [-2, -0.5],
  promo_budget_per_period: null,
  promo_uplift: [0, 0.2],
  delist_discount: 0.3,
  salvage_share: 0.5,
  holding_rate_per_period: 0.02,
  default_lead_time_days: 14,
  return_loss_share: 0.3,
  seed: 42,
};

export const AssumptionsSchema = z.strictObject({
  horizon: z.number().int().min(1).max(60),
  bootstrap: z.number().int().min(20).max(10_000),
  quantiles: z.tuple([z.number().min(0).max(0.5), z.number().min(0.5).max(1)]).refine(([a, b]) => a < b),
  purchase_increase: z.number().min(0).max(5),
  purchase_decrease: z.number().min(0).max(1),
  price_cut: z.number().min(0).max(0.95),
  elasticity: z.tuple([z.number().min(-10).max(0), z.number().min(-10).max(0)]).refine(([a, b]) => a <= b),
  promo_budget_per_period: z.number().min(0).max(1e12).nullable(),
  promo_uplift: z.tuple([z.number().min(0).max(10), z.number().min(0).max(10)]).refine(([a, b]) => a <= b),
  delist_discount: z.number().min(0).max(0.95),
  salvage_share: z.number().min(0).max(1),
  holding_rate_per_period: z.number().min(0).max(1),
  default_lead_time_days: z.number().min(0).max(365),
  return_loss_share: z.number().min(0).max(1),
  seed: z.number().int().min(0).max(4294967295),
});

export interface SimulationResult {
  action: ActionId;
  draws: Record<EcomCriterionId, number[]>;
  /** total unconstrained demand over the horizon (for forecast checks) */
  demand_total: number[];
  units_sold: number[];
  stockout: number[];
  order_qty: number;
  assumptions: string[];
  provenance: 'computed' | 'scenario';
}

export interface DemandDraws {
  /** base demand per draw and horizon period (before action multipliers) */
  base: Float64Array[];
  lead_periods: Int32Array;
  forecast_per_period: number[];
}

function sampleU(rng: Rng, [a, b]: [number, number]): number {
  return a + (b - a) * rng();
}

/**
 * Bootstrap of de-seasonalised train-window demand (with replacement), re-seasonalised for the
 * horizon months; lead times resampled from train deliveries. Shared by all actions (common random numbers).
 */
export function demandDraws(f: TrainFeatures, A: ActionAssumptions): DemandDraws {
  const rng = mulberry32(deriveSeed(A.seed, `ecom|${f.sku}|${f.cutoff}|demand`));
  const W = f.demand.window.length;
  const season = (t: number) => (f.demand.seasonal_index ? f.demand.seasonal_index[periodMonth(f.cutoff + t, f.period)] : 1);
  const base: Float64Array[] = [];
  const lead = new Int32Array(A.bootstrap);
  const pd = PERIOD_DAYS[f.period];
  for (let b = 0; b < A.bootstrap; b++) {
    const row = new Float64Array(A.horizon);
    for (let t = 0; t < A.horizon; t++) row[t] = f.demand.window[Math.floor(rng() * W)] * season(t);
    base.push(row);
    const days = f.lead_time_days ? f.lead_time_days[Math.floor(rng() * f.lead_time_days.length)] : A.default_lead_time_days;
    lead[b] = Math.ceil(days / pd - 1e-9);
  }
  return { base, lead_periods: lead, forecast_per_period: Array.from({ length: A.horizon }, (_, t) => f.demand.mean * season(t)) };
}

export function simulateAction(f: TrainFeatures, action: ActionId, A: ActionAssumptions, dd: DemandDraws): SimulationResult {
  const rng = mulberry32(deriveSeed(A.seed, `ecom|${f.sku}|${f.cutoff}|${action}`));
  const H = A.horizon;
  const price = f.price ?? 0;
  const cost = f.unit_cost ?? 0;
  const stockKnown = f.stock_now !== null;
  const stock0 = f.stock_now ?? 0;
  const holding = f.storage_cost_per_unit_period ?? A.holding_rate_per_period * cost;
  const leadMean = f.lead_time_days ? f.lead_time_days.reduce((s, x) => s + x, 0) / f.lead_time_days.length : A.default_lead_time_days;
  const leadPeriods = leadMean / PERIOD_DAYS[f.period];
  const fc = dd.forecast_per_period;
  const fcTotal = fc.reduce((s, x) => s + x, 0);
  const perPeriod = fcTotal / H;
  const assumptions: string[] = ['спрос на горизонте — бутстрэп спроса train-окна (с возвратом)'];
  if (f.demand.seasonal_index) assumptions.push('спрос скорректирован на сезонные индексы, оценённые по train');
  if (!f.lead_time_days) assumptions.push(`срок поставки ${A.default_lead_time_days} дн. — экспертное допущение (нет данных)`);
  if (f.storage_cost_per_unit_period === null) assumptions.push(`хранение ${A.holding_rate_per_period * 100}% себестоимости за период — экспертное допущение`);
  if (!stockKnown) assumptions.push('остаток неизвестен: продажи не ограничены запасом');

  const midElastic = (A.elasticity[0] + A.elasticity[1]) / 2;
  const midUplift = (A.promo_uplift[0] + A.promo_uplift[1]) / 2;
  let pointMult = 1;
  let priceA = price;
  let adExtra = 0;
  switch (action) {
    case 'price_cut':
      priceA = price * (1 - A.price_cut);
      pointMult = (1 - A.price_cut) ** midElastic;
      assumptions.push(`снижение цены на ${A.price_cut * 100}%; эластичность ε ∈ [${A.elasticity.join('; ')}] — экспертное допущение, по истории продаж не оценивается (корреляция ≠ причинный эффект)`);
      break;
    case 'promote': {
      const budget = A.promo_budget_per_period ?? (f.ad ? 0.5 * f.ad.spend_per_period : 0);
      adExtra = budget * H;
      pointMult = 1 + midUplift;
      assumptions.push(`доп. реклама ${Math.round(budget)} руб./период; прирост спроса ∈ [${A.promo_uplift.map((x) => `${x * 100}%`).join('; ')}] — экспертное допущение`);
      if (f.ad?.attributed_roas != null) assumptions.push(`атрибутированная ROAS на train = ${f.ad.attributed_roas.toFixed(2)} (оценка рекламной системы, не причинный эффект)`);
      break;
    }
    case 'delist':
      priceA = price * (1 - A.delist_discount);
      pointMult = (1 - A.delist_discount) ** midElastic;
      assumptions.push(`распродажа со скидкой ${A.delist_discount * 100}%, остаток списывается с возмещением ${A.salvage_share * 100}% себестоимости — экспертные допущения`);
      break;
    case 'increase_purchase':
      assumptions.push(`заказ больше базового на ${A.purchase_increase * 100}%; спрос не зависит от объёма закупки`);
      break;
    case 'reduce_purchase':
      assumptions.push(`заказ меньше базового на ${A.purchase_decrease * 100}%; спрос не зависит от объёма закупки`);
      break;
    case 'keep':
      assumptions.push('пополнение до прогноза спроса на горизонт + срок поставки (order-up-to)');
  }
  const baseOrder = Math.max(0, fcTotal * pointMult + perPeriod * pointMult * leadPeriods - stock0);
  const order =
    action === 'delist' ? 0 : action === 'increase_purchase' ? baseOrder * (1 + A.purchase_increase) + (baseOrder === 0 ? A.purchase_increase * fcTotal : 0) : action === 'reduce_purchase' ? baseOrder * (1 - A.purchase_decrease) : baseOrder;

  const B = A.bootstrap;
  const draws: Record<EcomCriterionId, number[]> = {
    gross_profit: [],
    lost_sales_share: [],
    stockout_risk: [],
    ending_cover: [],
    capital_tied: [],
    holding_cost: [],
    turnover: [],
    return_cost: [],
  };
  const demandTotal: number[] = [];
  const unitsSold: number[] = [];
  const stockout: number[] = [];
  for (let b = 0; b < B; b++) {
    let mult = 1;
    if (action === 'price_cut') mult = (1 - A.price_cut) ** sampleU(rng, A.elasticity);
    else if (action === 'delist') mult = (1 - A.delist_discount) ** sampleU(rng, A.elasticity);
    else if (action === 'promote') mult = 1 + sampleU(rng, A.promo_uplift);
    let stock = stockKnown ? stock0 : Infinity;
    let sold = 0;
    let lost = 0;
    let dem = 0;
    let hold = 0;
    let stockSum = 0;
    let out = 0;
    const arrival = dd.lead_periods[b];
    for (let t = 0; t < H; t++) {
      if (t === arrival) stock += order;
      const d = dd.base[b][t] * mult;
      const s = Math.min(d, stock);
      sold += s;
      lost += d - s;
      dem += d;
      stock -= s;
      if (stockKnown && stock <= 1e-9 && d > s) out = 1;
      const st = stockKnown ? stock : 0;
      hold += st * holding;
      stockSum += st;
    }
    const endStock = stockKnown ? stock : 0;
    const writeoff = action === 'delist' ? endStock * cost * (1 - A.salvage_share) : 0;
    const avgStock = stockSum / H;
    draws.gross_profit.push(sold * (priceA - cost) - adExtra - hold - writeoff);
    draws.lost_sales_share.push(dem > 0 ? lost / dem : 0);
    draws.stockout_risk.push(out);
    draws.ending_cover.push(action === 'delist' ? 0 : perPeriod > 0 ? Math.min(999, endStock / perPeriod) : endStock > 0 ? 999 : 0);
    draws.capital_tied.push(avgStock * cost);
    draws.holding_cost.push(hold);
    draws.turnover.push(sold / Math.max(avgStock, 1));
    draws.return_cost.push((f.returns_rate ?? 0) * sold * priceA * A.return_loss_share);
    demandTotal.push(dem / mult);
    unitsSold.push(sold);
    stockout.push(out);
  }
  if (action === 'delist') assumptions.push('после распродажи позиция выводится: остаток на конец горизонта = 0 (списан)');
  return {
    action,
    draws,
    demand_total: demandTotal,
    units_sold: unitsSold,
    stockout,
    order_qty: order,
    assumptions,
    provenance: ACTIONS.find((a) => a.id === action)!.scenario ? 'scenario' : 'computed',
  };
}

export function summarizeDraws(xs: number[], q: [number, number]): { lo: number; median: number; hi: number; mean: number } {
  const s = [...xs].sort((a, b) => a - b);
  return { lo: quantileSorted(s, q[0]), median: quantileSorted(s, 0.5), hi: quantileSorted(s, q[1]), mean: xs.reduce((a, b) => a + b, 0) / (xs.length || 1) };
}
