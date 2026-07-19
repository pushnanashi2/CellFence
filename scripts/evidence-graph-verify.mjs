#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const expectedSchemaVersion = "cellfence.evidence-graph.v1";
const reportSchemaVersion = "cellfence.evidence-graph-verifier.v1";
const allowedNodeKinds = new Set(["subject-file", "observation", "finding", "evidence-defect"]);
const allowedEdgeKinds = new Set(["observed-as", "reported-finding", "has-defect", "witnesses"]);
const allowedFamilies = new Set([
  "manifest",
  "ownership",
  "public-surface",
  "imports",
  "resources",
  "baseline",
  "plugins",
  "waivers",
]);
const allowedObservationStatuses = new Set(["processed", "not-applicable", "parse-error", "unsupported"]);
const allowedSeverities = new Set(["error", "warning"]);
const allowedWitnessSubjectKinds = new Set(["file", "cell", "producer-cell", "detail"]);

function usage() {
  console.error(`Usage:
  node scripts/evidence-graph-verify.mjs --graph evidence-graph.json [--out report.json]
  node scripts/evidence-graph-verify.mjs --check-result check-result.json [--out report.json]

Validates the structural integrity of a CellFence evidence graph. This is a
standalone structural verifier for graph shape, canonical ordering, references,
finding witnesses, and file anchors. It is not a formal policy re-evaluator.`);
}

function parseArgs(argv) {
  const parsed = {
    graphPath: "",
    checkResultPath: "",
    outPath: "",
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--graph") {
      parsed.graphPath = path.resolve(requireValue(argv, index, "--graph"));
      index += 1;
    } else if (argument.startsWith("--graph=")) {
      parsed.graphPath = path.resolve(requireInlineValue(argument, "--graph=", "--graph"));
    } else if (argument === "--check-result") {
      parsed.checkResultPath = path.resolve(requireValue(argv, index, "--check-result"));
      index += 1;
    } else if (argument.startsWith("--check-result=")) {
      parsed.checkResultPath = path.resolve(requireInlineValue(argument, "--check-result=", "--check-result"));
    } else if (argument === "--out") {
      parsed.outPath = path.resolve(requireValue(argv, index, "--out"));
      index += 1;
    } else if (argument.startsWith("--out=")) {
      parsed.outPath = path.resolve(requireInlineValue(argument, "--out=", "--out"));
    } else if (argument === "--help" || argument === "-h") {
      usage();
      process.exit(0);
    } else {
      throw new Error(`unknown argument: ${argument}`);
    }
  }
  if (Boolean(parsed.graphPath) === Boolean(parsed.checkResultPath)) {
    throw new Error("exactly one of --graph or --check-result is required");
  }
  return parsed;
}

function requireValue(argv, index, optionName) {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${optionName} requires a value`);
  return value;
}

function requireInlineValue(argument, prefix, optionName) {
  const value = argument.slice(prefix.length);
  if (!value) throw new Error(`${optionName} requires a value`);
  return value;
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stableCanonicalJson(value) {
  if (value === null) return "null";
  if (value === undefined) return "null";
  if (Array.isArray(value)) return `[${value.map((item) => stableCanonicalJson(item)).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.entries(value)
      .filter((entry) => entry[1] !== undefined)
      .sort((left, right) => left[0].localeCompare(right[0]))
      .map(([key, entryValue]) => `${JSON.stringify(key)}:${stableCanonicalJson(entryValue)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256Hex(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function stableDigest(value) {
  return sha256Hex(Buffer.from(stableCanonicalJson(value)));
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function addDefect(defects, code, message, detail = {}) {
  defects.push({ code, message, ...detail });
}

function nodeSortKey(node) {
  return isRecord(node) && typeof node.id === "string" ? node.id : "";
}

function edgeSortKey(edge) {
  if (!isRecord(edge)) return "";
  return `${typeof edge.from === "string" ? edge.from : ""}:${typeof edge.to === "string" ? edge.to : ""}:${typeof edge.kind === "string" ? edge.kind : ""}:${typeof edge.label === "string" ? edge.label : ""}`;
}

function isSorted(values) {
  return values.every((value, index) => index === 0 || values[index - 1].localeCompare(value) <= 0);
}

function validateOptionalHex(defects, value, code, message, detail) {
  if (value !== undefined && (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value))) {
    addDefect(defects, code, message, detail);
  }
}

function edgeMatches(edge, from, to, kind) {
  return edge.from === from && edge.to === to && edge.kind === kind;
}

function witnessMatchesFindingNode(witness, node) {
  return witness.ruleId === node.ruleId
    && witness.severity === node.severity
    && (node.filePath === undefined || witness.filePath === node.filePath);
}

function summarizeNodes(nodes) {
  const byKind = Object.fromEntries([...allowedNodeKinds].map((kind) => [kind, 0]));
  for (const node of nodes) {
    if (allowedNodeKinds.has(node.kind)) byKind[node.kind] += 1;
  }
  return byKind;
}

export function verifyEvidenceGraph(graph, options = {}) {
  const defects = [];
  if (!isRecord(graph)) {
    addDefect(defects, "GRAPH_NOT_OBJECT", "evidence graph must be a JSON object");
    return createReport({ graph, defects, options });
  }

  if (graph.schemaVersion !== expectedSchemaVersion) {
    addDefect(defects, "UNEXPECTED_SCHEMA_VERSION", `expected ${expectedSchemaVersion}`, {
      actual: graph.schemaVersion ?? null,
    });
  }
  if (typeof graph.snapshotDigest !== "string" || !/^[a-f0-9]{64}$/.test(graph.snapshotDigest)) {
    addDefect(defects, "INVALID_SNAPSHOT_DIGEST", "snapshotDigest must be a 64-character lowercase sha256 hex digest");
  }

  const rawNodes = Array.isArray(graph.nodes) ? graph.nodes : [];
  const rawEdges = Array.isArray(graph.edges) ? graph.edges : [];
  const rawWitnesses = Array.isArray(graph.findingWitnesses) ? graph.findingWitnesses : [];
  if (!Array.isArray(graph.nodes)) addDefect(defects, "NODES_NOT_ARRAY", "nodes must be an array");
  if (!Array.isArray(graph.edges)) addDefect(defects, "EDGES_NOT_ARRAY", "edges must be an array");
  if (!Array.isArray(graph.findingWitnesses)) {
    addDefect(defects, "FINDING_WITNESSES_NOT_ARRAY", "findingWitnesses must be an array");
  }
  if (!isSorted(rawNodes.map(nodeSortKey))) {
    addDefect(defects, "NODES_NOT_CANONICALLY_SORTED", "nodes must be sorted by id for reproducible evidence");
  }
  if (!isSorted(rawEdges.map(edgeSortKey))) {
    addDefect(defects, "EDGES_NOT_CANONICALLY_SORTED", "edges must be sorted by from/to/kind/label for reproducible evidence");
  }
  if (!isSorted(rawWitnesses.map((witness) => stableDigest(witness)))) {
    addDefect(defects, "WITNESSES_NOT_CANONICALLY_SORTED", "findingWitnesses must be sorted by canonical digest");
  }

  const nodesById = new Map();
  const subjectFileByPath = new Map();
  const validNodes = [];
  for (const [index, node] of rawNodes.entries()) {
    if (!isRecord(node)) {
      addDefect(defects, "NODE_NOT_OBJECT", "node must be a JSON object", { nodeIndex: index });
      continue;
    }
    const id = node.id;
    const kind = node.kind;
    if (typeof id !== "string" || id.length === 0) {
      addDefect(defects, "INVALID_NODE_ID", "node id must be a non-empty string", { nodeIndex: index });
      continue;
    }
    if (nodesById.has(id)) {
      addDefect(defects, "DUPLICATE_NODE_ID", "node id must be unique", { nodeIndex: index, nodeId: id });
      continue;
    }
    if (!allowedNodeKinds.has(kind)) {
      addDefect(defects, "INVALID_NODE_KIND", "node kind is not recognized", { nodeIndex: index, nodeId: id, kind });
    }
    if (typeof node.label !== "string" || node.label.length === 0) {
      addDefect(defects, "INVALID_NODE_LABEL", "node label must be a non-empty string", { nodeIndex: index, nodeId: id });
    }
    if (node.filePath !== undefined && (typeof node.filePath !== "string" || node.filePath.length === 0)) {
      addDefect(defects, "INVALID_NODE_FILE_PATH", "node filePath must be a non-empty string when present", { nodeIndex: index, nodeId: id });
    }
    if (node.family !== undefined && !allowedFamilies.has(node.family)) {
      addDefect(defects, "INVALID_NODE_FAMILY", "node family is not recognized", { nodeIndex: index, nodeId: id, family: node.family });
    }
    if (node.status !== undefined && !allowedObservationStatuses.has(node.status)) {
      addDefect(defects, "INVALID_NODE_STATUS", "node status is not recognized", { nodeIndex: index, nodeId: id, status: node.status });
    }
    if (node.severity !== undefined && !allowedSeverities.has(node.severity)) {
      addDefect(defects, "INVALID_NODE_SEVERITY", "node severity is not recognized", { nodeIndex: index, nodeId: id, severity: node.severity });
    }
    validateOptionalHex(defects, node.digest, "INVALID_NODE_DIGEST", "node digest must be a sha256 hex digest when present", {
      nodeIndex: index,
      nodeId: id,
    });
    nodesById.set(id, node);
    validNodes.push(node);
    if (kind === "subject-file") {
      if (typeof node.filePath !== "string" || node.filePath.length === 0) {
        addDefect(defects, "SUBJECT_FILE_WITHOUT_FILE_PATH", "subject-file nodes must carry filePath", { nodeIndex: index, nodeId: id });
      } else if (subjectFileByPath.has(node.filePath)) {
        addDefect(defects, "DUPLICATE_SUBJECT_FILE_PATH", "subject-file filePath must be unique", {
          nodeIndex: index,
          nodeId: id,
          filePath: node.filePath,
        });
      } else {
        subjectFileByPath.set(node.filePath, node);
      }
    }
  }

  const edgeKeys = new Set();
  const validEdges = [];
  for (const [index, edge] of rawEdges.entries()) {
    if (!isRecord(edge)) {
      addDefect(defects, "EDGE_NOT_OBJECT", "edge must be a JSON object", { edgeIndex: index });
      continue;
    }
    const { from, to, kind, label } = edge;
    if (typeof from !== "string" || from.length === 0) {
      addDefect(defects, "INVALID_EDGE_FROM", "edge from must be a non-empty string", { edgeIndex: index });
      continue;
    }
    if (typeof to !== "string" || to.length === 0) {
      addDefect(defects, "INVALID_EDGE_TO", "edge to must be a non-empty string", { edgeIndex: index });
      continue;
    }
    if (!allowedEdgeKinds.has(kind)) {
      addDefect(defects, "INVALID_EDGE_KIND", "edge kind is not recognized", { edgeIndex: index, kind });
    }
    if (typeof label !== "string" || label.length === 0) {
      addDefect(defects, "INVALID_EDGE_LABEL", "edge label must be a non-empty string", { edgeIndex: index, from, to, kind });
    }
    const key = edgeSortKey(edge);
    if (edgeKeys.has(key)) {
      addDefect(defects, "DUPLICATE_EDGE", "edge must be unique by from/to/kind/label", { edgeIndex: index, edgeKey: key });
    }
    edgeKeys.add(key);
    const fromNode = nodesById.get(from);
    const toNode = nodesById.get(to);
    if (!fromNode) addDefect(defects, "UNKNOWN_EDGE_FROM", "edge references an unknown from node", { edgeIndex: index, from });
    if (!toNode) addDefect(defects, "UNKNOWN_EDGE_TO", "edge references an unknown to node", { edgeIndex: index, to });
    if (fromNode && toNode) validateEdgeShape(defects, edge, fromNode, toNode, index);
    validEdges.push(edge);
  }

  const witnesses = validateWitnesses(defects, rawWitnesses, subjectFileByPath);
  validateNodeAnchors(defects, validNodes, validEdges, witnesses, subjectFileByPath);

  return createReport({ graph, defects, options, validNodes, validEdges, witnesses });
}

function validateEdgeShape(defects, edge, fromNode, toNode, edgeIndex) {
  if (edge.kind === "observed-as") {
    if (fromNode.kind !== "subject-file" || toNode.kind !== "observation") {
      addDefect(defects, "INVALID_OBSERVED_AS_EDGE_SHAPE", "observed-as edges must connect subject-file to observation", { edgeIndex });
    }
    if (toNode.family && edge.label !== toNode.family) {
      addDefect(defects, "OBSERVED_AS_LABEL_MISMATCH", "observed-as edge label must match observation family", { edgeIndex });
    }
    if (fromNode.filePath && toNode.filePath && fromNode.filePath !== toNode.filePath) {
      addDefect(defects, "OBSERVED_AS_FILE_MISMATCH", "observed-as edge endpoints must refer to the same file", { edgeIndex });
    }
  } else if (edge.kind === "reported-finding") {
    if (fromNode.kind !== "subject-file" || toNode.kind !== "finding") {
      addDefect(defects, "INVALID_REPORTED_FINDING_EDGE_SHAPE", "reported-finding edges must connect subject-file to finding", { edgeIndex });
    }
    if (toNode.ruleId && edge.label !== toNode.ruleId) {
      addDefect(defects, "REPORTED_FINDING_LABEL_MISMATCH", "reported-finding edge label must match finding ruleId", { edgeIndex });
    }
  } else if (edge.kind === "has-defect") {
    if (fromNode.kind !== "subject-file" || toNode.kind !== "evidence-defect") {
      addDefect(defects, "INVALID_HAS_DEFECT_EDGE_SHAPE", "has-defect edges must connect subject-file to evidence-defect", { edgeIndex });
    }
    if (edge.label !== toNode.label) {
      addDefect(defects, "HAS_DEFECT_LABEL_MISMATCH", "has-defect edge label must match defect code label", { edgeIndex });
    }
  } else if (edge.kind === "witnesses") {
    if (fromNode.kind !== "finding" || toNode.kind !== "subject-file") {
      addDefect(defects, "INVALID_WITNESSES_EDGE_SHAPE", "witnesses edges must connect finding to subject-file", { edgeIndex });
    }
    if (fromNode.filePath && toNode.filePath && fromNode.filePath !== toNode.filePath) {
      addDefect(defects, "WITNESS_FILE_MISMATCH", "witnesses edge endpoints must refer to the same file", { edgeIndex });
    }
  }
}

function validateWitnesses(defects, rawWitnesses, subjectFileByPath) {
  const witnesses = [];
  for (const [index, witness] of rawWitnesses.entries()) {
    if (!isRecord(witness)) {
      addDefect(defects, "WITNESS_NOT_OBJECT", "finding witness must be a JSON object", { witnessIndex: index });
      continue;
    }
    if (typeof witness.ruleId !== "string" || witness.ruleId.length === 0) {
      addDefect(defects, "INVALID_WITNESS_RULE_ID", "finding witness ruleId must be a non-empty string", { witnessIndex: index });
    }
    if (!allowedSeverities.has(witness.severity)) {
      addDefect(defects, "INVALID_WITNESS_SEVERITY", "finding witness severity is not recognized", { witnessIndex: index, severity: witness.severity });
    }
    if (typeof witness.message !== "string" || witness.message.length === 0) {
      addDefect(defects, "INVALID_WITNESS_MESSAGE", "finding witness message must be a non-empty string", { witnessIndex: index });
    }
    if (witness.fingerprint !== undefined && (typeof witness.fingerprint !== "string" || witness.fingerprint.length === 0)) {
      addDefect(defects, "INVALID_WITNESS_FINGERPRINT", "finding witness fingerprint must be a non-empty string when present", { witnessIndex: index });
    }
    if (witness.filePath !== undefined) {
      if (typeof witness.filePath !== "string" || witness.filePath.length === 0) {
        addDefect(defects, "INVALID_WITNESS_FILE_PATH", "finding witness filePath must be a non-empty string when present", { witnessIndex: index });
      } else if (!subjectFileByPath.has(witness.filePath)) {
        addDefect(defects, "WITNESS_FILE_NOT_IN_GRAPH", "finding witness filePath must refer to a subject-file node", {
          witnessIndex: index,
          filePath: witness.filePath,
        });
      }
    }
    if (witness.line !== undefined && (!Number.isInteger(witness.line) || witness.line < 1)) {
      addDefect(defects, "INVALID_WITNESS_LINE", "finding witness line must be a positive integer when present", { witnessIndex: index });
    }
    if (!Array.isArray(witness.subjects)) {
      addDefect(defects, "WITNESS_SUBJECTS_NOT_ARRAY", "finding witness subjects must be an array", { witnessIndex: index });
    } else {
      for (const [subjectIndex, subject] of witness.subjects.entries()) {
        validateWitnessSubject(defects, subject, witnessIndex(index, subjectIndex), subjectFileByPath);
      }
    }
    if (!witness.filePath && !witness.fingerprint && (!Array.isArray(witness.subjects) || witness.subjects.length === 0)) {
      addDefect(defects, "WITNESS_WITHOUT_ANCHOR", "finding witness must carry a filePath, fingerprint, or subject anchor", { witnessIndex: index });
    }
    witnesses.push(witness);
  }
  return witnesses;
}

function witnessIndex(witnessIndexValue, subjectIndex) {
  return { witnessIndex: witnessIndexValue, subjectIndex };
}

function validateWitnessSubject(defects, subject, detail, subjectFileByPath) {
  if (!isRecord(subject)) {
    addDefect(defects, "WITNESS_SUBJECT_NOT_OBJECT", "finding witness subject must be a JSON object", detail);
    return;
  }
  if (!allowedWitnessSubjectKinds.has(subject.kind)) {
    addDefect(defects, "INVALID_WITNESS_SUBJECT_KIND", "finding witness subject kind is not recognized", {
      ...detail,
      kind: subject.kind,
    });
  }
  if (typeof subject.key !== "string" || subject.key.length === 0) {
    addDefect(defects, "INVALID_WITNESS_SUBJECT_KEY", "finding witness subject key must be a non-empty string", detail);
  }
  if (typeof subject.value !== "string" || subject.value.length === 0) {
    addDefect(defects, "INVALID_WITNESS_SUBJECT_VALUE", "finding witness subject value must be a non-empty string", detail);
  }
  if (subject.kind === "file" && subject.key === "filePath" && typeof subject.value === "string" && !subjectFileByPath.has(subject.value)) {
    addDefect(defects, "WITNESS_SUBJECT_FILE_NOT_IN_GRAPH", "file witness subject must refer to a subject-file node", {
      ...detail,
      filePath: subject.value,
    });
  }
}

function validateNodeAnchors(defects, nodes, edges, witnesses, subjectFileByPath) {
  const findingNodes = nodes.filter((node) => node.kind === "finding");
  for (const node of nodes) {
    if (node.kind === "observation") {
      validateObservationNodeAnchor(defects, node, edges, subjectFileByPath);
    } else if (node.kind === "evidence-defect") {
      validateDefectNodeAnchor(defects, node, edges, subjectFileByPath);
    } else if (node.kind === "finding") {
      validateFindingNodeAnchor(defects, node, edges, witnesses, subjectFileByPath);
    }
  }
  for (const [index, witness] of witnesses.entries()) {
    if (!findingNodes.some((node) => witnessMatchesFindingNode(witness, node))) {
      addDefect(defects, "WITNESS_WITHOUT_FINDING_NODE", "finding witness must match a finding node by ruleId, severity, and filePath", {
        witnessIndex: index,
        ruleId: witness.ruleId,
        filePath: witness.filePath ?? null,
      });
    }
  }
}

function validateObservationNodeAnchor(defects, node, edges, subjectFileByPath) {
  if (typeof node.filePath !== "string" || node.filePath.length === 0) {
    addDefect(defects, "OBSERVATION_WITHOUT_FILE_PATH", "observation nodes must carry filePath", { nodeId: node.id });
    return;
  }
  const fileNode = subjectFileByPath.get(node.filePath);
  if (!fileNode) {
    addDefect(defects, "OBSERVATION_FILE_NOT_IN_GRAPH", "observation filePath must refer to a subject-file node", {
      nodeId: node.id,
      filePath: node.filePath,
    });
    return;
  }
  if (!edges.some((edge) => edgeMatches(edge, fileNode.id, node.id, "observed-as"))) {
    addDefect(defects, "OBSERVATION_WITHOUT_OBSERVED_AS_EDGE", "observation node must be reached from its subject-file node", {
      nodeId: node.id,
      filePath: node.filePath,
    });
  }
}

function validateDefectNodeAnchor(defects, node, edges, subjectFileByPath) {
  if (node.filePath === undefined) return;
  const fileNode = subjectFileByPath.get(node.filePath);
  if (!fileNode) {
    addDefect(defects, "DEFECT_FILE_NOT_IN_GRAPH", "evidence-defect filePath must refer to a subject-file node", {
      nodeId: node.id,
      filePath: node.filePath,
    });
    return;
  }
  if (!edges.some((edge) => edgeMatches(edge, fileNode.id, node.id, "has-defect"))) {
    addDefect(defects, "DEFECT_WITHOUT_HAS_DEFECT_EDGE", "evidence-defect node must be reached from its subject-file node", {
      nodeId: node.id,
      filePath: node.filePath,
    });
  }
}

function validateFindingNodeAnchor(defects, node, edges, witnesses, subjectFileByPath) {
  if (typeof node.ruleId !== "string" || node.ruleId.length === 0) {
    addDefect(defects, "FINDING_NODE_WITHOUT_RULE_ID", "finding nodes must carry ruleId", { nodeId: node.id });
  }
  if (!allowedSeverities.has(node.severity)) {
    addDefect(defects, "FINDING_NODE_WITHOUT_SEVERITY", "finding nodes must carry severity", { nodeId: node.id });
  }
  if (!witnesses.some((witness) => witnessMatchesFindingNode(witness, node))) {
    addDefect(defects, "FINDING_NODE_WITHOUT_WITNESS_RECORD", "finding node must have a matching findingWitness record", {
      nodeId: node.id,
      ruleId: node.ruleId ?? null,
      filePath: node.filePath ?? null,
    });
  }
  if (node.filePath === undefined) return;
  const fileNode = subjectFileByPath.get(node.filePath);
  if (!fileNode) {
    addDefect(defects, "FINDING_FILE_NOT_IN_GRAPH", "finding node filePath must refer to a subject-file node", {
      nodeId: node.id,
      filePath: node.filePath,
    });
    return;
  }
  if (!edges.some((edge) => edgeMatches(edge, fileNode.id, node.id, "reported-finding"))) {
    addDefect(defects, "FINDING_WITHOUT_REPORTED_FINDING_EDGE", "finding node must be reached from its subject-file node", {
      nodeId: node.id,
      filePath: node.filePath,
    });
  }
  if (!edges.some((edge) => edgeMatches(edge, node.id, fileNode.id, "witnesses"))) {
    addDefect(defects, "FINDING_WITHOUT_WITNESSES_EDGE", "finding node must witness its subject-file node", {
      nodeId: node.id,
      filePath: node.filePath,
    });
  }
}

function createReport({ graph, defects, options, validNodes = [], validEdges = [], witnesses = [] }) {
  const byKind = summarizeNodes(validNodes);
  return {
    schemaVersion: reportSchemaVersion,
    verifier: "cellfence-evidence-graph-structural-verifier.v1",
    ok: defects.length === 0,
    input: {
      source: options.source || "memory",
      inputSha256: options.inputSha256 || null,
      graphCanonicalSha256: isRecord(graph) ? stableDigest(graph) : null,
    },
    summary: {
      nodes: validNodes.length,
      edges: validEdges.length,
      subjectFiles: byKind["subject-file"],
      observations: byKind.observation,
      findings: byKind.finding,
      evidenceDefects: byKind["evidence-defect"],
      findingWitnesses: witnesses.length,
      structuralDefects: defects.length,
    },
    defects,
  };
}

function loadGraph(options) {
  const inputPath = options.graphPath || options.checkResultPath;
  const text = fs.readFileSync(inputPath, "utf8");
  const parsed = JSON.parse(text);
  if (options.checkResultPath) {
    if (!isRecord(parsed) || !isRecord(parsed.evidenceGraph)) {
      throw new Error("--check-result input does not contain an evidenceGraph object");
    }
    return {
      graph: parsed.evidenceGraph,
      source: "check-result",
      inputSha256: sha256Hex(Buffer.from(text)),
    };
  }
  return {
    graph: parsed,
    source: "graph",
    inputSha256: sha256Hex(Buffer.from(text)),
  };
}

function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    usage();
    console.error(error instanceof Error ? error.message : String(error));
    return 2;
  }

  try {
    const loaded = loadGraph(options);
    const report = verifyEvidenceGraph(loaded.graph, {
      source: loaded.source,
      inputSha256: loaded.inputSha256,
    });
    if (options.outPath) writeJson(options.outPath, report);
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return report.ok ? 0 : 1;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 2;
  }
}

if (import.meta.url === pathToFileURL(fileURLToPath(import.meta.url)).href
  && process.argv[1]
  && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main();
}
