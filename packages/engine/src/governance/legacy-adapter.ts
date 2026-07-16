import type { GovernanceEvaluationResult, GovernanceFinding } from "./model.js";

export type LegacyCheckDecision<TFinding extends GovernanceFinding, TMetrics> = {
  ok: boolean;
  exitCode: 0 | 1 | 2 | 3;
  findings: TFinding[];
  warnings: TFinding[];
  metrics: TMetrics;
};

export function legacyDecisionFromEvaluation<TFinding extends GovernanceFinding, TMetrics>(
  evaluation: GovernanceEvaluationResult<TFinding, TMetrics>,
): LegacyCheckDecision<TFinding, TMetrics> {
  if (evaluation.inputStatus === "INVALID") {
    return {
      ok: false,
      exitCode: 2,
      findings: evaluation.findings,
      warnings: evaluation.warnings,
      metrics: evaluation.metrics,
    };
  }
  return {
    ok: evaluation.gateDecision === "ALLOW",
    exitCode: evaluation.gateDecision === "ALLOW" ? 0 : 1,
    findings: evaluation.findings,
    warnings: evaluation.warnings,
    metrics: evaluation.metrics,
  };
}
