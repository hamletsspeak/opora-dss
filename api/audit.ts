import type { VercelRequest, VercelResponse } from '@vercel/node';
import type { AuditRecord, ChatMessage, McdmResult, SessionState } from '../shared/types.js';
import { buildAuditRecord, globalAuditStore } from '../shared/audit.js';
import {
  handleOptions,
  methodNotAllowed,
  parseBody,
} from './_lib.js';

export const config = { maxDuration: 10 };

/**
 * Demo audit API: POST stores/echoes an audit record in-memory;
 * GET lists recent records (ephemeral on serverless).
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (handleOptions(req, res)) return;

  if (req.method === 'GET') {
    const id = typeof req.query?.id === 'string' ? req.query.id : undefined;
    if (id) {
      const one = globalAuditStore.get(id);
      if (!one) {
        res.status(404).json({ error: 'Запись не найдена' });
        return;
      }
      res.status(200).json({ audit: one });
      return;
    }
    res.status(200).json({ audits: globalAuditStore.list() });
    return;
  }

  if (req.method !== 'POST') {
    methodNotAllowed(res, 'GET, POST, OPTIONS');
    return;
  }

  try {
    const body = parseBody<{
      audit?: AuditRecord;
      session?: SessionState;
      analysis?: McdmResult;
      explanation?: string;
      messages?: ChatMessage[];
    }>(req);

    let record: AuditRecord | undefined;

    if (body.session && body.analysis) {
      record = buildAuditRecord({
        session: body.session,
        analysis: body.analysis,
        explanation: body.explanation,
        messages: body.messages,
      });
    } else if (
      body.audit?.session &&
      body.audit.ranking &&
      body.audit.mcdmParams
    ) {
      const a = body.audit;
      record = buildAuditRecord({
        session: a.session,
        analysis: {
          ranking: a.ranking,
          samples: a.samples ?? a.mcdmParams.samples,
          sensitivityNote: a.sensitivityNote ?? '',
          weightMeans: a.weightMeans ?? {},
          methods: a.methods ?? {
            topsis: a.ranking,
            wsm: a.ranking,
            vikor: a.ranking,
          },
          agreement: a.agreement ?? {
            leaderMatchRate: 0,
            pairwiseLeaderMatch: {
              topsis_wsm: 0,
              topsis_vikor: 0,
              wsm_vikor: 0,
            },
            meanRankByMethod: {},
          },
          mcdmParams: a.mcdmParams,
        },
        explanation: a.explanation ?? body.explanation,
        messages: a.messages ?? body.messages,
        id: a.id,
        ts: a.ts,
      });
    }

    if (!record) {
      res.status(400).json({
        error: 'Нужен audit или связка session+analysis (см. buildAuditRecord)',
      });
      return;
    }

    const stored = globalAuditStore.put(record);
    res.status(200).json({ audit: stored, ok: true });
  } catch {
    res.status(500).json({ error: 'Ошибка audit' });
  }
}
