import { csvToObjects, CsvError, detectDelimiter, type CsvLimits } from '../csv.js';
import {
  SCHEMA_VERSION,
  type DecisionProblem,
  type EvaluationValue,
  type MethodSpec,
  type ModeId,
  type WeightItem,
} from '../problem/index.js';
import { slugId } from '../trace.js';

/**
 * Wide CSV format (one row per alternative, one column per criterion):
 *
 *   alternative,Цена,Срок,Брак
 *   #direction,min,min,min           (required)
 *   #id,price,lead_time,defect       (optional criterion ids)
 *   #unit,руб.,дн.,%                 (optional)
 *   #weight,0.4,0.3,0.3              (optional exact weights — never re-normalized)
 *   #weight_lower,0.3,0.2,0.2        (optional bounds)
 *   #weight_upper,0.5,0.4,0.4
 *   #missing_policy,reject,worst_observed,reject
 *   Альфа,480..500,5,1.5
 *
 * Cells: `480` exact · `480..500` interval (uniform) · `480..490..500` triangular (lower..mode..upper) ·
 * `97@0.7|88@0.3` scenarios · empty / `NA` / `?` missing.
 */
export class ImportError extends Error {
  readonly errors: string[];
  constructor(errors: string[]) {
    super(errors.slice(0, 5).join('; '));
    this.name = 'ImportError';
    this.errors = errors;
  }
}

export interface TableImportOptions {
  problemId?: string;
  title?: string;
  method?: MethodSpec;
  mode?: ModeId;
  iterations?: number;
  seed?: number;
  delimiter?: string;
  limits?: Partial<CsvLimits>;
  source?: string;
}

const META = new Set(['#direction', '#id', '#unit', '#weight', '#weight_lower', '#weight_upper', '#missing_policy']);
const MISSING = new Set(['', 'na', 'n/a', '?', '—', '-', 'null']);

function num(s: string, decimalComma: boolean): number | null {
  const t = s.trim().replace(/[ \u00a0]/g, '');
  const v = Number(decimalComma ? t.replace(',', '.') : t);
  return t !== '' && Number.isFinite(v) ? v : null;
}

export function parseCell(raw: string, decimalComma: boolean): EvaluationValue | { error: string } {
  const s = raw.trim();
  if (MISSING.has(s.toLowerCase())) return { kind: 'missing', reason: 'пусто в исходной таблице' };
  if (s.includes('@')) {
    const scenarios = s.split('|').map((part) => {
      const [v, p] = part.split('@');
      return { value: num(v ?? '', decimalComma), probability: num(p ?? '', decimalComma) };
    });
    if (scenarios.some((x) => x.value === null || x.probability === null)) return { error: `сценарии «${s}»: ожидается v@p|v@p` };
    return { kind: 'scenarios', scenarios: scenarios as { value: number; probability: number }[] };
  }
  if (s.includes('..')) {
    const parts = s.split('..').map((x) => num(x, decimalComma));
    if (parts.some((x) => x === null) || parts.length < 2 || parts.length > 3) return { error: `интервал «${s}»: ожидается a..b или a..m..b` };
    const [a, b, c] = parts as number[];
    if (parts.length === 2) return { kind: 'interval', lower: a, upper: b };
    return { kind: 'interval', lower: a, upper: c, distribution: 'triangular', mode: b };
  }
  const v = num(s, decimalComma);
  if (v === null) return { error: `не число: «${s}»` };
  return { kind: 'exact', value: v };
}

export function tableCsvToProblem(text: string, opts: TableImportOptions = {}): { problem: DecisionProblem; warnings: string[] } {
  let parsed;
  try {
    parsed = csvToObjects(text, { delimiter: opts.delimiter, limits: opts.limits });
  } catch (e) {
    throw new ImportError([e instanceof CsvError ? e.message : String(e)]);
  }
  const { header, rows } = parsed;
  if (header.length < 2) throw new ImportError(['нужен столбец альтернатив и хотя бы один столбец критерия']);
  const altCol = header[0];
  const critCols = header.slice(1);
  const meta = new Map<string, Record<string, string>>();
  const data: Record<string, string>[] = [];
  const errors: string[] = [];
  const warnings: string[] = [];
  rows.forEach((r, k) => {
    const first = (r[altCol] ?? '').trim();
    if (first.startsWith('#')) {
      const key = first.toLowerCase();
      if (!META.has(key)) errors.push(`строка ${k + 2}: неизвестная служебная строка «${first}»`);
      else meta.set(key, r);
    } else if (first) data.push(r);
    else if (Object.values(r).some((v) => v)) errors.push(`строка ${k + 2}: нет названия альтернативы`);
  });
  const decimalComma = (opts.delimiter ?? detectDelimiter(text)) !== ',';
  const dirRow = meta.get('#direction');
  if (!dirRow) errors.push('нет строки #direction (min/max для каждого критерия)');
  const critIds = new Set<string>();
  const criteria = critCols.map((name, j) => {
    const idRaw = meta.get('#id')?.[name]?.trim();
    const id = idRaw ? (critIds.has(idRaw) ? (errors.push(`повторный id критерия ${idRaw}`), idRaw) : (critIds.add(idRaw), idRaw)) : slugId(name, `c${j + 1}`, critIds);
    const d = dirRow?.[name]?.trim().toLowerCase();
    if (dirRow && d !== 'min' && d !== 'max') errors.push(`#direction для «${name}»: ожидается min или max`);
    const unit = meta.get('#unit')?.[name]?.trim();
    const mp = meta.get('#missing_policy')?.[name]?.trim();
    if (mp && mp !== 'reject' && mp !== 'worst_observed') errors.push(`#missing_policy для «${name}»: reject или worst_observed`);
    return {
      criterion_id: id,
      name,
      direction: (d === 'min' ? 'min' : 'max') as 'min' | 'max',
      ...(unit ? { unit } : {}),
      ...(mp ? { missing_policy: mp as 'reject' | 'worst_observed' } : {}),
      provenance: 'imported' as const,
    };
  });
  const altIds = new Set<string>();
  const alternatives = data.map((r, i) => ({
    alternative_id: slugId(r[altCol], `a${i + 1}`, altIds),
    name: r[altCol].slice(0, 200),
    provenance: 'imported' as const,
  }));
  const evaluations: DecisionProblem['evaluations'] = [];
  data.forEach((r, i) =>
    critCols.forEach((name, j) => {
      const v = parseCell(r[name] ?? '', decimalComma);
      if ('error' in v) errors.push(`«${r[altCol]}» × «${name}»: ${v.error}`);
      else
        evaluations.push({
          alternative_id: alternatives[i].alternative_id,
          criterion_id: criteria[j].criterion_id,
          value: v,
          provenance: 'imported',
        });
    }),
  );
  const wv = meta.get('#weight');
  const wl = meta.get('#weight_lower');
  const wu = meta.get('#weight_upper');
  const items: WeightItem[] = criteria.map((c, j) => {
    const name = critCols[j];
    const g = (row: Record<string, string> | undefined, label: string) => {
      const s = row?.[name]?.trim();
      if (!s) return undefined;
      const v = num(s, decimalComma);
      if (v === null) errors.push(`${label} для «${name}»: не число «${s}»`);
      return v ?? undefined;
    };
    const value = g(wv, '#weight');
    const lower = g(wl, '#weight_lower');
    const upper = g(wu, '#weight_upper');
    return {
      criterion_id: c.criterion_id,
      ...(value !== undefined ? { value } : {}),
      ...(lower !== undefined ? { lower } : {}),
      ...(upper !== undefined ? { upper } : {}),
      provenance: 'imported',
    };
  });
  if (errors.length) throw new ImportError(errors);
  if (alternatives.length < 2) warnings.push('в таблице меньше двух альтернатив');
  const mUnc = evaluations.some((e) => e.value.kind === 'interval' || e.value.kind === 'scenarios');
  const wExact = items.every((w) => typeof w.value === 'number' && w.lower == null && w.upper == null);
  const mode: ModeId = opts.mode ?? (`${mUnc ? 'MU' : 'MF'}_${wExact ? 'WF' : 'WU'}` as ModeId);
  const problem: DecisionProblem = {
    schema_version: SCHEMA_VERSION,
    problem_id: opts.problemId ?? 'imported',
    context: { title: opts.title ?? 'Импортированная задача' },
    alternatives,
    criteria,
    evaluations,
    weights: { normalization: 'sum_to_one', items },
    constraints: [],
    method: opts.method ?? { id: 'topsis', params: { normalization: 'minmax' } },
    uncertainty: { mode, iterations: opts.iterations ?? 2000, seed: opts.seed ?? 42 },
    metadata: { origin: 'import', status: 'confirmed', source: opts.source ?? 'CSV', created_at: new Date().toISOString() },
  };
  return { problem, warnings };
}

/** JSON import: a DecisionProblem, an array of them, or `{ problems: [...] }`. */
export function problemsFromJson(text: string): unknown[] {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    throw new ImportError(['файл не является корректным JSON']);
  }
  if (Array.isArray(v)) return v;
  if (v && typeof v === 'object' && Array.isArray((v as { problems?: unknown }).problems)) return (v as { problems: unknown[] }).problems;
  return [v];
}
