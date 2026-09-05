#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const expectedSchemaVersion = "cellfence.acceptance-record.v1";
const reportSchemaVersion = "cellfence.acceptance-record-verifier.v1";
const verifierVersion = "cellfence.acceptance-record-standalone-verifier.v1";
const allowedGateDecisions = new Set(["ALLOW", "BLOCK", "NOT_EVALUATED"]);
const allowedEvidenceStatuses = new Set(["COMPLETE", "INCOMPLETE"]);
const allowedInputStatuses = new Set(["VALID", "INVALID"]);
const allowedRuleJudgments = new Set(["SATISFIED", "VIOLATED", "UNKNOWN", "NOT_APPLICABLE"]);
const sha256Pattern = /^[a-f0-9]{64}$/;

function usage() {
  console.error(`Usage:
  node scripts/acceptance-record-verify.mjs --record record.json [--graph evidence-graph.json] [--out report.json]

Validates a CellFence acceptance record without importing CellFence runtime code.
For ALLOW records, this verifier requires complete evidence, zero errors, no
UNKNOWN or VIOLATED rule results, a valid recordDigest, and, when supplied, a
matching evidence graph digest.`);
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

function parseArgs(argv) {
  const parsed = {
    recordPath: "",
    graphPath: "",
    outPath: "",
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--record") {
      parsed.recordPath = path.resolve(requireValue(argv, index, "--record"));
      index += 1;
    } else if (argument.startsWith("--record=")) {
      parsed.recordPath = path.resolve(requireInlineValue(argument, "--record=", "--record"));
    } else if (argument === "--graph") {
      parsed.graphPath = path.resolve(requireValue(argv, index, "--graph"));
      index += 1;
    } else if (argument.startsWith("--graph=")) {
      parsed.graphPath = path.resolve(requireInlineValue(argument, "--graph=", "--graph"));
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
  if (!parsed.recordPath) throw new Error("--record is required");
  return parsed;
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

function stableDigest(value) {
  return crypto.createHash("sha256").update(Buffer.from(stableCanonicalJson(value))).digest("hex");
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function withoutRecordDigest(record) {
  const body = { ...record };
  delete body.recordDigest;
  return body;
}

function addDefect(defects, code, message, detail = {}) {
  defects.push({ code, message, ...detail });
}

function validateHex(defects, value, code, message, detail) {
  if (value !== undefined && (typeof value !== "string" || !sha256Pattern.test(value))) {
    addDefect(defects, code, message, detail);
  }
}

function validateRecordShape(defects, record) {
  if (!isRecord(record)) {
    addDefect(defects, "RECORD_NOT_OBJECT", "acceptance record must be a JSON object");
    return;
  }
  if (record.schemaVersion !== expectedSchemaVersion) {
    addDefect(defects, "UNEXPECTED_SCHEMA_VERSION", `expected ${expectedSchemaVersion}`, { actual: record.schemaVersion ?? null });
  }
  if (typeof record.generatedAt !== "string" || Number.isNaN(Date.parse(record.generatedAt))) {
    addDefect(defects, "INVALID_GENERATED_AT", "generatedAt must be an ISO-like timestamp string");
  }
  if (!isRecord(record.subject)) addDefect(defects, "INVALID_SUBJECT", "subject must be an object");
  if (!isRecord(record.controls)) addDefect(defects, "INVALID_CONTROLS", "controls must be an object");
  if (!isRecord(record.verifier)) addDefect(defects, "INVALID_VERIFIER", "verifier must be an object");
  if (!isRecord(record.evidence)) addDefect(defects, "INVALID_EVIDENCE", "evidence must be an object");
  if (!isRecord(record.decision)) addDefect(defects, "INVALID_DECISION", "decision must be an object");
  if (!isRecord(record.findings)) addDefect(defects, "INVALID_FINDINGS", "findings must be an object");
  validateHex(defects, record.recordDigest, "INVALID_RECORD_DIGEST", "recordDigest must be a sha256 hex digest");

  if (isRecord(record.controls)) {
    if (typeof record.controls.manifestPath !== "string" || record.controls.manifestPath.length === 0) {
      addDefect(defects, "INVALID_MANIFEST_PATH", "controls.manifestPath must be a non-empty string");
    }
    validateHex(defects, record.controls.manifestDigest, "INVALID_MANIFEST_DIGEST", "controls.manifestDigest must be a sha256 hex digest");
    validateHex(defects, record.controls.baselineDigest, "INVALID_BASELINE_DIGEST", "controls.baselineDigest must be a sha256 hex digest");
    validateHex(defects, record.controls.evidenceGraphDigest, "INVALID_EVIDENCE_GRAPH_DIGEST", "controls.evidenceGraphDigest must be a sha256 hex digest");
  }
  if (isRecord(record.evidence)) {
    validateHex(defects, record.evidence.snapshotDigest, "INVALID_SNAPSHOT_DIGEST", "evidence.snapshotDigest must be a sha256 hex digest");
    if (!allowedEvidenceStatuses.has(record.evidence.status)) {
      addDefect(defects, "INVALID_EVIDENCE_STATUS", "evidence.status must be COMPLETE or INCOMPLETE", { actual: record.evidence.status ?? null });
    }
    if (!Array.isArray(record.evidence.observedFamilies)) addDefect(defects, "INVALID_OBSERVED_FAMILIES", "evidence.observedFamilies must be an array");
    if (!Array.isArray(record.evidence.requiredObservations)) addDefect(defects, "INVALID_REQUIRED_OBSERVATIONS", "evidence.requiredObservations must be an array");
    if (!Array.isArray(record.evidence.defects)) addDefect(defects, "INVALID_EVIDENCE_DEFECTS", "evidence.defects must be an array");
  }
  if (isRecord(record.decision)) {
    if (!allowedGateDecisions.has(record.decision.gateDecision)) {
      addDefect(defects, "INVALID_GATE_DECISION", "decision.gateDecision is not recognized", { actual: record.decision.gateDecision ?? null });
    }
    if (!allowedInputStatuses.has(record.decision.inputStatus)) {
      addDefect(defects, "INVALID_INPUT_STATUS", "decision.inputStatus is not recognized", { actual: record.decision.inputStatus ?? null });
    }
    if (!allowedEvidenceStatuses.has(record.decision.evidenceStatus)) {
      addDefect(defects, "INVALID_DECISION_EVIDENCE_STATUS", "decision.evidenceStatus is not recognized", { actual: record.decision.evidenceStatus ?? null });
    }
    if (!Array.isArray(record.decision.ruleResults)) {
      addDefect(defects, "INVALID_RULE_RESULTS", "decision.ruleResults must be an array");
    } else {
      for (const [index, result] of record.decision.ruleResults.entries()) {
        if (!isRecord(result) || typeof result.ruleId !== "string" || !allowedRuleJudgments.has(result.status)) {
          addDefect(defects, "INVALID_RULE_RESULT", "rule result entries must carry ruleId and a recognized status", { index });
        }
      }
    }
  }
  if (isRecord(record.findings)) {
    if (!Number.isInteger(record.findings.errors) || record.findings.errors < 0) addDefect(defects, "INVALID_ERROR_COUNT", "findings.errors must be a non-negative integer");
    if (!Number.isInteger(record.findings.warnings) || record.findings.warnings < 0) addDefect(defects, "INVALID_WARNING_COUNT", "findings.warnings must be a non-negative integer");
    if (!Array.isArray(record.findings.fingerprints)) addDefect(defects, "INVALID_FINDING_FINGERPRINTS", "findings.fingerprints must be an array");
  }
}

function validateRecordDigest(defects, record) {
  if (!isRecord(record) || typeof record.recordDigest !== "string") return;
  const actual = stableDigest(withoutRecordDigest(record));
  if (actual !== record.recordDigest) {
    addDefect(defects, "RECORD_DIGEST_MISMATCH", "recordDigest does not match the canonical acceptance record body", {
      expected: record.recordDigest,
      actual,
    });
  }
}

function validateGraphDigest(defects, record, graph) {
  if (!graph) return;
  if (!isRecord(record) || !isRecord(record.controls)) return;
  const expected = record.controls.evidenceGraphDigest;
  if (typeof expected !== "string") {
    addDefect(defects, "MISSING_EVIDENCE_GRAPH_DIGEST", "record does not contain controls.evidenceGraphDigest for the supplied graph");
    return;
  }
  const actual = stableDigest(graph);
  if (actual !== expected) {
    addDefect(defects, "EVIDENCE_GRAPH_DIGEST_MISMATCH", "supplied evidence graph digest does not match the acceptance record", {
      expected,
      actual,
    });
  }
  if (
    isRecord(record.evidence)
    && typeof record.evidence.snapshotDigest === "string"
    && typeof graph.snapshotDigest === "string"
    && graph.snapshotDigest !== record.evidence.snapshotDigest
  ) {
    addDefect(defects, "EVIDENCE_GRAPH_SNAPSHOT_MISMATCH", "supplied evidence graph snapshotDigest does not match the acceptance record", {
      expected: record.evidence.snapshotDigest,
      actual: graph.snapshotDigest,
    });
  }
}

function validateAllowDecision(defects, record) {
  if (!isRecord(record) || !isRecord(record.decision) || record.decision.gateDecision !== "ALLOW") return;
  if (!isRecord(record.evidence) || record.evidence.status !== "COMPLETE") {
    addDefect(defects, "ALLOW_WITH_INCOMPLETE_EVIDENCE", "ALLOW records require COMPLETE evidence");
  }
  if (record.decision.evidenceStatus !== "COMPLETE") {
    addDefect(defects, "ALLOW_WITH_INCOMPLETE_DECISION_EVIDENCE", "ALLOW records require decision.evidenceStatus COMPLETE", {
      evidenceStatus: record.decision.evidenceStatus ?? null,
    });
  }
  if (record.decision.inputStatus !== "VALID") {
    addDefect(defects, "ALLOW_WITH_INVALID_INPUT", "ALLOW records require decision.inputStatus VALID", {
      inputStatus: record.decision.inputStatus ?? null,
    });
  }
  if (!isRecord(record.decision.assurance) || record.decision.assurance.requiredRuleStatus !== "SATISFIED") {
    addDefect(defects, "ALLOW_WITH_UNSATISFIED_ASSURANCE", "ALLOW records require satisfied required-rule assurance");
  }
  if (isRecord(record.evidence) && Array.isArray(record.evidence.defects) && record.evidence.defects.length > 0) {
    addDefect(defects, "ALLOW_WITH_EVIDENCE_DEFECTS", "ALLOW records must not contain evidence defects");
  }
  const errors = isRecord(record.findings) ? record.findings.errors : undefined;
  if (errors !== 0) addDefect(defects, "ALLOW_WITH_ERROR_FINDINGS", "ALLOW records require zero error findings", { errors: errors ?? null });
  if (Array.isArray(record.decision.ruleResults)) {
    const blockingRules = record.decision.ruleResults
      .filter((result) => isRecord(result) && (result.status === "VIOLATED" || result.status === "UNKNOWN"))
      .map((result) => result.ruleId);
    if (blockingRules.length > 0) {
      addDefect(defects, "ALLOW_WITH_BLOCKING_RULE_STATUS", "ALLOW records cannot contain UNKNOWN or VIOLATED rule results", {
        blockingRules,
      });
    }
  }
}

export function verifyAcceptanceRecord(record, options = {}) {
  const defects = [];
  validateRecordShape(defects, record);
  validateRecordDigest(defects, record);
  validateGraphDigest(defects, record, options.graph);
  validateAllowDecision(defects, record);
  return {
    schemaVersion: reportSchemaVersion,
    verifierVersion,
    ok: defects.length === 0,
    input: {
      recordCanonicalSha256: isRecord(record) ? stableDigest(record) : null,
      evidenceGraphCanonicalSha256: options.graph ? stableDigest(options.graph) : null,
    },
    summary: {
      defects: defects.length,
      gateDecision: isRecord(record) && isRecord(record.decision) ? record.decision.gateDecision ?? null : null,
      evidenceStatus: isRecord(record) && isRecord(record.evidence) ? record.evidence.status ?? null : null,
      requiredObservations: isRecord(record) && isRecord(record.evidence) && Array.isArray(record.evidence.requiredObservations)
        ? record.evidence.requiredObservations.length
        : 0,
    },
    defects,
  };
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
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
  let report;
  try {
    const record = readJson(options.recordPath);
    const graph = options.graphPath ? readJson(options.graphPath) : undefined;
    report = verifyAcceptanceRecord(record, { graph });
  } catch (error) {
    report = {
      schemaVersion: reportSchemaVersion,
      verifierVersion,
      ok: false,
      input: {
        recordCanonicalSha256: null,
        evidenceGraphCanonicalSha256: null,
      },
      summary: {
        defects: 1,
        gateDecision: null,
        evidenceStatus: null,
        requiredObservations: 0,
      },
      defects: [{
        code: "INPUT_READ_ERROR",
        message: error instanceof Error ? error.message : String(error),
      }],
    };
  }
  if (options.outPath) writeJson(options.outPath, report);
  else console.log(JSON.stringify(report, null, 2));
  return report.ok ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main();
}
