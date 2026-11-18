import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { CompletionRequest, CompletionResult, LlmErrorCode, Pricing } from './types.js';

export type CallPurpose = 'formalize' | 'chat' | 'explain' | 'health' | 'benchmark';

/** Metadata of one LLM call. Never contains credentials; prompt/response text only as hashes. */
export interface LlmCallRecord {
  call_id: string;
  purpose: CallPurpose;
  provider: string;
  model: string;
  model_version: string | null;
  endpoint: string | null;
  request_id: string | null;
  started_at: string;
  latency_ms: number;
  status: 'ok' | 'error';
  error_code: LlmErrorCode | null;
  error_message: string | null;
  http_status: number | null;
  temperature: number;
  max_tokens: number;
  json_mode: boolean;
  attempt: number;
  /** set when this provider was used because the primary one failed */
  fallback_from: string | null;
  fallback_reason: LlmErrorCode | null;
  input_tokens: number | null;
  output_tokens: number | null;
  /** estimate from configured prices; null when prices are not configured */
  cost: { amount: number; currency: string } | null;
  prompt_sha256: string;
  prompt_chars: number;
  response_sha256: string | null;
  response_chars: number | null;
  finish_reason: string | null;
}

export function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

export function promptDigest(req: CompletionRequest): { sha: string; chars: number } {
  const s = JSON.stringify(req.messages);
  return { sha: sha256(s), chars: s.length };
}

export function estimateCost(pricing: Pricing | null, r: Pick<CompletionResult, 'usage'>): LlmCallRecord['cost'] {
  if (!pricing || r.usage.input_tokens === null || r.usage.output_tokens === null) return null;
  const amount = (r.usage.input_tokens * pricing.input_per_1m + r.usage.output_tokens * pricing.output_per_1m) / 1e6;
  return { amount: Number(amount.toFixed(6)), currency: pricing.currency };
}

export function newCallId(): string {
  return randomUUID();
}

export class CallLog {
  private readonly items: LlmCallRecord[] = [];

  constructor(
    private readonly capacity = 1000,
    private readonly file: string | null = null,
  ) {
    if (file) fs.mkdirSync(path.dirname(file), { recursive: true });
  }

  add(r: LlmCallRecord): void {
    this.items.push(r);
    if (this.items.length > this.capacity) this.items.shift();
    if (this.file) {
      try {
        fs.appendFileSync(this.file, `${JSON.stringify(r)}\n`, 'utf8');
      } catch {
        /* the in-memory copy is still available */
      }
    }
  }

  list(limit = 100): LlmCallRecord[] {
    return this.items.slice(-limit).reverse();
  }

  get(id: string): LlmCallRecord | undefined {
    return this.items.find((x) => x.call_id === id);
  }
}
