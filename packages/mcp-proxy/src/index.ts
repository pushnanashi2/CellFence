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
  CompleteRequestSchema,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  type CallToolRequest,
  type CallToolResult,
  ListToolsRequestSchema,
  PromptListChangedNotificationSchema,
  ReadResourceRequestSchema,
  ResourceListChangedNotificationSchema,
  ResourceUpdatedNotificationSchema,
  type ServerCapabilities,
  SubscribeRequestSchema,
  ToolListChangedNotificationSchema,
  UnsubscribeRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

export type ProxyMode = "enforce" | "dry-run" | "off";
export type FailMode = "closed" | "open";
export type UnknownToolPolicy = "allow" | "deny";

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
  readTools?: string[];
  unknownToolPolicy?: UnknownToolPolicy;
};

type ToolConfigPatch = {
  writeTools: WriteToolConfig;
  readTools: string[];
  unknownToolPolicy?: UnknownToolPolicy;
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

const VERSION = "0.2.1";

// H-5 (0.3.0): the previous default only knew about the original
// five tool names. Real agent harnesses use Write/Edit/NotebookEdit/
// MultiEdit/patch/fs_write/edit. Tool matching is now case-insensitive
// (see shouldExposeTool) so the additional names are picked up.
const DEFAULT_WRITE_TOOLS: WriteToolConfig = {
  apply_patch: ["path", "file_path", "filename"],
  create_file: ["path", "file_path", "filename"],
  edit_file: ["path", "file_path", "filename"],
  str_replace: ["path", "file_path", "filename"],
  write_file: ["path", "file_path", "filename"],
  Write: ["file_path", "path", "filepath", "filename"],
  Edit: ["file_path", "path", "filepath", "filename"],
  NotebookEdit: ["file_path", "path", "filepath", "filename"],
  MultiEdit: ["file_path", "path", "filepath", "filename"],
  patch: ["file_path", "path", "filepath", "filename"],
  fs_write: ["file_path", "path", "filepath", "filename"],
  edit: ["file_path", "path", "filepath", "filename"],
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
  --unknown-tool-policy POLICY  allow or deny unconfigured tools. Defaults to allow.
  --tool-config PATH            JSON file with writeTools, readTools, and/or unknownToolPolicy.
  --write-tool NAME=KEYS        Override one write tool. KEYS is comma-separated.
  --read-tool NAME              Allowlist a read-only tool. Repeatable.
  --downstream-command CMD      MCP server command to wrap.
  --downstream-arg ARG          Repeatable downstream argument.
  --downstream-cwd DIR          Working directory for the downstream server.
  --help                        Show this help.

Environment:
  CELLFENCE_AGENT, CELLFENCE_MCP_MODE, CELLFENCE_MCP_FAIL_MODE,
  CELLFENCE_MCP_UNKNOWN_TOOL_POLICY, CELLFENCE_MCP_READ_TOOLS,
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

function getNestedValues(value: unknown, keyPath: string): unknown[] {
  let current = [value];
  for (const segment of keyPath.split(".")) {
    const expandsArray = segment.endsWith("[]");
    const key = expandsArray ? segment.slice(0, -2) : segment;
    const next: unknown[] = [];
    for (const entry of current) {
      if (!isRecord(entry)) continue;
      const nested = entry[key];
      if (expandsArray) {
        if (Array.isArray(nested)) next.push(...nested);
      } else {
        next.push(nested);
      }
    }
    current = next;
  }
  return current;
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

function mergeReadTools(base: string[], patch: string[]): string[] {
  return [...new Set([...base, ...patch].map((tool) => tool.trim()).filter(Boolean))];
}

function readToolConfig(filePath: string): ToolConfigPatch {
  const raw = JSON.parse(fs.readFileSync(filePath, "utf8"));
  if (!isRecord(raw)) {
    throw new Error("tool config must be an object with writeTools, readTools, or unknownToolPolicy");
  }
  if (raw.writeTools === undefined && raw.readTools === undefined && raw.unknownToolPolicy === undefined) {
    throw new Error("tool config must be an object with writeTools, readTools, or unknownToolPolicy");
  }
  const writeTools: WriteToolConfig = {};
  if (raw.writeTools !== undefined) {
    if (!isRecord(raw.writeTools)) throw new Error("tool config writeTools must be an object");
    for (const [tool, value] of Object.entries(raw.writeTools)) {
      const keys = stringsFromValue(value);
      if (keys.length === 0) throw new Error(`tool config for ${tool} must list at least one path key`);
      writeTools[tool] = keys;
    }
  }
  let readTools: string[] = [];
  if (raw.readTools !== undefined) {
    if (!Array.isArray(raw.readTools) || raw.readTools.some((tool) => typeof tool !== "string" || !tool.trim())) {
      throw new Error("tool config readTools must be an array of non-empty tool names");
    }
    readTools = mergeReadTools([], raw.readTools);
  }
  return {
    writeTools,
    readTools,
    unknownToolPolicy: raw.unknownToolPolicy === undefined
      ? undefined
      : parseUnknownToolPolicy(typeof raw.unknownToolPolicy === "string" ? raw.unknownToolPolicy : String(raw.unknownToolPolicy)),
  };
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

function parseUnknownToolPolicy(value: string | undefined): UnknownToolPolicy {
  if (value === "allow" || value === "deny") return value;
  throw new Error(`invalid unknown tool policy ${value === undefined || value === "" ? "(empty)" : value}`);
}

function parseReadTool(value: string | undefined): string {
  const tool = value?.trim() || "";
  if (!tool) throw new Error("--read-tool must include a tool name");
  return tool;
}

export function parseProxyArgs(argv: string[], env: NodeJS.ProcessEnv = process.env): ProxyOptions {
  let rootDir = process.cwd();
  let manifestPath: string | undefined;
  let claimsPath: string | undefined;
  let agent = env.CELLFENCE_AGENT || "";
  let mode = parseMode(env.CELLFENCE_MCP_MODE);
  let failMode = parseFailMode(env.CELLFENCE_MCP_FAIL_MODE);
  // H-5 (0.3.0): the previous default was "allow", which let any tool
  // through unless explicitly listed. The new default is "deny" so an
  // unrecognized tool name never bypasses the runtime guard. Operators
  // can opt back into "allow" with CELLFENCE_MCP_UNKNOWN_TOOL_POLICY=allow.
  let unknownToolPolicy: UnknownToolPolicy = env.CELLFENCE_MCP_UNKNOWN_TOOL_POLICY === undefined
    ? "deny"
    : parseUnknownToolPolicy(env.CELLFENCE_MCP_UNKNOWN_TOOL_POLICY);
  let readTools = mergeReadTools([], (env.CELLFENCE_MCP_READ_TOOLS || "").split(","));
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
    } else if (argument === "--unknown-tool-policy") {
      const value = argv[index + 1];
      unknownToolPolicy = parseUnknownToolPolicy(value && !value.startsWith("--") ? value : undefined);
      index += 1;
    } else if (argument.startsWith("--unknown-tool-policy=")) {
      unknownToolPolicy = parseUnknownToolPolicy(argument.slice("--unknown-tool-policy=".length));
    } else if (argument === "--audit-log") {
      auditLogPath = argv[index + 1];
      index += 1;
    } else if (argument.startsWith("--audit-log=")) {
      auditLogPath = argument.slice("--audit-log=".length);
    } else if (argument === "--tool-config") {
      const config = readToolConfig(argv[index + 1] || "");
      writeTools = mergeWriteToolConfig(writeTools, config.writeTools);
      readTools = mergeReadTools(readTools, config.readTools);
      unknownToolPolicy = config.unknownToolPolicy ?? unknownToolPolicy;
      index += 1;
    } else if (argument.startsWith("--tool-config=")) {
      const config = readToolConfig(argument.slice("--tool-config=".length));
      writeTools = mergeWriteToolConfig(writeTools, config.writeTools);
      readTools = mergeReadTools(readTools, config.readTools);
      unknownToolPolicy = config.unknownToolPolicy ?? unknownToolPolicy;
    } else if (argument === "--write-tool") {
      writeTools = mergeWriteToolConfig(writeTools, parseWriteToolOverride(argv[index + 1] || ""));
      index += 1;
    } else if (argument.startsWith("--write-tool=")) {
      writeTools = mergeWriteToolConfig(writeTools, parseWriteToolOverride(argument.slice("--write-tool=".length)));
    } else if (argument === "--read-tool") {
      readTools = mergeReadTools(readTools, [parseReadTool(argv[index + 1])]);
      index += 1;
    } else if (argument.startsWith("--read-tool=")) {
      readTools = mergeReadTools(readTools, [parseReadTool(argument.slice("--read-tool=".length))]);
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
    readTools,
    unknownToolPolicy,
  };
}

export function pathsForToolCall(toolName: string, args: unknown, writeTools: WriteToolConfig): string[] | undefined {
  // H-5: real clients (Claude Code, Cursor) often capitalise tool
  // names (Write, Edit). The previous exact-match lookup let
  // case-mismatched calls bypass path extraction. Look up the keys
  // case-insensitively while preserving the original config casing.
  const wanted = toolName.toLowerCase();
  const matchKey = Object.keys(writeTools).find((key) => key.toLowerCase() === wanted);
  if (!matchKey) return undefined;
  const keys = writeTools[matchKey];
  if (!keys) return undefined;
  const paths: string[] = [];
  for (const key of keys) {
    for (const value of getNestedValues(args, key)) paths.push(...stringsFromValue(value));
  }
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
    if (options.readTools?.includes(toolName)) {
      return { shouldForward: true, auditDecision: "allow", paths: [], reason: "configured read tool" };
    }
    if ((options.unknownToolPolicy ?? "deny") === "deny") {
      const reason = `unknown tool ${toolName} is not configured as a read or write tool`;
      if (options.mode === "dry-run") {
        return { shouldForward: true, auditDecision: "dry-run-deny", paths: [], reason };
      }
      return { shouldForward: false, auditDecision: "deny", paths: [], reason };
    }
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

// H-3 (0.3.0): the previous inheritedEnvironment() forwarded every
// process.env entry to the downstream MCP server. That leaked operator
// secrets (CELLFENCE_BASELINE_HMAC_KEY, CELLFENCE_BASELINE_ED25519_*
// private keys, NPM_TOKEN, GITHUB_TOKEN, AWS_*, ...) into an
// attacker-controlled process: any tool call the downstream advertises
// can read the proxy's own environment. Build the downstream env
// from an explicit allowlist instead. The downstream keeps what it
// actually needs to start (PATH, HOME, USER, locale, TMPDIR, TZ) and
// the proxy's own CELLFENCE_MCP_* configuration knobs. Every other
// variable is dropped, including the baseline signing material that
// should never leave the verifier.
const SAFE_DOWNSTREAM_ENV_NAMES = new Set([
  "PATH",
  "Path",
  "HOME",
  "USER",
  "USERNAME",
  "USERPROFILE",
  "HOMEDRIVE",
  "HOMEPATH",
  "TMPDIR",
  "TMP",
  "TEMP",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "LC_MESSAGES",
  "LC_COLLATE",
  "LC_NUMERIC",
  "LC_TIME",
  "TZ",
  "SHELL",
  "LANGUAGE",
  "TERM",
  "PWD",
  "MOCK_MCP_LOG",
]);

const SAFE_DOWNSTREAM_ENV_PREFIXES = [
  "CELLFENCE_MCP_",
  "LC_",
];

function safeDownstreamEnvironment(env: NodeJS.ProcessEnv): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) {
    if (typeof value !== "string") continue;
    if (SAFE_DOWNSTREAM_ENV_NAMES.has(name)) {
      result[name] = value;
      continue;
    }
    if (SAFE_DOWNSTREAM_ENV_PREFIXES.some((prefix) => name.startsWith(prefix))) {
      result[name] = value;
    }
  }
  return result;
}

export const __testing = { safeDownstreamEnvironment };

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

function shouldExposeTool(options: ProxyOptions, toolName: string): boolean {
  // H-5 (0.3.0): the fallback is "deny" so an unrecognised tool never
  // bypasses the runtime guard, and the case-insensitive lookup keeps
  // Claude Code / Cursor clients aligned with the documented dialect.
  if (options.mode !== "enforce") return true;
  const policy = options.unknownToolPolicy ?? "deny";
  if (policy === "allow") return true;
  const wanted = toolName.toLowerCase();
  const hasWrite = Object.keys(options.writeTools).some((key) => key.toLowerCase() === wanted);
  if (hasWrite) return true;
  const readTools = options.readTools ?? [];
  return readTools.some((tool) => tool.toLowerCase() === wanted);
}

export async function runProxy(options: ProxyOptions): Promise<void> {
  const downstreamTransport = new StdioClientTransport({
    command: options.downstreamCommand,
    args: options.downstreamArgs,
    cwd: options.downstreamCwd,
    env: safeDownstreamEnvironment(process.env),
    stderr: "inherit",
  });
  const downstream = new Client({
    name: "cellfence-mcp-proxy-downstream",
    version: VERSION,
  }, {
    capabilities: {},
  });
  await downstream.connect(downstreamTransport);

  const downstreamCapabilities = downstream.getServerCapabilities() || {};
  const capabilities: ServerCapabilities = {
    tools: downstreamCapabilities.tools || {},
    ...(downstreamCapabilities.resources ? { resources: downstreamCapabilities.resources } : {}),
    ...(downstreamCapabilities.prompts ? { prompts: downstreamCapabilities.prompts } : {}),
    ...(downstreamCapabilities.completions ? { completions: downstreamCapabilities.completions } : {}),
  };

  const server = new Server({
    name: "cellfence-mcp-proxy",
    version: VERSION,
  }, {
    capabilities,
  });

  server.setRequestHandler(ListToolsRequestSchema, async (request) => {
    const result = await downstream.listTools(request.params);
    return {
      ...result,
      tools: result.tools.filter((tool) => shouldExposeTool(options, tool.name)),
    };
  });
  server.setRequestHandler(CallToolRequestSchema, async (request: CallToolRequest) => {
    const toolName = request.params.name;
    const toolArgs = request.params.arguments;
    const decision = decideToolCall(options, toolName, toolArgs);
    audit(options, toolName, decision);
    if (!decision.shouldForward) return deniedToolResult(toolName, decision);
    return downstream.callTool(request.params);
  });

  if (downstreamCapabilities.resources) {
    server.setRequestHandler(ListResourcesRequestSchema, async (request) => downstream.listResources(request.params));
    server.setRequestHandler(ListResourceTemplatesRequestSchema, async (request) => downstream.listResourceTemplates(request.params));
    server.setRequestHandler(ReadResourceRequestSchema, async (request) => downstream.readResource(request.params));
    if (downstreamCapabilities.resources.subscribe) {
      server.setRequestHandler(SubscribeRequestSchema, async (request) => downstream.subscribeResource(request.params));
      server.setRequestHandler(UnsubscribeRequestSchema, async (request) => downstream.unsubscribeResource(request.params));
      downstream.setNotificationHandler(ResourceUpdatedNotificationSchema, async (notification) => {
        await server.sendResourceUpdated(notification.params);
      });
    }
    if (downstreamCapabilities.resources.listChanged) {
      downstream.setNotificationHandler(ResourceListChangedNotificationSchema, async () => {
        await server.sendResourceListChanged();
      });
    }
  }

  if (downstreamCapabilities.prompts) {
    server.setRequestHandler(ListPromptsRequestSchema, async (request) => downstream.listPrompts(request.params));
    server.setRequestHandler(GetPromptRequestSchema, async (request) => downstream.getPrompt(request.params));
    if (downstreamCapabilities.prompts.listChanged) {
      downstream.setNotificationHandler(PromptListChangedNotificationSchema, async () => {
        await server.sendPromptListChanged();
      });
    }
  }

  if (downstreamCapabilities.completions) {
    server.setRequestHandler(CompleteRequestSchema, async (request) => downstream.complete(request.params));
  }

  if (downstreamCapabilities.tools?.listChanged) {
    downstream.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
      await server.sendToolListChanged();
    });
  }

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
