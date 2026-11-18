import 'dotenv/config';
import { mkdir, readFile, writeFile, appendFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { readAppInfo } from '../server/appInfo.js';
import { runBenchmark } from '../server/llm-eval/runner.js';
import { serviceFromEnv } from '../server/llm/registry.js';

const { values } = parseArgs({ options: {
  cases: { type: 'string', default: 'data/llm-benchmark/cases.json' },
  providers: { type: 'string', default: 'mock' },
  out: { type: 'string', default: 'results/llm-benchmark' },
  repeats: { type: 'string', default: '1' },
  'max-tokens': { type: 'string', default: '6000' },
} });
const corpus = JSON.parse(await readFile(values.cases, 'utf8'));
await mkdir(path.dirname(path.resolve(values.out)), { recursive: true });
// Reserve a new directory before any calls, so no existing report can be overwritten.
await mkdir(values.out);
const partial = path.join(values.out, 'responses.jsonl');
const reportPath = path.join(values.out, 'report.json');
await writeFile(partial, '', { flag: 'wx' });
const service = serviceFromEnv();
const report = await runBenchmark(service, corpus, {
  providers: values.providers.split(',').map((s) => s.trim()).filter(Boolean),
  repeats: Number(values.repeats), maxTokens: Number(values['max-tokens']),
  app: readAppInfo(process.cwd()),
  onResult: async (row) => {
    await appendFile(partial, JSON.stringify(row) + '\n', 'utf8');
    console.log(`${row.provider} ${row.case_id} #${row.repeat}: ${row.status}, F1=${row.raw_metrics.overall.f1?.toFixed(3) ?? 'n/a'}`);
  },
});
await writeFile(reportPath, JSON.stringify(report, null, 2), { flag: 'wx' });
await writeFile(path.join(values.out, 'summary.json'), JSON.stringify(report.summary, null, 2), { flag: 'wx' });
console.log(`Отчёт: ${reportPath}`);
if (report.rows.some((r) => r.status !== 'ok')) process.exitCode = 1;
