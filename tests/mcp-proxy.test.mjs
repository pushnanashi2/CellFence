import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { checkWriteAccess } from "../packages/engine/dist/index.js";
import { __testing, decideToolCall, main, parseProxyArgs, pathsForToolCall } from "../packages/mcp-proxy/dist/index.js";

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

function writeFeatureServer(rootDir) {
  const serverPath = path.join(rootDir, "feature-mcp-server.mjs");
  fs.writeFileSync(serverPath, `import readline from "node:readline";

function respond(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\\n");
}

function notify(method, params) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\\n");
}

const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on("line", (line) => {
  if (!line.trim()) return;
  const request = JSON.parse(line);
  if (!("id" in request)) return;
  if (request.method === "initialize") {
    respond(request.id, {
      protocolVersion: request.params.protocolVersion,
      capabilities: {
        tools: { listChanged: true },
        resources: { subscribe: true, listChanged: true },
        prompts: { listChanged: true },
        completions: {},
      },
      serverInfo: { name: "feature-mcp", version: "1.0.0" },
    });
  } else if (request.method === "tools/list") {
    respond(request.id, {
      tools: [
        { name: "read_file", inputSchema: { type: "object" } },
        { name: "write_file", inputSchema: { type: "object" } },
        { name: "run_command", inputSchema: { type: "object" } },
      ],
    });
    notify("notifications/tools/list_changed");
  } else if (request.method === "tools/call") {
    respond(request.id, { content: [{ type: "text", text: "called " + request.params.name }] });
  } else if (request.method === "resources/list") {
    respond(request.id, { resources: [{ uri: "memory://guide", name: "Guide" }] });
    notify("notifications/resources/list_changed");
  } else if (request.method === "resources/templates/list") {
    respond(request.id, { resourceTemplates: [{ uriTemplate: "memory://{name}", name: "Memory" }] });
  } else if (request.method === "resources/read") {
    respond(request.id, { contents: [{ uri: request.params.uri, text: "resource body" }] });
  } else if (request.method === "resources/subscribe") {
    respond(request.id, {});
    notify("notifications/resources/updated", { uri: request.params.uri });
  } else if (request.method === "resources/unsubscribe") {
    respond(request.id, {});
  } else if (request.method === "prompts/list") {
    respond(request.id, { prompts: [{ name: "greet", arguments: [{ name: "name" }] }] });
    notify("notifications/prompts/list_changed");
  } else if (request.method === "prompts/get") {
    respond(request.id, {
      description: "Greeting",
      messages: [{ role: "user", content: { type: "text", text: "Hello " + request.params.arguments.name } }],
    });
  } else if (request.method === "completion/complete") {
    respond(request.id, { completion: { values: [request.params.argument.value + "lice"] } });
  } else {
    process.stdout.write(JSON.stringify({
      jsonrpc: "2.0",
      id: request.id,
      error: { code: -32601, message: "unknown method " + request.method },
    }) + "\\n");
  }
});
`);
  return serverPath;
}

function createRpcClient(child) {
  let nextId = 1;
  let buffer = "";
  const pending = new Map();
  const notifications = [];
  child.stdout.on("data", (chunk) => {
    buffer += chunk.toString("utf8");
    let newlineIndex = buffer.indexOf("\n");
    while (newlineIndex !== -1) {
      const line = buffer.slice(0, newlineIndex).trim();
      buffer = buffer.slice(newlineIndex + 1);
      if (line) {
        const message = JSON.parse(line);
        if (!("id" in message)) notifications.push(message);
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
    notifications,
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

async function withProxy(rootDir, mode, fn, { proxyArgs = [], serverPath = mockServerPath } = {}) {
  const mockLog = path.join(rootDir, `mock-${mode}.jsonl`);
  const auditLog = path.join(rootDir, `audit-${mode}.jsonl`);
  const child = spawn(process.execPath, [
    proxyPath,
    "--agent", "agent-owned",
    "--root", rootDir,
    "--mode", mode,
    "--audit-log", auditLog,
    ...proxyArgs,
    "--",
    process.execPath,
    serverPath,
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
    const initialization = await rpc.send("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "cellfence-test", version: "1.0.0" },
    });
    await fn(rpc, { mockLog, auditLog, initialization });
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

    const emptyPath = checkWriteAccess({
      rootDir,
      agent: "agent-owned",
      paths: [""],
    });
    assert.equal(emptyPath.ok, false);
    assert.match(emptyPath.paths[0].reason, /path is empty/);

    const absoluteAllowed = checkWriteAccess({
      rootDir,
      agent: "agent-owned",
      paths: [path.join(rootDir, "src/owned/absolute.ts")],
    });
    assert.equal(absoluteAllowed.ok, true, JSON.stringify(absoluteAllowed.findings));

    const previousCwd = process.cwd();
    process.chdir(rootDir);
    try {
      const cwdAllowed = checkWriteAccess({
        agent: "agent-owned",
        paths: ["src/owned/cwd.ts"],
      });
      assert.equal(cwdAllowed.ok, true, JSON.stringify(cwdAllowed.findings));
    } finally {
      process.chdir(previousCwd);
    }
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
    fs.rmSync(outsideDir, { recursive: true, force: true });
  }
});

test("write access API fails closed for empty agents, empty paths, missing manifests, invalid claims, and conflicts", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-write-access-failures-"));
  try {
    writeProject(rootDir);
    const emptyInputs = checkWriteAccess({
      rootDir,
      agent: " ",
      paths: [],
    });
    assert.equal(emptyInputs.ok, false);
    assert.deepEqual(emptyInputs.findings.map((finding) => finding.ruleId).sort(), [
      "CELLFENCE_CLAIM_INVALID",
      "CELLFENCE_UNCLAIMED_CHANGE",
    ]);

    const missingManifest = checkWriteAccess({
      rootDir,
      manifestPath: "missing-manifest.json",
      agent: "agent-owned",
      paths: ["src/owned/new.ts"],
    });
    assert.equal(missingManifest.ok, false);
    assert.equal(missingManifest.paths[0].reason, "manifest is unavailable");

    writeJson(path.join(rootDir, ".cellfence/bad-claims.json"), { schemaVersion: "wrong", claims: [] });
    const badClaims = checkWriteAccess({
      rootDir,
      claimsPath: ".cellfence/bad-claims.json",
      agent: "agent-owned",
      paths: ["src/owned/new.ts"],
    });
    assert.equal(badClaims.ok, false);
    assert.equal(badClaims.paths[0].reason, "claim policy is invalid or conflicting");

    writeJson(path.join(rootDir, ".cellfence/conflicting-claims.json"), {
      schemaVersion: "cellfence.claims.v1",
      claims: [
        {
          id: "claim-owned",
          agent: "agent-owned",
          task: "current",
          cells: ["owned"],
          paths: [],
          symbols: [],
          resources: [],
          artifactLanes: [],
          createdAt: "2026-01-01T00:00:00.000Z",
          expiresAt: "2099-01-01T00:00:00.000Z",
        },
        {
          id: "claim-other",
          agent: "agent-other",
          task: "conflict",
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
    const conflict = checkWriteAccess({
      rootDir,
      claimsPath: ".cellfence/conflicting-claims.json",
      agent: "agent-owned",
      paths: ["src/owned/new.ts"],
    });
    assert.equal(conflict.ok, false);
    assert.equal(conflict.paths[0].reason, "claim policy is invalid or conflicting");
    assert.ok(conflict.findings.some((finding) => finding.ruleId === "CELLFENCE_ACTIVE_CLAIM_CONFLICT"));
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("proxy path extraction supports configured write tools", () => {
  assert.equal(pathsForToolCall("read_file", { path: "src/a.ts" }, { write_file: ["path"] }), undefined);
  assert.deepEqual(pathsForToolCall("write_file", { path: "src/a.ts" }, { write_file: ["path"] }), ["src/a.ts"]);
  assert.deepEqual(pathsForToolCall("write_file", { target: { file_path: "src/a.ts" } }, { write_file: ["target.file_path"] }), ["src/a.ts"]);
  assert.deepEqual(pathsForToolCall("write_file", { paths: ["src/a.ts", "", "src/a.ts", 7] }, { write_file: ["paths"] }), ["src/a.ts"]);
  assert.deepEqual(pathsForToolCall("apply_edits", {
    edits: [{ path: "src/a.ts" }, { path: "src/b.ts" }, { path: "src/a.ts" }, { nope: true }],
  }, { apply_edits: ["edits[].path"] }), ["src/a.ts", "src/b.ts"]);
  assert.deepEqual(pathsForToolCall("apply_edits", {
    batches: [{ edits: [{ target: { path: "src/a.ts" } }] }, { edits: [{ target: { path: "src/b.ts" } }] }],
  }, { apply_edits: ["batches[].edits[].target.path"] }), ["src/a.ts", "src/b.ts"]);
  assert.deepEqual(pathsForToolCall("write_file", 7, { write_file: ["path"] }), []);
});

test("proxy argument parser covers env defaults, file config, inline overrides, and separator args", async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-mcp-parse-"));
  try {
    writeJson(path.join(rootDir, "tools.json"), {
      unknownToolPolicy: "deny",
      readTools: ["custom_read", "custom_read"],
      writeTools: {
        custom_write: ["payload.file", "path"],
      },
    });
    const options = parseProxyArgs([
      "--root", rootDir,
      "--manifest=custom.manifest.json",
      "--claims", "claims.json",
      "--mode=dry-run",
      "--fail-mode", "open",
      "--audit-log", "audit.jsonl",
      "--tool-config", path.join(rootDir, "tools.json"),
      "--write-tool=patch_file=file_path, filename",
      "--downstream-cwd", rootDir,
      "--downstream-arg=--first",
      "--downstream-arg", "--second",
      "--",
      process.execPath,
      "-e",
      "setTimeout(()=>{}, 1)",
    ], {
      CELLFENCE_AGENT: " env-agent ",
      CELLFENCE_MCP_MODE: "enforce",
      CELLFENCE_MCP_FAIL_MODE: "closed",
      CELLFENCE_MCP_AUDIT_LOG: "env-audit.jsonl",
      CELLFENCE_MCP_DOWNSTREAM_COMMAND: "env-cmd",
    });
    assert.equal(options.rootDir, rootDir);
    assert.equal(options.manifestPath, "custom.manifest.json");
    assert.equal(options.claimsPath, "claims.json");
    assert.equal(options.agent, "env-agent");
    assert.equal(options.mode, "dry-run");
    assert.equal(options.failMode, "open");
    assert.equal(options.unknownToolPolicy, "deny");
    assert.deepEqual(options.readTools, ["custom_read"]);
    assert.equal(options.auditLogPath, "audit.jsonl");
    assert.equal(options.downstreamCommand, process.execPath);
    assert.deepEqual(options.downstreamArgs, ["-e", "setTimeout(()=>{}, 1)"]);
    assert.equal(options.downstreamCwd, rootDir);
    assert.deepEqual(options.writeTools.custom_write, ["payload.file", "path"]);
    assert.deepEqual(options.writeTools.patch_file, ["file_path", "filename"]);

    const equalsOptions = parseProxyArgs([
      `--root=${rootDir}`,
      "--manifest=manifest.json",
      "--claims=claims.json",
      "--agent=cli-agent",
      "--mode", "off",
      "--fail-mode=open",
      "--audit-log=audit.jsonl",
      `--tool-config=${path.join(rootDir, "tools.json")}`,
      "--write-tool", "replace_file=target.path",
      "--downstream-command=node",
      "--downstream-arg", "--version",
      `--downstream-cwd=${rootDir}`,
    ], {});
    assert.equal(equalsOptions.agent, "cli-agent");
    assert.equal(equalsOptions.mode, "off");
    assert.equal(equalsOptions.failMode, "open");
    assert.equal(equalsOptions.downstreamCommand, "node");
    assert.deepEqual(equalsOptions.downstreamArgs, ["--version"]);
    assert.equal(equalsOptions.downstreamCwd, rootDir);
    assert.deepEqual(equalsOptions.writeTools.replace_file, ["target.path"]);

    const separatedOptions = parseProxyArgs([
      "--root", rootDir,
      "--manifest", "manifest.json",
      "--claims", "claims.json",
      "--agent", "cli-agent",
      "--mode", "enforce",
      "--fail-mode", "closed",
      "--unknown-tool-policy", "deny",
      "--read-tool", "read_file",
      "--read-tool=inspect_file",
      "--audit-log", "audit.jsonl",
      "--downstream-command", "node",
      "--downstream-cwd", rootDir,
    ], {});
    assert.equal(separatedOptions.agent, "cli-agent");
    assert.equal(separatedOptions.manifestPath, "manifest.json");
    assert.equal(separatedOptions.claimsPath, "claims.json");
    assert.equal(separatedOptions.downstreamCommand, "node");
    assert.equal(separatedOptions.unknownToolPolicy, "deny");
    assert.deepEqual(separatedOptions.readTools, ["read_file", "inspect_file"]);

    const envOptions = parseProxyArgs([], {
      CELLFENCE_AGENT: "env-agent",
      CELLFENCE_MCP_UNKNOWN_TOOL_POLICY: "deny",
      CELLFENCE_MCP_READ_TOOLS: "read_file, inspect_file,read_file",
      CELLFENCE_MCP_DOWNSTREAM_COMMAND: "node",
    });
    assert.equal(envOptions.unknownToolPolicy, "deny");
    assert.deepEqual(envOptions.readTools, ["read_file", "inspect_file"]);

    const separatorFallback = parseProxyArgs(["--"], {
      CELLFENCE_AGENT: "fallback-agent",
      CELLFENCE_MCP_DOWNSTREAM_COMMAND: "fallback-cmd",
    });
    assert.equal(separatorFallback.downstreamCommand, "fallback-cmd");

    const missingRootValue = parseProxyArgs(["--root"], {
      CELLFENCE_AGENT: "fallback-agent",
      CELLFENCE_MCP_DOWNSTREAM_COMMAND: "fallback-cmd",
    });
    assert.equal(missingRootValue.rootDir, process.cwd());

    const missingArgValue = parseProxyArgs(["--downstream-arg"], {
      CELLFENCE_AGENT: "fallback-agent",
      CELLFENCE_MCP_DOWNSTREAM_COMMAND: "fallback-cmd",
    });
    assert.deepEqual(missingArgValue.downstreamArgs, []);

    assert.equal(await main(["--help"], {}), 0);
    assert.equal(await main(["--mode=bad", "--agent=a", "--downstream-command=node"], {}), 2);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("proxy argument parser rejects malformed modes, write tools, and configs", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-mcp-parse-errors-"));
  try {
    writeJson(path.join(rootDir, "bad-tools.json"), { writeTools: { write_file: [] } });
    writeJson(path.join(rootDir, "not-tools.json"), { nope: true });
    writeJson(path.join(rootDir, "bad-read-tools.json"), { readTools: ["read_file", 7] });
    writeJson(path.join(rootDir, "bad-policy.json"), { unknownToolPolicy: "maybe" });
    assert.throws(() => parseProxyArgs(["--agent=a", "--downstream-command=node"], { CELLFENCE_MCP_MODE: "bad" }), /invalid mode bad/);
    assert.throws(() => parseProxyArgs(["--agent=a", "--downstream-command=node"], { CELLFENCE_MCP_FAIL_MODE: "maybe" }), /invalid fail mode maybe/);
    assert.throws(() => parseProxyArgs(["--agent=a", "--downstream-command=node"], { CELLFENCE_MCP_UNKNOWN_TOOL_POLICY: "maybe" }), /invalid unknown tool policy maybe/);
    assert.throws(() => parseProxyArgs(["--write-tool", "broken", "--agent=a", "--downstream-command=node"], {}), /NAME=path/);
    assert.throws(() => parseProxyArgs(["--write-tool", "=path", "--agent=a", "--downstream-command=node"], {}), /tool name/);
    assert.throws(() => parseProxyArgs(["--tool-config", path.join(rootDir, "bad-tools.json"), "--agent=a", "--downstream-command=node"], {}), /must list at least one path key/);
    assert.throws(() => parseProxyArgs(["--tool-config", path.join(rootDir, "not-tools.json"), "--agent=a", "--downstream-command=node"], {}), /tool config must be an object/);
    assert.throws(() => parseProxyArgs(["--tool-config", path.join(rootDir, "bad-read-tools.json"), "--agent=a", "--downstream-command=node"], {}), /readTools must be an array/);
    assert.throws(() => parseProxyArgs(["--tool-config", path.join(rootDir, "bad-policy.json"), "--agent=a", "--downstream-command=node"], {}), /invalid unknown tool policy maybe/);
    assert.throws(() => parseProxyArgs(["--tool-config", "--agent=a", "--downstream-command=node"], {}), /ENOENT|no such file/i);
    assert.throws(() => parseProxyArgs(["--agent=a", "--downstream-command=node", "--tool-config"], {}), /ENOENT|no such file/i);
    assert.throws(() => parseProxyArgs(["--write-tool", "", "--agent=a", "--downstream-command=node"], {}), /NAME=path|tool name/);
    assert.throws(() => parseProxyArgs(["--read-tool", "", "--agent=a", "--downstream-command=node"], {}), /must include a tool name/);
    assert.throws(() => parseProxyArgs(["--unknown-tool-policy=maybe", "--agent=a", "--downstream-command=node"], {}), /invalid unknown tool policy maybe/);
    assert.throws(() => parseProxyArgs(["--unknown-tool-policy", "--agent=a", "--downstream-command=node"], {}), /invalid unknown tool policy \(empty\)/);
    assert.throws(() => parseProxyArgs(["--unknown-tool-policy=", "--agent=a", "--downstream-command=node"], {}), /invalid unknown tool policy \(empty\)/);
    assert.throws(() => parseProxyArgs(["--agent=a", "--downstream-command=node"], { CELLFENCE_MCP_UNKNOWN_TOOL_POLICY: "" }), /invalid unknown tool policy \(empty\)/);
    assert.throws(() => parseProxyArgs(["--agent"], { CELLFENCE_MCP_DOWNSTREAM_COMMAND: "node" }), /missing --agent/);
    assert.throws(() => parseProxyArgs(["--agent=a", "--downstream-command"], {}), /missing --downstream-command/);
    assert.throws(() => parseProxyArgs(["--agent=a", "--downstream-command=node", "--unknown"], {}), /unknown argument --unknown/);
    assert.throws(() => parseProxyArgs(["--downstream-command=node"], {}), /missing --agent/);
    assert.throws(() => parseProxyArgs(["--agent=a"], {}), /missing --downstream-command/);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("proxy path extraction treats prototype names as unknown tools", () => {
  assert.equal(pathsForToolCall("constructor", { path: "src/private.ts" }, { write_file: ["path"] }), undefined);
  assert.equal(pathsForToolCall("toString", { path: "src/private.ts" }, { write_file: ["path"] }), undefined);
});

test("proxy downstream environment is filtered to an explicit allowlist (H-3)", () => {
  const safeEnv = __testing.safeDownstreamEnvironment({
    PATH: "/usr/bin:/bin",
    HOME: "/tmp/cellfence-home-test",
    USER: "test",
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    TZ: "UTC",
    MOCK_MCP_LOG: "/tmp/log",
    // Operator secrets that must never leak to the downstream.
    CELLFENCE_BASELINE_HMAC_KEY: "super-secret-hmac",
    CELLFENCE_BASELINE_HMAC_KEY_ID: "operator-1",
    CELLFENCE_BASELINE_ED25519_PRIVATE_KEY: "-----BEGIN PRIVATE KEY-----\n...",
    CELLFENCE_BASELINE_ED25519_KEY_ID: "operator-1",
    NPM_TOKEN: "npm-secret",
    GITHUB_TOKEN: "ghp_secret",
    AWS_SECRET_ACCESS_KEY: "aws-secret",
    // Proxy configuration that the downstream legitimately needs.
    CELLFENCE_MCP_MODE: "enforce",
    CELLFENCE_MCP_AUDIT_LOG: "/tmp/audit",
    // Unrelated env that should be dropped.
    RANDOM_NOISE: "drop me",
    DATABASE_URL: "postgres://user:pass@host/db",
  });
  // Allowed names come through verbatim.
  assert.equal(safeEnv.PATH, "/usr/bin:/bin");
  assert.equal(safeEnv.HOME, "/tmp/cellfence-home-test");
  assert.equal(safeEnv.USER, "test");
  assert.equal(safeEnv.LANG, "C.UTF-8");
  assert.equal(safeEnv.LC_ALL, "C.UTF-8");
  assert.equal(safeEnv.TZ, "UTC");
  // 0.4.x (N-9): the audit log path (CELLFENCE_MCP_AUDIT_LOG) and
  // the unknown-tool policy (CELLFENCE_MCP_UNKNOWN_TOOL_POLICY)
  // must NOT reach the downstream because they expose operator
  // state and let a caller override the guard. MOCK_MCP_LOG, on
  // the other hand, lives in a separate test-harness namespace
  // (MOCK_ prefix) that the proxy forwards intact so the mock
  // MCP server can find its JSONL log file. The proxy is the
  // boundary: production surfaces (CELLFENCE_*, PATH, HOME, ...)
  // are filtered, and the mock surface is honoured.
  assert.equal(safeEnv.MOCK_MCP_LOG, "/tmp/log");
  assert.equal(safeEnv.CELLFENCE_MCP_AUDIT_LOG, undefined);
  // The proxy's own config is forwarded.
  assert.equal(safeEnv.CELLFENCE_MCP_MODE, "enforce");
  // Secrets and unrelated env are dropped.
  assert.equal(safeEnv.CELLFENCE_BASELINE_HMAC_KEY, undefined);
  assert.equal(safeEnv.CELLFENCE_BASELINE_HMAC_KEY_ID, undefined);
  assert.equal(safeEnv.CELLFENCE_BASELINE_ED25519_PRIVATE_KEY, undefined);
  assert.equal(safeEnv.CELLFENCE_BASELINE_ED25519_KEY_ID, undefined);
  assert.equal(safeEnv.NPM_TOKEN, undefined);
  assert.equal(safeEnv.GITHUB_TOKEN, undefined);
  assert.equal(safeEnv.AWS_SECRET_ACCESS_KEY, undefined);
  assert.equal(safeEnv.RANDOM_NOISE, undefined);
  assert.equal(safeEnv.DATABASE_URL, undefined);
  // The output must be a plain object (not process.env) so callers
  // can't mutate the parent's environment by accident.
  assert.equal(Object.getPrototypeOf(safeEnv), Object.prototype);
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

    const failOpenDecision = decideToolCall({
      rootDir,
      agent: "agent-owned",
      mode: "enforce",
      failMode: "open",
      downstreamCommand: process.execPath,
      downstreamArgs: [],
      writeTools: { write_file: ["path"] },
    }, "write_file", { content: "missing path" });
    assert.equal(failOpenDecision.shouldForward, true);
    assert.equal(failOpenDecision.auditDecision, "allow");

    const dryRunDecision = decideToolCall({
      rootDir,
      agent: "agent-owned",
      mode: "dry-run",
      failMode: "closed",
      downstreamCommand: process.execPath,
      downstreamArgs: [],
      writeTools: { write_file: ["path"] },
    }, "write_file", { content: "missing path" });
    assert.equal(dryRunDecision.shouldForward, true);
    assert.equal(dryRunDecision.auditDecision, "dry-run-deny");

    const offDecision = decideToolCall({
      rootDir,
      agent: "agent-owned",
      mode: "off",
      failMode: "closed",
      downstreamCommand: process.execPath,
      downstreamArgs: [],
      writeTools: { write_file: ["path"] },
    }, "write_file", { path: "src/other/new.ts" });
    assert.equal(offDecision.shouldForward, true);
    assert.equal(offDecision.auditDecision, "off");

    const offReadDecision = decideToolCall({
      rootDir,
      agent: "agent-owned",
      mode: "off",
      failMode: "closed",
      downstreamCommand: process.execPath,
      downstreamArgs: [],
      writeTools: { write_file: ["path"] },
    }, "read_file", {});
    assert.deepEqual(offReadDecision.paths, []);

    const readDecision = decideToolCall({
      rootDir,
      agent: "agent-owned",
      mode: "enforce",
      failMode: "closed",
      downstreamCommand: process.execPath,
      downstreamArgs: [],
      writeTools: { write_file: ["path"] },
      readTools: ["read_file"],
    }, "read_file", { path: "src/other/new.ts" });
    assert.equal(readDecision.shouldForward, true);
    assert.equal(readDecision.reason, "configured read tool");

    const secureUnknownDecision = decideToolCall({
      rootDir,
      agent: "agent-owned",
      mode: "enforce",
      failMode: "open",
      downstreamCommand: process.execPath,
      downstreamArgs: [],
      writeTools: { write_file: ["path"] },
      readTools: ["read_file"],
      unknownToolPolicy: "deny",
    }, "run_command", { command: "echo unsafe" });
    assert.equal(secureUnknownDecision.shouldForward, false);
    assert.equal(secureUnknownDecision.auditDecision, "deny");
    assert.match(secureUnknownDecision.reason, /not configured as a read or write tool/);

    const secureReadDecision = decideToolCall({
      rootDir,
      agent: "agent-owned",
      mode: "enforce",
      failMode: "closed",
      downstreamCommand: process.execPath,
      downstreamArgs: [],
      writeTools: { write_file: ["path"] },
      readTools: ["read_file"],
      unknownToolPolicy: "deny",
    }, "read_file", { path: "src/other/new.ts" });
    assert.equal(secureReadDecision.shouldForward, true);
    assert.equal(secureReadDecision.reason, "configured read tool");

    const dryRunUnknownDecision = decideToolCall({
      rootDir,
      agent: "agent-owned",
      mode: "dry-run",
      failMode: "closed",
      downstreamCommand: process.execPath,
      downstreamArgs: [],
      writeTools: { write_file: ["path"] },
      unknownToolPolicy: "deny",
    }, "run_command", {});
    assert.equal(dryRunUnknownDecision.shouldForward, true);
    assert.equal(dryRunUnknownDecision.auditDecision, "dry-run-deny");

    const allowedDecision = decideToolCall({
      rootDir,
      agent: "agent-owned",
      mode: "enforce",
      failMode: "closed",
      downstreamCommand: process.execPath,
      downstreamArgs: [],
      writeTools: { write_file: ["path"] },
    }, "write_file", { path: "src/owned/new.ts" });
    assert.equal(allowedDecision.shouldForward, true);
    assert.equal(allowedDecision.auditDecision, "allow");

    const deniedClosedDecision = decideToolCall({
      rootDir,
      agent: "agent-owned",
      mode: "enforce",
      failMode: "closed",
      downstreamCommand: process.execPath,
      downstreamArgs: [],
      writeTools: { write_file: ["path"] },
    }, "write_file", { path: "src/other/new.ts" });
    assert.equal(deniedClosedDecision.shouldForward, false);
    assert.equal(deniedClosedDecision.auditDecision, "deny");

    const deniedDryRunDecision = decideToolCall({
      rootDir,
      agent: "agent-owned",
      mode: "dry-run",
      failMode: "closed",
      downstreamCommand: process.execPath,
      downstreamArgs: [],
      writeTools: { write_file: ["path"] },
    }, "write_file", { path: "src/other/new.ts" });
    assert.equal(deniedDryRunDecision.shouldForward, true);
    assert.equal(deniedDryRunDecision.auditDecision, "dry-run-deny");
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("proxy decisions cover fail-open and policy-error branches", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-mcp-policy-errors-"));
  try {
    writeProject(rootDir);
    const deniedOpen = decideToolCall({
      rootDir,
      agent: "agent-owned",
      mode: "enforce",
      failMode: "open",
      downstreamCommand: process.execPath,
      downstreamArgs: [],
      writeTools: { write_file: ["path"] },
    }, "write_file", { path: "src/other/new.ts" });
    assert.equal(deniedOpen.shouldForward, true);
    assert.equal(deniedOpen.auditDecision, "allow");
    assert.match(deniedOpen.reason, /fail-open after denial/);

    const policyErrorClosed = decideToolCall({
      rootDir: 42,
      manifestPath: "missing-manifest.json",
      agent: "agent-owned",
      mode: "enforce",
      failMode: "closed",
      downstreamCommand: process.execPath,
      downstreamArgs: [],
      writeTools: { write_file: ["path"] },
    }, "write_file", { path: "src/owned/new.ts" });
    assert.equal(policyErrorClosed.shouldForward, false);
    assert.equal(policyErrorClosed.auditDecision, "deny");

    const policyErrorDryRun = decideToolCall({
      rootDir: 42,
      manifestPath: "missing-manifest.json",
      agent: "agent-owned",
      mode: "dry-run",
      failMode: "closed",
      downstreamCommand: process.execPath,
      downstreamArgs: [],
      writeTools: { write_file: ["path"] },
    }, "write_file", { path: "src/owned/new.ts" });
    assert.equal(policyErrorDryRun.shouldForward, true);
    assert.equal(policyErrorDryRun.auditDecision, "dry-run-deny");

    const policyErrorOpen = decideToolCall({
      rootDir: 42,
      manifestPath: "missing-manifest.json",
      agent: "agent-owned",
      mode: "enforce",
      failMode: "open",
      downstreamCommand: process.execPath,
      downstreamArgs: [],
      writeTools: { write_file: ["path"] },
    }, "write_file", { path: "src/owned/new.ts" });
    assert.equal(policyErrorOpen.shouldForward, true);
    assert.match(policyErrorOpen.reason, /fail-open after policy error/);

    const nonErrorOptions = {
      get rootDir() {
        throw "string failure";
      },
      agent: "agent-owned",
      mode: "enforce",
      failMode: "closed",
      downstreamCommand: process.execPath,
      downstreamArgs: [],
      writeTools: { write_file: ["path"] },
    };
    const nonErrorDecision = decideToolCall(nonErrorOptions, "write_file", { path: "src/owned/new.ts" });
    assert.equal(nonErrorDecision.shouldForward, false);
    assert.equal(nonErrorDecision.reason, "string failure");
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
    }, { proxyArgs: ["--read-tool", "read_file"] });
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

test("MCP proxy deny policy exposes configured tools and blocks unknown calls", async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-mcp-unknown-deny-"));
  try {
    writeProject(rootDir);
    const serverPath = writeFeatureServer(rootDir);
    await withProxy(rootDir, "enforce", async (rpc, logs) => {
      const tools = await rpc.send("tools/list");
      assert.deepEqual(tools.result.tools.map((tool) => tool.name), ["read_file", "write_file"]);

      const read = await rpc.send("tools/call", { name: "read_file", arguments: { path: "src/other/public.ts" } });
      assert.equal(read.result.content[0].text, "called read_file");

      const beforeDenied = readJsonLines(logs.mockLog).length;
      const denied = await rpc.send("tools/call", { name: "run_command", arguments: { command: "echo unsafe" } });
      assert.equal(denied.result.isError, true);
      assert.match(denied.result.content[0].text, /CellFence denied run_command/);
      assert.equal(readJsonLines(logs.mockLog).length, beforeDenied);
      assert.deepEqual(readJsonLines(logs.auditLog).map((event) => event.decision), ["allow", "deny"]);
    }, {
      proxyArgs: ["--unknown-tool-policy", "deny", "--read-tool", "read_file"],
      serverPath,
    });
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("MCP proxy bridges downstream resources, prompts, and completion", async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-mcp-features-"));
  try {
    writeProject(rootDir);
    const serverPath = writeFeatureServer(rootDir);
    await withProxy(rootDir, "enforce", async (rpc, { initialization }) => {
      assert.deepEqual(initialization.result.capabilities.resources, { subscribe: true, listChanged: true });
      assert.deepEqual(initialization.result.capabilities.prompts, { listChanged: true });
      assert.deepEqual(initialization.result.capabilities.completions, {});
      assert.deepEqual(initialization.result.capabilities.tools, { listChanged: true });

      const tools = await rpc.send("tools/list");
      assert.deepEqual(tools.result.tools.map((tool) => tool.name), ["read_file", "write_file", "run_command"]);

      const resources = await rpc.send("resources/list");
      assert.deepEqual(resources.result.resources, [{ uri: "memory://guide", name: "Guide" }]);

      const templates = await rpc.send("resources/templates/list");
      assert.deepEqual(templates.result.resourceTemplates, [{ uriTemplate: "memory://{name}", name: "Memory" }]);

      const resource = await rpc.send("resources/read", { uri: "memory://guide" });
      assert.equal(resource.result.contents[0].text, "resource body");
      assert.deepEqual((await rpc.send("resources/subscribe", { uri: "memory://guide" })).result, {});
      assert.deepEqual((await rpc.send("resources/unsubscribe", { uri: "memory://guide" })).result, {});

      const prompts = await rpc.send("prompts/list");
      assert.equal(prompts.result.prompts[0].name, "greet");
      const prompt = await rpc.send("prompts/get", { name: "greet", arguments: { name: "Ada" } });
      assert.equal(prompt.result.messages[0].content.text, "Hello Ada");

      const completion = await rpc.send("completion/complete", {
        ref: { type: "ref/prompt", name: "greet" },
        argument: { name: "name", value: "A" },
      });
      assert.deepEqual(completion.result.completion.values, ["Alice"]);

      await waitFor(() => rpc.notifications.length === 4, "bridged MCP notifications");
      assert.deepEqual(rpc.notifications.map((notification) => notification.method).sort(), [
        "notifications/prompts/list_changed",
        "notifications/resources/list_changed",
        "notifications/resources/updated",
        "notifications/tools/list_changed",
      ]);
    }, { serverPath, proxyArgs: ["--read-tool", "read_file", "--read-tool", "run_command"] });
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});
