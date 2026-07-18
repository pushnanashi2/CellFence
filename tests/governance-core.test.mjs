import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { checkRepository } from "../packages/engine/dist/index.js";
import { stableCanonicalJson, stableDigest } from "../packages/engine/dist/governance/canonicalization.js";
import { createGovernanceControlState } from "../packages/engine/dist/governance/control-state.js";
import { assessEvidence } from "../packages/engine/dist/governance/evidence-assessment.js";
import { evaluateGovernance } from "../packages/engine/dist/governance/evaluator.js";
import { legacyDecisionFromEvaluation } from "../packages/engine/dist/governance/legacy-adapter.js";
import { createRawObservationReport } from "../packages/engine/dist/governance/observation-report.js";
import {
  createSubjectSnapshotFromFiles,
  verifySubjectSnapshotIntegrity,
} from "../packages/engine/dist/governance/subject-snapshot.js";

const root = process.cwd();

function completeSnapshot() {
  return createSubjectSnapshotFromFiles([
    { path: "./src/a/public.ts", role: "source", content: "export const a = 1;\n" },
    { path: "cellfence.manifest.json", role: "manifest", content: "{\"schemaVersion\":\"cellfence.manifest.v1\"}\n" },
  ]);
}

function completeReport(snapshot) {
  return createRawObservationReport({
    observer: "unit-test",
    snapshot,
    statuses: [
      { filePath: "src/a/public.ts", family: "imports", status: "processed" },
      { filePath: "src/a/public.ts", family: "resources", status: "processed" },
      { filePath: "src/a/public.ts", family: "public-surface", status: "processed" },
      { filePath: "cellfence.manifest.json", family: "manifest", status: "processed" },
      { filePath: "cellfence.manifest.json", family: "ownership", status: "processed" },
    ],
    importObservationCount: 1,
    resourceObservationCount: 1,
    publicSurfaceObservationCount: 1,
  });
}

function summarizeCheck(result) {
  return {
    ok: result.ok,
    exitCode: result.exitCode,
    findings: result.findings.map((finding) => ({
      ruleId: finding.ruleId,
      severity: finding.severity,
      filePath: finding.filePath,
      message: finding.message,
    })).sort((left, right) => `${left.ruleId}:${left.filePath || ""}`.localeCompare(`${right.ruleId}:${right.filePath || ""}`)),
    warnings: result.warnings.map((finding) => ({
      ruleId: finding.ruleId,
      severity: finding.severity,
      filePath: finding.filePath,
      message: finding.message,
    })).sort((left, right) => `${left.ruleId}:${left.filePath || ""}`.localeCompare(`${right.ruleId}:${right.filePath || ""}`)),
  };
}

function checkFixture(relativePath, options = {}) {
  const previous = process.env.CELLFENCE_BASELINE_HMAC_KEY;
  const baselinePath = options.baselinePath ? path.join(root, "fixtures", relativePath, options.baselinePath) : "";
  const baselineHasSeal = baselinePath && JSON.parse(fs.readFileSync(baselinePath, "utf8")).seal;
  if (baselineHasSeal) process.env.CELLFENCE_BASELINE_HMAC_KEY = "test-baseline-secret";
  try {
    return checkRepository({
      rootDir: path.join(root, "fixtures", relativePath),
      manifestPath: "cellfence.manifest.json",
      ...options,
    });
  } finally {
    if (baselineHasSeal) {
      if (previous === undefined) delete process.env.CELLFENCE_BASELINE_HMAC_KEY;
      else process.env.CELLFENCE_BASELINE_HMAC_KEY = previous;
    }
  }
}

test("governance canonicalization is stable across object order and JSON primitive shapes", () => {
  assert.equal(stableCanonicalJson({ b: 2, a: 1, skipped: undefined }), "{\"a\":1,\"b\":2}");
  assert.equal(stableCanonicalJson([null, "x", true, 3]), "[null,\"x\",true,3]");
  assert.equal(stableCanonicalJson(null), "null");
  assert.equal(stableDigest({ b: 2, a: 1 }), stableDigest({ a: 1, b: 2 }));
});

test("subject snapshot digest is deterministic and integrity checked", () => {
  const first = createSubjectSnapshotFromFiles([
    { path: "src\\b.ts", role: "source", content: "export const b = 2;\n" },
    { path: "./src/a.ts", role: "source", content: "export const a = 1;\n" },
  ]);
  const second = createSubjectSnapshotFromFiles([
    { path: "src/a.ts", role: "source", content: "export const a = 1;\n" },
    { path: "src/b.ts", role: "source", content: "export const b = 2;\n" },
  ]);
  assert.deepEqual(first, second);
  assert.equal(verifySubjectSnapshotIntegrity(first), true);
  assert.equal(verifySubjectSnapshotIntegrity({ ...first, files: first.files.slice(1) }), false);
});

test("raw observation report defaults counts and sorts terminal statuses", () => {
  const snapshot = completeSnapshot();
  const report = createRawObservationReport({
    observer: "unit-test",
    snapshot,
    statuses: [
      { filePath: "src/a/public.ts", family: "resources", status: "not-applicable" },
      { filePath: "cellfence.manifest.json", family: "manifest", status: "processed" },
    ],
  });
  assert.equal(report.importObservationCount, 0);
  assert.equal(report.resourceObservationCount, 0);
  assert.deepEqual(report.statuses.map((status) => `${status.filePath}:${status.family}`), [
    "cellfence.manifest.json:manifest",
    "src/a/public.ts:resources",
  ]);
});

test("complete evidence allows governance evaluation to satisfy required rules", () => {
  const snapshot = completeSnapshot();
  const assessment = assessEvidence(snapshot, completeReport(snapshot), {
    requiredFamilies: ["manifest", "ownership", "imports", "resources", "public-surface"],
  });
  const evaluation = evaluateGovernance({
    evidence: assessment,
    findings: [],
    warnings: [{ ruleId: "CELLFENCE_OWNERSHIP_COVERAGE_DISABLED", severity: "warning", message: "warning only" }],
    metrics: { cells: 1 },
    requiredRules: ["CELLFENCE_PRIVATE_IMPORT"],
  });
  assert.equal(assessment.status, "COMPLETE");
  assert.equal(evaluation.gateDecision, "ALLOW");
  assert.equal(evaluation.assurance.requiredRuleStatus, "SATISFIED");
  assert.equal(evaluation.ruleResults[0].status, "SATISFIED");
});

test("evidence gaps are fail-closed with UNKNOWN rule status", () => {
  const snapshot = completeSnapshot();
  const report = createRawObservationReport({
    observer: "unit-test",
    snapshot,
    statuses: [
      { filePath: "cellfence.manifest.json", family: "manifest", status: "processed" },
      { filePath: "cellfence.manifest.json", family: "ownership", status: "processed" },
    ],
  });
  const assessment = assessEvidence(snapshot, report, { requiredFamilies: ["manifest", "imports", "resources"] });
  const evaluation = evaluateGovernance({
    evidence: assessment,
    findings: [],
    warnings: [],
    metrics: {},
    requiredRules: [],
  });
  assert.equal(assessment.status, "INCOMPLETE");
  assert.ok(assessment.defects.some((defect) => defect.code === "MISSING_OBSERVATION_FAMILY" && defect.family === "resources"));
  assert.ok(assessment.defects.some((defect) => defect.code === "MISSING_FILE_OBSERVATION" && defect.filePath === "src/a/public.ts"));
  assert.equal(evaluation.gateDecision, "BLOCK");
  assert.ok(evaluation.ruleResults.some((result) => result.status === "UNKNOWN" && result.ruleId === "CELLFENCE_EVIDENCE_COVERAGE"));
});

test("parse errors and unsupported observations block without erasing active violations", () => {
  const snapshot = completeSnapshot();
  const report = createRawObservationReport({
    observer: "unit-test",
    snapshot,
    statuses: [
      { filePath: "cellfence.manifest.json", family: "manifest", status: "processed" },
      { filePath: "cellfence.manifest.json", family: "ownership", status: "processed" },
      { filePath: "src/a/public.ts", family: "imports", status: "parse-error", message: "unterminated source" },
      { filePath: "src/a/public.ts", family: "resources", status: "unsupported", message: "adapter missing" },
      { filePath: "src/a/public.ts", family: "public-surface", status: "processed" },
    ],
  });
  const assessment = assessEvidence(snapshot, report, {
    requiredFamilies: ["manifest", "ownership", "imports", "resources", "public-surface"],
  });
  const evaluation = evaluateGovernance({
    evidence: assessment,
    findings: [{ ruleId: "CELLFENCE_PRIVATE_IMPORT", severity: "error", message: "private import" }],
    warnings: [],
    metrics: {},
    requiredRules: ["CELLFENCE_PRIVATE_IMPORT"],
  });
  assert.equal(assessment.status, "INCOMPLETE");
  assert.deepEqual(assessment.defects.map((defect) => defect.code).sort(), ["PARSE_ERROR", "UNSUPPORTED_OBSERVATION"]);
  assert.equal(evaluation.gateDecision, "BLOCK");
  assert.ok(evaluation.ruleResults.some((result) => result.ruleId === "CELLFENCE_PRIVATE_IMPORT" && result.status === "VIOLATED"));
  assert.ok(evaluation.ruleResults.some((result) => result.ruleId === "CELLFENCE_EVIDENCE_COVERAGE" && result.status === "UNKNOWN"));
});

test("evidence assessment detects snapshot mismatch, unknown files, and duplicate observations", () => {
  const snapshot = completeSnapshot();
  const brokenSnapshot = { ...snapshot, snapshotDigest: "0".repeat(64) };
  const report = createRawObservationReport({
    observer: "unit-test",
    snapshot,
    statuses: [
      { filePath: "cellfence.manifest.json", family: "manifest", status: "processed" },
      { filePath: "cellfence.manifest.json", family: "manifest", status: "processed" },
      { filePath: "src/a/public.ts", family: "imports", status: "processed" },
      { filePath: "ghost.ts", family: "imports", status: "processed" },
    ],
  });
  const assessment = assessEvidence(brokenSnapshot, report, { requiredFamilies: ["manifest"] });
  assert.deepEqual(assessment.defects.map((defect) => defect.code).sort(), [
    "DUPLICATE_FILE_OBSERVATION",
    "SNAPSHOT_DIGEST_MISMATCH",
    "SNAPSHOT_INTEGRITY_MISMATCH",
    "UNKNOWN_OBSERVED_FILE",
  ]);
});

test("evidence assessment supplies default messages for parse and unsupported defects", () => {
  const snapshot = completeSnapshot();
  const report = createRawObservationReport({
    observer: "unit-test",
    snapshot,
    statuses: [
      { filePath: "cellfence.manifest.json", family: "manifest", status: "processed" },
      { filePath: "cellfence.manifest.json", family: "ownership", status: "processed" },
      { filePath: "src/a/public.ts", family: "imports", status: "parse-error" },
      { filePath: "src/a/public.ts", family: "resources", status: "unsupported" },
      { filePath: "src/a/public.ts", family: "public-surface", status: "processed" },
    ],
  });
  const assessment = assessEvidence(snapshot, report, {
    requiredFamilies: ["manifest", "ownership", "imports", "resources", "public-surface"],
  });
  assert.ok(assessment.defects.some((defect) =>
    defect.code === "PARSE_ERROR"
    && defect.message === "parse error while observing src/a/public.ts"));
  assert.ok(assessment.defects.some((defect) =>
    defect.code === "UNSUPPORTED_OBSERVATION"
    && defect.message === "unsupported observation for src/a/public.ts"));
});

test("control state digest changes when governance controls change", () => {
  const base = createGovernanceControlState({
    declared: {
      cellIds: ["b", "a"],
      requiredRules: ["CELLFENCE_PRIVATE_IMPORT"],
      configuredSeverities: { beta: "warning", alpha: "error" },
    },
    observed: {
      findingRuleIds: ["CELLFENCE_PRIVATE_IMPORT"],
      warningRuleIds: [],
      observedFamilies: ["imports", "manifest"],
    },
    accepted: {
      baselineCellIds: ["a"],
      waiverRuleIds: [],
    },
    observer: "unit-test",
  });
  const changed = createGovernanceControlState({
    declared: {
      ...base.declared,
      requiredRules: [...base.declared.requiredRules, "CELLFENCE_UNDECLARED_CONSUMER"],
    },
    observed: base.observed,
    accepted: base.accepted,
    observer: "unit-test",
  });
  assert.match(base.controlDigest, /^[a-f0-9]{64}$/);
  assert.notEqual(base.controlDigest, changed.controlDigest);
  assert.deepEqual(base.declared.cellIds, ["a", "b"]);
  assert.deepEqual(Object.keys(base.declared.configuredSeverities), ["alpha", "beta"]);
});

test("legacy adapter maps evaluator decisions without changing check result shape", () => {
  const allow = legacyDecisionFromEvaluation({
    gateDecision: "ALLOW",
    inputStatus: "VALID",
    evidenceStatus: "COMPLETE",
    assurance: { inputStatus: "VALID", evidenceStatus: "COMPLETE", requiredRuleStatus: "SATISFIED" },
    ruleResults: [],
    findings: [],
    warnings: [],
    metrics: { ok: true },
  });
  const invalid = legacyDecisionFromEvaluation({
    ...allow,
    gateDecision: "NOT_EVALUATED",
    inputStatus: "INVALID",
  });
  const block = legacyDecisionFromEvaluation({
    ...allow,
    gateDecision: "BLOCK",
  });
  assert.deepEqual(allow, { ok: true, exitCode: 0, findings: [], warnings: [], metrics: { ok: true } });
  assert.equal(invalid.exitCode, 2);
  assert.equal(block.exitCode, 1);
});

test("checkRepository characterization is stable for valid and invalid fixtures", () => {
  assert.deepEqual(summarizeCheck(checkFixture("valid/public-import")), {
    ok: true,
    exitCode: 0,
    findings: [],
    warnings: [
      {
        ruleId: "CELLFENCE_OWNERSHIP_COVERAGE_DISABLED",
        severity: "warning",
        filePath: undefined,
        message: "strict ownership coverage is disabled; source outside ownedPaths can escape CellFence checks",
      },
    ],
  });
  assert.deepEqual(summarizeCheck(checkFixture("invalid/private-cross-cell-import")), {
    ok: false,
    exitCode: 1,
    findings: [
      {
        ruleId: "CELLFENCE_PRIVATE_IMPORT",
        severity: "error",
        filePath: "src/consumer/public.ts",
        message: "consumer imports private implementation from producer",
      },
    ],
    warnings: [
      {
        ruleId: "CELLFENCE_OWNERSHIP_COVERAGE_DISABLED",
        severity: "warning",
        filePath: undefined,
        message: "strict ownership coverage is disabled; source outside ownedPaths can escape CellFence checks",
      },
    ],
  });
  assert.equal(checkFixture("valid/resource-evidence-baseline", {
    baselinePath: "cellfence.baseline.json",
    evidencePaths: ["resource-evidence.json"],
  }).ok, true);
});

test("pure evaluator dependency closure excludes filesystem, process, git, and compiler imports", () => {
  const forbidden = new Set([
    "node:fs",
    "node:path",
    "node:child_process",
    "node:process",
    "typescript",
  ]);
  const checkedFiles = new Set();
  const pendingFiles = [path.join(root, "packages/engine/src/governance/evaluator.ts")];
  while (pendingFiles.length > 0) {
    const filePath = pendingFiles.pop();
    if (!filePath || checkedFiles.has(filePath)) continue;
    checkedFiles.add(filePath);
    const source = fs.readFileSync(filePath, "utf8");
    for (const match of source.matchAll(/^\s*import(?:\s+type)?[\s\S]*?from\s+"([^"]+)";/gm)) {
      const specifier = match[1];
      assert.equal(forbidden.has(specifier), false, `${path.relative(root, filePath)} imports forbidden module ${specifier}`);
      if (specifier.startsWith("./")) pendingFiles.push(path.join(path.dirname(filePath), `${specifier.slice(2).replace(/\.js$/, "")}.ts`));
    }
  }
  assert.deepEqual([...checkedFiles].map((filePath) => path.relative(root, filePath).replace(/\\/g, "/")).sort(), [
    "packages/engine/src/governance/evaluator.ts",
    "packages/engine/src/governance/model.ts",
  ]);
});
