/**
 * Ranking with explicit tie handling.
 *
 * Scores within `tol` of the first (best) score of a group are tied. A tie group occupying
 * positions a..b receives the average (fractional) rank (a+b)/2, and every member receives
 * 1/(b−a+1) of each position a..b. This equals uniform random tie-breaking in expectation
 * and never favours an alternative by its index.
 */
export interface Ranked {
  /** indices from best to worst (stable by index inside tie groups — display only) */
  order: number[];
  /** fractional rank per alternative (1 = best) */
  rank: number[];
  /** 1-based first and last position of the tie group of each alternative */
  groupStart: number[];
  groupEnd: number[];
}

export function rankScores(scores: ArrayLike<number>, higherIsBetter: boolean, tol: number): Ranked {
  const n = scores.length;
  const order = Array.from({ length: n }, (_, i) => i);
  order.sort((a, b) => {
    const d = higherIsBetter ? scores[b] - scores[a] : scores[a] - scores[b];
    return d !== 0 ? d : a - b;
  });
  const rank = new Array<number>(n);
  const groupStart = new Array<number>(n);
  const groupEnd = new Array<number>(n);
  let p = 0;
  while (p < n) {
    const anchor = scores[order[p]];
    let q = p;
    while (q + 1 < n && Math.abs(scores[order[q + 1]] - anchor) <= tol) q++;
    const a = p + 1;
    const b = q + 1;
    for (let k = p; k <= q; k++) {
      rank[order[k]] = (a + b) / 2;
      groupStart[order[k]] = a;
      groupEnd[order[k]] = b;
    }
    p = q + 1;
  }
  return { order, rank, groupStart, groupEnd };
}

/** Indices of alternatives sharing the first position. */
export function leaders(r: Ranked): number[] {
  return r.order.filter((i) => r.groupStart[i] === 1);
}

/** Share of positions 1..k covered by the alternative's tie group. */
export function topKCredit(r: Ranked, i: number, k: number): number {
  const a = r.groupStart[i];
  const b = r.groupEnd[i];
  if (a > k) return 0;
  return (Math.min(b, k) - a + 1) / (b - a + 1);
}

/** Linear-interpolation quantile (type 7, R default) of a sorted array. */
export function quantileSorted(sorted: ArrayLike<number>, q: number): number {
  const n = sorted.length;
  if (n === 0) return NaN;
  if (n === 1) return sorted[0];
  const h = (n - 1) * q;
  const lo = Math.floor(h);
  const hi = Math.min(n - 1, lo + 1);
  return sorted[lo] + (h - lo) * (sorted[hi] - sorted[lo]);
}

/** Kendall tau-b between two rank vectors (ties allowed). */
export function kendallTauB(x: number[], y: number[]): number {
  const n = x.length;
  let concordant = 0;
  let discordant = 0;
  let tiesX = 0;
  let tiesY = 0;
  for (let i = 0; i < n; i++)
    for (let j = i + 1; j < n; j++) {
      const dx = Math.sign(x[i] - x[j]);
      const dy = Math.sign(y[i] - y[j]);
      if (dx === 0 && dy === 0) continue;
      if (dx === 0) tiesX++;
      else if (dy === 0) tiesY++;
      else if (dx === dy) concordant++;
      else discordant++;
    }
  const denom = Math.sqrt((concordant + discordant + tiesX) * (concordant + discordant + tiesY));
  return denom > 0 ? (concordant - discordant) / denom : 1;
}
