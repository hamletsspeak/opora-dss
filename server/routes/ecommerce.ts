import express from 'express';
import { z } from 'zod';
import type { AppDeps } from '../deps.js';
import { parseBody } from './schemas.js';
import { AssumptionsSchema, availability } from '../../shared/ecommerce/actions.js';
import { BacktestConfig, cutoffIndex, prepareSku, runBacktest } from '../../shared/ecommerce/backtest.js';
import { parseEcomCsv } from '../../shared/ecommerce/dataset.js';
import { demoDataset } from '../../shared/ecommerce/demo.js';
import { FIELDS, mappingErrors, suggestMapping, type ColumnMapping } from '../../shared/ecommerce/fields.js';
import { buildSkuProblem } from '../../shared/ecommerce/problem.js';
import { csvToObjects } from '../../shared/csv.js';
import { MethodSpec, ProblemValidationError, validateProblem } from '../../shared/problem/index.js';

const Mapping = z.record(z.enum(FIELDS.map((f) => f.key)), z.string().max(200).nullable());
const DatasetBody = z.strictObject({
  content: z.string().min(1).max(5 * 1024 * 1024),
  mapping: Mapping,
  period: z.enum(['day', 'week', 'month']),
});
const ProblemConfig = z.strictObject({
  actions: z.array(z.enum(['increase_purchase', 'keep', 'price_cut', 'promote', 'reduce_purchase', 'delist'])).min(2).max(6).optional(),
  criteria: z.array(z.enum(['gross_profit', 'lost_sales_share', 'stockout_risk', 'ending_cover', 'capital_tied', 'holding_cost', 'turnover', 'return_cost'])).min(1).max(8).optional(),
  assumptions: AssumptionsSchema.partial().optional(),
  weights: z.record(z.string().max(64), z.strictObject({ value: z.number().optional(), lower: z.number().optional(), upper: z.number().optional() })).optional(),
  method: MethodSpec.optional(),
  mode: z.enum(['MF_WF', 'MU_WF', 'MF_WU', 'MU_WU']).optional(),
  iterations: z.number().int().min(1).max(10_000).optional(),
  seed: z.number().int().min(0).max(4294967295).optional(),
});

export function ecommerceRouter(deps: AppDeps) {
  const r = express.Router();
  r.use(express.json({ limit: deps.config.uploadLimit }));
  r.get('/demo-dataset', (_req, res) => {
    res.type('text/csv').attachment('synthetic-monthly.csv').send('\ufeff' + demoDataset());
  });
  r.post('/inspect', (req, res) => {
    const body = parseBody(z.strictObject({ content: z.string().min(1).max(5 * 1024 * 1024) }), req.body);
    const { header, rows } = csvToObjects(body.content);
    res.json({ fields: FIELDS, headers: header, rows: rows.length, preview: rows.slice(0, 5), suggested_mapping: suggestMapping(header), requires_mapping_confirmation: true });
  });
  r.post('/mapping', (req, res) => {
    const body = parseBody(DatasetBody, req.body);
    const { header } = csvToObjects(body.content);
    const errors = mappingErrors(body.mapping as ColumnMapping, header);
    if (errors.length) { res.status(400).json({ errors }); return; }
    const dataset = parseEcomCsv(body.content, body.mapping, { period: body.period });
    res.json({ stats: dataset.stats, coverage: dataset.coverage, warnings: dataset.warnings, skus: dataset.skus.map((s) => ({ sku: s.sku, name: s.name })), availability: availability(dataset.coverage), note: 'Доступность по всему файлу — справочная; при расчёте используются только поля train.' });
  });
  r.post('/problem', (req, res) => {
    const body = parseBody(DatasetBody.extend({ sku: z.string().min(1).max(200), cutoff: z.string().max(10), train_periods: z.number().int().min(3).max(3660).default(12), window: z.number().int().min(3).max(3660).default(12), config: ProblemConfig.default({}) }), req.body);
    const dataset = parseEcomCsv(body.content, body.mapping, { period: body.period });
    const { features, fields } = prepareSku(dataset, body.sku, cutoffIndex(body.cutoff, dataset), body.train_periods, body.window);
    const built = buildSkuProblem(features, { ...body.config, fields_present: fields });
    const validation = validateProblem(built.problem, { forRun: true });
    if (!validation.ok) throw new ProblemValidationError(validation.issues);
    res.json({ problem: built.problem, assumptions: built.assumptions, excluded_actions: built.excluded_actions, excluded_criteria: built.excluded_criteria, features, warnings: dataset.warnings });
  });
  r.post('/backtest', (req, res) => {
    const body = parseBody(DatasetBody.extend({ backtest: BacktestConfig, config: ProblemConfig.default({}) }), req.body);
    const dataset = parseEcomCsv(body.content, body.mapping, { period: body.period });
    res.json(runBacktest(dataset, body.backtest, body.config));
  });
  return r;
}
