import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import type { CellFenceManifest, CellManifest } from "@cellfence/schema";

import { DEFAULT_CLAIMS_PATH, DEFAULT_MANIFEST_PATH } from "./constants.js";
import { errorMessage } from "./errors.js";
import { addFinding, humanResolution } from "./findings.js";
import {
  matchesPattern,
  normalizePath,
  pathOwnedByCell,
  patternCoveredByOwnedPaths,
  repoPath,
} from "./file-index.js";
import { pathPatternsOverlap } from "./glob-overlap.js";
import { readJsonFile } from "./json-file.js";
import type {
  AnalysisContext,
  CellFenceClaim,
  CellFenceClaimStore,
  ClaimCheckOptions,
  ClaimCheckResult,
  ClaimCreateOptions,
  ClaimCreateResult,
  Finding,
  WriteAccessOptions,
  WriteAccessPathDecision,
  WriteAccessResult,
} from "./types.js";

type ClaimOperationDependencies = {
  assertGitCommit(rootDir: string, ref: string): string;
  changedFilesForRefs(rootDir: string, baseRef: string, headRef?: string): string[];
  createContext(rootDir: string, manifest: CellFenceManifest): AnalysisContext;
  gitCommand(rootDir: string, args: string[]): string;
  loadManifestFromFile(manifestPath: string): CellFenceManifest;
};

function claimConfigurationFailure(message: string, claimsPath = ""): ClaimCheckResult {
  return {
    schemaVersion: "cellfence.claim-check.v1",
    ok: false,
    exitCode: 2,
    findings: [
      {
        ruleId: "CELLFENCE_CLAIM_INVALID",
        severity: "error",
        message,
        filePath: claimsPath || undefined,
      },
    ],
    warnings: [],
    claims: [],
    activeClaims: [],
  };
}

function sortedUnique(values: readonly string[] | undefined): string[] {
  return [...new Set((values || []).map((value) => normalizePath(String(value).trim())).filter(Boolean))]
    .sort((left, right) => left.localeCompare(right));
}

function claimStorePath(rootDir: string, claimsPath: string | undefined): string {
  return path.resolve(rootDir, claimsPath || DEFAULT_CLAIMS_PATH);
}

function parseTtlMillis(value: string): number | undefined {
  const match = /^(\d+)(m|h|d)$/.exec(value.trim());
  if (!match) return undefined;
  const amount = Number(match[1]);
  const unit = match[2];
  if (!Number.isSafeInteger(amount) || amount <= 0) return undefined;
  if (unit === "m") return amount * 60 * 1000;
  if (unit === "h") return amount * 60 * 60 * 1000;
  return amount * 24 * 60 * 60 * 1000;
}

function computeClaimExpiresAt(now: Date, ttl: string | undefined, expiresAt: string | undefined): string | undefined {
  if (expiresAt) {
    const parsed = Date.parse(expiresAt);
    if (Number.isNaN(parsed)) return undefined;
    return new Date(parsed).toISOString();
  }
  const ttlMillis = parseTtlMillis(ttl || "2h");
  if (!ttlMillis) return undefined;
  return new Date(now.getTime() + ttlMillis).toISOString();
}

function claimIsActive(claim: CellFenceClaim, now: Date): boolean {
  return Date.parse(claim.expiresAt) > now.getTime();
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function validateClaimShape(claim: unknown, index: number, findings: Finding[], claimsPath: string): claim is CellFenceClaim {
  if (!claim || typeof claim !== "object") {
    addFinding(findings, {
      ruleId: "CELLFENCE_CLAIM_INVALID",
      severity: "error",
      filePath: claimsPath,
      message: `claim at index ${index} must be an object`,
    });
    return false;
  }
  const candidate = claim as Partial<CellFenceClaim>;
  const errors: string[] = [];
  if (!candidate.id || typeof candidate.id !== "string") errors.push("id is required");
  if (!candidate.agent || typeof candidate.agent !== "string") errors.push("agent is required");
  if (!isStringArray(candidate.cells)) errors.push("cells must be a string array");
  if (!isStringArray(candidate.paths)) errors.push("paths must be a string array");
  if (!isStringArray(candidate.symbols)) errors.push("symbols must be a string array");
  if (!isStringArray(candidate.resources)) errors.push("resources must be a string array");
  if (!isStringArray(candidate.artifactLanes)) errors.push("artifactLanes must be a string array");
  if (!candidate.createdAt || typeof candidate.createdAt !== "string" || Number.isNaN(Date.parse(candidate.createdAt))) errors.push("createdAt must be an ISO timestamp");
  if (!candidate.expiresAt || typeof candidate.expiresAt !== "string" || Number.isNaN(Date.parse(candidate.expiresAt))) errors.push("expiresAt must be an ISO timestamp");
  if (errors.length > 0) {
    addFinding(findings, {
      ruleId: "CELLFENCE_CLAIM_INVALID",
      severity: "error",
      filePath: claimsPath,
      message: `claim ${candidate.id || `at index ${index}`} is invalid: ${errors.join("; ")}`,
      details: { index, errors },
    });
    return false;
  }
  return true;
}

function readClaimStore(rootDir: string, claimsPathOption: string | undefined, findings: Finding[]): { path: string; claims: CellFenceClaim[] } {
  const resolvedPath = claimStorePath(rootDir, claimsPathOption);
  const relativePath = repoPath(rootDir, resolvedPath);
  if (!fs.existsSync(resolvedPath)) return { path: resolvedPath, claims: [] };
  let raw: unknown;
  try {
    raw = readJsonFile(resolvedPath);
  } catch (error) {
    addFinding(findings, {
      ruleId: "CELLFENCE_CLAIM_INVALID",
      severity: "error",
      filePath: relativePath,
      message: `failed to read claim store: ${errorMessage(error)}`,
    });
    return { path: resolvedPath, claims: [] };
  }
  if (!raw || typeof raw !== "object" || (raw as { schemaVersion?: unknown }).schemaVersion !== "cellfence.claims.v1" || !Array.isArray((raw as { claims?: unknown }).claims)) {
    addFinding(findings, {
      ruleId: "CELLFENCE_CLAIM_INVALID",
      severity: "error",
      filePath: relativePath,
      message: "claim store must have schemaVersion cellfence.claims.v1 and claims array",
    });
    return { path: resolvedPath, claims: [] };
  }
  const claims = (raw as CellFenceClaimStore).claims.filter((claim, index) => validateClaimShape(claim, index, findings, relativePath));
  return { path: resolvedPath, claims };
}

function sleepSync(ms: number): void {
  const buffer = new SharedArrayBuffer(4);
  const view = new Int32Array(buffer);
  Atomics.wait(view, 0, 0, ms);
}

function acquireClaimStoreLock(filePath: string): () => void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const lockPath = `${filePath}.lock`;
  const deadline = Date.now() + 5_000;
  while (true) {
    try {
      const fd = fs.openSync(lockPath, "wx");
      fs.writeFileSync(fd, `${process.pid}\n${new Date().toISOString()}\n`);
      return () => {
        fs.closeSync(fd);
        try {
          fs.unlinkSync(lockPath);
        } catch {
          // The lock is already gone; release stays idempotent for process cleanup races.
        }
      };
    } catch (error) {
      const code = typeof error === "object" && error !== null && "code" in error ? String((error as { code?: unknown }).code) : "";
      const lockIsBusy = code === "EEXIST" || code === "EPERM" || code === "EACCES" || code === "EBUSY";
      if (!lockIsBusy || Date.now() >= deadline) {
        throw new Error(`failed to acquire claim store lock ${lockPath}: ${errorMessage(error)}`, { cause: error });
      }
      sleepSync(25);
    }
  }
}

function writeClaimStore(filePath: string, claims: CellFenceClaim[]): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const store: CellFenceClaimStore = {
    schemaVersion: "cellfence.claims.v1",
    claims: [...claims].sort((left, right) => left.id.localeCompare(right.id)),
  };
  const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporaryPath, `${JSON.stringify(store, null, 2)}\n`, { flag: "wx" });
  fs.renameSync(temporaryPath, filePath);
}

function intersectingValues(left: readonly string[], right: readonly string[]): string[] {
  const rightSet = new Set(right);
  return left.filter((value) => rightSet.has(value));
}

function claimConflictSurfaces(left: CellFenceClaim, right: CellFenceClaim): string[] {
  const surfaces: string[] = [];
  for (const cell of intersectingValues(left.cells, right.cells)) surfaces.push(`cell:${cell}`);
  for (const symbol of intersectingValues(left.symbols, right.symbols)) surfaces.push(`symbol:${symbol}`);
  for (const resource of intersectingValues(left.resources, right.resources)) surfaces.push(`resource:${resource}`);
  for (const lane of intersectingValues(left.artifactLanes, right.artifactLanes)) surfaces.push(`artifact:${lane}`);
  for (const leftPath of left.paths) {
    for (const rightPath of right.paths) {
      if (pathPatternsOverlap(leftPath, rightPath)) surfaces.push(`path:${leftPath}<->${rightPath}`);
    }
  }
  return [...new Set(surfaces)].sort((first, second) => first.localeCompare(second));
}

function validateClaimCells(context: AnalysisContext, claim: CellFenceClaim, findings: Finding[], claimsPath: string): void {
  const unknownCells = claim.cells.filter((cellId) => !context.cellsById.has(cellId));
  if (unknownCells.length > 0) {
    addFinding(findings, {
      ruleId: "CELLFENCE_CLAIM_INVALID",
      severity: "error",
      filePath: claimsPath,
      message: `claim ${claim.id} references unknown cells: ${unknownCells.join(", ")}`,
      details: { claimId: claim.id, unknownCells },
    });
  }
  if (claim.cells.length > 0) {
    const claimedCells = claim.cells.map((cellId) => context.cellsById.get(cellId)).filter((cell): cell is CellManifest => Boolean(cell));
    for (const claimedPath of claim.paths) {
      if (!claimedCells.some((cell) => patternCoveredByOwnedPaths(claimedPath, cell.ownedPaths))) {
        addFinding(findings, {
          ruleId: "CELLFENCE_CLAIM_INVALID",
          severity: "error",
          filePath: claimsPath,
          message: `claim ${claim.id} path ${claimedPath} is outside claimed cell ownership`,
          details: { claimId: claim.id, path: claimedPath, cells: claim.cells },
        });
      }
    }
  }
}

function addClaimConflictFinding(findings: Finding[], left: CellFenceClaim, right: CellFenceClaim, surfaces: string[]): void {
  addFinding(findings, {
    ruleId: "CELLFENCE_ACTIVE_CLAIM_CONFLICT",
    severity: "error",
    message: `active claims ${left.id} and ${right.id} conflict`,
    details: {
      left: { id: left.id, agent: left.agent, expiresAt: left.expiresAt },
      right: { id: right.id, agent: right.agent, expiresAt: right.expiresAt },
      surfaces,
    },
    suggestedResolutions: [
      humanResolution("Wait for one claim to expire, narrow the claim surface, or assign a human owner to serialize the work", {
        leftClaim: left.id,
        rightClaim: right.id,
        surfaces,
      }),
    ],
  });
}

function validateActiveClaimConflicts(activeClaims: CellFenceClaim[], findings: Finding[]): void {
  for (let leftIndex = 0; leftIndex < activeClaims.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < activeClaims.length; rightIndex += 1) {
      const left = activeClaims[leftIndex];
      const right = activeClaims[rightIndex];
      if (left.id === right.id) continue;
      const surfaces = claimConflictSurfaces(left, right);
      if (surfaces.length > 0) addClaimConflictFinding(findings, left, right, surfaces);
    }
  }
}

function workingTreeChangedFiles(rootDir: string, dependencies: ClaimOperationDependencies): string[] {
  const files = new Set<string>();
  const add = (args: string[]): void => {
    const output = dependencies.gitCommand(rootDir, args);
    for (const entry of output.split(/\r?\n/)) {
      const normalized = normalizePath(entry.trim());
      if (normalized) files.add(normalized);
    }
  };
  dependencies.gitCommand(rootDir, ["rev-parse", "--is-inside-work-tree"]);
  dependencies.assertGitCommit(rootDir, "HEAD");
  add(["diff", "--name-only", "--diff-filter=ACMR", "HEAD"]);
  add(["ls-files", "--others", "--exclude-standard"]);
  return [...files].sort((left, right) => left.localeCompare(right));
}

function changedFilesForClaimCheck(rootDir: string, options: ClaimCheckOptions, dependencies: ClaimOperationDependencies): string[] {
  if (options.baseRef) {
    dependencies.assertGitCommit(rootDir, options.baseRef);
    if (options.headRef) dependencies.assertGitCommit(rootDir, options.headRef);
    return dependencies.changedFilesForRefs(rootDir, options.baseRef, options.headRef);
  }
  return workingTreeChangedFiles(rootDir, dependencies);
}

function claimCoversFile(manifest: CellFenceManifest, claim: CellFenceClaim, relativePath: string): boolean {
  if (claim.paths.some((pattern) => matchesPattern(relativePath, pattern))) return true;
  return claim.cells.some((cellId) => {
    const cell = manifest.cells.find((candidate) => candidate.id === cellId);
    return cell ? cell.ownedPaths.some((pattern) => matchesPattern(relativePath, pattern)) : false;
  });
}

function canonicalizePotentialPath(targetPath: string): string {
  const resolvedPath = path.resolve(targetPath);
  const parsedPath = path.parse(resolvedPath);
  const relativeParts = path.relative(parsedPath.root, resolvedPath).split(path.sep).filter(Boolean);
  let currentPath = parsedPath.root;
  let firstMissingIndex = relativeParts.length;
  for (let index = 0; index < relativeParts.length; index += 1) {
    const nextPath = path.join(currentPath, relativeParts[index]);
    if (!fs.existsSync(nextPath)) {
      firstMissingIndex = index;
      break;
    }
    currentPath = fs.realpathSync(nextPath);
  }
  return path.resolve(currentPath, ...relativeParts.slice(firstMissingIndex));
}

function normalizeWriteAccessPath(rootDir: string, requestedPath: string): { relativePath: string; canonicalPath: string } {
  if (requestedPath.trim().length === 0) throw new Error("path is empty");
  const rootRealPath = fs.realpathSync(rootDir);
  const targetPath = path.isAbsolute(requestedPath)
    ? path.resolve(requestedPath)
    : path.resolve(rootDir, requestedPath);
  const canonicalPath = canonicalizePotentialPath(targetPath);
  const relativeFromRoot = path.relative(rootRealPath, canonicalPath);
  if (relativeFromRoot === "" || relativeFromRoot.startsWith("..") || path.isAbsolute(relativeFromRoot)) {
    throw new Error(`path escapes repository root: ${requestedPath}`);
  }
  return {
    relativePath: normalizePath(relativeFromRoot),
    canonicalPath,
  };
}

function writeAccessResult(
  agent: string,
  pathDecisions: WriteAccessPathDecision[],
  findings: Finding[],
  warnings: Finding[],
  activeClaims: CellFenceClaim[],
): WriteAccessResult {
  const hasErrors = findings.some((finding) => finding.severity === "error");
  return {
    schemaVersion: "cellfence.write-access.v1",
    ok: !hasErrors && pathDecisions.every((decision) => decision.allowed),
    exitCode: hasErrors || pathDecisions.some((decision) => !decision.allowed) ? 1 : 0,
    agent,
    paths: pathDecisions,
    findings,
    warnings,
    activeClaims,
  };
}

export function checkWriteAccess(options: WriteAccessOptions, dependencies: ClaimOperationDependencies): WriteAccessResult {
  const rootDir = path.resolve(options.rootDir || process.cwd());
  const manifestPath = path.resolve(rootDir, options.manifestPath || DEFAULT_MANIFEST_PATH);
  const agent = options.agent.trim();
  const findings: Finding[] = [];
  const warnings: Finding[] = [];
  if (agent.length === 0) {
    addFinding(findings, {
      ruleId: "CELLFENCE_CLAIM_INVALID",
      severity: "error",
      message: "write access check requires a non-empty agent",
    });
  }
  if (options.paths.length === 0) {
    addFinding(findings, {
      ruleId: "CELLFENCE_UNCLAIMED_CHANGE",
      severity: "error",
      message: "write access check requires at least one path",
    });
  }

  let manifest: CellFenceManifest;
  try {
    manifest = dependencies.loadManifestFromFile(manifestPath);
  } catch (error) {
    addFinding(findings, {
      ruleId: "CELLFENCE_MANIFEST_INVALID",
      severity: "error",
      message: `failed to read manifest ${repoPath(rootDir, manifestPath)}: ${errorMessage(error)}`,
    });
    return writeAccessResult(agent, options.paths.map((requestedPath) => ({
      requestedPath,
      allowed: false,
      reason: "manifest is unavailable",
      claimIds: [],
    })), findings, warnings, []);
  }

  const claimResultForPolicy = checkClaims({
    rootDir,
    manifestPath: repoPath(rootDir, manifestPath),
    claimsPath: options.claimsPath,
    now: options.now,
  }, dependencies);
  findings.push(...claimResultForPolicy.findings);
  warnings.push(...claimResultForPolicy.warnings);
  const activeClaims = claimResultForPolicy.activeClaims;
  const agentClaims = activeClaims.filter((claim) => claim.agent === agent);
  const otherClaims = activeClaims.filter((claim) => claim.agent !== agent);

  const pathDecisions = options.paths.map((requestedPath): WriteAccessPathDecision => {
    let normalizedPath: { relativePath: string; canonicalPath: string };
    try {
      normalizedPath = normalizeWriteAccessPath(rootDir, requestedPath);
    } catch (error) {
      addFinding(findings, {
        ruleId: "CELLFENCE_UNCLAIMED_CHANGE",
        severity: "error",
        message: `write access denied for ${requestedPath}: ${errorMessage(error)}`,
        details: { requestedPath },
      });
      return {
        requestedPath,
        allowed: false,
        reason: errorMessage(error),
        claimIds: [],
      };
    }

    if (!claimResultForPolicy.ok) {
      return {
        requestedPath,
        relativePath: normalizedPath.relativePath,
        canonicalPath: normalizedPath.canonicalPath,
        allowed: false,
        reason: "claim policy is invalid or conflicting",
        claimIds: agentClaims.map((claim) => claim.id),
      };
    }

    /* c8 ignore start -- checkClaims rejects overlapping active claims before write-path evaluation; this branch remains as a defensive guard for externally supplied policy results. */
    const conflictingClaim = otherClaims.find((claim) => claimCoversFile(manifest, claim, normalizedPath.relativePath));
    if (conflictingClaim) {
      addFinding(findings, {
        ruleId: "CELLFENCE_ACTIVE_CLAIM_CONFLICT",
        severity: "error",
        filePath: normalizedPath.relativePath,
        message: `${agent} cannot write ${normalizedPath.relativePath}; active claim ${conflictingClaim.id} belongs to ${conflictingClaim.agent}`,
        details: { agent, requestedPath, relativePath: normalizedPath.relativePath, conflictingClaim },
      });
      return {
        requestedPath,
        relativePath: normalizedPath.relativePath,
        canonicalPath: normalizedPath.canonicalPath,
        allowed: false,
        reason: `active claim ${conflictingClaim.id} belongs to ${conflictingClaim.agent}`,
        claimIds: agentClaims.map((claim) => claim.id),
      };
    }
    /* c8 ignore stop */

    const coveringClaims = agentClaims.filter((claim) => claimCoversFile(manifest, claim, normalizedPath.relativePath));
    if (coveringClaims.length === 0) {
      addFinding(findings, {
        ruleId: "CELLFENCE_UNCLAIMED_CHANGE",
        severity: "error",
        filePath: normalizedPath.relativePath,
        message: `${agent} cannot write ${normalizedPath.relativePath}; no active claim covers that path`,
        details: { agent, requestedPath, relativePath: normalizedPath.relativePath, activeClaimIds: agentClaims.map((claim) => claim.id) },
      });
      return {
        requestedPath,
        relativePath: normalizedPath.relativePath,
        canonicalPath: normalizedPath.canonicalPath,
        allowed: false,
        reason: "no active claim covers that path",
        claimIds: agentClaims.map((claim) => claim.id),
      };
    }

    const firstClaim = coveringClaims[0];
    const firstCellId = firstClaim.cells.find((cellId) => {
      /* c8 ignore next -- checkClaims validates claim cell references before write access computes the accepted cell id. */
      const cell = manifest.cells.find((candidate) => candidate.id === cellId);
      /* c8 ignore next -- checkClaims validates claim cell references before write access computes the accepted cell id. */
      return cell ? pathOwnedByCell(cell, normalizedPath.relativePath) : false;
    });
    return {
      requestedPath,
      relativePath: normalizedPath.relativePath,
      canonicalPath: normalizedPath.canonicalPath,
      allowed: true,
      reason: `covered by active claim ${firstClaim.id}`,
      cellId: firstCellId,
      claimIds: coveringClaims.map((claim) => claim.id),
    };
  });

  return writeAccessResult(agent, pathDecisions, findings, warnings, activeClaims);
}

function validateAgentChangedFiles(
  context: AnalysisContext,
  agent: string,
  activeClaims: CellFenceClaim[],
  changedFiles: string[],
  claimsPath: string,
  findings: Finding[],
): void {
  const claimsRelativePath = repoPath(context.rootDir, claimsPath);
  const agentClaims = activeClaims.filter((claim) => claim.agent === agent);
  const otherClaims = activeClaims.filter((claim) => claim.agent !== agent);
  for (const changedFile of changedFiles.filter((filePath) => normalizePath(filePath) !== claimsRelativePath)) {
    const coveredByAgent = agentClaims.some((claim) => claimCoversFile(context.manifest, claim, changedFile));
    const conflictingClaim = otherClaims.find((claim) => claimCoversFile(context.manifest, claim, changedFile));
    if (conflictingClaim) {
      addFinding(findings, {
        ruleId: "CELLFENCE_ACTIVE_CLAIM_CONFLICT",
        severity: "error",
        filePath: changedFile,
        message: `${agent} changed ${changedFile}, but active claim ${conflictingClaim.id} belongs to ${conflictingClaim.agent}`,
        details: { agent, changedFile, conflictingClaim },
        suggestedResolutions: [
          humanResolution("Serialize the work or create a non-overlapping claim before editing this path", {
            changedFile,
            conflictingClaim: conflictingClaim.id,
          }),
        ],
      });
    } else if (!coveredByAgent) {
      addFinding(findings, {
        ruleId: "CELLFENCE_UNCLAIMED_CHANGE",
        severity: "error",
        filePath: changedFile,
        message: `${agent} changed ${changedFile} without an active claim covering that path`,
        details: { agent, changedFile, activeClaimIds: agentClaims.map((claim) => claim.id) },
        suggestedResolutions: [
          humanResolution("Create or narrow an active CellFence claim before editing this path", {
            changedFile,
            agent,
          }),
        ],
      });
    }
  }
}

function claimResult(findings: Finding[], warnings: Finding[], claims: CellFenceClaim[], activeClaims: CellFenceClaim[], changedFiles?: string[]): ClaimCheckResult {
  const hasErrors = findings.some((finding) => finding.severity === "error");
  return {
    schemaVersion: "cellfence.claim-check.v1",
    ok: !hasErrors,
    exitCode: hasErrors ? 1 : 0,
    findings,
    warnings,
    claims,
    activeClaims,
    changedFiles,
  };
}

export function checkClaims(options: ClaimCheckOptions = {}, dependencies: ClaimOperationDependencies): ClaimCheckResult {
  const rootDir = path.resolve(options.rootDir || process.cwd());
  const manifestPath = path.resolve(rootDir, options.manifestPath || DEFAULT_MANIFEST_PATH);
  let manifest: CellFenceManifest;
  try {
    manifest = dependencies.loadManifestFromFile(manifestPath);
  } catch (error) {
    return claimConfigurationFailure(`failed to read manifest ${repoPath(rootDir, manifestPath)}: ${errorMessage(error)}`);
  }
  const context = dependencies.createContext(rootDir, manifest);
  const findings: Finding[] = [];
  const warnings: Finding[] = [];
  const store = readClaimStore(rootDir, options.claimsPath, findings);
  const claimsPath = repoPath(rootDir, store.path);
  const now = options.now || new Date();
  for (const claim of store.claims) validateClaimCells(context, claim, findings, claimsPath);
  const activeClaims = store.claims.filter((claim) => claimIsActive(claim, now));
  validateActiveClaimConflicts(activeClaims, findings);

  let changedFiles: string[] | undefined;
  if (options.agent) {
    try {
      const claimsRelativePath = repoPath(rootDir, store.path);
      changedFiles = changedFilesForClaimCheck(rootDir, options, dependencies).filter((filePath) => normalizePath(filePath) !== claimsRelativePath);
      validateAgentChangedFiles(context, options.agent, activeClaims, changedFiles, store.path, findings);
    } catch (error) {
      addFinding(findings, {
        ruleId: "CELLFENCE_GIT_METADATA_UNAVAILABLE",
        severity: "error",
        message: `claim check --agent requires git metadata to compare changed files: ${errorMessage(error)}`,
      });
    }
  }

  return claimResult(findings, warnings, store.claims, activeClaims, changedFiles);
}

function claimIdFor(claim: Omit<CellFenceClaim, "id">): string {
  const digest = crypto.createHash("sha256").update(JSON.stringify(claim)).digest("hex").slice(0, 12);
  return `claim-${digest}`;
}

export function createClaim(options: ClaimCreateOptions, dependencies: ClaimOperationDependencies): ClaimCreateResult {
  const rootDir = path.resolve(options.rootDir || process.cwd());
  const manifestPath = path.resolve(rootDir, options.manifestPath || DEFAULT_MANIFEST_PATH);
  let manifest: CellFenceManifest;
  try {
    manifest = dependencies.loadManifestFromFile(manifestPath);
  } catch (error) {
    return { ...claimConfigurationFailure(`failed to read manifest ${repoPath(rootDir, manifestPath)}: ${errorMessage(error)}`), claimsPath: claimStorePath(rootDir, options.claimsPath) };
  }
  const context = dependencies.createContext(rootDir, manifest);
  const findings: Finding[] = [];
  const warnings: Finding[] = [];
  const claimsStorePath = claimStorePath(rootDir, options.claimsPath);
  let releaseClaimLock: (() => void) | undefined;
  try {
    releaseClaimLock = acquireClaimStoreLock(claimsStorePath);
  } catch (error) {
    addFinding(findings, {
      ruleId: "CELLFENCE_CLAIM_INVALID",
      severity: "error",
      filePath: repoPath(rootDir, claimsStorePath),
      message: errorMessage(error),
    });
    return {
      ...claimResult(findings, warnings, [], []),
      claimsPath: claimsStorePath,
    };
  }
  try {
    const store = readClaimStore(rootDir, options.claimsPath, findings);
    const claimsPath = repoPath(rootDir, store.path);
    const now = options.now || new Date();
    const expiresAt = computeClaimExpiresAt(now, options.ttl, options.expiresAt);
    if (!expiresAt) {
      addFinding(findings, {
        ruleId: "CELLFENCE_CLAIM_INVALID",
        severity: "error",
        filePath: claimsPath,
        message: "claim requires --ttl like 30m, 2h, 1d or --expires as an ISO timestamp",
      });
    }
    const agent = options.agent?.trim() || "";
    if (agent.length === 0) {
      addFinding(findings, {
        ruleId: "CELLFENCE_CLAIM_INVALID",
        severity: "error",
        filePath: claimsPath,
        message: "claim requires a non-empty agent",
      });
    }
    const draft: Omit<CellFenceClaim, "id"> = {
      agent,
      task: options.task?.trim() || undefined,
      cells: sortedUnique(options.cells),
      paths: sortedUnique(options.paths),
      symbols: sortedUnique(options.symbols),
      resources: sortedUnique(options.resources),
      artifactLanes: sortedUnique(options.artifactLanes),
      createdAt: now.toISOString(),
      expiresAt: expiresAt || now.toISOString(),
    };
    const claimedSurfaceCount = draft.cells.length + draft.paths.length + draft.symbols.length + draft.resources.length + draft.artifactLanes.length;
    if (claimedSurfaceCount === 0) {
      addFinding(findings, {
        ruleId: "CELLFENCE_CLAIM_INVALID",
        severity: "error",
        filePath: claimsPath,
        message: "claim must reserve at least one cell, path, symbol, resource, or artifact lane",
      });
    }
    const claim: CellFenceClaim = {
      ...draft,
      id: options.claimId?.trim() || claimIdFor(draft),
    };
    validateClaimCells(context, claim, findings, claimsPath);
    const activeClaims = store.claims.filter((candidate) => claimIsActive(candidate, now));
    for (const existingClaim of activeClaims) {
      const surfaces = claimConflictSurfaces(existingClaim, claim);
      if (surfaces.length > 0) addClaimConflictFinding(findings, existingClaim, claim, surfaces);
    }
    if (findings.some((finding) => finding.severity === "error")) {
      return {
        ...claimResult(findings, warnings, store.claims, activeClaims),
        claimsPath: store.path,
      };
    }
    const nextClaims = [
      ...store.claims.filter((candidate) => candidate.id !== claim.id),
      claim,
    ];
    writeClaimStore(store.path, nextClaims);
    const nextActiveClaims = nextClaims.filter((candidate) => claimIsActive(candidate, now));
    return {
      ...claimResult(findings, warnings, nextClaims, nextActiveClaims),
      createdClaim: claim,
      claimsPath: store.path,
    };
  } finally {
    releaseClaimLock?.();
  }
}

export function listClaims(options: ClaimCheckOptions = {}): ClaimCheckResult {
  const findings: Finding[] = [];
  const rootDir = path.resolve(options.rootDir || process.cwd());
  const store = readClaimStore(rootDir, options.claimsPath, findings);
  const now = options.now || new Date();
  return claimResult(findings, [], store.claims, store.claims.filter((claim) => claimIsActive(claim, now)));
}
