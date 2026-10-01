import { useEffect, useRef, useState, type ReactNode } from 'react';
import type {
  ChatMessage,
  McdmResult,
  SessionState,
} from '../shared/types';
import { emptySession } from '../shared/types';

type Screen = 'hero' | 'chat' | 'results';

const COACH_KEY = 'klar-coach-dismissed';

const EXAMPLE =
  'Я выбираю поставщика. Есть цена, срок поставки, процент брака и минимальная партия. По цене точно сказать не могу — примерно 450–500 рублей. Цена и срок для меня наиболее важны, но насколько именно — не знаю.';

const COACH_TIPS = [
  {
    title: 'Расскажите о выборе',
    body: 'Что решаете и что для вас важно? Можно своими словами, без таблиц.',
  },
  {
    title: 'Неточность — нормально',
    body: '«Примерно», интервалы и «не уверен» — Klar это учитывает.',
  },
  {
    title: 'Сравним спокойно',
    body: 'Покажем, какой вариант чаще выигрывает, даже если данные размыты.',
  },
] as const;

const HERO_LINE =
  'Поможем выбрать спокойно, даже если цифры неточные и важность «на глаз».';

function BrandMark({ size = 'md' }: { size?: 'sm' | 'md' | 'lg' }) {
  return (
    <img
      src="/klar-logo.png"
      alt="Klar"
      className={`brand-mark brand-${size}`}
      draggable={false}
      decoding="async"
    />
  );
}

function Typewriter({
  text,
  className,
  onDone,
}: {
  text: string;
  className?: string;
  onDone?: () => void;
}) {
  const [n, setN] = useState(0);
  const [done, setDone] = useState(false);
  const onDoneRef = useRef(onDone);
  onDoneRef.current = onDone;

  useEffect(() => {
    const reduce =
      typeof window !== 'undefined' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduce) {
      setN(text.length);
      setDone(true);
      onDoneRef.current?.();
      return;
    }
    setN(0);
    setDone(false);
    let i = 0;
    const id = window.setInterval(() => {
      i += 1;
      setN(i);
      if (i >= text.length) {
        window.clearInterval(id);
        setDone(true);
        onDoneRef.current?.();
      }
    }, 26);
    return () => window.clearInterval(id);
  }, [text]);

  return (
    <p className={className} aria-label={text}>
      <span>{text.slice(0, n)}</span>
      <span className={`type-caret${done ? ' idle' : ''}`} aria-hidden />
    </p>
  );
}

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
    <div className="bubble assistant typing" aria-live="polite" aria-label="Klar печатает">
      <span className="dot" />
      <span className="dot" />
      <span className="dot" />
    </div>
  );
}

function TipHint({ label, text }: { label: string; text: string }) {
  return (
    <span className="tip-wrap">
      <button type="button" className="tip-btn" aria-label={`Подсказка: ${label}`}>
        ?
      </button>
      <span className="tip-bubble" role="tooltip">
        {text}
      </span>
    </span>
  );
}

function AppHeader({
  leading,
  trailing,
  className = '',
}: {
  leading?: ReactNode;
  trailing?: ReactNode;
  className?: string;
}) {
  return (
    <header className={`nav-bar nav-island-bar ${className}`.trim()} aria-label="Klar">
      <div className="nav-side leading">{leading}</div>
      <div className="nav-island glass">
        <BrandMark size="sm" />
      </div>
      <div className="nav-side trailing">{trailing ?? null}</div>
    </header>
  );
}

function readCoachDismissed(): boolean {
  try {
    return localStorage.getItem(COACH_KEY) === '1';
  } catch {
    return false;
  }
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
  const [coachOpen, setCoachOpen] = useState(false);
  const [coachStep, setCoachStep] = useState(0);
  const [introReady, setIntroReady] = useState(false);
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

  useEffect(() => {
    if (screen !== 'hero') return;
    if (readCoachDismissed()) return;
    if (!introReady) return;
    const t = window.setTimeout(() => setCoachOpen(true), 380);
    return () => window.clearTimeout(t);
  }, [screen, introReady]);

  function dismissCoach(forever: boolean) {
    setCoachOpen(false);
    setCoachStep(0);
    if (forever) {
      try {
        localStorage.setItem(COACH_KEY, '1');
      } catch {
        /* ignore */
      }
    }
  }

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
        { role: 'user', content: 'Подставить демо-варианты' },
        { role: 'assistant', content: data.reply },
      ]);
    } catch {
      setMessages((m) => [
        ...m,
        { role: 'assistant', content: 'Не удалось загрузить демо. Попробуйте ещё раз.' },
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
      const msg = e instanceof Error ? e.message : 'Не удалось сравнить варианты';
      setMessages((m) => [...m, { role: 'assistant', content: msg }]);
    } finally {
      setBusy(false);
    }
  }

  function start() {
    setCoachOpen(false);
    setScreen('chat');
    setMessages([
      {
        role: 'assistant',
        content:
          'Расскажите о выборе своими словами: что важно, какие есть варианты. Можно «примерно» и с интервалами — так даже удобнее.',
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
    setIntroReady(false);
    if (!readCoachDismissed()) setCoachOpen(true);
  }

  const coachCard = coachOpen && (
    <div className="coach-scrim" role="dialog" aria-modal="true" aria-labelledby="coach-title">
      <div className="coach-sheet glass sheet">
        <p className="coach-kicker caption" id="coach-title">
          Как устроен Klar
        </p>
        <div className="coach-steps" aria-hidden>
          {COACH_TIPS.map((_, i) => (
            <i key={i} className={i === coachStep ? 'on' : undefined} />
          ))}
        </div>
        <h2 className="coach-title">{COACH_TIPS[coachStep].title}</h2>
        <p className="coach-body body">{COACH_TIPS[coachStep].body}</p>
        <div className="coach-actions">
          {coachStep < COACH_TIPS.length - 1 ? (
            <button
              type="button"
              className="btn-primary glass-cta"
              onClick={() => setCoachStep((s) => s + 1)}
            >
              Дальше
            </button>
          ) : (
            <button
              type="button"
              className="btn-primary glass-cta"
              onClick={() => dismissCoach(false)}
            >
              Понятно
            </button>
          )}
          <button
            type="button"
            className="coach-link"
            onClick={() => dismissCoach(true)}
          >
            Больше не показывать
          </button>
          <button
            type="button"
            className="coach-link subtle"
            onClick={() => dismissCoach(false)}
          >
            Закрыть
          </button>
        </div>
      </div>
    </div>
  );

  if (screen === 'hero') {
    return (
      <div className="ios-root">
        <Atmosphere />
        <div className="ios-shell hero-shell">
          <AppHeader
            className="reveal-item d0"
            leading={
              <button
                type="button"
                className="nav-help"
                onClick={() => {
                  setCoachStep(0);
                  setCoachOpen(true);
                }}
                aria-label="Как пользоваться"
              >
                ?
              </button>
            }
          />
          <main className="hero-body">
            <div className="hero-copy">
              <Typewriter
                text={HERO_LINE}
                className="hero-sub body reveal-item d1"
                onDone={() => setIntroReady(true)}
              />
            </div>
            <div className="hero-bottom">
              <ol className="inset-group hero-group glass sheet steps-list reveal-item d2">
                <li>
                  <span className="step-n">1</span>
                  <span className="row-label">Расскажите о выборе</span>
                </li>
                <li>
                  <span className="step-n">2</span>
                  <span className="row-label">Добавьте варианты</span>
                </li>
                <li>
                  <span className="step-n">3</span>
                  <span className="row-label">Сравним устойчиво</span>
                </li>
              </ol>
              <button
                type="button"
                className="btn-primary glass-cta reveal-item d3"
                onClick={start}
              >
                Начать
              </button>
            </div>
          </main>
        </div>
        {coachCard}
      </div>
    );
  }

  if (screen === 'results' && analysis) {
    const contextLabel =
      session.context?.trim() ||
      (session.usedDemoData ? 'Выбор поставщика' : 'Ваш выбор');
    const leader = analysis.ranking[0];

    return (
      <div className="ios-root">
        <Atmosphere />
        <div className="ios-shell results-shell">
          <AppHeader
            leading={
              <button
                type="button"
                className="nav-back"
                onClick={() => setScreen('chat')}
              >
                ‹ Диалог
              </button>
            }
          />

          <div className="results-scroll">
            <h1 className="large-title compact">Итог сравнения</h1>
            <p className="section-foot caption">
              {contextLabel}
              {session.usedDemoData ? ' · демо-варианты' : ''}
            </p>

            {leader && (
              <p className="leader-plain body">
                Чаще всего выигрывает <strong>{leader.name}</strong> — примерно в{' '}
                {(leader.winRate * 100).toFixed(0)}% проверок. Это не «гарантия»,
                а насколько вариант устойчив, когда данные и важность чуть
                меняются.
              </p>
            )}

            <p className="section-label caption">
              Как часто побеждает
              <TipHint
                label="Как часто побеждает"
                text="Мы много раз «переигрываем» сравнение со слегка разными цифрами. Процент — доля раз, когда вариант оказался лучшим."
              />
            </p>

            <ol className="inset-group rank-group glass sheet">
              {analysis.ranking.map((r, i) => (
                <li key={r.alternativeId} className={i === 0 ? 'is-lead' : undefined}>
                  <span className="rank-n">{i + 1}</span>
                  <div className="rank-body">
                    <div className="rank-top">
                      <span className="rank-name">{r.name}</span>
                      <span className="rank-pct caption">
                        {(r.winRate * 100).toFixed(0)}% раз
                      </span>
                    </div>
                    <div
                      className="rank-bar"
                      title={`Обычный балл ${r.expectedScore.toFixed(3)}`}
                    >
                      <i style={{ width: `${Math.max(3, r.winRate * 100)}%` }} />
                    </div>
                    <div className="rank-meta caption">
                      обычно на месте ≈{r.meanRank.toFixed(1)}
                    </div>
                  </div>
                </li>
              ))}
            </ol>

            <p className="footnote body">{analysis.sensitivityNote}</p>
            {explanation && (
              <>
                <p className="section-label caption">Простыми словами</p>
                <p className="footnote explain body">{explanation}</p>
              </>
            )}

            <button type="button" className="btn-secondary glass" onClick={resetAll}>
              Новый выбор
            </button>
          </div>
        </div>
      </div>
    );
  }

  const missingFriendly = session.missing
    .map((m) => {
      const low = m.toLowerCase();
      if (low.includes('альтернатив') || low.includes('вариант')) return 'варианты на выбор';
      if (low.includes('критер')) return 'что для вас важно';
      if (low.includes('вес') || low.includes('важност')) return 'насколько важно каждое условие';
      return m;
    })
    .join(', ');

  return (
    <div className="ios-root">
      <Atmosphere />
      <div className="ios-shell chat-shell">
        <AppHeader
          leading={
            <button
              type="button"
              className="nav-help"
              onClick={() => {
                setCoachStep(0);
                setCoachOpen(true);
              }}
              aria-label="Подсказки"
            >
              ?
            </button>
          }
          trailing={
            <span className={`status-chip${busy ? ' busy' : ''}`}>
              {busy ? 'Думаю…' : 'Agent'}
            </span>
          }
        />

        {showSessionMeta && (
          <div className="meta-strip" aria-label="Что уже поняли">
            {(session.context?.trim() ||
              (session.criteria.length > 0 ? 'Ваш выбор' : '')) && (
              <span>{session.context?.trim() || 'Ваш выбор'}</span>
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
            Чтобы продолжить, расскажите ещё про: {missingFriendly}.
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
              <p className="body">Нет своих вариантов? Подставим демо.</p>
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
              Сравнить варианты
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
                  Пример: поставщик
                </button>
              )}
              {showDemoChip && !offerDemo && (
                <button type="button" disabled={busy} onClick={loadDemo}>
                  Демо-варианты
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
              placeholder="Опишите выбор своими словами…"
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
      {coachCard}
    </div>
  );
}
