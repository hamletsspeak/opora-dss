import { number, percent, pretty } from "./format";
import { useEffect, useState } from "react";
import { supplierDemo } from "../../shared/problem/examples";
import type { SensitivityReport } from "../../shared/engine/sensitivity";
import { download, exportText, readUpload, request, setApiToken } from "./api";
import { Field, JsonView, Panel, Table } from "./components";
import type { DecisionProblem, LabExperiment, Provider } from "./types";
import Ecommerce from "./Ecommerce";
import Benchmark from "./Benchmark";
import "./lab.css";

const tabs = [
  ["problem", "Постановка"],
  ["calculate", "Расчёт"],
  ["results", "Результаты"],
  ["sensitivity", "Устойчивость"],
  ["experiments", "Эксперименты"],
  ["ecommerce", "Электронная торговля"],
  ["benchmark", "Сравнение LLM"],
] as const;
const modes = ["MF_WF", "MU_WF", "MF_WU", "MU_WU"];
const modeLabels = [
  "M fixed / W fixed",
  "M uncertain / W fixed",
  "M fixed / W uncertain",
  "M uncertain / W uncertain",
];

function currentTab() {
  const hash = window.location.hash.slice(1);
  return tabs.some(([id]) => id === hash) ? hash : "problem";
}

export default function Lab() {
  const [tab, setTab] = useState(
    currentTab,
  );
  const [editor, setEditor] = useState(pretty(supplierDemo));
  const [confirmed, setConfirmed] = useState(false);
  const [reviewed, setReviewed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [providers, setProviders] = useState<Provider[]>([]);
  const [provider, setProvider] = useState("mock");
  const [text, setText] = useState(
    "Выбираю поставщика.\nАльфа: цена 480–500 руб.; срок 5 дней.\nБета: цена 520 руб.; срок 3 дня.\nВеса: цена 60%; срок 40%.",
  );
  const [validation, setValidation] = useState<unknown>(null);
  const [draft, setDraft] = useState<unknown>(null);
  const [method, setMethod] = useState("topsis");
  const [normalization, setNormalization] = useState("minmax");
  const [vikorV, setVikorV] = useState(0.5);
  const [mode, setMode] = useState("MU_WU");
  const [iterations, setIterations] = useState(500);
  const [seed, setSeed] = useState(42);
  const [distribution, setDistribution] = useState("uniform");
  const [sampler, setSampler] = useState("polytope_rejection");
  const [record, setRecord] = useState<LabExperiment | null>(null);
  const [resultMode, setResultMode] = useState("");
  const [sensitivity, setSensitivity] = useState<SensitivityReport | null>(
    null,
  );
  const [history, setHistory] = useState<
    { experiment_id: string; title: string; created_at: string; seed: number }[]
  >([]);
  const [batchFiles, setBatchFiles] = useState<File[]>([]);
  const [batch, setBatch] = useState<unknown>(null);
  useEffect(() => {
    const change = () => setTab(currentTab());
    window.addEventListener("hashchange", change);
    return () => window.removeEventListener("hashchange", change);
  }, []);

  async function perform(work: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await work();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }
  function changeProblem(value: string) {
    setEditor(value);
    setConfirmed(false);
    setReviewed(false);
    setValidation(null);
    setDraft(null);
    setSensitivity(null);
  }
  function acceptProblem(p: DecisionProblem) {
    changeProblem(pretty(p));
    window.location.hash = "problem";
  }
  function problem(): DecisionProblem {
    return JSON.parse(editor);
  }
  function overrides() {
    return {
      iterations,
      seed,
      method: {
        id: method,
        params: { normalization, ...(method === "vikor" ? { v: vikorV } : {}) },
      },
      m: { default_interval_distribution: distribution },
      w: { sampler },
    };
  }
  function loadRecord(r: LabExperiment) {
    setRecord(r);
    setResultMode(r.runs.find((x) => x.result)?.mode ?? "");
  }
  const result = record?.runs.find((r) => r.mode === resultMode)?.result;

  return (
    <div className="lab">
      <header className="lab-header">
        <a href="/" className="lab-brand">
          Klar <span>Лаборатория</span>
        </a>
        <span className="lab-tag">MCDA · воспроизводимые расчёты</span>
        <details>
          <summary>Доступ к API</summary>
          <div className="lab-api-content">
            <Field label="Токен доступа (если включён на сервере)">
              <input
                type="password"
                autoComplete="off"
                onChange={(e) => setApiToken(e.target.value)}
              />
            </Field>
            <small>Хранится только в памяти вкладки.</small>
          </div>
        </details>
      </header>
      <div className="lab-layout">
        <nav aria-label="Разделы Лаборатории">
          {tabs.map(([id, title], i) => (
            <a
              key={id}
              href={"#" + id}
              aria-current={tab === id ? "page" : undefined}
            >
              <span>{String(i + 1).padStart(2, "0")}</span>
              {title}
            </a>
          ))}
          <a href="/">← Диалоговый интерфейс</a>
        </nav>
        <main>
          <div className="lab-intro">
            <p className="lab-eyebrow">РАБОЧЕЕ ПРОСТРАНСТВО</p>
            <h1>{tabs.find(([id]) => id === tab)?.[1] ?? "Постановка"}</h1>
            <p>
              Проверьте исходные данные, исследуйте неопределённость и сохраните
              результат.
            </p>
          </div>
          <div role="status" aria-live="polite">
            {busy && <p className="lab-status">Выполняется запрос…</p>}
            {notice && <p className="lab-status">{notice}</p>}
          </div>
          {error && (
            <pre className="lab-error" role="alert">
              {error}
            </pre>
          )}
          <fieldset className="lab-workspace" disabled={busy}>
            {tab === "problem" && (
              <>
                <Panel title="1. Введите задачу или загрузите данные">
                  <Field label="Описание выбора">
                    <textarea
                      rows={5}
                      value={text}
                      onChange={(e) => setText(e.target.value)}
                    />
                  </Field>
                  <div className="lab-row">
                    <Field label="Провайдер">
                      <select
                        value={provider}
                        onChange={(e) => setProvider(e.target.value)}
                      >
                        {[
                          ...new Set(["mock", ...providers.map((p) => p.id)]),
                        ].map((id) => (
                          <option key={id}>{id}</option>
                        ))}
                      </select>
                    </Field>
                    <button
                      onClick={() =>
                        void perform(async () => {
                          const r = await request<{ providers: Provider[] }>(
                            "/llm/providers",
                          );
                          setProviders(r.providers);
                          setNotice(
                            r.providers
                              .map(
                                (p) =>
                                  `${p.id}: ${p.model}${p.configured ? "" : " (не настроен)"}`,
                              )
                              .join("; "),
                          );
                        })
                      }
                    >
                      Обновить провайдеры
                    </button>
                    <button
                      onClick={() =>
                        void perform(async () => {
                          const r = await request<{
                            problem: DecisionProblem;
                            provider_notice: string;
                          }>("/problems/formalize", {
                            text,
                            provider,
                            allow_fallback: false,
                          });
                          changeProblem(pretty(r.problem));
                          setDraft(r);
                          setNotice(r.provider_notice);
                        })
                      }
                    >
                      Сформировать черновик
                    </button>
                  </div>
                  <p>
                    LLM извлекает данные. Неизвестные значения нужно заполнить
                    вручную перед расчётом.
                  </p>
                  <Field label="Импорт задачи: JSON или CSV">
                    <input
                      type="file"
                      accept=".json,.csv"
                      onChange={(e) => {
                        const f = e.target.files?.[0];
                        if (f)
                          void perform(async () => {
                            const r = await request<{
                              problems: (DecisionProblem | null)[];
                            }>("/problems/import", {
                              format: f.name.endsWith(".csv") ? "csv" : "json",
                              content: await readUpload(f),
                              title: f.name,
                            });
                            if (!r.problems[0])
                              throw new Error(
                                "Первая задача не прошла валидацию",
                              );
                            changeProblem(pretty(r.problems[0]));
                            setNotice(
                              `Загружено задач: ${r.problems.length}. В редакторе — первая. Для пакета используйте «Эксперименты».`,
                            );
                          });
                      }}
                    />
                  </Field>
                  <button
                    onClick={() => {
                      changeProblem(pretty(supplierDemo));
                      setNotice("Загружен синтетический пример поставщиков.");
                    }}
                  >
                    Синтетический пример
                  </button>
                  {draft != null && (
                    <JsonView
                      value={draft}
                      label="Черновик, неизвестные поля и источники"
                    />
                  )}
                </Panel>
                <Panel title="2. Проверьте и подтвердите постановку">
                  <p>
                    Точные значения, интервалы, сценарии, веса и источники
                    доступны в редакторе. Любая правка снимает подтверждение.
                  </p>
                  <Field label="DecisionProblem · JSON">
                    <textarea
                      className="lab-code"
                      rows={20}
                      value={editor}
                      spellCheck={false}
                      onChange={(e) => changeProblem(e.target.value)}
                    />
                  </Field>
                  <div className="lab-row">
                    <button
                      onClick={() =>
                        void perform(async () => {
                          setValidation(
                            await request("/problems/validate", {
                              problem: problem(),
                              for_run: true,
                              overrides: { mode },
                            }),
                          );
                        })
                      }
                    >
                      Проверить
                    </button>
                    <button
                      onClick={() =>
                        void perform(async () => {
                          download("decision-problem.json", problem());
                        })
                      }
                    >
                      Скачать JSON
                    </button>
                  </div>
                  <label className="lab-check">
                    <input
                      type="checkbox"
                      checked={reviewed}
                      onChange={(e) => setReviewed(e.target.checked)}
                    />
                    Проверены значения, источники, допущения и неизвестные поля
                  </label>
                  <button
                    className="lab-primary"
                    disabled={!reviewed}
                    onClick={() =>
                      void perform(async () => {
                        const p = problem();
                        const unknown =
                          (
                            p.metadata.draft as
                              | {
                                  unknown_fields?: {
                                    path: string;
                                    blocking: boolean;
                                  }[];
                                }
                              | undefined
                          )?.unknown_fields ?? [];
                        const r = await request<{ problem: DecisionProblem }>(
                          "/problems/confirm",
                          {
                            problem: p,
                            resolved: unknown
                              .filter((u) => u.blocking)
                              .map((u) => u.path),
                          },
                        );
                        setEditor(pretty(r.problem));
                        setConfirmed(true);
                        setNotice(
                          "Постановка подтверждена. Перейдите в «Расчёт».",
                        );
                      })
                    }
                  >
                    {confirmed ? "Подтверждено" : "Подтвердить постановку"}
                  </button>
                  {validation != null && (
                    <JsonView value={validation} label="Результат валидации" />
                  )}
                </Panel>
              </>
            )}
            {tab === "calculate" && (
              <Panel title="Параметры расчёта">
                <p>
                  {confirmed
                    ? "Используется подтверждённая постановка из редактора."
                    : "Сначала проверьте и подтвердите постановку в первом разделе."}
                </p>
                <div className="lab-grid">
                  <Field label="Метод">
                    <select
                      value={method}
                      onChange={(e) => setMethod(e.target.value)}
                    >
                      {["topsis", "wsm", "vikor"].map((x) => (
                        <option key={x}>{x}</option>
                      ))}
                    </select>
                  </Field>
                  <Field label="Нормализация TOPSIS">
                    <select
                      value={normalization}
                      onChange={(e) => setNormalization(e.target.value)}
                    >
                      <option value="minmax">Min–max</option>
                      <option value="vector">Векторная</option>
                    </select>
                  </Field>
                  <Field label="Режим неопределённости">
                    <select
                      value={mode}
                      onChange={(e) => setMode(e.target.value)}
                    >
                      {modes.map((x, i) => (
                        <option key={x} value={x}>
                          {modeLabels[i]}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <Field label="Итерации N">
                    <input
                      type="number"
                      min={1}
                      max={10000}
                      value={iterations}
                      onChange={(e) => setIterations(+e.target.value)}
                    />
                  </Field>
                  <Field label="Seed">
                    <input
                      type="number"
                      min={0}
                      max={4294967295}
                      value={seed}
                      onChange={(e) => setSeed(+e.target.value)}
                    />
                  </Field>
                  <Field label="Распределение интервалов M по умолчанию">
                    <select
                      value={distribution}
                      onChange={(e) => setDistribution(e.target.value)}
                    >
                      <option value="uniform">Равномерное</option>
                      <option value="triangular">
                        Треугольное (мода обязательна)
                      </option>
                    </select>
                  </Field>
                  <Field label="Генератор неопределённых весов W">
                    <select
                      value={sampler}
                      onChange={(e) => setSampler(e.target.value)}
                    >
                      {[
                        "polytope_rejection",
                        "polytope_hit_and_run",
                        "dirichlet",
                        "scenarios",
                      ].map((x) => (
                        <option key={x}>{x}</option>
                      ))}
                    </select>
                  </Field>
                </div>
                {method === "vikor" && (
                  <Field label="VIKOR · компромисс v">
                    <input
                      type="number"
                      min={0}
                      max={1}
                      step={0.05}
                      value={vikorV}
                      onChange={(e) => setVikorV(+e.target.value)}
                    />
                  </Field>
                )}
                <p>
                  Параметры Дирихле, моды и сценарии задаются в JSON постановки.
                  Индивидуальные распределения ячеек имеют приоритет.
                  Фиксированные M и W не возмущаются.
                </p>
                <button
                  className="lab-primary"
                  disabled={!confirmed}
                  onClick={() =>
                    void perform(async () => {
                      const r = await request<LabExperiment>("/runs", {
                        problem: problem(),
                        modes: [mode],
                        overrides: overrides(),
                        sensitivity: false,
                      });
                      loadRecord(r);
                      window.location.hash = "results";
                    })
                  }
                >
                  Рассчитать
                </button>
              </Panel>
            )}
            {tab === "results" && (
              <Panel title="Результаты математического ядра">
                {record ? (
                  <>
                    <p>Эксперимент: {record.experiment_id}</p>
                    <Field label="Режим">
                      <select
                        value={resultMode}
                        onChange={(e) => setResultMode(e.target.value)}
                      >
                        {record.runs.map((r) => (
                          <option key={r.mode} value={r.mode}>
                            {r.mode} · {r.status}
                          </option>
                        ))}
                      </select>
                    </Field>
                    {result ? (
                      <>
                        <p>
                          {result.mode_label} · N ={" "}
                          {result.iterations_effective} · seed ={" "}
                          {result.settings.seed}
                        </p>
                        <Table
                          headings={[
                            "Альтернатива",
                            "Score (средний)",
                            "Ранг (средний)",
                            "pBest",
                            "pWorst",
                          ]}
                          rows={result.primary.ranking.map((id) => {
                            const a = result.primary.alternatives.find(
                              (x) => x.alternative_id === id,
                            )!;
                            return [
                              a.name,
                              number(a.mean_score),
                              number(a.mean_rank),
                              percent(a.p_best),
                              percent(a.p_worst),
                            ];
                          })}
                        />
                        <p>
                          pBest — частота первого места в выбранной модели
                          неопределённости. При ничьей вклад делится между
                          лидерами. Это не вероятность коммерческого успеха.
                        </p>
                        <JsonView
                          value={result.uncertainty}
                          label="Фактически использованная неопределённость"
                        />
                      </>
                    ) : (
                      <JsonView
                        value={
                          record.runs.find((r) => r.mode === resultMode)?.issues
                        }
                        label="Ошибки режима"
                      />
                    )}
                    <div className="lab-row">
                      <button
                        onClick={() =>
                          download(record.experiment_id + ".json", record)
                        }
                      >
                        Скачать JSON
                      </button>
                      <button
                        onClick={() =>
                          void perform(async () => {
                            await exportCsv(record.experiment_id);
                          })
                        }
                      >
                        Скачать CSV
                      </button>
                    </div>
                    <JsonView
                      value={record.comparison}
                      label="Сопоставление режимов"
                    />
                    <JsonView
                      value={record.passport}
                      label="Паспорт и воспроизводимость"
                    />
                  </>
                ) : (
                  <p>Выполните расчёт или откройте сохранённый эксперимент.</p>
                )}
              </Panel>
            )}
            {tab === "sensitivity" && (
              <Panel title="При каких изменениях меняется лидер">
                <p>
                  Анализ использует текущую постановку из редактора. Порог
                  рассчитывается по данным и методу. При изменении веса
                  остальные меняются по указанной в отчёте схеме.
                </p>
                <button
                  disabled={!confirmed}
                  onClick={() =>
                    void perform(async () => {
                      setSensitivity(
                        await request<SensitivityReport>("/sensitivity", {
                          analysis: "report",
                          problem: problem(),
                          overrides: { ...overrides(), mode },
                          max_cells: 100,
                        }),
                      );
                    })
                  }
                >
                  Рассчитать чувствительность
                </button>
                {sensitivity && (
                  <>
                    <ul>
                      {sensitivity.summary.map((s) => (
                        <li key={s}>{s}</li>
                      ))}
                    </ul>
                    <Table
                      headings={[
                        "Параметр",
                        "Базовое значение",
                        "Граница смены",
                        "|Δ|",
                        "Новый лидер",
                      ]}
                      rows={sensitivity.critical.map((c) => [
                        c.label,
                        number(c.base_value),
                        number(c.flip_at),
                        number(c.abs_delta),
                        c.new_leader_ids?.join(", ") ?? "—",
                      ])}
                    />
                    {sensitivity.weights.map((w) => (
                      <details key={w.parameter.criterion_id}>
                        <summary>
                          {w.parameter.label} ·{" "}
                          {w.analytic
                            ? "аналитический расчёт"
                            : "численный поиск"}
                        </summary>
                        <p>{w.scheme}</p>
                        <ul>
                          {w.statements.map((s) => (
                            <li key={s}>{s}</li>
                          ))}
                        </ul>
                        <Table
                          headings={["От", "До", "Лидер"]}
                          rows={w.segments.map((s) => [
                            number(s.from),
                            number(s.to),
                            s.leader_ids.join(", "),
                          ])}
                        />
                        <JsonView
                          value={w.change_points}
                          label="Границы и точность"
                        />
                      </details>
                    ))}
                    <button
                      onClick={() => download("sensitivity.json", sensitivity)}
                    >
                      Скачать анализ
                    </button>
                    <JsonView
                      value={sensitivity.notes}
                      label="Ограничения анализа"
                    />
                  </>
                )}
              </Panel>
            )}
            {tab === "experiments" && (
              <>
                <Panel title="Пакет и сравнение четырёх режимов">
                  <button
                    disabled={!confirmed}
                    onClick={() =>
                      void perform(async () => {
                        loadRecord(
                          await request<LabExperiment>("/runs", {
                            problem: problem(),
                            modes: "all",
                            overrides: overrides(),
                            sensitivity: false,
                          }),
                        );
                        window.location.hash = "results";
                      })
                    }
                  >
                    Все четыре режима текущей задачи
                  </button>
                  <Field label="Пакет файлов CSV/JSON">
                    <input
                      type="file"
                      multiple
                      accept=".csv,.json"
                      onChange={(e) =>
                        setBatchFiles(Array.from(e.target.files ?? []))
                      }
                    />
                  </Field>
                  <button
                    disabled={!batchFiles.length}
                    onClick={() =>
                      void perform(async () => {
                        const items = await Promise.all(
                          batchFiles.map(async (f) => ({
                            name: f.name,
                            format: f.name.endsWith(".csv") ? "csv" : "json",
                            content: await readUpload(f),
                          })),
                        );
                        setBatch(
                          await request("/experiments/batch", {
                            items,
                            modes: "all",
                            overrides: overrides(),
                            sensitivity: false,
                          }),
                        );
                      })
                    }
                  >
                    Запустить пакет в четырёх режимах
                  </button>
                  {batch != null && (
                    <>
                      <JsonView
                        value={batch}
                        label="Статусы пакетного запуска"
                      />
                      <button onClick={() => download("batch.json", batch)}>
                        Скачать статусы
                      </button>
                    </>
                  )}
                </Panel>
                <Panel title="История экспериментов">
                  <button
                    onClick={() =>
                      void perform(async () => {
                        const r = await request<{
                          experiments: typeof history;
                        }>("/experiments");
                        setHistory(r.experiments);
                      })
                    }
                  >
                    Обновить историю
                  </button>
                  <Table
                    headings={["Постановка", "Создано", "Seed", "Действия"]}
                    rows={history.map((h) => [
                      h.title,
                      h.created_at,
                      h.seed,
                      <div className="lab-row" key={h.experiment_id}>
                        <button
                          onClick={() =>
                            void perform(async () => {
                              const r = await request<LabExperiment>(
                                "/experiments/" + h.experiment_id,
                              );
                              loadRecord(r);
                              window.location.hash = "results";
                            })
                          }
                        >
                          Открыть
                        </button>
                        <button
                          onClick={() =>
                            void perform(async () => {
                              const r = await request<LabExperiment>(
                                "/experiments/" + h.experiment_id + "/repeat",
                                {},
                              );
                              loadRecord(r);
                              setNotice(
                                r.verification?.same_result
                                  ? "Повтор: результат идентичен."
                                  : "Повтор завершён; проверьте паспорт.",
                              );
                            })
                          }
                        >
                          Повторить
                        </button>
                        <button
                          onClick={() =>
                            void perform(async () => {
                              const r = await request<LabExperiment>(
                                "/experiments/" + h.experiment_id,
                              );
                              acceptProblem(r.problem);
                            })
                          }
                        >
                          В редактор
                        </button>
                      </div>,
                    ])}
                  />
                </Panel>
              </>
            )}
            <div hidden={tab !== "ecommerce"}>
              <Ecommerce perform={perform} acceptProblem={acceptProblem} />
            </div>
            <div hidden={tab !== "benchmark"}>
              <Benchmark perform={perform} />
            </div>
          </fieldset>
        </main>
      </div>
    </div>
  );
}

async function exportCsv(id: string) {
  // Use the same in-memory Authorization header as all other lab requests.

  await exportText(
    "/experiments/" + encodeURIComponent(id) + "/export?format=csv",
    id + ".csv",
  );
}
