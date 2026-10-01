import { useEffect, useRef, useState } from 'react';
import type {
  ChatMessage,
  McdmResult,
  SessionState,
} from '../shared/types';
import { emptySession } from '../shared/types';

type Screen = 'hero' | 'chat' | 'results';

const EXAMPLE =
  'Я выбираю поставщика. Есть цена, срок поставки, процент брака и минимальная партия. По цене точно сказать не могу — примерно 450–500 рублей. Цена и срок для меня наиболее важны, но насколько именно — не знаю.';

async function postJson<T>(url: string, body: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch {
    throw new Error(
      'Сеть: не удалось достучаться до /api. Проверьте деплой serverless-функций.',
    );
  }
  const raw = await res.text();
  let data: { error?: string } = {};
  if (raw) {
    try {
      data = JSON.parse(raw) as { error?: string };
    } catch {
      if (raw.includes('FUNCTION_INVOCATION_FAILED')) {
        throw new Error(
          'API на Vercel упал при старте (FUNCTION_INVOCATION_FAILED). Нужен редеплой с исправлением serverless.',
        );
      }
      throw new Error(
        `Ответ API не JSON (HTTP ${res.status}). Маршрут /api может быть недоступен.`,
      );
    }
  }
  if (!res.ok) {
    throw new Error(data.error || `Ошибка API (HTTP ${res.status})`);
  }
  return data as T;
}

function TypingDots() {
  return (
    <div className="bubble assistant typing" aria-live="polite" aria-label="Агент печатает">
      <span className="dot" />
      <span className="dot" />
      <span className="dot" />
    </div>
  );
}

export default function App() {
  const [screen, setScreen] = useState<Screen>('hero');
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [session, setSession] = useState<SessionState>(emptySession());
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [offerDemo, setOfferDemo] = useState(false);
  const [canAnalyze, setCanAnalyze] = useState(false);
  const [analysis, setAnalysis] = useState<McdmResult | null>(null);
  const [explanation, setExplanation] = useState('');
  const bottomRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const messagesRef = useRef<HTMLDivElement>(null);

  const hasUserMessage = messages.some((m) => m.role === 'user');
  const showExample = !hasUserMessage && !session.usedDemoData;
  const showDemoChip =
    !session.usedDemoData &&
    (offerDemo || session.criteria.length >= 2) &&
    !canAnalyze;

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [messages, busy, screen, offerDemo, canAnalyze]);

  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = '0px';
    el.style.height = `${Math.min(el.scrollHeight, 132)}px`;
  }, [draft]);

  async function send(text: string) {
    const trimmed = text.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    setDraft('');
    const nextMessages = [...messages, { role: 'user' as const, content: trimmed }];
    setMessages(nextMessages);
    try {
      const data = await postJson<{
        reply: string;
        session: SessionState;
        offerDemo: boolean;
        canAnalyze: boolean;
      }>('/api/chat', {
        message: trimmed,
        // prior history only — current turn is `message` (QA: avoid duplicate user turn)
        messages,
        session,
      });
      setSession(data.session);
      setOfferDemo(data.offerDemo);
      setCanAnalyze(data.canAnalyze);
      setMessages([
        ...nextMessages,
        { role: 'assistant', content: data.reply },
      ]);
    } catch (e) {
      const msg =
        e instanceof Error
          ? e.message
          : 'Не удалось связаться с агентом. Проверьте сервер и OPENAI_API_KEY.';
      setMessages([
        ...nextMessages,
        {
          role: 'assistant',
          content: msg,
        },
      ]);
    } finally {
      setBusy(false);
      requestAnimationFrame(() => textareaRef.current?.focus());
    }
  }

  async function loadDemo() {
    setBusy(true);
    try {
      const data = await postJson<{
        session: SessionState;
        canAnalyze: boolean;
        reply: string;
      }>('/api/demo', { session });
      setSession(data.session);
      setCanAnalyze(data.canAnalyze);
      setOfferDemo(false);
      setMessages((m) => [
        ...m,
        { role: 'user', content: 'Использовать демо-поставщиков' },
        { role: 'assistant', content: data.reply },
      ]);
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Не удалось загрузить демо.';
      setMessages((m) => [...m, { role: 'assistant', content: msg }]);
    } finally {
      setBusy(false);
    }
  }

  async function analyze() {
    setBusy(true);
    try {
      const data = await postJson<{
        analysis: McdmResult;
        explanation: string;
      }>('/api/analyze', { session });
      setAnalysis(data.analysis);
      setExplanation(data.explanation);
      setScreen('results');
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Ошибка анализа';
      setMessages((m) => [...m, { role: 'assistant', content: msg }]);
    } finally {
      setBusy(false);
    }
  }

  function start() {
    setScreen('chat');
    setMessages([
      {
        role: 'assistant',
        content:
          'Опишите решение своими словами: критерии, важность, альтернативы. Можно с интервалами и «примерно».',
      },
    ]);
  }

  function resetAll() {
    setScreen('hero');
    setMessages([]);
    setSession(emptySession());
    setAnalysis(null);
    setExplanation('');
    setCanAnalyze(false);
    setOfferDemo(false);
    setDraft('');
    setBusy(false);
  }

  if (screen === 'hero') {
    return (
      <>
        <div className="app-bg" aria-hidden />
        <div className="shell hero-shell">
          <section className="hero">
            <p className="hero-kicker">СППР · LLM + робастный MCDM</p>
            <h1 className="brand">Опора</h1>
            <p className="hero-lead">
              Соберите нечёткий выбор в диалоге — получите устойчивое ранжирование
              с учётом неопределённости.
            </p>
            <button type="button" className="cta" onClick={start}>
              Начать диалог
            </button>
          </section>
        </div>
      </>
    );
  }

  if (screen === 'results' && analysis) {
    return (
      <>
        <div className="app-bg" aria-hidden />
        <div className="shell results">
          <header className="topbar">
            <div className="logo">Опора</div>
            <button
              type="button"
              className="chip ghost"
              onClick={() => setScreen('chat')}
            >
              ← к диалогу
            </button>
          </header>
          <h1>Ранжирование</h1>
          <p className="lead">
            {session.context?.trim() ||
              (session.usedDemoData ? 'Выбор поставщика' : 'Решение')}{' '}
            · {analysis.samples} симуляций
            {session.usedDemoData ? ' · демо-данные' : ''}
          </p>
          <ol className="rank-list">
            {analysis.ranking.map((r, i) => (
              <li
                key={r.alternativeId}
                className={`rank-item${i === 0 ? ' leader' : ''}`}
                style={{ animationDelay: `${0.06 * i}s` }}
              >
                <span className="n">{i + 1}</span>
                <div>
                  <div className="meta">
                    <span className="name">{r.name}</span>
                    <span className="pct">{(r.winRate * 100).toFixed(0)}% побед</span>
                  </div>
                  <div
                    className="bar"
                    title={`Ожидаемый балл ${r.expectedScore.toFixed(3)}`}
                  >
                    <i style={{ width: `${Math.max(4, r.winRate * 100)}%` }} />
                  </div>
                  <div className="rank-stats">
                    ср. ранг {r.meanRank.toFixed(2)} · балл{' '}
                    {r.expectedScore.toFixed(3)}
                  </div>
                </div>
              </li>
            ))}
          </ol>
          <p className="note">{analysis.sensitivityNote}</p>
          {explanation && (
            <section className="explain-block">
              <h2>Пояснение</h2>
              <p className="explain">{explanation}</p>
            </section>
          )}
          <div className="results-actions">
            <button type="button" className="cta secondary" onClick={resetAll}>
              Новое решение
            </button>
          </div>
        </div>
      </>
    );
  }

  return (
    <>
      <div className="app-bg" aria-hidden />
      <div className="shell chat-shell">
        <header className="topbar">
          <div className="logo">Опора</div>
          <span className={`chip${busy ? ' busy' : ''}`}>
            {busy ? 'думаю…' : 'агент + MCDM'}
          </span>
        </header>

        {(session.criteria.length > 0 || session.alternatives.length > 0) && (
          <div className="session-strip" aria-label="Состояние сессии">
            {(session.context?.trim() ||
              (session.criteria.length > 0 ? 'Решение в работе' : '')) && (
              <span className="strip-ctx">
                {session.context?.trim() || 'Решение в работе'}
              </span>
            )}
            {session.criteria.map((c) => (
              <span key={c.id} className="strip-crit">
                {c.name}
                {c.importance === 'high' ? ' ★' : ''}
                {c.weightUncertain ? ' ±' : ''}
                {Array.isArray(c.valueHint)
                  ? ` [${c.valueHint[0]}–${c.valueHint[1]}]`
                  : ''}
              </span>
            ))}
            {session.alternatives.map((a) => (
              <span key={a.id} className="strip-alt">
                {a.name}
              </span>
            ))}
          </div>
        )}

        {session.missing.length > 0 && !canAnalyze && (
          <p className="clarify-hint" role="status">
            Уточните: {session.missing.join(', ')}
          </p>
        )}

        <div className="messages" ref={messagesRef}>
          {messages.map((m, i) => (
            <div key={i} className={`bubble ${m.role}`}>
              {m.content}
            </div>
          ))}
          {busy && <TypingDots />}
          <div ref={bottomRef} />
        </div>

        <div className="dock">
          {offerDemo && !session.usedDemoData && (
            <div className="demo-banner">
              <p>Альтернатив пока нет — подставить демо-поставщиков?</p>
              <button type="button" disabled={busy} onClick={loadDemo}>
                Демо-поставщики
              </button>
            </div>
          )}

          {canAnalyze && (
            <button
              type="button"
              className="cta analyze"
              disabled={busy}
              onClick={analyze}
            >
              Запустить анализ
            </button>
          )}

          {(showExample || showDemoChip) && (
            <div className="quick">
              {showExample && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => send(EXAMPLE)}
                >
                  Пример про поставщика
                </button>
              )}
              {showDemoChip && !offerDemo && (
                <button type="button" disabled={busy} onClick={loadDemo}>
                  Демо-поставщики
                </button>
              )}
            </div>
          )}

          <form
            className="composer"
            onSubmit={(e) => {
              e.preventDefault();
              void send(draft);
            }}
          >
            <textarea
              ref={textareaRef}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="Опишите выбор…"
              rows={1}
              enterKeyHint="send"
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  void send(draft);
                }
              }}
            />
            <button
              className="send"
              type="submit"
              disabled={busy || !draft.trim()}
              aria-label="Отправить"
            >
              →
            </button>
          </form>
        </div>
      </div>
    </>
  );
}
