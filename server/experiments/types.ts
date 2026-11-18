import type { ModeComparison, RunResult, SensitivityReport } from '../../shared/engine/index.js';
import type { DecisionProblem, Issue, MethodSpec, ModeId, RunOverrides } from '../../shared/problem/index.js';
import type { AppInfo } from '../appInfo.js';
import type { Explanation } from '../llm/explain.js';

export interface SourceInfo {
  name?: string;
  format?: 'json' | 'csv' | 'manual' | 'ecommerce' | 'example' | 'llm';
  /** sha256 of the raw uploaded bytes (as text) */
  sha256?: string;
  rows?: number;
}

export interface ExperimentConfig {
  modes: ModeId[];
  overrides: Omit<RunOverrides, 'mode'>;
  extra_methods: MethodSpec[];
  sensitivity: boolean;
}

export interface RunPassport {
  passport_version: '1.0';
  experiment_id: string;
  created_at: string;
  label: string | null;
  app: AppInfo;
  engine: { name: string; version: string };
  methods: Record<string, string>;
  schema_version: string;
  dataset: {
    problem_id: string;
    title: string;
    /** sha256 of the canonical problem JSON without `metadata` */
    problem_sha256: string;
    source: SourceInfo | null;
    alternatives: number;
    criteria: number;
    evaluations: number;
    origin: string | null;
    status: string | null;
  };
  config: ExperimentConfig & { config_sha256: string };
  /** resolved settings actually used, per mode */
  settings: Partial<Record<ModeId, RunResult['settings']>>;
  iterations: Partial<Record<ModeId, number>>;
  seed: number;
  rng: string;
  timing: { started_at: string; finished_at: string; duration_ms: number };
  warnings: Issue[];
  errors: { mode: ModeId | null; code: string; message: string }[];
  llm: Record<string, unknown> | null;
  /** sha256 of canonical runs + comparison + sensitivity; equal hashes = identical results */
  result_sha256: string;
}

export interface ModeRun {
  mode: ModeId;
  status: 'ok' | 'error';
  result: RunResult | null;
  issues: Issue[];
}

export interface Verification {
  reference_id: string;
  same_dataset: boolean;
  same_config: boolean;
  same_result: boolean;
  reference_result_sha256: string;
  repeat_result_sha256: string;
  differences: string[];
}

export interface ExperimentRecord {
  experiment_id: string;
  batch_id: string | null;
  passport: RunPassport;
  problem: DecisionProblem;
  runs: ModeRun[];
  comparison: ModeComparison | null;
  sensitivity: SensitivityReport | null;
  explanation: Explanation | null;
  repeat_of: string | null;
  verification: Verification | null;
}

export interface ExperimentSummary {
  experiment_id: string;
  batch_id: string | null;
  created_at: string;
  label: string | null;
  problem_id: string;
  title: string;
  modes: { mode: ModeId; status: 'ok' | 'error'; leaders: string[]; p_best_leader: number | null }[];
  iterations: Partial<Record<ModeId, number>>;
  seed: number;
  result_sha256: string;
  repeat_of: string | null;
  same_result: boolean | null;
  warnings: number;
  errors: number;
}

export interface BatchItemResult {
  name: string;
  index: number;
  status: 'ok' | 'error';
  experiment_id: string | null;
  error: string | null;
}

export interface BatchRecord {
  batch_id: string;
  created_at: string;
  label: string | null;
  config: ExperimentConfig;
  items: BatchItemResult[];
}
