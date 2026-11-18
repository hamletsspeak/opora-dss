import type {
  AgentLlmInfo,
  Alternative,
  ChatMessage,
  Criterion,
  SessionState,
} from '../shared/types.js';
import { emptySession } from '../shared/types.js';
import { applyDemoSuppliers } from '../shared/demo.js';
import { isAnalysisReady } from '../shared/mcdm.js';
import { parseJsonReply } from './llm/draft.js';
import { providerNotice } from './llm/formalize.js';
import { LlmCallFailed, type LlmService, type ProviderSelection } from './llm/service.js';
import { ERROR_TEXT } from './llm/types.js';

const SYSTEM = `Ты агент Klar (СППР). Говори тепло и просто, на «вы». Извлекай структуру решения из русской речи.
Отвечай ТОЛЬКО JSON:
{"reply":"…","sessionPatch":{"context":"","criteria":[{"id":"slug","name":"","direction":"min|max","weightUncertain":true,"importance":"high|medium|low|unknown","valueHint":null|number|[lo,hi]}],"alternatives":[],"missing":[],"readyForAnalysis":false,"usedDemoData":false},"offerDemo":false,"canAnalyze":false}
Правила:
- direction: цена/срок/брак/партия/стоимость → min; качество/надёжность/рейтинг → max.
- Интервалы («450–500») → [450,500] в valueHint критерия (не в alternatives).
- «важны, но не знаю насколько» → weightUncertain:true, importance:high.
- НЕ выдумывай альтернативы и оценки. alternatives=[] пока пользователь не перечислил поставщиков/варианты с числами.
- Если альтернатив нет и критерии есть → offerDemo:true; в reply предложи «демо» или вставку альтернатив (не спрашивай все valueHint сразу).
- canAnalyze:true только при ≥2 критериях и ≥2 альтернативах с оценками по всем критериям.
- reply ≤2 коротких предложения на русском.`;

function slugify(name: string, fallback: string): string {
  const s = name
    .toLowerCase()
    .replace(/[^a-zа-яё0-9]+/gi, '_')
    .replace(/^_|_$/g, '')
    .slice(0, 40);
  return s || fallback;
}

function normalizeCriterion(c: Criterion, i: number): Criterion {
  const name = c.name?.trim() || `Критерий ${i + 1}`;
  const n = name.toLowerCase();
  let direction = c.direction;
  if (/брак|дефект|срок|время|парт|лот|издерж|риск|задерж|стоим/.test(n)) {
    direction = 'min';
  } else if (/(^|[^а-яё])цен(а|ы|е|у)?([^а-яё]|$)/.test(n) || (n.includes('цен') && !n.includes('процент'))) {
    direction = 'min';
  } else if (/качеств|надёж|надеж|рейтинг|удобств|сервис/.test(n)) {
    direction = 'max';
  }
  const importance = c.importance || 'unknown';
  const hasWeight = typeof c.weight === 'number';
  // Exact weight → respect weightUncertain flag; otherwise sample from importance priors
  const weightUncertain = hasWeight ? c.weightUncertain === true : true;
  return {
    id: c.id || slugify(name, `c${i + 1}`),
    name,
    direction: direction === 'max' ? 'max' : 'min',
    weight: hasWeight ? c.weight : undefined,
    weightUncertain,
    importance,
    valueHint: c.valueHint,
  };
}

function looksFabricated(alts: Alternative[], userText: string): boolean {
  if (!alts.length) return false;
  // If user didn't mention any alt name fragment, treat as fabricated
  const t = userText.toLowerCase();
  const mentioned = alts.some((a) => {
    const parts = a.name.toLowerCase().split(/\s+/).filter((w) => w.length > 3);
    return parts.some((p) => t.includes(p));
  });
  return !mentioned;
}

function mergeSession(
  base: SessionState,
  patch: Partial<SessionState> | undefined,
  userText: string,
): SessionState {
  if (!patch) return base;

  const criteria = (patch.criteria?.length ? patch.criteria : base.criteria).map(
    (c, i) => normalizeCriterion(c, i),
  );

  let alternatives = patch.alternatives?.length
    ? patch.alternatives
    : base.alternatives;

  // Drop LLM-hallucinated suppliers / scores
  if (looksFabricated(alternatives, userText) && !/демо|пример поставщик|подстав/i.test(userText)) {
    alternatives = base.alternatives.length ? base.alternatives : [];
  }

  return {
    context:
      (patch.context?.trim() ? patch.context : base.context) ||
      (/поставщик|выбор\s+постав/i.test(userText) ? 'Выбор поставщика' : ''),
    criteria,
    alternatives,
    missing: patch.missing ?? base.missing,
    readyForAnalysis: false,
    usedDemoData: false,
  };
}

function fallbackParse(
  userText: string,
  session: SessionState,
): {
  reply: string;
  session: SessionState;
  offerDemo: boolean;
  canAnalyze: boolean;
} {
  let next: SessionState = {
    ...session,
    criteria: session.criteria.map((c, i) => normalizeCriterion(c, i)),
    alternatives: [...session.alternatives],
  };
  const t = userText.toLowerCase();

  if (!next.context && (t.includes('поставщик') || t.includes('выбор'))) {
    next.context = 'Выбор поставщика';
  }

  if (
    next.criteria.length === 0 &&
    (t.includes('цен') || t.includes('срок') || t.includes('брак'))
  ) {
    next.criteria = [
      {
        id: 'price',
        name: 'Цена',
        direction: 'min',
        weightUncertain: true,
        importance: 'high',
        valueHint: /450/.test(t) ? [450, 500] : undefined,
      },
      {
        id: 'lead_time',
        name: 'Срок поставки',
        direction: 'min',
        weightUncertain: true,
        importance: 'high',
      },
      {
        id: 'defect_rate',
        name: 'Процент брака',
        direction: 'min',
        weightUncertain: true,
        importance: 'medium',
      },
      {
        id: 'min_lot',
        name: 'Минимальная партия',
        direction: 'min',
        weightUncertain: true,
        importance: 'low',
      },
    ];
  }

  if (/демо|пример|подставь|готовые/.test(t)) {
    next = applyDemoSuppliers(next);
    return {
      reply: 'Подставила демо-поставщиков. Можно запускать робастный анализ.',
      session: { ...next, readyForAnalysis: true },
      offerDemo: false,
      canAnalyze: isAnalysisReady(next),
    };
  }

  // Parse pasted simple alternatives: "Название: цена=.., срок=.."
  const lineAlts = parsePastedAlternatives(userText, next.criteria);
  if (lineAlts.length >= 2) {
    next.alternatives = lineAlts;
  }

  const canAnalyze = isAnalysisReady(next);
  next.readyForAnalysis = canAnalyze;
  next.missing = [];
  if (next.criteria.length < 2) next.missing.push('критерии');
  if (next.alternatives.length < 2) next.missing.push('альтернативы');

  const offerDemo = next.alternatives.length < 2;
  let reply =
    'Зафиксировала контекст и критерии. Добавьте альтернативы с оценками или скажите «демо».';
  if (canAnalyze) reply = 'Данных достаточно — можно запускать анализ.';
  else if (offerDemo)
    reply =
      'Критерии понятны (с неопределённостью весов). Перечислите поставщиков или скажите «использовать демо».';

  return { reply, session: next, offerDemo, canAnalyze };
}

function parsePastedAlternatives(
  text: string,
  criteria: Criterion[],
): Alternative[] {
  const lines = text.split(/\n|;/).map((l) => l.trim()).filter(Boolean);
  const alts: Alternative[] = [];
  for (const line of lines) {
    // "Альфа: 480, 5, 1.5, 100" or "Альфа цена 480 срок 5"
    const m = line.match(/^([^:：—-]{2,40})\s*[:：—-]\s*(.+)$/);
    if (!m || criteria.length === 0) continue;
    const name = m[1].trim();
    const nums = m[2].match(/\d+(?:[.,]\d+)?(?:\s*[–-]\s*\d+(?:[.,]\d+)?)?/g);
    if (!nums || nums.length < Math.min(2, criteria.length)) continue;
    const scores: Alternative['scores'] = {};
    criteria.forEach((c, i) => {
      if (!nums[i]) return;
      const part = nums[i].replace(',', '.');
      if (/[–-]/.test(part)) {
        const [a, b] = part.split(/\s*[–-]\s*/).map(Number);
        scores[c.id] = [a, b];
      } else {
        scores[c.id] = Number(part);
      }
    });
    if (Object.keys(scores).length >= 2) {
      alts.push({
        id: slugify(name, `a${alts.length + 1}`),
        name,
        scores,
      });
    }
  }
  return alts;
}

export interface AgentTurn {
  reply: string;
  session: SessionState;
  offerDemo: boolean;
  canAnalyze: boolean;
  llm: AgentLlmInfo;
}

function rulesInfo(notice: string, error: AgentLlmInfo['error'] = null, provider: string | null = null): AgentLlmInfo {
  return { mode: 'rules', provider, model: null, fallback_from: null, notice, error };
}

export async function runAgentTurn(opts: {
  llm: LlmService | null;
  selection?: ProviderSelection;
  messages: ChatMessage[];
  session: SessionState;
  userText: string;
}): Promise<AgentTurn> {
  // Fast path: explicit demo request
  if (/демо|использовать демо|готовые поставщик|подставь/i.test(opts.userText)) {
    const session = applyDemoSuppliers(opts.session);
    return {
      reply: 'Загружены демо-поставщики с интервальными оценками. Можно запускать анализ.',
      session,
      offerDemo: false,
      canAnalyze: isAnalysisReady(session),
      llm: rulesInfo('Команда «демо» обработана без LLM.'),
    };
  }

  if (!opts.llm) {
    return {
      ...fallbackParse(opts.userText, opts.session || emptySession()),
      llm: rulesInfo('LLM не настроена — использован встроенный разбор по правилам.'),
    };
  }
  const compact = {
    context: opts.session.context,
    criteria: opts.session.criteria,
    alternatives: opts.session.alternatives.map((a) => ({
      id: a.id,
      name: a.name,
      scoreKeys: Object.keys(a.scores),
    })),
  };

  try {
    const call = await opts.llm.call('chat', {
      temperature: 0.1,
      maxTokens: 700,
      json: true,
      messages: [
        { role: 'system', content: SYSTEM },
        { role: 'system', content: `Состояние: ${JSON.stringify(compact)}` },
        ...opts.messages
          .slice(-6)
          // FE may already include the current user turn — avoid duplicating it
          .filter(
            (m, i, arr) =>
              !(
                i === arr.length - 1 &&
                m.role === 'user' &&
                m.content === opts.userText
              ),
          )
          .map((m) => ({
            role: m.role as 'user' | 'assistant',
            content: m.content,
          })),
        { role: 'user', content: opts.userText },
      ],
    }, opts.selection);

    const llmInfo: AgentLlmInfo = {
      mode: 'llm',
      provider: call.record.provider,
      model: call.record.model_version ?? call.record.model,
      fallback_from: call.record.fallback_from,
      notice: providerNotice(call.record, call.attempts),
      error: null,
    };
    const json = parseJsonReply(call.result.text);
    if (!json.ok || !json.value || typeof json.value !== 'object') {
      return {
        ...fallbackParse(opts.userText, opts.session || emptySession()),
        llm: rulesInfo(
          `${call.record.provider} вернул некорректный JSON — использован встроенный разбор по правилам.`,
          { code: 'bad_response', message: 'ответ не является JSON-объектом' },
          call.record.provider,
        ),
      };
    }
    const parsed = json.value as {
      reply?: string;
      sessionPatch?: Partial<SessionState>;
      offerDemo?: boolean;
      canAnalyze?: boolean;
    };

    let session = mergeSession(opts.session, parsed.sessionPatch, opts.userText);

    const pasted = parsePastedAlternatives(opts.userText, session.criteria);
    if (pasted.length >= 2) session.alternatives = pasted;

    const canAnalyze = isAnalysisReady(session);
    session.readyForAnalysis = canAnalyze;
    const offerDemo =
      session.alternatives.length < 2 && session.criteria.length >= 2;

    return {
      reply:
        parsed.reply?.trim() ||
        (offerDemo
          ? 'Критерии приняты. Перечислите альтернативы или скажите «демо».'
          : 'Приняла. Можно уточнить оценки или запустить анализ.'),
      session,
      offerDemo,
      canAnalyze,
      llm: llmInfo,
    };
  } catch (e) {
    if (!(e instanceof LlmCallFailed)) throw e;
    const last = e.attempts.at(-1);
    return {
      ...fallbackParse(opts.userText, opts.session || emptySession()),
      llm: rulesInfo(
        `LLM недоступна (${last?.provider ?? '—'}: ${ERROR_TEXT[e.last.code]}) — использован встроенный разбор по правилам.`,
        { code: e.last.code, message: e.last.message },
        last?.provider ?? null,
      ),
    };
  }
}
