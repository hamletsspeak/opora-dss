import type { ModeId } from '../problem/schema.js';
import { kendallTauB } from './ranking.js';
import type { RunResult } from './types.js';

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;

/** Factual robustness statements (no single-threshold verdict). */
export function robustnessSummary(run: RunResult): string[] {
  const s = run.primary;
  const byId = new Map(s.alternatives.map((a) => [a.alternative_id, a]));
  const name = (id: string) => byId.get(id)?.name ?? id;
  const out: string[] = [];
  out.push(`${run.mode_label}; метод ${s.method.title}; итераций: ${run.iterations_effective}; seed ${run.settings.seed}.`);
  if (run.iterations_effective === 1) {
    out.push(
      `Детерминированный расчёт: лидер — ${run.baseline.leader_ids.map(name).join(' = ')}. Показатели pBest/pWorst вырождены (0, 1 или доля при ничьей) и не характеризуют устойчивость.`,
    );
    return out;
  }
  const [first, second] = s.ranking.map((id) => byId.get(id)!);
  out.push(
    `Чаще всего первое место занимает ${first.name}: pBest = ${pct(first.p_best)} (±${pct(1.96 * first.p_best_mcse)} — погрешность Монте-Карло, не реальная неопределённость).`,
  );
  if (second) {
    out.push(
      `Ближайший конкурент — ${second.name}: pBest = ${pct(second.p_best)}; разница ${pct(first.p_best - second.p_best)}.`,
    );
    const se = Math.sqrt(first.p_best_mcse ** 2 + second.p_best_mcse ** 2);
    if (first.p_best - second.p_best <= 1.96 * se)
      out.push('Разница pBest первых двух альтернатив в пределах погрешности Монте-Карло: при данном N их нельзя упорядочить по доле первых мест.');
  }
  out.push(
    `Средний ранг ${first.name}: ${first.mean_rank.toFixed(2)} (90%-диапазон рангов ${first.rank_q05}–${first.rank_q95}); вероятность последнего места ${pct(first.p_worst)}; вероятность попасть в топ-${run.settings.top_k}: ${pct(first.p_top_k)}.`,
  );
  const baseLeader = run.baseline.leader_ids;
  if (!baseLeader.includes(first.alternative_id))
    out.push(`Лидер базового детерминированного расчёта (${baseLeader.map(name).join(' = ')}) не совпадает с лидером по pBest.`);
  return out;
}

export interface ModeComparison {
  problem_id: string;
  method: string;
  modes: ModeId[];
  alternatives: { alternative_id: string; name: string }[];
  leaders: Record<string, string[]>;
  p_best: Record<string, Record<string, number>>;
  mean_rank: Record<string, Record<string, number>>;
  /** Kendall τ-b between mean-rank orderings of every pair of modes */
  kendall_tau: Record<string, number>;
  leader_matches_mode1: Record<string, boolean | null>;
  notes: string[];
}

export function compareModes(runs: RunResult[]): ModeComparison {
  if (!runs.length) throw new Error('Нет запусков для сравнения');
  const ids = runs[0].alternatives_kept;
  const alts = runs[0].primary.alternatives.map((a) => ({ alternative_id: a.alternative_id, name: a.name }));
  const modes = runs.map((r) => r.mode);
  const leadersBy: Record<string, string[]> = {};
  const pBest: Record<string, Record<string, number>> = {};
  const meanRank: Record<string, Record<string, number>> = {};
  for (const id of ids) {
    pBest[id] = {};
    meanRank[id] = {};
  }
  for (const r of runs) {
    leadersBy[r.mode] = r.primary.leader_ids;
    for (const a of r.primary.alternatives) {
      pBest[a.alternative_id][r.mode] = a.p_best;
      meanRank[a.alternative_id][r.mode] = a.mean_rank;
    }
  }
  const tau: Record<string, number> = {};
  for (let i = 0; i < runs.length; i++)
    for (let j = i + 1; j < runs.length; j++) {
      const x = ids.map((id) => meanRank[id][runs[i].mode]);
      const y = ids.map((id) => meanRank[id][runs[j].mode]);
      tau[`${runs[i].mode}~${runs[j].mode}`] = kendallTauB(x, y);
    }
  const m1 = runs.find((r) => r.mode === 'MF_WF');
  const same = (a: string[], b: string[]) => a.length === b.length && a.every((x) => b.includes(x));
  const matches: Record<string, boolean | null> = {};
  for (const r of runs) matches[r.mode] = m1 ? same(r.primary.leader_ids, m1.primary.leader_ids) : null;
  const notes = [
    'Все режимы используют один алгоритм, одну задачу, один seed и одинаковое N; различаются только источники неопределённости.',
    'Подпотоки случайных чисел M и W независимы: выборки M в режиме 4 совпадают с режимом 2, выборки W — с режимом 3.',
  ];
  for (const r of runs)
    for (const i of r.issues)
      if (i.code.startsWith('mode_degenerate')) notes.push(`${r.mode}: ${i.message}`);
  return {
    problem_id: runs[0].problem_id,
    method: runs[0].primary.method.id,
    modes,
    alternatives: alts,
    leaders: leadersBy,
    p_best: pBest,
    mean_rank: meanRank,
    kendall_tau: tau,
    leader_matches_mode1: matches,
    notes,
  };
}
