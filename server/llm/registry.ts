import path from 'node:path';
import { CallLog } from './callLog.js';
import { MockProvider } from './providers/mock.js';
import { OllamaProvider } from './providers/ollama.js';
import { OpenAiCompatibleProvider } from './providers/openaiCompatible.js';
import { YandexGptProvider } from './providers/yandex.js';
import { LlmService } from './service.js';
import type { LLMProvider, Pricing, ProviderInfo, ProviderKind } from './types.js';

export const PROVIDER_IDS: ProviderKind[] = ['openai', 'yandexgpt', 'ollama', 'llamacpp', 'mock'];

export class ProviderRegistry {
  private readonly byId: Map<string, LLMProvider>;

  constructor(
    providers: LLMProvider[],
    readonly defaultId: string,
    readonly fallback: string[] = [],
    readonly configErrors: string[] = [],
  ) {
    this.byId = new Map(providers.map((p) => [p.info.id, p]));
  }

  get(id: string): LLMProvider | undefined {
    return this.byId.get(id);
  }

  list(): (ProviderInfo & { is_default: boolean; in_fallback: boolean })[] {
    return [...this.byId.values()].map((p) => ({
      ...p.info,
      is_default: p.info.id === this.defaultId,
      in_fallback: this.fallback.includes(p.info.id),
    }));
  }
}

type Env = Record<string, string | undefined>;

function clean(v: string | undefined): string | undefined {
  const s = v?.trim();
  return s ? s : undefined;
}

function pricing(env: Env, prefix: string, currency: string): Pricing | null {
  const i = Number(env[`${prefix}_PRICE_INPUT_PER_1M`]);
  const o = Number(env[`${prefix}_PRICE_OUTPUT_PER_1M`]);
  if (!Number.isFinite(i) || !Number.isFinite(o) || !env[`${prefix}_PRICE_INPUT_PER_1M`]) return null;
  return { input_per_1m: i, output_per_1m: o, currency: clean(env[`${prefix}_PRICE_CURRENCY`]) ?? currency };
}

export function registryFromEnv(env: Env = process.env, fetchImpl?: typeof fetch): ProviderRegistry {
  const timeoutMs = Math.max(1000, Number(env.LLM_TIMEOUT_MS) || 60_000);
  const providers: LLMProvider[] = [
    new OpenAiCompatibleProvider({
      id: 'openai',
      kind: 'openai',
      title: 'OpenAI',
      baseUrl: clean(env.OPENAI_BASE_URL) ?? 'https://api.openai.com/v1',
      model: clean(env.OPENAI_MODEL) ?? 'gpt-4o-mini',
      apiKey: clean(env.OPENAI_API_KEY),
      requireKey: true,
      timeoutMs,
      pricing: pricing(env, 'OPENAI', 'USD'),
      local: false,
      fetchImpl,
    }),
    new YandexGptProvider({
      baseUrl: clean(env.YANDEX_BASE_URL) ?? 'https://llm.api.cloud.yandex.net',
      folderId: clean(env.YANDEX_FOLDER_ID),
      apiKey: clean(env.YANDEX_API_KEY),
      iamToken: clean(env.YANDEX_IAM_TOKEN),
      model: clean(env.YANDEX_MODEL) ?? 'yandexgpt-lite/latest',
      timeoutMs,
      pricing: pricing(env, 'YANDEX', 'RUB'),
      fetchImpl,
    }),
    new OllamaProvider({
      baseUrl: clean(env.OLLAMA_BASE_URL) ?? 'http://127.0.0.1:11434',
      model: clean(env.OLLAMA_MODEL) ?? 'qwen2.5:7b-instruct',
      timeoutMs: Math.max(timeoutMs, 120_000),
      fetchImpl,
    }),
    new OpenAiCompatibleProvider({
      id: 'llamacpp',
      kind: 'llamacpp',
      title: 'llama.cpp server (локальная модель)',
      baseUrl: clean(env.LLAMACPP_BASE_URL) ?? 'http://127.0.0.1:8080/v1',
      model: clean(env.LLAMACPP_MODEL) ?? 'local',
      apiKey: clean(env.LLAMACPP_API_KEY),
      requireKey: false,
      timeoutMs: Math.max(timeoutMs, 120_000),
      pricing: null,
      local: true,
      fetchImpl,
    }),
    new MockProvider({
      failWith: (clean(env.MOCK_LLM_FAIL) as never) || undefined,
      latencyMs: Number(env.MOCK_LLM_LATENCY_MS) || 0,
    }),
  ];
  const errors: string[] = [];
  const requested = clean(env.LLM_PROVIDER)?.toLowerCase() ?? 'openai';
  if (!PROVIDER_IDS.includes(requested as ProviderKind))
    errors.push(`LLM_PROVIDER=${requested}: неизвестный провайдер (допустимо: ${PROVIDER_IDS.join(', ')})`);
  const fallback = (clean(env.LLM_FALLBACK) ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  for (const f of fallback)
    if (!PROVIDER_IDS.includes(f as ProviderKind)) errors.push(`LLM_FALLBACK: неизвестный провайдер ${f}`);
  return new ProviderRegistry(
    providers,
    requested,
    fallback.filter((f) => PROVIDER_IDS.includes(f as ProviderKind) && f !== requested),
    errors,
  );
}

export function serviceFromEnv(env: Env = process.env, opts: { dataDir?: string | null; fetchImpl?: typeof fetch } = {}): LlmService {
  const registry = registryFromEnv(env, opts.fetchImpl);
  const file = opts.dataDir ? path.join(opts.dataDir, 'llm-calls.jsonl') : null;
  return new LlmService(registry, new CallLog(1000, file), {
    maxRetries: Math.max(0, Math.min(3, Number(env.LLM_MAX_RETRIES ?? 1) || 0)),
    retryDelayMs: 1000,
  });
}
