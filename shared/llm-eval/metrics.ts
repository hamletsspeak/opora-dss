import type { DecisionProblem } from '../problem/schema.js';
import type { BenchmarkCase, DraftResponse } from './schema.js';

export const METRICS_VERSION = 'facts-1.0';
export const TOLERANCE = { absolute: 1e-6, relative: 1e-6 };
export const GROUPS = ['alternatives', 'criteria', 'directions', 'units', 'evaluations', 'weights', 'weight_order', 'constraints'] as const;
export type Group = typeof GROUPS[number];
export interface Fact { group: Group; key: string; values: (string | number)[] }
const norm = (s: string) => s.normalize('NFKC').toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ').trim();

function resolver(c: BenchmarkCase) {
  const aliases = new Map<string, string>();
  for (const x of c.gold.criteria) {
    const name = norm(x.name);
    for (const a of [x.name, ...(c.criterion_aliases[x.criterion_id] ?? [])]) aliases.set(norm(a), name);
  }
  return (name: string) => aliases.get(norm(name)) ?? norm(name);
}

export function goldFacts(c: BenchmarkCase): Fact[] { return problemFacts(c.gold, c); }

export function problemFacts(p: DecisionProblem, c: BenchmarkCase): Fact[] {
  const criterion = resolver(c);
  const alternatives = new Map(p.alternatives.map((a) => [a.alternative_id, norm(a.name)]));
  const criteria = new Map(p.criteria.map((x) => [x.criterion_id, criterion(x.name)]));
  const a = (id: string) => alternatives.get(id) ?? `unknown:${id}`;
  const k = (id: string) => criteria.get(id) ?? `unknown:${id}`;
  const facts: Fact[] = [];
  const add = (group: Group, key: string, ...values: (string | number)[]) => facts.push({ group, key, values });
  p.alternatives.forEach((x) => add('alternatives', a(x.alternative_id)));
  p.criteria.forEach((x) => {
    add('criteria', k(x.criterion_id));
    add('directions', k(x.criterion_id), x.direction);
    if (x.unit) add('units', k(x.criterion_id), x.unit);
  });
  p.evaluations.forEach((x) => {
    const key = JSON.stringify([a(x.alternative_id), k(x.criterion_id)]);
    if (x.value.kind === 'exact') add('evaluations', key, 'exact', x.value.value);
    if (x.value.kind === 'interval') add('evaluations', key, 'interval', x.value.lower, x.value.upper);
  });
  p.weights.items.forEach((x) => {
    if (x.value != null) add('weights', k(x.criterion_id) + ':value', x.value);
    if (x.lower != null) add('weights', k(x.criterion_id) + ':lower', x.lower);
    if (x.upper != null) add('weights', k(x.criterion_id) + ':upper', x.upper);
  });
  p.weights.ordinal?.forEach((x) => add('weight_order', k(x.greater), k(x.lesser)));
  p.constraints.forEach((x) => {
    if (x.type === 'exclude') add('constraints', 'exclude', a(x.alternative_id));
    else add('constraints', k(x.criterion_id), x.op, x.value);
  });
  return facts;
}

/** Score raw extraction before the traceability filter drops invented facts. IDs are resolved by name. */
export function draftFacts(d: DraftResponse, c: BenchmarkCase): Fact[] {
  const criterion = resolver(c);
  const alternatives = new Map(d.alternatives.flatMap((a) => [[norm(a.id ?? a.name), norm(a.name)], [norm(a.name), norm(a.name)]] as [string, string][]));
  const criteria = new Map(d.criteria.flatMap((x) => [[norm(x.id ?? x.name), criterion(x.name)], [norm(x.name), criterion(x.name)]] as [string, string][]));
  const a = (id: string) => alternatives.get(norm(id)) ?? `unknown:${norm(id)}`;
  const k = (id: string) => criteria.get(norm(id)) ?? `unknown:${norm(id)}`;
  const facts: Fact[] = [];
  const add = (group: Group, key: string, ...values: (string | number)[]) => facts.push({ group, key, values });
  d.alternatives.forEach((x) => add('alternatives', norm(x.name)));
  d.criteria.forEach((x) => {
    add('criteria', criterion(x.name));
    if (x.direction) add('directions', criterion(x.name), x.direction);
    if (x.unit) add('units', criterion(x.name), x.unit);
  });
  d.evaluations.forEach((x) => {
    const key = JSON.stringify([a(x.alternative), k(x.criterion)]);
    if (x.lower != null || x.upper != null) {
      add('evaluations', key, 'interval', x.lower ?? 'missing', x.upper ?? 'missing');
      if (x.value != null) add('evaluations', key + ':point', 'point', x.value);
    } else if (x.value != null) add('evaluations', key, 'exact', x.value);
  });
  d.weights.forEach((x) => {
    // Only explicit percent units are converted; no inference from other weights or their sum.
    const scale = x.unit === 'percent' ? 0.01 : 1;
    for (const field of ['value', 'lower', 'upper'] as const)
      if (x[field] != null) add('weights', k(x.criterion) + ':' + field, x[field]! * scale);
  });
  d.weight_order.forEach((x) => add('weight_order', k(x.greater), k(x.lesser)));
  d.constraints.forEach((x) => {
    if (x.kind === 'exclude') add('constraints', 'exclude', a(x.alternative));
    else add('constraints', k(x.criterion), x.op, x.value);
  });
  return facts;
}

export interface Counts { tp: number; fp: number; fn: number }
export function scores(c: Counts) {
  const precision = c.tp + c.fp ? c.tp / (c.tp + c.fp) : null;
  const recall = c.tp + c.fn ? c.tp / (c.tp + c.fn) : null;
  const f1 = 2 * c.tp + c.fp + c.fn ? 2 * c.tp / (2 * c.tp + c.fp + c.fn) : null;
  return { ...c, precision, recall, f1 };
}

export function compareFacts(predicted: Fact[], expected: Fact[], tolerance = TOLERANCE) {
  const equal = (a: Fact, b: Fact) => a.group === b.group && a.key === b.key && a.values.length === b.values.length && a.values.every((x, i) => {
    const y = b.values[i];
    return typeof x === 'number' && typeof y === 'number'
      ? Math.abs(x - y) <= tolerance.absolute + tolerance.relative * Math.abs(y) : x === y;
  });
  const unmatched = [...expected];
  const extra: Fact[] = [];
  const matched: Fact[] = [];
  for (const f of predicted) {
    const i = unmatched.findIndex((g) => equal(f, g));
    if (i < 0) extra.push(f);
    else { matched.push(f); unmatched.splice(i, 1); }
  }
  const by_group = Object.fromEntries(GROUPS.map((group) => [group, scores({ tp: matched.filter((f) => f.group === group).length, fp: extra.filter((f) => f.group === group).length, fn: unmatched.filter((f) => f.group === group).length })])) as Record<Group, ReturnType<typeof scores>>;
  return {
    overall: scores({ tp: matched.length, fp: extra.length, fn: unmatched.length }), by_group,
    exact_match: !extra.length && !unmatched.length,
    unsupported_facts: extra.filter((f) => !['directions', 'units'].includes(f.group)),
    extra, missing: unmatched,
  };
}
