import type { DraftJson } from './draft.js';

/**
 * Rule-based baseline formalizer (no LLM). Recognises a small dictionary of criteria and lines like
 * «Альфа: цена 480–500 руб., срок 5 дней, брак 1,5%». It is intentionally simple: it serves as the
 * offline mock provider and as the lower baseline in the LLM benchmark.
 */
interface DictCriterion {
  id: string;
  name: string;
  re: RegExp;
  direction: 'min' | 'max';
  unit?: string;
}

const DICT: DictCriterion[] = [
  { id: 'payment_delay', name: 'Отсрочка платежа', re: /отсрочк/i, direction: 'max', unit: 'дн.' },
  { id: 'warranty', name: 'Гарантия', re: /гаранти/i, direction: 'max', unit: 'мес.' },
  { id: 'defect_rate', name: 'Доля брака', re: /брак|дефект/i, direction: 'min', unit: '%' },
  { id: 'min_lot', name: 'Минимальная партия', re: /парти|\bлот|мин(имальный|\.)?\s*заказ/i, direction: 'min', unit: 'шт.' },
  { id: 'rating', name: 'Рейтинг', re: /рейтинг/i, direction: 'max' },
  { id: 'quality', name: 'Качество', re: /качеств/i, direction: 'max' },
  { id: 'reliability', name: 'Надёжность', re: /надёжн|надежн/i, direction: 'max' },
  { id: 'distance', name: 'Расстояние', re: /расстояни|\bкм\b/i, direction: 'min', unit: 'км' },
  { id: 'lead_time', name: 'Срок поставки', re: /срок|\bдн(ей|я|и)?\b|\bдень\b|недел|доставк/i, direction: 'min', unit: 'дн.' },
  { id: 'price', name: 'Цена', re: /цен[аыеуо]|стоимост|руб|₽|\bдорож|\bдешев/i, direction: 'min', unit: 'руб.' },
];

const NUM = String.raw`\d+(?:[.,]\d+)?`;
const VALUE_RE = new RegExp(`(${NUM})(?:\\s*[–—-]\\s*(${NUM}))?`);
const toNum = (s: string) => Number(s.replace(',', '.'));
/** list separators; a comma between digits is a decimal comma */
const SEP = /;|,(?!\d)/;

function matchCriterion(s: string): DictCriterion | undefined {
  return DICT.find((c) => c.re.test(s));
}

export function heuristicDraft(text: string): DraftJson {
  const criteria = new Map<string, NonNullable<DraftJson['criteria']>[number]>();
  const alternatives: NonNullable<DraftJson['alternatives']> = [];
  const evaluations: NonNullable<DraftJson['evaluations']> = [];
  const weights: NonNullable<DraftJson['weights']> = [];
  const order: NonNullable<DraftJson['weight_order']> = [];
  const constraints: NonNullable<DraftJson['constraints']> = [];
  const addCrit = (c: DictCriterion, quote: string) => {
    if (!criteria.has(c.id))
      criteria.set(c.id, { id: c.id, name: c.name, direction: c.direction, direction_basis: 'domain_default', unit: c.unit ?? null, source_quote: quote });
  };

  const lines = text.split(/\n/).map((l) => l.trim()).filter(Boolean);
  const altLine = /^(?:[-•*–]\s*|\d+[.)]\s*)?([^:\n]{1,60}?)\s*[:—]\s*(.+)$/;
  for (const line of lines) {
    const m = line.match(altLine);
    if (!m) continue;
    const name = m[1].trim().replace(/^«|»$/g, '');
    if (/критери|вес|важн|огранич|бюджет|задача|цель/i.test(name)) continue;
    const segs = m[2].split(SEP).map((s) => s.trim()).filter(Boolean);
    const found: typeof evaluations = [];
    for (const seg of segs) {
      const c = matchCriterion(seg);
      const v = seg.match(VALUE_RE);
      if (!c || !v) continue;
      addCrit(c, seg);
      const lo = toNum(v[1]);
      const hi = v[2] !== undefined ? toNum(v[2]) : null;
      found.push(
        hi !== null && hi !== lo
          ? { alternative: name, criterion: c.id, value: null, lower: Math.min(lo, hi), upper: Math.max(lo, hi), unit: c.unit ?? null, source_quote: seg }
          : { alternative: name, criterion: c.id, value: lo, lower: null, upper: null, unit: c.unit ?? null, source_quote: seg },
      );
    }
    if (found.length) {
      alternatives.push({ name, source_quote: name });
      evaluations.push(...found);
    }
  }

  const sentences = text.split(/(?<=[.!?])\s+|\n/).map((s) => s.trim()).filter(Boolean);
  for (const s of sentences) {
    if (/вес|важност/i.test(s) && s.includes('%')) {
      for (const part of s.split(SEP)) {
        const c = matchCriterion(part);
        const p = part.match(new RegExp(`(${NUM})\\s*%`));
        if (c && p) {
          addCrit(c, part.trim());
          weights.push({ criterion: c.id, value: toNum(p[1]), unit: 'percent', source_quote: part.trim() });
        }
      }
    }
    const imp = s.match(/^(.*?)\s+(?:важнее|приоритетнее|значимее)\s+(.*)$/i);
    if (imp) {
      const g = matchCriterion(imp[1]);
      const l = matchCriterion(imp[2]);
      if (g && l && g.id !== l.id) {
        addCrit(g, s);
        addCrit(l, s);
        order.push({ greater: g.id, lesser: l.id, source_quote: s });
      }
    }
    const lim = s.match(new RegExp(`(не дороже|не более|не выше|не больше|до|бюджет[^\\d]{0,20}|не менее|не ниже|минимум)\\s*(${NUM})`, 'i'));
    if (lim) {
      const c = matchCriterion(s);
      if (c) {
        const op = /не менее|не ниже|минимум/i.test(lim[1]) ? '>=' : '<=';
        if (!/^до$/i.test(lim[1]) || /бюджет|огранич|допуст/i.test(s)) {
          addCrit(c, s);
          constraints.push({ kind: 'threshold', criterion: c.id, op, value: toNum(lim[2]), source_quote: lim[0] });
        }
      }
    }
    const ex = s.match(/(?:исключ\w*|не рассматрива\w*)\s+(.+)/i);
    if (ex) {
      const a = alternatives.find((x) => x.name && ex[1].toLowerCase().includes(x.name.toLowerCase()));
      if (a) constraints.push({ kind: 'exclude', alternative: a.name, reason: s, source_quote: s });
    }
    if (/критери|учитыва|важн/i.test(s))
      for (const part of s.split(new RegExp(`${SEP.source}| и `))) {
        const c = matchCriterion(part);
        if (c) addCrit(c, part.trim());
      }
  }

  const unknowns: string[] = [];
  for (const a of alternatives)
    for (const c of criteria.values())
      if (!evaluations.some((e) => e.alternative === a.name && e.criterion === c.id)) unknowns.push(`оценка ${a.name} по критерию ${c.name}`);
  if (!weights.length) unknowns.push('веса критериев');
  return {
    context: { title: sentences[0]?.slice(0, 120) ?? null, goal: null, domain: null },
    alternatives,
    criteria: [...criteria.values()],
    evaluations,
    weights,
    weight_order: order,
    constraints,
    unknowns,
    questions: unknowns.length ? [`Уточните: ${unknowns.slice(0, 3).join('; ')}`] : [],
  };
}
