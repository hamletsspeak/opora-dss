import { hostOf, num, requestJson } from '../http.js';
import {
  LlmError,
  type CompletionRequest,
  type CompletionResult,
  type HealthResult,
  type LLMProvider,
  type Pricing,
  type ProviderInfo,
} from '../types.js';

export interface YandexConfig {
  baseUrl: string;
  folderId?: string;
  /** service-account API key (`Authorization: Api-Key …`) */
  apiKey?: string;
  /** alternatively a short-lived IAM token (`Authorization: Bearer …`) */
  iamToken?: string;
  /** model name inside the folder, e.g. `yandexgpt-lite/latest`; full `gpt://…` URIs are accepted too */
  model: string;
  timeoutMs: number;
  pricing: Pricing | null;
  fetchImpl?: typeof fetch;
}

interface YandexCompletion {
  result?: {
    alternatives?: { message?: { role?: string; text?: string }; status?: string }[];
    usage?: { inputTextTokens?: string | number; completionTokens?: string | number; totalTokens?: string | number };
    modelVersion?: string;
  };
}

/** Yandex AI Studio (YandexGPT) Foundation Models text generation API, synchronous mode. */
export class YandexGptProvider implements LLMProvider {
  readonly info: ProviderInfo;

  constructor(private readonly cfg: YandexConfig) {
    const missing: string[] = [];
    if (!cfg.apiKey && !cfg.iamToken) missing.push('YANDEX_API_KEY | YANDEX_IAM_TOKEN');
    if (!cfg.folderId && !cfg.model.startsWith('gpt://')) missing.push('YANDEX_FOLDER_ID');
    this.info = {
      id: 'yandexgpt',
      kind: 'yandexgpt',
      title: 'YandexGPT (Yandex AI Studio)',
      model: cfg.model,
      endpoint: hostOf(cfg.baseUrl),
      configured: missing.length === 0,
      missing,
      local: false,
      pricing: cfg.pricing,
    };
  }

  get modelUri(): string {
    return this.cfg.model.startsWith('gpt://') ? this.cfg.model : `gpt://${this.cfg.folderId}/${this.cfg.model}`;
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = this.cfg.apiKey
      ? { Authorization: `Api-Key ${this.cfg.apiKey}` }
      : { Authorization: `Bearer ${this.cfg.iamToken}` };
    if (this.cfg.folderId) h['x-folder-id'] = this.cfg.folderId;
    return h;
  }

  async complete(req: CompletionRequest): Promise<CompletionResult> {
    if (!this.info.configured)
      throw new LlmError('config', this.info.id, `не заданы переменные: ${this.info.missing.join(', ')}`);
    const t0 = Date.now();
    const { json, headers } = await requestJson({
      provider: this.info.id,
      url: `${this.cfg.baseUrl.replace(/\/+$/, '')}/foundationModels/v1/completion`,
      headers: this.headers(),
      body: {
        modelUri: this.modelUri,
        completionOptions: {
          stream: false,
          temperature: req.temperature ?? 0,
          maxTokens: String(req.maxTokens ?? 1500),
        },
        messages: req.messages.map((m) => ({ role: m.role, text: m.content })),
        ...(req.json ? { jsonObject: true } : {}),
      },
      timeoutMs: req.timeoutMs ?? this.cfg.timeoutMs,
      secrets: [this.cfg.apiKey, this.cfg.iamToken],
      fetchImpl: this.cfg.fetchImpl,
    });
    const r = (json as YandexCompletion).result;
    const alt = r?.alternatives?.[0];
    if (alt?.status === 'ALTERNATIVE_STATUS_CONTENT_FILTER')
      throw new LlmError('content_filter', this.info.id, 'ответ заблокирован фильтром YandexGPT');
    const text = alt?.message?.text;
    if (typeof text !== 'string') throw new LlmError('bad_response', this.info.id, 'в ответе нет result.alternatives[0].message.text');
    return {
      text,
      provider: this.info.id,
      model: this.cfg.model,
      model_version: r?.modelVersion ?? null,
      request_id: headers.get('x-request-id'),
      finish_reason: alt?.status ?? null,
      usage: {
        input_tokens: num(r?.usage?.inputTextTokens),
        output_tokens: num(r?.usage?.completionTokens),
        total_tokens: num(r?.usage?.totalTokens),
      },
      latency_ms: Date.now() - t0,
    };
  }

  /** The native API has no free model listing; the check is a 1-token completion. */
  async health(): Promise<HealthResult> {
    const t0 = Date.now();
    const base = {
      provider: this.info.id,
      checked_at: new Date().toISOString(),
      model: this.cfg.model,
      spends_tokens: true,
    };
    try {
      await this.complete({ messages: [{ role: 'user', content: 'ok' }], maxTokens: 1, timeoutMs: 15_000 });
      return { ...base, latency_ms: Date.now() - t0, ok: true, detail: `доступен; ${this.modelUri.replace(/^gpt:\/\/[^/]+/, 'gpt://…')}`, error: null };
    } catch (e) {
      const err = e instanceof LlmError ? e : new LlmError('unavailable', this.info.id, String(e));
      return { ...base, latency_ms: Date.now() - t0, ok: false, detail: err.message, error: { code: err.code, message: err.message } };
    }
  }
}
