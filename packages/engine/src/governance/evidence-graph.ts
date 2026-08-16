import { stableCanonicalJson, stableDigest, stableStringCompare } from "./canonicalization.js";
import type {
  EvidenceAssessment,
  EvidenceDefect,
  EvidenceGraph,
  EvidenceGraphEdge,
  EvidenceGraphNode,
  FileObservation,
  FindingWitness,
  FindingWitnessSubject,
  GovernanceFinding,
  RawObservationReport,
  SubjectFile,
  SubjectSnapshot,
} from "./model.js";

export type EvidenceGraphInput<TFinding extends GovernanceFinding = GovernanceFinding> = {
  snapshot: SubjectSnapshot;
  report: RawObservationReport;
  assessment: EvidenceAssessment;
  findings: readonly TFinding[];
  warnings: readonly TFinding[];
};

function graphId(kind: string, payload: unknown): string {
  return `${kind}:${stableDigest(payload).slice(0, 16)}`;
}

function fileNodeId(filePath: string): string {
  return graphId("file", { filePath });
}

function observationNodeId(observation: FileObservation): string {
  return graphId("observation", observation);
}

function findingNodeId(finding: GovernanceFinding, witness: FindingWitness): string {
  return graphId("finding", {
    fingerprint: finding.fingerprint,
    ruleId: finding.ruleId,
    severity: finding.severity,
    filePath: finding.filePath,
    cellId: finding.cellId,
    producerCellId: finding.producerCellId,
    message: finding.message,
    details: finding.details,
    witness,
  });
}

function defectNodeId(defect: EvidenceDefect): string {
  return graphId("defect", defect);
}

function addNode(nodes: Map<string, EvidenceGraphNode>, node: EvidenceGraphNode): void {
  nodes.set(node.id, node);
}

function addEdge(edges: Map<string, EvidenceGraphEdge>, edge: EvidenceGraphEdge): void {
  edges.set(`${edge.from}->${edge.to}:${edge.kind}:${edge.label}`, edge);
}

function subjectFileNode(file: SubjectFile): EvidenceGraphNode {
  return {
    id: fileNodeId(file.path),
    kind: "subject-file",
    label: file.path,
    filePath: file.path,
    digest: file.digest,
  };
}

function subjectFileAnchorNode(filePath: string): EvidenceGraphNode {
  return {
    id: fileNodeId(filePath),
    kind: "subject-file",
    label: filePath,
    filePath,
  };
}

function ensureSubjectFileAnchor(nodes: Map<string, EvidenceGraphNode>, filePath: string | undefined): void {
  if (!filePath) return;
  const id = fileNodeId(filePath);
  if (nodes.has(id)) return;
  addNode(nodes, subjectFileAnchorNode(filePath));
}

function observationNode(observation: FileObservation): EvidenceGraphNode {
  return {
    id: observationNodeId(observation),
    kind: "observation",
    label: `${observation.family}:${observation.status}`,
    filePath: observation.filePath,
    family: observation.family,
    status: observation.status,
  };
}

function findingNode(finding: GovernanceFinding, witness: FindingWitness): EvidenceGraphNode {
  return {
    id: findingNodeId(finding, witness),
    kind: "finding",
    label: finding.ruleId,
    filePath: witness.filePath,
    ruleId: finding.ruleId,
    severity: finding.severity,
  };
}

function defectNode(defect: EvidenceDefect): EvidenceGraphNode {
  return {
    id: defectNodeId(defect),
    kind: "evidence-defect",
    label: defect.code,
    filePath: defect.filePath,
    family: defect.family,
  };
}

function stringDetailSubjects(details: Record<string, unknown> | undefined): FindingWitnessSubject[] {
  if (!details) return [];
  const subjects: FindingWitnessSubject[] = [];
  for (const [key, value] of Object.entries(details)) {
    if (typeof value === "string") subjects.push({ kind: "detail", key, value });
    if (typeof value === "number" || typeof value === "boolean") {
      subjects.push({ kind: "detail", key, value: String(value) });
    }
    if (
      Array.isArray(value)
      && value.every((entry) =>
        typeof entry === "string"
        || typeof entry === "number"
        || typeof entry === "boolean")
    ) {
      subjects.push({ kind: "detail", key, value: stableCanonicalJson(value) });
    }
  }
  return subjects;
}

function compareWitnessSubjects(left: FindingWitnessSubject, right: FindingWitnessSubject): number {
  return stableStringCompare(`${left.kind}:${left.key}:${left.value}`, `${right.kind}:${right.key}:${right.value}`);
}

function sortedWitnessSubjects(subjects: readonly FindingWitnessSubject[]): FindingWitnessSubject[] {
  return [...subjects].sort(compareWitnessSubjects);
}

function witnessFileSubjectPaths(witness: FindingWitness): string[] {
  return witness.subjects
    .filter((subject) => subject.kind === "file" && subject.key === "filePath")
    .map((subject) => subject.value);
}

function normalizedSuppliedWitness(finding: GovernanceFinding, witness: FindingWitness): FindingWitness {
  return {
    ruleId: finding.ruleId,
    severity: finding.severity,
    message: finding.message,
    fingerprint: witness.fingerprint ?? finding.fingerprint,
    filePath: witness.filePath ?? finding.filePath,
    line: witness.line,
    subjects: sortedWitnessSubjects(witness.subjects),
  };
}

export function findingWitness(finding: GovernanceFinding): FindingWitness {
  if (finding.witness) return normalizedSuppliedWitness(finding, finding.witness);
  const subjects: FindingWitnessSubject[] = [];
  if (finding.filePath) subjects.push({ kind: "file", key: "filePath", value: finding.filePath });
  if (finding.cellId) subjects.push({ kind: "cell", key: "cellId", value: finding.cellId });
  if (finding.producerCellId) subjects.push({ kind: "producer-cell", key: "producerCellId", value: finding.producerCellId });
  subjects.push(...stringDetailSubjects(finding.details));
  const line = typeof finding.details?.line === "number" ? finding.details.line : undefined;
  return {
    ruleId: finding.ruleId,
    severity: finding.severity,
    message: finding.message,
    fingerprint: finding.fingerprint,
    filePath: finding.filePath,
    line,
    subjects: sortedWitnessSubjects(subjects),
  };
}

function witnessSortKey(witness: FindingWitness): string {
  return stableDigest(witness);
}

export function createEvidenceGraph<TFinding extends GovernanceFinding>(input: EvidenceGraphInput<TFinding>): EvidenceGraph {
  const nodes = new Map<string, EvidenceGraphNode>();
  const edges = new Map<string, EvidenceGraphEdge>();

  for (const file of input.snapshot.files) addNode(nodes, subjectFileNode(file));

  for (const observation of input.report.statuses) {
    const node = observationNode(observation);
    ensureSubjectFileAnchor(nodes, observation.filePath);
    addNode(nodes, node);
    addEdge(edges, {
      from: fileNodeId(observation.filePath),
      to: node.id,
      kind: "observed-as",
      label: observation.family,
    });
  }

  const findingEntries = [...input.findings, ...input.warnings].map((finding) => ({
    finding,
    witness: findingWitness(finding),
  }));
  const findingWitnesses = findingEntries.map((entry) => entry.witness);
  for (const { finding, witness } of findingEntries) {
    const node = findingNode(finding, witness);
    ensureSubjectFileAnchor(nodes, witness.filePath);
    for (const filePath of witnessFileSubjectPaths(witness)) ensureSubjectFileAnchor(nodes, filePath);
    addNode(nodes, node);
    const filePath = witness.filePath;
    if (filePath) {
      addEdge(edges, {
        from: fileNodeId(filePath),
        to: node.id,
        kind: "reported-finding",
        label: finding.ruleId,
      });
      addEdge(edges, {
        from: node.id,
        to: fileNodeId(filePath),
        kind: "witnesses",
        label: "filePath",
      });
    }
  }

  for (const defect of input.assessment.defects) {
    const node = defectNode(defect);
    ensureSubjectFileAnchor(nodes, defect.filePath);
    addNode(nodes, node);
    if (defect.filePath) {
      addEdge(edges, {
        from: fileNodeId(defect.filePath),
        to: node.id,
        kind: "has-defect",
        label: defect.code,
      });
    }
  }

  return {
    schemaVersion: "cellfence.evidence-graph.v1",
    snapshotDigest: input.snapshot.snapshotDigest,
    nodes: [...nodes.values()].sort((left, right) => stableStringCompare(left.id, right.id)),
    edges: [...edges.values()].sort((left, right) => stableStringCompare(`${left.from}:${left.to}:${left.kind}:${left.label}`, `${right.from}:${right.to}:${right.kind}:${right.label}`)),
    findingWitnesses: findingWitnesses.sort((left, right) =>
      stableStringCompare(witnessSortKey(left), witnessSortKey(right))),
  };
}
