import type { VercelRequest, VercelResponse } from '@vercel/node';
import type { SessionState } from '../shared/types';
import { runRobustMcdm, isAnalysisReady } from '../shared/mcdm';
import { explainResult } from '../server/agent';
import {
  getApiKey,
  getModel,
  handleOptions,
  methodNotAllowed,
  parseBody,
} from './lib';

export const config = { maxDuration: 60 };

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (handleOptions(req, res)) return;
  if (req.method !== 'POST') {
    methodNotAllowed(res, 'POST, OPTIONS');
    return;
  }
  try {
    const body = parseBody<{ session?: SessionState }>(req);
    const session = body.session;
    if (!session || !isAnalysisReady(session)) {
      res.status(400).json({
        error:
          'Недостаточно данных: нужны ≥2 критерия и ≥2 альтернативы с оценками',
      });
      return;
    }
    const analysis = runRobustMcdm(session, 2000, 42);
    let explanation = analysis.sensitivityNote;
    const key = getApiKey();
    if (key) {
      try {
        explanation = await explainResult({
          apiKey: key,
          model: getModel(),
          session,
          analysisJson: JSON.stringify({
            ranking: analysis.ranking.map((r) => ({
              name: r.name,
              winRate: Number(r.winRate.toFixed(3)),
              expectedScore: Number(r.expectedScore.toFixed(3)),
              meanRank: Number(r.meanRank.toFixed(2)),
            })),
            sensitivityNote: analysis.sensitivityNote,
            weightMeans: analysis.weightMeans,
            samples: analysis.samples,
          }),
        });
      } catch {
        /* keep sensitivityNote */
      }
    }
    res.status(200).json({ analysis, explanation });
  } catch {
    res.status(500).json({ error: 'Ошибка анализа' });
  }
}
