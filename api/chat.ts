import type { VercelRequest, VercelResponse } from '@vercel/node';
import {
  emptySession,
  type ChatMessage,
  type SessionState,
} from '../shared/types';
import { runAgentTurn } from '../server/agent';
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
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/401|incorrect api key|invalid_api_key|invalid api key/i.test(msg)) {
      res.status(401).json({
        error:
          'OpenAI отклонил ключ (401). Проверьте OPENAI_API_KEY в Vercel Environment Variables.',
      });
      return;
    }
    console.error('[api/chat]', msg);
    res.status(500).json({ error: 'Ошибка агента' });
  }
}
