import { performance } from 'node:perf_hooks';
import { canonicalJson } from '../../shared/canonical.js';
import { ENGINE } from '../../shared/engine/solve.js';
import { DecisionProblem, validateProblem } from '../../shared/problem/index.js';
import { compareFacts, draftFacts, goldFacts, GROUPS, METRICS_VERSION, problemFacts, scores, TOLERANCE, type Counts } from '../../shared/llm-eval/metrics.js';
import { BenchmarkCorpus, DraftResponse } from '../../shared/llm-eval/schema.js';
import type { AppInfo } from '../appInfo.js';
import { sha256, type LlmCallRecord } from '../llm/callLog.js';
import { buildProblemFromDraft, parseJsonReply } from '../llm/draft.js';
import { formalizeMessages, PROMPT_VERSION } from '../llm/prompts.js';
import { LlmCallFailed, type LlmService } from '../llm/service.js';
import type { CompletionRequest } from '../llm/types.js';

export interface BenchmarkOptions {
  providers: string[];
  temperature?: number;
  maxTokens?: number;
  repeats?: number;
  app?: AppInfo;
  onResult?: (row: BenchmarkRow) => void | Promise<void>;
}

export interface BenchmarkRow {
  case_id: string;
  family: string;
  provider: string;
  repeat: number;
  status: 'ok' | 'invalid_json' | 'invalid_draft' | 'llm_error';
  elapsed_ms: number;
  raw: string | null;
  parsed: unknown;
  strict_json_valid: boolean;
  recovered_json: boolean;
  draft_schema_valid: boolean;
  problem_schema_valid: boolean;
  semantic_valid: boolean;
  run_valid: boolean;
  expected_run_valid: boolean;
  run_validity_matches_gold: boolean;
  errors: unknown[];
  attempts: LlmCallRecord[];
  raw_metrics: ReturnType<typeof compareFacts>;
  processed_metrics: ReturnType<typeof compareFacts> | null;
  processed: ReturnType<typeof buildProblemFromDraft> | null;
}

export function summarizeBenchmark(rows: BenchmarkRow[]) {
  const byProvider = [...new Set(rows.map((r) => r.provider))];
  return byProvider.map((provider) => {
    const rs = rows.filter((r) => r.provider === provider);
    const rate = (f: (r: BenchmarkRow) => boolean) => rs.filter(f).length / rs.length;
    const add = (cs: Counts[]) => scores(cs.reduce((s, c) => ({ tp: s.tp + c.tp, fp: s.fp + c.fp, fn: s.fn + c.fn }), { tp: 0, fp: 0, fn: 0 }));
    const calls = rs.flatMap((r) => r.attempts);
    const currencies = [...new Set(calls.flatMap((c) => c.cost ? [c.cost.currency] : []))];
    return {
      provider, cases: rs.length, failures: rs.filter((r) => r.status !== 'ok').length,
      strict_json_rate: rate((r) => r.strict_json_valid), draft_schema_rate: rate((r) => r.draft_schema_valid),
      problem_schema_rate: rate((r) => r.problem_schema_valid), semantic_valid_rate: rate((r) => r.semantic_valid),
      run_valid_rate: rate((r) => r.run_valid), run_validity_accuracy: rate((r) => r.run_validity_matches_gold),
      exact_fact_match_rate: rate((r) => r.raw_metrics.exact_match && r.draft_schema_valid),
      micro: add(rs.map((r) => r.raw_metrics.overall)),
      by_group: Object.fromEntries(GROUPS.map((g) => [g, add(rs.map((r) => r.raw_metrics.by_group[g]))])),
      unsupported_fact_count: rs.reduce((s, r) => s + r.raw_metrics.unsupported_facts.length, 0),
      cases_with_unsupported_facts: rs.filter((r) => r.raw_metrics.unsupported_facts.length).length,
      facts_unscorable_cases: rs.filter((r) => !r.draft_schema_valid).length,
      mean_elapsed_ms: rs.reduce((s, r) => s + r.elapsed_ms, 0) / rs.length,
      costs: currencies.map((currency) => ({ currency, known_amount: calls.filter((c) => c.cost?.currency === currency).reduce((s, c) => s + c.cost!.amount, 0) })),
      calls_with_unknown_cost: calls.filter((c) => !c.cost).length,
    };
  });
}

/** Same prompts, schema, generation settings and deterministic postprocessing for every provider. */
export async function runBenchmark(service: LlmService, input: unknown, options: BenchmarkOptions) {
  const corpus = BenchmarkCorpus.parse(input);
  const providers = [...new Set(options.providers)];
  const repeats = options.repeats ?? 1;
  const temperature = options.temperature ?? 0;
  const maxTokens = options.maxTokens ?? 6000;
  if (!providers.length || providers.length > 10 || providers.some((p) => !service.registry.get(p))) throw new Error('Укажите зарегистрированные провайдеры');
  if (!Number.isInteger(repeats) || repeats < 1 || repeats > 10 || !Number.isFinite(temperature) || temperature < 0 || temperature > 1 || !Number.isInteger(maxTokens) || maxTokens < 100 || maxTokens > 32000)
    throw new Error('Некорректные repeats, temperature или maxTokens');
  // A malformed or mislabeled gold corpus must never cause chargeable calls.
  for (const c of corpus.cases) {
    const validation = validateProblem(c.gold, { forRun: true });
    if (validation.ok !== c.expected_run_valid) throw new Error(`${c.case_id}: expected_run_valid не соответствует эталону`);
  }
  const started = new Date().toISOString();
  const rows: BenchmarkRow[] = [];
  for (const c of corpus.cases) {
    const expected = goldFacts(c);
    for (let repeat = 1; repeat <= repeats; repeat++) for (const provider of providers) {
      const begin = performance.now();
      const row: BenchmarkRow = {
        case_id: c.case_id, family: c.family, provider, repeat, status: 'llm_error', elapsed_ms: 0,
        raw: null, parsed: null, strict_json_valid: false, recovered_json: false, draft_schema_valid: false,
        problem_schema_valid: false, semantic_valid: false, run_valid: false,
        expected_run_valid: c.expected_run_valid, run_validity_matches_gold: false, errors: [], attempts: [],
        raw_metrics: compareFacts([], expected), processed_metrics: null, processed: null,
      };
      const request: CompletionRequest = { messages: formalizeMessages(c.text), temperature, maxTokens, json: true };
      try {
        const call = await service.call('benchmark', request, { provider, allowFallback: false });
        row.attempts = call.attempts;
        row.raw = call.result.text;
        try { row.parsed = JSON.parse(row.raw); row.strict_json_valid = true; } catch { /* record tolerant recovery separately */ }
        const parsed = parseJsonReply(row.raw);
        if (!parsed.ok) { row.status = 'invalid_json'; row.errors.push(parsed.error); }
        else {
          row.parsed = parsed.value;
          row.recovered_json = !row.strict_json_valid;
          const draft = DraftResponse.safeParse(parsed.value);
          row.draft_schema_valid = draft.success;
          if (!draft.success) { row.status = 'invalid_draft'; row.errors.push(...draft.error.issues); }
          else {
            row.status = 'ok';
            row.raw_metrics = compareFacts(draftFacts(draft.data, c), expected);
            const built = buildProblemFromDraft(parsed.value, c.text, { problemId: c.case_id, now: '1970-01-01T00:00:00.000Z', method: { id: 'topsis', params: { normalization: 'minmax' } }, iterations: 2000, seed: 42 });
            row.processed = built;
            row.problem_schema_valid = DecisionProblem.safeParse(built.problem).success;
            const semantic = validateProblem(built.problem);
            const runnable = validateProblem(built.problem, { forRun: true });
            row.semantic_valid = semantic.ok;
            row.run_valid = runnable.ok;
            row.run_validity_matches_gold = runnable.ok === c.expected_run_valid;
            row.errors.push(...semantic.issues, ...runnable.issues.filter((i) => i.severity === 'error'));
            row.processed_metrics = compareFacts(problemFacts(built.problem, c), expected);
          }
        }
      } catch (error) {
        if (!(error instanceof LlmCallFailed)) throw error;
        row.attempts = error.attempts;
        row.errors.push({ code: error.last.code, provider });
      }
      row.elapsed_ms = performance.now() - begin;
      rows.push(row);
      await options.onResult?.(row);
    }
  }
  return {
    protocol: 'llm-extraction-benchmark-1.0', metrics_version: METRICS_VERSION,
    started_at: started, finished_at: new Date().toISOString(),
    corpus_sha256: sha256(canonicalJson(corpus)), corpus,
    prompt_version: PROMPT_VERSION, prompt_sha256: sha256(canonicalJson(formalizeMessages(''))),
    prompt_template: formalizeMessages(''),
    draft_schema_sha256: sha256(canonicalJson(DraftResponse.toJSONSchema())),
    draft_schema: DraftResponse.toJSONSchema(),
    engine: ENGINE, app: options.app ?? null,
    settings: { temperature, max_tokens: maxTokens, repeats, fallback: false, retries: service.opts.maxRetries, numeric_tolerance: TOLERANCE, postprocessing: { method: 'topsis/minmax', iterations: 2000, seed: 42 }, ranking_executed: false },
    providers: providers.map((id) => service.registry.get(id)!.info),
    rows, summary: summarizeBenchmark(rows),
    limitations: [
      'Синтетические постановки не заменяют независимый размеченный корпус реальных запросов.',
      'Mock — детерминированный парсер по правилам, не языковая модель.',
      'Неподдержанные факты — расхождения с эталоном, а не доказательство намеренного выдумывания.',
      'Невалидным ответам засчитываются пропуски всех gold-фактов; дополнительные факты для них не оцениваются.',
      'Время, request_id и версии удалённых моделей могут меняться; seed ядра не делает генерацию LLM воспроизводимой.',
    ],
  };
}
