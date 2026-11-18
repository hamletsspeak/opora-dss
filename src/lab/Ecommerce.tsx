import { number, percent } from "./format";
import { useState } from "react";
import type { DecisionProblem } from "./types";
import { download, getText, readUpload, request } from "./api";
import { Field, JsonView, Panel, Table, type Perform } from "./components";

interface Inspection {
  headers: string[];
  fields: { key: string; title: string; required: boolean }[];
  suggested_mapping: Record<string, string | null>;
}
interface MappingResult {
  skus: { sku: string; name: string | null }[];
  availability: { actions: Availability[]; criteria: Availability[] };
  warnings: string[];
}
interface Availability {
  id: string;
  name: string;
  available: boolean;
  reason: string | null;
}
interface Backtest {
  metrics: {
    mae: number;
    rmse: number;
    wape: number | null;
    interval_coverage: number;
  };
  limitations: string[];
  folds: {
    cutoff: string;
    train_from: string;
    train_to: string;
    test_to: string;
    forecast: { point: number; lower: number; upper: number };
    observed: { units_sold: number };
    runs: { mode: string; result: { primary: { leader_ids: string[] } } }[];
  }[];
}
export default function Ecommerce({
  perform,
  acceptProblem,
}: {
  perform: Perform;
  acceptProblem: (p: DecisionProblem) => void;
}) {
  const [content, setContent] = useState("");
  const [inspection, setInspection] = useState<Inspection | null>(null);
  const [mapping, setMapping] = useState<Record<string, string | null>>({});
  const [mapped, setMapped] = useState<MappingResult | null>(null);
  const [period, setPeriod] = useState("month");
  const [sku, setSku] = useState("");
  const [cutoff, setCutoff] = useState("2023-01");
  const [last, setLast] = useState("");
  const [train, setTrain] = useState(24);
  const [horizon, setHorizon] = useState(3);
  const [step, setStep] = useState(3);
  const [assumptions, setAssumptions] = useState(
    '{"bootstrap": 300, "seed": 42}',
  );
  const [result, setResult] = useState<Backtest | null>(null);
  const [choices, setChoices] = useState<string[]>([]);
  async function inspect(csv: string) {
    const r = await request<Inspection>("/ecommerce/inspect", { content: csv });
    setContent(csv);
    setInspection(r);
    setMapping(r.suggested_mapping);
    setMapped(null);
    setResult(null);
  }
  function invalidate() {
    setMapped(null);
    setResult(null);
  }
  const body = () => ({ content, mapping, period });
  const cfg = () => ({
    assumptions: { ...JSON.parse(assumptions), horizon },
    ...(choices.length ? { actions: choices } : {}),
  });
  return (
    <>
      <Panel title="История SKU и сопоставление полей">
        <p>
          Загрузите обезличенный CSV. Предложенный маппинг необходимо проверить.
          Демонстрационный набор полностью синтетический.
        </p>
        <div className="lab-row">
          <Field label="Исторические данные CSV">
            <input
              type="file"
              accept=".csv"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void perform(async () => inspect(await readUpload(f)));
              }}
            />
          </Field>
          <button
            onClick={() =>
              void perform(async () => {
                await inspect(await getText("/ecommerce/demo-dataset"));
              })
            }
          >
            Загрузить синтетическое демо
          </button>
        </div>
        <Field label="Период агрегации">
          <select
            value={period}
            onChange={(e) => {
              setPeriod(e.target.value);
              invalidate();
            }}
          >
            <option value="month">Месяц</option>
            <option value="week">Неделя</option>
            <option value="day">День</option>
          </select>
        </Field>
        {inspection && (
          <>
            <div className="lab-grid">
              {inspection.fields.map((f) => (
                <Field key={f.key} label={f.title + (f.required ? " *" : "")}>
                  <select
                    value={mapping[f.key] ?? ""}
                    onChange={(e) => {
                      setMapping({
                        ...mapping,
                        [f.key]: e.target.value || null,
                      });
                      invalidate();
                    }}
                  >
                    <option value="">Не задано</option>
                    {inspection.headers.map((h) => (
                      <option key={h}>{h}</option>
                    ))}
                  </select>
                </Field>
              ))}
            </div>
            <button
              onClick={() =>
                void perform(async () => {
                  const r = await request<MappingResult>(
                    "/ecommerce/mapping",
                    body(),
                  );
                  setMapped(r);
                  setSku(r.skus[0]?.sku ?? "");
                  setChoices(
                    r.availability.actions
                      .filter((a) => a.available)
                      .map((a) => a.id),
                  );
                })
              }
            >
              Проверить и применить маппинг
            </button>
          </>
        )}
      </Panel>
      {mapped && (
        <>
          <Panel title="Доступные критерии и действия">
            <p>
              Доступность по всему файлу справочная. При построении задачи
              учитывается только train выбранного SKU.
            </p>
            <Table
              headings={["Критерий", "Доступен", "Причина"]}
              rows={mapped.availability.criteria.map((a) => [
                a.name,
                a.available ? "Да" : "Нет",
                a.reason ?? "—",
              ])}
            />
            <div className="lab-grid">
              {mapped.availability.actions.map((a) => (
                <label className="lab-check" key={a.id}>
                  <input
                    type="checkbox"
                    disabled={!a.available}
                    checked={choices.includes(a.id)}
                    onChange={(e) =>
                      setChoices(
                        e.target.checked
                          ? [...choices, a.id]
                          : choices.filter((x) => x !== a.id),
                      )
                    }
                  />
                  {a.name}
                  {!a.available && ` (${a.reason})`}
                </label>
              ))}
            </div>
            {mapped.warnings.map((s) => (
              <p key={s}>{s}</p>
            ))}
          </Panel>
          <Panel title="Train и будущий период">
            <div className="lab-grid">
              <Field label="SKU">
                <select value={sku} onChange={(e) => setSku(e.target.value)}>
                  {mapped.skus.map((s) => (
                    <option key={s.sku}>{s.sku}</option>
                  ))}
                </select>
              </Field>
              <Field label="Первый test / дата решения">
                <input
                  value={cutoff}
                  onChange={(e) => setCutoff(e.target.value)}
                  placeholder="2023-01"
                />
              </Field>
              <Field label="Последний cutoff (пусто — по данным)">
                <input value={last} onChange={(e) => setLast(e.target.value)} />
              </Field>
              <Field label="Периодов train">
                <input
                  type="number"
                  min={3}
                  value={train}
                  onChange={(e) => setTrain(+e.target.value)}
                />
              </Field>
              <Field label="Горизонт / периодов test">
                <input
                  type="number"
                  min={1}
                  max={60}
                  value={horizon}
                  onChange={(e) => setHorizon(+e.target.value)}
                />
              </Field>
              <Field label="Шаг rolling">
                <input
                  type="number"
                  min={1}
                  value={step}
                  onChange={(e) => setStep(+e.target.value)}
                />
              </Field>
            </div>
            <Field label="Экспертные допущения (JSON, частичные переопределения)">
              <textarea
                className="lab-code"
                rows={4}
                value={assumptions}
                onChange={(e) => setAssumptions(e.target.value)}
              />
            </Field>
            <p>
              Эластичность, рекламный uplift и параметры закупки — модельные
              допущения. Значения по умолчанию будут показаны в постановке.
              Подтвердите их перед обычным расчётом.
            </p>
            <div className="lab-row">
              <button
                disabled={choices.length < 2}
                onClick={() =>
                  void perform(async () => {
                    const r = await request<{ problem: DecisionProblem }>(
                      "/ecommerce/problem",
                      {
                        ...body(),
                        sku,
                        cutoff,
                        train_periods: train,
                        config: cfg(),
                      },
                    );
                    acceptProblem(r.problem);
                  })
                }
              >
                Построить черновик задачи
              </button>
              <button
                disabled={choices.length < 2}
                onClick={() =>
                  void perform(async () => {
                    setResult(
                      await request<Backtest>("/ecommerce/backtest", {
                        ...body(),
                        backtest: {
                          sku,
                          first_test: cutoff,
                          ...(last ? { last_test: last } : {}),
                          train_periods: train,
                          test_periods: horizon,
                          step,
                          iterations: 300,
                        },
                        config: cfg(),
                      }),
                    );
                  })
                }
              >
                Запустить rolling backtest · 4 режима
              </button>
            </div>
          </Panel>
        </>
      )}
      {result && (
        <Panel title="Проверка на последующем периоде">
          <div className="lab-stats">
            <span>
              MAE <b>{number(result.metrics.mae)}</b>
            </span>
            <span>
              RMSE <b>{number(result.metrics.rmse)}</b>
            </span>
            <span>
              WAPE <b>{percent(result.metrics.wape)}</b>
            </span>
            <span>
              Покрытие интервала{" "}
              <b>{percent(result.metrics.interval_coverage)}</b>
            </span>
          </div>
          <Table
            headings={[
              "Train",
              "Test",
              "Прогноз",
              "Диапазон",
              "Факт",
              "Лидеры по режимам",
            ]}
            rows={result.folds.map((f) => [
              `${f.train_from} — ${f.train_to}`,
              `${f.cutoff} — ${f.test_to}`,
              number(f.forecast.point),
              `${number(f.forecast.lower)} … ${number(f.forecast.upper)}`,
              number(f.observed.units_sold),
              f.runs
                .map(
                  (r) => `${r.mode}: ${r.result.primary.leader_ids.join(", ")}`,
                )
                .join("; "),
            ])}
          />
          <ul>
            {result.limitations.map((s) => (
              <li key={s}>{s}</li>
            ))}
          </ul>
          <button onClick={() => download("sku-backtest.json", result)}>
            Скачать backtest JSON
          </button>
          <JsonView
            value={result}
            label="Полные постановки, допущения и результаты"
          />
        </Panel>
      )}
    </>
  );
}
