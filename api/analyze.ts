import type { VercelRequest, VercelResponse } from '@vercel/node';
import type { ChatMessage, SessionState } from '../shared/types.js';
import {
  DEFAULT_MCDM_SAMPLES,
  DEFAULT_MCDM_SEED,
  runRobustMcdm,
  isAnalysisReady,
} from '../shared/mcdm.js';
import { buildAuditRecord, globalAuditStore } from '../shared/audit.js';
import { explainResult } from '../server/agent.js';
import {
  getApiKey,
  getModel,
  handleOptions,
  methodNotAllowed,
  parseBody,
} from './_lib.js';

export const config = { maxDuration: 60 };

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (handleOptions(req, res)) return;
  if (req.method !== 'POST') {
    methodNotAllowed(res, 'POST, OPTIONS');
    return;
  }
  try {
    const body = parseBody<{
      session?: SessionState;
      messages?: ChatMessage[];
      samples?: number;
      seed?: number;
    }>(req);
    const session = body.session;
    if (!session || !isAnalysisReady(session)) {
      res.status(400).json({
        error:
          'Недостаточно данных: нужны ≥2 критерия и ≥2 альтернативы с оценками',
      });
      return;
    }
    const samples =
      typeof body.samples === 'number' && body.samples > 0
        ? Math.min(10_000, Math.floor(body.samples))
        : DEFAULT_MCDM_SAMPLES;
    const seed =
      typeof body.seed === 'number' && Number.isFinite(body.seed)
        ? Math.floor(body.seed)
        : DEFAULT_MCDM_SEED;

    const analysis = runRobustMcdm(session, samples, seed);
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
            methods: {
              topsisLeader: analysis.methods.topsis[0]?.name,
              wsmLeader: analysis.methods.wsm[0]?.name,
              vikorLeader: analysis.methods.vikor[0]?.name,
            },
            agreement: {
              leaderMatchRate: Number(
                analysis.agreement.leaderMatchRate.toFixed(3),
              ),
              pairwise: analysis.agreement.pairwiseLeaderMatch,
            },
            sensitivityNote: analysis.sensitivityNote,
            weightMeans: analysis.weightMeans,
            samples: analysis.samples,
            mcdmParams: analysis.mcdmParams,
          }),
        });
      } catch {
        /* keep sensitivityNote */
      }
    }

    const audit = buildAuditRecord({
      session,
      analysis,
      explanation,
      messages: body.messages,
    });
    globalAuditStore.put(audit);

    res.status(200).json({ analysis, explanation, audit });
  } catch {
    res.status(500).json({ error: 'Ошибка анализа' });
  }
}
