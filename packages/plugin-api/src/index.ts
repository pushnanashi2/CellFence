import type ts from "typescript";

import type {
  CellBaselineRecord,
  CellFenceBaseline,
  CellFenceManifest,
  CellManifest,
  ResourceAccessConfidence,
  ResourceAccessMode,
  ResourceContractKind,
  ResourceContractManifest,
} from "@cellfence/schema";

export const CELLFENCE_PLUGIN_API_VERSION = 1;

export type CellFenceRuleSeverity = "off" | "warning" | "error";
export type CellFenceFindingSeverity = "warning" | "error";
export type CellFenceCapability =
  | "repository-read"
  | "ast"
  | "type-checker"
  | "git-diff"
  | "runtime-evidence"
  | "process-execution"
  | "network";

export type CellFenceSuggestedResolution = {
  kind: "change-code" | "change-manifest" | "update-baseline" | "ask-human";
  title: string;
  approvalRequired: boolean;
  details?: Record<string, unknown>;
};

export type CellFenceFinding<RuleId extends string = string> = {
  ruleId: RuleId;
  severity: CellFenceFindingSeverity;
  message: string;
  filePath?: string;
  cellId?: string;
  producerCellId?: string;
  details?: Record<string, unknown>;
  suggestedResolutions?: CellFenceSuggestedResolution[];
  fingerprint?: string;
};

export type CellFenceFileIndex = {
  all: readonly string[];
  governed: readonly string[];
  byCell: Readonly<Record<string, readonly string[]>>;
  contents: Readonly<Record<string, string>>;
};

export type CellFenceImportReference = {
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

export type CellFenceResourceAccess = {
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

export type CellFenceRepositoryModel = {
  rootDir: string;
  manifest: CellFenceManifest;
  baseline: CellFenceBaseline | null;
  files: CellFenceFileIndex;
  imports: readonly CellFenceImportReference[];
  resources: readonly CellFenceResourceAccess[];
  metrics: Readonly<Record<string, CellBaselineRecord>>;
  changedFiles: ReadonlySet<string>;
};

export type CellFenceRuleContext = {
  repository: CellFenceRepositoryModel;
  cells: readonly CellManifest[];
  report(finding: CellFenceFinding): void;
};

export type CellFenceRule = {
  id: string;
  meta: {
    description: string;
    defaultSeverity: CellFenceRuleSeverity;
    category: string;
    docsUrl?: string;
  };
  run(context: CellFenceRuleContext): void | CellFenceFinding[];
};

export type CellFenceAdapterHelpers = {
  getQualifiedCallName(node: ts.Node): string | undefined;
  getStaticStringArgument(node: ts.CallExpression, index: number): string | undefined;
  lineOf(node: ts.Node): number;
};

export type CellFenceAdapterContext = {
  repository: CellFenceRepositoryModel;
  cell: CellManifest;
  filePath: string;
  sourceText: string;
  sourceFile: ts.SourceFile;
  helpers: CellFenceAdapterHelpers;
};

export type CellFenceAdapter = {
  name: string;
  detect(context: CellFenceAdapterContext): CellFenceResourceAccess[];
};

export type CellFenceReporterContext = {
  repository: CellFenceRepositoryModel;
  findings: readonly CellFenceFinding[];
  warnings: readonly CellFenceFinding[];
};

export type CellFenceReporter = {
  name: string;
  report(context: CellFenceReporterContext): string;
};

export type CellFencePluginCapabilities = {
  needsAst?: boolean;
  needsTypeChecker?: boolean;
  needsGitDiff?: boolean;
  needsRuntimeEvidence?: boolean;
  needsNetwork?: boolean;
};

export type CellFencePlugin = {
  apiVersion: typeof CELLFENCE_PLUGIN_API_VERSION;
  name: string;
  version: string;
  capabilities?: CellFencePluginCapabilities;
  rules?: Record<string, CellFenceRule>;
  adapters?: CellFenceAdapter[];
  reporters?: CellFenceReporter[];
  manifestSchema?: unknown;
};

export function definePlugin(plugin: CellFencePlugin): CellFencePlugin {
  return plugin;
}

export function defineRule(rule: CellFenceRule): CellFenceRule {
  return rule;
}

export function defineAdapter(adapter: CellFenceAdapter): CellFenceAdapter {
  return adapter;
}

export function defineReporter(reporter: CellFenceReporter): CellFenceReporter {
  return reporter;
}
