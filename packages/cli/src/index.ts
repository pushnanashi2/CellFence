#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
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
  listClaims,
  listWaivers,
  writeBaselineFile,
} from "@cellfence/engine";

type ParsedArgs = {
  command: string[];
  manifestPath?: string;
  baselinePath?: string;
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
  ruleId?: string;
  targetFilePath?: string;
  line?: number;
  expires?: string;
  ttl?: string;
  reason?: string;
  approvedBy?: string;
};

const INIT_MANIFEST = {
  schemaVersion: "cellfence.manifest.v1",
  governance: {
    requireOwnership: true,
    include: ["src/**"],
    exclude: [],
  },
  cells: [
    {
      id: "example",
      ownedPaths: ["src/example/**"],
      publicEntry: "src/example/public.ts",
      publicSymbols: ["example"],
      consumes: [],
      producesArtifacts: [],
    },
  ],
};

function printUsage(): void {
  console.log(`CellFence

Usage:
  cellfence init
  cellfence check [--manifest cellfence.manifest.json] [--json]
  cellfence check --changed [--base origin/main] [--head HEAD] [--json]
  cellfence context --cell cell-id [--manifest cellfence.manifest.json] [--baseline cellfence.baseline.json] [--json|--format agents-md]
  cellfence context --auto-allocate --task "task text" [--cell cell-id] [--json|--format agents-md]
  cellfence graph [--json|--format mermaid]
  cellfence claim create --agent agent-id --cell cell-id [--path glob] [--ttl 2h] [--claims .cellfence/claims.json] [--json]
  cellfence claim check [--agent agent-id] [--base origin/main] [--head HEAD] [--claims .cellfence/claims.json] [--json]
  cellfence claim list [--claims .cellfence/claims.json] [--json]
  cellfence baseline create [--manifest cellfence.manifest.json] [--baseline cellfence.baseline.json] [--evidence resource-evidence.json]
  cellfence baseline check [--manifest cellfence.manifest.json] [--baseline cellfence.baseline.json] [--evidence resource-evidence.json] [--json]
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
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--json") {
      parsed.json = true;
    } else if (argument === "--changed") {
      parsed.changed = true;
    } else if (argument === "--auto-allocate") {
      parsed.autoAllocate = true;
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

function commandInit(rootDir: string): number {
  const manifestPath = path.join(rootDir, "cellfence.manifest.json");
  if (fs.existsSync(manifestPath)) {
    console.error("cellfence.manifest.json already exists");
    return 2;
  }
  fs.mkdirSync(path.join(rootDir, "src/example"), { recursive: true });
  fs.writeFileSync(path.join(rootDir, "src/example/public.ts"), "export const example = true;\n");
  fs.writeFileSync(manifestPath, `${JSON.stringify(INIT_MANIFEST, null, 2)}\n`);
  console.log(`created ${manifestPath}`);
  return 0;
}

function commandCheck(parsed: ParsedArgs): number {
  const options = {
    rootDir: parsed.rootDir,
    manifestPath: parsed.manifestPath,
  };
  const result = parsed.changed
    ? checkChangedRepository({
      ...options,
      baselinePath: parsed.baselinePath,
      evidencePaths: parsed.evidencePaths,
      baseRef: parsed.baseRef,
      headRef: parsed.headRef,
    })
    : checkRepository(options);
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

function commandBaselineCheck(parsed: ParsedArgs): number {
  const result = checkRepository({
    rootDir: parsed.rootDir,
    manifestPath: parsed.manifestPath,
    baselinePath: parsed.baselinePath || defaultBaselinePath(parsed.rootDir),
    evidencePaths: parsed.evidencePaths,
  });
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
  return commandBaselineCheck(parsed);
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
