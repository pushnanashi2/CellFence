import fs from "node:fs";
import os from "node:os";
import path from "node:path";
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
  type ResourceContractManifest,
  validateBaseline,
  validateManifest,
  validateResourceEvidence,
} from "@cellfence/schema";

export type RuleId =
  | "CELLFENCE_MANIFEST_INVALID"
  | "CELLFENCE_DUPLICATE_CELL_ID"
  | "CELLFENCE_OWNERSHIP_OVERLAP"
  | "CELLFENCE_PRIVATE_IMPORT"
  | "CELLFENCE_UNDECLARED_CONSUMER"
  | "CELLFENCE_PUBLIC_ENTRY_MISSING"
  | "CELLFENCE_PUBLIC_SYMBOL_MISMATCH"
  | "CELLFENCE_UNDECLARED_ARTIFACT"
  | "CELLFENCE_RATCHET_OWNED_PATH_GROWTH"
  | "CELLFENCE_RATCHET_PUBLIC_SYMBOL_GROWTH"
  | "CELLFENCE_RATCHET_PUBLIC_SURFACE_LINE_GROWTH"
  | "CELLFENCE_RATCHET_CROSS_CELL_DEPENDENCY_GROWTH"
  | "CELLFENCE_UNDECLARED_RESOURCE_ACCESS"
  | "CELLFENCE_UNRESOLVED_RESOURCE_ACCESS"
  | "CELLFENCE_RESOURCE_EVIDENCE_INVALID"
  | "CELLFENCE_UNRESOLVED_IMPORT"
  | "CELLFENCE_LOCKED_BASELINE_EXPANSION"
  | "CELLFENCE_WAIVER_INVALID"
  | "CELLFENCE_GIT_METADATA_UNAVAILABLE"
  | "CELLFENCE_UNSUPPORTED_DYNAMIC_IMPORT";

export type Severity = "error" | "warning";

export type SuggestedResolution = {
  kind: "change-code" | "change-manifest" | "update-baseline" | "ask-human";
  title: string;
  approvalRequired: boolean;
  details?: Record<string, unknown>;
};

export type Finding = {
  ruleId: RuleId;
  severity: Severity;
  message: string;
  filePath?: string;
  cellId?: string;
  producerCellId?: string;
  details?: Record<string, unknown>;
  suggestedResolutions?: SuggestedResolution[];
};

export type CheckOptions = {
  rootDir?: string;
  manifestPath?: string;
  baselinePath?: string;
  evidencePaths?: string[];
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

type ImportKind = "import" | "export-from" | "require" | "dynamic-import";

type ImportReference = {
  importerPath: string;
  specifier: string;
  kind: ImportKind;
  typeOnly: boolean;
  line: number;
};

type ResourceAccessKind = "file" | "database" | "queue" | "http";
type ResourceAccessMode = "read" | "write" | "publish" | "subscribe" | "call" | "serve";

type ResourceAccessReference = {
  kind: ResourceAccessKind;
  access: ResourceAccessMode;
  selector: string;
  filePath: string;
  line: number;
  source: string;
  detectedBy: string;
  confidence: "high" | "medium" | "low" | "runtime";
  unresolved?: boolean;
  reason?: string;
};

type ResolvedImport = {
  targetPath?: string;
  targetCell?: CellManifest;
  artifactLaneId?: string;
  isExternal: boolean;
  isPublicPackage: boolean;
};

type AnalysisContext = {
  rootDir: string;
  manifest: CellFenceManifest;
  cellsById: Map<string, CellManifest>;
  packageToCell: Map<string, CellManifest>;
  packageRoots: Map<string, string>;
  pathAliases: PathAlias[];
};

const DEFAULT_MANIFEST_PATH = "cellfence.manifest.json";
const DEFAULT_BASELINE_PATH = "cellfence.baseline.json";
const SOURCE_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mts", ".cts", ".mjs", ".cjs"];
const IGNORED_DIRECTORIES = new Set([".git", "node_modules", "dist", "coverage", ".turbo"]);
const PRISMA_MODEL_SELECTOR_CACHE = new Map<string, Map<string, string>>();

type PathAlias = {
  pattern: string;
  targets: string[];
};

function normalizePath(filePath: string): string {
  return filePath.split(path.sep).join("/");
}

function repoPath(rootDir: string, filePath: string): string {
  return normalizePath(path.relative(rootDir, filePath));
}

function absolutePath(rootDir: string, relativePath: string): string {
  return path.resolve(rootDir, relativePath);
}

function readJsonFile(filePath: string): unknown {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function escapeRegExp(text: string): string {
  return text.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
}

function patternToRegExp(pattern: string): RegExp {
  const normalized = normalizePath(pattern);
  let expression = "";
  for (let index = 0; index < normalized.length; index += 1) {
    const character = normalized[index];
    const nextCharacter = normalized[index + 1];
    if (character === "*" && nextCharacter === "*") {
      expression += ".*";
      index += 1;
    } else if (character === "*") {
      expression += "[^/]*";
    } else {
      expression += escapeRegExp(character);
    }
  }
  return new RegExp(`^${expression}$`);
}

function matchesPattern(relativePath: string, pattern: string): boolean {
  return patternToRegExp(pattern).test(normalizePath(relativePath));
}

function literalPrefix(pattern: string): string {
  const normalized = normalizePath(pattern);
  const wildcardIndex = normalized.search(/[*?]/);
  const prefix = wildcardIndex === -1 ? normalized : normalized.slice(0, wildcardIndex);
  return prefix.replace(/\/+$/, "");
}

function addFinding(findings: Finding[], finding: Finding): void {
  findings.push(finding);
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
  const reason = reasonMatch?.[1]?.trim() || "";
  const errors: string[] = [];
  if (!/^CELLFENCE_[A-Z0-9_]+$/.test(ruleId)) errors.push("rule id must be a concrete CELLFENCE_* rule");
  if (!expires || !isIsoDate(expires)) errors.push("expires must be YYYY-MM-DD");
  if (!approvedBy) errors.push("approved-by is required");
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
  const files = new Set<string>();
  for (const cell of manifest.cells) {
    for (const sourceFile of sourceFilesForCell(rootDir, cell)) {
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

function listFiles(rootDir: string): string[] {
  const files: string[] = [];
  function visit(directoryPath: string): void {
    for (const entry of fs.readdirSync(directoryPath, { withFileTypes: true })) {
      if (entry.isDirectory() && IGNORED_DIRECTORIES.has(entry.name)) continue;
      const entryPath = path.join(directoryPath, entry.name);
      if (entry.isDirectory()) {
        visit(entryPath);
      } else if (entry.isFile()) {
        files.push(entryPath);
      }
    }
  }
  visit(rootDir);
  return files;
}

function sourceFilesForCell(rootDir: string, cell: CellManifest): string[] {
  return listFiles(rootDir).filter((filePath) => {
    const relativePath = repoPath(rootDir, filePath);
    return SOURCE_EXTENSIONS.includes(path.extname(filePath)) && cell.ownedPaths.some((pattern) => matchesPattern(relativePath, pattern));
  });
}

function findOwningCell(manifest: CellFenceManifest, relativePath: string): CellManifest | undefined {
  return manifest.cells.find((cell) => cell.ownedPaths.some((pattern) => matchesPattern(relativePath, pattern)));
}

function findPackageRoot(rootDir: string, publicEntry: string): string | undefined {
  let directoryPath = path.dirname(absolutePath(rootDir, publicEntry));
  while (directoryPath.startsWith(rootDir)) {
    if (fs.existsSync(path.join(directoryPath, "package.json"))) {
      return repoPath(rootDir, directoryPath);
    }
    const parentPath = path.dirname(directoryPath);
    if (parentPath === directoryPath) break;
    directoryPath = parentPath;
  }
  return undefined;
}

function readPathAliases(rootDir: string): PathAlias[] {
  const tsconfigPath = path.join(rootDir, "tsconfig.json");
  if (!fs.existsSync(tsconfigPath)) return [];
  const rawConfig = readJsonFile(tsconfigPath);
  if (typeof rawConfig !== "object" || rawConfig === null || Array.isArray(rawConfig)) return [];
  const compilerOptions = (rawConfig as { compilerOptions?: unknown }).compilerOptions;
  if (typeof compilerOptions !== "object" || compilerOptions === null || Array.isArray(compilerOptions)) return [];
  const options = compilerOptions as { baseUrl?: unknown; paths?: unknown };
  if (typeof options.paths !== "object" || options.paths === null || Array.isArray(options.paths)) return [];
  const baseUrl = typeof options.baseUrl === "string" ? options.baseUrl : ".";
  const aliases: PathAlias[] = [];
  for (const [pattern, targets] of Object.entries(options.paths)) {
    if (!Array.isArray(targets)) continue;
    const normalizedTargets = targets
      .filter((target): target is string => typeof target === "string" && target.trim().length > 0)
      .map((target) => normalizePath(path.resolve(rootDir, baseUrl, target)));
    if (normalizedTargets.length > 0) aliases.push({ pattern, targets: normalizedTargets });
  }
  return aliases;
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
  return { rootDir, manifest, cellsById, packageToCell, packageRoots, pathAliases: readPathAliases(rootDir) };
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

function sourceKindForPath(filePath: string): ts.ScriptKind {
  const extension = path.extname(filePath);
  if (extension === ".tsx") return ts.ScriptKind.TSX;
  if (extension === ".jsx") return ts.ScriptKind.JSX;
  if (extension === ".js" || extension === ".mjs" || extension === ".cjs") return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

function getLineNumber(sourceFile: ts.SourceFile, node: ts.Node): number {
  return sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
}

function expressionName(expression: ts.Expression): string | undefined {
  if (ts.isIdentifier(expression)) return expression.text;
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text;
  return undefined;
}

function literalText(node: ts.Node | undefined): string | undefined {
  if (!node) return undefined;
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  return undefined;
}

function lowerFirst(text: string): string {
  return text.length === 0 ? text : `${text[0].toLowerCase()}${text.slice(1)}`;
}

function expressionRootName(expression: ts.Expression): string | undefined {
  if (ts.isIdentifier(expression)) return expression.text;
  if (ts.isPropertyAccessExpression(expression)) return expressionRootName(expression.expression);
  return undefined;
}

function propertyName(expression: ts.Expression): string | undefined {
  return ts.isPropertyAccessExpression(expression) ? expression.name.text : undefined;
}

function objectStringProperty(expression: ts.Expression | undefined, propertyNameText: string): string | undefined {
  if (!expression || !ts.isObjectLiteralExpression(expression)) return undefined;
  for (const property of expression.properties) {
    if (!ts.isPropertyAssignment(property)) continue;
    const name = property.name;
    const isMatch = (ts.isIdentifier(name) && name.text === propertyNameText)
      || (ts.isStringLiteral(name) && name.text === propertyNameText);
    if (isMatch) return literalText(property.initializer);
  }
  return undefined;
}

function templateLiteralText(node: ts.TemplateLiteral): string | undefined {
  if (ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  return undefined;
}

function expressionContainsSqlLiteral(node: ts.Node): boolean {
  let found = false;
  function visit(candidate: ts.Node): void {
    if (found) return;
    const text = literalText(candidate);
    if (text && /\b(select|insert|update|delete|from|join|into)\b/i.test(text)) {
      found = true;
      return;
    }
    ts.forEachChild(candidate, visit);
  }
  visit(node);
  return found;
}

const PRISMA_READ_METHODS = new Set(["findMany", "findFirst", "findUnique", "count", "aggregate", "groupBy"]);
const PRISMA_WRITE_METHODS = new Set(["create", "createMany", "update", "updateMany", "upsert", "delete", "deleteMany"]);
const TYPEORM_READ_METHODS = new Set(["find", "findBy", "findOne", "findOneBy", "count", "countBy", "exist"]);
const TYPEORM_WRITE_METHODS = new Set(["save", "insert", "update", "upsert", "delete", "remove", "softDelete", "restore"]);
const QUERY_BUILDER_READ_METHODS = new Set(["selectFrom", "from"]);
const QUERY_BUILDER_WRITE_METHODS = new Set(["insertInto", "updateTable", "deleteFrom", "into", "update"]);
const RAW_SQL_METHODS = new Set(["$queryRaw", "$executeRaw", "query"]);
const UNSAFE_RAW_SQL_METHODS = new Set(["$queryRawUnsafe", "$executeRawUnsafe"]);
const FILE_READ_METHODS = new Set(["readFile", "readFileSync", "createReadStream", "readdir", "readdirSync"]);
const FILE_WRITE_METHODS = new Set(["writeFile", "writeFileSync", "appendFile", "appendFileSync", "createWriteStream"]);

function resourceAccessSource(source: string, detectedBy = source, confidence: "high" | "medium" | "low" | "runtime" = "high"): Pick<ResourceAccessReference, "source" | "detectedBy" | "confidence"> {
  return { source, detectedBy, confidence };
}

function addResourceAccess(accesses: ResourceAccessReference[], access: ResourceAccessReference): void {
  const duplicate = accesses.some((candidate) =>
    candidate.kind === access.kind
    && candidate.access === access.access
    && candidate.selector === access.selector
    && candidate.filePath === access.filePath
    && candidate.line === access.line
  );
  if (!duplicate) accesses.push(access);
}

function sqlTableAccesses(text: string): Array<{ access: "read" | "write"; selector: string }> {
  const accesses: Array<{ access: "read" | "write"; selector: string }> = [];
  const sqlPattern = /\b(from|join|into|update)\s+([A-Za-z_][A-Za-z0-9_.$"]*)/gi;
  let match: RegExpExecArray | null;
  while ((match = sqlPattern.exec(text)) !== null) {
    const verb = match[1].toLowerCase();
    const selector = match[2].replace(/"/g, "");
    accesses.push({ access: verb === "into" || verb === "update" ? "write" : "read", selector });
  }
  return accesses;
}

function prismaModelSelectors(rootDir: string): Map<string, string> {
  const cachedSelectors = PRISMA_MODEL_SELECTOR_CACHE.get(rootDir);
  if (cachedSelectors) return cachedSelectors;
  const selectors = new Map<string, string>();
  for (const filePath of listFiles(rootDir)) {
    if (path.basename(filePath) !== "schema.prisma") continue;
    const schemaText = fs.readFileSync(filePath, "utf8");
    const modelPattern = /model\s+([A-Za-z_][A-Za-z0-9_]*)\s+\{([\s\S]*?)\n\}/g;
    let match: RegExpExecArray | null;
    while ((match = modelPattern.exec(schemaText)) !== null) {
      const modelName = match[1];
      const modelBody = match[2];
      const mappedTable = /@@map\(\s*"([^"]+)"\s*\)/.exec(modelBody)?.[1];
      selectors.set(lowerFirst(modelName), mappedTable || modelName);
    }
  }
  PRISMA_MODEL_SELECTOR_CACHE.set(rootDir, selectors);
  return selectors;
}

function collectPrismaClientNames(sourceFile: ts.SourceFile): Set<string> {
  const names = new Set<string>(["prisma"]);
  function visit(node: ts.Node): void {
    if (
      ts.isVariableDeclaration(node)
      && ts.isIdentifier(node.name)
      && node.initializer
      && ts.isNewExpression(node.initializer)
      && expressionName(node.initializer.expression) === "PrismaClient"
    ) {
      names.add(node.name.text);
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return names;
}

function selectorFromEntityExpression(expression: ts.Expression | undefined, entitySelectors: Map<string, string>, options: { allowUnknownIdentifier: boolean }): string | undefined {
  const literalSelector = literalText(expression);
  if (literalSelector) return literalSelector;
  if (expression && ts.isIdentifier(expression)) return entitySelectors.get(expression.text) || (options.allowUnknownIdentifier ? expression.text : undefined);
  return undefined;
}

function decoratorsForNode(node: ts.Node): readonly ts.Decorator[] {
  return ts.canHaveDecorators(node) ? ts.getDecorators(node) || [] : [];
}

function collectTypeOrmEntitySelectors(sourceFile: ts.SourceFile): Map<string, string> {
  const selectors = new Map<string, string>();
  function visit(node: ts.Node): void {
    if (ts.isClassDeclaration(node) && node.name) {
      for (const decorator of decoratorsForNode(node)) {
        const expression = decorator.expression;
        if (!ts.isCallExpression(expression) || expressionName(expression.expression) !== "Entity") continue;
      const explicitName = literalText(expression.arguments[0]) || objectStringProperty(expression.arguments[0], "name");
        selectors.set(node.name.text, explicitName || node.name.text);
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return selectors;
}

function collectTypeOrmRepositoryVariables(sourceFile: ts.SourceFile, entitySelectors: Map<string, string>): Map<string, string> {
  const repositories = new Map<string, string>();
  function visit(node: ts.Node): void {
    if (
      ts.isVariableDeclaration(node)
      && ts.isIdentifier(node.name)
      && node.initializer
      && ts.isCallExpression(node.initializer)
      && expressionName(node.initializer.expression) === "getRepository"
    ) {
      const selector = selectorFromEntityExpression(node.initializer.arguments[0], entitySelectors, { allowUnknownIdentifier: true });
      if (selector) repositories.set(node.name.text, selector);
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return repositories;
}

function typeOrmRepositorySelector(expression: ts.Expression, repositoryVariables: Map<string, string>, entitySelectors: Map<string, string>): string | undefined {
  if (ts.isIdentifier(expression)) return repositoryVariables.get(expression.text);
  if (ts.isCallExpression(expression) && expressionName(expression.expression) === "getRepository") {
    return selectorFromEntityExpression(expression.arguments[0], entitySelectors, { allowUnknownIdentifier: true });
  }
  return undefined;
}

function collectBullQueueVariables(sourceFile: ts.SourceFile): Map<string, string> {
  const queueVariables = new Map<string, string>();
  function visit(node: ts.Node): void {
    if (
      ts.isVariableDeclaration(node)
      && ts.isIdentifier(node.name)
      && node.initializer
      && ts.isNewExpression(node.initializer)
      && expressionName(node.initializer.expression) === "Queue"
    ) {
      const queueName = literalText(node.initializer.arguments?.[0]);
      if (queueName) queueVariables.set(node.name.text, `bullmq:${queueName}`);
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return queueVariables;
}

function collectDynamicSqlVariables(sourceFile: ts.SourceFile): Set<string> {
  const dynamicSqlVariables = new Set<string>();
  function visit(node: ts.Node): void {
    if (
      ts.isVariableDeclaration(node)
      && ts.isIdentifier(node.name)
      && node.initializer
      && !literalText(node.initializer)
      && expressionContainsSqlLiteral(node.initializer)
    ) {
      dynamicSqlVariables.add(node.name.text);
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return dynamicSqlVariables;
}

function chainContainsMethod(expression: ts.Expression, methodName: string): boolean {
  let current: ts.Expression | undefined = expression;
  while (current) {
    if (ts.isCallExpression(current)) {
      const currentMethodName = propertyName(current.expression) || expressionName(current.expression);
      if (currentMethodName === methodName) return true;
      if (ts.isPropertyAccessExpression(current.expression)) {
        current = current.expression.expression;
      } else {
        break;
      }
    } else if (ts.isPropertyAccessExpression(current)) {
      if (current.name.text === methodName) return true;
      current = current.expression;
    } else {
      break;
    }
  }
  return false;
}

function queueAccessMode(name: string): "publish" | "subscribe" | undefined {
  const lowered = name.toLowerCase();
  if (/(?:publish|enqueue|emitevent|sendmessage)$/.test(lowered)) return "publish";
  if (/(?:subscribe|consume|dequeue|receivemessage)$/.test(lowered)) return "subscribe";
  return undefined;
}

function collectResourceAccesses(rootDir: string, filePath: string): ResourceAccessReference[] {
  const sourceText = fs.readFileSync(filePath, "utf8");
  const sourceFile = ts.createSourceFile(filePath, sourceText, ts.ScriptTarget.Latest, true, sourceKindForPath(filePath));
  const relativeFilePath = repoPath(rootDir, filePath);
  const accesses: ResourceAccessReference[] = [];
  const prismaSelectors = prismaModelSelectors(rootDir);
  const prismaClientNames = collectPrismaClientNames(sourceFile);
  const typeOrmEntitySelectors = collectTypeOrmEntitySelectors(sourceFile);
  const typeOrmRepositories = collectTypeOrmRepositoryVariables(sourceFile, typeOrmEntitySelectors);
  const bullQueuesByVariable = collectBullQueueVariables(sourceFile);
  const dynamicSqlVariables = collectDynamicSqlVariables(sourceFile);

  function visit(node: ts.Node): void {
    if (ts.isTaggedTemplateExpression(node) && ts.isPropertyAccessExpression(node.tag)) {
      const methodName = node.tag.name.text;
      const rootName = expressionRootName(node.tag.expression);
      if (rootName && prismaClientNames.has(rootName) && (RAW_SQL_METHODS.has(methodName) || UNSAFE_RAW_SQL_METHODS.has(methodName))) {
        const templateText = templateLiteralText(node.template);
        if (UNSAFE_RAW_SQL_METHODS.has(methodName) || templateText === undefined) {
          addResourceAccess(accesses, {
            kind: "database",
            access: "read",
            selector: "unresolved:dynamic-sql",
            filePath: relativeFilePath,
            line: getLineNumber(sourceFile, node),
            unresolved: true,
            reason: UNSAFE_RAW_SQL_METHODS.has(methodName) ? "unsafe raw SQL call" : "raw SQL template contains dynamic interpolation",
            ...resourceAccessSource(methodName, "prisma-adapter", "low"),
          });
        } else {
          for (const sqlAccess of sqlTableAccesses(templateText)) {
            addResourceAccess(accesses, {
              kind: "database",
              access: sqlAccess.access,
              selector: sqlAccess.selector,
              filePath: relativeFilePath,
              line: getLineNumber(sourceFile, node),
              ...resourceAccessSource(methodName, "prisma-adapter", "medium"),
            });
          }
        }
      }
    }

    if (ts.isCallExpression(node)) {
      const name = expressionName(node.expression);
      const firstArgumentText = literalText(node.arguments[0]);
      const methodName = propertyName(node.expression);
      const rootName = ts.isPropertyAccessExpression(node.expression) ? expressionRootName(node.expression.expression) : undefined;

      if (ts.isPropertyAccessExpression(node.expression) && methodName) {
        const typeOrmRepository = typeOrmRepositorySelector(node.expression.expression, typeOrmRepositories, typeOrmEntitySelectors);
        const typeOrmAccess = TYPEORM_READ_METHODS.has(methodName) ? "read" : TYPEORM_WRITE_METHODS.has(methodName) ? "write" : undefined;
        if (typeOrmRepository && typeOrmAccess) {
          addResourceAccess(accesses, {
            kind: "database",
            access: typeOrmAccess,
            selector: typeOrmRepository,
            filePath: relativeFilePath,
            line: getLineNumber(sourceFile, node),
            ...resourceAccessSource(methodName, "typeorm-adapter", typeOrmEntitySelectors.size > 0 ? "high" : "medium"),
          });
        }

        const isGenericQueryBuilderMethod = ["selectFrom", "insertInto", "updateTable", "deleteFrom"].includes(methodName);
        const isTypeOrmQueryBuilderMethod = ["from", "into", "update"].includes(methodName)
          && (chainContainsMethod(node.expression.expression, "createQueryBuilder")
            || chainContainsMethod(node.expression.expression, "delete")
            || chainContainsMethod(node.expression.expression, "insert")
            || chainContainsMethod(node.expression.expression, "update"));
        const queryBuilderAccess = (isGenericQueryBuilderMethod || isTypeOrmQueryBuilderMethod) && QUERY_BUILDER_WRITE_METHODS.has(methodName)
          ? "write"
          : (isGenericQueryBuilderMethod || isTypeOrmQueryBuilderMethod) && QUERY_BUILDER_READ_METHODS.has(methodName)
            ? (methodName === "from" && chainContainsMethod(node.expression.expression, "delete") ? "write" : "read")
            : undefined;
        if (queryBuilderAccess) {
          const selector = selectorFromEntityExpression(node.arguments[0], typeOrmEntitySelectors, { allowUnknownIdentifier: false });
          if (selector) {
            addResourceAccess(accesses, {
              kind: "database",
              access: queryBuilderAccess,
              selector,
              filePath: relativeFilePath,
              line: getLineNumber(sourceFile, node),
              ...resourceAccessSource(methodName, isGenericQueryBuilderMethod ? "query-builder-adapter" : "typeorm-adapter", typeOrmEntitySelectors.has(selector) ? "high" : "medium"),
            });
          } else if (node.arguments.length > 0) {
            addResourceAccess(accesses, {
              kind: "database",
              access: queryBuilderAccess,
              selector: "unresolved:dynamic-query-builder-table",
              filePath: relativeFilePath,
              line: getLineNumber(sourceFile, node),
              unresolved: true,
              reason: `${methodName} table argument is not a static literal or known entity`,
              ...resourceAccessSource(methodName, isGenericQueryBuilderMethod ? "query-builder-adapter" : "typeorm-adapter", "low"),
            });
          }
        }

        if (rootName && prismaClientNames.has(rootName) && ts.isPropertyAccessExpression(node.expression.expression)) {
          const delegateName = node.expression.expression.name.text;
          const selector = prismaSelectors.get(delegateName) || `prisma.${delegateName}`;
          const access = PRISMA_READ_METHODS.has(methodName) ? "read" : PRISMA_WRITE_METHODS.has(methodName) ? "write" : undefined;
          if (access) {
            addResourceAccess(accesses, {
              kind: "database",
              access,
              selector,
              filePath: relativeFilePath,
              line: getLineNumber(sourceFile, node),
              ...resourceAccessSource(methodName, "prisma-adapter", prismaSelectors.has(delegateName) ? "high" : "medium"),
            });
          }
        }

        if (rootName && prismaClientNames.has(rootName) && (RAW_SQL_METHODS.has(methodName) || UNSAFE_RAW_SQL_METHODS.has(methodName))) {
          if (UNSAFE_RAW_SQL_METHODS.has(methodName)) {
            addResourceAccess(accesses, {
              kind: "database",
              access: "read",
              selector: "unresolved:dynamic-sql",
              filePath: relativeFilePath,
              line: getLineNumber(sourceFile, node),
              unresolved: true,
              reason: "unsafe raw SQL call",
              ...resourceAccessSource(methodName, "prisma-adapter", "low"),
            });
          } else if (firstArgumentText) {
            for (const sqlAccess of sqlTableAccesses(firstArgumentText)) {
              addResourceAccess(accesses, {
                kind: "database",
                access: sqlAccess.access,
                selector: sqlAccess.selector,
                filePath: relativeFilePath,
                line: getLineNumber(sourceFile, node),
                ...resourceAccessSource(methodName, "prisma-adapter", "medium"),
              });
            }
          } else {
            addResourceAccess(accesses, {
              kind: "database",
              access: "read",
              selector: "unresolved:dynamic-sql",
              filePath: relativeFilePath,
              line: getLineNumber(sourceFile, node),
              unresolved: true,
              reason: "raw SQL argument is not a static literal",
              ...resourceAccessSource(methodName, "prisma-adapter", "low"),
            });
          }
        } else if (methodName === "query") {
          if (firstArgumentText) {
            for (const sqlAccess of sqlTableAccesses(firstArgumentText)) {
              addResourceAccess(accesses, {
                kind: "database",
                access: sqlAccess.access,
                selector: sqlAccess.selector,
                filePath: relativeFilePath,
                line: getLineNumber(sourceFile, node),
                ...resourceAccessSource(methodName, "sql-literal", "medium"),
              });
            }
          } else if (expressionContainsSqlLiteral(node.arguments[0]) || (ts.isIdentifier(node.arguments[0]) && dynamicSqlVariables.has(node.arguments[0].text))) {
            addResourceAccess(accesses, {
              kind: "database",
              access: "read",
              selector: "unresolved:dynamic-sql",
              filePath: relativeFilePath,
              line: getLineNumber(sourceFile, node),
              unresolved: true,
              reason: "SQL query is assembled dynamically",
              ...resourceAccessSource(methodName, "sql-literal", "low"),
            });
          }
        }

        if (methodName === "add" && ts.isPropertyAccessExpression(node.expression)) {
          const queueSelector = expressionRootName(node.expression.expression);
          if (queueSelector && bullQueuesByVariable.has(queueSelector)) {
            addResourceAccess(accesses, {
              kind: "queue",
              access: "publish",
              selector: bullQueuesByVariable.get(queueSelector) || queueSelector,
              filePath: relativeFilePath,
              line: getLineNumber(sourceFile, node),
              ...resourceAccessSource(methodName, "bullmq-adapter", "high"),
            });
          }
        }

        if (methodName === "send") {
          const topic = objectStringProperty(node.arguments[0], "topic");
          if (topic) {
            addResourceAccess(accesses, {
              kind: "queue",
              access: "publish",
              selector: `kafka:${topic}`,
              filePath: relativeFilePath,
              line: getLineNumber(sourceFile, node),
              ...resourceAccessSource(methodName, "kafkajs-adapter", "medium"),
            });
          }
        } else if (methodName === "subscribe") {
          const topic = objectStringProperty(node.arguments[0], "topic");
          if (topic) {
            addResourceAccess(accesses, {
              kind: "queue",
              access: "subscribe",
              selector: `kafka:${topic}`,
              filePath: relativeFilePath,
              line: getLineNumber(sourceFile, node),
              ...resourceAccessSource(methodName, "kafkajs-adapter", "medium"),
            });
          }
        }
      }

      if (name && (FILE_READ_METHODS.has(name) || FILE_WRITE_METHODS.has(name)) && !firstArgumentText && node.arguments.length > 0) {
        addResourceAccess(accesses, {
          kind: "file",
          access: FILE_READ_METHODS.has(name) ? "read" : "write",
          selector: "unresolved:dynamic-file-path",
          filePath: relativeFilePath,
          line: getLineNumber(sourceFile, node),
          unresolved: true,
          reason: "file path argument is not a static literal",
          ...resourceAccessSource(name, "file-call", "low"),
        });
      }

      if (name && firstArgumentText) {
        if (FILE_READ_METHODS.has(name)) {
          addResourceAccess(accesses, {
            kind: "file",
            access: "read",
            selector: normalizePath(firstArgumentText),
            filePath: relativeFilePath,
            line: getLineNumber(sourceFile, node),
            ...resourceAccessSource(name),
          });
        } else if (FILE_WRITE_METHODS.has(name)) {
          addResourceAccess(accesses, {
            kind: "file",
            access: "write",
            selector: normalizePath(firstArgumentText),
            filePath: relativeFilePath,
            line: getLineNumber(sourceFile, node),
            ...resourceAccessSource(name),
          });
        } else if ((name === "fetch" || name === "request") && /^https?:\/\//.test(firstArgumentText)) {
          addResourceAccess(accesses, {
            kind: "http",
            access: "call",
            selector: firstArgumentText,
            filePath: relativeFilePath,
            line: getLineNumber(sourceFile, node),
            ...resourceAccessSource(name),
          });
        } else if (["get", "post", "put", "patch", "delete"].includes(name) && firstArgumentText.startsWith("/")) {
          addResourceAccess(accesses, {
            kind: "http",
            access: "serve",
            selector: `${name.toUpperCase()} ${firstArgumentText}`,
            filePath: relativeFilePath,
            line: getLineNumber(sourceFile, node),
            ...resourceAccessSource(name),
          });
        }

        const queueMode = queueAccessMode(name);
        if (queueMode && !firstArgumentText.startsWith("/") && !/^https?:\/\//.test(firstArgumentText)) {
          addResourceAccess(accesses, {
            kind: "queue",
            access: queueMode,
            selector: firstArgumentText,
            filePath: relativeFilePath,
            line: getLineNumber(sourceFile, node),
            ...resourceAccessSource(name),
          });
        }
      }
    }

    if (ts.isNewExpression(node) && expressionName(node.expression) === "Worker") {
      const queueName = literalText(node.arguments?.[0]);
      if (queueName) {
        addResourceAccess(accesses, {
          kind: "queue",
          access: "subscribe",
          selector: `bullmq:${queueName}`,
          filePath: relativeFilePath,
          line: getLineNumber(sourceFile, node),
          ...resourceAccessSource("Worker", "bullmq-adapter", "high"),
        });
      }
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return accesses;
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
    for (const sourceFilePath of sourceFilesForCell(context.rootDir, cell)) {
      for (const access of collectResourceAccesses(context.rootDir, sourceFilePath)) {
        if (access.unresolved) {
          const severity: Severity = access.kind === "file" ? "warning" : "error";
          addFinding(severity === "warning" ? warnings : findings, {
            ruleId: "CELLFENCE_UNRESOLVED_RESOURCE_ACCESS",
            severity,
            cellId: cell.id,
            filePath: access.filePath,
            message: `${cell.id} has unresolved ${access.kind} resource access at line ${access.line}: ${access.reason || "resource access is not statically resolvable"}`,
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
        message: `failed to read resource evidence: ${error instanceof Error ? error.message : String(error)}`,
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

      const cell = context.cellsById.get(cellId);
      if (!cell) continue;
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

function extractImports(rootDir: string, filePath: string, warnings: Finding[]): ImportReference[] {
  const sourceText = fs.readFileSync(filePath, "utf8");
  const sourceFile = ts.createSourceFile(filePath, sourceText, ts.ScriptTarget.Latest, true, sourceKindForPath(filePath));
  const references: ImportReference[] = [];
  const importerPath = repoPath(rootDir, filePath);

  function addReference(specifier: string, kind: ImportKind, node: ts.Node, typeOnly: boolean): void {
    references.push({
      importerPath,
      specifier,
      kind,
      typeOnly,
      line: getLineNumber(sourceFile, node),
    });
  }

  function visit(node: ts.Node): void {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      addReference(node.moduleSpecifier.text, "import", node, Boolean(node.importClause?.isTypeOnly));
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      addReference(node.moduleSpecifier.text, "export-from", node, Boolean(node.isTypeOnly));
    } else if (
      ts.isCallExpression(node)
      && ts.isIdentifier(node.expression)
      && node.expression.text === "require"
      && node.arguments.length === 1
      && ts.isStringLiteral(node.arguments[0])
    ) {
      addReference(node.arguments[0].text, "require", node, false);
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const [specifierNode] = node.arguments;
      if (specifierNode && ts.isStringLiteral(specifierNode)) {
        addReference(specifierNode.text, "dynamic-import", node, false);
      } else {
        addFinding(warnings, {
          ruleId: "CELLFENCE_UNSUPPORTED_DYNAMIC_IMPORT",
          severity: "warning",
          filePath: importerPath,
          message: `computed dynamic import cannot be resolved statically at line ${getLineNumber(sourceFile, node)}`,
          details: { line: getLineNumber(sourceFile, node) },
        });
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return references;
}

function addUniquePath(candidates: string[], candidatePath: string): void {
  if (!candidates.includes(candidatePath)) candidates.push(candidatePath);
}

function sourceExtensionsForRuntimeSpecifier(extension: string): string[] {
  if (extension === ".js") return [".ts", ".tsx", ".js", ".jsx"];
  if (extension === ".jsx") return [".tsx", ".jsx"];
  if (extension === ".mjs") return [".mts", ".mjs"];
  if (extension === ".cjs") return [".cts", ".cjs"];
  return [];
}

function candidateModulePaths(basePath: string): string[] {
  const candidates: string[] = [];
  const extension = path.extname(basePath);
  addUniquePath(candidates, basePath);
  if (extension) {
    const basePathWithoutExtension = basePath.slice(0, -extension.length);
    for (const sourceExtension of sourceExtensionsForRuntimeSpecifier(extension)) {
      addUniquePath(candidates, `${basePathWithoutExtension}${sourceExtension}`);
    }
    return candidates;
  }
  for (const sourceExtension of SOURCE_EXTENSIONS) {
    addUniquePath(candidates, `${basePath}${sourceExtension}`);
  }
  for (const sourceExtension of SOURCE_EXTENSIONS) {
    addUniquePath(candidates, path.join(basePath, `index${sourceExtension}`));
  }
  return candidates;
}

function resolveRelativeImport(context: AnalysisContext, importerPath: string, specifier: string): string | undefined {
  const importerAbsolutePath = absolutePath(context.rootDir, importerPath);
  const basePath = path.resolve(path.dirname(importerAbsolutePath), specifier);
  for (const candidatePath of candidateModulePaths(basePath)) {
    if (fs.existsSync(candidatePath) && fs.statSync(candidatePath).isFile()) {
      return repoPath(context.rootDir, candidatePath);
    }
  }
  return undefined;
}

function resolvePathAliasTarget(context: AnalysisContext, specifier: string): string | undefined {
  for (const alias of context.pathAliases) {
    const wildcardIndex = alias.pattern.indexOf("*");
    let wildcardValue = "";
    if (wildcardIndex === -1) {
      if (alias.pattern !== specifier) continue;
    } else {
      const prefix = alias.pattern.slice(0, wildcardIndex);
      const suffix = alias.pattern.slice(wildcardIndex + 1);
      if (!specifier.startsWith(prefix) || !specifier.endsWith(suffix)) continue;
      wildcardValue = specifier.slice(prefix.length, specifier.length - suffix.length);
    }

    for (const target of alias.targets) {
      const targetWildcardIndex = target.indexOf("*");
      const baseTarget = targetWildcardIndex === -1
        ? target
        : `${target.slice(0, targetWildcardIndex)}${wildcardValue}${target.slice(targetWildcardIndex + 1)}`;
      for (const candidatePath of candidateModulePaths(baseTarget)) {
        if (fs.existsSync(candidatePath) && fs.statSync(candidatePath).isFile()) {
          return repoPath(context.rootDir, candidatePath);
        }
      }
    }
  }
  return undefined;
}

function findArtifactLaneForPath(cell: CellManifest, relativePath: string): string | undefined {
  for (const lane of cell.producesArtifacts || []) {
    if (lane.paths.some((pattern) => matchesPattern(relativePath, pattern))) return lane.id;
  }
  return undefined;
}

function resolveImport(context: AnalysisContext, reference: ImportReference): ResolvedImport {
  if (reference.specifier.startsWith(".") || reference.specifier.startsWith("/")) {
    const targetPath = resolveRelativeImport(context, reference.importerPath, reference.specifier);
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
  return (cell.consumes || []).find((consumer) => consumer.cell === producerCellId);
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

function exportedNameFromDeclarationName(name: ts.DeclarationName | undefined): string | undefined {
  if (!name) return undefined;
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name.text;
  return undefined;
}

function resolveLocalModuleFile(fromFilePath: string, specifier: string): string | undefined {
  if (!specifier.startsWith(".") && !specifier.startsWith("/")) return undefined;
  const basePath = path.resolve(path.dirname(fromFilePath), specifier);
  for (const candidatePath of candidateModulePaths(basePath)) {
    if (fs.existsSync(candidatePath) && fs.statSync(candidatePath).isFile()) return candidatePath;
  }
  return undefined;
}

function extractPublicSymbols(filePath: string, visitedFiles = new Set<string>()): Set<string> {
  const normalizedFilePath = path.resolve(filePath);
  if (visitedFiles.has(normalizedFilePath)) return new Set<string>();
  visitedFiles.add(normalizedFilePath);
  const sourceText = fs.readFileSync(filePath, "utf8");
  const sourceFile = ts.createSourceFile(filePath, sourceText, ts.ScriptTarget.Latest, true, sourceKindForPath(filePath));
  const symbols = new Set<string>();

  function hasExportModifier(node: ts.Node): boolean {
    return Boolean(ts.getCombinedModifierFlags(node as ts.Declaration) & ts.ModifierFlags.Export);
  }

  function visit(node: ts.Node): void {
    if ((ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node) || ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node) || ts.isEnumDeclaration(node)) && hasExportModifier(node)) {
      if (ts.getCombinedModifierFlags(node as ts.Declaration) & ts.ModifierFlags.Default) {
        symbols.add("default");
      } else {
        const exportedName = exportedNameFromDeclarationName(node.name);
        if (exportedName) symbols.add(exportedName);
      }
    } else if (ts.isVariableStatement(node) && hasExportModifier(node)) {
      for (const declaration of node.declarationList.declarations) {
        const exportedName = exportedNameFromDeclarationName(declaration.name);
        if (exportedName) symbols.add(exportedName);
      }
    } else if (ts.isExportAssignment(node)) {
      symbols.add("default");
    } else if (ts.isExportDeclaration(node)) {
      if (node.exportClause && ts.isNamedExports(node.exportClause)) {
        for (const element of node.exportClause.elements) {
          symbols.add(element.name.text);
        }
      } else if (node.exportClause && ts.isNamespaceExport(node.exportClause)) {
        symbols.add(node.exportClause.name.text);
      } else if (!node.exportClause && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
        const targetFilePath = resolveLocalModuleFile(filePath, node.moduleSpecifier.text);
        if (targetFilePath) {
          for (const exportedSymbol of extractPublicSymbols(targetFilePath, visitedFiles)) {
            if (exportedSymbol !== "default") symbols.add(exportedSymbol);
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return symbols;
}

function validateImports(context: AnalysisContext, findings: Finding[], warnings: Finding[]): Map<string, Set<string>> {
  const crossCellDependencies = new Map<string, Set<string>>();
  for (const importerCell of context.manifest.cells) {
    for (const sourceFilePath of sourceFilesForCell(context.rootDir, importerCell)) {
      const references = extractImports(context.rootDir, sourceFilePath, warnings);
      for (const reference of references) {
        const resolvedImport = resolveImport(context, reference);
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

        const targetIsPublicEntry = normalizePath(resolvedImport.targetPath || "") === normalizePath(producerCell.publicEntry);
        if (!targetIsPublicEntry || (!resolvedImport.isPublicPackage && reference.specifier.includes("/src/"))) {
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

function computeMetrics(
  context: AnalysisContext,
  crossCellDependencies: Map<string, Set<string>>,
  accessesByCell: Map<string, ResourceAccessReference[]>,
): Record<string, CellBaselineRecord> {
  const metrics: Record<string, CellBaselineRecord> = {};
  for (const cell of context.manifest.cells) {
    metrics[cell.id] = {
      ownedPathPatterns: cell.ownedPaths.length,
      publicSymbols: cell.publicSymbols.length,
      publicSurfaceLines: countLines(absolutePath(context.rootDir, cell.publicEntry)),
      crossCellDependencies: crossCellDependencies.get(cell.id)?.size || 0,
      resourceAccesses: sortedResourceBaselineEntries(accessesByCell.get(cell.id) || []),
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
  for (const [cellId, metric] of Object.entries(metrics)) {
    const locked = Boolean(context.cellsById.get(cellId)?.locked);
    const baselineRecord = baseline.cells[cellId];
    if (!baselineRecord) continue;
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
    if (metric.publicSurfaceLines > baselineRecord.publicSurfaceLines) {
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
    return manifestInvalidResult(`failed to read manifest ${repoPath(rootDir, manifestPath)}: ${error instanceof Error ? error.message : String(error)}`);
  }

  const manifestValidation = validateManifest(rawManifest);
  if (!manifestValidation.ok || !manifestValidation.value) {
    return manifestInvalidResult(manifestValidation.errors.join("; "));
  }

  const findings: Finding[] = [];
  const warnings: Finding[] = [];
  const manifest = manifestValidation.value;
  const context = createContext(rootDir, manifest);
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
      }
    } catch (error) {
      addFinding(findings, {
        ruleId: "CELLFENCE_MANIFEST_INVALID",
        severity: "error",
        message: `failed to read baseline ${repoPath(rootDir, baselinePath)}: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }

  validateDuplicateCellIds(manifest, findings);
  validateOwnershipOverlap(manifest, findings);
  validatePublicEntries(context, findings);
  const crossCellDependencies = validateImports(context, findings, warnings);
  const accessesByCell = validateResourceAccesses(context, findings, warnings, baseline);
  mergeAccessesByCell(
    accessesByCell,
    resourceEvidenceAccesses(context, evidencePathsForOptions(rootDir, options.evidencePaths), findings, baseline),
  );
  const metrics = computeMetrics(context, crossCellDependencies, accessesByCell);

  if (baseline) {
    compareBaseline(context, metrics, baseline, findings);
  }

  const active = applyWaiversToFindings(context, findings, warnings);
  const hasErrors = active.findings.some((finding) => finding.severity === "error");
  return {
    ok: !hasErrors,
    exitCode: hasErrors ? 1 : 0,
    findings: active.findings,
    warnings: active.warnings,
    metrics,
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
    const message = stderr || (typeof failure.message === "string" ? failure.message : "git command failed");
    throw new Error(message);
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
  const evidencePaths = (options.evidencePaths || []).filter((evidencePath) => fs.existsSync(path.resolve(baseRootDir, evidencePath)));
  if (evidencePaths.length > 0) baseOptions.evidencePaths = evidencePaths;
  return baseOptions;
}

function findingKey(finding: Finding): string {
  return JSON.stringify({
    ruleId: finding.ruleId,
    severity: finding.severity,
    filePath: finding.filePath ? normalizePath(finding.filePath) : undefined,
    cellId: finding.cellId,
    producerCellId: finding.producerCellId,
    message: finding.message,
  });
}

export function checkChangedRepository(options: ChangedCheckOptions = {}): CheckResult {
  const rootDir = path.resolve(options.rootDir || process.cwd());
  const baseRef = options.baseRef || "origin/main";
  try {
    gitCommand(rootDir, ["rev-parse", "--is-inside-work-tree"]);
    const baseCommit = assertGitCommit(rootDir, baseRef);
    if (options.headRef) assertGitCommit(rootDir, options.headRef);
    const changedFiles = changedFilesForRefs(rootDir, baseRef, options.headRef);
    const currentResult = checkRepository(options);
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
    const findings = currentResult.findings.filter((finding) => !baseFindingKeys.has(findingKey(finding)));
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
    return gitMetadataFailure(`changed check requires git metadata and a valid base ref: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function createBaseline(options: CheckOptions = {}): CellFenceBaseline {
  const result = checkRepository({ ...options, baselinePath: undefined });
  if (result.exitCode === 2 || result.exitCode === 3) {
    throw new Error(result.findings.map((finding) => finding.message).join("; "));
  }
  return {
    schemaVersion: CELLFENCE_BASELINE_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
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
    if (!current || !previous) continue;

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
    const current = currentMetrics?.[metric] ?? 0;
    const manifestLimit = cell.budgets?.[metric];
    if (typeof manifestLimit === "number") {
      budgets[metric] = budgetEntry(current, manifestLimit, "manifest-budget");
    } else if (baselineRecord && typeof baselineRecord[metric] === "number") {
      budgets[metric] = budgetEntry(current, baselineRecord[metric], "baseline-ratchet");
    }
  }

  const allowedImports: ContextAllowedImport[] = (cell.consumes || []).flatMap((consumer) => {
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

export function writeBaselineFile(filePath: string, baseline: CellFenceBaseline): void {
  fs.writeFileSync(filePath, `${JSON.stringify(baseline, null, 2)}\n`);
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
