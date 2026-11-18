import type { DecisionProblem, ModeId } from '../problem/schema.js';
import { evaluationKey, partitionWeights, pointValue } from '../problem/derive.js';
import type { RunOverrides } from '../problem/settings.js';
import { evaluateMethod, normalizeMinMax, type ResolvedMethod } from './methods.js';
import { leaders, rankScores } from './ranking.js';
import { solve } from './solve.js';
import type { RunResult } from './types.js';

export interface SensitivityBase {
  problem: DecisionProblem;
  kept: string[];
  names: Map<string, string>;
  critIds: string[];
  critNames: Map<string, string>;
  directions: ('min' | 'max')[];
  matrix: number[][];
  weights: number[];
  weightsSource: 'exact' | 'sample_mean';
  method: ResolvedMethod;
  tol: number;
  baseLeaders: string[];
  overrides: RunOverrides;
}

export interface SweepPoint {
  x: number;
  scores: number[];
  ranks: number[];
  leader_ids: string[];
}

export interface LeaderSegment {
  from: number;
  to: number;
  leader_ids: string[];
}

export interface ChangePoint {
  at: number;
  before: string[];
  after: string[];
  method: 'analytic' | 'bisection';
  precision: number;
}

export interface SweepResult {
  kind: 'weight' | 'evaluation';
  parameter: {
    criterion_id: string;
    alternative_id?: string;
    label: string;
    base_value: number;
  };
  range: { from: number; to: number; step: number };
  scheme: string;
  method: ResolvedMethod;
  analytic: boolean;
  alternatives: { alternative_id: string; name: string }[];
  points: SweepPoint[];
  segments: LeaderSegment[];
  change_points: ChangePoint[];
  base_leader_ids: string[];
  nearest_change: {
    below: number | null;
    above: number | null;
    min_abs_delta: number | null;
  };
  statements: string[];
  notes: string[];
}

/** Baseline for what-if analysis: point M and exact W (or the sample-mean W when W is not exact). */
export function prepareBase(problem: DecisionProblem, overrides: RunOverrides = {}): SensitivityBase {
  const part = partitionWeights(problem);
  const hasExact = part.sumPoint !== null && Math.abs(part.sumPoint - 1) <= 1e-6;
  const mode: ModeId = hasExact ? 'MF_WF' : 'MF_WU';
  const res = solve(problem, {
    overrides: { ...overrides, mode, iterations: hasExact ? 1 : (overrides.iterations ?? 2000) },
  });
  return baseFromRun(problem, res, overrides);
}

export function baseFromRun(problem: DecisionProblem, res: RunResult, overrides: RunOverrides): SensitivityBase {
  const kept = res.alternatives_kept;
  const critIds = problem.criteria.map((c) => c.criterion_id);
  const matrix = kept.map((a) =>
    critIds.map((c) => res.baseline.trace.find((t) => t.alternative_id === a && t.criterion_id === c)!.raw),
  );
  return {
    problem,
    kept,
    names: new Map(problem.alternatives.map((a) => [a.alternative_id, a.name])),
    critIds,
    critNames: new Map(problem.criteria.map((c) => [c.criterion_id, c.name])),
    directions: problem.criteria.map((c) => c.direction),
    matrix,
    weights: critIds.map((c) => res.baseline.weights[c]),
    weightsSource: res.baseline.weights_source,
    method: res.settings.method,
    tol: res.settings.tie_tolerance,
    baseLeaders: res.baseline.leader_ids,
    overrides,
  };
}

function evaluateAt(base: SensitivityBase, matrix: number[][], weights: number[]): SweepPoint & { x: number } {
  const ev = evaluateMethod(base.method, matrix, base.directions, weights);
  const r = rankScores(ev.scores, ev.higherIsBetter, base.tol);
  return { x: NaN, scores: ev.scores, ranks: r.rank, leader_ids: leaders(r).map((i) => base.kept[i]).sort() };
}

/** Proportional rescaling: w_j := t, others keep their mutual proportions and sum to 1 − t. */
export function rescaleWeights(weights: number[], j: number, t: number): number[] {
  const rest = weights.reduce((s, w, k) => (k === j ? s : s + w), 0);
  const m = weights.length;
  return weights.map((w, k) => {
    if (k === j) return t;
    if (rest > 0) return (w * (1 - t)) / rest;
    return m > 1 ? (1 - t) / (m - 1) : 0;
  });
}

const sameSet = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i]);

function decimals(precision: number): number {
  return Math.min(8, Math.max(0, Math.ceil(-Math.log10(precision))));
}

export function fmt(x: number, digits = 4): string {
  if (!Number.isFinite(x)) return String(x);
  return String(Number(x.toFixed(digits)));
}

function namesOf(base: SensitivityBase, ids: string[]): string {
  return ids.map((id) => base.names.get(id) ?? id).join(' = ');
}

function buildStatements(
  base: SensitivityBase,
  label: string,
  from: number,
  to: number,
  segments: LeaderSegment[],
  digits: number,
): string[] {
  if (segments.length <= 1) {
    const ids = segments[0]?.leader_ids ?? [];
    return [`Во всём диапазоне ${label} ∈ [${fmt(from, digits)}; ${fmt(to, digits)}] лидер — ${namesOf(base, ids)}: смены лидера нет.`];
  }
  return segments.map((s, i) => {
    if (i === 0) return `${label} < ${fmt(s.to, digits)} → ${namesOf(base, s.leader_ids)}`;
    if (i === segments.length - 1) return `${label} ≥ ${fmt(s.from, digits)} → ${namesOf(base, s.leader_ids)}`;
    return `${fmt(s.from, digits)} ≤ ${label} < ${fmt(s.to, digits)} → ${namesOf(base, s.leader_ids)}`;
  });
}

function segmentsFrom(from: number, to: number, cps: ChangePoint[], first: string[]): LeaderSegment[] {
  const segs: LeaderSegment[] = [];
  let start = from;
  let cur = first;
  for (const cp of cps) {
    segs.push({ from: start, to: cp.at, leader_ids: cur });
    start = cp.at;
    cur = cp.after;
  }
  segs.push({ from: start, to, leader_ids: cur });
  return segs;
}

function nearest(cps: ChangePoint[], baseValue: number): SweepResult['nearest_change'] {
  let below: number | null = null;
  let above: number | null = null;
  for (const cp of cps) {
    if (cp.at <= baseValue && (below === null || cp.at > below)) below = cp.at;
    if (cp.at > baseValue && (above === null || cp.at < above)) above = cp.at;
  }
  const deltas = [below, above].filter((x): x is number => x !== null).map((x) => Math.abs(x - baseValue));
  return { below, above, min_abs_delta: deltas.length ? Math.min(...deltas) : null };
}

/** Numeric change-point search: grid scan + bisection of every interval where the leader set changes. */
function numericChangePoints(
  leadersAt: (x: number) => string[],
  grid: number[],
  precision: number,
): ChangePoint[] {
  const cps: ChangePoint[] = [];
  let prevX = grid[0];
  let prevL = leadersAt(prevX);
  for (let g = 1; g < grid.length; g++) {
    const x = grid[g];
    const L = leadersAt(x);
    let lo = prevX;
    let loL = prevL;
    let guard = 0;
    while (!sameSet(loL, L) && guard++ < 50) {
      let a = lo;
      let b = x;
      while (b - a > precision) {
        const mid = (a + b) / 2;
        if (sameSet(leadersAt(mid), loL)) a = mid;
        else b = mid;
      }
      const after = leadersAt(b);
      cps.push({ at: (a + b) / 2, before: loL, after, method: 'bisection', precision: (b - a) / 2 });
      lo = b;
      loL = after;
    }
    prevX = x;
    prevL = L;
  }
  return mergeTransientTies(cps, precision);
}

/**
 * A crossing of two scores passes through a tie zone of width ≈ 2·tol/|Δslope|. When the
 * bisection resolves it, A → {A,B} → B appears as two change points; merge them into one.
 */
function mergeTransientTies(cps: ChangePoint[], precision: number): ChangePoint[] {
  const eps = Math.max(8 * precision, 1e-9);
  const out: ChangePoint[] = [];
  for (let k = 0; k < cps.length; k++) {
    const cur = cps[k];
    const next = cps[k + 1];
    const isTie =
      next &&
      cur.after.length > 1 &&
      sameSet(next.before, cur.after) &&
      next.at - cur.at <= eps &&
      cur.before.every((x) => cur.after.includes(x)) &&
      next.after.every((x) => cur.after.includes(x));
    if (isTie) {
      if (!sameSet(cur.before, next.after))
        out.push({
          at: (cur.at + next.at) / 2,
          before: cur.before,
          after: next.after,
          method: 'bisection',
          precision: (next.at - cur.at) / 2 + Math.max(cur.precision, next.precision),
        });
      k++;
      continue;
    }
    out.push(cur);
  }
  return out;
}

export interface WeightSweepOptions {
  criterion_id: string;
  from?: number;
  to?: number;
  step?: number;
  precision?: number;
  /** Force the numeric search even where an analytic solution exists (cross-check). */
  numeric?: boolean;
}

export function weightSweep(base: SensitivityBase, opts: WeightSweepOptions): SweepResult {
  const j = base.critIds.indexOf(opts.criterion_id);
  if (j < 0) throw new Error(`Неизвестный критерий «${opts.criterion_id}»`);
  const from = Math.max(0, opts.from ?? 0);
  const to = Math.min(1, opts.to ?? 1);
  const step = opts.step ?? 0.01;
  const precision = opts.precision ?? 1e-6;
  const label = `w(${base.critNames.get(opts.criterion_id) ?? opts.criterion_id})`;
  const baseValue = base.weights[j];
  const grid: number[] = [];
  for (let x = from; x < to - 1e-12; x += step) grid.push(Number(x.toFixed(12)));
  grid.push(to);
  const at = (t: number) => evaluateAt(base, base.matrix, rescaleWeights(base.weights, j, t));
  const points = grid.map((x) => ({ ...at(x), x }));
  const notes: string[] = [];
  let cps: ChangePoint[];
  let analytic = false;
  if (base.method.id === 'wsm' && !opts.numeric) {
    analytic = true;
    cps = wsmAnalyticChangePoints(base, j, from, to);
    notes.push('WSM: score линейно зависит от веса при пропорциональном перераспределении остальных, поэтому границы смены лидера найдены аналитически как точки пересечения прямых (верхняя огибающая).');
  } else {
    cps = numericChangePoints((t) => at(t).leader_ids, grid, precision);
    notes.push(`${base.method.id.toUpperCase()}: границы найдены численно — перебор с шагом ${step} и уточнение бисекцией до ±${precision}. Смены лидера на участках короче шага могут быть пропущены.`);
  }
  if (base.weightsSource === 'sample_mean')
    notes.push('Точные веса заданы не для всех критериев: базовая точка — средний выборочный вектор весов (расчётная величина).');
  const first = cps.length ? cps[0].before : at((from + to) / 2).leader_ids;
  const segments = segmentsFrom(from, to, cps, first);
  const digits = analytic ? 4 : decimals(precision);
  return {
    kind: 'weight',
    parameter: { criterion_id: opts.criterion_id, label, base_value: baseValue },
    range: { from, to, step },
    scheme: `Меняется только ${label}; остальные веса сохраняют взаимные пропорции и в сумме дают 1 − ${label}. Матрица M — точечные оценки, неизменна.`,
    method: base.method,
    analytic,
    alternatives: base.kept.map((id) => ({ alternative_id: id, name: base.names.get(id) ?? id })),
    points,
    segments,
    change_points: cps,
    base_leader_ids: base.baseLeaders,
    nearest_change: nearest(cps, baseValue),
    statements: buildStatements(base, label, from, to, segments, digits),
    notes,
  };
}

/**
 * WSM with proportional rescaling: S_a(t) = c_a + s_a·t, c_a = B_a, s_a = r_aj − B_a,
 * B_a = Σ_{k≠j} w_k r_ak / Σ_{k≠j} w_k. The leader set over t is the upper envelope of the lines.
 */
function wsmAnalyticChangePoints(base: SensitivityBase, j: number, from: number, to: number): ChangePoint[] {
  const norm = normalizeMinMax(base.matrix, base.directions);
  const m = base.weights.length;
  const rest = base.weights.reduce((s, w, k) => (k === j ? s : s + w), 0);
  const c = norm.map((row) => {
    let s = 0;
    for (let k = 0; k < m; k++) {
      if (k === j) continue;
      s += rest > 0 ? (base.weights[k] * row[k]) / rest : row[k] / Math.max(1, m - 1);
    }
    return s;
  });
  const slope = norm.map((row, a) => row[j] - c[a]);
  const value = (a: number, t: number) => c[a] + slope[a] * t;
  const tol = base.tol;
  const leaderSet = (t: number) => {
    let mx = -Infinity;
    for (let a = 0; a < norm.length; a++) mx = Math.max(mx, value(a, t));
    return base.kept.filter((_, a) => Math.abs(value(a, t) - mx) <= tol).sort();
  };
  const topRightOf = (t: number) => {
    let best = 0;
    for (let a = 1; a < norm.length; a++) {
      const d = value(a, t) - value(best, t);
      if (d > tol || (Math.abs(d) <= tol && slope[a] > slope[best])) best = a;
    }
    return best;
  };
  // breakpoints of the upper envelope
  const breaks: number[] = [];
  let t = from;
  let cur = topRightOf(t);
  for (let guard = 0; guard <= norm.length; guard++) {
    let tNext = Infinity;
    let next = -1;
    for (let b = 0; b < norm.length; b++) {
      if (b === cur || !(slope[b] > slope[cur] + 1e-15)) continue;
      const tx = (c[cur] - c[b]) / (slope[b] - slope[cur]);
      if (tx > t + 1e-12 && (tx < tNext - 1e-15 || (Math.abs(tx - tNext) <= 1e-15 && slope[b] > slope[next]))) {
        tNext = tx;
        next = b;
      }
    }
    if (next < 0 || tNext >= to) break;
    breaks.push(tNext);
    t = tNext;
    cur = next;
  }
  // leader set of each open segment is evaluated at its midpoint (away from tie points)
  const edges = [from, ...breaks, to];
  const segSets = edges.slice(0, -1).map((a, k) => leaderSet((a + edges[k + 1]) / 2));
  const cps: ChangePoint[] = [];
  for (let k = 0; k < breaks.length; k++) {
    if (!sameSet(segSets[k], segSets[k + 1]))
      cps.push({ at: breaks[k], before: segSets[k], after: segSets[k + 1], method: 'analytic', precision: 0 });
  }
  return cps;
}

export interface EvaluationSweepOptions {
  alternative_id: string;
  criterion_id: string;
  from?: number;
  to?: number;
  steps?: number;
  precision?: number;
}

export function evaluationSweep(base: SensitivityBase, opts: EvaluationSweepOptions): SweepResult {
  const i = base.kept.indexOf(opts.alternative_id);
  const j = base.critIds.indexOf(opts.criterion_id);
  if (i < 0) throw new Error(`Альтернатива «${opts.alternative_id}» отсутствует или исключена ограничениями`);
  if (j < 0) throw new Error(`Неизвестный критерий «${opts.criterion_id}»`);
  const baseValue = base.matrix[i][j];
  const col = base.matrix.map((r) => r[j]);
  let lo = Math.min(...col);
  let hi = Math.max(...col);
  const ev = base.problem.evaluations.find(
    (e) => evaluationKey(e.alternative_id, e.criterion_id) === evaluationKey(opts.alternative_id, opts.criterion_id),
  );
  if (ev && ev.value.kind === 'interval') {
    lo = Math.min(lo, ev.value.lower);
    hi = Math.max(hi, ev.value.upper);
  }
  let span = hi - lo;
  if (!(span > 0)) span = Math.max(1, Math.abs(baseValue) * 0.2);
  let from = opts.from ?? lo - 0.25 * span;
  let to = opts.to ?? hi + 0.25 * span;
  const range = base.problem.criteria[j].range;
  if (opts.from === undefined && range?.min != null) from = Math.max(from, range.min);
  if (opts.to === undefined && range?.max != null) to = Math.min(to, range.max);
  const steps = opts.steps ?? 200;
  const step = (to - from) / steps;
  const precision = opts.precision ?? Math.max(1e-9, span * 1e-6);
  const grid = Array.from({ length: steps + 1 }, (_, k) => (k === steps ? to : from + k * step));
  const at = (x: number) => {
    const mtx = base.matrix.map((r) => r.slice());
    mtx[i][j] = x;
    return evaluateAt(base, mtx, base.weights);
  };
  const points = grid.map((x) => ({ ...at(x), x }));
  const cps = numericChangePoints((x) => at(x).leader_ids, grid, precision);
  const label = `x(${base.names.get(opts.alternative_id) ?? opts.alternative_id}; ${base.critNames.get(opts.criterion_id) ?? opts.criterion_id})`;
  const segments = segmentsFrom(from, to, cps, cps.length ? cps[0].before : at((from + to) / 2).leader_ids);
  const unit = base.problem.criteria[j].unit;
  return {
    kind: 'evaluation',
    parameter: {
      criterion_id: opts.criterion_id,
      alternative_id: opts.alternative_id,
      label,
      base_value: baseValue,
    },
    range: { from, to, step },
    scheme: `Меняется только оценка ${label}${unit ? `, ${unit}` : ''}; остальные оценки и веса фиксированы на базовых значениях.`,
    method: base.method,
    analytic: false,
    alternatives: base.kept.map((id) => ({ alternative_id: id, name: base.names.get(id) ?? id })),
    points,
    segments,
    change_points: cps,
    base_leader_ids: base.baseLeaders,
    nearest_change: nearest(cps, baseValue),
    statements: buildStatements(base, label, from, to, segments, Math.max(2, decimals(precision))),
    notes: [
      'Min–max нормализация пересчитывается при каждом значении, поэтому зависимость score от оценки нелинейна: используется численный перебор с бисекцией.',
      `Диапазон по умолчанию — наблюдаемый размах критерия (и интервал оценки), расширенный на 25% в обе стороны${range ? ' и ограниченный допустимым диапазоном критерия' : ''}.`,
    ],
  };
}

export interface CriticalParameter {
  type: 'weight' | 'evaluation';
  criterion_id: string;
  alternative_id?: string;
  label: string;
  base_value: number;
  /** closest value at which the leader changes, or null if no change in the scanned range */
  flip_at: number | null;
  abs_delta: number | null;
  /** weights: same as abs_delta; evaluations: delta divided by the observed column span */
  relative_delta: number | null;
  new_leader_ids: string[] | null;
}

export interface SensitivityReport {
  base: {
    method: ResolvedMethod;
    weights: Record<string, number>;
    weights_source: 'exact' | 'sample_mean';
    leader_ids: string[];
  };
  weights: SweepResult[];
  critical: CriticalParameter[];
  summary: string[];
  scanned_cells: number;
  notes: string[];
}

function flipInfo(s: SweepResult): { flip_at: number | null; after: string[] | null } {
  const { below, above } = s.nearest_change;
  const b = s.parameter.base_value;
  let flip: number | null = null;
  if (below !== null && above !== null) flip = Math.abs(b - below) <= Math.abs(above - b) ? below : above;
  else flip = below ?? above;
  if (flip === null) return { flip_at: null, after: null };
  const cp = s.change_points.find((c) => c.at === flip)!;
  const after = flip <= b ? cp.before : cp.after;
  return { flip_at: flip, after };
}

/** Which parameters is the decision sensitive to, and where does the leader change? */
export function sensitivityReport(
  problem: DecisionProblem,
  overrides: RunOverrides = {},
  opts: { maxCells?: number } = {},
): SensitivityReport {
  const base = prepareBase(problem, overrides);
  const weights = base.critIds.map((id) => weightSweep(base, { criterion_id: id }));
  const critical: CriticalParameter[] = [];
  for (const s of weights) {
    const f = flipInfo(s);
    critical.push({
      type: 'weight',
      criterion_id: s.parameter.criterion_id,
      label: s.parameter.label,
      base_value: s.parameter.base_value,
      flip_at: f.flip_at,
      abs_delta: f.flip_at === null ? null : Math.abs(f.flip_at - s.parameter.base_value),
      relative_delta: f.flip_at === null ? null : Math.abs(f.flip_at - s.parameter.base_value),
      new_leader_ids: f.after,
    });
  }
  const maxCells = opts.maxCells ?? 200;
  let altScope = base.kept;
  if (base.kept.length * base.critIds.length > maxCells) {
    const ranks = evaluateAt(base, base.matrix, base.weights).ranks;
    const order = base.kept.map((id, i) => ({ id, r: ranks[i] })).sort((x, y) => x.r - y.r);
    altScope = order
      .slice(0, Math.max(2, Math.floor(maxCells / base.critIds.length)))
      .map((x) => x.id);
  }
  let scanned = 0;
  for (const a of altScope) {
    for (const c of base.critIds) {
      const s = evaluationSweep(base, { alternative_id: a, criterion_id: c, steps: 100 });
      scanned++;
      const f = flipInfo(s);
      const j = base.critIds.indexOf(c);
      const col = base.matrix.map((r) => r[j]);
      const span = Math.max(...col) - Math.min(...col);
      const abs = f.flip_at === null ? null : Math.abs(f.flip_at - s.parameter.base_value);
      critical.push({
        type: 'evaluation',
        criterion_id: c,
        alternative_id: a,
        label: s.parameter.label,
        base_value: s.parameter.base_value,
        flip_at: f.flip_at,
        abs_delta: abs,
        relative_delta: abs === null ? null : span > 0 ? abs / span : null,
        new_leader_ids: f.after,
      });
    }
  }
  const byRel = (x: CriticalParameter, y: CriticalParameter) =>
    (x.relative_delta ?? Infinity) - (y.relative_delta ?? Infinity);
  critical.sort((x, y) => (x.type === y.type ? byRel(x, y) : x.type === 'weight' ? -1 : 1));
  const name = (ids: string[] | null) => (ids ? namesOf(base, ids) : '—');
  const summary: string[] = [];
  const wCrit = critical.filter((c) => c.type === 'weight' && c.flip_at !== null);
  const eCrit = critical.filter((c) => c.type === 'evaluation' && c.flip_at !== null);
  summary.push(`Базовый лидер (${base.method.id.toUpperCase()}): ${name(base.baseLeaders)}.`);
  if (wCrit.length) {
    const w = wCrit[0];
    summary.push(
      `Наиболее чувствителен вес ${w.label}: при изменении с ${fmt(w.base_value)} до ${fmt(w.flip_at!)} (|Δ| = ${fmt(w.abs_delta!)}) лидер меняется на ${name(w.new_leader_ids)}.`,
    );
  } else {
    summary.push('При однофакторном изменении любого веса в [0; 1] лидер не меняется.');
  }
  if (eCrit.length) {
    const e = eCrit[0];
    summary.push(
      `Наиболее чувствительная оценка ${e.label}: при изменении с ${fmt(e.base_value)} до ${fmt(e.flip_at!)} (${e.relative_delta !== null ? `${fmt(e.relative_delta * 100, 1)}% размаха критерия` : `|Δ| = ${fmt(e.abs_delta!)}`}) лидер меняется на ${name(e.new_leader_ids)}.`,
    );
  } else {
    summary.push('В просмотренных диапазонах изменение одной оценки не меняет лидера.');
  }
  return {
    base: {
      method: base.method,
      weights: Object.fromEntries(base.critIds.map((c, j) => [c, base.weights[j]])),
      weights_source: base.weightsSource,
      leader_ids: base.baseLeaders,
    },
    weights,
    critical,
    summary,
    scanned_cells: scanned,
    notes: [
      'Однофакторный анализ (one-at-a-time): меняется один параметр, остальные фиксированы на базовых значениях.',
      altScope.length < base.kept.length
        ? `Оценки просмотрены для ${altScope.length} лучших по базовому рангу альтернатив (ограничение объёма).`
        : 'Оценки просмотрены для всех альтернатив и критериев.',
    ],
  };
}

export interface ScaleSweepOptions {
  target: 'm' | 'w' | 'both';
  factors: number[];
  mode?: ModeId;
}

/** Scales interval half-widths (around the point estimate) and re-runs the simulation with the same seed. */
export function uncertaintyScaleSweep(
  problem: DecisionProblem,
  opts: ScaleSweepOptions,
  overrides: RunOverrides = {},
): {
  target: string;
  mode: ModeId;
  rows: { factor: number; leader_ids: string[]; p_best: Record<string, number>; mean_rank: Record<string, number> }[];
  notes: string[];
} {
  const mode = opts.mode ?? 'MU_WU';
  const ref = solve(problem, { overrides: { ...overrides, mode } });
  const settings = ref.settings;
  const center = ref.baseline.weights;
  const rows = opts.factors.map((f) => {
    const scaled = scaleProblem(problem, f, opts.target, settings, center);
    const r = solve(scaled, { overrides: { ...overrides, mode } });
    return {
      factor: f,
      leader_ids: r.primary.leader_ids,
      p_best: Object.fromEntries(r.primary.alternatives.map((a) => [a.alternative_id, a.p_best])),
      mean_rank: Object.fromEntries(r.primary.alternatives.map((a) => [a.alternative_id, a.mean_rank])),
    };
  });
  return {
    target: opts.target,
    mode,
    rows,
    notes: [
      'Ширина интервалов масштабируется относительно точечной оценки: l′ = p − f·(p − l), u′ = p + f·(u − p); сценарные значения — v′ = p + f·(v − p).',
      'Для весов центр — точный вес либо средний выборочный вес; границы обрезаются до [0; 1]. Исходная задача не изменяется: масштабируется её копия.',
      'Все прогоны используют один seed и одинаковое N (общие случайные числа).',
    ],
  };
}

function scaleProblem(
  problem: DecisionProblem,
  f: number,
  target: 'm' | 'w' | 'both',
  settings: RunResult['settings'],
  center: Record<string, number>,
): DecisionProblem {
  const copy: DecisionProblem = JSON.parse(JSON.stringify(problem));
  const crit = new Map(copy.criteria.map((c) => [c.criterion_id, c]));
  if (target !== 'w') {
    for (const e of copy.evaluations) {
      const v = e.value;
      const p = pointValue(v, settings);
      if (p === null) continue;
      const r = crit.get(e.criterion_id)?.range;
      const clip = (x: number) => Math.min(r?.max ?? Infinity, Math.max(r?.min ?? -Infinity, x));
      if (v.kind === 'interval') {
        v.lower = clip(p - f * (p - v.lower));
        v.upper = clip(p + f * (v.upper - p));
        if (v.mode !== undefined) v.mode = clip(p + f * (v.mode - p));
        v.point = p;
      } else if (v.kind === 'scenarios') {
        for (const s of v.scenarios) s.value = clip(p + f * (s.value - p));
        v.point = p;
      }
    }
  }
  if (target !== 'm') {
    const part = partitionWeights(copy);
    copy.weights.items = copy.criteria.map((c, j) => {
      const item = copy.weights.items.find((w) => w.criterion_id === c.criterion_id) ?? { criterion_id: c.criterion_id };
      if (!part.uncertain[j]) return item;
      const p = item.value ?? center[c.criterion_id];
      return {
        ...item,
        lower: Math.max(0, p - f * (p - part.lower[j])),
        upper: Math.min(1, p + f * (part.upper[j] - p)),
      };
    });
  }
  return copy;
}

/** Leader map over a pair of weights (others keep proportions, Σ = 1). */
export function weightPairGrid(
  base: SensitivityBase,
  a: string,
  b: string,
  steps = 20,
): { a: string; b: string; steps: number; cells: { wa: number; wb: number; leader_ids: string[] }[]; scheme: string } {
  const ia = base.critIds.indexOf(a);
  const ib = base.critIds.indexOf(b);
  if (ia < 0 || ib < 0 || ia === ib) throw new Error('Нужны два разных критерия');
  const restBase = 1 - base.weights[ia] - base.weights[ib];
  const m = base.weights.length;
  const cells: { wa: number; wb: number; leader_ids: string[] }[] = [];
  for (let x = 0; x <= steps; x++) {
    for (let y = 0; x + y <= steps; y++) {
      const wa = x / steps;
      const wb = y / steps;
      const rest = 1 - wa - wb;
      const w = base.weights.map((v, k) => {
        if (k === ia) return wa;
        if (k === ib) return wb;
        if (restBase > 1e-12) return (v * rest) / restBase;
        return m > 2 ? rest / (m - 2) : 0;
      });
      cells.push({ wa, wb, leader_ids: evaluateAt(base, base.matrix, w).leader_ids });
    }
  }
  return {
    a,
    b,
    steps,
    cells,
    scheme: 'Сетка по паре весов (w_a, w_b), w_a + w_b ≤ 1; остальные веса сохраняют взаимные пропорции. Матрица M — точечные оценки.',
  };
}
