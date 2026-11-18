import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { createApp } from './app.js';
import { readAppInfo } from './appInfo.js';
import { configFromEnv } from './deps.js';
import { FileRunStore, MemoryRunStore } from './experiments/store.js';
import { createLogger, type LogLevel } from './http/logger.js';
import { serviceFromEnv } from './llm/registry.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Secrets come only from the server environment or a local, git-ignored .env; values are never logged.
dotenv.config({ path: path.join(root, '.env'), quiet: true });

const env = process.env;
const logger = createLogger((env.LOG_LEVEL as LogLevel) || 'info');
const config = configFromEnv(env, root);
const app = readAppInfo(root, env);
const store = config.dataDir ? new FileRunStore(config.dataDir) : new MemoryRunStore();
const llm = serviceFromEnv(env, { dataDir: config.dataDir });

const server = createApp({ app, llm, store, logger, config, startedAt: new Date() });
const port = Number(env.PORT || 8787);
const host = env.HOST || '0.0.0.0';

const listener = server.listen(port, host, () => {
  logger.info('started', {
    url: `http://${host === '0.0.0.0' ? 'localhost' : host}:${port}`,
    version: app.version,
    commit: app.commit?.slice(0, 12) ?? null,
    storage: store.kind,
    llm_default: llm.registry.defaultId,
    llm_configured: llm.registry.list().filter((p) => p.configured).map((p) => p.id),
    llm_config_errors: llm.registry.configErrors,
    api_token: Boolean(config.apiToken),
  });
});

for (const signal of ['SIGTERM', 'SIGINT'] as const) process.once(signal, () => {
  logger.info('stopping', { signal });
  listener.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10_000).unref();
});
