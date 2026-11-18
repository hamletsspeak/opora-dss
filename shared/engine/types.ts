import type { ModeId } from '../problem/schema.js';
import type { ResolvedSettings } from '../problem/settings.js';
import type { Issue } from '../problem/validate.js';
import type { ResolvedMethod } from './methods.js';
import type { UncertainCellInfo } from './samplers.js';

export interface AlternativeStats {
  alternative_id: string;
  name: string;
  /** share of iterations ranked first (ties: fractional credit) */
  p_best: number;
  /** Monte-Carlo standard error of p_best: √(p(1−p)/N) — simulation precision only */
  p_best_mcse: number;
  p_worst: number;
  p_top_k: number;
  mean_rank: number;
  sd_rank: number;
  rank_q05: number;
  rank_median: number;
  rank_q95: number;
  mean_score: number;
  sd_score: number;
  score_q05: number;
  score_median: number;
  score_q95: number;
  /** rank_acceptability[r-1] = probability of rank r */
  rank_acceptability: number[];
  baseline_score: number;
  baseline_rank: number;
}

export interface MethodStats {
  method: ResolvedMethod & { version: string; title: string };
  higher_is_better: boolean;
  /** alternatives in problem order (kept alternatives only) */
  alternatives: AlternativeStats[];
  /** ordering: p_best desc, mean_rank asc, problem order */
  ranking: string[];
  /** alternatives with maximal p_best */
  leader_ids: string[];
  /** pairwise_win[i][j] = P(alt i ranked strictly better than alt j) + ½·P(tie) */
  pairwise_win: number[][];
}

export interface TraceRow {
  alternative_id: string;
  criterion_id: string;
  direction: 'min' | 'max';
  raw: number;
  raw_source: 'exact' | 'point_estimate' | 'worst_observed';
  normalized: number;
  weight: number;
  weighted: number;
}

export interface BaselineResult {
  description: string;
  weights: Record<string, number>;
  weights_source: 'exact' | 'sample_mean';
  scores: Record<string, number>;
  ranks: Record<string, number>;
  ranking: string[];
  leader_ids: string[];
  trace: TraceRow[];
  method_detail: Record<string, Record<string, number>>;
}

export interface WeightStat {
  criterion_id: string;
  status: 'fixed' | 'uncertain';
  point: number | null;
  lower: number;
  upper: number;
  mean: number;
  sd: number;
  min: number;
  max: number;
}

export interface RunResult {
  engine: { name: string; version: string };
  schema_version: string;
  problem_id: string;
  mode: ModeId;
  mode_number: 1 | 2 | 3 | 4;
  mode_label: string;
  m_status: 'fixed' | 'uncertain';
  w_status: 'fixed' | 'uncertain';
  settings: ResolvedSettings;
  iterations_effective: number;
  rng: string;
  alternatives_kept: string[];
  excluded: { alternative_id: string; constraint_id: string; reason: string }[];
  uncertainty: {
    m: {
      used: boolean;
      uncertain_cells: UncertainCellInfo[];
      fixed_cells: number;
      missing_cells: { alternative_id: string; criterion_id: string }[];
      description: string;
    };
    w: {
      used: boolean;
      sampler: string | null;
      fixed: string[];
      uncertain: { criterion_id: string; lower: number; upper: number }[];
      ordinal: { greater: string; lesser: string }[];
      acceptance_rate: number | null;
      description: string;
    };
  };
  baseline: BaselineResult;
  primary: MethodStats;
  secondary: MethodStats[];
  method_agreement: { leader_match_rate: number; pairwise: Record<string, number> } | null;
  weight_stats: WeightStat[];
  constraint_diagnostics: {
    constraint_id: string;
    alternative_id: string;
    violation_probability: number;
  }[];
  issues: Issue[];
}
