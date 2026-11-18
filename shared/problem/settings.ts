import type { DecisionProblem, MethodId, ModeId } from './schema.js';

export const DEFAULTS = {
  mode: 'MF_WF' as ModeId,
  iterations: 2000,
  seed: 42,
  default_interval_distribution: 'uniform' as const,
  point_rule: 'expected_value' as const,
  w_sampler: 'polytope_rejection' as const,
  max_attempts_per_sample: 20_000,
  hit_and_run_burn_in: 500,
  hit_and_run_thinning: 10,
  tie_tolerance: 1e-9,
  topsis_normalization: 'minmax' as const,
  vikor_v: 0.5,
  top_k_max: 3,
} as const;

/** Hard safety limits (overridable only via server env, never by request). */
export const LIMITS = {
  max_iterations: 200_000,
  /** iterations × alternatives (per-iteration ranks/scores are kept for quantiles) */
  max_cells: 4_000_000,
};

export const MODE_INFO: Record<
  ModeId,
  { n: 1 | 2 | 3 | 4; m: 'fixed' | 'uncertain'; w: 'fixed' | 'uncertain'; label: string }
> = {
  MF_WF: { n: 1, m: 'fixed', w: 'fixed', label: 'M fixed / W fixed' },
  MU_WF: { n: 2, m: 'uncertain', w: 'fixed', label: 'M uncertain / W fixed' },
  MF_WU: { n: 3, m: 'fixed', w: 'uncertain', label: 'M fixed / W uncertain' },
  MU_WU: { n: 4, m: 'uncertain', w: 'uncertain', label: 'M uncertain / W uncertain' },
};

export const ALL_MODES: ModeId[] = ['MF_WF', 'MU_WF', 'MF_WU', 'MU_WU'];

export function modeFromNumber(n: number): ModeId | undefined {
  return ALL_MODES.find((m) => MODE_INFO[m].n === n);
}

export type WSampler = 'polytope_rejection' | 'polytope_hit_and_run' | 'dirichlet' | 'scenarios';

export interface RunOverrides {
  mode?: ModeId;
  iterations?: number;
  seed?: number;
  method?: { id: MethodId; params?: { normalization?: 'minmax' | 'vector'; v?: number } };
  m?: {
    default_interval_distribution?: 'uniform' | 'triangular';
    point_rule?: 'expected_value' | 'explicit_only';
  };
  w?: {
    sampler?: WSampler;
    dirichlet_alpha?: Record<string, number>;
    max_attempts_per_sample?: number;
    hit_and_run_burn_in?: number;
    hit_and_run_thinning?: number;
  };
  top_k?: number;
  tie_tolerance?: number;
}

export type SettingSource = 'override' | 'problem' | 'default';

export interface ResolvedSettings {
  mode: ModeId;
  iterations: number;
  seed: number;
  method: { id: MethodId; normalization: 'minmax' | 'vector'; v: number | null };
  m: {
    default_interval_distribution: 'uniform' | 'triangular';
    point_rule: 'expected_value' | 'explicit_only';
  };
  w: {
    sampler: WSampler;
    dirichlet_alpha: Record<string, number> | null;
    max_attempts_per_sample: number;
    hit_and_run_burn_in: number;
    hit_and_run_thinning: number;
  };
  top_k: number;
  tie_tolerance: number;
  /** Where every setting came from — reported in passports. */
  sources: Record<string, SettingSource>;
}

function pick<T>(
  sources: Record<string, SettingSource>,
  key: string,
  override: T | undefined,
  fromProblem: T | undefined,
  fallback: T,
): T {
  if (override !== undefined) {
    sources[key] = 'override';
    return override;
  }
  if (fromProblem !== undefined) {
    sources[key] = 'problem';
    return fromProblem;
  }
  sources[key] = 'default';
  return fallback;
}

export function resolveSettings(
  problem: DecisionProblem,
  overrides: RunOverrides = {},
): ResolvedSettings {
  const u = problem.uncertainty ?? {};
  const sources: Record<string, SettingSource> = {};
  const methodSpec = overrides.method ?? problem.method;
  sources['method.id'] = overrides.method ? 'override' : 'problem';
  const methodId = methodSpec.id;
  const params = methodSpec.params ?? {};
  const normalization =
    methodId === 'topsis'
      ? pick(sources, 'method.normalization', params.normalization, undefined, DEFAULTS.topsis_normalization)
      : 'minmax';
  if (methodId !== 'topsis') sources['method.normalization'] = 'default';
  const v =
    methodId === 'vikor'
      ? pick(sources, 'method.v', params.v, undefined, DEFAULTS.vikor_v)
      : null;
  const nAlt = problem.alternatives.length;
  return {
    mode: pick(sources, 'mode', overrides.mode, u.mode, DEFAULTS.mode),
    iterations: pick(sources, 'iterations', overrides.iterations, u.iterations, DEFAULTS.iterations),
    seed: pick(sources, 'seed', overrides.seed, u.seed, DEFAULTS.seed),
    method: { id: methodId, normalization, v },
    m: {
      default_interval_distribution: pick(
        sources,
        'm.default_interval_distribution',
        overrides.m?.default_interval_distribution,
        u.m?.default_interval_distribution,
        DEFAULTS.default_interval_distribution,
      ),
      point_rule: pick(sources, 'm.point_rule', overrides.m?.point_rule, u.m?.point_rule, DEFAULTS.point_rule),
    },
    w: {
      sampler: pick(sources, 'w.sampler', overrides.w?.sampler, u.w?.sampler, DEFAULTS.w_sampler),
      dirichlet_alpha: pick(
        sources,
        'w.dirichlet_alpha',
        overrides.w?.dirichlet_alpha,
        u.w?.dirichlet_alpha,
        null as Record<string, number> | null,
      ),
      max_attempts_per_sample: pick(
        sources,
        'w.max_attempts_per_sample',
        overrides.w?.max_attempts_per_sample,
        u.w?.max_attempts_per_sample,
        DEFAULTS.max_attempts_per_sample,
      ),
      hit_and_run_burn_in: pick(
        sources,
        'w.hit_and_run_burn_in',
        overrides.w?.hit_and_run_burn_in,
        u.w?.hit_and_run_burn_in,
        DEFAULTS.hit_and_run_burn_in,
      ),
      hit_and_run_thinning: pick(
        sources,
        'w.hit_and_run_thinning',
        overrides.w?.hit_and_run_thinning,
        u.w?.hit_and_run_thinning,
        DEFAULTS.hit_and_run_thinning,
      ),
    },
    top_k: pick(
      sources,
      'top_k',
      overrides.top_k,
      u.top_k,
      Math.max(1, Math.min(DEFAULTS.top_k_max, nAlt - 1 || 1)),
    ),
    tie_tolerance: pick(sources, 'tie_tolerance', overrides.tie_tolerance, u.tie_tolerance, DEFAULTS.tie_tolerance),
    sources,
  };
}
