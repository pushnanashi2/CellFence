import type * as ts from "typescript";

import type {
  CellBaselineRecord,
  CellFenceBaseline,
  CellFenceManifest,
  CellManifest,
  ResourceAccessConfidence,
  ResourceBaselineEntry,
  ResourceContractKind,
  ResourceContractManifest,
  RuleSeverity as ConfiguredRuleSeverity,
} from "@cellfence/schema";
import type { FileIndexContext } from "./file-index.js";
import type { EvidenceGraph, FindingWitness } from "./governance/model.js";
import type { PathAlias } from "./module-resolution.js";
import type { ResourceAccessMode } from "./resource-access.js";

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
  | "CELLFENCE_UNSUPPORTED_TYPESCRIPT_SYNTAX"
  | "CELLFENCE_UNSUPPORTED_PYTHON_SYNTAX"
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

export type PluginFinding<RuleIdentifier extends string = string> = {
  ruleId: RuleIdentifier;
  severity: Severity;
  message: string;
  filePath?: string;
  cellId?: string;
  producerCellId?: string;
  details?: Record<string, unknown>;
  suggestedResolutions?: SuggestedResolution[];
  fingerprint?: string;
  witness?: FindingWitness;
};

export type Finding = PluginFinding<RuleId | string>;

export type PluginImportReference = {
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

export type PluginResourceAccess = {
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

export type PluginRepositoryModel = {
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

export type PluginRuleContext = {
  repository: PluginRepositoryModel;
  cells: readonly CellManifest[];
  report(finding: PluginFinding): void;
};

export type PluginAdapterHelpers = {
  getQualifiedCallName(node: ts.Node): string | undefined;
  getStaticStringArgument(node: ts.CallExpression, index: number): string | undefined;
  lineOf(node: ts.Node): number;
};

export type PluginAdapter = {
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

export type PluginRule = {
  id: string;
  meta: {
    description: string;
    defaultSeverity: ConfiguredRuleSeverity;
    category: string;
    docsUrl?: string;
  };
  run(context: PluginRuleContext): void | PluginFinding[];
};

export type PluginReporter = {
  name: string;
  report(context: {
    repository: PluginRepositoryModel;
    findings: readonly PluginFinding[];
    warnings: readonly PluginFinding[];
  }): string;
};

export type PluginDefinition = {
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
  includeEvidenceGraph?: boolean;
};

export type CheckResult = {
  ok: boolean;
  exitCode: 0 | 1 | 2 | 3;
  findings: Finding[];
  warnings: Finding[];
  metrics: Record<string, CellBaselineRecord>;
  changedFiles?: string[];
  baseFindingCount?: number;
  evidenceGraph?: EvidenceGraph;
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

export type ChangedCheckOptions = Omit<CheckOptions, "includeEvidenceGraph"> & {
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

export type ContextBudgetMetric =
  | "ownedPathPatterns"
  | "publicSymbols"
  | "publicSurfaceLines"
  | "crossCellDependencies";

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

export type ResolvedImport = {
  targetPath?: string;
  targetCell?: CellManifest;
  artifactLaneId?: string;
  matchedSpecifier?: string;
  isExternal: boolean;
  isPublicPackage: boolean;
};

export type AnalysisContext = FileIndexContext & {
  cellsById: Map<string, CellManifest>;
  packageToCell: Map<string, CellManifest>;
  packageRoots: Map<string, string>;
  pathAliases: PathAlias[];
};
