import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { runCoverageCommand } from "../packages/cli/dist/coverage-command.js";
import { buildCoverageReport } from "../packages/engine/dist/index.js";

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

test("runCoverageCommand returns exit 0 when no observations are unresolved", () => {
  const dir = fs.mkdtempSync(path.join(root, ".cellfence-coverage-empty-"));
  try {
    const { report, exitCode } = runCoverageCommand({
      rootDir: dir,
      format: "json",
      failUnder: 0.5,
      check: {},
    });
    assert.equal(report.schemaVersion, "cellfence.coverage.v1");
    assert.equal(typeof report.summary.coverage, "number");
    assert.equal(exitCode, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("runCoverageCommand writes JSON to the requested output path", () => {
  const dir = fs.mkdtempSync(path.join(root, ".cellfence-coverage-output-"));
  try {
    const outputPath = path.join(dir, "coverage.json");
    const { report } = runCoverageCommand({
      rootDir: dir,
      format: "json",
      outputPath,
      check: {},
    });
    assert.ok(fs.existsSync(outputPath));
    const onDisk = JSON.parse(fs.readFileSync(outputPath, "utf8"));
    assert.equal(onDisk.schemaVersion, report.schemaVersion);
    assert.deepEqual(onDisk.findings, report.findings);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
