import { stableDigest } from "./canonicalization.js";
import type { EvidenceAssessmentWithRequirements } from "./evidence-assessment.js";
import type {
  AssuranceVector,
  EvidenceDefect,
  EvidenceStatus,
  EvidenceGraph,
  GateDecision,
  GovernanceEvaluationResult,
  GovernanceFinding,
  GovernanceInputStatus,
  ObservationFamily,
  RuleResult,
  SubjectSnapshot,
} from "./model.js";

export const ACCEPTANCE_RECORD_VERIFIER_ID = "cellfence-engine";
export const ACCEPTANCE_RECORD_VERIFIER_VERSION = "cellfence.acceptance-verifier.v1";

export type AcceptanceRecord = {
  schemaVersion: "cellfence.acceptance-record.v1";
  generatedAt: string;
  subject: {
    headSha?: string;
    baseSha?: string;
    changedFiles?: string[];
  };
  controls: {
    manifestPath: string;
    manifestDigest?: string;
    baselinePath?: string;
    baselineDigest?: string;
    evidenceGraphDigest?: string;
  };
  verifier: {
    id: string;
    version: string;
  };
  evidence: {
    snapshotDigest: string;
    status: EvidenceStatus;
    observedFamilies: ObservationFamily[];
    requiredObservations: EvidenceAssessmentWithRequirements["requiredObservations"];
    defects: EvidenceDefect[];
  };
  decision: {
    gateDecision: GateDecision;
    inputStatus: GovernanceInputStatus;
    evidenceStatus: EvidenceStatus;
    assurance: AssuranceVector;
    ruleResults: RuleResult[];
  };
  findings: {
    errors: number;
    warnings: number;
    fingerprints: string[];
  };
  recordDigest: string;
};

export type AcceptanceRecordInput<TFinding extends GovernanceFinding, TMetrics> = {
  generatedAt?: string;
  manifestPath: string;
  baselinePath?: string;
  headSha?: string;
  baseSha?: string;
  changedFiles?: string[];
  snapshot: SubjectSnapshot;
  evidence: EvidenceAssessmentWithRequirements;
  evidenceGraph?: EvidenceGraph;
  evaluation: GovernanceEvaluationResult<TFinding, TMetrics>;
};

function fileDigest(snapshot: SubjectSnapshot, filePath: string | undefined): string | undefined {
  if (!filePath) return undefined;
  return snapshot.files.find((file) => file.path === filePath)?.digest;
}

function sortedValues(values: string[] | undefined): string[] | undefined {
  if (!values) return undefined;
  return [...values].sort((left, right) => left.localeCompare(right));
}

export function createAcceptanceRecord<TFinding extends GovernanceFinding, TMetrics>(
  input: AcceptanceRecordInput<TFinding, TMetrics>,
): AcceptanceRecord {
  const recordWithoutDigest = {
    schemaVersion: "cellfence.acceptance-record.v1" as const,
    generatedAt: input.generatedAt || new Date().toISOString(),
    subject: {
      headSha: input.headSha,
      baseSha: input.baseSha,
      changedFiles: sortedValues(input.changedFiles),
    },
    controls: {
      manifestPath: input.manifestPath,
      manifestDigest: fileDigest(input.snapshot, input.manifestPath),
      baselinePath: input.baselinePath,
      baselineDigest: fileDigest(input.snapshot, input.baselinePath),
      evidenceGraphDigest: input.evidenceGraph ? stableDigest(input.evidenceGraph) : undefined,
    },
    verifier: {
      id: ACCEPTANCE_RECORD_VERIFIER_ID,
      version: ACCEPTANCE_RECORD_VERIFIER_VERSION,
    },
    evidence: {
      snapshotDigest: input.evidence.snapshotDigest,
      status: input.evidence.status,
      observedFamilies: input.evidence.observedFamilies,
      requiredObservations: input.evidence.requiredObservations,
      defects: input.evidence.defects,
    },
    decision: {
      gateDecision: input.evaluation.gateDecision,
      inputStatus: input.evaluation.inputStatus,
      evidenceStatus: input.evaluation.evidenceStatus,
      assurance: input.evaluation.assurance,
      ruleResults: input.evaluation.ruleResults,
    },
    findings: {
      errors: input.evaluation.findings.length,
      warnings: input.evaluation.warnings.length,
      fingerprints: sortedValues(input.evaluation.findings.map((finding) => finding.fingerprint || stableDigest(finding))) || [],
    },
  };
  return {
    ...recordWithoutDigest,
    recordDigest: stableDigest(recordWithoutDigest),
  };
}
