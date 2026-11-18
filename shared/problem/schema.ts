import { z } from 'zod';

/**
 * Formal contract `DecisionProblem` v1.0 — the only input accepted by the MCDA engine.
 * Structural rules live here; semantic rules (sums, bounds, completeness) live in `validate.ts`.
 */
export const SCHEMA_VERSION = '1.0' as const;

export const ID_PATTERN = /^[\p{L}\p{N}_.:-]{1,64}$/u;

const Id = z
  .string()
  .regex(ID_PATTERN, 'идентификатор: 1–64 символа, буквы/цифры/._:-');

const FiniteNumber = z.number().refine(Number.isFinite, 'число должно быть конечным');

export const PROVENANCE = [
  'user_input',
  'imported',
  'historical',
  'computed',
  'expert',
  'scenario',
  'llm_draft',
  'synthetic',
] as const;
export const Provenance = z.enum(PROVENANCE);
export type Provenance = z.infer<typeof Provenance>;

export const SourceRef = z.strictObject({
  kind: z.enum(['text', 'dataset', 'model', 'manual']),
  ref: z.string().max(500).optional(),
  quote: z.string().max(2000).optional(),
});
export type SourceRef = z.infer<typeof SourceRef>;

export const Direction = z.enum(['min', 'max']);
export type Direction = z.infer<typeof Direction>;

export const VALUE_TYPES = [
  'real',
  'integer',
  'percent',
  'ratio',
  'currency',
  'duration',
  'score',
] as const;

export const Criterion = z.strictObject({
  criterion_id: Id,
  name: z.string().min(1).max(200),
  description: z.string().max(2000).optional(),
  direction: Direction,
  value_type: z.enum(VALUE_TYPES).optional(),
  unit: z.string().max(40).nullable().optional(),
  range: z
    .strictObject({
      min: FiniteNumber.nullable().optional(),
      max: FiniteNumber.nullable().optional(),
    })
    .optional(),
  missing_policy: z.enum(['reject', 'worst_observed']).optional(),
  provenance: Provenance.optional(),
  source: SourceRef.optional(),
});
export type Criterion = z.infer<typeof Criterion>;

export const Alternative = z.strictObject({
  alternative_id: Id,
  name: z.string().min(1).max(200),
  description: z.string().max(2000).optional(),
  provenance: Provenance.optional(),
  source: SourceRef.optional(),
});
export type Alternative = z.infer<typeof Alternative>;

export const ExactValue = z.strictObject({
  kind: z.literal('exact'),
  value: FiniteNumber,
});
export const IntervalValue = z.strictObject({
  kind: z.literal('interval'),
  lower: FiniteNumber,
  upper: FiniteNumber,
  distribution: z.enum(['uniform', 'triangular']).optional(),
  mode: FiniteNumber.optional(),
  point: FiniteNumber.optional(),
});
export const Scenario = z.strictObject({
  label: z.string().max(200).optional(),
  value: FiniteNumber,
  probability: FiniteNumber,
});
export const ScenarioValue = z.strictObject({
  kind: z.literal('scenarios'),
  scenarios: z.array(Scenario).min(1).max(100),
  point: FiniteNumber.optional(),
});
export const MissingValue = z.strictObject({
  kind: z.literal('missing'),
  reason: z.string().max(500).optional(),
});
export const EvaluationValue = z.discriminatedUnion('kind', [
  ExactValue,
  IntervalValue,
  ScenarioValue,
  MissingValue,
]);
export type EvaluationValue = z.infer<typeof EvaluationValue>;
export type IntervalValue = z.infer<typeof IntervalValue>;
export type ScenarioValue = z.infer<typeof ScenarioValue>;

export const Evaluation = z.strictObject({
  alternative_id: Id,
  criterion_id: Id,
  value: EvaluationValue,
  unit: z.string().max(40).nullable().optional(),
  provenance: Provenance.optional(),
  source: SourceRef.optional(),
  assumptions: z.array(z.string().max(500)).max(50).optional(),
  note: z.string().max(1000).optional(),
});
export type Evaluation = z.infer<typeof Evaluation>;

export const WeightItem = z.strictObject({
  criterion_id: Id,
  /** Exact (point) weight; used as-is in W-fixed mode, never re-normalized. */
  value: FiniteNumber.nullable().optional(),
  /** Bounds used in W-uncertain mode. */
  lower: FiniteNumber.nullable().optional(),
  upper: FiniteNumber.nullable().optional(),
  provenance: Provenance.optional(),
  source: SourceRef.optional(),
});
export type WeightItem = z.infer<typeof WeightItem>;

export const WeightScenario = z.strictObject({
  label: z.string().max(200).optional(),
  probability: FiniteNumber,
  values: z.record(Id, FiniteNumber),
});
export type WeightScenario = z.infer<typeof WeightScenario>;

export const OrdinalConstraint = z.strictObject({
  greater: Id,
  lesser: Id,
});

export const Weights = z.strictObject({
  normalization: z.literal('sum_to_one'),
  items: z.array(WeightItem).max(200),
  ordinal: z.array(OrdinalConstraint).max(500).optional(),
  scenarios: z.array(WeightScenario).max(200).optional(),
});
export type Weights = z.infer<typeof Weights>;

export const ThresholdConstraint = z.strictObject({
  constraint_id: Id,
  type: z.literal('threshold'),
  criterion_id: Id,
  op: z.enum(['<=', '<', '>=', '>', '==']),
  value: FiniteNumber,
  description: z.string().max(500).optional(),
  provenance: Provenance.optional(),
  source: SourceRef.optional(),
});
export const ExcludeConstraint = z.strictObject({
  constraint_id: Id,
  type: z.literal('exclude'),
  alternative_id: Id,
  reason: z.string().max(500).optional(),
  provenance: Provenance.optional(),
  source: SourceRef.optional(),
});
export const Constraint = z.discriminatedUnion('type', [
  ThresholdConstraint,
  ExcludeConstraint,
]);
export type Constraint = z.infer<typeof Constraint>;
export type ThresholdConstraint = z.infer<typeof ThresholdConstraint>;

export const METHOD_IDS = ['wsm', 'topsis', 'vikor'] as const;
export const MethodId = z.enum(METHOD_IDS);
export type MethodId = z.infer<typeof MethodId>;

export const MethodSpec = z.strictObject({
  id: MethodId,
  params: z
    .strictObject({
      normalization: z.enum(['minmax', 'vector']).optional(),
      v: FiniteNumber.optional(),
    })
    .optional(),
});
export type MethodSpec = z.infer<typeof MethodSpec>;

export const MODE_IDS = ['MF_WF', 'MU_WF', 'MF_WU', 'MU_WU'] as const;
export const ModeId = z.enum(MODE_IDS);
export type ModeId = z.infer<typeof ModeId>;

export const MSettings = z.strictObject({
  default_interval_distribution: z.enum(['uniform', 'triangular']).optional(),
  point_rule: z.enum(['expected_value', 'explicit_only']).optional(),
});
export const WSettings = z.strictObject({
  sampler: z
    .enum(['polytope_rejection', 'polytope_hit_and_run', 'dirichlet', 'scenarios'])
    .optional(),
  dirichlet_alpha: z.record(Id, FiniteNumber).optional(),
  max_attempts_per_sample: z.number().int().min(10).max(1_000_000).optional(),
  hit_and_run_burn_in: z.number().int().min(0).max(100_000).optional(),
  hit_and_run_thinning: z.number().int().min(1).max(1000).optional(),
});

export const UncertaintySettings = z.strictObject({
  mode: ModeId.optional(),
  iterations: z.number().int().min(1).max(200_000).optional(),
  seed: z.number().int().min(0).max(4_294_967_295).optional(),
  m: MSettings.optional(),
  w: WSettings.optional(),
  top_k: z.number().int().min(1).max(100).optional(),
  tie_tolerance: z.number().min(0).max(1).optional(),
});
export type UncertaintySettings = z.infer<typeof UncertaintySettings>;

export const LlmCallMeta = z.looseObject({
  provider: z.string(),
  model: z.string(),
  model_version: z.string().nullable().optional(),
  request_id: z.string().optional(),
  temperature: z.number().optional(),
  max_tokens: z.number().optional(),
  started_at: z.string().optional(),
  latency_ms: z.number().optional(),
  status: z.string().optional(),
  fallback_from: z.string().nullable().optional(),
});

export const Metadata = z.looseObject({
  source: z.string().max(500).optional(),
  author: z.string().max(200).optional(),
  created_at: z.string().max(40).optional(),
  origin: z.enum(['manual', 'llm', 'import', 'ecommerce', 'legacy_session', 'example']).optional(),
  status: z.enum(['draft', 'confirmed']).optional(),
  confirmed_at: z.string().max(40).optional(),
  llm: LlmCallMeta.optional(),
  notes: z.array(z.string().max(1000)).max(100).optional(),
});

export const Context = z.strictObject({
  title: z.string().max(300),
  goal: z.string().max(2000).optional(),
  domain: z.string().max(100).optional(),
  decision_date: z.string().max(40).optional(),
});

export const DecisionProblem = z.strictObject({
  schema_version: z.literal(SCHEMA_VERSION),
  problem_id: Id,
  context: Context,
  alternatives: z.array(Alternative).max(500),
  criteria: z.array(Criterion).max(200),
  evaluations: z.array(Evaluation).max(100_000),
  weights: Weights,
  constraints: z.array(Constraint).max(500),
  method: MethodSpec,
  uncertainty: UncertaintySettings,
  metadata: Metadata,
});
export type DecisionProblem = z.infer<typeof DecisionProblem>;

/** JSON Schema (draft 2020-12) generated from the zod contract. */
export function decisionProblemJsonSchema(): Record<string, unknown> {
  const schema = z.toJSONSchema(DecisionProblem, { target: 'draft-2020-12' }) as Record<
    string,
    unknown
  >;
  return {
    $id: `https://opora-dss/schemas/decision-problem/${SCHEMA_VERSION}`,
    title: 'DecisionProblem',
    ...schema,
  };
}
