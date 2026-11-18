import { csvToObjects, type CsvLimits } from '../csv.js';
import { FIELDS, mappingErrors, type ColumnMapping, type FieldKey } from './fields.js';

export type PeriodKind = 'day' | 'week' | 'month';

export const PERIOD_DAYS: Record<PeriodKind, number> = { day: 1, week: 7, month: 30.44 };

/** Aggregated observation of one SKU in one period. `null` = not observed. */
export interface PeriodRow {
  p: number;
  units: number;
  revenue: number | null;
  price: number | null;
  cost: number | null;
  stock: number | null;
  ad_spend: number | null;
  ad_revenue: number | null;
  returns: number | null;
  lead_time_days: number | null;
  storage_cost: number | null;
  inbound: number | null;
  /** logged management action (raw text), if the dataset has an action journal */
  action: string | null;
  /** true when the SKU had no rows in this period (filled with zero sales) */
  gap: boolean;
}

export interface SkuSeries {
  sku: string;
  name: string | null;
  category: string | null;
  rows: PeriodRow[];
}

export interface EcomDataset {
  period: PeriodKind;
  mapping: ColumnMapping;
  skus: SkuSeries[];
  first_period: number;
  last_period: number;
  fields_present: FieldKey[];
  /** share of non-empty values per mapped field */
  coverage: Partial<Record<FieldKey, number>>;
  stats: { rows: number; rows_used: number; rows_skipped: number; skus: number; periods: number };
  warnings: string[];
}

export class DatasetError extends Error {
  readonly errors: string[];
  constructor(errors: string[]) {
    super(errors.slice(0, 5).join('; '));
    this.name = 'DatasetError';
    this.errors = errors;
  }
}

const DAY = 86_400_000;

export function parseDate(s: string): Date | null {
  const t = s.trim();
  const iso = t.match(/^(\d{4})-(\d{2})(?:-(\d{2}))?$/);
  const ru = t.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
  const month = t.match(/^(\d{1,2})\.(\d{4})$/);
  if (!iso && !ru && !month) return null;
  const y = iso ? +iso[1] : ru ? +ru[3] : +month![2];
  const m = iso ? +iso[2] : ru ? +ru[2] : +month![1];
  const day = iso ? +(iso[3] ?? 1) : ru ? +ru[1] : 1;
  const d = new Date(Date.UTC(y, m - 1, day));
  return y >= 1900 && y <= 2200 && d.getUTCFullYear() === y && d.getUTCMonth() === m - 1 && d.getUTCDate() === day ? d : null;
}

/** Monday 1970-01-05 is the origin of week numbering. */
export function periodIndex(d: Date, kind: PeriodKind): number {
  if (kind === 'month') return d.getUTCFullYear() * 12 + d.getUTCMonth();
  const days = Math.floor(d.getTime() / DAY);
  return kind === 'day' ? days : Math.floor((days - 4) / 7);
}

export function periodStart(p: number, kind: PeriodKind): Date {
  if (kind === 'month') return new Date(Date.UTC(Math.floor(p / 12), p % 12, 1));
  return new Date((kind === 'day' ? p : p * 7 + 4) * DAY);
}

export function periodLabel(p: number, kind: PeriodKind): string {
  const d = periodStart(p, kind).toISOString();
  return kind === 'month' ? d.slice(0, 7) : d.slice(0, 10);
}

/** Calendar month (0–11) of a period, used for seasonal indices. */
export function periodMonth(p: number, kind: PeriodKind): number {
  return periodStart(p, kind).getUTCMonth();
}

function num(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  const t = raw.trim().replace(/[ \u00a0]/g, '').replace(/[₽$€%]|руб\.?/gi, '');
  if (!t || /^(na|n\/a|null|-|—)$/i.test(t)) return null;
  const v = Number(t.replace(',', '.'));
  return Number.isFinite(v) ? v : NaN;
}

interface Acc {
  units: number;
  revenue: number | null;
  priceSum: number;
  priceN: number;
  costSum: number;
  costN: number;
  stock: number | null;
  stockDate: number;
  ad_spend: number | null;
  ad_revenue: number | null;
  returns: number | null;
  leadSum: number;
  leadN: number;
  storage: number | null;
  inbound: number | null;
  action: string | null;
}

const add = (a: number | null, b: number | null) => (b === null ? a : (a ?? 0) + b);

export interface ParseOptions {
  period: PeriodKind;
  limits?: Partial<CsvLimits>;
  maxSkus?: number;
}

/** CSV + column mapping → per-SKU period series. Values are parsed as data only. */
export function parseEcomCsv(text: string, mapping: ColumnMapping, opts: ParseOptions): EcomDataset {
  const { header, rows } = csvToObjects(text, { limits: opts.limits });
  const errs = mappingErrors(mapping, header);
  if (errs.length) throw new DatasetError(errs);
  const col = (k: FieldKey) => mapping[k] ?? null;
  const warnings: string[] = [];
  const bySku = new Map<string, { name: string | null; category: string | null; acc: Map<number, Acc> }>();
  let skipped = 0;
  const badDates: number[] = [];
  const badNums = new Map<FieldKey, number>();
  const filled = new Map<FieldKey, number>();
  rows.forEach((r, k) => {
    const sku = r[col('sku')!]?.trim();
    const d = parseDate(r[col('date')!] ?? '');
    if (!sku || !d) {
      skipped++;
      if (!d && badDates.length < 5) badDates.push(k + 2);
      return;
    }
    const get = (f: FieldKey): number | null => {
      const c = col(f);
      if (!c) return null;
      const v = num(r[c]);
      if (v !== null && Number.isNaN(v)) {
        badNums.set(f, (badNums.get(f) ?? 0) + 1);
        return null;
      }
      if (v !== null && v < 0) throw new DatasetError([`Строка ${k + 2}: поле ${f} должно быть неотрицательным`]);
      if (v !== null) filled.set(f, (filled.get(f) ?? 0) + 1);
      return v;
    };
    const units = get('units_sold');
    if (units === null) {
      skipped++;
      return;
    }
    if (units < 0) throw new DatasetError([`Строка ${k + 2}: продажи должны быть неотрицательными`]);
    let s = bySku.get(sku);
    if (!s) {
      if (opts.maxSkus && bySku.size >= opts.maxSkus) {
        skipped++;
        return;
      }
      s = { name: col('name') ? r[col('name')!]?.trim() || null : null, category: col('category') ? r[col('category')!]?.trim() || null : null, acc: new Map() };
      bySku.set(sku, s);
    }
    const p = periodIndex(d, opts.period);
    let a = s.acc.get(p);
    if (!a) {
      a = { units: 0, revenue: null, priceSum: 0, priceN: 0, costSum: 0, costN: 0, stock: null, stockDate: -Infinity, ad_spend: null, ad_revenue: null, returns: null, leadSum: 0, leadN: 0, storage: null, inbound: null, action: null };
      s.acc.set(p, a);
    }
    const act = col('action_taken') ? r[col('action_taken')!]?.trim() : '';
    if (act) a.action = act.slice(0, 100);
    a.units += units;
    a.revenue = add(a.revenue, get('revenue'));
    const price = get('price');
    if (price !== null) {
      a.priceSum += price;
      a.priceN++;
    }
    const cost = get('unit_cost');
    if (cost !== null) {
      a.costSum += cost;
      a.costN++;
    }
    const stock = get('stock');
    if (stock !== null && d.getTime() >= a.stockDate) {
      a.stock = stock;
      a.stockDate = d.getTime();
    }
    a.ad_spend = add(a.ad_spend, get('ad_spend'));
    a.ad_revenue = add(a.ad_revenue, get('ad_revenue'));
    a.returns = add(a.returns, get('returns_units'));
    const lt = get('lead_time_days');
    if (lt !== null) {
      a.leadSum += lt;
      a.leadN++;
    }
    a.storage = add(a.storage, get('storage_cost'));
    a.inbound = add(a.inbound, get('inbound_units'));
  });
  if (badDates.length) warnings.push(`строки без распознаваемой даты пропущены (например, строки ${badDates.join(', ')})`);
  for (const [f, n] of badNums) warnings.push(`поле ${f}: ${n} нечисловых значений заменены на «нет данных»`);
  if (!bySku.size) throw new DatasetError(['после разбора не осталось ни одной строки с SKU, датой и продажами']);
  let first = Infinity;
  let last = -Infinity;
  const skus: SkuSeries[] = [];
  let gaps = 0;
  let expanded = 0;
  for (const [sku, s] of bySku) {
    const ps = [...s.acc.keys()].sort((x, y) => x - y);
    expanded += ps.at(-1)! - ps[0] + 1;
    if (expanded > 200_000) throw new DatasetError(['Слишком большой диапазон периодов после заполнения пропусков (лимит 200000)']);
    first = Math.min(first, ps[0]);
    last = Math.max(last, ps.at(-1)!);
    const out: PeriodRow[] = [];
    for (let p = ps[0]; p <= ps.at(-1)!; p++) {
      const a = s.acc.get(p);
      if (!a) {
        gaps++;
        out.push({ p, units: 0, revenue: null, price: null, cost: null, stock: null, ad_spend: null, ad_revenue: null, returns: null, lead_time_days: null, storage_cost: null, inbound: null, action: null, gap: true });
        continue;
      }
      const price = a.priceN ? a.priceSum / a.priceN : a.revenue !== null && a.units > 0 ? a.revenue / a.units : null;
      out.push({
        p,
        units: a.units,
        revenue: a.revenue,
        price,
        cost: a.costN ? a.costSum / a.costN : null,
        stock: a.stock,
        ad_spend: a.ad_spend,
        ad_revenue: a.ad_revenue,
        returns: a.returns,
        lead_time_days: a.leadN ? a.leadSum / a.leadN : null,
        storage_cost: a.storage,
        inbound: a.inbound,
        action: a.action,
        gap: false,
      });
    }
    skus.push({ sku, name: s.name, category: s.category, rows: out });
  }
  if (gaps) warnings.push(`${gaps} пропущенных периодов внутри истории SKU заполнены нулевыми продажами (остаток — «нет данных»)`);
  const used = rows.length - skipped;
  const present = FIELDS.filter((f) => mapping[f.key]).map((f) => f.key);
  const coverage: Partial<Record<FieldKey, number>> = {};
  for (const f of present) if (FIELDS.find((x) => x.key === f)!.kind === 'number') coverage[f] = used ? (filled.get(f) ?? 0) / used : 0;
  return {
    period: opts.period,
    mapping,
    skus: skus.sort((a, b) => a.sku.localeCompare(b.sku)),
    first_period: first,
    last_period: last,
    fields_present: present,
    coverage,
    stats: { rows: rows.length, rows_used: used, rows_skipped: skipped, skus: skus.length, periods: last - first + 1 },
    warnings,
  };
}
