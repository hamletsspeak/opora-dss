import { z } from 'zod';
import { DecisionProblem } from '../problem/schema.js';

const ref = z.string().min(1).max(200);
const quote = z.string().max(2000).nullable().optional();
const number = z.number().nullable().optional();
const value = { value: number, lower: number, upper: number, unit: z.string().max(40).nullable().optional(), source_quote: quote };
// The extraction format already requested by formalizeMessages; never a new provider-specific prompt.
export const DraftResponse = z.strictObject({
  context: z.strictObject({ title: z.string().nullable().optional(), goal: z.string().nullable().optional(), domain: z.string().nullable().optional() }).optional(),
  alternatives: z.array(z.strictObject({ id: ref.optional(), name: ref, source_quote: quote })).max(500),
  criteria: z.array(z.strictObject({ id: ref.optional(), name: ref, direction: z.enum(['min', 'max']).nullable().optional(), direction_basis: z.enum(['explicit', 'domain_default', 'unknown']).optional(), unit: z.string().max(40).nullable().optional(), source_quote: quote })).max(200),
  evaluations: z.array(z.strictObject({ alternative: ref, criterion: ref, ...value })).max(100000),
  weights: z.array(z.strictObject({ criterion: ref, ...value })).max(200),
  weight_order: z.array(z.strictObject({ greater: ref, lesser: ref, source_quote: quote })).max(500),
  constraints: z.array(z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('threshold'), criterion: ref, op: z.enum(['<=', '<', '>=', '>', '==']), value: z.number(), source_quote: quote }),
    z.strictObject({ kind: z.literal('exclude'), alternative: ref, reason: z.string().optional(), source_quote: quote }),
  ])).max(500),
  unknowns: z.array(z.string()).max(5000).optional(),
  questions: z.array(z.string()).max(5000).optional(),
});
export type DraftResponse = z.infer<typeof DraftResponse>;

export const BenchmarkCase = z.strictObject({
  case_id: z.string().regex(/^[a-z0-9_-]{1,64}$/),
  family: z.string().min(1),
  tags: z.array(z.string()).min(1),
  text: z.string().min(1).max(20000),
  gold: DecisionProblem,
  // Gold-authored aliases, fixed before seeing model replies. No fuzzy matching.
  criterion_aliases: z.record(z.string(), z.array(z.string())).default({}),
  expected_run_valid: z.boolean(),
});
export type BenchmarkCase = z.infer<typeof BenchmarkCase>;
export const BenchmarkCorpus = z.strictObject({
  version: z.literal('1.0'),
  description: z.string(),
  cases: z.array(BenchmarkCase).min(1).max(100),
}).superRefine((v, ctx) => {
  if (new Set(v.cases.map((c) => c.case_id)).size !== v.cases.length)
    ctx.addIssue({ code: 'custom', message: 'case_id должны быть уникальными' });
});
