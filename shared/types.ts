export type Direction = 'min' | 'max';
export type Importance = 'high' | 'medium' | 'low' | 'unknown';

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

export interface McdmResult {
  ranking: RankItem[];
  samples: number;
  sensitivityNote: string;
  weightMeans: Record<string, number>;
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
