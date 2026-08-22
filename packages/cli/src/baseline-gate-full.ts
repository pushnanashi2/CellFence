// 0.4.0: full baseline update gate command. The prototype accepted
// two paths on disk; the real implementation accepts two git refs
// (or two paths), reads the baseline file from each, and emits the
// governance-change report. This is the piece the
// `cellfence-baseline-gate` action calls into from CI.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import {
  CELLFENCE_BASELINE_SCHEMA_VERSION,
  validateBaseline,
  type CellFenceBaseline,
} from "@cellfence/schema";
import {
  readJsonFile,
} from "@cellfence/engine";

import {
  runBaselineGateCommand,
  type BaselineGateOptions,
  type BaselineGateResult,
} from "./baseline-gate-command.js";

// 0.4.x (N-12): the previous helper computed the path as
// `path.relative(rootDir, baselineFile)`. `git show` takes paths
// relative to the **repository root**, not to whatever directory
// the process happens to be in. The GitHub Action and the
// `cellfence baseline gate` CLI both invoke this from a subdirectory
// of the repo (the action runs in the workspace root, but a
// monorepo tool may pick a package cwd), so the relative path was
// wrong whenever rootDir was not the toplevel. Resolve the real
// toplevel via `git rev-parse --show-toplevel` and compute the
// path from there, falling back to the previous behaviour only if
// git cannot answer (e.g. the directory is not in a repo at all,
// in which case the caller is expected to use filePath, not a ref).
function canonicalPathForComparison(filePath: string): string {
  let existingPath = path.resolve(filePath);
  const missingSegments: string[] = [];
  while (!fs.existsSync(existingPath)) {
    const parent = path.dirname(existingPath);
    if (parent === existingPath) return path.resolve(filePath);
    missingSegments.unshift(path.basename(existingPath));
    existingPath = parent;
  }
  return path.resolve(fs.realpathSync.native(existingPath), ...missingSegments);
}

function pathIsOutsideRepository(relativePath: string): boolean {
  return relativePath === ".." || relativePath.startsWith("../") || relativePath.startsWith("..\\") || path.isAbsolute(relativePath);
}

function resolveBaselineAtRef(rootDir: string, ref: string, baselineFile: string): string {
  let repoRoot: string;
  try {
    repoRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd: rootDir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch (error) {
    throw new Error(
      `cannot resolve baseline at git ref ${ref}: ${rootDir} is not inside a git repository (${(error as Error).message})`,
      { cause: error },
    );
  }
  // The ref is referenced in the error path so a misuse surfaces
  // it instead of swallowing it.
  if (!ref || !/^[0-9a-fA-F]{4,}$|^[A-Za-z0-9._/-]+$/.test(ref)) {
    throw new Error(`refused to read baseline at invalid git ref: ${JSON.stringify(ref)}`);
  }
  const relative = path.relative(canonicalPathForComparison(repoRoot), canonicalPathForComparison(baselineFile)).replaceAll(path.sep, "/") || baselineFile;
  if (pathIsOutsideRepository(relative)) {
    throw new Error(`baseline file must stay inside the git repository: ${baselineFile}`);
  }
  return relative;
}

function readBaselineFromGit(rootDir: string, ref: string, baselineFile: string): unknown {
  const relative = resolveBaselineAtRef(rootDir, ref, baselineFile);
  try {
    execFileSync("git", ["cat-file", "-e", `${ref}^{commit}`], {
      cwd: rootDir,
      stdio: ["ignore", "ignore", "pipe"],
    });
  } catch (error) {
    throw new Error(
      `cannot resolve git ref ${ref}: ${(error as Error).message}`,
      { cause: error },
    );
  }
  let text: string;
  try {
    text = execFileSync("git", ["show", `${ref}:${relative}`], {
      cwd: rootDir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    if (gitShowMissingPath(error)) return emptyBaseline();
    throw new Error(
      `failed to read baseline at git ref ${ref} (${relative}): ${(error as Error).message}`,
      { cause: error },
    );
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(
      `failed to parse baseline at git ref ${ref} (${relative}): ${(error as Error).message}`,
      { cause: error },
    );
  }
}

function gitShowMissingPath(error: unknown): boolean {
  const output = [
    error instanceof Error ? error.message : "",
    error && typeof error === "object" && "stderr" in error ? String((error as { stderr?: unknown }).stderr) : "",
    error && typeof error === "object" && "stdout" in error ? String((error as { stdout?: unknown }).stdout) : "",
  ].join("\n");
  return /path ['"].*['"] does not exist in|exists on disk, but not in/i.test(output);
}

function emptyBaseline(): CellFenceBaseline {
  return {
    schemaVersion: CELLFENCE_BASELINE_SCHEMA_VERSION,
    generatedAt: "1970-01-01T00:00:00.000Z",
    cellIds: [],
    cells: {},
  };
}

export type BaselineGateFullOptions = {
  rootDir: string;
  baselineFile: string;
  baseRef?: string;
  headRef?: string;
  basePath?: string;
  headPath?: string;
  format: "json" | "human";
  hasImplementationChanges?: boolean;
};

/**
 * Resolve a single baseline, either from a git ref or a local path.
 */
function readBaselineAt(rootDir: string, options: { ref?: string; filePath?: string }, baselineFile: string): { value: unknown; displayPath: string } {
  if (options.ref) {
    return {
      value: readBaselineFromGit(rootDir, options.ref, baselineFile),
      displayPath: `${options.ref}:${path.relative(rootDir, baselineFile) || baselineFile}`,
    };
  }
  if (options.filePath) {
    try {
      return {
        value: readJsonFile(options.filePath),
        displayPath: options.filePath,
      };
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error ? (error as NodeJS.ErrnoException).code : undefined;
      if (code === "ENOENT") {
        return {
          value: emptyBaseline(),
          displayPath: options.filePath,
        };
      }
      throw error;
    }
  }
  throw new Error("either a git ref or a local file path is required");
}

function validateBaselineValue(value: unknown, displayPath: string): CellFenceBaseline {
  const validation = validateBaseline(value);
  if (!validation.ok || !validation.value) {
    throw new Error(`baseline at ${displayPath} is not a valid CellFenceBaseline: ${validation.errors.join("; ")}`);
  }
  return validation.value;
}

export function runBaselineGateFull(options: BaselineGateFullOptions): BaselineGateResult {
  const baselineFile = path.isAbsolute(options.baselineFile)
    ? options.baselineFile
    : path.resolve(options.rootDir, options.baselineFile);

  let baseBaseline: unknown;
  let headBaseline: unknown;
  let baseDisplay: string;
  let headDisplay: string;
  try {
    const base = readBaselineAt(options.rootDir, { ref: options.baseRef, filePath: options.basePath }, baselineFile);
    baseBaseline = base.value;
    baseDisplay = base.displayPath;
  } catch (error) {
    throw new Error(`base baseline: ${(error as Error).message}`, { cause: error });
  }
  try {
    const head = readBaselineAt(options.rootDir, { ref: options.headRef, filePath: options.headPath }, baselineFile);
    headBaseline = head.value;
    headDisplay = head.displayPath;
  } catch (error) {
    throw new Error(`head baseline: ${(error as Error).message}`, { cause: error });
  }

  const gateOptions: BaselineGateOptions = {
    baseBaseline: validateBaselineValue(baseBaseline, baseDisplay),
    headBaseline: validateBaselineValue(headBaseline, headDisplay),
    baseBaselinePath: baseDisplay,
    headBaselinePath: headDisplay,
    format: options.format,
    hasImplementationChanges: options.hasImplementationChanges ?? false,
  };
  return runBaselineGateCommand(gateOptions);
}
