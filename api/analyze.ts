import type { VercelRequest, VercelResponse } from '@vercel/node';
import type { SessionState } from '../shared/types.ts';
import { runRobustMcdm, isAnalysisReady } from '../shared/mcdm.ts';
import { explainResult } from '../server/agent.ts';

const MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }
  try {
    const session = req.body?.session as SessionState;
    if (!session || !isAnalysisReady(session)) {
      res.status(400).json({
        error:
          'Недостаточно данных: нужны ≥2 критерия и ≥2 альтернативы с оценками',
      });
      return;
    }
    const analysis = runRobustMcdm(session, 2000, 42);
    let explanation = analysis.sensitivityNote;
    const key = process.env.OPENAI_API_KEY;
    if (key) {
      try {
        explanation = await explainResult({
          apiKey: key,
          model: MODEL,
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
