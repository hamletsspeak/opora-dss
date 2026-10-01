import type { VercelRequest, VercelResponse } from '@vercel/node';
import { emptySession, type SessionState } from '../shared/types.ts';
import { applyDemoSuppliers } from '../shared/demo.ts';
import { isAnalysisReady } from '../shared/mcdm.ts';
import {
  handleOptions,
  methodNotAllowed,
  parseBody,
} from './_lib.ts';

export const config = { maxDuration: 60 };

export default function handler(req: VercelRequest, res: VercelResponse) {
  if (handleOptions(req, res)) return;
  if (req.method !== 'POST') {
    methodNotAllowed(res, 'POST, OPTIONS');
    return;
  }
  const body = parseBody<{ session?: SessionState }>(req);
  const session = body.session || emptySession();
  const next = applyDemoSuppliers(session);
  res.status(200).json({
    session: next,
    canAnalyze: isAnalysisReady(next),
    reply: 'Загружены демо-поставщики. Можно запускать анализ.',
  });
}
