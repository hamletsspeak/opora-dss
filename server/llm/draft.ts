import {
  ID_PATTERN,
  SCHEMA_VERSION,
  type Alternative,
  type Constraint,
  type Criterion,
  type DecisionProblem,
  type Evaluation,
  type MethodSpec,
  type WeightItem,
} from '../../shared/problem/index.js';
import {
  extractNumbers,
  nameInText,
  normalizeText,
  quoteInText,
  slugId,
  traceNumber,
  type NumberTrace,
  type NumberTransform,
} from '../../shared/trace.js';

/** What the LLM is asked to return (see prompts.ts). Parsed leniently: types are coerced, not trusted. */
export interface DraftJson {
  context?: { title?: string | null; goal?: string | null; domain?: string | null };
  alternatives?: { id?: string; name?: string; source_quote?: string | null }[];
  criteria?: {
    id?: string;
    name?: string;
    direction?: string | null;
    direction_basis?: string | null;
    unit?: string | null;
    source_quote?: string | null;
  }[];
  evaluations?: {
    alternative?: string;
    criterion?: string;
    value?: unknown;
    lower?: unknown;
    upper?: unknown;
    unit?: string | null;
    source_quote?: string | null;
  }[];
  weights?: { criterion?: string; value?: unknown; lower?: unknown; upper?: unknown; unit?: string | null; source_quote?: string | null }[];
  weight_order?: { greater?: string; lesser?: string; source_quote?: string | null }[];
  constraints?: {
    kind?: string;
    criterion?: string;
    op?: string;
    value?: unknown;
    alternative?: string;
    reason?: string | null;
    source_quote?: string | null;
  }[];
  unknowns?: unknown[];
  questions?: unknown[];
}

export type DraftElement = 'context' | 'alternative' | 'criterion' | 'evaluation' | 'weight' | 'weight_order' | 'constraint';

export interface TraceEntry {
  path: string;
  element: DraftElement;
  status: 'accepted' | 'converted' | 'dropped';
  quote: string | null;
  quote_verified: boolean;
  numbers?: NumberTrace[];
  note?: string;
}

export interface UnknownField {
  path: string;
  reason: string;
  /** must be resolved explicitly by the user before confirmation */
  blocking: boolean;
}

export interface Hallucination {
  path: string;
  element: DraftElement;
  value: unknown;
  reason: string;
}

export interface DraftBuildResult {
  problem: DecisionProblem;
  trace: TraceEntry[];
  unknown_fields: UnknownField[];
  hallucinations: Hallucination[];
  questions: string[];
  normalization_log: string[];
  parse_issues: string[];
}

export interface DraftBuildOptions {
  problemId: string;
  method?: MethodSpec;
  iterations?: number;
  seed?: number;
  now?: string;
  llm?: Record<string, unknown>;
}

/** Deterministic, documented direction defaults; used only when the LLM gives none, and flagged. */
const DIRECTION_DICT: { re: RegExp; direction: 'min' | 'max' }[] = [
  { re: /цен|стоим|затрат|расход|издерж|бюджет|price|cost/i, direction: 'min' },
  { re: /срок|время|задерж|дн(ей|я)|lead|delay/i, direction: 'min' },
  { re: /брак|дефект|возврат|риск|ошиб|отказ|штраф|расстоян|партия|лот/i, direction: 'min' },
  { re: /качеств|надёжн|надежн|рейтинг|гарант|удовлетвор|сервис|выручк|прибыл|марж|отсрочк|доля|охват/i, direction: 'max' },
];

const OPS = new Set(['<=', '<', '>=', '>', '==']);

function str(x: unknown, max = 200): string | null {
  if (typeof x !== 'string') return null;
  const s = x.trim();
  return s ? s.slice(0, max) : null;
}

function numeric(x: unknown): number | null {
  if (typeof x === 'number') return Number.isFinite(x) ? x : null;
  if (typeof x === 'string' && x.trim()) {
    const n = Number(x.replace(/[ \u00a0]/g, '').replace(',', '.').replace(/%$/, ''));
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function arr<T>(x: unknown): T[] {
  return Array.isArray(x) ? (x as T[]) : [];
}

const TRANSFORM_TEXT: Record<NumberTransform, string> = {
  identity: '',
  percent_to_fraction: 'проценты → доли',
  fraction_to_percent: 'доли → проценты',
  thousands: '× 1000 (тыс.)',
  millions: '× 10⁶ (млн)',
};

export function buildProblemFromDraft(raw: unknown, sourceText: string, opts: DraftBuildOptions): DraftBuildResult {
  const d = (raw && typeof raw === 'object' ? raw : {}) as DraftJson;
  const text = normalizeText(sourceText);
  const nums = extractNumbers(sourceText);
  const trace: TraceEntry[] = [];
  const unknown: UnknownField[] = [];
  const halluc: Hallucination[] = [];
  const log: string[] = [];
  const issues: string[] = [];
  const quoteOk = (q: string | null) => quoteInText(q, text);

  // ---- alternatives
  const altIds = new Set<string>();
  const altRef = new Map<string, string>();
  const alternatives: Alternative[] = [];
  arr<NonNullable<DraftJson['alternatives']>[number]>(d.alternatives).forEach((a, i) => {
    const name = str(a?.name);
    const quote = str(a?.source_quote, 2000);
    if (!name) {
      issues.push(`alternatives[${i}]: нет названия — пропущено`);
      return;
    }
    const path = `alternatives[${name}]`;
    const qv = quoteOk(quote);
    if (!nameInText(name, text) && !qv) {
      halluc.push({ path, element: 'alternative', value: name, reason: 'название не найдено в тексте и цитата не подтверждена' });
      trace.push({ path, element: 'alternative', status: 'dropped', quote, quote_verified: false, note: 'не найдено в тексте' });
      return;
    }
    const key = normalizeText(name);
    if (altRef.has(key)) {
      issues.push(`${path}: дубликат — пропущен`);
      return;
    }
    const rid = str(a?.id, 64);
    const id = rid && ID_PATTERN.test(rid) && !altIds.has(rid) ? (altIds.add(rid), rid) : slugId(name, `a${i + 1}`, altIds);
    altRef.set(key, id);
    if (rid) altRef.set(normalizeText(rid), id);
    altRef.set(normalizeText(id), id);
    alternatives.push({
      alternative_id: id,
      name,
      provenance: 'llm_draft',
      ...(quote ? { source: { kind: 'text' as const, quote } } : {}),
    });
    trace.push({ path: `alternatives[${id}]`, element: 'alternative', status: 'accepted', quote, quote_verified: qv });
  });

  // ---- criteria
  const critIds = new Set<string>();
  const critRef = new Map<string, string>();
  const criteria: Criterion[] = [];
  arr<NonNullable<DraftJson['criteria']>[number]>(d.criteria).forEach((c, i) => {
    const name = str(c?.name);
    const quote = str(c?.source_quote, 2000);
    if (!name) {
      issues.push(`criteria[${i}]: нет названия — пропущено`);
      return;
    }
    const qv = quoteOk(quote);
    if (!nameInText(name, text) && !qv) {
      halluc.push({ path: `criteria[${name}]`, element: 'criterion', value: name, reason: 'критерий не найден в тексте и цитата не подтверждена' });
      trace.push({ path: `criteria[${name}]`, element: 'criterion', status: 'dropped', quote, quote_verified: false });
      return;
    }
    const key = normalizeText(name);
    if (critRef.has(key)) {
      issues.push(`criteria[${name}]: дубликат — пропущен`);
      return;
    }
    const rid = str(c?.id, 64);
    const id = rid && ID_PATTERN.test(rid) && !critIds.has(rid) ? (critIds.add(rid), rid) : slugId(name, `c${i + 1}`, critIds);
    critRef.set(key, id);
    if (rid) critRef.set(normalizeText(rid), id);
    critRef.set(normalizeText(id), id);
    let direction: 'min' | 'max';
    const given = c?.direction === 'min' || c?.direction === 'max' ? c.direction : null;
    const basis = c?.direction_basis;
    if (given) {
      direction = given;
      if (basis !== 'explicit')
        unknown.push({ path: `criteria[${id}].direction`, reason: `направление «${given}» принято по смыслу критерия, в тексте прямо не указано — подтвердите`, blocking: false });
    } else {
      const dict = DIRECTION_DICT.find((x) => x.re.test(name));
      if (dict) {
        direction = dict.direction;
        unknown.push({ path: `criteria[${id}].direction`, reason: `LLM не определила направление; предложено «${dict.direction}» по словарю — подтвердите`, blocking: false });
        log.push(`criteria[${id}].direction: «${dict.direction}» по словарю направлений (LLM вернула null)`);
      } else {
        direction = 'max';
        unknown.push({ path: `criteria[${id}].direction`, reason: 'направление неизвестно (временное значение «max») — укажите min или max', blocking: true });
      }
    }
    const unit = str(c?.unit, 40);
    criteria.push({
      criterion_id: id,
      name,
      direction,
      ...(unit ? { unit } : {}),
      provenance: 'llm_draft',
      ...(quote ? { source: { kind: 'text' as const, quote } } : {}),
    });
    trace.push({ path: `criteria[${id}]`, element: 'criterion', status: 'accepted', quote, quote_verified: qv });
  });

  const resolve = (ref: Map<string, string>, x: unknown) => {
    const s = str(x, 200);
    return s ? ref.get(normalizeText(s)) ?? null : null;
  };

  const traceAll = (vals: number[], allowed: NumberTransform[]) => {
    const out: NumberTrace[] = [];
    for (const v of vals) {
      const t = traceNumber(v, nums, allowed);
      if (!t) return { ok: false as const, bad: v };
      out.push(t);
    }
    return { ok: true as const, traces: out };
  };

  // ---- evaluations
  const evals = new Map<string, Evaluation>();
  const evalAllowed: NumberTransform[] = ['identity', 'thousands', 'millions', 'percent_to_fraction', 'fraction_to_percent'];
  arr<NonNullable<DraftJson['evaluations']>[number]>(d.evaluations).forEach((e) => {
    const a = resolve(altRef, e?.alternative);
    const c = resolve(critRef, e?.criterion);
    const quote = str(e?.source_quote, 2000);
    const path = `evaluations[${a ?? e?.alternative},${c ?? e?.criterion}]`;
    if (!a || !c) {
      halluc.push({ path, element: 'evaluation', value: e, reason: 'ссылка на неизвестную (или отброшенную) альтернативу/критерий' });
      trace.push({ path, element: 'evaluation', status: 'dropped', quote, quote_verified: quoteOk(quote) });
      return;
    }
    if (evals.has(`${a}\u0000${c}`)) {
      issues.push(`${path}: повторная оценка — оставлена первая`);
      return;
    }
    let value = numeric(e?.value);
    let lower = numeric(e?.lower);
    let upper = numeric(e?.upper);
    const given = [value, lower, upper].filter((x): x is number => x !== null);
    if (!given.length) return;
    const t = traceAll(given, evalAllowed);
    if (!t.ok) {
      halluc.push({ path, element: 'evaluation', value: t.bad, reason: `число ${t.bad} отсутствует в тексте` });
      trace.push({ path, element: 'evaluation', status: 'dropped', quote, quote_verified: quoteOk(quote), note: `число ${t.bad} не найдено в тексте` });
      return;
    }
    const converted = t.traces.filter((x) => x.transform !== 'identity');
    for (const x of converted) log.push(`${path}: ${x.source_value} → ${x.value} (${TRANSFORM_TEXT[x.transform]})`);
    if (lower !== null && upper !== null && lower > upper) {
      [lower, upper] = [upper, lower];
      log.push(`${path}: границы интервала переставлены (нижняя > верхней в ответе LLM)`);
    }
    if ((lower === null) !== (upper === null)) {
      unknown.push({ path, reason: 'указана только одна граница интервала — уточните вторую', blocking: true });
      value = value ?? lower ?? upper;
      lower = upper = null;
    }
    let ev: Evaluation['value'];
    if (lower !== null && upper !== null && lower < upper) {
      ev = { kind: 'interval', lower, upper, ...(value !== null && value >= lower && value <= upper ? { point: value } : {}) };
    } else {
      ev = { kind: 'exact', value: value ?? lower! };
    }
    const unit = str(e?.unit, 40);
    evals.set(`${a}\u0000${c}`, {
      alternative_id: a,
      criterion_id: c,
      value: ev,
      ...(unit ? { unit } : {}),
      provenance: 'llm_draft',
      ...(quote ? { source: { kind: 'text' as const, quote } } : {}),
    });
    trace.push({ path, element: 'evaluation', status: converted.length ? 'converted' : 'accepted', quote, quote_verified: quoteOk(quote), numbers: t.traces });
  });
  const evaluations: Evaluation[] = [];
  for (const a of alternatives)
    for (const c of criteria) {
      const ex = evals.get(`${a.alternative_id}\u0000${c.criterion_id}`);
      if (ex) evaluations.push(ex);
      else {
        evaluations.push({ alternative_id: a.alternative_id, criterion_id: c.criterion_id, value: { kind: 'missing', reason: 'не указано в тексте' }, provenance: 'llm_draft' });
        unknown.push({ path: `evaluations[${a.alternative_id},${c.criterion_id}]`, reason: `оценка «${a.name}» по «${c.name}» не указана в тексте`, blocking: false });
      }
    }

  // ---- weights
  const rawW = arr<NonNullable<DraftJson['weights']>[number]>(d.weights)
    .map((w) => ({ w, c: resolve(critRef, w?.criterion), value: numeric(w?.value), lower: numeric(w?.lower), upper: numeric(w?.upper), quote: str(w?.source_quote, 2000) }))
    .filter((x) => {
      if (!x.c) {
        halluc.push({ path: `weights[${x.w?.criterion}]`, element: 'weight', value: x.w, reason: 'вес для неизвестного критерия' });
        return false;
      }
      return x.value !== null || x.lower !== null || x.upper !== null;
    });
  const pointVals = rawW.map((x) => x.value).filter((v): v is number => v !== null);
  const allW = rawW.flatMap((x) => [x.value, x.lower, x.upper]).filter((v): v is number => v !== null);
  const sumPoint = pointVals.reduce((s, v) => s + v, 0);
  const percent =
    allW.some((v) => v > 1) &&
    allW.every((v) => v >= 0 && v <= 100) &&
    (rawW.some((x) => x.w?.unit === 'percent') || Math.abs(sumPoint - 100) <= 1e-4 || sourceText.includes('%'));
  if (percent) log.push(`weights: заданы в процентах — переведены в доли делением на 100 (единицы, а не нормировка)`);
  const wItems = new Map<string, WeightItem>();
  for (const x of rawW) {
    const path = `weights[${x.c}]`;
    if (wItems.has(x.c!)) {
      issues.push(`${path}: повторный вес — оставлен первый`);
      continue;
    }
    const vals = [x.value, x.lower, x.upper].filter((v): v is number => v !== null);
    const t = traceAll(vals, ['identity', 'percent_to_fraction', 'fraction_to_percent']);
    if (!t.ok) {
      halluc.push({ path, element: 'weight', value: t.bad, reason: `число ${t.bad} отсутствует в тексте` });
      trace.push({ path, element: 'weight', status: 'dropped', quote: x.quote, quote_verified: quoteOk(x.quote) });
      continue;
    }
    const conv = (v: number | null) => (v === null ? null : percent ? v / 100 : v);
    const value = conv(x.value);
    const lower = conv(x.lower);
    const upper = conv(x.upper);
    if ([value, lower, upper].some((v) => v !== null && v > 1)) {
      issues.push(`${path}: вес больше 1 без указания процентов — пропущен`);
      unknown.push({ path, reason: 'вес задан в непонятной шкале (не доля и не проценты) — задайте вручную', blocking: false });
      continue;
    }
    wItems.set(x.c!, {
      criterion_id: x.c!,
      ...(value !== null ? { value } : {}),
      ...(lower !== null ? { lower } : {}),
      ...(upper !== null ? { upper } : {}),
      provenance: 'llm_draft',
      ...(x.quote ? { source: { kind: 'text' as const, quote: x.quote } } : {}),
    });
    trace.push({ path, element: 'weight', status: percent ? 'converted' : 'accepted', quote: x.quote, quote_verified: quoteOk(x.quote), numbers: t.traces });
  }
  const items: WeightItem[] = criteria.map((c) => {
    const w = wItems.get(c.criterion_id);
    if (w) return w;
    unknown.push({ path: `weights[${c.criterion_id}]`, reason: `вес «${c.name}» не указан — будет неопределённым в [0; 1]`, blocking: false });
    return { criterion_id: c.criterion_id };
  });
  const exactAll = items.length > 0 && items.every((w) => typeof w.value === 'number' && w.lower == null && w.upper == null);
  if (exactAll) {
    const s = items.reduce((acc, w) => acc + (w.value as number), 0);
    if (Math.abs(s - 1) > 1e-6) {
      log.push(`weights: сумма точных весов = ${Number(s.toFixed(6))} ≠ 1; веса НЕ нормированы автоматически`);
      unknown.push({ path: 'weights', reason: `сумма весов ${Number(s.toFixed(6))} ≠ 1 — исправьте веса или задайте интервалы`, blocking: true });
    }
  }

  // ---- ordinal relations
  const ordinal: { greater: string; lesser: string }[] = [];
  for (const o of arr<NonNullable<DraftJson['weight_order']>[number]>(d.weight_order)) {
    const g = resolve(critRef, o?.greater);
    const l = resolve(critRef, o?.lesser);
    const quote = str(o?.source_quote, 2000);
    const path = `weights.ordinal[${o?.greater}>${o?.lesser}]`;
    if (!g || !l || g === l) {
      halluc.push({ path, element: 'weight_order', value: o, reason: 'неизвестный критерий или отношение с самим собой' });
      continue;
    }
    if (ordinal.some((x) => x.greater === g && x.lesser === l)) continue;
    ordinal.push({ greater: g, lesser: l });
    trace.push({ path: `weights.ordinal[${g}>${l}]`, element: 'weight_order', status: 'accepted', quote, quote_verified: quoteOk(quote) });
  }

  // ---- constraints
  const constraints: Constraint[] = [];
  const cIds = new Set<string>();
  arr<NonNullable<DraftJson['constraints']>[number]>(d.constraints).forEach((k, i) => {
    const quote = str(k?.source_quote, 2000);
    if (k?.kind === 'exclude') {
      const a = resolve(altRef, k.alternative);
      if (!a) {
        halluc.push({ path: `constraints[${i}]`, element: 'constraint', value: k, reason: 'исключение неизвестной альтернативы' });
        return;
      }
      const reason = str(k.reason, 500);
      constraints.push({ constraint_id: slugId(`exclude_${a}`, `k${i + 1}`, cIds), type: 'exclude', alternative_id: a, ...(reason ? { reason } : {}) });
      trace.push({ path: `constraints[exclude ${a}]`, element: 'constraint', status: 'accepted', quote, quote_verified: quoteOk(quote) });
      return;
    }
    const c = resolve(critRef, k?.criterion);
    const v = numeric(k?.value);
    const op = typeof k?.op === 'string' && OPS.has(k.op) ? (k.op as '<=') : null;
    if (!c || v === null || !op) {
      issues.push(`constraints[${i}]: неполное ограничение (критерий/оператор/значение) — пропущено`);
      return;
    }
    const t = traceNumber(v, nums, ['identity', 'thousands', 'millions', 'percent_to_fraction', 'fraction_to_percent']);
    if (!t) {
      halluc.push({ path: `constraints[${c} ${op} ${v}]`, element: 'constraint', value: v, reason: `число ${v} отсутствует в тексте` });
      return;
    }
    if (t.transform !== 'identity') log.push(`constraints[${c}]: ${t.source_value} → ${v} (${TRANSFORM_TEXT[t.transform]})`);
    constraints.push({
      constraint_id: slugId(`${c}_${op === '<=' || op === '<' ? 'max' : op === '==' ? 'eq' : 'min'}`, `k${i + 1}`, cIds),
      type: 'threshold',
      criterion_id: c,
      op,
      value: v,
      provenance: 'llm_draft',
      ...(quote ? { description: quote.slice(0, 500) } : {}),
    });
    trace.push({ path: `constraints[${c} ${op} ${v}]`, element: 'constraint', status: t.transform === 'identity' ? 'accepted' : 'converted', quote, quote_verified: quoteOk(quote), numbers: [t] });
  });

  // ---- context, questions
  const ctx = d.context && typeof d.context === 'object' ? d.context : {};
  const firstSentence = sourceText.trim().split(/(?<=[.!?])\s|\n/)[0]?.slice(0, 120) || 'Задача выбора';
  const title = str(ctx.title, 300) ?? firstSentence;
  const goal = str(ctx.goal, 2000);
  const domain = str(ctx.domain, 100);
  const questions = arr<unknown>(d.questions).map((q) => str(q, 500)).filter((q): q is string => !!q);
  const llmUnknowns = arr<unknown>(d.unknowns).map((q) => str(q, 500)).filter((q): q is string => !!q);
  if (alternatives.length < 2) unknown.push({ path: 'alternatives', reason: 'в тексте найдено меньше двух альтернатив', blocking: true });
  if (criteria.length < 1) unknown.push({ path: 'criteria', reason: 'в тексте не найдено ни одного критерия', blocking: true });

  const mUncertain = evaluations.some((e) => e.value.kind === 'interval' || e.value.kind === 'scenarios');
  const mode = `${mUncertain ? 'MU' : 'MF'}_${exactAll ? 'WF' : 'WU'}` as const;

  const problem: DecisionProblem = {
    schema_version: SCHEMA_VERSION,
    problem_id: opts.problemId,
    context: { title, ...(goal ? { goal } : {}), ...(domain ? { domain } : {}) },
    alternatives,
    criteria,
    evaluations,
    weights: { normalization: 'sum_to_one', items, ...(ordinal.length ? { ordinal } : {}) },
    constraints,
    method: opts.method ?? { id: 'topsis', params: { normalization: 'minmax' } },
    uncertainty: { mode, iterations: opts.iterations ?? 2000, seed: opts.seed ?? 42 },
    metadata: {
      origin: 'llm',
      status: 'draft',
      created_at: opts.now ?? new Date().toISOString(),
      source: 'текст пользователя',
      ...(opts.llm ? { llm: opts.llm as DecisionProblem['metadata']['llm'] } : {}),
      notes: [
        'Черновик сформирован LLM и проверен на трассируемость к тексту; требует подтверждения пользователем.',
        ...llmUnknowns.map((u) => `LLM: неизвестно — ${u}`),
      ].slice(0, 100),
      draft: {
        unknown_fields: unknown,
        hallucinations: halluc.length,
      },
    },
  };
  return { problem, trace, unknown_fields: unknown, hallucinations: halluc, questions, normalization_log: log, parse_issues: issues };
}

/** Extract a JSON object from a model reply (tolerates ```json fences and leading prose). */
export function parseJsonReply(text: string): { ok: true; value: unknown } | { ok: false; error: string } {
  const t = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  try {
    return { ok: true, value: JSON.parse(t) };
  } catch {
    const a = t.indexOf('{');
    const b = t.lastIndexOf('}');
    if (a >= 0 && b > a) {
      try {
        return { ok: true, value: JSON.parse(t.slice(a, b + 1)) };
      } catch {
        /* fallthrough */
      }
    }
    return { ok: false, error: 'ответ модели не является корректным JSON' };
  }
}
