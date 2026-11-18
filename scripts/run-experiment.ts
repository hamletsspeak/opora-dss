/**
 * Reproducible experiment from the command line.
 *
 *   npx tsx scripts/run-experiment.ts --input data/examples/suppliers.csv [--input b.json …]
 *        [--modes all|1,2,3,4|MU_WU,MF_WU] [--n 2000] [--seed 42] [--method topsis|wsm|vikor]
 *        [--compare-methods] [--no-sensitivity] [--label "…"] [--out results/]
 *   npx tsx scripts/run-experiment.ts --repeat results/exp_….json [--out results/]
 *
 * Writes <id>.json (full record with passport) and <id>-<table>.csv for every input.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { modeFromNumber, type ModeId, type RunOverrides } from '../shared/problem/index.js';
import { readAppInfo } from '../server/appInfo.js';
import { runBatch, type BatchInput } from '../server/experiments/batch.js';
import { EXPORT_TABLES, exportBatchCsv, exportCsv } from '../server/experiments/export.js';
import { repeatExperiment } from '../server/experiments/runner.js';
import { MemoryRunStore } from '../server/experiments/store.js';
import type { ExperimentRecord } from '../server/experiments/types.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function args(argv: string[]) {
  const out: Record<string, string[]> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    const val = next && !next.startsWith('--') ? (i++, next) : 'true';
    (out[key] ??= []).push(val);
  }
  return out;
}

function parseModes(s: string | undefined): ModeId[] | undefined {
  if (!s || s === 'all') return undefined;
  return s.split(',').map((x) => {
    const t = x.trim();
    const m = /^\d$/.test(t) ? modeFromNumber(Number(t)) : (t as ModeId);
    if (!m || !['MF_WF', 'MU_WF', 'MF_WU', 'MU_WU'].includes(m)) throw new Error(`неизвестный режим: ${t}`);
    return m;
  });
}

function writeRecord(dir: string, rec: ExperimentRecord): void {
  fs.writeFileSync(path.join(dir, `${rec.experiment_id}.json`), JSON.stringify(rec, null, 2), 'utf8');
  for (const t of EXPORT_TABLES) fs.writeFileSync(path.join(dir, `${rec.experiment_id}-${t}.csv`), `\ufeff${exportCsv(rec, t)}`, 'utf8');
}

function printRecord(rec: ExperimentRecord): void {
  console.log(`\n${rec.experiment_id}  ${rec.problem.context.title}`);
  console.log(`  dataset sha256 ${rec.passport.dataset.problem_sha256.slice(0, 16)}…  result sha256 ${rec.passport.result_sha256.slice(0, 16)}…`);
  for (const r of rec.runs) {
    if (!r.result) {
      console.log(`  ${r.mode}: ошибка — ${r.issues.filter((i) => i.severity === 'error').map((i) => i.message).join('; ')}`);
      continue;
    }
    const top = r.result.primary.ranking.slice(0, 3).map((id) => {
      const a = r.result!.primary.alternatives.find((x) => x.alternative_id === id)!;
      return `${a.name} pBest=${a.p_best.toFixed(3)}±${(1.96 * a.p_best_mcse).toFixed(3)} rank=${a.mean_rank.toFixed(2)}`;
    });
    console.log(`  ${r.mode} (N=${r.result.iterations_effective}): ${top.join(' | ')}`);
  }
  for (const s of rec.sensitivity?.summary ?? []) console.log(`  · ${s}`);
  if (rec.verification)
    console.log(`  повтор ${rec.verification.reference_id}: ${rec.verification.same_result ? 'результат идентичен' : `РАЗЛИЧИЯ: ${rec.verification.differences.join('; ')}`}`);
}

function main(): void {
  const a = args(process.argv.slice(2));
  const out = path.resolve(a.out?.[0] ?? 'results');
  fs.mkdirSync(out, { recursive: true });
  const ctx = { app: readAppInfo(root) };
  if (a.repeat) {
    for (const f of a.repeat) {
      const ref = JSON.parse(fs.readFileSync(f, 'utf8')) as ExperimentRecord;
      const rec = repeatExperiment(ref, ctx);
      writeRecord(out, rec);
      printRecord(rec);
      if (!rec.verification?.same_result) process.exitCode = 2;
    }
    return;
  }
  if (!a.input?.length) {
    console.error('Нужен --input <файл.csv|.json> (можно несколько) или --repeat <запись.json>');
    process.exit(1);
  }
  const overrides: Omit<RunOverrides, 'mode'> = {};
  if (a.n) overrides.iterations = Number(a.n[0]);
  if (a.seed) overrides.seed = Number(a.seed[0]);
  if (a.method) overrides.method = { id: a.method[0] as 'topsis' };
  const inputs: BatchInput[] = a.input.map((f) => ({
    name: path.basename(f),
    format: f.toLowerCase().endsWith('.csv') ? 'csv' : 'json',
    content: fs.readFileSync(f, 'utf8'),
  }));
  const store = new MemoryRunStore();
  const { batch, records } = runBatch(
    inputs,
    {
      modes: parseModes(a.modes?.[0]),
      overrides,
      extra_methods: a['compare-methods'] ? [{ id: 'wsm' }, { id: 'vikor' }].filter((m) => m.id !== (overrides.method?.id ?? '')) as { id: 'wsm' }[] : [],
      sensitivity: !a['no-sensitivity'],
      label: a.label?.[0] ?? null,
    },
    ctx,
    store,
  );
  for (const rec of records) {
    writeRecord(out, rec);
    printRecord(rec);
  }
  for (const it of batch.items.filter((i) => i.status === 'error')) {
    console.error(`\n${it.name}: ОШИБКА — ${it.error}`);
    process.exitCode = 1;
  }
  fs.writeFileSync(path.join(out, `${batch.batch_id}.csv`), `\ufeff${exportBatchCsv(batch, batch.items.map((i) => (i.experiment_id ? store.get(i.experiment_id) : null)))}`, 'utf8');
  console.log(`\nРезультаты: ${out}`);
}

main();
