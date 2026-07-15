import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import { main } from "../packages/cli/dist/index.js";

const root = process.cwd();
const cliPath = path.join(root, "packages/cli/dist/index.js");

function runCli(args, cwd = root) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    cwd,
    encoding: "utf8",
  });
}

function runCliWithEnv(args, cwd, envPatch) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      ...envPatch,
    },
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

function writeClaimProject(tempDir) {
  fs.mkdirSync(path.join(tempDir, "src/billing"), { recursive: true });
  fs.mkdirSync(path.join(tempDir, "src/reporting"), { recursive: true });
  fs.writeFileSync(path.join(tempDir, "src/billing/public.ts"), "export const invoice = true;\n");
  fs.writeFileSync(path.join(tempDir, "src/reporting/public.ts"), "export const report = true;\n");
  writeJson(path.join(tempDir, "cellfence.manifest.json"), {
    schemaVersion: "cellfence.manifest.v1",
    governance: {
      requireOwnership: true,
      include: ["src/**"],
      exclude: [],
    },
    cells: [
      {
        id: "billing",
        ownedPaths: ["src/billing/**"],
        publicEntry: "src/billing/public.ts",
        publicSymbols: ["invoice"],
        consumes: [],
        producesArtifacts: [],
      },
      {
        id: "reporting",
        ownedPaths: ["src/reporting/**"],
        publicEntry: "src/reporting/public.ts",
        publicSymbols: ["report"],
        consumes: [],
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

test("CLI context agent markdown lists allowed imports and resource contracts", () => {
  const importFixture = path.join(root, "fixtures/valid/public-import");
  const importResult = runCli(["context", "--cell", "consumer", "--format", "agents-md"], importFixture);
  assert.equal(importResult.status, 0);
  assert.match(importResult.stdout, /producer: src\/producer\/public\.ts/);

  const resourceFixture = path.join(root, "fixtures/valid/declared-resource-contracts");
  const resourceResult = runCli(["context", "--cell", "runtime", "--format", "agents-md"], resourceFixture);
  assert.equal(resourceResult.status, 0);
  assert.match(resourceResult.stdout, /database:read:app\.users/);
});

test("CLI context agent markdown renders package, lane, and lock metadata", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-context-metadata-"));
  try {
    fs.mkdirSync(path.join(tempDir, "src/producer"), { recursive: true });
    fs.mkdirSync(path.join(tempDir, "src/consumer"), { recursive: true });
    fs.writeFileSync(path.join(tempDir, "src/producer/public.ts"), "export const producerApi = true;\n");
    fs.writeFileSync(path.join(tempDir, "src/consumer/public.ts"), "export const consumerApi = true;\n");
    writeJson(path.join(tempDir, "cellfence.manifest.json"), {
      schemaVersion: "cellfence.manifest.v1",
      cells: [{
        id: "producer",
        locked: true,
        packageName: "@example/producer",
        ownedPaths: ["src/producer/**"],
        publicEntry: "src/producer/public.ts",
        publicSymbols: ["producerApi"],
        consumes: [],
        producesArtifacts: [{ id: "events-v1", paths: ["src/producer/events/**"] }],
      }, {
        id: "consumer",
        locked: true,
        packageName: "@example/consumer",
        ownedPaths: ["src/consumer/**"],
        publicEntry: "src/consumer/public.ts",
        publicSymbols: ["consumerApi"],
        consumes: [{ cell: "producer", artifactLanes: ["events-v1"] }],
        producesArtifacts: [],
      }],
    });

    const result = runCli(["context", "--cell=consumer", "--format=agents-md"], tempDir);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /packageName: @example\/consumer/);
    assert.match(result.stdout, /locked: true/);
    assert.match(result.stdout, /producer: src\/producer\/public\.ts or @example\/producer; artifact lanes: events-v1; locked/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("CLI context renders empty budget guidance for cells without ratchet budgets", () => {
  const fixturePath = path.join(root, "fixtures/valid/single-cell");
  const result = runCli(["context", "--cell=core", "--format=agents-md"], fixturePath);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /## Budget\n- \(none\)/);
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

test("CLI context auto-allocation includes resource contract and baseline selectors", () => {
  const fixturePath = path.join(root, "fixtures/valid/resource-baseline-allows-existing");
  const result = runCli(["context", "--auto-allocate", "--task", "runtime resource work", "--json"], fixturePath);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const allocation = JSON.parse(result.stdout);
  assert.deepEqual(allocation.selectedCells, ["runtime"]);
  assert.deepEqual(allocation.resourceSelectors, [
    "database:read:app.users",
    "file:read:data/config.json",
  ]);
});

test("CLI context auto-allocation renders agent markdown for empty task scopes", () => {
  const fixturePath = path.join(root, "fixtures/valid/public-import");
  const result = runCli(["context", "--auto-allocate", "--format=agents-md"], fixturePath);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /# CellFence Auto Allocation/);
  assert.match(result.stdout, /## Task\n\(none\)/);
  assert.match(result.stdout, /## Selected Cells\n- \(none\)/);
  assert.match(result.stdout, /## Budgets\n- \(none\)/);
});

test("CLI context auto-allocation agent markdown lists budget entries", () => {
  const fixturePath = path.join(root, "fixtures/valid/resource-baseline-allows-existing");
  const result = runCli(["context", "--auto-allocate", "--task", "runtime", "--format", "agents-md"], fixturePath);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /runtime\.publicSurfaceLines: 9\/20, remaining 11, source baseline-ratchet/);
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

test("CLI rejects unsupported context and graph formats", () => {
  const fixturePath = path.join(root, "fixtures/valid/public-import");
  const auto = runCli(["context", "--auto-allocate", "--format=json"], fixturePath);
  assert.equal(auto.status, 2);
  assert.match(auto.stderr, /auto-allocate supports --format agents-md/);

  const context = runCli(["context", "--cell=consumer", "--format=json"], fixturePath);
  assert.equal(context.status, 2);
  assert.match(context.stderr, /context supports --format agents-md/);

  const missingCell = runCli(["context"], fixturePath);
  assert.equal(missingCell.status, 2);
  assert.match(missingCell.stderr, /requires --cell/);

  const graph = runCli(["graph", "--format=json"], fixturePath);
  assert.equal(graph.status, 2);
  assert.match(graph.stderr, /graph supports --format mermaid/);
});

test("CLI claim create writes an active lease before editing", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-claim-create-"));
  writeClaimProject(tempDir);
  const result = runCli([
    "claim",
    "create",
    "--agent",
    "codex-a",
    "--cell",
    "billing",
    "--path",
    "src/billing/**",
    "--ttl",
    "2h",
    "--json",
  ], tempDir);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.schemaVersion, "cellfence.claim-check.v1");
  assert.equal(parsed.createdClaim.agent, "codex-a");
  assert.deepEqual(parsed.createdClaim.cells, ["billing"]);
  const store = JSON.parse(fs.readFileSync(path.join(tempDir, ".cellfence/claims.json"), "utf8"));
  assert.equal(store.schemaVersion, "cellfence.claims.v1");
  assert.equal(store.claims.length, 1);
});

test("CLI claim create rejects an active same-cell conflict", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-claim-conflict-"));
  writeClaimProject(tempDir);
  const first = runCli(["claim", "create", "--agent", "codex-a", "--cell", "billing", "--ttl", "2h"], tempDir);
  assert.equal(first.status, 0, first.stderr || first.stdout);
  const second = runCli(["claim", "create", "--agent", "codex-b", "--cell", "billing", "--ttl", "2h", "--json"], tempDir);
  assert.equal(second.status, 1);
  const parsed = JSON.parse(second.stdout);
  assert.ok(parsed.findings.some((finding) => finding.ruleId === "CELLFENCE_ACTIVE_CLAIM_CONFLICT"));
  assert.equal(JSON.parse(fs.readFileSync(path.join(tempDir, ".cellfence/claims.json"), "utf8")).claims.length, 1);
});

test("CLI claim commands render human output and reject missing agent ids", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-claim-human-"));
  writeClaimProject(tempDir);

  const missingAgent = runCli(["claim", "create", "--cell=reporting"], tempDir);
  assert.equal(missingAgent.status, 2);
  assert.match(missingAgent.stderr, /requires --agent/);

  const emptyList = runCli(["claim", "list"], tempDir);
  assert.equal(emptyList.status, 0);
  assert.match(emptyList.stdout, /No CellFence claims found/);

  const create = runCli(["claim", "create", "--agent=codex-a", "--cell=reporting", "--path=src/reporting/**", "--ttl=2h"], tempDir);
  assert.equal(create.status, 0, create.stderr || create.stdout);
  assert.match(create.stdout, /Created claim:/);

  const list = runCli(["claim", "list"], tempDir);
  assert.equal(list.status, 0);
  assert.match(list.stdout, /active .* agent:codex-a cells:reporting/);

  const jsonList = runCli(["claim", "list", "--json"], tempDir);
  assert.equal(jsonList.status, 0);
  const parsed = JSON.parse(jsonList.stdout);
  assert.equal(parsed.schemaVersion, "cellfence.claims.v1");
  assert.equal(parsed.claims.length, 1);
});

test("CLI claim list renders expired claims with empty cell lists", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-claim-expired-"));
  writeClaimProject(tempDir);
  fs.mkdirSync(path.join(tempDir, ".cellfence"), { recursive: true });
  writeJson(path.join(tempDir, ".cellfence/claims.json"), {
    schemaVersion: "cellfence.claims.v1",
    claims: [{
      id: "expired-empty",
      agent: "codex-old",
      task: "expired task",
      createdAt: "2026-01-01T00:00:00.000Z",
      expiresAt: "2026-01-01T00:00:01.000Z",
      cells: [],
      paths: [],
      symbols: [],
      resources: [],
      artifactLanes: [],
    }],
  });

  const result = runCli(["claim", "list"], tempDir);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /expired expired-empty agent:codex-old cells:\(none\)/);
});

test("CLI claim check human output includes findings", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-claim-human-finding-"));
  writeClaimProject(tempDir);
  runGit(["init"], tempDir);
  runGit(["config", "user.email", "test@example.com"], tempDir);
  runGit(["config", "user.name", "Test User"], tempDir);
  runGit(["add", "."], tempDir);
  runGit(["commit", "-m", "initial"], tempDir);
  fs.appendFileSync(path.join(tempDir, "src/billing/public.ts"), "export const changed = true;\n");

  const result = runCli(["claim", "check", "--agent", "codex-a"], tempDir);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /CellFence claim check failed/);
  assert.match(result.stdout, /CELLFENCE_UNCLAIMED_CHANGE src\/billing\/public\.ts/);
});

test("CLI claim check human output handles findings without file paths", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-claim-human-no-file-"));
  try {
    writeClaimProject(tempDir);
    const result = runCli(["claim", "check", "--agent", "codex-a"], tempDir);
    assert.equal(result.status, 1);
    assert.match(result.stdout, /CELLFENCE_GIT_METADATA_UNAVAILABLE: claim check --agent requires git metadata/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("CLI claim check fails unclaimed agent changes and passes claimed changes", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-claim-diff-"));
  writeClaimProject(tempDir);
  runGit(["init"], tempDir);
  runGit(["config", "user.email", "test@example.com"], tempDir);
  runGit(["config", "user.name", "Test User"], tempDir);
  runGit(["add", "."], tempDir);
  runGit(["commit", "-m", "initial"], tempDir);
  fs.appendFileSync(path.join(tempDir, "src/billing/public.ts"), "export const nextInvoice = true;\n");

  const unclaimed = runCli(["claim", "check", "--agent", "codex-a", "--json"], tempDir);
  assert.equal(unclaimed.status, 1);
  const unclaimedResult = JSON.parse(unclaimed.stdout);
  assert.ok(unclaimedResult.findings.some((finding) => finding.ruleId === "CELLFENCE_UNCLAIMED_CHANGE"));

  const create = runCli(["claim", "create", "--agent", "codex-a", "--cell", "billing", "--ttl", "2h"], tempDir);
  assert.equal(create.status, 0, create.stderr || create.stdout);
  const claimed = runCli(["claim", "check", "--agent", "codex-a", "--json"], tempDir);
  assert.equal(claimed.status, 0, claimed.stderr || claimed.stdout);
  const claimedResult = JSON.parse(claimed.stdout);
  assert.deepEqual(claimedResult.changedFiles, ["src/billing/public.ts"]);
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

test("CLI init enables strict ownership coverage by default", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-init-strict-"));
  try {
    const result = runCli(["init"], tempDir);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const manifest = JSON.parse(fs.readFileSync(path.join(tempDir, "cellfence.manifest.json"), "utf8"));
    assert.deepEqual(manifest.governance, {
      requireOwnership: true,
      include: ["src/**"],
      exclude: [],
    });
    const checkResult = runCli(["check", "--json"], tempDir);
    assert.equal(checkResult.status, 0, checkResult.stderr || checkResult.stdout);
    const parsed = JSON.parse(checkResult.stdout);
    assert.equal(parsed.ok, true);
    assert.deepEqual(parsed.warnings, []);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("CLI init infers src cells, workspace cells, public entries, and consumers", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-init-infer-"));
  try {
    writeJson(path.join(tempDir, "package.json"), {
      workspaces: ["packages/*"],
    });
    writeJson(path.join(tempDir, "tsconfig.json"), {
      compilerOptions: {
        baseUrl: ".",
        paths: {
          "@parser/*": ["src/parser/*"],
        },
      },
    });
    fs.mkdirSync(path.join(tempDir, "src/parser"), { recursive: true });
    fs.mkdirSync(path.join(tempDir, "src/reporting"), { recursive: true });
    fs.mkdirSync(path.join(tempDir, "packages/worker/src"), { recursive: true });
    writeJson(path.join(tempDir, "packages/worker/package.json"), { name: "@demo/worker" });
    fs.writeFileSync(path.join(tempDir, "src/parser/public.ts"), "export function parse(value: string): string { return value; }\n");
    fs.writeFileSync(path.join(tempDir, "src/reporting/index.ts"), "import 'node:fs';\nimport { parse } from '@parser/public.js';\nexport const report = parse('ok');\n");
    fs.writeFileSync(path.join(tempDir, "packages/worker/src/index.ts"), "import { parse } from '../../../src/parser/public.js';\nexport const run = () => parse('job');\n");

    const result = runCli(["init"], tempDir);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const manifest = JSON.parse(fs.readFileSync(path.join(tempDir, "cellfence.manifest.json"), "utf8"));
    assert.deepEqual(manifest.governance, {
      requireOwnership: true,
      include: ["packages/worker/src/**", "src/**"],
      exclude: [],
    });
    assert.deepEqual(manifest.cells.map((cell) => cell.id), ["parser", "reporting", "worker"]);
    assert.deepEqual(manifest.cells.map((cell) => [cell.id, cell.publicEntry]), [
      ["parser", "src/parser/public.ts"],
      ["reporting", "src/reporting/index.ts"],
      ["worker", "packages/worker/src/index.ts"],
    ]);
    assert.deepEqual(manifest.cells.find((cell) => cell.id === "parser").publicSymbols, ["parse"]);
    assert.deepEqual(manifest.cells.find((cell) => cell.id === "reporting").consumes, [{ cell: "parser" }]);
    assert.deepEqual(manifest.cells.find((cell) => cell.id === "worker").packageName, "@demo/worker");
    assert.deepEqual(manifest.cells.find((cell) => cell.id === "worker").consumes, [{ cell: "parser" }]);

    const checkResult = runCli(["check", "--json"], tempDir);
    assert.equal(checkResult.status, 0, checkResult.stderr || checkResult.stdout);
    assert.equal(JSON.parse(checkResult.stdout).ok, true);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("CLI init infers object workspaces, exact workspaces, duplicate ids, and src root files", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-init-workspaces-"));
  try {
    writeJson(path.join(tempDir, "package.json"), {
      workspaces: {
        packages: ["*", "libs/core", "packages/*", "packages/dup-a", "missing", "missing/*"],
      },
    });
    fs.mkdirSync(path.join(tempDir, "src"), { recursive: true });
    fs.mkdirSync(path.join(tempDir, "loose/src"), { recursive: true });
    fs.mkdirSync(path.join(tempDir, "libs/core/src"), { recursive: true });
    fs.mkdirSync(path.join(tempDir, "packages/dup-a/src"), { recursive: true });
    fs.mkdirSync(path.join(tempDir, "packages/dup-b/src"), { recursive: true });
    writeJson(path.join(tempDir, "libs/core/package.json"), { name: "" });
    writeJson(path.join(tempDir, "loose/package.json"), { name: "/" });
    writeJson(path.join(tempDir, "packages/dup-a/package.json"), { name: "@demo/dup" });
    writeJson(path.join(tempDir, "packages/dup-b/package.json"), { name: "@demo/dup" });
    fs.writeFileSync(path.join(tempDir, "src/index.ts"), "export const root = true;\n");
    fs.writeFileSync(path.join(tempDir, "loose/src/index.ts"), "export const loose = true;\n");
    fs.writeFileSync(path.join(tempDir, "libs/core/src/custom.ts"), "export const core = true;\n");
    fs.writeFileSync(path.join(tempDir, "packages/dup-a/src/index.ts"), "export const first = true;\n");
    fs.writeFileSync(path.join(tempDir, "packages/dup-b/src/index.ts"), "export const second = true;\n");

    const result = runCli(["init"], tempDir);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const manifest = JSON.parse(fs.readFileSync(path.join(tempDir, "cellfence.manifest.json"), "utf8"));
    assert.deepEqual(manifest.cells.map((cell) => cell.id), ["cell", "core", "dup", "dup-2", "src-root"]);
    assert.deepEqual(manifest.cells.map((cell) => [cell.id, cell.ownedPaths[0], cell.publicEntry]), [
      ["cell", "loose/src/**", "loose/src/index.ts"],
      ["core", "libs/core/src/**", "libs/core/src/custom.ts"],
      ["dup", "packages/dup-a/src/**", "packages/dup-a/src/index.ts"],
      ["dup-2", "packages/dup-b/src/**", "packages/dup-b/src/index.ts"],
      ["src-root", "src/*", "src/index.ts"],
    ]);
    assert.equal(manifest.cells.find((cell) => cell.id === "dup").packageName, "@demo/dup");
    assert.equal(manifest.cells.find((cell) => cell.id === "dup-2").packageName, "@demo/dup");

    const checkResult = runCli(["check", "--json"], tempDir);
    assert.equal(checkResult.status, 0, checkResult.stderr || checkResult.stdout);
    assert.equal(JSON.parse(checkResult.stdout).ok, true);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("CLI init falls back to the example cell when repository metadata is malformed and no sources exist", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-init-malformed-"));
  try {
    fs.writeFileSync(path.join(tempDir, "package.json"), "{");
    const result = runCli(["init"], tempDir);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const manifest = JSON.parse(fs.readFileSync(path.join(tempDir, "cellfence.manifest.json"), "utf8"));
    assert.deepEqual(manifest.cells.map((cell) => cell.id), ["example"]);
    assert.equal(fs.existsSync(path.join(tempDir, "src/example/public.ts")), true);
    const checkResult = runCli(["check", "--json"], tempDir);
    assert.equal(checkResult.status, 0, checkResult.stderr || checkResult.stdout);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("CLI init refuses to overwrite an existing manifest", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-init-existing-"));
  try {
    const first = runCli(["init"], tempDir);
    assert.equal(first.status, 0, first.stderr || first.stdout);
    const second = runCli(["init"], tempDir);
    assert.equal(second.status, 2);
    assert.match(second.stderr, /cellfence\.manifest\.json already exists/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("CLI rejects manifest plugins and extends instead of silently ignoring them", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-reserved-manifest-"));
  try {
    fs.mkdirSync(path.join(tempDir, "src/core"), { recursive: true });
    fs.writeFileSync(path.join(tempDir, "src/core/public.ts"), "export const core = true;\n");
    writeJson(path.join(tempDir, "cellfence.manifest.json"), {
      schemaVersion: "cellfence.manifest.v1",
      extends: ["./missing.json"],
      plugins: ["missing-plugin"],
      cells: [{
        id: "core",
        ownedPaths: ["src/core/**"],
        publicEntry: "src/core/public.ts",
        publicSymbols: ["core"],
        consumes: [],
        producesArtifacts: [],
      }],
    });
    const result = runCli(["check", "--json"], tempDir);
    assert.equal(result.status, 2);
    const parsed = JSON.parse(result.stdout);
    assert.ok(parsed.findings.some((finding) => finding.ruleId === "CELLFENCE_MANIFEST_INVALID"));
    assert.match(parsed.findings[0].message, /extends is reserved/);
    assert.match(parsed.findings[0].message, /plugins is reserved/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
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

test("CLI baseline update refuses to add a locked cell missing from the accepted baseline", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-locked-new-cell-"));
  fs.mkdirSync(path.join(tempDir, "src/core"), { recursive: true });
  fs.mkdirSync(path.join(tempDir, "src/newcell"), { recursive: true });
  fs.writeFileSync(path.join(tempDir, "src/core/public.ts"), "export const core = true;\n");
  fs.writeFileSync(path.join(tempDir, "src/newcell/public.ts"), "export const newcell = true;\n");
  fs.writeFileSync(path.join(tempDir, "cellfence.manifest.json"), `${JSON.stringify({
    schemaVersion: "cellfence.manifest.v1",
    cells: [
      {
        id: "core",
        ownedPaths: ["src/core/**"],
        publicEntry: "src/core/public.ts",
        publicSymbols: ["core"],
        consumes: [],
        producesArtifacts: [],
      },
      {
        id: "newcell",
        locked: true,
        ownedPaths: ["src/newcell/**"],
        publicEntry: "src/newcell/public.ts",
        publicSymbols: ["newcell"],
        consumes: [],
        producesArtifacts: [],
      },
    ],
  }, null, 2)}\n`);
  fs.writeFileSync(path.join(tempDir, "cellfence.baseline.json"), `${JSON.stringify({
    schemaVersion: "cellfence.baseline.v1",
    generatedAt: "2026-01-01T00:00:00.000Z",
    cellIds: ["core"],
    cells: {
      core: {
        ownedPathPatterns: 1,
        publicSymbols: 1,
        publicSurfaceLines: 1,
        crossCellDependencies: 0,
      },
    },
  }, null, 2)}\n`);

  const result = runCli(["baseline", "update"], tempDir);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /newcell is locked and is absent from the existing baseline/);
  const baseline = JSON.parse(fs.readFileSync(path.join(tempDir, "cellfence.baseline.json"), "utf8"));
  assert.equal(baseline.cells.newcell, undefined);
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

  const humanList = runCli(["waivers", "list"], tempDir);
  assert.equal(humanList.status, 0);
  assert.match(humanList.stdout, /valid CELLFENCE_PRIVATE_IMPORT src\/consumer\/public\.ts:1/);
});

test("CLI waivers list reports an empty human-readable inventory", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-waiver-empty-"));
  try {
    fs.mkdirSync(path.join(tempDir, "src/core"), { recursive: true });
    fs.writeFileSync(path.join(tempDir, "src/core/public.ts"), "export const core = true;\n");
    writeJson(path.join(tempDir, "cellfence.manifest.json"), {
      schemaVersion: "cellfence.manifest.v1",
      cells: [{
        id: "core",
        ownedPaths: ["src/core/**"],
        publicEntry: "src/core/public.ts",
        publicSymbols: ["core"],
        consumes: [],
        producesArtifacts: [],
      }],
    });

    const result = runCli(["waivers", "list"], tempDir);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /No CellFence waivers found\./);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
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

test("CLI rejects PENDING CellFence waivers instead of treating requests as approvals", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-waiver-pending-"));
  try {
    writePrivateImportProject(tempDir, { withWaiver: true });
    const consumerPath = path.join(tempDir, "src/consumer/public.ts");
    fs.writeFileSync(
      consumerPath,
      fs.readFileSync(consumerPath, "utf8").replace("approved-by:test-owner", "approved-by:PENDING"),
    );

    const result = runCli(["check", "--json"], tempDir);
    assert.equal(result.status, 1);
    const parsed = JSON.parse(result.stdout);
    assert.ok(parsed.findings.some((finding) => finding.ruleId === "CELLFENCE_WAIVER_INVALID"));
    assert.ok(parsed.findings.some((finding) => finding.ruleId === "CELLFENCE_PRIVATE_IMPORT"));

    const listResult = runCli(["waivers", "list", "--json"], tempDir);
    assert.equal(listResult.status, 1);
    const waivers = JSON.parse(listResult.stdout).waivers;
    assert.equal(waivers[0].approvedBy, "PENDING");
    assert.equal(waivers[0].valid, false);
    assert.ok(waivers[0].errors.includes("approved-by:PENDING is a request placeholder, not an approval"));

    const humanList = runCli(["waivers", "list"], tempDir);
    assert.equal(humanList.status, 1);
    assert.match(humanList.stdout, /invalid CELLFENCE_PRIVATE_IMPORT src\/consumer\/public\.ts:1/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("CLI check writes audit JSONL and summary JSON artifacts", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-audit-artifacts-"));
  try {
    writePrivateImportProject(tempDir);
    const auditPath = path.join(tempDir, "tmp", "cellfence-audit.jsonl");
    const summaryPath = path.join(tempDir, "tmp", "cellfence-summary.json");
    const result = runCliWithEnv(["check", "--json", "--audit-log", auditPath, "--summary-json", summaryPath], tempDir, {
      GITHUB_SHA: "sha-from-env",
    });
    assert.equal(result.status, 1);

    const auditLines = fs.readFileSync(auditPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(auditLines[0].schemaVersion, "cellfence.audit-event.v1");
    assert.equal(auditLines[0].commit, "sha-from-env");
    assert.equal(auditLines[0].event, "check.started");
    assert.equal(auditLines[0].command, "check");
    assert.equal(auditLines.at(-1).event, "check.completed");
    assert.equal(auditLines.at(-1).ok, false);

    const privateImportEvent = auditLines.find((event) => event.event === "finding.detected" && event.ruleId === "CELLFENCE_PRIVATE_IMPORT");
    assert.ok(privateImportEvent);
    assert.equal(privateImportEvent.outcome, "rejected");
    assert.equal(privateImportEvent.filePath, "src/consumer/public.ts");
    assert.match(privateImportEvent.fingerprint, /^[a-f0-9]{64}$/);
    assert.ok(auditLines.some((event) => event.event === "finding.detected" && event.ruleId === "CELLFENCE_OWNERSHIP_COVERAGE_DISABLED"));

    const summary = JSON.parse(fs.readFileSync(summaryPath, "utf8"));
    assert.equal(summary.schemaVersion, "cellfence.summary.v1");
    assert.equal(summary.commit, "sha-from-env");
    assert.equal(summary.command, "check");
    assert.equal(summary.ok, false);
    assert.equal(summary.exitCode, 1);
    assert.deepEqual(summary.failedRules, ["CELLFENCE_PRIVATE_IMPORT"]);
    assert.equal(summary.findingsByRule.CELLFENCE_PRIVATE_IMPORT, 1);
    assert.equal(summary.warningsByRule.CELLFENCE_OWNERSHIP_COVERAGE_DISABLED, 1);
    assert.equal(summary.findingFingerprints.length, 1);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("CLI summary records null commit when git returns an empty HEAD", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-summary-empty-head-"));
  const fakeBin = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-fake-empty-git-"));
  try {
    writePrivateImportProject(tempDir);
    const fakeGitPath = path.join(fakeBin, "git");
    fs.writeFileSync(fakeGitPath, "#!/bin/sh\nexit 0\n");
    fs.chmodSync(fakeGitPath, 0o755);
    const summaryPath = path.join(tempDir, "tmp", "summary.json");
    const result = runCliWithEnv(["check", "--summary-json", summaryPath, "--json"], tempDir, {
      PATH: `${fakeBin}${path.delimiter}${process.env.PATH}`,
      GITHUB_SHA: "",
    });
    assert.equal(result.status, 1);
    const summary = JSON.parse(fs.readFileSync(summaryPath, "utf8"));
    assert.equal(summary.commit, null);
  } finally {
    fs.rmSync(fakeBin, { recursive: true, force: true });
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("CLI changed check audit log records changed files and baseline comparison events", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-audit-changed-"));
  try {
    fs.mkdirSync(path.join(tempDir, "src/core"), { recursive: true });
    fs.writeFileSync(path.join(tempDir, "src/core/public.ts"), "export const core = true;\n");
    writeJson(path.join(tempDir, "cellfence.manifest.json"), {
      schemaVersion: "cellfence.manifest.v1",
      cells: [{
        id: "core",
        ownedPaths: ["src/core/**"],
        publicEntry: "src/core/public.ts",
        publicSymbols: ["core"],
        consumes: [],
        producesArtifacts: [],
      }],
    });
    writeJson(path.join(tempDir, "cellfence.baseline.json"), {
      schemaVersion: "cellfence.baseline.v1",
      generatedAt: "2026-01-01T00:00:00.000Z",
      cells: {
        core: {
          ownedPathPatterns: 1,
          publicSymbols: 2,
          publicSurfaceLines: 20,
          crossCellDependencies: 0,
          resourceAccesses: [],
        },
      },
    });
    runGit(["init"], tempDir);
    runGit(["config", "user.email", "cellfence@example.invalid"], tempDir);
    runGit(["config", "user.name", "CellFence Test"], tempDir);
    runGit(["add", "."], tempDir);
    runGit(["commit", "-m", "base"], tempDir);
    fs.appendFileSync(path.join(tempDir, "src/core/public.ts"), "// changed without public API drift\n");

    const auditPath = path.join("tmp", "changed-audit.jsonl");
    const summaryPath = path.join("tmp", "changed-summary.json");
    const result = runCli([
      "check",
      "--changed",
      "--base",
      "HEAD",
      "--baseline",
      "cellfence.baseline.json",
      "--audit-log",
      auditPath,
      "--summary-json",
      summaryPath,
      "--json",
    ], tempDir);
    assert.equal(result.status, 0, result.stderr || result.stdout);

    const auditLines = fs.readFileSync(path.join(tempDir, auditPath), "utf8").trim().split("\n").map((line) => JSON.parse(line));
    assert.ok(auditLines.some((event) => event.event === "changed_files.computed" && event.count === 1));
    assert.ok(auditLines.some((event) => event.event === "baseline.compared" && event.baselinePath === "cellfence.baseline.json"));
    const summary = JSON.parse(fs.readFileSync(path.join(tempDir, summaryPath), "utf8"));
    assert.equal(summary.counts.changedFiles, 1);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
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

test("CLI human output covers check, baseline, evidence, and waiver error paths", () => {
  const validFixture = path.join(root, "fixtures/valid/single-cell");
  const check = runCli(["check"], validFixture);
  assert.equal(check.status, 0);
  assert.match(check.stdout, /CellFence check passed/);

  const baselineFixture = path.join(root, "fixtures/valid/resource-baseline-allows-existing");
  const baseline = runCli(["baseline", "check", "--baseline=cellfence.baseline.json"], baselineFixture);
  assert.equal(baseline.status, 0);
  assert.match(baseline.stdout, /CellFence check passed/);

  const noEvidence = runCli(["evidence", "check"], baselineFixture);
  assert.equal(noEvidence.status, 2);
  assert.match(noEvidence.stderr, /requires at least one --evidence path/);

  const missingWaiverArgs = runCli(["waivers", "request", "--rule=CELLFENCE_PRIVATE_IMPORT"]);
  assert.equal(missingWaiverArgs.status, 2);
  assert.match(missingWaiverArgs.stderr, /requires --rule, --file, --line, --expires, and --reason/);

  const waiverMarkdown = runCli([
    "waivers",
    "request",
    "--rule=CELLFENCE_PRIVATE_IMPORT",
    "--file=src/consumer/public.ts",
    "--line=7",
    "--expires=2099-01-01",
    "--reason=temporary architecture migration while public API is extracted",
  ]);
  assert.equal(waiverMarkdown.status, 0);
  assert.match(waiverMarkdown.stdout, /CellFence Waiver Request/);
});

test("CLI baseline update succeeds when no locked expansion is present", () => {
  const fixturePath = path.join(root, "fixtures/valid/single-cell");
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-baseline-update-"));
  fs.cpSync(fixturePath, tempDir, { recursive: true });

  const create = runCli(["baseline", "create", "--baseline=cellfence.baseline.json"], tempDir);
  assert.equal(create.status, 0, create.stderr || create.stdout);
  const update = runCli(["baseline", "update", "--baseline=cellfence.baseline.json"], tempDir);
  assert.equal(update.status, 0, update.stderr || update.stdout);
  assert.match(update.stdout, /updated .*cellfence\.baseline\.json/);
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

test("CLI returns usage for unknown commands", () => {
  const result = runCli([
    "definitely-unknown",
    `--root=${root}`,
    "--base=origin/main",
    "--head=HEAD",
    "--manifest=cellfence.manifest.json",
    "--baseline=cellfence.baseline.json",
    "--audit-log=tmp/audit.jsonl",
    "--summary-json=tmp/summary.json",
    "--agent=codex-a",
    "--claim-id=claim-1",
    "--claims=.cellfence/claims.json",
    "--path=src/**",
    "--symbol=api",
    "--resource=database:read:app.users",
    "--artifact=events-v1",
    "--task=touch runtime",
    "--rule=CELLFENCE_PRIVATE_IMPORT",
    "--file=src/consumer/public.ts",
    "--line=7",
    "--expires=2099-01-01",
    "--ttl=2h",
    "--reason=temporary architecture migration",
    "--approved-by=owner",
    "--format=agents-md",
    "--evidence=resource-evidence.json",
  ]);
  assert.equal(result.status, 2);
  assert.match(result.stdout, /Usage:/);
});

test("CLI parses space-separated option forms before returning usage", () => {
  const result = runCli([
    "definitely-unknown",
    "--root",
    root,
    "--head",
    "HEAD",
    "--baseline",
    "cellfence.baseline.json",
    "--claim-id",
    "claim-1",
    "--claims",
    ".cellfence/claims.json",
    "--symbol",
    "api",
    "--resource",
    "database:read:app.users",
    "--artifact",
    "events-v1",
  ]);
  assert.equal(result.status, 2);
  assert.match(result.stdout, /Usage:/);
});

test("CLI help returns usage without running a command", () => {
  const result = runCli(["--help"]);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /Usage:/);
});

test("CLI main catches unexpected command errors", () => {
  const originalError = console.error;
  let captured = "";
  console.error = (message) => {
    captured += String(message);
  };
  try {
    const status = main(["context", "--cell", "core", "--manifest", "definitely-missing-manifest.json"]);
    assert.equal(status, 3);
    assert.match(captured, /definitely-missing-manifest\.json/);
  } finally {
    console.error = originalError;
  }
});

test("CLI main renders non-Error command failures safely", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-main-string-catch-"));
  const originalWriteFileSync = fs.writeFileSync;
  const originalConsoleError = console.error;
  const errors = [];
  try {
    fs.mkdirSync(path.join(tempDir, "src/core"), { recursive: true });
    originalWriteFileSync.call(fs, path.join(tempDir, "src/core/public.ts"), "export const core = true;\n");
    writeJson(path.join(tempDir, "cellfence.manifest.json"), {
      schemaVersion: "cellfence.manifest.v1",
      cells: [{
        id: "core",
        ownedPaths: ["src/core/**"],
        publicEntry: "src/core/public.ts",
        publicSymbols: ["core"],
        consumes: [],
        producesArtifacts: [],
      }],
    });
    fs.writeFileSync = () => {
      throw "string write failure";
    };
    console.error = (message) => {
      errors.push(String(message));
    };
    assert.equal(main(["baseline", "update", "--root", tempDir]), 3);
    assert.deepEqual(errors, ["string write failure"]);
  } finally {
    fs.writeFileSync = originalWriteFileSync;
    console.error = originalConsoleError;
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("CLI direct execution guard tolerates missing argv executable path", async () => {
  const originalArgv = process.argv[1];
  const originalExitCode = process.exitCode;
  process.argv[1] = path.join(os.tmpdir(), `cellfence-missing-${Date.now()}.js`);
  try {
    await import(`${pathToFileURL(cliPath).href}?missingArgv=${Date.now()}`);
    assert.equal(process.exitCode, originalExitCode);
  } finally {
    process.argv[1] = originalArgv;
    process.exitCode = originalExitCode;
  }
});
