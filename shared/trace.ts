/**
 * Traceability checks for LLM drafts: every number, name and quote must be found in the
 * source text. Pure functions, shared by the formalizer and the LLM benchmark.
 */

export function normalizeText(s: string): string {
  return s
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[\u2010-\u2015\u2212]/g, '-')
    .replace(/[«»„“”"']/g, '"')
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const NUM_RE = /-?\d{1,3}(?:[ \u00a0]\d{3})+(?:[.,]\d+)?|-?\d+(?:[.,]\d+)?/g;

export function parseNumberToken(tok: string): number | null {
  const n = Number(tok.replace(/[ \u00a0]/g, '').replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

/** Numbers literally present in the text (handles `1 200`, `1,5`, `450–500`). */
export function extractNumbers(text: string): number[] {
  const out: number[] = [];
  for (const m of text.replace(/(\d)\s*[–—-]\s*(\d)/g, '$1 – $2').matchAll(NUM_RE)) {
    const v = parseNumberToken(m[0]);
    if (v === null) continue;
    out.push(v);
    // `1 200` is ambiguous: a spaced thousand or two adjacent numbers
    if (/[ \u00a0]/.test(m[0]))
      for (const part of m[0].split(/[ \u00a0]/)) {
        const p = parseNumberToken(part);
        if (p !== null) out.push(p);
      }
    // `450–500` must not yield -500
    if (v < 0) out.push(-v);
  }
  return out;
}

export type NumberTransform = 'identity' | 'percent_to_fraction' | 'fraction_to_percent' | 'thousands' | 'millions';

export interface NumberTrace {
  value: number;
  source_value: number;
  transform: NumberTransform;
}

const TRANSFORMS: { t: NumberTransform; f: (src: number) => number }[] = [
  { t: 'identity', f: (x) => x },
  { t: 'percent_to_fraction', f: (x) => x / 100 },
  { t: 'fraction_to_percent', f: (x) => x * 100 },
  { t: 'thousands', f: (x) => x * 1000 },
  { t: 'millions', f: (x) => x * 1e6 },
];

function close(a: number, b: number): boolean {
  return Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));
}

/** Finds a source number that yields `value` by identity or a unit conversion; null = not traceable. */
export function traceNumber(value: number, sourceNumbers: number[], allowed?: NumberTransform[]): NumberTrace | null {
  for (const { t, f } of TRANSFORMS) {
    if (allowed && !allowed.includes(t)) continue;
    for (const s of sourceNumbers) if (close(f(s), value)) return { value, source_value: s, transform: t };
  }
  return null;
}

export function quoteInText(quote: string | null | undefined, normalizedText: string): boolean {
  if (!quote) return false;
  const q = normalizeText(quote).replace(/^["\s.…]+|["\s.…]+$/g, '');
  return q.length >= 2 && normalizedText.includes(q);
}

const GENERIC = new Set([
  'поставщик', 'поставщика', 'вариант', 'варианта', 'альтернатива', 'компания', 'фирма', 'ооо', 'ип', 'ао', 'пао',
  'зао', 'магазин', 'товар', 'проект', 'опция', 'option', 'supplier', 'vendor', 'company',
]);

function tokens(s: string): string[] {
  return normalizeText(s)
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

/** A name is present if it occurs verbatim, or a distinctive token (≥4 chars, stem match) does. */
export function nameInText(name: string, normalizedText: string): boolean {
  const n = normalizeText(name).replace(/"/g, '');
  if (n && normalizedText.replace(/"/g, '').includes(n)) return true;
  const textTokens = tokens(normalizedText);
  return tokens(name)
    .filter((t) => t.length >= 4 && !GENERIC.has(t))
    .some((t) => {
      const stem = t.length > 5 ? t.slice(0, t.length - 2) : t;
      return textTokens.some((x) => x.startsWith(stem));
    });
}

export function slugId(name: string, fallback: string, taken: Set<string>): string {
  let base = normalizeText(name)
    .replace(/[^\p{L}\p{N}]+/gu, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 48);
  if (!base) base = fallback;
  let id = base;
  for (let k = 2; taken.has(id); k++) id = `${base}_${k}`;
  taken.add(id);
  return id;
}
