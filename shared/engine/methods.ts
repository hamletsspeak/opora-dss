import type { Direction, MethodId } from '../problem/schema.js';

export interface ResolvedMethod {
  id: MethodId;
  normalization: 'minmax' | 'vector';
  v: number | null;
}

export const METHOD_VERSIONS: Record<MethodId, string> = {
  wsm: '1.0',
  topsis: '1.0',
  vikor: '1.0',
};

export const METHOD_TITLES: Record<MethodId, string> = {
  wsm: 'Взвешенная сумма (WSM)',
  topsis: 'TOPSIS',
  vikor: 'VIKOR',
};

export interface MethodEvaluation {
  /** Method score per alternative (WSM/TOPSIS: higher is better; VIKOR Q: lower is better). */
  scores: number[];
  higherIsBetter: boolean;
  /** Benefit-oriented normalized matrix (minmax) or vector-normalized matrix. */
  normalized: number[][];
  /** Method-specific per-alternative quantities for the trace. */
  detail: Record<string, number[]>;
}

/**
 * Linear min–max normalization to a benefit scale [0, 1]:
 *   max: r = (x − min) / (max − min);  min: r = (max − x) / (max − min).
 * A constant column (max = min) does not discriminate and is set to r = 1 for everyone.
 */
export function normalizeMinMax(matrix: number[][], directions: Direction[]): number[][] {
  const n = matrix.length;
  const m = directions.length;
  const out: number[][] = Array.from({ length: n }, () => new Array<number>(m));
  for (let j = 0; j < m; j++) {
    let lo = Infinity;
    let hi = -Infinity;
    for (let i = 0; i < n; i++) {
      const x = matrix[i][j];
      if (x < lo) lo = x;
      if (x > hi) hi = x;
    }
    const span = hi - lo;
    for (let i = 0; i < n; i++) {
      if (!(span > 0)) out[i][j] = 1;
      else out[i][j] = directions[j] === 'max' ? (matrix[i][j] - lo) / span : (hi - matrix[i][j]) / span;
    }
  }
  return out;
}

/** Vector normalization r = x / ‖x_j‖₂ (direction handled by the ideal point in TOPSIS). */
export function normalizeVector(matrix: number[][], nCrit: number): number[][] {
  const n = matrix.length;
  const out: number[][] = Array.from({ length: n }, () => new Array<number>(nCrit));
  for (let j = 0; j < nCrit; j++) {
    let ss = 0;
    for (let i = 0; i < n; i++) ss += matrix[i][j] * matrix[i][j];
    const norm = Math.sqrt(ss);
    for (let i = 0; i < n; i++) out[i][j] = norm > 0 ? matrix[i][j] / norm : 0;
  }
  return out;
}

/** WSM: S_i = Σ_j w_j r_ij on the min–max benefit scale. */
export function scoreWsm(norm: number[][], w: number[]): number[] {
  return norm.map((row) => {
    let s = 0;
    for (let j = 0; j < row.length; j++) s += w[j] * row[j];
    return s;
  });
}

/**
 * TOPSIS: v_ij = w_j r_ij; ideal A⁺ / anti-ideal A⁻ per column; C_i = d⁻ / (d⁺ + d⁻).
 * `benefitDirections` = all "max" for the min–max benefit scale, real directions for vector scale.
 */
export function scoreTopsis(
  norm: number[][],
  w: number[],
  benefitDirections: Direction[],
): { scores: number[]; dPlus: number[]; dMinus: number[] } {
  const n = norm.length;
  const m = w.length;
  const ideal = new Array<number>(m);
  const anti = new Array<number>(m);
  for (let j = 0; j < m; j++) {
    let lo = Infinity;
    let hi = -Infinity;
    for (let i = 0; i < n; i++) {
      const v = w[j] * norm[i][j];
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    if (benefitDirections[j] === 'max') {
      ideal[j] = hi;
      anti[j] = lo;
    } else {
      ideal[j] = lo;
      anti[j] = hi;
    }
  }
  const dPlus: number[] = [];
  const dMinus: number[] = [];
  const scores: number[] = [];
  for (let i = 0; i < n; i++) {
    let p = 0;
    let q = 0;
    for (let j = 0; j < m; j++) {
      const v = w[j] * norm[i][j];
      p += (v - ideal[j]) ** 2;
      q += (v - anti[j]) ** 2;
    }
    const dp = Math.sqrt(p);
    const dm = Math.sqrt(q);
    dPlus.push(dp);
    dMinus.push(dm);
    // All alternatives identical on every weighted criterion → no preference information.
    scores.push(dp + dm > 0 ? dm / (dp + dm) : 0.5);
  }
  return { scores, dPlus, dMinus };
}

/**
 * VIKOR on the min–max benefit scale (equivalent to the raw-value formulation):
 * S_i = Σ w_j (f*_j − r_ij)/(f*_j − f⁻_j), R_i = max_j(...), Q_i = v·S̃_i + (1−v)·R̃_i. Lower Q is better.
 * The acceptance conditions C1/C2 of the original method are not applied: ranking is by Q.
 */
export function scoreVikor(
  norm: number[][],
  w: number[],
  v: number,
): { Q: number[]; S: number[]; R: number[] } {
  const n = norm.length;
  const m = w.length;
  const fStar = new Array<number>(m).fill(-Infinity);
  const fMinus = new Array<number>(m).fill(Infinity);
  for (let i = 0; i < n; i++)
    for (let j = 0; j < m; j++) {
      if (norm[i][j] > fStar[j]) fStar[j] = norm[i][j];
      if (norm[i][j] < fMinus[j]) fMinus[j] = norm[i][j];
    }
  const S: number[] = [];
  const R: number[] = [];
  for (let i = 0; i < n; i++) {
    let s = 0;
    let r = 0;
    for (let j = 0; j < m; j++) {
      const span = fStar[j] - fMinus[j];
      const d = span > 0 ? (w[j] * (fStar[j] - norm[i][j])) / span : 0;
      s += d;
      if (d > r) r = d;
    }
    S.push(s);
    R.push(r);
  }
  const sMin = Math.min(...S);
  const sMax = Math.max(...S);
  const rMin = Math.min(...R);
  const rMax = Math.max(...R);
  const Q = S.map((s, i) => {
    const a = sMax - sMin > 0 ? (s - sMin) / (sMax - sMin) : 0;
    const b = rMax - rMin > 0 ? (R[i] - rMin) / (rMax - rMin) : 0;
    return v * a + (1 - v) * b;
  });
  return { Q, S, R };
}

export function evaluateMethod(
  method: ResolvedMethod,
  matrix: number[][],
  directions: Direction[],
  weights: number[],
): MethodEvaluation {
  if (method.id === 'topsis' && method.normalization === 'vector') {
    const norm = normalizeVector(matrix, directions.length);
    const t = scoreTopsis(norm, weights, directions);
    return {
      scores: t.scores,
      higherIsBetter: true,
      normalized: norm,
      detail: { d_plus: t.dPlus, d_minus: t.dMinus },
    };
  }
  const norm = normalizeMinMax(matrix, directions);
  if (method.id === 'wsm') {
    return { scores: scoreWsm(norm, weights), higherIsBetter: true, normalized: norm, detail: {} };
  }
  if (method.id === 'topsis') {
    const t = scoreTopsis(norm, weights, directions.map(() => 'max'));
    return {
      scores: t.scores,
      higherIsBetter: true,
      normalized: norm,
      detail: { d_plus: t.dPlus, d_minus: t.dMinus },
    };
  }
  const vk = scoreVikor(norm, weights, method.v ?? 0.5);
  return { scores: vk.Q, higherIsBetter: false, normalized: norm, detail: { S: vk.S, R: vk.R } };
}
