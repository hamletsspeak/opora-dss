import type { MethodAgreement, RankItem } from '../shared/types';

/** Flexible multi-method shapes from backend (or future packs). */
export type MethodSlice = {
  method: string;
  ranking: RankItem[];
  leaderMatchRate?: number;
  meanRank?: number;
};

/** UI-facing analysis: primary ranking always present; multi-method optional. */
export type FlexibleAnalysis = {
  ranking: RankItem[];
  samples: number;
  sensitivityNote: string;
  weightMeans: Record<string, number>;
  /** Backend object { topsis, wsm, vikor } or normalized MethodSlice[] */
  methods?:
    | MethodSlice[]
    | {
        topsis: RankItem[];
        wsm: RankItem[];
        vikor: RankItem[];
      };
  agreement?: Partial<MethodAgreement> & {
    meanRank?: number;
    meanRankCorrelation?: number;
    [key: string]: unknown;
  };
  mcdmParams?: { samples?: number; seed?: number } & Record<string, unknown>;
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

function asRankList(raw: unknown): RankItem[] {
  if (!Array.isArray(raw)) return [];
  return raw.map(asRankItem).filter((r): r is RankItem => r != null);
}

function asMethodSlice(raw: unknown, index: number): MethodSlice | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const ranking = asRankList(o.ranking ?? o.ranks ?? o.items);
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
  const ranking = asRankList(o.ranking);
  if (!ranking.length) return null;

  const samples = Number(o.samples ?? 0);
  const base: FlexibleAnalysis = {
    ranking,
    samples: Number.isFinite(samples) ? samples : 0,
    sensitivityNote: String(o.sensitivityNote ?? ''),
    weightMeans:
      o.weightMeans && typeof o.weightMeans === 'object'
        ? (o.weightMeans as Record<string, number>)
        : {},
  };

  if (o.mcdmParams && typeof o.mcdmParams === 'object') {
    const p = o.mcdmParams as Record<string, unknown>;
    base.mcdmParams = {
      ...p,
      samples: Number(p.samples ?? samples),
      seed: Number(p.seed ?? 42),
    };
  } else {
    base.mcdmParams = { samples: base.samples, seed: 42 };
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
  } else if (bag && typeof bag === 'object') {
    const m = bag as Record<string, unknown>;
    const topsis = asRankList(m.topsis);
    const wsm = asRankList(m.wsm);
    const vikor = asRankList(m.vikor);
    if (topsis.length || wsm.length || vikor.length) {
      base.methods = {
        topsis: topsis.length ? topsis : ranking,
        wsm: wsm.length ? wsm : ranking,
        vikor: vikor.length ? vikor : ranking,
      };
    }
  }

  return base;
}

export function extractMethodSlices(analysis: FlexibleAnalysis): MethodSlice[] {
  const m = analysis.methods;
  if (!m) return [];
  if (Array.isArray(m)) {
    return m
      .map(asMethodSlice)
      .filter((x): x is MethodSlice => x != null);
  }
  const out: MethodSlice[] = [];
  if (m.topsis?.length) out.push({ method: 'TOPSIS', ranking: m.topsis });
  if (m.wsm?.length) out.push({ method: 'WSM', ranking: m.wsm });
  if (m.vikor?.length) out.push({ method: 'VIKOR', ranking: m.vikor });
  return out;
}
