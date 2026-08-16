import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  compareSarifToJson,
  validateOfficialSarifSchema,
} from "../scripts/sarif-oracle-conformance.mjs";

const repoRoot = path.resolve(".");
const scriptPath = path.join(repoRoot, "scripts", "sarif-oracle-conformance.mjs");

test("SARIF oracle harness compares JSON semantics and runs a pre-provisioned external validator", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-sarif-oracle-test-"));
  try {
    const validatorPath = path.join(rootDir, "validator.mjs");
    const outPath = path.join(rootDir, "report.json");
    const sarifPath = path.join(rootDir, "cellfence.sarif");
    fs.writeFileSync(validatorPath, `#!${process.execPath}\nimport fs from "node:fs";\nconst document = JSON.parse(fs.readFileSync(process.argv.at(-1), "utf8"));\nprocess.exitCode = document.version === "2.1.0" && document.runs?.[0]?.tool?.driver?.name === "CellFence" ? 0 : 1;\n`);
    fs.chmodSync(validatorPath, 0o755);
    const result = spawnSync(process.execPath, [
      scriptPath,
      "--root", path.join(repoRoot, "fixtures", "invalid", "private-cross-cell-import"),
      "--oracle-command", process.execPath,
      "--oracle-arg", validatorPath,
      "--oracle-arg", "{sarif}",
      "--require-external",
      "--sarif-out", sarifPath,
      "--out", outPath,
    ], { cwd: repoRoot, encoding: "utf8", maxBuffer: 100 * 1024 * 1024 });

    assert.equal(result.status, 0, result.stderr || result.stdout);
    const report = JSON.parse(fs.readFileSync(outPath, "utf8"));
    assert.equal(report.schemaVersion, "cellfence.sarif-oracle-conformance.v1");
    assert.equal(report.status, "conformant");
    assert.equal(report.internal.status, "conformant");
    assert.equal(report.internal.officialSchema.status, "conformant");
    assert.equal(report.internal.jsonFindings, report.internal.sarifResults);
    assert.equal(report.external.status, "conformant");
    assert.equal(JSON.parse(fs.readFileSync(sarifPath, "utf8")).version, "2.1.0");
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("official OASIS SARIF schema rejects malformed output", () => {
  const validation = validateOfficialSarifSchema({ version: "2.1.0", runs: [{ unexpected: true }] });
  assert.equal(validation.status, "divergent");
  assert.equal(validation.schemaPath, "tests/fixtures/sarif/sarif-schema-2.1.0.json");
  assert.match(validation.errors.join("\n"), /additional properties|tool/);
});

test("SARIF semantic comparison reports tampered results as divergent", () => {
  const checkResult = {
    findings: [{
      ruleId: "CELLFENCE_PRIVATE_IMPORT",
      severity: "error",
      message: "private import",
      filePath: "src/app.ts",
      details: { line: 3 },
      fingerprint: "abc",
    }],
    warnings: [],
  };
  const sarif = {
    version: "2.1.0",
    $schema: "https://json.schemastore.org/sarif-2.1.0.json",
    runs: [{
      tool: { driver: { name: "CellFence", rules: [{ id: "CELLFENCE_PRIVATE_IMPORT" }] } },
      invocations: [{ executionSuccessful: true }],
      results: [{
        ruleId: "CELLFENCE_PRIVATE_IMPORT",
        level: "warning",
        message: { text: "private import" },
        locations: [{ physicalLocation: { artifactLocation: { uri: "src/app.ts" }, region: { startLine: 3 } } }],
        partialFingerprints: { cellfence: "abc" },
      }],
    }],
  };
  const comparison = compareSarifToJson(checkResult, sarif);
  assert.equal(comparison.status, "divergent");
  assert.match(comparison.errors.join("\n"), /diverge/);
});

test("SARIF semantic comparison decodes artifact URIs before comparing paths", () => {
  const checkResult = {
    findings: [{
      ruleId: "CELLFENCE_PRIVATE_IMPORT",
      severity: "error",
      message: "private import",
      filePath: "src/app #?.ts",
      details: { line: 3 },
      fingerprint: "abc",
    }],
    warnings: [],
  };
  const sarif = {
    version: "2.1.0",
    $schema: "https://json.schemastore.org/sarif-2.1.0.json",
    runs: [{
      tool: { driver: { name: "CellFence", rules: [{ id: "CELLFENCE_PRIVATE_IMPORT" }] } },
      invocations: [{ executionSuccessful: true }],
      results: [{
        ruleId: "CELLFENCE_PRIVATE_IMPORT",
        level: "error",
        message: { text: "private import" },
        locations: [{ physicalLocation: { artifactLocation: { uri: "src/app%20%23%3F.ts" }, region: { startLine: 3 } } }],
        partialFingerprints: { cellfence: "abc" },
      }],
    }],
  };
  const comparison = compareSarifToJson(checkResult, sarif);
  assert.equal(comparison.status, "conformant", comparison.errors.join("\n"));
});
