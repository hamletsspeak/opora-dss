import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getApiKey, getModel, handleOptions } from './_lib.ts';

export const config = { maxDuration: 10 };

export default function handler(req: VercelRequest, res: VercelResponse) {
  if (handleOptions(req, res)) return;
  // Touch env so hasKey reflects deployed secret without exposing it
  getApiKey();
  res.status(200).json({
    ok: true,
    model: getModel(),
    hasKey: Boolean(process.env.OPENAI_API_KEY),
  });
}
