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

/** Same-origin `/api/*` on Vercel (no absolute base URL needed). */
async function postJson<T>(url: string, body: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch {
    throw new Error('Нет ответа от /api — проверьте деплой serverless-функций.');
  }
  const text = await res.text();
  let data: { error?: string } | null = null;
  try {
    data = text ? (JSON.parse(text) as { error?: string }) : null;
  } catch {
    throw new Error(
      `API ${res.status}: ответ не JSON (функция упала при старте?).`,
    );
  }
  if (!res.ok) {
    throw new Error(data?.error || `Ошибка API (${res.status})`);
  }
  return data as T;
}

function Atmosphere() {
  return (
    <div className="aurora" aria-hidden>
      <i className="blob a" />
      <i className="blob b" />
      <i className="blob c" />
      <i className="mesh" />
    </div>
  );
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

  const hasUserMessage = messages.some((m) => m.role === 'user');
  const showExample = !hasUserMessage && !session.usedDemoData;
  const showDemoChip =
    !session.usedDemoData &&
    (offerDemo || session.criteria.length >= 2) &&
    !canAnalyze;
  const showSessionMeta =
    session.criteria.length > 0 || session.alternatives.length > 0;

  useEffect(() => {
    if (screen !== 'chat') return;
    bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [messages, busy, screen, offerDemo, canAnalyze]);

  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(Math.max(el.scrollHeight, 36), 112)}px`;
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
      const detail = e instanceof Error ? e.message : '';
      setMessages([
        ...nextMessages,
        {
          role: 'assistant',
          content: detail
            ? `Не удалось связаться с агентом: ${detail}`
            : 'Не удалось связаться с агентом. Проверьте /api/health и OPENAI_API_KEY на Vercel.',
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
    } catch {
      setMessages((m) => [
        ...m,
        { role: 'assistant', content: 'Не удалось загрузить демо.' },
      ]);
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
      <div className="ios-root">
        <Atmosphere />
        <div className="ios-shell hero-shell">
          <header className="nav-bar glass">
            <div className="nav-brand">Опора</div>
            <span className="nav-meta caption">СППР</span>
          </header>
          <main className="hero-body">
            <h1 className="large-title">Опора</h1>
            <p className="hero-sub body">
              Нечёткий выбор в диалоге — устойчивое ранжирование с учётом
              неопределённости.
            </p>
            <ul className="inset-group hero-group glass sheet">
              <li>
                <span className="row-label">Диалог с агентом</span>
                <span className="row-value caption">критерии и важность</span>
              </li>
              <li>
                <span className="row-label">Демо или свои варианты</span>
                <span className="row-value caption">альтернативы</span>
              </li>
              <li>
                <span className="row-label">Робастный MCDM</span>
                <span className="row-value caption">win rate</span>
              </li>
            </ul>
            <button type="button" className="btn-primary glass-cta" onClick={start}>
              Начать диалог
            </button>
          </main>
        </div>
      </div>
    );
  }

  if (screen === 'results' && analysis) {
    const contextLabel =
      session.context?.trim() ||
      (session.usedDemoData ? 'Выбор поставщика' : 'Решение');

    return (
      <div className="ios-root">
        <Atmosphere />
        <div className="ios-shell results-shell">
          <header className="nav-bar glass">
            <button
              type="button"
              className="nav-back"
              onClick={() => setScreen('chat')}
            >
              ‹ Диалог
            </button>
            <div className="nav-brand center">Опора</div>
            <span className="nav-meta spacer" aria-hidden />
          </header>

          <div className="results-scroll">
            <h1 className="large-title compact">Ранжирование</h1>
            <p className="section-foot caption">
              {contextLabel} · {analysis.samples} симуляций
              {session.usedDemoData ? ' · демо' : ''}
            </p>

            <ol className="inset-group rank-group glass sheet">
              {analysis.ranking.map((r, i) => (
                <li key={r.alternativeId} className={i === 0 ? 'is-lead' : undefined}>
                  <span className="rank-n">{i + 1}</span>
                  <div className="rank-body">
                    <div className="rank-top">
                      <span className="rank-name">{r.name}</span>
                      <span className="rank-pct caption">
                        {(r.winRate * 100).toFixed(0)}%
                      </span>
                    </div>
                    <div
                      className="rank-bar"
                      title={`балл ${r.expectedScore.toFixed(3)}`}
                    >
                      <i style={{ width: `${Math.max(3, r.winRate * 100)}%` }} />
                    </div>
                    <div className="rank-meta caption">
                      ср. ранг {r.meanRank.toFixed(2)} · балл{' '}
                      {r.expectedScore.toFixed(3)}
                    </div>
                  </div>
                </li>
              ))}
            </ol>

            <p className="footnote body">{analysis.sensitivityNote}</p>
            {explanation && (
              <>
                <p className="section-label caption">Пояснение</p>
                <p className="footnote explain body">{explanation}</p>
              </>
            )}

            <button type="button" className="btn-secondary glass" onClick={resetAll}>
              Новое решение
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="ios-root">
      <Atmosphere />
      <div className="ios-shell chat-shell">
        <header className="nav-bar glass">
          <div className="nav-brand">Опора</div>
          <span className={`nav-meta caption${busy ? ' busy' : ''}`}>
            {busy ? 'Думаю…' : 'Агент'}
          </span>
        </header>

        {showSessionMeta && (
          <div className="meta-strip" aria-label="Состояние сессии">
            {(session.context?.trim() ||
              (session.criteria.length > 0 ? 'Решение' : '')) && (
              <span>{session.context?.trim() || 'Решение'}</span>
            )}
            {session.criteria.map((c) => (
              <span key={c.id}>
                {c.name}
                {c.importance === 'high' ? ' ★' : ''}
                {c.weightUncertain ? ' ±' : ''}
                {Array.isArray(c.valueHint)
                  ? ` ${c.valueHint[0]}–${c.valueHint[1]}`
                  : ''}
              </span>
            ))}
            {session.alternatives.map((a) => (
              <span key={a.id}>{a.name}</span>
            ))}
          </div>
        )}

        {session.missing.length > 0 && !canAnalyze && (
          <p className="clarify" role="status">
            Уточните: {session.missing.join(', ')}
          </p>
        )}

        <div className="messages" role="log" aria-live="polite">
          {messages.map((m, i) => (
            <div key={i} className={`bubble ${m.role}`}>
              {m.content}
            </div>
          ))}
          {busy && <TypingDots />}
          <div ref={bottomRef} />
        </div>

        <footer className="composer-dock glass">
          {offerDemo && !session.usedDemoData && (
            <div className="action-row glass sheet">
              <p className="body">Подставить демо-поставщиков?</p>
              <button type="button" disabled={busy} onClick={loadDemo}>
                Демо
              </button>
            </div>
          )}

          {canAnalyze && (
            <button
              type="button"
              className="btn-primary glass-cta dock-cta"
              disabled={busy}
              onClick={analyze}
            >
              Запустить анализ
            </button>
          )}

          {(showExample || showDemoChip) && (
            <div className="quick-row">
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
              placeholder="Сообщение"
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
              ↑
            </button>
          </form>
        </footer>
      </div>
    </div>
  );
}
