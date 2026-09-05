import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { checkRepository } from "../packages/engine/dist/index.js";
import { stableDigest } from "../packages/engine/dist/governance/canonicalization.js";

const repoRoot = process.cwd();
const verifierPath = path.join(repoRoot, "scripts", "acceptance-record-verify.mjs");

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function runVerifier(args) {
  return spawnSync(process.execPath, [verifierPath, ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 100 * 1024 * 1024,
  });
}

function withRecordDigest(record) {
  const body = { ...record };
  delete body.recordDigest;
  return {
    ...body,
    recordDigest: stableDigest(body),
  };
}

test("acceptance record verifier accepts a complete ALLOW record and matching evidence graph", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-acceptance-record-ok-"));
  try {
    const result = checkRepository({
      rootDir: path.join(repoRoot, "fixtures/valid/public-import"),
      manifestPath: "cellfence.manifest.json",
      includeEvidenceGraph: true,
      includeAcceptanceRecord: true,
    });
    assert.equal(result.ok, true);
    writeJson(path.join(tempDir, "record.json"), result.acceptanceRecord);
    writeJson(path.join(tempDir, "evidence-graph.json"), result.evidenceGraph);

    const verify = runVerifier([
      "--record",
      path.join(tempDir, "record.json"),
      "--graph",
      path.join(tempDir, "evidence-graph.json"),
    ]);

    assert.equal(verify.status, 0, verify.stderr || verify.stdout);
    const report = JSON.parse(verify.stdout);
    assert.equal(report.ok, true);
    assert.equal(report.summary.gateDecision, "ALLOW");
    assert.ok(report.summary.requiredObservations > 0);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("acceptance record verifier rejects ALLOW records with incomplete evidence", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-acceptance-record-bad-"));
  try {
    const result = checkRepository({
      rootDir: path.join(repoRoot, "fixtures/valid/public-import"),
      manifestPath: "cellfence.manifest.json",
      includeEvidenceGraph: true,
      includeAcceptanceRecord: true,
    });
    const record = withRecordDigest({
      ...result.acceptanceRecord,
      evidence: {
        ...result.acceptanceRecord.evidence,
        status: "INCOMPLETE",
        defects: [{
          code: "MISSING_REQUIRED_OBSERVATION",
          filePath: "src/consumer/public.ts",
          family: "imports",
          message: "required imports observation is missing for src/consumer/public.ts",
        }],
      },
      decision: {
        ...result.acceptanceRecord.decision,
        evidenceStatus: "INCOMPLETE",
      },
    });
    writeJson(path.join(tempDir, "record.json"), record);
    writeJson(path.join(tempDir, "evidence-graph.json"), result.evidenceGraph);

    const verify = runVerifier([
      "--record",
      path.join(tempDir, "record.json"),
      "--graph",
      path.join(tempDir, "evidence-graph.json"),
    ]);

    assert.equal(verify.status, 1, verify.stderr || verify.stdout);
    const report = JSON.parse(verify.stdout);
    assert.equal(report.ok, false);
    assert.ok(report.defects.some((defect) => defect.code === "ALLOW_WITH_INCOMPLETE_EVIDENCE"));
    assert.ok(report.defects.some((defect) => defect.code === "ALLOW_WITH_EVIDENCE_DEFECTS"));
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("acceptance record verifier rejects evidence graphs from a different snapshot", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-acceptance-record-snapshot-"));
  try {
    const result = checkRepository({
      rootDir: path.join(repoRoot, "fixtures/valid/public-import"),
      manifestPath: "cellfence.manifest.json",
      includeEvidenceGraph: true,
      includeAcceptanceRecord: true,
    });
    const graph = {
      ...result.evidenceGraph,
      snapshotDigest: "0".repeat(64),
    };
    const record = withRecordDigest({
      ...result.acceptanceRecord,
      controls: {
        ...result.acceptanceRecord.controls,
        evidenceGraphDigest: stableDigest(graph),
      },
    });
    writeJson(path.join(tempDir, "record.json"), record);
    writeJson(path.join(tempDir, "evidence-graph.json"), graph);

    const verify = runVerifier([
      "--record",
      path.join(tempDir, "record.json"),
      "--graph",
      path.join(tempDir, "evidence-graph.json"),
    ]);

    assert.equal(verify.status, 1, verify.stderr || verify.stdout);
    const report = JSON.parse(verify.stdout);
    assert.ok(report.defects.some((defect) => defect.code === "EVIDENCE_GRAPH_SNAPSHOT_MISMATCH"));
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
