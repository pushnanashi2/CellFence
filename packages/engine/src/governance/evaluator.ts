import type {
  AssuranceVector,
  GateDecision,
  GovernanceEvaluationInput,
  GovernanceEvaluationResult,
  GovernanceFinding,
  RuleJudgment,
  RuleResult,
} from "./model.js";

const EVIDENCE_RULE_ID = "CELLFENCE_EVIDENCE_COVERAGE";

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function ruleResultsForFindings<TFinding extends GovernanceFinding>(findings: TFinding[]): RuleResult[] {
  return uniqueSorted(findings.filter((finding) => finding.severity === "error").map((finding) => finding.ruleId))
    .map((ruleId): RuleResult => ({
      ruleId,
      status: "VIOLATED",
      severity: "error",
      message: `rule ${ruleId} emitted at least one active error finding`,
    }));
}

function satisfiedRequiredRules(requiredRules: string[], violatedRuleIds: Set<string>): RuleResult[] {
  return uniqueSorted(requiredRules)
    .filter((ruleId) => !violatedRuleIds.has(ruleId))
    .map((ruleId): RuleResult => ({
      ruleId,
      status: "SATISFIED",
      severity: "error",
      message: `required rule ${ruleId} has no active error finding`,
    }));
}

function requiredRuleStatus(ruleResults: RuleResult[]): RuleJudgment {
  if (ruleResults.some((result) => result.status === "VIOLATED")) return "VIOLATED";
  if (ruleResults.some((result) => result.status === "UNKNOWN")) return "UNKNOWN";
  return "SATISFIED";
}

function gateDecisionForAssurance(assurance: AssuranceVector): GateDecision {
  if (assurance.evidenceStatus === "INCOMPLETE") return "BLOCK";
  if (assurance.requiredRuleStatus === "VIOLATED" || assurance.requiredRuleStatus === "UNKNOWN") return "BLOCK";
  return "ALLOW";
}

export function evaluateGovernance<TFinding extends GovernanceFinding, TMetrics>(
  input: GovernanceEvaluationInput<TFinding, TMetrics>,
): GovernanceEvaluationResult<TFinding, TMetrics> {
  const ruleResults = ruleResultsForFindings(input.findings);
  const violatedRuleIds = new Set(ruleResults.map((result) => result.ruleId));
  ruleResults.push(...satisfiedRequiredRules(input.requiredRules, violatedRuleIds));
  if (input.evidence.status === "INCOMPLETE") {
    ruleResults.push({
      ruleId: EVIDENCE_RULE_ID,
      status: "UNKNOWN",
      severity: "error",
      message: "required evidence is incomplete, so governance cannot prove the evaluated state",
    });
  }
  const assurance: AssuranceVector = {
    inputStatus: "VALID",
    evidenceStatus: input.evidence.status,
    requiredRuleStatus: requiredRuleStatus(ruleResults),
  };
  return {
    gateDecision: gateDecisionForAssurance(assurance),
    inputStatus: assurance.inputStatus,
    evidenceStatus: assurance.evidenceStatus,
    assurance,
    ruleResults,
    findings: input.findings,
    warnings: input.warnings,
    metrics: input.metrics,
  };
}
