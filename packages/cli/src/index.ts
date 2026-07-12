#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  type CellFenceContext,
  checkRepository,
  createCellContext,
  createBaseline,
  defaultBaselinePath,
  formatHumanResult,
  guardBaselineUpdate,
  writeBaselineFile,
} from "@cellfence/engine";

type ParsedArgs = {
  command: string[];
  manifestPath?: string;
  baselinePath?: string;
  cellId?: string;
  evidencePaths: string[];
  format?: string;
  json: boolean;
  rootDir: string;
};

const INIT_MANIFEST = {
  schemaVersion: "cellfence.manifest.v1",
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
  cellfence context --cell cell-id [--manifest cellfence.manifest.json] [--baseline cellfence.baseline.json] [--json|--format agents-md]
  cellfence baseline create [--manifest cellfence.manifest.json] [--baseline cellfence.baseline.json] [--evidence resource-evidence.json]
  cellfence baseline check [--manifest cellfence.manifest.json] [--baseline cellfence.baseline.json] [--evidence resource-evidence.json] [--json]
  cellfence baseline update [--manifest cellfence.manifest.json] [--baseline cellfence.baseline.json] [--evidence resource-evidence.json]
  cellfence evidence check --evidence resource-evidence.json [--manifest cellfence.manifest.json] [--baseline cellfence.baseline.json] [--json]

Exit codes:
  0  no violations
  1  governance violations
  2  configuration or manifest error
  3  internal tool error`);
}

function parseArgs(argv: string[]): ParsedArgs {
  const parsed: ParsedArgs = { command: [], evidencePaths: [], json: false, rootDir: process.cwd() };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--json") {
      parsed.json = true;
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
      index += 1;
    } else if (argument.startsWith("--cell=")) {
      parsed.cellId = argument.slice("--cell=".length);
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
  const result = checkRepository({
    rootDir: parsed.rootDir,
    manifestPath: parsed.manifestPath,
  });
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

function commandContext(parsed: ParsedArgs): number {
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
    if (primaryCommand === "baseline" && secondaryCommand === "create") return commandBaselineCreate(parsed);
    if (primaryCommand === "baseline" && secondaryCommand === "check") return commandBaselineCheck(parsed);
    if (primaryCommand === "baseline" && secondaryCommand === "update") return commandBaselineUpdate(parsed);
    if (primaryCommand === "evidence" && secondaryCommand === "check") return commandEvidenceCheck(parsed);
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
