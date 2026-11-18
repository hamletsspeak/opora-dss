import type { McdmMethodId, McdmResult, MethodAgreement, RankItem, SessionState } from './types.js';
import { sessionToProblem } from './problem/fromSession.js';
import {
  ENGINE,
  robustnessSummary,
  sensitivityReport,
  solve,
  type MethodStats,
  type RunResult,
  type SensitivityReport,
} from './engine/index.js';
import type { DecisionProblem } from './problem/index.js';

export { mulberry32 } from './engine/rng.js';

export const DEFAULT_MCDM_SAMPLES = 2000;
export const DEFAULT_MCDM_SEED = 42;

function toRankItems(stats: MethodStats): RankItem[] {
  const byId = new Map(stats.alternatives.map((a) => [a.alternative_id, a]));
  return stats.ranking.map((id) => {
    const a = byId.get(id)!;
    return {
      alternativeId: a.alternative_id,
      name: a.name,
      expectedScore: a.mean_score,
      winRate: a.p_best,
      meanRank: a.mean_rank,
      pBest: a.p_best,
      pWorst: a.p_worst,
    };
  });
}

/**
 * Legacy response shape (`McdmResult`) computed by the v1 engine:
 * SessionState → DecisionProblem → solve(TOPSIS, + WSM/VIKOR on the same samples).
 */
export function runRobustMcdm(
  session: SessionState,
  samples = DEFAULT_MCDM_SAMPLES,
  seed = DEFAULT_MCDM_SEED,
): McdmResult {
  return runRobustMcdmDetailed(session, samples, seed).analysis;
}

export function runRobustMcdmDetailed(
  session: SessionState,
  samples = DEFAULT_MCDM_SAMPLES,
  seed = DEFAULT_MCDM_SEED,
): { analysis: McdmResult; run: RunResult; sensitivity: SensitivityReport; problem: DecisionProblem } {
  const { problem, log } = sessionToProblem(session, { iterations: samples, seed });
  const run = solve(problem, { extraMethods: [{ id: 'wsm' }, { id: 'vikor' }] });
  const [wsm, vikor] = run.secondary;
  const methods = { topsis: toRankItems(run.primary), wsm: toRankItems(wsm), vikor: toRankItems(vikor) };
  const meanRankByMethod: MethodAgreement['meanRankByMethod'] = {};
  const all: [McdmMethodId, MethodStats][] = [
    ['topsis', run.primary],
    ['wsm', wsm],
    ['vikor', vikor],
  ];
  for (const a of run.primary.alternatives) {
    meanRankByMethod[a.alternative_id] = { topsis: 0, wsm: 0, vikor: 0 };
    for (const [m, s] of all)
      meanRankByMethod[a.alternative_id][m] = s.alternatives.find((x) => x.alternative_id === a.alternative_id)!.mean_rank;
  }
  const pw = run.method_agreement?.pairwise ?? {};
  const names = new Map(problem.alternatives.map((a) => [a.alternative_id, a.name]));
  const sens = sensitivityReport(problem, { iterations: samples, seed });
  const robustness = robustnessSummary(run);
  const analysis: McdmResult = {
    ranking: methods.topsis,
    samples: run.iterations_effective,
    sensitivityNote: [...sens.summary.slice(1), robustness.at(-1) ?? ''].filter(Boolean).join(' '),
    weightMeans: Object.fromEntries(run.weight_stats.map((w) => [w.criterion_id, w.mean])),
    methods,
    agreement: {
      leaderMatchRate: run.method_agreement?.leader_match_rate ?? 1,
      pairwiseLeaderMatch: {
        topsis_wsm: pw.topsis_wsm ?? 1,
        topsis_vikor: pw.topsis_vikor ?? 1,
        wsm_vikor: pw.wsm_vikor ?? 1,
      },
      meanRankByMethod,
    },
    mcdmParams: { samples: run.iterations_effective, seed, mode: run.mode, engine: `${ENGINE.name}@${ENGINE.version}` },
    mode: { id: run.mode, number: run.mode_number, label: run.mode_label, m: run.uncertainty.m.description, w: run.uncertainty.w.description },
    robustness,
    sensitivity: {
      summary: sens.summary,
      critical: [
        ...sens.critical.filter((c) => c.type === 'weight' && c.flip_at !== null).slice(0, 3),
        ...sens.critical.filter((c) => c.type === 'evaluation' && c.flip_at !== null).slice(0, 3),
      ].map((c) => ({
          type: c.type,
          label: c.label,
          base_value: c.base_value,
          flip_at: c.flip_at,
          abs_delta: c.abs_delta,
          relative_delta: c.relative_delta,
          new_leader_names: (c.new_leader_ids ?? []).map((id) => names.get(id) ?? id),
        })),
      statements: Object.fromEntries(sens.weights.map((w) => [w.parameter.criterion_id, w.statements])),
    },
    conversionLog: log,
  };
  return { analysis, run, sensitivity: sens, problem };
}

export function isAnalysisReady(session: SessionState): boolean {
  if (session.criteria.length < 2) return false;
  if (session.alternatives.length < 2) return false;
  const critIds = session.criteria.map((c) => c.id);
  return session.alternatives.every((a) => critIds.every((id) => a.scores[id] != null));
}
