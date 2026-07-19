export type RuleJudgment = "SATISFIED" | "VIOLATED" | "UNKNOWN" | "NOT_APPLICABLE";
export type GovernanceInputStatus = "VALID" | "INVALID";
export type EvidenceStatus = "COMPLETE" | "INCOMPLETE";
export type GateDecision = "ALLOW" | "BLOCK" | "NOT_EVALUATED";
export type SubjectFileRole = "source" | "manifest" | "baseline" | "config" | "runtime-evidence";
export type ObservationStatus = "processed" | "not-applicable" | "parse-error" | "unsupported";
export type ObservationFamily =
  | "manifest"
  | "ownership"
  | "public-surface"
  | "imports"
  | "resources"
  | "baseline"
  | "plugins"
  | "waivers";

export type SubjectFile = {
  path: string;
  role: SubjectFileRole;
  digest: string;
  size: number;
};

export type SubjectSnapshot = {
  schemaVersion: "cellfence.governance-subject.v1";
  files: SubjectFile[];
  snapshotDigest: string;
};

export type FileObservation = {
  filePath: string;
  family: ObservationFamily;
  status: ObservationStatus;
  message?: string;
};

export type RawObservationReport = {
  schemaVersion: "cellfence.raw-observation.v1";
  observer: string;
  snapshotDigest: string;
  statuses: FileObservation[];
  importObservationCount: number;
  resourceObservationCount: number;
  publicSurfaceObservationCount: number;
};

export type EvidenceDefectCode =
  | "SNAPSHOT_DIGEST_MISMATCH"
  | "SNAPSHOT_INTEGRITY_MISMATCH"
  | "UNKNOWN_OBSERVED_FILE"
  | "DUPLICATE_FILE_OBSERVATION"
  | "MISSING_FILE_OBSERVATION"
  | "PARSE_ERROR"
  | "UNSUPPORTED_OBSERVATION"
  | "MISSING_OBSERVATION_FAMILY";

export type EvidenceDefect = {
  code: EvidenceDefectCode;
  message: string;
  filePath?: string;
  family?: ObservationFamily;
};

export type AssuranceVector = {
  inputStatus: GovernanceInputStatus;
  evidenceStatus: EvidenceStatus;
  requiredRuleStatus: RuleJudgment;
};

export type EvidenceAssessment = {
  schemaVersion: "cellfence.evidence-assessment.v1";
  snapshotDigest: string;
  status: EvidenceStatus;
  defects: EvidenceDefect[];
  observedFamilies: ObservationFamily[];
};

export type DeclaredIntermediateRepresentation = {
  cellIds: string[];
  requiredRules: string[];
  configuredSeverities: Record<string, string>;
};

export type NormalizedObservedIntermediateRepresentation = {
  findingRuleIds: string[];
  warningRuleIds: string[];
  observedFamilies: ObservationFamily[];
};

export type AcceptedIntermediateRepresentation = {
  baselineCellIds: string[];
  waiverRuleIds: string[];
};

export type GovernanceControlState = {
  schemaVersion: "cellfence.governance-control-state.v1";
  declared: DeclaredIntermediateRepresentation;
  observed: NormalizedObservedIntermediateRepresentation;
  accepted: AcceptedIntermediateRepresentation;
  observer: string;
  controlDigest: string;
};

export type GovernanceFinding = {
  ruleId: string;
  severity: "error" | "warning";
  message: string;
  filePath?: string;
  cellId?: string;
  producerCellId?: string;
  fingerprint?: string;
  details?: Record<string, unknown>;
  witness?: FindingWitness;
};

export type FindingWitnessSubject = {
  kind: "file" | "cell" | "producer-cell" | "detail";
  key: string;
  value: string;
};

export type FindingWitness = {
  ruleId: string;
  severity: "error" | "warning";
  message: string;
  fingerprint?: string;
  filePath?: string;
  line?: number;
  subjects: FindingWitnessSubject[];
};

export type EvidenceGraphNodeKind = "subject-file" | "observation" | "finding" | "evidence-defect";

export type EvidenceGraphNode = {
  id: string;
  kind: EvidenceGraphNodeKind;
  label: string;
  filePath?: string;
  family?: ObservationFamily;
  status?: ObservationStatus;
  ruleId?: string;
  severity?: "error" | "warning";
  digest?: string;
};

export type EvidenceGraphEdgeKind = "observed-as" | "reported-finding" | "has-defect" | "witnesses";

export type EvidenceGraphEdge = {
  from: string;
  to: string;
  kind: EvidenceGraphEdgeKind;
  label: string;
};

export type EvidenceGraph = {
  schemaVersion: "cellfence.evidence-graph.v1";
  snapshotDigest: string;
  nodes: EvidenceGraphNode[];
  edges: EvidenceGraphEdge[];
  findingWitnesses: FindingWitness[];
};

export type RuleResult = {
  ruleId: string;
  status: RuleJudgment;
  severity: "error" | "warning";
  message: string;
};

export type GovernanceEvaluationInput<TFinding extends GovernanceFinding, TMetrics> = {
  evidence: EvidenceAssessment;
  findings: TFinding[];
  warnings: TFinding[];
  metrics: TMetrics;
  requiredRules: string[];
};

export type GovernanceEvaluationResult<TFinding extends GovernanceFinding, TMetrics> = {
  gateDecision: GateDecision;
  inputStatus: GovernanceInputStatus;
  evidenceStatus: EvidenceStatus;
  assurance: AssuranceVector;
  ruleResults: RuleResult[];
  findings: TFinding[];
  warnings: TFinding[];
  metrics: TMetrics;
};
