import { randomBytes } from 'node:crypto';
import { canonicalJson } from '../../shared/canonical.js';
import {
  compareModes,
  EngineError,
  ENGINE,
  METHOD_VERSIONS,
  RNG_DESCRIPTION,
  sensitivityReport,
  solve,
  type RunResult,
} from '../../shared/engine/index.js';
import {
  ALL_MODES,
  ProblemValidationError,
  SCHEMA_VERSION,
  validateProblem,
  type DecisionProblem,
  type Issue,
  type MethodSpec,
  type ModeId,
  type RunOverrides,
} from '../../shared/problem/index.js';
import type { AppInfo } from '../appInfo.js';
import { sha256 } from '../llm/callLog.js';
import type { ExperimentConfig, ExperimentRecord, ExperimentSummary, ModeRun, RunPassport, SourceInfo, Verification } from './types.js';

export class DraftNotConfirmedError extends Error {
  constructor() {
    super('Черновик постановки от LLM не подтверждён пользователем — расчёт запрещён. Подтвердите задачу (POST /api/v1/problems/confirm).');
    this.name = 'DraftNotConfirmedError';
  }
}

export interface ExperimentRequest {
  problem: unknown;
  modes?: ModeId[] | 'all';
  overrides?: Omit<RunOverrides, 'mode'>;
  extra_methods?: MethodSpec[];
  sensitivity?: boolean;
  label?: string | null;
  source?: SourceInfo | null;
  batch_id?: string | null;
}

export interface RunContext {
  app: AppInfo;
  now?: () => Date;
  newId?: (prefix: 'exp' | 'bat') => string;
}

export function newId(prefix: 'exp' | 'bat', now = new Date()): string {
  const ts = now.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  return `${prefix}_${ts}_${randomBytes(3).toString('hex')}`;
}

export const ID_RE = /^(exp|bat)_\d{8}T\d{6}Z_[0-9a-f]{6}$/;

export function problemSha256(p: DecisionProblem): string {
  const { metadata: _metadata, ...rest } = p;
  return sha256(canonicalJson(rest));
}

function resultSha(runs: ModeRun[], rec: Pick<ExperimentRecord, 'comparison' | 'sensitivity'>): string {
  return sha256(canonicalJson({ runs, comparison: rec.comparison, sensitivity: rec.sensitivity }));
}

function normalizeModes(m: ExperimentRequest['modes']): ModeId[] {
  if (!m || m === 'all') return [...ALL_MODES];
  const set = new Set(m);
  return ALL_MODES.filter((x) => set.has(x));
}

/** Validates, checks the confirmation gate, runs the requested modes, builds the passport. */
export function runExperiment(req: ExperimentRequest, ctx: RunContext): ExperimentRecord {
  const now = ctx.now ?? (() => new Date());
  const started = now();
  const report = validateProblem(req.problem);
  if (!report.ok || !report.problem) throw new ProblemValidationError(report.issues);
  const problem = report.problem;
  if (problem.metadata.origin === 'llm' && problem.metadata.status !== 'confirmed') throw new DraftNotConfirmedError();
  const config: ExperimentConfig = {
    modes: normalizeModes(req.modes),
    overrides: req.overrides ?? {},
    extra_methods: req.extra_methods ?? [],
    sensitivity: req.sensitivity ?? true,
  };
  if (!config.modes.length) throw new ProblemValidationError([{ severity: 'error', code: 'no_modes', path: 'modes', message: 'Не выбран ни один режим' }]);
  const runs: ModeRun[] = [];
  const errors: RunPassport['errors'] = [];
  for (const mode of config.modes) {
    try {
      const result = solve(problem, { overrides: { ...config.overrides, mode }, extraMethods: config.extra_methods });
      runs.push({ mode, status: 'ok', result, issues: result.issues });
    } catch (e) {
      if (e instanceof ProblemValidationError) {
        runs.push({ mode, status: 'error', result: null, issues: e.issues });
        for (const i of e.issues.filter((x) => x.severity === 'error')) errors.push({ mode, code: i.code, message: i.message });
      } else if (e instanceof EngineError) {
        runs.push({ mode, status: 'error', result: null, issues: [{ severity: 'error', code: e.code, path: '', message: e.message }] });
        errors.push({ mode, code: e.code, message: e.message });
      } else throw e;
    }
  }
  const ok = runs.filter((r) => r.status === 'ok').map((r) => r.result as RunResult);
  const comparison = ok.length ? compareModes(ok) : null;
  let sensitivity = null;
  if (config.sensitivity) {
    try {
      sensitivity = sensitivityReport(problem, config.overrides);
    } catch (e) {
      errors.push({ mode: null, code: 'sensitivity_failed', message: e instanceof Error ? e.message : String(e) });
    }
  }
  const seen = new Set<string>();
  const warnings: Issue[] = [];
  for (const r of runs)
    for (const i of r.issues)
      if (i.severity === 'warning' && !seen.has(`${i.code}|${i.path}|${i.message}`)) {
        seen.add(`${i.code}|${i.path}|${i.message}`);
        warnings.push(i);
      }
  const finished = now();
  const id = (ctx.newId ?? ((p) => newId(p, started)))('exp');
  const usedMethods = new Set([problem.method.id, ...config.extra_methods.map((m) => m.id), ...(config.overrides.method ? [config.overrides.method.id] : [])]);
  const passport: RunPassport = {
    passport_version: '1.0',
    experiment_id: id,
    created_at: started.toISOString(),
    label: req.label ?? null,
    app: ctx.app,
    engine: { ...ENGINE },
    methods: Object.fromEntries([...usedMethods].map((m) => [m, METHOD_VERSIONS[m]])),
    schema_version: SCHEMA_VERSION,
    dataset: {
      problem_id: problem.problem_id,
      title: problem.context.title,
      problem_sha256: problemSha256(problem),
      source: req.source ?? null,
      alternatives: problem.alternatives.length,
      criteria: problem.criteria.length,
      evaluations: problem.evaluations.length,
      origin: problem.metadata.origin ?? null,
      status: problem.metadata.status ?? null,
    },
    config: { ...config, config_sha256: sha256(canonicalJson(config)) },
    settings: Object.fromEntries(ok.map((r) => [r.mode, r.settings])),
    iterations: Object.fromEntries(ok.map((r) => [r.mode, r.iterations_effective])),
    seed: ok[0]?.settings.seed ?? config.overrides.seed ?? problem.uncertainty.seed ?? 42,
    rng: RNG_DESCRIPTION,
    timing: { started_at: started.toISOString(), finished_at: finished.toISOString(), duration_ms: finished.getTime() - started.getTime() },
    warnings,
    errors,
    llm: (problem.metadata.llm as Record<string, unknown> | undefined) ?? null,
    result_sha256: '',
  };
  const rec: ExperimentRecord = {
    experiment_id: id,
    batch_id: req.batch_id ?? null,
    passport,
    problem,
    runs,
    comparison,
    sensitivity,
    explanation: null,
    repeat_of: null,
    verification: null,
  };
  passport.result_sha256 = resultSha(runs, rec);
  return rec;
}

/** Re-runs a stored experiment with the identical problem and configuration and compares hashes. */
export function repeatExperiment(ref: ExperimentRecord, ctx: RunContext): ExperimentRecord {
  const cfg = ref.passport.config;
  const rec = runExperiment(
    {
      problem: ref.problem,
      modes: cfg.modes,
      overrides: cfg.overrides,
      extra_methods: cfg.extra_methods,
      sensitivity: cfg.sensitivity,
      label: ref.passport.label ? `${ref.passport.label} (повтор)` : 'повтор',
      source: ref.passport.dataset.source,
    },
    ctx,
  );
  const differences: string[] = [];
  for (const r of rec.runs) {
    const o = ref.runs.find((x) => x.mode === r.mode);
    if (!o) differences.push(`${r.mode}: нет в исходном эксперименте`);
    else if (sha256(canonicalJson(o)) !== sha256(canonicalJson(r))) differences.push(`${r.mode}: результаты различаются`);
  }
  if (sha256(canonicalJson(ref.sensitivity)) !== sha256(canonicalJson(rec.sensitivity))) differences.push('анализ чувствительности различается');
  const v: Verification = {
    reference_id: ref.experiment_id,
    same_dataset: ref.passport.dataset.problem_sha256 === rec.passport.dataset.problem_sha256,
    same_config: ref.passport.config.config_sha256 === rec.passport.config.config_sha256,
    same_result: ref.passport.result_sha256 === rec.passport.result_sha256,
    reference_result_sha256: ref.passport.result_sha256,
    repeat_result_sha256: rec.passport.result_sha256,
    differences,
  };
  if (ref.passport.app.version !== rec.passport.app.version || ref.passport.engine.version !== rec.passport.engine.version)
    differences.push(`версия приложения/ядра: ${ref.passport.app.version}/${ref.passport.engine.version} → ${rec.passport.app.version}/${rec.passport.engine.version}`);
  return { ...rec, repeat_of: ref.experiment_id, verification: v };
}

export function summarize(rec: ExperimentRecord): ExperimentSummary {
  return {
    experiment_id: rec.experiment_id,
    batch_id: rec.batch_id,
    created_at: rec.passport.created_at,
    label: rec.passport.label,
    problem_id: rec.problem.problem_id,
    title: rec.problem.context.title,
    modes: rec.runs.map((r) => {
      const lead = r.result?.primary.leader_ids ?? [];
      const a = r.result?.primary.alternatives.find((x) => x.alternative_id === lead[0]);
      return { mode: r.mode, status: r.status, leaders: lead, p_best_leader: a ? a.p_best : null };
    }),
    iterations: rec.passport.iterations,
    seed: rec.passport.seed,
    result_sha256: rec.passport.result_sha256,
    repeat_of: rec.repeat_of,
    same_result: rec.verification?.same_result ?? null,
    warnings: rec.passport.warnings.length,
    errors: rec.passport.errors.length,
  };
}
