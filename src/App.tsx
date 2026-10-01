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
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Ошибка запроса');
  return data as T;
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

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, busy, screen]);

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
        // prior history only — current turn is `message`
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
    } catch {
      setMessages([
        ...nextMessages,
        {
          role: 'assistant',
          content:
            'Не удалось связаться с агентом. Проверьте сервер и OPENAI_API_KEY.',
        },
      ]);
    } finally {
      setBusy(false);
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

  if (screen === 'hero') {
    return (
      <>
        <div className="app-bg" aria-hidden />
        <div className="shell">
          <section className="hero">
            <h1 className="brand">Опора</h1>
            <p>
              Интеллектуальная СППР: LLM-агент собирает нечёткие критерии, робастный
              MCDM ранжирует варианты с учётом неопределённости.
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
              className="chip"
              onClick={() => setScreen('chat')}
              style={{ background: 'transparent' }}
            >
              ← к диалогу
            </button>
          </header>
          <h1>Ранжирование</h1>
          <p className="lead">
            {session.context || 'Решение'} · {analysis.samples} симуляций
            {session.usedDemoData ? ' · демо-данные' : ''}
          </p>
          <ol className="rank-list">
            {analysis.ranking.map((r, i) => (
              <li key={r.alternativeId} className="rank-item">
                <span className="n">{i + 1}</span>
                <div>
                  <div className="meta">
                    <span className="name">{r.name}</span>
                    <span className="pct">{(r.winRate * 100).toFixed(0)}% побед</span>
                  </div>
                  <div className="bar" title={`Ожидаемый балл ${r.expectedScore.toFixed(3)}`}>
                    <i style={{ width: `${Math.max(4, r.winRate * 100)}%` }} />
                  </div>
                  <div style={{ fontSize: '0.78rem', color: 'var(--muted)', marginTop: 4 }}>
                    ср. ранг {r.meanRank.toFixed(2)} · балл {r.expectedScore.toFixed(3)}
                  </div>
                </div>
              </li>
            ))}
          </ol>
          <p className="note">{analysis.sensitivityNote}</p>
          {explanation && (
            <p className="explain">{explanation}</p>
          )}
          <button
            type="button"
            className="cta secondary"
            onClick={() => {
              setScreen('hero');
              setMessages([]);
              setSession(emptySession());
              setAnalysis(null);
              setExplanation('');
              setCanAnalyze(false);
              setOfferDemo(false);
            }}
          >
            Новое решение
          </button>
        </div>
      </>
    );
  }

  return (
    <>
      <div className="app-bg" aria-hidden />
      <div className="shell" style={{ height: '100dvh' }}>
        <header className="topbar">
          <div className="logo">Опора</div>
          <span className="chip">{busy ? 'думаю…' : 'агент + MCDM'}</span>
        </header>

        {(session.criteria.length > 0 || session.alternatives.length > 0) && (
          <div className="session-strip" aria-label="Состояние сессии">
            {session.context && <span>Контекст: {session.context}</span>}
            {session.criteria.map((c) => (
              <span key={c.id}>
                {c.name}
                {c.importance === 'high' ? ' ★' : ''}
                {c.weightUncertain ? ' ±' : ''}
                {Array.isArray(c.valueHint)
                  ? ` [${c.valueHint[0]}–${c.valueHint[1]}]`
                  : ''}
              </span>
            ))}
            {session.alternatives.map((a) => (
              <span key={a.id}>{a.name}</span>
            ))}
          </div>
        )}

        <div className="messages">
          {messages.map((m, i) => (
            <div key={i} className={`bubble ${m.role}`}>
              {m.content}
            </div>
          ))}
          {busy && <div className="loading">Агент обрабатывает…</div>}
          <div ref={bottomRef} />
        </div>

        <div className="quick">
          <button type="button" disabled={busy} onClick={() => send(EXAMPLE)}>
            Пример про поставщика
          </button>
          {(offerDemo || session.criteria.length >= 2) && (
            <button type="button" disabled={busy} onClick={loadDemo}>
              Демо-поставщики
            </button>
          )}
          {canAnalyze && (
            <button type="button" disabled={busy} onClick={analyze}>
              Запустить анализ
            </button>
          )}
        </div>

        <form
          className="composer"
          onSubmit={(e) => {
            e.preventDefault();
            void send(draft);
          }}
        >
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="Опишите выбор…"
            rows={2}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                void send(draft);
              }
            }}
          />
          <button className="send" type="submit" disabled={busy || !draft.trim()} aria-label="Отправить">
            →
          </button>
        </form>
      </div>
    </>
  );
}
