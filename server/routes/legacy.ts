import express, { type Router } from 'express';
import { buildAuditRecord, globalAuditStore } from '../../shared/audit.js';
import { applyDemoSuppliers } from '../../shared/demo.js';
import { DEFAULT_MCDM_SAMPLES, DEFAULT_MCDM_SEED, isAnalysisReady, runRobustMcdmDetailed } from '../../shared/mcdm.js';
import { emptySession, type AuditRecord, type ChatMessage, type McdmResult, type SessionState } from '../../shared/types.js';
import { runAgentTurn } from '../agent.js';
import type { AppDeps } from '../deps.js';
import { asyncRoute, HttpError, rateLimit } from '../http/middleware.js';
import { explainRun } from '../llm/explain.js';

/** Endpoints of the original Klar chat UI, now backed by the v1 engine and the provider layer. */
export function legacyRouter(deps: AppDeps): Router {
  const r = express.Router();
  const json = express.json({ limit: deps.config.jsonLimit });
  const llmLimit = rateLimit(deps.config.llmRatePerMinute);

  r.post(
    '/chat',
    llmLimit,
    json,
    asyncRoute(async (req, res) => {
      const userText = String(req.body?.message ?? '').trim().slice(0, 8000);
      if (!userText) throw new HttpError(400, 'Пустое сообщение', 'bad_request');
      const messages = (Array.isArray(req.body?.messages) ? req.body.messages : []) as ChatMessage[];
      const session = (req.body?.session as SessionState) || emptySession();
      res.json(await runAgentTurn({ llm: deps.llm, messages, session, userText }));
    }),
  );

  const demo = (req: express.Request, res: express.Response) => {
    const session = (req.body?.session as SessionState) || emptySession();
    const next = applyDemoSuppliers(session);
    res.json({ session: next, canAnalyze: isAnalysisReady(next), reply: 'Загружены демо-поставщики. Можно запускать анализ.' });
  };
  r.post('/demo', json, demo);
  r.get('/demo', demo);

  r.post(
    '/analyze',
    llmLimit,
    json,
    asyncRoute(async (req, res) => {
      const session = req.body?.session as SessionState;
      if (!session || !isAnalysisReady(session))
        throw new HttpError(400, 'Недостаточно данных: нужны ≥2 критерия и ≥2 альтернативы с оценками', 'not_ready');
      const samplesRaw = Number(req.body?.samples);
      const seedRaw = Number(req.body?.seed);
      const samples = Number.isFinite(samplesRaw) && samplesRaw > 0 ? Math.min(20_000, Math.floor(samplesRaw)) : DEFAULT_MCDM_SAMPLES;
      const seed = Number.isFinite(seedRaw) ? Math.floor(seedRaw) >>> 0 : DEFAULT_MCDM_SEED;
      const { analysis, run, sensitivity } = runRobustMcdmDetailed(session, samples, seed);
      const explanation = await explainRun(deps.llm, run, sensitivity);
      const messages = (Array.isArray(req.body?.messages) ? req.body.messages : []) as ChatMessage[];
      const audit = buildAuditRecord({ session, analysis, explanation: explanation.text, messages: messages.length ? messages : undefined });
      globalAuditStore.put(audit);
      res.json({
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
    }),
  );

  r.get('/audit', (req, res) => {
    const id = typeof req.query.id === 'string' ? req.query.id : undefined;
    if (id) {
      const one = globalAuditStore.get(id);
      if (!one) throw new HttpError(404, 'Запись не найдена', 'not_found');
      res.json({ audit: one });
      return;
    }
    res.json({ audits: globalAuditStore.list() });
  });

  r.post('/audit', json, (req, res) => {
    const body = req.body as { audit?: AuditRecord; session?: SessionState; analysis?: McdmResult; explanation?: string; messages?: ChatMessage[] };
    let record: AuditRecord;
    if (body.session && body.analysis) {
      record = buildAuditRecord({ session: body.session, analysis: body.analysis, explanation: body.explanation, messages: body.messages });
    } else if (body.audit?.session && body.audit.ranking && body.audit.mcdmParams) {
      record = buildAuditRecord({
        session: body.audit.session,
        analysis: {
          ranking: body.audit.ranking,
          samples: body.audit.samples ?? body.audit.mcdmParams.samples,
          sensitivityNote: body.audit.sensitivityNote ?? '',
          weightMeans: body.audit.weightMeans ?? {},
          methods: body.audit.methods ?? { topsis: body.audit.ranking, wsm: body.audit.ranking, vikor: body.audit.ranking },
          agreement: body.audit.agreement ?? {
            leaderMatchRate: 0,
            pairwiseLeaderMatch: { topsis_wsm: 0, topsis_vikor: 0, wsm_vikor: 0 },
            meanRankByMethod: {},
          },
          mcdmParams: body.audit.mcdmParams,
        },
        explanation: body.audit.explanation ?? body.explanation,
        messages: body.audit.messages ?? body.messages,
        id: body.audit.id,
        ts: body.audit.ts,
      });
    } else throw new HttpError(400, 'Нужен audit или связка session+analysis', 'bad_request');
    res.json({ audit: globalAuditStore.put(record), ok: true });
  });

  return r;
}
