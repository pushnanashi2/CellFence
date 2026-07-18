import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import ts from "typescript";

import {
  absolutePath,
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
  kind: ImportKind;
  typeOnly: boolean;
  line: number;
};

export type ImportWarning = {
  ruleId: "CELLFENCE_UNSUPPORTED_DYNAMIC_REQUIRE" | "CELLFENCE_UNSUPPORTED_DYNAMIC_IMPORT" | "CELLFENCE_UNSUPPORTED_PYTHON_SYNTAX";
  severity: "warning";
  filePath: string;
  message: string;
  details: { line?: number; offset?: number; kind?: string };
};

type ImportScanContext = FileIndexContext & {
  rootDir: string;
};

type PathAliasContext = {
  rootDir?: string;
  pathAliases: PathAlias[];
};

const IMPORT_SCAN_HINT = /\b(?:from|import|export|require)\b/;

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

export function candidateModulePaths(basePath: string): string[] {
  const candidates: string[] = [];
  const normalizedBasePath = normalizePath(basePath);
  const extension = path.extname(normalizedBasePath);
  addUniquePath(candidates, normalizedBasePath);
  if (extension) {
    const basePathWithoutExtension = normalizedBasePath.slice(0, -extension.length);
    for (const sourceExtension of sourceExtensionsForRuntimeSpecifier(extension)) {
      addUniquePath(candidates, `${basePathWithoutExtension}${sourceExtension}`);
    }
    return candidates;
  }
  for (const sourceExtension of SOURCE_EXTENSIONS) {
    addUniquePath(candidates, `${normalizedBasePath}${sourceExtension}`);
  }
  for (const sourceExtension of SOURCE_EXTENSIONS) {
    addUniquePath(candidates, `${normalizedBasePath}/index${sourceExtension}`);
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
  const basePath = path.resolve(path.dirname(importerAbsolutePath), specifier);
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
  return inspection.imports.map((reference) => ({
    importerPath,
    specifier: reference.specifier,
    kind: "import",
    typeOnly: false,
    line: reference.line,
  }));
}

export function extractImports(context: ImportScanContext, filePath: string, warnings: { push(warning: ImportWarning): void }): ImportReference[] {
  const sourceText = readSourceText(context, filePath);
  if (isPythonPath(filePath)) return extractPythonImports(context, filePath, warnings);
  // Stryker disable next-line ConditionalExpression,ArrayDeclaration: the hint is a performance prefilter; parsing no-import files still returns no references.
  if (!IMPORT_SCAN_HINT.test(sourceText)) return [];
  const sourceFile = parseSourceFile(context, filePath);
  const references: ImportReference[] = [];
  const importerPath = repoPath(context.rootDir, filePath);

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
    ) {
      if (ts.isStringLiteral(node.arguments[0])) {
        addReference(node.arguments[0].text, "require", node, false);
      } else {
        warnings.push({
          ruleId: "CELLFENCE_UNSUPPORTED_DYNAMIC_REQUIRE",
          severity: "warning",
          filePath: importerPath,
          message: `computed require() cannot be resolved statically at line ${getLineNumber(sourceFile, node)}`,
          details: { line: getLineNumber(sourceFile, node) },
        });
      }
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const [specifierNode] = node.arguments;
      if (specifierNode && ts.isStringLiteral(specifierNode)) {
        addReference(specifierNode.text, "dynamic-import", node, false);
      } else {
        warnings.push({
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

function exportedNameFromDeclarationName(name: ts.DeclarationName): string | undefined {
  // Stryker disable next-line ConditionalExpression: supported declaration names are identifiers/string/numeric literals; other node kinds are invalid export names here.
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name.text || undefined;
  return undefined;
}

function resolveLocalModuleFile(fromFilePath: string, specifier: string): string | undefined {
  // Stryker disable next-line MethodExpression: package specifiers are rejected by the leading-dot check; changing the secondary absolute-path guard is equivalent for non-local specifiers.
  if (!specifier.startsWith(".") && !specifier.startsWith("/")) return undefined;
  const basePath = path.resolve(path.dirname(fromFilePath), specifier);
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
        const exportedName = exportedNameFromDeclarationName(declaration.name);
        // Stryker disable next-line ConditionalExpression: valid exported variable declarations have names.
        if (exportedName) symbols.add(exportedName);
      }
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
          const targetFilePath = resolveLocalModuleFile(filePath, node.moduleSpecifier.text);
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

function publicSurfaceSignatureParts(filePath: string): string[] {
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
        const name = exportedNameFromDeclarationName(declaration.name);
        // Stryker disable next-line ConditionalExpression: valid exported variable declarations have names.
        if (name) parts.push(`variable:${name}:${typeText(declaration.type)}`);
      }
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

export function publicSurfaceHash(filePath: string): string {
  return crypto.createHash("sha256").update(publicSurfaceSignatureParts(filePath).join("\n")).digest("hex");
}
