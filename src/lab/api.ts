let token = "";
export function setApiToken(value: string) {
  token = value;
}
export async function getText(path: string) {
  const res = await fetch("/api/v1" + path, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  if (!res.ok) throw new Error(`Ошибка загрузки: HTTP ${res.status}`);
  return res.text();
}
export async function exportText(path: string, name: string) {
  download(name, await getText(path), "text/csv;charset=utf-8");
}
export async function request<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch("/api/v1" + path, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok)
    throw new Error(
      [
        data.error ?? `HTTP ${res.status}`,
        JSON.stringify(data.issues ?? data.details ?? data.errors ?? ""),
      ].join("\n"),
    );
  return data as T;
}
export function download(
  name: string,
  data: unknown,
  type = "application/json",
) {
  const url = URL.createObjectURL(
    new Blob(
      [typeof data === "string" ? data : JSON.stringify(data, null, 2)],
      { type },
    ),
  );
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export async function readUpload(file: File): Promise<string> {
  if (file.size > 5 * 1024 * 1024)
    throw new Error("Максимальный размер файла — 5 МБ");
  return file.text();
}
