import { hostOf, num, requestJson } from '../http.js';
import {
  LlmError,
  type CompletionRequest,
  type CompletionResult,
  type HealthResult,
  type LLMProvider,
  type ProviderInfo,
} from '../types.js';

export interface OllamaConfig {
  baseUrl: string;
  model: string;
  timeoutMs: number;
  fetchImpl?: typeof fetch;
}

interface OllamaChat {
  model?: string;
  message?: { content?: string };
  done_reason?: string;
  prompt_eval_count?: number;
  eval_count?: number;
}

/** Local models via Ollama (`/api/chat`, non-streaming). */
export class OllamaProvider implements LLMProvider {
  readonly info: ProviderInfo;

  constructor(private readonly cfg: OllamaConfig) {
    const missing: string[] = [];
    if (!cfg.baseUrl) missing.push('OLLAMA_BASE_URL');
    if (!cfg.model) missing.push('OLLAMA_MODEL');
    this.info = {
      id: 'ollama',
      kind: 'ollama',
      title: 'Ollama (локальная модель)',
      model: cfg.model,
      endpoint: hostOf(cfg.baseUrl),
      configured: missing.length === 0,
      missing,
      local: true,
      pricing: null,
    };
  }

  async complete(req: CompletionRequest): Promise<CompletionResult> {
    if (!this.info.configured)
      throw new LlmError('config', this.info.id, `не заданы переменные: ${this.info.missing.join(', ')}`);
    const t0 = Date.now();
    const { json } = await requestJson({
      provider: this.info.id,
      url: `${this.cfg.baseUrl.replace(/\/+$/, '')}/api/chat`,
      body: {
        model: this.cfg.model,
        messages: req.messages,
        stream: false,
        ...(req.json ? { format: 'json' } : {}),
        options: { temperature: req.temperature ?? 0, num_predict: req.maxTokens ?? 1500 },
      },
      timeoutMs: req.timeoutMs ?? this.cfg.timeoutMs,
      fetchImpl: this.cfg.fetchImpl,
    });
    const r = json as OllamaChat;
    const text = r.message?.content;
    if (typeof text !== 'string') throw new LlmError('bad_response', this.info.id, 'в ответе нет message.content');
    const inp = num(r.prompt_eval_count);
    const out = num(r.eval_count);
    return {
      text,
      provider: this.info.id,
      model: this.cfg.model,
      model_version: r.model ?? null,
      request_id: null,
      finish_reason: r.done_reason ?? null,
      usage: { input_tokens: inp, output_tokens: out, total_tokens: inp !== null && out !== null ? inp + out : null },
      latency_ms: Date.now() - t0,
    };
  }

  /** GET /api/tags lists locally pulled models; no generation. */
  async health(): Promise<HealthResult> {
    const t0 = Date.now();
    const base = { provider: this.info.id, checked_at: new Date().toISOString(), model: this.cfg.model, spends_tokens: false };
    try {
      if (!this.info.configured) throw new LlmError('config', this.info.id, `не заданы переменные: ${this.info.missing.join(', ')}`);
      const { json } = await requestJson({
        provider: this.info.id,
        url: `${this.cfg.baseUrl.replace(/\/+$/, '')}/api/tags`,
        method: 'GET',
        timeoutMs: 5_000,
        fetchImpl: this.cfg.fetchImpl,
      });
      const names = ((json as { models?: { name?: string; model?: string }[] }).models ?? []).flatMap((m) => [m.name, m.model]);
      const want = this.cfg.model.includes(':') ? [this.cfg.model] : [this.cfg.model, `${this.cfg.model}:latest`];
      const found = want.some((w) => names.includes(w));
      return {
        ...base,
        latency_ms: Date.now() - t0,
        ok: found,
        detail: found ? `доступен; модель ${this.cfg.model}` : `модель ${this.cfg.model} не загружена (ollama pull ${this.cfg.model})`,
        error: found ? null : { code: 'config', message: `модель ${this.cfg.model} не найдена в /api/tags` },
      };
    } catch (e) {
      const err = e instanceof LlmError ? e : new LlmError('unavailable', this.info.id, String(e));
      return { ...base, latency_ms: Date.now() - t0, ok: false, detail: err.message, error: { code: err.code, message: err.message } };
    }
  }
}
