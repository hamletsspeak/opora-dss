import { hostOf, num, requestJson } from '../http.js';
import {
  LlmError,
  type CompletionRequest,
  type CompletionResult,
  type HealthResult,
  type LLMProvider,
  type Pricing,
  type ProviderInfo,
  type ProviderKind,
} from '../types.js';

export interface OpenAiCompatibleConfig {
  id: string;
  kind: Extract<ProviderKind, 'openai' | 'llamacpp'>;
  title: string;
  baseUrl: string;
  model: string;
  apiKey?: string;
  /** llama.cpp server does not require a key */
  requireKey: boolean;
  timeoutMs: number;
  pricing: Pricing | null;
  local: boolean;
  fetchImpl?: typeof fetch;
}

interface ChatCompletion {
  id?: string;
  model?: string;
  choices?: { message?: { content?: string | null; refusal?: string | null }; finish_reason?: string }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
}

/** OpenAI Chat Completions API and compatible servers (llama.cpp `llama-server`, vLLM, …). */
export class OpenAiCompatibleProvider implements LLMProvider {
  readonly info: ProviderInfo;

  constructor(private readonly cfg: OpenAiCompatibleConfig) {
    const missing: string[] = [];
    if (cfg.requireKey && !cfg.apiKey) missing.push(cfg.kind === 'openai' ? 'OPENAI_API_KEY' : 'LLAMACPP_API_KEY');
    if (!cfg.baseUrl) missing.push(cfg.kind === 'openai' ? 'OPENAI_BASE_URL' : 'LLAMACPP_BASE_URL');
    if (!cfg.model) missing.push(cfg.kind === 'openai' ? 'OPENAI_MODEL' : 'LLAMACPP_MODEL');
    this.info = {
      id: cfg.id,
      kind: cfg.kind,
      title: cfg.title,
      model: cfg.model,
      endpoint: hostOf(cfg.baseUrl),
      configured: missing.length === 0,
      missing,
      local: cfg.local,
      pricing: cfg.pricing,
    };
  }

  private headers(): Record<string, string> {
    return this.cfg.apiKey ? { Authorization: `Bearer ${this.cfg.apiKey}` } : {};
  }

  private ensureConfigured(): void {
    if (!this.info.configured)
      throw new LlmError('config', this.info.id, `не заданы переменные: ${this.info.missing.join(', ')}`);
  }

  async complete(req: CompletionRequest): Promise<CompletionResult> {
    this.ensureConfigured();
    const t0 = Date.now();
    const { json } = await requestJson({
      provider: this.info.id,
      url: `${this.cfg.baseUrl.replace(/\/+$/, '')}/chat/completions`,
      headers: this.headers(),
      body: {
        model: this.cfg.model,
        messages: req.messages,
        temperature: req.temperature ?? 0,
        max_tokens: req.maxTokens ?? 1500,
        ...(req.json ? { response_format: { type: 'json_object' } } : {}),
      },
      timeoutMs: req.timeoutMs ?? this.cfg.timeoutMs,
      secrets: [this.cfg.apiKey],
      fetchImpl: this.cfg.fetchImpl,
    });
    const r = json as ChatCompletion;
    const choice = r.choices?.[0];
    if (choice?.message?.refusal) throw new LlmError('content_filter', this.info.id, 'модель отказалась отвечать');
    const text = choice?.message?.content;
    if (typeof text !== 'string') throw new LlmError('bad_response', this.info.id, 'в ответе нет choices[0].message.content');
    if (choice?.finish_reason === 'content_filter') throw new LlmError('content_filter', this.info.id, 'ответ отфильтрован');
    return {
      text,
      provider: this.info.id,
      model: this.cfg.model,
      model_version: r.model ?? null,
      request_id: r.id ?? null,
      finish_reason: choice?.finish_reason ?? null,
      usage: {
        input_tokens: num(r.usage?.prompt_tokens),
        output_tokens: num(r.usage?.completion_tokens),
        total_tokens: num(r.usage?.total_tokens),
      },
      latency_ms: Date.now() - t0,
    };
  }

  /** GET /models — free for OpenAI and available in llama.cpp server; does not spend tokens. */
  async health(): Promise<HealthResult> {
    const t0 = Date.now();
    const base: Omit<HealthResult, 'ok' | 'detail' | 'error'> = {
      provider: this.info.id,
      checked_at: new Date().toISOString(),
      latency_ms: 0,
      model: this.cfg.model,
      spends_tokens: false,
    };
    try {
      this.ensureConfigured();
      const { json } = await requestJson({
        provider: this.info.id,
        url: `${this.cfg.baseUrl.replace(/\/+$/, '')}/models`,
        method: 'GET',
        headers: this.headers(),
        timeoutMs: Math.min(this.cfg.timeoutMs, 10_000),
        secrets: [this.cfg.apiKey],
        fetchImpl: this.cfg.fetchImpl,
      });
      const ids = ((json as { data?: { id?: string }[] }).data ?? []).map((m) => m.id);
      const found = this.cfg.kind === 'llamacpp' || ids.includes(this.cfg.model);
      return {
        ...base,
        latency_ms: Date.now() - t0,
        ok: found,
        detail: found ? `доступен; модель ${this.cfg.model}` : `модель ${this.cfg.model} не найдена в /models`,
        error: found ? null : { code: 'config', message: `модель ${this.cfg.model} недоступна для этого ключа` },
      };
    } catch (e) {
      const err = e instanceof LlmError ? e : new LlmError('unavailable', this.info.id, String(e));
      return { ...base, latency_ms: Date.now() - t0, ok: false, detail: err.message, error: { code: err.code, message: err.message } };
    }
  }
}
