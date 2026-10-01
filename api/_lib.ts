import type { VercelRequest, VercelResponse } from '@vercel/node';

export function getModel(): string {
  return process.env.OPENAI_MODEL || 'gpt-4o-mini';
}

export function getApiKey(): string | undefined {
  const key = process.env.OPENAI_API_KEY;
  return key && key.trim() ? key.trim() : undefined;
}

export function applyCors(res: VercelResponse): void {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

/** Parse JSON body for Node/Vercel (object | string | Buffer). */
export function parseBody<T = Record<string, unknown>>(req: VercelRequest): T {
  const raw = req.body;
  if (raw == null) return {} as T;
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw || '{}') as T;
    } catch {
      return {} as T;
    }
  }
  if (typeof Buffer !== 'undefined' && Buffer.isBuffer(raw)) {
    try {
      return JSON.parse(raw.toString('utf8') || '{}') as T;
    } catch {
      return {} as T;
    }
  }
  return raw as T;
}

export function handleOptions(req: VercelRequest, res: VercelResponse): boolean {
  applyCors(res);
  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return true;
  }
  return false;
}

export function methodNotAllowed(
  res: VercelResponse,
  allow: string,
): void {
  applyCors(res);
  res.setHeader('Allow', allow);
  res.status(405).json({ error: 'Method not allowed', allow });
}
