import path from 'node:path';
import type { AppInfo } from './appInfo.js';
import type { RunStore } from './experiments/store.js';
import type { Logger } from './http/logger.js';
import type { LlmService } from './llm/service.js';

export interface AppConfig {
  /** allowed CORS origins; null = same-origin only */
  corsOrigins: string[] | null;
  apiToken: string | null;
  jsonLimit: string;
  uploadLimit: string;
  llmRatePerMinute: number;
  distDir: string | null;
  dataDir: string | null;
  trustProxy: boolean;
}

export interface AppDeps {
  app: AppInfo;
  llm: LlmService;
  store: RunStore;
  logger: Logger;
  config: AppConfig;
  startedAt: Date;
}

export function configFromEnv(env: Record<string, string | undefined>, root: string): AppConfig {
  const cors = env.CORS_ORIGIN?.trim();
  const uploadMb = Math.max(1, Math.min(100, Number(env.MAX_UPLOAD_MB) || 10));
  const dataDir = env.DATA_DIR?.trim();
  return {
    corsOrigins: cors ? cors.split(',').map((s) => s.trim()).filter(Boolean) : null,
    apiToken: env.API_TOKEN?.trim() || null,
    jsonLimit: '2mb',
    uploadLimit: `${uploadMb}mb`,
    llmRatePerMinute: Math.max(0, Number(env.LLM_RATE_LIMIT_PER_MIN ?? 20) || 0),
    distDir: path.join(root, 'dist'),
    dataDir: dataDir === 'memory' ? null : path.resolve(root, dataDir || 'data/runs'),
    trustProxy: env.TRUST_PROXY === '1' || env.TRUST_PROXY === 'true',
  };
}
