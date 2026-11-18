import type { DecisionProblem, Evaluation } from '../problem/schema.js';
import {
  SUM_TOLERANCE,
  evaluationKey,
  intervalDistribution,
  partitionWeights,
  pointValue,
  type WeightPartition,
} from '../problem/derive.js';
import type { ResolvedSettings, WSampler } from '../problem/settings.js';
import { exponential, gamma, pickCumulative, standardNormal, triangularInv, type Rng } from './rng.js';

export class EngineError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'EngineError';
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// M: evaluation matrix
// ---------------------------------------------------------------------------

type Cell =
  | { kind: 'const'; value: number }
  | { kind: 'missing' }
  | { kind: 'uniform'; lower: number; upper: number }
  | { kind: 'triangular'; lower: number; mode: number; upper: number }
  | { kind: 'scenarios'; values: number[]; cumulative: number[] };

export interface UncertainCellInfo {
  alternative_id: string;
  criterion_id: string;
  kind: 'interval' | 'scenarios';
  distribution: 'uniform' | 'triangular' | 'discrete';
  lower: number;
  upper: number;
  mode?: number;
  scenarios?: { value: number; probability: number; label?: string }[];
  point: number | null;
}

export interface MatrixModel {
  altIds: string[];
  critIds: string[];
  /** point matrix (null = missing) */
  point: (number | null)[][];
  cells: Cell[][];
  uncertain: UncertainCellInfo[];
  missing: { alternative_id: string; criterion_id: string }[];
  directions: ('min' | 'max')[];
}

export function buildMatrixModel(
  problem: DecisionProblem,
  altIds: string[],
  settings: ResolvedSettings,
): MatrixModel {
  const evals = new Map<string, Evaluation>();
  for (const e of problem.evaluations) evals.set(evaluationKey(e.alternative_id, e.criterion_id), e);
  const critIds = problem.criteria.map((c) => c.criterion_id);
  const point: (number | null)[][] = [];
  const cells: Cell[][] = [];
  const uncertain: UncertainCellInfo[] = [];
  const missing: { alternative_id: string; criterion_id: string }[] = [];
  for (const a of altIds) {
    const pRow: (number | null)[] = [];
    const cRow: Cell[] = [];
    for (const c of critIds) {
      const e = evals.get(evaluationKey(a, c));
      if (!e || e.value.kind === 'missing') {
        pRow.push(null);
        cRow.push({ kind: 'missing' });
        missing.push({ alternative_id: a, criterion_id: c });
        continue;
      }
      const v = e.value;
      const p = pointValue(v, settings);
      pRow.push(p);
      if (v.kind === 'exact') {
        cRow.push({ kind: 'const', value: v.value });
      } else if (v.kind === 'interval') {
        const dist = intervalDistribution(v, settings);
        if (dist === 'triangular') {
          cRow.push({ kind: 'triangular', lower: v.lower, mode: v.mode as number, upper: v.upper });
        } else {
          cRow.push({ kind: 'uniform', lower: v.lower, upper: v.upper });
        }
        uncertain.push({
          alternative_id: a,
          criterion_id: c,
          kind: 'interval',
          distribution: dist,
          lower: v.lower,
          upper: v.upper,
          mode: dist === 'triangular' ? v.mode : undefined,
          point: p,
        });
      } else {
        const cumulative: number[] = [];
        let acc = 0;
        for (const s of v.scenarios) {
          acc += s.probability;
          cumulative.push(acc);
        }
        cRow.push({ kind: 'scenarios', values: v.scenarios.map((s) => s.value), cumulative });
        const xs = v.scenarios.map((s) => s.value);
        uncertain.push({
          alternative_id: a,
          criterion_id: c,
          kind: 'scenarios',
          distribution: 'discrete',
          lower: Math.min(...xs),
          upper: Math.max(...xs),
          scenarios: v.scenarios.map((s) => ({ value: s.value, probability: s.probability, label: s.label })),
          point: p,
        });
      }
    }
    point.push(pRow);
    cells.push(cRow);
  }
  return {
    altIds,
    critIds,
    point,
    cells,
    uncertain,
    missing,
    directions: problem.criteria.map((c) => c.direction),
  };
}

/** Missing cells (policy worst_observed) get the worst value of their column in this matrix. */
function fillMissing(matrix: (number | null)[][], directions: ('min' | 'max')[]): number[][] {
  const m = directions.length;
  const worst = new Array<number>(m);
  for (let j = 0; j < m; j++) {
    let w = directions[j] === 'min' ? -Infinity : Infinity;
    for (const row of matrix) {
      const x = row[j];
      if (x === null) continue;
      if (directions[j] === 'min' ? x > w : x < w) w = x;
    }
    worst[j] = w;
  }
  return matrix.map((row) => row.map((x, j) => (x === null ? worst[j] : x)));
}

export function pointMatrix(model: MatrixModel): number[][] {
  return fillMissing(model.point, model.directions);
}

/**
 * One draw of M. Exact cells are copied unchanged; every uncertain cell consumes exactly
 * one uniform from the M stream (inverse-CDF sampling), in row-major order.
 */
export function sampleMatrix(model: MatrixModel, rng: Rng): number[][] {
  const raw: (number | null)[][] = model.cells.map((row) =>
    row.map((cell) => {
      switch (cell.kind) {
        case 'const':
          return cell.value;
        case 'missing':
          return null;
        case 'uniform': {
          const u = rng();
          return cell.lower + (cell.upper - cell.lower) * u;
        }
        case 'triangular':
          return triangularInv(rng(), cell.lower, cell.mode, cell.upper);
        case 'scenarios':
          return cell.values[pickCumulative(rng(), cell.cumulative)];
      }
    }),
  );
  return fillMissing(raw, model.directions);
}

// ---------------------------------------------------------------------------
// W: weight vector
// ---------------------------------------------------------------------------

export interface WeightModel {
  ids: string[];
  partition: WeightPartition;
  sampler: WSampler;
  /** indices of sampled (uncertain) criteria */
  free: number[];
  /** bounds of free weights after folding ordinal constraints with fixed weights */
  lower: number[];
  upper: number[];
  /** mass available to free weights: 1 − Σ fixed */
  total: number;
  /** ordinal pairs between free weights (indices into `free`) */
  ordinal: [number, number][];
  base: number[];
  alpha: number[] | null;
  scenarios: { values: number[]; cumulative: number[] } | null;
  stats: { attempts: number; accepted: number };
  /** Markov chain state for hit-and-run */
  chain: number[] | null;
  maxAttempts: number;
  burnIn: number;
  thinning: number;
}

export function buildWeightModel(problem: DecisionProblem, settings: ResolvedSettings): WeightModel {
  const partition = partitionWeights(problem);
  const ids = partition.ids;
  const free: number[] = [];
  ids.forEach((_, i) => {
    if (partition.uncertain[i]) free.push(i);
  });
  const fixedSum = ids.reduce((s, _, i) => (partition.uncertain[i] ? s : s + partition.lower[i]), 0);
  const base = ids.map((_, i) => (partition.uncertain[i] ? 0 : partition.lower[i]));
  const lower = free.map((i) => partition.lower[i]);
  const upper = free.map((i) => partition.upper[i]);
  const ordinal: [number, number][] = [];
  for (const o of problem.weights.ordinal ?? []) {
    const gi = ids.indexOf(o.greater);
    const li = ids.indexOf(o.lesser);
    if (gi < 0 || li < 0) continue;
    const gf = free.indexOf(gi);
    const lf = free.indexOf(li);
    if (gf >= 0 && lf >= 0) ordinal.push([gf, lf]);
    else if (gf >= 0) lower[gf] = Math.max(lower[gf], partition.lower[li]);
    else if (lf >= 0) upper[lf] = Math.min(upper[lf], partition.lower[gi]);
  }
  let alpha: number[] | null = null;
  if (settings.w.sampler === 'dirichlet') {
    const a = settings.w.dirichlet_alpha ?? {};
    alpha = free.map((i) => a[ids[i]]);
  }
  let scenarios: WeightModel['scenarios'] = null;
  if (settings.w.sampler === 'scenarios') {
    const list = problem.weights.scenarios ?? [];
    let acc = 0;
    scenarios = {
      values: [],
      cumulative: [],
    };
    const flat: number[] = [];
    for (const s of list) {
      acc += s.probability;
      scenarios.cumulative.push(acc);
      for (const id of ids) flat.push(s.values[id]);
    }
    scenarios.values = flat;
  }
  return {
    ids,
    partition,
    sampler: settings.w.sampler,
    free,
    lower,
    upper,
    total: 1 - fixedSum,
    ordinal,
    base,
    alpha,
    scenarios,
    stats: { attempts: 0, accepted: 0 },
    chain: null,
    maxAttempts: settings.w.max_attempts_per_sample,
    burnIn: settings.w.hit_and_run_burn_in,
    thinning: settings.w.hit_and_run_thinning,
  };
}

/** Exact point weights (W fixed). Never re-normalized: validation guarantees Σ = 1. */
export function pointWeights(model: WeightModel): number[] {
  return model.partition.point.map((v) => v as number);
}

function feasible(model: WeightModel, x: number[]): boolean {
  for (let k = 0; k < x.length; k++) {
    if (x[k] < model.lower[k] - SUM_TOLERANCE || x[k] > model.upper[k] + SUM_TOLERANCE) return false;
  }
  for (const [g, l] of model.ordinal) if (x[g] < x[l] - SUM_TOLERANCE) return false;
  return true;
}

function assemble(model: WeightModel, x: number[]): number[] {
  const w = model.base.slice();
  model.free.forEach((i, k) => {
    w[i] = x[k];
  });
  return w;
}

/**
 * Uniform proposal on the shifted simplex {l + y : y ≥ 0, Σ y = total − Σ l}
 * (normalized exponentials). Accepting only feasible points yields the uniform
 * distribution on the feasible weight polytope (bounds + ordinal constraints, Σ w = 1).
 */
function proposeShifted(model: WeightModel, rng: Rng): number[] {
  const k = model.free.length;
  const slack = model.total - model.lower.reduce((s, v) => s + v, 0);
  const e = new Array<number>(k);
  let sum = 0;
  for (let i = 0; i < k; i++) {
    e[i] = exponential(rng);
    sum += e[i];
  }
  return e.map((x, i) => model.lower[i] + (slack * x) / sum);
}

function rejectionSample(model: WeightModel, propose: () => number[]): number[] {
  for (let attempt = 1; attempt <= model.maxAttempts; attempt++) {
    model.stats.attempts++;
    const x = propose();
    if (feasible(model, x)) {
      model.stats.accepted++;
      return x;
    }
  }
  throw new EngineError(
    'weight_sampler_low_acceptance',
    `Генератор весов не нашёл допустимый вектор за ${model.maxAttempts} попыток: допустимое множество весов слишком узкое для метода отбраковки. Используйте sampler = "polytope_hit_and_run" или ослабьте ограничения.`,
  );
}

function hitAndRunStep(model: WeightModel, rng: Rng, x: number[]): void {
  const k = x.length;
  const d = new Array<number>(k);
  let mean = 0;
  for (let i = 0; i < k; i++) {
    d[i] = standardNormal(rng);
    mean += d[i];
  }
  mean /= k;
  let norm = 0;
  for (let i = 0; i < k; i++) {
    d[i] -= mean;
    norm += d[i] * d[i];
  }
  norm = Math.sqrt(norm);
  if (!(norm > 0)) return;
  for (let i = 0; i < k; i++) d[i] /= norm;
  let tMin = -Infinity;
  let tMax = Infinity;
  for (let i = 0; i < k; i++) {
    if (d[i] > 1e-15) {
      tMin = Math.max(tMin, (model.lower[i] - x[i]) / d[i]);
      tMax = Math.min(tMax, (model.upper[i] - x[i]) / d[i]);
    } else if (d[i] < -1e-15) {
      tMin = Math.max(tMin, (model.upper[i] - x[i]) / d[i]);
      tMax = Math.min(tMax, (model.lower[i] - x[i]) / d[i]);
    }
  }
  for (const [g, l] of model.ordinal) {
    const gap = x[g] - x[l];
    const dd = d[g] - d[l];
    if (dd > 1e-15) tMin = Math.max(tMin, -gap / dd);
    else if (dd < -1e-15) tMax = Math.min(tMax, -gap / dd);
  }
  if (!(tMax >= tMin)) return;
  const t = tMin + (tMax - tMin) * rng();
  for (let i = 0; i < k; i++) x[i] += t * d[i];
  // keep Σ x = total exact up to rounding drift
  const drift = (model.total - x.reduce((s, v) => s + v, 0)) / k;
  for (let i = 0; i < k; i++) x[i] += drift;
}

/** One draw of W in W-uncertain mode. Fixed weights are copied unchanged. */
export function sampleWeights(model: WeightModel, rng: Rng): number[] {
  const k = model.free.length;
  if (model.sampler === 'scenarios') {
    const sc = model.scenarios!;
    const idx = pickCumulative(rng(), sc.cumulative);
    const n = model.ids.length;
    return sc.values.slice(idx * n, idx * n + n);
  }
  if (k === 0) return model.base.slice();
  if (k === 1) return assemble(model, [model.total]);
  if (model.sampler === 'dirichlet') {
    const alpha = model.alpha!;
    const x = rejectionSample(model, () => {
      const g = alpha.map((a) => gamma(rng, a));
      const s = g.reduce((acc, v) => acc + v, 0);
      return g.map((v) => (model.total * v) / s);
    });
    return assemble(model, x);
  }
  if (model.sampler === 'polytope_hit_and_run') {
    if (!model.chain) {
      model.chain = rejectionSample(model, () => proposeShifted(model, rng));
      for (let i = 0; i < model.burnIn; i++) hitAndRunStep(model, rng, model.chain);
    }
    for (let i = 0; i < model.thinning; i++) hitAndRunStep(model, rng, model.chain);
    return assemble(
      model,
      model.chain.map((v, i) => Math.min(model.upper[i], Math.max(model.lower[i], v))),
    );
  }
  return assemble(
    model,
    rejectionSample(model, () => proposeShifted(model, rng)),
  );
}
