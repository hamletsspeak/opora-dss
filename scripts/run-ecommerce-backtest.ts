import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { csvToObjects } from '../shared/csv.js';
import { runBacktest } from '../shared/ecommerce/backtest.js';
import { parseEcomCsv } from '../shared/ecommerce/dataset.js';
import type { ColumnMapping } from '../shared/ecommerce/fields.js';

const { values } = parseArgs({ options: {
  input: { type: 'string' }, mapping: { type: 'string' }, config: { type: 'string' }, out: { type: 'string' },
} });
if (!values.input || !values.mapping || !values.config || !values.out)
  throw new Error('Использование: npx tsx scripts/run-ecommerce-backtest.ts --input data.csv --mapping mapping.json --config config.json --out report.json');
const content = await readFile(values.input, 'utf8');
const mapping = JSON.parse(await readFile(values.mapping, 'utf8')) as ColumnMapping;
const config = JSON.parse(await readFile(values.config, 'utf8'));
const period = config.period ?? 'month';
if (!['day', 'week', 'month'].includes(period)) throw new Error('period: day, week или month');
const dataset = parseEcomCsv(content, mapping, { period });
const report = runBacktest(dataset, config.backtest, config.problem ?? {});
await writeFile(values.out, JSON.stringify({ source: { name: values.input, sha256: createHash('sha256').update(content).digest('hex'), rows: csvToObjects(content).rows.length }, mapping, period, ...report }, null, 2), 'utf8');
console.log(`Сохранён ${values.out}; окон: ${report.folds.length}; MAE: ${report.metrics.mae.toFixed(3)}`);
