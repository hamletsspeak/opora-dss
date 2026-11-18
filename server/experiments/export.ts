import { toCsv } from '../../shared/csv.js';
import type { BatchRecord, ExperimentRecord } from './types.js';

export const EXPORT_TABLES = ['ranking', 'weights', 'comparison', 'sensitivity', 'passport'] as const;
export type ExportTable = (typeof EXPORT_TABLES)[number];

const RANKING_COLS = [
  'experiment_id', 'mode', 'mode_label', 'method', 'method_version', 'iterations', 'seed', 'alternative_id', 'name',
  'p_best', 'p_best_mcse', 'p_worst', 'p_top_k', 'mean_rank', 'sd_rank', 'rank_q05', 'rank_median', 'rank_q95',
  'mean_score', 'sd_score', 'score_q05', 'score_median', 'score_q95', 'baseline_rank', 'baseline_score',
];

export function rankingRows(rec: ExperimentRecord): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const r of rec.runs) {
    if (!r.result) continue;
    for (const m of [r.result.primary, ...r.result.secondary])
      for (const id of m.ranking) {
        const a = m.alternatives.find((x) => x.alternative_id === id)!;
        out.push({
          experiment_id: rec.experiment_id,
          mode: r.mode,
          mode_label: r.result.mode_label,
          method: m.method.id + (m.method.id === 'topsis' ? `/${m.method.normalization}` : ''),
          method_version: m.method.version,
          iterations: r.result.iterations_effective,
          seed: r.result.settings.seed,
          ...a,
          rank_acceptability: undefined,
        });
      }
  }
  return out;
}

function flatten(prefix: string, v: unknown, out: Record<string, unknown>[]): void {
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    for (const [k, x] of Object.entries(v)) flatten(prefix ? `${prefix}.${k}` : k, x, out);
  } else out.push({ key: prefix, value: Array.isArray(v) ? JSON.stringify(v) : v });
}

export function exportCsv(rec: ExperimentRecord, table: ExportTable): string {
  switch (table) {
    case 'ranking':
      return toCsv(RANKING_COLS, rankingRows(rec));
    case 'weights': {
      const rows = rec.runs.flatMap((r) => (r.result ? r.result.weight_stats.map((w) => ({ mode: r.mode, ...w })) : []));
      return toCsv(['mode', 'criterion_id', 'status', 'point', 'lower', 'upper', 'mean', 'sd', 'min', 'max'], rows);
    }
    case 'comparison': {
      const c = rec.comparison;
      if (!c) return toCsv(['alternative_id'], []);
      const modes = c.modes;
      const rows = c.alternatives.map((a) => {
        const row: Record<string, unknown> = { alternative_id: a.alternative_id, name: a.name };
        for (const m of modes) {
          row[`p_best_${m}`] = c.p_best[a.alternative_id]?.[m];
          row[`mean_rank_${m}`] = c.mean_rank[a.alternative_id]?.[m];
        }
        return row;
      });
      return toCsv(['alternative_id', 'name', ...modes.flatMap((m) => [`p_best_${m}`, `mean_rank_${m}`])], rows);
    }
    case 'sensitivity': {
      const rows = (rec.sensitivity?.critical ?? []).map((c) => ({ ...c, new_leader_ids: c.new_leader_ids?.join(' ') ?? '' }));
      return toCsv(['type', 'criterion_id', 'alternative_id', 'label', 'base_value', 'flip_at', 'abs_delta', 'relative_delta', 'new_leader_ids'], rows);
    }
    case 'passport': {
      const rows: Record<string, unknown>[] = [];
      flatten('', rec.passport, rows);
      if (rec.verification) flatten('verification', rec.verification, rows);
      return toCsv(['key', 'value'], rows);
    }
  }
}

export function exportBatchCsv(batch: BatchRecord, recs: (ExperimentRecord | null)[]): string {
  const rows: Record<string, unknown>[] = [];
  batch.items.forEach((it, k) => {
    const rec = recs[k];
    if (!rec) {
      rows.push({ batch_id: batch.batch_id, item: it.name, status: it.status, error: it.error });
      return;
    }
    for (const r of rec.runs) {
      const lead = r.result?.primary.leader_ids ?? [];
      const a = r.result?.primary.alternatives.find((x) => x.alternative_id === lead[0]);
      rows.push({
        batch_id: batch.batch_id,
        item: it.name,
        experiment_id: rec.experiment_id,
        problem_sha256: rec.passport.dataset.problem_sha256,
        mode: r.mode,
        status: r.status,
        leaders: lead.join(' '),
        p_best_leader: a?.p_best ?? null,
        p_best_mcse: a?.p_best_mcse ?? null,
        mean_rank_leader: a?.mean_rank ?? null,
        iterations: r.result?.iterations_effective ?? null,
        seed: r.result?.settings.seed ?? null,
        tau_vs_mode1: r.mode === 'MF_WF' ? 1 : rec.comparison?.kendall_tau[`MF_WF~${r.mode}`] ?? null,
        error: r.status === 'error' ? r.issues.filter((i) => i.severity === 'error').map((i) => i.message).join('; ') : null,
      });
    }
  });
  return toCsv(
    ['batch_id', 'item', 'experiment_id', 'problem_sha256', 'mode', 'status', 'leaders', 'p_best_leader', 'p_best_mcse', 'mean_rank_leader', 'iterations', 'seed', 'tau_vs_mode1', 'error'],
    rows,
  );
}
