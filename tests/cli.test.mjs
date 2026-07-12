import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

const root = process.cwd();
const cliPath = path.join(root, "packages/cli/dist/index.js");

function runCli(args, cwd = root) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    cwd,
    encoding: "utf8",
  });
}

function runExecutable(command, args, cwd = root) {
  return spawnSync(command, args, {
    cwd,
    encoding: "utf8",
  });
}

function runGit(args, cwd) {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result;
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function writePrivateImportProject(tempDir, { withWaiver = false, waiverExpires = "2099-01-01" } = {}) {
  fs.mkdirSync(path.join(tempDir, "src/producer"), { recursive: true });
  fs.mkdirSync(path.join(tempDir, "src/consumer"), { recursive: true });
  fs.writeFileSync(path.join(tempDir, "src/producer/public.ts"), "export const exposed = true;\n");
  fs.writeFileSync(path.join(tempDir, "src/producer/internal.ts"), "export const hidden = true;\n");
  const waiverLine = withWaiver
    ? `// cellfence-ignore CELLFENCE_PRIVATE_IMPORT expires:${waiverExpires} approved-by:test-owner reason:temporary test fixture waiver\n`
    : "";
  fs.writeFileSync(path.join(tempDir, "src/consumer/public.ts"), `${waiverLine}import { hidden } from "../producer/internal";\nexport const used = hidden;\n`);
  writeJson(path.join(tempDir, "cellfence.manifest.json"), {
    schemaVersion: "cellfence.manifest.v1",
    cells: [
      {
        id: "producer",
        ownedPaths: ["src/producer/**"],
        publicEntry: "src/producer/public.ts",
        publicSymbols: ["exposed"],
        consumes: [],
        producesArtifacts: [],
      },
      {
        id: "consumer",
        ownedPaths: ["src/consumer/**"],
        publicEntry: "src/consumer/public.ts",
        publicSymbols: ["used"],
        consumes: [{ cell: "producer" }],
        producesArtifacts: [],
      },
    ],
  });
}

test("CLI check returns zero for a valid fixture", () => {
  const fixturePath = path.join(root, "fixtures/valid/single-cell");
  const result = runCli(["check", "--json"], fixturePath);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /"ok": true/);
});

test("CLI check returns one for governance violations", () => {
  const fixturePath = path.join(root, "fixtures/invalid/private-cross-cell-import");
  const result = runCli(["check", "--json"], fixturePath);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /CELLFENCE_PRIVATE_IMPORT/);
});

test("CLI check returns two for manifest configuration errors", () => {
  const fixturePath = path.join(root, "fixtures/invalid/malformed-manifest");
  const result = runCli(["check", "--json"], fixturePath);
  assert.equal(result.status, 2);
  assert.match(result.stdout, /CELLFENCE_MANIFEST_INVALID/);
});

test("CLI evidence check accepts baseline-approved runtime evidence", () => {
  const fixturePath = path.join(root, "fixtures/valid/resource-evidence-baseline");
  const result = runCli(["evidence", "check", "--evidence", "resource-evidence.json", "--json"], fixturePath);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /"ok": true/);
});

test("CLI evidence check rejects new runtime resource evidence", () => {
  const fixturePath = path.join(root, "fixtures/invalid/resource-evidence-detects-new");
  const result = runCli(["evidence", "check", "--evidence", "resource-evidence.json", "--json"], fixturePath);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /CELLFENCE_UNDECLARED_RESOURCE_ACCESS/);
});

test("CLI context returns machine-readable cell fence before editing", () => {
  const fixturePath = path.join(root, "fixtures/valid/public-import");
  const result = runCli(["context", "--cell", "consumer", "--json"], fixturePath);
  assert.equal(result.status, 0);
  const context = JSON.parse(result.stdout);
  assert.equal(context.schemaVersion, "cellfence.context.v1");
  assert.equal(context.cell.id, "consumer");
  assert.deepEqual(context.cell.ownedPaths, ["src/consumer/**"]);
  assert.deepEqual(context.allowedImports, [
    {
      cell: "producer",
      publicEntry: "src/producer/public.ts",
      locked: false,
      artifactLanes: [],
    },
  ]);
  assert.match(context.guidance.join("\n"), /Do not import another cell's internal implementation paths/);
});

test("CLI context can render AGENTS.md-compatible guidance", () => {
  const fixturePath = path.join(root, "fixtures/valid/resource-baseline-allows-existing");
  const result = runCli(["context", "--cell", "runtime", "--format", "agents-md"], fixturePath);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /# CellFence Context: runtime/);
  assert.match(result.stdout, /## Allowed Resources/);
  assert.match(result.stdout, /database:read:app\.users \(baseline\)/);
  assert.match(result.stdout, /publicSurfaceLines: 9\/20, remaining 11, source baseline-ratchet/);
});

test("CLI context auto-allocates a minimal agent editing scope from task text", () => {
  const fixturePath = path.join(root, "fixtures/valid/public-import");
  const result = runCli(["context", "--auto-allocate", "--task", "change consumer behavior", "--json"], fixturePath);
  assert.equal(result.status, 0);
  const allocation = JSON.parse(result.stdout);
  assert.equal(allocation.schemaVersion, "cellfence.auto-allocation.v1");
  assert.deepEqual(allocation.selectedCells, ["consumer"]);
  assert.deepEqual(allocation.contextCells, ["consumer", "producer"]);
  assert.deepEqual(allocation.includePaths, ["src/consumer/**"]);
  assert.deepEqual(allocation.publicEntries, ["src/consumer/public.ts", "src/producer/public.ts"]);
  assert.deepEqual(allocation.budgets, { consumer: {}, producer: {} });
});

test("CLI graph returns a machine-readable coupling graph", () => {
  const fixturePath = path.join(root, "fixtures/valid/public-import");
  const result = runCli(["graph", "--json"], fixturePath);
  assert.equal(result.status, 0);
  const graph = JSON.parse(result.stdout);
  assert.equal(graph.schemaVersion, "cellfence.coupling-graph.v1");
  assert.ok(graph.nodes.some((node) => node.kind === "cell" && node.id === "consumer"));
  assert.ok(graph.edges.some((edge) =>
    edge.from === "consumer"
    && edge.to === "producer"
    && edge.kind === "observed-import"
    && edge.label === "imports"
  ));
});

test("CLI graph renders Mermaid for review dashboards", () => {
  const fixturePath = path.join(root, "fixtures/valid/declared-resource-contracts");
  const result = runCli(["graph", "--format", "mermaid"], fixturePath);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /^flowchart LR/);
  assert.match(result.stdout, /runtime -- "read \(resource-access\)" --> file_data_config_json/);
});

test("CLI waiver request creates an approval-oriented directive without editing source", () => {
  const result = runCli([
    "waivers",
    "request",
    "--rule",
    "CELLFENCE_PRIVATE_IMPORT",
    "--file",
    "src/consumer/public.ts",
    "--line",
    "7",
    "--expires",
    "2099-01-01",
    "--reason",
    "temporary architecture migration while public API is extracted",
    "--approved-by",
    "owner",
    "--json",
  ]);
  assert.equal(result.status, 0);
  const request = JSON.parse(result.stdout);
  assert.equal(request.schemaVersion, "cellfence.waiver-request.v1");
  assert.equal(request.approvalRequired, true);
  assert.equal(request.directive, "// cellfence-ignore CELLFENCE_PRIVATE_IMPORT expires:2099-01-01 approved-by:owner reason:temporary architecture migration while public API is extracted");
  assert.match(request.markdown, /CellFence Waiver Request/);
});

test("CLI check emits suggested resolutions for private imports", () => {
  const fixturePath = path.join(root, "fixtures/invalid/private-cross-cell-import");
  const result = runCli(["check", "--json"], fixturePath);
  assert.equal(result.status, 1);
  const checkResult = JSON.parse(result.stdout);
  const privateImportFinding = checkResult.findings.find((finding) => finding.ruleId === "CELLFENCE_PRIVATE_IMPORT");
  assert.ok(privateImportFinding);
  assert.deepEqual(
    privateImportFinding.suggestedResolutions.map((resolution) => resolution.kind),
    ["change-code", "ask-human"],
  );
  assert.equal(privateImportFinding.suggestedResolutions[0].approvalRequired, false);
  assert.equal(privateImportFinding.suggestedResolutions[1].approvalRequired, true);
  assert.equal(privateImportFinding.suggestedResolutions[0].details.publicEntry, "src/producer/public.ts");
});

test("CLI baseline update refuses to expand locked cell baselines", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-locked-"));
  fs.mkdirSync(path.join(tempDir, "src/core"), { recursive: true });
  fs.writeFileSync(path.join(tempDir, "src/core/public.ts"), "export const a = 1;\nexport const b = 2;\n");
  fs.writeFileSync(path.join(tempDir, "cellfence.manifest.json"), `${JSON.stringify({
    schemaVersion: "cellfence.manifest.v1",
    cells: [
      {
        id: "core",
        locked: true,
        ownedPaths: ["src/core/**"],
        publicEntry: "src/core/public.ts",
        publicSymbols: ["a", "b"],
        consumes: [],
        producesArtifacts: [],
      },
    ],
  }, null, 2)}\n`);
  fs.writeFileSync(path.join(tempDir, "cellfence.baseline.json"), `${JSON.stringify({
    schemaVersion: "cellfence.baseline.v1",
    generatedAt: "2026-01-01T00:00:00.000Z",
    cells: {
      core: {
        ownedPathPatterns: 1,
        publicSymbols: 1,
        publicSurfaceLines: 20,
        crossCellDependencies: 0,
        resourceAccesses: [],
      },
    },
  }, null, 2)}\n`);

  const checkResult = runCli(["baseline", "check", "--json"], tempDir);
  assert.equal(checkResult.status, 1);
  const parsedCheckResult = JSON.parse(checkResult.stdout);
  const ratchetFinding = parsedCheckResult.findings.find((finding) => finding.ruleId === "CELLFENCE_RATCHET_PUBLIC_SYMBOL_GROWTH");
  assert.ok(ratchetFinding);
  const baselineSuggestion = ratchetFinding.suggestedResolutions.find((resolution) => resolution.kind === "update-baseline");
  assert.equal(baselineSuggestion.approvalRequired, true);

  const result = runCli(["baseline", "update"], tempDir);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /CELLFENCE_LOCKED_BASELINE_EXPANSION/);
  const baseline = JSON.parse(fs.readFileSync(path.join(tempDir, "cellfence.baseline.json"), "utf8"));
  assert.equal(baseline.cells.core.publicSymbols, 1);
});

test("CLI accepts a valid line-local CellFence waiver and lists it", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-waiver-valid-"));
  writePrivateImportProject(tempDir, { withWaiver: true });

  const checkResult = runCli(["check", "--json"], tempDir);
  assert.equal(checkResult.status, 0);
  assert.match(checkResult.stdout, /"ok": true/);

  const listResult = runCli(["waivers", "list", "--json"], tempDir);
  assert.equal(listResult.status, 0);
  const parsed = JSON.parse(listResult.stdout);
  assert.equal(parsed.schemaVersion, "cellfence.waivers.v1");
  assert.equal(parsed.waivers.length, 1);
  assert.equal(parsed.waivers[0].ruleId, "CELLFENCE_PRIVATE_IMPORT");
  assert.equal(parsed.waivers[0].valid, true);
});

test("CLI rejects expired CellFence waivers instead of silently suppressing findings", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-waiver-expired-"));
  writePrivateImportProject(tempDir, { withWaiver: true, waiverExpires: "2020-01-01" });

  const result = runCli(["check", "--json"], tempDir);
  assert.equal(result.status, 1);
  const parsed = JSON.parse(result.stdout);
  assert.ok(parsed.findings.some((finding) => finding.ruleId === "CELLFENCE_WAIVER_INVALID"));
  assert.ok(parsed.findings.some((finding) => finding.ruleId === "CELLFENCE_PRIVATE_IMPORT"));
});

test("CLI changed check ignores violations already present at the base commit", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-changed-existing-"));
  writePrivateImportProject(tempDir);
  runGit(["init"], tempDir);
  runGit(["config", "user.email", "cellfence@example.invalid"], tempDir);
  runGit(["config", "user.name", "CellFence Test"], tempDir);
  runGit(["add", "."], tempDir);
  runGit(["commit", "-m", "base"], tempDir);

  const result = runCli(["check", "--changed", "--base", "HEAD", "--json"], tempDir);
  assert.equal(result.status, 0);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.findings, []);
  assert.equal(parsed.baseFindingCount, 1);
});

test("CLI changed check fails on new findings introduced after the base commit", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-changed-new-"));
  fs.mkdirSync(path.join(tempDir, "src/producer"), { recursive: true });
  fs.mkdirSync(path.join(tempDir, "src/consumer"), { recursive: true });
  fs.writeFileSync(path.join(tempDir, "src/producer/public.ts"), "export const exposed = true;\n");
  fs.writeFileSync(path.join(tempDir, "src/producer/internal.ts"), "export const hidden = true;\n");
  fs.writeFileSync(path.join(tempDir, "src/consumer/public.ts"), "import { exposed } from \"../producer/public\";\nexport const used = exposed;\n");
  writeJson(path.join(tempDir, "cellfence.manifest.json"), {
    schemaVersion: "cellfence.manifest.v1",
    cells: [
      {
        id: "producer",
        ownedPaths: ["src/producer/**"],
        publicEntry: "src/producer/public.ts",
        publicSymbols: ["exposed"],
        consumes: [],
        producesArtifacts: [],
      },
      {
        id: "consumer",
        ownedPaths: ["src/consumer/**"],
        publicEntry: "src/consumer/public.ts",
        publicSymbols: ["used"],
        consumes: [{ cell: "producer" }],
        producesArtifacts: [],
      },
    ],
  });
  runGit(["init"], tempDir);
  runGit(["config", "user.email", "cellfence@example.invalid"], tempDir);
  runGit(["config", "user.name", "CellFence Test"], tempDir);
  runGit(["add", "."], tempDir);
  runGit(["commit", "-m", "base"], tempDir);

  fs.writeFileSync(path.join(tempDir, "src/consumer/public.ts"), "import { hidden } from \"../producer/internal\";\nexport const used = hidden;\n");

  const result = runCli(["check", "--changed", "--base", "HEAD", "--json"], tempDir);
  assert.equal(result.status, 1);
  const parsed = JSON.parse(result.stdout);
  assert.deepEqual(parsed.findings.map((finding) => finding.ruleId), ["CELLFENCE_PRIVATE_IMPORT"]);
  assert.deepEqual(parsed.changedFiles, ["src/consumer/public.ts"]);
});

test("CLI changed check fails closed without git metadata", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-changed-nogit-"));
  writePrivateImportProject(tempDir);

  const result = runCli(["check", "--changed", "--base", "HEAD", "--json"], tempDir);
  assert.equal(result.status, 2);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.findings[0].ruleId, "CELLFENCE_GIT_METADATA_UNAVAILABLE");
});

test("CLI baseline create stores runtime evidence inventory", () => {
  const fixturePath = path.join(root, "fixtures/valid/resource-evidence-baseline");
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-evidence-"));
  fs.cpSync(fixturePath, tempDir, { recursive: true });
  fs.rmSync(path.join(tempDir, "cellfence.baseline.json"));

  const result = runCli(["baseline", "create", "--evidence", "resource-evidence.json"], tempDir);
  assert.equal(result.status, 0);

  const baseline = JSON.parse(fs.readFileSync(path.join(tempDir, "cellfence.baseline.json"), "utf8"));
  assert.deepEqual(baseline.cells.runtime.resourceAccesses, [
    {
      kind: "database",
      access: "read",
      selector: "runtime.orders",
      detectedBy: "runtime-evidence",
      confidence: "runtime",
    },
  ]);
});

test("CLI baseline create stores Prisma delegate inventory", () => {
  const fixturePath = path.join(root, "fixtures/valid/prisma-resource-baseline");
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-prisma-"));
  fs.cpSync(fixturePath, tempDir, { recursive: true });
  fs.rmSync(path.join(tempDir, "cellfence.baseline.json"));

  const result = runCli(["baseline", "create"], tempDir);
  assert.equal(result.status, 0);

  const baseline = JSON.parse(fs.readFileSync(path.join(tempDir, "cellfence.baseline.json"), "utf8"));
  assert.deepEqual(baseline.cells.runtime.resourceAccesses, [
    {
      kind: "database",
      access: "read",
      selector: "app_users",
      detectedBy: "prisma-adapter",
      confidence: "high",
    },
    {
      kind: "database",
      access: "write",
      selector: "app_users",
      detectedBy: "prisma-adapter",
      confidence: "high",
    },
  ]);
});

test("CLI baseline create stores BullMQ and KafkaJS inventory", () => {
  const fixturePath = path.join(root, "fixtures/valid/event-adapters-declared");
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-events-"));
  fs.cpSync(fixturePath, tempDir, { recursive: true });

  const result = runCli(["baseline", "create"], tempDir);
  assert.equal(result.status, 0);

  const baseline = JSON.parse(fs.readFileSync(path.join(tempDir, "cellfence.baseline.json"), "utf8"));
  assert.deepEqual(baseline.cells.runtime.resourceAccesses, [
    {
      kind: "queue",
      access: "publish",
      selector: "bullmq:nightly-research",
      detectedBy: "bullmq-adapter",
      confidence: "high",
    },
    {
      kind: "queue",
      access: "publish",
      selector: "kafka:research.events",
      detectedBy: "kafkajs-adapter",
      confidence: "medium",
    },
    {
      kind: "queue",
      access: "subscribe",
      selector: "bullmq:nightly-research",
      detectedBy: "bullmq-adapter",
      confidence: "high",
    },
    {
      kind: "queue",
      access: "subscribe",
      selector: "kafka:research.events",
      detectedBy: "kafkajs-adapter",
      confidence: "medium",
    },
  ]);
});

test("CLI exits nonzero when executed through a node_modules bin symlink", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-bin-"));
  const binDir = path.join(tempDir, "node_modules/.bin");
  fs.mkdirSync(binDir, { recursive: true });
  const binPath = path.join(binDir, "cellfence");
  fs.symlinkSync(cliPath, binPath);

  const fixturePath = path.join(root, "fixtures/invalid/private-cross-cell-import");
  const result = runExecutable(process.execPath, [binPath, "check", "--json"], fixturePath);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /CELLFENCE_PRIVATE_IMPORT/);
});

test("CLI package import has no command execution side effect", () => {
  const result = spawnSync(process.execPath, [
    "--input-type=module",
    "-e",
    `import ${JSON.stringify(pathToFileURL(cliPath).href)}; console.log("import-ok");`,
  ], {
    cwd: root,
    encoding: "utf8",
  });
  assert.equal(result.status, 0);
  assert.equal(result.stdout.trim(), "import-ok");
  assert.equal(result.stderr.trim(), "");
});
