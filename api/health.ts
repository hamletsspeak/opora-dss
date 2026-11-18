import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getLlm, handleOptions } from './_lib.js';

export const config = { maxDuration: 10 };

export default function handler(req: VercelRequest, res: VercelResponse) {
  if (handleOptions(req, res)) return;
  const llm = getLlm();
  const def = llm.registry.get(llm.registry.defaultId);
  res.status(200).json({
    ok: true,
    deployment: 'vercel-legacy-demo',
    llm: { default: llm.registry.defaultId, default_configured: def?.info.configured ?? false, fallback: llm.registry.fallback },
    model: def?.info.model ?? null,
    hasKey: def?.info.configured ?? false,
  });
}
