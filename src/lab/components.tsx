import type { ReactNode } from "react";
import { pretty } from "./format";
export function JsonView({
  value,
  label = "Полные данные",
}: {
  value: unknown;
  label?: string;
}) {
  return (
    <details className="lab-json">
      <summary>{label}</summary>
      <pre>{pretty(value)}</pre>
    </details>
  );
}
export function Panel({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <section className="lab-panel">
      <h2>{title}</h2>
      {children}
    </section>
  );
}
export function Field({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <label className="lab-field">
      <span>{label}</span>
      {children}
    </label>
  );
}
export function Table({
  headings,
  rows,
}: {
  headings: string[];
  rows: ReactNode[][];
}) {
  return (
    <div className="lab-table">
      <table>
        <thead>
          <tr>
            {headings.map((h) => (
              <th key={h} scope="col">{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 && (
            <tr><td colSpan={headings.length} className="lab-table-empty">Пока нет данных</td></tr>
          )}
          {rows.map((row, i) => (
            <tr key={i}>
              {row.map((cell, j) => (
                <td key={j}>{cell}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
export type Perform = (work: () => Promise<void>) => Promise<void>;
