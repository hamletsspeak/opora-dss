import { DecisionProblem as DecisionProblemSchema, validateProblem, type MethodSpec, type ValidationReport } from '../../shared/problem/index.js';
import type { DecisionProblem } from '../../shared/problem/index.js';
import { sha256, type LlmCallRecord } from './callLog.js';
import { buildProblemFromDraft, parseJsonReply, type DraftBuildResult } from './draft.js';
import { formalizeMessages, PROMPT_VERSION } from './prompts.js';
import { LlmCallFailed, problemLlmMeta, type LlmService, type ProviderSelection } from './service.js';
import { ERROR_TEXT, type LlmErrorCode } from './types.js';

export const MAX_SOURCE_CHARS = 20_000;

export interface FormalizeOptions extends ProviderSelection {
  domain?: string;
  method?: MethodSpec;
  iterations?: number;
  seed?: number;
  maxTokens?: number;
}

interface Common {
  source_sha256: string;
  prompt_version: string;
  /** the call that produced the answer (or the last failed one) */
  llm: LlmCallRecord | null;
  attempts: LlmCallRecord[];
  /** human-readable note on which provider answered and why */
  provider_notice: string;
}

export type FormalizeOutcome =
  | (Common &
      DraftBuildResult & {
        status: 'ok';
        schema_valid: boolean;
        schema_errors: string[];
        validation: ValidationReport;
        run_validation: ValidationReport;
      })
  | (Common & { status: 'invalid_json' | 'llm_error'; error: { code: LlmErrorCode | 'invalid_json'; message: string }; raw_excerpt?: string });

export function providerNotice(r: LlmCallRecord | null, attempts: LlmCallRecord[]): string {
  if (!r) {
    const last = attempts.at(-1);
    return last ? `LLM недоступна: ${last.provider} — ${ERROR_TEXT[last.error_code ?? 'unavailable']}` : 'LLM не вызывалась';
  }
  const base = `Ответ получен от ${r.provider} (${r.model_version ?? r.model})`;
  if (!r.fallback_from) return base;
  return `${base}; основной провайдер ${r.fallback_from} не ответил (${ERROR_TEXT[r.fallback_reason ?? 'unavailable']}), использован резервный из LLM_FALLBACK`;
}

/**
 * Text → LLM draft → deterministic traceability checks → DecisionProblem (status: draft).
 * The result must be confirmed by the user before it can be solved.
 */
export async function formalize(llm: LlmService, text: string, opts: FormalizeOptions = {}): Promise<FormalizeOutcome> {
  const source = text.slice(0, MAX_SOURCE_CHARS);
  const source_sha256 = sha256(source);
  const base = { source_sha256, prompt_version: PROMPT_VERSION };
  let outcome;
  try {
    outcome = await llm.call(
      'formalize',
      { messages: formalizeMessages(source, { domain: opts.domain }), json: true, temperature: 0, maxTokens: opts.maxTokens ?? 3000 },
      opts,
    );
  } catch (e) {
    if (!(e instanceof LlmCallFailed)) throw e;
    return {
      ...base,
      status: 'llm_error',
      error: { code: e.last.code, message: `${ERROR_TEXT[e.last.code]}: ${e.last.message}` },
      llm: null,
      attempts: e.attempts,
      provider_notice: providerNotice(null, e.attempts),
    };
  }
  const { result, record, attempts } = outcome;
  const notice = providerNotice(record, attempts);
  const parsed = parseJsonReply(result.text);
  if (!parsed.ok)
    return {
      ...base,
      status: 'invalid_json',
      error: { code: 'invalid_json', message: parsed.error },
      raw_excerpt: result.text.slice(0, 300),
      llm: record,
      attempts,
      provider_notice: notice,
    };
  const built = buildProblemFromDraft(parsed.value, source, {
    problemId: `draft-${source_sha256.slice(0, 12)}`,
    method: opts.method,
    iterations: opts.iterations,
    seed: opts.seed,
    llm: { ...problemLlmMeta(record, PROMPT_VERSION), source_sha256 },
  });
  const schema = DecisionProblemSchema.safeParse(built.problem);
  return {
    ...base,
    status: 'ok',
    ...built,
    schema_valid: schema.success,
    schema_errors: schema.success ? [] : schema.error.issues.slice(0, 20).map((i) => `${i.path.join('.')}: ${i.message}`),
    validation: validateProblem(built.problem),
    run_validation: validateProblem(built.problem, { forRun: true }),
    llm: record,
    attempts,
    provider_notice: notice,
  };
}

export interface ConfirmResult {
  ok: boolean;
  problem: DecisionProblem | null;
  unresolved: { path: string; reason: string }[];
  validation: ValidationReport;
}

/**
 * User confirmation of a draft: blocking unknown fields must be listed in `resolved`
 * (i.e. the user has reviewed/edited them); the problem must pass semantic validation.
 */
export function confirmDraft(input: unknown, resolved: string[] = [], now = new Date().toISOString()): ConfirmResult {
  const validation = validateProblem(input);
  if (!validation.ok || !validation.problem) return { ok: false, problem: null, unresolved: [], validation };
  const p = structuredClone(validation.problem);
  const draft = (p.metadata as { draft?: { unknown_fields?: { path: string; reason: string; blocking: boolean }[] } }).draft;
  const unresolved = (draft?.unknown_fields ?? []).filter((u) => u.blocking && !resolved.includes(u.path)).map(({ path, reason }) => ({ path, reason }));
  if (unresolved.length) return { ok: false, problem: null, unresolved, validation };
  p.metadata.status = 'confirmed';
  p.metadata.confirmed_at = now;
  if (draft) (p.metadata as Record<string, unknown>).draft = { ...draft, resolved_by_user: resolved };
  return { ok: true, problem: p, unresolved: [], validation };
}
