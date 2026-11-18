import fs from 'node:fs';
import path from 'node:path';
import cors from 'cors';
import express, { type Express } from 'express';
import { ENGINE } from '../shared/engine/index.js';
import { SCHEMA_VERSION } from '../shared/problem/index.js';
import type { AppDeps } from './deps.js';
import { accessLog, apiToken, errorHandler, HttpError, requestId, securityHeaders } from './http/middleware.js';
import { legacyRouter } from './routes/legacy.js';
import { v1Router } from './routes/v1.js';
import { ecommerceRouter } from './routes/ecommerce.js';
import { benchmarkRouter } from './routes/benchmark.js';

export function createApp(deps: AppDeps): Express {
  const app = express();
  app.disable('x-powered-by');
  if (deps.config.trustProxy) app.set('trust proxy', 1);
  app.use(requestId());
  app.use(accessLog(deps.logger));
  app.use(securityHeaders());
  if (deps.config.corsOrigins)
    app.use('/api', cors({ origin: deps.config.corsOrigins.includes('*') ? true : deps.config.corsOrigins, methods: ['GET', 'POST'] }));

  app.get('/api/health', (_req, res) => {
    const def = deps.llm.registry.get(deps.llm.registry.defaultId);
    res.json({
      ok: true,
      status: 'ok',
      version: deps.app.version,
      commit: deps.app.commit,
      engine: ENGINE,
      schema_version: SCHEMA_VERSION,
      uptime_s: Math.round((Date.now() - deps.startedAt.getTime()) / 1000),
      storage: { kind: deps.store.kind },
      llm: {
        default: deps.llm.registry.defaultId,
        default_configured: def?.info.configured ?? false,
        fallback: deps.llm.registry.fallback,
        providers: deps.llm.registry.list().map((p) => ({ id: p.id, configured: p.configured, model: p.model, local: p.local })),
        config_errors: deps.llm.registry.configErrors,
      },
      // legacy fields used by the original UI
      model: def?.info.model ?? null,
      hasKey: def?.info.configured ?? false,
    });
  });

  app.use('/api', apiToken(deps.config.apiToken));
  app.use('/api/v1/ecommerce', ecommerceRouter(deps));
  app.use('/api/v1/llm-benchmark', benchmarkRouter(deps));
  app.use('/api/v1', v1Router(deps));
  app.use('/api', legacyRouter(deps));
  app.use('/api', (_req, _res, next) => next(new HttpError(404, 'Неизвестный маршрут API', 'not_found')));

  const dist = deps.config.distDir;
  if (dist && fs.existsSync(path.join(dist, 'index.html'))) {
    app.use(express.static(dist, { index: false, maxAge: '1h' }));
    app.get(/^(?!\/api).*/, (_req, res) => res.sendFile('index.html', { root: dist }));
  } else {
    app.get(/^(?!\/api).*/, (_req, res) => {
      res.status(404).type('text/plain').send('Клиент не собран: выполните npm run build (в режиме разработки используйте npm run dev).');
    });
  }

  app.use(errorHandler(deps.logger));
  return app;
}
