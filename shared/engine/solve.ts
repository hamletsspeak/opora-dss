import type { DecisionProblem, MethodSpec } from '../problem/schema.js';
import { feasibleAlternatives } from '../problem/derive.js';
import { MODE_INFO, type ResolvedSettings, type RunOverrides } from '../problem/settings.js';
import { ProblemValidationError, validateProblem, type Issue } from '../problem/validate.js';
import { METHOD_TITLES, METHOD_VERSIONS, evaluateMethod, type ResolvedMethod } from './methods.js';
import { leaders, quantileSorted, rankScores, topKCredit } from './ranking.js';
import { substream } from './rng.js';
import {
  buildMatrixModel,
  buildWeightModel,
  pointMatrix,
  pointWeights,
  sampleMatrix,
  sampleWeights,
  type MatrixModel,
  type WeightModel,
} from './samplers.js';
import type {
  AlternativeStats,
  BaselineResult,
  MethodStats,
  RunResult,
  TraceRow,
  WeightStat,
} from './types.js';

export const ENGINE = { name: 'opora-mcda', version: '1.0.0' } as const;
export const RNG_DESCRIPTION =
  'Mulberry32; независимые подпотоки M и W (seed → FNV-1a + fmix32); общие случайные числа между режимами';

export interface SolveOptions {
  overrides?: RunOverrides;
  /** Additional methods evaluated on exactly the same samples (for method comparison). */
  extraMethods?: MethodSpec[];
  /** Diagnostic hook: receives the weight vector and matrix of every iteration (read-only). */
  onIteration?: (iteration: number, weights: readonly number[], matrix: readonly (readonly number[])[]) => void;
}

export function resolveMethod(spec: MethodSpec): ResolvedMethod {
  return {
    id: spec.id,
    normalization: spec.id === 'topsis' ? (spec.params?.normalization ?? 'minmax') : 'minmax',
    v: spec.id === 'vikor' ? (spec.params?.v ?? 0.5) : null,
  };
}

interface Acc {
  method: ResolvedMethod;
  higherIsBetter: boolean;
  best: Float64Array;
  worst: Float64Array;
  topk: Float64Array;
  rankSum: Float64Array;
  rankSq: Float64Array;
  scoreSum: Float64Array;
  scoreSq: Float64Array;
  ranks: Float32Array;
  scores: Float32Array;
  acceptability: Float64Array;
  pairwise: Float64Array;
}

function newAcc(method: ResolvedMethod, n: number, iterations: number): Acc {
  return {
    method,
    higherIsBetter: method.id !== 'vikor',
    best: new Float64Array(n),
    worst: new Float64Array(n),
    topk: new Float64Array(n),
    rankSum: new Float64Array(n),
    rankSq: new Float64Array(n),
    scoreSum: new Float64Array(n),
    scoreSq: new Float64Array(n),
    ranks: new Float32Array(n * iterations),
    scores: new Float32Array(n * iterations),
    acceptability: new Float64Array(n * n),
    pairwise: new Float64Array(n * n),
  };
}

function baselineMatrix(model: MatrixModel): {
  matrix: number[][];
  source: TraceRow['raw_source'][][];
} {
  const raw: (number | null)[][] = model.cells.map((row, i) =>
    row.map((cell, j) => {
      const p = model.point[i][j];
      if (cell.kind === 'missing') return null;
      if (p !== null) return p;
      // explicit_only without a point (allowed in M-uncertain mode): expected value of the distribution
      if (cell.kind === 'uniform') return (cell.lower + cell.upper) / 2;
      if (cell.kind === 'triangular') return (cell.lower + cell.mode + cell.upper) / 3;
      if (cell.kind === 'scenarios') {
        let prev = 0;
        return cell.values.reduce((s, v, k) => {
          const pr = cell.cumulative[k] - prev;
          prev = cell.cumulative[k];
          return s + pr * v;
        }, 0);
      }
      return cell.value;
    }),
  );
  const filled = pointMatrix({ ...model, point: raw });
  const source = model.cells.map((row) =>
    row.map((cell): TraceRow['raw_source'] =>
      cell.kind === 'missing' ? 'worst_observed' : cell.kind === 'const' ? 'exact' : 'point_estimate',
    ),
  );
  return { matrix: filled, source };
}

function finalizeStats(
  acc: Acc,
  kept: string[],
  names: Map<string, string>,
  iterations: number,
  baseScores: number[],
  baseRanks: number[],
): MethodStats {
  const n = kept.length;
  const N = iterations;
  const col = new Float64Array(N);
  const alternatives: AlternativeStats[] = kept.map((id, i) => {
    const pBest = acc.best[i] / N;
    const meanRank = acc.rankSum[i] / N;
    const meanScore = acc.scoreSum[i] / N;
    for (let t = 0; t < N; t++) col[t] = acc.ranks[t * n + i];
    const rs = Float64Array.from(col).sort();
    for (let t = 0; t < N; t++) col[t] = acc.scores[t * n + i];
    const ss = Float64Array.from(col).sort();
    return {
      alternative_id: id,
      name: names.get(id) ?? id,
      p_best: pBest,
      p_best_mcse: Math.sqrt(Math.max(0, pBest * (1 - pBest)) / N),
      p_worst: acc.worst[i] / N,
      p_top_k: acc.topk[i] / N,
      mean_rank: meanRank,
      sd_rank: Math.sqrt(Math.max(0, acc.rankSq[i] / N - meanRank * meanRank)),
      rank_q05: quantileSorted(rs, 0.05),
      rank_median: quantileSorted(rs, 0.5),
      rank_q95: quantileSorted(rs, 0.95),
      mean_score: meanScore,
      sd_score: Math.sqrt(Math.max(0, acc.scoreSq[i] / N - meanScore * meanScore)),
      score_q05: quantileSorted(ss, 0.05),
      score_median: quantileSorted(ss, 0.5),
      score_q95: quantileSorted(ss, 0.95),
      rank_acceptability: Array.from({ length: n }, (_, r) => acc.acceptability[i * n + r] / N),
      baseline_score: baseScores[i],
      baseline_rank: baseRanks[i],
    };
  });
  const idx = kept.map((_, i) => i);
  idx.sort((a, b) => {
    const A = alternatives[a];
    const B = alternatives[b];
    if (Math.abs(B.p_best - A.p_best) > 1e-12) return B.p_best - A.p_best;
    if (Math.abs(A.mean_rank - B.mean_rank) > 1e-12) return A.mean_rank - B.mean_rank;
    return a - b;
  });
  const maxP = Math.max(...alternatives.map((a) => a.p_best));
  return {
    method: {
      ...acc.method,
      version: METHOD_VERSIONS[acc.method.id],
      title: METHOD_TITLES[acc.method.id],
    },
    higher_is_better: acc.higherIsBetter,
    alternatives,
    ranking: idx.map((i) => kept[i]),
    leader_ids: kept.filter((_, i) => Math.abs(alternatives[i].p_best - maxP) <= 1e-12),
    pairwise_win: Array.from({ length: n }, (_, i) =>
      Array.from({ length: n }, (_, j) => (i === j ? 0 : acc.pairwise[i * n + j] / N)),
    ),
  };
}

function describeM(model: MatrixModel, used: boolean, settings: ResolvedSettings): string {
  const k = model.uncertain.length;
  if (!used) {
    return k
      ? `M fixed: используются точечные оценки (правило «${settings.m.point_rule}»); ${k} неопределённых ячеек не моделируются.`
      : 'M fixed: все оценки точные.';
  }
  if (!k) return 'M uncertain: неопределённых оценок нет — режим вырожден.';
  const u = model.uncertain.filter((c) => c.distribution === 'uniform').length;
  const t = model.uncertain.filter((c) => c.distribution === 'triangular').length;
  const s = model.uncertain.filter((c) => c.distribution === 'discrete').length;
  return `M uncertain: моделируется ${k} ячеек (равномерное — ${u}, треугольное — ${t}, сценарии — ${s}); точные оценки не возмущаются.`;
}

function describeW(wm: WeightModel, used: boolean): string {
  if (!used) return 'W fixed: точные веса используются без изменений на всех итерациях.';
  const fixed = wm.ids.filter((_, i) => !wm.partition.uncertain[i]);
  const fixedPart = fixed.length ? ` Фиксированы без изменений: ${fixed.join(', ')}.` : '';
  switch (wm.sampler) {
    case 'scenarios':
      return 'W uncertain: веса выбираются из заданных сценариев с их вероятностями.' + fixedPart;
    case 'dirichlet':
      return 'W uncertain: усечённое распределение Дирихле с заданными α, масштабированное на долю 1 − Σ(фиксированных весов), с отбраковкой векторов вне границ и порядковых ограничений.' + fixedPart;
    case 'polytope_hit_and_run':
      return `W uncertain: равномерное распределение на допустимом многограннике {Σw = 1, l ≤ w ≤ u, порядковые ограничения}, цепь hit-and-run (burn-in ${wm.burnIn}, прореживание ${wm.thinning}); выборки автокоррелированы.` + fixedPart;
    default:
      return 'W uncertain: равномерное распределение на допустимом многограннике {Σw = 1, l ≤ w ≤ u, порядковые ограничения}; метод отбраковки из равномерного распределения на сдвинутом симплексе (без последующей перенормировки).' + fixedPart;
  }
}

export function solve(problem: DecisionProblem, opts: SolveOptions = {}): RunResult {
  const report = validateProblem(problem, { forRun: true, overrides: opts.overrides });
  if (!report.ok || !report.problem || !report.settings) throw new ProblemValidationError(report.issues);
  const p = report.problem;
  const settings = report.settings;
  const mode = MODE_INFO[settings.mode];
  const issues: Issue[] = report.issues.filter((i) => i.severity !== 'error');

  const { kept, excluded } = feasibleAlternatives(p, settings);
  const names = new Map(p.alternatives.map((a) => [a.alternative_id, a.name]));
  const model = buildMatrixModel(p, kept, settings);
  const wModel = buildWeightModel(p, settings);
  const methods: ResolvedMethod[] = [settings.method, ...(opts.extraMethods ?? []).map(resolveMethod)];
  const n = kept.length;
  const nCrit = p.criteria.length;
  const directions = model.directions;
  const tol = settings.tie_tolerance;
  const k = settings.top_k;

  const deterministic = mode.m === 'fixed' && mode.w === 'fixed';
  const N = deterministic ? 1 : settings.iterations;
  const rngM = substream(settings.seed, 'M');
  const rngW = substream(settings.seed, 'W');
  const fixedW = mode.w === 'fixed' ? pointWeights(wModel) : null;
  const fixedM = mode.m === 'fixed' ? pointMatrix(model) : null;

  const accs = methods.map((m) => newAcc(m, n, N));
  const wSum = new Float64Array(nCrit);
  const wSq = new Float64Array(nCrit);
  const wMin = new Float64Array(nCrit).fill(Infinity);
  const wMax = new Float64Array(nCrit).fill(-Infinity);
  const thresholds = p.constraints.filter((c) => c.type === 'threshold');
  const violations = new Float64Array(thresholds.length * n);
  const critIndex = new Map(p.criteria.map((c, j) => [c.criterion_id, j]));
  const pairAgree = new Float64Array(methods.length * methods.length);
  let allAgree = 0;

  for (let it = 0; it < N; it++) {
    const w = fixedW ?? sampleWeights(wModel, rngW);
    const X = fixedM ?? sampleMatrix(model, rngM);
    opts.onIteration?.(it, w, X);
    for (let j = 0; j < nCrit; j++) {
      wSum[j] += w[j];
      wSq[j] += w[j] * w[j];
      if (w[j] < wMin[j]) wMin[j] = w[j];
      if (w[j] > wMax[j]) wMax[j] = w[j];
    }
    thresholds.forEach((c, ci) => {
      if (c.type !== 'threshold') return;
      const j = critIndex.get(c.criterion_id)!;
      for (let i = 0; i < n; i++) {
        const x = X[i][j];
        const ok =
          c.op === '<=' ? x <= c.value : c.op === '<' ? x < c.value : c.op === '>=' ? x >= c.value : c.op === '>' ? x > c.value : Math.abs(x - c.value) <= 1e-12 * Math.max(1, Math.abs(c.value));
        if (!ok) violations[ci * n + i]++;
      }
    });
    const leaderKeys: string[] = [];
    for (const acc of accs) {
      const ev = evaluateMethod(acc.method, X, directions, w);
      const r = rankScores(ev.scores, ev.higherIsBetter, tol);
      const base = it * n;
      for (let i = 0; i < n; i++) {
        const size = r.groupEnd[i] - r.groupStart[i] + 1;
        if (r.groupStart[i] === 1) acc.best[i] += 1 / size;
        if (r.groupEnd[i] === n) acc.worst[i] += 1 / size;
        acc.topk[i] += topKCredit(r, i, k);
        acc.rankSum[i] += r.rank[i];
        acc.rankSq[i] += r.rank[i] * r.rank[i];
        acc.scoreSum[i] += ev.scores[i];
        acc.scoreSq[i] += ev.scores[i] * ev.scores[i];
        acc.ranks[base + i] = r.rank[i];
        acc.scores[base + i] = ev.scores[i];
        for (let pos = r.groupStart[i]; pos <= r.groupEnd[i]; pos++) acc.acceptability[i * n + pos - 1] += 1 / size;
        for (let j = 0; j < n; j++) {
          if (i === j) continue;
          if (r.rank[i] < r.rank[j]) acc.pairwise[i * n + j] += 1;
          else if (r.rank[i] === r.rank[j]) acc.pairwise[i * n + j] += 0.5;
        }
      }
      leaderKeys.push(
        leaders(r)
          .sort((a, b) => a - b)
          .join(','),
      );
    }
    if (methods.length > 1) {
      let all = true;
      for (let a = 0; a < methods.length; a++)
        for (let b = a + 1; b < methods.length; b++) {
          if (leaderKeys[a] === leaderKeys[b]) pairAgree[a * methods.length + b]++;
          else all = false;
        }
      if (all) allAgree++;
    }
  }

  // --- baseline (deterministic point evaluation with trace) ---------------
  const partition = wModel.partition;
  let baseWeights: number[];
  let weightsSource: BaselineResult['weights_source'];
  if (fixedW) {
    baseWeights = fixedW;
    weightsSource = 'exact';
  } else if (partition.sumPoint !== null && Math.abs(partition.sumPoint - 1) <= 1e-6) {
    baseWeights = partition.point as number[];
    weightsSource = 'exact';
  } else {
    baseWeights = Array.from(wSum, (s) => s / N);
    weightsSource = 'sample_mean';
  }
  const bm = baselineMatrix(model);
  const baseEvals = methods.map((m) => evaluateMethod(m, bm.matrix, directions, baseWeights));
  const baseRanked = baseEvals.map((ev) => rankScores(ev.scores, ev.higherIsBetter, tol));
  const primaryEval = baseEvals[0];
  const trace: TraceRow[] = [];
  kept.forEach((a, i) => {
    p.criteria.forEach((c, j) => {
      trace.push({
        alternative_id: a,
        criterion_id: c.criterion_id,
        direction: c.direction,
        raw: bm.matrix[i][j],
        raw_source: bm.source[i][j],
        normalized: primaryEval.normalized[i][j],
        weight: baseWeights[j],
        weighted: baseWeights[j] * primaryEval.normalized[i][j],
      });
    });
  });
  const methodDetail: Record<string, Record<string, number>> = {};
  kept.forEach((a, i) => {
    const d: Record<string, number> = { score: primaryEval.scores[i] };
    for (const [key, arr] of Object.entries(primaryEval.detail)) d[key] = arr[i];
    methodDetail[a] = d;
  });
  const pr = baseRanked[0];
  const baseline: BaselineResult = {
    description:
      weightsSource === 'exact'
        ? 'Детерминированный расчёт на точечных оценках M и точных весах W.'
        : 'Детерминированный расчёт на точечных оценках M и среднем выборочном векторе весов W (точные веса заданы не для всех критериев).',
    weights: Object.fromEntries(p.criteria.map((c, j) => [c.criterion_id, baseWeights[j]])),
    weights_source: weightsSource,
    scores: Object.fromEntries(kept.map((a, i) => [a, primaryEval.scores[i]])),
    ranks: Object.fromEntries(kept.map((a, i) => [a, pr.rank[i]])),
    ranking: pr.order.map((i) => kept[i]),
    leader_ids: leaders(pr).map((i) => kept[i]),
    trace,
    method_detail: methodDetail,
  };

  const stats = accs.map((acc, mi) => finalizeStats(acc, kept, names, N, baseEvals[mi].scores, baseRanked[mi].rank));

  const weight_stats: WeightStat[] = p.criteria.map((c, j) => {
    const mean = wSum[j] / N;
    return {
      criterion_id: c.criterion_id,
      status: mode.w === 'fixed' || !partition.uncertain[j] ? 'fixed' : 'uncertain',
      point: partition.point[j],
      lower: mode.w === 'fixed' ? (partition.point[j] as number) : partition.lower[j],
      upper: mode.w === 'fixed' ? (partition.point[j] as number) : partition.upper[j],
      mean,
      sd: Math.sqrt(Math.max(0, wSq[j] / N - mean * mean)),
      min: wMin[j],
      max: wMax[j],
    };
  });

  const acceptance =
    mode.w === 'uncertain' && wModel.stats.attempts > 0 ? wModel.stats.accepted / wModel.stats.attempts : null;
  if (acceptance !== null && acceptance < 0.01)
    issues.push({
      severity: 'warning',
      code: 'low_acceptance',
      path: 'uncertainty.w',
      message: `Доля принятых предложений генератора весов ${(acceptance * 100).toFixed(2)}% — расчёт медленный; рассмотрите sampler = "polytope_hit_and_run".`,
    });

  let method_agreement: RunResult['method_agreement'] = null;
  if (methods.length > 1) {
    const pairwise: Record<string, number> = {};
    for (let a = 0; a < methods.length; a++)
      for (let b = a + 1; b < methods.length; b++)
        pairwise[`${methods[a].id}_${methods[b].id}`] = pairAgree[a * methods.length + b] / N;
    method_agreement = { leader_match_rate: allAgree / N, pairwise };
  }

  return {
    engine: { ...ENGINE },
    schema_version: p.schema_version,
    problem_id: p.problem_id,
    mode: settings.mode,
    mode_number: mode.n,
    mode_label: mode.label,
    m_status: mode.m,
    w_status: mode.w,
    settings,
    iterations_effective: N,
    rng: RNG_DESCRIPTION,
    alternatives_kept: kept,
    excluded,
    uncertainty: {
      m: {
        used: mode.m === 'uncertain',
        uncertain_cells: model.uncertain,
        fixed_cells: n * nCrit - model.uncertain.length - model.missing.length,
        missing_cells: model.missing,
        description: describeM(model, mode.m === 'uncertain', settings),
      },
      w: {
        used: mode.w === 'uncertain',
        sampler: mode.w === 'uncertain' ? settings.w.sampler : null,
        fixed: p.criteria.filter((_, j) => mode.w === 'fixed' || !partition.uncertain[j]).map((c) => c.criterion_id),
        uncertain:
          mode.w === 'uncertain'
            ? p.criteria
                .map((c, j) => ({ criterion_id: c.criterion_id, lower: partition.lower[j], upper: partition.upper[j], u: partition.uncertain[j] }))
                .filter((x) => x.u)
                .map(({ criterion_id, lower, upper }) => ({ criterion_id, lower, upper }))
            : [],
        ordinal: mode.w === 'uncertain' ? (p.weights.ordinal ?? []) : [],
        acceptance_rate: acceptance,
        description: describeW(wModel, mode.w === 'uncertain'),
      },
    },
    baseline,
    primary: stats[0],
    secondary: stats.slice(1),
    method_agreement,
    weight_stats,
    constraint_diagnostics: thresholds.flatMap((c, ci) =>
      kept.map((a, i) => ({
        constraint_id: c.constraint_id,
        alternative_id: a,
        violation_probability: violations[ci * n + i] / N,
      })),
    ),
    issues,
  };
}
