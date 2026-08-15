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

test("runCoverageCommand coverage is not inflated by irrelevant diagnostics", () => {
  const dir = fs.mkdtempSync(path.join(root, ".cellfence-coverage-diagnostics-"));
  try {
    fs.mkdirSync(path.join(dir, "src/core"), { recursive: true });
    fs.mkdirSync(path.join(dir, "src/app"), { recursive: true });
    fs.writeFileSync(path.join(dir, "src/core/public.ts"), "export const exposed = true;\n");
    fs.writeFileSync(path.join(dir, "src/core/private.ts"), "export const secret = true;\n");
    fs.writeFileSync(path.join(dir, "src/app/public.ts"), "import { secret } from '../core/private';\nexport const app = secret;\n");
    fs.writeFileSync(path.join(dir, "cellfence.manifest.json"), `${JSON.stringify({
      schemaVersion: "cellfence.manifest.v1",
      cells: [{
        id: "core",
        ownedPaths: ["src/core/**"],
        publicEntry: "src/core/public.ts",
        publicSymbols: ["exposed"],
        consumes: [],
        producesArtifacts: [],
      }, {
        id: "app",
        ownedPaths: ["src/app/**"],
        publicEntry: "src/app/public.ts",
        publicSymbols: ["app"],
        consumes: [{ cell: "core" }],
        producesArtifacts: [],
      }],
    }, null, 2)}\n`);
    const base = runCoverageCommand({
      rootDir: dir,
      format: "json",
      check: {},
    });
    const noisyPlugin = {
      apiVersion: 1,
      name: "@cellfence/test-coverage-noise",
      version: "1.0.0",
      rules: {
        "test/noise": {
          meta: {
            description: "emits irrelevant warnings",
            defaultSeverity: "warning",
            category: "test",
          },
          run() {
            return Array.from({ length: 90 }, (_, index) => ({
              ruleId: "test/noise",
              severity: "warning",
              filePath: "src/app/public.ts",
              message: `irrelevant diagnostic ${index}`,
            }));
          },
        },
      },
    };
    const noisy = runCoverageCommand({
      rootDir: dir,
      format: "json",
      check: { plugins: [noisyPlugin] },
    });
    assert.equal(base.report.summary.totalFiles, 3);
    assert.equal(base.report.summary.analyzedFiles, 2);
    assert.equal(noisy.report.summary.totalFiles, base.report.summary.totalFiles);
    assert.equal(noisy.report.summary.analyzedFiles, base.report.summary.analyzedFiles);
    assert.equal(noisy.report.summary.coverage, base.report.summary.coverage);
    assert.equal(noisy.report.summary.unresolvedImports, base.report.summary.unresolvedImports);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
