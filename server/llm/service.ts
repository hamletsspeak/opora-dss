import { CallLog, estimateCost, newCallId, promptDigest, sha256, type CallPurpose, type LlmCallRecord } from './callLog.js';
import type { ProviderRegistry } from './registry.js';
import { LlmError, RETRIABLE, type CompletionRequest, type CompletionResult, type LLMProvider } from './types.js';

export interface ProviderSelection {
  /** explicit provider id; default = LLM_PROVIDER */
  provider?: string;
  /**
   * Try the providers from LLM_FALLBACK after a failure. Off by default when a provider is
   * requested explicitly (benchmarks must not silently mix models).
   */
  allowFallback?: boolean;
}

export interface CallOutcome {
  result: CompletionResult;
  record: LlmCallRecord;
  attempts: LlmCallRecord[];
}

export class LlmCallFailed extends Error {
  constructor(
    readonly attempts: LlmCallRecord[],
    readonly last: LlmError,
  ) {
    super(last.message);
    this.name = 'LlmCallFailed';
  }
}

export interface ServiceOptions {
  maxRetries: number;
  retryDelayMs: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class LlmService {
  constructor(
    readonly registry: ProviderRegistry,
    readonly log: CallLog,
    readonly opts: ServiceOptions = { maxRetries: 1, retryDelayMs: 1000 },
  ) {}

  chainFor(sel: ProviderSelection): string[] {
    const primary = sel.provider ?? this.registry.defaultId;
    const allow = sel.allowFallback ?? sel.provider === undefined;
    return allow ? [primary, ...this.registry.fallback.filter((f) => f !== primary)] : [primary];
  }

  /**
   * Calls the selected provider; on failure moves along the explicit fallback chain.
   * Every attempt is recorded; the successful record carries `fallback_from` when applicable.
   */
  async call(purpose: CallPurpose, req: CompletionRequest, sel: ProviderSelection = {}): Promise<CallOutcome> {
    const chain = this.chainFor(sel);
    const attempts: LlmCallRecord[] = [];
    const digest = promptDigest(req);
    let last: LlmError | null = null;
    let firstFailure: LlmError | null = null;
    for (const id of chain) {
      const provider = this.registry.get(id);
      if (!provider) {
        last = new LlmError('config', id, `провайдер «${id}» не зарегистрирован`);
        attempts.push(this.errorRecord(purpose, req, digest, id, null, last, attempts.length + 1, chain[0], firstFailure));
        firstFailure ??= last;
        continue;
      }
      for (let k = 0; k <= this.opts.maxRetries; k++) {
        const started = new Date();
        try {
          const result = await provider.complete(req);
          const record = this.okRecord(purpose, req, digest, provider, result, started, attempts.length + 1, id === chain[0] ? null : chain[0], firstFailure);
          attempts.push(record);
          this.log.add(record);
          return { result, record, attempts };
        } catch (e) {
          const err = e instanceof LlmError ? e : new LlmError('bad_response', id, e instanceof Error ? e.message : String(e));
          last = err;
          const rec = this.errorRecord(purpose, req, digest, id, provider, err, attempts.length + 1, id === chain[0] ? null : chain[0], firstFailure, started);
          attempts.push(rec);
          this.log.add(rec);
          if (!RETRIABLE.has(err.code) || k === this.opts.maxRetries) break;
          const wait = err.retryAfterSec !== undefined ? err.retryAfterSec * 1000 : this.opts.retryDelayMs * 2 ** k;
          if (wait > 10_000) break;
          await sleep(wait);
        }
      }
      firstFailure ??= last;
    }
    throw new LlmCallFailed(attempts, last ?? new LlmError('config', chain[0], 'нет доступных провайдеров'));
  }

  private okRecord(
    purpose: CallPurpose,
    req: CompletionRequest,
    digest: { sha: string; chars: number },
    provider: LLMProvider,
    r: CompletionResult,
    started: Date,
    attempt: number,
    fallbackFrom: string | null,
    firstFailure: LlmError | null,
  ): LlmCallRecord {
    return {
      call_id: newCallId(),
      purpose,
      provider: provider.info.id,
      model: r.model,
      model_version: r.model_version,
      endpoint: provider.info.endpoint,
      request_id: r.request_id,
      started_at: started.toISOString(),
      latency_ms: r.latency_ms,
      status: 'ok',
      error_code: null,
      error_message: null,
      http_status: null,
      temperature: req.temperature ?? 0,
      max_tokens: req.maxTokens ?? 1500,
      json_mode: Boolean(req.json),
      attempt,
      fallback_from: fallbackFrom,
      fallback_reason: fallbackFrom ? firstFailure?.code ?? null : null,
      input_tokens: r.usage.input_tokens,
      output_tokens: r.usage.output_tokens,
      cost: estimateCost(provider.info.pricing, r),
      prompt_sha256: digest.sha,
      prompt_chars: digest.chars,
      response_sha256: sha256(r.text),
      response_chars: r.text.length,
      finish_reason: r.finish_reason,
    };
  }

  private errorRecord(
    purpose: CallPurpose,
    req: CompletionRequest,
    digest: { sha: string; chars: number },
    id: string,
    provider: LLMProvider | null,
    err: LlmError,
    attempt: number,
    fallbackFrom: string | null,
    firstFailure: LlmError | null,
    started = new Date(),
  ): LlmCallRecord {
    return {
      call_id: newCallId(),
      purpose,
      provider: id,
      model: provider?.info.model ?? '',
      model_version: null,
      endpoint: provider?.info.endpoint ?? null,
      request_id: null,
      started_at: started.toISOString(),
      latency_ms: Date.now() - started.getTime(),
      status: 'error',
      error_code: err.code,
      error_message: err.message,
      http_status: err.httpStatus ?? null,
      temperature: req.temperature ?? 0,
      max_tokens: req.maxTokens ?? 1500,
      json_mode: Boolean(req.json),
      attempt,
      fallback_from: fallbackFrom,
      fallback_reason: fallbackFrom ? firstFailure?.code ?? null : null,
      input_tokens: null,
      output_tokens: null,
      cost: null,
      prompt_sha256: digest.sha,
      prompt_chars: digest.chars,
      response_sha256: null,
      response_chars: null,
      finish_reason: null,
    };
  }
}

/** Compact, secret-free metadata stored inside a DecisionProblem draft. */
export function problemLlmMeta(r: LlmCallRecord, promptVersion: string): Record<string, unknown> {
  return {
    provider: r.provider,
    model: r.model,
    model_version: r.model_version,
    request_id: r.request_id ?? undefined,
    temperature: r.temperature,
    max_tokens: r.max_tokens,
    started_at: r.started_at,
    latency_ms: r.latency_ms,
    status: r.status,
    fallback_from: r.fallback_from,
    call_id: r.call_id,
    prompt_version: promptVersion,
    prompt_sha256: r.prompt_sha256,
    response_sha256: r.response_sha256,
    input_tokens: r.input_tokens,
    output_tokens: r.output_tokens,
  };
}
