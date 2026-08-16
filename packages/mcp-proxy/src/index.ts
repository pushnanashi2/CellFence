#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

import { checkWriteAccess, checkWriteAccessAsync, type WriteAccessResult } from "@cellfence/engine";
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
export type DownstreamFeaturePolicy = "allow" | "deny";

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
  downstreamEnv?: Record<string, string>;
  // H-6 (0.3.0): opt-in escape hatch for the --downstream-cwd
  // containment check. By default the cwd must sit inside rootDir;
  // setting this to true lets advanced deployments point the
  // downstream server at a sibling directory (e.g. a shared cache)
  // without disabling the safety net for everyone else.
  allowCwdMismatch?: boolean;
  writeTools: WriteToolConfig;
  readTools?: string[];
  unknownToolPolicy?: UnknownToolPolicy;
  downstreamFeaturePolicy?: DownstreamFeaturePolicy;
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
  apply_patch: ["path", "file_path", "filename", "patch", "diff"],
  create_file: ["path", "file_path", "filename"],
  edit_file: ["path", "file_path", "filename"],
  str_replace: ["path", "file_path", "filename"],
  write_file: ["path", "file_path", "filename"],
  Write: ["file_path", "path", "filepath", "filename"],
  Edit: ["file_path", "path", "filepath", "filename"],
  NotebookEdit: ["file_path", "path", "filepath", "filename"],
  MultiEdit: ["file_path", "path", "filepath", "filename"],
  patch: ["file_path", "path", "filepath", "filename", "patch", "diff"],
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
  --unknown-tool-policy POLICY  allow or deny unconfigured tools. Defaults to deny.
  --downstream-feature-policy POLICY
                                allow or deny downstream resources, prompts, and completions. Defaults to deny.
  --tool-config PATH            JSON file with writeTools, readTools, and/or unknownToolPolicy.
  --write-tool NAME=KEYS        Override one write tool. KEYS is comma-separated.
  --read-tool NAME              Allowlist a read-only tool. Repeatable.
  --downstream-command CMD      MCP server command to wrap.
  --downstream-arg ARG          Repeatable downstream argument.
  --downstream-cwd DIR          Working directory for the downstream server. Must be inside --root unless --allow-cwd-mismatch is set.
  --downstream-env NAME         Extra exact environment variable name to forward to the downstream server. Repeatable/comma-separated.
  --allow-cwd-mismatch          Skip the --downstream-cwd containment check (H-6 opt-in escape hatch).
  --help                        Show this help.

Environment:
	  CELLFENCE_AGENT, CELLFENCE_MCP_MODE, CELLFENCE_MCP_FAIL_MODE,
	  CELLFENCE_MCP_UNKNOWN_TOOL_POLICY, CELLFENCE_MCP_READ_TOOLS,
	  CELLFENCE_MCP_AUDIT_LOG, CELLFENCE_MCP_DOWNSTREAM_COMMAND,
	  CELLFENCE_MCP_DOWNSTREAM_FEATURE_POLICY
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

function pathFromDiffHeader(value: string): string | undefined {
  const trimmed = value.trim();
  if (trimmed === "/dev/null") return undefined;
  if (trimmed.startsWith("a/") || trimmed.startsWith("b/")) return trimmed.slice(2);
  return trimmed;
}

function pathsFromPatchText(value: string): string[] {
  const paths: string[] = [];
  for (const line of value.split(/\r?\n/)) {
    let match = /^\*\*\* (?:Add|Update|Delete) File: (.+)$/.exec(line);
    if (match) {
      paths.push(match[1].trim());
      continue;
    }
    match = /^\*\*\* Move to: (.+)$/.exec(line);
    if (match) {
      paths.push(match[1].trim());
      continue;
    }
    match = /^diff --git\s+a\/(.+?)\s+b\/(.+)$/.exec(line);
    if (match) {
      paths.push(match[1].trim(), match[2].trim());
      continue;
    }
    match = /^(?:---|\+\+\+)\s+(.+)$/.exec(line);
    if (match) {
      const filePath = pathFromDiffHeader(match[1]);
      if (filePath) paths.push(filePath);
    }
  }
  return paths.filter((entry) => entry.length > 0);
}

function keyLooksLikePatchPayload(keyPath: string): boolean {
  const segments = keyPath.split(".");
  const key = segments[segments.length - 1]?.replace(/\[\]$/, "").toLowerCase();
  return key === "patch" || key === "diff";
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

function parseDownstreamFeaturePolicy(value: string | undefined): DownstreamFeaturePolicy {
  if (value === "allow" || value === "deny") return value;
  throw new Error(`invalid downstream feature policy ${value === undefined || value === "" ? "(empty)" : value}`);
}

function parseDownstreamEnvAllowlist(value: string | undefined): string[] {
  if (!value) return [];
  return value.split(",").map((entry) => entry.trim()).filter(Boolean).map((name) => {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error(`invalid downstream env name ${name}`);
    return name;
  });
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
  let downstreamFeaturePolicy = parseDownstreamFeaturePolicy(env.CELLFENCE_MCP_DOWNSTREAM_FEATURE_POLICY ?? "deny");
  let auditLogPath = env.CELLFENCE_MCP_AUDIT_LOG;
  let downstreamCommand = env.CELLFENCE_MCP_DOWNSTREAM_COMMAND || "";
  let downstreamArgs: string[] = [];
  let downstreamCwd: string | undefined;
  let downstreamEnvAllowlist = parseDownstreamEnvAllowlist(env.CELLFENCE_MCP_DOWNSTREAM_ENV_ALLOW);
  let allowCwdMismatch = false;
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
    } else if (argument === "--downstream-feature-policy") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) throw new Error("--downstream-feature-policy requires allow or deny");
      downstreamFeaturePolicy = parseDownstreamFeaturePolicy(value);
      index += 1;
    } else if (argument.startsWith("--downstream-feature-policy=")) {
      downstreamFeaturePolicy = parseDownstreamFeaturePolicy(argument.slice("--downstream-feature-policy=".length));
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
    } else if (argument === "--downstream-env") {
      downstreamEnvAllowlist = [...downstreamEnvAllowlist, ...parseDownstreamEnvAllowlist(argv[index + 1])];
      index += 1;
    } else if (argument.startsWith("--downstream-env=")) {
      downstreamEnvAllowlist = [...downstreamEnvAllowlist, ...parseDownstreamEnvAllowlist(argument.slice("--downstream-env=".length))];
    } else if (argument === "--allow-cwd-mismatch") {
      allowCwdMismatch = true;
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
    downstreamEnv: safeDownstreamEnvironment(env, downstreamEnvAllowlist),
    allowCwdMismatch,
    writeTools,
    readTools,
    unknownToolPolicy,
    downstreamFeaturePolicy,
  };
}

export function pathsForToolCall(toolName: string, args: unknown, writeTools: WriteToolConfig): string[] | undefined {
  // H-5: real clients (Claude Code, Cursor) often capitalise tool
  // names (Write, Edit). The previous exact-match lookup let
  // case-mismatched calls bypass path extraction. Look up the keys
  // case-insensitively while preserving the original config casing.
  const wanted = toolName.toLowerCase();
  // 0.4.x (N-10): the previous lookup iterated DEFAULT_WRITE_TOOLS
  // in declaration order, where 'Edit' precedes 'edit'. A caller
  // that passed --write-tool edit=... added a lowercase override
  // key, but the case-insensitive find stopped at the first hit
  // (the capitalised 'Edit' built into the defaults) and silently
  // ignored the override. Reverse the search so the last
  // declared matching key wins — overrides sit on top of the
  // defaults because they were merged in after the spread.
  const matchKey = Object.keys(writeTools)
    .reverse()
    .find((key) => key.toLowerCase() === wanted);
  if (!matchKey) return undefined;
  const keys = writeTools[matchKey];
  if (!keys) return undefined;
  const paths: string[] = [];
  for (const key of keys) {
    for (const value of getNestedValues(args, key)) {
      if (keyLooksLikePatchPayload(key)) {
        for (const patchText of stringsFromValue(value)) paths.push(...pathsFromPatchText(patchText));
      } else {
        paths.push(...stringsFromValue(value));
      }
    }
  }
  return [...new Set(paths)];
}

function authorizationPathsForToolCall(options: ProxyOptions, paths: string[]): string[] {
  const downstreamCwd = resolveAndValidateDownstreamCwd(
    options.rootDir,
    options.downstreamCwd,
    options.allowCwdMismatch === true,
  );
  return paths.map((targetPath) => path.isAbsolute(targetPath)
    ? path.resolve(targetPath)
    : path.resolve(downstreamCwd, targetPath));
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

function isConfiguredReadTool(options: ProxyOptions, toolName: string): boolean {
  const wanted = toolName.toLowerCase();
  return (options.readTools ?? []).some((tool) => tool.toLowerCase() === wanted);
}

export function decideToolCall(options: ProxyOptions, toolName: string, args: unknown): ToolDecision {
  const paths = pathsForToolCall(toolName, args, options.writeTools);
  if (options.mode === "off") {
    return { shouldForward: true, auditDecision: "off", paths: paths || [], reason: "guard disabled" };
  }
  if (paths === undefined) {
    if (isConfiguredReadTool(options, toolName)) {
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
    const authorizationPaths = authorizationPathsForToolCall(options, paths);
    const access = checkWriteAccess({
      rootDir: options.rootDir,
      manifestPath: options.manifestPath,
      claimsPath: options.claimsPath,
      agent: options.agent,
      paths: authorizationPaths,
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

export async function decideToolCallAsync(options: ProxyOptions, toolName: string, args: unknown): Promise<ToolDecision> {
  const paths = pathsForToolCall(toolName, args, options.writeTools);
  if (options.mode === "off") {
    return { shouldForward: true, auditDecision: "off", paths: paths || [], reason: "guard disabled" };
  }
  if (paths === undefined) {
    if (isConfiguredReadTool(options, toolName)) {
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
    const authorizationPaths = authorizationPathsForToolCall(options, paths);
    const access = await checkWriteAccessAsync({
      rootDir: options.rootDir,
      manifestPath: options.manifestPath,
      claimsPath: options.claimsPath,
      agent: options.agent,
      paths: authorizationPaths,
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
// 0.4.x (N-9): the previous allowlist whitelisted every
// CELLFENCE_MCP_* prefix, which let through knob names that
// should not have left the proxy (CELLFENCE_MCP_AUDIT_LOG exposes
// the audit log path; CELLFENCE_MCP_UNKNOWN_TOOL_POLICY lets a
// caller override the gate). Replace
// the CELLFENCE_MCP_ prefix with an explicit set of the
// configuration knobs the downstream MCP server genuinely needs
// to honour, and add the missing cross-platform variables
// (NODE_EXTRA_CA_CERTS for TLS interception, the standard
// HTTP(S)_PROXY / NO_PROXY trio, and the Windows SystemRoot /
// ComSpec / PATHEXT / APPDATA entries that downstream servers
// spawned from cmd.exe need to bootstrap). LC_ stays as a prefix
// because every LC_* locale variable is needed by the downstream
// for the same reason LANG is; pinning the eight explicit names
// would be fragile.
const SAFE_DOWNSTREAM_ENV_NAMES = new Set([
  // Process / shell environment
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
  "TZ",
  "SHELL",
  "LANGUAGE",
  "TERM",
  "PWD",
  // Proxy / TLS interception
  "NODE_EXTRA_CA_CERTS",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
  // Windows-specific bootstrap
  "SystemRoot",
  "ComSpec",
  "PATHEXT",
  "APPDATA",
  "LOCALAPPDATA",
  // The proxy's own MCP knobs the downstream is allowed to read.
  // Audit / unknown-tool knobs are intentionally NOT included.
  "CELLFENCE_MCP_MODE",
  "CELLFENCE_MCP_FAIL_MODE",
  "CELLFENCE_MCP_READ_TOOLS",
  "CELLFENCE_MCP_DOWNSTREAM_COMMAND",
]);

const SAFE_DOWNSTREAM_ENV_PREFIXES = [
  "LC_",
];

function safeDownstreamEnvironment(env: NodeJS.ProcessEnv, extraNames: readonly string[] = []): Record<string, string> {
  const result: Record<string, string> = {};
  const allowedExtraNames = new Set(extraNames);
  for (const [name, value] of Object.entries(env)) {
    if (typeof value !== "string") continue;
    if (SAFE_DOWNSTREAM_ENV_NAMES.has(name) || allowedExtraNames.has(name)) {
      result[name] = value;
      continue;
    }
    if (SAFE_DOWNSTREAM_ENV_PREFIXES.some((prefix) => name.startsWith(prefix))) {
      result[name] = value;
    }
  }
  return result;
}

export const __testing = { safeDownstreamEnvironment, resolveAndValidateDownstreamCwd };

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
  return isConfiguredReadTool(options, toolName);
}

// H-6 (0.3.0): --downstream-cwd is the working directory of the
// spawned MCP server. Without this guard a confused-deputy attack
// (or a plain misconfiguration) could redirect the server's
// filesystem access to anywhere the cellfence-mcp-proxy process can
// reach, so the cwd must sit inside --root unless the operator
// explicitly opts in with allowCwdMismatch. The default cwd is
// --root so the safe option is also the convenient one.
function resolveRealPathForConfinement(targetPath: string): string {
  const absolute = path.resolve(targetPath);
  if (fs.existsSync(absolute)) return fs.realpathSync.native(absolute);
  const missingSegments: string[] = [];
  let cursor = absolute;
  while (!fs.existsSync(cursor)) {
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    missingSegments.unshift(path.basename(cursor));
    cursor = parent;
  }
  const realParent = fs.realpathSync.native(cursor);
  return path.resolve(realParent, ...missingSegments);
}

export function resolveAndValidateDownstreamCwd(rootDir: string, downstreamCwd: string | undefined, allowCwdMismatch: boolean): string {
  const absoluteRoot = path.resolve(rootDir);
  if (!downstreamCwd) return absoluteRoot;
  const absoluteCwd = path.resolve(downstreamCwd);
  if (allowCwdMismatch) return absoluteCwd;
  const realRoot = resolveRealPathForConfinement(absoluteRoot);
  const realCwd = resolveRealPathForConfinement(absoluteCwd);
  const relativeCwd = path.relative(realRoot, realCwd);
  if (relativeCwd.startsWith("..") || path.isAbsolute(relativeCwd)) {
    throw new Error(
      `--downstream-cwd must be inside --root (${realRoot}); got ${realCwd}. ` +
      `Pass --allow-cwd-mismatch to override.`,
    );
  }
  return absoluteCwd;
}

export async function runProxy(options: ProxyOptions): Promise<void> {
  const validatedCwd = resolveAndValidateDownstreamCwd(
    options.rootDir,
    options.downstreamCwd,
    options.allowCwdMismatch === true,
  );
  const downstreamTransport = new StdioClientTransport({
    command: options.downstreamCommand,
    args: options.downstreamArgs,
    cwd: validatedCwd,
    env: options.downstreamEnv ?? safeDownstreamEnvironment(process.env),
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
  const featurePolicy = options.downstreamFeaturePolicy ?? "deny";
  const capabilities: ServerCapabilities = {
    tools: downstreamCapabilities.tools || {},
    ...(featurePolicy === "allow" && downstreamCapabilities.resources ? { resources: downstreamCapabilities.resources } : {}),
    ...(featurePolicy === "allow" && downstreamCapabilities.prompts ? { prompts: downstreamCapabilities.prompts } : {}),
    ...(featurePolicy === "allow" && downstreamCapabilities.completions ? { completions: downstreamCapabilities.completions } : {}),
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
    const decision = await decideToolCallAsync(options, toolName, toolArgs);
    audit(options, toolName, decision);
    if (!decision.shouldForward) return deniedToolResult(toolName, decision);
    return downstream.callTool(request.params);
  });

  if (featurePolicy === "allow" && downstreamCapabilities.resources) {
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

  if (featurePolicy === "allow" && downstreamCapabilities.prompts) {
    server.setRequestHandler(ListPromptsRequestSchema, async (request) => downstream.listPrompts(request.params));
    server.setRequestHandler(GetPromptRequestSchema, async (request) => downstream.getPrompt(request.params));
    if (downstreamCapabilities.prompts.listChanged) {
      downstream.setNotificationHandler(PromptListChangedNotificationSchema, async () => {
        await server.sendPromptListChanged();
      });
    }
  }

  if (featurePolicy === "allow" && downstreamCapabilities.completions) {
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
