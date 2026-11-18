import type { SessionState } from '../types.js';
import {
  ID_PATTERN,
  SCHEMA_VERSION,
  type DecisionProblem,
  type MethodId,
  type ModeId,
} from './schema.js';

const LEVEL: Record<string, number> = { high: 3, medium: 2, low: 1 };

function safeId(raw: string, fallback: string, log: string[]): string {
  if (ID_PATTERN.test(raw)) return raw;
  const fixed = raw.replace(/[^\p{L}\p{N}_.:-]+/gu, '_').slice(0, 64) || fallback;
  log.push(`идентификатор «${raw}» заменён на «${fixed}»`);
  return fixed;
}

/**
 * Converts the chat `SessionState` (Klar v0 UI) into a `DecisionProblem`.
 * Mapping is explicit and reported:
 *  - number → exact evaluation; [lo, hi] → interval (distribution from settings, default uniform);
 *  - exact weight with weightUncertain=false → fixed weight; any other criterion → uncertain weight;
 *  - importance high > medium > low → ordinal weight constraints between uncertain weights.
 */
export function sessionToProblem(
  session: SessionState,
  opts: { problemId?: string; method?: MethodId; iterations?: number; seed?: number } = {},
): { problem: DecisionProblem; log: string[] } {
  const log: string[] = [];
  const prov = session.usedDemoData ? ('synthetic' as const) : ('user_input' as const);
  const critIds = session.criteria.map((c, i) => safeId(c.id, `c${i + 1}`, log));
  const altIds = session.alternatives.map((a, i) => safeId(a.id, `a${i + 1}`, log));
  const criteria = session.criteria.map((c, i) => ({
    criterion_id: critIds[i],
    name: c.name,
    direction: c.direction,
    provenance: prov,
  }));
  const alternatives = session.alternatives.map((a, i) => ({
    alternative_id: altIds[i],
    name: a.name,
    provenance: prov,
  }));
  const evaluations: DecisionProblem['evaluations'] = [];
  session.alternatives.forEach((a, i) => {
    session.criteria.forEach((c, j) => {
      const v = a.scores[c.id];
      if (v == null) {
        evaluations.push({
          alternative_id: altIds[i],
          criterion_id: critIds[j],
          value: { kind: 'missing', reason: 'оценка не указана в сессии' },
          provenance: prov,
        });
      } else if (Array.isArray(v)) {
        const [lo, hi] = v[0] <= v[1] ? v : [v[1], v[0]];
        evaluations.push({
          alternative_id: altIds[i],
          criterion_id: critIds[j],
          value: { kind: 'interval', lower: lo, upper: hi },
          provenance: prov,
        });
      } else {
        evaluations.push({
          alternative_id: altIds[i],
          criterion_id: critIds[j],
          value: { kind: 'exact', value: v },
          provenance: prov,
        });
      }
    });
  });
  const items = session.criteria.map((c, j) => {
    if (typeof c.weight === 'number' && !c.weightUncertain) {
      return { criterion_id: critIds[j], value: c.weight, provenance: prov };
    }
    if (typeof c.weight === 'number') {
      log.push(`вес «${c.name}» = ${c.weight} помечен как неточный: используется как точечная оценка в интервале [0; 1]`);
      return { criterion_id: critIds[j], value: c.weight, lower: 0, upper: 1, provenance: prov };
    }
    return { criterion_id: critIds[j] };
  });
  const ordinal: { greater: string; lesser: string }[] = [];
  session.criteria.forEach((a, i) => {
    session.criteria.forEach((b, k) => {
      if (i === k) return;
      const la = LEVEL[a.importance];
      const lb = LEVEL[b.importance];
      const aUncertain = !(typeof a.weight === 'number' && !a.weightUncertain);
      const bUncertain = !(typeof b.weight === 'number' && !b.weightUncertain);
      if (la && lb && la > lb && aUncertain && bUncertain) ordinal.push({ greater: critIds[i], lesser: critIds[k] });
    });
  });
  if (ordinal.length) log.push(`важность критериев преобразована в ${ordinal.length} порядковых ограничений на веса (high ≥ medium ≥ low)`);
  const anyInterval = evaluations.some((e) => e.value.kind === 'interval');
  const anyUncertainW = items.some((w) => !('value' in w) || w.value === undefined || 'lower' in w);
  const mode: ModeId = `${anyInterval ? 'MU' : 'MF'}_${anyUncertainW ? 'WU' : 'WF'}` as ModeId;
  log.push(`режим выбран по данным сессии: ${mode}`);
  const problem: DecisionProblem = {
    schema_version: SCHEMA_VERSION,
    problem_id: opts.problemId ?? 'klar-session',
    context: { title: session.context?.trim() || 'Выбор без названия' },
    alternatives,
    criteria,
    evaluations,
    weights: { normalization: 'sum_to_one', items, ordinal },
    constraints: [],
    method: { id: opts.method ?? 'topsis', params: opts.method === 'topsis' || !opts.method ? { normalization: 'minmax' } : undefined },
    uncertainty: {
      mode,
      iterations: opts.iterations ?? 2000,
      seed: opts.seed ?? 42,
      m: { default_interval_distribution: 'uniform', point_rule: 'expected_value' },
      w: { sampler: session.criteria.length > 6 ? 'polytope_hit_and_run' : 'polytope_rejection' },
    },
    metadata: {
      origin: 'legacy_session',
      source: session.usedDemoData ? 'Klar: демо-поставщики (синтетические данные)' : 'Klar: сессия диалога',
      status: 'confirmed',
    },
  };
  return { problem, log };
}
