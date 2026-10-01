import type { VercelRequest, VercelResponse } from '@vercel/node';
import { emptySession, type SessionState } from '../shared/types.ts';
import { applyDemoSuppliers } from '../shared/demo.ts';
import { isAnalysisReady } from '../shared/mcdm.ts';

export default function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }
  const session = (req.body?.session as SessionState) || emptySession();
  const next = applyDemoSuppliers(session);
  res.status(200).json({
    session: next,
    canAnalyze: isAnalysisReady(next),
    reply: 'Загружены демо-поставщики. Можно запускать анализ.',
  });
}
