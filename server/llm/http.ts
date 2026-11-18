import { LlmError, type LlmErrorCode } from './types.js';

const SECRET_PATTERNS: RegExp[] = [
  /sk-[A-Za-z0-9_-]{8,}/g,
  /(Bearer|Api-Key)\s+[A-Za-z0-9._~+/=-]{6,}/gi,
  /AQVN[A-Za-z0-9_-]{10,}/g,
  /t1\.[A-Za-z0-9._-]{20,}/g,
];

/** Remove anything that looks like a credential, plus the given known secrets. */
export function redact(text: string, secrets: (string | undefined)[] = []): string {
  let out = text;
  for (const s of secrets) if (s && s.length >= 6) out = out.split(s).join('***');
  for (const re of SECRET_PATTERNS) out = out.replace(re, '***');
  return out;
}

export function hostOf(url: string | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}${u.pathname.replace(/\/+$/, '')}`;
  } catch {
    return null;
  }
}

function codeForStatus(status: number): LlmErrorCode {
  if (status === 401 || status === 403) return 'auth';
  if (status === 429) return 'rate_limit';
  if (status === 408 || status === 504) return 'timeout';
  if (status >= 500) return 'unavailable';
  if (status === 404) return 'bad_request';
  return 'bad_request';
}

export interface HttpOptions {
  provider: string;
  url: string;
  method?: 'GET' | 'POST';
  headers?: Record<string, string>;
  body?: unknown;
  timeoutMs: number;
  secrets?: (string | undefined)[];
  fetchImpl?: typeof fetch;
}

export interface HttpResult {
  status: number;
  json: unknown;
  headers: Headers;
}

/**
 * JSON request with a hard timeout and provider-neutral error classification.
 * Error messages never contain credentials (known secrets and key-like strings are redacted).
 */
export async function requestJson(o: HttpOptions): Promise<HttpResult> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), o.timeoutMs);
  const f = o.fetchImpl ?? fetch;
  let res: Response;
  try {
    res = await f(o.url, {
      method: o.method ?? 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...o.headers },
      body: o.body === undefined ? undefined : JSON.stringify(o.body),
      signal: ctrl.signal,
    });
  } catch (e) {
    clearTimeout(timer);
    if (ctrl.signal.aborted) throw new LlmError('timeout', o.provider, `нет ответа за ${o.timeoutMs} мс`);
    const msg = e instanceof Error ? e.message : String(e);
    throw new LlmError('unavailable', o.provider, `сетевая ошибка: ${redact(msg, o.secrets).slice(0, 200)}`);
  }
  let text: string;
  try {
    text = await res.text();
  } catch {
    clearTimeout(timer);
    if (ctrl.signal.aborted) throw new LlmError('timeout', o.provider, `ответ не получен за ${o.timeoutMs} мс`);
    throw new LlmError('unavailable', o.provider, 'обрыв соединения при чтении ответа', res.status);
  }
  clearTimeout(timer);
  if (!res.ok) {
    const code = codeForStatus(res.status);
    const ra = Number(res.headers.get('retry-after'));
    let detail = '';
    try {
      const j = JSON.parse(text) as { error?: { message?: string } | string; message?: string };
      detail = typeof j.error === 'string' ? j.error : j.error?.message ?? j.message ?? '';
    } catch {
      detail = text;
    }
    throw new LlmError(
      code,
      o.provider,
      `HTTP ${res.status}${detail ? `: ${redact(detail, o.secrets).slice(0, 300)}` : ''}`,
      res.status,
      Number.isFinite(ra) && ra > 0 ? ra : undefined,
    );
  }
  try {
    return { status: res.status, json: JSON.parse(text), headers: res.headers };
  } catch {
    throw new LlmError('bad_response', o.provider, 'ответ провайдера не является JSON', res.status);
  }
}

export function num(x: unknown): number | null {
  const n = typeof x === 'string' ? Number(x) : typeof x === 'number' ? x : NaN;
  return Number.isFinite(n) ? n : null;
}
