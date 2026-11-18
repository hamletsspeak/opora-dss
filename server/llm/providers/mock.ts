import { heuristicDraft } from '../heuristic.js';
import { extractSourceText } from '../prompts.js';
import {
  LlmError,
  type CompletionRequest,
  type CompletionResult,
  type HealthResult,
  type LLMProvider,
  type LlmErrorCode,
  type ProviderInfo,
} from '../types.js';

export type MockStep = string | { error: LlmErrorCode; message?: string; httpStatus?: number };

export interface MockConfig {
  id?: string;
  /** scripted responses consumed in order; when exhausted, the default behaviour applies */
  script?: MockStep[];
  /** custom handler overriding the default behaviour */
  handler?: (req: CompletionRequest) => string;
  failWith?: LlmErrorCode;
  latencyMs?: number;
  model?: string;
}

/**
 * Deterministic offline provider. Default behaviour: for formalization prompts it returns the
 * rule-based baseline draft (`heuristicDraft`) of the delimited source text; otherwise a fixed reply.
 * Used for tests, demos without keys and as a baseline in the LLM benchmark.
 */
export class MockProvider implements LLMProvider {
  readonly info: ProviderInfo;
  private readonly script: MockStep[];
  readonly calls: CompletionRequest[] = [];

  constructor(private readonly cfg: MockConfig = {}) {
    this.script = [...(cfg.script ?? [])];
    this.info = {
      id: cfg.id ?? 'mock',
      kind: 'mock',
      title: 'Mock (детерминированный, без сети)',
      model: cfg.model ?? 'rule-baseline-1',
      endpoint: null,
      configured: true,
      missing: [],
      local: true,
      pricing: null,
    };
  }

  async complete(req: CompletionRequest): Promise<CompletionResult> {
    this.calls.push(req);
    if (this.cfg.latencyMs) await new Promise((r) => setTimeout(r, this.cfg.latencyMs));
    const step = this.script.shift();
    if (this.cfg.failWith) throw new LlmError(this.cfg.failWith, this.info.id, 'имитация ошибки (MOCK_LLM_FAIL)');
    if (step && typeof step !== 'string')
      throw new LlmError(step.error, this.info.id, step.message ?? `имитация ошибки ${step.error}`, step.httpStatus);
    let text: string;
    if (typeof step === 'string') text = step;
    else if (this.cfg.handler) text = this.cfg.handler(req);
    else {
      const all = req.messages.map((m) => m.content).join('\n');
      const src = extractSourceText(all);
      text = src !== null ? JSON.stringify(heuristicDraft(src)) : JSON.stringify({ reply: 'Принято (mock).' });
    }
    const inTok = Math.ceil(req.messages.reduce((s, m) => s + m.content.length, 0) / 4);
    const outTok = Math.ceil(text.length / 4);
    return {
      text,
      provider: this.info.id,
      model: this.info.model,
      model_version: this.info.model,
      request_id: null,
      finish_reason: 'stop',
      usage: { input_tokens: inTok, output_tokens: outTok, total_tokens: inTok + outTok },
      latency_ms: this.cfg.latencyMs ?? 0,
    };
  }

  async health(): Promise<HealthResult> {
    return {
      provider: this.info.id,
      ok: !this.cfg.failWith,
      checked_at: new Date().toISOString(),
      latency_ms: 0,
      model: this.info.model,
      detail: this.cfg.failWith ? `имитация ошибки ${this.cfg.failWith}` : 'доступен (локальная имитация)',
      error: this.cfg.failWith ? { code: this.cfg.failWith, message: 'имитация ошибки' } : null,
      spends_tokens: false,
    };
  }
}
