import express, { type Router } from 'express';
import {
  ENGINE,
  evaluationSweep,
  METHOD_TITLES,
  METHOD_VERSIONS,
  prepareBase,
  RNG_DESCRIPTION,
  sensitivityReport,
  uncertaintyScaleSweep,
  weightPairGrid,
  weightSweep,
} from '../../shared/engine/index.js';
import { problemsFromJson, tableCsvToProblem } from '../../shared/import/table.js';
import {
  ALL_MODES,
  decisionProblemJsonSchema,
  DEFAULTS,
  EXAMPLES,
  LIMITS,
  MODE_INFO,
  ProblemValidationError,
  SCHEMA_VERSION,
  validateProblem,
  type DecisionProblem,
  type RunOverrides,
} from '../../shared/problem/index.js';
import type { AppDeps } from '../deps.js';
import { runBatch } from '../experiments/batch.js';
import { EXPORT_TABLES, exportBatchCsv, exportCsv, type ExportTable } from '../experiments/export.js';
import { repeatExperiment, runExperiment, summarize } from '../experiments/runner.js';
import { asyncRoute, HttpError, rateLimit } from '../http/middleware.js';
import { explainRun } from '../llm/explain.js';
import { confirmDraft, formalize } from '../llm/formalize.js';
import { PROMPT_VERSION } from '../llm/prompts.js';
import { sha256 } from '../llm/callLog.js';
import {
  BatchBody,
  ConfirmBody,
  ExplainBody,
  FormalizeBody,
  HealthBody,
  ImportBody,
  parseBody,
  RunBody,
  SensitivityBody,
  ValidateBody,
} from './schemas.js';

function requireProblem(input: unknown, forRun = false, overrides?: RunOverrides): DecisionProblem {
  const r = validateProblem(input, { forRun, overrides });
  if (!r.ok || !r.problem) throw new ProblemValidationError(r.issues);
  return r.problem;
}

function attachment(res: express.Response, name: string, type: string, body: string): void {
  res.setHeader('Content-Type', `${type}; charset=utf-8`);
  res.setHeader('Content-Disposition', `attachment; filename="${name.replace(/[^\w.-]/g, '_')}"`);
  res.send(type === 'text/csv' ? `\ufeff${body}` : body);
}

export function v1Router(deps: AppDeps): Router {
  const r = express.Router();
  const json = express.json({ limit: deps.config.jsonLimit });
  const upload = express.json({ limit: deps.config.uploadLimit });
  const llmLimit = rateLimit(deps.config.llmRatePerMinute);
  const ctx = { app: deps.app };

  r.get('/meta', (_req, res) => {
    res.json({
      app: deps.app,
      engine: ENGINE,
      schema_version: SCHEMA_VERSION,
      prompt_version: PROMPT_VERSION,
      methods: Object.fromEntries(Object.entries(METHOD_VERSIONS).map(([k, v]) => [k, { version: v, title: METHOD_TITLES[k as keyof typeof METHOD_TITLES] }])),
      modes: ALL_MODES.map((m) => ({ id: m, ...MODE_INFO[m] })),
      defaults: DEFAULTS,
      limits: LIMITS,
      rng: RNG_DESCRIPTION,
    });
  });

  // ---- problems
  r.get('/problems/schema', (_req, res) => {
    res.json(decisionProblemJsonSchema());
  });
  r.get('/problems/examples', (_req, res) => {
    res.json({ examples: Object.values(EXAMPLES).map((p) => ({ problem_id: p.problem_id, title: p.context.title, goal: p.context.goal ?? null, mode: p.uncertainty.mode, method: p.method.id })) });
  });
  r.get('/problems/examples/:id', (req, res) => {
    const p = Object.values(EXAMPLES).find((x) => x.problem_id === req.params.id);
    if (!p) throw new HttpError(404, 'Пример не найден', 'not_found');
    res.json({ problem: p });
  });
  r.post('/problems/validate', json, (req, res) => {
    const b = parseBody(ValidateBody, req.body);
    res.json(validateProblem(b.problem, { forRun: b.for_run, overrides: b.overrides }));
  });
  r.post(
    '/problems/formalize',
    llmLimit,
    json,
    asyncRoute(async (req, res) => {
      const b = parseBody(FormalizeBody, req.body);
      const out = await formalize(deps.llm, b.text, { provider: b.provider, allowFallback: b.allow_fallback, domain: b.domain });
      res.status(out.status === 'ok' ? 200 : out.status === 'invalid_json' ? 422 : 502).json(out);
    }),
  );
  r.post('/problems/confirm', json, (req, res) => {
    const b = parseBody(ConfirmBody, req.body);
    const out = confirmDraft(b.problem, b.resolved ?? []);
    res.status(out.ok ? 200 : 422).json({ ...out, run_validation: out.problem ? validateProblem(out.problem, { forRun: true }) : null });
  });
  r.post('/problems/import', upload, (req, res) => {
    const b = parseBody(ImportBody, req.body);
    if (b.format === 'csv') {
      const out = tableCsvToProblem(b.content, { title: b.title, delimiter: b.delimiter, source: b.title ?? 'CSV' });
      res.json({ problems: [out.problem], warnings: out.warnings, source: { format: 'csv', sha256: sha256(b.content) } });
      return;
    }
    const list = problemsFromJson(b.content);
    const reports = list.map((p) => validateProblem(p));
    res.json({
      problems: reports.map((x) => x.problem ?? null),
      reports: reports.map((x) => ({ ok: x.ok, issues: x.issues })),
      source: { format: 'json', sha256: sha256(b.content) },
    });
  });

  // ---- runs & experiments
  r.post('/runs', upload, (req, res) => {
    const b = parseBody(RunBody, req.body);
    const rec = runExperiment(
      { problem: b.problem, modes: b.modes, overrides: b.overrides, extra_methods: b.extra_methods, sensitivity: b.sensitivity, label: b.label, source: b.source ?? null },
      ctx,
    );
    deps.store.save(rec);
    res.status(201).json(rec);
  });
  r.post('/sensitivity', json, (req, res) => {
    const b = parseBody(SensitivityBody, req.body);
    const p = requireProblem(b.problem);
    const ov = b.overrides ?? {};
    switch (b.analysis) {
      case 'report':
        res.json(sensitivityReport(p, ov, { maxCells: b.max_cells }));
        return;
      case 'weight':
        res.json(weightSweep(prepareBase(p, ov), { criterion_id: b.criterion_id, from: b.from, to: b.to, step: b.step, precision: b.precision }));
        return;
      case 'evaluation':
        res.json(evaluationSweep(prepareBase(p, ov), { alternative_id: b.alternative_id, criterion_id: b.criterion_id, from: b.from, to: b.to, steps: b.steps }));
        return;
      case 'pair':
        res.json(weightPairGrid(prepareBase(p, ov), b.a, b.b, b.steps));
        return;
      case 'scale':
        res.json(uncertaintyScaleSweep(p, { target: b.target, factors: b.factors, mode: b.mode }, ov));
        return;
    }
  });
  r.get('/experiments', (req, res) => {
    const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 100));
    res.json({ experiments: deps.store.list(limit), storage: { kind: deps.store.kind } });
  });
  const getRec = (id: string) => {
    const rec = deps.store.get(id);
    if (!rec) throw new HttpError(404, 'Эксперимент не найден', 'not_found');
    return rec;
  };
  r.get('/experiments/:id', (req, res) => {
    res.json(getRec(req.params.id));
  });
  r.post('/experiments/:id/repeat', (req, res) => {
    const rec = repeatExperiment(getRec(req.params.id), ctx);
    deps.store.save(rec);
    res.status(201).json(rec);
  });
  r.post(
    '/experiments/:id/explain',
    llmLimit,
    json,
    asyncRoute(async (req, res) => {
      const b = parseBody(ExplainBody, req.body);
      const rec = getRec(String(req.params.id));
      const run = (b.mode ? rec.runs.find((x) => x.mode === b.mode) : [...rec.runs].reverse().find((x) => x.status === 'ok'))?.result;
      if (!run) throw new HttpError(422, 'Нет успешного расчёта для объяснения', 'no_run');
      rec.explanation = await explainRun(deps.llm, run, rec.sensitivity, { provider: b.provider, allowFallback: b.allow_fallback });
      deps.store.save(rec);
      res.json(rec.explanation);
    }),
  );
  r.get('/experiments/:id/export', (req, res) => {
    const rec = getRec(req.params.id);
    const format = String(req.query.format ?? 'json');
    if (format === 'json') return attachment(res, `${rec.experiment_id}.json`, 'application/json', JSON.stringify(rec, null, 2));
    if (format !== 'csv') throw new HttpError(400, 'format: json или csv', 'bad_request');
    const table = String(req.query.table ?? 'ranking') as ExportTable;
    if (!EXPORT_TABLES.includes(table)) throw new HttpError(400, `table: ${EXPORT_TABLES.join(', ')}`, 'bad_request');
    attachment(res, `${rec.experiment_id}-${table}.csv`, 'text/csv', exportCsv(rec, table));
  });
  r.post('/experiments/batch', upload, (req, res) => {
    const b = parseBody(BatchBody, req.body);
    const { batch, records } = runBatch(
      b.items,
      { modes: b.modes === 'all' || !b.modes ? undefined : b.modes, overrides: b.overrides, extra_methods: b.extra_methods, sensitivity: b.sensitivity, label: b.label },
      ctx,
      deps.store,
    );
    res.status(201).json({ batch, summaries: records.map(summarize) });
  });
  r.get('/batches', (_req, res) => {
    res.json({ batches: deps.store.listBatches() });
  });
  r.get('/batches/:id', (req, res) => {
    const b = deps.store.getBatch(req.params.id);
    if (!b) throw new HttpError(404, 'Пакет не найден', 'not_found');
    res.json(b);
  });
  r.get('/batches/:id/export', (req, res) => {
    const b = deps.store.getBatch(req.params.id);
    if (!b) throw new HttpError(404, 'Пакет не найден', 'not_found');
    const recs = b.items.map((it) => (it.experiment_id ? deps.store.get(it.experiment_id) : null));
    attachment(res, `${b.batch_id}.csv`, 'text/csv', exportBatchCsv(b, recs));
  });

  // ---- LLM providers
  r.get('/llm/providers', (_req, res) => {
    res.json({
      default: deps.llm.registry.defaultId,
      fallback: deps.llm.registry.fallback,
      config_errors: deps.llm.registry.configErrors,
      providers: deps.llm.registry.list(),
      note: 'Резервные провайдеры используются только если перечислены в LLM_FALLBACK; использованный провайдер всегда указывается в ответе.',
    });
  });
  r.post(
    '/llm/health',
    llmLimit,
    json,
    asyncRoute(async (req, res) => {
      const b = parseBody(HealthBody, req.body);
      const p = deps.llm.registry.get(b.provider);
      if (!p) throw new HttpError(404, `Провайдер «${b.provider}» не зарегистрирован`, 'not_found');
      res.json(await p.health());
    }),
  );
  r.get('/llm/calls', (req, res) => {
    res.json({ calls: deps.llm.log.list(Math.min(1000, Math.max(1, Number(req.query.limit) || 100))) });
  });

  return r;
}
