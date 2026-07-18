import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import ts from "typescript";

import {
  CELLFENCE_BASELINE_SCHEMA_VERSION,
  type CellFenceResourceEvidence,
  type CellBaselineRecord,
  type CellFenceBaseline,
  type CellFenceManifest,
  type CellManifest,
  type CellConsumerManifest,
  type ResourceBaselineEntry,
  type ResourceAccessConfidence,
  type ResourceContractKind,
  type ResourceContractManifest,
  validateBaseline,
  validateManifest,
  validateResourceEvidence,
  type RuleSeverity as ConfiguredRuleSeverity,
} from "@cellfence/schema";
import {
  absolutePath,
  listFiles,
  listSymlinks,
  literalPrefix,
  matchesPattern,
  normalizePath,
  pathIsGoverned,
  pathOwnedByCell,
  patternCoveredByOwnedPaths,
  readSourceText,
  repoPath,
  SOURCE_EXTENSIONS,
  type FileIndexContext,
  type SymlinkEntry,
  sourceFilesForCell,
  sourceFilesUnderGovernance,
  sourceKindForPath,
} from "./file-index.js";
import {
  extractImports,
  extractPublicSymbols,
  getLineNumber,
  literalText,
  publicSurfaceHash,
  resolvePythonImport,
  readPathAliases,
  resolvePathAliasTarget,
  resolveRelativeImport,
  type ImportReference,
  type ImportWarning,
  type PathAlias,
} from "./module-resolution.js";
import {
  addResourceAccess,
  collectResourceAccesses,
  type ResourceAccessMode,
  type ResourceAccessReference,
} from "./resource-access.js";
import { assessEvidence } from "./governance/evidence-assessment.js";
import { createRawObservationReport } from "./governance/observation-report.js";
import { createSubjectSnapshotFromFiles, type SubjectSnapshotInputFile } from "./governance/subject-snapshot.js";
import { evaluateGovernance } from "./governance/evaluator.js";
import { legacyDecisionFromEvaluation } from "./governance/legacy-adapter.js";
import type { FileObservation, ObservationFamily } from "./governance/model.js";
import { validateChangedPathClasses, validatePathClassImports } from "./advanced-governance.js";
import { stableCanonicalJson } from "./governance/canonicalization.js";

export { inferManifest, type InferManifestOptions } from "./manifest-inference.js";
export {
  checkCommitEvidence,
  checkDesignDocs,
  checkMutationReport,
  checkTaskManifest,
  createBaselineAudit,
  createManifestFromServiceManifests,
  profileConfig,
  profileRuleSeverities,
  stampDesignDoc,
  verifyManifestFromServiceManifests,
  type BaselineAuditResult,
  type CommitEvidenceResult,
  type DocsCheckResult,
  type MutationCheckResult,
  type ServiceManifestImportResult,
  type ServiceManifestVerifyResult,
  type TaskCheckResult,
} from "./advanced-governance.js";

export type RuleId =
  | "CELLFENCE_MANIFEST_INVALID"
  | "CELLFENCE_DUPLICATE_CELL_ID"
  | "CELLFENCE_OWNERSHIP_OVERLAP"
  | "CELLFENCE_OWNERSHIP_COVERAGE_DISABLED"
  | "CELLFENCE_UNOWNED_SOURCE"
  | "CELLFENCE_UNOWNED_IMPORT_TARGET"
  | "CELLFENCE_PUBLIC_ENTRY_OUTSIDE_OWNERSHIP"
  | "CELLFENCE_ARTIFACT_OUTSIDE_OWNERSHIP"
  | "CELLFENCE_SYMLINK_TARGET_OUTSIDE_OWNERSHIP"
  | "CELLFENCE_PRIVATE_IMPORT"
  | "CELLFENCE_UNDECLARED_CONSUMER"
  | "CELLFENCE_PUBLIC_ENTRY_MISSING"
  | "CELLFENCE_PUBLIC_SYMBOL_MISMATCH"
  | "CELLFENCE_UNDECLARED_ARTIFACT"
  | "CELLFENCE_RATCHET_OWNED_PATH_GROWTH"
  | "CELLFENCE_RATCHET_PUBLIC_SYMBOL_GROWTH"
  | "CELLFENCE_RATCHET_PUBLIC_SURFACE_LINE_GROWTH"
  | "CELLFENCE_RATCHET_CROSS_CELL_DEPENDENCY_GROWTH"
  | "CELLFENCE_RATCHET_CELL_SET_GROWTH"
  | "CELLFENCE_RATCHET_OWNERSHIP_SCOPE_CHANGE"
  | "CELLFENCE_RATCHET_PUBLIC_SYMBOL_SET_CHANGE"
  | "CELLFENCE_RATCHET_DEPENDENCY_EDGE_CHANGE"
  | "CELLFENCE_RATCHET_PUBLIC_ENTRY_CHANGE"
  | "CELLFENCE_RATCHET_ARTIFACT_CONTRACT_CHANGE"
  | "CELLFENCE_RATCHET_PUBLIC_SURFACE_SIGNATURE_CHANGE"
  | "CELLFENCE_BASELINE_SEAL_INVALID"
  | "CELLFENCE_UNDECLARED_RESOURCE_ACCESS"
  | "CELLFENCE_UNRESOLVED_RESOURCE_ACCESS"
  | "CELLFENCE_RESOURCE_EVIDENCE_INVALID"
  | "CELLFENCE_PLUGIN_INVALID"
  | "CELLFENCE_REQUIRED_RULE_DISABLED"
  | "CELLFENCE_CLAIM_INVALID"
  | "CELLFENCE_ACTIVE_CLAIM_CONFLICT"
  | "CELLFENCE_UNCLAIMED_CHANGE"
  | "CELLFENCE_UNRESOLVED_IMPORT"
  | "CELLFENCE_CROSS_CELL_MOVE"
  | "CELLFENCE_LOCKED_BASELINE_EXPANSION"
  | "CELLFENCE_WAIVER_INVALID"
  | "CELLFENCE_GIT_METADATA_UNAVAILABLE"
  | "CELLFENCE_UNSUPPORTED_DYNAMIC_REQUIRE"
  | "CELLFENCE_UNSUPPORTED_DYNAMIC_IMPORT"
  | "CELLFENCE_SOURCE_IMPORTS_RUNTIME"
  | "CELLFENCE_MIXED_SOURCE_RUNTIME_CHANGE"
  | "CELLFENCE_GENERATED_PATH_CHANGED"
  | "CELLFENCE_SERVICE_MANIFEST_DRIFT"
  | "CELLFENCE_COMMIT_EVIDENCE_MISSING"
  | "CELLFENCE_COMMIT_TRAILER_MISSING"
  | "CELLFENCE_COMMIT_CHANGED_CELLS_MISMATCH"
  | "CELLFENCE_COMMIT_TEST_EVIDENCE_MISMATCH"
  | "CELLFENCE_COMMIT_TEST_REASON_REQUIRED"
  | "CELLFENCE_COMMIT_TEST_WEAKENING"
  | "CELLFENCE_TASK_INVALID"
  | "CELLFENCE_TASK_WRITE_OUTSIDE_ALLOWLIST"
  | "CELLFENCE_TASK_FORBIDDEN_PATH"
  | "CELLFENCE_TASK_CHANGE_BUDGET_EXCEEDED"
  | "CELLFENCE_DOC_UNKNOWN_CELL"
  | "CELLFENCE_DOC_SURFACE_STALE"
  | "CELLFENCE_MUTATION_SCORE_BELOW_THRESHOLD";

export type Severity = "error" | "warning";

export type SuggestedResolution = {
  kind: "change-code" | "change-manifest" | "update-baseline" | "ask-human";
  title: string;
  approvalRequired: boolean;
  details?: Record<string, unknown>;
};

type PluginFinding<RuleIdentifier extends string = string> = {
  ruleId: RuleIdentifier;
  severity: Severity;
  message: string;
  filePath?: string;
  cellId?: string;
  producerCellId?: string;
  details?: Record<string, unknown>;
  suggestedResolutions?: SuggestedResolution[];
  fingerprint?: string;
};

export type Finding = PluginFinding<RuleId | string>;

type PluginImportReference = {
  importerPath: string;
  importerCellId: string;
  specifier: string;
  kind: "import" | "export-from" | "require" | "dynamic-import";
  typeOnly: boolean;
  line: number;
  targetPath?: string;
  targetCellId?: string;
  artifactLaneId?: string;
  isExternal: boolean;
  isPublicPackage: boolean;
};

type PluginResourceAccess = {
  kind: ResourceContractKind;
  access: ResourceAccessMode;
  selector: string;
  filePath: string;
  line: number;
  source: string;
  detectedBy: string;
  confidence: ResourceAccessConfidence;
  cellId?: string;
  unresolved?: boolean;
  reason?: string;
};

type PluginRepositoryModel = {
  rootDir: string;
  manifest: CellFenceManifest;
  baseline: CellFenceBaseline | null;
  files: {
    all: readonly string[];
    governed: readonly string[];
    byCell: Readonly<Record<string, readonly string[]>>;
    contents: Readonly<Record<string, string>>;
  };
  imports: readonly PluginImportReference[];
  resources: readonly PluginResourceAccess[];
  metrics: Readonly<Record<string, CellBaselineRecord>>;
  changedFiles: ReadonlySet<string>;
};

type PluginRuleContext = {
  repository: PluginRepositoryModel;
  cells: readonly CellManifest[];
  report(finding: PluginFinding): void;
};

type PluginAdapterHelpers = {
  getQualifiedCallName(node: ts.Node): string | undefined;
  getStaticStringArgument(node: ts.CallExpression, index: number): string | undefined;
  lineOf(node: ts.Node): number;
};

type PluginAdapter = {
  name: string;
  detect(context: {
    repository: PluginRepositoryModel;
    cell: CellManifest;
    filePath: string;
    sourceText: string;
    sourceFile: ts.SourceFile;
    helpers: PluginAdapterHelpers;
  }): PluginResourceAccess[];
};

type PluginRule = {
  id: string;
  meta: {
    description: string;
    defaultSeverity: ConfiguredRuleSeverity;
    category: string;
    docsUrl?: string;
  };
  run(context: PluginRuleContext): void | PluginFinding[];
};

type PluginReporter = {
  name: string;
  report(context: {
    repository: PluginRepositoryModel;
    findings: readonly PluginFinding[];
    warnings: readonly PluginFinding[];
  }): string;
};

type PluginDefinition = {
  apiVersion: 1;
  name: string;
  version: string;
  capabilities?: {
    needsAst?: boolean;
    needsTypeChecker?: boolean;
    needsGitDiff?: boolean;
    needsRuntimeEvidence?: boolean;
    needsNetwork?: boolean;
  };
  rules?: Record<string, PluginRule>;
  adapters?: PluginAdapter[];
  reporters?: PluginReporter[];
  manifestSchema?: unknown;
};

export type CheckOptions = {
  rootDir?: string;
  manifestPath?: string;
  baselinePath?: string;
  evidencePaths?: string[];
  plugins?: PluginDefinition[];
  ruleSeverities?: Record<string, ConfiguredRuleSeverity>;
  changedFiles?: string[];
};

export type CheckResult = {
  ok: boolean;
  exitCode: 0 | 1 | 2 | 3;
  findings: Finding[];
  warnings: Finding[];
  metrics: Record<string, CellBaselineRecord>;
  changedFiles?: string[];
  baseFindingCount?: number;
};

export type PruneCandidateKind =
  | "unused-consumer"
  | "unused-public-symbol"
  | "unconsumed-artifact-lane"
  | "stale-waiver"
  | "stale-baseline-resource";

export type PruneCandidate = {
  kind: PruneCandidateKind;
  cellId?: string;
  producerCellId?: string;
  filePath?: string;
  line?: number;
  ruleId?: string;
  symbol?: string;
  artifactLaneId?: string;
  resource?: ResourceBaselineEntry;
  message: string;
  details?: Record<string, unknown>;
};

export type PruneReport = {
  schemaVersion: "cellfence.prune.v1";
  ok: boolean;
  candidates: PruneCandidate[];
  metrics: {
    candidates: number;
    unusedConsumers: number;
    unusedPublicSymbols: number;
    unconsumedArtifactLanes: number;
    staleWaivers: number;
    staleBaselineResources: number;
  };
};

export type ChangedCheckOptions = CheckOptions & {
  baseRef?: string;
  headRef?: string;
};

export type ContextBudgetEntry = {
  current: number;
  limit: number;
  remaining: number;
  source: "manifest-budget" | "baseline-ratchet";
};

export type ContextAllowedImport = {
  cell: string;
  publicEntry: string;
  packageName?: string;
  locked?: boolean;
  artifactLanes: string[];
};

type ContextBudgetMetric = "ownedPathPatterns" | "publicSymbols" | "publicSurfaceLines" | "crossCellDependencies";

export type CouplingGraphNode = {
  id: string;
  label: string;
  kind: "cell" | "resource" | "artifact";
};

export type CouplingGraphEdgeKind = "declared-consumer" | "observed-import" | "artifact-lane" | "resource-access";

export type CouplingGraphEdge = {
  from: string;
  to: string;
  kind: CouplingGraphEdgeKind;
  label: string;
};

export type CouplingGraph = {
  schemaVersion: "cellfence.coupling-graph.v1";
  nodes: CouplingGraphNode[];
  edges: CouplingGraphEdge[];
};

export type AutoAllocation = {
  schemaVersion: "cellfence.auto-allocation.v1";
  task: string;
  selectedCells: string[];
  contextCells: string[];
  includePaths: string[];
  publicEntries: string[];
  resourceSelectors: string[];
  budgets: Record<string, Record<string, ContextBudgetEntry>>;
  guidance: string[];
};

export type CellFenceClaim = {
  id: string;
  agent: string;
  task?: string;
  cells: string[];
  paths: string[];
  symbols: string[];
  resources: string[];
  artifactLanes: string[];
  createdAt: string;
  expiresAt: string;
};

export type CellFenceClaimStore = {
  schemaVersion: "cellfence.claims.v1";
  claims: CellFenceClaim[];
};

export type ClaimCreateOptions = CheckOptions & {
  claimsPath?: string;
  claimId?: string;
  agent: string;
  task?: string;
  ttl?: string;
  expiresAt?: string;
  cells?: string[];
  paths?: string[];
  symbols?: string[];
  resources?: string[];
  artifactLanes?: string[];
  now?: Date;
};

export type ClaimCheckOptions = CheckOptions & {
  claimsPath?: string;
  agent?: string;
  baseRef?: string;
  headRef?: string;
  now?: Date;
};

export type ClaimCheckResult = {
  schemaVersion: "cellfence.claim-check.v1";
  ok: boolean;
  exitCode: 0 | 1 | 2 | 3;
  findings: Finding[];
  warnings: Finding[];
  claims: CellFenceClaim[];
  activeClaims: CellFenceClaim[];
  changedFiles?: string[];
};

export type ClaimCreateResult = ClaimCheckResult & {
  createdClaim?: CellFenceClaim;
  claimsPath: string;
};

export type WriteAccessPathDecision = {
  requestedPath: string;
  relativePath?: string;
  canonicalPath?: string;
  allowed: boolean;
  reason: string;
  cellId?: string;
  claimIds: string[];
};

export type WriteAccessOptions = CheckOptions & {
  agent: string;
  paths: string[];
  claimsPath?: string;
  now?: Date;
};

export type WriteAccessResult = {
  schemaVersion: "cellfence.write-access.v1";
  ok: boolean;
  exitCode: 0 | 1 | 2 | 3;
  agent: string;
  paths: WriteAccessPathDecision[];
  findings: Finding[];
  warnings: Finding[];
  activeClaims: CellFenceClaim[];
};

export type CellFenceContext = {
  schemaVersion: "cellfence.context.v1";
  cell: {
    id: string;
    packageName?: string;
    locked: boolean;
    ownedPaths: string[];
    publicEntry: string;
    publicSymbols: string[];
  };
  allowedImports: ContextAllowedImport[];
  allowedResources: ResourceContractManifest[];
  baselineResources: ResourceBaselineEntry[];
  producedArtifacts: Array<{ id: string; paths: string[]; description?: string }>;
  budgets: Partial<Record<ContextBudgetMetric, ContextBudgetEntry>>;
  guidance: string[];
};

export type ContextOptions = CheckOptions & {
  cellId: string;
};

export type AutoAllocateOptions = CheckOptions & {
  task?: string;
  cellId?: string;
};

export type WaiverRequestOptions = {
  ruleId: RuleId;
  filePath: string;
  line: number;
  expires: string;
  approvedBy?: string;
  reason: string;
};

export type WaiverRequest = {
  schemaVersion: "cellfence.waiver-request.v1";
  directive: string;
  markdown: string;
  approvalRequired: true;
  ruleId: RuleId;
  filePath: string;
  line: number;
  expires: string;
  approvedBy: string;
  reason: string;
};

export type BaselineUpdateGuardResult = {
  ok: boolean;
  findings: Finding[];
};

export type BaselineUpdateGuardOptions = CheckOptions & {
  nextBaseline: CellFenceBaseline;
};

export type CellFenceWaiver = {
  ruleId: string;
  filePath: string;
  line: number;
  expires: string;
  approvedBy: string;
  reason: string;
  expired: boolean;
  valid: boolean;
  errors: string[];
};

type ResolvedImport = {
  targetPath?: string;
  targetCell?: CellManifest;
  artifactLaneId?: string;
  isExternal: boolean;
  isPublicPackage: boolean;
};

type AnalysisContext = FileIndexContext & {
  cellsById: Map<string, CellManifest>;
  packageToCell: Map<string, CellManifest>;
  packageRoots: Map<string, string>;
  pathAliases: PathAlias[];
};

const DEFAULT_MANIFEST_PATH = "cellfence.manifest.json";
const DEFAULT_BASELINE_PATH = "cellfence.baseline.json";
const DEFAULT_CLAIMS_PATH = ".cellfence/claims.json";
const BASELINE_HMAC_KEY_ENV = "CELLFENCE_BASELINE_HMAC_KEY";
const BASELINE_HMAC_KEY_ID_ENV = "CELLFENCE_BASELINE_HMAC_KEY_ID";
const CORE_REQUIRED_RULES = [
  "CELLFENCE_OWNERSHIP_OVERLAP",
  "CELLFENCE_UNOWNED_SOURCE",
  "CELLFENCE_UNOWNED_IMPORT_TARGET",
  "CELLFENCE_PUBLIC_ENTRY_OUTSIDE_OWNERSHIP",
  "CELLFENCE_ARTIFACT_OUTSIDE_OWNERSHIP",
  "CELLFENCE_SYMLINK_TARGET_OUTSIDE_OWNERSHIP",
  "CELLFENCE_PRIVATE_IMPORT",
  "CELLFENCE_UNSUPPORTED_DYNAMIC_IMPORT",
  "CELLFENCE_UNSUPPORTED_DYNAMIC_REQUIRE",
  "CELLFENCE_REQUIRED_RULE_DISABLED",
  "CELLFENCE_WAIVER_INVALID",
];

function readJsonFile(filePath: string): unknown {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function normalizedFindingDetails(details: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!details) return undefined;
  const normalizedEntries = Object.entries(details)
    .filter(([key]) => !["message", "currentHash", "nextHash"].includes(key))
    .map(([key, value]) => [key, value] as const);
  return normalizedEntries.length > 0 ? Object.fromEntries(normalizedEntries) : undefined;
}

function findingFingerprint(finding: Finding): string {
  return crypto
    .createHash("sha256")
    .update(stableCanonicalJson({
      ruleId: finding.ruleId,
      severity: finding.severity,
      filePath: finding.filePath ? normalizePath(finding.filePath) : undefined,
      cellId: finding.cellId,
      producerCellId: finding.producerCellId,
      details: normalizedFindingDetails(finding.details),
    }))
    .digest("hex");
}

function withFindingFingerprint(finding: Finding): Finding {
  return {
    ...finding,
    fingerprint: finding.fingerprint || findingFingerprint(finding),
  };
}

function addFinding(findings: Finding[], finding: Finding): void {
  findings.push(withFindingFingerprint(finding));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function baselineWithoutSeal(baseline: CellFenceBaseline): Omit<CellFenceBaseline, "seal"> {
  const { seal: _seal, ...unsignedBaseline } = baseline;
  return unsignedBaseline;
}

function baselineHmacDigest(baseline: CellFenceBaseline | Omit<CellFenceBaseline, "seal">, secret: string): string {
  return crypto
    .createHmac("sha256", secret)
    .update(stableCanonicalJson("seal" in baseline ? baselineWithoutSeal(baseline) : baseline))
    .digest("hex");
}

function sealBaselineIfConfigured(baseline: CellFenceBaseline): CellFenceBaseline {
  const secret = process.env[BASELINE_HMAC_KEY_ENV];
  if (!secret) return baseline;
  const unsignedBaseline = baselineWithoutSeal(baseline);
  const sealedBaseline: CellFenceBaseline = {
    ...unsignedBaseline,
    seal: {
      algorithm: "hmac-sha256",
      ...(process.env[BASELINE_HMAC_KEY_ID_ENV] ? { keyId: process.env[BASELINE_HMAC_KEY_ID_ENV] } : {}),
      digest: baselineHmacDigest(unsignedBaseline, secret),
    },
  };
  return sealedBaseline;
}

function validateBaselineSeal(manifest: CellFenceManifest, baseline: CellFenceBaseline, baselinePath: string, findings: Finding[]): void {
  const secret = process.env[BASELINE_HMAC_KEY_ENV];
  const lockedCells = manifest.cells.filter((cell) => cell.locked);
  if (!secret && lockedCells.length > 0) {
    addFinding(findings, {
      ruleId: "CELLFENCE_BASELINE_SEAL_INVALID",
      severity: "error",
      filePath: baselinePath,
      message: `locked cells require ${BASELINE_HMAC_KEY_ENV} during baseline check`,
      details: { lockedCells: lockedCells.map((cell) => cell.id) },
    });
    return;
  }
  if (!secret) return;
  if (!baseline.seal) {
    addFinding(findings, {
      ruleId: "CELLFENCE_BASELINE_SEAL_INVALID",
      severity: "error",
      filePath: baselinePath,
      message: `baseline is not sealed; set ${BASELINE_HMAC_KEY_ENV} only after creating or updating the baseline with the same key`,
    });
    return;
  }
  const expectedDigest = baselineHmacDigest(baseline, secret);
  if (baseline.seal.digest !== expectedDigest) {
    addFinding(findings, {
      ruleId: "CELLFENCE_BASELINE_SEAL_INVALID",
      severity: "error",
      filePath: baselinePath,
      message: "baseline seal does not match the checked baseline content",
      details: { algorithm: baseline.seal.algorithm, keyId: baseline.seal.keyId },
    });
  }
}

const WAIVER_PATTERN = /cellfence-ignore\s+([A-Z0-9_*]+)\s+(.*)$/;

function todayIsoDate(): string {
  return new Date().toISOString().slice(0, 10);
}

function isIsoDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00.000Z`));
}

function parseWaiverDirective(rootDir: string, filePath: string, line: number, text: string): CellFenceWaiver | undefined {
  const match = WAIVER_PATTERN.exec(text);
  if (!match) return undefined;
  const [, ruleId, suffix] = match;
  const expiresMatch = /\bexpires:(\d{4}-\d{2}-\d{2})\b/.exec(suffix);
  const approvedByMatch = /\bapproved-by:([^\s]+)/.exec(suffix);
  const reasonMatch = /\breason:(.+)$/.exec(suffix);
  const expires = expiresMatch?.[1] || "";
  const approvedBy = approvedByMatch?.[1] || "";
  const reason = reasonMatch ? reasonMatch[1].trim() : "";
  const errors: string[] = [];
  if (!/^CELLFENCE_[A-Z0-9_]+$/.test(ruleId)) errors.push("rule id must be a concrete CELLFENCE_* rule");
  if (!expires || !isIsoDate(expires)) errors.push("expires must be YYYY-MM-DD");
  if (!approvedBy) errors.push("approved-by is required");
  if (approvedBy.toUpperCase() === "PENDING") errors.push("approved-by:PENDING is a request placeholder, not an approval");
  if (reason.length < 12) errors.push("reason must explain the waiver in at least 12 characters");
  const expired = Boolean(expires) && expires < todayIsoDate();
  if (expired) errors.push("waiver is expired");
  return {
    ruleId,
    filePath: repoPath(rootDir, filePath),
    line,
    expires,
    approvedBy,
    reason,
    expired,
    valid: errors.length === 0,
    errors,
  };
}

function sourceFilesForManifest(rootDir: string, manifest: CellFenceManifest): string[] {
  const context = createContext(rootDir, manifest);
  const files = new Set<string>();
  for (const cell of manifest.cells) {
    for (const sourceFile of sourceFilesForCell(rootDir, cell, context)) {
      files.add(sourceFile);
    }
  }
  return [...files].sort((left, right) => left.localeCompare(right));
}

function collectWaiversForManifest(rootDir: string, manifest: CellFenceManifest): CellFenceWaiver[] {
  const waivers: CellFenceWaiver[] = [];
  for (const sourceFile of sourceFilesForManifest(rootDir, manifest)) {
    const lines = fs.readFileSync(sourceFile, "utf8").split(/\r?\n/);
    for (const [index, line] of lines.entries()) {
      const waiver = parseWaiverDirective(rootDir, sourceFile, index + 1, line);
      if (waiver) waivers.push(waiver);
    }
  }
  return waivers;
}

export function listWaivers(options: CheckOptions = {}): CellFenceWaiver[] {
  const rootDir = path.resolve(options.rootDir || process.cwd());
  const manifestPath = path.resolve(rootDir, options.manifestPath || DEFAULT_MANIFEST_PATH);
  const manifest = loadManifestFromFile(manifestPath);
  return collectWaiversForManifest(rootDir, manifest);
}

function lineForFinding(finding: Finding): number | undefined {
  const line = finding.details?.line;
  return Number.isInteger(line) ? Number(line) : undefined;
}

function waiverMatchesFinding(waiver: CellFenceWaiver, finding: Finding): boolean {
  if (!finding.filePath || waiver.filePath !== normalizePath(finding.filePath)) return false;
  if (waiver.ruleId !== finding.ruleId) return false;
  const findingLine = lineForFinding(finding);
  if (!findingLine) return true;
  return waiver.line === findingLine || waiver.line === findingLine - 1;
}

function applyWaiversToFindings(
  context: AnalysisContext,
  findings: Finding[],
  warnings: Finding[],
): { findings: Finding[]; warnings: Finding[] } {
  const waivers = collectWaiversForManifest(context.rootDir, context.manifest);
  const validWaivers = waivers.filter((waiver) => waiver.valid);
  const waiverFindings = waivers
    .filter((waiver) => !waiver.valid)
    .map((waiver): Finding => ({
      ruleId: "CELLFENCE_WAIVER_INVALID",
      severity: "error",
      filePath: waiver.filePath,
      message: `invalid CellFence waiver at line ${waiver.line}: ${waiver.errors.join("; ")}`,
      details: {
        line: waiver.line,
        ruleId: waiver.ruleId,
        expires: waiver.expires,
        approvedBy: waiver.approvedBy,
        reason: waiver.reason,
      },
    }));

  const isWaived = (finding: Finding) => validWaivers.some((waiver) => waiverMatchesFinding(waiver, finding));
  return {
    findings: [...findings.filter((finding) => !isWaived(finding)), ...waiverFindings],
    warnings: warnings.filter((warning) => !isWaived(warning)),
  };
}

function codeResolution(title: string, details?: Record<string, unknown>): SuggestedResolution {
  return { kind: "change-code", title, approvalRequired: false, details };
}

function manifestResolution(title: string, approvalRequired: boolean, details?: Record<string, unknown>): SuggestedResolution {
  return { kind: "change-manifest", title, approvalRequired, details };
}

function baselineResolution(title: string, approvalRequired: boolean, details?: Record<string, unknown>): SuggestedResolution {
  return { kind: "update-baseline", title, approvalRequired, details };
}

function humanResolution(title: string, details?: Record<string, unknown>): SuggestedResolution {
  return { kind: "ask-human", title, approvalRequired: true, details };
}

function findOwningCell(manifest: CellFenceManifest, relativePath: string): CellManifest | undefined {
  return manifest.cells.find((cell) => cell.ownedPaths.some((pattern) => matchesPattern(relativePath, pattern)));
}

function owningCells(manifest: CellFenceManifest, relativePath: string): CellManifest[] {
  return manifest.cells.filter((cell) => cell.ownedPaths.some((pattern) => matchesPattern(relativePath, pattern)));
}

function findPackageRoot(rootDir: string, publicEntry: string): string | undefined {
  let directoryPath = path.dirname(absolutePath(rootDir, publicEntry));
  while (directoryPath.startsWith(rootDir)) {
    if (fs.existsSync(path.join(directoryPath, "package.json"))) {
      return repoPath(rootDir, directoryPath);
    }
    const parentPath = path.dirname(directoryPath);
    /* c8 ignore next -- Safety guard for filesystem roots; normal repo roots exit via the while condition. */
    if (parentPath === directoryPath) break;
    directoryPath = parentPath;
  }
  return undefined;
}

function createContext(rootDir: string, manifest: CellFenceManifest): AnalysisContext {
  const cellsById = new Map<string, CellManifest>();
  const packageToCell = new Map<string, CellManifest>();
  const packageRoots = new Map<string, string>();
  for (const cell of manifest.cells) {
    cellsById.set(cell.id, cell);
    if (cell.packageName) {
      packageToCell.set(cell.packageName, cell);
      const packageRoot = findPackageRoot(rootDir, cell.publicEntry);
      if (packageRoot) packageRoots.set(cell.packageName, packageRoot);
    }
  }
  return {
    rootDir,
    manifest,
    cellsById,
    packageToCell,
    packageRoots,
    pathAliases: readPathAliases(rootDir),
    sourceFilesForCellCache: new Map<string, string[]>(),
    sourceTextCache: new Map<string, string>(),
    sourceFileCache: new Map<string, ts.SourceFile>(),
  };
}

function validateDuplicateCellIds(manifest: CellFenceManifest, findings: Finding[]): void {
  const seenCellIds = new Set<string>();
  for (const cell of manifest.cells) {
    if (seenCellIds.has(cell.id)) {
      addFinding(findings, {
        ruleId: "CELLFENCE_DUPLICATE_CELL_ID",
        severity: "error",
        cellId: cell.id,
        message: `duplicate cell id ${cell.id}`,
      });
    }
    seenCellIds.add(cell.id);
  }
}

function validateOwnershipOverlap(manifest: CellFenceManifest, findings: Finding[]): void {
  for (let leftIndex = 0; leftIndex < manifest.cells.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < manifest.cells.length; rightIndex += 1) {
      const leftCell = manifest.cells[leftIndex];
      const rightCell = manifest.cells[rightIndex];
      for (const leftPattern of leftCell.ownedPaths) {
        for (const rightPattern of rightCell.ownedPaths) {
          const leftPrefix = literalPrefix(leftPattern);
          const rightPrefix = literalPrefix(rightPattern);
          if (leftPrefix && rightPrefix && (leftPrefix.startsWith(rightPrefix) || rightPrefix.startsWith(leftPrefix))) {
            addFinding(findings, {
              ruleId: "CELLFENCE_OWNERSHIP_OVERLAP",
              severity: "error",
              cellId: leftCell.id,
              producerCellId: rightCell.id,
              message: `owned path patterns overlap: ${leftCell.id}:${leftPattern} and ${rightCell.id}:${rightPattern}`,
              details: { leftPattern, rightPattern },
            });
          }
        }
      }
    }
  }
}

function warnWhenOwnershipCoverageDisabled(context: AnalysisContext, warnings: Finding[]): void {
  if (context.manifest.governance?.requireOwnership === true) return;
  addFinding(warnings, {
    ruleId: "CELLFENCE_OWNERSHIP_COVERAGE_DISABLED",
    severity: "warning",
    message: "strict ownership coverage is disabled; source outside ownedPaths can escape CellFence checks",
    details: {
      governance: context.manifest.governance,
      suggestedGovernance: {
        requireOwnership: true,
        include: ["src/**", "packages/**", "apps/**"],
        exclude: ["tests/**", "fixtures/**"],
      },
    },
    suggestedResolutions: [
      manifestResolution("Enable governance.requireOwnership and include the source roots CellFence must govern", true, {
        governance: {
          requireOwnership: true,
          include: ["src/**", "packages/**", "apps/**"],
          exclude: ["tests/**", "fixtures/**"],
        },
      }),
    ],
  });
}

function validateOwnershipCoverage(context: AnalysisContext, findings: Finding[]): void {
  for (const cell of context.manifest.cells) {
    if (!pathOwnedByCell(cell, cell.publicEntry)) {
      addFinding(findings, {
        ruleId: "CELLFENCE_PUBLIC_ENTRY_OUTSIDE_OWNERSHIP",
        severity: "error",
        cellId: cell.id,
        filePath: cell.publicEntry,
        message: `${cell.id} public entry is outside its ownedPaths: ${cell.publicEntry}`,
        details: { publicEntry: cell.publicEntry, ownedPaths: cell.ownedPaths },
        suggestedResolutions: [
          manifestResolution("Move publicEntry under an owned path or narrow the manifest to the real owner", Boolean(cell.locked), {
            cell: cell.id,
            publicEntry: cell.publicEntry,
          }),
        ],
      });
    }

    for (const artifactLane of cell.producesArtifacts || []) {
      for (const artifactPath of artifactLane.paths) {
        if (patternCoveredByOwnedPaths(artifactPath, cell.ownedPaths)) continue;
        addFinding(findings, {
          ruleId: "CELLFENCE_ARTIFACT_OUTSIDE_OWNERSHIP",
          severity: "error",
          cellId: cell.id,
          filePath: artifactPath,
          message: `${cell.id} artifact lane ${artifactLane.id} is outside its ownedPaths: ${artifactPath}`,
          details: { artifactLaneId: artifactLane.id, artifactPath, ownedPaths: cell.ownedPaths },
          suggestedResolutions: [
            manifestResolution("Move the artifact lane under the producer ownedPaths or assign the artifact to the owning cell", Boolean(cell.locked), {
              cell: cell.id,
              artifactLane: artifactLane.id,
            }),
          ],
        });
      }
    }
  }

  for (const sourceFilePath of sourceFilesUnderGovernance(context.rootDir, context.manifest, context)) {
    const relativePath = repoPath(context.rootDir, sourceFilePath);
    if (findOwningCell(context.manifest, relativePath)) continue;
    addFinding(findings, {
      ruleId: "CELLFENCE_UNOWNED_SOURCE",
      severity: "error",
      filePath: relativePath,
      message: `governed source file is not owned by any cell: ${relativePath}`,
      details: { path: relativePath, governance: context.manifest.governance },
      suggestedResolutions: [
        manifestResolution("Assign this source path to exactly one cell or exclude it from governance", true, {
          path: relativePath,
        }),
      ],
    });
  }
}

function symlinkIsRelevant(context: AnalysisContext, symlink: SymlinkEntry): boolean {
  const relativePath = repoPath(context.rootDir, symlink.path);
  return SOURCE_EXTENSIONS.includes(path.extname(relativePath))
    || pathIsGoverned(context.manifest, relativePath)
    || owningCells(context.manifest, relativePath).length > 0;
}

function targetIsInsideRoot(rootDir: string, targetPath: string): boolean {
  const rootRealPath = fs.realpathSync(rootDir);
  const normalizedRoot = rootRealPath.endsWith(path.sep) ? rootRealPath : `${rootRealPath}${path.sep}`;
  return targetPath === rootRealPath || targetPath.startsWith(normalizedRoot);
}

function validateSymlinkTargets(context: AnalysisContext, findings: Finding[]): void {
  for (const symlink of listSymlinks(context.rootDir)) {
    if (!symlinkIsRelevant(context, symlink)) continue;
    const relativePath = repoPath(context.rootDir, symlink.path);
    if (!symlink.targetPath) {
      addFinding(findings, {
        ruleId: "CELLFENCE_SYMLINK_TARGET_OUTSIDE_OWNERSHIP",
        severity: "error",
        filePath: relativePath,
        message: `governed symlink cannot be resolved: ${relativePath}`,
        details: { path: relativePath, error: symlink.error },
        suggestedResolutions: [
          codeResolution("Replace the symlink with a regular file inside the owning cell or remove the broken link"),
        ],
      });
      continue;
    }
    if (!targetIsInsideRoot(context.rootDir, symlink.targetPath)) {
      addFinding(findings, {
        ruleId: "CELLFENCE_SYMLINK_TARGET_OUTSIDE_OWNERSHIP",
        severity: "error",
        filePath: relativePath,
        message: `governed symlink points outside the repository: ${relativePath}`,
        details: { path: relativePath },
        suggestedResolutions: [
          codeResolution("Replace the symlink with a checked-in source file or point it inside the owning cell"),
        ],
      });
      continue;
    }

    const targetRelativePath = repoPath(context.rootDir, symlink.targetPath);
    const linkOwners = owningCells(context.manifest, relativePath);
    const targetOwners = owningCells(context.manifest, targetRelativePath);
    const sharesOwner = linkOwners.some((linkOwner) => targetOwners.some((targetOwner) => targetOwner.id === linkOwner.id));
    if (linkOwners.length > 0 && !sharesOwner) {
      addFinding(findings, {
        ruleId: "CELLFENCE_SYMLINK_TARGET_OUTSIDE_OWNERSHIP",
        severity: "error",
        cellId: linkOwners[0].id,
        producerCellId: targetOwners[0]?.id,
        filePath: relativePath,
        message: `governed symlink ${relativePath} targets ${targetRelativePath} outside its owning cell`,
        details: {
          path: relativePath,
          targetPath: targetRelativePath,
          linkOwners: linkOwners.map((cell) => cell.id),
          targetOwners: targetOwners.map((cell) => cell.id),
        },
        suggestedResolutions: [
          codeResolution("Import the producer public entry instead of re-exporting another cell through a symlink"),
          humanResolution("Ask a human owner to review whether this path should move to the target cell"),
        ],
      });
    }
  }
}

function resourceBaselineEntry(access: ResourceAccessReference): ResourceBaselineEntry {
  return {
    kind: access.kind,
    access: access.access,
    selector: access.selector,
    detectedBy: access.detectedBy,
    confidence: access.confidence,
  };
}

function resourceBaselineKey(access: ResourceBaselineEntry): string {
  return `${access.kind}:${access.access}:${access.selector}`;
}

function sortedResourceBaselineEntries(accesses: ResourceAccessReference[]): ResourceBaselineEntry[] {
  const uniqueEntries = new Map<string, ResourceBaselineEntry>();
  for (const access of accesses) {
    const entry = resourceBaselineEntry(access);
    uniqueEntries.set(resourceBaselineKey(entry), entry);
  }
  return [...uniqueEntries.values()].sort((left, right) => resourceBaselineKey(left).localeCompare(resourceBaselineKey(right)));
}

function resourceAccessDeclaredByManifest(cell: CellManifest, access: ResourceAccessReference): boolean {
  return (cell.resourceContracts || []).some((contract) =>
    contract.kind === access.kind
    && contract.access.includes(access.access)
    && contract.selectors.some((selector) => matchesPattern(access.selector, selector) || selector === access.selector)
  );
}

function resourceAccessDeclaredByBaseline(cell: CellManifest, baseline: CellFenceBaseline | undefined, access: ResourceAccessReference): boolean {
  const resourceAccesses = baseline?.cells[cell.id]?.resourceAccesses || [];
  const currentAccessKey = resourceBaselineKey(resourceBaselineEntry(access));
  return resourceAccesses.some((entry) => resourceBaselineKey(entry) === currentAccessKey);
}

function resourceAccessVerb(access: ResourceAccessMode): string {
  if (access === "publish") return "publishes";
  if (access === "subscribe") return "subscribes to";
  if (access === "call") return "calls";
  if (access === "serve") return "serves";
  if (access === "read") return "reads";
  return "writes";
}

function validateResourceAccesses(context: AnalysisContext, findings: Finding[], warnings: Finding[], baseline: CellFenceBaseline | undefined): Map<string, ResourceAccessReference[]> {
  const accessesByCell = new Map<string, ResourceAccessReference[]>();
  for (const cell of context.manifest.cells) {
    const cellAccesses: ResourceAccessReference[] = [];
    for (const sourceFilePath of sourceFilesForCell(context.rootDir, cell, context)) {
      for (const access of collectResourceAccesses(context, sourceFilePath)) {
        if (access.unresolved) {
          if (resourceAccessDeclaredByManifest(cell, access) || resourceAccessDeclaredByBaseline(cell, baseline, access)) {
            cellAccesses.push(access);
            continue;
          }
          const severity: Severity = access.kind === "file" ? "warning" : "error";
          addFinding(severity === "warning" ? warnings : findings, {
            ruleId: "CELLFENCE_UNRESOLVED_RESOURCE_ACCESS",
            severity,
            cellId: cell.id,
            filePath: access.filePath,
            message: `${cell.id} has unresolved ${access.kind} resource access at line ${access.line}: ${access.reason as string}`,
            details: {
              kind: access.kind,
              access: access.access,
              selector: access.selector,
              line: access.line,
              source: access.source,
              detectedBy: access.detectedBy,
              confidence: access.confidence,
              reason: access.reason,
            },
          });
          continue;
        }
        cellAccesses.push(access);
        if (resourceAccessDeclaredByManifest(cell, access) || resourceAccessDeclaredByBaseline(cell, baseline, access)) continue;
        addFinding(findings, {
          ruleId: "CELLFENCE_UNDECLARED_RESOURCE_ACCESS",
          severity: "error",
          cellId: cell.id,
          filePath: access.filePath,
          message: `${cell.id} ${resourceAccessVerb(access.access)} undeclared ${access.kind} resource ${access.selector}`,
          details: {
            kind: access.kind,
            access: access.access,
            selector: access.selector,
            line: access.line,
            source: access.source,
            detectedBy: access.detectedBy,
            confidence: access.confidence,
          },
          suggestedResolutions: [
            codeResolution(`Remove or route this ${access.kind} access through an allowed owner`, {
              kind: access.kind,
              access: access.access,
              selector: access.selector,
            }),
            manifestResolution(`Declare ${access.kind} ${access.access} access for ${access.selector}`, Boolean(cell.locked), {
              cell: cell.id,
              resourceContract: {
                kind: access.kind,
                access: [access.access],
                selectors: [access.selector],
              },
            }),
          ],
        });
      }
    }
    accessesByCell.set(cell.id, cellAccesses);
  }
  return accessesByCell;
}

function addAccessToCell(accessesByCell: Map<string, ResourceAccessReference[]>, cellId: string, access: ResourceAccessReference): void {
  const currentAccesses = accessesByCell.get(cellId) || [];
  addResourceAccess(currentAccesses, access);
  accessesByCell.set(cellId, currentAccesses);
}

function evidencePathsForOptions(rootDir: string, evidencePaths: string[] | undefined): string[] {
  return (evidencePaths || []).map((evidencePath) => path.resolve(rootDir, evidencePath));
}

function resourceEvidenceAccesses(
  context: AnalysisContext,
  evidencePaths: string[],
  findings: Finding[],
  baseline: CellFenceBaseline | undefined,
): Map<string, ResourceAccessReference[]> {
  const accessesByCell = new Map<string, ResourceAccessReference[]>();
  for (const evidencePath of evidencePaths) {
    let evidence: CellFenceResourceEvidence;
    try {
      const validation = validateResourceEvidence(readJsonFile(evidencePath));
      if (!validation.ok || !validation.value) {
        addFinding(findings, {
          ruleId: "CELLFENCE_RESOURCE_EVIDENCE_INVALID",
          severity: "error",
          filePath: repoPath(context.rootDir, evidencePath),
          message: `resource evidence is invalid: ${validation.errors.join("; ")}`,
        });
        continue;
      }
      evidence = validation.value;
    } catch (error) {
      addFinding(findings, {
        ruleId: "CELLFENCE_RESOURCE_EVIDENCE_INVALID",
        severity: "error",
        filePath: repoPath(context.rootDir, evidencePath),
        message: `failed to read resource evidence: ${errorMessage(error)}`,
      });
      continue;
    }

    for (const [entryIndex, entry] of evidence.accesses.entries()) {
      const cellId = entry.cellId || evidence.cellId;
      if (!cellId || !context.cellsById.has(cellId)) {
        addFinding(findings, {
          ruleId: "CELLFENCE_RESOURCE_EVIDENCE_INVALID",
          severity: "error",
          filePath: repoPath(context.rootDir, evidencePath),
          message: `resource evidence access ${entryIndex} references unknown cell ${cellId || "(missing)"}`,
          details: { entryIndex, cellId },
        });
        continue;
      }

      const cell = context.cellsById.get(cellId) as CellManifest;
      const access: ResourceAccessReference = {
        kind: entry.kind,
        access: entry.access,
        selector: entry.selector,
        filePath: repoPath(context.rootDir, evidencePath),
        line: 1,
        source: entry.detectedBy || "resource-evidence",
        detectedBy: entry.detectedBy || "runtime-evidence",
        confidence: entry.confidence || "runtime",
      };
      addAccessToCell(accessesByCell, cellId, access);

      if (resourceAccessDeclaredByManifest(cell, access) || resourceAccessDeclaredByBaseline(cell, baseline, access)) continue;
      addFinding(findings, {
        ruleId: "CELLFENCE_UNDECLARED_RESOURCE_ACCESS",
        severity: "error",
        cellId,
        filePath: access.filePath,
        message: `${cellId} ${resourceAccessVerb(access.access)} undeclared runtime ${access.kind} resource ${access.selector}`,
        details: {
          kind: access.kind,
          access: access.access,
          selector: access.selector,
          source: access.source,
          detectedBy: access.detectedBy,
          confidence: access.confidence,
        },
        suggestedResolutions: [
          codeResolution(`Stop emitting runtime evidence for undeclared ${access.kind} access if it is accidental`, {
            kind: access.kind,
            access: access.access,
            selector: access.selector,
          }),
          manifestResolution(`Declare runtime ${access.kind} ${access.access} access for ${access.selector}`, Boolean(cell.locked), {
            cell: cell.id,
            resourceContract: {
              kind: access.kind,
              access: [access.access],
              selectors: [access.selector],
            },
          }),
        ],
      });
    }
  }
  return accessesByCell;
}

function mergeAccessesByCell(target: Map<string, ResourceAccessReference[]>, source: Map<string, ResourceAccessReference[]>): void {
  for (const [cellId, accesses] of source.entries()) {
    for (const access of accesses) {
      addAccessToCell(target, cellId, access);
    }
  }
}

function allSourceFilesByCell(context: AnalysisContext): Record<string, readonly string[]> {
  const byCell: Record<string, readonly string[]> = {};
  for (const cell of context.manifest.cells) {
    byCell[cell.id] = sourceFilesForCell(context.rootDir, cell, context).map((filePath) => repoPath(context.rootDir, filePath));
  }
  return byCell;
}

function repositoryFiles(context: AnalysisContext): readonly string[] {
  return listFiles(context.rootDir, context).map((filePath) => repoPath(context.rootDir, filePath));
}

function sourceContentsByPath(context: AnalysisContext, byCell: Record<string, readonly string[]>): Record<string, string> {
  const contents: Record<string, string> = {};
  const sourceFiles = new Set(Object.values(byCell).flat());
  for (const filePath of sourceFiles) {
    contents[filePath] = readSourceText(context, path.join(context.rootDir, filePath));
  }
  return contents;
}

function resourceAccessForPlugin(cellId: string, access: ResourceAccessReference): PluginResourceAccess {
  return {
    kind: access.kind,
    access: access.access,
    selector: access.selector,
    filePath: access.filePath,
    line: access.line,
    source: access.source,
    detectedBy: access.detectedBy,
    confidence: access.confidence,
    cellId,
    unresolved: access.unresolved,
    reason: access.reason,
  };
}

function flattenResourceAccesses(accessesByCell: Map<string, ResourceAccessReference[]>): PluginResourceAccess[] {
  const accesses: PluginResourceAccess[] = [];
  for (const [cellId, cellAccesses] of accessesByCell.entries()) {
    for (const access of cellAccesses) accesses.push(resourceAccessForPlugin(cellId, access));
  }
  return accesses.sort((left, right) =>
    `${left.cellId}:${left.kind}:${left.access}:${left.selector}:${left.filePath}:${left.line}`
      .localeCompare(`${right.cellId}:${right.kind}:${right.access}:${right.selector}:${right.filePath}:${right.line}`));
}

function createRepositoryModel(
  context: AnalysisContext,
  baseline: CellFenceBaseline | undefined,
  observedImports: PluginImportReference[],
  accessesByCell: Map<string, ResourceAccessReference[]>,
  metrics: Record<string, CellBaselineRecord>,
  changedFiles: string[] = [],
): PluginRepositoryModel {
  const byCell = allSourceFilesByCell(context);
  return {
    rootDir: context.rootDir,
    manifest: context.manifest,
    baseline: baseline || null,
    files: {
      all: repositoryFiles(context),
      governed: sourceFilesUnderGovernance(context.rootDir, context.manifest, context).map((filePath) => repoPath(context.rootDir, filePath)),
      byCell,
      contents: sourceContentsByPath(context, byCell),
    },
    imports: observedImports,
    resources: flattenResourceAccesses(accessesByCell),
    metrics,
    changedFiles: new Set(changedFiles.map(normalizePath)),
  };
}

function addGovernanceSubjectFile(
  subjectFiles: Map<string, SubjectSnapshotInputFile>,
  rootDir: string,
  relativePath: string,
  role: SubjectSnapshotInputFile["role"],
): void {
  const normalizedPath = normalizePath(relativePath);
  if (subjectFiles.has(normalizedPath)) return;
  const absoluteFilePath = absolutePath(rootDir, normalizedPath);
  if (!fs.existsSync(absoluteFilePath) || !fs.statSync(absoluteFilePath).isFile()) return;
  subjectFiles.set(normalizedPath, {
    path: normalizedPath,
    content: fs.readFileSync(absoluteFilePath, "utf8"),
    role,
  });
}

function governanceSubjectFiles(
  context: AnalysisContext,
  manifestPath: string,
  baselinePath: string | undefined,
  evidencePaths: string[],
): SubjectSnapshotInputFile[] {
  const subjectFiles = new Map<string, SubjectSnapshotInputFile>();
  addGovernanceSubjectFile(subjectFiles, context.rootDir, repoPath(context.rootDir, manifestPath), "manifest");
  if (baselinePath) addGovernanceSubjectFile(subjectFiles, context.rootDir, repoPath(context.rootDir, baselinePath), "baseline");
  const tsconfigPath = path.join(context.rootDir, "tsconfig.json");
  addGovernanceSubjectFile(subjectFiles, context.rootDir, repoPath(context.rootDir, tsconfigPath), "config");
  for (const evidencePath of evidencePaths) addGovernanceSubjectFile(subjectFiles, context.rootDir, repoPath(context.rootDir, evidencePath), "runtime-evidence");
  for (const cell of context.manifest.cells) {
    for (const sourceFilePath of sourceFilesForCell(context.rootDir, cell, context)) {
      addGovernanceSubjectFile(subjectFiles, context.rootDir, repoPath(context.rootDir, sourceFilePath), "source");
    }
  }
  for (const governedFilePath of sourceFilesUnderGovernance(context.rootDir, context.manifest, context)) {
    addGovernanceSubjectFile(subjectFiles, context.rootDir, repoPath(context.rootDir, governedFilePath), "source");
  }
  return [...subjectFiles.values()].sort((left, right) => left.path.localeCompare(right.path));
}

function requiredGovernanceFamilies(baselinePath: string | undefined): ObservationFamily[] {
  const families: ObservationFamily[] = ["manifest", "ownership", "public-surface", "imports", "resources"];
  if (baselinePath) families.push("baseline");
  return families;
}

function governanceEvidenceForCheck(
  context: AnalysisContext,
  manifestPath: string,
  baselinePath: string | undefined,
  evidencePaths: string[],
  observedImports: PluginImportReference[],
  accessesByCell: Map<string, ResourceAccessReference[]>,
): ReturnType<typeof assessEvidence> {
  const snapshot = createSubjectSnapshotFromFiles(governanceSubjectFiles(context, manifestPath, baselinePath, evidencePaths));
  const statuses: FileObservation[] = snapshot.files.flatMap((file): FileObservation[] => {
    if (file.role === "manifest") {
      return [
        { filePath: file.path, family: "manifest" as const, status: "processed" as const },
        { filePath: file.path, family: "ownership" as const, status: "processed" as const },
      ];
    }
    if (file.role === "baseline") return [{ filePath: file.path, family: "baseline" as const, status: "processed" as const }];
    if (file.role === "runtime-evidence") return [{ filePath: file.path, family: "resources" as const, status: "processed" as const }];
    if (file.role === "source") {
      return [
        { filePath: file.path, family: "imports" as const, status: "processed" as const },
        { filePath: file.path, family: "public-surface" as const, status: "processed" as const },
        { filePath: file.path, family: "resources" as const, status: "processed" as const },
      ];
    }
    return [{ filePath: file.path, family: "imports" as const, status: "not-applicable" as const }];
  });
  const resourceObservationCount = [...accessesByCell.values()].reduce(
    (count, accesses) => count + accesses.length,
    0,
  );
  const report = createRawObservationReport({
    observer: "cellfence-engine",
    snapshot,
    statuses,
    importObservationCount: observedImports.length,
    resourceObservationCount,
    publicSurfaceObservationCount: context.manifest.cells.length,
  });
  return assessEvidence(snapshot, report, { requiredFamilies: requiredGovernanceFamilies(baselinePath) });
}

function qualifiedExpressionName(node: ts.Node): string | undefined {
  if (ts.isIdentifier(node)) return node.text;
  if (ts.isPropertyAccessExpression(node)) {
    const root = qualifiedExpressionName(node.expression);
    return root ? `${root}.${node.name.text}` : node.name.text;
  }
  if (ts.isCallExpression(node)) return qualifiedExpressionName(node.expression);
  return undefined;
}

function adapterHelpers(sourceFile: ts.SourceFile): PluginAdapterHelpers {
  return {
    getQualifiedCallName(node: ts.Node): string | undefined {
      if (ts.isCallExpression(node)) return qualifiedExpressionName(node.expression);
      return qualifiedExpressionName(node);
    },
    getStaticStringArgument(node: ts.CallExpression, index: number): string | undefined {
      return literalText(node.arguments[index]);
    },
    lineOf(node: ts.Node): number {
      return getLineNumber(sourceFile, node);
    },
  };
}

function pluginAccessToInternal(access: PluginResourceAccess): ResourceAccessReference {
  return {
    kind: access.kind,
    access: access.access,
    selector: access.selector,
    filePath: normalizePath(access.filePath),
    line: access.line,
    source: access.source,
    detectedBy: access.detectedBy,
    confidence: access.confidence,
    unresolved: access.unresolved,
    reason: access.reason,
  };
}

function validatePluginApiVersion(plugin: PluginDefinition, findings: Finding[]): boolean {
  if (plugin.apiVersion === 1) return true;
  addFinding(findings, {
    ruleId: "CELLFENCE_PLUGIN_INVALID",
    severity: "error",
    message: `plugin ${plugin.name || "(unnamed)"} requires unsupported CellFence plugin API version ${String(plugin.apiVersion)}`,
    details: { plugin: plugin.name, apiVersion: plugin.apiVersion, supportedApiVersion: 1 },
  });
  return false;
}

function runPluginAdapters(
  context: AnalysisContext,
  plugins: PluginDefinition[],
  repository: PluginRepositoryModel,
  findings: Finding[],
): Map<string, ResourceAccessReference[]> {
  const accessesByCell = new Map<string, ResourceAccessReference[]>();
  for (const plugin of plugins) {
    if (!validatePluginApiVersion(plugin, findings)) continue;
    for (const adapter of plugin.adapters || []) {
      for (const cell of context.manifest.cells) {
        for (const sourceFilePath of sourceFilesForCell(context.rootDir, cell, context)) {
          const relativeFilePath = repoPath(context.rootDir, sourceFilePath);
          const sourceText = repository.files.contents[relativeFilePath] as string;
          const sourceFile = ts.createSourceFile(sourceFilePath, sourceText, ts.ScriptTarget.Latest, true, sourceKindForPath(sourceFilePath));
          let accesses: PluginResourceAccess[];
          try {
            accesses = adapter.detect({
              repository,
              cell,
              filePath: relativeFilePath,
              sourceText,
              sourceFile,
              helpers: adapterHelpers(sourceFile),
            });
          } catch (error) {
            addFinding(findings, {
              ruleId: "CELLFENCE_PLUGIN_INVALID",
              severity: "error",
              cellId: cell.id,
              filePath: relativeFilePath,
              message: `plugin adapter ${plugin.name}/${adapter.name} failed: ${errorMessage(error)}`,
              details: { plugin: plugin.name, adapter: adapter.name },
            });
            continue;
          }
          for (const access of accesses) {
            const cellId = access.cellId || cell.id;
            if (!context.cellsById.has(cellId)) {
              addFinding(findings, {
                ruleId: "CELLFENCE_PLUGIN_INVALID",
                severity: "error",
                cellId: cell.id,
                filePath: relativeFilePath,
                message: `plugin adapter ${plugin.name}/${adapter.name} emitted access for unknown cell ${cellId}`,
                details: { plugin: plugin.name, adapter: adapter.name, cellId },
              });
              continue;
            }
            addAccessToCell(accessesByCell, cellId, pluginAccessToInternal({
              ...access,
              filePath: access.filePath || relativeFilePath,
              line: access.line || 1,
              source: access.source || adapter.name,
              detectedBy: access.detectedBy || adapter.name,
            }));
          }
        }
      }
    }
  }
  return accessesByCell;
}

function validatePluginResourceAccesses(
  context: AnalysisContext,
  findings: Finding[],
  warnings: Finding[],
  baseline: CellFenceBaseline | undefined,
  accessesByCell: Map<string, ResourceAccessReference[]>,
): Map<string, ResourceAccessReference[]> {
  const acceptedAccessesByCell = new Map<string, ResourceAccessReference[]>();
  for (const [cellId, accesses] of accessesByCell.entries()) {
    const cell = context.cellsById.get(cellId) as CellManifest;
    for (const access of accesses) {
      if (access.unresolved) {
        if (resourceAccessDeclaredByManifest(cell, access) || resourceAccessDeclaredByBaseline(cell, baseline, access)) {
          addAccessToCell(acceptedAccessesByCell, cellId, access);
          continue;
        }
        const severity: Severity = access.kind === "file" ? "warning" : "error";
        addFinding(severity === "warning" ? warnings : findings, {
          ruleId: "CELLFENCE_UNRESOLVED_RESOURCE_ACCESS",
          severity,
          cellId,
          filePath: access.filePath,
          message: `${cellId} has unresolved ${access.kind} resource access at line ${access.line}: ${access.reason || "resource access is not statically resolvable"}`,
          details: {
            kind: access.kind,
            access: access.access,
            selector: access.selector,
            line: access.line,
            source: access.source,
            detectedBy: access.detectedBy,
            confidence: access.confidence,
            reason: access.reason,
          },
        });
        continue;
      }

      addAccessToCell(acceptedAccessesByCell, cellId, access);
      if (resourceAccessDeclaredByManifest(cell, access) || resourceAccessDeclaredByBaseline(cell, baseline, access)) continue;
      addFinding(findings, {
        ruleId: "CELLFENCE_UNDECLARED_RESOURCE_ACCESS",
        severity: "error",
        cellId,
        filePath: access.filePath,
        message: `${cellId} ${resourceAccessVerb(access.access)} undeclared ${access.kind} resource ${access.selector}`,
        details: {
          kind: access.kind,
          access: access.access,
          selector: access.selector,
          line: access.line,
          source: access.source,
          detectedBy: access.detectedBy,
          confidence: access.confidence,
        },
        suggestedResolutions: [
          codeResolution(`Remove or route this ${access.kind} access through an allowed owner`, {
            kind: access.kind,
            access: access.access,
            selector: access.selector,
          }),
          manifestResolution(`Declare ${access.kind} ${access.access} access for ${access.selector}`, Boolean(cell.locked), {
            cell: cell.id,
            resourceContract: {
              kind: access.kind,
              access: [access.access],
              selectors: [access.selector],
            },
          }),
        ],
      });
    }
  }
  return acceptedAccessesByCell;
}

function runPluginRules(
  context: AnalysisContext,
  plugins: PluginDefinition[],
  repository: PluginRepositoryModel,
  findings: Finding[],
): void {
  for (const plugin of plugins) {
    if (!validatePluginApiVersion(plugin, findings)) continue;
    for (const [ruleId, rule] of Object.entries(plugin.rules || {})) {
      const emittedFindings: Finding[] = [];
      const ruleContext: PluginRuleContext = {
        repository,
        cells: context.manifest.cells,
        report(finding: PluginFinding): void {
          emittedFindings.push({ ...finding, ruleId: finding.ruleId || ruleId });
        },
      };
      try {
        const returnedFindings = rule.run(ruleContext) || [];
        for (const finding of returnedFindings) emittedFindings.push({ ...finding, ruleId: finding.ruleId || ruleId });
      } catch (error) {
        addFinding(findings, {
          ruleId: "CELLFENCE_PLUGIN_INVALID",
          severity: "error",
          message: `plugin rule ${plugin.name}/${ruleId} failed: ${errorMessage(error)}`,
          details: { plugin: plugin.name, ruleId },
        });
        continue;
      }
      for (const finding of emittedFindings) addFinding(findings, finding);
    }
  }
}

function findArtifactLaneForPath(cell: CellManifest, relativePath: string): string | undefined {
  for (const lane of cell.producesArtifacts ?? []) {
    if (lane.paths.some((pattern) => matchesPattern(relativePath, pattern))) return lane.id;
  }
  return undefined;
}

function parentPrefix(relativePath: string): string {
  const normalized = normalizePath(relativePath);
  const parent = path.dirname(normalized);
  return parent === "." ? "" : parent;
}

function addPythonRoot(roots: Set<string>, root: string | undefined): void {
  if (!root) return;
  const normalized = normalizePath(root).replace(/\/+$/, "");
  if (normalized === "." || normalized === "") roots.add("");
  else roots.add(normalized);
}

function pythonSourceRootsFromPyproject(rootDir: string): string[] {
  const pyprojectPath = path.join(rootDir, "pyproject.toml");
  if (!fs.existsSync(pyprojectPath)) return [];
  const text = fs.readFileSync(pyprojectPath, "utf8");
  const roots = new Set<string>();
  for (const match of text.matchAll(/(?:package-dir|package_dir)\s*=\s*\{[^}]*["']{0,1}["']{0,1}\s*=\s*["']([^"']+)["'][^}]*\}/g)) {
    addPythonRoot(roots, match[1]);
  }
  for (const match of text.matchAll(/\bfrom\s*=\s*["']([^"']+)["']/g)) {
    addPythonRoot(roots, match[1]);
  }
  return [...roots];
}

function pythonSourceRootsFromSetupCfg(rootDir: string): string[] {
  const setupCfgPath = path.join(rootDir, "setup.cfg");
  if (!fs.existsSync(setupCfgPath)) return [];
  const text = fs.readFileSync(setupCfgPath, "utf8");
  const roots = new Set<string>();
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    if (!/^\s*package_dir\s*=\s*$/.test(lines[index])) continue;
    for (let blockIndex = index + 1; blockIndex < lines.length; blockIndex += 1) {
      const line = lines[blockIndex];
      if (line.trim().length === 0) continue;
      if (/^\S/.test(line)) break;
      const match = line.match(/^\s*=\s*([^\s#]+)\s*$/);
      if (match) addPythonRoot(roots, match[1]);
    }
  }
  return [...roots];
}

function pythonSourceRoots(context: AnalysisContext): string[] {
  const roots = new Set<string>(["", "src"]);
  for (const root of pythonSourceRootsFromPyproject(context.rootDir)) addPythonRoot(roots, root);
  for (const root of pythonSourceRootsFromSetupCfg(context.rootDir)) addPythonRoot(roots, root);
  for (const cell of context.manifest.cells) {
    if (path.extname(cell.publicEntry) === ".py") {
      const parent = parentPrefix(cell.publicEntry);
      const packageRoot = parentPrefix(parent);
      roots.add(packageRoot);
    }
    for (const pattern of cell.ownedPaths) {
      const prefix = literalPrefix(pattern);
      if (!prefix) continue;
      roots.add(parentPrefix(prefix));
    }
  }
  return [...roots].sort((left, right) => left.localeCompare(right));
}

function resolveImport(context: AnalysisContext, reference: ImportReference): ResolvedImport {
  if (path.extname(reference.importerPath) === ".py") {
    const pythonTargetPath = resolvePythonImport(context.rootDir, reference.importerPath, reference.specifier, pythonSourceRoots(context));
    if (pythonTargetPath) {
      const targetCell = findOwningCell(context.manifest, pythonTargetPath);
      const artifactLaneId = targetCell ? findArtifactLaneForPath(targetCell, pythonTargetPath) : undefined;
      return { targetPath: pythonTargetPath, targetCell, artifactLaneId, isExternal: false, isPublicPackage: false };
    }
    if (reference.specifier.startsWith(".")) return { isExternal: false, isPublicPackage: false };
  }

  if (reference.specifier.startsWith(".") || reference.specifier.startsWith("/")) {
    const targetPath = resolveRelativeImport(context.rootDir, reference.importerPath, reference.specifier);
    if (!targetPath) return { isExternal: false, isPublicPackage: false };
    const targetCell = findOwningCell(context.manifest, targetPath);
    const artifactLaneId = targetCell ? findArtifactLaneForPath(targetCell, targetPath) : undefined;
    return { targetPath, targetCell, artifactLaneId, isExternal: false, isPublicPackage: false };
  }

  const aliasTargetPath = resolvePathAliasTarget(context, reference.specifier);
  if (aliasTargetPath) {
    const targetCell = findOwningCell(context.manifest, aliasTargetPath);
    const artifactLaneId = targetCell ? findArtifactLaneForPath(targetCell, aliasTargetPath) : undefined;
    return { targetPath: aliasTargetPath, targetCell, artifactLaneId, isExternal: false, isPublicPackage: false };
  }

  const exactPackageCell = context.packageToCell.get(reference.specifier);
  if (exactPackageCell) {
    return {
      targetPath: exactPackageCell.publicEntry,
      targetCell: exactPackageCell,
      isExternal: false,
      isPublicPackage: true,
    };
  }

  for (const [packageName, packageCell] of context.packageToCell.entries()) {
    const subpathPrefix = `${packageName}/`;
    if (!reference.specifier.startsWith(subpathPrefix)) continue;
    const packageRoot = context.packageRoots.get(packageName);
    const subpath = reference.specifier.slice(subpathPrefix.length);
    const targetPath = packageRoot ? normalizePath(path.join(packageRoot, subpath)) : undefined;
    return {
      targetPath,
      targetCell: packageCell,
      isExternal: false,
      isPublicPackage: false,
    };
  }

  return { isExternal: true, isPublicPackage: false };
}

function consumerDeclaration(cell: CellManifest, producerCellId: string): CellConsumerManifest | undefined {
  return (cell.consumes ?? []).find((consumer) => consumer.cell === producerCellId);
}

function importTargetsPrivateImplementation(resolvedImport: ResolvedImport, producerCell: CellManifest): boolean {
  const targetIsPublicEntry = normalizePath(resolvedImport.targetPath || "") === normalizePath(producerCell.publicEntry);
  if (targetIsPublicEntry) return false;
  return true;
}

function addPrivateImportFinding(
  findings: Finding[],
  importerCell: CellManifest,
  producerCell: CellManifest,
  reference: ImportReference,
  resolvedImport: ResolvedImport,
): void {
  addFinding(findings, {
    ruleId: "CELLFENCE_PRIVATE_IMPORT",
    severity: "error",
    cellId: importerCell.id,
    producerCellId: producerCell.id,
    filePath: reference.importerPath,
    message: `${importerCell.id} imports private implementation from ${producerCell.id}`,
    details: { specifier: reference.specifier, targetPath: resolvedImport.targetPath, line: reference.line },
    suggestedResolutions: [
      codeResolution(`Import from ${producerCell.publicEntry} instead of ${resolvedImport.targetPath || reference.specifier}`, {
        publicEntry: producerCell.publicEntry,
        packageName: producerCell.packageName,
      }),
      humanResolution(`Ask ${producerCell.id}'s owner to expose the needed symbol through its public entry`, {
        producerCell: producerCell.id,
        publicEntry: producerCell.publicEntry,
      }),
    ],
  });
}

function validatePublicEntries(context: AnalysisContext, findings: Finding[]): void {
  for (const cell of context.manifest.cells) {
    const publicEntryPath = absolutePath(context.rootDir, cell.publicEntry);
    if (!fs.existsSync(publicEntryPath)) {
      addFinding(findings, {
        ruleId: "CELLFENCE_PUBLIC_ENTRY_MISSING",
        severity: "error",
        cellId: cell.id,
        filePath: cell.publicEntry,
        message: `public entry for cell ${cell.id} is missing: ${cell.publicEntry}`,
      });
      continue;
    }
    const actualSymbols = extractPublicSymbols(publicEntryPath);
    const declaredSymbols = new Set(cell.publicSymbols);
    const missingSymbols = [...declaredSymbols].filter((symbol) => !actualSymbols.has(symbol));
    const undeclaredSymbols = [...actualSymbols].filter((symbol) => !declaredSymbols.has(symbol));
    if (missingSymbols.length > 0 || undeclaredSymbols.length > 0) {
      const mismatchParts = [];
      if (missingSymbols.length > 0) mismatchParts.push(`missing: ${missingSymbols.join(", ")}`);
      if (undeclaredSymbols.length > 0) mismatchParts.push(`undeclared: ${undeclaredSymbols.join(", ")}`);
      addFinding(findings, {
        ruleId: "CELLFENCE_PUBLIC_SYMBOL_MISMATCH",
        severity: "error",
        cellId: cell.id,
        filePath: cell.publicEntry,
        message: `public symbols for cell ${cell.id} do not match manifest (${mismatchParts.join("; ")})`,
        details: { missingSymbols, undeclaredSymbols },
        suggestedResolutions: [
          codeResolution("Change the public entry exports to match the manifest", {
            publicEntry: cell.publicEntry,
            expectedSymbols: cell.publicSymbols,
          }),
          manifestResolution("Update publicSymbols in the manifest to match the public entry", Boolean(cell.locked), {
            cell: cell.id,
            missingSymbols,
            undeclaredSymbols,
          }),
        ],
      });
    }
  }
}

function validateImports(
  context: AnalysisContext,
  findings: Finding[],
  warnings: Finding[],
  observedImports: PluginImportReference[] = [],
): Map<string, Set<string>> {
  const crossCellDependencies = new Map<string, Set<string>>();
  for (const importerCell of context.manifest.cells) {
    for (const sourceFilePath of sourceFilesForCell(context.rootDir, importerCell, context)) {
      const references = extractImports(context, sourceFilePath, warnings);
      for (const reference of references) {
        const resolvedImport = resolveImport(context, reference);
        observedImports.push({
          importerPath: reference.importerPath,
          importerCellId: importerCell.id,
          specifier: reference.specifier,
          kind: reference.kind,
          typeOnly: reference.typeOnly,
          line: reference.line,
          targetPath: resolvedImport.targetPath ? normalizePath(resolvedImport.targetPath) : undefined,
          targetCellId: resolvedImport.targetCell?.id,
          artifactLaneId: resolvedImport.artifactLaneId,
          isExternal: resolvedImport.isExternal,
          isPublicPackage: resolvedImport.isPublicPackage,
        });
        if (!resolvedImport.targetPath && !resolvedImport.isExternal && (reference.specifier.startsWith(".") || reference.specifier.startsWith("/"))) {
          addFinding(findings, {
            ruleId: "CELLFENCE_UNRESOLVED_IMPORT",
            severity: "error",
            filePath: reference.importerPath,
            message: `relative import ${reference.specifier} could not be resolved statically at line ${reference.line}`,
            details: { line: reference.line, specifier: reference.specifier },
            suggestedResolutions: [
              codeResolution("Fix the import specifier so CellFence can resolve the target file", {
                specifier: reference.specifier,
              }),
              humanResolution("Ask for a resolver adapter if this import uses unsupported project-specific resolution", {
                specifier: reference.specifier,
              }),
            ],
          });
        }
        if (
          resolvedImport.targetPath
          && !resolvedImport.targetCell
          && pathIsGoverned(context.manifest, resolvedImport.targetPath)
        ) {
          addFinding(findings, {
            ruleId: "CELLFENCE_UNOWNED_IMPORT_TARGET",
            severity: "error",
            cellId: importerCell.id,
            filePath: reference.importerPath,
            message: `${importerCell.id} imports governed but unowned source ${resolvedImport.targetPath}`,
            details: { specifier: reference.specifier, targetPath: resolvedImport.targetPath, line: reference.line },
            suggestedResolutions: [
              codeResolution("Move the helper into an owned cell and import through that cell's public entry", {
                specifier: reference.specifier,
                targetPath: resolvedImport.targetPath,
              }),
              manifestResolution("Assign the target path to exactly one cell if it is intentional source", true, {
                targetPath: resolvedImport.targetPath,
              }),
            ],
          });
          continue;
        }
        if (resolvedImport.isExternal || !resolvedImport.targetCell || resolvedImport.targetCell.id === importerCell.id) continue;
        const producerCell = resolvedImport.targetCell;
        const declaration = consumerDeclaration(importerCell, producerCell.id);
        const dependencySet = crossCellDependencies.get(importerCell.id) || new Set<string>();
        dependencySet.add(producerCell.id);
        crossCellDependencies.set(importerCell.id, dependencySet);

        if (!declaration) {
          addFinding(findings, {
            ruleId: "CELLFENCE_UNDECLARED_CONSUMER",
            severity: "error",
            cellId: importerCell.id,
            producerCellId: producerCell.id,
            filePath: reference.importerPath,
            message: `${importerCell.id} imports ${producerCell.id} without declaring a consumer relationship`,
            details: { specifier: reference.specifier, line: reference.line, kind: reference.kind, typeOnly: reference.typeOnly },
            suggestedResolutions: [
              codeResolution(`Remove the ${producerCell.id} import or move the code behind an existing allowed cell`, {
                specifier: reference.specifier,
              }),
              manifestResolution(`Declare ${importerCell.id} as a consumer of ${producerCell.id}`, Boolean(importerCell.locked), {
                cell: importerCell.id,
                consumes: { cell: producerCell.id },
              }),
            ],
          });
        }

        if (resolvedImport.artifactLaneId) {
          if (
            resolvedImport.targetPath
            && SOURCE_EXTENSIONS.includes(path.extname(resolvedImport.targetPath))
            && importTargetsPrivateImplementation(resolvedImport, producerCell)
          ) {
            addPrivateImportFinding(findings, importerCell, producerCell, reference, resolvedImport);
          }
          const declaredArtifactLanes = new Set(declaration?.artifactLanes || []);
          if (!declaredArtifactLanes.has(resolvedImport.artifactLaneId)) {
            addFinding(findings, {
              ruleId: "CELLFENCE_UNDECLARED_ARTIFACT",
              severity: "error",
              cellId: importerCell.id,
              producerCellId: producerCell.id,
              filePath: reference.importerPath,
              message: `${importerCell.id} imports artifact lane ${resolvedImport.artifactLaneId} from ${producerCell.id} without declaring it`,
              details: { specifier: reference.specifier, artifactLaneId: resolvedImport.artifactLaneId, line: reference.line },
              suggestedResolutions: [
                codeResolution("Stop importing the artifact lane directly if this is not an intended artifact dependency", {
                  specifier: reference.specifier,
                }),
                manifestResolution(`Declare artifact lane ${resolvedImport.artifactLaneId} on the consumer relationship`, Boolean(importerCell.locked), {
                  cell: importerCell.id,
                  consumes: { cell: producerCell.id, artifactLanes: [resolvedImport.artifactLaneId] },
                }),
              ],
            });
          }
          continue;
        }

        if (importTargetsPrivateImplementation(resolvedImport, producerCell)) {
          addPrivateImportFinding(findings, importerCell, producerCell, reference, resolvedImport);
        }
      }
    }
  }
  return crossCellDependencies;
}

function countLines(filePath: string): number {
  if (!fs.existsSync(filePath)) return 0;
  const content = fs.readFileSync(filePath, "utf8");
  if (content.length === 0) return 0;
  return content.split(/\r?\n/).length;
}

function artifactContractsForCell(cell: CellManifest): string[] {
  const contracts: string[] = [];
  for (const lane of cell.producesArtifacts || []) {
    for (const artifactPath of lane.paths) contracts.push(`produce:${lane.id}:${normalizePath(artifactPath)}`);
  }
  for (const consumer of cell.consumes || []) {
    for (const lane of consumer.artifactLanes || []) contracts.push(`consume:${consumer.cell}:${lane}`);
  }
  return contracts.sort((left, right) => left.localeCompare(right));
}

function dependencyEdgesForCell(cellId: string, dependencies: Set<string> | undefined): string[] {
  return [...(dependencies || new Set<string>())]
    .map((dependency) => `${cellId}->${dependency}`)
    .sort((left, right) => left.localeCompare(right));
}

function computeMetrics(
  context: AnalysisContext,
  crossCellDependencies: Map<string, Set<string>>,
  accessesByCell: Map<string, ResourceAccessReference[]>,
): Record<string, CellBaselineRecord> {
  const metrics: Record<string, CellBaselineRecord> = {};
  for (const cell of context.manifest.cells) {
    const publicEntryPath = absolutePath(context.rootDir, cell.publicEntry);
    metrics[cell.id] = {
      ownedPathPatterns: cell.ownedPaths.length,
      publicSymbols: cell.publicSymbols.length,
      publicSurfaceLines: countLines(absolutePath(context.rootDir, cell.publicEntry)),
      crossCellDependencies: crossCellDependencies.get(cell.id)?.size || 0,
      ownedPathSet: [...cell.ownedPaths].map(normalizePath).sort((left, right) => left.localeCompare(right)),
      publicEntryPath: normalizePath(cell.publicEntry),
      publicSymbolSet: [...cell.publicSymbols].sort((left, right) => left.localeCompare(right)),
      publicSurfaceHash: publicSurfaceHash(publicEntryPath),
      dependencyEdges: dependencyEdgesForCell(cell.id, crossCellDependencies.get(cell.id)),
      artifactContracts: artifactContractsForCell(cell),
      resourceAccesses: sortedResourceBaselineEntries(accessesByCell.get(cell.id) as ResourceAccessReference[]),
    };
  }
  return metrics;
}

function compareBaseline(
  context: AnalysisContext,
  metrics: Record<string, CellBaselineRecord>,
  baseline: CellFenceBaseline,
  findings: Finding[],
): void {
  const baselineCellIds = new Set(baseline.cellIds || Object.keys(baseline.cells));
  for (const [cellId, metric] of Object.entries(metrics)) {
    const locked = Boolean(context.cellsById.get(cellId)?.locked);
    const baselineRecord = baseline.cells[cellId];
    if (!baselineRecord || !baselineCellIds.has(cellId)) {
      addFinding(findings, {
        ruleId: "CELLFENCE_RATCHET_CELL_SET_GROWTH",
        severity: "error",
        cellId,
        message: `${cellId} is not present in the accepted baseline cell set`,
        suggestedResolutions: [
          codeResolution("Move the new source under an existing accepted cell if this is not an intentional architecture addition"),
          baselineResolution("Accept the new cell in the baseline", locked, { cell: cellId }),
        ],
      });
      continue;
    }

    if (baselineRecord.publicEntryPath && metric.publicEntryPath !== baselineRecord.publicEntryPath) {
      addFinding(findings, {
        ruleId: "CELLFENCE_RATCHET_PUBLIC_ENTRY_CHANGE",
        severity: "error",
        cellId,
        message: `${cellId} public entry changed from ${baselineRecord.publicEntryPath} to ${metric.publicEntryPath}`,
        suggestedResolutions: [
          codeResolution("Keep the existing public entry path and move implementation detail behind it"),
          baselineResolution("Accept the public entry contract change in the baseline", locked, { cell: cellId, previous: baselineRecord.publicEntryPath, current: metric.publicEntryPath }),
        ],
      });
    }

    if (baselineRecord.ownedPathSet) {
      const uncovered = (metric.ownedPathSet as string[]).filter((currentPattern) => !patternCoveredByOwnedPaths(currentPattern, baselineRecord.ownedPathSet as string[]));
      if (uncovered.length > 0) {
        addFinding(findings, {
          ruleId: "CELLFENCE_RATCHET_OWNERSHIP_SCOPE_CHANGE",
          severity: "error",
          cellId,
          message: `${cellId} ownership scope expanded or shifted outside the accepted baseline: ${uncovered.join(", ")}`,
          details: { previous: baselineRecord.ownedPathSet, current: metric.ownedPathSet, uncovered },
          suggestedResolutions: [
            codeResolution("Keep new source inside an existing accepted ownership scope or create a reviewed cell change"),
            baselineResolution("Accept the ownership scope change in the baseline", locked, { cell: cellId, uncovered }),
          ],
        });
      }
    }

    if (baselineRecord.publicSymbolSet) {
      const previousSymbols = new Set(baselineRecord.publicSymbolSet);
      const addedSymbols = (metric.publicSymbolSet as string[]).filter((symbol) => !previousSymbols.has(symbol));
      if (addedSymbols.length > 0) {
        addFinding(findings, {
          ruleId: "CELLFENCE_RATCHET_PUBLIC_SYMBOL_SET_CHANGE",
          severity: "error",
          cellId,
          message: `${cellId} added public symbols outside the accepted baseline: ${addedSymbols.join(", ")}`,
          details: { previous: baselineRecord.publicSymbolSet, current: metric.publicSymbolSet, addedSymbols },
          suggestedResolutions: [
            codeResolution("Keep the new API internal or route through an existing public symbol"),
            baselineResolution("Accept the public symbol set change in the baseline", locked, { cell: cellId, addedSymbols }),
          ],
        });
      }
    }

    if (baselineRecord.dependencyEdges) {
      const previousEdges = new Set(baselineRecord.dependencyEdges);
      const addedEdges = (metric.dependencyEdges as string[]).filter((edge) => !previousEdges.has(edge));
      if (addedEdges.length > 0) {
        addFinding(findings, {
          ruleId: "CELLFENCE_RATCHET_DEPENDENCY_EDGE_CHANGE",
          severity: "error",
          cellId,
          message: `${cellId} added dependency edges outside the accepted baseline: ${addedEdges.join(", ")}`,
          details: { previous: baselineRecord.dependencyEdges, current: metric.dependencyEdges, addedEdges },
          suggestedResolutions: [
            codeResolution("Remove the new dependency edge or depend on an existing accepted cell"),
            baselineResolution("Accept the dependency edge change in the baseline", locked, { cell: cellId, addedEdges }),
          ],
        });
      }
    }

    if (baselineRecord.artifactContracts) {
      const previousArtifacts = new Set(baselineRecord.artifactContracts);
      const addedArtifacts = (metric.artifactContracts as string[]).filter((artifact) => !previousArtifacts.has(artifact));
      if (addedArtifacts.length > 0) {
        addFinding(findings, {
          ruleId: "CELLFENCE_RATCHET_ARTIFACT_CONTRACT_CHANGE",
          severity: "error",
          cellId,
          message: `${cellId} added artifact contracts outside the accepted baseline: ${addedArtifacts.join(", ")}`,
          details: { previous: baselineRecord.artifactContracts, current: metric.artifactContracts, addedArtifacts },
          suggestedResolutions: [
            codeResolution("Avoid the new artifact lane or reuse an accepted artifact contract"),
            baselineResolution("Accept the artifact contract change in the baseline", locked, { cell: cellId, addedArtifacts }),
          ],
        });
      }
    }

    if (baselineRecord.publicSurfaceHash && metric.publicSurfaceHash !== baselineRecord.publicSurfaceHash) {
      addFinding(findings, {
        ruleId: "CELLFENCE_RATCHET_PUBLIC_SURFACE_SIGNATURE_CHANGE",
        severity: "error",
        cellId,
        message: `${cellId} public surface signature hash changed from the accepted baseline`,
        details: { previous: baselineRecord.publicSurfaceHash },
        suggestedResolutions: [
          codeResolution("Keep the public type/signature contract stable or move changes behind existing exports"),
          baselineResolution("Accept the public signature change in the baseline", locked, { cell: cellId }),
        ],
      });
    }

    if (metric.ownedPathPatterns > baselineRecord.ownedPathPatterns) {
      addFinding(findings, {
        ruleId: "CELLFENCE_RATCHET_OWNED_PATH_GROWTH",
        severity: "error",
        cellId,
        message: `${cellId} owned path patterns grew from ${baselineRecord.ownedPathPatterns} to ${metric.ownedPathPatterns}`,
        suggestedResolutions: [
          codeResolution("Move new files under existing owned path patterns or reduce the owned path expansion"),
          baselineResolution("Accept the owned path growth in the baseline", locked, { cell: cellId, metric: "ownedPathPatterns" }),
        ],
      });
    }
    if (metric.publicSymbols > baselineRecord.publicSymbols) {
      addFinding(findings, {
        ruleId: "CELLFENCE_RATCHET_PUBLIC_SYMBOL_GROWTH",
        severity: "error",
        cellId,
        message: `${cellId} public symbols grew from ${baselineRecord.publicSymbols} to ${metric.publicSymbols}`,
        suggestedResolutions: [
          codeResolution("Keep the new API internal or remove public exports that are not part of the intended contract"),
          baselineResolution("Accept the public symbol growth in the baseline", locked, { cell: cellId, metric: "publicSymbols" }),
        ],
      });
    }
    if (!baselineRecord.publicSurfaceHash && metric.publicSurfaceLines > baselineRecord.publicSurfaceLines) {
      addFinding(findings, {
        ruleId: "CELLFENCE_RATCHET_PUBLIC_SURFACE_LINE_GROWTH",
        severity: "error",
        cellId,
        message: `${cellId} public surface lines grew from ${baselineRecord.publicSurfaceLines} to ${metric.publicSurfaceLines}`,
        suggestedResolutions: [
          codeResolution("Move implementation detail out of the public entry or reduce public surface size"),
          baselineResolution("Accept the public surface growth in the baseline", locked, { cell: cellId, metric: "publicSurfaceLines" }),
        ],
      });
    }
    if (metric.crossCellDependencies > baselineRecord.crossCellDependencies) {
      addFinding(findings, {
        ruleId: "CELLFENCE_RATCHET_CROSS_CELL_DEPENDENCY_GROWTH",
        severity: "error",
        cellId,
        message: `${cellId} cross-cell dependencies grew from ${baselineRecord.crossCellDependencies} to ${metric.crossCellDependencies}`,
        suggestedResolutions: [
          codeResolution("Remove the new cross-cell dependency or route it through an existing allowed dependency"),
          baselineResolution("Accept the cross-cell dependency growth in the baseline", locked, { cell: cellId, metric: "crossCellDependencies" }),
        ],
      });
    }
  }
}

function manifestInvalidResult(message: string): CheckResult {
  const finding: Finding = {
    ruleId: "CELLFENCE_MANIFEST_INVALID",
    severity: "error",
    message,
  };
  return { ok: false, exitCode: 2, findings: [finding], warnings: [], metrics: {} };
}

function configuredRuleSeverity(
  context: AnalysisContext,
  finding: Finding,
  cliRuleSeverities: Record<string, ConfiguredRuleSeverity> | undefined,
): ConfiguredRuleSeverity | undefined {
  let severity = context.manifest.rules?.[finding.ruleId];
  if (finding.cellId) {
    const cellSeverity = context.cellsById.get(finding.cellId)?.rules?.[finding.ruleId];
    if (cellSeverity) severity = cellSeverity;
  }
  const findingFilePath = finding.filePath;
  if (findingFilePath) {
    for (const override of context.manifest.overrides || []) {
      if (override.files.some((pattern) => matchesPattern(findingFilePath, pattern))) {
        const overrideSeverity = override.rules[finding.ruleId];
        if (overrideSeverity) severity = overrideSeverity;
      }
    }
  }
  return cliRuleSeverities?.[finding.ruleId] || severity;
}

function ruleIsRequired(context: AnalysisContext, ruleId: string): boolean {
  return requiredRuleSet(context).has(ruleId);
}

function requiredRuleSet(context: AnalysisContext): Set<string> {
  return new Set([...CORE_REQUIRED_RULES, ...(context.manifest.governance?.requiredRules || [])]);
}

function validateRequiredRuleConfiguration(
  context: AnalysisContext,
  cliRuleSeverities: Record<string, ConfiguredRuleSeverity> | undefined,
  findings: Finding[],
): void {
  const requiredRules = requiredRuleSet(context);
  if (requiredRules.size === 0) return;
  const checkMap = (source: string, rules: Record<string, ConfiguredRuleSeverity> | undefined, filePath?: string, cellId?: string): void => {
    for (const [ruleId, severity] of Object.entries(rules || {})) {
      if (!requiredRules.has(ruleId) || severity === "error") continue;
      addFinding(findings, {
        ruleId: "CELLFENCE_REQUIRED_RULE_DISABLED",
        severity: "error",
        cellId,
        filePath,
        message: `${source} weakens required rule ${ruleId} to ${severity}`,
        details: { source, ruleId, severity },
      });
    }
  };
  checkMap("repository rules", context.manifest.rules);
  for (const cell of context.manifest.cells) checkMap(`cell ${cell.id} rules`, cell.rules, cell.publicEntry, cell.id);
  for (const [overrideIndex, override] of (context.manifest.overrides || []).entries()) {
    checkMap(`override ${overrideIndex}`, override.rules, override.files.join(","));
  }
  checkMap("CLI ruleSeverities", cliRuleSeverities);
}

function applyRuleSeverityPolicy(
  context: AnalysisContext,
  findings: Finding[],
  warnings: Finding[],
  cliRuleSeverities: Record<string, ConfiguredRuleSeverity> | undefined,
): { findings: Finding[]; warnings: Finding[] } {
  const nextFindings: Finding[] = [];
  const nextWarnings: Finding[] = [];
  for (const finding of [...findings, ...warnings]) {
    const configuredSeverity = configuredRuleSeverity(context, finding, cliRuleSeverities);
    if (configuredSeverity === "off") {
      if (ruleIsRequired(context, finding.ruleId)) {
        nextFindings.push({
          ruleId: "CELLFENCE_REQUIRED_RULE_DISABLED",
          severity: "error",
          cellId: finding.cellId,
          filePath: finding.filePath,
          message: `required rule ${finding.ruleId} cannot be disabled`,
          details: { ruleId: finding.ruleId },
        });
        nextFindings.push(finding);
      }
      continue;
    }
    const severity = ruleIsRequired(context, finding.ruleId) ? "error" : configuredSeverity || finding.severity;
    const normalizedFinding: Finding = withFindingFingerprint({ ...finding, severity, fingerprint: undefined });
    if (severity === "warning") nextWarnings.push(normalizedFinding);
    else nextFindings.push(normalizedFinding);
  }
  return { findings: nextFindings, warnings: nextWarnings };
}

export function loadManifestFromFile(manifestPath: string): CellFenceManifest {
  const validation = validateManifest(readJsonFile(manifestPath));
  if (!validation.ok || !validation.value) {
    throw new Error(validation.errors.join("; "));
  }
  return validation.value;
}

export function checkRepository(options: CheckOptions = {}): CheckResult {
  const rootDir = path.resolve(options.rootDir || process.cwd());
  const manifestPath = path.resolve(rootDir, options.manifestPath || DEFAULT_MANIFEST_PATH);
  const baselinePath = options.baselinePath ? path.resolve(rootDir, options.baselinePath) : undefined;

  let rawManifest: unknown;
  try {
    rawManifest = readJsonFile(manifestPath);
  } catch (error) {
    return manifestInvalidResult(`failed to read manifest ${repoPath(rootDir, manifestPath)}: ${errorMessage(error)}`);
  }

  const manifestValidation = validateManifest(rawManifest);
  if (!manifestValidation.ok || !manifestValidation.value) {
    return manifestInvalidResult(manifestValidation.errors.join("; "));
  }

  const findings: Finding[] = [];
  const warnings: Finding[] = [];
  const manifest = manifestValidation.value;
  const context = createContext(rootDir, manifest);
  const plugins = options.plugins || [];
  let baseline: CellFenceBaseline | undefined;

  if (baselinePath) {
    try {
      const baselineValidation = validateBaseline(readJsonFile(baselinePath));
      if (!baselineValidation.ok || !baselineValidation.value) {
        addFinding(findings, {
          ruleId: "CELLFENCE_MANIFEST_INVALID",
          severity: "error",
          message: `baseline is invalid: ${baselineValidation.errors.join("; ")}`,
        });
      } else {
        baseline = baselineValidation.value;
        validateBaselineSeal(manifest, baseline, repoPath(rootDir, baselinePath), findings);
      }
    } catch (error) {
      addFinding(findings, {
        ruleId: "CELLFENCE_MANIFEST_INVALID",
        severity: "error",
        message: `failed to read baseline ${repoPath(rootDir, baselinePath)}: ${errorMessage(error)}`,
      });
    }
  }

  validateDuplicateCellIds(manifest, findings);
  validateOwnershipOverlap(manifest, findings);
  warnWhenOwnershipCoverageDisabled(context, warnings);
  validateOwnershipCoverage(context, findings);
  validateSymlinkTargets(context, findings);
  validatePublicEntries(context, findings);
  validateRequiredRuleConfiguration(context, options.ruleSeverities, findings);
  const observedImports: PluginImportReference[] = [];
  const crossCellDependencies = validateImports(context, findings, warnings, observedImports);
  for (const finding of validatePathClassImports({
    pathClasses: manifest.governance?.pathClasses,
    imports: observedImports.map((reference) => ({
      importerPath: reference.importerPath,
      targetPath: reference.targetPath,
      importerCellId: reference.importerCellId,
    })),
  })) {
    addFinding(findings, finding);
  }
  for (const finding of validateChangedPathClasses({
    pathClasses: manifest.governance?.pathClasses,
    changedFiles: options.changedFiles,
  })) {
    addFinding(finding.severity === "error" ? findings : warnings, finding);
  }
  const accessesByCell = validateResourceAccesses(context, findings, warnings, baseline);
  mergeAccessesByCell(
    accessesByCell,
    resourceEvidenceAccesses(context, evidencePathsForOptions(rootDir, options.evidencePaths), findings, baseline),
  );
  const prePluginMetrics = computeMetrics(context, crossCellDependencies, accessesByCell);
  const pluginRepositoryModel = createRepositoryModel(
    context,
    baseline,
    observedImports,
    accessesByCell,
    prePluginMetrics,
    options.changedFiles,
  );
  mergeAccessesByCell(
    accessesByCell,
    validatePluginResourceAccesses(
      context,
      findings,
      warnings,
      baseline,
      runPluginAdapters(context, plugins, pluginRepositoryModel, findings),
    ),
  );
  const metrics = computeMetrics(context, crossCellDependencies, accessesByCell);
  const repositoryModel = createRepositoryModel(context, baseline, observedImports, accessesByCell, metrics, options.changedFiles);

  if (baseline) {
    compareBaseline(context, metrics, baseline, findings);
  }

  runPluginRules(context, plugins, repositoryModel, findings);

  const severityAdjusted = applyRuleSeverityPolicy(context, findings, warnings, options.ruleSeverities);
  const active = applyWaiversToFindings(context, severityAdjusted.findings, severityAdjusted.warnings);
  const evidence = governanceEvidenceForCheck(
    context,
    manifestPath,
    baselinePath,
    evidencePathsForOptions(rootDir, options.evidencePaths),
    observedImports,
    accessesByCell,
  );
  const evaluation = evaluateGovernance({
    evidence,
    findings: active.findings,
    warnings: active.warnings,
    metrics,
    requiredRules: [...requiredRuleSet(context)].sort((left, right) => left.localeCompare(right)),
  });
  const decision = legacyDecisionFromEvaluation(evaluation);
  return {
    ok: decision.ok,
    exitCode: decision.exitCode,
    findings: decision.findings,
    warnings: decision.warnings,
    metrics: decision.metrics,
  };
}

function addPruneCandidate(candidates: PruneCandidate[], candidate: PruneCandidate): void {
  candidates.push(candidate);
}

/* c8 ignore start -- Public-symbol import shape handling is covered through createPruneReport black-box fixtures; V8 exposes each TypeScript AST guard as separate low-value branches. */
function importClausePublicSymbols(importClause: ts.ImportClause | undefined, producerSymbols: Set<string>): string[] {
  if (!importClause) return [];
  const symbols = new Set<string>();
  if (importClause.name && producerSymbols.has("default")) symbols.add("default");
  const namedBindings = importClause.namedBindings;
  if (namedBindings && ts.isNamespaceImport(namedBindings)) {
    for (const symbol of producerSymbols) symbols.add(symbol);
  } else if (namedBindings && ts.isNamedImports(namedBindings)) {
    for (const element of namedBindings.elements) {
      const importedName = element.propertyName?.text || element.name.text;
      if (producerSymbols.has(importedName)) symbols.add(importedName);
    }
  }
  return [...symbols];
}

function exportDeclarationPublicSymbols(exportDeclaration: ts.ExportDeclaration, producerSymbols: Set<string>): string[] {
  const exportClause = exportDeclaration.exportClause;
  if (!exportClause) return [...producerSymbols].filter((symbol) => symbol !== "default");
  if (ts.isNamespaceExport(exportClause)) return [...producerSymbols];
  const symbols = new Set<string>();
  for (const element of exportClause.elements) {
    const exportedName = element.propertyName?.text || element.name.text;
    if (producerSymbols.has(exportedName)) symbols.add(exportedName);
  }
  return [...symbols];
}

function publicSymbolsUsedByReference(
  context: AnalysisContext,
  reference: PluginImportReference,
  producer: CellManifest,
): string[] {
  const sourceFile = ts.createSourceFile(
    reference.importerPath,
    readSourceText(context, absolutePath(context.rootDir, reference.importerPath)),
    ts.ScriptTarget.Latest,
    true,
    sourceKindForPath(reference.importerPath),
  );
  const producerSymbols = new Set(producer.publicSymbols);
  const symbols = new Set<string>();
  function visit(node: ts.Node): void {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier) && node.moduleSpecifier.text === reference.specifier) {
      for (const symbol of importClausePublicSymbols(node.importClause, producerSymbols)) symbols.add(symbol);
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier) && node.moduleSpecifier.text === reference.specifier) {
      for (const symbol of exportDeclarationPublicSymbols(node, producerSymbols)) symbols.add(symbol);
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return [...symbols];
}

function collectUsedPublicSymbols(context: AnalysisContext, observedImports: PluginImportReference[]): Map<string, Set<string>> {
  const usedByCell = new Map<string, Set<string>>();
  for (const cell of context.manifest.cells) usedByCell.set(cell.id, new Set<string>());
  for (const reference of observedImports) {
    if (!reference.targetCellId || !reference.targetPath || reference.importerCellId === reference.targetCellId) continue;
    const producer = context.cellsById.get(reference.targetCellId);
    if (!producer || normalizePath(reference.targetPath) !== normalizePath(producer.publicEntry)) continue;
    const usedSymbols = usedByCell.get(producer.id) as Set<string>;
    for (const symbol of publicSymbolsUsedByReference(context, reference, producer)) usedSymbols.add(symbol);
  }
  return usedByCell;
}
/* c8 ignore stop */

function resourceEntrySet(accesses: ResourceAccessReference[] = []): Set<string> {
  return new Set(sortedResourceBaselineEntries(accesses).map(resourceBaselineKey));
}

function countPruneCandidates(candidates: PruneCandidate[], kind: PruneCandidateKind): number {
  return candidates.filter((candidate) => candidate.kind === kind).length;
}

/* c8 ignore next 3 -- Optional fields only make prune output ordering deterministic; rule behavior is asserted through candidate contents. */
function pruneCandidateSortKey(candidate: PruneCandidate): string {
  return `${candidate.kind}:${candidate.cellId || ""}:${candidate.producerCellId || ""}:${candidate.filePath || ""}:${candidate.symbol || ""}:${candidate.artifactLaneId || ""}:${candidate.ruleId || ""}`;
}

export function createPruneReport(options: CheckOptions = {}): PruneReport {
  const rootDir = path.resolve(options.rootDir || process.cwd());
  const manifestPath = path.resolve(rootDir, options.manifestPath || DEFAULT_MANIFEST_PATH);
  const manifest = loadManifestFromFile(manifestPath);
  const baseline = loadOptionalBaseline(rootDir, options.baselinePath);
  const context = createContext(rootDir, manifest);
  const findings: Finding[] = [];
  const warnings: Finding[] = [];
  const observedImports: PluginImportReference[] = [];

  validateDuplicateCellIds(manifest, findings);
  validateOwnershipOverlap(manifest, findings);
  warnWhenOwnershipCoverageDisabled(context, warnings);
  validateOwnershipCoverage(context, findings);
  validatePublicEntries(context, findings);
  validateRequiredRuleConfiguration(context, options.ruleSeverities, findings);
  const crossCellDependencies = validateImports(context, findings, warnings, observedImports);
  const accessesByCell = validateResourceAccesses(context, findings, warnings, baseline);
  mergeAccessesByCell(
    accessesByCell,
    resourceEvidenceAccesses(context, evidencePathsForOptions(rootDir, options.evidencePaths), findings, baseline),
  );
  const metrics = computeMetrics(context, crossCellDependencies, accessesByCell);
  if (baseline) compareBaseline(context, metrics, baseline, findings);
  const severityAdjusted = applyRuleSeverityPolicy(context, findings, warnings, options.ruleSeverities);
  const preWaiverFindings = [...severityAdjusted.findings, ...severityAdjusted.warnings];
  const candidates: PruneCandidate[] = [];

  for (const cell of manifest.cells) {
    const observedDependencies = crossCellDependencies.get(cell.id) || new Set<string>();
    for (const consumer of cell.consumes || []) {
      if (observedDependencies.has(consumer.cell) || (consumer.artifactLanes || []).length > 0) continue;
      addPruneCandidate(candidates, {
        kind: "unused-consumer",
        cellId: cell.id,
        producerCellId: consumer.cell,
        message: `${cell.id} declares ${consumer.cell} as a consumer dependency, but no in-repository import uses it`,
      });
    }
  }

  const artifactConsumers = new Set<string>();
  for (const cell of manifest.cells) {
    for (const consumer of cell.consumes || []) {
      for (const lane of consumer.artifactLanes || []) artifactConsumers.add(`${consumer.cell}:${lane}`);
    }
  }
  for (const cell of manifest.cells) {
    for (const lane of cell.producesArtifacts || []) {
      if (artifactConsumers.has(`${cell.id}:${lane.id}`)) continue;
      addPruneCandidate(candidates, {
        kind: "unconsumed-artifact-lane",
        cellId: cell.id,
        artifactLaneId: lane.id,
        message: `${cell.id} produces artifact lane ${lane.id}, but no cell declares consumption of it`,
        details: { paths: lane.paths },
      });
    }
  }

  const usedPublicSymbols = collectUsedPublicSymbols(context, observedImports);
  for (const cell of manifest.cells) {
    const usedSymbols = usedPublicSymbols.get(cell.id) as Set<string>;
    for (const symbol of cell.publicSymbols) {
      if (usedSymbols.has(symbol)) continue;
      addPruneCandidate(candidates, {
        kind: "unused-public-symbol",
        cellId: cell.id,
        symbol,
        filePath: cell.publicEntry,
        message: `${cell.id} declares public symbol ${symbol}, but no in-repository consumer imports it`,
      });
    }
  }

  for (const waiver of collectWaiversForManifest(rootDir, manifest).filter((candidate) => candidate.valid)) {
    if (preWaiverFindings.some((finding) => waiverMatchesFinding(waiver, finding))) continue;
    addPruneCandidate(candidates, {
      kind: "stale-waiver",
      cellId: findOwningCell(manifest, waiver.filePath)?.id,
      filePath: waiver.filePath,
      line: waiver.line,
      ruleId: waiver.ruleId,
      message: `waiver for ${waiver.ruleId} at ${waiver.filePath}:${waiver.line} no longer suppresses an active finding`,
      details: { expires: waiver.expires, approvedBy: waiver.approvedBy, reason: waiver.reason },
    });
  }

  if (baseline) {
    for (const [cellId, baselineRecord] of Object.entries(baseline.cells)) {
      const currentResourceKeys = resourceEntrySet(accessesByCell.get(cellId));
      for (const resource of baselineRecord.resourceAccesses || []) {
        if (currentResourceKeys.has(resourceBaselineKey(resource))) continue;
        addPruneCandidate(candidates, {
          kind: "stale-baseline-resource",
          cellId,
          resource,
          message: `${cellId} baseline grandfathers ${resource.kind} ${resource.access} ${resource.selector}, but current analysis no longer observes it`,
        });
      }
    }
  }

  const sortedCandidates = candidates.sort((left, right) =>
    pruneCandidateSortKey(left).localeCompare(pruneCandidateSortKey(right)));
  return {
    schemaVersion: "cellfence.prune.v1",
    ok: sortedCandidates.length === 0,
    candidates: sortedCandidates,
    metrics: {
      candidates: sortedCandidates.length,
      unusedConsumers: countPruneCandidates(sortedCandidates, "unused-consumer"),
      unusedPublicSymbols: countPruneCandidates(sortedCandidates, "unused-public-symbol"),
      unconsumedArtifactLanes: countPruneCandidates(sortedCandidates, "unconsumed-artifact-lane"),
      staleWaivers: countPruneCandidates(sortedCandidates, "stale-waiver"),
      staleBaselineResources: countPruneCandidates(sortedCandidates, "stale-baseline-resource"),
    },
  };
}

function gitCommand(rootDir: string, args: string[]): string {
  try {
    return execFileSync("git", args, {
      cwd: rootDir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch (error) {
    const failure = error as { stderr?: unknown; message?: unknown };
    const stderr = typeof failure.stderr === "string" ? failure.stderr.trim() : "";
    /* c8 ignore next -- execFileSync throws Error-like objects with string messages; this is a final defensive fallback. */
    const fallbackMessage = typeof failure.message === "string" ? failure.message : "git command failed";
    const message = stderr || fallbackMessage;
    throw new Error(message, { cause: error });
  }
}

function gitMetadataFailure(message: string): CheckResult {
  return {
    ok: false,
    exitCode: 2,
    findings: [
      {
        ruleId: "CELLFENCE_GIT_METADATA_UNAVAILABLE",
        severity: "error",
        message,
      },
    ],
    warnings: [],
    metrics: {},
  };
}

function assertGitCommit(rootDir: string, ref: string): string {
  return gitCommand(rootDir, ["rev-parse", "--verify", `${ref}^{commit}`]);
}

function changedFilesForRefs(rootDir: string, baseRef: string, headRef?: string): string[] {
  const files = new Set<string>();
  const addDiff = (args: string[]): void => {
    const output = gitCommand(rootDir, args);
    for (const entry of output.split(/\r?\n/)) {
      const normalized = normalizePath(entry.trim());
      if (normalized) files.add(normalized);
    }
  };
  if (headRef) {
    addDiff(["diff", "--name-only", "--diff-filter=ACMR", `${baseRef}...${headRef}`]);
  } else {
    addDiff(["diff", "--name-only", "--diff-filter=ACMR", `${baseRef}...HEAD`]);
    addDiff(["diff", "--name-only", "--diff-filter=ACMR", "--cached"]);
    addDiff(["diff", "--name-only", "--diff-filter=ACMR"]);
  }
  return [...files].sort((left, right) => left.localeCompare(right));
}

type OwnershipMovement = {
  status: "rename" | "copy";
  similarity: number | undefined;
  fromPath: string;
  toPath: string;
};

function parseMovementStatus(status: string): Pick<OwnershipMovement, "status" | "similarity"> | undefined {
  const kind = status[0];
  if (kind !== "R" && kind !== "C") return undefined;
  const rawSimilarity = status.slice(1);
  return {
    status: kind === "R" ? "rename" : "copy",
    similarity: rawSimilarity.length > 0 ? Number(rawSimilarity) : undefined,
  };
}

function movementEntriesFromDiff(output: string): OwnershipMovement[] {
  const movements: OwnershipMovement[] = [];
  for (const line of output.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const parts = line.split("\t");
    if (parts.length < 3) continue;
    const parsedStatus = parseMovementStatus(parts[0]);
    if (!parsedStatus) continue;
    movements.push({
      ...parsedStatus,
      fromPath: normalizePath(parts[1]),
      toPath: normalizePath(parts[2]),
    });
  }
  return movements;
}

function movementEntriesForRefs(rootDir: string, baseRef: string, headRef?: string): OwnershipMovement[] {
  const movements = new Map<string, OwnershipMovement>();
  const addDiff = (args: string[]): void => {
    const output = gitCommand(rootDir, args);
    for (const movement of movementEntriesFromDiff(output)) {
      movements.set(`${movement.status}:${movement.fromPath}:${movement.toPath}`, movement);
    }
  };
  const diffArgs = ["diff", "--find-renames=50%", "--find-copies=50%", "--name-status", "--diff-filter=RC"];
  if (headRef) {
    addDiff([...diffArgs, `${baseRef}...${headRef}`]);
  } else {
    addDiff([...diffArgs, `${baseRef}...HEAD`]);
    addDiff([...diffArgs, "--cached"]);
    addDiff([...diffArgs]);
  }
  return [...movements.values()].sort((left, right) => `${left.fromPath}:${left.toPath}`.localeCompare(`${right.fromPath}:${right.toPath}`));
}

function crossCellMovementFindings(manifest: CellFenceManifest, movements: OwnershipMovement[]): Finding[] {
  const findings: Finding[] = [];
  for (const movement of movements) {
    const fromCell = findOwningCell(manifest, movement.fromPath);
    const toCell = findOwningCell(manifest, movement.toPath);
    if (!fromCell || !toCell || fromCell.id === toCell.id) continue;
    findings.push({
      ruleId: "CELLFENCE_CROSS_CELL_MOVE",
      severity: "error",
      cellId: toCell.id,
      producerCellId: fromCell.id,
      filePath: movement.toPath,
      message: `${movement.status} moves governed source across cell ownership from ${fromCell.id} to ${toCell.id}`,
      details: {
        status: movement.status,
        similarity: movement.similarity,
        fromPath: movement.fromPath,
        toPath: movement.toPath,
        fromCell: fromCell.id,
        toCell: toCell.id,
      },
      suggestedResolutions: [
        humanResolution("Declare and review the cross-cell ownership transfer before merging", {
          fromCell: fromCell.id,
          toCell: toCell.id,
          fromPath: movement.fromPath,
          toPath: movement.toPath,
        }),
        manifestResolution("Update dependency, public-surface, and resource contracts for the ownership transfer", true, {
          fromCell: fromCell.id,
          toCell: toCell.id,
        }),
      ],
    });
  }
  return findings;
}

function withBaseWorktree<T>(rootDir: string, baseCommit: string, callback: (baseRootDir: string) => T): T {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-base-"));
  const baseRootDir = path.join(tempRoot, "repo");
  try {
    gitCommand(rootDir, ["worktree", "add", "--detach", "--quiet", baseRootDir, baseCommit]);
    return callback(baseRootDir);
  } finally {
    try {
      if (fs.existsSync(baseRootDir)) gitCommand(rootDir, ["worktree", "remove", "--force", baseRootDir]);
    } catch {
      // Best-effort cleanup. The main check result should not be hidden by worktree removal noise.
    }
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

function checkOptionsForBase(baseRootDir: string, options: ChangedCheckOptions): CheckOptions {
  const baseOptions: CheckOptions = {
    rootDir: baseRootDir,
    manifestPath: options.manifestPath,
  };
  if (options.baselinePath && fs.existsSync(path.resolve(baseRootDir, options.baselinePath))) {
    baseOptions.baselinePath = options.baselinePath;
  }
  if (options.plugins) baseOptions.plugins = options.plugins;
  if (options.ruleSeverities) baseOptions.ruleSeverities = options.ruleSeverities;
  const evidencePaths = (options.evidencePaths || []).filter((evidencePath) => fs.existsSync(path.resolve(baseRootDir, evidencePath)));
  if (evidencePaths.length > 0) baseOptions.evidencePaths = evidencePaths;
  return baseOptions;
}

function findingKey(finding: Finding): string {
  return finding.fingerprint || findingFingerprint(finding);
}

export function checkChangedRepository(options: ChangedCheckOptions = {}): CheckResult {
  const rootDir = path.resolve(options.rootDir || process.cwd());
  const baseRef = options.baseRef || "origin/main";
  try {
    gitCommand(rootDir, ["rev-parse", "--is-inside-work-tree"]);
    const baseCommit = assertGitCommit(rootDir, baseRef);
    if (options.headRef) assertGitCommit(rootDir, options.headRef);
    const changedFiles = changedFilesForRefs(rootDir, baseRef, options.headRef);
    const movements = movementEntriesForRefs(rootDir, baseRef, options.headRef);
    const currentResult = checkRepository({ ...options, changedFiles });
    if (currentResult.exitCode === 2 || currentResult.exitCode === 3) {
      return { ...currentResult, changedFiles };
    }
    const baseResult = withBaseWorktree(rootDir, baseCommit, (baseRootDir) => checkRepository(checkOptionsForBase(baseRootDir, options)));
    if (baseResult.exitCode === 2 || baseResult.exitCode === 3) {
      return {
        ...baseResult,
        findings: baseResult.findings.map((finding) => ({
          ...finding,
          message: `base check failed before changed-finding diff could be computed: ${finding.message}`,
        })),
        changedFiles,
      };
    }
    const baseFindingKeys = new Set(baseResult.findings.map(findingKey));
    const baseWarningKeys = new Set(baseResult.warnings.map(findingKey));
    const manifest = loadManifestFromFile(path.resolve(rootDir, options.manifestPath || DEFAULT_MANIFEST_PATH));
    const movementFindings = crossCellMovementFindings(manifest, movements);
    const findings = [
      ...currentResult.findings.filter((finding) => !baseFindingKeys.has(findingKey(finding))),
      ...movementFindings,
    ];
    const warnings = currentResult.warnings.filter((warning) => !baseWarningKeys.has(findingKey(warning)));
    const hasErrors = findings.some((finding) => finding.severity === "error");
    return {
      ...currentResult,
      ok: !hasErrors,
      exitCode: hasErrors ? 1 : 0,
      findings,
      warnings,
      changedFiles,
      baseFindingCount: baseResult.findings.length,
    };
  } catch (error) {
    return gitMetadataFailure(`changed check requires git metadata and a valid base ref: ${errorMessage(error)}`);
  }
}

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
      if (code !== "EEXIST" || Date.now() >= deadline) {
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

function pathPatternsOverlap(leftPattern: string, rightPattern: string): boolean {
  const left = normalizePath(leftPattern);
  const right = normalizePath(rightPattern);
  if (left === right) return true;
  const leftPrefix = literalPrefix(left) || left;
  const rightPrefix = literalPrefix(right) || right;
  return matchesPattern(leftPrefix, right)
    || matchesPattern(rightPrefix, left)
    || (Boolean(leftPrefix) && Boolean(rightPrefix) && (
      leftPrefix === rightPrefix
      || leftPrefix.startsWith(`${rightPrefix}/`)
      || rightPrefix.startsWith(`${leftPrefix}/`)
    ));
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

function workingTreeChangedFiles(rootDir: string): string[] {
  const files = new Set<string>();
  const add = (args: string[]): void => {
    const output = gitCommand(rootDir, args);
    for (const entry of output.split(/\r?\n/)) {
      const normalized = normalizePath(entry.trim());
      if (normalized) files.add(normalized);
    }
  };
  gitCommand(rootDir, ["rev-parse", "--is-inside-work-tree"]);
  assertGitCommit(rootDir, "HEAD");
  add(["diff", "--name-only", "--diff-filter=ACMR", "HEAD"]);
  add(["ls-files", "--others", "--exclude-standard"]);
  return [...files].sort((left, right) => left.localeCompare(right));
}

function changedFilesForClaimCheck(rootDir: string, options: ClaimCheckOptions): string[] {
  if (options.baseRef) {
    assertGitCommit(rootDir, options.baseRef);
    if (options.headRef) assertGitCommit(rootDir, options.headRef);
    return changedFilesForRefs(rootDir, options.baseRef, options.headRef);
  }
  return workingTreeChangedFiles(rootDir);
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

export function checkWriteAccess(options: WriteAccessOptions): WriteAccessResult {
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
    manifest = loadManifestFromFile(manifestPath);
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
  });
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

export function checkClaims(options: ClaimCheckOptions = {}): ClaimCheckResult {
  const rootDir = path.resolve(options.rootDir || process.cwd());
  const manifestPath = path.resolve(rootDir, options.manifestPath || DEFAULT_MANIFEST_PATH);
  let manifest: CellFenceManifest;
  try {
    manifest = loadManifestFromFile(manifestPath);
  } catch (error) {
    return claimConfigurationFailure(`failed to read manifest ${repoPath(rootDir, manifestPath)}: ${errorMessage(error)}`);
  }
  const context = createContext(rootDir, manifest);
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
      changedFiles = changedFilesForClaimCheck(rootDir, options).filter((filePath) => normalizePath(filePath) !== claimsRelativePath);
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

export function createClaim(options: ClaimCreateOptions): ClaimCreateResult {
  const rootDir = path.resolve(options.rootDir || process.cwd());
  const manifestPath = path.resolve(rootDir, options.manifestPath || DEFAULT_MANIFEST_PATH);
  let manifest: CellFenceManifest;
  try {
    manifest = loadManifestFromFile(manifestPath);
  } catch (error) {
    return { ...claimConfigurationFailure(`failed to read manifest ${repoPath(rootDir, manifestPath)}: ${errorMessage(error)}`), claimsPath: claimStorePath(rootDir, options.claimsPath) };
  }
  const context = createContext(rootDir, manifest);
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

export function createBaseline(options: CheckOptions = {}): CellFenceBaseline {
  const result = checkRepository({ ...options, baselinePath: undefined });
  if (result.exitCode === 2 || result.exitCode === 3) {
    throw new Error(result.findings.map((finding) => finding.message).join("; "));
  }
  return {
    schemaVersion: CELLFENCE_BASELINE_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    cellIds: Object.keys(result.metrics).sort((left, right) => left.localeCompare(right)),
    cells: result.metrics,
  };
}

function addLockedBaselineFinding(
  findings: Finding[],
  cellId: string,
  message: string,
  details: Record<string, unknown>,
): void {
  addFinding(findings, {
    ruleId: "CELLFENCE_LOCKED_BASELINE_EXPANSION",
    severity: "error",
    cellId,
    message,
    details,
    suggestedResolutions: [
      codeResolution("Reduce the change so the locked cell stays within the accepted baseline", details),
      humanResolution("Ask a human owner to review and unlock or manually accept this architectural expansion", details),
    ],
  });
}

export function guardBaselineUpdate(options: BaselineUpdateGuardOptions): BaselineUpdateGuardResult {
  const rootDir = path.resolve(options.rootDir || process.cwd());
  const manifestPath = path.resolve(rootDir, options.manifestPath || DEFAULT_MANIFEST_PATH);
  const baselinePath = path.resolve(rootDir, options.baselinePath || defaultBaselinePath(rootDir));
  if (!fs.existsSync(baselinePath)) return { ok: true, findings: [] };

  const manifest = loadManifestFromFile(manifestPath);
  const existingBaselineValidation = validateBaseline(readJsonFile(baselinePath));
  if (!existingBaselineValidation.ok || !existingBaselineValidation.value) {
    throw new Error(`baseline is invalid: ${existingBaselineValidation.errors.join("; ")}`);
  }

  const findings: Finding[] = [];
  const existingBaseline = existingBaselineValidation.value;
  for (const cell of manifest.cells) {
    if (!cell.locked) continue;
    const current = options.nextBaseline.cells[cell.id];
    const previous = existingBaseline.cells[cell.id];
    if (!previous) {
      if (current) {
        addLockedBaselineFinding(
          findings,
          cell.id,
          `${cell.id} is locked and is absent from the existing baseline`,
          { cell: cell.id, metric: "cellIds", previous: null, current: true },
        );
      }
      continue;
    }
    if (!current) continue;

    for (const metric of ["ownedPathPatterns", "publicSymbols", "publicSurfaceLines", "crossCellDependencies"] as const) {
      if (current[metric] > previous[metric]) {
        addLockedBaselineFinding(
          findings,
          cell.id,
          `${cell.id} is locked and ${metric} would grow from ${previous[metric]} to ${current[metric]}`,
          { cell: cell.id, metric, previous: previous[metric], current: current[metric] },
        );
      }
    }

    const scopeExpansion = current.ownedPathSet && previous.ownedPathSet
      ? current.ownedPathSet.filter((currentPattern) => !patternCoveredByOwnedPaths(currentPattern, previous.ownedPathSet as string[]))
      : [];
    if (scopeExpansion.length > 0) {
      addLockedBaselineFinding(
        findings,
        cell.id,
        `${cell.id} is locked and ownership scope would expand or shift: ${scopeExpansion.join(", ")}`,
        { cell: cell.id, metric: "ownedPathSet", previous: previous.ownedPathSet, current: current.ownedPathSet, scopeExpansion },
      );
    }

    if (current.publicEntryPath && previous.publicEntryPath && current.publicEntryPath !== previous.publicEntryPath) {
      addLockedBaselineFinding(
        findings,
        cell.id,
        `${cell.id} is locked and public entry would change from ${previous.publicEntryPath} to ${current.publicEntryPath}`,
        { cell: cell.id, metric: "publicEntryPath", previous: previous.publicEntryPath, current: current.publicEntryPath },
      );
    }

    const addedPublicSymbols = current.publicSymbolSet && previous.publicSymbolSet
      ? current.publicSymbolSet.filter((symbol) => !(previous.publicSymbolSet as string[]).includes(symbol))
      : [];
    if (addedPublicSymbols.length > 0) {
      addLockedBaselineFinding(
        findings,
        cell.id,
        `${cell.id} is locked and public symbols would be added: ${addedPublicSymbols.join(", ")}`,
        { cell: cell.id, metric: "publicSymbolSet", addedPublicSymbols },
      );
    }

    const addedDependencyEdges = current.dependencyEdges && previous.dependencyEdges
      ? current.dependencyEdges.filter((edge) => !(previous.dependencyEdges as string[]).includes(edge))
      : [];
    if (addedDependencyEdges.length > 0) {
      addLockedBaselineFinding(
        findings,
        cell.id,
        `${cell.id} is locked and dependency edges would be added: ${addedDependencyEdges.join(", ")}`,
        { cell: cell.id, metric: "dependencyEdges", addedDependencyEdges },
      );
    }

    const addedArtifacts = current.artifactContracts && previous.artifactContracts
      ? current.artifactContracts.filter((artifact) => !(previous.artifactContracts as string[]).includes(artifact))
      : [];
    if (addedArtifacts.length > 0) {
      addLockedBaselineFinding(
        findings,
        cell.id,
        `${cell.id} is locked and artifact contracts would be added: ${addedArtifacts.join(", ")}`,
        { cell: cell.id, metric: "artifactContracts", addedArtifacts },
      );
    }

    if (current.publicSurfaceHash && previous.publicSurfaceHash && current.publicSurfaceHash !== previous.publicSurfaceHash) {
      addLockedBaselineFinding(
        findings,
        cell.id,
        `${cell.id} is locked and public surface signature hash would change`,
        { cell: cell.id, metric: "publicSurfaceHash", previous: previous.publicSurfaceHash, current: current.publicSurfaceHash },
      );
    }

    const previousResourceKeys = new Set((previous.resourceAccesses || []).map(resourceBaselineKey));
    for (const resourceAccess of current.resourceAccesses || []) {
      const resourceKey = resourceBaselineKey(resourceAccess);
      if (previousResourceKeys.has(resourceKey)) continue;
      addLockedBaselineFinding(
        findings,
        cell.id,
        `${cell.id} is locked and baseline update would grandfather ${resourceAccess.kind} ${resourceAccess.access} ${resourceAccess.selector}`,
        { cell: cell.id, resourceAccess },
      );
    }
  }

  return { ok: findings.length === 0, findings };
}

function loadOptionalBaseline(rootDir: string, baselinePath: string | undefined): CellFenceBaseline | undefined {
  const resolvedBaselinePath = baselinePath
    ? path.resolve(rootDir, baselinePath)
    : defaultBaselinePath(rootDir);
  if (!fs.existsSync(resolvedBaselinePath)) return undefined;
  const validation = validateBaseline(readJsonFile(resolvedBaselinePath));
  if (!validation.ok || !validation.value) {
    throw new Error(`baseline is invalid: ${validation.errors.join("; ")}`);
  }
  return validation.value;
}

function budgetEntry(current: number, limit: number, source: ContextBudgetEntry["source"]): ContextBudgetEntry {
  return {
    current,
    limit,
    remaining: limit - current,
    source,
  };
}

export function createCellContext(options: ContextOptions): CellFenceContext {
  const rootDir = path.resolve(options.rootDir || process.cwd());
  const manifestPath = path.resolve(rootDir, options.manifestPath || DEFAULT_MANIFEST_PATH);
  const manifest = loadManifestFromFile(manifestPath);
  const context = createContext(rootDir, manifest);
  const cell = context.cellsById.get(options.cellId);
  if (!cell) {
    throw new Error(`unknown cell ${options.cellId}`);
  }

  const baseline = loadOptionalBaseline(rootDir, options.baselinePath);
  const currentResult = checkRepository({
    rootDir,
    manifestPath: repoPath(rootDir, manifestPath),
    evidencePaths: options.evidencePaths,
  });
  const currentMetrics = currentResult.metrics[cell.id];
  const baselineRecord = baseline?.cells[cell.id];
  const budgets: CellFenceContext["budgets"] = {};

  for (const metric of ["ownedPathPatterns", "publicSymbols", "publicSurfaceLines", "crossCellDependencies"] as const) {
    const current = (currentMetrics as CellBaselineRecord)[metric];
    const manifestLimit = cell.budgets?.[metric];
    if (typeof manifestLimit === "number") {
      budgets[metric] = budgetEntry(current, manifestLimit, "manifest-budget");
    } else if (baselineRecord && typeof baselineRecord[metric] === "number") {
      budgets[metric] = budgetEntry(current, baselineRecord[metric], "baseline-ratchet");
    }
  }

  const allowedImports: ContextAllowedImport[] = (cell.consumes ?? []).flatMap((consumer) => {
    const producer = context.cellsById.get(consumer.cell);
    if (!producer) return [];
    return [{
      cell: producer.id,
      publicEntry: producer.publicEntry,
      packageName: producer.packageName,
      locked: Boolean(producer.locked),
      artifactLanes: consumer.artifactLanes || [],
    }];
  });

  return {
    schemaVersion: "cellfence.context.v1",
    cell: {
      id: cell.id,
      packageName: cell.packageName,
      locked: Boolean(cell.locked),
      ownedPaths: cell.ownedPaths,
      publicEntry: cell.publicEntry,
      publicSymbols: cell.publicSymbols,
    },
    allowedImports,
    allowedResources: cell.resourceContracts || [],
    baselineResources: baselineRecord?.resourceAccesses || [],
    producedArtifacts: cell.producesArtifacts || [],
    budgets,
    guidance: [
      "Create and edit source only inside ownedPaths unless a human changes the manifest.",
      "Cross-cell imports must use the listed publicEntry or packageName surfaces.",
      "Do not import another cell's internal implementation paths.",
      "Resource access must match allowedResources or existing baselineResources.",
      "Baseline updates expand the fence and should be treated as review-sensitive changes.",
    ],
  };
}

function graphNodeKey(kind: CouplingGraphNode["kind"], id: string): string {
  return `${kind}:${id}`;
}

function addGraphNode(nodes: Map<string, CouplingGraphNode>, node: CouplingGraphNode): void {
  nodes.set(graphNodeKey(node.kind, node.id), node);
}

function addGraphEdge(edges: Map<string, CouplingGraphEdge>, edge: CouplingGraphEdge): void {
  edges.set(`${edge.from}->${edge.to}:${edge.kind}:${edge.label}`, edge);
}

function resourceNodeId(access: ResourceBaselineEntry): string {
  return `${access.kind}:${access.selector}`;
}

export function createCouplingGraph(options: CheckOptions = {}): CouplingGraph {
  const rootDir = path.resolve(options.rootDir || process.cwd());
  const manifestPath = path.resolve(rootDir, options.manifestPath || DEFAULT_MANIFEST_PATH);
  const manifest = loadManifestFromFile(manifestPath);
  const context = createContext(rootDir, manifest);
  const findings: Finding[] = [];
  const warnings: Finding[] = [];
  const nodes = new Map<string, CouplingGraphNode>();
  const edges = new Map<string, CouplingGraphEdge>();

  for (const cell of manifest.cells) {
    addGraphNode(nodes, { id: cell.id, label: cell.id, kind: "cell" });
    for (const consumer of cell.consumes ?? []) {
      addGraphEdge(edges, {
        from: cell.id,
        to: consumer.cell,
        kind: "declared-consumer",
        label: "declares",
      });
      for (const lane of consumer.artifactLanes || []) {
        const artifactId = `artifact:${consumer.cell}:${lane}`;
        addGraphNode(nodes, { id: artifactId, label: lane, kind: "artifact" });
        addGraphEdge(edges, {
          from: consumer.cell,
          to: artifactId,
          kind: "artifact-lane",
          label: "produces",
        });
        addGraphEdge(edges, {
          from: cell.id,
          to: artifactId,
          kind: "artifact-lane",
          label: "consumes",
        });
      }
    }
  }

  const observedImports = validateImports(context, findings, warnings);
  for (const [consumerCellId, producerCells] of observedImports.entries()) {
    for (const producerCellId of producerCells) {
      addGraphEdge(edges, {
        from: consumerCellId,
        to: producerCellId,
        kind: "observed-import",
        label: "imports",
      });
    }
  }

  const accessesByCell = validateResourceAccesses(context, findings, warnings, undefined);
  mergeAccessesByCell(
    accessesByCell,
    resourceEvidenceAccesses(context, evidencePathsForOptions(rootDir, options.evidencePaths), findings, undefined),
  );
  for (const [cellId, accesses] of accessesByCell.entries()) {
    for (const access of sortedResourceBaselineEntries(accesses)) {
      const nodeId = resourceNodeId(access);
      addGraphNode(nodes, { id: nodeId, label: nodeId, kind: "resource" });
      addGraphEdge(edges, {
        from: cellId,
        to: nodeId,
        kind: "resource-access",
        label: access.access,
      });
    }
  }

  return {
    schemaVersion: "cellfence.coupling-graph.v1",
    nodes: [...nodes.values()].sort((left, right) => graphNodeKey(left.kind, left.id).localeCompare(graphNodeKey(right.kind, right.id))),
    edges: [...edges.values()].sort((left, right) => `${left.from}:${left.to}:${left.kind}:${left.label}`.localeCompare(`${right.from}:${right.to}:${right.kind}:${right.label}`)),
  };
}

function mermaidId(value: string): string {
  return value.replace(/[^A-Za-z0-9_]/g, "_");
}

export function formatCouplingGraphMermaid(graph: CouplingGraph): string {
  const lines = ["flowchart LR"];
  for (const node of graph.nodes) {
    lines.push(`  ${mermaidId(node.id)}["${node.label.replace(/"/g, "'")}"]`);
  }
  for (const edge of graph.edges) {
    lines.push(`  ${mermaidId(edge.from)} -- "${edge.label} (${edge.kind})" --> ${mermaidId(edge.to)}`);
  }
  return lines.join("\n");
}

function taskMatchesCell(task: string, cell: CellManifest): boolean {
  const text = task.toLowerCase();
  if (cell.id.toLowerCase().split(/[-_]/).some((part) => part.length > 2 && text.includes(part))) return true;
  if (text.includes(cell.id.toLowerCase())) return true;
  if (cell.packageName && text.includes(cell.packageName.toLowerCase())) return true;
  if (cell.publicSymbols.some((symbol) => text.includes(symbol.toLowerCase()))) return true;
  return cell.ownedPaths.some((ownedPath) => text.includes(ownedPath.toLowerCase().replace(/\*\*/g, "").replace(/\*/g, "")));
}

export function createAutoAllocation(options: AutoAllocateOptions = {}): AutoAllocation {
  const rootDir = path.resolve(options.rootDir || process.cwd());
  const manifestPath = path.resolve(rootDir, options.manifestPath || DEFAULT_MANIFEST_PATH);
  const manifest = loadManifestFromFile(manifestPath);
  const graph = createCouplingGraph(options);
  const selectedCells = new Set<string>();
  const task = options.task || "";
  if (options.cellId) selectedCells.add(options.cellId);
  if (task.trim().length > 0) {
    for (const cell of manifest.cells) {
      if (taskMatchesCell(task, cell)) selectedCells.add(cell.id);
    }
  }

  const contextCells = new Set(selectedCells);
  for (const edge of graph.edges) {
    if (selectedCells.has(edge.from) && graph.nodes.some((node) => node.kind === "cell" && node.id === edge.to)) {
      contextCells.add(edge.to);
    }
  }

  const includePaths = new Set<string>();
  const publicEntries = new Set<string>();
  const resourceSelectors = new Set<string>();
  const budgets: Record<string, Record<string, ContextBudgetEntry>> = {};
  for (const cell of manifest.cells) {
    if (selectedCells.has(cell.id)) {
      cell.ownedPaths.forEach((ownedPath) => includePaths.add(ownedPath));
    }
    if (contextCells.has(cell.id)) {
      const cellContext = createCellContext({
        rootDir,
        manifestPath,
        baselinePath: options.baselinePath,
        evidencePaths: options.evidencePaths,
        cellId: cell.id,
      });
      publicEntries.add(cell.publicEntry);
      budgets[cell.id] = Object.fromEntries(Object.entries(cellContext.budgets));
      for (const contract of cellContext.allowedResources) {
        for (const access of contract.access) {
          for (const selector of contract.selectors) resourceSelectors.add(`${contract.kind}:${access}:${selector}`);
        }
      }
      for (const resource of cellContext.baselineResources) {
        resourceSelectors.add(`${resource.kind}:${resource.access}:${resource.selector}`);
      }
    }
  }

  return {
    schemaVersion: "cellfence.auto-allocation.v1",
    task,
    selectedCells: [...selectedCells].sort(),
    contextCells: [...contextCells].sort(),
    includePaths: [...includePaths].sort(),
    publicEntries: [...publicEntries].sort(),
    resourceSelectors: [...resourceSelectors].sort(),
    budgets,
    guidance: [
      "Read selected cell owned paths only when implementation edits are needed.",
      "Read context cell public entries for dependency contracts; avoid internal files from context cells.",
      "If selectedCells is empty, ask for a target cell or a more specific task before editing.",
    ],
  };
}

export function createWaiverRequest(options: WaiverRequestOptions): WaiverRequest {
  if (!isIsoDate(options.expires)) throw new Error("expires must be YYYY-MM-DD");
  if (options.reason.trim().length < 12) throw new Error("reason must explain the waiver in at least 12 characters");
  const approvedBy = options.approvedBy || "PENDING";
  const directive = `// cellfence-ignore ${options.ruleId} expires:${options.expires} approved-by:${approvedBy} reason:${options.reason.trim()}`;
  const markdown = [
    "## CellFence Waiver Request",
    "",
    `- Rule: ${options.ruleId}`,
    `- File: ${normalizePath(options.filePath)}:${options.line}`,
    `- Expires: ${options.expires}`,
    `- Approved by: ${approvedBy}`,
    `- Reason: ${options.reason.trim()}`,
    "",
    "Approved directive:",
    "",
    "```ts",
    directive,
    "```",
  ].join("\n");
  return {
    schemaVersion: "cellfence.waiver-request.v1",
    directive,
    markdown,
    approvalRequired: true,
    ruleId: options.ruleId,
    filePath: normalizePath(options.filePath),
    line: options.line,
    expires: options.expires,
    approvedBy,
    reason: options.reason.trim(),
  };
}

export function writeBaselineFile(filePath: string, baseline: CellFenceBaseline): void {
  fs.writeFileSync(filePath, `${JSON.stringify(sealBaselineIfConfigured(baseline), null, 2)}\n`);
}

export function defaultBaselinePath(rootDir = process.cwd()): string {
  return path.resolve(rootDir, DEFAULT_BASELINE_PATH);
}

export function formatHumanResult(result: CheckResult): string {
  const lines: string[] = [];
  lines.push(result.ok ? "CellFence check passed." : "CellFence check failed.");
  for (const finding of [...result.findings, ...result.warnings]) {
    const location = finding.filePath ? ` ${finding.filePath}` : "";
    lines.push(`[${finding.severity}] ${finding.ruleId}${location}: ${finding.message}`);
  }
  return lines.join("\n");
}
