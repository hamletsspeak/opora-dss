import type { VercelRequest, VercelResponse } from '@vercel/node';
import {
  emptySession,
  type ChatMessage,
  type SessionState,
} from '../shared/types.js';
import { runAgentTurn } from '../server/agent.js';
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
    const key = getApiKey();
    if (!key) {
      res.status(500).json({ error: 'OPENAI_API_KEY не задан на сервере' });
      return;
    }
    const body = parseBody<{
      message?: string;
      messages?: ChatMessage[];
      session?: SessionState;
    }>(req);
    const userText = String(body.message ?? '').trim();
    if (!userText) {
      res.status(400).json({ error: 'Пустое сообщение' });
      return;
    }
    const messages = (body.messages ?? []) as ChatMessage[];
    const session = body.session || emptySession();
    const turn = await runAgentTurn({
      apiKey: key,
      model: getModel(),
      messages,
      session,
      userText,
    });
    res.status(200).json(turn);
  } catch {
    res.status(500).json({ error: 'Ошибка агента' });
  }
}
