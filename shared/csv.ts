/**
 * Minimal RFC 4180 CSV reader/writer. Input is treated strictly as data: nothing is evaluated.
 * Output neutralises spreadsheet formula injection (cells starting with = + - @ tab CR).
 */

export interface CsvLimits {
  maxBytes: number;
  maxRows: number;
  maxCols: number;
  maxCell: number;
}

export const DEFAULT_CSV_LIMITS: CsvLimits = {
  maxBytes: 5 * 1024 * 1024,
  maxRows: 200_000,
  maxCols: 200,
  maxCell: 10_000,
};

export class CsvError extends Error {
  readonly line?: number;
  constructor(message: string, line?: number) {
    super(line ? `CSV, строка ${line}: ${message}` : `CSV: ${message}`);
    this.name = 'CsvError';
    this.line = line;
  }
}

export function detectDelimiter(text: string): ',' | ';' | '\t' {
  const first = text.split(/\r?\n/, 1)[0] ?? '';
  const counts = { ',': 0, ';': 0, '\t': 0 } as Record<',' | ';' | '\t', number>;
  let q = false;
  for (const ch of first) {
    if (ch === '"') q = !q;
    else if (!q && ch in counts) counts[ch as ',']++;
  }
  const best = (Object.entries(counts) as [',' | ';' | '\t', number][]).sort((a, b) => b[1] - a[1])[0];
  return best[1] > 0 ? best[0] : ',';
}

export function parseCsv(text: string, opts: { delimiter?: string; limits?: Partial<CsvLimits> } = {}): string[][] {
  const lim = { ...DEFAULT_CSV_LIMITS, ...opts.limits };
  if (text.length > lim.maxBytes) throw new CsvError(`файл больше ${lim.maxBytes} байт`);
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const d = opts.delimiter ?? detectDelimiter(src);
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let inQuotes = false;
  let line = 1;
  const pushCell = () => {
    if (cell.length > lim.maxCell) throw new CsvError(`ячейка длиннее ${lim.maxCell} символов`, line);
    row.push(cell);
    if (row.length > lim.maxCols) throw new CsvError(`больше ${lim.maxCols} столбцов`, line);
    cell = '';
  };
  const pushRow = () => {
    pushCell();
    if (!(row.length === 1 && row[0] === '')) rows.push(row);
    if (rows.length > lim.maxRows) throw new CsvError(`больше ${lim.maxRows} строк`);
    row = [];
  };
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          cell += '"';
          i++;
        } else inQuotes = false;
      } else {
        if (ch === '\n') line++;
        cell += ch;
      }
    } else if (ch === '"' && cell === '') inQuotes = true;
    else if (ch === d) pushCell();
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      pushRow();
      line++;
    } else cell += ch;
  }
  if (inQuotes) throw new CsvError('незакрытая кавычка', line);
  if (cell !== '' || row.length) pushRow();
  return rows;
}

/** Rows as objects keyed by the (trimmed) header. Duplicate headers are an error. */
export function csvToObjects(text: string, opts: { delimiter?: string; limits?: Partial<CsvLimits> } = {}): {
  header: string[];
  rows: Record<string, string>[];
} {
  const all = parseCsv(text, opts);
  if (!all.length) throw new CsvError('пустой файл');
  const header = all[0].map((h) => h.trim());
  const seen = new Set<string>();
  for (const h of header) {
    if (!h) throw new CsvError('пустое имя столбца в заголовке', 1);
    if (seen.has(h)) throw new CsvError(`повторяющийся столбец «${h}»`, 1);
    seen.add(h);
  }
  const rows = all.slice(1).map((r, k) => {
    if (r.length > header.length) throw new CsvError(`ячеек больше, чем столбцов (${r.length} > ${header.length})`, k + 2);
    const o: Record<string, string> = {};
    header.forEach((h, j) => (o[h] = (r[j] ?? '').trim()));
    return o;
  });
  return { header, rows };
}

const INJECTION = /^[=+\-@\t\r]/;

function cellOut(v: unknown, d: string): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : '';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  let s = typeof v === 'string' ? v : JSON.stringify(v);
  if (INJECTION.test(s)) s = `'${s}`;
  return /["\r\n]/.test(s) || s.includes(d) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(header: string[], rows: Record<string, unknown>[], delimiter = ','): string {
  const lines = [header.map((h) => cellOut(h, delimiter)).join(delimiter)];
  for (const r of rows) lines.push(header.map((h) => cellOut(r[h], delimiter)).join(delimiter));
  return `${lines.join('\r\n')}\r\n`;
}
