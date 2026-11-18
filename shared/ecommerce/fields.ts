import { normalizeText } from '../trace.js';

/**
 * Canonical fields of an SKU history table. The dataset structure is not fixed: any column can be
 * mapped to a field; synonyms are only suggestions shown to the user.
 */
export type FieldKey =
  | 'sku'
  | 'date'
  | 'name'
  | 'category'
  | 'units_sold'
  | 'revenue'
  | 'price'
  | 'unit_cost'
  | 'stock'
  | 'ad_spend'
  | 'ad_revenue'
  | 'returns_units'
  | 'lead_time_days'
  | 'storage_cost'
  | 'inbound_units'
  | 'action_taken';

export interface FieldDef {
  key: FieldKey;
  title: string;
  unit: string | null;
  kind: 'id' | 'date' | 'text' | 'number';
  required: boolean;
  aggregate: 'sum' | 'mean' | 'last' | 'first';
  description: string;
  synonyms: string[];
}

export const FIELDS: FieldDef[] = [
  { key: 'sku', title: 'Артикул (SKU)', unit: null, kind: 'id', required: true, aggregate: 'first', description: 'Идентификатор товарной позиции', synonyms: ['sku', 'артикул', 'product_id', 'item_id', 'id товара', 'код товара', 'offer_id', 'nm_id', 'item', 'товар id'] },
  { key: 'date', title: 'Дата / период', unit: null, kind: 'date', required: true, aggregate: 'first', description: 'Дата наблюдения или начало периода (YYYY-MM-DD, DD.MM.YYYY, YYYY-MM)', synonyms: ['date', 'дата', 'период', 'месяц', 'неделя', 'day', 'week', 'month', 'period', 'report_date'] },
  { key: 'name', title: 'Наименование', unit: null, kind: 'text', required: false, aggregate: 'first', description: 'Название товара', synonyms: ['name', 'наименование', 'название', 'product_name', 'title', 'товар'] },
  { key: 'category', title: 'Категория', unit: null, kind: 'text', required: false, aggregate: 'first', description: 'Категория товара', synonyms: ['category', 'категория', 'группа', 'subject', 'предмет'] },
  { key: 'units_sold', title: 'Продажи, шт.', unit: 'шт.', kind: 'number', required: true, aggregate: 'sum', description: 'Проданные единицы за период', synonyms: ['units_sold', 'units', 'qty', 'quantity', 'sales_qty', 'продано', 'продано, шт', 'продажи, шт', 'продажи шт', 'количество', 'кол-во', 'заказано, шт', 'выкупы, шт'] },
  { key: 'revenue', title: 'Выручка', unit: 'руб.', kind: 'number', required: false, aggregate: 'sum', description: 'Выручка за период', synonyms: ['revenue', 'sales', 'выручка', 'выручка, руб', 'сумма продаж', 'gmv', 'оборот'] },
  { key: 'price', title: 'Цена продажи', unit: 'руб.', kind: 'number', required: false, aggregate: 'mean', description: 'Средняя цена продажи единицы', synonyms: ['price', 'цена', 'цена, руб', 'цена продажи', 'avg_price', 'средняя цена'] },
  { key: 'unit_cost', title: 'Себестоимость единицы', unit: 'руб.', kind: 'number', required: false, aggregate: 'mean', description: 'Закупочная цена / себестоимость единицы', synonyms: ['unit_cost', 'cost', 'cogs', 'себестоимость', 'себестоимость, руб', 'закупочная цена', 'purchase_price'] },
  { key: 'stock', title: 'Остаток на конец периода', unit: 'шт.', kind: 'number', required: false, aggregate: 'last', description: 'Складской остаток на конец периода', synonyms: ['stock', 'inventory', 'on_hand', 'остаток', 'остаток, шт', 'остаток на конец', 'остаток на конец, шт', 'склад', 'stock_end'] },
  { key: 'ad_spend', title: 'Расходы на рекламу', unit: 'руб.', kind: 'number', required: false, aggregate: 'sum', description: 'Рекламные расходы за период', synonyms: ['ad_spend', 'ads', 'marketing', 'реклама', 'реклама, руб', 'расходы на рекламу', 'рекламный бюджет', 'spend'] },
  { key: 'ad_revenue', title: 'Выручка с рекламы (атрибутированная)', unit: 'руб.', kind: 'number', required: false, aggregate: 'sum', description: 'Выручка, атрибутированная рекламе рекламной системой', synonyms: ['ad_revenue', 'attributed_revenue', 'выручка с рекламы', 'выручка с рекламы, руб', 'рекламная выручка'] },
  { key: 'returns_units', title: 'Возвраты, шт.', unit: 'шт.', kind: 'number', required: false, aggregate: 'sum', description: 'Возвращённые единицы за период', synonyms: ['returns', 'returns_units', 'возвраты', 'возвраты, шт', 'возврат'] },
  { key: 'lead_time_days', title: 'Срок поставки, дн.', unit: 'дн.', kind: 'number', required: false, aggregate: 'mean', description: 'Фактический срок поставки (по поставкам периода)', synonyms: ['lead_time', 'lead_time_days', 'срок поставки', 'срок поставки, дн', 'время поставки'] },
  { key: 'storage_cost', title: 'Затраты на хранение', unit: 'руб.', kind: 'number', required: false, aggregate: 'sum', description: 'Затраты на хранение и логистику за период', synonyms: ['storage_cost', 'storage', 'хранение', 'затраты на хранение', 'логистика', 'logistics_cost'] },
  { key: 'inbound_units', title: 'Поступило, шт.', unit: 'шт.', kind: 'number', required: false, aggregate: 'sum', description: 'Поступления (закупки) за период', synonyms: ['inbound', 'receipts', 'поступило', 'поступления', 'приход', 'закуплено'] },
  { key: 'action_taken', title: 'Фактическое действие (журнал)', unit: null, kind: 'text', required: false, aggregate: 'last', description: 'Управленческое действие, фактически выполненное в начале периода (id или название действия)', synonyms: ['action', 'action_taken', 'действие', 'решение', 'управленческое действие'] },
];

export const FIELD_BY_KEY = Object.fromEntries(FIELDS.map((f) => [f.key, f])) as Record<FieldKey, FieldDef>;

export type ColumnMapping = Partial<Record<FieldKey, string | null>>;

function norm(s: string): string {
  return normalizeText(s).replace(/[_\-.]+/g, ' ').replace(/\s+/g, ' ').trim();
}

/** Suggests a column for every field by exact/synonym/prefix match. Each column is used at most once. */
export function suggestMapping(headers: string[]): ColumnMapping {
  const out: ColumnMapping = {};
  const used = new Set<string>();
  const nh = headers.map((h) => ({ h, n: norm(h) }));
  for (const f of FIELDS) {
    const syn = [f.key, ...f.synonyms].map(norm);
    const exact = nh.find((x) => !used.has(x.h) && syn.includes(x.n));
    const loose = exact ?? nh.find((x) => !used.has(x.h) && syn.some((s) => s.length >= 4 && (x.n.startsWith(s) || x.n.includes(` ${s}`))));
    out[f.key] = loose?.h ?? null;
    if (loose) used.add(loose.h);
  }
  return out;
}

export function mappingErrors(mapping: ColumnMapping, headers: string[]): string[] {
  const errs: string[] = [];
  const seen = new Map<string, FieldKey>();
  for (const f of FIELDS) {
    const col = mapping[f.key];
    if (!col) {
      if (f.required) errs.push(`не сопоставлено обязательное поле «${f.title}»`);
      continue;
    }
    if (!headers.includes(col)) errs.push(`поле «${f.title}»: столбца «${col}» нет в файле`);
    if (seen.has(col)) errs.push(`столбец «${col}» сопоставлен двум полям: ${seen.get(col)} и ${f.key}`);
    seen.set(col, f.key);
  }
  return errs;
}
