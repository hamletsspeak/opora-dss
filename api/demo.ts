import type { VercelRequest, VercelResponse } from '@vercel/node';
import { emptySession, type SessionState } from '../shared/types';
import { applyDemoSuppliers } from '../shared/demo';
import { isAnalysisReady } from '../shared/mcdm';
import {
  handleOptions,
  methodNotAllowed,
  parseBody,
} from './lib';

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
