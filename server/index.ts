import dotenv from 'dotenv';
import fs from 'node:fs';
import express from 'express';
import cors from 'cors';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { emptySession, type ChatMessage, type SessionState } from '../shared/types.js';
import { runRobustMcdm, isAnalysisReady } from '../shared/mcdm.js';
import { applyDemoSuppliers } from '../shared/demo.js';
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
    const analysis = runRobustMcdm(session, 2000, 42);
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
          sensitivityNote: analysis.sensitivityNote,
          weightMeans: analysis.weightMeans,
          samples: analysis.samples,
        }),
      });
    } catch {
      explanation = analysis.sensitivityNote;
    }
    res.json({ analysis, explanation });
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'analyze error';
    console.error('[analyze]', msg);
    res.status(500).json({ error: 'Ошибка анализа' });
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
  console.log(`Опора API on http://localhost:${PORT}`);
});
