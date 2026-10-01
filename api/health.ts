import type { VercelRequest, VercelResponse } from '@vercel/node';

export const config = { maxDuration: 10 };

export default function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }
  res.status(200).json({
    ok: true,
    model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
    hasKey: Boolean(process.env.OPENAI_API_KEY && process.env.OPENAI_API_KEY.trim()),
  });
}
