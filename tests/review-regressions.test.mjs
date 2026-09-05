import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

import {
  checkCommitEvidence,
  checkMutationReport,
  checkRepository,
  checkTaskManifest,
  detectBaselineChanges,
  emptyClaimStoreState,
  LocalFileClaimStore,
} from "../packages/engine/dist/index.js";
import {
  publicSurfaceHash,
  resolvePackageImportsTarget,
  resolvePathAliasTarget,
} from "../packages/engine/dist/module-resolution.js";
import { inspectPythonSource } from "../packages/engine/dist/python-analysis.js";
import { runCoverageCommand } from "../packages/cli/dist/coverage-command.js";
import { pathsForToolCall, parseProxyArgs } from "../packages/mcp-proxy/dist/index.js";
import { openTelemetryToResourceEvidence } from "../packages/adapter-opentelemetry/dist/index.js";

const repoRoot = process.cwd();
const cliPath = path.join(repoRoot, "packages/cli/dist/index.js");

function writeFile(filePath, contents) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${Array.isArray(contents) ? contents.join("\n") : contents}`.replace(/\n?$/, "\n"));
}

function writeJson(filePath, value) {
  writeFile(filePath, JSON.stringify(value, null, 2));
}

function manifest(cells) {
  return {
    schemaVersion: "cellfence.manifest.v1",
    governance: {
      requireOwnership: true,
      include: ["src/**"],
      exclude: [],
    },
    cells,
  };
}

function cell(id, patch = {}) {
  return {
    id,
    ownedPaths: [`src/${id}/**`],
    publicEntry: `src/${id}/public.ts`,
    publicSymbols: [id === "producer" ? "exposed" : "consumerValue"],
    consumes: [],
    producesArtifacts: [],
    ...patch,
  };
}

function git(rootDir, args) {
  const result = spawnSync("git", args, { cwd: rootDir, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout.trim();
}

function initGit(rootDir) {
  git(rootDir, ["init", "-q", "-b", "main"]);
  git(rootDir, ["config", "user.email", "cellfence@example.invalid"]);
  git(rootDir, ["config", "user.name", "CellFence Test"]);
}

function makeBaseline(overrides = {}) {
  return {
    schemaVersion: "cellfence.baseline.v1",
    generatedAt: "2026-01-01T00:00:00.000Z",
    cellIds: ["core"],
    cells: {
      core: {
        ownedPathPatterns: 1,
        publicSymbols: 1,
        publicSurfaceLines: 1,
        crossCellDependencies: 0,
        ownedPathSet: ["src/core/**"],
        publicSymbolSet: ["run"],
        dependencyEdges: [],
        resourceAccesses: [],
        artifactContracts: [],
        externalDependencySet: [],
      },
    },
    ...overrides,
  };
}

test("review CF-01: init does not overwrite an existing example cell", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-review-init-"));
  try {
    writeFile(path.join(rootDir, "src/example/public.ts"), "export const precious = 'KEEP';");
    const result = spawnSync(process.execPath, [cliPath, "--root", rootDir, "init"], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(fs.readFileSync(path.join(rootDir, "src/example/public.ts"), "utf8"), "export const precious = 'KEEP';\n");
    const generated = JSON.parse(fs.readFileSync(path.join(rootDir, "cellfence.manifest.json"), "utf8"));
    assert.deepEqual(generated.cells[0].publicSymbols, ["precious"]);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("review CF-02: imports in function parameters, type positions, and binding defaults are extracted", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-review-import-positions-"));
  try {
    writeFile(path.join(rootDir, "src/producer/public.ts"), "export const exposed = true;");
    writeFile(path.join(rootDir, "src/producer/internal.ts"), "export type SecretType = { secret: true };\nexport const secret = 42;");
    writeFile(path.join(rootDir, "src/consumer/public.ts"), [
      "export const consumerValue = true;",
      "export function withDefault(value = import('../producer/internal.js')) { return value; }",
      "export type UsesSecret = import('../producer/internal.js').SecretType;",
      "const { value = import('../producer/internal.js') } = {};",
    ]);
    writeJson(path.join(rootDir, "cellfence.manifest.json"), manifest([
      cell("producer"),
      cell("consumer", { consumes: [{ cell: "producer" }] }),
    ]));
    const result = checkRepository({ rootDir, manifestPath: "cellfence.manifest.json" });
    const privateFindings = result.findings.filter((finding) => finding.ruleId === "CELLFENCE_PRIVATE_IMPORT");
    assert.equal(privateFindings.length >= 3, true, JSON.stringify(result.findings, null, 2));
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("review CF-03: @internal removal does not erase the preceding public declaration", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-review-internal-"));
  try {
    const publicPath = path.join(rootDir, "public.ts");
    writeFile(publicPath, [
      "export function run(value: string): string { return value; }",
      "/** @internal */",
      "export const hidden = true;",
    ]);
    const before = publicSurfaceHash(publicPath);
    writeFile(publicPath, [
      "export function run(value: number): number { return value; }",
      "/** @internal */",
      "export const hidden = true;",
    ]);
    assert.notEqual(publicSurfaceHash(publicPath), before);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("review CF-04: Python __all__ preserves public signature material", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-review-python-all-"));
  try {
    const publicPath = path.join(rootDir, "public.py");
    writeFile(publicPath, [
      "__all__ = ['run']",
      "def run(x):",
      "    return x",
    ]);
    const before = inspectPythonSource(publicPath).surfaceParts;
    assert.equal(before.includes("py:function:run(x)"), true);
    writeFile(publicPath, [
      "__all__ = ['run']",
      "def run(x, y):",
      "    return x + y",
    ]);
    assert.notDeepEqual(inspectPythonSource(publicPath).surfaceParts, before);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("review CF-05 and CF-06: resolution follows specific paths and package condition order", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-review-resolution-"));
  try {
    writeFile(path.join(rootDir, "src/consumer/private.ts"), "export const safe = true;");
    writeFile(path.join(rootDir, "src/producer/private.ts"), "export const secret = true;");
    assert.equal(resolvePathAliasTarget({
      rootDir,
      pathAliases: [
        { pattern: "@app/*", targets: [path.join(rootDir, "src/consumer/*")] },
        { pattern: "@app/private", targets: [path.join(rootDir, "src/producer/private.ts")] },
      ],
    }, "@app/private"), "src/producer/private.ts");

    const packageRoot = path.join(rootDir, "pkg");
    writeFile(path.join(packageRoot, "src/private.ts"), "export const secret = true;");
    writeFile(path.join(packageRoot, "src/safe.ts"), "export const safe = true;");
    writeFile(path.join(packageRoot, "src/importer.ts"), "export const importer = true;");
    writeJson(path.join(packageRoot, "package.json"), {
      imports: {
        "#selected": {
          node: "./src/private.js",
          import: "./src/safe.js",
          default: "./src/safe.js",
        },
      },
    });
    assert.equal(resolvePackageImportsTarget(rootDir, "pkg/src/importer.ts", "#selected", "import"), "pkg/src/private.ts");
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("review CF-07: repo-local file URL imports are treated as local source imports", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-review-file-url-"));
  try {
    writeFile(path.join(rootDir, "src/producer/public.ts"), "export const exposed = true;");
    writeFile(path.join(rootDir, "src/producer/internal.ts"), "export const secret = 42;");
    const fileUrl = pathToFileURL(path.join(rootDir, "src/producer/internal.ts")).href;
    writeFile(path.join(rootDir, "src/consumer/public.ts"), `import { secret } from ${JSON.stringify(fileUrl)};\nexport const consumerValue = secret;`);
    writeJson(path.join(rootDir, "cellfence.manifest.json"), manifest([
      cell("producer"),
      cell("consumer", { consumes: [{ cell: "producer" }] }),
    ]));
    const result = checkRepository({ rootDir, manifestPath: "cellfence.manifest.json" });
    assert.equal(result.findings.some((finding) => finding.ruleId === "CELLFENCE_PRIVATE_IMPORT"), true, JSON.stringify(result.findings, null, 2));
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("review CF-08 through CF-10: SQL and fs operations fail closed for writes and quoted selectors", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-review-resources-"));
  try {
    writeFile(path.join(rootDir, "src/app/public.ts"), [
      "import { openSync } from 'node:fs';",
      "declare const db: { query(sql: string): void };",
      "db.query('DELETE FROM users WHERE id = 1');",
      "db.query('SELECT * FROM \"secret_users\"');",
      "openSync('data/a.txt', 577);",
      "export const app = true;",
    ]);
    writeJson(path.join(rootDir, "cellfence.manifest.json"), manifest([
      cell("app", {
        publicSymbols: ["app"],
        resourceContracts: [
          { id: "users-read", kind: "database", access: ["read"], selectors: ["users"] },
          { id: "data-read", kind: "file", access: ["read"], selectors: ["data/a.txt"] },
        ],
      }),
    ]));
    const result = checkRepository({ rootDir, manifestPath: "cellfence.manifest.json" });
    const simplified = result.findings.map((finding) => ({
      ruleId: finding.ruleId,
      kind: finding.details?.kind,
      access: finding.details?.access,
      selector: finding.details?.selector,
    }));
    assert.equal(simplified.some((finding) => finding.kind === "database" && finding.access === "write" && finding.selector === "users"), true, JSON.stringify(simplified));
    assert.equal(simplified.some((finding) => finding.kind === "database" && finding.access === "read" && finding.selector === "secret_users"), true, JSON.stringify(simplified));
    assert.equal(simplified.some((finding) => finding.kind === "file" && finding.access === "write" && finding.selector === "data/a.txt"), true, JSON.stringify(simplified));
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("review CF-11 and CF-12: task and mutation checks see staged/deleted files and official Stryker reports", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-review-advanced-"));
  try {
    initGit(rootDir);
    writeFile(path.join(rootDir, "src/deleted.ts"), "export const gone = true;");
    writeFile(path.join(rootDir, "src/core/a.ts"), "export const value = true;");
    writeJson(path.join(rootDir, "task.json"), { allowedWritePaths: ["src/allowed/**"], requiredGates: ["test"] });
    git(rootDir, ["add", "."]);
    git(rootDir, ["commit", "-qm", "initial"]);
    fs.rmSync(path.join(rootDir, "src/deleted.ts"));
    writeFile(path.join(rootDir, "src/staged.ts"), "export const staged = true;");
    git(rootDir, ["add", "src/staged.ts"]);

    const taskResult = checkTaskManifest({ rootDir, taskPath: "task.json" });
    assert.deepEqual(taskResult.changedFiles, ["src/deleted.ts", "src/staged.ts"]);

    writeJson(path.join(rootDir, "stryker-report.json"), {
      schemaVersion: "1.0",
      files: {
        "src/core/a.ts": {
          source: "export const value = true;",
          mutants: [{ id: "1", status: "Survived" }],
        },
      },
    });
    const mutationResult = checkMutationReport({
      rootDir,
      reportPath: "stryker-report.json",
      minScore: 100,
      manifest: manifest([cell("core", { publicSymbols: ["value"] })]),
    });
    assert.equal(mutationResult.ok, false);
    assert.equal(mutationResult.cells.core.survived, 1);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("review CF-22: deleted test files do not crash commit evidence checks", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-review-deleted-test-"));
  try {
    initGit(rootDir);
    writeFile(path.join(rootDir, "tests/core.test.ts"), "test('works', () => {});");
    writeFile(path.join(rootDir, "src/core/public.ts"), "export const run = true;");
    git(rootDir, ["add", "."]);
    git(rootDir, ["commit", "-qm", "initial"]);
    fs.rmSync(path.join(rootDir, "tests/core.test.ts"));
    git(rootDir, ["add", "."]);
    git(rootDir, ["commit", "-qm", [
      "remove obsolete test",
      "",
      "Problem:",
      "An obsolete test file no longer matches current fixtures.",
      "Change:",
      "Remove the obsolete test file from the suite.",
      "Behavior:",
      "Runtime behavior is unchanged by this test-only update.",
      "Tests:",
      "The removed file is declared in the test evidence trailer.",
      "Known-Gaps:",
      "No additional known gaps.",
      "",
      "Change-Type: test-maintenance",
      "Changed-Cells: none",
      "Tests-Added: none",
      "Tests-Modified: tests/core.test.ts",
      "Test-Impact: removes obsolete test coverage",
      "Tests-Not-Added-Reason: test-only deletion",
      "Agent-Run-Id: review-regression-run",
      "Agent-Task-Id: review-regression-task",
    ].join("\n")]);
    const evidence = checkCommitEvidence({
      rootDir,
      manifest: manifest([cell("core", { publicSymbols: ["run"] })]),
      commit: "HEAD",
    });
    assert.equal(evidence.ok, true, JSON.stringify(evidence.findings, null, 2));
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("review CF-15 through CF-17: runtime adapters preserve evidence semantics", () => {
  const evidence = openTelemetryToResourceEvidence({
    name: "DROP users",
    attributes: {
      "db.system": "postgresql",
      "db.operation": "DROP",
      "db.sql.table": "users",
      "cellfence.cell": "api",
    },
  }, {
    commitSha: "abc123",
    generatedAt: "2026-01-01T00:00:00.000Z",
  });
  assert.equal(evidence.transcriptStatus, "active");
  assert.equal(evidence.accesses[0].access, "write");

  const parsed = parseProxyArgs([
    "--agent", "agent",
    "--downstream-command", "node",
    "--write-tool", "Edit=edits[].path",
  ]);
  assert.deepEqual(pathsForToolCall("Edit", {
    file_path: "src/owned.ts",
    edits: [{ path: "src/other.ts" }],
  }, parsed.writeTools), ["src/other.ts"]);
});

test("review CF-20, CF-21, CF-23 through CF-25: governance metadata and recovery edge cases are explicit", () => {
  const baseBaseline = makeBaseline();
  const headBaseline = makeBaseline();
  headBaseline.cells.core.ownedPathPatterns = 999;
  const baselineReport = detectBaselineChanges(baseBaseline, headBaseline, "base.json", "head.json");
  assert.deepEqual(baselineReport.deltas.find((delta) => delta.dimension === "ownedPaths")?.added, ["core: ownedPathPatterns=999"]);

  const coverageRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-review-coverage-"));
  try {
    writeFile(path.join(coverageRoot, "src/core/public.ts"), "export const run = true;");
    writeJson(path.join(coverageRoot, "cellfence.manifest.json"), manifest([cell("core", { publicSymbols: ["run"] })]));
    const coverage = runCoverageCommand({
      rootDir: coverageRoot,
      format: "json",
      failUnder: 1,
      check: { baselinePath: "missing-baseline.json" },
    });
    assert.equal(coverage.exitCode, 1);
    assert.equal(coverage.report.findings.some((finding) => finding.shape === "configuration"), true);
  } finally {
    fs.rmSync(coverageRoot, { recursive: true, force: true });
  }

  const commitRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-review-commit-"));
  try {
    initGit(commitRoot);
    writeFile(path.join(commitRoot, "docs/readme.md"), "hello");
    git(commitRoot, ["add", "."]);
    git(commitRoot, ["commit", "-qm", "initial"]);
    writeFile(path.join(commitRoot, "docs/readme.md"), "hello again");
    git(commitRoot, ["add", "."]);
    git(commitRoot, ["commit", "-qm", [
      "docs only",
      "",
      "Problem:",
      "Document context needed.",
      "Change:",
      "Update the documentation text.",
      "Behavior:",
      "Runtime behavior is unchanged.",
      "Tests:",
      "No executable code changed.",
      "Known-Gaps:",
      "No additional known gaps.",
      "",
      "Change-Type: documentation",
      "Changed-Cells: none",
      "Tests-Added: none",
      "Tests-Modified: none",
      "Test-Impact: documentation-only change",
      "Tests-Not-Added-Reason: documentation-only change",
      "Agent-Run-Id: review-regression-run",
      "Agent-Task-Id: review-regression-task",
    ].join("\n")]);
    const evidence = checkCommitEvidence({ rootDir: commitRoot, manifest: manifest([cell("core", { publicSymbols: ["run"] })]), commit: "HEAD" });
    assert.equal(evidence.findings.some((finding) => finding.ruleId === "CELLFENCE_COMMIT_TRAILER_MISSING"), false, JSON.stringify(evidence.findings, null, 2));
  } finally {
    fs.rmSync(commitRoot, { recursive: true, force: true });
  }

  const claimRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-review-claims-"));
  try {
    const claimPath = path.join(claimRoot, ".cellfence/claims.json");
    fs.mkdirSync(path.dirname(claimPath), { recursive: true });
    fs.writeFileSync(`${claimPath}.local-file-write.lock`, "99999999\n1970-01-01T00:00:00.000Z\n");
    const store = new LocalFileClaimStore({ filePath: claimPath });
    const previous = store.read();
    store.write(emptyClaimStoreState(), previous);
    assert.equal(fs.existsSync(`${claimPath}.local-file-write.lock`), false);
  } finally {
    fs.rmSync(claimRoot, { recursive: true, force: true });
  }

  const pythonRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-review-python-stdlib-"));
  try {
    writeFile(path.join(pythonRoot, "src/core/public.py"), [
      "import random",
      "import socket",
      "import email",
      "import json",
      "run = 1",
    ]);
    writeJson(path.join(pythonRoot, "cellfence.manifest.json"), {
      ...manifest([{
        ...cell("core", { publicEntry: "src/core/public.py", publicSymbols: ["run"] }),
      }]),
      baseline: makeBaseline(),
    });
    const result = checkRepository({ rootDir: pythonRoot, manifestPath: "cellfence.manifest.json" });
    assert.equal(result.findings.some((finding) => finding.ruleId === "CELLFENCE_RATCHET_EXTERNAL_DEPENDENCY_ADDED"), false, JSON.stringify(result.findings, null, 2));
  } finally {
    fs.rmSync(pythonRoot, { recursive: true, force: true });
  }
});
