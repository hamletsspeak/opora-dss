import type { SessionState } from './types.js';
import { DEMO_ALTERNATIVES, DEMO_CRITERIA } from './demo.js';

/**
 * Fixed supplier experiment session for thesis reproducibility.
 * Same matrix as demo suppliers; context pinned for docs/tables.
 */
export const EXPERIMENT_SEED = 42;
export const EXPERIMENT_SAMPLES = 2000;
export const EXPERIMENT_SAMPLES_QUICK = 500;

export function experimentSupplierSession(): SessionState {
  return {
    context: 'Эксперимент: выбор поставщика (фиксированный датасет Klar)',
    criteria: DEMO_CRITERIA.map((c) => ({ ...c })),
    alternatives: DEMO_ALTERNATIVES.map((a) => ({
      ...a,
      scores: { ...a.scores },
    })),
    missing: [],
    readyForAnalysis: true,
    usedDemoData: true,
  };
}
