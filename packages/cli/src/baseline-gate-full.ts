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

function resolveBaselineAtRef(rootDir: string, ref: string, baselineFile: string): string {
  // Resolve a baseline file at a git ref. The `git show <ref>:<path>`
  // form avoids the cost of a worktree checkout; we just need the
  // file contents. The path is repo-relative.
  const relative = path.relative(rootDir, baselineFile) || baselineFile;
  return relative;
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
    throw new Error(`base baseline: ${(error as Error).message}`);
  }
  try {
    const head = readBaselineAt(options.rootDir, { ref: options.headRef, filePath: options.headPath }, baselineFile);
    headBaseline = head.value;
    headDisplay = head.displayPath;
  } catch (error) {
    throw new Error(`head baseline: ${(error as Error).message}`);
  }

  const gateOptions: BaselineGateOptions = {
    baseBaseline: baseBaseline as never,
    headBaseline: headBaseline as never,
    baseBaselinePath: baseDisplay,
    headBaselinePath: headDisplay,
    format: options.format,
    hasImplementationChanges: options.hasImplementationChanges ?? false,
  };
  return runBaselineGateCommand(gateOptions);
}
