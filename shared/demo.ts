import type { Alternative, Criterion, SessionState } from './types.ts';

export const DEMO_CRITERIA: Criterion[] = [
  {
    id: 'price',
    name: 'Цена',
    direction: 'min',
    weightUncertain: true,
    importance: 'high',
    valueHint: [450, 500],
  },
  {
    id: 'lead_time',
    name: 'Срок поставки',
    direction: 'min',
    weightUncertain: true,
    importance: 'high',
  },
  {
    id: 'defect_rate',
    name: 'Процент брака',
    direction: 'min',
    weightUncertain: true,
    importance: 'medium',
  },
  {
    id: 'min_lot',
    name: 'Минимальная партия',
    direction: 'min',
    weightUncertain: true,
    importance: 'low',
  },
];

/** Demo suppliers for «выбор поставщика» */
export const DEMO_ALTERNATIVES: Alternative[] = [
  {
    id: 'alpha',
    name: 'ООО «АльфаСнаб»',
    scores: {
      price: [470, 490],
      lead_time: 5,
      defect_rate: [1.2, 1.8],
      min_lot: 100,
    },
  },
  {
    id: 'beta',
    name: 'ИП Бета Логистик',
    scores: {
      price: [430, 460],
      lead_time: [7, 10],
      defect_rate: 0.8,
      min_lot: 200,
    },
  },
  {
    id: 'gamma',
    name: 'Гамма Трейд',
    scores: {
      price: 520,
      lead_time: 3,
      defect_rate: [2.0, 2.5],
      min_lot: 50,
    },
  },
  {
    id: 'delta',
    name: 'Дельта Партнёр',
    scores: {
      price: [450, 480],
      lead_time: 6,
      defect_rate: [1.0, 1.4],
      min_lot: [80, 120],
    },
  },
];

function coerceDirection(name: string, direction: Criterion['direction']): Criterion['direction'] {
  const n = name.toLowerCase();
  if (/брак|дефект|срок|время|парт|лот|издерж|риск|задерж|стоим/.test(n)) return 'min';
  if (/(^|[^а-яё])цен(а|ы|е|у)?([^а-яё]|$)/.test(n) || (n.includes('цен') && !n.includes('процент')))
    return 'min';
  if (/качеств|надёж|надеж|рейтинг|удобств|сервис/.test(n)) return 'max';
  return direction === 'max' ? 'max' : 'min';
}

export function applyDemoSuppliers(session: SessionState): SessionState {
  const criteria = (
    session.criteria.length >= 2 ? session.criteria : DEMO_CRITERIA
  ).map((c) => ({ ...c, direction: coerceDirection(c.name, c.direction) }));
  // Remap demo scores onto session criterion ids by name heuristics
  const mapped: Alternative[] = DEMO_ALTERNATIVES.map((alt) => {
    const scores: Alternative['scores'] = {};
    for (const c of criteria) {
      const key = guessDemoKey(c.name);
      if (key && alt.scores[key] != null) scores[c.id] = alt.scores[key];
      else if (alt.scores[c.id] != null) scores[c.id] = alt.scores[c.id];
    }
    return { ...alt, scores };
  });

  return {
    ...session,
    context: session.context || 'Выбор поставщика',
    criteria,
    alternatives: mapped,
    usedDemoData: true,
    missing: [],
    readyForAnalysis: true,
  };
}

function guessDemoKey(name: string): string | null {
  const n = name.toLowerCase();
  // Check defect before price: «процент» contains substring «цен»
  if (n.includes('брак') || n.includes('дефект') || n.includes('defect')) return 'defect_rate';
  if (n.includes('срок') || n.includes('время') || n.includes('lead') || n.includes('delivery'))
    return 'lead_time';
  if (n.includes('парт') || n.includes('лот') || n.includes('миним') || n.includes('batch'))
    return 'min_lot';
  if (
    n.includes('price') ||
    n.includes('стоим') ||
    /(^|[^а-яё])цен(а|ы|е|у|ой|ам)?([^а-яё]|$)/.test(n) ||
    n === 'цена' ||
    n.startsWith('цена ')
  )
    return 'price';
  if (n.includes('цен') && !n.includes('процент')) return 'price';
  return null;
}
