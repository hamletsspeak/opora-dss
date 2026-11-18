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
  mcdmParams: { samples: number; seed: number; mode?: string; engine?: string };
  /** v1 engine extras (absent in v0 responses) */
  mode?: { id: string; number: number; label: string; m: string; w: string };
  robustness?: string[];
  sensitivity?: {
    summary: string[];
    critical: {
      type: 'weight' | 'evaluation';
      label: string;
      base_value: number;
      flip_at: number | null;
      abs_delta: number | null;
      relative_delta: number | null;
      new_leader_names: string[];
    }[];
    statements: Record<string, string[]>;
  };
  conversionLog?: string[];
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

/** Which engine produced a chat reply. `rules` = built-in parser, shown to the user explicitly. */
export interface AgentLlmInfo {
  mode: 'llm' | 'rules';
  provider: string | null;
  model: string | null;
  fallback_from: string | null;
  notice: string;
  error: { code: string; message: string } | null;
}

export interface AgentResponse {
  reply: string;
  session: SessionState;
  offerDemo: boolean;
  canAnalyze: boolean;
  analysis?: McdmResult;
  explanation?: string;
  llm?: AgentLlmInfo;
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
