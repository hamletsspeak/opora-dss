import type {
  AuditRecord,
  ChatMessage,
  McdmResult,
  SessionState,
} from './types.js';

let seq = 0;

export function newAuditId(ts = Date.now()): string {
  seq = (seq + 1) % 1_000_000;
  return `audit_${ts.toString(36)}_${seq.toString(36)}`;
}

/** Build a thesis audit payload from analyze outputs. */
export function buildAuditRecord(input: {
  session: SessionState;
  analysis: McdmResult;
  explanation?: string;
  messages?: ChatMessage[];
  id?: string;
  ts?: number;
}): AuditRecord {
  const ts = input.ts ?? Date.now();
  return {
    id: input.id ?? newAuditId(ts),
    ts,
    messages: input.messages,
    session: input.session,
    mcdmParams: input.analysis.mcdmParams,
    ranking: input.analysis.ranking,
    methods: input.analysis.methods,
    agreement: input.analysis.agreement,
    explanation: input.explanation,
    sensitivityNote: input.analysis.sensitivityNote,
    weightMeans: input.analysis.weightMeans,
    samples: input.analysis.samples,
  };
}

/** In-memory audit store for local / demo serverless. */
export class AuditStore {
  private readonly max: number;
  private readonly items: AuditRecord[] = [];

  constructor(max = 100) {
    this.max = max;
  }

  put(record: AuditRecord): AuditRecord {
    this.items.unshift(record);
    if (this.items.length > this.max) this.items.length = this.max;
    return record;
  }

  list(): AuditRecord[] {
    return [...this.items];
  }

  get(id: string): AuditRecord | undefined {
    return this.items.find((r) => r.id === id);
  }

  clear(): void {
    this.items.length = 0;
  }
}

export const globalAuditStore = new AuditStore(100);
