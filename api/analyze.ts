import type { VercelRequest, VercelResponse } from '@vercel/node';
import type { ChatMessage, SessionState } from '../shared/types.js';
import {
  DEFAULT_MCDM_SAMPLES,
  DEFAULT_MCDM_SEED,
  isAnalysisReady,
  runRobustMcdmDetailed,
} from '../shared/mcdm.js';
import { buildAuditRecord, globalAuditStore } from '../shared/audit.js';
import { explainRun } from '../server/llm/explain.js';
import { getLlm, handleOptions, methodNotAllowed, parseBody } from './_lib.js';

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
        ? Math.min(20_000, Math.floor(body.samples))
        : DEFAULT_MCDM_SAMPLES;
    const seed =
      typeof body.seed === 'number' && Number.isFinite(body.seed)
        ? Math.floor(body.seed) >>> 0
        : DEFAULT_MCDM_SEED;

    const { analysis, run, sensitivity } = runRobustMcdmDetailed(session, samples, seed);
    const explanation = await explainRun(getLlm(), run, sensitivity);
    const audit = buildAuditRecord({
      session,
      analysis,
      explanation: explanation.text,
      messages: body.messages,
    });
    globalAuditStore.put(audit);

    res.status(200).json({
      analysis,
      explanation: explanation.text,
      explanation_meta: {
        source: explanation.source,
        provider_notice: explanation.provider_notice,
        rejected: explanation.rejected,
        provider: explanation.llm?.provider ?? null,
        model: explanation.llm?.model_version ?? explanation.llm?.model ?? null,
      },
      audit,
    });
  } catch {
    res.status(500).json({ error: 'Ошибка анализа' });
  }
}
