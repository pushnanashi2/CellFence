#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

import { checkWriteAccess, type WriteAccessResult } from "@cellfence/engine";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  type CallToolRequest,
  type CallToolResult,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

export type ProxyMode = "enforce" | "dry-run" | "off";
export type FailMode = "closed" | "open";

export type WriteToolConfig = Record<string, string[]>;

export type ProxyOptions = {
  rootDir: string;
  manifestPath?: string;
  claimsPath?: string;
  agent: string;
  mode: ProxyMode;
  failMode: FailMode;
  auditLogPath?: string;
  downstreamCommand: string;
  downstreamArgs: string[];
  downstreamCwd?: string;
  writeTools: WriteToolConfig;
};

type AuditDecision = "allow" | "deny" | "dry-run-deny" | "off";

type AuditEvent = {
  timestamp: string;
  agent: string;
  tool: string;
  paths: string[];
  decision: AuditDecision;
  reason: string;
};

type ToolDecision = {
  shouldForward: boolean;
  auditDecision: AuditDecision;
  paths: string[];
  reason: string;
  access?: WriteAccessResult;
};

const VERSION = "0.1.12";

const DEFAULT_WRITE_TOOLS: WriteToolConfig = {
  apply_patch: ["path", "file_path", "filename"],
  create_file: ["path", "file_path", "filename"],
  edit_file: ["path", "file_path", "filename"],
  str_replace: ["path", "file_path", "filename"],
  write_file: ["path", "file_path", "filename"],
};

function usage(): string {
  return `CellFence MCP runtime guard

Usage:
  cellfence-mcp-proxy --agent AGENT --downstream-command CMD [options]
  cellfence-mcp-proxy --agent AGENT [options] -- CMD [ARG...]

Options:
  --root DIR                    Repository root. Defaults to cwd.
  --manifest PATH               Manifest path relative to root. Defaults to cellfence.manifest.json.
  --claims PATH                 Claim store path. Defaults to .cellfence/claims.json.
  --agent ID                    Agent id. Can also use CELLFENCE_AGENT.
  --mode enforce|dry-run|off    Guard mode. Defaults to enforce.
  --fail-mode closed|open       Policy failure behavior for writes. Defaults to closed.
  --audit-log PATH              Append one JSONL decision event per tool call.
  --tool-config PATH            JSON file with { "writeTools": { "tool": ["pathKey"] } }.
  --write-tool NAME=KEYS        Override one write tool. KEYS is comma-separated.
  --downstream-command CMD      MCP server command to wrap.
  --downstream-arg ARG          Repeatable downstream argument.
  --downstream-cwd DIR          Working directory for the downstream server.
  --help                        Show this help.

Environment:
  CELLFENCE_AGENT, CELLFENCE_MCP_MODE, CELLFENCE_MCP_FAIL_MODE,
  CELLFENCE_MCP_AUDIT_LOG, CELLFENCE_MCP_DOWNSTREAM_COMMAND
`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stringsFromValue(value: unknown): string[] {
  if (typeof value === "string" && value.trim().length > 0) return [value];
  if (Array.isArray(value)) return value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0);
  return [];
}

function getNestedValue(value: unknown, keyPath: string): unknown {
  return keyPath.split(".").reduce<unknown>((current, key) => {
    if (!isRecord(current)) return undefined;
    return current[key];
  }, value);
}

function mergeWriteToolConfig(base: WriteToolConfig, patch: WriteToolConfig): WriteToolConfig {
  return {
    ...base,
    ...Object.fromEntries(Object.entries(patch).map(([tool, keys]) => [
      tool,
      [...new Set(keys.map((key) => key.trim()).filter(Boolean))],
    ])),
  };
}

function readToolConfig(filePath: string): WriteToolConfig {
  const raw = JSON.parse(fs.readFileSync(filePath, "utf8"));
  if (!isRecord(raw) || !isRecord(raw.writeTools)) {
    throw new Error("tool config must be an object with writeTools");
  }
  const writeTools: WriteToolConfig = {};
  for (const [tool, value] of Object.entries(raw.writeTools)) {
    const keys = stringsFromValue(value);
    if (keys.length === 0) throw new Error(`tool config for ${tool} must list at least one path key`);
    writeTools[tool] = keys;
  }
  return writeTools;
}

function parseWriteToolOverride(value: string): WriteToolConfig {
  const separatorIndex = value.indexOf("=");
  if (separatorIndex === -1) throw new Error("--write-tool must be NAME=path,file_path");
  const tool = value.slice(0, separatorIndex).trim();
  const keys = value.slice(separatorIndex + 1).split(",").map((key) => key.trim()).filter(Boolean);
  if (!tool || keys.length === 0) throw new Error("--write-tool must include a tool name and at least one path key");
  return { [tool]: keys };
}

function parseMode(value: string | undefined): ProxyMode {
  if (value === "dry-run" || value === "off" || value === "enforce") return value;
  if (value) throw new Error(`invalid mode ${value}`);
  return "enforce";
}

function parseFailMode(value: string | undefined): FailMode {
  if (value === "open" || value === "closed") return value;
  if (value) throw new Error(`invalid fail mode ${value}`);
  return "closed";
}

export function parseProxyArgs(argv: string[], env: NodeJS.ProcessEnv = process.env): ProxyOptions {
  let rootDir = process.cwd();
  let manifestPath: string | undefined;
  let claimsPath: string | undefined;
  let agent = env.CELLFENCE_AGENT || "";
  let mode = parseMode(env.CELLFENCE_MCP_MODE);
  let failMode = parseFailMode(env.CELLFENCE_MCP_FAIL_MODE);
  let auditLogPath = env.CELLFENCE_MCP_AUDIT_LOG;
  let downstreamCommand = env.CELLFENCE_MCP_DOWNSTREAM_COMMAND || "";
  let downstreamArgs: string[] = [];
  let downstreamCwd: string | undefined;
  let writeTools = { ...DEFAULT_WRITE_TOOLS };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--") {
      downstreamCommand = argv[index + 1] || downstreamCommand;
      downstreamArgs = argv.slice(index + 2);
      break;
    } else if (argument === "--help" || argument === "-h") {
      throw new Error(usage());
    } else if (argument === "--root") {
      rootDir = argv[index + 1] || "";
      index += 1;
    } else if (argument.startsWith("--root=")) {
      rootDir = argument.slice("--root=".length);
    } else if (argument === "--manifest") {
      manifestPath = argv[index + 1];
      index += 1;
    } else if (argument.startsWith("--manifest=")) {
      manifestPath = argument.slice("--manifest=".length);
    } else if (argument === "--claims") {
      claimsPath = argv[index + 1];
      index += 1;
    } else if (argument.startsWith("--claims=")) {
      claimsPath = argument.slice("--claims=".length);
    } else if (argument === "--agent") {
      agent = argv[index + 1] || "";
      index += 1;
    } else if (argument.startsWith("--agent=")) {
      agent = argument.slice("--agent=".length);
    } else if (argument === "--mode") {
      mode = parseMode(argv[index + 1]);
      index += 1;
    } else if (argument.startsWith("--mode=")) {
      mode = parseMode(argument.slice("--mode=".length));
    } else if (argument === "--fail-mode") {
      failMode = parseFailMode(argv[index + 1]);
      index += 1;
    } else if (argument.startsWith("--fail-mode=")) {
      failMode = parseFailMode(argument.slice("--fail-mode=".length));
    } else if (argument === "--audit-log") {
      auditLogPath = argv[index + 1];
      index += 1;
    } else if (argument.startsWith("--audit-log=")) {
      auditLogPath = argument.slice("--audit-log=".length);
    } else if (argument === "--tool-config") {
      writeTools = mergeWriteToolConfig(writeTools, readToolConfig(argv[index + 1] || ""));
      index += 1;
    } else if (argument.startsWith("--tool-config=")) {
      writeTools = mergeWriteToolConfig(writeTools, readToolConfig(argument.slice("--tool-config=".length)));
    } else if (argument === "--write-tool") {
      writeTools = mergeWriteToolConfig(writeTools, parseWriteToolOverride(argv[index + 1] || ""));
      index += 1;
    } else if (argument.startsWith("--write-tool=")) {
      writeTools = mergeWriteToolConfig(writeTools, parseWriteToolOverride(argument.slice("--write-tool=".length)));
    } else if (argument === "--downstream-command") {
      downstreamCommand = argv[index + 1] || "";
      index += 1;
    } else if (argument.startsWith("--downstream-command=")) {
      downstreamCommand = argument.slice("--downstream-command=".length);
    } else if (argument === "--downstream-arg") {
      downstreamArgs.push(argv[index + 1] || "");
      index += 1;
    } else if (argument.startsWith("--downstream-arg=")) {
      downstreamArgs.push(argument.slice("--downstream-arg=".length));
    } else if (argument === "--downstream-cwd") {
      downstreamCwd = argv[index + 1];
      index += 1;
    } else if (argument.startsWith("--downstream-cwd=")) {
      downstreamCwd = argument.slice("--downstream-cwd=".length);
    } else {
      throw new Error(`unknown argument ${argument}`);
    }
  }

  if (!agent.trim()) throw new Error("missing --agent or CELLFENCE_AGENT");
  if (!downstreamCommand.trim()) throw new Error("missing --downstream-command or -- CMD");
  return {
    rootDir: path.resolve(rootDir),
    manifestPath,
    claimsPath,
    agent: agent.trim(),
    mode,
    failMode,
    auditLogPath,
    downstreamCommand,
    downstreamArgs: downstreamArgs.filter((entry) => entry.length > 0),
    downstreamCwd,
    writeTools,
  };
}

export function pathsForToolCall(toolName: string, args: unknown, writeTools: WriteToolConfig): string[] | undefined {
  const keys = writeTools[toolName];
  if (!keys) return undefined;
  const paths: string[] = [];
  for (const key of keys) paths.push(...stringsFromValue(getNestedValue(args, key)));
  return [...new Set(paths)];
}

/* c8 ignore start -- Audit file appending is exercised through the subprocess MCP proxy E2E tests; parent-process c8 does not retain that child coverage. */
function appendAuditEvent(options: ProxyOptions, event: AuditEvent): void {
  if (!options.auditLogPath) return;
  const outputPath = path.isAbsolute(options.auditLogPath)
    ? options.auditLogPath
    : path.resolve(options.rootDir, options.auditLogPath);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.appendFileSync(outputPath, `${JSON.stringify(event)}\n`);
}
/* c8 ignore stop */

function summarizeAccess(access: WriteAccessResult): string {
  const denied = access.paths.filter((decision) => !decision.allowed);
  if (denied.length > 0) {
    return denied.map((decision) => `${decision.requestedPath}: ${decision.reason}`).join("; ");
  }
  /* c8 ignore start -- checkWriteAccess returns a denied path whenever ok is false for current inputs; these are defensive fallbacks for future WriteAccessResult producers. */
  if (!access.ok) return access.findings.map((finding) => finding.message).join("; ") || "CellFence policy rejected the write";
  return "allowed";
}
/* c8 ignore stop */

export function decideToolCall(options: ProxyOptions, toolName: string, args: unknown): ToolDecision {
  const paths = pathsForToolCall(toolName, args, options.writeTools);
  if (options.mode === "off") {
    return { shouldForward: true, auditDecision: "off", paths: paths || [], reason: "guard disabled" };
  }
  if (paths === undefined) {
    return { shouldForward: true, auditDecision: "allow", paths: [], reason: "read-only or unconfigured tool" };
  }
  if (paths.length === 0) {
    const reason = `write tool ${toolName} did not expose a configured path argument`;
    const shouldForward = options.failMode === "open" || options.mode === "dry-run";
    return {
      shouldForward,
      auditDecision: shouldForward && options.mode === "dry-run" ? "dry-run-deny" : shouldForward ? "allow" : "deny",
      paths: [],
      reason,
    };
  }
  try {
    const access = checkWriteAccess({
      rootDir: options.rootDir,
      manifestPath: options.manifestPath,
      claimsPath: options.claimsPath,
      agent: options.agent,
      paths,
    });
    if (access.ok) return { shouldForward: true, auditDecision: "allow", paths, reason: "CellFence write access allowed", access };
    const reason = summarizeAccess(access);
    if (options.mode === "dry-run") return { shouldForward: true, auditDecision: "dry-run-deny", paths, reason, access };
    if (options.failMode === "open") return { shouldForward: true, auditDecision: "allow", paths, reason: `fail-open after denial: ${reason}`, access };
    return { shouldForward: false, auditDecision: "deny", paths, reason, access };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    if (options.mode === "dry-run") return { shouldForward: true, auditDecision: "dry-run-deny", paths, reason };
    if (options.failMode === "open") return { shouldForward: true, auditDecision: "allow", paths, reason: `fail-open after policy error: ${reason}` };
    return { shouldForward: false, auditDecision: "deny", paths, reason };
  }
}

/* c8 ignore start -- The stdio MCP bridge is covered by tests/mcp-proxy.test.mjs through a subprocess. Parent-process c8 does not reliably attribute the long-lived child process before it is terminated. */
function deniedToolResult(toolName: string, decision: ToolDecision): CallToolResult {
  return {
    isError: true,
    content: [{
      type: "text",
      text: `CellFence denied ${toolName}: ${decision.reason}`,
    }],
  };
}

function inheritedEnvironment(): Record<string, string> {
  return Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
}

function audit(options: ProxyOptions, toolName: string, decision: ToolDecision): void {
  appendAuditEvent(options, {
    timestamp: new Date().toISOString(),
    agent: options.agent,
    tool: toolName,
    paths: decision.paths,
    decision: decision.auditDecision,
    reason: decision.reason,
  });
}

export async function runProxy(options: ProxyOptions): Promise<void> {
  const downstreamTransport = new StdioClientTransport({
    command: options.downstreamCommand,
    args: options.downstreamArgs,
    cwd: options.downstreamCwd,
    env: inheritedEnvironment(),
    stderr: "inherit",
  });
  const downstream = new Client({
    name: "cellfence-mcp-proxy-downstream",
    version: VERSION,
  }, {
    capabilities: {},
  });
  await downstream.connect(downstreamTransport);

  const server = new Server({
    name: "cellfence-mcp-proxy",
    version: VERSION,
  }, {
    capabilities: { tools: {} },
  });

  server.setRequestHandler(ListToolsRequestSchema, async (request) => downstream.listTools(request.params));
  server.setRequestHandler(CallToolRequestSchema, async (request: CallToolRequest) => {
    const toolName = request.params.name;
    const toolArgs = request.params.arguments;
    const decision = decideToolCall(options, toolName, toolArgs);
    audit(options, toolName, decision);
    if (!decision.shouldForward) return deniedToolResult(toolName, decision);
    return downstream.callTool(request.params);
  });

  const upstreamTransport = new StdioServerTransport();
  await server.connect(upstreamTransport);
}

export async function main(argv = process.argv.slice(2), env = process.env): Promise<number> {
  try {
    const options = parseProxyArgs(argv, env);
    await runProxy(options);
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.startsWith("CellFence MCP runtime guard")) {
      console.log(message);
      return 0;
    }
    console.error(message);
    return 2;
  }
}

function isCliEntry(): boolean {
  if (!process.argv[1]) return false;
  try {
    return import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href;
  } catch {
    return import.meta.url === pathToFileURL(process.argv[1]).href;
  }
}

if (isCliEntry()) {
  main().then((exitCode) => {
    process.exitCode = exitCode;
  }, (error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 3;
  });
}
/* c8 ignore stop */
