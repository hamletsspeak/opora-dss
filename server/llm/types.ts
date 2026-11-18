export type ProviderKind = 'openai' | 'yandexgpt' | 'ollama' | 'llamacpp' | 'mock';

export type LlmErrorCode =
  | 'config'
  | 'auth'
  | 'rate_limit'
  | 'timeout'
  | 'unavailable'
  | 'bad_request'
  | 'bad_response'
  | 'content_filter';

/** Errors that may succeed on another provider or a later retry. */
export const RETRIABLE: ReadonlySet<LlmErrorCode> = new Set(['rate_limit', 'timeout', 'unavailable']);

export const ERROR_TEXT: Record<LlmErrorCode, string> = {
  config: 'провайдер не настроен',
  auth: 'ошибка авторизации (проверьте ключ/токен на сервере)',
  rate_limit: 'превышен лимит запросов (429)',
  timeout: 'превышено время ожидания ответа',
  unavailable: 'провайдер недоступен',
  bad_request: 'провайдер отклонил запрос',
  bad_response: 'некорректный ответ провайдера',
  content_filter: 'ответ заблокирован фильтром провайдера',
};

export class LlmError extends Error {
  constructor(
    readonly code: LlmErrorCode,
    readonly provider: string,
    message: string,
    readonly httpStatus?: number,
    readonly retryAfterSec?: number,
  ) {
    super(message);
    this.name = 'LlmError';
  }
}

export interface LlmMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface CompletionRequest {
  messages: LlmMessage[];
  temperature?: number;
  maxTokens?: number;
  /** ask the provider for a JSON object response (provider-native mode where available) */
  json?: boolean;
  timeoutMs?: number;
}

export interface Usage {
  input_tokens: number | null;
  output_tokens: number | null;
  total_tokens: number | null;
}

export interface CompletionResult {
  text: string;
  provider: string;
  model: string;
  /** model version reported by the provider, if any */
  model_version: string | null;
  request_id: string | null;
  finish_reason: string | null;
  usage: Usage;
  latency_ms: number;
}

export interface Pricing {
  input_per_1m: number;
  output_per_1m: number;
  currency: string;
}

export interface ProviderInfo {
  id: string;
  kind: ProviderKind;
  title: string;
  model: string;
  /** host only, never credentials */
  endpoint: string | null;
  configured: boolean;
  /** names of missing env variables (never values) */
  missing: string[];
  local: boolean;
  pricing: Pricing | null;
}

export interface HealthResult {
  provider: string;
  ok: boolean;
  checked_at: string;
  latency_ms: number;
  model: string;
  detail: string;
  error: { code: LlmErrorCode; message: string } | null;
  /** an active check may spend a few tokens (YandexGPT has no free model endpoint) */
  spends_tokens: boolean;
}

export interface LLMProvider {
  readonly info: ProviderInfo;
  health(): Promise<HealthResult>;
  complete(req: CompletionRequest): Promise<CompletionResult>;
}
