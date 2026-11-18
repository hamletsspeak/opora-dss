import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BenchmarkCorpus, DraftResponse, type BenchmarkCase } from '../shared/llm-eval/schema.js';
import { compareFacts, draftFacts, goldFacts, scores, type Fact } from '../shared/llm-eval/metrics.js';
import { runBenchmark } from '../server/llm-eval/runner.js';
import { MockProvider } from '../server/llm/providers/mock.js';
import { ProviderRegistry } from '../server/llm/registry.js';
import { CallLog } from '../server/llm/callLog.js';
import { LlmService } from '../server/llm/service.js';
import { buildProblemFromDraft } from '../server/llm/draft.js';
import { validateProblem } from '../shared/problem/index.js';

const corpus = BenchmarkCorpus.parse(JSON.parse(await readFile(new URL('../data/llm-benchmark/cases.json', import.meta.url), 'utf8')));
const example = corpus.cases[0];

// Test-only oracle: never registered by the benchmark CLI and never used to generate gold.
function oracle(c: BenchmarkCase): DraftResponse {
  return {
    alternatives: c.gold.alternatives.map((a) => ({ id: a.alternative_id, name: a.name, source_quote: a.name })),
    criteria: c.gold.criteria.map((k) => ({ id: k.criterion_id, name: k.name, direction: k.direction, unit: k.unit, direction_basis: 'explicit', source_quote: k.name })),
    evaluations: c.gold.evaluations.flatMap<DraftResponse['evaluations'][number]>((e) => e.value.kind === 'exact'
      ? [{ alternative: e.alternative_id, criterion: e.criterion_id, value: e.value.value }]
      : e.value.kind === 'interval' ? [{ alternative: e.alternative_id, criterion: e.criterion_id, lower: e.value.lower, upper: e.value.upper }] : []),
    weights: c.gold.weights.items.filter((w) => w.value != null || w.lower != null || w.upper != null).map((w) => ({ criterion: w.criterion_id, value: w.value == null ? null : w.value * 100, lower: w.lower == null ? null : w.lower * 100, upper: w.upper == null ? null : w.upper * 100, unit: 'percent' })),
    weight_order: (c.gold.weights.ordinal ?? []).map((w) => ({ greater: w.greater, lesser: w.lesser })),
    constraints: c.gold.constraints.map((k) => k.type === 'exclude' ? { kind: 'exclude', alternative: k.alternative_id } : { kind: 'threshold', criterion: k.criterion_id, op: k.op, value: k.value }),
  };
}

test('benchmark corpus: 36 уникальных постановок, gold соответствует контракту и ожидаемой готовности', () => {
  assert.equal(corpus.cases.length, 36);
  assert.equal(new Set(corpus.cases.map((c) => c.text)).size, 36);
  assert.equal(new Set(corpus.cases.map((c) => c.family)).size, 12);
  for (const c of corpus.cases) {
    assert.equal(validateProblem(c.gold, { forRun: true }).ok, c.expected_run_valid, c.case_id);
    assert.ok(compareFacts(draftFacts(oracle(c), c), goldFacts(c)).exact_match, c.case_id);
  }
});

test('benchmark metrics: дубликаты, ошибки привязки, числа и пропуски дают отдельные FP/FN', () => {
  const fact: Fact = { group: 'evaluations', key: 'a,c', values: ['exact', 10] };
  assert.equal(compareFacts([fact], [fact]).overall.f1, 1);
  const counts = compareFacts([fact, fact, { ...fact, key: 'other' }], [fact]).overall;
  assert.deepEqual({ tp: counts.tp, fp: counts.fp, fn: counts.fn }, { tp: 1, fp: 2, fn: 0 });
  const incorrect = compareFacts([{ ...fact, values: ['exact', 11] }], [fact]);
  assert.deepEqual(incorrect.overall, { tp: 0, fp: 1, fn: 1, precision: 0, recall: 0, f1: 0 });
  assert.equal(incorrect.unsupported_facts.length, 1);
  assert.equal(compareFacts([{ ...fact, values: ['exact', 10 + 1e-7] }], [fact]).exact_match, true);
  assert.equal(scores({ tp: 0, fp: 0, fn: 0 }).f1, null);
});

test('benchmark metrics: распознавание по именам/алиасам независимо от ids, интервал не равен точке', () => {
  const draft = oracle(example);
  draft.criteria[0].name = 'Стоимость';
  draft.criteria[0].id = 'new-id';
  draft.evaluations.filter((e) => e.criterion === 'c1').forEach((e) => { e.criterion = 'new-id'; });
  draft.weights[0].criterion = 'new-id';
  assert.equal(compareFacts(draftFacts(draft, example), goldFacts(example)).exact_match, true);
  draft.evaluations[0] = { alternative: 'a1', criterion: 'new-id', lower: 480.5, upper: 480.5 };
  assert.equal(compareFacts(draftFacts(draft, example), goldFacts(example)).by_group.evaluations.fp, 1);
  const absent = corpus.cases.find((c) => c.family === 'missing_evaluation')!;
  const invented = oracle(absent);
  invented.evaluations.push({ alternative: 'a2', criterion: 'c2', value: 5 });
  assert.equal(compareFacts(draftFacts(invented, absent), goldFacts(absent)).unsupported_facts.length, 1, 'число из другой ячейки не подтверждает выдуманную оценку');
});

test('benchmark runner: два провайдера, одинаковые запросы, gold не передаётся модели, рейтинг не рассчитывается', async () => {
  const response = JSON.stringify(oracle(example));
  const a = new MockProvider({ id: 'a', script: [response] });
  const b = new MockProvider({ id: 'b', script: [response] });
  const service = new LlmService(new ProviderRegistry([a, b], 'a'), new CallLog(), { maxRetries: 0, retryDelayMs: 0 });
  const events: string[] = [];
  const report = await runBenchmark(service, { ...corpus, cases: [example] }, { providers: ['a', 'b'], onResult: (r) => { events.push(r.provider); } });
  assert.deepEqual(a.calls, b.calls);
  assert.ok(!JSON.stringify(a.calls).includes('criterion_aliases'));
  assert.ok(!JSON.stringify(a.calls).includes('expected_run_valid'));
  assert.equal(report.rows.length, 2);
  assert.deepEqual(events, ['a', 'b']);
  for (const row of report.rows) {
    assert.equal(row.raw_metrics.overall.f1, 1);
    assert.equal(row.run_valid, true);
    assert.equal(row.strict_json_valid, true);
    assert.equal(row.attempts[0].purpose, 'benchmark');
    assert.equal(row.attempts[0].fallback_from, null);
  }
  assert.equal(report.settings.ranking_executed, false);
  assert.equal(report.summary[0].calls_with_unknown_cost, 1);
  assert.deepEqual(report.summary[0].costs, []);
});

test('benchmark runner: raw-галлюцинация остаётся в метриках после удаления фильтром', async () => {
  const draft = oracle(example);
  draft.alternatives.push({ id: 'fiction', name: 'Несуществующий поставщик', source_quote: 'нет такой цитаты' });
  const model = new MockProvider({ script: [JSON.stringify(draft)] });
  const service = new LlmService(new ProviderRegistry([model], 'mock'), new CallLog());
  const { rows: [row] } = await runBenchmark(service, { ...corpus, cases: [example] }, { providers: ['mock'] });
  assert.equal(row.raw_metrics.by_group.alternatives.fp, 1);
  assert.equal(row.processed_metrics!.by_group.alternatives.fp, 0);
  assert.equal(row.processed!.hallucinations.length, 1);
});

test('benchmark runner: ошибки, JSON recovery и отказ без fallback учитываются в знаменателе', async () => {
  const model = new MockProvider({ script: ['bad json', '```json\n' + JSON.stringify(oracle(example)) + '\n```', { error: 'timeout' }, '{"ranking":["a"]}'] });
  const fallback = new MockProvider({ id: 'fallback' });
  const service = new LlmService(new ProviderRegistry([model, fallback], 'mock', ['fallback']), new CallLog(), { maxRetries: 0, retryDelayMs: 0 });
  const result = await runBenchmark(service, { ...corpus, cases: [example] }, { providers: ['mock'], repeats: 4 });
  assert.deepEqual(result.rows.map((r) => r.status), ['invalid_json', 'ok', 'llm_error', 'invalid_draft']);
  assert.equal(result.rows[1].recovered_json, true);
  assert.equal(result.rows[1].strict_json_valid, false);
  assert.equal(result.summary[0].strict_json_rate, 0.25);
  assert.equal(result.summary[0].draft_schema_rate, 0.25);
  assert.equal(result.summary[0].facts_unscorable_cases, 3);
  assert.equal(fallback.calls.length, 0);
  assert.ok(result.summary[0].micro.recall! < 1);
});

test('benchmark runner: неверный gold отклоняется до обращения к провайдеру', async () => {
  const model = new MockProvider();
  const service = new LlmService(new ProviderRegistry([model], 'mock'), new CallLog());
  await assert.rejects(runBenchmark(service, { ...corpus, cases: [{ ...example, expected_run_valid: false }] }, { providers: ['mock'] }), /эталону/);
  assert.equal(model.calls.length, 0);
});

test('benchmark mock: весь корпус обрабатывается офлайн, слабые результаты не заменяются gold', async () => {
  const model = new MockProvider();
  const service = new LlmService(new ProviderRegistry([model], 'mock'), new CallLog());
  const result = await runBenchmark(service, corpus, { providers: ['mock'] });
  assert.equal(result.rows.length, 36);
  assert.equal(result.summary[0].strict_json_rate, 1);
  assert.ok(result.summary[0].micro.f1! < 1);
  assert.ok(result.rows.some((r) => r.raw_metrics.overall.f1 === 0));
  // The converter itself remains available, independent of the benchmark.
  const built = buildProblemFromDraft(oracle(example), example.text, { problemId: 'control' });
  assert.ok(validateProblem(built.problem).ok);
});
