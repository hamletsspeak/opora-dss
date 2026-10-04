import { useEffect, useRef, useState, type ReactNode } from 'react';
import type {
  Alternative,
  ChatMessage,
  Criterion,
  Direction,
  Importance,
  SessionState,
} from '../shared/types';
import { emptySession } from '../shared/types';
import {
  extractMethodSlices,
  normalizeAnalysis,
  type FlexibleAnalysis,
} from './analysisCompat';

type Screen = 'hero' | 'chat' | 'results';

const COACH_KEY = 'klar-coach-dismissed';
const AUDIT_KEY = 'klar-audit-trail';

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

const IMPORTANCE_OPTS: { value: Importance; label: string }[] = [
  { value: 'high', label: 'важно' },
  { value: 'medium', label: 'средне' },
  { value: 'low', label: 'меньше' },
  { value: 'unknown', label: 'не знаю' },
];

type AuditRecord = {
  messages: ChatMessage[];
  session: SessionState;
  mcdmParams: Record<string, unknown>;
  ranking: FlexibleAnalysis['ranking'];
  explanation: string;
  ts: string;
  analysis?: FlexibleAnalysis;
};

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
    <div
      className="bubble assistant typing bubble-enter"
      aria-live="polite"
      aria-label="Klar печатает"
    >
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
  compact = false,
}: {
  leading?: ReactNode;
  trailing?: ReactNode;
  className?: string;
  /** Sheet / overlay: no safe-area top padding */
  compact?: boolean;
}) {
  return (
    <header
      className={`nav-bar nav-island-bar${compact ? ' nav-in-sheet' : ''} ${className}`.trim()}
      aria-label="Klar"
    >
      <div className="nav-side leading">{leading ?? <span className="nav-slot" />}</div>
      <div className="nav-island">
        <BrandMark size="sm" />
      </div>
      <div className="nav-side trailing">{trailing ?? <span className="nav-slot" />}</div>
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

function slugId(name: string, i: number): string {
  const base = name
    .toLowerCase()
    .replace(/[^a-zа-яё0-9]+/gi, '_')
    .replace(/^_|_$/g, '')
    .slice(0, 24);
  return base || `alt_${i + 1}`;
}

function parseScoreToken(tok: string): number | [number, number] | null {
  const t = tok.trim().replace(',', '.');
  if (!t) return null;
  const range = t.match(/^(-?\d+(?:\.\d+)?)\s*[-–—]\s*(-?\d+(?:\.\d+)?)$/);
  if (range) {
    const a = Number(range[1]);
    const b = Number(range[2]);
    if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
    return a <= b ? [a, b] : [b, a];
  }
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

/** Parse paste lines: `Name: c1, c2, …` (criteria order). */
function parseAlternativesPaste(
  text: string,
  criteria: Criterion[],
): { alternatives: Alternative[]; error?: string } {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  if (!lines.length) {
    return { alternatives: [], error: 'Вставьте хотя бы одну строку.' };
  }
  if (criteria.length < 1) {
    return {
      alternatives: [],
      error: 'Сначала нужны критерии — расскажите, что важно.',
    };
  }
  const alternatives: Alternative[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const m = line.match(/^(.+?)\s*[:：]\s*(.+)$/);
    if (!m) {
      return {
        alternatives: [],
        error: `Строка ${i + 1}: формат «Название: значение1, значение2, …»`,
      };
    }
    const name = m[1].trim();
    const parts = m[2].split(/[,;|]/).map((p) => p.trim()).filter(Boolean);
    if (parts.length !== criteria.length) {
      return {
        alternatives: [],
        error: `«${name}»: нужно ${criteria.length} значений (по числу критериев), сейчас ${parts.length}.`,
      };
    }
    const scores: Alternative['scores'] = {};
    for (let j = 0; j < criteria.length; j++) {
      const v = parseScoreToken(parts[j]);
      if (v == null) {
        return {
          alternatives: [],
          error: `«${name}»: не разобрал значение «${parts[j]}».`,
        };
      }
      scores[criteria[j].id] = v;
    }
    alternatives.push({ id: slugId(name, i), name, scores });
  }
  if (alternatives.length < 2) {
    return {
      alternatives: [],
      error: 'Нужны минимум два варианта для сравнения.',
    };
  }
  return { alternatives };
}

function matrixComplete(session: SessionState): boolean {
  if (session.criteria.length < 2 || session.alternatives.length < 2) {
    return false;
  }
  const ids = session.criteria.map((c) => c.id);
  return session.alternatives.every((a) =>
    ids.every((id) => a.scores[id] != null),
  );
}

function persistAudit(record: AuditRecord) {
  try {
    const prev = JSON.parse(localStorage.getItem(AUDIT_KEY) || '[]') as AuditRecord[];
    const next = [record, ...(Array.isArray(prev) ? prev : [])].slice(0, 20);
    localStorage.setItem(AUDIT_KEY, JSON.stringify(next));
  } catch {
    /* ignore quota */
  }
  void fetch('/api/audit', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(record),
  }).catch(() => {
    /* optional demo endpoint */
  });
}

function downloadJson(filename: string, data: unknown) {
  const blob = new Blob([JSON.stringify(data, null, 2)], {
    type: 'application/json',
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function WinRateChart({ ranking }: { ranking: FlexibleAnalysis['ranking'] }) {
  const max = Math.max(...ranking.map((r) => r.winRate), 0.01);
  return (
    <div className="win-chart" role="img" aria-label="Доля побед по вариантам">
      {ranking.map((r, i) => {
        const pct = r.winRate * 100;
        const h = Math.max(8, (r.winRate / max) * 100);
        return (
          <div key={r.alternativeId} className="win-col">
            <div className="win-col-track">
              <i
                className={i === 0 ? 'lead' : undefined}
                style={{ height: `${h}%` }}
                title={`${r.name}: ${pct.toFixed(0)}%`}
              />
            </div>
            <span className="win-col-pct caption">{pct.toFixed(0)}%</span>
            <span className="win-col-name caption">{r.name}</span>
          </div>
        );
      })}
    </div>
  );
}

function SensitivityViz({ analysis }: { analysis: FlexibleAnalysis }) {
  const leader = analysis.ranking[0];
  const runner = analysis.ranking[1];
  if (!leader) return null;
  const leadPct = Math.round(leader.winRate * 100);
  const runPct = runner ? Math.round(runner.winRate * 100) : 0;
  const stable = leader.winRate >= 0.55;
  return (
    <div className="sens-viz glass sheet" aria-label="Устойчивость лидера">
      <div className="sens-meter" aria-hidden>
        <i className="sens-fill" style={{ width: `${leadPct}%` }} />
        <i className="sens-mark" style={{ left: '55%' }} />
      </div>
      <p className="sens-caption caption">
        {stable
          ? `Лидер устойчив: ${leader.name} ≈${leadPct}% побед`
          : `Лидер спорный: ${leader.name} ≈${leadPct}%${
              runner ? `, рядом ${runner.name} ≈${runPct}%` : ''
            }`}
        <span className="sens-threshold"> · порог устойчивости 55%</span>
      </p>
    </div>
  );
}

function MethodCompare({ analysis }: { analysis: FlexibleAnalysis }) {
  const methods = extractMethodSlices(analysis);
  if (!methods.length) return null;
  const agree =
    analysis.agreement?.leaderMatchRate ??
    methods.find((m) => m.leaderMatchRate != null)?.leaderMatchRate;
  return (
    <div className="method-block reveal-stagger">
      <p className="section-label caption">
        Сравнение методов
        <TipHint
          label="Сравнение методов"
          text="Один и тот же набор симуляций прогнан разными правилами ранжирования. Совпадение лидера — признак устойчивости вывода."
        />
      </p>
      {agree != null && Number.isFinite(agree) && (
        <p className="caption method-agree">
          Совпадение лидера между методами: {(Number(agree) * 100).toFixed(0)}%
        </p>
      )}
      <div className="method-grid">
        {methods.map((m) => {
          const top = m.ranking[0];
          return (
            <div key={m.method} className="method-card">
              <p className="method-name caption">{m.method}</p>
              <p className="method-leader body">
                {top ? top.name : '—'}
                {top ? (
                  <span className="caption">
                    {' '}
                    · {(top.winRate * 100).toFixed(0)}%
                  </span>
                ) : null}
              </p>
              <ol className="method-mini">
                {m.ranking.slice(0, 4).map((r, i) => (
                  <li key={r.alternativeId}>
                    <span>{i + 1}.</span> {r.name}
                  </li>
                ))}
              </ol>
            </div>
          );
        })}
      </div>
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
  const [analysis, setAnalysis] = useState<FlexibleAnalysis | null>(null);
  const [explanation, setExplanation] = useState('');
  const [lastAudit, setLastAudit] = useState<AuditRecord | null>(null);
  const [sessionConfirmed, setSessionConfirmed] = useState(false);
  const [altPaste, setAltPaste] = useState('');
  const [altError, setAltError] = useState('');
  const [altOpen, setAltOpen] = useState(false);
  const [coachOpen, setCoachOpen] = useState(false);
  const [coachStep, setCoachStep] = useState(0);
  const [introReady, setIntroReady] = useState(false);
  /** Auto-coach once per welcome visit (QA: no reopen after dismiss) */
  const [coachAutoShown, setCoachAutoShown] = useState(false);
  /** Bumps on home reset so welcome remounts with current layout/animations */
  const [welcomeKey, setWelcomeKey] = useState(0);
  const bottomRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const coachSheetRef = useRef<HTMLDivElement>(null);
  const coachRestoreFocus = useRef<HTMLElement | null>(null);

  const hasUserMessage = messages.some((m) => m.role === 'user');
  const showExample = !hasUserMessage && !session.usedDemoData;
  const showDemoChip =
    !session.usedDemoData &&
    (offerDemo || session.criteria.length >= 2) &&
    !canAnalyze;
  const showSessionMeta =
    session.criteria.length > 0 || session.alternatives.length > 0;
  const showAltHelper = session.criteria.length >= 2 && (altOpen || !canAnalyze || offerDemo);

  useEffect(() => {
    if (screen !== 'chat') return;
    bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [messages, busy, screen, offerDemo, canAnalyze, sessionConfirmed]);

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
    if (coachAutoShown) return;
    const t = window.setTimeout(() => {
      setCoachOpen(true);
      setCoachAutoShown(true);
    }, 380);
    return () => window.clearTimeout(t);
  }, [screen, introReady, coachAutoShown]);

  useEffect(() => {
    if (!coachOpen) return;
    coachRestoreFocus.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    const sheet = coachSheetRef.current;
    const focusables = () =>
      sheet
        ? Array.from(
            sheet.querySelectorAll<HTMLElement>(
              'button, [href], input, textarea, select, [tabindex]:not([tabindex="-1"])',
            ),
          ).filter((el) => !el.hasAttribute('disabled'))
        : [];
    const list = focusables();
    list[0]?.focus();

    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.preventDefault();
        dismissCoach(false);
        return;
      }
      if (e.key !== 'Tab' || !sheet) return;
      const items = focusables();
      if (items.length === 0) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      coachRestoreFocus.current?.focus?.();
    };
  }, [coachOpen]);

  function dismissCoach(forever: boolean) {
    setCoachOpen(false);
    setCoachStep(0);
    setCoachAutoShown(true);
    if (forever) {
      try {
        localStorage.setItem(COACH_KEY, '1');
      } catch {
        /* ignore */
      }
    }
  }

  function patchCriterion(id: string, patch: Partial<Criterion>) {
    setSession((s) => ({
      ...s,
      criteria: s.criteria.map((c) => (c.id === id ? { ...c, ...patch } : c)),
    }));
    setSessionConfirmed(false);
  }

  function applyOwnAlternatives() {
    const parsed = parseAlternativesPaste(altPaste, session.criteria);
    if (parsed.error) {
      setAltError(parsed.error);
      return;
    }
    setAltError('');
    setSession((s) => ({
      ...s,
      alternatives: parsed.alternatives,
      usedDemoData: false,
      missing: s.missing.filter(
        (m) =>
          !m.toLowerCase().includes('альтернатив') &&
          !m.toLowerCase().includes('вариант'),
      ),
      readyForAnalysis: matrixComplete({
        ...s,
        alternatives: parsed.alternatives,
      }),
    }));
    setCanAnalyze(
      matrixComplete({
        ...session,
        alternatives: parsed.alternatives,
      }),
    );
    setSessionConfirmed(false);
    setAltOpen(false);
    setMessages((m) => [
      ...m,
      {
        role: 'assistant',
        content: `Принял ваши варианты (${parsed.alternatives.map((a) => a.name).join(', ')}). Проверьте критерии ниже и подтвердите данные перед сравнением.`,
      },
    ]);
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
      setSessionConfirmed(false);
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
      setSessionConfirmed(false);
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
    if (!sessionConfirmed) return;
    setBusy(true);
    try {
      const data = await postJson<{
        analysis: unknown;
        explanation: string;
      }>('/api/analyze', { session });
      const normalized = normalizeAnalysis(data.analysis);
      if (!normalized) {
        throw new Error('Ответ анализа без ранжирования');
      }
      const mcdmParams: Record<string, unknown> = {
        ...(normalized.mcdmParams ?? {}),
        samples: normalized.samples,
        seed: normalized.mcdmParams?.seed ?? 42,
        weightMeans: normalized.weightMeans,
        engine: 'MCDM (Monte-Carlo / SMAA-lite + TOPSIS-like)',
      };
      const record: AuditRecord = {
        messages,
        session,
        mcdmParams,
        ranking: normalized.ranking,
        explanation: data.explanation ?? '',
        ts: new Date().toISOString(),
        analysis: normalized,
      };
      persistAudit(record);
      setLastAudit(record);
      setAnalysis(normalized);
      setExplanation(data.explanation ?? '');
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
    setMessages([]);
    setSession(emptySession());
    setAnalysis(null);
    setExplanation('');
    setLastAudit(null);
    setCanAnalyze(false);
    setSessionConfirmed(false);
    setAltPaste('');
    setAltError('');
    setAltOpen(false);
    setOfferDemo(false);
    setDraft('');
    setBusy(false);
    // QA blocker: never open coach immediately — wait for typewriter / useEffect
    setCoachOpen(false);
    setCoachStep(0);
    setCoachAutoShown(false);
    setIntroReady(false);
    setWelcomeKey((k) => k + 1);
    setScreen('hero');
  }

  const helpBtn = (
    <button
      type="button"
      className="nav-help"
      onClick={() => {
        setCoachStep(0);
        setCoachOpen(true);
        setCoachAutoShown(true);
      }}
      aria-label="Подсказки"
    >
      ?
    </button>
  );

  const homeBtn = (
    <button
      type="button"
      className="nav-home"
      onClick={resetAll}
      aria-label="На главную"
    >
      Домой
    </button>
  );

  const coachCard = coachOpen && (
    <div
      className="coach-scrim"
      role="dialog"
      aria-modal="true"
      aria-labelledby="coach-title"
    >
      <div
        className="coach-sheet glass sheet reveal-item d0"
        ref={coachSheetRef}
      >
        <AppHeader compact className="coach-header" />
        <p className="coach-kicker caption" id="coach-title">
          Как это работает
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
      <div className="ios-root" key={`welcome-${welcomeKey}`}>
        <Atmosphere />
        <div className="ios-shell hero-shell">
          <AppHeader className="reveal-item d0" leading={helpBtn} />
          <main className="hero-body">
            <div className="hero-copy">
              <Typewriter
                key={`tw-${welcomeKey}`}
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
            className="reveal-item d0"
            leading={
              <button
                type="button"
                className="nav-back"
                onClick={() => setScreen('chat')}
              >
                ‹ Диалог
              </button>
            }
            trailing={
              lastAudit ? (
                <button
                  type="button"
                  className="nav-export"
                  onClick={() =>
                    downloadJson(
                      `klar-audit-${lastAudit.ts.slice(0, 19).replace(/:/g, '')}.json`,
                      lastAudit,
                    )
                  }
                >
                  JSON
                </button>
              ) : null
            }
          />

          <div className="results-scroll">
            <h1 className="large-title compact reveal-item d1">Итог сравнения</h1>
            <p className="section-foot caption reveal-item d1">
              {contextLabel}
              {session.usedDemoData ? ' · демо-варианты' : ''}
            </p>

            <p className="mcdm-badge caption reveal-item d1" role="note">
              Цифры ниже — из робастного MCDM (Monte-Carlo), не из ответа LLM.
              Текст «простыми словами» — пояснение агента.
            </p>

            {leader && (
              <p className="leader-plain body reveal-item d2">
                Чаще всего выигрывает <strong>{leader.name}</strong> — примерно в{' '}
                {(leader.winRate * 100).toFixed(0)}% проверок. Это не «гарантия»,
                а насколько вариант устойчив, когда данные и важность чуть
                меняются.
              </p>
            )}

            <p className="section-label caption reveal-item d2">
              Как часто побеждает
              <TipHint
                label="Как часто побеждает"
                text="Мы много раз «переигрываем» сравнение со слегка разными цифрами. Процент — доля раз, когда вариант оказался лучшим."
              />
            </p>

            <div className="win-chart-wrap glass sheet reveal-item d3">
              <WinRateChart ranking={analysis.ranking} />
            </div>

            <ol className="inset-group rank-group glass sheet results-stagger">
              {analysis.ranking.map((r, i) => (
                <li
                  key={r.alternativeId}
                  className={i === 0 ? 'is-lead' : undefined}
                  style={{ animationDelay: `${0.08 + i * 0.07}s` }}
                >
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

            <p className="section-label caption reveal-item d4">Чувствительность</p>
            <div className="reveal-item d4">
              <SensitivityViz analysis={analysis} />
            </div>
            <p className="footnote body reveal-item d4">{analysis.sensitivityNote}</p>

            <MethodCompare analysis={analysis} />

            {explanation && (
              <>
                <p className="section-label caption reveal-item d4">
                  Простыми словами
                  <span className="llm-tag">LLM</span>
                </p>
                <p className="footnote explain body reveal-item d4">{explanation}</p>
              </>
            )}

            <div className="results-actions reveal-item d4">
              {lastAudit && (
                <button
                  type="button"
                  className="btn-secondary glass"
                  onClick={() =>
                    downloadJson(
                      `klar-audit-${lastAudit.ts.slice(0, 19).replace(/:/g, '')}.json`,
                      lastAudit,
                    )
                  }
                >
                  Скачать аудит (JSON)
                </button>
              )}
              <button
                type="button"
                className="btn-secondary glass"
                onClick={resetAll}
              >
                Новый выбор
              </button>
            </div>
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

  const criteriaHint = session.criteria.map((c) => c.name).join(', ');

  return (
    <div className="ios-root">
      <Atmosphere />
      <div className="ios-shell chat-shell">
        <AppHeader
          className="reveal-item d0"
          leading={helpBtn}
          trailing={
            <>
              {homeBtn}
              <span className={`status-chip${busy ? ' busy' : ''}`}>
                {busy ? 'Думаю…' : 'Agent'}
              </span>
            </>
          }
        />

        {showSessionMeta && (
          <div className="meta-strip reveal-item d1" aria-label="Что уже поняли">
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
          <p className="clarify reveal-item d1" role="status">
            Чтобы продолжить, расскажите ещё про: {missingFriendly}.
          </p>
        )}

        <div className="messages reveal-item d2" role="log" aria-live="polite">
          {messages.map((m, i) => (
            <div
              key={`${i}-${m.role}-${m.content.slice(0, 24)}`}
              className={`bubble ${m.role} bubble-enter`}
              style={{ animationDelay: `${Math.min(i, 8) * 0.04}s` }}
            >
              {m.content}
            </div>
          ))}
          {busy && <TypingDots />}
          <div ref={bottomRef} />
        </div>

        <footer className="composer-dock glass reveal-item d3">
          {offerDemo && !session.usedDemoData && (
            <div className="action-row glass sheet">
              <p className="body">Нет своих вариантов? Подставим демо.</p>
              <button type="button" disabled={busy} onClick={loadDemo}>
                Демо
              </button>
            </div>
          )}

          {showAltHelper && (
            <div className="alt-panel glass sheet">
              <div className="alt-panel-head">
                <p className="body">Свои варианты</p>
                <button
                  type="button"
                  className="alt-toggle"
                  onClick={() => setAltOpen((v) => !v)}
                >
                  {altOpen ? 'Скрыть' : 'Вставить'}
                </button>
              </div>
              {altOpen && (
                <>
                  <p className="caption alt-hint">
                    Строка на вариант: «Название: {criteriaHint || 'к1, к2, …'}».
                    Интервал — через дефис, например 450-500.
                  </p>
                  <textarea
                    className="alt-paste"
                    value={altPaste}
                    onChange={(e) => {
                      setAltPaste(e.target.value);
                      setAltError('');
                    }}
                    rows={4}
                    placeholder={`ООО Альфа: 480, 5, 1.5, 100\nИП Бета: 450-470, 8, 0.8, 200`}
                  />
                  {altError && (
                    <p className="alt-error caption" role="alert">
                      {altError}
                    </p>
                  )}
                  <button
                    type="button"
                    className="btn-secondary glass alt-apply"
                    disabled={busy || !altPaste.trim()}
                    onClick={applyOwnAlternatives}
                  >
                    Применить варианты
                  </button>
                </>
              )}
            </div>
          )}

          {canAnalyze && (
            <div className="session-review glass sheet" aria-label="Проверка данных">
              <div className="session-review-head">
                <p className="session-review-title body">Проверьте данные</p>
                <button
                  type="button"
                  className="alt-toggle"
                  onClick={() => setAltOpen(true)}
                >
                  Варианты
                </button>
              </div>
              <p className="caption session-review-foot">
                Критерии можно поправить перед сравнением. Цифры посчитает MCDM,
                не чат.
              </p>
              <ul className="crit-chips">
                {session.criteria.map((c) => (
                  <li key={c.id} className="crit-chip">
                    <input
                      className="crit-name"
                      value={c.name}
                      aria-label="Название критерия"
                      onChange={(e) =>
                        patchCriterion(c.id, { name: e.target.value })
                      }
                    />
                    <label className="crit-field">
                      <span className="caption">направление</span>
                      <select
                        value={c.direction}
                        onChange={(e) =>
                          patchCriterion(c.id, {
                            direction: e.target.value as Direction,
                          })
                        }
                      >
                        <option value="min">меньше лучше</option>
                        <option value="max">больше лучше</option>
                      </select>
                    </label>
                    <label className="crit-field">
                      <span className="caption">важность</span>
                      <select
                        value={c.importance}
                        onChange={(e) =>
                          patchCriterion(c.id, {
                            importance: e.target.value as Importance,
                          })
                        }
                      >
                        {IMPORTANCE_OPTS.map((o) => (
                          <option key={o.value} value={o.value}>
                            {o.label}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="crit-check">
                      <input
                        type="checkbox"
                        checked={Boolean(c.weightUncertain)}
                        onChange={(e) =>
                          patchCriterion(c.id, {
                            weightUncertain: e.target.checked,
                          })
                        }
                      />
                      <span className="caption">вес ±</span>
                    </label>
                  </li>
                ))}
              </ul>
              {!sessionConfirmed ? (
                <button
                  type="button"
                  className="btn-primary glass-cta dock-cta"
                  disabled={busy}
                  onClick={() => setSessionConfirmed(true)}
                >
                  Данные верны
                </button>
              ) : (
                <button
                  type="button"
                  className="btn-primary glass-cta dock-cta"
                  disabled={busy}
                  onClick={() => void analyze()}
                >
                  Сравнить варианты
                </button>
              )}
            </div>
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
              {session.criteria.length >= 2 && !altOpen && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => setAltOpen(true)}
                >
                  Свои варианты
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
