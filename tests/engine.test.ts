import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  ALL_MODES,
  ProblemValidationError,
  mixedUncertainty,
  supplierDemo,
  validateProblem,
  type DecisionProblem,
} from '../shared/problem/index.js';
import { rankScores, solve } from '../shared/engine/index.js';
import { clone, exactProblem } from './helpers.js';

describe('фиксированные значения не меняются', () => {
  test('точные веса при W fixed идентичны на всех итерациях', () => {
    const p = clone(supplierDemo);
    const exact = p.weights.items.map((w) => w.value as number);
    let n = 0;
    solve(p, {
      overrides: { mode: 'MU_WF', iterations: 500 },
      onIteration: (_, w) => {
        n++;
        assert.deepEqual([...w], exact);
      },
    });
    assert.equal(n, 500);
  });

  test('частично фиксированный вес не меняется в режиме W uncertain', () => {
    const p = clone(mixedUncertainty);
    const j = p.criteria.findIndex((c) => c.criterion_id === 'cost');
    solve(p, {
      overrides: { mode: 'MU_WU', iterations: 800 },
      onIteration: (_, w) => assert.equal(w[j], 0.4),
    });
  });

  test('фиксированная матрица M не возмущается (MF_WU)', () => {
    const p = clone(supplierDemo);
    const first: number[][][] = [];
    solve(p, {
      overrides: { mode: 'MF_WU', iterations: 300 },
      onIteration: (_, __, X) => {
        if (!first.length) first.push(X.map((r) => [...r]));
        assert.deepEqual(
          X.map((r) => [...r]),
          first[0],
        );
      },
    });
    // point estimates = interval midpoints, exact cells unchanged
    assert.equal(first[0][0][0], 480);
    assert.equal(first[0][0][1], 5);
  });

  test('точные оценки M не меняются в режиме M uncertain', () => {
    const p = clone(supplierDemo);
    solve(p, {
      overrides: { mode: 'MU_WU', iterations: 400 },
      onIteration: (_, __, X) => {
        assert.equal(X[0][1], 5); // alpha lead_time exact
        assert.equal(X[2][0], 520); // gamma price exact
        assert.equal(X[1][2], 0.8); // beta defect exact
      },
    });
  });

  test('исходная задача не модифицируется расчётом', () => {
    const p = clone(mixedUncertainty);
    const before = JSON.stringify(p);
    for (const mode of ALL_MODES) solve(p, { overrides: { mode, iterations: 200 } });
    assert.equal(JSON.stringify(p), before);
  });
});

describe('направления min/max', () => {
  for (const method of [{ id: 'wsm' }, { id: 'topsis' }, { id: 'topsis', params: { normalization: 'vector' } }, { id: 'vikor' }] as DecisionProblem['method'][]) {
    test(`min и max для ${method.id}${method.params?.normalization ? `/${method.params.normalization}` : ''}`, () => {
      const pMin = exactProblem({ matrix: [[10, 1], [20, 1]], directions: ['min', 'max'], weights: [0.9, 0.1], method });
      assert.deepEqual(solve(pMin).baseline.leader_ids, ['a1']);
      const pMax = exactProblem({ matrix: [[10, 1], [20, 1]], directions: ['max', 'max'], weights: [0.9, 0.1], method });
      assert.deepEqual(solve(pMax).baseline.leader_ids, ['a2']);
    });
  }
});

describe('генерация неопределённых оценок M', () => {
  test('значения не выходят за границы интервалов; треугольное среднее ≈ (l+m+u)/3', () => {
    const p = clone(mixedUncertainty);
    let sum = 0;
    let n = 0;
    solve(p, {
      overrides: { mode: 'MU_WF', iterations: 6000 },
      onIteration: (_, __, X) => {
        const c = X[0][0]; // op1 cost: triangular [180, 220], mode 190
        assert.ok(c >= 180 && c <= 220);
        const otd = X[2][1]; // op3 otd uniform [85, 93]
        assert.ok(otd >= 85 && otd <= 93);
        sum += c;
        n++;
      },
    });
    assert.ok(Math.abs(sum / n - (180 + 190 + 220) / 3) < 0.6);
  });

  test('сценарии выбираются с заданными вероятностями', () => {
    const p = clone(mixedUncertainty);
    let peak = 0;
    const N = 10000;
    solve(p, {
      overrides: { mode: 'MU_WF', iterations: N },
      onIteration: (_, __, X) => {
        const v = X[1][1]; // op2 otd: 97 (0.7) / 88 (0.3)
        assert.ok(v === 97 || v === 88);
        if (v === 88) peak++;
      },
    });
    const sd = Math.sqrt((0.3 * 0.7) / N);
    assert.ok(Math.abs(peak / N - 0.3) < 4 * sd, `доля ${peak / N}`);
  });

  test('пропуск при worst_observed заменяется худшим значением столбца', () => {
    const p = clone(mixedUncertainty);
    solve(p, {
      overrides: { mode: 'MU_WF', iterations: 300 },
      onIteration: (_, __, X) => {
        const col = [X[0][2], X[2][2]]; // op4 excluded by budget
        assert.equal(X[1][2], Math.max(...col));
      },
    });
  });
});

describe('генерация неопределённых весов W', () => {
  const check = (p: DecisionProblem, sampler: 'polytope_rejection' | 'polytope_hit_and_run' | 'dirichlet') => {
    const means = new Array(p.criteria.length).fill(0);
    const N = 4000;
    solve(p, {
      overrides: { mode: 'MF_WU', iterations: N, w: { sampler, dirichlet_alpha: { cost: 1, otd: 2, damage: 1, coverage: 1 } } },
      onIteration: (_, w) => {
        const s = w.reduce((a, b) => a + b, 0);
        assert.ok(Math.abs(s - 1) < 1e-9, `сумма ${s}`);
        p.weights.items.forEach((it, j) => {
          const lo = it.lower ?? it.value ?? 0;
          const hi = it.upper ?? it.value ?? 1;
          assert.ok(w[j] >= lo - 1e-9 && w[j] <= hi + 1e-9, `${it.criterion_id}=${w[j]}`);
          means[j] += w[j] / N;
        });
        for (const o of p.weights.ordinal ?? []) {
          const g = p.criteria.findIndex((c) => c.criterion_id === o.greater);
          const l = p.criteria.findIndex((c) => c.criterion_id === o.lesser);
          assert.ok(w[g] >= w[l] - 1e-9);
        }
      },
    });
    return means;
  };

  test('отбраковка: Σw = 1, границы и порядковые ограничения соблюдены', () => {
    check(clone(mixedUncertainty), 'polytope_rejection');
  });

  test('hit-and-run: те же ограничения; средние близки к методу отбраковки (оба равномерны)', () => {
    const a = check(clone(mixedUncertainty), 'polytope_rejection');
    const b = check(clone(mixedUncertainty), 'polytope_hit_and_run');
    a.forEach((x, j) => assert.ok(Math.abs(x - b[j]) < 0.01, `критерий ${j}: ${x} vs ${b[j]}`));
  });

  test('усечённый Дирихле: ограничения соблюдены', () => {
    check(clone(mixedUncertainty), 'dirichlet');
  });

  test('сценарии весов выбираются с заданными вероятностями, фиксированный вес не меняется', () => {
    const p = clone(mixedUncertainty);
    p.weights.scenarios = [
      { label: 's1', probability: 0.25, values: { cost: 0.4, otd: 0.3, damage: 0.15, coverage: 0.15 } },
      { label: 's2', probability: 0.75, values: { cost: 0.4, otd: 0.4, damage: 0.1, coverage: 0.1 } },
    ];
    let s2 = 0;
    const N = 8000;
    solve(p, {
      overrides: { mode: 'MF_WU', iterations: N, w: { sampler: 'scenarios' } },
      onIteration: (_, w) => {
        assert.equal(w[0], 0.4);
        if (w[1] === 0.4) s2++;
      },
    });
    assert.ok(Math.abs(s2 / N - 0.75) < 4 * Math.sqrt((0.25 * 0.75) / N));
  });

  test('сценарий, меняющий фиксированный вес, отклоняется', () => {
    const p = clone(mixedUncertainty);
    p.weights.scenarios = [{ probability: 1, values: { cost: 0.5, otd: 0.3, damage: 0.1, coverage: 0.1 } }];
    const r = validateProblem(p, { forRun: true, overrides: { mode: 'MF_WU', w: { sampler: 'scenarios' } } });
    assert.ok(r.issues.some((i) => i.code === 'scenario_changes_fixed_weight'));
  });
});

describe('валидация весов', () => {
  test('сумма нижних границ > 1 — допустимого вектора нет', () => {
    const p = clone(supplierDemo);
    p.weights.items[0].lower = 0.6;
    p.weights.items[0].upper = 0.7;
    p.weights.items[0].value = 0.65;
    p.weights.items[1].lower = 0.35;
    p.weights.items[1].value = 0.35;
    const r = validateProblem(p, { forRun: true, overrides: { mode: 'MF_WU' } });
    const e = r.issues.find((i) => i.code === 'weights_infeasible_lower');
    assert.ok(e);
    assert.match(e!.message, /допустимого нормированного вектора весов не существует/);
  });

  test('сумма верхних границ < 1 — допустимого вектора нет', () => {
    const p = clone(supplierDemo);
    for (const w of p.weights.items) w.upper = 0.2;
    for (const w of p.weights.items) w.value = null;
    for (const w of p.weights.items) w.lower = 0;
    const r = validateProblem(p, { forRun: true, overrides: { mode: 'MF_WU' } });
    assert.ok(r.issues.some((i) => i.code === 'weights_infeasible_upper'));
  });

  test('точные веса с суммой ≠ 1 не нормируются, а отклоняются', () => {
    const p = exactProblem({ matrix: [[1, 2], [2, 1]], directions: ['max', 'max'], weights: [0.5, 0.6] });
    assert.throws(() => solve(p), (e: unknown) => e instanceof ProblemValidationError && e.issues.some((i) => i.code === 'weights_sum'));
  });

  test('режим W fixed без точных весов отклоняется', () => {
    const p = clone(supplierDemo);
    p.weights.items[2].value = null;
    const r = validateProblem(p, { forRun: true, overrides: { mode: 'MU_WF' } });
    assert.ok(r.issues.some((i) => i.code === 'weights_not_exact'));
  });

  test('пропуск при правиле reject отклоняется', () => {
    const p = clone(supplierDemo);
    p.evaluations[0].value = { kind: 'missing' };
    const r = validateProblem(p, { forRun: true });
    assert.ok(r.issues.some((i) => i.code === 'evaluation_missing'));
  });

  test('отсутствующая пара оценки отклоняется (пропуск должен быть явным)', () => {
    const p = clone(supplierDemo);
    p.evaluations.pop();
    const r = validateProblem(p, { forRun: true });
    assert.ok(r.issues.some((i) => i.code === 'evaluation_absent'));
  });

  test('треугольное распределение без моды отклоняется', () => {
    const p = clone(supplierDemo);
    const r = validateProblem(p, { forRun: true, overrides: { m: { default_interval_distribution: 'triangular' } } });
    assert.ok(r.issues.some((i) => i.code === 'triangular_mode_missing'));
  });
});

describe('воспроизводимость', () => {
  test('одинаковые данные, настройки и seed → идентичный результат', () => {
    for (const mode of ALL_MODES) {
      const a = solve(clone(mixedUncertainty), { overrides: { mode, iterations: 1500, seed: 99 } });
      const b = solve(clone(mixedUncertainty), { overrides: { mode, iterations: 1500, seed: 99 } });
      assert.equal(JSON.stringify(a), JSON.stringify(b));
    }
  });

  test('другой seed даёт другую выборку', () => {
    const a = solve(clone(supplierDemo), { overrides: { seed: 1 } });
    const b = solve(clone(supplierDemo), { overrides: { seed: 2 } });
    assert.notEqual(a.primary.alternatives[0].p_best, b.primary.alternatives[0].p_best);
  });

  test('общие случайные числа: выборки M в режиме 4 совпадают с режимом 2', () => {
    const m2: number[][][] = [];
    const m4: number[][][] = [];
    solve(clone(supplierDemo), { overrides: { mode: 'MU_WF', iterations: 50 }, onIteration: (_, __, X) => m2.push(X.map((r) => [...r])) });
    solve(clone(supplierDemo), { overrides: { mode: 'MU_WU', iterations: 50 }, onIteration: (_, __, X) => m4.push(X.map((r) => [...r])) });
    assert.deepEqual(m2, m4);
  });
});

describe('ничьи', () => {
  test('rankScores: средний ранг для равных score', () => {
    const r = rankScores([0.5, 0.9, 0.5, 0.1], true, 1e-9);
    assert.deepEqual(r.rank, [2.5, 1, 2.5, 4]);
  });

  test('одинаковые альтернативы делят первое место поровну независимо от порядка', () => {
    const p = exactProblem({ matrix: [[1, 5], [1, 5], [0, 0]], directions: ['max', 'max'], weights: [0.5, 0.5] });
    const r = solve(p);
    const [a1, a2, a3] = r.primary.alternatives;
    assert.equal(a1.p_best, 0.5);
    assert.equal(a2.p_best, 0.5);
    assert.equal(a1.mean_rank, 1.5);
    assert.equal(a3.p_worst, 1);
    assert.deepEqual(a1.rank_acceptability, [0.5, 0.5, 0]);
    assert.deepEqual(r.baseline.leader_ids.sort(), ['a1', 'a2']);
    const swapped = exactProblem({ matrix: [[0, 0], [1, 5], [1, 5]], directions: ['max', 'max'], weights: [0.5, 0.5], altIds: ['a3', 'a1', 'a2'] });
    const r2 = solve(swapped);
    const byId = (x: typeof r2, id: string) => x.primary.alternatives.find((a) => a.alternative_id === id)!;
    assert.equal(byId(r2, 'a1').p_best, 0.5);
    assert.equal(byId(r2, 'a2').p_best, 0.5);
  });
});

describe('показатели устойчивости', () => {
  test('pBest и pWorst — распределения вероятностей; acceptability стохастична по строкам и столбцам', () => {
    const r = solve(clone(supplierDemo), { overrides: { mode: 'MU_WU', iterations: 2000 } });
    const alts = r.primary.alternatives;
    const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
    assert.ok(Math.abs(sum(alts.map((a) => a.p_best)) - 1) < 1e-9);
    assert.ok(Math.abs(sum(alts.map((a) => a.p_worst)) - 1) < 1e-9);
    for (const a of alts) assert.ok(Math.abs(sum(a.rank_acceptability) - 1) < 1e-9);
    for (let rnk = 0; rnk < alts.length; rnk++) assert.ok(Math.abs(sum(alts.map((a) => a.rank_acceptability[rnk])) - 1) < 1e-9);
    assert.ok(Math.abs(sum(alts.map((a) => a.mean_rank)) - (alts.length * (alts.length + 1)) / 2) < 1e-9);
  });

  test('режим 1 детерминирован: одна итерация, ранги равны базовым', () => {
    const r = solve(clone(supplierDemo), { overrides: { mode: 'MF_WF' } });
    assert.equal(r.iterations_effective, 1);
    for (const a of r.primary.alternatives) assert.equal(a.mean_rank, a.baseline_rank);
  });

  test('трассировка: взвешенный вклад = вес × нормированное значение; WSM score = Σ вкладов', () => {
    const p = clone(supplierDemo);
    p.method = { id: 'wsm' };
    const r = solve(p, { overrides: { mode: 'MF_WF' } });
    for (const a of r.alternatives_kept) {
      const rows = r.baseline.trace.filter((t) => t.alternative_id === a);
      for (const t of rows) assert.ok(Math.abs(t.weighted - t.weight * t.normalized) < 1e-12);
      const s = rows.reduce((acc, t) => acc + t.weighted, 0);
      assert.ok(Math.abs(s - r.baseline.scores[a]) < 1e-12);
    }
  });

  test('ограничение-порог исключает альтернативу на точечной оценке', () => {
    const r = solve(clone(mixedUncertainty));
    assert.ok(!r.alternatives_kept.includes('op4'));
    assert.equal(r.excluded[0].alternative_id, 'op4');
  });
});
