import { SCHEMA_VERSION, type DecisionProblem } from './schema.js';

/**
 * Example problems. All data are synthetic/illustrative (provenance "synthetic") and are
 * not observations of real suppliers, products or decision makers.
 */

export const supplierDemo: DecisionProblem = {
  schema_version: SCHEMA_VERSION,
  problem_id: 'supplier-demo',
  context: {
    title: 'Выбор поставщика (демонстрационный набор)',
    goal: 'Выбрать поставщика комплектующих при неточных ценах и браке',
    domain: 'procurement',
  },
  alternatives: [
    { alternative_id: 'alpha', name: 'ООО «АльфаСнаб»', provenance: 'synthetic' },
    { alternative_id: 'beta', name: 'ИП Бета Логистик', provenance: 'synthetic' },
    { alternative_id: 'gamma', name: 'Гамма Трейд', provenance: 'synthetic' },
    { alternative_id: 'delta', name: 'Дельта Партнёр', provenance: 'synthetic' },
  ],
  criteria: [
    { criterion_id: 'price', name: 'Цена', direction: 'min', value_type: 'currency', unit: 'руб./шт.', range: { min: 0 }, provenance: 'synthetic' },
    { criterion_id: 'lead_time', name: 'Срок поставки', direction: 'min', value_type: 'duration', unit: 'дн.', range: { min: 0 }, provenance: 'synthetic' },
    { criterion_id: 'defect_rate', name: 'Процент брака', direction: 'min', value_type: 'percent', unit: '%', range: { min: 0, max: 100 }, provenance: 'synthetic' },
    { criterion_id: 'min_lot', name: 'Минимальная партия', direction: 'min', value_type: 'integer', unit: 'шт.', range: { min: 0 }, provenance: 'synthetic' },
  ],
  evaluations: [
    { alternative_id: 'alpha', criterion_id: 'price', value: { kind: 'interval', lower: 470, upper: 490 } },
    { alternative_id: 'alpha', criterion_id: 'lead_time', value: { kind: 'exact', value: 5 } },
    { alternative_id: 'alpha', criterion_id: 'defect_rate', value: { kind: 'interval', lower: 1.2, upper: 1.8 } },
    { alternative_id: 'alpha', criterion_id: 'min_lot', value: { kind: 'exact', value: 100 } },
    { alternative_id: 'beta', criterion_id: 'price', value: { kind: 'interval', lower: 430, upper: 460 } },
    { alternative_id: 'beta', criterion_id: 'lead_time', value: { kind: 'interval', lower: 7, upper: 10 } },
    { alternative_id: 'beta', criterion_id: 'defect_rate', value: { kind: 'exact', value: 0.8 } },
    { alternative_id: 'beta', criterion_id: 'min_lot', value: { kind: 'exact', value: 200 } },
    { alternative_id: 'gamma', criterion_id: 'price', value: { kind: 'exact', value: 520 } },
    { alternative_id: 'gamma', criterion_id: 'lead_time', value: { kind: 'exact', value: 3 } },
    { alternative_id: 'gamma', criterion_id: 'defect_rate', value: { kind: 'interval', lower: 2.0, upper: 2.5 } },
    { alternative_id: 'gamma', criterion_id: 'min_lot', value: { kind: 'exact', value: 50 } },
    { alternative_id: 'delta', criterion_id: 'price', value: { kind: 'interval', lower: 450, upper: 480 } },
    { alternative_id: 'delta', criterion_id: 'lead_time', value: { kind: 'exact', value: 6 } },
    { alternative_id: 'delta', criterion_id: 'defect_rate', value: { kind: 'interval', lower: 1.0, upper: 1.4 } },
    { alternative_id: 'delta', criterion_id: 'min_lot', value: { kind: 'interval', lower: 80, upper: 120 } },
  ].map((e) => ({ ...e, provenance: 'synthetic' as const })) as DecisionProblem['evaluations'],
  weights: {
    normalization: 'sum_to_one',
    items: [
      { criterion_id: 'price', value: 0.35, lower: 0.25, upper: 0.45, provenance: 'synthetic' },
      { criterion_id: 'lead_time', value: 0.3, lower: 0.2, upper: 0.4, provenance: 'synthetic' },
      { criterion_id: 'defect_rate', value: 0.2, lower: 0.1, upper: 0.3, provenance: 'synthetic' },
      { criterion_id: 'min_lot', value: 0.15, lower: 0.05, upper: 0.25, provenance: 'synthetic' },
    ],
  },
  constraints: [],
  method: { id: 'topsis', params: { normalization: 'minmax' } },
  uncertainty: {
    mode: 'MU_WU',
    iterations: 2000,
    seed: 42,
    m: { default_interval_distribution: 'uniform', point_rule: 'expected_value' },
    w: { sampler: 'polytope_rejection' },
  },
  metadata: {
    origin: 'example',
    source: 'Демонстрационный набор Klar (синтетические данные)',
    author: 'opora-dss',
    notes: ['Веса и интервалы весов — иллюстративные, не получены от реального ЛПР.'],
  },
};

/**
 * Control problem with known analytic answer (WSM, min–max):
 * r(c1) = (1, 0, 2/3), r(c2) = (0, 1, 2/3) → S_A = w, S_B = 1 − w, S_C = 2/3.
 * Leader: B for w < 1/3, C for 1/3 < w < 2/3, A for w > 2/3.
 */
export const thresholdControl: DecisionProblem = {
  schema_version: SCHEMA_VERSION,
  problem_id: 'threshold-control',
  context: { title: 'Контрольный пример: пороги смены лидера 1/3 и 2/3', domain: 'test' },
  alternatives: [
    { alternative_id: 'A', name: 'A' },
    { alternative_id: 'B', name: 'B' },
    { alternative_id: 'C', name: 'C' },
  ],
  criteria: [
    { criterion_id: 'c1', name: 'Критерий 1', direction: 'max' },
    { criterion_id: 'c2', name: 'Критерий 2', direction: 'max' },
  ],
  evaluations: [
    { alternative_id: 'A', criterion_id: 'c1', value: { kind: 'exact', value: 10 } },
    { alternative_id: 'A', criterion_id: 'c2', value: { kind: 'exact', value: 2 } },
    { alternative_id: 'B', criterion_id: 'c1', value: { kind: 'exact', value: 4 } },
    { alternative_id: 'B', criterion_id: 'c2', value: { kind: 'exact', value: 8 } },
    { alternative_id: 'C', criterion_id: 'c1', value: { kind: 'exact', value: 8 } },
    { alternative_id: 'C', criterion_id: 'c2', value: { kind: 'exact', value: 6 } },
  ],
  weights: {
    normalization: 'sum_to_one',
    items: [
      { criterion_id: 'c1', value: 0.5, lower: 0, upper: 1 },
      { criterion_id: 'c2', value: 0.5, lower: 0, upper: 1 },
    ],
  },
  constraints: [],
  method: { id: 'wsm' },
  uncertainty: { mode: 'MF_WF', iterations: 1000, seed: 1 },
  metadata: { origin: 'example', source: 'контрольный пример с аналитическим решением' },
};

/** Exercises every uncertainty feature: triangular, scenarios, missing values, constraints, ordinal weights. */
export const mixedUncertainty: DecisionProblem = {
  schema_version: SCHEMA_VERSION,
  problem_id: 'mixed-uncertainty',
  context: { title: 'Выбор логистического оператора (иллюстрация всех видов неопределённости)', domain: 'logistics' },
  alternatives: [
    { alternative_id: 'op1', name: 'Оператор 1' },
    { alternative_id: 'op2', name: 'Оператор 2' },
    { alternative_id: 'op3', name: 'Оператор 3' },
    { alternative_id: 'op4', name: 'Оператор 4' },
  ],
  criteria: [
    { criterion_id: 'cost', name: 'Стоимость доставки', direction: 'min', unit: 'руб./заказ', range: { min: 0 } },
    { criterion_id: 'otd', name: 'Доля доставок в срок', direction: 'max', unit: '%', range: { min: 0, max: 100 } },
    { criterion_id: 'damage', name: 'Повреждения', direction: 'min', unit: '%', range: { min: 0, max: 100 }, missing_policy: 'worst_observed' },
    { criterion_id: 'coverage', name: 'Покрытие регионов', direction: 'max', unit: 'регионов', value_type: 'integer' },
  ],
  evaluations: [
    { alternative_id: 'op1', criterion_id: 'cost', value: { kind: 'interval', lower: 180, upper: 220, distribution: 'triangular', mode: 190 } },
    { alternative_id: 'op1', criterion_id: 'otd', value: { kind: 'exact', value: 94 } },
    { alternative_id: 'op1', criterion_id: 'damage', value: { kind: 'exact', value: 0.6 } },
    { alternative_id: 'op1', criterion_id: 'coverage', value: { kind: 'exact', value: 60 } },
    { alternative_id: 'op2', criterion_id: 'cost', value: { kind: 'exact', value: 205 } },
    { alternative_id: 'op2', criterion_id: 'otd', value: { kind: 'scenarios', scenarios: [{ label: 'штатно', value: 97, probability: 0.7 }, { label: 'пик сезона', value: 88, probability: 0.3 }] } },
    { alternative_id: 'op2', criterion_id: 'damage', value: { kind: 'missing', reason: 'оператор не раскрыл статистику' } },
    { alternative_id: 'op2', criterion_id: 'coverage', value: { kind: 'exact', value: 75 } },
    { alternative_id: 'op3', criterion_id: 'cost', value: { kind: 'interval', lower: 150, upper: 200 } },
    { alternative_id: 'op3', criterion_id: 'otd', value: { kind: 'interval', lower: 85, upper: 93 } },
    { alternative_id: 'op3', criterion_id: 'damage', value: { kind: 'interval', lower: 0.8, upper: 1.5 } },
    { alternative_id: 'op3', criterion_id: 'coverage', value: { kind: 'exact', value: 40 } },
    { alternative_id: 'op4', criterion_id: 'cost', value: { kind: 'exact', value: 260 } },
    { alternative_id: 'op4', criterion_id: 'otd', value: { kind: 'exact', value: 98 } },
    { alternative_id: 'op4', criterion_id: 'damage', value: { kind: 'exact', value: 0.3 } },
    { alternative_id: 'op4', criterion_id: 'coverage', value: { kind: 'exact', value: 80 } },
  ].map((e) => ({ ...e, provenance: 'synthetic' as const })) as DecisionProblem['evaluations'],
  weights: {
    normalization: 'sum_to_one',
    items: [
      { criterion_id: 'cost', value: 0.4 },
      { criterion_id: 'otd', value: 0.3, lower: 0.2, upper: 0.45 },
      { criterion_id: 'damage', value: 0.15, lower: 0.05, upper: 0.25 },
      { criterion_id: 'coverage', value: 0.15, lower: 0.05, upper: 0.3 },
    ],
    ordinal: [{ greater: 'otd', lesser: 'damage' }],
  },
  constraints: [
    { constraint_id: 'budget', type: 'threshold', criterion_id: 'cost', op: '<=', value: 250, description: 'Бюджет — не более 250 руб./заказ' },
  ],
  method: { id: 'topsis', params: { normalization: 'minmax' } },
  uncertainty: { mode: 'MU_WU', iterations: 3000, seed: 7, m: { default_interval_distribution: 'uniform', point_rule: 'expected_value' }, w: { sampler: 'polytope_rejection' } },
  metadata: { origin: 'example', source: 'синтетический пример', notes: ['Вес стоимости фиксирован (0.4) и не меняется в режиме W uncertain.'] },
};

export const EXAMPLES: Record<string, DecisionProblem> = {
  [supplierDemo.problem_id]: supplierDemo,
  [thresholdControl.problem_id]: thresholdControl,
  [mixedUncertainty.problem_id]: mixedUncertainty,
};
