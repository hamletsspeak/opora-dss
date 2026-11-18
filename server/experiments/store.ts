import fs from 'node:fs';
import path from 'node:path';
import { ID_RE, summarize } from './runner.js';
import type { BatchRecord, ExperimentRecord, ExperimentSummary } from './types.js';

export interface RunStore {
  readonly kind: 'file' | 'memory';
  readonly location: string | null;
  save(rec: ExperimentRecord): void;
  get(id: string): ExperimentRecord | null;
  list(limit?: number): ExperimentSummary[];
  saveBatch(b: BatchRecord): void;
  getBatch(id: string): BatchRecord | null;
  listBatches(limit?: number): BatchRecord[];
}

export class MemoryRunStore implements RunStore {
  readonly kind = 'memory' as const;
  readonly location = null;
  private readonly recs = new Map<string, ExperimentRecord>();
  private readonly batches = new Map<string, BatchRecord>();

  constructor(private readonly capacity = 500) {}

  save(rec: ExperimentRecord): void {
    this.recs.set(rec.experiment_id, rec);
    if (this.recs.size > this.capacity) this.recs.delete(this.recs.keys().next().value as string);
  }
  get(id: string): ExperimentRecord | null {
    return this.recs.get(id) ?? null;
  }
  list(limit = 100): ExperimentSummary[] {
    return [...this.recs.values()].reverse().slice(0, limit).map(summarize);
  }
  saveBatch(b: BatchRecord): void {
    this.batches.set(b.batch_id, b);
  }
  getBatch(id: string): BatchRecord | null {
    return this.batches.get(id) ?? null;
  }
  listBatches(limit = 50): BatchRecord[] {
    return [...this.batches.values()].reverse().slice(0, limit);
  }
}

/** One JSON file per experiment under `<dir>/experiments`, batches under `<dir>/batches`. */
export class FileRunStore implements RunStore {
  readonly kind = 'file' as const;
  private readonly expDir: string;
  private readonly batDir: string;
  private index: ExperimentSummary[] | null = null;

  constructor(readonly location: string) {
    this.expDir = path.join(location, 'experiments');
    this.batDir = path.join(location, 'batches');
    fs.mkdirSync(this.expDir, { recursive: true });
    fs.mkdirSync(this.batDir, { recursive: true });
  }

  private file(dir: string, id: string): string {
    if (!ID_RE.test(id)) throw new Error('некорректный идентификатор');
    return path.join(dir, `${id}.json`);
  }

  save(rec: ExperimentRecord): void {
    const f = this.file(this.expDir, rec.experiment_id);
    fs.writeFileSync(`${f}.tmp`, JSON.stringify(rec), 'utf8');
    fs.renameSync(`${f}.tmp`, f);
    this.index?.unshift(summarize(rec));
  }

  get(id: string): ExperimentRecord | null {
    if (!ID_RE.test(id)) return null;
    try {
      return JSON.parse(fs.readFileSync(this.file(this.expDir, id), 'utf8')) as ExperimentRecord;
    } catch {
      return null;
    }
  }

  list(limit = 100): ExperimentSummary[] {
    if (!this.index) {
      const ids = fs
        .readdirSync(this.expDir)
        .filter((f) => f.endsWith('.json'))
        .map((f) => f.slice(0, -5))
        .filter((id) => ID_RE.test(id))
        .sort()
        .reverse();
      this.index = ids.flatMap((id) => {
        const r = this.get(id);
        return r ? [summarize(r)] : [];
      });
    }
    return this.index.slice(0, limit);
  }

  saveBatch(b: BatchRecord): void {
    fs.writeFileSync(this.file(this.batDir, b.batch_id), JSON.stringify(b), 'utf8');
  }

  getBatch(id: string): BatchRecord | null {
    if (!ID_RE.test(id)) return null;
    try {
      return JSON.parse(fs.readFileSync(this.file(this.batDir, id), 'utf8')) as BatchRecord;
    } catch {
      return null;
    }
  }

  listBatches(limit = 50): BatchRecord[] {
    return fs
      .readdirSync(this.batDir)
      .filter((f) => f.endsWith('.json'))
      .sort()
      .reverse()
      .slice(0, limit)
      .flatMap((f) => {
        const b = this.getBatch(f.slice(0, -5));
        return b ? [b] : [];
      });
  }
}
