import type { McdmResult, RankItem } from '../shared/types';

/** Flexible multi-method shapes from backend (or future packs). */
export type MethodSlice = {
  method: string;
  ranking: RankItem[];
  leaderMatchRate?: number;
  meanRank?: number;
};

export type FlexibleAnalysis = McdmResult & {
  methods?: unknown;
  multiMethod?: unknown;
  methodRankings?: unknown;
  agreement?: {
    leaderMatchRate?: number;
    meanRank?: number;
    meanRankCorrelation?: number;
    [key: string]: unknown;
  };
  mcdmParams?: Record<string, unknown>;
};

function asRankItem(raw: unknown): RankItem | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const alternativeId = String(o.alternativeId ?? o.id ?? '');
  const name = String(o.name ?? '');
  if (!alternativeId && !name) return null;
  const winRate = Number(o.winRate ?? o.pBest ?? 0);
  return {
    alternativeId: alternativeId || name,
    name: name || alternativeId,
    expectedScore: Number(o.expectedScore ?? o.score ?? 0),
    winRate: Number.isFinite(winRate) ? winRate : 0,
    meanRank: Number(o.meanRank ?? o.avgRank ?? 0),
    pBest: Number(o.pBest ?? winRate ?? 0),
    pWorst: Number(o.pWorst ?? 0),
  };
}

function asMethodSlice(raw: unknown, index: number): MethodSlice | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const rankingRaw = o.ranking ?? o.ranks ?? o.items;
  if (!Array.isArray(rankingRaw)) return null;
  const ranking = rankingRaw
    .map(asRankItem)
    .filter((r): r is RankItem => r != null);
  if (!ranking.length) return null;
  const method = String(
    o.method ?? o.name ?? o.id ?? o.label ?? `method-${index + 1}`,
  );
  const leaderMatchRate =
    o.leaderMatchRate != null ? Number(o.leaderMatchRate) : undefined;
  const meanRank = o.meanRank != null ? Number(o.meanRank) : undefined;
  return {
    method,
    ranking,
    leaderMatchRate: Number.isFinite(leaderMatchRate)
      ? leaderMatchRate
      : undefined,
    meanRank: Number.isFinite(meanRank) ? meanRank : undefined,
  };
}

/** Normalize analyze payload; never throw on unknown multi-method shape. */
export function normalizeAnalysis(raw: unknown): FlexibleAnalysis | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const rankingRaw = o.ranking;
  if (!Array.isArray(rankingRaw) || rankingRaw.length === 0) return null;
  const ranking = rankingRaw
    .map(asRankItem)
    .filter((r): r is RankItem => r != null);
  if (!ranking.length) return null;

  const base: FlexibleAnalysis = {
    ranking,
    samples: Number(o.samples ?? 0),
    sensitivityNote: String(o.sensitivityNote ?? ''),
    weightMeans:
      o.weightMeans && typeof o.weightMeans === 'object'
        ? (o.weightMeans as Record<string, number>)
        : {},
  };

  if (o.mcdmParams && typeof o.mcdmParams === 'object') {
    base.mcdmParams = o.mcdmParams as Record<string, unknown>;
  }
  if (o.agreement && typeof o.agreement === 'object') {
    base.agreement = o.agreement as FlexibleAnalysis['agreement'];
  }

  const bag = o.methods ?? o.multiMethod ?? o.methodRankings;
  if (Array.isArray(bag)) {
    const methods = bag
      .map(asMethodSlice)
      .filter((m): m is MethodSlice => m != null);
    if (methods.length) base.methods = methods;
  }

  return base;
}

export function extractMethodSlices(analysis: FlexibleAnalysis): MethodSlice[] {
  if (!Array.isArray(analysis.methods)) return [];
  return analysis.methods
    .map(asMethodSlice)
    .filter((m): m is MethodSlice => m != null);
}
