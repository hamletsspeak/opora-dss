import { randomUUID, timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { CsvError } from '../../shared/csv.js';
import { DatasetError } from '../../shared/ecommerce/dataset.js';
import { ZodError } from 'zod';
import { ImportError } from '../../shared/import/table.js';
import { EngineError } from '../../shared/engine/index.js';
import { ProblemValidationError } from '../../shared/problem/index.js';
import { DraftNotConfirmedError } from '../experiments/runner.js';
import { LlmCallFailed } from '../llm/service.js';
import { ERROR_TEXT, LlmError } from '../llm/types.js';
import type { Logger } from './logger.js';

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code = 'http_error',
    readonly details?: unknown,
  ) {
    super(message);
  }
}

export function requestId(): RequestHandler {
  return (req, res, next) => {
    const incoming = req.header('x-request-id');
    const id = incoming && /^[\w.-]{1,64}$/.test(incoming) ? incoming : randomUUID();
    res.locals.requestId = id;
    res.setHeader('X-Request-Id', id);
    next();
  };
}

export function accessLog(logger: Logger): RequestHandler {
  return (req, res, next) => {
    const t0 = process.hrtime.bigint();
    res.on('finish', () => {
      if (req.path === '/api/health' && res.statusCode === 200) return;
      logger.info('http', {
        req_id: res.locals.requestId,
        method: req.method,
        path: req.path,
        status: res.statusCode,
        ms: Number((process.hrtime.bigint() - t0) / 1_000_000n),
        bytes_in: Number(req.header('content-length') ?? 0),
      });
    });
    next();
  };
}

export function securityHeaders(): RequestHandler {
  return (_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
    );
    next();
  };
}

/** Optional shared token for the API (set API_TOKEN on public deployments). GET /api/health stays open. */
export function apiToken(token: string | null): RequestHandler {
  if (!token) return (_req, _res, next) => next();
  const want = Buffer.from(token);
  return (req, _res, next) => {
    if (req.path === '/health') return next();
    const got = Buffer.from((req.header('authorization') ?? '').replace(/^Bearer\s+/i, ''));
    if (got.length === want.length && timingSafeEqual(got, want)) return next();
    next(new HttpError(401, 'Требуется токен доступа (Authorization: Bearer …)', 'unauthorized'));
  };
}

/** Fixed-window limiter per client IP; used for endpoints that call paid LLM APIs. */
export function rateLimit(perMinute: number): RequestHandler {
  const hits = new Map<string, { start: number; n: number }>();
  return (req, res, next) => {
    if (perMinute <= 0) return next();
    const key = req.ip ?? 'unknown';
    const now = Date.now();
    const h = hits.get(key);
    if (!h || now - h.start >= 60_000) {
      hits.set(key, { start: now, n: 1 });
      if (hits.size > 10_000) hits.clear();
      return next();
    }
    if (++h.n > perMinute) {
      res.setHeader('Retry-After', String(Math.ceil((h.start + 60_000 - now) / 1000)));
      return next(new HttpError(429, `Слишком много запросов к LLM: не более ${perMinute} в минуту`, 'rate_limited'));
    }
    next();
  };
}

export function asyncRoute(fn: (req: Request, res: Response) => Promise<void> | void): RequestHandler {
  return (req, res, next) => {
    Promise.resolve(fn(req, res)).catch(next);
  };
}

export function errorHandler(logger: Logger) {
  return (err: unknown, _req: Request, res: Response, next: NextFunction): void => {
    void next;
    const reqId = res.locals.requestId;
    const send = (status: number, body: Record<string, unknown>) => {
      if (!res.headersSent) res.status(status).json({ ...body, request_id: reqId });
    };
    if (err instanceof HttpError) return send(err.status, { error: err.message, code: err.code, details: err.details });
    if (err instanceof ProblemValidationError) return send(422, { error: 'Задача не прошла проверку', code: 'validation_failed', issues: err.issues });
    if (err instanceof DraftNotConfirmedError) return send(409, { error: err.message, code: 'draft_not_confirmed' });
    if (err instanceof ImportError) return send(400, { error: 'Ошибка импорта', code: 'import_failed', errors: err.errors });
    if (err instanceof CsvError) return send(400, { error: err.message, code: 'csv_invalid' });
    if (err instanceof DatasetError) return send(400, { error: err.message, code: 'dataset_invalid', errors: err.errors });
    if (err instanceof ZodError) return send(400, { error: 'Некорректные параметры', code: 'bad_request', details: err.issues.slice(0, 20) });
    if (err instanceof EngineError) return send(422, { error: err.message, code: err.code });
    if (err instanceof LlmCallFailed || err instanceof LlmError) {
      const e = err instanceof LlmCallFailed ? err.last : err;
      return send(502, { error: `LLM: ${ERROR_TEXT[e.code]}`, code: `llm_${e.code}`, provider: e.provider });
    }
    const t = (err as { type?: string; status?: number } | null) ?? {};
    if (t.type === 'entity.too.large') return send(413, { error: 'Слишком большой запрос', code: 'payload_too_large' });
    if (t.type === 'entity.parse.failed') return send(400, { error: 'Тело запроса не является корректным JSON', code: 'bad_json' });
    logger.error('unhandled', { req_id: reqId, err: err instanceof Error ? `${err.name}: ${err.message}`.slice(0, 500) : String(err).slice(0, 500) });
    send(500, { error: 'Внутренняя ошибка сервера', code: 'internal' });
  };
}
