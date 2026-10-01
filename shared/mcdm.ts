import type {
  Criterion,
  Direction,
  McdmResult,
  RankItem,
  SessionState,
} from './types';

/** Mulberry32 PRNG — deterministic given seed */
function mulberry32(seed: number): () => number {
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
function topsisScores(
  norm: number[][],
  weights: number[],
): number[] {
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

export function runRobustMcdm(
  session: SessionState,
  samples = 2000,
  seed = 42,
): McdmResult {
  const { criteria, alternatives } = session;
  if (!criteria.length || !alternatives.length) {
    return {
      ranking: [],
      samples: 0,
      sensitivityNote: 'Недостаточно данных для анализа.',
      weightMeans: {},
    };
  }

  const rng = mulberry32(seed);
  const nAlt = alternatives.length;
  const winCounts = new Array(nAlt).fill(0);
  const rankSums = new Array(nAlt).fill(0);
  const scoreSums = new Array(nAlt).fill(0);
  const worstCounts = new Array(nAlt).fill(0);
  const weightSums: Record<string, number> = {};
  criteria.forEach((c) => {
    weightSums[c.id] = 0;
  });

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
    const scores = topsisScores(norm, weights);

    const order = scores
      .map((sc, i) => ({ sc, i }))
      .sort((a, b) => b.sc - a.sc);

    winCounts[order[0].i]++;
    worstCounts[order[order.length - 1].i]++;
    order.forEach((o, rank) => {
      rankSums[o.i] += rank + 1;
      scoreSums[o.i] += o.sc;
    });
  }

  const ranking: RankItem[] = alternatives
    .map((alt, i) => ({
      alternativeId: alt.id,
      name: alt.name,
      expectedScore: scoreSums[i] / samples,
      winRate: winCounts[i] / samples,
      meanRank: rankSums[i] / samples,
      pBest: winCounts[i] / samples,
      pWorst: worstCounts[i] / samples,
    }))
    .sort((a, b) => b.winRate - a.winRate || b.expectedScore - a.expectedScore);

  const weightMeans: Record<string, number> = {};
  for (const c of criteria) {
    weightMeans[c.id] = weightSums[c.id] / samples;
  }

  const leader = ranking[0];
  const runner = ranking[1];
  let sensitivityNote = '';
  if (!leader) {
    sensitivityNote = 'Ранжирование пусто.';
  } else if (!runner) {
    sensitivityNote = `${leader.name} — единственная альтернатива.`;
  } else if (leader.winRate < 0.55) {
    sensitivityNote = `Лидер неустойчив: ${leader.name} побеждает лишь в ${(leader.winRate * 100).toFixed(0)}% симуляций. При изменении весов/оценок возможна смена лидера (${runner.name}: ${(runner.winRate * 100).toFixed(0)}%).`;
  } else if (Math.abs(leader.expectedScore - runner.expectedScore) < 0.05) {
    sensitivityNote = `${leader.name} чаще первый (${(leader.winRate * 100).toFixed(0)}%), но ожидаемые оценки близки к ${runner.name} — решение чувствительно к уточнению весов.`;
  } else {
    sensitivityNote = `${leader.name} устойчиво лидирует (${(leader.winRate * 100).toFixed(0)}% побед). Уточнение неопределённых весов вряд ли сменит топ-1.`;
  }

  return { ranking, samples, sensitivityNote, weightMeans };
}

export function isAnalysisReady(session: SessionState): boolean {
  if (session.criteria.length < 2) return false;
  if (session.alternatives.length < 2) return false;
  const critIds = session.criteria.map((c) => c.id);
  return session.alternatives.every((a) =>
    critIds.every((id) => a.scores[id] != null),
  );
}
