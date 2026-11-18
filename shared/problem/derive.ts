import type { DecisionProblem, Evaluation, EvaluationValue } from './schema.js';
import type { ResolvedSettings } from './settings.js';

export const SUM_TOLERANCE = 1e-6;

export function evaluationKey(alternativeId: string, criterionId: string): string {
  return `${alternativeId}\u0000${criterionId}`;
}

export function indexEvaluations(problem: DecisionProblem): Map<string, Evaluation> {
  const map = new Map<string, Evaluation>();
  for (const e of problem.evaluations) {
    const key = evaluationKey(e.alternative_id, e.criterion_id);
    if (!map.has(key)) map.set(key, e);
  }
  return map;
}

export type IntervalDistribution = 'uniform' | 'triangular';

/** Distribution actually used for an interval evaluation (explicit or the configured default). */
export function intervalDistribution(
  v: Extract<EvaluationValue, { kind: 'interval' }>,
  settings: Pick<ResolvedSettings, 'm'>,
): IntervalDistribution {
  return v.distribution ?? settings.m.default_interval_distribution;
}

/**
 * Point estimate used in M-fixed mode and as the sensitivity baseline.
 * Explicit `point` wins; otherwise the expected value of the declared distribution
 * (uniform: (l+u)/2, triangular: (l+m+u)/3, scenarios: Σ p·v) when point_rule = expected_value.
 * Returns null when no point can be derived (missing value or explicit_only without point).
 */
export function pointValue(
  v: EvaluationValue,
  settings: Pick<ResolvedSettings, 'm'>,
): number | null {
  switch (v.kind) {
    case 'exact':
      return v.value;
    case 'interval': {
      if (v.point !== undefined) return v.point;
      if (settings.m.point_rule === 'explicit_only') return null;
      const dist = intervalDistribution(v, settings);
      if (dist === 'triangular') {
        if (v.mode === undefined) return null;
        return (v.lower + v.mode + v.upper) / 3;
      }
      return (v.lower + v.upper) / 2;
    }
    case 'scenarios': {
      if (v.point !== undefined) return v.point;
      if (settings.m.point_rule === 'explicit_only') return null;
      return v.scenarios.reduce((s, x) => s + x.probability * x.value, 0);
    }
    case 'missing':
      return null;
  }
}

export function isUncertainValue(v: EvaluationValue): boolean {
  return v.kind === 'interval' || v.kind === 'scenarios';
}

/** Support [min, max] of an evaluation value (null for missing). */
export function valueSupport(v: EvaluationValue): [number, number] | null {
  switch (v.kind) {
    case 'exact':
      return [v.value, v.value];
    case 'interval':
      return [Math.min(v.lower, v.upper), Math.max(v.lower, v.upper)];
    case 'scenarios': {
      const xs = v.scenarios.map((s) => s.value);
      return [Math.min(...xs), Math.max(...xs)];
    }
    case 'missing':
      return null;
  }
}

export interface WeightPartition {
  /** criterion ids in problem order */
  ids: string[];
  /** exact point weight per criterion (null if not given) */
  point: (number | null)[];
  /** in W-uncertain mode: is the criterion weight sampled? */
  uncertain: boolean[];
  /** effective bounds in W-uncertain mode (fixed weights: [v, v]) */
  lower: number[];
  upper: number[];
  /** criteria whose weight is neither given nor bounded (implicit [0, 1]) */
  unspecified: string[];
  sumLower: number;
  sumUpper: number;
  sumPoint: number | null;
}

/**
 * Splits weights into fixed and uncertain parts for W-uncertain mode.
 * A weight is uncertain iff it has an explicit bound or no exact value at all
 * (then its bounds are the full feasible range [0, 1]).
 */
export function partitionWeights(problem: DecisionProblem): WeightPartition {
  const byId = new Map(problem.weights.items.map((w) => [w.criterion_id, w]));
  const ids = problem.criteria.map((c) => c.criterion_id);
  const point: (number | null)[] = [];
  const uncertain: boolean[] = [];
  const lower: number[] = [];
  const upper: number[] = [];
  const unspecified: string[] = [];
  for (const id of ids) {
    const w = byId.get(id);
    const value = w?.value ?? null;
    const lo = w?.lower ?? null;
    const hi = w?.upper ?? null;
    point.push(value);
    if (lo !== null || hi !== null) {
      uncertain.push(true);
      lower.push(lo ?? 0);
      upper.push(hi ?? 1);
    } else if (value !== null) {
      uncertain.push(false);
      lower.push(value);
      upper.push(value);
    } else {
      uncertain.push(true);
      lower.push(0);
      upper.push(1);
      unspecified.push(id);
    }
  }
  const sumPoint = point.every((v) => v !== null)
    ? (point as number[]).reduce((s, v) => s + v, 0)
    : null;
  return {
    ids,
    point,
    uncertain,
    lower,
    upper,
    unspecified,
    sumLower: lower.reduce((s, v) => s + v, 0),
    sumUpper: upper.reduce((s, v) => s + v, 0),
    sumPoint,
  };
}

/** Alternatives remaining after `exclude` constraints and point-value threshold constraints. */
export function feasibleAlternatives(
  problem: DecisionProblem,
  settings: Pick<ResolvedSettings, 'm'>,
): {
  kept: string[];
  excluded: { alternative_id: string; constraint_id: string; reason: string }[];
} {
  const evals = indexEvaluations(problem);
  const excluded: { alternative_id: string; constraint_id: string; reason: string }[] = [];
  const excludedIds = new Set<string>();
  for (const c of problem.constraints) {
    if (c.type === 'exclude') {
      if (!excludedIds.has(c.alternative_id)) {
        excludedIds.add(c.alternative_id);
        excluded.push({
          alternative_id: c.alternative_id,
          constraint_id: c.constraint_id,
          reason: c.reason ?? 'исключено ограничением',
        });
      }
    }
  }
  for (const c of problem.constraints) {
    if (c.type !== 'threshold') continue;
    for (const a of problem.alternatives) {
      if (excludedIds.has(a.alternative_id)) continue;
      const e = evals.get(evaluationKey(a.alternative_id, c.criterion_id));
      const p = e ? pointValue(e.value, settings) : null;
      if (p === null) continue;
      if (!compare(p, c.op, c.value)) {
        excludedIds.add(a.alternative_id);
        excluded.push({
          alternative_id: a.alternative_id,
          constraint_id: c.constraint_id,
          reason: `точечная оценка ${formatNum(p)} не удовлетворяет условию ${c.criterion_id} ${c.op} ${formatNum(c.value)}`,
        });
      }
    }
  }
  return {
    kept: problem.alternatives.map((a) => a.alternative_id).filter((id) => !excludedIds.has(id)),
    excluded,
  };
}

export function compare(x: number, op: '<=' | '<' | '>=' | '>' | '==', y: number): boolean {
  switch (op) {
    case '<=':
      return x <= y;
    case '<':
      return x < y;
    case '>=':
      return x >= y;
    case '>':
      return x > y;
    case '==':
      return Math.abs(x - y) <= 1e-12 * Math.max(1, Math.abs(y));
  }
}

export function formatNum(x: number): string {
  if (!Number.isFinite(x)) return String(x);
  const r = Math.round(x * 1e6) / 1e6;
  return String(r);
}
