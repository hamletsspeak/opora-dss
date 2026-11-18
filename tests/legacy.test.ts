import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { runRobustMcdm } from '../shared/mcdm.js';
import { runRobustMcdmV0 } from '../shared/legacy/mcdmV0.js';
import { sessionToProblem } from '../shared/problem/fromSession.js';
import { validateProblem } from '../shared/problem/index.js';
import { applyDemoSuppliers } from '../shared/demo.js';
import { emptySession, type SessionState } from '../shared/types.js';

function exactSession(): SessionState {
  return {
    ...emptySession(),
    context: 'точная задача',
    criteria: [
      { id: 'price', name: 'Цена', direction: 'min', weight: 0.5, importance: 'medium' },
      { id: 'quality', name: 'Качество', direction: 'max', weight: 0.5, importance: 'medium' },
    ],
    alternatives: [
      { id: 'a', name: 'A', scores: { price: 100, quality: 8 } },
      { id: 'b', name: 'B', scores: { price: 90, quality: 7.4 } },
      { id: 'c', name: 'C', scores: { price: 120, quality: 9 } },
    ],
  };
}

describe('legacy API поверх нового ядра', () => {
  test('форма ответа McdmResult сохранена; основной рейтинг = TOPSIS', () => {
    const r = runRobustMcdm(applyDemoSuppliers(emptySession()), 400, 3);
    assert.equal(r.ranking[0].alternativeId, r.methods.topsis[0].alternativeId);
    assert.ok(Math.abs(r.ranking.reduce((s, x) => s + x.winRate, 0) - 1) < 1e-9);
    assert.equal(r.mcdmParams.seed, 3);
    assert.ok(r.mode && r.robustness?.length && r.sensitivity?.summary.length);
  });

  test('сессия конвертируется в валидную DecisionProblem', () => {
    const { problem } = sessionToProblem(applyDemoSuppliers(emptySession()));
    const rep = validateProblem(problem, { forRun: true });
    assert.equal(rep.ok, true, JSON.stringify(rep.issues.filter((i) => i.severity === 'error')));
  });

  test('D1: v0 возмущал точные веса; v1 считает точную задачу детерминированно', () => {
    const s = exactSession();
    const v0 = runRobustMcdmV0(s, 2000, 42);
    const v1 = runRobustMcdm(s, 2000, 42);
    assert.equal(v1.mode?.id, 'MF_WF');
    assert.equal(v1.samples, 1);
    assert.equal(Math.max(...v1.ranking.map((x) => x.winRate)), 1);
    for (const [id, w] of Object.entries(v1.weightMeans)) assert.equal(w, s.criteria.find((c) => c.id === id)!.weight);
    assert.ok(Math.max(...v0.ranking.map((x) => x.winRate)) < 1, 'ожидалось, что v0 «размазывает» точную задачу');
  });
});
