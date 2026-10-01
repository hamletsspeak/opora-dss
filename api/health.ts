import type { VercelRequest, VercelResponse } from '@vercel/node';

const MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';

export default function handler(_req: VercelRequest, res: VercelResponse) {
  res.status(200).json({
    ok: true,
    model: MODEL,
    hasKey: Boolean(process.env.OPENAI_API_KEY),
  });
}
