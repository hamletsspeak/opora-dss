import { SCHEMA_VERSION, type DecisionProblem, type Evaluation, type MethodSpec, type ModeId, type WeightItem } from '../problem/index.js';
import {
  ACTIONS,
  AssumptionsSchema,
  availability,
  DEFAULT_ASSUMPTIONS,
  demandDraws,
  ECOM_CRITERIA,
  simulateAction,
  summarizeDraws,
  type ActionAssumptions,
  type ActionId,
  type EcomCriterionId,
  type SimulationResult,
} from './actions.js';
import type { FieldKey } from './fields.js';
import type { TrainFeatures } from './features.js';

export const ECOM_LIMITATIONS = [
  'Оценки действий — модельные последствия на горизонте, построенные только по train-периоду; это не наблюдаемые факты.',
  'Действия «снизить цену», «усилить продвижение», «вывести позицию» оцениваются по экспертным сценарным допущениям (эластичность, прирост спроса, скидка распродажи): обычная история продаж не позволяет оценить их причинный эффект.',
  'Корреляции в исторических данных (цена ↔ продажи, реклама ↔ продажи) не трактуются как доказательство причинного эффекта.',
  'Исторические данные показывают результат только фактически выполненного действия; backtest проверяет прогнозы и согласованность с наблюдаемым, но не доказывает оптимальность невыполненных альтернатив.',
  'Если в train были периоды с нулевым остатком, наблюдаемые продажи занижают спрос (цензурирование).',
];

export interface SkuProblemConfig {
  actions?: ActionId[];
  criteria?: EcomCriterionId[];
  assumptions?: Partial<ActionAssumptions>;
  /** exact weights by criterion id (must sum to 1) or bounds; default: unknown weights in [0, 1] */
  weights?: Record<string, { value?: number; lower?: number; upper?: number }>;
  method?: MethodSpec;
  mode?: ModeId;
  iterations?: number;
  seed?: number;
  fields_present: FieldKey[] | Partial<Record<FieldKey, number>>;
}

export interface SkuProblemResult {
  problem: DecisionProblem;
  simulations: SimulationResult[];
  excluded_actions: { id: ActionId; reason: string }[];
  excluded_criteria: { id: EcomCriterionId; reason: string }[];
  assumptions: ActionAssumptions;
}

export function resolveAssumptions(a: Partial<ActionAssumptions> = {}): ActionAssumptions {
  return AssumptionsSchema.parse({ ...DEFAULT_ASSUMPTIONS, ...a });
}

/** Builds the SKU decision problem from train features: alternatives = actions, evaluations = simulated consequences. */
export function buildSkuProblem(f: TrainFeatures, cfg: SkuProblemConfig): SkuProblemResult {
  const A = resolveAssumptions(cfg.assumptions);
  const av = availability(cfg.fields_present);
  const wantA = new Set(cfg.actions ?? ACTIONS.map((a) => a.id));
  const wantC = new Set(cfg.criteria ?? ECOM_CRITERIA.map((c) => c.id));
  const excludedA: SkuProblemResult['excluded_actions'] = [];
  const excludedC: SkuProblemResult['excluded_criteria'] = [];
  const actions = ACTIONS.filter((a) => {
    if (!wantA.has(a.id)) return false;
    const x = av.actions.find((y) => y.id === a.id)!;
    if (!x.available) {
      excludedA.push({ id: a.id, reason: x.reason! });
      return false;
    }
    if (a.id === 'promote' && A.promo_budget_per_period === null && !f.ad) {
      excludedA.push({ id: a.id, reason: 'нет данных о рекламе — задайте promo_budget_per_period' });
      return false;
    }
    if ((a.id === 'increase_purchase' || a.id === 'reduce_purchase' || a.id === 'delist') && f.stock_now === null) {
      excludedA.push({ id: a.id, reason: 'остаток на дату решения неизвестен' });
      return false;
    }
    return true;
  });
  const criteria = ECOM_CRITERIA.filter((c) => {
    if (!wantC.has(c.id)) return false;
    const x = av.criteria.find((y) => y.id === c.id)!;
    if (!x.available) {
      excludedC.push({ id: c.id, reason: x.reason! });
      return false;
    }
    if (c.id === 'return_cost' && f.returns_rate === null) {
      excludedC.push({ id: c.id, reason: 'нет возвратов в train-окне' });
      return false;
    }
    if (c.requires.includes('stock') && f.stock_now === null) {
      excludedC.push({ id: c.id, reason: 'остаток на дату решения неизвестен' });
      return false;
    }
    return true;
  });
  const dd = demandDraws(f, A);
  const sims = actions.map((a) => simulateAction(f, a.id, A, dd));
  const source = `train ${f.train_from}…${f.train_to} (${f.train_periods} периодов, окно ${f.window_periods}); SKU ${f.sku}`;
  const evaluations: Evaluation[] = [];
  for (const s of sims)
    for (const c of criteria) {
      const q = summarizeDraws(s.draws[c.id], A.quantiles);
      const span = Math.abs(q.hi - q.lo);
      const value: Evaluation['value'] =
        c.summary === 'probability'
          ? { kind: 'exact', value: q.mean }
          : span <= 1e-9 * Math.max(1, Math.abs(q.median))
            ? { kind: 'exact', value: q.median }
            : { kind: 'interval', lower: q.lo, upper: q.hi, point: q.median };
      const how = c.summary === 'probability' ? 'доля траекторий' : `интервал [q${A.quantiles[0] * 100}; q${A.quantiles[1] * 100}], точка = медиана`;
      evaluations.push({
        alternative_id: s.action,
        criterion_id: c.id,
        value,
        unit: c.unit,
        provenance: s.provenance,
        source: { kind: 'model', ref: `${source}; бутстрэп B=${A.bootstrap}, ${how}` },
        assumptions: s.assumptions.slice(0, 50),
      });
    }
  const n = criteria.length;
  const items: WeightItem[] = criteria.map((c) => {
    const w = cfg.weights?.[c.id];
    if (!cfg.weights)
      return {
        criterion_id: c.id,
        value: 1 / n,
        lower: 0.5 / n,
        upper: Math.min(1, 2 / n),
        provenance: 'expert',
        source: { kind: 'manual', ref: 'по умолчанию: равные веса, неопределённость [0,5/n; 2/n] — допущение, задайте свои веса' },
      };
    return {
      criterion_id: c.id,
      ...(w?.value !== undefined ? { value: w.value } : {}),
      ...(w?.lower !== undefined ? { lower: w.lower } : {}),
      ...(w?.upper !== undefined ? { upper: w.upper } : {}),
      provenance: 'user_input',
    };
  });
  const exactW = items.length > 0 && items.every((w) => typeof w.value === 'number' && w.lower == null && w.upper == null);
  const problem: DecisionProblem = {
    schema_version: SCHEMA_VERSION,
    problem_id: `sku-${f.sku}-${f.cutoff_label}`.replace(/[^\p{L}\p{N}_.:-]/gu, '_').slice(0, 64),
    context: {
      title: `SKU ${f.sku}${f.name ? ` «${f.name}»` : ''}: выбор действия на ${f.cutoff_label}`,
      goal: `Выбор управленческого действия на горизонт ${A.horizon} периодов по данным ${f.train_from}…${f.train_to}`,
      domain: 'ecommerce',
      decision_date: f.cutoff_label,
    },
    alternatives: actions.map((a) => ({ alternative_id: a.id, name: a.name, description: a.description, provenance: a.scenario ? 'scenario' : 'computed' })),
    criteria: criteria.map((c) => ({
      criterion_id: c.id,
      name: c.name,
      description: c.formula,
      direction: c.direction,
      unit: c.unit,
      provenance: 'computed',
      source: { kind: 'dataset', ref: `поля: ${c.requires.join(', ')}` },
    })),
    evaluations,
    weights: { normalization: 'sum_to_one', items },
    constraints: [],
    method: cfg.method ?? { id: 'topsis', params: { normalization: 'minmax' } },
    uncertainty: { mode: cfg.mode ?? (exactW ? 'MU_WF' : 'MU_WU'), iterations: cfg.iterations ?? 2000, seed: cfg.seed ?? A.seed },
    metadata: {
      origin: 'ecommerce',
      status: 'draft',
      source,
      created_at: new Date(0).toISOString(),
      notes: [...ECOM_LIMITATIONS, ...f.notes.map((x) => `данные: ${x}`)].slice(0, 100),
      ecommerce: {
        sku: f.sku,
        cutoff: f.cutoff_label,
        horizon: A.horizon,
        assumptions: A,
        features: {
          demand_mean: f.demand.mean,
          demand_q10: f.demand.q10,
          demand_q90: f.demand.q90,
          price: f.price,
          unit_cost: f.unit_cost,
          stock_now: f.stock_now,
          cover_periods: f.cover_periods,
          returns_rate: f.returns_rate,
          attributed_roas: f.ad?.attributed_roas ?? null,
          seasonal: Boolean(f.demand.seasonal_index),
          censored_share: f.demand.censored_share,
        },
        order_qty: Object.fromEntries(sims.map((s) => [s.action, s.order_qty])),
        excluded_actions: excludedA,
        excluded_criteria: excludedC,
      },
    },
  };
  return { problem, simulations: sims, excluded_actions: excludedA, excluded_criteria: excludedC, assumptions: A };
}
