import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import ts from "typescript";

import {
  absolutePath,
  listFiles,
  normalizePath,
  parseSourceFile,
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
  severity: "warning" | "error";
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

type ImportBindingKind = "require" | "createRequire" | "moduleNamespace" | "nodeModule" | null;

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

function isDeclarationPath(filePath: string): boolean {
  return DECLARATION_EXTENSIONS.some((extension) => filePath.endsWith(extension));
}

export function getLineNumber(sourceFile: ts.SourceFile, node: ts.Node): number {
  return sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
}

export function literalText(node: ts.Node | undefined): string | undefined {
  if (!node) return undefined;
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  return undefined;
}

function readPathAliasesFromConfig(rootDir: string, configPath: string): PathAlias[] {
  const normalizedRootDir = normalizePath(rootDir);
  const tsconfigPath = normalizePath(configPath);
  const configFile = ts.readConfigFile(tsconfigPath, ts.sys.readFile);
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

export function readPathAliases(rootDir: string): PathAlias[] {
  return readPathAliasesFromConfig(rootDir, path.join(rootDir, "tsconfig.json"));
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
    addAliases(readPathAliasesFromConfig(path.dirname(filePath), filePath));
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
  const runtimeSourceExtensions = sourceExtensionsForRuntimeSpecifier(extension);
  if (runtimeSourceExtensions.length > 0) {
    const basePathWithoutExtension = normalizedBasePath.slice(0, -extension.length);
    for (const sourceExtension of runtimeSourceExtensions) {
      addUniquePath(candidates, `${basePathWithoutExtension}${sourceExtension}`);
    }
    return candidates;
  }
  if (extension && EXACT_SPECIFIER_EXTENSIONS.has(extension)) return candidates;
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

export function importSpecifierLooksPathLike(specifier: string): boolean {
  return specifier.startsWith(".")
    || specifier.startsWith("/")
    || /^[A-Za-z]:[\\/]/.test(specifier);
}

function resolvePythonRelativeModule(rootDir: string, importerPath: string, specifier: string): string | undefined {
  let dotCount = 0;
  while (specifier[dotCount] === ".") dotCount += 1;
  let baseDir = path.dirname(absolutePath(rootDir, importerPath));
  for (let index = 1; index < dotCount; index += 1) baseDir = path.dirname(baseDir);
  const modulePath = path.join(baseDir, ...specifier.split("."));
  const target = existingFileFromCandidates(candidatePythonModulePaths(modulePath));
  return target ? repoPath(rootDir, target) : undefined;
}

export function resolvePythonImport(rootDir: string, importerPath: string, specifier: string, sourceRoots?: string[]): string | undefined {
  if (!isPythonPath(importerPath)) return undefined;
  if (specifier.startsWith(".")) return resolvePythonRelativeModule(rootDir, importerPath, specifier);
  const moduleParts = specifier.split(".").filter(Boolean);
  if (moduleParts.length === 0) return undefined;
  const rootTarget = existingFileFromCandidates(candidatePythonModulePaths(path.resolve(rootDir, ...moduleParts)));
  if (rootTarget) return repoPath(rootDir, rootTarget);
  if (!sourceRoots) return undefined;
  for (const sourceRoot of sourceRoots) {
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
    const value = JSON.parse(fs.readFileSync(filePath).toString()) as unknown;
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
  } catch {
    // Invalid package metadata is treated as absent.
  }
  return undefined;
}

function nearestPackageInfo(fromFilePath: string): { rootDir: string; name?: string; imports?: unknown; exports?: unknown } | undefined {
  let directoryPath = path.dirname(path.resolve(fromFilePath));
  for (;;) {
    const packageJsonPath = path.join(directoryPath, "package.json");
    if (fs.existsSync(packageJsonPath)) {
      const packageJson = readJsonRecord(packageJsonPath) || {};
      return {
        rootDir: directoryPath,
        name: packageJson.name as string | undefined,
        imports: packageJson.imports,
        exports: packageJson.exports,
      };
    }
    const parentPath = path.dirname(directoryPath);
    if (parentPath === directoryPath) return undefined;
    directoryPath = parentPath;
  }
}

function packageConditionOrder(mode?: PackageConditionMode): string[] {
  if (mode === "types") return ["types", "import", "node", "default", "require"];
  if (mode === "require") return ["require", "node", "default", "import", "types"];
  return ["import", "node", "default", "require", "types"];
}

function packageMapEntryTarget(entry: unknown, mode?: PackageConditionMode): string | null | undefined {
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
  const record = entry as Record<string, unknown>;
  for (const condition of packageConditionOrder(mode)) {
    if (!Object.prototype.hasOwnProperty.call(record, condition)) continue;
    const target = packageMapEntryTarget(record[condition], mode);
    if (target !== undefined) return target;
  }
  for (const value of Object.values(record)) {
    const target = packageMapEntryTarget(value, mode);
    if (target !== undefined) return target;
  }
  return undefined;
}

function packageMapLooksSubpathMap(record: Record<string, unknown>): boolean {
  return Object.keys(record).some((key) => key === "." || key.startsWith("./"));
}

function packageMapTarget(map: unknown, specifier: string, mode?: PackageConditionMode): string | null | undefined {
  if (map === null || map === undefined) return undefined;
  const record = map as Record<string, unknown>;
  if (specifier === "." && !packageMapLooksSubpathMap(record)) return packageMapEntryTarget(record, mode);
  if (Object.prototype.hasOwnProperty.call(record, specifier)) {
    return packageMapEntryTarget(record[specifier], mode);
  }
  const wildcardEntries = Object.entries(record)
    .map(([pattern, entry]) => {
      const wildcardIndex = pattern.indexOf("*");
      if (wildcardIndex === -1) return undefined;
      return {
        pattern,
        entry,
        prefix: pattern.slice(0, wildcardIndex),
        suffix: pattern.slice(wildcardIndex + 1),
      };
    })
    .filter((entry): entry is { pattern: string; entry: unknown; prefix: string; suffix: string } => Boolean(entry))
    .sort((left, right) =>
      right.prefix.length - left.prefix.length
      || right.suffix.length - left.suffix.length
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
  return !relative.startsWith("..") && !path.isAbsolute(relative);
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

function resolvePackageImportsFile(fromFilePath: string, specifier: string, mode?: PackageConditionMode): string | undefined {
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

function resolvePackageSelfSubpathFile(fromFilePath: string, specifier: string, mode: PackageConditionMode): string | undefined {
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
  mode?: PackageConditionMode,
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

export function resolvePackageImportsTarget(rootDir: string, importerPath: string, specifier: string, mode?: PackageConditionMode): string | undefined {
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
    return resolvePathAliasTarget({ pathAliases: readPathAliases(path.dirname(tsconfigPath)) }, specifier);
  }
  return undefined;
}

function extractPythonImports(
  context: ImportScanContext,
  filePath: string,
  warnings: { push(warning: ImportWarning): void },
  errors?: { push(error: ImportWarning): void },
): ImportReference[] {
  const importerPath = repoPath(context.rootDir, filePath);
  const inspection = inspectPythonSource(filePath);
  for (const error of inspection.errors) {
    const destination = error.kind === "inspector_error" && errors ? errors : warnings;
    destination.push({
      ruleId: "CELLFENCE_UNSUPPORTED_PYTHON_SYNTAX",
      severity: error.kind === "inspector_error" ? "error" : "warning",
      filePath: importerPath,
      message: `Python source cannot be parsed statically${error.line ? ` at line ${error.line}` : ""}: ${error.message}`,
      details: {
        kind: error.kind,
        ...(error.line ? { line: error.line } : {}),
        ...(error.offset ? { offset: error.offset } : {}),
      },
    });
  }
  if (inspection.warnings) {
    for (const warning of inspection.warnings) {
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

export function extractImports(
  context: ImportScanContext,
  filePath: string,
  warnings: { push(warning: ImportWarning): void },
  errors?: { push(error: ImportWarning): void },
): ImportReference[] {
  if (isPythonPath(filePath)) return extractPythonImports(context, filePath, warnings, errors);
  const sourceFile = parseSourceFile(context, filePath);
  const parseDiagnostics = (sourceFile as unknown as { parseDiagnostics: readonly ts.Diagnostic[] }).parseDiagnostics;
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
  const references: ImportReference[] = [];
  const importerPath = repoPath(context.rootDir, filePath);
  const rootScope = createRootImportScope();
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

  function isModulePackageSpecifier(specifier: unknown): boolean {
    return specifier === "module" || specifier === "node:module";
  }

  function createRootImportScope(): ImportScope {
    const scope = {
      bindings: new Map<string, ImportBindingKind>(),
      stringConstants: new Map<string, string>(),
      singletonStringSets: new Map<string, string>(),
    } as ImportScope;
    scope.varScope = scope;
    return scope;
  }

  function createImportScope(parent: ImportScope, isVarScope: boolean): ImportScope {
    const scope = {
      bindings: new Map<string, ImportBindingKind>(),
      stringConstants: new Map<string, string>(),
      singletonStringSets: new Map<string, string>(),
      parent,
      varScope: undefined as unknown as ImportScope,
    };
    scope.varScope = isVarScope ? scope : parent.varScope;
    return scope;
  }

  function bindingFor(scope: ImportScope, name: string): ImportBindingKind | undefined {
    let current: ImportScope | undefined = scope;
    while (current) {
      if (current.bindings.has(name)) return current.bindings.get(name);
      current = current.parent;
    }
  }

  function bindName(scope: ImportScope, name: string, kind: ImportBindingKind, varScoped: boolean): void {
    const targetScope = varScoped ? scope.varScope : scope;
    targetScope.bindings.set(name, kind);
    targetScope.stringConstants.delete(name);
    targetScope.singletonStringSets.delete(name);
  }

  function bindLexicalName(scope: ImportScope, name: string, kind: ImportBindingKind): void {
    bindName(scope, name, kind, false);
  }

  function bindStringConstant(scope: ImportScope, name: string, value: string, varScoped: boolean): void {
    const targetScope = varScoped ? scope.varScope : scope;
    targetScope.bindings.set(name, null);
    targetScope.stringConstants.set(name, value);
    targetScope.singletonStringSets.delete(name);
  }

  function bindSingletonStringSet(scope: ImportScope, name: string, value: string, varScoped: boolean): void {
    const targetScope = varScoped ? scope.varScope : scope;
    targetScope.bindings.set(name, null);
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
  }

  function singletonStringSetFor(scope: ImportScope, name: string): string | undefined {
    let current: ImportScope | undefined = scope;
    while (current) {
      if (current.singletonStringSets.has(name)) return current.singletonStringSets.get(name);
      current = current.parent;
    }
    return undefined;
  }

  function singletonStringSetInitializer(node: ts.Expression | undefined): string | undefined {
    if (!node) return undefined;
    const unwrapped = unwrapExpression(node);
    if (!ts.isNewExpression(unwrapped)) return undefined;
    const constructorExpression = unwrapExpression(unwrapped.expression);
    if (!ts.isIdentifier(constructorExpression)) return undefined;
    if (constructorExpression.text !== "Set") return undefined;
    if (!unwrapped.arguments || unwrapped.arguments.length === 0) return undefined;
    const argument = unwrapped.arguments[0];
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
    return ts.isIfStatement(callExpression.parent);
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
    switch (unwrapped.kind) {
      case ts.SyntaxKind.PropertyAccessExpression: {
        const propertyAccess = unwrapped as ts.PropertyAccessExpression;
        return { receiver: propertyAccess.expression, name: propertyAccess.name.text };
      }
      case ts.SyntaxKind.ElementAccessExpression: {
        const elementAccess = unwrapped as ts.ElementAccessExpression;
        const name = literalText(elementAccess.argumentExpression);
        return name ? { receiver: elementAccess.expression, name } : undefined;
      }
    }
    // Stryker disable next-line ConditionalExpression: falling through and an explicit undefined return are equivalent for non-member expressions.
    return undefined;
  }

  function staticDeclarationName(name: ts.PropertyName | undefined): string | undefined {
    switch (name?.kind) {
      case ts.SyntaxKind.Identifier:
      case ts.SyntaxKind.StringLiteral:
      case ts.SyntaxKind.NumericLiteral:
        return (name as ts.Identifier | ts.StringLiteral | ts.NumericLiteral).text;
      case ts.SyntaxKind.ComputedPropertyName:
        return literalText((name as ts.ComputedPropertyName).expression);
    }
    // Stryker disable next-line ConditionalExpression: unsupported or absent property names have no static declaration name.
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
      if (
        ts.isBinaryExpression(node)
        && isAssignmentOperatorKind(node.operatorToken.kind)
        && isSetPrototypeHasExpression(node.left)
      ) {
        mutated = true;
        return;
      }
      if (ts.isCallExpression(node)) {
        const callee = staticMemberAccess(node.expression);
        const calleeReceiver = callee ? unwrapExpression(callee.receiver) : undefined;
        const receiverName = calleeReceiver && ts.isIdentifier(calleeReceiver) ? calleeReceiver.text : undefined;
        if (
          callee
          && (receiverName === "Object" || receiverName === "Reflect")
          && callee.name === "defineProperty"
          && node.arguments.length >= 2
          && isSetPrototypeExpression(node.arguments[0])
        ) {
          const propertyName = literalText(node.arguments[1]);
          if (propertyName === undefined || propertyName === "has") {
            mutated = true;
            return;
          }
        }
        if (
          callee
          && receiverName === "Object"
          && callee.name === "defineProperties"
          && node.arguments.length >= 2
          && isSetPrototypeExpression(node.arguments[0])
        ) {
          const descriptors = unwrapExpression(node.arguments[1]);
          const definitelyOmitsHas = ts.isObjectLiteralExpression(descriptors)
            && descriptors.properties.every((property) => {
              const propertyName = staticDeclarationName(property.name);
              return propertyName !== undefined && propertyName !== "has";
            });
          if (!definitelyOmitsHas) {
            mutated = true;
            return;
          }
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
      if (ts.isParameter(node)) countBindingName(node.name);
      if (ts.isFunctionDeclaration(node)) {
        if (node.name) countDeclaration(node.name.text);
      }
      if (ts.isClassDeclaration(node)) {
        if (node.name) countDeclaration(node.name.text);
      }
      if (ts.isImportClause(node) && node.name) countDeclaration(node.name.text);
      if (ts.isNamespaceImport(node)) countDeclaration(node.name.text);
      if (ts.isImportSpecifier(node)) countDeclaration(node.name.text);
      if (ts.isImportEqualsDeclaration(node)) countDeclaration(node.name.text);
      ts.forEachChild(node, countDeclaredNames);
    }
    countDeclaredNames(sourceFile);
    if ((declarationCounts.get("Set") || 0) > 0) return new Map();
    if (mutatesSetPrototypeHas()) return new Map();
    for (const statement of sourceFile.statements) {
      if (!ts.isVariableStatement(statement) || !isConstDeclarationList(statement.declarationList)) continue;
      for (const declaration of statement.declarationList.declarations) {
        // Stryker disable next-line ConditionalExpression: non-Identifier binding names have no stable text key that an Identifier use can retrieve.
        if (!ts.isIdentifier(declaration.name)) continue;
        const value = singletonStringSetInitializer(declaration.initializer);
        // Stryker disable next-line ConditionalExpression: an undefined initializer value cannot produce a resolvable static module specifier.
        if (value === undefined) continue;
        candidates.set(declaration.name.text, { declarationStart: declaration.name.getStart(sourceFile), value });
      }
    }
    function visitCandidateUse(node: ts.Node): void {
      if (node.kind === ts.SyntaxKind.Identifier) {
        const identifier = node as ts.Identifier;
        if (candidates.has(identifier.text) && !isDeclarationIdentifier(identifier) && !isAllowedSingletonSetReference(identifier)) {
          unsafeNames.add(identifier.text);
        }
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

  function bindPattern(scope: ImportScope, name: ts.BindingName, kind: ImportBindingKind, varScoped: boolean): void {
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
    return staticMemberAccess(expression)?.name;
  }

  function staticPropertyReceiver(expression: ts.Expression): ts.Expression | undefined {
    return staticMemberAccess(expression)?.receiver;
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
    if (staticPropertyName(expression) !== "require") return false;
    const unwrappedReceiver = unwrapExpression(staticPropertyReceiver(expression)!);
    if (ts.isIdentifier(unwrappedReceiver)) {
      const receiverName = unwrappedReceiver.getText(sourceFile);
      return ["global", "globalThis"].includes(receiverName) && bindingFor(scope, receiverName) === undefined;
    }
    return unwrappedReceiver.kind === ts.SyntaxKind.ThisKeyword && scopeAllowsTopLevelThis(scope);
  }

  function isModuleRequireProperty(scope: ImportScope, expression: ts.Expression): boolean {
    if (staticPropertyName(expression) !== "require") return false;
    return isNodeModuleObject(scope, staticPropertyReceiver(expression)!);
  }

  function isProcessMainModuleRequireProperty(scope: ImportScope, expression: ts.Expression): boolean {
    if (staticPropertyName(expression) !== "require") return false;
    const receiver = unwrapExpression(staticPropertyReceiver(expression)!);
    if (staticPropertyName(receiver) !== "mainModule") return false;
    const root = unwrapExpression(staticPropertyReceiver(receiver)!);
    return ts.isIdentifier(root) && root.text === "process" && bindingFor(scope, "process") === undefined;
  }

  function isModuleConstructorLoadProperty(scope: ImportScope, expression: ts.Expression): boolean {
    if (staticPropertyName(expression) !== "_load") return false;
    const receiver = unwrapExpression(staticPropertyReceiver(expression)!);
    if (staticPropertyName(receiver) !== "constructor") return false;
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
    if (!node || !ts.isCallExpression(node) || !isRequireLikeExpression(scope, node.expression)) return undefined;
    return staticModuleSpecifier(scope, node.arguments[0]);
  }

  function isModuleNamespaceExpression(scope: ImportScope, expression: ts.Expression): boolean {
    const unwrapped = unwrapExpression(expression);
    if (ts.isIdentifier(unwrapped) && bindingFor(scope, unwrapped.text) === "moduleNamespace") return true;
    return isModulePackageSpecifier(literalRequireLikeSpecifier(scope, unwrapped));
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
      const receiverName = staticPropertyReceiver(unwrapped)!.getText(sourceFile);
      if (receiverName === "global") return "global.require";
      if (receiverName === "this") return "this.require";
      return "globalThis.require";
    }
    return undefined;
  }

  function literalFromApplyArray(scope: ImportScope, node: ts.Expression | undefined): string | undefined {
    if (!node) return undefined;
    const unwrapped = unwrapExpression(node);
    if (!ts.isArrayLiteralExpression(unwrapped)) return undefined;
    return staticModuleSpecifier(scope, unwrapped.elements[0]);
  }

  function requireCallArgument(scope: ImportScope, node: ts.CallExpression): { sourceName: string; specifier?: string } | undefined {
    const directName = requireLikeName(scope, node.expression);
    if (directName) {
      if (node.arguments.length < 1) return undefined;
      const specifier = staticModuleSpecifier(scope, node.arguments[0]);
      return { sourceName: directName, specifier };
    }

    const propertyName = staticPropertyName(node.expression);
    const receiver = staticPropertyReceiver(node.expression);
    if ((propertyName === "call" || propertyName === "apply") && receiver && isRequireLikeExpression(scope, receiver)) {
      const receiverName = requireLikeName(scope, receiver)!;
      if (propertyName === "call") {
        const specifier = staticModuleSpecifier(scope, node.arguments[1]);
        return { sourceName: `${receiverName}.call`, specifier };
      }
      const specifier = literalFromApplyArray(scope, node.arguments[1]);
      return { sourceName: `${receiverName}.apply`, specifier };
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
      return { sourceName: "Reflect.apply(require)", specifier };
    }
    return undefined;
  }

  function readonlySetHasGuard(scope: ImportScope, node: ts.Expression): { identifier: string; specifier: string } | undefined {
    const unwrapped = unwrapExpression(node);
    if (unwrapped.kind !== ts.SyntaxKind.CallExpression) return undefined;
    const callExpression = unwrapped as ts.CallExpression;
    if (callExpression.arguments.length !== 1) return undefined;
    const access = staticMemberAccess(callExpression.expression);
    // Stryker disable next-line ConditionalExpression: safe singleton candidates are invalidated by every non-`has` member use before guard recognition.
    if (access?.name !== "has") return undefined;
    const receiverName = unwrapExpression(access.receiver);
    if (!ts.isIdentifier(receiverName)) return undefined;
    const specifier = singletonStringSetFor(scope, receiverName.text);
    if (specifier === undefined) return undefined;
    const argument = callExpression.arguments[0];
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

  function addRequireCallReference(node: ts.CallExpression, sourceName: string, specifier: string | undefined): void {
    if (specifier) {
      addReference(specifier, "require", node, false);
    } else {
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

  function addDynamicExecutionRequireReferences(scope: ImportScope, node: ts.CallExpression): void {
    const sourceName = dynamicExecutionSourceName(scope, node);
    if (!sourceName) return;
    const modulePatterns = [
      { kind: "require" as const, pattern: /\brequire\s*\(\s*(["'`])([^"'`]+)\1/g },
      { kind: "dynamic-import" as const, pattern: /\bimport\s*\(\s*(["'`])([^"'`]+)\1/g },
    ];
    let hasComputedArgument = false;
    for (const argument of node.arguments) {
      const sourceText = literalText(argument);
      if (sourceText === undefined) {
        hasComputedArgument = true;
        continue;
      }
      for (const { kind, pattern } of modulePatterns) {
        for (const match of sourceText.matchAll(pattern)) {
          addReference(match[2]!, kind, node, false);
        }
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
    }
  }

  function importTypeSpecifier(node: ts.ImportTypeNode): string | undefined {
    if (!ts.isLiteralTypeNode(node.argument)) return undefined;
    const literal = node.argument.literal;
    return ts.isStringLiteral(literal) || ts.isNoSubstitutionTemplateLiteral(literal) ? literal.text : undefined;
  }

  function predeclareStatement(scope: ImportScope, node: ts.Node): void {
    if (ts.isVariableStatement(node)) {
      const varScoped = isVarScopedDeclarationList(node.declarationList);
      for (const declaration of node.declarationList.declarations) bindPattern(scope, declaration.name, null, varScoped);
    } else if (ts.isFunctionDeclaration(node) && node.name) {
      bindLexicalName(scope, node.name.text, null);
    } else if (ts.isClassDeclaration(node) && node.name) {
      bindLexicalName(scope, node.name.text, null);
    } else if (ts.isImportDeclaration(node)) {
      const clause = node.importClause;
      if (!clause) return;
      if (clause.name) bindLexicalName(scope, clause.name.text, null);
      const namedBindings = clause.namedBindings;
      if (namedBindings && ts.isNamespaceImport(namedBindings)) {
        bindLexicalName(scope, namedBindings.name.text, null);
      } else if (namedBindings && ts.isNamedImports(namedBindings)) {
        for (const element of namedBindings.elements) bindLexicalName(scope, element.name.text, null);
      }
    } else if (ts.isImportEqualsDeclaration(node)) {
      bindLexicalName(scope, node.name.text, null);
    }
  }

  function predeclareScope(scope: ImportScope, statements: ts.NodeArray<ts.Statement>): void {
    for (const statement of statements) predeclareStatement(scope, statement);
  }

  function bindImportClause(scope: ImportScope, node: ts.ImportDeclaration): void {
    if (!ts.isStringLiteral(node.moduleSpecifier) || !isModulePackageSpecifier(node.moduleSpecifier.text)) return;
    const clause = node.importClause;
    if (!clause || clause.isTypeOnly) return;
    if (clause.name) bindLexicalName(scope, clause.name.text, "moduleNamespace");
    const namedBindings = clause.namedBindings;
    if (namedBindings && ts.isNamedImports(namedBindings)) {
      for (const element of namedBindings.elements) {
        if (element.isTypeOnly) continue;
        if ((element.propertyName?.text || element.name.text) === "createRequire") bindLexicalName(scope, element.name.text, "createRequire");
      }
    } else if (namedBindings && ts.isNamespaceImport(namedBindings)) {
      bindLexicalName(scope, namedBindings.name.text, "moduleNamespace");
    }
  }

  function visitVariableDeclaration(scope: ImportScope, node: ts.VariableDeclaration): void {
    if (node.initializer) visit(scope, node.initializer);
    const declarationList = node.parent as ts.VariableDeclarationList;
    const varScoped = isVarScopedDeclarationList(declarationList);
    const constScoped = isConstDeclarationList(declarationList);
    if (node.initializer && ts.isIdentifier(node.name)) {
      const kind = bindingKindFromInitializer(scope, node.initializer);
      const stringValue = constScoped ? staticModuleSpecifier(scope, node.initializer) : undefined;
      const singletonSet = constScoped ? safeSingletonStringSets.get(node.name.getStart(sourceFile)) : undefined;
      if (kind) bindName(scope, node.name.text, kind, varScoped);
      else if (stringValue !== undefined) bindStringConstant(scope, node.name.text, stringValue, varScoped);
      else if (singletonSet) bindSingletonStringSet(scope, singletonSet.name, singletonSet.value, varScoped);
      else bindName(scope, node.name.text, null, varScoped);
    } else if (node.initializer && ts.isObjectBindingPattern(node.name)) {
      const moduleSpecifier = literalRequireLikeSpecifier(scope, node.initializer);
      if (moduleSpecifier && isModulePackageSpecifier(moduleSpecifier)) {
        for (const element of node.name.elements) {
          // Stryker disable next-line ConditionalExpression: nested binding patterns do not expose a retrievable local Identifier key.
          if (!ts.isIdentifier(element.name)) continue;
          const propertyName = element.propertyName && ts.isIdentifier(element.propertyName) ? element.propertyName.text : element.name.text;
          bindName(scope, element.name.text, propertyName === "createRequire" ? "createRequire" : null, varScoped);
        }
      } else if (isNodeModuleObject(scope, node.initializer)) {
        for (const element of node.name.elements) {
          // Stryker disable next-line ConditionalExpression: nested binding patterns do not expose a retrievable local Identifier key.
          if (!ts.isIdentifier(element.name)) continue;
          const propertyName = element.propertyName && ts.isIdentifier(element.propertyName) ? element.propertyName.text : element.name.text;
          bindName(scope, element.name.text, propertyName === "require" ? "require" : null, varScoped);
        }
      } else {
        bindPattern(scope, node.name, null, varScoped);
      }
    } else {
      bindPattern(scope, node.name, null, varScoped);
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
    for (const parameter of node.parameters) {
      // Stryker disable next-line BooleanLiteral: childScope is itself the function var-scope, so either routing choice selects the same map.
      bindPattern(childScope, parameter.name, null, false);
    }
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
    } else if (ts.isExportDeclaration(node)) {
      const moduleSpecifier = node.moduleSpecifier;
      if (moduleSpecifier && ts.isStringLiteral(moduleSpecifier)) {
        addReference(moduleSpecifier.text, "export-from", node, Boolean(node.isTypeOnly));
      }
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
        if (requireCall) addRequireCallReference(node, requireCall.sourceName, requireCall.specifier);
        addDynamicExecutionRequireReferences(scope, node);
      }
    } else if (ts.isIfStatement(node)) {
      if (addReadonlySetGuardedRequireIfSafe(scope, node)) return;
    } else if (ts.isForStatement(node)) {
      const loopScope = createImportScope(scope, false);
      if (node.initializer) visit(loopScope, node.initializer);
      if (node.condition) visit(loopScope, node.condition);
      if (node.incrementor) visit(loopScope, node.incrementor);
      visit(loopScope, node.statement);
      return;
    } else if (ts.isForInStatement(node) || ts.isForOfStatement(node)) {
      const loopScope = createImportScope(scope, false);
      visit(loopScope, node.initializer);
      visit(loopScope, node.expression);
      visit(loopScope, node.statement);
      return;
    } else if (ts.isSwitchStatement(node)) {
      visit(scope, node.expression);
      const switchScope = createImportScope(scope, false);
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
      const catchScope = createImportScope(scope, false);
      if (node.variableDeclaration) bindPattern(catchScope, node.variableDeclaration.name, null, false);
      visit(catchScope, node.block);
      return;
    } else if (ts.isSourceFile(node)) {
      visitStatementList(scope, node.statements);
      return;
    } else if (ts.isBlock(node) || ts.isModuleBlock(node)) {
      visitStatementList(createImportScope(scope, false), node.statements);
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
  switch (name.kind) {
    case ts.SyntaxKind.Identifier:
    case ts.SyntaxKind.StringLiteral:
    case ts.SyntaxKind.NumericLiteral:
      return (name as ts.Identifier | ts.StringLiteral | ts.NumericLiteral).text || undefined;
  }
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

function hasInternalTag(node: ts.Node): boolean {
  return ts.getJSDocTags(node).some((tag) => tag.tagName.text === "internal");
}

function resolveLocalModuleFile(fromFilePath: string, specifier: string): string | undefined {
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
    if (hasInternalTag(node)) return;
    if (ts.isModuleDeclaration(node) && hasExportModifier(node)) {
      const exportedName = exportedNameFromDeclarationName(node.name);
      if (exportedName) symbols.add(exportedName);
      return;
    }
    if ((ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node) || ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node) || ts.isEnumDeclaration(node)) && hasExportModifier(node)) {
      if (ts.getCombinedModifierFlags(node as ts.Declaration) & ts.ModifierFlags.Default) {
        symbols.add("default");
      } else {
        const exportedName = exportedNameFromDeclarationName(node.name!);
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
    } else if (ts.isExportDeclaration(node)) {
      if (node.exportClause && ts.isNamedExports(node.exportClause)) {
        for (const element of node.exportClause.elements) {
          symbols.add(element.name.text);
        }
      } else if (node.exportClause && ts.isNamespaceExport(node.exportClause)) {
        symbols.add(node.exportClause.name.text);
      } else {
        const moduleSpecifier = node.moduleSpecifier as ts.StringLiteral;
        const targetFilePath = resolveProjectModuleFile(filePath, moduleSpecifier.text);
        if (targetFilePath) {
          for (const exportedSymbol of extractPublicSymbols(targetFilePath, visitedFiles)) {
            if (exportedSymbol !== "default") symbols.add(exportedSymbol);
          }
        }
      }
      return;
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return symbols;
}

function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, " ");
}

/** @internal */
export function syntaxPublicSurfaceSignatureParts(filePath: string): string[] {
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
    if (hasInternalTag(node)) return;
    if (ts.isModuleDeclaration(node) && hasExportModifier(node)) {
      const name = exportedNameFromDeclarationName(node.name);
      if (name) parts.push(`namespace:${name}:${normalizeWhitespace(node.getText(sourceFile))}`);
      return;
    }
    if (ts.isFunctionDeclaration(node) && hasExportModifier(node)) {
      const name = ts.getCombinedModifierFlags(node) & ts.ModifierFlags.Default
        ? "default"
        : node.name ? exportedNameFromDeclarationName(node.name) : undefined;
      if (name) {
        const params = node.parameters.map((parameter) => `${typeText(parameter.name)}:${typeText(parameter.type)}`).join(",");
        parts.push(`function:${name}(${params}):${typeText(node.type)}`);
      }
    } else if ((ts.isClassDeclaration(node) || ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node) || ts.isEnumDeclaration(node)) && hasExportModifier(node)) {
      const name = ts.getCombinedModifierFlags(node) & ts.ModifierFlags.Default
        ? "default"
        : node.name ? exportedNameFromDeclarationName(node.name) : undefined;
      if (name) parts.push(`${ts.SyntaxKind[node.kind]}:${name}:${normalizeWhitespace(node.getText(sourceFile))}`);
    } else if (ts.isVariableStatement(node) && hasExportModifier(node)) {
      for (const declaration of node.declarationList.declarations) {
        for (const name of bindingNames(declaration.name)) parts.push(`variable:${name}:${typeText(declaration.type)}`);
      }
    } else if (ts.isImportEqualsDeclaration(node) && hasExportModifier(node)) {
      parts.push(`export-import:${node.name.text}:${typeText(node.moduleReference)}`);
    } else if (ts.isExportAssignment(node)) {
      parts.push("export:default");
    } else if (ts.isExportDeclaration(node)) {
      if (node.exportClause && ts.isNamedExports(node.exportClause)) {
        for (const element of node.exportClause.elements) parts.push(`export:${element.name.text}`);
      } else if (node.exportClause && ts.isNamespaceExport(node.exportClause)) {
        parts.push(`namespace:${node.exportClause.name.text}`);
      } else {
        parts.push(`export-star:${(node.moduleSpecifier as ts.StringLiteral).text}`);
      }
      return;
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return parts.sort((left, right) => left.localeCompare(right));
}

function findNearestTsConfig(filePath: string): string | undefined {
  let directoryPath = path.dirname(path.resolve(filePath));
  const visited = new Set<string>();
  while (!visited.has(directoryPath)) {
    visited.add(directoryPath);
    const tsconfigPath = path.join(directoryPath, "tsconfig.json");
    if (fs.existsSync(tsconfigPath)) return tsconfigPath;
    if (fs.existsSync(path.join(directoryPath, ".git"))) return undefined;
    directoryPath = path.dirname(directoryPath);
  }
  return undefined;
}

/** @internal */
export function declarationEmitCompilerOptions(filePath: string): ts.CompilerOptions {
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
    const parsedConfig = ts.parseJsonConfigFileContent(configFile.config, ts.sys, path.dirname(normalizedTsconfigPath), undefined, normalizedTsconfigPath);
    options = { ...defaultOptions, ...parsedConfig.options };
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
    newLine: ts.NewLineKind.LineFeed,
    removeComments: true,
    sourceMap: false,
    stripInternal: true,
    tsBuildInfoFile: undefined,
  };
}

/** @internal */
export function collectPublicDeclarationRoots(filePath: string, visitedFiles = new Set<string>()): string[] {
  const normalizedFilePath = path.resolve(filePath);
  if (visitedFiles.has(normalizedFilePath) || !fs.existsSync(normalizedFilePath)) return [];
  visitedFiles.add(normalizedFilePath);
  const roots = [normalizedFilePath];
  const sourceText = fs.readFileSync(normalizedFilePath, "utf8");
  // Stryker disable next-line BooleanLiteral: parent pointers are not used while collecting declaration roots.
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
  return text.split("\n").map((line) => line.trim()).filter(Boolean).join("\n");
}

function sourceTextWithoutInternalDeclarations(filePath: string): string {
  const sourceText = fs.readFileSync(filePath, "utf8");
  // Stryker disable next-line BooleanLiteral: parent pointers are not used while collecting internal declaration line ranges.
  const sourceFile = ts.createSourceFile(filePath, sourceText, ts.ScriptTarget.Latest, true, sourceKindForPath(filePath));
  // Stryker disable next-line ArrayDeclaration: a non-range sentinel in this private, typed collection has no valid line bounds and cannot remove source text.
  const lineRanges: Array<{ start: number; end: number }> = [];
  function visit(node: ts.Node): void {
    if (hasInternalTag(node)) {
      lineRanges.push({
        start: sourceFile.getLineAndCharacterOfPosition(node.getFullStart()).line,
        end: sourceFile.getLineAndCharacterOfPosition(node.getEnd()).line,
      });
      return;
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  // Stryker disable next-line ConditionalExpression: with no internal ranges, declaration emit observes the same source text after line splitting.
  if (lineRanges.length === 0) return sourceText;
  const removedLines = new Set<number>();
  for (const range of lineRanges) {
    for (let line = range.start; line <= range.end; line += 1) removedLines.add(line);
  }
  const lines = sourceText.split("\n");
  // Stryker disable next-line StringLiteral: declaration emit normalizes equivalent internal-stripped source text; public surface output is asserted black-box.
  return lines.filter((_, index) => !removedLines.has(index)).join("\n");
}

function normalizedDeclarationSourceText(filePath: string): string {
  const sourceText = fs.readFileSync(filePath, "utf8");
  const sourceFile = ts.createSourceFile(filePath, sourceText, ts.ScriptTarget.Latest, true, sourceKindForPath(filePath));
  const transformer: ts.TransformerFactory<ts.SourceFile> = (context) => {
    const visit: ts.Visitor = (node) => {
      if (hasInternalTag(node)) return undefined;
      return ts.visitEachChild(node, visit, context);
    };
    return (root) => ts.visitNode(root, visit) as ts.SourceFile;
  };
  const result = ts.transform(sourceFile, [transformer]);
  const declarationText = ts.createPrinter({
    newLine: ts.NewLineKind.LineFeed,
    removeComments: true,
  }).printFile(result.transformed[0] as ts.SourceFile);
  result.dispose();
  return declarationText;
}

/** @internal */
export function declarationTextForRoot(rootFile: string, options: ts.CompilerOptions): string {
  if (isDeclarationPath(rootFile)) return normalizedDeclarationSourceText(rootFile);
  try {
    return ts.transpileDeclaration(sourceTextWithoutInternalDeclarations(rootFile), {
      compilerOptions: options,
      fileName: rootFile,
    }).outputText;
  } catch {
    // Declaration emit failures fall back to the syntax surface.
  }
  return "";
}

/** @internal */
export function declarationPublicSurfaceSignatureParts(filePath: string): string[] {
  if (isPythonPath(filePath)) return [];
  const rootFiles = collectPublicDeclarationRoots(filePath);
  const options = declarationEmitCompilerOptions(filePath);
  const declarations: { orderKey: string; text: string }[] = [];
  for (const rootFile of rootFiles) {
    const outputText = declarationTextForRoot(rootFile, options);
    const normalizedText = normalizeDeclarationText(outputText);
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
  const declarationParts = declarationPublicSurfaceSignatureParts(filePath);
  return declarationParts.length > 0 ? declarationParts : syntaxPublicSurfaceSignatureParts(filePath);
}

export function publicSurfaceHash(filePath: string): string {
  return crypto.createHash("sha256").update(publicSurfaceSignatureParts(filePath).join("\n")).digest("hex");
}
