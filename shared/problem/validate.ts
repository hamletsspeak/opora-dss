import { DecisionProblem, SCHEMA_VERSION, type ModeId } from './schema.js';
import {
  SUM_TOLERANCE,
  evaluationKey,
  feasibleAlternatives,
  formatNum,
  intervalDistribution,
  isUncertainValue,
  partitionWeights,
  pointValue,
  valueSupport,
} from './derive.js';
import {
  LIMITS,
  MODE_INFO,
  resolveSettings,
  type ResolvedSettings,
  type RunOverrides,
} from './settings.js';

export type Severity = 'error' | 'warning' | 'info';

export interface Issue {
  severity: Severity;
  code: string;
  path: string;
  message: string;
}

export interface ValidationReport {
  ok: boolean;
  issues: Issue[];
  problem?: DecisionProblem;
  settings?: ResolvedSettings;
}

export class ProblemValidationError extends Error {
  readonly issues: Issue[];
  constructor(issues: Issue[]) {
    const errors = issues.filter((i) => i.severity === 'error');
    super(
      `Задача не прошла валидацию: ${errors
        .slice(0, 3)
        .map((e) => e.message)
        .join('; ')}${errors.length > 3 ? ` (и ещё ${errors.length - 3})` : ''}`,
    );
    this.name = 'ProblemValidationError';
    this.issues = issues;
  }
}

function pathToString(path: readonly PropertyKey[]): string {
  let out = '';
  for (const p of path) {
    if (typeof p === 'number') out += `[${p}]`;
    else out += out ? `.${String(p)}` : String(p);
  }
  return out || '$';
}

/** Structural validation against the zod contract. */
export function parseProblem(input: unknown): { problem?: DecisionProblem; issues: Issue[] } {
  if (input && typeof input === 'object' && 'schema_version' in input) {
    const v = (input as { schema_version?: unknown }).schema_version;
    if (v !== SCHEMA_VERSION) {
      return {
        issues: [
          {
            severity: 'error',
            code: 'schema_version',
            path: 'schema_version',
            message: `Неподдерживаемая версия схемы «${String(v)}»; ожидается «${SCHEMA_VERSION}».`,
          },
        ],
      };
    }
  }
  const res = DecisionProblem.safeParse(input);
  if (res.success) return { problem: res.data, issues: [] };
  return {
    issues: res.error.issues.map((i) => ({
      severity: 'error' as const,
      code: `schema.${i.code}`,
      path: pathToString(i.path),
      message: i.message,
    })),
  };
}

export interface SemanticOptions {
  /** Check completeness and mode-specific requirements for an actual run. */
  forRun?: boolean;
  overrides?: RunOverrides;
}

export function validateSemantics(
  p: DecisionProblem,
  opts: SemanticOptions = {},
): { issues: Issue[]; settings: ResolvedSettings } {
  const issues: Issue[] = [];
  const err = (code: string, path: string, message: string) =>
    issues.push({ severity: 'error', code, path, message });
  const warn = (code: string, path: string, message: string) =>
    issues.push({ severity: 'warning', code, path, message });

  const settings = resolveSettings(p, opts.overrides);

  // --- identifiers -------------------------------------------------------
  const altIds = new Set<string>();
  p.alternatives.forEach((a, i) => {
    if (altIds.has(a.alternative_id))
      err('duplicate_alternative_id', `alternatives[${i}].alternative_id`, `Повторяющийся идентификатор альтернативы «${a.alternative_id}».`);
    altIds.add(a.alternative_id);
  });
  const critIds = new Set<string>();
  const critById = new Map(p.criteria.map((c) => [c.criterion_id, c]));
  p.criteria.forEach((c, i) => {
    if (critIds.has(c.criterion_id))
      err('duplicate_criterion_id', `criteria[${i}].criterion_id`, `Повторяющийся идентификатор критерия «${c.criterion_id}».`);
    critIds.add(c.criterion_id);
    const r = c.range;
    if (r && r.min != null && r.max != null && r.min > r.max)
      err('range_inverted', `criteria[${i}].range`, `Критерий «${c.name}»: нижняя граница диапазона больше верхней.`);
  });
  const conIds = new Set<string>();
  p.constraints.forEach((c, i) => {
    if (conIds.has(c.constraint_id))
      err('duplicate_constraint_id', `constraints[${i}].constraint_id`, `Повторяющийся идентификатор ограничения «${c.constraint_id}».`);
    conIds.add(c.constraint_id);
  });

  // --- evaluations -------------------------------------------------------
  const seen = new Set<string>();
  const inRange = (critId: string, x: number) => {
    const r = critById.get(critId)?.range;
    if (!r) return true;
    if (r.min != null && x < r.min) return false;
    if (r.max != null && x > r.max) return false;
    return true;
  };
  p.evaluations.forEach((e, i) => {
    const path = `evaluations[${i}]`;
    if (!altIds.has(e.alternative_id))
      err('unknown_alternative', `${path}.alternative_id`, `Оценка ссылается на неизвестную альтернативу «${e.alternative_id}».`);
    const crit = critById.get(e.criterion_id);
    if (!crit)
      err('unknown_criterion', `${path}.criterion_id`, `Оценка ссылается на неизвестный критерий «${e.criterion_id}».`);
    const key = evaluationKey(e.alternative_id, e.criterion_id);
    if (seen.has(key))
      err('duplicate_evaluation', path, `Повторная оценка для пары («${e.alternative_id}», «${e.criterion_id}»).`);
    seen.add(key);
    if (crit && e.unit != null && crit.unit != null && e.unit !== crit.unit)
      err('unit_mismatch', `${path}.unit`, `Единица оценки «${e.unit}» не совпадает с единицей критерия «${crit.unit}» (${crit.name}).`);

    const v = e.value;
    const label = `(${e.alternative_id}, ${e.criterion_id})`;
    if (v.kind === 'exact') {
      if (crit && !inRange(crit.criterion_id, v.value))
        err('out_of_range', `${path}.value.value`, `Оценка ${label} = ${formatNum(v.value)} вне допустимого диапазона критерия.`);
      if (crit?.value_type === 'integer' && !Number.isInteger(v.value))
        warn('not_integer', `${path}.value.value`, `Оценка ${label} должна быть целой (${formatNum(v.value)}).`);
    } else if (v.kind === 'interval') {
      if (v.lower > v.upper)
        err('interval_inverted', `${path}.value`, `Интервал ${label}: нижняя граница ${formatNum(v.lower)} больше верхней ${formatNum(v.upper)}.`);
      if (v.lower === v.upper)
        warn('interval_degenerate', `${path}.value`, `Интервал ${label} вырожден (нижняя = верхняя границе).`);
      if (crit && (!inRange(crit.criterion_id, v.lower) || !inRange(crit.criterion_id, v.upper)))
        err('out_of_range', `${path}.value`, `Интервал ${label} выходит за допустимый диапазон критерия.`);
      const dist = intervalDistribution(v, settings);
      if (dist === 'triangular') {
        if (v.mode === undefined)
          err('triangular_mode_missing', `${path}.value.mode`, `Треугольное распределение ${label}: мода должна быть задана явно.`);
        else if (v.mode < v.lower || v.mode > v.upper)
          err('triangular_mode_out', `${path}.value.mode`, `Мода ${label} вне интервала.`);
      } else if (v.mode !== undefined && v.distribution === undefined) {
        warn('mode_ignored', `${path}.value.mode`, `Для ${label} задана мода, но распределение — равномерное; мода не используется.`);
      }
      if (v.point !== undefined && (v.point < v.lower || v.point > v.upper))
        err('point_out_of_interval', `${path}.value.point`, `Точечная оценка ${label} вне интервала.`);
    } else if (v.kind === 'scenarios') {
      let sum = 0;
      v.scenarios.forEach((s, j) => {
        if (!(s.probability > 0 && s.probability <= 1))
          err('scenario_probability', `${path}.value.scenarios[${j}].probability`, `Вероятность сценария ${label} должна быть в (0; 1].`);
        sum += s.probability;
        if (crit && !inRange(crit.criterion_id, s.value))
          err('out_of_range', `${path}.value.scenarios[${j}].value`, `Значение сценария ${label} вне допустимого диапазона.`);
      });
      if (Math.abs(sum - 1) > SUM_TOLERANCE)
        err('scenario_probability_sum', `${path}.value.scenarios`, `Сумма вероятностей сценариев ${label} равна ${formatNum(sum)}, а должна быть 1.`);
    }
  });

  // --- weights -----------------------------------------------------------
  const wSeen = new Set<string>();
  p.weights.items.forEach((w, i) => {
    const path = `weights.items[${i}]`;
    if (!critIds.has(w.criterion_id))
      err('unknown_criterion', `${path}.criterion_id`, `Вес задан для неизвестного критерия «${w.criterion_id}».`);
    if (wSeen.has(w.criterion_id))
      err('duplicate_weight', path, `Повторная запись веса для критерия «${w.criterion_id}».`);
    wSeen.add(w.criterion_id);
    for (const k of ['value', 'lower', 'upper'] as const) {
      const x = w[k];
      if (x != null && (x < 0 || x > 1))
        err('weight_out_of_unit', `${path}.${k}`, `Вес «${w.criterion_id}» (${k}) = ${formatNum(x)} должен быть в [0; 1].`);
    }
    if (w.lower != null && w.upper != null && w.lower > w.upper)
      err('weight_interval_inverted', path, `Интервал веса «${w.criterion_id}»: нижняя граница больше верхней.`);
    if (w.value != null && w.lower != null && w.value < w.lower - SUM_TOLERANCE)
      err('weight_point_out', path, `Точный вес «${w.criterion_id}» меньше нижней границы своего интервала.`);
    if (w.value != null && w.upper != null && w.value > w.upper + SUM_TOLERANCE)
      err('weight_point_out', path, `Точный вес «${w.criterion_id}» больше верхней границы своего интервала.`);
  });
  const ordinal = p.weights.ordinal ?? [];
  ordinal.forEach((o, i) => {
    const path = `weights.ordinal[${i}]`;
    if (!critIds.has(o.greater) || !critIds.has(o.lesser))
      err('unknown_criterion', path, `Порядковое ограничение ссылается на неизвестный критерий.`);
    if (o.greater === o.lesser)
      err('ordinal_self', path, `Порядковое ограничение сравнивает критерий «${o.greater}» сам с собой.`);
  });
  if (hasCycle(ordinal))
    err('ordinal_cycle', 'weights.ordinal', 'Порядковые ограничения на веса содержат цикл — они несовместны.');
  const scen = p.weights.scenarios ?? [];
  if (scen.length) {
    let ps = 0;
    scen.forEach((s, i) => {
      const path = `weights.scenarios[${i}]`;
      ps += s.probability;
      if (!(s.probability > 0 && s.probability <= 1))
        err('scenario_probability', `${path}.probability`, 'Вероятность сценария весов должна быть в (0; 1].');
      let sum = 0;
      for (const id of critIds) {
        const x = s.values[id];
        if (x === undefined) {
          err('weight_scenario_incomplete', `${path}.values`, `Сценарий весов «${s.label ?? i + 1}» не задаёт вес критерия «${id}».`);
          continue;
        }
        if (x < 0 || x > 1)
          err('weight_out_of_unit', `${path}.values.${id}`, `Вес в сценарии должен быть в [0; 1].`);
        sum += x;
      }
      for (const id of Object.keys(s.values))
        if (!critIds.has(id))
          err('unknown_criterion', `${path}.values.${id}`, `Сценарий весов ссылается на неизвестный критерий «${id}».`);
      if (Math.abs(sum - 1) > SUM_TOLERANCE)
        err('weight_scenario_sum', `${path}.values`, `Сумма весов в сценарии «${s.label ?? i + 1}» равна ${formatNum(sum)}, а должна быть 1.`);
    });
    if (Math.abs(ps - 1) > SUM_TOLERANCE)
      err('scenario_probability_sum', 'weights.scenarios', `Сумма вероятностей сценариев весов равна ${formatNum(ps)}, а должна быть 1.`);
  }

  // --- constraints -------------------------------------------------------
  p.constraints.forEach((c, i) => {
    const path = `constraints[${i}]`;
    if (c.type === 'threshold' && !critIds.has(c.criterion_id))
      err('unknown_criterion', `${path}.criterion_id`, `Ограничение «${c.constraint_id}» ссылается на неизвестный критерий.`);
    if (c.type === 'exclude' && !altIds.has(c.alternative_id))
      err('unknown_alternative', `${path}.alternative_id`, `Ограничение «${c.constraint_id}» ссылается на неизвестную альтернативу.`);
  });

  // --- method ------------------------------------------------------------
  const mp = p.method.params ?? {};
  if (p.method.id === 'vikor' && mp.v !== undefined && (mp.v < 0 || mp.v > 1))
    err('vikor_v', 'method.params.v', 'Параметр VIKOR v должен быть в [0; 1].');
  if (p.method.id !== 'topsis' && mp.normalization === 'vector')
    err('normalization_unsupported', 'method.params.normalization', 'Векторная нормализация поддерживается только для TOPSIS.');
  if (p.method.id !== 'vikor' && mp.v !== undefined)
    warn('param_ignored', 'method.params.v', `Параметр v не используется методом ${p.method.id}.`);
  const alpha = settings.w.dirichlet_alpha;
  if (alpha) {
    for (const [id, a] of Object.entries(alpha)) {
      if (!critIds.has(id)) err('unknown_criterion', `uncertainty.w.dirichlet_alpha.${id}`, `Параметр Дирихле для неизвестного критерия «${id}».`);
      if (!(a > 0)) err('dirichlet_alpha', `uncertainty.w.dirichlet_alpha.${id}`, 'Параметры Дирихле должны быть > 0.');
    }
  }

  if (issues.some((i) => i.severity === 'error') || !opts.forRun) {
    if (!opts.forRun) draftCompleteness(p, issues);
    return { issues, settings };
  }

  // --- run-level checks --------------------------------------------------
  runChecks(p, settings, issues);
  return { issues, settings };
}

function draftCompleteness(p: DecisionProblem, issues: Issue[]): void {
  const info = (code: string, path: string, message: string) =>
    issues.push({ severity: 'info', code, path, message });
  if (p.alternatives.length < 2) info('need_alternatives', 'alternatives', 'Для расчёта нужно не менее двух альтернатив.');
  if (p.criteria.length < 1) info('need_criteria', 'criteria', 'Для расчёта нужен хотя бы один критерий.');
  const keys = new Set(p.evaluations.map((e) => evaluationKey(e.alternative_id, e.criterion_id)));
  let missing = 0;
  for (const a of p.alternatives) for (const c of p.criteria) if (!keys.has(evaluationKey(a.alternative_id, c.criterion_id))) missing++;
  if (missing) info('evaluations_incomplete', 'evaluations', `Не заполнено оценок: ${missing}.`);
}

function runChecks(p: DecisionProblem, settings: ResolvedSettings, issues: Issue[]): void {
  const err = (code: string, path: string, message: string) =>
    issues.push({ severity: 'error', code, path, message });
  const warn = (code: string, path: string, message: string) =>
    issues.push({ severity: 'warning', code, path, message });
  const info = (code: string, path: string, message: string) =>
    issues.push({ severity: 'info', code, path, message });
  const mode = MODE_INFO[settings.mode];

  if (p.criteria.length < 1) err('need_criteria', 'criteria', 'Для расчёта нужен хотя бы один критерий.');
  if (p.criteria.length === 1) warn('single_criterion', 'criteria', 'Задан один критерий — многокритериальный анализ вырожден.');

  const { kept, excluded } = feasibleAlternatives(p, settings);
  for (const x of excluded)
    info('alternative_excluded', 'constraints', `Альтернатива «${x.alternative_id}» исключена: ${x.reason}.`);
  if (kept.length < 2)
    err('need_alternatives', 'alternatives', `После применения ограничений осталось альтернатив: ${kept.length}; нужно не менее двух.`);

  // completeness of M
  const evals = new Map(p.evaluations.map((e) => [evaluationKey(e.alternative_id, e.criterion_id), e]));
  let uncertainCells = 0;
  for (const c of p.criteria) {
    let present = 0;
    for (const a of p.alternatives) {
      if (!kept.includes(a.alternative_id)) continue;
      const e = evals.get(evaluationKey(a.alternative_id, c.criterion_id));
      const path = `evaluations(${a.alternative_id}, ${c.criterion_id})`;
      if (!e) {
        err('evaluation_absent', path, `Нет оценки альтернативы «${a.name}» по критерию «${c.name}». Пропуск нужно описать явно (kind: "missing").`);
        continue;
      }
      if (e.value.kind === 'missing') {
        if ((c.missing_policy ?? 'reject') === 'reject')
          err('evaluation_missing', path, `Оценка «${a.name}» по «${c.name}» отсутствует, а правило пропусков критерия — reject.`);
        else
          warn('evaluation_missing_worst', path, `Оценка «${a.name}» по «${c.name}» отсутствует: используется худшее наблюдаемое значение (правило worst_observed).`);
        continue;
      }
      present++;
      if (isUncertainValue(e.value)) uncertainCells++;
      if (mode.m === 'fixed' && pointValue(e.value, settings) === null)
        err('point_missing', path, `Режим M fixed: для неопределённой оценки «${a.name}» / «${c.name}» нет точечного значения (правило ${settings.m.point_rule}).`);
    }
    if (present === 0 && kept.length > 0)
      err('criterion_all_missing', `criteria(${c.criterion_id})`, `По критерию «${c.name}» нет ни одной оценки.`);
  }
  if (mode.m === 'uncertain' && uncertainCells === 0)
    warn('mode_degenerate_m', 'uncertainty.mode', 'Режим M uncertain вырожден: в матрице нет интервальных или сценарных оценок.');

  if (settings.method.normalization === 'vector') {
    for (const c of p.criteria) {
      for (const e of p.evaluations) {
        if (e.criterion_id !== c.criterion_id) continue;
        const sup = valueSupport(e.value);
        if (sup && sup[0] < 0) {
          err('vector_negative', `evaluations(${e.alternative_id}, ${c.criterion_id})`, `Векторная нормализация TOPSIS недопустима при отрицательных значениях (критерий «${c.name}»).`);
          break;
        }
      }
    }
  }

  // weights
  const part = partitionWeights(p);
  const missingItem = p.criteria.filter((c) => !p.weights.items.some((w) => w.criterion_id === c.criterion_id));
  if (mode.w === 'fixed') {
    const noValue = p.criteria.filter((_, i) => part.point[i] === null);
    if (noValue.length)
      err('weights_not_exact', 'weights.items', `Режим W fixed требует точных весов для всех критериев; не заданы: ${noValue.map((c) => c.name).join(', ')}.`);
    else if (part.sumPoint !== null && Math.abs(part.sumPoint - 1) > SUM_TOLERANCE)
      err('weights_sum', 'weights.items', `Сумма точных весов равна ${formatNum(part.sumPoint)}, а должна быть 1. Веса не нормируются автоматически — исправьте исходные данные.`);
    if (p.weights.items.some((w) => w.lower != null || w.upper != null))
      info('bounds_ignored', 'weights.items', 'Режим W fixed: интервалы весов не используются.');
  } else {
    const sampler = settings.w.sampler;
    if (sampler === 'scenarios') {
      if (!(p.weights.scenarios ?? []).length)
        err('weight_scenarios_absent', 'weights.scenarios', 'Выбран сценарный генератор весов, но сценарии не заданы.');
      (p.weights.scenarios ?? []).forEach((s, si) => {
        part.ids.forEach((id, i) => {
          const x = s.values[id];
          if (x === undefined) return;
          if (!part.uncertain[i] && Math.abs(x - (part.point[i] as number)) > SUM_TOLERANCE)
            err('scenario_changes_fixed_weight', `weights.scenarios[${si}].values.${id}`, `Сценарий «${s.label ?? si + 1}» меняет фиксированный вес «${id}».`);
          if (part.uncertain[i] && (x < part.lower[i] - SUM_TOLERANCE || x > part.upper[i] + SUM_TOLERANCE))
            err('scenario_out_of_bounds', `weights.scenarios[${si}].values.${id}`, `Сценарий «${s.label ?? si + 1}»: вес «${id}» вне заданного интервала.`);
        });
      });
    } else {
      if (part.sumLower > 1 + SUM_TOLERANCE)
        err('weights_infeasible_lower', 'weights.items', `Сумма нижних границ весов (с учётом фиксированных) равна ${formatNum(part.sumLower)} > 1: допустимого нормированного вектора весов не существует.`);
      if (part.sumUpper < 1 - SUM_TOLERANCE)
        err('weights_infeasible_upper', 'weights.items', `Сумма верхних границ весов (с учётом фиксированных) равна ${formatNum(part.sumUpper)} < 1: допустимого нормированного вектора весов не существует.`);
      if (!part.uncertain.some(Boolean))
        warn('mode_degenerate_w', 'uncertainty.mode', 'Режим W uncertain вырожден: все веса точные, интервалы не заданы.');
      if (part.unspecified.length)
        info('weights_unspecified', 'weights.items', `Вес не задан для: ${part.unspecified.join(', ')} — генерируется по всему допустимому диапазону [0; 1].`);
      if (sampler === 'dirichlet') {
        const a = settings.w.dirichlet_alpha ?? {};
        const absent = part.ids.filter((id, i) => part.uncertain[i] && !(a[id] > 0));
        if (absent.length)
          err('dirichlet_alpha_missing', 'uncertainty.w.dirichlet_alpha', `Генератор Дирихле: параметры α не заданы для ${absent.join(', ')}.`);
      }
      if ((p.weights.scenarios ?? []).length)
        warn('weight_scenarios_unused', 'weights.scenarios', `Сценарии весов заданы, но генератор весов — ${sampler}; сценарии не используются.`);
      for (const o of p.weights.ordinal ?? []) {
        const gi = part.ids.indexOf(o.greater);
        const li = part.ids.indexOf(o.lesser);
        if (gi < 0 || li < 0) continue;
        if (part.upper[gi] < part.lower[li] - SUM_TOLERANCE)
          err('ordinal_infeasible', 'weights.ordinal', `Ограничение w(${o.greater}) ≥ w(${o.lesser}) несовместно с границами весов.`);
      }
    }
  }
  if (missingItem.length && mode.w === 'uncertain')
    info('weight_item_absent', 'weights.items', `Нет записи веса для: ${missingItem.map((c) => c.criterion_id).join(', ')} — трактуется как незаданный вес [0; 1].`);

  if (settings.iterations > LIMITS.max_iterations)
    err('iterations_limit', 'uncertainty.iterations', `Число итераций ${settings.iterations} превышает лимит ${LIMITS.max_iterations}.`);
  if (settings.iterations * Math.max(1, kept.length) > LIMITS.max_cells)
    err('cells_limit', 'uncertainty.iterations', 'Произведение числа итераций на число альтернатив превышает лимит сервера.');
  if (settings.top_k > Math.max(1, kept.length))
    err('top_k', 'uncertainty.top_k', `top_k = ${settings.top_k} больше числа альтернатив (${kept.length}).`);
}

function hasCycle(edges: { greater: string; lesser: string }[]): boolean {
  const adj = new Map<string, string[]>();
  for (const e of edges) {
    if (!adj.has(e.greater)) adj.set(e.greater, []);
    adj.get(e.greater)!.push(e.lesser);
  }
  const state = new Map<string, 1 | 2>();
  const visit = (n: string): boolean => {
    const s = state.get(n);
    if (s === 1) return true;
    if (s === 2) return false;
    state.set(n, 1);
    for (const m of adj.get(n) ?? []) if (visit(m)) return true;
    state.set(n, 2);
    return false;
  };
  for (const n of adj.keys()) if (visit(n)) return true;
  return false;
}

/** Structural + semantic validation in one call. */
export function validateProblem(input: unknown, opts: SemanticOptions = {}): ValidationReport {
  const parsed = parseProblem(input);
  if (!parsed.problem) return { ok: false, issues: parsed.issues };
  const { issues, settings } = validateSemantics(parsed.problem, opts);
  return {
    ok: !issues.some((i) => i.severity === 'error'),
    issues,
    problem: parsed.problem,
    settings,
  };
}

export function modeLabel(mode: ModeId): string {
  return `Режим ${MODE_INFO[mode].n}: ${MODE_INFO[mode].label}`;
}
