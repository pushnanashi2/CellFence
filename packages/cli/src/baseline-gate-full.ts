// 0.4.0: full baseline update gate command. The prototype accepted
// two paths on disk; the real implementation accepts two git refs
// (or two paths), reads the baseline file from each, and emits the
// governance-change report. This is the piece the
// `cellfence-baseline-gate` action calls into from CI.

import { execFileSync } from "node:child_process";
import path from "node:path";

import {
  readJsonFile,
  type GovernanceChangeReport,
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
      { cause: error as Error },
    );
  }
  // The ref is referenced in the error path so a misuse surfaces
  // it instead of swallowing it.
  if (!ref || !/^[0-9a-fA-F]{4,}$|^[A-Za-z0-9._/-]+$/.test(ref)) {
    throw new Error(`refused to read baseline at invalid git ref: ${JSON.stringify(ref)}`);
  }
  return path.relative(repoRoot, baselineFile) || baselineFile;
}

function readBaselineFromGit(rootDir: string, ref: string, baselineFile: string): unknown {
  const relative = resolveBaselineAtRef(rootDir, ref, baselineFile);
  try {
    const text = execFileSync("git", ["show", `${ref}:${relative}`], {
      cwd: rootDir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return JSON.parse(text);
  } catch (error) {
    throw new Error(
      `failed to read baseline at git ref ${ref} (${relative}): ${(error as Error).message}`,
      { cause: error as Error },
    );
  }
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
    return {
      value: readJsonFile(options.filePath),
      displayPath: options.filePath,
    };
  }
  throw new Error("either a git ref or a local file path is required");
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
    throw new Error(`base baseline: ${(error as Error).message}`, { cause: error as Error });
  }
  try {
    const head = readBaselineAt(options.rootDir, { ref: options.headRef, filePath: options.headPath }, baselineFile);
    headBaseline = head.value;
    headDisplay = head.displayPath;
  } catch (error) {
    throw new Error(`head baseline: ${(error as Error).message}`, { cause: error as Error });
  }

  // 0.4.x (N-12): the previous code cast `unknown` to `never`
  // before handing the values to the engine, which bypassed the
  // type check and let an arbitrary object through. The engine's
  // detectBaselineChanges expects a CellFenceBaseline; reject
  // anything that doesn't look like one here so the runBaselineGateCommand
  // call has a typed argument and the engine's structural
  // assumptions hold end-to-end.
  if (!isBaselineLike(baseBaseline) || !isBaselineLike(headBaseline)) {
    throw new Error(
      `baseline at ${baseDisplay} or ${headDisplay} is not a CellFenceBaseline (missing cells, schemaVersion, or generatedAt)`,
    );
  }
  // The runtime check above guarantees the structural shape; the
  // double cast keeps the literal schemaVersion type from
  // CellFenceBaseline intact while still rejecting malformed
  // values before they reach the engine.
  const gateOptions: BaselineGateOptions = {
    baseBaseline: baseBaseline as Parameters<typeof runBaselineGateCommand>[0]["baseBaseline"],
    headBaseline: headBaseline as Parameters<typeof runBaselineGateCommand>[0]["headBaseline"],
    baseBaselinePath: baseDisplay,
    headBaselinePath: headDisplay,
    format: options.format,
    hasImplementationChanges: options.hasImplementationChanges ?? false,
  };
  return runBaselineGateCommand(gateOptions);
}

function isBaselineLike(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const candidate = value as { schemaVersion?: unknown; generatedAt?: unknown; cells?: unknown };
  return (
    typeof candidate.schemaVersion === "string" &&
    typeof candidate.generatedAt === "string" &&
    typeof candidate.cells === "object" &&
    candidate.cells !== null
  );
}
