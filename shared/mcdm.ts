import type {
  Criterion,
  Direction,
  McdmMethodId,
  McdmResult,
  MethodAgreement,
  RankItem,
  SessionState,
} from './types.js';

export const DEFAULT_MCDM_SAMPLES = 2000;
export const DEFAULT_MCDM_SEED = 42;

/** Mulberry32 PRNG — deterministic given seed */
export function mulberry32(seed: number): () => number {
  let t = seed >>> 0;
  return () => {
    t = (t + 0x6d2b79f5) >>> 0;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

function sampleInterval(rng: () => number, v: number | [number, number]): number {
  if (typeof v === 'number') return v;
  const [lo, hi] = v[0] <= v[1] ? v : [v[1], v[0]];
  return lo + (hi - lo) * rng();
}

/** Dirichlet-like weight sample with importance priors */
function sampleWeights(
  criteria: Criterion[],
  rng: () => number,
): Record<string, number> {
  const alphas = criteria.map((c) => {
    if (c.weight != null && !c.weightUncertain) {
      return Math.max(0.05, c.weight * 20);
    }
    if (c.importance === 'high') return 4 + rng() * 2;
    if (c.importance === 'medium') return 2 + rng();
    if (c.importance === 'low') return 0.8 + rng() * 0.5;
    // unknown / uncertain → wide prior
    return 1 + rng() * 2;
  });

  // Gamma(k,1) via sum of -ln(U) for integer-ish shape; use approximation
  const draws = alphas.map((a) => {
    // Marsaglia for shape>0: simple product of uniforms when a small
    let g = 0;
    const full = Math.floor(a);
    for (let i = 0; i < full; i++) g -= Math.log(Math.max(1e-12, rng()));
    const frac = a - full;
    if (frac > 0.01) g -= Math.log(Math.max(1e-12, rng())) * frac;
    return Math.max(1e-9, g);
  });

  const sum = draws.reduce((s, x) => s + x, 0);
  const out: Record<string, number> = {};
  criteria.forEach((c, i) => {
    out[c.id] = draws[i] / sum;
  });

  // Soft ordinal: boost high-importance vs low when both uncertain
  const high = criteria.filter((c) => c.importance === 'high');
  const low = criteria.filter((c) => c.importance === 'low');
  if (high.length && low.length) {
    for (const h of high) {
      for (const l of low) {
        const hi = out[h.id];
        const lo = out[l.id];
        if (hi < lo) {
          const mid = (hi + lo) / 2;
          const half = Math.abs(lo - hi) / 2;
          out[h.id] = mid + half;
          out[l.id] = Math.max(1e-9, mid - half);
        }
      }
    }
    const s2 = Object.values(out).reduce((a, b) => a + b, 0);
    for (const id of Object.keys(out)) out[id] /= s2;
  }

  return out;
}

function normalizeMatrix(
  values: number[][],
  directions: Direction[],
): number[][] {
  const nCrit = directions.length;
  const ideal: number[] = [];
  const anti: number[] = [];
  for (let j = 0; j < nCrit; j++) {
    const col = values.map((r) => r[j]);
    const mn = Math.min(...col);
    const mx = Math.max(...col);
    if (directions[j] === 'min') {
      ideal[j] = mn;
      anti[j] = mx;
    } else {
      ideal[j] = mx;
      anti[j] = mn;
    }
  }
  return values.map((row) =>
    row.map((v, j) => {
      const span = Math.abs(ideal[j] - anti[j]);
      if (span < 1e-12) return 0.5;
      return Math.abs(v - anti[j]) / span; // 1 = closer to ideal
    }),
  );
}

/** Weighted TOPSIS-like score in [0,1] (higher better) */
function topsisScores(norm: number[][], weights: number[]): number[] {
  return norm.map((row) => {
    let dPos = 0;
    let dNeg = 0;
    for (let j = 0; j < row.length; j++) {
      const w = weights[j];
      dPos += (w * (1 - row[j])) ** 2;
      dNeg += (w * (0 - row[j])) ** 2;
    }
    dPos = Math.sqrt(dPos);
    dNeg = Math.sqrt(dNeg);
    const den = dPos + dNeg;
    return den < 1e-12 ? 0.5 : dNeg / den;
  });
}

/** Weighted Sum Model on benefit-normalized matrix (higher better) */
function wsmScores(norm: number[][], weights: number[]): number[] {
  return norm.map((row) => {
    let s = 0;
    for (let j = 0; j < row.length; j++) s += weights[j] * row[j];
    return s;
  });
}

/**
 * VIKOR Q-scores on benefit-normalized matrix (lower Q better).
 * v = strategy weight of group utility (default 0.5).
 */
function vikorQScores(
  norm: number[][],
  weights: number[],
  v = 0.5,
): number[] {
  const nAlt = norm.length;
  const nCrit = weights.length;
  if (!nAlt) return [];

  const fStar: number[] = [];
  const fMinus: number[] = [];
  for (let j = 0; j < nCrit; j++) {
    let mx = -Infinity;
    let mn = Infinity;
    for (let i = 0; i < nAlt; i++) {
      mx = Math.max(mx, norm[i][j]);
      mn = Math.min(mn, norm[i][j]);
    }
    fStar[j] = mx;
    fMinus[j] = mn;
  }

  const S: number[] = [];
  const R: number[] = [];
  for (let i = 0; i < nAlt; i++) {
    let s = 0;
    let r = 0;
    for (let j = 0; j < nCrit; j++) {
      const span = fStar[j] - fMinus[j];
      const u = span < 1e-12 ? 0 : (fStar[j] - norm[i][j]) / span;
      const wu = weights[j] * u;
      s += wu;
      if (wu > r) r = wu;
    }
    S[i] = s;
    R[i] = r;
  }

  const Sstar = Math.min(...S);
  const Sminus = Math.max(...S);
  const Rstar = Math.min(...R);
  const Rminus = Math.max(...R);
  const dS = Sminus - Sstar;
  const dR = Rminus - Rstar;

  return S.map((Si, i) => {
    const termS = dS < 1e-12 ? 0 : (Si - Sstar) / dS;
    const termR = dR < 1e-12 ? 0 : (R[i] - Rstar) / dR;
    return v * termS + (1 - v) * termR;
  });
}

type MethodAgg = {
  winCounts: number[];
  rankSums: number[];
  scoreSums: number[];
  worstCounts: number[];
};

function emptyAgg(nAlt: number): MethodAgg {
  return {
    winCounts: new Array(nAlt).fill(0),
    rankSums: new Array(nAlt).fill(0),
    scoreSums: new Array(nAlt).fill(0),
    worstCounts: new Array(nAlt).fill(0),
  };
}

/** Higher score → better rank (1 = best) */
function orderByScoreDesc(scores: number[]): { sc: number; i: number }[] {
  return scores
    .map((sc, i) => ({ sc, i }))
    .sort((a, b) => b.sc - a.sc || a.i - b.i);
}

/** Lower score → better rank (VIKOR Q) */
function orderByScoreAsc(scores: number[]): { sc: number; i: number }[] {
  return scores
    .map((sc, i) => ({ sc, i }))
    .sort((a, b) => a.sc - b.sc || a.i - b.i);
}

function recordOrder(agg: MethodAgg, order: { sc: number; i: number }[]): void {
  agg.winCounts[order[0].i]++;
  agg.worstCounts[order[order.length - 1].i]++;
  order.forEach((o, rank) => {
    agg.rankSums[o.i] += rank + 1;
    agg.scoreSums[o.i] += o.sc;
  });
}

function toRanking(
  alternatives: SessionState['alternatives'],
  agg: MethodAgg,
  samples: number,
  /** For VIKOR, expectedScore stores mean Q (lower better); flip display via note only */
  sortHigherBetter = true,
): RankItem[] {
  const items: RankItem[] = alternatives.map((alt, i) => ({
    alternativeId: alt.id,
    name: alt.name,
    expectedScore: agg.scoreSums[i] / samples,
    winRate: agg.winCounts[i] / samples,
    meanRank: agg.rankSums[i] / samples,
    pBest: agg.winCounts[i] / samples,
    pWorst: agg.worstCounts[i] / samples,
  }));
  if (sortHigherBetter) {
    return items.sort(
      (a, b) => b.winRate - a.winRate || b.expectedScore - a.expectedScore,
    );
  }
  // VIKOR: prefer higher winRate, then lower Q (expectedScore)
  return items.sort(
    (a, b) => b.winRate - a.winRate || a.expectedScore - b.expectedScore,
  );
}

function sensitivityFromRanking(ranking: RankItem[]): string {
  const leader = ranking[0];
  const runner = ranking[1];
  if (!leader) return 'Ранжирование пусто.';
  if (!runner) return `${leader.name} — единственная альтернатива.`;
  if (leader.winRate < 0.55) {
    return `Лидер неустойчив: ${leader.name} побеждает лишь в ${(leader.winRate * 100).toFixed(0)}% симуляций. При изменении весов/оценок возможна смена лидера (${runner.name}: ${(runner.winRate * 100).toFixed(0)}%).`;
  }
  if (Math.abs(leader.expectedScore - runner.expectedScore) < 0.05) {
    return `${leader.name} чаще первый (${(leader.winRate * 100).toFixed(0)}%), но ожидаемые оценки близки к ${runner.name} — решение чувствительно к уточнению весов.`;
  }
  return `${leader.name} устойчиво лидирует (${(leader.winRate * 100).toFixed(0)}% побед). Уточнение неопределённых весов вряд ли сменит топ-1.`;
}

function emptyResult(note: string, samples: number, seed: number): McdmResult {
  const emptyMethods = { topsis: [], wsm: [], vikor: [] };
  const agreement: MethodAgreement = {
    leaderMatchRate: 0,
    pairwiseLeaderMatch: {
      topsis_wsm: 0,
      topsis_vikor: 0,
      wsm_vikor: 0,
    },
    meanRankByMethod: {},
  };
  return {
    ranking: [],
    samples: 0,
    sensitivityNote: note,
    weightMeans: {},
    methods: emptyMethods,
    agreement,
    mcdmParams: { samples, seed },
  };
}

/**
 * Робастный MCDM: одни и те же Monte-Carlo выборки → TOPSIS-like, Weighted Sum, VIKOR.
 * `ranking` = TOPSIS (обратная совместимость).
 */
export function runRobustMcdm(
  session: SessionState,
  samples = DEFAULT_MCDM_SAMPLES,
  seed = DEFAULT_MCDM_SEED,
): McdmResult {
  const { criteria, alternatives } = session;
  if (!criteria.length || !alternatives.length) {
    return emptyResult('Недостаточно данных для анализа.', samples, seed);
  }

  const rng = mulberry32(seed);
  const nAlt = alternatives.length;
  const topsisAgg = emptyAgg(nAlt);
  const wsmAgg = emptyAgg(nAlt);
  const vikorAgg = emptyAgg(nAlt);
  const weightSums: Record<string, number> = {};
  criteria.forEach((c) => {
    weightSums[c.id] = 0;
  });

  let allAgree = 0;
  let tw = 0;
  let tv = 0;
  let wv = 0;

  for (let s = 0; s < samples; s++) {
    const wMap = sampleWeights(criteria, rng);
    const weights = criteria.map((c) => {
      weightSums[c.id] += wMap[c.id];
      return wMap[c.id];
    });

    const matrix: number[][] = alternatives.map((alt) =>
      criteria.map((c) => {
        const raw = alt.scores[c.id];
        if (raw == null) return 0;
        return sampleInterval(rng, raw);
      }),
    );

    const directions = criteria.map((c) => c.direction);
    const norm = normalizeMatrix(matrix, directions);

    const topsis = topsisScores(norm, weights);
    const wsm = wsmScores(norm, weights);
    const vikor = vikorQScores(norm, weights, 0.5);

    const oT = orderByScoreDesc(topsis);
    const oW = orderByScoreDesc(wsm);
    const oV = orderByScoreAsc(vikor);

    recordOrder(topsisAgg, oT);
    recordOrder(wsmAgg, oW);
    recordOrder(vikorAgg, oV);

    const lT = oT[0].i;
    const lW = oW[0].i;
    const lV = oV[0].i;
    if (lT === lW && lT === lV) allAgree++;
    if (lT === lW) tw++;
    if (lT === lV) tv++;
    if (lW === lV) wv++;
  }

  const topsisRanking = toRanking(alternatives, topsisAgg, samples, true);
  const wsmRanking = toRanking(alternatives, wsmAgg, samples, true);
  const vikorRanking = toRanking(alternatives, vikorAgg, samples, false);

  const weightMeans: Record<string, number> = {};
  for (const c of criteria) {
    weightMeans[c.id] = weightSums[c.id] / samples;
  }

  const meanRankByMethod: MethodAgreement['meanRankByMethod'] = {};
  const methodIds: McdmMethodId[] = ['topsis', 'wsm', 'vikor'];
  const aggs = [topsisAgg, wsmAgg, vikorAgg];
  for (let i = 0; i < nAlt; i++) {
    const id = alternatives[i].id;
    meanRankByMethod[id] = { topsis: 0, wsm: 0, vikor: 0 };
    methodIds.forEach((m, mi) => {
      meanRankByMethod[id][m] = aggs[mi].rankSums[i] / samples;
    });
  }

  const agreement: MethodAgreement = {
    leaderMatchRate: allAgree / samples,
    pairwiseLeaderMatch: {
      topsis_wsm: tw / samples,
      topsis_vikor: tv / samples,
      wsm_vikor: wv / samples,
    },
    meanRankByMethod,
  };

  return {
    ranking: topsisRanking,
    samples,
    sensitivityNote: sensitivityFromRanking(topsisRanking),
    weightMeans,
    methods: {
      topsis: topsisRanking,
      wsm: wsmRanking,
      vikor: vikorRanking,
    },
    agreement,
    mcdmParams: { samples, seed },
  };
}

export function isAnalysisReady(session: SessionState): boolean {
  if (session.criteria.length < 2) return false;
  if (session.alternatives.length < 2) return false;
  const critIds = session.criteria.map((c) => c.id);
  return session.alternatives.every((a) =>
    critIds.every((id) => a.scores[id] != null),
  );
}
