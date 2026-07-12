#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  checkRepository,
  createBaseline,
  defaultBaselinePath,
  formatHumanResult,
  writeBaselineFile,
} from "@cellfence/engine";

type ParsedArgs = {
  command: string[];
  manifestPath?: string;
  baselinePath?: string;
  evidencePaths: string[];
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
    } else if (argument === "--evidence") {
      parsed.evidencePaths.push(argv[index + 1]);
      index += 1;
    } else if (argument.startsWith("--evidence=")) {
      parsed.evidencePaths.push(argument.slice("--evidence=".length));
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
