import type { VercelRequest, VercelResponse } from '@vercel/node';
import {
  emptySession,
  type ChatMessage,
  type SessionState,
} from '../shared/types.ts';
import { runAgentTurn } from '../server/agent.ts';

const MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }
  try {
    const key = process.env.OPENAI_API_KEY;
    if (!key) {
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
    res.status(200).json(turn);
  } catch {
    res.status(500).json({ error: 'Ошибка агента' });
  }
}
