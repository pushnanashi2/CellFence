#!/usr/bin/env node
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

import {
  type CellFenceContext,
  type AutoAllocation,
  type ClaimCheckResult,
  checkChangedRepository,
  checkClaims,
  checkRepository,
  createClaim,
  createAutoAllocation,
  createCellContext,
  createCouplingGraph,
  createWaiverRequest,
  createBaseline,
  defaultBaselinePath,
  formatCouplingGraphMermaid,
  formatHumanResult,
  guardBaselineUpdate,
  inferManifest,
  listClaims,
  listWaivers,
  type CheckResult,
  type Finding,
  writeBaselineFile,
} from "@cellfence/engine";

type ParsedArgs = {
  command: string[];
  manifestPath?: string;
  baselinePath?: string;
  auditLogPath?: string;
  summaryJsonPath?: string;
  cellId?: string;
  claimId?: string;
  claimsPath?: string;
  agent?: string;
  evidencePaths: string[];
  claimCells: string[];
  claimPaths: string[];
  symbols: string[];
  resources: string[];
  artifactLanes: string[];
  format?: string;
  json: boolean;
  rootDir: string;
  changed: boolean;
  autoAllocate: boolean;
  baseRef?: string;
  headRef?: string;
  task?: string;
  installTarget?: string;
  ruleId?: string;
  targetFilePath?: string;
  line?: number;
  expires?: string;
  ttl?: string;
  reason?: string;
  approvedBy?: string;
  checkInstall: boolean;
  uninstall: boolean;
  mcp: boolean;
};

function printUsage(): void {
  console.log(`CellFence

Usage:
  cellfence init
  cellfence check [--manifest cellfence.manifest.json] [--json] [--audit-log audit.jsonl] [--summary-json summary.json]
  cellfence check --changed [--base origin/main] [--head HEAD] [--json] [--audit-log audit.jsonl] [--summary-json summary.json]
  cellfence context --cell cell-id [--manifest cellfence.manifest.json] [--baseline cellfence.baseline.json] [--json|--format agents-md]
  cellfence context --auto-allocate --task "task text" [--cell cell-id] [--json|--format agents-md]
  cellfence install --target agents-md --file AGENTS.md [--check|--uninstall] [--json]
  cellfence serve --mcp
  cellfence graph [--json|--format mermaid]
  cellfence claim create --agent agent-id --cell cell-id [--path glob] [--ttl 2h] [--claims .cellfence/claims.json] [--json]
  cellfence claim check [--agent agent-id] [--base origin/main] [--head HEAD] [--claims .cellfence/claims.json] [--json]
  cellfence claim list [--claims .cellfence/claims.json] [--json]
  cellfence baseline create [--manifest cellfence.manifest.json] [--baseline cellfence.baseline.json] [--evidence resource-evidence.json]
  cellfence baseline check [--manifest cellfence.manifest.json] [--baseline cellfence.baseline.json] [--evidence resource-evidence.json] [--json] [--audit-log audit.jsonl] [--summary-json summary.json]
  cellfence baseline update [--manifest cellfence.manifest.json] [--baseline cellfence.baseline.json] [--evidence resource-evidence.json]
  cellfence evidence check --evidence resource-evidence.json [--manifest cellfence.manifest.json] [--baseline cellfence.baseline.json] [--json]
  cellfence waivers list [--manifest cellfence.manifest.json] [--json]
  cellfence waivers request --rule CELLFENCE_RULE --file path --line n --expires YYYY-MM-DD --reason text [--approved-by name] [--json]

Exit codes:
  0  no violations
  1  governance violations
  2  configuration or manifest error
  3  internal tool error`);
}

function parseArgs(argv: string[]): ParsedArgs {
  const parsed: ParsedArgs = {
    command: [],
    evidencePaths: [],
    claimCells: [],
    claimPaths: [],
    symbols: [],
    resources: [],
    artifactLanes: [],
    json: false,
    rootDir: process.cwd(),
    changed: false,
    autoAllocate: false,
    checkInstall: false,
    uninstall: false,
    mcp: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--json") {
      parsed.json = true;
    } else if (argument === "--changed") {
      parsed.changed = true;
    } else if (argument === "--auto-allocate") {
      parsed.autoAllocate = true;
    } else if (argument === "--check") {
      parsed.checkInstall = true;
    } else if (argument === "--uninstall") {
      parsed.uninstall = true;
    } else if (argument === "--mcp") {
      parsed.mcp = true;
    } else if (argument === "--base") {
      parsed.baseRef = argv[index + 1];
      index += 1;
    } else if (argument.startsWith("--base=")) {
      parsed.baseRef = argument.slice("--base=".length);
    } else if (argument === "--head") {
      parsed.headRef = argv[index + 1];
      index += 1;
    } else if (argument.startsWith("--head=")) {
      parsed.headRef = argument.slice("--head=".length);
    } else if (argument === "--manifest") {
      parsed.manifestPath = argv[index + 1];
      index += 1;
    } else if (argument.startsWith("--manifest=")) {
      parsed.manifestPath = argument.slice("--manifest=".length);
    } else if (argument === "--baseline") {
      parsed.baselinePath = argv[index + 1];
      index += 1;
    } else if (argument.startsWith("--baseline=")) {
      parsed.baselinePath = argument.slice("--baseline=".length);
    } else if (argument === "--audit-log") {
      parsed.auditLogPath = argv[index + 1];
      index += 1;
    } else if (argument.startsWith("--audit-log=")) {
      parsed.auditLogPath = argument.slice("--audit-log=".length);
    } else if (argument === "--summary-json") {
      parsed.summaryJsonPath = argv[index + 1];
      index += 1;
    } else if (argument.startsWith("--summary-json=")) {
      parsed.summaryJsonPath = argument.slice("--summary-json=".length);
    } else if (argument === "--cell") {
      parsed.cellId = argv[index + 1];
      parsed.claimCells.push(argv[index + 1]);
      index += 1;
    } else if (argument.startsWith("--cell=")) {
      parsed.cellId = argument.slice("--cell=".length);
      parsed.claimCells.push(parsed.cellId);
    } else if (argument === "--agent") {
      parsed.agent = argv[index + 1];
      index += 1;
    } else if (argument.startsWith("--agent=")) {
      parsed.agent = argument.slice("--agent=".length);
    } else if (argument === "--claim-id") {
      parsed.claimId = argv[index + 1];
      index += 1;
    } else if (argument.startsWith("--claim-id=")) {
      parsed.claimId = argument.slice("--claim-id=".length);
    } else if (argument === "--claims") {
      parsed.claimsPath = argv[index + 1];
      index += 1;
    } else if (argument.startsWith("--claims=")) {
      parsed.claimsPath = argument.slice("--claims=".length);
    } else if (argument === "--path") {
      parsed.claimPaths.push(argv[index + 1]);
      index += 1;
    } else if (argument.startsWith("--path=")) {
      parsed.claimPaths.push(argument.slice("--path=".length));
    } else if (argument === "--symbol") {
      parsed.symbols.push(argv[index + 1]);
      index += 1;
    } else if (argument.startsWith("--symbol=")) {
      parsed.symbols.push(argument.slice("--symbol=".length));
    } else if (argument === "--resource") {
      parsed.resources.push(argv[index + 1]);
      index += 1;
    } else if (argument.startsWith("--resource=")) {
      parsed.resources.push(argument.slice("--resource=".length));
    } else if (argument === "--artifact") {
      parsed.artifactLanes.push(argv[index + 1]);
      index += 1;
    } else if (argument.startsWith("--artifact=")) {
      parsed.artifactLanes.push(argument.slice("--artifact=".length));
    } else if (argument === "--task") {
      parsed.task = argv[index + 1];
      index += 1;
    } else if (argument.startsWith("--task=")) {
      parsed.task = argument.slice("--task=".length);
    } else if (argument === "--target") {
      parsed.installTarget = argv[index + 1];
      index += 1;
    } else if (argument.startsWith("--target=")) {
      parsed.installTarget = argument.slice("--target=".length);
    } else if (argument === "--rule") {
      parsed.ruleId = argv[index + 1];
      index += 1;
    } else if (argument.startsWith("--rule=")) {
      parsed.ruleId = argument.slice("--rule=".length);
    } else if (argument === "--file") {
      parsed.targetFilePath = argv[index + 1];
      index += 1;
    } else if (argument.startsWith("--file=")) {
      parsed.targetFilePath = argument.slice("--file=".length);
    } else if (argument === "--line") {
      parsed.line = Number(argv[index + 1]);
      index += 1;
    } else if (argument.startsWith("--line=")) {
      parsed.line = Number(argument.slice("--line=".length));
    } else if (argument === "--expires") {
      parsed.expires = argv[index + 1];
      index += 1;
    } else if (argument.startsWith("--expires=")) {
      parsed.expires = argument.slice("--expires=".length);
    } else if (argument === "--ttl") {
      parsed.ttl = argv[index + 1];
      index += 1;
    } else if (argument.startsWith("--ttl=")) {
      parsed.ttl = argument.slice("--ttl=".length);
    } else if (argument === "--reason") {
      parsed.reason = argv[index + 1];
      index += 1;
    } else if (argument.startsWith("--reason=")) {
      parsed.reason = argument.slice("--reason=".length);
    } else if (argument === "--approved-by") {
      parsed.approvedBy = argv[index + 1];
      index += 1;
    } else if (argument.startsWith("--approved-by=")) {
      parsed.approvedBy = argument.slice("--approved-by=".length);
    } else if (argument === "--evidence") {
      parsed.evidencePaths.push(argv[index + 1]);
      index += 1;
    } else if (argument.startsWith("--evidence=")) {
      parsed.evidencePaths.push(argument.slice("--evidence=".length));
    } else if (argument === "--format") {
      parsed.format = argv[index + 1];
      index += 1;
    } else if (argument.startsWith("--format=")) {
      parsed.format = argument.slice("--format=".length);
    } else if (argument === "--root") {
      parsed.rootDir = path.resolve(argv[index + 1]);
      index += 1;
    } else if (argument.startsWith("--root=")) {
      parsed.rootDir = path.resolve(argument.slice("--root=".length));
    } else {
      parsed.command.push(argument);
    }
  }
  return parsed;
}

function writeJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

function errorMessage(error: unknown): string {
  return String(error).replace(/^[A-Za-z]*Error: /, "");
}

type CheckRunMetadata = {
  command: string;
  runId: string;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  commit: string | null;
};

type AuditEvent = {
  schemaVersion: "cellfence.audit-event.v1";
  runId: string;
  timestamp: string;
  commit: string | null;
  event: string;
  command: string;
  [key: string]: unknown;
};

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item)).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
}

function findingFingerprint(finding: Finding): string {
  /* c8 ignore next -- CLI cannot currently load plugins that emit precomputed finding fingerprints. */
  if (finding.fingerprint) return finding.fingerprint;
  return crypto.createHash("sha256").update(stableJson({
    ruleId: finding.ruleId,
    severity: finding.severity,
    filePath: finding.filePath,
    cellId: finding.cellId,
    producerCellId: finding.producerCellId,
    message: finding.message,
    details: finding.details,
  })).digest("hex");
}

function currentCommit(rootDir: string): string | null {
  if (process.env.GITHUB_SHA) return process.env.GITHUB_SHA;
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: rootDir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim() || null;
  } catch {
    return null;
  }
}

function resolveOutputPath(rootDir: string, filePath: string): string {
  return path.isAbsolute(filePath) ? filePath : path.resolve(rootDir, filePath);
}

function writeFileEnsuringDirectory(filePath: string, contents: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, contents);
}

function createRunMetadata(command: string, rootDir: string, startedAtMs: number, startedAt: string): CheckRunMetadata {
  const completedAtMs = Date.now();
  return {
    command,
    runId: crypto.randomUUID(),
    startedAt,
    completedAt: new Date(completedAtMs).toISOString(),
    durationMs: completedAtMs - startedAtMs,
    commit: currentCommit(rootDir),
  };
}

function countBy<T extends string>(values: T[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const value of values) counts[value] = (counts[value] || 0) + 1;
  return counts;
}

function checkSummary(result: CheckResult, metadata: CheckRunMetadata): Record<string, unknown> {
  const allFindings = [...result.findings, ...result.warnings];
  const cells = allFindings.map((finding) => finding.cellId).filter((cellId): cellId is string => Boolean(cellId));
  return {
    schemaVersion: "cellfence.summary.v1",
    runId: metadata.runId,
    command: metadata.command,
    commit: metadata.commit,
    startedAt: metadata.startedAt,
    completedAt: metadata.completedAt,
    durationMs: metadata.durationMs,
    ok: result.ok,
    exitCode: result.exitCode,
    counts: {
      findings: result.findings.length,
      warnings: result.warnings.length,
      changedFiles: result.changedFiles?.length || 0,
      baseFindings: result.baseFindingCount,
      impactedCells: new Set(cells).size,
    },
    failedRules: [...new Set(result.findings.map((finding) => finding.ruleId))].sort(),
    warningRules: [...new Set(result.warnings.map((finding) => finding.ruleId))].sort(),
    findingsByRule: countBy(result.findings.map((finding) => finding.ruleId)),
    warningsByRule: countBy(result.warnings.map((finding) => finding.ruleId)),
    findingsByCell: countBy(cells),
    findingFingerprints: result.findings.map((finding) => findingFingerprint(finding)),
    warningFingerprints: result.warnings.map((finding) => findingFingerprint(finding)),
  };
}

function auditEventsForCheck(result: CheckResult, metadata: CheckRunMetadata, parsed: ParsedArgs): AuditEvent[] {
  const startedEvent: AuditEvent = {
    schemaVersion: "cellfence.audit-event.v1",
    runId: metadata.runId,
    timestamp: metadata.startedAt,
    commit: metadata.commit,
    event: "check.started",
    command: metadata.command,
    changed: parsed.changed,
    manifestPath: parsed.manifestPath || "cellfence.manifest.json",
    baselinePath: parsed.baselinePath,
    evidencePaths: parsed.evidencePaths,
  };
  const events: AuditEvent[] = [startedEvent];
  if (result.changedFiles) {
    events.push({
      schemaVersion: "cellfence.audit-event.v1",
      runId: metadata.runId,
      timestamp: metadata.completedAt,
      commit: metadata.commit,
      event: "changed_files.computed",
      command: metadata.command,
      count: result.changedFiles.length,
      changedFiles: result.changedFiles,
    });
  }
  if (parsed.baselinePath) {
    events.push({
      schemaVersion: "cellfence.audit-event.v1",
      runId: metadata.runId,
      timestamp: metadata.completedAt,
      commit: metadata.commit,
      event: "baseline.compared",
      command: metadata.command,
      baselinePath: parsed.baselinePath,
      metricCells: Object.keys(result.metrics).length,
      baseFindingCount: result.baseFindingCount,
    });
  }
  for (const finding of [...result.findings, ...result.warnings]) {
    events.push({
      schemaVersion: "cellfence.audit-event.v1",
      runId: metadata.runId,
      timestamp: metadata.completedAt,
      commit: metadata.commit,
      event: "finding.detected",
      command: metadata.command,
      ruleId: finding.ruleId,
      severity: finding.severity,
      cellId: finding.cellId,
      producerCellId: finding.producerCellId,
      filePath: finding.filePath,
      message: finding.message,
      fingerprint: findingFingerprint(finding),
      details: finding.details,
      outcome: finding.severity === "error" ? "rejected" : "reported",
    });
  }
  events.push({
    schemaVersion: "cellfence.audit-event.v1",
    runId: metadata.runId,
    timestamp: metadata.completedAt,
    commit: metadata.commit,
    event: "check.completed",
    command: metadata.command,
    ok: result.ok,
    exitCode: result.exitCode,
    findings: result.findings.length,
    warnings: result.warnings.length,
    durationMs: metadata.durationMs,
  });
  return events;
}

function writeCheckArtifacts(parsed: ParsedArgs, result: CheckResult, metadata: CheckRunMetadata): void {
  if (parsed.auditLogPath) {
    const events = auditEventsForCheck(result, metadata, parsed);
    writeFileEnsuringDirectory(resolveOutputPath(parsed.rootDir, parsed.auditLogPath), `${events.map((event) => JSON.stringify(event)).join("\n")}\n`);
  }
  if (parsed.summaryJsonPath) {
    writeFileEnsuringDirectory(resolveOutputPath(parsed.rootDir, parsed.summaryJsonPath), `${JSON.stringify(checkSummary(result, metadata), null, 2)}\n`);
  }
}

function commandInit(rootDir: string): number {
  const manifestPath = path.join(rootDir, "cellfence.manifest.json");
  if (fs.existsSync(manifestPath)) {
    console.error("cellfence.manifest.json already exists");
    return 2;
  }
  const manifest = inferManifest({ rootDir });
  if (manifest.cells.length === 1 && manifest.cells[0]?.id === "example") {
    fs.mkdirSync(path.join(rootDir, "src/example"), { recursive: true });
    fs.writeFileSync(path.join(rootDir, "src/example/public.ts"), "export const example = true;\n");
  }
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`created ${manifestPath}`);
  return 0;
}

function commandCheck(parsed: ParsedArgs): number {
  const options = {
    rootDir: parsed.rootDir,
    manifestPath: parsed.manifestPath,
  };
  const startedAtMs = Date.now();
  const startedAt = new Date(startedAtMs).toISOString();
  const result = parsed.changed
    ? checkChangedRepository({
      ...options,
      baselinePath: parsed.baselinePath,
      evidencePaths: parsed.evidencePaths,
      baseRef: parsed.baseRef,
      headRef: parsed.headRef,
    })
    : checkRepository(options);
  writeCheckArtifacts(parsed, result, createRunMetadata(parsed.changed ? "check --changed" : "check", parsed.rootDir, startedAtMs, startedAt));
  if (parsed.json) writeJson(result);
  else console.log(formatHumanResult(result));
  return result.exitCode;
}

function bulletList(values: string[], emptyValue = "(none)"): string[] {
  return values.length > 0 ? values.map((value) => `- ${value}`) : [`- ${emptyValue}`];
}

function formatContextAsAgentsMarkdown(context: CellFenceContext): string {
  const lines: string[] = [];
  lines.push(`# CellFence Context: ${context.cell.id}`);
  lines.push("");
  lines.push("## Owned Paths");
  lines.push(...bulletList(context.cell.ownedPaths));
  lines.push("");
  lines.push("## Public Surface");
  lines.push(`- publicEntry: ${context.cell.publicEntry}`);
  if (context.cell.packageName) lines.push(`- packageName: ${context.cell.packageName}`);
  lines.push(`- locked: ${context.cell.locked ? "true" : "false"}`);
  lines.push(...context.cell.publicSymbols.map((symbol) => `- symbol: ${symbol}`));
  lines.push("");
  lines.push("## Allowed Cross-Cell Imports");
  if (context.allowedImports.length === 0) {
    lines.push("- (none)");
  } else {
    for (const allowedImport of context.allowedImports) {
      const packageSuffix = allowedImport.packageName ? ` or ${allowedImport.packageName}` : "";
      const laneSuffix = allowedImport.artifactLanes.length > 0 ? `; artifact lanes: ${allowedImport.artifactLanes.join(", ")}` : "";
      const lockedSuffix = allowedImport.locked ? "; locked" : "";
      lines.push(`- ${allowedImport.cell}: ${allowedImport.publicEntry}${packageSuffix}${laneSuffix}${lockedSuffix}`);
    }
  }
  lines.push("");
  lines.push("## Allowed Resources");
  const resources = [
    ...context.allowedResources.flatMap((contract) =>
      contract.access.flatMap((access) =>
        contract.selectors.map((selector) => `${contract.kind}:${access}:${selector} (${contract.id})`)
      )
    ),
    ...context.baselineResources.map((resource) => `${resource.kind}:${resource.access}:${resource.selector} (baseline)`),
  ];
  lines.push(...bulletList(resources));
  lines.push("");
  lines.push("## Budget");
  const budgetEntries = Object.entries(context.budgets);
  if (budgetEntries.length === 0) {
    lines.push("- (none)");
  } else {
    for (const [metric, budget] of budgetEntries) {
      lines.push(`- ${metric}: ${budget.current}/${budget.limit}, remaining ${budget.remaining}, source ${budget.source}`);
    }
  }
  lines.push("");
  lines.push("## Guidance");
  lines.push(...bulletList(context.guidance));
  return lines.join("\n");
}

function formatAutoAllocationAsAgentsMarkdown(allocation: AutoAllocation): string {
  const lines: string[] = [];
  lines.push("# CellFence Auto Allocation");
  lines.push("");
  lines.push("## Task");
  lines.push(allocation.task.trim().length > 0 ? allocation.task : "(none)");
  lines.push("");
  lines.push("## Selected Cells");
  lines.push(...bulletList(allocation.selectedCells));
  lines.push("");
  lines.push("## Context Cells");
  lines.push(...bulletList(allocation.contextCells));
  lines.push("");
  lines.push("## Include Paths");
  lines.push(...bulletList(allocation.includePaths));
  lines.push("");
  lines.push("## Public Entries");
  lines.push(...bulletList(allocation.publicEntries));
  lines.push("");
  lines.push("## Resource Selectors");
  lines.push(...bulletList(allocation.resourceSelectors));
  lines.push("");
  lines.push("## Budgets");
  const budgetLines: string[] = [];
  for (const [cellId, budgets] of Object.entries(allocation.budgets)) {
    for (const [metric, budget] of Object.entries(budgets)) {
      budgetLines.push(`- ${cellId}.${metric}: ${budget.current}/${budget.limit}, remaining ${budget.remaining}, source ${budget.source}`);
    }
  }
  lines.push(...(budgetLines.length > 0 ? budgetLines : ["- (none)"]));
  lines.push("");
  lines.push("## Guidance");
  lines.push(...bulletList(allocation.guidance));
  return lines.join("\n");
}

function commandContext(parsed: ParsedArgs): number {
  if (parsed.autoAllocate) {
    if (parsed.format && parsed.format !== "agents-md") {
      console.error("cellfence context --auto-allocate supports --format agents-md");
      return 2;
    }
    const allocation = createAutoAllocation({
      rootDir: parsed.rootDir,
      manifestPath: parsed.manifestPath,
      baselinePath: parsed.baselinePath,
      evidencePaths: parsed.evidencePaths,
      cellId: parsed.cellId,
      task: parsed.task,
    });
    if (parsed.json) writeJson(allocation);
    else console.log(formatAutoAllocationAsAgentsMarkdown(allocation));
    return 0;
  }
  if (!parsed.cellId) {
    console.error("cellfence context requires --cell cell-id");
    return 2;
  }
  if (parsed.format && parsed.format !== "agents-md") {
    console.error("cellfence context supports --format agents-md");
    return 2;
  }
  const context = createCellContext({
    rootDir: parsed.rootDir,
    manifestPath: parsed.manifestPath,
    baselinePath: parsed.baselinePath,
    evidencePaths: parsed.evidencePaths,
    cellId: parsed.cellId,
  });
  if (parsed.json) writeJson(context);
  else console.log(formatContextAsAgentsMarkdown(context));
  return 0;
}

function commandGraph(parsed: ParsedArgs): number {
  if (parsed.format && parsed.format !== "mermaid") {
    console.error("cellfence graph supports --format mermaid");
    return 2;
  }
  const graph = createCouplingGraph({
    rootDir: parsed.rootDir,
    manifestPath: parsed.manifestPath,
    baselinePath: parsed.baselinePath,
    evidencePaths: parsed.evidencePaths,
  });
  if (parsed.json) writeJson(graph);
  else console.log(formatCouplingGraphMermaid(graph));
  return 0;
}

function formatClaimResult(result: ClaimCheckResult, createdClaimId?: string): string {
  const lines: string[] = [];
  lines.push(result.ok ? "CellFence claim check passed." : "CellFence claim check failed.");
  if (createdClaimId) lines.push(`Created claim: ${createdClaimId}`);
  lines.push(`Active claims: ${result.activeClaims.length}`);
  if (result.changedFiles) lines.push(`Changed files: ${result.changedFiles.length}`);
  for (const finding of [...result.findings, ...result.warnings]) {
    const location = finding.filePath ? ` ${finding.filePath}` : "";
    lines.push(`[${finding.severity}] ${finding.ruleId}${location}: ${finding.message}`);
  }
  return lines.join("\n");
}

function commandClaimCreate(parsed: ParsedArgs): number {
  if (!parsed.agent) {
    console.error("cellfence claim create requires --agent agent-id");
    return 2;
  }
  const result = createClaim({
    rootDir: parsed.rootDir,
    manifestPath: parsed.manifestPath,
    claimsPath: parsed.claimsPath,
    claimId: parsed.claimId,
    agent: parsed.agent,
    task: parsed.task,
    ttl: parsed.ttl,
    expiresAt: parsed.expires,
    cells: parsed.claimCells,
    paths: parsed.claimPaths,
    symbols: parsed.symbols,
    resources: parsed.resources,
    artifactLanes: parsed.artifactLanes,
  });
  if (parsed.json) writeJson(result);
  else console.log(formatClaimResult(result, result.createdClaim?.id));
  return result.exitCode;
}

function commandClaimCheck(parsed: ParsedArgs): number {
  const result = checkClaims({
    rootDir: parsed.rootDir,
    manifestPath: parsed.manifestPath,
    claimsPath: parsed.claimsPath,
    agent: parsed.agent,
    baseRef: parsed.baseRef,
    headRef: parsed.headRef,
  });
  if (parsed.json) writeJson(result);
  else console.log(formatClaimResult(result));
  return result.exitCode;
}

function commandClaimList(parsed: ParsedArgs): number {
  const result = listClaims({
    rootDir: parsed.rootDir,
    claimsPath: parsed.claimsPath,
  });
  if (parsed.json) {
    writeJson({
      schemaVersion: "cellfence.claims.v1",
      claims: result.claims,
      activeClaims: result.activeClaims,
      findings: result.findings,
      warnings: result.warnings,
    });
  } else if (result.claims.length === 0) {
    console.log("No CellFence claims found.");
  } else {
    for (const claim of result.claims) {
      const active = result.activeClaims.some((activeClaim) => activeClaim.id === claim.id) ? "active" : "expired";
      console.log(`${active} ${claim.id} agent:${claim.agent} cells:${claim.cells.join(",") || "(none)"} expires:${claim.expiresAt}`);
    }
  }
  return result.exitCode;
}

function commandBaselineCreate(parsed: ParsedArgs): number {
  const baseline = createBaseline({
    rootDir: parsed.rootDir,
    manifestPath: parsed.manifestPath,
    evidencePaths: parsed.evidencePaths,
  });
  const baselinePath = path.resolve(parsed.rootDir, parsed.baselinePath || defaultBaselinePath(parsed.rootDir));
  writeBaselineFile(baselinePath, baseline);
  console.log(`created ${baselinePath}`);
  return 0;
}

function commandBaselineCheck(parsed: ParsedArgs, commandName = "baseline check"): number {
  const startedAtMs = Date.now();
  const startedAt = new Date(startedAtMs).toISOString();
  const effectiveParsed = {
    ...parsed,
    baselinePath: parsed.baselinePath || defaultBaselinePath(parsed.rootDir),
  };
  const result = checkRepository({
    rootDir: parsed.rootDir,
    manifestPath: parsed.manifestPath,
    baselinePath: effectiveParsed.baselinePath,
    evidencePaths: parsed.evidencePaths,
  });
  writeCheckArtifacts(effectiveParsed, result, createRunMetadata(commandName, parsed.rootDir, startedAtMs, startedAt));
  if (parsed.json) writeJson(result);
  else console.log(formatHumanResult(result));
  return result.exitCode;
}

function commandBaselineUpdate(parsed: ParsedArgs): number {
  const baseline = createBaseline({
    rootDir: parsed.rootDir,
    manifestPath: parsed.manifestPath,
    evidencePaths: parsed.evidencePaths,
  });
  const baselinePath = path.resolve(parsed.rootDir, parsed.baselinePath || defaultBaselinePath(parsed.rootDir));
  const guard = guardBaselineUpdate({
    rootDir: parsed.rootDir,
    manifestPath: parsed.manifestPath,
    baselinePath,
    evidencePaths: parsed.evidencePaths,
    nextBaseline: baseline,
  });
  if (!guard.ok) {
    console.log(formatHumanResult({
      ok: false,
      exitCode: 1,
      findings: guard.findings,
      warnings: [],
      metrics: baseline.cells,
    }));
    return 1;
  }
  writeBaselineFile(baselinePath, baseline);
  console.log(`updated ${baselinePath}`);
  return 0;
}

function commandEvidenceCheck(parsed: ParsedArgs): number {
  if (parsed.evidencePaths.length === 0) {
    console.error("cellfence evidence check requires at least one --evidence path");
    return 2;
  }
  return commandBaselineCheck(parsed, "evidence check");
}

function commandWaiversList(parsed: ParsedArgs): number {
  const waivers = listWaivers({
    rootDir: parsed.rootDir,
    manifestPath: parsed.manifestPath,
  });
  if (parsed.json) {
    writeJson({ schemaVersion: "cellfence.waivers.v1", waivers });
  } else if (waivers.length === 0) {
    console.log("No CellFence waivers found.");
  } else {
    for (const waiver of waivers) {
      const status = waiver.valid ? "valid" : "invalid";
      console.log(`${status} ${waiver.ruleId} ${waiver.filePath}:${waiver.line} expires:${waiver.expires} approved-by:${waiver.approvedBy}`);
    }
  }
  return waivers.some((waiver) => !waiver.valid) ? 1 : 0;
}

function commandWaiversRequest(parsed: ParsedArgs): number {
  if (!parsed.ruleId || !parsed.targetFilePath || !parsed.line || !parsed.expires || !parsed.reason) {
    console.error("cellfence waivers request requires --rule, --file, --line, --expires, and --reason");
    return 2;
  }
  const request = createWaiverRequest({
    ruleId: parsed.ruleId as Parameters<typeof createWaiverRequest>[0]["ruleId"],
    filePath: parsed.targetFilePath,
    line: parsed.line,
    expires: parsed.expires,
    approvedBy: parsed.approvedBy,
    reason: parsed.reason,
  });
  if (parsed.json) writeJson(request);
  else console.log(request.markdown);
  return 0;
}

const INSTALL_MARKER_START = "<!-- cellfence:start";
const INSTALL_MARKER_END = "<!-- cellfence:end -->";

type InstallTarget = "agents-md" | "claude-md";

type InstallResult = {
  schemaVersion: "cellfence.install.v1";
  ok: boolean;
  action: "install" | "check" | "uninstall";
  target: InstallTarget;
  filePath: string;
  findings: string[];
  changed: boolean;
};

function defaultInstallFile(target: InstallTarget): string {
  return target === "claude-md" ? "CLAUDE.md" : "AGENTS.md";
}

function parseInstallTarget(value: string | undefined): InstallTarget | undefined {
  if (value === undefined || value === "agents-md") return "agents-md";
  if (value === "claude-md") return "claude-md";
  return undefined;
}

function generatedInstallBody(target: InstallTarget): string {
  const heading = target === "claude-md" ? "### Architecture fence (CellFence for Claude)" : "### Architecture fence (CellFence)";
  return [
    heading,
    "",
    "- Before editing, run `npx cellfence context --cell <cell-id> --format agents-md` and follow the returned ownership, import, resource, and budget guidance.",
    "- Stay inside the assigned cell's owned paths. Cross-cell imports must target the producer's declared public entry or package name.",
    "- After editing, `npx cellfence check` must exit 0. When a baseline exists, `npx cellfence baseline check` must also exit 0.",
    "- Treat `cellfence.manifest.json` and `cellfence.baseline.json` as review-gated files. Do not edit them merely to make a check pass.",
    "- Keep this managed block intact. Run `npx cellfence install --check` to verify that the agent-facing instructions have not drifted.",
  ].join("\n");
}

function installChecksum(body: string): string {
  return crypto.createHash("sha256").update(body).digest("hex");
}

function generatedInstallBlock(target: InstallTarget): string {
  const body = generatedInstallBody(target);
  return `${INSTALL_MARKER_START} target:${target} checksum:${installChecksum(body)} -->\n${body}\n${INSTALL_MARKER_END}`;
}

function installBlockPattern(): RegExp {
  return /<!-- cellfence:start[^\n]*-->\n[\s\S]*?\n<!-- cellfence:end -->/m;
}

function installManagedBlock(text: string): string | undefined {
  return installBlockPattern().exec(text)?.[0];
}

function installBodyFromBlock(block: string): string {
  const lines = block.split(/\r?\n/);
  return lines.slice(1, -1).join("\n");
}

function installChecksumFromBlock(block: string): string | undefined {
  return /checksum:([a-f0-9]{64})\b/.exec(block)?.[1];
}

function oldFenceTextOutsideBlock(text: string): boolean {
  const unmanaged = text.replace(installBlockPattern(), "");
  return /Architecture fence \(CellFence/.test(unmanaged) || /cellfence context --cell/.test(unmanaged);
}

function commandInstall(parsed: ParsedArgs): number {
  const target = parseInstallTarget(parsed.installTarget);
  if (!target) {
    console.error("cellfence install supports --target agents-md or --target claude-md");
    return 2;
  }
  if (parsed.checkInstall && parsed.uninstall) {
    console.error("cellfence install cannot use --check and --uninstall together");
    return 2;
  }

  const relativeFilePath = parsed.targetFilePath || defaultInstallFile(target);
  const absoluteFilePath = resolveOutputPath(parsed.rootDir, relativeFilePath);
  const expectedBlock = generatedInstallBlock(target);
  const action: InstallResult["action"] = parsed.uninstall ? "uninstall" : parsed.checkInstall ? "check" : "install";
  const currentText = fs.existsSync(absoluteFilePath) ? fs.readFileSync(absoluteFilePath, "utf8") : "";
  const currentBlock = installManagedBlock(currentText);
  const findings: string[] = [];
  let changed = false;

  if (parsed.checkInstall) {
    if (!currentBlock) {
      findings.push("missing CellFence managed block");
    } else {
      const currentBody = installBodyFromBlock(currentBlock);
      const declaredChecksum = installChecksumFromBlock(currentBlock);
      if (!declaredChecksum || declaredChecksum !== installChecksum(currentBody)) {
        findings.push("managed block checksum does not match its body");
      }
      if (currentBlock !== expectedBlock) {
        findings.push("managed block content differs from the generated CellFence instructions");
      }
    }
    if (oldFenceTextOutsideBlock(currentText)) {
      findings.push("unmanaged CellFence instruction text exists outside the managed block");
    }
  } else if (parsed.uninstall) {
    if (currentBlock) {
      const nextText = currentText.replace(installBlockPattern(), "").replace(/\n{3,}/g, "\n\n").trimEnd();
      writeFileEnsuringDirectory(absoluteFilePath, nextText.length > 0 ? `${nextText}\n` : "");
      changed = true;
    }
  } else {
    const nextText = currentBlock
      ? currentText.replace(installBlockPattern(), expectedBlock)
      : `${currentText.trimEnd()}${currentText.trimEnd().length > 0 ? "\n\n" : ""}${expectedBlock}\n`;
    if (nextText !== currentText) {
      writeFileEnsuringDirectory(absoluteFilePath, nextText);
      changed = true;
    }
  }

  const result: InstallResult = {
    schemaVersion: "cellfence.install.v1",
    ok: findings.length === 0,
    action,
    target,
    filePath: relativeFilePath,
    findings,
    changed,
  };
  if (parsed.json) writeJson(result);
  else if (result.ok) console.log(`CellFence install ${action} passed for ${relativeFilePath}.`);
  else console.log(`CellFence install ${action} failed for ${relativeFilePath}.\n${findings.map((finding) => `- ${finding}`).join("\n")}`);
  return result.ok ? 0 : 1;
}

type JsonRpcId = string | number | null;
type JsonRpcRequest = {
  jsonrpc?: "2.0";
  id?: JsonRpcId;
  method?: string;
  params?: unknown;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringParam(params: Record<string, unknown>, key: string): string | undefined {
  const value = params[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function booleanParam(params: Record<string, unknown>, key: string): boolean | undefined {
  const value = params[key];
  return typeof value === "boolean" ? value : undefined;
}

function mcpTextResult(value: unknown): { content: { type: "text"; text: string }[] } {
  return { content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }] };
}

function mcpToolDefinitions(): Record<string, unknown>[] {
  return [{
    name: "get_cell_context",
    description: "Return CellFence context for one cell before an agent edits it.",
    inputSchema: {
      type: "object",
      properties: {
        cellId: { type: "string" },
        rootDir: { type: "string" },
        manifestPath: { type: "string" },
        baselinePath: { type: "string" },
        format: { type: "string", enum: ["json", "agents-md"] },
      },
      required: ["cellId"],
    },
  }, {
    name: "check_change",
    description: "Run CellFence check or changed-check and return the structured result.",
    inputSchema: {
      type: "object",
      properties: {
        rootDir: { type: "string" },
        manifestPath: { type: "string" },
        baselinePath: { type: "string" },
        changed: { type: "boolean" },
        baseRef: { type: "string" },
        headRef: { type: "string" },
      },
    },
  }, {
    name: "create_claim",
    description: "Create a CellFence claim lease for a parallel coding agent.",
    inputSchema: {
      type: "object",
      properties: {
        agent: { type: "string" },
        cellId: { type: "string" },
        rootDir: { type: "string" },
        manifestPath: { type: "string" },
        claimsPath: { type: "string" },
        ttl: { type: "string" },
      },
      required: ["agent", "cellId"],
    },
  }, {
    name: "explain_finding",
    description: "Explain one CellFence finding and return its suggested resolutions.",
    inputSchema: {
      type: "object",
      properties: {
        finding: { type: "object" },
      },
      required: ["finding"],
    },
  }];
}

function mcpToolCall(name: string, params: Record<string, unknown>, defaultRootDir: string): unknown {
  const rootDir = path.resolve(stringParam(params, "rootDir") || defaultRootDir);
  if (name === "get_cell_context") {
    const cellId = stringParam(params, "cellId");
    if (!cellId) throw new Error("get_cell_context requires cellId");
    const context = createCellContext({
      rootDir,
      manifestPath: stringParam(params, "manifestPath"),
      baselinePath: stringParam(params, "baselinePath"),
      cellId,
    });
    return mcpTextResult(params.format === "agents-md" ? formatContextAsAgentsMarkdown(context) : context);
  }
  if (name === "check_change") {
    const changed = booleanParam(params, "changed") === true;
    const options = {
      rootDir,
      manifestPath: stringParam(params, "manifestPath"),
      baselinePath: stringParam(params, "baselinePath"),
    };
    return mcpTextResult(changed
      ? checkChangedRepository({
        ...options,
        baseRef: stringParam(params, "baseRef"),
        headRef: stringParam(params, "headRef"),
      })
      : checkRepository(options));
  }
  if (name === "create_claim") {
    const agent = stringParam(params, "agent");
    const cellId = stringParam(params, "cellId");
    if (!agent || !cellId) throw new Error("create_claim requires agent and cellId");
    return mcpTextResult(createClaim({
      rootDir,
      manifestPath: stringParam(params, "manifestPath"),
      claimsPath: stringParam(params, "claimsPath"),
      agent,
      ttl: stringParam(params, "ttl"),
      cells: [cellId],
    }));
  }
  if (name === "explain_finding") {
    const finding = params.finding;
    if (!isRecord(finding)) throw new Error("explain_finding requires finding object");
    return mcpTextResult({
      ruleId: finding.ruleId,
      message: finding.message,
      suggestedResolutions: finding.suggestedResolutions || [],
    });
  }
  throw new Error(`unknown CellFence MCP tool: ${name}`);
}

function mcpResponse(id: JsonRpcId | undefined, result: unknown): string {
  return JSON.stringify({ jsonrpc: "2.0", id, result });
}

function mcpError(id: JsonRpcId | undefined, code: number, message: string): string {
  return JSON.stringify({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });
}

function handleMcpRequest(request: JsonRpcRequest, defaultRootDir: string): string | undefined {
  if (request.id === undefined) return undefined;
  if (request.method === "initialize") {
    return mcpResponse(request.id, {
      protocolVersion: "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "cellfence", version: "0.1.10" },
    });
  }
  if (request.method === "tools/list") {
    return mcpResponse(request.id, { tools: mcpToolDefinitions() });
  }
  if (request.method === "tools/call") {
    const params = isRecord(request.params) ? request.params : {};
    const name = stringParam(params, "name");
    const args = isRecord(params.arguments) ? params.arguments : {};
    if (!name) return mcpError(request.id, -32602, "tools/call requires a string name");
    try {
      return mcpResponse(request.id, mcpToolCall(name, args, defaultRootDir));
    } catch (error) {
      return mcpResponse(request.id, {
        isError: true,
        content: [{ type: "text", text: errorMessage(error) }],
      });
    }
  }
  return mcpError(request.id, -32601, `unknown method: ${request.method || "(missing)"}`);
}

function commandServe(parsed: ParsedArgs): number {
  if (!parsed.mcp) {
    console.error("cellfence serve currently requires --mcp");
    return 2;
  }
  const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  input.on("line", (line) => {
    if (line.trim().length === 0) return;
    try {
      const response = handleMcpRequest(JSON.parse(line) as JsonRpcRequest, parsed.rootDir);
      if (response) process.stdout.write(`${response}\n`);
    } catch (error) {
      process.stdout.write(`${mcpError(null, -32700, errorMessage(error))}\n`);
    }
  });
  return 0;
}

export function main(argv = process.argv.slice(2)): number {
  const parsed = parseArgs(argv);
  try {
    if (parsed.command.length === 0 || parsed.command.includes("--help") || parsed.command.includes("-h")) {
      printUsage();
      return 0;
    }
    const [primaryCommand, secondaryCommand] = parsed.command;
    if (primaryCommand === "init") return commandInit(parsed.rootDir);
    if (primaryCommand === "check") return commandCheck(parsed);
    if (primaryCommand === "context") return commandContext(parsed);
    if (primaryCommand === "install") return commandInstall(parsed);
    if (primaryCommand === "serve") return commandServe(parsed);
    if (primaryCommand === "graph") return commandGraph(parsed);
    if (primaryCommand === "claim" && secondaryCommand === "create") return commandClaimCreate(parsed);
    if (primaryCommand === "claim" && secondaryCommand === "check") return commandClaimCheck(parsed);
    if (primaryCommand === "claim" && secondaryCommand === "list") return commandClaimList(parsed);
    if (primaryCommand === "baseline" && secondaryCommand === "create") return commandBaselineCreate(parsed);
    if (primaryCommand === "baseline" && secondaryCommand === "check") return commandBaselineCheck(parsed);
    if (primaryCommand === "baseline" && secondaryCommand === "update") return commandBaselineUpdate(parsed);
    if (primaryCommand === "evidence" && secondaryCommand === "check") return commandEvidenceCheck(parsed);
    if (primaryCommand === "waivers" && secondaryCommand === "list") return commandWaiversList(parsed);
    if (primaryCommand === "waivers" && secondaryCommand === "request") return commandWaiversRequest(parsed);
    printUsage();
    return 2;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 3;
  }
}

function isDirectCliExecution(): boolean {
  if (!process.argv[1]) return false;
  try {
    return fs.realpathSync(fileURLToPath(import.meta.url)) === fs.realpathSync(process.argv[1]);
  } catch {
    return false;
  }
}

if (isDirectCliExecution()) {
  process.exitCode = main();
}
