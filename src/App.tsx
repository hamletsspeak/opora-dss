import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type {
  Alternative,
  ChatMessage,
  Criterion,
  Direction,
  Importance,
  SessionState,
} from "../shared/types";
import { emptySession } from "../shared/types";
import { ProductShell } from "./components/ProductShell";
import { InterfaceIcon } from "./components/InterfaceIcon";
import {
  extractMethodSlices,
  normalizeAnalysis,
  type FlexibleAnalysis,
} from "./analysisCompat";

type Screen = "setup" | "chat" | "results";

const AUDIT_KEY = "klar-audit-trail";

const EXAMPLE =
  "Я выбираю поставщика. Есть цена, срок поставки, процент брака и минимальная партия. По цене точно сказать не могу — примерно 450–500 рублей. Цена и срок для меня наиболее важны, но насколько именно — не знаю.";

const COACH_TIPS = [
  {
    title: "Расскажите о выборе",
    body: "Что решаете и что для вас важно? Можно своими словами, без таблиц.",
  },
  {
    title: "Неточность — нормально",
    body: "«Примерно», интервалы и «не уверен» — Klar это учитывает.",
  },
  {
    title: "Сравним спокойно",
    body: "Покажем, какой вариант чаще выигрывает, даже если данные размыты.",
  },
] as const;

const TEMPLATES = [
  {
    icon: "box",
    title: "Выбрать поставщика",
    description: "Цена, сроки и качество",
    text: EXAMPLE,
  },
  {
    icon: "briefcase",
    title: "Сравнить предложения",
    description: "Работа и новые возможности",
    text: "Хочу сравнить предложения о работе. Для меня важны зарплата, интересные задачи, возможность работать удалённо и время на дорогу. Помоги определить критерии — затем добавлю предложения.",
  },
  {
    icon: "laptop",
    title: "Подобрать технику",
    description: "Бюджет и характеристики",
    text: "Выбираю ноутбук для работы. Важны цена, производительность, вес и время работы от батареи. Помоги структурировать выбор — модели и их характеристики добавлю сам.",
  },
] as const;

const IMPORTANCE_OPTS: { value: Importance; label: string }[] = [
  { value: "high", label: "важно" },
  { value: "medium", label: "средне" },
  { value: "low", label: "меньше" },
  { value: "unknown", label: "не знаю" },
];

const WIDE_QUERY = "(width > 1375px)";
const FINE_POINTER_QUERY = "(hover: hover) and (pointer: fine)";

function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const mql = window.matchMedia(query);
      mql.addEventListener("change", onChange);
      return () => mql.removeEventListener("change", onChange);
    },
    () => window.matchMedia(query).matches,
    () => false,
  );
}

type AuditRecord = {
  messages: ChatMessage[];
  session: SessionState;
  mcdmParams: Record<string, unknown>;
  ranking: FlexibleAnalysis["ranking"];
  explanation: string;
  ts: string;
  analysis?: FlexibleAnalysis;
};

/** Same-origin `/api/*` on Vercel (no absolute base URL needed). */
async function postJson<T>(url: string, body: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch {
    throw new Error(
      "Нет ответа от /api — проверьте деплой serverless-функций.",
    );
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
      <button
        type="button"
        className="tip-btn"
        aria-label={`Подсказка: ${label}`}
      >
        ?
      </button>
      <span className="tip-bubble" role="tooltip">
        {text}
      </span>
    </span>
  );
}

function slugId(name: string, i: number): string {
  const base = name
    .toLowerCase()
    .replace(/[^a-zа-яё0-9]+/gi, "_")
    .replace(/^_|_$/g, "")
    .slice(0, 24);
  return base || `alt_${i + 1}`;
}

function parseScoreToken(tok: string): number | [number, number] | null {
  const t = tok.trim().replace(",", ".");
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
    return { alternatives: [], error: "Вставьте хотя бы одну строку." };
  }
  if (criteria.length < 1) {
    return {
      alternatives: [],
      error: "Сначала нужны критерии — расскажите, что важно.",
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
    const parts = m[2]
      .split(/[,;|]/)
      .map((p) => p.trim())
      .filter(Boolean);
    if (parts.length !== criteria.length) {
      return {
        alternatives: [],
        error: `«${name}»: нужно ${criteria.length} значений (по числу критериев), сейчас ${parts.length}.`,
      };
    }
    const scores: Alternative["scores"] = {};
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
      error: "Нужны минимум два варианта для сравнения.",
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
    const prev = JSON.parse(
      localStorage.getItem(AUDIT_KEY) || "[]",
    ) as AuditRecord[];
    const next = [record, ...(Array.isArray(prev) ? prev : [])].slice(0, 20);
    localStorage.setItem(AUDIT_KEY, JSON.stringify(next));
  } catch {
    /* ignore quota */
  }
  void fetch("/api/audit", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(record),
  }).catch(() => {
    /* optional demo endpoint */
  });
}

function downloadJson(filename: string, data: unknown) {
  const blob = new Blob([JSON.stringify(data, null, 2)], {
    type: "application/json",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoking synchronously can cancel the download in Firefox/Safari.
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function downloadAudit(record: AuditRecord) {
  downloadJson(
    `klar-audit-${record.ts.slice(0, 19).replace(/:/g, "")}.json`,
    record,
  );
}

function WinRateChart({ ranking }: { ranking: FlexibleAnalysis["ranking"] }) {
  return (
    <div className="win-chart" role="img" aria-label="Доля побед по вариантам">
      {ranking.map((r, i) => {
        const pct = r.winRate * 100;
        const h = Math.max(0, Math.min(100, pct));
        return (
          <div key={r.alternativeId} className="win-col">
            <div className="win-col-track">
              <i
                className={i === 0 ? "lead" : undefined}
                style={{ height: `${h}%` }}
                title={`${r.name}: ${pct.toFixed(0)}%`}
              />
            </div>
            <span className="win-col-pct caption">{pct.toFixed(0)}%</span>
            <span className="win-col-name caption" title={r.name}>
              {r.name}
            </span>
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
  const leadPct = Math.round(leader.pBest * 100);
  const runPct = runner ? Math.round(runner.pBest * 100) : 0;
  return (
    <div className="sens-viz glass sheet" aria-label="Устойчивость лидера">
      <div className="sens-meter" aria-hidden>
        <i className="sens-fill" style={{ width: `${leadPct}%` }} />
      </div>
      <p className="sens-caption caption">
        {`${leader.name} занимает первое место в ${leadPct}% симуляций.${runner ? ` ${runner.name} — в ${runPct}%.` : ""}`}
      </p>
      {analysis.sensitivity?.critical?.length ? (
        <ul className="caption">
          {analysis.sensitivity.critical.map((c, i) => (
            <li key={i}>
              {c.label}: {c.base_value.toPrecision(4)} →{" "}
              {c.flip_at?.toPrecision(4) ?? "нет границы"}; новый лидер:{" "}
              {c.new_leader_names.join(", ")}
            </li>
          ))}
        </ul>
      ) : (
        <p className="caption">
          Границы смены лидера для этого результата не найдены или не
          рассчитаны.
        </p>
      )}
      <a href="/lab#sensitivity">Исследовать параметры в Лаборатории →</a>
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
    <div className="method-block">
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
                {top ? top.name : "—"}
                {top ? (
                  <span className="caption">
                    {" "}
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
  const [screen, setScreen] = useState<Screen>("setup");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [session, setSession] = useState<SessionState>(emptySession());
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [offerDemo, setOfferDemo] = useState(false);
  const [canAnalyze, setCanAnalyze] = useState(false);
  const [analysis, setAnalysis] = useState<FlexibleAnalysis | null>(null);
  const [explanation, setExplanation] = useState("");
  const [explanationMeta, setExplanationMeta] = useState<{
    source: "llm" | "deterministic";
    provider_notice?: string;
    rejected?: { reason: string } | null;
  } | null>(null);
  const [lastAudit, setLastAudit] = useState<AuditRecord | null>(null);
  const [sessionConfirmed, setSessionConfirmed] = useState(false);
  const [altPaste, setAltPaste] = useState("");
  const [altError, setAltError] = useState("");
  const [altOpen, setAltOpen] = useState(false);
  const [coachOpen, setCoachOpen] = useState(false);
  const [coachStep, setCoachStep] = useState(0);
  const [taskOpen, setTaskOpen] = useState(false);
  const wide = useMediaQuery(WIDE_QUERY);
  const finePointer = useMediaQuery(FINE_POINTER_QUERY);
  const messagesRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const coachSheetRef = useRef<HTMLDivElement>(null);
  const coachRestoreFocus = useRef<HTMLElement | null>(null);

  const hasUserMessage = messages.some((m) => m.role === "user");
  const showDemoChip =
    !session.usedDemoData &&
    (offerDemo || session.criteria.length >= 2) &&
    !canAnalyze;
  const showSessionMeta =
    session.criteria.length > 0 || session.alternatives.length > 0;
  const showAltHelper =
    session.criteria.length >= 2 && (altOpen || !canAnalyze || offerDemo);

  useEffect(() => {
    if (screen !== "chat") return;
    // scrollIntoView would also scroll overflow-hidden ancestors and shift the layout
    const el = messagesRef.current;
    el?.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }, [messages, busy, screen, offerDemo, canAnalyze, sessionConfirmed, wide]);

  useEffect(() => {
    if (screen !== "chat" || !finePointer) return;
    textareaRef.current?.focus({ preventScroll: true });
  }, [screen, finePointer]);

  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    const scale =
      parseFloat(getComputedStyle(document.documentElement).fontSize) / 16;
    el.style.height = "auto";
    el.style.height = `${Math.min(Math.max(el.scrollHeight, 36 * scale), 112 * scale)}px`;
  }, [draft]);

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
          ).filter((el) => !el.hasAttribute("disabled"))
        : [];
    const list = focusables();
    list[0]?.focus();

    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        dismissCoach();
        return;
      }
      if (e.key !== "Tab" || !sheet) return;
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
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      coachRestoreFocus.current?.focus?.();
    };
  }, [coachOpen]);

  function dismissCoach() {
    setCoachOpen(false);
    setCoachStep(0);
  }

  function openHelp() {
    setCoachStep(0);
    setCoachOpen(true);
  }

  function invalidateResults() {
    setAnalysis(null);
    setExplanation("");
    setLastAudit(null);
  }

  function patchCriterion(id: string, patch: Partial<Criterion>) {
    invalidateResults();
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
    setAltError("");
    invalidateResults();
    setSession((s) => ({
      ...s,
      alternatives: parsed.alternatives,
      usedDemoData: false,
      missing: s.missing.filter(
        (m) =>
          !m.toLowerCase().includes("альтернатив") &&
          !m.toLowerCase().includes("вариант"),
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
        role: "assistant",
        content: `Принял ваши варианты (${parsed.alternatives.map((a) => a.name).join(", ")}). Проверьте критерии ниже и подтвердите данные перед сравнением.`,
      },
    ]);
  }

  async function send(text: string) {
    const trimmed = text.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    setScreen("chat");
    setTaskOpen(false);
    setDraft("");
    const nextMessages = [
      ...messages,
      { role: "user" as const, content: trimmed },
    ];
    setMessages(nextMessages);
    try {
      const data = await postJson<{
        reply: string;
        session: SessionState;
        offerDemo: boolean;
        canAnalyze: boolean;
      }>("/api/chat", {
        message: trimmed,
        // prior history only — current turn is `message` (QA: avoid duplicate user turn)
        messages,
        session,
      });
      invalidateResults();
      setSession(data.session);
      setOfferDemo(data.offerDemo);
      setCanAnalyze(data.canAnalyze);
      setSessionConfirmed(false);
      setMessages([
        ...nextMessages,
        { role: "assistant", content: data.reply },
      ]);
    } catch (e) {
      const detail = e instanceof Error ? e.message : "";
      setMessages([
        ...nextMessages,
        {
          role: "assistant",
          content: detail
            ? `Не удалось связаться с агентом: ${detail}`
            : "Не удалось связаться с агентом. Проверьте /api/health и OPENAI_API_KEY на Vercel.",
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
      }>("/api/demo", { session });
      invalidateResults();
      setSession(data.session);
      setCanAnalyze(data.canAnalyze);
      setOfferDemo(false);
      setSessionConfirmed(false);
      setMessages((m) => [
        ...m,
        { role: "user", content: "Подставить демо-варианты" },
        { role: "assistant", content: data.reply },
      ]);
    } catch {
      setMessages((m) => [
        ...m,
        {
          role: "assistant",
          content: "Не удалось загрузить демо. Попробуйте ещё раз.",
        },
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
        explanation_meta?: {
          source: "llm" | "deterministic";
          provider_notice?: string;
          rejected?: { reason: string } | null;
        };
      }>("/api/analyze", { session });
      const normalized = normalizeAnalysis(data.analysis);
      if (!normalized) {
        throw new Error("Ответ анализа без ранжирования");
      }
      const mcdmParams: Record<string, unknown> = {
        ...(normalized.mcdmParams ?? {}),
        samples: normalized.samples,
        seed: normalized.mcdmParams?.seed ?? 42,
        weightMeans: normalized.weightMeans,
        engine: "MCDM (Monte-Carlo / SMAA-lite + TOPSIS-like)",
      };
      const record: AuditRecord = {
        messages,
        session,
        mcdmParams,
        ranking: normalized.ranking,
        explanation: data.explanation ?? "",
        ts: new Date().toISOString(),
        analysis: normalized,
      };
      persistAudit(record);
      setLastAudit(record);
      setAnalysis(normalized);
      setExplanation(data.explanation ?? "");
      setExplanationMeta(data.explanation_meta ?? null);
      setScreen("results");
    } catch (e) {
      const msg =
        e instanceof Error ? e.message : "Не удалось сравнить варианты";
      setMessages((m) => [...m, { role: "assistant", content: msg }]);
      setTaskOpen(false);
    } finally {
      setBusy(false);
    }
  }

  function resetAll() {
    setMessages([]);
    setSession(emptySession());
    setAnalysis(null);
    setExplanation("");
    setLastAudit(null);
    setCanAnalyze(false);
    setSessionConfirmed(false);
    setAltPaste("");
    setAltError("");
    setAltOpen(false);
    setOfferDemo(false);
    setDraft("");
    setBusy(false);
    setCoachOpen(false);
    setCoachStep(0);
    setTaskOpen(false);
    setScreen("setup");
  }

  const coachCard = coachOpen && (
    <div
      className="coach-scrim"
      role="dialog"
      aria-modal="true"
      aria-labelledby="coach-title"
      onClick={(e) => {
        if (e.target === e.currentTarget) dismissCoach();
      }}
    >
      <div className="coach-sheet glass sheet" ref={coachSheetRef}>
        <div className="coach-heading">
          <span className="assistant-emblem">
            <InterfaceIcon name="spark" />
          </span>
          <button
            type="button"
            className="icon-button"
            onClick={dismissCoach}
            aria-label="Закрыть подсказки"
          >
            <InterfaceIcon name="close" />
          </button>
        </div>
        <p className="coach-kicker caption" id="coach-title">
          Как это работает
        </p>
        <div className="coach-steps" aria-hidden>
          {COACH_TIPS.map((_, i) => (
            <i key={i} className={i === coachStep ? "on" : undefined} />
          ))}
        </div>
        <h2 className="coach-title">{COACH_TIPS[coachStep].title}</h2>
        <p className="coach-body body">{COACH_TIPS[coachStep].body}</p>
        <div className="coach-actions">
          {coachStep < COACH_TIPS.length - 1 ? (
            <button
              type="button"
              className="btn-primary"
              onClick={() => setCoachStep((s) => s + 1)}
            >
              Дальше
            </button>
          ) : (
            <button
              type="button"
              className="btn-primary"
              onClick={() => dismissCoach()}
            >
              Понятно
            </button>
          )}
          <button
            type="button"
            className="coach-link subtle"
            onClick={() => dismissCoach()}
          >
            Закрыть
          </button>
        </div>
      </div>
    </div>
  );

  const shellProps = {
    stage:
      screen === "results"
        ? ("results" as const)
        : hasUserMessage
          ? ("chat" as const)
          : ("setup" as const),
    title:
      screen === "results"
        ? "Результаты"
        : hasUserMessage
          ? "Диалог"
          : "Новое решение",
    onNew: resetAll,
    onChat: hasUserMessage
      ? () => {
          setTaskOpen(false);
          setScreen("chat");
        }
      : undefined,
    onResults: busy ? undefined : () => setScreen("results"),
    hasResults: analysis !== null,
    onHelp: openHelp,
    busy,
  };

  if (screen === "results" && analysis) {
    const contextLabel =
      session.context?.trim() ||
      (session.usedDemoData ? "Выбор поставщика" : "Ваш выбор");
    const leader = analysis.ranking[0];

    return (
      <ProductShell {...shellProps}>
        <main className="results-scroll">
          <div className="results-inner">
            <div className="results-head">
              <p className="eyebrow">РЕЗУЛЬТАТЫ СРАВНЕНИЯ</p>
              <h1 className="large-title compact">Итог сравнения</h1>
              <p className="section-foot caption">
                {contextLabel}
                {session.usedDemoData ? " · демо-варианты" : ""}
              </p>
              <p className="mcdm-badge caption" role="note">
                Результат рассчитан по вашим критериям с учётом
                неопределённости. Частота побед показывает, насколько устойчив
                выбор.
              </p>
            </div>

            <div className="result-metrics">
              <div className="result-leader">
                <span className="result-leader-icon">
                  <InterfaceIcon name="check" size={24} />
                </span>
                <div>
                  <p className="caption">Лидер сравнения</p>
                  <h2>{leader?.name ?? "—"}</h2>
                </div>
                <span className="leader-percent">
                  {((leader?.winRate ?? 0) * 100).toFixed(0)}%
                  <small>побед в симуляциях</small>
                </span>
              </div>
              <div className="result-stat">
                <span>Альтернативы</span>
                <strong>{analysis.ranking.length}</strong>
              </div>
              <div className="result-stat">
                <span>Критерии</span>
                <strong>{session.criteria.length}</strong>
              </div>
              <div className="result-stat">
                <span>Симуляции</span>
                <strong>{analysis.samples.toLocaleString("ru-RU")}</strong>
              </div>
            </div>
            <div className="results-grid">
              <section className="results-col" aria-label="Рейтинг вариантов">
                <p className="section-label caption">
                  Как часто побеждает
                  <TipHint
                    label="Как часто побеждает"
                    text="Мы много раз «переигрываем» сравнение со слегка разными цифрами. Процент — доля раз, когда вариант оказался лучшим."
                  />
                </p>

                <div className="win-chart-wrap glass sheet">
                  <WinRateChart ranking={analysis.ranking} />
                </div>

                <ol className="inset-group rank-group glass sheet">
                  {analysis.ranking.map((r, i) => (
                    <li
                      key={r.alternativeId}
                      className={i === 0 ? "is-lead" : undefined}
                    >
                      <span className="rank-n">{i + 1}</span>
                      <div className="rank-body">
                        <div className="rank-top">
                          <span className="rank-name" title={r.name}>
                            {r.name}
                          </span>
                          <span className="rank-pct caption">
                            {(r.winRate * 100).toFixed(0)}% раз
                          </span>
                        </div>
                        <div
                          className="rank-bar"
                          title={`Обычный балл ${r.expectedScore.toFixed(3)}`}
                        >
                          <i
                            style={{
                              width: `${Math.max(0, Math.min(100, r.winRate * 100))}%`,
                            }}
                          />
                        </div>
                        <div className="rank-meta caption">
                          обычно на месте ≈{r.meanRank.toFixed(1)}
                        </div>
                      </div>
                    </li>
                  ))}
                </ol>
              </section>

              <section
                className="results-col"
                aria-label="Устойчивость и пояснения"
              >
                <p className="section-label caption">Чувствительность</p>
                <div>
                  <SensitivityViz analysis={analysis} />
                </div>
                <p className="footnote body">{analysis.sensitivityNote}</p>

                <MethodCompare analysis={analysis} />

                {explanation && (
                  <>
                    <p className="section-label caption">
                      Простыми словами
                      {explanationMeta && (
                        <span className="llm-tag">
                          {explanationMeta.source === "llm" ? "LLM" : "По расчёту"}
                        </span>
                      )}
                    </p>
                    <p className="footnote explain body">{explanation}</p>
                    {explanationMeta?.source === "deterministic" && (
                      <p className="footnote body">
                        {explanationMeta.rejected
                          ? "Ответ LLM не прошёл проверку. Показано объяснение по результатам расчёта."
                          : "Показано объяснение по результатам расчёта без LLM."}
                      </p>
                    )}
                  </>
                )}

                <div className="results-actions">
                  {lastAudit && (
                    <button
                      type="button"
                      className="btn-secondary glass"
                      onClick={() => downloadAudit(lastAudit)}
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
              </section>
            </div>
          </div>
        </main>
        {coachCard}
      </ProductShell>
    );
  }

  const missingFriendly = session.missing
    .map((m) => {
      const low = m.toLowerCase();
      if (low.includes("альтернатив") || low.includes("вариант"))
        return "варианты на выбор";
      if (low.includes("критер")) return "что для вас важно";
      if (low.includes("вес") || low.includes("важност"))
        return "насколько важно каждое условие";
      return m;
    })
    .join(", ");

  const criteriaHint = session.criteria.map((c) => c.name).join(", ");

  const metaChips = (
    <>
      {(session.context?.trim() ||
        (session.criteria.length > 0 ? "Ваш выбор" : "")) && (
        <span className="meta-context">
          {session.context?.trim() || "Ваш выбор"}
        </span>
      )}
      {session.criteria.map((c) => (
        <span key={c.id}>
          {c.name}
          {c.importance === "high" ? " ★" : ""}
          {c.weightUncertain ? " ±" : ""}
          {Array.isArray(c.valueHint)
            ? ` ${c.valueHint[0]}–${c.valueHint[1]}`
            : ""}
        </span>
      ))}
      {session.alternatives.map((a) => (
        <span key={a.id} className="meta-alt">
          {a.name}
        </span>
      ))}
    </>
  );

  const clarifyNote = session.missing.length > 0 && !canAnalyze && (
    <p className="clarify" role="status">
      Чтобы продолжить, расскажите ещё про: {missingFriendly}.
    </p>
  );

  const sidePanels = (
    <>
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
              aria-expanded={altOpen}
              onClick={() => setAltOpen((v) => !v)}
            >
              {altOpen ? "Скрыть" : "Вставить"}
            </button>
          </div>
          {altOpen && (
            <>
              <p className="caption alt-hint">
                Строка на вариант: «Название: {criteriaHint || "к1, к2, …"}».
                Интервал — через дефис, например 450-500.
              </p>
              <textarea
                className="alt-paste"
                value={altPaste}
                aria-label="Свои варианты, по строке на вариант"
                onChange={(e) => {
                  setAltPaste(e.target.value);
                  setAltError("");
                }}
                rows={wide ? 6 : 4}
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
        <div
          className="session-review glass sheet"
          aria-label="Проверка данных"
        >
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
            Проверьте критерии и их важность. После подтверждения можно
            запустить сравнение.
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
              className="btn-primary dock-cta"
              disabled={busy}
              onClick={() => setSessionConfirmed(true)}
            >
              Данные верны
            </button>
          ) : (
            <button
              type="button"
              className="btn-primary dock-cta"
              disabled={busy}
              onClick={() => void analyze()}
            >
              Сравнить варианты
            </button>
          )}
        </div>
      )}
    </>
  );

  const messageLog = (
    <div className="messages" role="log" aria-live="polite" ref={messagesRef}>
      {messages.map((m, i) => (
        <div
          key={`${i}-${m.role}-${m.content.slice(0, 24)}`}
          className={`message-row ${m.role}`}
        >
          {m.role === "assistant" && (
            <span className="message-avatar">
              <InterfaceIcon name="spark" size={16} />
            </span>
          )}
          <div className="message-content">
            <span className="message-author">
              {m.role === "user" ? "Вы" : "Klar"}
            </span>
            <div className={`bubble ${m.role}`}>{m.content}</div>
          </div>
        </div>
      ))}
      {busy && <TypingDots />}
    </div>
  );

  const quickRow = (showDemoChip || session.criteria.length >= 2) && (
    <div className="quick-row">
      {showDemoChip && !offerDemo && (
        <button type="button" disabled={busy} onClick={loadDemo}>
          Демо-варианты
        </button>
      )}
      {session.criteria.length >= 2 && !altOpen && (
        <button type="button" disabled={busy} onClick={() => setAltOpen(true)}>
          Свои варианты
        </button>
      )}
    </div>
  );

  const composer = (
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
        aria-label="Сообщение"
        rows={2}
        enterKeyHint="send"
        onKeyDown={(e) => {
          // Enter during IME composition confirms the candidate, not the message
          if (e.nativeEvent.isComposing || e.keyCode === 229) return;
          if (e.key === "Enter" && !e.shiftKey) {
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
        title="Отправить (Enter)"
      >
        <InterfaceIcon name="arrow" size={20} />
      </button>
    </form>
  );

  const completedSteps =
    Number(Boolean(session.context.trim())) +
    Number(sessionConfirmed) +
    Number(analysis !== null);
  const taskSummary = (
    <>
      <section className="task-overview">
        <div className="panel-heading">
          <h2>
            <InterfaceIcon name="layers" size={18} /> Ваша задача
          </h2>
          <span className="draft-badge">
            {sessionConfirmed ? "Подтверждено" : "Черновик"}
          </span>
        </div>
        <div
          className="task-progress"
          aria-label={`Выполнено шагов: ${completedSteps} из 3`}
        >
          {[0, 1, 2].map((i) => (
            <i key={i} className={i < completedSteps ? "complete" : ""} />
          ))}
        </div>
        <ol className="task-steps">
          {[
            {
              title: "Опишите выбор",
              description: "Цель и то, что для вас важно",
              done: Boolean(session.context.trim()),
            },
            {
              title: "Проверьте данные",
              description: "Варианты, критерии и их важность",
              done: sessionConfirmed,
            },
            {
              title: "Сравните варианты",
              description: "Рейтинг и устойчивость решения",
              done: analysis !== null,
            },
          ].map((step, i) => (
            <li key={step.title} className={step.done ? "is-complete" : ""}>
              <span className="task-step-number">
                {step.done ? <InterfaceIcon name="check" size={14} /> : i + 1}
              </span>
              <div>
                <strong>{step.title}</strong>
                <p>{step.description}</p>
              </div>
            </li>
          ))}
        </ol>
        <div className="task-counters">
          <div>
            <strong>
              {session.alternatives.length.toString().padStart(2, "0")}
            </strong>
            <span>вариантов</span>
          </div>
          <div>
            <strong>
              {session.criteria.length.toString().padStart(2, "0")}
            </strong>
            <span>критериев</span>
          </div>
        </div>
        {showSessionMeta ? (
          <div className="task-extracted">
            <p className="small-label">ИЗ ДИАЛОГА</p>
            <div className="meta-cloud">{metaChips}</div>
            {session.usedDemoData && (
              <p className="demo-note">Демонстрационные данные</p>
            )}
          </div>
        ) : (
          <div className="task-placeholder">
            <InterfaceIcon name="edit" size={19} />
            <p>
              Здесь появятся данные
              <br />
              из вашего описания
            </p>
          </div>
        )}
      </section>
      {clarifyNote}
      {(offerDemo || showAltHelper || canAnalyze) && (
        <fieldset
          className="task-editors"
          disabled={busy}
          aria-label="Редактирование задачи"
        >
          {sidePanels}
        </fieldset>
      )}
      {!canAnalyze && (
        <div className="uncertainty-note">
          <span className="note-icon">
            <InterfaceIcon name="spark" size={18} />
          </span>
          <h3>Можно без точных цифр</h3>
          <p>
            Укажите диапазон или напишите «не уверен». Klar учтёт
            неопределённость при сравнении.
          </p>
          <span className="note-example">Например: «бюджет 450–500 тысяч»</span>
        </div>
      )}
      <a href="/lab" className="lab-shortcut">
        <InterfaceIcon name="chart" size={17} />
        <span>
          Нужны расширенные настройки?
          <strong>
            Открыть лабораторию <span aria-hidden="true">↗</span>
          </strong>
        </span>
      </a>
    </>
  );

  return (
    <ProductShell {...shellProps}>
      <main className="workspace-page">
        <div className="workspace-title">
          <div>
            <p className="eyebrow">ОТ ВОПРОСА К РЕШЕНИЮ</p>
            <h1>{hasUserMessage ? "Разберём ваш выбор" : "Новое решение"}</h1>
            <p>Сравните варианты и найдите тот, на который можно опереться.</p>
          </div>
          <button type="button" className="help-link" onClick={openHelp}>
            <InterfaceIcon name="info" size={16} /> Как это работает
          </button>
        </div>
        <div
          className="mobile-workspace-tabs"
          role="group"
          aria-label="Рабочая область"
        >
          <button
            type="button"
            aria-pressed={!taskOpen}
            onClick={() => setTaskOpen(false)}
          >
            Диалог
          </button>
          <button
            type="button"
            aria-pressed={taskOpen}
            onClick={() => setTaskOpen(true)}
          >
            Ваша задача{" "}
            <span>{session.criteria.length + session.alternatives.length}</span>
          </button>
        </div>
        <div className={`decision-workspace${taskOpen ? " is-task-open" : ""}`}>
          <section
            className={`conversation-panel${hasUserMessage ? "" : " is-empty"}`}
            aria-label="Диалог"
          >
            <div className="conversation-heading">
              <span className="assistant-avatar">
                <InterfaceIcon name="spark" />
              </span>
              <div>
                <h2>Помощник Klar</h2>
                <p>
                  {busy
                    ? "Работаем над вашим запросом…"
                    : "Поможет превратить вопрос в понятную задачу"}
                </p>
              </div>
              <span className="conversation-tag">Диалог</span>
            </div>
            {!hasUserMessage ? (
              <div className="conversation-welcome">
                <div className="welcome-symbol">
                  <InterfaceIcon name="spark" size={30} />
                </div>
                <h2>
                  Сложный выбор.
                  <br />
                  Ясное решение.
                </h2>
                <p>
                  Расскажите, что выбираете и что для вас важно.
                  <br className="desktop-break" /> Вместе разложим всё по
                  полочкам.
                </p>
                <div className="template-section">
                  <span className="small-label">
                    НАЧНИТЕ С ПРИМЕРА ИЛИ СВОЕГО ВОПРОСА
                  </span>
                  <div className="template-grid">
                    {TEMPLATES.map((template) => (
                      <button
                        type="button"
                        className="template-card"
                        key={template.title}
                        disabled={busy}
                        onClick={() => {
                          setDraft(template.text);
                          textareaRef.current?.focus();
                        }}
                      >
                        <InterfaceIcon name={template.icon} size={21} />
                        <strong>{template.title}</strong>
                        <span>{template.description}</span>
                        <InterfaceIcon name="arrow" size={15} />
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            ) : (
              messageLog
            )}
            <footer className="composer-dock">
              {hasUserMessage && quickRow}
              {canAnalyze && !wide && (
                <button
                  type="button"
                  className="review-shortcut"
                  onClick={() => setTaskOpen(true)}
                >
                  Проверьте данные перед сравнением{" "}
                  <InterfaceIcon name="arrow" size={16} />
                </button>
              )}
              {composer}
              <div className="composer-footnote">
                <span>
                  <span className="privacy-dot" /> Решение остаётся за вами
                </span>
                {finePointer && (
                  <span>
                    Enter <span aria-hidden="true">↵</span> отправить ·
                    Shift+Enter — новая строка
                  </span>
                )}
              </div>
            </footer>
          </section>
          <aside className="task-panel" aria-label="Данные выбора">
            {taskSummary}
          </aside>
        </div>
      </main>
      {coachCard}
    </ProductShell>
  );
}
