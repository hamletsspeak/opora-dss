export type Direction = 'min' | 'max';
export type Importance = 'high' | 'medium' | 'low' | 'unknown';
export type McdmMethodId = 'topsis' | 'wsm' | 'vikor';

export interface Criterion {
  id: string;
  name: string;
  direction: Direction;
  /** Exact weight 0..1 if known */
  weight?: number;
  weightUncertain?: boolean;
  importance: Importance;
  /** Optional preferred value / interval for filtering — mainly for display */
  valueHint?: number | [number, number];
}

export interface Alternative {
  id: string;
  name: string;
  /** criterionId -> crisp or interval score */
  scores: Record<string, number | [number, number]>;
}

export interface SessionState {
  context: string;
  criteria: Criterion[];
  alternatives: Alternative[];
  missing: string[];
  readyForAnalysis: boolean;
  usedDemoData: boolean;
}

export interface ChatMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

export interface RankItem {
  alternativeId: string;
  name: string;
  expectedScore: number;
  winRate: number;
  meanRank: number;
  pBest: number;
  pWorst: number;
}

export interface MethodAgreement {
  /** Доля выборок, где все методы дали одного лидера */
  leaderMatchRate: number;
  /** Попарное совпадение лидеров на выборках */
  pairwiseLeaderMatch: {
    topsis_wsm: number;
    topsis_vikor: number;
    wsm_vikor: number;
  };
  /** Средний ранг каждой альтернативы по методам (id → method → rank) */
  meanRankByMethod: Record<string, Record<McdmMethodId, number>>;
}

export interface McdmResult {
  /** Primary ranking = TOPSIS-like (backward-compatible) */
  ranking: RankItem[];
  samples: number;
  sensitivityNote: string;
  weightMeans: Record<string, number>;
  /** Per-method rankings on the same Monte-Carlo samples */
  methods: {
    topsis: RankItem[];
    wsm: RankItem[];
    vikor: RankItem[];
  };
  agreement: MethodAgreement;
  mcdmParams: { samples: number; seed: number };
}

/** Audit trail record for thesis / export */
export interface AuditRecord {
  id: string;
  ts: number;
  messages?: ChatMessage[];
  session: SessionState;
  mcdmParams: { samples: number; seed: number };
  ranking: RankItem[];
  methods?: McdmResult['methods'];
  agreement?: MethodAgreement;
  explanation?: string;
  sensitivityNote?: string;
  weightMeans?: Record<string, number>;
  samples?: number;
}

export interface AgentResponse {
  reply: string;
  session: SessionState;
  offerDemo: boolean;
  canAnalyze: boolean;
  analysis?: McdmResult;
  explanation?: string;
}

export function emptySession(): SessionState {
  return {
    context: '',
    criteria: [],
    alternatives: [],
    missing: [],
    readyForAnalysis: false,
    usedDemoData: false,
  };
}
