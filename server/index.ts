import dotenv from 'dotenv';
import fs from 'node:fs';
import express from 'express';
import cors from 'cors';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  emptySession,
  type AuditRecord,
  type ChatMessage,
  type McdmResult,
  type SessionState,
} from '../shared/types.js';
import {
  DEFAULT_MCDM_SAMPLES,
  DEFAULT_MCDM_SEED,
  runRobustMcdm,
  isAnalysisReady,
} from '../shared/mcdm.js';
import { applyDemoSuppliers } from '../shared/demo.js';
import { buildAuditRecord, globalAuditStore } from '../shared/audit.js';
import { explainResult, runAgentTurn } from './agent.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

// Local secrets: project .env, then agent openai.env — never log values
dotenv.config({ path: path.join(root, '.env') });
if (!process.env.OPENAI_API_KEY) {
  const agentEnv = '/cursor/stores/self/internal/openai.env';
  if (fs.existsSync(agentEnv)) dotenv.config({ path: agentEnv });
}

const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));

const PORT = Number(process.env.PORT || 8787);
const MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';

function requireKey(): string {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error('OPENAI_API_KEY не задан на сервере');
  return key;
}

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    model: MODEL,
    hasKey: Boolean(process.env.OPENAI_API_KEY),
  });
});

app.post('/api/chat', async (req, res) => {
  try {
    let key: string;
    try {
      key = requireKey();
    } catch {
      res.status(500).json({ error: 'OPENAI_API_KEY не задан на сервере' });
      return;
    }
    const userText = String(req.body?.message ?? '').trim();
    if (!userText) {
      res.status(400).json({ error: 'Пустое сообщение' });
      return;
    }
    const messages = (req.body?.messages ?? []) as ChatMessage[];
    const session = (req.body?.session as SessionState) || emptySession();

    const turn = await runAgentTurn({
      apiKey: key,
      model: MODEL,
      messages,
      session,
      userText,
    });

    res.json(turn);
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'chat error';
    console.error('[chat]', msg);
    res.status(500).json({ error: 'Ошибка агента' });
  }
});

function demoHandler(req: express.Request, res: express.Response) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    res.status(405).json({ error: 'Method not allowed', allow: 'POST' });
    return;
  }
  const session = (req.body?.session as SessionState) || emptySession();
  const next = applyDemoSuppliers(session);
  res.json({
    session: next,
    canAnalyze: isAnalysisReady(next),
    reply: 'Загружены демо-поставщики. Можно запускать анализ.',
  });
}

app.post('/api/demo', demoHandler);
app.get('/api/demo', demoHandler);

app.post('/api/analyze', async (req, res) => {
  try {
    const session = req.body?.session as SessionState;
    if (!session || !isAnalysisReady(session)) {
      res.status(400).json({
        error: 'Недостаточно данных: нужны ≥2 критерия и ≥2 альтернативы с оценками',
      });
      return;
    }
    const samplesRaw = Number(req.body?.samples);
    const seedRaw = Number(req.body?.seed);
    const samples =
      Number.isFinite(samplesRaw) && samplesRaw > 0
        ? Math.min(10_000, Math.floor(samplesRaw))
        : DEFAULT_MCDM_SAMPLES;
    const seed =
      Number.isFinite(seedRaw) ? Math.floor(seedRaw) : DEFAULT_MCDM_SEED;

    // Local-only: MCDM_BACKEND=python proxies to python/server.py (default: ts)
    const backend = (process.env.MCDM_BACKEND || 'ts').toLowerCase();
    if (backend === 'python') {
      const pyUrl =
        process.env.MCDM_PYTHON_URL || 'http://127.0.0.1:8790/analyze';
      const pyRes = await fetch(pyUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session, samples, seed, messages: req.body?.messages }),
      });
      const pyJson = (await pyRes.json()) as {
        analysis?: McdmResult;
        explanation?: string;
        audit?: AuditRecord;
        error?: string;
      };
      if (!pyRes.ok || !pyJson.analysis) {
        res.status(pyRes.status || 502).json({
          error: pyJson.error || 'Python MCDM backend error',
        });
        return;
      }
      const audit =
        pyJson.audit ||
        buildAuditRecord({
          session,
          analysis: pyJson.analysis,
          explanation: pyJson.explanation,
          messages: req.body?.messages,
        });
      globalAuditStore.put(audit);
      res.json({
        analysis: pyJson.analysis,
        explanation: pyJson.explanation || pyJson.analysis.sensitivityNote,
        audit,
        backend: 'python',
      });
      return;
    }

    const analysis = runRobustMcdm(session, samples, seed);
    let explanation = '';
    try {
      explanation = await explainResult({
        apiKey: requireKey(),
        model: MODEL,
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
      explanation = analysis.sensitivityNote;
    }

    const messages = (req.body?.messages ?? []) as ChatMessage[];
    const audit = buildAuditRecord({
      session,
      analysis,
      explanation,
      messages: messages.length ? messages : undefined,
    });
    globalAuditStore.put(audit);

    res.json({ analysis, explanation, audit });
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'analyze error';
    console.error('[analyze]', msg);
    res.status(500).json({ error: 'Ошибка анализа' });
  }
});

app.get('/api/audit', (req, res) => {
  const id = typeof req.query.id === 'string' ? req.query.id : undefined;
  if (id) {
    const one = globalAuditStore.get(id);
    if (!one) {
      res.status(404).json({ error: 'Запись не найдена' });
      return;
    }
    res.json({ audit: one });
    return;
  }
  res.json({ audits: globalAuditStore.list() });
});

app.post('/api/audit', (req, res) => {
  try {
    const body = req.body as {
      audit?: AuditRecord;
      session?: SessionState;
      analysis?: McdmResult;
      explanation?: string;
      messages?: ChatMessage[];
    };
    let record: AuditRecord;
    if (body.session && body.analysis) {
      record = buildAuditRecord({
        session: body.session,
        analysis: body.analysis,
        explanation: body.explanation,
        messages: body.messages,
      });
    } else if (body.audit?.session && body.audit.ranking && body.audit.mcdmParams) {
      record = buildAuditRecord({
        session: body.audit.session,
        analysis: {
          ranking: body.audit.ranking,
          samples: body.audit.samples ?? body.audit.mcdmParams.samples,
          sensitivityNote: body.audit.sensitivityNote ?? '',
          weightMeans: body.audit.weightMeans ?? {},
          methods: body.audit.methods ?? {
            topsis: body.audit.ranking,
            wsm: body.audit.ranking,
            vikor: body.audit.ranking,
          },
          agreement: body.audit.agreement ?? {
            leaderMatchRate: 0,
            pairwiseLeaderMatch: {
              topsis_wsm: 0,
              topsis_vikor: 0,
              wsm_vikor: 0,
            },
            meanRankByMethod: {},
          },
          mcdmParams: body.audit.mcdmParams,
        },
        explanation: body.audit.explanation ?? body.explanation,
        messages: body.audit.messages ?? body.messages,
        id: body.audit.id,
        ts: body.audit.ts,
      });
    } else {
      res.status(400).json({
        error: 'Нужен audit или связка session+analysis',
      });
      return;
    }
    res.json({ audit: globalAuditStore.put(record), ok: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'audit error';
    console.error('[audit]', msg);
    res.status(500).json({ error: 'Ошибка audit' });
  }
});

// Production static
const dist = path.join(root, 'dist');
app.use(express.static(dist));
app.get(/^(?!\/api).*/, (_req, res) => {
  res.sendFile(path.join(dist, 'index.html'), (err) => {
    if (err) res.status(404).send('Build the client first (npm run build)');
  });
});

app.listen(PORT, () => {
  console.log(`Klar API on http://localhost:${PORT}`);
});
