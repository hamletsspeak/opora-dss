import { robustnessSummary, type RunResult, type SensitivityReport } from '../../shared/engine/index.js';
import type { LlmCallRecord } from './callLog.js';
import { explainMessages } from './prompts.js';
import { LlmCallFailed, type LlmService, type ProviderSelection } from './service.js';
import { providerNotice } from './formalize.js';

/** A readable fallback based only on computed results, including when no model is available. */
export function plainExplanation(run: RunResult, sens?: SensitivityReport | null): string {
  const byId = new Map(run.primary.alternatives.map((a) => [a.alternative_id, a]));
  const names = (ids: string[]) => ids.map((id) => byId.get(id)?.name ?? id).join(', ');
  const [first, second] = run.primary.ranking.map((id) => byId.get(id)!);
  const out: string[] = [];
  if (run.iterations_effective === 1) {
    out.push(run.baseline.leader_ids.length > 1
      ? `При заданных данных одинаковый лучший результат у вариантов: ${names(run.baseline.leader_ids)}.`
      : `При заданных данных на первом месте — ${names(run.baseline.leader_ids)}.`);
    out.push('Этот расчёт не показывает, сохранится ли результат при изменении исходных данных.');
  } else {
    if (run.primary.leader_ids.length > 1) {
      out.push(`При переборе допустимых значений одинаково часто побеждают: ${names(run.primary.leader_ids)}.`);
    } else {
      out.push(`При переборе допустимых значений чаще всего побеждает ${first.name} — примерно в ${Math.round(first.p_best * 100)}% проверенных сценариев.`);
      if (second) {
        const se = Math.sqrt(first.p_best_mcse ** 2 + second.p_best_mcse ** 2);
        out.push(first.p_best - second.p_best <= 1.96 * se
          ? `Ближайший конкурент — ${second.name}; разница слишком мала, чтобы уверенно различить их по этому расчёту.`
          : `Ближайший конкурент — ${second.name}.`);
      }
    }
    if (!run.baseline.leader_ids.includes(first.alternative_id))
      out.push(`При фиксированных исходных значениях на первом месте ${names(run.baseline.leader_ids)}: результат зависит от того, как учитывать неточность данных.`);
    out.push('Доли побед относятся к проверенным сценариям и не гарантируют успех в реальной ситуации.');
  }
  const change = sens?.critical.find((c) => c.type === 'weight' && c.flip_at !== null)
    ?? sens?.critical.find((c) => c.flip_at !== null);
  if (change?.new_leader_ids?.length) {
    const criterion = change.label.replace(/^w\((.*)\)$/, '$1');
    out.push(change.type === 'weight'
      ? `В отдельной проверке, если изменить важность критерия «${criterion}», сохранив остальные исходные данные, на первое место выходит ${names(change.new_leader_ids)}.`
      : `В отдельной проверке изменение одной из оценок при остальных исходных данных без изменений выводит на первое место ${names(change.new_leader_ids)}.`);
  }
  return out.join(' ');
}

/** Read-only compact view of a run handed to the LLM. */
export function explanationPayload(run: RunResult, sens?: SensitivityReport | null): Record<string, unknown> {
  return {
    plain_language_summary: plainExplanation(run, sens),
    mode: run.mode_label,
    method: run.primary.method.title,
    iterations: run.iterations_effective,
    seed: run.settings.seed,
    ranking: run.primary.ranking.map((id) => {
      const a = run.primary.alternatives.find((x) => x.alternative_id === id)!;
      return {
        name: a.name,
        p_best: Number(a.p_best.toFixed(3)),
        p_worst: Number(a.p_worst.toFixed(3)),
        mean_rank: Number(a.mean_rank.toFixed(2)),
        rank_q05: a.rank_q05,
        rank_q95: a.rank_q95,
      };
    }),
    excluded: run.excluded.map((e) => `${e.alternative_id}: ${e.reason}`),
    robustness: robustnessSummary(run),
    sensitivity: sens?.summary ?? [],
  };
}

function collectNumbers(x: unknown, out: number[]): void {
  if (typeof x === 'number' && Number.isFinite(x)) out.push(x);
  else if (typeof x === 'string') for (const m of x.matchAll(/-?\d+(?:[.,]\d+)?/g)) out.push(Number(m[0].replace(',', '.')));
  else if (Array.isArray(x)) for (const v of x) collectNumbers(v, out);
  else if (x && typeof x === 'object') for (const v of Object.values(x)) collectNumbers(v, out);
}

/**
 * Every number in the explanation must be a (rounded) number of the payload, possibly in percent.
 * Small integers (0–10) are allowed for counts and ordinals.
 */
export function verifyExplanation(text: string, payload: unknown): { ok: boolean; unknown_numbers: number[] } {
  const allowed: number[] = [];
  collectNumbers(payload, allowed);
  const bad: number[] = [];
  for (const m of text.matchAll(/-?\d+(?:[.,]\d+)?/g)) {
    const tok = m[0].replace(',', '.');
    const x = Number(tok);
    const d = tok.includes('.') ? tok.split('.')[1].length : 0;
    const round = (v: number) => Number(v.toFixed(d));
    if (Number.isInteger(x) && x >= 0 && x <= 10) continue;
    const ok = allowed.some((a) => round(a) === x || round(a * 100) === x || Math.abs(round(a) - x) < 1e-12);
    if (!ok) bad.push(x);
  }
  return { ok: bad.length === 0, unknown_numbers: bad };
}

export interface Explanation {
  text: string;
  source: 'llm' | 'deterministic';
  llm: LlmCallRecord | null;
  provider_notice: string;
  rejected: { reason: string; unknown_numbers: number[] } | null;
}

/** LLM wording over fixed results. The LLM never sees or changes anything it could alter. */
export async function explainRun(
  llm: LlmService | null,
  run: RunResult,
  sens: SensitivityReport | null,
  sel: ProviderSelection = {},
): Promise<Explanation> {
  const payload = explanationPayload(run, sens);
  const deterministic = plainExplanation(run, sens);
  if (!llm) return { text: deterministic, source: 'deterministic', llm: null, provider_notice: 'LLM не используется', rejected: null };
  try {
    const { result, record, attempts } = await llm.call('explain', { messages: explainMessages(payload), temperature: 0.2, maxTokens: 400 }, sel);
    const check = verifyExplanation(result.text, payload);
    if (!result.text.trim() || !check.ok)
      return {
        text: deterministic,
        source: 'deterministic',
        llm: record,
        provider_notice: providerNotice(record, attempts),
        rejected: { reason: result.text.trim() ? 'объяснение LLM содержит числа, которых нет в результате расчёта' : 'LLM вернула пустое объяснение', unknown_numbers: check.unknown_numbers },
      };
    if (llm.registry.get(record.provider)?.info.kind === 'mock')
      return { text: deterministic, source: 'deterministic', llm: record, provider_notice: 'Локальное объяснение: выбран демонстрационный провайдер, LLM не используется', rejected: null };
    if (/p[_ ]?best|p[_ ]?worst|TOPSIS|\bseed\b|Монте.Карло|\b[wx]\s*\(/i.test(result.text) || /^[{[]/.test(result.text.trim()))
      return {
        text: deterministic, source: 'deterministic', llm: record,
        provider_notice: providerNotice(record, attempts),
        rejected: { reason: 'LLM вернула техническую сводку вместо объяснения простыми словами', unknown_numbers: [] },
      };
    return { text: result.text.trim(), source: 'llm', llm: record, provider_notice: providerNotice(record, attempts), rejected: null };
  } catch (e) {
    if (!(e instanceof LlmCallFailed)) throw e;
    return { text: deterministic, source: 'deterministic', llm: null, provider_notice: providerNotice(null, e.attempts), rejected: null };
  }
}
