import type { VercelRequest, VercelResponse } from '@vercel/node';
import {
  emptySession,
  type ChatMessage,
  type SessionState,
} from '../shared/types.js';
import { runAgentTurn } from '../server/agent.js';
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
      message?: string;
      messages?: ChatMessage[];
      session?: SessionState;
    }>(req);
    const userText = String(body.message ?? '').trim().slice(0, 8000);
    if (!userText) {
      res.status(400).json({ error: 'Пустое сообщение' });
      return;
    }
    const turn = await runAgentTurn({
      llm: getLlm(),
      messages: Array.isArray(body.messages) ? body.messages : [],
      session: body.session || emptySession(),
      userText,
    });
    res.status(200).json(turn);
  } catch {
    res.status(500).json({ error: 'Ошибка агента' });
  }
}
