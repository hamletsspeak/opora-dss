import { z } from 'zod';
import { HttpError } from '../http/middleware.js';

const Id = z.string().min(1).max(64);
const ModeId = z.enum(['MF_WF', 'MU_WF', 'MF_WU', 'MU_WU']);
const MethodSpec = z.strictObject({
  id: z.enum(['wsm', 'topsis', 'vikor']),
  params: z.strictObject({ normalization: z.enum(['minmax', 'vector']).optional(), v: z.number().min(0).max(1).optional() }).optional(),
});

export const OverridesSchema = z.strictObject({
  iterations: z.number().int().min(1).max(200_000).optional(),
  seed: z.number().int().min(0).max(4294967295).optional(),
  method: MethodSpec.optional(),
  m: z
    .strictObject({
      default_interval_distribution: z.enum(['uniform', 'triangular']).optional(),
      point_rule: z.enum(['expected_value', 'explicit_only']).optional(),
    })
    .optional(),
  w: z
    .strictObject({
      sampler: z.enum(['polytope_rejection', 'polytope_hit_and_run', 'dirichlet', 'scenarios']).optional(),
      dirichlet_alpha: z.record(Id, z.number().positive()).optional(),
      max_attempts_per_sample: z.number().int().min(1).max(1_000_000).optional(),
      hit_and_run_burn_in: z.number().int().min(0).max(100_000).optional(),
      hit_and_run_thinning: z.number().int().min(1).max(1000).optional(),
    })
    .optional(),
  top_k: z.number().int().min(1).max(50).optional(),
  tie_tolerance: z.number().min(0).max(1).optional(),
});

export const OverridesWithMode = OverridesSchema.extend({ mode: ModeId.optional() });

export const ValidateBody = z.strictObject({
  problem: z.unknown(),
  for_run: z.boolean().optional(),
  overrides: OverridesWithMode.optional(),
});

export const FormalizeBody = z.strictObject({
  text: z.string().min(1).max(20_000),
  provider: z.string().max(32).optional(),
  allow_fallback: z.boolean().optional(),
  domain: z.string().max(100).optional(),
});

export const ConfirmBody = z.strictObject({
  problem: z.unknown(),
  resolved: z.array(z.string().max(300)).max(5000).optional(),
});

export const ImportBody = z.strictObject({
  format: z.enum(['csv', 'json']),
  content: z.string().min(1),
  title: z.string().max(300).optional(),
  delimiter: z.enum([',', ';', '\t']).optional(),
});

const SourceSchema = z
  .strictObject({
    name: z.string().max(200).optional(),
    format: z.enum(['json', 'csv', 'manual', 'ecommerce', 'example', 'llm']).optional(),
    sha256: z.string().regex(/^[0-9a-f]{64}$/).optional(),
    rows: z.number().int().min(0).optional(),
  })
  .nullable()
  .optional();

export const RunBody = z.strictObject({
  problem: z.unknown(),
  modes: z.union([z.literal('all'), z.array(ModeId).min(1).max(4)]).optional(),
  overrides: OverridesSchema.optional(),
  extra_methods: z.array(MethodSpec).max(4).optional(),
  sensitivity: z.boolean().optional(),
  label: z.string().max(200).nullable().optional(),
  source: SourceSchema,
});

export const BatchBody = z.strictObject({
  items: z
    .array(z.strictObject({ name: z.string().min(1).max(200), format: z.enum(['csv', 'json']), content: z.string().min(1) }))
    .min(1)
    .max(100),
  modes: z.union([z.literal('all'), z.array(ModeId).min(1).max(4)]).optional(),
  overrides: OverridesSchema.optional(),
  extra_methods: z.array(MethodSpec).max(4).optional(),
  sensitivity: z.boolean().optional(),
  label: z.string().max(200).nullable().optional(),
});

export const SensitivityBody = z.discriminatedUnion('analysis', [
  z.strictObject({ analysis: z.literal('report'), problem: z.unknown(), overrides: OverridesWithMode.optional(), max_cells: z.number().int().min(0).max(2000).optional() }),
  z.strictObject({
    analysis: z.literal('weight'),
    problem: z.unknown(),
    overrides: OverridesWithMode.optional(),
    criterion_id: Id,
    from: z.number().min(0).max(1).optional(),
    to: z.number().min(0).max(1).optional(),
    step: z.number().min(0.0005).max(0.5).optional(),
    precision: z.number().min(1e-12).max(0.1).optional(),
  }),
  z.strictObject({
    analysis: z.literal('evaluation'),
    problem: z.unknown(),
    overrides: OverridesWithMode.optional(),
    alternative_id: Id,
    criterion_id: Id,
    from: z.number().optional(),
    to: z.number().optional(),
    steps: z.number().int().min(4).max(2000).optional(),
  }),
  z.strictObject({ analysis: z.literal('pair'), problem: z.unknown(), overrides: OverridesWithMode.optional(), a: Id, b: Id, steps: z.number().int().min(2).max(100).optional() }),
  z.strictObject({
    analysis: z.literal('scale'),
    problem: z.unknown(),
    overrides: OverridesWithMode.optional(),
    target: z.enum(['m', 'w', 'both']),
    factors: z.array(z.number().min(0).max(10)).min(1).max(30),
    mode: ModeId.optional(),
  }),
]);

export const ExplainBody = z.strictObject({ provider: z.string().max(32).optional(), allow_fallback: z.boolean().optional(), mode: ModeId.optional() });
export const HealthBody = z.strictObject({ provider: z.string().max(32) });

export function parseBody<T extends z.ZodType>(schema: T, body: unknown): z.infer<T> {
  const r = schema.safeParse(body ?? {});
  if (!r.success)
    throw new HttpError(
      400,
      'Некорректные параметры запроса',
      'bad_request',
      r.error.issues.slice(0, 20).map((i) => ({ path: i.path.join('.'), message: i.message })),
    );
  return r.data;
}
