import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { buildCoverageReport } from "../packages/engine/dist/index.js";
import { runCoverageCommand } from "../packages/cli/dist/coverage-command.js";

const root = process.cwd();

test("buildCoverageReport rolls up unresolved observations into a stable summary", () => {
  const rootDir = fs.mkdtempSync(path.join(root, ".cellfence-coverage-"));
  try {
    const report = buildCoverageReport({
      rootDir,
      totalFiles: 100,
      analyzedFiles: ["src/a.ts", "src/b.ts", "src/c.ts"],
      unresolved: [
        { kind: "import", filePath: "src/a.ts", line: 12, shape: "import(computed)", reason: "dynamic import with non-literal specifier" },
        { kind: "import", filePath: "src/b.ts", line: 4, shape: "require(variable)", reason: "require target is not a string literal" },
        { kind: "resource", filePath: "src/c.ts", line: 88, shape: "sequelize.query", reason: "sequelize adapter is not built-in", suggestion: "Add 'orders.sequelize.query' to resourceContracts" },
        { kind: "public-surface", filePath: "src/c.ts", line: 102, shape: "export const x: any", reason: "isolated declaration could not infer a public type" },
      ],
    });
    assert.equal(report.schemaVersion, "cellfence.coverage.v1");
    assert.equal(report.summary.totalFiles, 100);
    assert.equal(report.summary.analyzedFiles, 3);
    assert.equal(report.summary.coverage, 0.03);
    assert.equal(report.summary.unresolvedImports, 2);
    assert.equal(report.summary.unresolvedResources, 1);
    assert.equal(report.summary.unresolvedPublicSurface, 1);
    assert.equal(report.findings.length, 4);
    assert.equal(report.findings[2].suggestion, "Add 'orders.sequelize.query' to resourceContracts");
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("runCoverageCommand returns exit 0 when coverage meets the threshold", () => {
  const rootDir = fs.mkdtempSync(path.join(root, ".cellfence-coverage-cmd-"));
  try {
    const result = runCoverageCommand({
      rootDir,
      format: "json",
      failUnder: 0.5,
      unresolved: [],
      analyzedFiles: ["a.ts", "b.ts"],
      totalFiles: 2,
    });
    assert.equal(result.exitCode, 0);
    assert.equal(result.report.summary.coverage, 1);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("runCoverageCommand returns exit 2 when coverage falls under the threshold", () => {
  const rootDir = fs.mkdtempSync(path.join(root, ".cellfence-coverage-threshold-"));
  try {
    const result = runCoverageCommand({
      rootDir,
      format: "json",
      failUnder: 0.95,
      unresolved: [],
      analyzedFiles: ["a.ts"],
      totalFiles: 100,
    });
    assert.equal(result.exitCode, 2);
    assert.equal(result.report.summary.coverage, 0.01);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});
