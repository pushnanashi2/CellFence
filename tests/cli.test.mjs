import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import { main } from "../packages/cli/dist/index.js";

const root = process.cwd();
const cliPath = path.join(root, "packages/cli/dist/index.js");
const defaultRequiredRules = [
  "CELLFENCE_OWNERSHIP_OVERLAP",
  "CELLFENCE_UNOWNED_SOURCE",
  "CELLFENCE_UNOWNED_IMPORT_TARGET",
  "CELLFENCE_PUBLIC_ENTRY_OUTSIDE_OWNERSHIP",
  "CELLFENCE_ARTIFACT_OUTSIDE_OWNERSHIP",
  "CELLFENCE_SYMLINK_TARGET_OUTSIDE_OWNERSHIP",
  "CELLFENCE_PRIVATE_IMPORT",
  "CELLFENCE_UNSUPPORTED_DYNAMIC_IMPORT",
  "CELLFENCE_UNSUPPORTED_DYNAMIC_REQUIRE",
  "CELLFENCE_REQUIRED_RULE_DISABLED",
  "CELLFENCE_WAIVER_INVALID",
];

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

function runCliWithInput(args, cwd, input) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    cwd,
    encoding: "utf8",
    input,
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

test("CLI install writes, checks, repairs, and uninstalls managed agent instruction blocks", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-install-"));
  try {
    const missing = runCli(["install", "--check", "--json"], tempDir);
    assert.equal(missing.status, 1);
    assert.match(missing.stdout, /missing CellFence managed block/);

    const invalidTarget = runCli(["install", "--target", "cursor"], tempDir);
    assert.equal(invalidTarget.status, 2);
    assert.match(invalidTarget.stderr, /supports --target/);

    const conflict = runCli(["install", "--check", "--uninstall"], tempDir);
    assert.equal(conflict.status, 2);
    assert.match(conflict.stderr, /cannot use --check and --uninstall together/);

    const install = runCli(["install", "--json"], tempDir);
    assert.equal(install.status, 0, install.stderr || install.stdout);
    const installed = JSON.parse(install.stdout);
    assert.equal(installed.schemaVersion, "cellfence.install.v1");
    assert.equal(installed.changed, true);
    const agentsPath = path.join(tempDir, "AGENTS.md");
    const agentsText = fs.readFileSync(agentsPath, "utf8");
    assert.match(agentsText, /<!-- cellfence:start target:agents-md checksum:[a-f0-9]{64} -->/);
    assert.match(agentsText, /npx cellfence install --check/);

    const secondInstall = runCli(["install", "--json"], tempDir);
    assert.equal(secondInstall.status, 0, secondInstall.stderr || secondInstall.stdout);
    assert.equal(JSON.parse(secondInstall.stdout).changed, false);

    const check = runCli(["install", "--check", "--json"], tempDir);
    assert.equal(check.status, 0, check.stderr || check.stdout);
    assert.equal(JSON.parse(check.stdout).ok, true);

    const notesPath = path.join(tempDir, "NOTES.md");
    fs.writeFileSync(notesPath, "Existing notes\n");
    const append = runCli(["install", "--file", "NOTES.md", "--json"], tempDir);
    assert.equal(append.status, 0, append.stderr || append.stdout);
    assert.match(fs.readFileSync(notesPath, "utf8"), /Existing notes\n\n<!-- cellfence:start/);
    const uninstallOnlyBlock = runCli(["install", "--file", "NOTES.md", "--uninstall", "--json"], tempDir);
    assert.equal(uninstallOnlyBlock.status, 0, uninstallOnlyBlock.stderr || uninstallOnlyBlock.stdout);
    assert.equal(JSON.parse(uninstallOnlyBlock.stdout).changed, true);
    assert.equal(fs.readFileSync(notesPath, "utf8"), "Existing notes\n");

    const onlyPath = path.join(tempDir, "ONLY.md");
    const onlyInstall = runCli(["install", "--file", "ONLY.md", "--json"], tempDir);
    assert.equal(onlyInstall.status, 0, onlyInstall.stderr || onlyInstall.stdout);
    const onlyUninstall = runCli(["install", "--file", "ONLY.md", "--uninstall", "--json"], tempDir);
    assert.equal(onlyUninstall.status, 0, onlyUninstall.stderr || onlyUninstall.stdout);
    assert.equal(fs.readFileSync(onlyPath, "utf8"), "");

    fs.writeFileSync(agentsPath, agentsText.replace(/checksum:[a-f0-9]{64}/, `checksum:${"0".repeat(64)}`));
    const checksumDrift = runCli(["install", "--check"], tempDir);
    assert.equal(checksumDrift.status, 1);
    assert.match(checksumDrift.stdout, /checksum does not match/);

    const repair = runCli(["install"], tempDir);
    assert.equal(repair.status, 0, repair.stderr || repair.stdout);
    fs.appendFileSync(agentsPath, "\n### Architecture fence (CellFence)\nold unmanaged copy\n");
    const unmanaged = runCli(["install", "--check"], tempDir);
    assert.equal(unmanaged.status, 1);
    assert.match(unmanaged.stdout, /unmanaged CellFence instruction text/);

    const uninstall = runCli(["install", "--uninstall", "--json"], tempDir);
    assert.equal(uninstall.status, 0, uninstall.stderr || uninstall.stdout);
    assert.equal(JSON.parse(uninstall.stdout).changed, true);
    assert.doesNotMatch(fs.readFileSync(agentsPath, "utf8"), /cellfence:start/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("CLI install supports Claude target and explicit files", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-install-claude-"));
  try {
    const install = runCli(["install", "--target=claude-md", "--json"], tempDir);
    assert.equal(install.status, 0, install.stderr || install.stdout);
    assert.equal(JSON.parse(install.stdout).filePath, "CLAUDE.md");
    assert.match(fs.readFileSync(path.join(tempDir, "CLAUDE.md"), "utf8"), /CellFence for Claude/);

    const explicit = runCli(["install", "--target=agents-md", "--file", "docs/AGENT-FENCE.md", "--json"], tempDir);
    assert.equal(explicit.status, 0, explicit.stderr || explicit.stdout);
    assert.equal(JSON.parse(explicit.stdout).filePath, "docs/AGENT-FENCE.md");
    assert.match(fs.readFileSync(path.join(tempDir, "docs/AGENT-FENCE.md"), "utf8"), /target:agents-md/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("CLI MCP server exposes context, checks, claims, and finding explanations", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-mcp-"));
  try {
    writeClaimProject(tempDir);
    const input = [
      "   ",
      JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
      JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }),
      JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
      JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "get_cell_context", arguments: { cellId: "billing", format: "agents-md" } } }),
      JSON.stringify({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "check_change", arguments: {} } }),
      JSON.stringify({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "check_change", arguments: { changed: true, baseRef: "HEAD", headRef: "HEAD" } } }),
      JSON.stringify({ jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "create_claim", arguments: { agent: "codex-a", cellId: "billing", ttl: "2h" } } }),
      JSON.stringify({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "explain_finding", arguments: { finding: { ruleId: "CELLFENCE_PRIVATE_IMPORT", message: "private import", suggestedResolutions: [{ kind: "change-code", title: "Use public entry", approvalRequired: false }] } } } }),
      JSON.stringify({ jsonrpc: "2.0", id: 8, method: "tools/call", params: { name: "explain_finding", arguments: { finding: { ruleId: "CELLFENCE_PRIVATE_IMPORT", message: "private import" } } } }),
      JSON.stringify({ jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "create_claim", arguments: { agent: "codex-a" } } }),
      JSON.stringify({ jsonrpc: "2.0", id: 10, method: "tools/call", params: { name: "explain_finding", arguments: {} } }),
      JSON.stringify({ jsonrpc: "2.0", id: 11, method: "tools/call", params: { name: "get_cell_context", arguments: { cellId: "billing" } } }),
      JSON.stringify({ jsonrpc: "2.0", id: 12, method: "tools/call", params: { name: "get_cell_context", arguments: {} } }),
      JSON.stringify({ jsonrpc: "2.0", id: 13, method: "tools/call", params: { name: "missing_tool", arguments: {} } }),
      JSON.stringify({ jsonrpc: "2.0", id: 14, method: "tools/call", params: {} }),
      JSON.stringify({ jsonrpc: "2.0", id: 15, method: "unknown/method", params: {} }),
      JSON.stringify({ jsonrpc: "2.0", id: 16, method: "tools/call", params: "bad-params" }),
      JSON.stringify({ jsonrpc: "2.0", id: 17, params: {} }),
      "{not-json}",
      "",
    ].join("\n");
    const result = runCliWithInput(["serve", "--mcp"], tempDir, input);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const responses = result.stdout.trim().split(/\n/).map((line) => JSON.parse(line));
    assert.equal(responses.length, 18);
    assert.equal(responses[0].result.serverInfo.name, "cellfence");
    assert.ok(responses[1].result.tools.some((tool) => tool.name === "get_cell_context"));
    assert.match(responses[2].result.content[0].text, /# CellFence Context: billing/);
    assert.match(responses[3].result.content[0].text, /"ok": true/);
    assert.match(responses[4].result.content[0].text, /CELLFENCE_GIT_METADATA_UNAVAILABLE/);
    assert.match(responses[5].result.content[0].text, /"createdClaim"/);
    assert.match(responses[6].result.content[0].text, /Use public entry/);
    assert.match(responses[7].result.content[0].text, /"suggestedResolutions": \[\]/);
    assert.equal(responses[8].result.isError, true);
    assert.match(responses[8].result.content[0].text, /create_claim requires agent and cellId/);
    assert.equal(responses[9].result.isError, true);
    assert.match(responses[9].result.content[0].text, /explain_finding requires finding object/);
    assert.match(responses[10].result.content[0].text, /"schemaVersion": "cellfence.context.v1"/);
    assert.equal(responses[11].result.isError, true);
    assert.match(responses[11].result.content[0].text, /get_cell_context requires cellId/);
    assert.equal(responses[12].result.isError, true);
    assert.match(responses[12].result.content[0].text, /unknown CellFence MCP tool/);
    assert.equal(responses[13].error.code, -32602);
    assert.equal(responses[14].error.code, -32601);
    assert.equal(responses[15].error.code, -32602);
    assert.equal(responses[16].error.code, -32601);
    assert.match(responses[16].error.message, /\(missing\)/);
    assert.equal(responses[17].error.code, -32700);

    const notMcp = runCli(["serve"], tempDir);
    assert.equal(notMcp.status, 2);
    assert.match(notMcp.stderr, /requires --mcp/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
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

test("CLI claim create serializes concurrent writes without losing claims", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-claim-concurrent-"));
  try {
    const cells = [];
    for (const cellId of ["a", "b", "c", "d", "e", "f"]) {
      fs.mkdirSync(path.join(tempDir, "src", cellId), { recursive: true });
      fs.writeFileSync(path.join(tempDir, "src", cellId, "public.ts"), `export const ${cellId} = true;\n`);
      cells.push({
        id: cellId,
        ownedPaths: [`src/${cellId}/**`],
        publicEntry: `src/${cellId}/public.ts`,
        publicSymbols: [cellId],
        consumes: [],
        producesArtifacts: [],
      });
    }
    writeJson(path.join(tempDir, "cellfence.manifest.json"), {
      schemaVersion: "cellfence.manifest.v1",
      cells,
    });

    const children = await Promise.all(cells.map((cell) => new Promise((resolve) => {
      const child = spawn(process.execPath, [
        cliPath,
        "claim",
        "create",
        "--agent",
        `agent-${cell.id}`,
        "--cell",
        cell.id,
        "--ttl",
        "2h",
        "--json",
      ], {
        cwd: tempDir,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk) => { stdout += chunk; });
      child.stderr.on("data", (chunk) => { stderr += chunk; });
      child.on("close", (status) => resolve({ status, stdout, stderr }));
    })));
    for (const child of children) assert.equal(child.status, 0, child.stderr || child.stdout);
    const store = JSON.parse(fs.readFileSync(path.join(tempDir, ".cellfence/claims.json"), "utf8"));
    assert.deepEqual(store.claims.map((claim) => claim.agent).sort(), cells.map((cell) => `agent-${cell.id}`).sort());
    assert.equal(fs.existsSync(path.join(tempDir, ".cellfence/claims.json.lock")), false);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
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
      requiredRules: defaultRequiredRules,
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
      requiredRules: defaultRequiredRules,
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

test("CLI rejects attempts to disable core boundary rules even without manifest requiredRules", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-core-rule-off-"));
  try {
    writePrivateImportProject(tempDir);
    const manifestPath = path.join(tempDir, "cellfence.manifest.json");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    manifest.rules = { CELLFENCE_PRIVATE_IMPORT: "off" };
    writeJson(manifestPath, manifest);

    const result = runCli(["check", "--json"], tempDir);
    assert.equal(result.status, 1);
    const parsed = JSON.parse(result.stdout);
    assert.ok(parsed.findings.some((finding) => finding.ruleId === "CELLFENCE_REQUIRED_RULE_DISABLED"));
    assert.ok(parsed.findings.some((finding) => finding.ruleId === "CELLFENCE_PRIVATE_IMPORT"));
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("CLI rejects governed symlinks that target another cell private source", { skip: process.platform === "win32" }, () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-symlink-private-"));
  try {
    fs.mkdirSync(path.join(tempDir, "src/parser/internal"), { recursive: true });
    fs.mkdirSync(path.join(tempDir, "src/parser"), { recursive: true });
    fs.mkdirSync(path.join(tempDir, "src/reporting"), { recursive: true });
    fs.writeFileSync(path.join(tempDir, "src/parser/public.ts"), "export const parse = true;\n");
    fs.writeFileSync(path.join(tempDir, "src/parser/internal/tokenizer.ts"), "export const token = true;\n");
    fs.symlinkSync(path.join(tempDir, "src/parser/internal/tokenizer.ts"), path.join(tempDir, "src/reporting/sneaky.ts"));
    fs.writeFileSync(path.join(tempDir, "src/reporting/public.ts"), "export { token } from './sneaky';\n");
    writeJson(path.join(tempDir, "cellfence.manifest.json"), {
      schemaVersion: "cellfence.manifest.v1",
      governance: {
        requireOwnership: true,
        include: ["src/**"],
        exclude: [],
      },
      cells: [
        {
          id: "parser",
          ownedPaths: ["src/parser/**"],
          publicEntry: "src/parser/public.ts",
          publicSymbols: ["parse"],
          consumes: [],
          producesArtifacts: [],
        },
        {
          id: "reporting",
          ownedPaths: ["src/reporting/**"],
          publicEntry: "src/reporting/public.ts",
          publicSymbols: ["token"],
          consumes: [],
          producesArtifacts: [],
        },
      ],
    });

    const result = runCli(["check", "--json"], tempDir);
    assert.equal(result.status, 1);
    const parsed = JSON.parse(result.stdout);
    assert.ok(parsed.findings.some((finding) =>
      finding.ruleId === "CELLFENCE_SYMLINK_TARGET_OUTSIDE_OWNERSHIP"
      && finding.filePath === "src/reporting/sneaky.ts"
    ));
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

test("CLI baseline HMAC seal rejects hand-edited baseline expansion", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-baseline-seal-"));
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

    const env = { CELLFENCE_BASELINE_HMAC_KEY: "test-baseline-secret", CELLFENCE_BASELINE_HMAC_KEY_ID: "test-key" };
    const create = runCliWithEnv(["baseline", "create"], tempDir, env);
    assert.equal(create.status, 0, create.stderr || create.stdout);
    const baselinePath = path.join(tempDir, "cellfence.baseline.json");
    const baseline = JSON.parse(fs.readFileSync(baselinePath, "utf8"));
    assert.equal(baseline.seal.algorithm, "hmac-sha256");
    assert.equal(baseline.seal.keyId, "test-key");

    const cleanCheck = runCliWithEnv(["baseline", "check", "--json"], tempDir, env);
    assert.equal(cleanCheck.status, 0, cleanCheck.stderr || cleanCheck.stdout);

    baseline.cells.core.publicSymbolSet.push("backdoor");
    baseline.cells.core.publicSymbols += 1;
    writeJson(baselinePath, baseline);

    const tampered = runCliWithEnv(["baseline", "check", "--json"], tempDir, env);
    assert.equal(tampered.status, 1);
    const parsed = JSON.parse(tampered.stdout);
    assert.ok(parsed.findings.some((finding) => finding.ruleId === "CELLFENCE_BASELINE_SEAL_INVALID"));
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("CLI baseline check does not print the next public surface hash in human output", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-baseline-hash-redaction-"));
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
    assert.equal(runCli(["baseline", "create"], tempDir).status, 0);

    fs.writeFileSync(path.join(tempDir, "src/core/public.ts"), "export const core = true;\nexport const extra = true;\n");
    const manifest = JSON.parse(fs.readFileSync(path.join(tempDir, "cellfence.manifest.json"), "utf8"));
    manifest.cells[0].publicSymbols.push("extra");
    writeJson(path.join(tempDir, "cellfence.manifest.json"), manifest);

    const result = runCli(["baseline", "check"], tempDir);
    assert.equal(result.status, 1);
    assert.doesNotMatch(result.stdout, / to [a-f0-9]{64}/);
    assert.match(result.stdout, /public surface signature hash changed from the accepted baseline/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
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

test("CLI prune reports dead declarations from manifest, waivers, and baseline", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-prune-cli-"));
  try {
    fs.mkdirSync(path.join(tempDir, "src/producer"), { recursive: true });
    fs.mkdirSync(path.join(tempDir, "src/consumer"), { recursive: true });
    fs.mkdirSync(path.join(tempDir, "src/unused"), { recursive: true });
    fs.writeFileSync(path.join(tempDir, "src/producer/public.ts"), "export const used = true;\nexport const unused = true;\n");
    fs.writeFileSync(
      path.join(tempDir, "src/consumer/public.ts"),
      [
        "// cellfence-ignore CELLFENCE_PRIVATE_IMPORT expires:2099-01-01 approved-by:test-owner reason:temporary stale prune fixture",
        "import { used } from '../producer/public';",
        "export const consumer = used;",
        "",
      ].join("\n"),
    );
    fs.writeFileSync(path.join(tempDir, "src/unused/public.ts"), "export const unusedCell = true;\n");
    writeJson(path.join(tempDir, "cellfence.manifest.json"), {
      schemaVersion: "cellfence.manifest.v1",
      cells: [{
        id: "producer",
        ownedPaths: ["src/producer/**"],
        publicEntry: "src/producer/public.ts",
        publicSymbols: ["used", "unused"],
        consumes: [],
        producesArtifacts: [{ id: "snapshots", paths: ["src/producer/artifacts/**"] }],
      }, {
        id: "consumer",
        ownedPaths: ["src/consumer/**"],
        publicEntry: "src/consumer/public.ts",
        publicSymbols: ["consumer"],
        consumes: [{ cell: "producer" }, { cell: "unused" }],
        producesArtifacts: [],
      }, {
        id: "unused",
        ownedPaths: ["src/unused/**"],
        publicEntry: "src/unused/public.ts",
        publicSymbols: ["unusedCell"],
        consumes: [],
        producesArtifacts: [],
      }],
    });
    writeJson(path.join(tempDir, "cellfence.baseline.json"), {
      schemaVersion: "cellfence.baseline.v1",
      generatedAt: "2026-01-01T00:00:00.000Z",
      cells: {
        consumer: {
          ownedPathPatterns: 1,
          publicSymbols: 1,
          publicSurfaceLines: 20,
          crossCellDependencies: 1,
          resourceAccesses: [{ kind: "database", access: "read", selector: "app.old" }],
        },
      },
    });

    const result = runCli(["prune", "--baseline", "cellfence.baseline.json", "--json"], tempDir);
    assert.equal(result.status, 1, result.stderr || result.stdout);
    const report = JSON.parse(result.stdout);
    assert.equal(report.schemaVersion, "cellfence.prune.v1");
    assert.equal(report.ok, false);
    assert.ok(report.candidates.some((candidate) => candidate.kind === "unused-consumer" && candidate.producerCellId === "unused"));
    assert.ok(report.candidates.some((candidate) => candidate.kind === "unused-public-symbol" && candidate.symbol === "unused"));
    assert.ok(report.candidates.some((candidate) => candidate.kind === "unconsumed-artifact-lane" && candidate.artifactLaneId === "snapshots"));
    assert.ok(report.candidates.some((candidate) => candidate.kind === "stale-waiver"));
    assert.ok(report.candidates.some((candidate) => candidate.kind === "stale-baseline-resource" && candidate.resource.selector === "app.old"));

    const human = runCli(["prune", "--baseline", "cellfence.baseline.json"], tempDir);
    assert.equal(human.status, 1);
    assert.match(human.stdout, /CellFence prune found/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("CLI prune reports a clean human result when declarations are all trimmed", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-prune-clean-"));
  try {
    fs.mkdirSync(path.join(tempDir, "src/core"), { recursive: true });
    fs.writeFileSync(path.join(tempDir, "src/core/public.ts"), "\n");
    writeJson(path.join(tempDir, "cellfence.manifest.json"), {
      schemaVersion: "cellfence.manifest.v1",
      cells: [{
        id: "core",
        ownedPaths: ["src/core/**"],
        publicEntry: "src/core/public.ts",
        publicSymbols: [],
        consumes: [],
        producesArtifacts: [],
      }],
    });
    const result = runCli(["prune"], tempDir);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /found no dead declarations/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

function writeFakeGh(binDir, protection) {
  fs.mkdirSync(binDir, { recursive: true });
  const script = [
    "#!/usr/bin/env node",
    "if (process.argv.includes('--version')) { console.log('gh version test'); process.exit(0); }",
    "if (process.env.CELLFENCE_FAKE_GH_FAIL === '1') { console.error('protection missing'); process.exit(1); }",
    "if (process.argv[2] === 'api') { console.log(process.env.CELLFENCE_FAKE_PROTECTION); process.exit(0); }",
    "process.exit(1);",
    "",
  ].join("\n");
  fs.writeFileSync(path.join(binDir, "gh"), script);
  fs.chmodSync(path.join(binDir, "gh"), 0o755);
  return {
    PATH: `${binDir}${path.delimiter}${process.env.PATH}`,
    CELLFENCE_FAKE_PROTECTION: JSON.stringify(protection),
  };
}

test("CLI doctor verifies local fence state and GitHub required checks", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-doctor-cli-"));
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
    assert.equal(runCli(["install", "--json"], tempDir).status, 0);
    const env = writeFakeGh(path.join(tempDir, "bin"), {
      required_status_checks: {
        contexts: ["CellFence"],
        checks: [{ context: "coverage" }],
      },
    });
    const result = runCliWithEnv(["doctor", "--repo", "owner/repo", "--branch", "main", "--required-check", "CellFence", "--json"], tempDir, env);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.schemaVersion, "cellfence.doctor.v1");
    assert.ok(parsed.checks.some((check) => check.id === "github-required-check" && check.status === "pass"));

    const missing = runCliWithEnv(["doctor", "--repo", "owner/repo", "--required-check", "missing", "--json"], tempDir, env);
    assert.equal(missing.status, 1);
    assert.ok(JSON.parse(missing.stdout).checks.some((check) => check.id === "github-required-check" && check.status === "fail"));

    const contextsOnlyEnv = writeFakeGh(path.join(tempDir, "contexts-only-bin"), {
      required_status_checks: {
        contexts: ["CellFence"],
      },
    });
    const contextsOnly = runCliWithEnv(["doctor", "--repo", "owner/repo", "--required-check", "CellFence", "--json"], tempDir, contextsOnlyEnv);
    assert.equal(contextsOnly.status, 0, contextsOnly.stderr || contextsOnly.stdout);
    assert.ok(JSON.parse(contextsOnly.stdout).checks.some((check) => check.id === "github-required-check" && check.status === "pass"));
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("CLI doctor reports GitHub verification failures and human-readable output", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-doctor-failure-"));
  try {
    const env = {
      ...writeFakeGh(path.join(tempDir, "bin"), {}),
      CELLFENCE_FAKE_GH_FAIL: "1",
    };
    const result = runCliWithEnv(["doctor", "--repo", "owner/repo"], tempDir, env);
    assert.equal(result.status, 1);
    assert.match(result.stdout, /FAIL manifest-present/);
    assert.match(result.stdout, /FAIL github-branch-protection/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("CLI doctor handles unavailable gh and inferred GitHub remotes", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-doctor-remote-"));
  try {
    fs.mkdirSync(path.join(tempDir, "empty-bin"), { recursive: true });
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
    runGit(["init"], tempDir);
    runGit(["remote", "add", "origin", "https://github.com/owner/repo.git"], tempDir);
    const noGhResult = runCliWithEnv(["doctor", "--repo", "owner/repo", "--json"], tempDir, { PATH: path.join(tempDir, "empty-bin") });
    assert.equal(noGhResult.status, 0, noGhResult.stderr || noGhResult.stdout);
    assert.ok(JSON.parse(noGhResult.stdout).checks.some((check) =>
      check.id === "github-branch-protection"
      && check.status === "warning"
      && check.details.repo === "owner/repo"));

    const httpsEnv = writeFakeGh(path.join(tempDir, "https-bin"), {});
    const inferredHttps = runCliWithEnv(["doctor", "--json"], tempDir, httpsEnv);
    assert.equal(inferredHttps.status, 0, inferredHttps.stderr || inferredHttps.stdout);
    assert.ok(JSON.parse(inferredHttps.stdout).checks.some((check) =>
      check.id === "github-branch-protection"
      && check.details.repo === "owner/repo"));

    runGit(["remote", "set-url", "origin", "git@github.com:owner/ssh-repo.git"], tempDir);
    const env = writeFakeGh(path.join(tempDir, "bin"), {
      required_status_checks: {
        checks: [{}, "invalid-check-entry", { context: 42 }],
      },
    });
    const inferredSsh = runCliWithEnv(["doctor", "--json"], tempDir, env);
    assert.equal(inferredSsh.status, 0, inferredSsh.stderr || inferredSsh.stdout);
    assert.ok(JSON.parse(inferredSsh.stdout).checks.some((check) =>
      check.id === "github-branch-protection"
      && check.details.repo === "owner/ssh-repo"));
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("CLI doctor catches drifted managed blocks and unmanaged instruction files", () => {
  const unmanagedDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-doctor-unmanaged-"));
  const driftedDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-doctor-drifted-"));
  try {
    for (const tempDir of [unmanagedDir, driftedDir]) {
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
    }

    fs.writeFileSync(path.join(unmanagedDir, "AGENTS.md"), "plain agent instruction file\n");
    const unmanaged = runCli(["doctor", "--json"], unmanagedDir);
    assert.equal(unmanaged.status, 0, unmanaged.stderr || unmanaged.stdout);
    assert.ok(JSON.parse(unmanaged.stdout).checks.some((check) =>
      check.id === "agent-instructions-installed"
      && check.status === "warning"));

    assert.equal(runCli(["install", "--json"], driftedDir).status, 0);
    const agentsPath = path.join(driftedDir, "AGENTS.md");
    fs.writeFileSync(agentsPath, fs.readFileSync(agentsPath, "utf8").replace("Before editing", "Before editing carefully"));
    const drifted = runCli(["doctor", "--json"], driftedDir);
    assert.equal(drifted.status, 1);
    assert.ok(JSON.parse(drifted.stdout).checks.some((check) =>
      check.id === "agent-instructions-installed"
      && check.status === "fail"));
  } finally {
    fs.rmSync(unmanagedDir, { recursive: true, force: true });
    fs.rmSync(driftedDir, { recursive: true, force: true });
  }
});

test("CLI doctor remains useful without GitHub metadata", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-doctor-local-"));
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
    const result = runCli(["doctor", "--json"], tempDir);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const parsed = JSON.parse(result.stdout);
    assert.ok(parsed.checks.some((check) => check.id === "github-repository" && check.status === "warning"));
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("CLI lab runs built-in red-team scenarios", () => {
  const result = runCli(["lab", "--json"]);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.schemaVersion, "cellfence.lab.v1");
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.scenarios.map((scenario) => scenario.id), [
    "private-import",
    "pending-waiver",
    "locked-baseline-expansion",
  ]);
  assert.ok(parsed.scenarios.every((scenario) => scenario.ok));

  const human = runCli(["lab"]);
  assert.equal(human.status, 0);
  assert.match(human.stdout, /PASS private-import/);
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

test("CLI changed check rejects cross-cell ownership moves", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-cross-cell-move-"));
  fs.mkdirSync(path.join(tempDir, "src/billing"), { recursive: true });
  fs.mkdirSync(path.join(tempDir, "src/collection"), { recursive: true });
  fs.writeFileSync(path.join(tempDir, "src/billing/public.ts"), "export const billing = true;\n");
  fs.writeFileSync(path.join(tempDir, "src/billing/calculate.ts"), "export const calculate = 1;\n");
  fs.writeFileSync(path.join(tempDir, "src/collection/public.ts"), "export const collection = true;\n");
  writeJson(path.join(tempDir, "cellfence.manifest.json"), {
    schemaVersion: "cellfence.manifest.v1",
    cells: [
      {
        id: "billing",
        ownedPaths: ["src/billing/**"],
        publicEntry: "src/billing/public.ts",
        publicSymbols: ["billing"],
        consumes: [],
        producesArtifacts: [],
      },
      {
        id: "collection",
        ownedPaths: ["src/collection/**"],
        publicEntry: "src/collection/public.ts",
        publicSymbols: ["collection"],
        consumes: [],
        producesArtifacts: [],
      },
    ],
  });
  runGit(["init"], tempDir);
  runGit(["config", "user.email", "cellfence@example.invalid"], tempDir);
  runGit(["config", "user.name", "CellFence Test"], tempDir);
  runGit(["add", "."], tempDir);
  runGit(["commit", "-m", "base"], tempDir);

  runGit(["mv", "src/billing/calculate.ts", "src/collection/calculate.ts"], tempDir);

  const result = runCli(["check", "--changed", "--base", "HEAD", "--json"], tempDir);
  assert.equal(result.status, 1);
  const parsed = JSON.parse(result.stdout);
  const movementFinding = parsed.findings.find((finding) => finding.ruleId === "CELLFENCE_CROSS_CELL_MOVE");
  assert.ok(movementFinding);
  assert.equal(movementFinding.producerCellId, "billing");
  assert.equal(movementFinding.cellId, "collection");
  assert.equal(movementFinding.details.fromPath, "src/billing/calculate.ts");
  assert.equal(movementFinding.details.toPath, "src/collection/calculate.ts");
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
    "--repo=owner/repo",
    "--branch=main",
    "--required-check=CellFence",
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
