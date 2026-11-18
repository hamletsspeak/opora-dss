import type { DecisionProblem } from "../../shared/problem/schema";
export type { DecisionProblem };
export interface Provider {
  id: string;
  title: string;
  model: string;
  configured: boolean;
}
export interface LabExperiment {
  experiment_id: string;
  problem: DecisionProblem;
  runs: {
    mode: string;
    status: string;
    issues: { message: string }[];
    result: import("../../shared/engine/types").RunResult | null;
  }[];
  passport: unknown;
  comparison: unknown;
  verification?: { same_result: boolean } | null;
}
