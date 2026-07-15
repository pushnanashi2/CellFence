import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { checkWriteAccess } from "../packages/engine/dist/index.js";
import { decideToolCall, pathsForToolCall } from "../packages/mcp-proxy/dist/index.js";

const root = process.cwd();
const proxyPath = path.join(root, "packages/mcp-proxy/dist/index.js");
const mockServerPath = path.join(root, "tests/fixtures/mock-mcp-server.mjs");

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function readJsonLines(filePath) {
  if (!fs.existsSync(filePath)) return [];
  return fs.readFileSync(filePath, "utf8").trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
}

async function waitFor(predicate, label) {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timed out waiting for ${label}`);
}

function writeProject(rootDir) {
  fs.mkdirSync(path.join(rootDir, "src/owned"), { recursive: true });
  fs.mkdirSync(path.join(rootDir, "src/other"), { recursive: true });
  fs.writeFileSync(path.join(rootDir, "src/owned/public.ts"), "export const owned = true;\n");
  fs.writeFileSync(path.join(rootDir, "src/other/public.ts"), "export const other = true;\n");
  writeJson(path.join(rootDir, "cellfence.manifest.json"), {
    schemaVersion: "cellfence.manifest.v1",
    governance: {
      requireOwnership: true,
      include: ["src/**"],
      exclude: [],
    },
    cells: [
      {
        id: "owned",
        ownedPaths: ["src/owned/**"],
        publicEntry: "src/owned/public.ts",
        publicSymbols: ["owned"],
        consumes: [],
        producesArtifacts: [],
      },
      {
        id: "other",
        ownedPaths: ["src/other/**"],
        publicEntry: "src/other/public.ts",
        publicSymbols: ["other"],
        consumes: [],
        producesArtifacts: [],
      },
    ],
  });
  writeJson(path.join(rootDir, ".cellfence/claims.json"), {
    schemaVersion: "cellfence.claims.v1",
    claims: [
      {
        id: "claim-owned",
        agent: "agent-owned",
        task: "mcp proxy test",
        cells: ["owned"],
        paths: [],
        symbols: [],
        resources: [],
        artifactLanes: [],
        createdAt: "2026-01-01T00:00:00.000Z",
        expiresAt: "2099-01-01T00:00:00.000Z",
      },
    ],
  });
}

function createRpcClient(child) {
  let nextId = 1;
  let buffer = "";
  const pending = new Map();
  child.stdout.on("data", (chunk) => {
    buffer += chunk.toString("utf8");
    let newlineIndex = buffer.indexOf("\n");
    while (newlineIndex !== -1) {
      const line = buffer.slice(0, newlineIndex).trim();
      buffer = buffer.slice(newlineIndex + 1);
      if (line) {
        const message = JSON.parse(line);
        const waiting = pending.get(message.id);
        if (waiting) {
          pending.delete(message.id);
          waiting(message);
        }
      }
      newlineIndex = buffer.indexOf("\n");
    }
  });
  return {
    send(method, params = {}) {
      const id = nextId;
      nextId += 1;
      const message = { jsonrpc: "2.0", id, method, params };
      const response = new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`timed out waiting for ${method}`));
        }, 5000);
        pending.set(id, (value) => {
          clearTimeout(timer);
          resolve(value);
        });
      });
      child.stdin.write(`${JSON.stringify(message)}\n`);
      return response;
    },
  };
}

async function withProxy(rootDir, mode, fn) {
  const mockLog = path.join(rootDir, `mock-${mode}.jsonl`);
  const auditLog = path.join(rootDir, `audit-${mode}.jsonl`);
  const child = spawn(process.execPath, [
    proxyPath,
    "--agent", "agent-owned",
    "--root", rootDir,
    "--mode", mode,
    "--audit-log", auditLog,
    "--",
    process.execPath,
    mockServerPath,
  ], {
    cwd: root,
    env: {
      ...process.env,
      MOCK_MCP_LOG: mockLog,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString("utf8");
  });
  const rpc = createRpcClient(child);
  try {
    await rpc.send("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "cellfence-test", version: "1.0.0" },
    });
    await fn(rpc, { mockLog, auditLog });
  } finally {
    child.kill();
    await new Promise((resolve) => child.once("close", resolve));
  }
  assert.equal(stderr, "");
}

test("write access API allows claimed paths and denies unclaimed or escaping paths", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-write-access-"));
  const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-outside-"));
  try {
    writeProject(rootDir);
    const allowed = checkWriteAccess({
      rootDir,
      agent: "agent-owned",
      paths: ["src/owned/new.ts"],
    });
    assert.equal(allowed.ok, true, JSON.stringify(allowed.findings));
    assert.equal(allowed.paths[0].allowed, true);
    assert.deepEqual(allowed.paths[0].claimIds, ["claim-owned"]);

    const denied = checkWriteAccess({
      rootDir,
      agent: "agent-owned",
      paths: ["src/other/new.ts"],
    });
    assert.equal(denied.ok, false);
    assert.equal(denied.paths[0].allowed, false);
    assert.equal(denied.findings[0].ruleId, "CELLFENCE_UNCLAIMED_CHANGE");

    fs.symlinkSync(outsideDir, path.join(rootDir, "src/owned/link-out"));
    const escaped = checkWriteAccess({
      rootDir,
      agent: "agent-owned",
      paths: ["src/owned/link-out/escape.ts"],
    });
    assert.equal(escaped.ok, false);
    assert.equal(escaped.paths[0].allowed, false);
    assert.match(escaped.paths[0].reason, /escapes repository root/);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
    fs.rmSync(outsideDir, { recursive: true, force: true });
  }
});

test("proxy path extraction supports configured write tools", () => {
  assert.equal(pathsForToolCall("read_file", { path: "src/a.ts" }, { write_file: ["path"] }), undefined);
  assert.deepEqual(pathsForToolCall("write_file", { path: "src/a.ts" }, { write_file: ["path"] }), ["src/a.ts"]);
  assert.deepEqual(pathsForToolCall("write_file", { target: { file_path: "src/a.ts" } }, { write_file: ["target.file_path"] }), ["src/a.ts"]);
});

test("proxy decision defaults to fail-closed for write tools with no path argument", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-mcp-decision-"));
  try {
    writeProject(rootDir);
    const decision = decideToolCall({
      rootDir,
      agent: "agent-owned",
      mode: "enforce",
      failMode: "closed",
      downstreamCommand: process.execPath,
      downstreamArgs: [],
      writeTools: { write_file: ["path"] },
    }, "write_file", { content: "missing path" });
    assert.equal(decision.shouldForward, false);
    assert.equal(decision.auditDecision, "deny");
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("MCP proxy forwards reads and claimed writes, but denies unclaimed writes before downstream", async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-mcp-enforce-"));
  try {
    writeProject(rootDir);
    await withProxy(rootDir, "enforce", async (rpc, logs) => {
      const tools = await rpc.send("tools/list");
      assert.deepEqual(tools.result.tools.map((tool) => tool.name), ["read_file", "write_file"]);

      const read = await rpc.send("tools/call", { name: "read_file", arguments: { path: "src/other/public.ts" } });
      assert.equal(read.result.content[0].text, "called read_file");

      const allowedWrite = await rpc.send("tools/call", { name: "write_file", arguments: { path: "src/owned/new.ts", content: "ok" } });
      assert.equal(allowedWrite.result.content[0].text, "called write_file");

      const beforeDenied = readJsonLines(logs.mockLog).length;
      const deniedWrite = await rpc.send("tools/call", { name: "write_file", arguments: { path: "src/other/new.ts", content: "no" } });
      assert.equal(deniedWrite.result.isError, true);
      assert.match(deniedWrite.result.content[0].text, /CellFence denied write_file/);
      assert.equal(readJsonLines(logs.mockLog).length, beforeDenied);

      const auditEvents = readJsonLines(logs.auditLog);
      assert.deepEqual(auditEvents.map((event) => event.decision), ["allow", "allow", "deny"]);
      assert.equal(auditEvents[2].paths[0], "src/other/new.ts");
    });
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("MCP proxy dry-run logs denied writes but still forwards them", async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-mcp-dry-run-"));
  try {
    writeProject(rootDir);
    await withProxy(rootDir, "dry-run", async (rpc, logs) => {
      const result = await rpc.send("tools/call", { name: "write_file", arguments: { path: "src/other/new.ts", content: "dry" } });
      assert.equal(result.result.content[0].text, "called write_file");
      await waitFor(() => readJsonLines(logs.mockLog).length === 1, "dry-run downstream log");
      assert.equal(readJsonLines(logs.mockLog).length, 1);
      const auditEvents = readJsonLines(logs.auditLog);
      assert.equal(auditEvents[0].decision, "dry-run-deny");
      assert.equal(auditEvents[0].paths[0], "src/other/new.ts");
    });
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});
