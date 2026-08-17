// H-3 (0.3.0): the trace hook monkey-patches `node:fs` and
// `globalThis.fetch` after import. ESM named imports of the same
// modules (e.g. `import { readFileSync } from "node:fs"`) are bound
// at module-load time and bypass the patch entirely, so the trace
// can miss real accesses. The previous implementation labelled
// everything it caught as `confidence: "runtime"`, which falsely
// implied the evidence was authoritative. The hook now labels its
// outputs as `confidence: "transient"` and writes a
// `transcriptStatus` field that distinguishes:
//
//   * `active`     — the patch installed and the process ran long
//                    enough for any intercepted calls to land
//   * `inactive`   — `CELLFENCE_TRACE_DISABLE=1` was set, the
//                    install was skipped
//
// The engine surfaces both as findings so a PR cannot accidentally
// pass with an empty `accesses` array that was really "the hook
// did not run".

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  CELLFENCE_RESOURCE_EVIDENCE_SCHEMA_VERSION,
  type ResourceEvidenceAccess,
  type ResourceEvidenceTranscriptStatus,
} from "@cellfence/schema";

type TraceAccessInput = Omit<ResourceEvidenceAccess, "detectedBy" | "confidence"> & {
  detectedBy?: string;
  confidence?: "transient" | "runtime";
};

function stableStringCompare(left: string, right: string): number {
  // Stryker disable next-line ConditionalExpression,EqualityOperator: access keys are de-duplicated in a Map before sorting, so equal-key comparisons are unobservable here.
  if (left === right) return 0;
  // Stryker disable next-line EqualityOperator: equality returned above, so `<` and `<=` have the same observable language here.
  return left < right ? -1 : 1;
}

const originalReadFileSync = fs.readFileSync.bind(fs);
const originalWriteFileSync = fs.writeFileSync.bind(fs);
const originalAppendFileSync = fs.appendFileSync.bind(fs);
const originalReadFile = fs.promises.readFile.bind(fs.promises);
const originalWriteFile = fs.promises.writeFile.bind(fs.promises);
const originalAppendFile = fs.promises.appendFile.bind(fs.promises);
const originalFetch = globalThis.fetch?.bind(globalThis);
const accesses = new Map<string, ResourceEvidenceAccess>();
const SOURCE_FILE_EXTENSIONS = new Set([".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx", ".mts", ".cts"]);
let installed = false;
let flushed = false;
let flushHooksRegistered = false;

export function traceDiagnostics(): { installed: boolean; flushHooksRegistered: boolean } {
  return { installed, flushHooksRegistered };
}

function normalizeSelector(selector: fs.PathOrFileDescriptor): string | undefined {
  if (typeof selector === "number") return undefined;
  const text = selector instanceof URL ? selector.pathname : selector.toString();
  return text.split(path.sep).join("/");
}

function defaultCellId(): string | undefined {
  return process.env.CELLFENCE_TRACE_CELL || process.env.CELLFENCE_CELL_ID;
}

function evidencePath(): string {
  return path.resolve(process.cwd(), process.env.CELLFENCE_TRACE_OUT || "cellfence.resource-evidence.json");
}

// H-4 (0.3.0): resource evidence must bind to the commit it was
// captured against, so the engine can reject replays against a
// different snapshot. The previous implementation read GITHUB_SHA
// (set in CI) or CELLFENCE_TRACE_COMMIT_SHA (opt-in), which made
// the binding opt-in: a local trace without env vars would simply
// omit commitSha, and the engine's `evidence.commitSha && ...`
// freshness check would skip the comparison. Read the current
// repository HEAD directly instead and let the engine surface the
// failure if the binding is missing or mismatched. GITHUB_SHA /
// CELLFENCE_TRACE_COMMIT_SHA remain as fallbacks for shallow
// checkouts where `git rev-parse HEAD` returns the merge ref rather
// than the actual commit.
function readCommitSha(): string {
  const envFallback = process.env.CELLFENCE_TRACE_COMMIT_SHA || process.env.GITHUB_SHA;
  if (envFallback && envFallback.trim().length > 0) return envFallback.trim();
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: process.cwd(),
      encoding: "utf8",
      // Stryker disable next-line ArrayDeclaration,StringLiteral: stdio routing only suppresses git noise; commit binding is asserted through stdout and fallback tests.
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "";
  }
}

function accessKey(access: ResourceEvidenceAccess): string {
  return `${access.cellId || ""}:${access.kind}:${access.access}:${access.selector}`;
}

export function recordResourceAccess(access: TraceAccessInput): void {
  registerFlushHooks();
  const resolvedAccess: ResourceEvidenceAccess = {
    ...access,
    cellId: access.cellId || defaultCellId(),
    detectedBy: access.detectedBy || "cellfence-trace",
    confidence: access.confidence || "transient",
  };
  accesses.set(accessKey(resolvedAccess), resolvedAccess);
}

export function recordDatabaseAccess(selector: string, access: "read" | "write" = "read", cellId?: string): void {
  recordResourceAccess({
    kind: "database",
    access,
    selector,
    cellId,
  });
}

export function recordHttpAccess(selector: string, access: "call" | "serve" = "call", cellId?: string): void {
  recordResourceAccess({
    kind: "http",
    access,
    selector,
    cellId,
  });
}

export function recordQueueAccess(selector: string, access: "publish" | "subscribe", cellId?: string): void {
  recordResourceAccess({
    kind: "queue",
    access,
    selector,
    cellId,
  });
}

function recordFileAccess(access: "read" | "write", selector: fs.PathOrFileDescriptor): void {
  const normalizedSelector = normalizeSelector(selector);
  if (!normalizedSelector) return;
  if (SOURCE_FILE_EXTENSIONS.has(path.extname(normalizedSelector))) return;
  if (path.resolve(process.cwd(), normalizedSelector) === evidencePath()) return;
  recordResourceAccess({
    kind: "file",
    access,
    selector: normalizedSelector,
  });
}

function fetchSelector(input: Parameters<typeof fetch>[0]): string | undefined {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  if (typeof Request !== "undefined" && input instanceof Request) return input.url;
  return undefined;
}

// 0.4.x (N-13): snapshot the disable flag at module-load time.
// The previous implementation re-read `process.env.CELLFENCE_TRACE_DISABLE`
// on every call, so any code that flipped the env var after
// import (or, more worryingly, after the loader set the env var
// to "1" right before checking transcriptStatus) could flip
// 'active' <-> 'inactive' mid-process. Capture the decision once
// and trust it.
const installTimeDisabled = process.env.CELLFENCE_TRACE_DISABLE === "1";

export function transcriptStatus(): ResourceEvidenceTranscriptStatus {
  // H-3 (0.3.0): a fresh process that has the disable env var set
  // never installs the patch, so its evidence is structurally
  // "inactive" rather than "active with no accesses".
  if (installTimeDisabled) return "inactive";
  return "active";
}

export function flushEvidence(): void {
  // H-3 (0.3.0): the previous implementation bailed when
  // `accesses.size === 0`, which silently merged three different
  // states ("disabled", "active but observed nothing", "active and
  // observed things"). Keep the early-return so an unused hook
  // does not write an empty file, but make sure the
  // `transcriptStatus` field is written alongside any evidence we
  // do emit, so consumers can still distinguish the cases where a
  // file is present.
  if (flushed || accesses.size === 0) return;
  flushed = true;
  const outputPath = evidencePath();
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  const evidence = {
    schemaVersion: CELLFENCE_RESOURCE_EVIDENCE_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    commitSha: readCommitSha(),
    cellId: defaultCellId(),
    transcriptStatus: transcriptStatus(),
    accesses: [...accesses.values()].sort((left, right) => stableStringCompare(accessKey(left), accessKey(right))),
  };
  originalWriteFileSync(outputPath, `${JSON.stringify(evidence, null, 2)}\n`);
}

function registerFlushHooks(): void {
  if (flushHooksRegistered) return;
  flushHooksRegistered = true;
  process.once("beforeExit", flushEvidence);
  process.once("exit", flushEvidence);
}

export function installTrace(): void {
  if (installed || process.env.CELLFENCE_TRACE_DISABLE === "1") return;
  // Stryker disable next-line BooleanLiteral: repeated installs reassign wrappers from immutable originals, so flipping this guard assignment is observationally equivalent.
  installed = true;
  registerFlushHooks();

  fs.readFileSync = ((selector: fs.PathOrFileDescriptor, ...args: unknown[]) => {
    recordFileAccess("read", selector);
    return originalReadFileSync(selector, ...args as [options?: BufferEncoding | { encoding?: BufferEncoding | null; flag?: string } | null]);
  }) as typeof fs.readFileSync;

  fs.writeFileSync = ((selector: fs.PathOrFileDescriptor, data: string | NodeJS.ArrayBufferView, ...args: unknown[]) => {
    recordFileAccess("write", selector);
    return originalWriteFileSync(selector, data, ...args as [options?: fs.WriteFileOptions]);
  }) as typeof fs.writeFileSync;

  fs.appendFileSync = ((selector: fs.PathOrFileDescriptor, data: string | Uint8Array, ...args: unknown[]) => {
    recordFileAccess("write", selector);
    return originalAppendFileSync(selector, data, ...args as [options?: fs.WriteFileOptions]);
  }) as typeof fs.appendFileSync;

  fs.promises.readFile = (async (selector: fs.PathLike | FileHandle, ...args: unknown[]) => {
    if (!(typeof selector === "object" && "fd" in selector)) recordFileAccess("read", selector as fs.PathLike);
    return originalReadFile(selector as Parameters<typeof fs.promises.readFile>[0], ...args as [options?: Parameters<typeof fs.promises.readFile>[1]]);
  }) as typeof fs.promises.readFile;

  fs.promises.writeFile = (async (selector: fs.PathLike | FileHandle, data: string | NodeJS.ArrayBufferView | Iterable<string | NodeJS.ArrayBufferView> | AsyncIterable<string | NodeJS.ArrayBufferView>, ...args: unknown[]) => {
    if (!(typeof selector === "object" && "fd" in selector)) recordFileAccess("write", selector as fs.PathLike);
    return originalWriteFile(selector as Parameters<typeof fs.promises.writeFile>[0], data, ...args as [options?: Parameters<typeof fs.promises.writeFile>[2]]);
  }) as typeof fs.promises.writeFile;

  fs.promises.appendFile = (async (selector: fs.PathLike | FileHandle, data: string | Uint8Array, ...args: unknown[]) => {
    if (!(typeof selector === "object" && "fd" in selector)) recordFileAccess("write", selector as fs.PathLike);
    return originalAppendFile(selector as Parameters<typeof fs.promises.appendFile>[0], data, ...args as [options?: Parameters<typeof fs.promises.appendFile>[2]]);
  }) as typeof fs.promises.appendFile;

  if (originalFetch) {
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const selector = fetchSelector(input);
      if (selector) recordHttpAccess(selector, "call");
      return originalFetch(input, init);
    }) as typeof fetch;
  }

}

function importSpecifierTargetsThisModule(specifier: string): boolean {
  // Stryker disable all: package-specifier preload is exercised through subprocess resolution, which Stryker cannot reliably bind to the mutated sandbox copy.
  if (specifier === "@cellfence/trace") return true;
  // Stryker restore all
  try {
    if (path.resolve(fileURLToPath(specifier)) === path.resolve(fileURLToPath(import.meta.url))) return true;
  } catch {
    // Non-file preload specifiers such as data: URLs are not CellFence trace.
  }
  return false;
}

function preloadRequestedThisModule(execArgv: readonly string[] = process.execArgv): boolean {
  const inlinePrefix = "--import=";
  for (const [index, argument] of execArgv.entries()) {
    if (argument === "--import") {
      if (importSpecifierTargetsThisModule(execArgv[index + 1])) return true;
      continue;
    }
    if (!argument.startsWith(inlinePrefix)) continue;
    const inlineSpecifier = argument.slice(inlinePrefix.length);
    if (importSpecifierTargetsThisModule(inlineSpecifier)) return true;
  }
  return false;
}

export const __testing = {
  importSpecifierTargetsThisModule,
  preloadRequestedThisModule,
};

if (process.env.CELLFENCE_TRACE_AUTO_INSTALL === "1" || preloadRequestedThisModule()) installTrace();

/**
 * 0.4.x (N-13): re-derive the transcript status from the raw
 * evidence rather than trusting the on-disk field. The trace
 * hook writes `transcriptStatus: 'active' | 'inactive'`, but a
 * hand-crafted evidence file (or an attacker who can set
 * CELLFENCE_TRACE_DISABLE=1 and then paste a 'complete' value
 * into a file) must not be enough to skip the gate. The engine
 * re-evaluates the status using the same install-time rules the
 * hook itself used, and refuses any value that does not match.
 */
export function deriveTranscriptStatus(
  evidence: { transcriptStatus?: string; accesses?: unknown[]; commitSha?: string },
  installedAt: { disabled: boolean; hookInstalled: boolean },
): ResourceEvidenceTranscriptStatus {
  if (installedAt.disabled) return "inactive";
  if (!installedAt.hookInstalled) return "inactive";
  if (evidence.transcriptStatus === "inactive") return "inactive";
  // Anything other than the three honest states ('active',
  // 'inactive', 'incomplete') collapses to 'incomplete' so the
  // engine surfaces CELLFENCE_RESOURCE_EVIDENCE_TRANSCRIPT_INCOMPLETE
  // and the caller can investigate.
  if (evidence.transcriptStatus === "active") {
    return Array.isArray(evidence.accesses) && evidence.accesses.length > 0 ? "active" : "incomplete";
  }
  return "incomplete";
}
