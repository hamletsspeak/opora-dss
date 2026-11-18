import { SCHEMA_VERSION, type DecisionProblem } from '../shared/problem/index.js';

export function clone<T>(x: T): T {
  return JSON.parse(JSON.stringify(x)) as T;
}

/** Small exact problem builder: matrix rows = alternatives, columns = criteria. */
export function exactProblem(opts: {
  matrix: number[][];
  directions: ('min' | 'max')[];
  weights: number[];
  method?: DecisionProblem['method'];
  altIds?: string[];
}): DecisionProblem {
  const altIds = opts.altIds ?? opts.matrix.map((_, i) => `a${i + 1}`);
  const critIds = opts.directions.map((_, j) => `c${j + 1}`);
  return {
    schema_version: SCHEMA_VERSION,
    problem_id: 'test',
    context: { title: 'test' },
    alternatives: altIds.map((id) => ({ alternative_id: id, name: id })),
    criteria: critIds.map((id, j) => ({ criterion_id: id, name: id, direction: opts.directions[j] })),
    evaluations: opts.matrix.flatMap((row, i) =>
      row.map((v, j) => ({
        alternative_id: altIds[i],
        criterion_id: critIds[j],
        value: { kind: 'exact' as const, value: v },
      })),
    ),
    weights: {
      normalization: 'sum_to_one',
      items: critIds.map((id, j) => ({ criterion_id: id, value: opts.weights[j] })),
    },
    constraints: [],
    method: opts.method ?? { id: 'wsm' },
    uncertainty: { mode: 'MF_WF', iterations: 200, seed: 3 },
    metadata: {},
  };
}
