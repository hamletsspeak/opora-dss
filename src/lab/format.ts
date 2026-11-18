export const pretty = (v: unknown) => JSON.stringify(v, null, 2);
export const number = (v: number | null | undefined) =>
  v == null ? "—" : v.toLocaleString("ru-RU", { maximumFractionDigits: 4 });
export const percent = (v: number | null | undefined) =>
  v == null ? "—" : `${(v * 100).toFixed(1)}%`;
