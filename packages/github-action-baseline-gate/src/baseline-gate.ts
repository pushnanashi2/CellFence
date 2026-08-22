// 0.4.x (M-5): the gate now delegates to the engine's
// `detectBaselineChanges` so the action can never diverge from
// the engine's idea of what counts as a governance change.
// The engine covers seven dimensions (ownedPaths, publicSymbols,
// crossCellEdges, signatures, resourceAccesses,
// publicSurfaceMetadata, dependencyCounts); the action used to
// reimplement four of them and was drifting from the engine on
// every new dimension the engine added. After this commit the
// action is a glue layer: git ref + path resolution on the way
// in, GovernanceChangeReport on the way out.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";

import {
  detectBaselineChanges,
} from "@cellfence/engine/baseline-change-detector.js";
import type { CellFenceBaseline, GovernanceChangeReport } from "@cellfence/engine";

export type { GovernanceChangeReport } from "@cellfence/engine";

export type BaselineGateResult = {
  report: GovernanceChangeReport;
  exitCode: number;
  warnings: string[];
};

export type BaselineGateOptions = {
  rootDir: string;
  baselineFile: string;
  baseRef?: string;
  headRef?: string;
  hasImplementationChanges?: boolean;
};

const GIT_COMMAND = "git";
const CELLFENCE_BASELINE_SCHEMA_VERSION = "cellfence.baseline.v1";

function gitText(rootDir: string, args: string[]): string {
  // Stryker disable next-line StringLiteral,ArrayDeclaration: stdio/encoding only control git subprocess plumbing; ref/path behavior is covered by gate tests.
  return String(execFileSync(GIT_COMMAND, args, { cwd: rootDir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }));
}

function gitSilent(rootDir: string, args: string[]): void {
  // Stryker disable next-line StringLiteral,ArrayDeclaration: stdio only controls git subprocess plumbing; ref/path behavior is covered by gate tests.
  execFileSync(GIT_COMMAND, args, { cwd: rootDir, stdio: ["ignore", "ignore", "pipe"] });
}

function canonicalPathForComparison(filePath: string): string {
  let existingPath = resolve(filePath);
  const missingSegments: string[] = [];
  while (!existsSync(existingPath)) {
    const parent = dirname(existingPath);
    if (parent === existingPath) return resolve(filePath);
    missingSegments.unshift(basename(existingPath));
    existingPath = parent;
  }
  return resolve(realpathSync.native(existingPath), ...missingSegments);
}

function pathIsOutsideRepository(relativePath: string): boolean {
  return relativePath === ".." || relativePath.startsWith("../") || relativePath.startsWith("..\\") || isAbsolute(relativePath);
}

function readBaselineFromGit(rootDir: string, ref: string, baselineFile: string): unknown {
  if (!/^[A-Za-z0-9._/-]+$/.test(ref)) {
    throw new Error(`refused to read baseline at invalid git ref: ${JSON.stringify(ref)}`);
  }
  const repoRoot = canonicalPathForComparison(gitText(rootDir, ["rev-parse", "--show-toplevel"]).trim());
  const absoluteBaselineFile = isAbsolute(baselineFile)
    ? baselineFile
    : resolve(rootDir, baselineFile);
  const relativeBaselineFile = isAbsolute(baselineFile)
    ? relative(repoRoot, canonicalPathForComparison(absoluteBaselineFile))
    : baselineFile;
  if (pathIsOutsideRepository(relativeBaselineFile)) {
    throw new Error(`baseline file must stay inside the git repository: ${baselineFile}`);
  }
  const gitBaselineFile = relativeBaselineFile.replace(/\\/g, "/");
  try {
    gitSilent(repoRoot, ["cat-file", "-e", `${ref}^{commit}`]);
  } catch (error) {
    throw new Error(`cannot resolve git ref ${ref}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
  if (!baselinePathExistsAtRef(repoRoot, ref, gitBaselineFile)) return emptyBaseline();
  const text = gitText(repoRoot, ["show", `${ref}:${gitBaselineFile}`]);
  return JSON.parse(text);
}

function baselinePathExistsAtRef(repoRoot: string, ref: string, relativeBaselineFile: string): boolean {
  const text = gitText(repoRoot, ["ls-tree", "-z", "--name-only", ref, "--", relativeBaselineFile]);
  return text === `${relativeBaselineFile}\0`;
}

function emptyBaseline(): CellFenceBaseline {
  return {
    schemaVersion: CELLFENCE_BASELINE_SCHEMA_VERSION,
    generatedAt: "1970-01-01T00:00:00.000Z",
    cellIds: [],
    cells: {},
  };
}

function readBaselineFromPath(filePath: string): unknown {
  try {
    return JSON.parse(String(readFileSync(filePath)));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyBaseline();
    throw error;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function baselineValidationErrors(value: unknown): string[] {
  const errors: string[] = [];
  if (!isRecord(value)) return ["baseline must be an object"];
  if (value.schemaVersion !== CELLFENCE_BASELINE_SCHEMA_VERSION) {
    errors.push(`schemaVersion must be ${CELLFENCE_BASELINE_SCHEMA_VERSION}`);
  }
  if (typeof value.generatedAt !== "string" || Number.isNaN(Date.parse(value.generatedAt))) {
    errors.push("generatedAt must be an ISO 8601 date-time string");
  }
  if (!isRecord(value.cells)) {
    errors.push("cells must be an object");
  }
  if (value.cellIds !== undefined && !Array.isArray(value.cellIds)) {
    errors.push("cellIds must be an array when present");
  }
  return errors;
}

function validateBaselineValue(value: unknown, displayPath: string): CellFenceBaseline {
  const errors = baselineValidationErrors(value);
  if (errors.length > 0) {
    throw new Error(`baseline at ${displayPath} is not a valid CellFenceBaseline: ${errors.join("; ")}`);
  }
  return value as CellFenceBaseline;
}

export function runBaselineGateFull(options: BaselineGateOptions): BaselineGateResult {
  if (!options.baseRef && !options.headRef) {
    throw new Error("either a base-ref or a head-ref is required to read the baseline");
  }
  const baselineFile = isAbsolute(options.baselineFile)
    ? options.baselineFile
    : resolve(options.rootDir, options.baselineFile);
  const baseValue = options.baseRef
    ? readBaselineFromGit(options.rootDir, options.baseRef, baselineFile)
    : readBaselineFromPath(baselineFile);
  const headValue = options.headRef
    ? readBaselineFromGit(options.rootDir, options.headRef, baselineFile)
    : readBaselineFromPath(baselineFile);
  const baseDisplay = options.baseRef
    ? `${options.baseRef}:${relative(options.rootDir, baselineFile)}`
    : baselineFile;
  const headDisplay = options.headRef
    ? `${options.headRef}:${relative(options.rootDir, baselineFile)}`
    : baselineFile;
  const baseBaseline = validateBaselineValue(baseValue, baseDisplay);
  const headBaseline = validateBaselineValue(headValue, headDisplay);
  const report = detectBaselineChanges(
    baseBaseline,
    headBaseline,
    baseDisplay,
    headDisplay,
  );
  const warnings: string[] = [];
  if (options.hasImplementationChanges && report.hasChange) {
    warnings.push(
      "baseline changes and implementation changes are mixed in the same pull request",
    );
  }
  return {
    report,
    // exit 1: governance change present. exit 0: no change.
    exitCode: report.hasChange ? 1 : 0,
    warnings,
  };
}
