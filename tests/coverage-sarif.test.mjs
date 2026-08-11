import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { runCoverageCommand } from "../packages/cli/dist/coverage-command.js";
import { coverageReportToSarif } from "../packages/cli/dist/coverage-sarif.js";
import { buildCoverageReport } from "../packages/engine/dist/index.js";

const root = process.cwd();

test("coverageReportToSarif emits a SARIF 2.1.0 log with one result per observation", () => {
  const rootDir = fs.mkdtempSync(path.join(root, ".cellfence-sarif-"));
  try {
    const report = buildCoverageReport({
      rootDir,
      totalFiles: 4,
      analyzedFiles: ["a.ts", "b.ts", "c.ts", "d.ts"],
      unresolved: [
        { kind: "import", filePath: "a.ts", line: 7, shape: "import(variable)", reason: "dynamic import specifier is not a string literal" },
        { kind: "resource", filePath: "b.ts", line: 42, shape: "sequelize.query", reason: "no built-in adapter for sequelize" },
        { kind: "public-surface", filePath: "c.ts", line: 1, shape: "export const x: any", reason: "isolated declaration could not infer a public type" },
      ],
    });
    const sarif = coverageReportToSarif(report);
    assert.equal(sarif.version, "2.1.0");
    assert.equal(sarif.runs.length, 1);
    assert.equal(sarif.runs[0].tool.driver.name, "cellfence-coverage");
    assert.equal(sarif.runs[0].results.length, 3);
    const ruleIds = sarif.runs[0].results.map((result) => result.ruleId);
    assert.ok(ruleIds.includes("CELLFENCE_COVERAGE_IMPORT"));
    assert.ok(ruleIds.includes("CELLFENCE_COVERAGE_RESOURCE"));
    assert.ok(ruleIds.includes("CELLFENCE_COVERAGE_PUBLIC_SURFACE"));
    const firstResult = sarif.runs[0].results[0];
    assert.equal(firstResult.locations[0].physicalLocation.artifactLocation.uri, "a.ts");
    assert.equal(firstResult.locations[0].physicalLocation.region.startLine, 7);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("runCoverageCommand supports --format sarif and writes SARIF JSON", () => {
  const dir = fs.mkdtempSync(path.join(root, ".cellfence-sarif-cmd-"));
  try {
    const { exitCode, report } = runCoverageCommand({
      rootDir: dir,
      format: "sarif",
      check: {},
    });
    assert.equal(exitCode, 0);
    assert.equal(report.schemaVersion, "cellfence.coverage.v1");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
