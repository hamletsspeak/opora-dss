import { number, percent } from "./format";
import { useState } from "react";
import { download, readUpload, request } from "./api";
import { Field, JsonView, Panel, Table, type Perform } from "./components";
import type { Provider } from "./types";

interface Report {
  protocol: string;
  summary: {
    provider: string;
    cases: number;
    strict_json_rate: number;
    draft_schema_rate: number;
    micro: {
      precision: number | null;
      recall: number | null;
      f1: number | null;
    };
    unsupported_fact_count: number;
    mean_elapsed_ms: number;
    costs: { currency: string; known_amount: number }[];
    calls_with_unknown_cost: number;
  }[];
  limitations?: string[];
}
export default function Benchmark({ perform }: { perform: Perform }) {
  const [cases, setCases] = useState<
    { case_id: string; family: string; text: string }[]
  >([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [providers, setProviders] = useState<Provider[]>([]);
  const [chosen, setChosen] = useState(["mock"]);
  const [report, setReport] = useState<Report | null>(null);
  return (
    <>
      <Panel title="Одинаковые постановки, разные модели">
        <p>
          36 синтетических постановок с gold JSON. Mock — парсер по правилам.
          Метрики считаются по исходным ответам до фильтрации выдуманных фактов.
        </p>
        <button
          onClick={() =>
            void perform(async () => {
              const [c, p] = await Promise.all([
                request<{ cases: typeof cases }>("/llm-benchmark/cases"),
                request<{ providers: Provider[] }>("/llm/providers"),
              ]);
              setCases(c.cases);
              setSelected(c.cases.map((x) => x.case_id));
              setProviders(p.providers);
            })
          }
        >
          Загрузить контрольный набор и провайдеров
        </button>
        {cases.length > 0 && (
          <>
            <div className="lab-grid">
              {providers.map((p) => (
                <label className="lab-check" key={p.id}>
                  <input
                    type="checkbox"
                    checked={chosen.includes(p.id)}
                    onChange={(e) =>
                      setChosen(
                        e.target.checked
                          ? [...chosen, p.id]
                          : chosen.filter((x) => x !== p.id),
                      )
                    }
                  />
                  {p.id} · {p.model}
                  {!p.configured && " (не настроен)"}
                </label>
              ))}
            </div>
            <details>
              <summary>
                Выбор постановок · {selected.length}/{cases.length}
              </summary>
              <div className="lab-row">
                <button
                  onClick={() => setSelected(cases.map((c) => c.case_id))}
                >
                  Выбрать все
                </button>
                <button onClick={() => setSelected([])}>Снять все</button>
              </div>
              {cases.map((c) => (
                <label className="lab-check" key={c.case_id}>
                  <input
                    type="checkbox"
                    checked={selected.includes(c.case_id)}
                    onChange={(e) =>
                      setSelected(
                        e.target.checked
                          ? [...selected, c.case_id]
                          : selected.filter((x) => x !== c.case_id),
                      )
                    }
                  />
                  {c.case_id}
                </label>
              ))}
            </details>
            <p>
              По кнопке будут вызваны выбранные провайдеры:{" "}
              {chosen.join(", ") || "не выбраны"}. Облачные модели расходуют
              квоты по их тарифам. Fallback отключён; один повтор, temperature =
              0. Запрос может занять несколько минут.
            </p>
            <button
              className="lab-primary"
              disabled={!selected.length || !chosen.length}
              onClick={() =>
                void perform(async () => {
                  setReport(
                    await request<Report>("/llm-benchmark", {
                      providers: chosen,
                      case_ids: selected,
                    }),
                  );
                })
              }
            >
              Запустить сравнение · {selected.length * chosen.length} обращений
            </button>
          </>
        )}
        <Field label="Открыть JSON-отчёт из CLI или предыдущего запуска">
          <input
            type="file"
            accept=".json"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f)
                void perform(async () => {
                  const r = JSON.parse(await readUpload(f));
                  if (
                    r.protocol !== "llm-extraction-benchmark-1.0" ||
                    !Array.isArray(r.summary) ||
                    r.summary.some(
                      (s: Report["summary"][number]) =>
                        !s.micro || typeof s.provider !== "string",
                    )
                  )
                    throw new Error("Ожидается report.json из LLM benchmark");
                  setReport(r);
                });
            }}
          />
        </Field>
      </Panel>
      {report && (
        <Panel title="Качество извлечения">
          <Table
            headings={[
              "Провайдер",
              "Случаев",
              "JSON",
              "Схема",
              "Precision",
              "Recall",
              "F1",
              "Неподдержанные факты",
              "Среднее время, мс",
            ]}
            rows={report.summary.map((s) => [
              s.provider,
              s.cases,
              percent(s.strict_json_rate),
              percent(s.draft_schema_rate),
              number(s.micro.precision),
              number(s.micro.recall),
              number(s.micro.f1),
              s.unsupported_fact_count,
              number(s.mean_elapsed_ms),
            ])}
          />
          {report.summary.map((s) => (
            <p key={s.provider}>
              {s.provider}:{" "}
              {s.costs.length
                ? s.costs
                    .map((c) => `${number(c.known_amount)} ${c.currency}`)
                    .join("; ")
                : "стоимость неизвестна"}
              ; вызовов без оценки стоимости: {s.calls_with_unknown_cost}.
            </p>
          ))}
          <ul>
            {report.limitations?.map((s) => (
              <li key={s}>{s}</li>
            ))}
          </ul>
          <button onClick={() => download("llm-benchmark-report.json", report)}>
            Скачать полный отчёт
          </button>
          <JsonView value={report} label="Ответы, ошибки, метрики и паспорт" />
        </Panel>
      )}
    </>
  );
}
