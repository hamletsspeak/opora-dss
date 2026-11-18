import { ImportError, problemsFromJson, tableCsvToProblem } from '../../shared/import/table.js';
import { ProblemValidationError } from '../../shared/problem/index.js';
import { sha256 } from '../llm/callLog.js';
import { DraftNotConfirmedError, newId, runExperiment, type ExperimentRequest, type RunContext } from './runner.js';
import type { RunStore } from './store.js';
import type { BatchItemResult, BatchRecord, ExperimentConfig, ExperimentRecord } from './types.js';

export interface BatchInput {
  name: string;
  format: 'json' | 'csv';
  content: string;
}

export const MAX_BATCH_ITEMS = 100;

export function describeError(e: unknown): string {
  if (e instanceof ProblemValidationError)
    return e.issues
      .filter((i) => i.severity === 'error')
      .slice(0, 5)
      .map((i) => `${i.path ? `${i.path}: ` : ''}${i.message}`)
      .join('; ');
  if (e instanceof ImportError) return e.errors.slice(0, 5).join('; ');
  if (e instanceof DraftNotConfirmedError) return e.message;
  return e instanceof Error ? e.message : String(e);
}

export function runBatch(
  inputs: BatchInput[],
  cfg: Partial<ExperimentConfig> & { label?: string | null },
  ctx: RunContext,
  store: RunStore,
): { batch: BatchRecord; records: ExperimentRecord[] } {
  if (inputs.length > MAX_BATCH_ITEMS) throw new ImportError([`в пакете больше ${MAX_BATCH_ITEMS} файлов`]);
  const batch_id = (ctx.newId ?? ((p) => newId(p)))('bat');
  const items: BatchItemResult[] = [];
  const records: ExperimentRecord[] = [];
  const base: Omit<ExperimentRequest, 'problem'> = {
    modes: cfg.modes ?? 'all',
    overrides: cfg.overrides ?? {},
    extra_methods: cfg.extra_methods ?? [],
    sensitivity: cfg.sensitivity ?? true,
    batch_id,
  };
  inputs.forEach((inp, index) => {
    const src = { name: inp.name.slice(0, 200), format: inp.format, sha256: sha256(inp.content) };
    let problems: unknown[];
    try {
      if (inp.format === 'csv') {
        const { problem } = tableCsvToProblem(inp.content, { problemId: `batch-${index + 1}`, title: inp.name, source: inp.name });
        problems = [problem];
      } else problems = problemsFromJson(inp.content);
    } catch (e) {
      items.push({ name: inp.name, index, status: 'error', experiment_id: null, error: describeError(e) });
      return;
    }
    problems.forEach((p, k) => {
      const name = problems.length > 1 ? `${inp.name}#${k + 1}` : inp.name;
      try {
        const rec = runExperiment({ ...base, problem: p, label: cfg.label ? `${cfg.label}: ${name}` : name, source: src }, ctx);
        store.save(rec);
        records.push(rec);
        items.push({ name, index, status: 'ok', experiment_id: rec.experiment_id, error: null });
      } catch (e) {
        items.push({ name, index, status: 'error', experiment_id: null, error: describeError(e) });
      }
    });
  });
  const batch: BatchRecord = {
    batch_id,
    created_at: new Date().toISOString(),
    label: cfg.label ?? null,
    config: {
      modes: base.modes === 'all' || !base.modes ? ['MF_WF', 'MU_WF', 'MF_WU', 'MU_WU'] : base.modes,
      overrides: base.overrides ?? {},
      extra_methods: base.extra_methods ?? [],
      sensitivity: base.sensitivity ?? true,
    },
    items,
  };
  store.saveBatch(batch);
  return { batch, records };
}
