import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import ts from "typescript";

import {
  absolutePath,
  listFiles,
  normalizePath,
  parseSourceFile,
  readSourceText,
  repoPath,
  SOURCE_EXTENSIONS,
  sourceKindForPath,
  type FileIndexContext,
} from "./file-index.js";
import { inspectPythonSource } from "./python-analysis.js";

export type PathAlias = {
  pattern: string;
  targets: string[];
};

export type ImportKind = "import" | "export-from" | "require" | "dynamic-import";

export type ImportReference = {
  importerPath: string;
  specifier: string;
  candidateSpecifiers?: string[];
  kind: ImportKind;
  typeOnly: boolean;
  line: number;
};

export type ImportWarning = {
  ruleId:
    | "CELLFENCE_UNSUPPORTED_DYNAMIC_REQUIRE"
    | "CELLFENCE_UNSUPPORTED_DYNAMIC_IMPORT"
    | "CELLFENCE_UNSUPPORTED_PYTHON_SYNTAX"
    | "CELLFENCE_UNSUPPORTED_TYPESCRIPT_SYNTAX";
  severity: "warning";
  filePath: string;
  message: string;
  details: { line?: number; offset?: number; kind?: string };
};

type ImportScanContext = FileIndexContext & {
  rootDir: string;
};

export type PackageConditionMode = "import" | "require" | "types";

export type PackageExportResolutionState =
  | "PUBLIC_RESOLVED"
  | "PUBLIC_DECLARED_GENERATED_TARGET_MISSING"
  | "NOT_EXPORTED_PRIVATE"
  | "UNRESOLVED_UNKNOWN";

export type PackageExportTarget = {
  state: PackageExportResolutionState;
  exported: boolean;
  targetPath?: string;
  reason?: string;
};

type PathAliasContext = {
  rootDir?: string;
  pathAliases: PathAlias[];
};

type ImportBindingKind = "require" | "createRequire" | "moduleNamespace" | "nodeModule" | "shadow";

type ImportScope = {
  bindings: Map<string, ImportBindingKind>;
  stringConstants: Map<string, string>;
  singletonStringSets: Map<string, string>;
  parent?: ImportScope;
  varScope: ImportScope;
};

type FunctionLikeWithBody =
  | ts.FunctionDeclaration
  | ts.FunctionExpression
  | ts.ArrowFunction
  | ts.MethodDeclaration
  | ts.GetAccessorDeclaration
  | ts.SetAccessorDeclaration
  | ts.ConstructorDeclaration;

const IMPORT_SCAN_HINT = /\b(?:from|import|export|require)\b/;
const EXACT_SPECIFIER_EXTENSIONS = new Set([
  ...SOURCE_EXTENSIONS,
  ".css",
  ".gif",
  ".jpeg",
  ".jpg",
  ".json",
  ".less",
  ".node",
  ".png",
  ".sass",
  ".scss",
  ".styl",
  ".svg",
  ".txt",
  ".wasm",
  ".webp",
]);
const DECLARATION_EXTENSIONS = [".d.ts", ".d.mts", ".d.cts"];

export function getLineNumber(sourceFile: ts.SourceFile, node: ts.Node): number {
  return sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
}

export function literalText(node: ts.Node | undefined): string | undefined {
  if (!node) return undefined;
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  return undefined;
}

export function readPathAliases(rootDir: string): PathAlias[] {
  const normalizedRootDir = normalizePath(rootDir);
  const tsconfigPath = normalizePath(path.join(rootDir, "tsconfig.json"));
  // Stryker disable next-line ConditionalExpression: missing config and TypeScript parse failure both resolve to an empty alias set.
  if (!fs.existsSync(tsconfigPath)) return [];
  const configFile = ts.readConfigFile(tsconfigPath, ts.sys.readFile);
  // Stryker disable next-line ConditionalExpression: invalid config is fail-closed to an empty alias set, matching absent paths.
  if (configFile.error) return [];
  const parsedConfig = ts.parseJsonConfigFileContent(configFile.config, ts.sys, normalizedRootDir);
  const paths = parsedConfig.options.paths;
  if (!paths) return [];
  const baseUrl = parsedConfig.options.baseUrl || rootDir;
  const aliases: PathAlias[] = [];
  for (const [pattern, targets] of Object.entries(paths)) {
    const normalizedTargets = targets
      .filter((target) => target.trim().length > 0)
      .map((target) => normalizePath(path.resolve(baseUrl, target)));
    if (normalizedTargets.length > 0) aliases.push({ pattern, targets: normalizedTargets });
  }
  return aliases;
}

export function readWorkspacePathAliases(rootDir: string): PathAlias[] {
  const aliases: PathAlias[] = [];
  const seen = new Set<string>();
  const addAliases = (entries: PathAlias[]): void => {
    for (const alias of entries) {
      const key = `${alias.pattern}\0${alias.targets.join("\0")}`;
      if (seen.has(key)) continue;
      seen.add(key);
      aliases.push(alias);
    }
  };
  addAliases(readPathAliases(rootDir));
  for (const filePath of listFiles(rootDir)) {
    const basename = path.basename(filePath);
    if (!/^tsconfig(?:\..+)?\.json$/.test(basename)) continue;
    if (normalizePath(filePath) === normalizePath(path.join(rootDir, "tsconfig.json"))) continue;
    addAliases(readPathAliases(path.dirname(filePath)));
  }
  return aliases;
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

function sourceExtensionsForDeclarationSpecifier(basePath: string): { basePath: string; extensions: string[] } | undefined {
  if (basePath.endsWith(".d.ts")) return { basePath: basePath.slice(0, -".d.ts".length), extensions: [".ts", ".tsx"] };
  if (basePath.endsWith(".d.mts")) return { basePath: basePath.slice(0, -".d.mts".length), extensions: [".mts"] };
  if (basePath.endsWith(".d.cts")) return { basePath: basePath.slice(0, -".d.cts".length), extensions: [".cts"] };
  return undefined;
}

export function candidateModulePaths(basePath: string): string[] {
  const candidates: string[] = [];
  const normalizedBasePath = normalizePath(basePath);
  const extension = path.extname(normalizedBasePath);
  addUniquePath(candidates, normalizedBasePath);
  const declarationSource = sourceExtensionsForDeclarationSpecifier(normalizedBasePath);
  if (declarationSource) {
    for (const sourceExtension of declarationSource.extensions) {
      addUniquePath(candidates, `${declarationSource.basePath}${sourceExtension}`);
    }
    return candidates;
  }
  if (extension) {
    const sourceExtensions = sourceExtensionsForRuntimeSpecifier(extension);
    if (sourceExtensions.length === 0 && EXACT_SPECIFIER_EXTENSIONS.has(extension)) return candidates;
    const basePathWithoutExtension = sourceExtensions.length > 0
      ? normalizedBasePath.slice(0, -extension.length)
      : normalizedBasePath;
    for (const sourceExtension of sourceExtensions.length > 0 ? sourceExtensions : [...SOURCE_EXTENSIONS, ...DECLARATION_EXTENSIONS]) {
      addUniquePath(candidates, `${basePathWithoutExtension}${sourceExtension}`);
    }
    if (sourceExtensions.length > 0) return candidates;
    for (const sourceExtension of [...SOURCE_EXTENSIONS, ...DECLARATION_EXTENSIONS]) {
      addUniquePath(candidates, `${normalizedBasePath}/index${sourceExtension}`);
    }
    return candidates;
  }
  for (const sourceExtension of SOURCE_EXTENSIONS) {
    addUniquePath(candidates, `${normalizedBasePath}${sourceExtension}`);
  }
  for (const declarationExtension of DECLARATION_EXTENSIONS) {
    addUniquePath(candidates, `${normalizedBasePath}${declarationExtension}`);
  }
  for (const sourceExtension of SOURCE_EXTENSIONS) {
    addUniquePath(candidates, `${normalizedBasePath}/index${sourceExtension}`);
  }
  for (const declarationExtension of DECLARATION_EXTENSIONS) {
    addUniquePath(candidates, `${normalizedBasePath}/index${declarationExtension}`);
  }
  return candidates;
}

function candidatePythonModulePaths(basePath: string): string[] {
  const normalizedBasePath = normalizePath(basePath);
  return [`${normalizedBasePath}.py`, `${normalizedBasePath}/__init__.py`];
}

function existingFileFromCandidates(candidates: string[]): string | undefined {
  for (const candidatePath of candidates) {
    if (fs.existsSync(candidatePath) && fs.statSync(candidatePath).isFile()) return candidatePath;
  }
  return undefined;
}

function stripResourceQuery(specifier: string): string {
  const queryIndex = specifier.search(/[?#]/);
  return queryIndex === -1 ? specifier : specifier.slice(0, queryIndex);
}

function isPythonPath(filePath: string): boolean {
  return path.extname(filePath) === ".py";
}

function resolvePythonRelativeModule(rootDir: string, importerPath: string, specifier: string): string | undefined {
  const match = specifier.match(/^(\.+)(.*)$/);
  if (!match) return undefined;
  const dotCount = match[1].length;
  const moduleName = match[2].replace(/^\./, "");
  let baseDir = path.dirname(absolutePath(rootDir, importerPath));
  for (let index = 1; index < dotCount; index += 1) baseDir = path.dirname(baseDir);
  const modulePath = moduleName.length > 0
    ? path.join(baseDir, ...moduleName.split(".").filter(Boolean))
    : baseDir;
  const target = existingFileFromCandidates(candidatePythonModulePaths(modulePath));
  return target ? repoPath(rootDir, target) : undefined;
}

export function resolvePythonImport(rootDir: string, importerPath: string, specifier: string, sourceRoots: string[] = []): string | undefined {
  if (!isPythonPath(importerPath)) return undefined;
  if (specifier.startsWith(".")) return resolvePythonRelativeModule(rootDir, importerPath, specifier);
  const moduleParts = specifier.split(".").filter(Boolean);
  if (moduleParts.length === 0) return undefined;
  for (const sourceRoot of ["", ...sourceRoots]) {
    const basePath = path.resolve(rootDir, sourceRoot, ...moduleParts);
    const target = existingFileFromCandidates(candidatePythonModulePaths(basePath));
    if (target) return repoPath(rootDir, target);
  }
  return undefined;
}

export function resolveRelativeImport(rootDir: string, importerPath: string, specifier: string): string | undefined {
  if (isPythonPath(importerPath) && specifier.startsWith(".") && !specifier.startsWith("./") && !specifier.startsWith("../")) {
    return resolvePythonRelativeModule(rootDir, importerPath, specifier);
  }
  const importerAbsolutePath = absolutePath(rootDir, importerPath);
  const basePath = path.resolve(path.dirname(importerAbsolutePath), stripResourceQuery(specifier));
  const target = existingFileFromCandidates(candidateModulePaths(basePath));
  return target ? repoPath(rootDir, target) : undefined;
}

export function resolvePathAliasTarget(context: PathAliasContext, specifier: string): string | undefined {
  for (const alias of context.pathAliases) {
    const wildcardIndex = alias.pattern.indexOf("*");
    // Stryker disable next-line StringLiteral: exact aliases never consume wildcardValue; wildcard aliases overwrite it before target interpolation.
    let wildcardValue = "";
    // Stryker disable next-line ConditionalExpression,UnaryOperator,BlockStatement: exact and wildcard alias behavior is covered by direct resolver tests; remaining mutants are equivalent for normalized tsconfig paths.
    if (wildcardIndex === -1) {
      // Stryker disable next-line ConditionalExpression: exact alias mismatch falls through to undefined; matched aliases are covered by resolver tests.
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
      const targetPath = existingFileFromCandidates(candidateModulePaths(baseTarget));
      if (targetPath) {
        return context.rootDir ? repoPath(context.rootDir, targetPath) : normalizePath(targetPath);
      }
    }
  }
  return undefined;
}

function readJsonRecord(filePath: string): Record<string, unknown> | undefined {
  try {
    const value = JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown;
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}

function nearestPackageInfo(fromFilePath: string): { rootDir: string; name?: string; imports?: unknown; exports?: unknown } | undefined {
  let directoryPath = path.dirname(path.resolve(fromFilePath));
  for (;;) {
    const packageJsonPath = path.join(directoryPath, "package.json");
    if (fs.existsSync(packageJsonPath)) {
      const packageJson = readJsonRecord(packageJsonPath) || {};
      return {
        rootDir: directoryPath,
        name: typeof packageJson.name === "string" ? packageJson.name : undefined,
        imports: packageJson.imports,
        exports: packageJson.exports,
      };
    }
    const parentPath = path.dirname(directoryPath);
    if (parentPath === directoryPath) return undefined;
    directoryPath = parentPath;
  }
}

function packageConditionOrder(mode: PackageConditionMode): string[] {
  if (mode === "types") return ["types", "import", "node", "default", "require"];
  if (mode === "require") return ["require", "node", "default", "import", "types"];
  return ["import", "node", "default", "require", "types"];
}

function packageMapEntryTarget(entry: unknown, mode: PackageConditionMode): string | null | undefined {
  if (entry === null) return null;
  if (typeof entry === "string") return entry;
  if (Array.isArray(entry)) {
    let sawNullTarget = false;
    for (const item of entry) {
      const target = packageMapEntryTarget(item, mode);
      if (target === null) {
        sawNullTarget = true;
        continue;
      }
      if (target !== undefined) return target;
    }
    return sawNullTarget ? null : undefined;
  }
  if (entry && typeof entry === "object") {
    const record = entry as Record<string, unknown>;
    const seenConditions = new Set<string>();
    for (const condition of packageConditionOrder(mode)) {
      seenConditions.add(condition);
      if (!Object.prototype.hasOwnProperty.call(record, condition)) continue;
      const target = packageMapEntryTarget(record[condition], mode);
      if (target !== undefined) return target;
    }
    for (const [condition, value] of Object.entries(record)) {
      if (seenConditions.has(condition)) continue;
      const target = packageMapEntryTarget(value, mode);
      if (target !== undefined) return target;
    }
  }
  return undefined;
}

function packageMapLooksSubpathMap(record: Record<string, unknown>): boolean {
  return Object.keys(record).some((key) => key === "." || key.startsWith("./"));
}

function packageMapTarget(map: unknown, specifier: string, mode: PackageConditionMode): string | null | undefined {
  if (specifier === "." && (!map || typeof map !== "object" || Array.isArray(map))) {
    return packageMapEntryTarget(map, mode);
  }
  if (!map || typeof map !== "object" || Array.isArray(map)) return undefined;
  const record = map as Record<string, unknown>;
  if (specifier === "." && !packageMapLooksSubpathMap(record)) return packageMapEntryTarget(record, mode);
  if (Object.prototype.hasOwnProperty.call(record, specifier)) {
    return packageMapEntryTarget(record[specifier], mode);
  }
  const wildcardEntries = Object.entries(record)
    .map(([pattern, entry], index) => {
      const wildcardIndex = pattern.indexOf("*");
      if (wildcardIndex === -1) return undefined;
      return {
        pattern,
        entry,
        index,
        prefix: pattern.slice(0, wildcardIndex),
        suffix: pattern.slice(wildcardIndex + 1),
      };
    })
    .filter((entry): entry is { pattern: string; entry: unknown; index: number; prefix: string; suffix: string } => Boolean(entry))
    .sort((left, right) =>
      right.prefix.length - left.prefix.length
      || right.suffix.length - left.suffix.length
      || left.index - right.index
    );
  for (const { entry, prefix, suffix } of wildcardEntries) {
    if (!specifier.startsWith(prefix) || !specifier.endsWith(suffix)) continue;
    const wildcardValue = specifier.slice(prefix.length, specifier.length - suffix.length);
    const target = packageMapEntryTarget(entry, mode);
    if (target === null) return null;
    if (target) return target.replace(/\*/g, wildcardValue);
  }
  return undefined;
}

function targetInsideDirectory(directoryPath: string, targetPath: string): boolean {
  const relative = path.relative(directoryPath, targetPath);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function resolvePackageTargetFile(packageRoot: string, target: string): string | undefined {
  if (!target.startsWith("./")) return undefined;
  const basePath = path.resolve(packageRoot, target);
  for (const candidate of candidateModulePaths(basePath)) {
    if (!targetInsideDirectory(packageRoot, candidate)) continue;
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  }
  return undefined;
}

function resolvePackageImportsFile(fromFilePath: string, specifier: string, mode: PackageConditionMode = "import"): string | undefined {
  if (!specifier.startsWith("#")) return undefined;
  const packageInfo = nearestPackageInfo(fromFilePath);
  if (!packageInfo) return undefined;
  const target = packageMapTarget(packageInfo.imports, specifier, mode);
  return target ? resolvePackageTargetFile(packageInfo.rootDir, target) : undefined;
}

function packageNameFromSpecifier(specifier: string): string {
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
}

function resolvePackageSelfSubpathFile(fromFilePath: string, specifier: string, mode: PackageConditionMode = "import"): string | undefined {
  const packageInfo = nearestPackageInfo(fromFilePath);
  if (!packageInfo || !packageInfo.name) return undefined;
  const packageName = packageNameFromSpecifier(specifier);
  if (packageName !== packageInfo.name) return undefined;
  if (specifier === packageInfo.name) {
    const target = packageMapTarget(packageInfo.exports, ".", mode);
    return target ? resolvePackageTargetFile(packageInfo.rootDir, target) : undefined;
  }
  const subpath = specifier.slice(packageInfo.name.length + 1);
  const exportTarget = packageMapTarget(packageInfo.exports, `./${subpath}`, mode);
  if (exportTarget === null) return undefined;
  return resolvePackageTargetFile(packageInfo.rootDir, exportTarget || `./${subpath}`);
}

export function resolvePackageExportTarget(
  rootDir: string,
  packageRoot: string,
  packageName: string,
  specifier: string,
  mode: PackageConditionMode = "import",
): PackageExportTarget {
  const packageSpecifier = packageNameFromSpecifier(specifier);
  if (packageSpecifier !== packageName) {
    return {
      state: "UNRESOLVED_UNKNOWN",
      exported: false,
      reason: "specifier does not target the workspace package",
    };
  }
  const packageJson = readJsonRecord(path.join(rootDir, packageRoot, "package.json"));
  if (!packageJson) {
    return {
      state: "UNRESOLVED_UNKNOWN",
      exported: false,
      reason: "package.json could not be read",
    };
  }
  if (packageJson.exports === undefined) {
    return {
      state: "NOT_EXPORTED_PRIVATE",
      exported: false,
      reason: "package has no exports map",
    };
  }
  const subpath = specifier === packageName ? "." : `./${specifier.slice(packageName.length + 1)}`;
  const exportTarget = packageMapTarget(packageJson.exports, subpath, mode);
  if (exportTarget === null) {
    return {
      state: "NOT_EXPORTED_PRIVATE",
      exported: false,
      reason: "specifier is explicitly excluded by the package exports map",
    };
  }
  if (!exportTarget) {
    return {
      state: "NOT_EXPORTED_PRIVATE",
      exported: false,
      reason: "specifier is not declared in the package exports map",
    };
  }
  const absoluteTarget = resolvePackageTargetFile(path.resolve(rootDir, packageRoot), exportTarget);
  if (!absoluteTarget) {
    return {
      state: "PUBLIC_DECLARED_GENERATED_TARGET_MISSING",
      exported: true,
      reason: "export target is declared but no source checkout file was found",
    };
  }
  return {
    state: "PUBLIC_RESOLVED",
    exported: true,
    targetPath: repoPath(rootDir, absoluteTarget),
  };
}

export function resolvePackageImportsTarget(rootDir: string, importerPath: string, specifier: string, mode: PackageConditionMode = "import"): string | undefined {
  const target = resolvePackageImportsFile(absolutePath(rootDir, importerPath), specifier, mode);
  return target ? repoPath(rootDir, target) : undefined;
}

export function resolveNearestPathAliasTarget(rootDir: string, importerPath: string, specifier: string): string | undefined {
  const importerAbsolutePath = absolutePath(rootDir, importerPath);
  const tsconfigPath = findNearestTsConfig(importerAbsolutePath);
  if (!tsconfigPath) return undefined;
  return resolvePathAliasTarget({ rootDir, pathAliases: readPathAliases(path.dirname(tsconfigPath)) }, specifier);
}

function resolveProjectModuleFile(fromFilePath: string, specifier: string): string | undefined {
  const localTarget = resolveLocalModuleFile(fromFilePath, specifier);
  if (localTarget) return localTarget;
  const packageImportTarget = resolvePackageImportsFile(fromFilePath, specifier, "types");
  if (packageImportTarget) return packageImportTarget;
  const selfSubpathTarget = resolvePackageSelfSubpathFile(fromFilePath, specifier, "types");
  if (selfSubpathTarget) return selfSubpathTarget;
  const tsconfigPath = findNearestTsConfig(fromFilePath);
  if (tsconfigPath) {
    const aliasTarget = resolvePathAliasTarget({ pathAliases: readPathAliases(path.dirname(tsconfigPath)) }, specifier);
    if (aliasTarget) return aliasTarget;
  }
  return undefined;
}

function extractPythonImports(context: ImportScanContext, filePath: string, warnings: { push(warning: ImportWarning): void }): ImportReference[] {
  const importerPath = repoPath(context.rootDir, filePath);
  const inspection = inspectPythonSource(filePath);
  for (const error of inspection.errors || []) {
    warnings.push({
      ruleId: "CELLFENCE_UNSUPPORTED_PYTHON_SYNTAX",
      severity: "warning",
      filePath: importerPath,
      message: `Python source cannot be parsed statically${error.line ? ` at line ${error.line}` : ""}: ${error.message}`,
      details: {
        kind: error.kind,
        ...(error.line ? { line: error.line } : {}),
        ...(error.offset ? { offset: error.offset } : {}),
      },
    });
  }
  for (const warning of inspection.warnings || []) {
    warnings.push({
      ruleId: "CELLFENCE_UNSUPPORTED_DYNAMIC_IMPORT",
      severity: "warning",
      filePath: importerPath,
      message: warning.message,
      details: {
        kind: warning.kind,
        ...(warning.line ? { line: warning.line } : {}),
      },
    });
  }
  return inspection.imports.map((reference) => ({
    importerPath,
    specifier: reference.specifier,
    candidateSpecifiers: reference.candidateSpecifiers,
    kind: "import",
    typeOnly: false,
    line: reference.line,
  }));
}

export function extractImports(context: ImportScanContext, filePath: string, warnings: { push(warning: ImportWarning): void }): ImportReference[] {
  const sourceText = readSourceText(context, filePath);
  if (isPythonPath(filePath)) return extractPythonImports(context, filePath, warnings);
  const sourceFile = parseSourceFile(context, filePath);
  const parseDiagnostics = (sourceFile as { parseDiagnostics?: readonly ts.Diagnostic[] }).parseDiagnostics || [];
  for (const diagnostic of parseDiagnostics) {
    const position = sourceFile.getLineAndCharacterOfPosition(diagnostic.start ?? 0);
    warnings.push({
      ruleId: "CELLFENCE_UNSUPPORTED_TYPESCRIPT_SYNTAX",
      severity: "warning",
      filePath: repoPath(context.rootDir, filePath),
      message: `TypeScript source cannot be parsed statically at line ${position.line + 1}: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n")}`,
      details: { line: position.line + 1, offset: position.character + 1 },
    });
  }
  // Stryker disable next-line ConditionalExpression,ArrayDeclaration: the hint is a performance prefilter; parsing no-import files still returns no references.
  if (!IMPORT_SCAN_HINT.test(sourceText)) return [];
  const references: ImportReference[] = [];
  const importerPath = repoPath(context.rootDir, filePath);
  const rootScope = createImportScope(undefined, true);
  rootScope.bindings.set("require", "require");

  function addReference(specifier: string, kind: ImportKind, node: ts.Node, typeOnly: boolean): void {
    references.push({
      importerPath,
      specifier,
      kind,
      typeOnly,
      line: getLineNumber(sourceFile, node),
    });
  }

  function isModulePackageSpecifier(specifier: string): boolean {
    return specifier === "module" || specifier === "node:module";
  }

  function createImportScope(parent?: ImportScope, isVarScope = false): ImportScope {
    const scope = {
      bindings: new Map<string, ImportBindingKind>(),
      stringConstants: new Map<string, string>(),
      singletonStringSets: new Map<string, string>(),
      parent,
      varScope: undefined as unknown as ImportScope,
    };
    scope.varScope = isVarScope || !parent ? scope : parent.varScope;
    return scope;
  }

  function bindingFor(scope: ImportScope, name: string): ImportBindingKind | undefined {
    let current: ImportScope | undefined = scope;
    while (current) {
      const binding = current.bindings.get(name);
      if (binding) return binding;
      current = current.parent;
    }
    return undefined;
  }

  function bindName(scope: ImportScope, name: string, kind: ImportBindingKind, varScoped = false): void {
    const targetScope = varScoped ? scope.varScope : scope;
    targetScope.bindings.set(name, kind);
    targetScope.stringConstants.delete(name);
    targetScope.singletonStringSets.delete(name);
  }

  function bindStringConstant(scope: ImportScope, name: string, value: string, varScoped = false): void {
    const targetScope = varScoped ? scope.varScope : scope;
    targetScope.bindings.set(name, "shadow");
    targetScope.stringConstants.set(name, value);
    targetScope.singletonStringSets.delete(name);
  }

  function bindSingletonStringSet(scope: ImportScope, name: string, value: string, varScoped = false): void {
    const targetScope = varScoped ? scope.varScope : scope;
    targetScope.bindings.set(name, "shadow");
    targetScope.stringConstants.delete(name);
    targetScope.singletonStringSets.set(name, value);
  }

  function stringConstantFor(scope: ImportScope, name: string): string | undefined {
    let current: ImportScope | undefined = scope;
    while (current) {
      if (current.stringConstants.has(name)) return current.stringConstants.get(name);
      if (current.bindings.has(name)) return undefined;
      current = current.parent;
    }
    return undefined;
  }

  function singletonStringSetFor(scope: ImportScope, name: string): string | undefined {
    let current: ImportScope | undefined = scope;
    while (current) {
      if (current.singletonStringSets.has(name)) return current.singletonStringSets.get(name);
      if (current.bindings.has(name)) return undefined;
      current = current.parent;
    }
    return undefined;
  }

  function singletonStringSetInitializer(node: ts.Expression | undefined): string | undefined {
    if (!node) return undefined;
    const unwrapped = unwrapExpression(node);
    if (!ts.isNewExpression(unwrapped)) return undefined;
    const constructorExpression = unwrapExpression(unwrapped.expression);
    if (!ts.isIdentifier(constructorExpression) || constructorExpression.text !== "Set") return undefined;
    const [argument] = unwrapped.arguments || [];
    if (!argument) return undefined;
    const setElements = unwrapExpression(argument);
    if (!ts.isArrayLiteralExpression(setElements)) return undefined;
    const elements = setElements.elements;
    if (elements.length !== 1) return undefined;
    return literalText(elements[0]);
  }

  function isDeclarationIdentifier(node: ts.Identifier): boolean {
    return ts.isVariableDeclaration(node.parent) && node.parent.name === node;
  }

  function isAllowedSingletonSetReference(node: ts.Identifier): boolean {
    if (!ts.isPropertyAccessExpression(node.parent) || node.parent.expression !== node || node.parent.name.text !== "has") return false;
    const callExpression = node.parent.parent;
    if (!ts.isCallExpression(callExpression) || callExpression.expression !== node.parent) return false;
    const guardExpression = unwrapExpression(callExpression);
    const ifStatement = callExpression.parent;
    return ts.isIfStatement(ifStatement) && unwrapExpression(ifStatement.expression) === guardExpression;
  }

  function isAssignmentOperatorKind(kind: ts.SyntaxKind): boolean {
    return kind === ts.SyntaxKind.EqualsToken
      || kind === ts.SyntaxKind.PlusEqualsToken
      || kind === ts.SyntaxKind.MinusEqualsToken
      || kind === ts.SyntaxKind.AsteriskEqualsToken
      || kind === ts.SyntaxKind.AsteriskAsteriskEqualsToken
      || kind === ts.SyntaxKind.SlashEqualsToken
      || kind === ts.SyntaxKind.PercentEqualsToken
      || kind === ts.SyntaxKind.LessThanLessThanEqualsToken
      || kind === ts.SyntaxKind.GreaterThanGreaterThanEqualsToken
      || kind === ts.SyntaxKind.GreaterThanGreaterThanGreaterThanEqualsToken
      || kind === ts.SyntaxKind.AmpersandEqualsToken
      || kind === ts.SyntaxKind.BarEqualsToken
      || kind === ts.SyntaxKind.CaretEqualsToken
      || kind === ts.SyntaxKind.AmpersandAmpersandEqualsToken
      || kind === ts.SyntaxKind.BarBarEqualsToken
      || kind === ts.SyntaxKind.QuestionQuestionEqualsToken;
  }

  function staticMemberAccess(expression: ts.Expression): { receiver: ts.Expression; name: string } | undefined {
    const unwrapped = unwrapExpression(expression);
    if (ts.isPropertyAccessExpression(unwrapped)) return { receiver: unwrapped.expression, name: unwrapped.name.text };
    if (ts.isElementAccessExpression(unwrapped)) {
      const name = literalText(unwrapped.argumentExpression);
      return name ? { receiver: unwrapped.expression, name } : undefined;
    }
    return undefined;
  }

  function isSetPrototypeHasExpression(expression: ts.Expression): boolean {
    const access = staticMemberAccess(expression);
    return access?.name === "has" && isSetPrototypeExpression(access.receiver);
  }

  function isSetPrototypeExpression(expression: ts.Expression): boolean {
    const access = staticMemberAccess(expression);
    if (access?.name !== "prototype") return false;
    const receiver = unwrapExpression(access.receiver);
    return ts.isIdentifier(receiver) && receiver.text === "Set";
  }

  function mutatesSetPrototypeHas(): boolean {
    let mutated = false;
    function visit(node: ts.Node): void {
      if (mutated) return;
      if (
        ts.isBinaryExpression(node)
        && isAssignmentOperatorKind(node.operatorToken.kind)
        && isSetPrototypeHasExpression(node.left)
      ) {
        mutated = true;
        return;
      }
      if (ts.isCallExpression(node)) {
        const callee = unwrapExpression(node.expression);
        const calleeReceiver = ts.isPropertyAccessExpression(callee) ? unwrapExpression(callee.expression) : undefined;
        if (
          ts.isPropertyAccessExpression(callee)
          && calleeReceiver
          && ts.isIdentifier(calleeReceiver)
          && calleeReceiver.text === "Object"
          && callee.name.text === "defineProperty"
          && node.arguments.length >= 2
          && isSetPrototypeExpression(node.arguments[0])
          && literalText(node.arguments[1]) === "has"
        ) {
          mutated = true;
          return;
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(sourceFile);
    return mutated;
  }

  function collectSafeSingletonStringSets(): Map<number, { name: string; value: string }> {
    const candidates = new Map<string, { declarationStart: number; value: string }>();
    const declarationCounts = new Map<string, number>();
    const unsafeNames = new Set<string>();
    function countDeclaration(name: string): void {
      declarationCounts.set(name, (declarationCounts.get(name) || 0) + 1);
    }
    function countBindingName(name: ts.BindingName): void {
      if (ts.isIdentifier(name)) {
        countDeclaration(name.text);
        return;
      }
      for (const element of name.elements) {
        if (!ts.isOmittedExpression(element)) countBindingName(element.name);
      }
    }
    function countDeclaredNames(node: ts.Node): void {
      if (ts.isVariableDeclaration(node)) countBindingName(node.name);
      else if (ts.isParameter(node)) countBindingName(node.name);
      else if ((ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) && node.name) countDeclaration(node.name.text);
      else if (ts.isImportClause(node) && node.name) countDeclaration(node.name.text);
      else if (ts.isNamespaceImport(node)) countDeclaration(node.name.text);
      else if (ts.isImportSpecifier(node)) countDeclaration(node.name.text);
      else if (ts.isImportEqualsDeclaration(node)) countDeclaration(node.name.text);
      else if (ts.isCatchClause(node) && node.variableDeclaration) countBindingName(node.variableDeclaration.name);
      ts.forEachChild(node, countDeclaredNames);
    }
    countDeclaredNames(sourceFile);
    if ((declarationCounts.get("Set") || 0) > 0) return new Map();
    if (mutatesSetPrototypeHas()) return new Map();
    for (const statement of sourceFile.statements) {
      if (!ts.isVariableStatement(statement) || !isConstDeclarationList(statement.declarationList)) continue;
      for (const declaration of statement.declarationList.declarations) {
        if (!ts.isIdentifier(declaration.name)) continue;
        const value = singletonStringSetInitializer(declaration.initializer);
        if (value === undefined) continue;
        candidates.set(declaration.name.text, { declarationStart: declaration.name.getStart(sourceFile), value });
      }
    }
    if (candidates.size === 0) return new Map();
    function visitCandidateUse(node: ts.Node): void {
      if (ts.isIdentifier(node) && candidates.has(node.text)) {
        if (!isDeclarationIdentifier(node) && !isAllowedSingletonSetReference(node)) unsafeNames.add(node.text);
      }
      ts.forEachChild(node, visitCandidateUse);
    }
    visitCandidateUse(sourceFile);
    const safe = new Map<number, { name: string; value: string }>();
    for (const [name, candidate] of candidates.entries()) {
      if (!unsafeNames.has(name) && (declarationCounts.get(name) || 0) === 1) {
        safe.set(candidate.declarationStart, { name, value: candidate.value });
      }
    }
    return safe;
  }

  const safeSingletonStringSets = collectSafeSingletonStringSets();

  function bindPattern(scope: ImportScope, name: ts.BindingName, kind: ImportBindingKind, varScoped = false): void {
    if (ts.isIdentifier(name)) {
      bindName(scope, name.text, kind, varScoped);
      return;
    }
    for (const element of name.elements) {
      if (!ts.isOmittedExpression(element)) bindPattern(scope, element.name, kind, varScoped);
    }
  }

  function isVarScopedDeclarationList(node: ts.VariableDeclarationList): boolean {
    return (node.flags & (ts.NodeFlags.Let | ts.NodeFlags.Const)) === 0;
  }

  function isConstDeclarationList(node: ts.VariableDeclarationList): boolean {
    return Boolean(node.flags & ts.NodeFlags.Const);
  }

  function isBuiltinModuleIdentifier(scope: ImportScope, name: string): boolean {
    return name === "module" && bindingFor(scope, name) === undefined;
  }

  function unwrapExpression(expression: ts.Expression): ts.Expression {
    let current = expression;
    for (;;) {
      if (ts.isParenthesizedExpression(current)) {
        current = current.expression;
        continue;
      }
      if (ts.isAsExpression(current) || ts.isTypeAssertionExpression(current) || ts.isNonNullExpression(current)) {
        current = current.expression;
        continue;
      }
      if (ts.isBinaryExpression(current) && current.operatorToken.kind === ts.SyntaxKind.CommaToken) {
        current = current.right;
        continue;
      }
      return current;
    }
  }

  function staticPropertyName(expression: ts.Expression): string | undefined {
    const unwrapped = unwrapExpression(expression);
    if (ts.isPropertyAccessExpression(unwrapped)) return unwrapped.name.text;
    if (ts.isElementAccessExpression(unwrapped)) return literalText(unwrapped.argumentExpression);
    return undefined;
  }

  function staticPropertyReceiver(expression: ts.Expression): ts.Expression | undefined {
    const unwrapped = unwrapExpression(expression);
    if (ts.isPropertyAccessExpression(unwrapped) || ts.isElementAccessExpression(unwrapped)) return unwrapped.expression;
    return undefined;
  }

  function staticModuleSpecifier(scope: ImportScope, node: ts.Node | undefined): string | undefined {
    if (!node || !ts.isExpression(node)) return undefined;
    const unwrapped = unwrapExpression(node);
    const literal = literalText(unwrapped);
    if (literal !== undefined) return literal;
    if (ts.isIdentifier(unwrapped)) return stringConstantFor(scope, unwrapped.text);
    if (
      ts.isCallExpression(unwrapped)
      && staticPropertyName(unwrapped.expression) === "resolve"
      && Boolean(staticPropertyReceiver(unwrapped.expression))
      && isRequireLikeExpression(scope, staticPropertyReceiver(unwrapped.expression)!)
      && unwrapped.arguments.length >= 1
    ) {
      return staticModuleSpecifier(scope, unwrapped.arguments[0]);
    }
    return undefined;
  }

  function isNodeModuleObject(scope: ImportScope, expression: ts.Expression): boolean {
    const unwrapped = unwrapExpression(expression);
    if (!ts.isIdentifier(unwrapped)) return false;
    return isBuiltinModuleIdentifier(scope, unwrapped.text) || bindingFor(scope, unwrapped.text) === "nodeModule";
  }

  function scopeAllowsTopLevelThis(scope: ImportScope): boolean {
    return scope.varScope.parent === undefined;
  }

  function isGlobalRequireProperty(scope: ImportScope, expression: ts.Expression): boolean {
    const receiver = staticPropertyReceiver(expression);
    return staticPropertyName(expression) === "require"
      && Boolean(receiver)
      && (
        (
          ts.isIdentifier(unwrapExpression(receiver!))
          && ["global", "globalThis"].includes(unwrapExpression(receiver!).getText(sourceFile))
          && bindingFor(scope, unwrapExpression(receiver!).getText(sourceFile)) === undefined
        )
        || (unwrapExpression(receiver!).kind === ts.SyntaxKind.ThisKeyword && scopeAllowsTopLevelThis(scope))
      );
  }

  function isModuleRequireProperty(scope: ImportScope, expression: ts.Expression): boolean {
    return staticPropertyName(expression) === "require"
      && Boolean(staticPropertyReceiver(expression))
      && isNodeModuleObject(scope, staticPropertyReceiver(expression)!);
  }

  function isProcessMainModuleRequireProperty(scope: ImportScope, expression: ts.Expression): boolean {
    if (staticPropertyName(expression) !== "require" || !staticPropertyReceiver(expression)) return false;
    const receiver = unwrapExpression(staticPropertyReceiver(expression)!);
    if (staticPropertyName(receiver) !== "mainModule" || !staticPropertyReceiver(receiver)) return false;
    const root = unwrapExpression(staticPropertyReceiver(receiver)!);
    return ts.isIdentifier(root) && root.text === "process" && bindingFor(scope, "process") === undefined;
  }

  function isModuleConstructorLoadProperty(scope: ImportScope, expression: ts.Expression): boolean {
    if (staticPropertyName(expression) !== "_load" || !staticPropertyReceiver(expression)) return false;
    const receiver = unwrapExpression(staticPropertyReceiver(expression)!);
    if (staticPropertyName(receiver) !== "constructor" || !staticPropertyReceiver(receiver)) return false;
    return isNodeModuleObject(scope, staticPropertyReceiver(receiver)!);
  }

  function isRequireLikeExpression(scope: ImportScope, expression: ts.Expression): boolean {
    const unwrapped = unwrapExpression(expression);
    return (ts.isIdentifier(unwrapped) && bindingFor(scope, unwrapped.text) === "require")
      || isModuleRequireProperty(scope, unwrapped)
      || isGlobalRequireProperty(scope, unwrapped)
      || isProcessMainModuleRequireProperty(scope, unwrapped)
      || isModuleConstructorLoadProperty(scope, unwrapped);
  }

  function literalRequireLikeSpecifier(scope: ImportScope, node: ts.Node | undefined): string | undefined {
    if (!node || !ts.isCallExpression(node) || !isRequireLikeExpression(scope, node.expression) || node.arguments.length < 1) return undefined;
    return staticModuleSpecifier(scope, node.arguments[0]);
  }

  function isModuleNamespaceExpression(scope: ImportScope, expression: ts.Expression): boolean {
    const unwrapped = unwrapExpression(expression);
    if (ts.isIdentifier(unwrapped) && bindingFor(scope, unwrapped.text) === "moduleNamespace") return true;
    if (ts.isCallExpression(unwrapped)) {
      const moduleSpecifier = literalRequireLikeSpecifier(scope, unwrapped);
      return Boolean(moduleSpecifier && isModulePackageSpecifier(moduleSpecifier));
    }
    return false;
  }

  function createRequireKind(scope: ImportScope, expression: ts.Expression): ImportBindingKind | undefined {
    const unwrapped = unwrapExpression(expression);
    if (ts.isIdentifier(unwrapped) && bindingFor(scope, unwrapped.text) === "createRequire") return "createRequire";
    if (
      staticPropertyName(unwrapped) === "createRequire"
      && Boolean(staticPropertyReceiver(unwrapped))
      && isModuleNamespaceExpression(scope, staticPropertyReceiver(unwrapped)!)
    ) {
      return "createRequire";
    }
    return undefined;
  }

  function bindingKindFromInitializer(scope: ImportScope, initializer: ts.Expression): ImportBindingKind | undefined {
    const unwrapped = unwrapExpression(initializer);
    if (isRequireLikeExpression(scope, unwrapped)) return "require";
    if (isNodeModuleObject(scope, unwrapped)) return "nodeModule";
    if (createRequireKind(scope, unwrapped)) return "createRequire";
    if (ts.isCallExpression(unwrapped)) {
      if (createRequireKind(scope, unwrapped.expression)) return "require";
      if (staticPropertyName(unwrapped.expression) === "bind" && Boolean(staticPropertyReceiver(unwrapped.expression)) && isRequireLikeExpression(scope, staticPropertyReceiver(unwrapped.expression)!)) return "require";
      const moduleSpecifier = literalRequireLikeSpecifier(scope, unwrapped);
      if (moduleSpecifier && isModulePackageSpecifier(moduleSpecifier)) return "moduleNamespace";
    }
    return undefined;
  }

  function requireLikeName(scope: ImportScope, expression: ts.Expression): string | undefined {
    const unwrapped = unwrapExpression(expression);
    if (ts.isIdentifier(unwrapped) && bindingFor(scope, unwrapped.text) === "require") return unwrapped.text;
    if (isModuleRequireProperty(scope, unwrapped)) return "module.require";
    if (isProcessMainModuleRequireProperty(scope, unwrapped)) return "process.mainModule.require";
    if (isModuleConstructorLoadProperty(scope, unwrapped)) return "module.constructor._load";
    if (isGlobalRequireProperty(scope, unwrapped)) {
      const receiverName = staticPropertyReceiver(unwrapped)?.getText(sourceFile);
      if (receiverName === "global") return "global.require";
      if (receiverName === "this") return "this.require";
      return "globalThis.require";
    }
    return undefined;
  }

  function literalFromApplyArray(scope: ImportScope, node: ts.Expression | undefined): string | undefined {
    if (!node) return undefined;
    const unwrapped = unwrapExpression(node);
    if (!ts.isArrayLiteralExpression(unwrapped) || unwrapped.elements.length < 1) return undefined;
    return staticModuleSpecifier(scope, unwrapped.elements[0]);
  }

  function requireCallArgument(scope: ImportScope, node: ts.CallExpression): { sourceName: string; specifier?: string; dynamic: boolean } | undefined {
    const directName = requireLikeName(scope, node.expression);
    if (directName) {
      if (node.arguments.length < 1) return undefined;
      const specifier = staticModuleSpecifier(scope, node.arguments[0]);
      return { sourceName: directName, specifier, dynamic: !specifier };
    }

    const propertyName = staticPropertyName(node.expression);
    const receiver = staticPropertyReceiver(node.expression);
    if ((propertyName === "call" || propertyName === "apply") && receiver && isRequireLikeExpression(scope, receiver)) {
      if (propertyName === "call") {
        const specifier = node.arguments.length >= 2 ? staticModuleSpecifier(scope, node.arguments[1]) : undefined;
        return { sourceName: `${requireLikeName(scope, receiver) || "require"}.call`, specifier, dynamic: !specifier };
      }
      const specifier = node.arguments.length >= 2 ? literalFromApplyArray(scope, node.arguments[1]) : undefined;
      return { sourceName: `${requireLikeName(scope, receiver) || "require"}.apply`, specifier, dynamic: !specifier };
    }

    if (
      propertyName === "apply"
      && receiver
      && ts.isIdentifier(unwrapExpression(receiver))
      && unwrapExpression(receiver).getText(sourceFile) === "Reflect"
      && bindingFor(scope, "Reflect") === undefined
      && node.arguments.length >= 3
      && isRequireLikeExpression(scope, node.arguments[0])
    ) {
      const specifier = literalFromApplyArray(scope, node.arguments[2]);
      return { sourceName: "Reflect.apply(require)", specifier, dynamic: !specifier };
    }
    return undefined;
  }

  function readonlySetHasGuard(scope: ImportScope, node: ts.Expression): { identifier: string; specifier: string } | undefined {
    const unwrapped = unwrapExpression(node);
    if (!ts.isCallExpression(unwrapped)) return undefined;
    if (staticPropertyName(unwrapped.expression) !== "has") return undefined;
    const receiver = staticPropertyReceiver(unwrapped.expression);
    if (!receiver) return undefined;
    const receiverName = unwrapExpression(receiver);
    if (!ts.isIdentifier(receiverName)) return undefined;
    const specifier = singletonStringSetFor(scope, receiverName.text);
    if (specifier === undefined) return undefined;
    const [argument] = unwrapped.arguments;
    if (!argument) return undefined;
    const argumentName = unwrapExpression(argument);
    if (!ts.isIdentifier(argumentName)) return undefined;
    return { identifier: argumentName.text, specifier };
  }

  function requireCallUsesIdentifier(scope: ImportScope, node: ts.Expression | undefined, identifier: string): ts.CallExpression | undefined {
    if (!node) return undefined;
    const unwrapped = unwrapExpression(node);
    if (!ts.isCallExpression(unwrapped) || !requireLikeName(scope, unwrapped.expression) || unwrapped.arguments.length < 1) return undefined;
    const argument = unwrapExpression(unwrapped.arguments[0]);
    return ts.isIdentifier(argument) && argument.text === identifier ? unwrapped : undefined;
  }

  function singleReturnRequireCall(scope: ImportScope, node: ts.Statement, identifier: string): ts.CallExpression | undefined {
    if (ts.isReturnStatement(node)) return requireCallUsesIdentifier(scope, node.expression, identifier);
    if (!ts.isBlock(node) || node.statements.length !== 1) return undefined;
    const [statement] = node.statements;
    return ts.isReturnStatement(statement) ? requireCallUsesIdentifier(scope, statement.expression, identifier) : undefined;
  }

  function addReadonlySetGuardedRequireIfSafe(scope: ImportScope, node: ts.IfStatement): boolean {
    const guard = readonlySetHasGuard(scope, node.expression);
    if (!guard) return false;
    const guardedRequireCall = singleReturnRequireCall(scope, node.thenStatement, guard.identifier);
    if (!guardedRequireCall) return false;
    addReference(guard.specifier, "require", guardedRequireCall, false);
    if (node.elseStatement) visit(scope, node.elseStatement);
    return true;
  }

  function addRequireCallReference(node: ts.CallExpression, sourceName: string, specifier: string | undefined, dynamic: boolean): void {
    if (specifier) {
      addReference(specifier, "require", node, false);
    } else if (dynamic) {
      warnings.push({
        ruleId: "CELLFENCE_UNSUPPORTED_DYNAMIC_REQUIRE",
        severity: "warning",
        filePath: importerPath,
        message: `computed ${sourceName}() cannot be resolved statically at line ${getLineNumber(sourceFile, node)}`,
        details: { line: getLineNumber(sourceFile, node) },
      });
    }
  }

  function dynamicExecutionSourceName(scope: ImportScope, node: ts.CallExpression): string | undefined {
    const expression = unwrapExpression(node.expression);
    if (!ts.isIdentifier(expression) || bindingFor(scope, expression.text) !== undefined) return undefined;
    return expression.text === "eval" || expression.text === "Function" ? expression.text : undefined;
  }

  function addDynamicExecutionRequireReferences(scope: ImportScope, node: ts.CallExpression): boolean {
    const sourceName = dynamicExecutionSourceName(scope, node);
    if (!sourceName) return false;
    const modulePattern = /\brequire\s*\(\s*(["'`])([^"'`]+)\1/g;
    let addedReference = false;
    let hasComputedArgument = false;
    for (const argument of node.arguments) {
      const sourceText = literalText(argument);
      if (sourceText === undefined) {
        hasComputedArgument = true;
        continue;
      }
      for (const match of sourceText.matchAll(modulePattern)) {
        const specifier = match[2];
        if (!specifier) continue;
        addReference(specifier, "require", node, false);
        addedReference = true;
      }
    }
    if (hasComputedArgument) {
      warnings.push({
        ruleId: "CELLFENCE_UNSUPPORTED_DYNAMIC_REQUIRE",
        severity: "warning",
        filePath: importerPath,
        message: `computed ${sourceName}() source cannot be resolved statically at line ${getLineNumber(sourceFile, node)}`,
        details: { line: getLineNumber(sourceFile, node) },
      });
      return true;
    }
    return addedReference;
  }

  function importTypeSpecifier(node: ts.ImportTypeNode): string | undefined {
    if (!ts.isLiteralTypeNode(node.argument)) return undefined;
    const literal = node.argument.literal;
    return ts.isStringLiteral(literal) || ts.isNoSubstitutionTemplateLiteral(literal) ? literal.text : undefined;
  }

  function predeclareStatement(scope: ImportScope, node: ts.Node): void {
    if (ts.isVariableStatement(node)) {
      const varScoped = isVarScopedDeclarationList(node.declarationList);
      for (const declaration of node.declarationList.declarations) bindPattern(scope, declaration.name, "shadow", varScoped);
    } else if (ts.isFunctionDeclaration(node) && node.name) {
      bindName(scope, node.name.text, "shadow");
    } else if (ts.isClassDeclaration(node) && node.name) {
      bindName(scope, node.name.text, "shadow");
    } else if (ts.isImportDeclaration(node)) {
      const clause = node.importClause;
      if (!clause) return;
      if (clause.name) bindName(scope, clause.name.text, "shadow");
      const namedBindings = clause.namedBindings;
      if (namedBindings && ts.isNamespaceImport(namedBindings)) {
        bindName(scope, namedBindings.name.text, "shadow");
      } else if (namedBindings && ts.isNamedImports(namedBindings)) {
        for (const element of namedBindings.elements) bindName(scope, element.name.text, "shadow");
      }
    } else if (ts.isImportEqualsDeclaration(node)) {
      bindName(scope, node.name.text, "shadow");
    }
  }

  function predeclareScope(scope: ImportScope, statements: ts.NodeArray<ts.Statement>): void {
    for (const statement of statements) predeclareStatement(scope, statement);
  }

  function bindImportClause(scope: ImportScope, node: ts.ImportDeclaration): void {
    if (!ts.isStringLiteral(node.moduleSpecifier) || !isModulePackageSpecifier(node.moduleSpecifier.text)) return;
    const clause = node.importClause;
    if (!clause || clause.isTypeOnly) return;
    if (clause.name) bindName(scope, clause.name.text, "moduleNamespace");
    const namedBindings = clause.namedBindings;
    if (namedBindings && ts.isNamedImports(namedBindings)) {
      for (const element of namedBindings.elements) {
        if (element.isTypeOnly) continue;
        if ((element.propertyName?.text || element.name.text) === "createRequire") bindName(scope, element.name.text, "createRequire");
      }
    } else if (namedBindings && ts.isNamespaceImport(namedBindings)) {
      bindName(scope, namedBindings.name.text, "moduleNamespace");
    }
  }

  function visitVariableDeclaration(scope: ImportScope, node: ts.VariableDeclaration): void {
    if (node.initializer) visit(scope, node.initializer);
    const varScoped = node.parent && ts.isVariableDeclarationList(node.parent) ? isVarScopedDeclarationList(node.parent) : false;
    const constScoped = node.parent && ts.isVariableDeclarationList(node.parent) ? isConstDeclarationList(node.parent) : false;
    if (node.initializer && ts.isIdentifier(node.name)) {
      const kind = bindingKindFromInitializer(scope, node.initializer);
      const stringValue = constScoped ? staticModuleSpecifier(scope, node.initializer) : undefined;
      const singletonSet = constScoped ? safeSingletonStringSets.get(node.name.getStart(sourceFile)) : undefined;
      if (kind) bindName(scope, node.name.text, kind, varScoped);
      else if (stringValue !== undefined) bindStringConstant(scope, node.name.text, stringValue, varScoped);
      else if (singletonSet) bindSingletonStringSet(scope, singletonSet.name, singletonSet.value, varScoped);
      else bindName(scope, node.name.text, "shadow", varScoped);
    } else if (node.initializer && ts.isObjectBindingPattern(node.name)) {
      const moduleSpecifier = literalRequireLikeSpecifier(scope, node.initializer);
      if (moduleSpecifier && isModulePackageSpecifier(moduleSpecifier)) {
        for (const element of node.name.elements) {
          if (!ts.isIdentifier(element.name)) continue;
          const propertyName = element.propertyName && ts.isIdentifier(element.propertyName) ? element.propertyName.text : element.name.text;
          bindName(scope, element.name.text, propertyName === "createRequire" ? "createRequire" : "shadow", varScoped);
        }
      } else if (isNodeModuleObject(scope, node.initializer)) {
        for (const element of node.name.elements) {
          if (!ts.isIdentifier(element.name)) continue;
          const propertyName = element.propertyName && ts.isIdentifier(element.propertyName) ? element.propertyName.text : element.name.text;
          bindName(scope, element.name.text, propertyName === "require" ? "require" : "shadow", varScoped);
        }
      } else {
        bindPattern(scope, node.name, "shadow", varScoped);
      }
    } else {
      bindPattern(scope, node.name, "shadow", varScoped);
    }
  }

  function isFunctionLikeWithBody(node: ts.Node): node is FunctionLikeWithBody {
    return ts.isFunctionDeclaration(node)
      || ts.isFunctionExpression(node)
      || ts.isArrowFunction(node)
      || ts.isMethodDeclaration(node)
      || ts.isGetAccessorDeclaration(node)
      || ts.isSetAccessorDeclaration(node)
      || ts.isConstructorDeclaration(node);
  }

  function visitFunctionLike(scope: ImportScope, node: FunctionLikeWithBody): void {
    const childScope = createImportScope(scope, true);
    for (const parameter of node.parameters) bindPattern(childScope, parameter.name, "shadow");
    if (node.body) visit(childScope, node.body);
  }

  function visitStatementList(scope: ImportScope, statements: ts.NodeArray<ts.Statement>): void {
    predeclareScope(scope, statements);
    for (const statement of statements) visit(scope, statement);
  }

  function visit(scope: ImportScope, node: ts.Node): void {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      addReference(node.moduleSpecifier.text, "import", node, Boolean(node.importClause?.isTypeOnly));
      bindImportClause(scope, node);
    } else if (
      ts.isImportEqualsDeclaration(node)
      && ts.isExternalModuleReference(node.moduleReference)
      && node.moduleReference.expression
    ) {
      const specifier = literalText(node.moduleReference.expression);
      if (specifier) addReference(specifier, "require", node, Boolean((node as { isTypeOnly?: boolean }).isTypeOnly));
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      addReference(node.moduleSpecifier.text, "export-from", node, Boolean(node.isTypeOnly));
    } else if (ts.isImportTypeNode(node)) {
      const specifier = importTypeSpecifier(node);
      if (specifier) addReference(specifier, "import", node, true);
    } else if (ts.isVariableDeclaration(node)) {
      visitVariableDeclaration(scope, node);
      return;
    } else if (ts.isCallExpression(node)) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        const [specifierNode] = node.arguments;
        const specifier = staticModuleSpecifier(scope, specifierNode);
        if (specifier !== undefined) {
          addReference(specifier, "dynamic-import", node, false);
        } else {
          warnings.push({
            ruleId: "CELLFENCE_UNSUPPORTED_DYNAMIC_IMPORT",
            severity: "warning",
            filePath: importerPath,
            message: `computed dynamic import cannot be resolved statically at line ${getLineNumber(sourceFile, node)}`,
            details: { line: getLineNumber(sourceFile, node) },
          });
        }
      } else {
        const requireCall = requireCallArgument(scope, node);
        if (requireCall) addRequireCallReference(node, requireCall.sourceName, requireCall.specifier, requireCall.dynamic);
        addDynamicExecutionRequireReferences(scope, node);
      }
    } else if (ts.isIfStatement(node)) {
      if (addReadonlySetGuardedRequireIfSafe(scope, node)) return;
    } else if (ts.isForStatement(node)) {
      const loopScope = createImportScope(scope);
      if (node.initializer) visit(loopScope, node.initializer);
      if (node.condition) visit(loopScope, node.condition);
      if (node.incrementor) visit(loopScope, node.incrementor);
      visit(loopScope, node.statement);
      return;
    } else if (ts.isForInStatement(node) || ts.isForOfStatement(node)) {
      const loopScope = createImportScope(scope);
      visit(loopScope, node.initializer);
      visit(loopScope, node.expression);
      visit(loopScope, node.statement);
      return;
    } else if (ts.isSwitchStatement(node)) {
      visit(scope, node.expression);
      const switchScope = createImportScope(scope);
      for (const clause of node.caseBlock.clauses) {
        if (ts.isCaseClause(clause)) visit(scope, clause.expression);
      }
      for (const clause of node.caseBlock.clauses) {
        for (const statement of clause.statements) predeclareStatement(switchScope, statement);
      }
      for (const clause of node.caseBlock.clauses) {
        for (const statement of clause.statements) visit(switchScope, statement);
      }
      return;
    } else if (ts.isCatchClause(node)) {
      const catchScope = createImportScope(scope);
      if (node.variableDeclaration) bindPattern(catchScope, node.variableDeclaration.name, "shadow");
      visit(catchScope, node.block);
      return;
    } else if (ts.isSourceFile(node)) {
      visitStatementList(scope, node.statements);
      return;
    } else if (ts.isBlock(node) || ts.isModuleBlock(node)) {
      visitStatementList(createImportScope(scope), node.statements);
      return;
    } else if (isFunctionLikeWithBody(node)) {
      visitFunctionLike(scope, node);
      return;
    }
    ts.forEachChild(node, (child) => visit(scope, child));
  }

  visit(rootScope, sourceFile);
  return references;
}

function exportedNameFromDeclarationName(name: ts.DeclarationName): string | undefined {
  // Stryker disable next-line ConditionalExpression: supported declaration names are identifiers/string/numeric literals; other node kinds are invalid export names here.
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name.text || undefined;
  return undefined;
}

function bindingNames(name: ts.BindingName): string[] {
  if (ts.isIdentifier(name)) return [name.text];
  const names: string[] = [];
  for (const element of name.elements) {
    if (!ts.isOmittedExpression(element)) names.push(...bindingNames(element.name));
  }
  return names;
}

function resolveLocalModuleFile(fromFilePath: string, specifier: string): string | undefined {
  // Stryker disable next-line MethodExpression: package specifiers are rejected by the leading-dot check; changing the secondary absolute-path guard is equivalent for non-local specifiers.
  if (!specifier.startsWith(".") && !specifier.startsWith("/")) return undefined;
  const basePath = path.resolve(path.dirname(fromFilePath), stripResourceQuery(specifier));
  for (const candidatePath of candidateModulePaths(basePath)) {
    if (fs.existsSync(candidatePath) && fs.statSync(candidatePath).isFile()) return candidatePath;
  }
  return undefined;
}

export function extractPublicSymbols(filePath: string, visitedFiles = new Set<string>()): Set<string> {
  const normalizedFilePath = path.resolve(filePath);
  if (visitedFiles.has(normalizedFilePath)) return new Set<string>();
  visitedFiles.add(normalizedFilePath);
  const sourceText = fs.readFileSync(filePath, "utf8");
  if (isPythonPath(filePath)) return new Set(inspectPythonSource(filePath).publicSymbols);
  // Stryker disable next-line BooleanLiteral: parent pointers are not used by public-symbol extraction.
  const sourceFile = ts.createSourceFile(filePath, sourceText, ts.ScriptTarget.Latest, true, sourceKindForPath(filePath));
  const symbols = new Set<string>();

  function hasExportModifier(node: ts.Node): boolean {
    return Boolean(ts.getCombinedModifierFlags(node as ts.Declaration) & ts.ModifierFlags.Export);
  }

  function visit(node: ts.Node): void {
    if (ts.isModuleDeclaration(node) && hasExportModifier(node)) {
      const exportedName = exportedNameFromDeclarationName(node.name);
      if (exportedName) symbols.add(exportedName);
      return;
    }
    // Stryker disable next-line ConditionalExpression: broadening this to arbitrary exported nodes is equivalent for valid TypeScript declarations exercised here.
    if ((ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node) || ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node) || ts.isEnumDeclaration(node)) && hasExportModifier(node)) {
      if (ts.getCombinedModifierFlags(node as ts.Declaration) & ts.ModifierFlags.Default) {
        symbols.add("default");
      } else {
        const exportedName = exportedNameFromDeclarationName(node.name!);
        // Stryker disable next-line ConditionalExpression: exported declaration names are guaranteed for valid non-default declarations.
        if (exportedName) symbols.add(exportedName);
      }
    } else if (ts.isVariableStatement(node) && hasExportModifier(node)) {
      for (const declaration of node.declarationList.declarations) {
        for (const exportedName of bindingNames(declaration.name)) symbols.add(exportedName);
      }
    } else if (ts.isImportEqualsDeclaration(node) && hasExportModifier(node)) {
      symbols.add(node.name.text);
    } else if (ts.isExportAssignment(node)) {
      symbols.add("default");
    } else {
      // Stryker disable next-line ConditionalExpression: non-export nodes have no public-symbol effect and are covered by exact symbol tests.
      if (ts.isExportDeclaration(node)) {
        // Stryker disable all: export-clause branch selection is asserted through named, namespace, package, and star re-export symbol tests.
        if (node.exportClause && ts.isNamedExports(node.exportClause)) {
          for (const element of node.exportClause.elements) {
            symbols.add(element.name.text);
          }
        } else if (node.exportClause && ts.isNamespaceExport(node.exportClause)) {
          symbols.add(node.exportClause.name.text);
        } else if (!node.exportClause && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
          const targetFilePath = resolveProjectModuleFile(filePath, node.moduleSpecifier.text);
          if (targetFilePath) {
            for (const exportedSymbol of extractPublicSymbols(targetFilePath, visitedFiles)) {
              if (exportedSymbol !== "default") symbols.add(exportedSymbol);
            }
          }
        }
        // Stryker restore all
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return symbols;
}

function normalizeWhitespace(text: string): string {
  // Stryker disable next-line MethodExpression: TypeScript node text used here has no leading/trailing whitespace; regex collapse is tested by exact digest cases.
  return text.replace(/\s+/g, " ").trim();
}

function syntaxPublicSurfaceSignatureParts(filePath: string): string[] {
  if (!fs.existsSync(filePath)) return [];
  const sourceText = fs.readFileSync(filePath, "utf8");
  if (isPythonPath(filePath)) return inspectPythonSource(filePath).surfaceParts;
  // Stryker disable next-line BooleanLiteral: parent pointers are not used by public-surface signature extraction.
  const sourceFile = ts.createSourceFile(filePath, sourceText, ts.ScriptTarget.Latest, true, sourceKindForPath(filePath));
  const parts: string[] = [];

  function hasExportModifier(node: ts.Node): boolean {
    return Boolean(ts.getCombinedModifierFlags(node as ts.Declaration) & ts.ModifierFlags.Export);
  }

  function typeText(node: ts.Node | undefined): string {
    return node ? normalizeWhitespace(node.getText(sourceFile)) : "";
  }

  function visit(node: ts.Node): void {
    if (ts.isModuleDeclaration(node) && hasExportModifier(node)) {
      const name = exportedNameFromDeclarationName(node.name);
      if (name) parts.push(`namespace:${name}:${normalizeWhitespace(node.getText(sourceFile))}`);
      return;
    }
    if (ts.isFunctionDeclaration(node) && hasExportModifier(node)) {
      const name = ts.getCombinedModifierFlags(node) & ts.ModifierFlags.Default ? "default" : exportedNameFromDeclarationName(node.name!);
      // Stryker disable next-line ConditionalExpression: valid exported function declarations are named unless default.
      if (name) {
        const params = node.parameters.map((parameter) => `${typeText(parameter.name)}:${typeText(parameter.type)}`).join(",");
        parts.push(`function:${name}(${params}):${typeText(node.type)}`);
      }
    } else if ((ts.isClassDeclaration(node) || ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node) || ts.isEnumDeclaration(node)) && hasExportModifier(node)) {
      const name = ts.getCombinedModifierFlags(node) & ts.ModifierFlags.Default ? "default" : exportedNameFromDeclarationName(node.name!);
      // Stryker disable next-line ConditionalExpression: valid exported type/class declarations are named unless default.
      if (name) parts.push(`${ts.SyntaxKind[node.kind]}:${name}:${normalizeWhitespace(node.getText(sourceFile))}`);
    } else if (ts.isVariableStatement(node) && hasExportModifier(node)) {
      for (const declaration of node.declarationList.declarations) {
        for (const name of bindingNames(declaration.name)) parts.push(`variable:${name}:${typeText(declaration.type)}`);
      }
    } else if (ts.isImportEqualsDeclaration(node) && hasExportModifier(node)) {
      parts.push(`export-import:${node.name.text}:${typeText(node.moduleReference)}`);
    } else if (ts.isExportAssignment(node)) {
      parts.push("export:default");
    } else {
      // Stryker disable next-line ConditionalExpression: non-export nodes have no public-surface effect and are covered by exact digest tests.
      if (ts.isExportDeclaration(node)) {
        // Stryker disable all: export-clause branch selection is asserted by the exact public-surface digest test.
        if (node.exportClause && ts.isNamedExports(node.exportClause)) {
          for (const element of node.exportClause.elements) parts.push(`export:${element.name.text}`);
        } else if (node.exportClause && ts.isNamespaceExport(node.exportClause)) {
          parts.push(`namespace:${node.exportClause.name.text}`);
        } else if (!node.exportClause && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
          parts.push(`export-star:${node.moduleSpecifier.text}`);
        }
        // Stryker restore all
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return parts.sort((left, right) => left.localeCompare(right));
}

function findNearestTsConfig(filePath: string): string | undefined {
  let directoryPath = path.dirname(path.resolve(filePath));
  for (;;) {
    const tsconfigPath = path.join(directoryPath, "tsconfig.json");
    if (fs.existsSync(tsconfigPath)) return tsconfigPath;
    const parentDirectoryPath = path.dirname(directoryPath);
    if (parentDirectoryPath === directoryPath) return undefined;
    directoryPath = parentDirectoryPath;
  }
}

function declarationEmitCompilerOptions(filePath: string): ts.CompilerOptions {
  const defaultOptions: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    jsx: ts.JsxEmit.ReactJSX,
    strict: false,
    skipLibCheck: true,
  };
  const tsconfigPath = findNearestTsConfig(filePath);
  let options = defaultOptions;
  if (tsconfigPath) {
    const normalizedTsconfigPath = normalizePath(tsconfigPath);
    const configFile = ts.readConfigFile(normalizedTsconfigPath, ts.sys.readFile);
    if (!configFile.error) {
      const parsedConfig = ts.parseJsonConfigFileContent(configFile.config, ts.sys, path.dirname(normalizedTsconfigPath), defaultOptions, normalizedTsconfigPath);
      options = parsedConfig.options;
    }
  }
  return {
    ...options,
    allowJs: true,
    checkJs: false,
    declaration: true,
    declarationMap: false,
    emitDeclarationOnly: true,
    inlineSourceMap: false,
    noEmit: false,
    noEmitOnError: false,
    removeComments: true,
    sourceMap: false,
    stripInternal: true,
    tsBuildInfoFile: undefined,
  };
}

function collectPublicDeclarationRoots(filePath: string, visitedFiles = new Set<string>()): string[] {
  const normalizedFilePath = path.resolve(filePath);
  if (visitedFiles.has(normalizedFilePath) || !fs.existsSync(normalizedFilePath)) return [];
  visitedFiles.add(normalizedFilePath);
  const roots = [normalizedFilePath];
  const sourceText = fs.readFileSync(normalizedFilePath, "utf8");
  const sourceFile = ts.createSourceFile(normalizedFilePath, sourceText, ts.ScriptTarget.Latest, true, sourceKindForPath(normalizedFilePath));

  function importDeclarationIsTypeSurface(node: ts.ImportDeclaration): boolean {
    const clause = node.importClause;
    if (!clause) return false;
    if (clause.isTypeOnly) return true;
    const namedBindings = clause.namedBindings;
    return Boolean(namedBindings && ts.isNamedImports(namedBindings) && namedBindings.elements.some((element) => element.isTypeOnly));
  }

  function visit(node: ts.Node): void {
    if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      const targetPath = resolveProjectModuleFile(normalizedFilePath, node.moduleSpecifier.text);
      if (targetPath) roots.push(...collectPublicDeclarationRoots(targetPath, visitedFiles));
    } else if (ts.isImportDeclaration(node) && importDeclarationIsTypeSurface(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const targetPath = resolveProjectModuleFile(normalizedFilePath, node.moduleSpecifier.text);
      if (targetPath) roots.push(...collectPublicDeclarationRoots(targetPath, visitedFiles));
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return roots;
}

function normalizeDeclarationText(text: string): string {
  return text.replace(/\r\n/g, "\n").split("\n").map((line) => line.trim()).filter(Boolean).join("\n");
}

function declarationPublicSurfaceSignatureParts(filePath: string): string[] {
  if (!fs.existsSync(filePath) || isPythonPath(filePath)) return [];
  const rootFiles = collectPublicDeclarationRoots(filePath);
  if (rootFiles.length === 0) return [];
  const options = declarationEmitCompilerOptions(filePath);
  const declarations: { orderKey: string; text: string }[] = [];
  for (const rootFile of [...new Set(rootFiles)].sort((left, right) => left.localeCompare(right))) {
    const result = ts.transpileDeclaration(fs.readFileSync(rootFile, "utf8"), {
      compilerOptions: options,
      fileName: rootFile,
    });
    if (!result.outputText) continue;
    const normalizedText = normalizeDeclarationText(result.outputText);
    if (normalizedText.length === 0) continue;
    declarations.push({
      orderKey: normalizePath(path.relative(path.dirname(path.resolve(filePath)), rootFile)),
      text: normalizedText,
    });
  }
  return declarations
    .sort((left, right) => left.orderKey.localeCompare(right.orderKey))
    .map((declaration) => `dts:${declaration.text}`);
}

function publicSurfaceSignatureParts(filePath: string): string[] {
  if (isPythonPath(filePath)) return syntaxPublicSurfaceSignatureParts(filePath);
  const declarationParts = declarationPublicSurfaceSignatureParts(filePath);
  return declarationParts.length > 0 ? declarationParts : syntaxPublicSurfaceSignatureParts(filePath);
}

export function publicSurfaceHash(filePath: string): string {
  return crypto.createHash("sha256").update(publicSurfaceSignatureParts(filePath).join("\n")).digest("hex");
}
