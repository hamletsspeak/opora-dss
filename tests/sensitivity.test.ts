import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mixedUncertainty, supplierDemo, thresholdControl } from '../shared/problem/index.js';
import {
  evaluationSweep,
  prepareBase,
  sensitivityReport,
  uncertaintyScaleSweep,
  weightPairGrid,
  weightSweep,
} from '../shared/engine/index.js';
import { clone, exactProblem } from './helpers.js';

describe('пороги смены лидера', () => {
  test('WSM, аналитика: B при w < 1/3, C при 1/3 < w < 2/3, A при w > 2/3', () => {
    const base = prepareBase(clone(thresholdControl));
    const s = weightSweep(base, { criterion_id: 'c1' });
    assert.equal(s.analytic, true);
    assert.equal(s.change_points.length, 2);
    assert.ok(Math.abs(s.change_points[0].at - 1 / 3) < 1e-12);
    assert.ok(Math.abs(s.change_points[1].at - 2 / 3) < 1e-12);
    assert.deepEqual(s.segments.map((x) => x.leader_ids), [['B'], ['C'], ['A']]);
    assert.equal(s.statements[0], 'w(Критерий 1) < 0.3333 → B');
    assert.equal(s.statements[2], 'w(Критерий 1) ≥ 0.6667 → A');
    assert.ok(Math.abs((s.nearest_change.min_abs_delta ?? 0) - 1 / 6) < 1e-12);
  });

  test('TOPSIS, численный поиск: порог w = 0.5 с заявленной точностью', () => {
    const p = exactProblem({ matrix: [[1, 0], [0, 1]], directions: ['max', 'max'], weights: [0.3, 0.7], method: { id: 'topsis' } });
    const base = prepareBase(p);
    const s = weightSweep(base, { criterion_id: 'c1', step: 0.07, precision: 1e-7 });
    assert.equal(s.analytic, false);
    assert.equal(s.change_points.length, 1);
    assert.ok(Math.abs(s.change_points[0].at - 0.5) <= 1e-7);
    assert.deepEqual(s.change_points[0].before, ['a2']);
    assert.deepEqual(s.change_points[0].after, ['a1']);
  });

  test('аналитический и численный поиск согласуются на WSM', () => {
    const base = prepareBase(clone(supplierDemo), { method: { id: 'wsm' } });
    for (const c of base.critIds) {
      const a = weightSweep(base, { criterion_id: c });
      const n = weightSweep(base, { criterion_id: c, numeric: true, step: 0.005, precision: 1e-8 });
      assert.equal(a.change_points.length, n.change_points.length, `критерий ${c}`);
      a.change_points.forEach((cp, k) => {
        assert.ok(Math.abs(cp.at - n.change_points[k].at) <= 1e-7, `${c}: ${cp.at} vs ${n.change_points[k].at}`);
        assert.deepEqual(cp.before, n.change_points[k].before);
        assert.deepEqual(cp.after, n.change_points[k].after);
      });
    }
  });

  test('отсутствие смены лидера описывается корректно', () => {
    const p = exactProblem({ matrix: [[10, 10], [1, 1]], directions: ['max', 'max'], weights: [0.5, 0.5] });
    const s = weightSweep(prepareBase(p), { criterion_id: 'c1' });
    assert.equal(s.change_points.length, 0);
    assert.match(s.statements[0], /смены лидера нет/);
    assert.equal(s.nearest_change.min_abs_delta, null);
  });

  test('чувствительность к оценке: смена лидера при изменении одной оценки', () => {
    // a1 = (10, 0), a2 = (0, 10), веса 0.6/0.4 → a1 лидирует; при x(a1,c1) ниже порога лидер a2
    const p = exactProblem({ matrix: [[10, 0], [0, 10], [5, 5]], directions: ['max', 'max'], weights: [0.6, 0.4] });
    const base = prepareBase(p);
    const s = evaluationSweep(base, { alternative_id: 'a1', criterion_id: 'c1', from: 0, to: 10, steps: 50 });
    assert.ok(s.change_points.length >= 1);
    const last = s.segments.at(-1)!;
    assert.deepEqual(last.leader_ids, ['a1']);
  });

  test('сводный отчёт называет чувствительные параметры и не меняет задачу', () => {
    const p = clone(mixedUncertainty);
    const before = JSON.stringify(p);
    const r = sensitivityReport(p);
    assert.equal(JSON.stringify(p), before);
    assert.ok(r.critical.some((c) => c.type === 'weight' && c.flip_at !== null));
    assert.ok(r.summary.some((s) => s.includes('Наиболее чувствителен вес')));
  });
});

describe('масштаб неопределённости и пары весов', () => {
  test('коэффициент 0 эквивалентен фиксированным значениям', () => {
    const p = clone(supplierDemo);
    const r = uncertaintyScaleSweep(p, { target: 'both', factors: [0, 1] }, { iterations: 500 });
    const zero = r.rows[0];
    assert.equal(Math.max(...Object.values(zero.p_best)), 1);
  });

  test('карта лидера по паре весов покрывает симплекс', () => {
    const base = prepareBase(clone(thresholdControl));
    const g = weightPairGrid(base, 'c1', 'c2', 10);
    assert.equal(g.cells.length, 66);
    const corner = g.cells.find((c) => c.wa === 1 && c.wb === 0)!;
    assert.deepEqual(corner.leader_ids, ['A']);
  });
});
