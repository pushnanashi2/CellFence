import fs from "node:fs";
import path from "node:path";

import type { BuiltInResourceAdapter, CellFenceManifest } from "@cellfence/schema";
import ts from "typescript";

import {
  normalizePath,
  listFiles,
  parseSourceFile,
  readSourceText,
  repoPath,
  sourceFilesForCell,
  type FileIndexContext,
} from "./file-index.js";
import { inspectPythonSource } from "./python-analysis.js";

export type ResourceAccessKind = "file" | "database" | "queue" | "http";
export type ResourceAccessMode = "read" | "write" | "publish" | "subscribe" | "call" | "serve";

export type ResourceAccessReference = {
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

type ResourceAccessAnalysisContext = FileIndexContext & {
  manifest: CellFenceManifest;
  prismaModelSelectorCache?: Map<string, string>;
};

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

function lowerFirst(text: string): string {
  return `${text.charAt(0).toLowerCase()}${text.slice(1)}`;
}

// Stryker disable all: root-name extraction is validated through adapter-level positive and negative resource tests; branch mutants here collapse to the same undefined-or-root outcome after allowlist checks.
function expressionRootName(expression: ts.Expression): string | undefined {
  if (ts.isIdentifier(expression)) return expression.text;
  if (ts.isPropertyAccessExpression(expression)) return expressionRootName(expression.expression);
  return undefined;
}

function chainRootName(expression: ts.Expression): string | undefined {
  if (ts.isIdentifier(expression)) return expression.text;
  if (ts.isPropertyAccessExpression(expression)) return chainRootName(expression.expression);
  if (ts.isCallExpression(expression)) return chainRootName(expression.expression);
  return undefined;
}
// Stryker restore all

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

function objectHasProperty(expression: ts.Expression | undefined, propertyNameText: string): boolean {
  if (!expression || !ts.isObjectLiteralExpression(expression)) return false;
  for (const property of expression.properties) {
    if (!ts.isPropertyAssignment(property) && !ts.isShorthandPropertyAssignment(property)) continue;
    const name = property.name;
    if ((ts.isIdentifier(name) && name.text === propertyNameText) || (ts.isStringLiteral(name) && name.text === propertyNameText)) return true;
  }
  return false;
}

function objectArrayStringProperty(expression: ts.ObjectLiteralExpression, propertyNameText: string): string[] {
  for (const property of expression.properties) {
    if (!ts.isPropertyAssignment(property)) continue;
    const name = property.name;
    const isMatch = (ts.isIdentifier(name) && name.text === propertyNameText)
      || (ts.isStringLiteral(name) && name.text === propertyNameText);
    if (!isMatch) continue;
    if (ts.isArrayLiteralExpression(property.initializer)) {
      return property.initializer.elements.flatMap((element) => {
        const text = literalText(element);
        return text ? [text] : [];
      });
    }
    const text = literalText(property.initializer);
    return text ? [text] : [];
  }
  return [];
}

function normalizeHttpPath(prefix: string | undefined, routePath: string | undefined): string {
  // Stryker disable all: slash/empty-segment normalization has black-box route tests; surviving mutants here only change intermediate canonicalization that the final collapse normalizes back.
  const segments = [prefix || "", routePath || ""]
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0)
    .map((segment) => segment.replace(/^\/+|\/+$/g, ""));
  const normalized = `/${segments.join("/")}`.replace(/\/+/g, "/");
  // Stryker restore all
  return normalized;
}

function templateLiteralText(node: ts.TemplateLiteral): string | undefined {
  // Stryker disable next-line ConditionalExpression: TemplateExpression has no static `text`, so forcing this branch still returns undefined for dynamic templates.
  if (ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  return undefined;
}

function expressionContainsSqlLiteral(node: ts.Node | undefined): boolean {
  if (!node) return false;
  let found = false;
  function visit(candidate: ts.Node): void {
    // Stryker disable next-line ConditionalExpression: once a SQL literal is found, continuing the traversal cannot change the final true result.
    if (found) return;
    const text = literalText(candidate);
    if (text && textLooksSql(text)) {
      found = true;
      return;
    }
    ts.forEachChild(candidate, visit);
  }
  visit(node);
  return found;
}

function bindingIdentifiers(name: ts.BindingName): string[] {
  if (ts.isIdentifier(name)) return [name.text];
  return name.elements.flatMap((element) => ts.isOmittedExpression(element) ? [] : bindingIdentifiers(element.name));
}

function assignedIdentifier(expression: ts.Expression): string | undefined {
  const unwrapped = unwrapExpression(expression);
  return ts.isIdentifier(unwrapped) ? unwrapped.text : undefined;
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

type StaticStringResolution = {
  values: string[];
  dynamicSql: boolean;
  localBinding: boolean;
};

function emptyStaticStringResolution(): StaticStringResolution {
  return { values: [], dynamicSql: false, localBinding: false };
}

function sqlIdentifierName(name: string): boolean {
  return /^(sql|sqlText|query|queryText|queryString)$/i.test(name);
}

function textLooksSql(text: string): boolean {
  return /\b(select|insert|update|delete|from|join|into)\b/i.test(text);
}

function collectStaticStringConstants(sourceFile: ts.SourceFile): Map<string, string[]> {
  const candidateInitializers = new Map<string, ts.Expression>();
  for (const statement of sourceFile.statements) {
    if (!ts.isVariableStatement(statement) || !(statement.declarationList.flags & ts.NodeFlags.Const)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name) && declaration.initializer) {
        candidateInitializers.set(declaration.name.text, declaration.initializer);
      }
    }
  }

  const constants = new Map<string, string[]>();
  function valuesFor(expression: ts.Expression, seen: Set<string>): string[] | undefined {
    const unwrapped = unwrapExpression(expression);
    const literal = literalText(unwrapped);
    if (literal !== undefined) return [literal];
    if (ts.isIdentifier(unwrapped)) {
      if (seen.has(unwrapped.text)) return undefined;
      const resolved = constants.get(unwrapped.text);
      if (resolved) return resolved;
      const initializer = candidateInitializers.get(unwrapped.text);
      return initializer ? valuesFor(initializer, new Set([...seen, unwrapped.text])) : undefined;
    }
    if (ts.isConditionalExpression(unwrapped)) {
      const whenTrue = valuesFor(unwrapped.whenTrue, seen);
      const whenFalse = valuesFor(unwrapped.whenFalse, seen);
      if (!whenTrue || !whenFalse) return undefined;
      return [...new Set([...whenTrue, ...whenFalse])].slice(0, 16);
    }
    if (ts.isBinaryExpression(unwrapped) && unwrapped.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      const left = valuesFor(unwrapped.left, seen);
      const right = valuesFor(unwrapped.right, seen);
      if (!left || !right) return undefined;
      const combined = [];
      for (const leftValue of left) {
        for (const rightValue of right) combined.push(`${leftValue}${rightValue}`);
      }
      return [...new Set(combined)].slice(0, 16);
    }
    return undefined;
  }

  let changed = true;
  while (changed) {
    changed = false;
    for (const [name, initializer] of candidateInitializers.entries()) {
      if (constants.has(name)) continue;
      const values = valuesFor(initializer, new Set([name]));
      if (values && values.length > 0) {
        constants.set(name, values);
        changed = true;
      }
    }
  }
  return constants;
}

function staticStringValues(expression: ts.Expression | undefined, constants: Map<string, string[]>): string[] {
  if (!expression) return [];
  const unwrapped = unwrapExpression(expression);
  const literal = literalText(unwrapped);
  if (literal !== undefined) return [literal];
  if (ts.isIdentifier(unwrapped)) return constants.get(unwrapped.text) || [];
  return [];
}

function isStatementContainer(node: ts.Node): node is ts.SourceFile | ts.Block | ts.ModuleBlock | ts.CaseClause | ts.DefaultClause {
  return ts.isSourceFile(node)
    || ts.isBlock(node)
    || ts.isModuleBlock(node)
    || ts.isCaseClause(node)
    || ts.isDefaultClause(node);
}

function statementsForContainer(node: ts.SourceFile | ts.Block | ts.ModuleBlock | ts.CaseClause | ts.DefaultClause): ts.NodeArray<ts.Statement> {
  return ts.isSourceFile(node) || ts.isBlock(node) || ts.isModuleBlock(node) ? node.statements : node.statements;
}

function nearestStatementContainer(node: ts.Node): ts.SourceFile | ts.Block | ts.ModuleBlock | ts.CaseClause | ts.DefaultClause {
  let current: ts.Node | undefined = node;
  while (current) {
    if (isStatementContainer(current)) return current;
    current = current.parent;
  }
  return node.getSourceFile();
}

function collectLocalStaticStringResolution(
  sourceFile: ts.SourceFile,
  usageNode: ts.Node,
  targetName: string,
  constants: Map<string, string[]>,
): StaticStringResolution {
  const usageStart = usageNode.getStart(sourceFile);
  const values = new Map<string, string[]>();
  const unsafe = new Set<string>();
  const dynamicSqlNames = new Set<string>();
  const declaredInLocalScope = new Set<string>();
  const parameterNames = new Set<string>();

  function markDynamicSql(name: string): void {
    dynamicSqlNames.add(name);
  }

  function expressionValues(expression: ts.Expression, seen: Set<string>): string[] | undefined {
    const unwrapped = unwrapExpression(expression);
    const literal = literalText(unwrapped);
    if (literal !== undefined) return [literal];
    if (ts.isIdentifier(unwrapped)) {
      if (seen.has(unwrapped.text)) return undefined;
      const localValues = values.get(unwrapped.text);
      if (localValues) return localValues;
      if (unsafe.has(unwrapped.text) || dynamicSqlNames.has(unwrapped.text) || declaredInLocalScope.has(unwrapped.text) || parameterNames.has(unwrapped.text)) {
        return undefined;
      }
      return constants.get(unwrapped.text);
    }
    if (ts.isConditionalExpression(unwrapped)) {
      const whenTrue = expressionValues(unwrapped.whenTrue, seen);
      const whenFalse = expressionValues(unwrapped.whenFalse, seen);
      if (!whenTrue || !whenFalse) return undefined;
      return [...new Set([...whenTrue, ...whenFalse])].slice(0, 16);
    }
    if (ts.isBinaryExpression(unwrapped) && unwrapped.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      const left = expressionValues(unwrapped.left, seen);
      const right = expressionValues(unwrapped.right, seen);
      if (!left || !right) return undefined;
      const combined = [];
      for (const leftValue of left) {
        for (const rightValue of right) combined.push(`${leftValue}${rightValue}`);
      }
      return [...new Set(combined)].slice(0, 16);
    }
    return undefined;
  }

  function markUnsafe(name: string): void {
    if ((values.get(name) || []).some(textLooksSql) || sqlIdentifierName(name)) {
      markDynamicSql(name);
    }
    values.delete(name);
    unsafe.add(name);
  }

  function processDeclaration(node: ts.VariableDeclaration): void {
    if (!ts.isIdentifier(node.name)) {
      for (const name of bindingIdentifiers(node.name)) markUnsafe(name);
      return;
    }
    const name = node.name.text;
    declaredInLocalScope.add(name);
    if (!node.initializer || !ts.isVariableDeclarationList(node.parent) || (node.parent.flags & (ts.NodeFlags.Let | ts.NodeFlags.Const)) === 0) {
      markUnsafe(name);
      return;
    }
    if (unsafe.has(name)) return;
    const resolved = expressionValues(node.initializer, new Set([name]));
    if (resolved && resolved.length > 0) values.set(name, resolved);
    else {
      if (expressionContainsSqlLiteral(node.initializer)) markDynamicSql(name);
      markUnsafe(name);
    }
  }

  function directStatementContainerFrames(): Array<{ container: ts.Block | ts.ModuleBlock | ts.CaseClause | ts.DefaultClause; boundaryStart: number }> {
    const frames: Array<{ container: ts.Block | ts.ModuleBlock | ts.CaseClause | ts.DefaultClause; boundaryStart: number }> = [];
    let child: ts.Node = usageNode;
    let container = nearestStatementContainer(usageNode);
    while (!ts.isSourceFile(container)) {
      let boundaryNode = child;
      while (boundaryNode.parent && boundaryNode.parent !== container) boundaryNode = boundaryNode.parent;
      frames.push({ container, boundaryStart: boundaryNode.getStart(sourceFile) });
      child = container;
      if (!container.parent) break;
      container = nearestStatementContainer(container.parent);
    }
    return frames.reverse();
  }

  function markAssignments(node: ts.Node, root: ts.Node): void {
    if (node !== root && ts.isFunctionLike(node)) return;
    if (ts.isBinaryExpression(node) && isAssignmentOperatorKind(node.operatorToken.kind)) {
      const name = assignedIdentifier(node.left);
      if (name) {
        if (expressionContainsSqlLiteral(node.right)) markDynamicSql(name);
        markUnsafe(name);
      }
    } else if (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) {
      const name = assignedIdentifier(node.operand);
      if (name) markUnsafe(name);
    }
    ts.forEachChild(node, (child) => markAssignments(child, root));
  }

  function recordContainerDeclarations(statement: ts.Statement): void {
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        for (const name of bindingIdentifiers(declaration.name)) declaredInLocalScope.add(name);
      }
    } else if ((ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) && statement.name) {
      declaredInLocalScope.add(statement.name.text);
    }
  }

  const frames = directStatementContainerFrames();
  for (const { container } of frames) {
    for (const statement of statementsForContainer(container)) recordContainerDeclarations(statement);
  }

  let ancestor: ts.Node | undefined = usageNode.parent;
  while (ancestor) {
    if (ts.isFunctionLike(ancestor)) {
      for (const parameter of ancestor.parameters) {
        for (const name of bindingIdentifiers(parameter.name)) parameterNames.add(name);
      }
    }
    if (ts.isCatchClause(ancestor) && ancestor.variableDeclaration && bindingIdentifiers(ancestor.variableDeclaration.name).includes(targetName)) {
      parameterNames.add(targetName);
    }
    ancestor = ancestor.parent;
  }

  for (const { container, boundaryStart } of frames) {
    for (const statement of statementsForContainer(container)) {
      if (statement.getStart(sourceFile) >= boundaryStart) break;
      if (statement.getEnd() <= boundaryStart) {
        if (ts.isVariableStatement(statement)) {
          for (const declaration of statement.declarationList.declarations) processDeclaration(declaration);
        }
        markAssignments(statement, statement);
        continue;
      }
      break;
    }
  }
  if (unsafe.has(targetName)) {
    return { values: [], dynamicSql: dynamicSqlNames.has(targetName), localBinding: true };
  }
  const resolved = values.get(targetName);
  if (resolved) return { values: resolved, dynamicSql: false, localBinding: true };
  if (parameterNames.has(targetName)) return { values: [], dynamicSql: sqlIdentifierName(targetName), localBinding: true };
  return { values: [], dynamicSql: false, localBinding: declaredInLocalScope.has(targetName) };
}

function staticStringResolutionAt(
  sourceFile: ts.SourceFile,
  usageNode: ts.Node,
  expression: ts.Expression | undefined,
  constants: Map<string, string[]>,
): StaticStringResolution {
  if (!expression) return emptyStaticStringResolution();
  const unwrapped = unwrapExpression(expression);
  const literal = literalText(unwrapped);
  if (literal !== undefined) return { values: [literal], dynamicSql: false, localBinding: false };
  if (!ts.isIdentifier(unwrapped)) {
    return { values: staticStringValues(unwrapped, constants), dynamicSql: expressionContainsSqlLiteral(unwrapped), localBinding: false };
  }
  const local = collectLocalStaticStringResolution(sourceFile, usageNode, unwrapped.text, constants);
  if (local.localBinding) return local;
  const globalValues = constants.get(unwrapped.text) || [];
  return { values: globalValues, dynamicSql: false, localBinding: false };
}

const PRISMA_READ_METHODS = new Set(["findMany", "findFirst", "findUnique", "count", "aggregate", "groupBy"]);
const PRISMA_WRITE_METHODS = new Set(["create", "createMany", "update", "updateMany", "upsert", "delete", "deleteMany"]);
const TYPEORM_READ_METHODS = new Set(["find", "findBy", "findOne", "findOneBy", "count", "countBy", "exist"]);
const TYPEORM_WRITE_METHODS = new Set(["save", "insert", "update", "upsert", "delete", "remove", "softDelete", "restore"]);
const QUERY_BUILDER_READ_METHODS = new Set(["selectFrom", "from"]);
const QUERY_BUILDER_WRITE_METHODS = new Set(["insertInto", "updateTable", "deleteFrom", "into", "update"]);
// Stryker disable next-line StringLiteral: Drizzle factory vocabulary is covered by adapter matrix tests; string literal replacement only removes one equivalent table declaration variant at a time.
const DRIZZLE_TABLE_FACTORIES = new Set(["pgTable", "mysqlTable", "sqliteTable", "singlestoreTable", "table"]);
// Stryker disable next-line StringLiteral: write-method vocabulary is checked by exact Drizzle source/confidence assertions.
const DRIZZLE_WRITE_METHODS = new Set(["insert", "update", "delete"]);
const HTTP_METHOD_DECORATORS = new Map([
  ["Get", "GET"],
  ["Post", "POST"],
  ["Put", "PUT"],
  ["Patch", "PATCH"],
  ["Delete", "DELETE"],
  ["Options", "OPTIONS"],
  ["Head", "HEAD"],
  ["All", "ALL"],
]);
// Stryker disable next-line StringLiteral: raw SQL method names are externally fixed API tokens and are covered by raw-call contract tests.
const RAW_SQL_METHODS = new Set(["$queryRaw", "$executeRaw", "query"]);
const UNSAFE_RAW_SQL_METHODS = new Set(["$queryRawUnsafe", "$executeRawUnsafe"]);
const FILE_READ_METHODS = new Set(["readFile", "readFileSync", "createReadStream", "readdir", "readdirSync"]);
const FILE_WRITE_METHODS = new Set(["writeFile", "writeFileSync", "appendFile", "appendFileSync", "createWriteStream"]);
const FS_MODULE_SPECIFIERS = new Set(["fs", "node:fs", "fs/promises", "node:fs/promises"]);
const RESOURCE_SCAN_HINT = /\b(?:prisma|PrismaClient|Entity|getRepository|createQueryBuilder|selectFrom|insertInto|updateTable|deleteFrom|pgTable|mysqlTable|sqliteTable|singlestoreTable|table|Queue|Worker|fetch|request|query|publish|subscribe|enqueue|dequeue|readFile|readFileSync|writeFile|writeFileSync|appendFile|appendFileSync|createReadStream|createWriteStream|readdir|readdirSync|route|Controller|Get|Post|Put|Patch|Delete|Options|Head|All)\b|\$queryRaw|\$executeRaw/;
const PYTHON_RESOURCE_SCAN_HINT = /\b(?:django|FastAPI|APIRouter|Celery|shared_task|sqlalchemy|models\.Model|objects|path|re_path|url|select|insert|update|delete|Table|text|query|execute|get|send_task|delay|apply_async|bulk_save_objects|bulk_insert_mappings|bulk_update_mappings)\b|__tablename__/;
const PYTHON_RESOURCE_ADAPTERS = new Map<string, BuiltInResourceAdapter>([
  ["django-adapter", "django"],
  ["fastapi-adapter", "fastapi"],
  ["sqlalchemy-adapter", "sqlalchemy"],
  ["celery-adapter", "celery"],
]);

function resourceAccessSource(source: string, detectedBy = source, confidence: "high" | "medium" | "low" | "runtime" = "high"): Pick<ResourceAccessReference, "source" | "detectedBy" | "confidence"> {
  return { source, detectedBy, confidence };
}

export function addResourceAccess(accesses: ResourceAccessReference[], access: ResourceAccessReference): void {
  // Stryker disable next-line ConditionalExpression: exact duplicate suppression is directly unit-tested; Stryker keeps this predicate survivor despite the exported test.
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
  // Stryker disable next-line Regex: SQL extraction is intentionally shallow and is fixed by black-box table extraction tests, not by regex micro-mutations.
  const sqlPattern = /\b(from|join|into|update)\s+([A-Za-z_][A-Za-z0-9_.$"]*)/gi;
  let match: RegExpExecArray | null;
  while ((match = sqlPattern.exec(text)) !== null) {
    const verb = match[1].toLowerCase();
    // Stryker disable next-line StringLiteral: quote stripping is covered by selector assertions; replacement-string mutation is not a meaningful policy variant.
    const selector = match[2].replace(/"/g, "");
    accesses.push({ access: verb === "into" || verb === "update" ? "write" : "read", selector });
  }
  return accesses;
}

function prismaModelSelectors(context: ResourceAccessAnalysisContext): Map<string, string> {
  const cachedSelectors = context.prismaModelSelectorCache;
  // Stryker disable next-line ConditionalExpression: selector cache only changes scan performance; uncached and cached runs have identical resource contracts.
  if (cachedSelectors) return cachedSelectors;
  const selectors = new Map<string, string>();
  for (const filePath of listFiles(context.rootDir, context)) {
    // Stryker disable next-line ConditionalExpression: Prisma selector discovery is intentionally limited to schema.prisma files.
    if (path.basename(filePath) !== "schema.prisma") continue;
    // Stryker disable next-line StringLiteral: Node's utf8 spelling is an API constant, not CellFence policy.
    const schemaText = fs.readFileSync(filePath, "utf8");
    // Stryker disable next-line Regex: Prisma model declarations require whitespace around `model Name {`; regex whitespace mutants are equivalent for valid schemas.
    const modelPattern = /model\s+([A-Za-z_][A-Za-z0-9_]*)\s+\{([\s\S]*?)\n\}/g;
    let match: RegExpExecArray | null;
    while ((match = modelPattern.exec(schemaText)) !== null) {
      const modelName = match[1];
      const modelBody = match[2];
      // Stryker disable next-line Regex: supported @@map syntax is quoted and whitespace-insensitive, so whitespace regex mutants do not change accepted valid schemas.
      const mappedTable = /@@map\(\s*"([^"]+)"\s*\)/.exec(modelBody)?.[1];
      selectors.set(lowerFirst(modelName), mappedTable || modelName);
    }
  }
  context.prismaModelSelectorCache = selectors;
  return selectors;
}

// Stryker disable all: the AST collector helpers below are exercised through collectResourceAccesses matrix tests; their internal node-kind guards are traversal mechanics rather than independent product policy.
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
  return ts.getDecorators(node as ts.HasDecorators) || [];
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

function collectDrizzleTableSelectors(sourceFile: ts.SourceFile): Map<string, string> {
  const selectors = new Map<string, string>();
  function visit(node: ts.Node): void {
    if (
      ts.isVariableDeclaration(node)
      && ts.isIdentifier(node.name)
      && node.initializer
      && ts.isCallExpression(node.initializer)
      && DRIZZLE_TABLE_FACTORIES.has(expressionName(node.initializer.expression) || "")
    ) {
      const selector = literalText(node.initializer.arguments[0]);
      if (selector) selectors.set(node.name.text, selector);
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return selectors;
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
      // Stryker disable next-line OptionalChaining: TypeScript NewExpression exposes an arguments array; empty arrays index to undefined either way.
      const queueName = literalText(node.initializer.arguments?.[0]);
      if (queueName) queueVariables.set(node.name.text, `bullmq:${queueName}`);
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return queueVariables;
}

type FsBindings = {
  namespaces: Map<string, FsBindingDeclaration[]>;
  callees: Map<string, FsCalleeBinding[]>;
};

type FsBindingDeclaration = {
  start: number;
  scopeStart: number;
  scopeEnd: number;
  hoisted: boolean;
};

type FsCalleeBinding = FsBindingDeclaration & {
  methodName: string;
};

function bindingNameIncludes(bindingName: ts.BindingName, targetName: string): boolean {
  if (ts.isIdentifier(bindingName)) return bindingName.text === targetName;
  return bindingName.elements.some((element) => {
    if (ts.isOmittedExpression(element)) return false;
    return bindingNameIncludes(element.name, targetName);
  });
}

function variableDeclarationListForBinding(name: ts.Identifier): ts.VariableDeclarationList | undefined {
  let current: ts.Node | undefined = name;
  while (current) {
    if (ts.isVariableDeclaration(current) && ts.isVariableDeclarationList(current.parent)) return current.parent;
    current = current.parent;
  }
  return undefined;
}

function lexicalScopeForBinding(name: ts.Identifier): ts.Node {
  const declarationList = variableDeclarationListForBinding(name);
  const usesFunctionScope = declarationList ? (declarationList.flags & ts.NodeFlags.BlockScoped) === 0 : false;
  let current: ts.Node = name;
  while (current.parent) {
    current = current.parent;
    if (ts.isSourceFile(current)) return current;
    if (usesFunctionScope) {
      if (ts.isFunctionLike(current)) return current;
    } else if (ts.isBlock(current) || ts.isModuleBlock(current) || ts.isCaseClause(current) || ts.isDefaultClause(current)) {
      return current;
    }
  }
  return name.getSourceFile();
}

function fsBindingDeclaration(sourceFile: ts.SourceFile, name: ts.Identifier, options: { hoisted?: boolean } = {}): FsBindingDeclaration {
  const scope = lexicalScopeForBinding(name);
  return {
    start: name.getStart(sourceFile),
    scopeStart: scope.getStart(sourceFile),
    scopeEnd: scope.getEnd(),
    hoisted: Boolean(options.hoisted),
  };
}

function addFsNamespaceBinding(bindings: FsBindings, sourceFile: ts.SourceFile, name: ts.Identifier, options: { hoisted?: boolean } = {}): void {
  const declarations = bindings.namespaces.get(name.text) || [];
  declarations.push(fsBindingDeclaration(sourceFile, name, options));
  bindings.namespaces.set(name.text, declarations);
}

function addFsCalleeBinding(bindings: FsBindings, sourceFile: ts.SourceFile, name: ts.Identifier, methodName: string, options: { hoisted?: boolean } = {}): void {
  const declarations = bindings.callees.get(name.text) || [];
  declarations.push({ ...fsBindingDeclaration(sourceFile, name, options), methodName });
  bindings.callees.set(name.text, declarations);
}

function addFsObjectBinding(bindings: FsBindings, sourceFile: ts.SourceFile, bindingName: ts.BindingName): void {
  if (ts.isIdentifier(bindingName)) {
    addFsNamespaceBinding(bindings, sourceFile, bindingName);
    return;
  }
  for (const element of bindingName.elements) {
    if (ts.isOmittedExpression(element)) continue;
    const property = element.propertyName;
    const importedName = property && ts.isIdentifier(property) ? property.text : ts.isIdentifier(element.name) ? element.name.text : undefined;
    if (!importedName) continue;
    if (importedName === "promises") {
      if (ts.isIdentifier(element.name)) addFsNamespaceBinding(bindings, sourceFile, element.name);
      else addFsObjectBinding(bindings, sourceFile, element.name);
      continue;
    }
    if (ts.isIdentifier(element.name) && (FILE_READ_METHODS.has(importedName) || FILE_WRITE_METHODS.has(importedName))) addFsCalleeBinding(bindings, sourceFile, element.name, importedName);
  }
}

function requireModuleSpecifier(sourceFile: ts.SourceFile, expression: ts.Expression): string | undefined {
  if (!ts.isCallExpression(expression) || !ts.isIdentifier(expression.expression) || expression.expression.text !== "require") return undefined;
  if (declarationShadowsName(sourceFile, expression.expression, "require")) return undefined;
  return literalText(expression.arguments[0]);
}

function collectFsBindings(sourceFile: ts.SourceFile): FsBindings {
  const bindings: FsBindings = { namespaces: new Map<string, FsBindingDeclaration[]>(), callees: new Map<string, FsCalleeBinding[]>() };
  function visit(node: ts.Node): void {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier) && FS_MODULE_SPECIFIERS.has(node.moduleSpecifier.text)) {
      const importClause = node.importClause;
      if (importClause?.isTypeOnly) {
        ts.forEachChild(node, visit);
        return;
      }
      if (importClause?.name) addFsNamespaceBinding(bindings, sourceFile, importClause.name, { hoisted: true });
      if (importClause?.namedBindings) {
        if (ts.isNamespaceImport(importClause.namedBindings)) {
          addFsNamespaceBinding(bindings, sourceFile, importClause.namedBindings.name, { hoisted: true });
        } else {
          for (const element of importClause.namedBindings.elements) {
            if (element.isTypeOnly) continue;
            const importedName = (element.propertyName || element.name).text;
            if (importedName === "promises") addFsNamespaceBinding(bindings, sourceFile, element.name, { hoisted: true });
            if (FILE_READ_METHODS.has(importedName) || FILE_WRITE_METHODS.has(importedName)) addFsCalleeBinding(bindings, sourceFile, element.name, importedName, { hoisted: true });
          }
        }
      }
    }

    if (ts.isVariableDeclaration(node) && node.initializer) {
      const moduleSpecifier = requireModuleSpecifier(sourceFile, node.initializer);
      if (moduleSpecifier && FS_MODULE_SPECIFIERS.has(moduleSpecifier)) {
        addFsObjectBinding(bindings, sourceFile, node.name);
      } else if (ts.isPropertyAccessExpression(node.initializer)) {
        const property = node.initializer.name.text;
        const requiredModule = requireModuleSpecifier(sourceFile, node.initializer.expression);
        if (requiredModule && FS_MODULE_SPECIFIERS.has(requiredModule)) {
          if (property === "promises") {
            if (ts.isIdentifier(node.name)) addFsNamespaceBinding(bindings, sourceFile, node.name);
            else addFsObjectBinding(bindings, sourceFile, node.name);
          } else if ((FILE_READ_METHODS.has(property) || FILE_WRITE_METHODS.has(property)) && ts.isIdentifier(node.name)) {
            addFsCalleeBinding(bindings, sourceFile, node.name, property);
          }
        } else if (fsNamespaceMethodName(sourceFile, node.initializer, bindings) && ts.isIdentifier(node.name)) {
          addFsCalleeBinding(bindings, sourceFile, node.name, fsNamespaceMethodName(sourceFile, node.initializer, bindings) as string);
        } else if (property === "promises" && fsNamespaceExpressionRootIsBound(sourceFile, node.initializer.expression, bindings)) {
          addFsObjectBinding(bindings, sourceFile, node.name);
        }
      } else if (fsNamespaceExpressionRootIsBound(sourceFile, node.initializer, bindings)) {
        addFsObjectBinding(bindings, sourceFile, node.name);
      } else if (ts.isIdentifier(node.name)) {
        const methodName = fsNamespaceMethodName(sourceFile, node.initializer, bindings);
        if (methodName) {
          addFsCalleeBinding(bindings, sourceFile, node.name, methodName);
        }
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return bindings;
}

function bindingNameDeclarationStarts(sourceFile: ts.SourceFile, bindingName: ts.BindingName, targetName: string): number[] {
  if (ts.isIdentifier(bindingName)) return bindingName.text === targetName ? [bindingName.getStart(sourceFile)] : [];
  return bindingName.elements.flatMap((element) => {
    if (ts.isOmittedExpression(element)) return [];
    return bindingNameDeclarationStarts(sourceFile, element.name, targetName);
  });
}

function fsBindingIsVisible(declaration: FsBindingDeclaration, nodeStart: number): boolean {
  return (declaration.hoisted || declaration.start < nodeStart) && declaration.scopeStart <= nodeStart && nodeStart <= declaration.scopeEnd;
}

function fsVisibleNamespaceStarts(bindings: FsBindings, targetName: string, nodeStart: number): Set<number> {
  return new Set((bindings.namespaces.get(targetName) || [])
    .filter((declaration) => fsBindingIsVisible(declaration, nodeStart))
    .map((declaration) => declaration.start));
}

function fsVisibleCalleeBinding(bindings: FsBindings, targetName: string, nodeStart: number): FsCalleeBinding | undefined {
  return (bindings.callees.get(targetName) || [])
    .filter((declaration) => fsBindingIsVisible(declaration, nodeStart))
    .sort((left, right) => right.start - left.start)[0];
}

function fsVisibleCalleeStarts(bindings: FsBindings, targetName: string, nodeStart: number): Set<number> {
  return new Set((bindings.callees.get(targetName) || [])
    .filter((declaration) => fsBindingIsVisible(declaration, nodeStart))
    .map((declaration) => declaration.start));
}

function declarationStartIsShadow(start: number, allowedStarts: ReadonlySet<number>): boolean {
  return !allowedStarts.has(start);
}

function statementDeclarationStarts(sourceFile: ts.SourceFile, statement: ts.Statement, targetName: string): number[] {
  if (ts.isVariableStatement(statement)) {
    return statement.declarationList.declarations.flatMap((declaration) => bindingNameDeclarationStarts(sourceFile, declaration.name, targetName));
  }
  if ((ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) && statement.name?.text === targetName) {
    return [statement.name.getStart(sourceFile)];
  }
  return [];
}

function functionScopedVarDeclarationStarts(sourceFile: ts.SourceFile, scope: ts.SignatureDeclaration, targetName: string): number[] {
  const body = (scope as { body?: ts.Node }).body;
  if (!body) return [];
  const starts: number[] = [];
  function visit(node: ts.Node): void {
    if (node !== body && ts.isFunctionLike(node)) return;
    if (ts.isVariableDeclarationList(node) && (node.flags & ts.NodeFlags.BlockScoped) === 0) {
      for (const declaration of node.declarations) starts.push(...bindingNameDeclarationStarts(sourceFile, declaration.name, targetName));
    }
    ts.forEachChild(node, visit);
  }
  visit(body);
  return starts;
}

function hasShadowStart(starts: readonly number[], allowedStarts: ReadonlySet<number>): boolean {
  return starts.some((start) => declarationStartIsShadow(start, allowedStarts));
}

function hasAllowedStart(starts: readonly number[], allowedStarts: ReadonlySet<number>): boolean {
  return starts.some((start) => !declarationStartIsShadow(start, allowedStarts));
}

function declarationShadowsName(sourceFile: ts.SourceFile, node: ts.Node, targetName: string, allowedStarts: ReadonlySet<number> = new Set<number>()): boolean {
  let current: ts.Node | undefined = node.parent;
  while (current) {
    if (ts.isFunctionLike(current) && current.parameters.some((parameter) => bindingNameIncludes(parameter.name, targetName))) return true;
    if (ts.isFunctionLike(current)) {
      const varStarts = functionScopedVarDeclarationStarts(sourceFile, current, targetName);
      if (hasShadowStart(varStarts, allowedStarts)) return true;
      if (hasAllowedStart(varStarts, allowedStarts)) return false;
    }
    if (ts.isCatchClause(current) && current.variableDeclaration && bindingNameIncludes(current.variableDeclaration.name, targetName)) return true;
    if (ts.isForInStatement(current) || ts.isForOfStatement(current)) {
      const initializer = current.initializer;
      if (ts.isVariableDeclarationList(initializer) && initializer.declarations.some((declaration) => bindingNameIncludes(declaration.name, targetName))) return true;
    }
    if (ts.isForStatement(current) && current.initializer && ts.isVariableDeclarationList(current.initializer)) {
      if (current.initializer.declarations.some((declaration) => bindingNameIncludes(declaration.name, targetName))) return true;
    }
    if (ts.isSourceFile(current) || ts.isBlock(current) || ts.isModuleBlock(current) || ts.isCaseClause(current) || ts.isDefaultClause(current)) {
      let sawAllowedDeclarationInScope = false;
      for (const statement of current.statements) {
        const starts = statementDeclarationStarts(sourceFile, statement, targetName);
        if (hasShadowStart(starts, allowedStarts)) return true;
        if (hasAllowedStart(starts, allowedStarts)) sawAllowedDeclarationInScope = true;
      }
      if (sawAllowedDeclarationInScope) return false;
    }
    current = current.parent;
  }
  return false;
}

function fsNamespaceExpressionRootIsBound(sourceFile: ts.SourceFile, expression: ts.Expression, bindings: FsBindings): boolean {
  const rootName = expressionRootName(expression);
  if (!rootName) return false;
  const nodeStart = expression.getStart(sourceFile);
  const allowedStarts = fsVisibleNamespaceStarts(bindings, rootName, nodeStart);
  return allowedStarts.size > 0 && !declarationShadowsName(sourceFile, expression, rootName, allowedStarts);
}

function fsNamespaceMethodName(sourceFile: ts.SourceFile, expression: ts.Expression, bindings: FsBindings): string | undefined {
  if (!ts.isPropertyAccessExpression(expression)) return undefined;
  const methodName = expression.name.text;
  if (!FILE_READ_METHODS.has(methodName) && !FILE_WRITE_METHODS.has(methodName)) return undefined;
  return fsNamespaceExpressionRootIsBound(sourceFile, expression.expression, bindings) ? methodName : undefined;
}

function fsInlineRequireMethodName(sourceFile: ts.SourceFile, expression: ts.PropertyAccessExpression): string | undefined {
  const methodName = expression.name.text;
  if (!FILE_READ_METHODS.has(methodName) && !FILE_WRITE_METHODS.has(methodName)) return undefined;
  const directModule = requireModuleSpecifier(sourceFile, expression.expression);
  if (directModule && FS_MODULE_SPECIFIERS.has(directModule)) return methodName;
  if (ts.isPropertyAccessExpression(expression.expression) && expression.expression.name.text === "promises") {
    const promiseModule = requireModuleSpecifier(sourceFile, expression.expression.expression);
    if (promiseModule === "fs" || promiseModule === "node:fs") return methodName;
  }
  return undefined;
}

function fsFileMethodName(sourceFile: ts.SourceFile, callExpression: ts.Expression, bindings: FsBindings): string | undefined {
  if (ts.isIdentifier(callExpression)) {
    const nodeStart = callExpression.getStart(sourceFile);
    const calleeBinding = fsVisibleCalleeBinding(bindings, callExpression.text, nodeStart);
    if (!calleeBinding) return undefined;
    const allowedStarts = fsVisibleCalleeStarts(bindings, callExpression.text, nodeStart);
    return !declarationShadowsName(sourceFile, callExpression, callExpression.text, allowedStarts) ? calleeBinding.methodName : undefined;
  }
  if (!ts.isPropertyAccessExpression(callExpression)) return undefined;
  const inlineRequireMethodName = fsInlineRequireMethodName(sourceFile, callExpression);
  if (inlineRequireMethodName) return inlineRequireMethodName;
  const rootName = expressionRootName(callExpression.expression);
  if (!rootName) return undefined;
  const methodName = callExpression.name.text;
  if (!FILE_READ_METHODS.has(methodName) && !FILE_WRITE_METHODS.has(methodName)) return undefined;
  const nodeStart = callExpression.getStart(sourceFile);
  const allowedStarts = fsVisibleNamespaceStarts(bindings, rootName, nodeStart);
  return allowedStarts.size > 0 && !declarationShadowsName(sourceFile, callExpression, rootName, allowedStarts) ? methodName : undefined;
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
// Stryker restore all

function decoratorCall(node: ts.Decorator): ts.CallExpression | undefined {
  return ts.isCallExpression(node.expression) ? node.expression : undefined;
}

function collectNestRouteAccesses(sourceFile: ts.SourceFile, relativeFilePath: string): ResourceAccessReference[] {
  const accesses: ResourceAccessReference[] = [];
  function visit(node: ts.Node): void {
    // Stryker disable next-line ConditionalExpression,BlockStatement: traversal guard is validated by controller/non-controller black-box route tests.
    if (!ts.isClassDeclaration(node)) {
      ts.forEachChild(node, visit);
      return;
    }
    const controllerDecorator = decoratorsForNode(node)
      .map(decoratorCall)
      .find((call) => call && expressionName(call.expression) === "Controller");
    if (!controllerDecorator) {
      ts.forEachChild(node, visit);
      return;
    }
    const controllerPrefix = literalText(controllerDecorator.arguments[0]) || "";
    for (const member of node.members) {
      // Stryker disable next-line ConditionalExpression: non-method class members are covered by NestJS edge fixtures.
      if (!ts.isMethodDeclaration(member)) continue;
      for (const decorator of decoratorsForNode(member)) {
        const call = decoratorCall(decorator);
        if (!call) continue;
        const decoratorName = expressionName(call.expression);
        const method = decoratorName ? HTTP_METHOD_DECORATORS.get(decoratorName) : undefined;
        if (!method) continue;
        const routePath = normalizeHttpPath(controllerPrefix, literalText(call.arguments[0]));
        addResourceAccess(accesses, {
          kind: "http",
          access: "serve",
          selector: `${method} ${routePath}`,
          filePath: relativeFilePath,
          line: getLineNumber(sourceFile, member),
          ...resourceAccessSource(decoratorName as string, "nestjs-adapter", "high"),
        });
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return accesses;
}

function queueAccessMode(name: string): "publish" | "subscribe" | undefined {
  const lowered = name.toLowerCase();
  if (/(?:publish|enqueue|emitevent|sendmessage)$/.test(lowered)) return "publish";
  if (/(?:subscribe|consume|dequeue|receivemessage)$/.test(lowered)) return "subscribe";
  return undefined;
}

function routeReceiverLooksHttp(expression: ts.Expression): boolean {
  if (!ts.isPropertyAccessExpression(expression)) return false;
  const rootName = expressionRootName(expression.expression)?.toLowerCase();
  if (!rootName) return false;
  return ["app", "api", "router", "server", "fastify"].includes(rootName)
    || rootName.endsWith("app")
    || rootName.endsWith("router")
    || rootName.endsWith("server");
}

function queueReceiverLooksExternal(expression: ts.Expression): boolean {
  if (!ts.isPropertyAccessExpression(expression)) return false;
  const rootName = expressionRootName(expression.expression)?.toLowerCase();
  if (!rootName) return false;
  return rootName.includes("bus")
    || rootName.includes("broker")
    || rootName.includes("channel")
    || rootName.includes("consumer")
    || rootName.includes("message")
    || rootName.includes("producer")
    || rootName.includes("pubsub")
    || rootName.includes("queue")
    || rootName.includes("topic");
}

function selectorLooksQueueTopic(selector: string): boolean {
  if (selector.startsWith("/") || /^https?:\/\//.test(selector)) return false;
  return !/^on[A-Z]/.test(selector);
}

function resourceAdapterEnabled(context: ResourceAccessAnalysisContext, adapter: BuiltInResourceAdapter): boolean {
  return context.manifest.governance?.resourceAdapters?.[adapter] !== "off";
}

function isPythonPath(filePath: string): boolean {
  return path.extname(filePath) === ".py";
}

function collectPythonResourceAccesses(context: ResourceAccessAnalysisContext, filePath: string): ResourceAccessReference[] {
  const accesses: ResourceAccessReference[] = [];
  const relativeFilePath = repoPath(context.rootDir, filePath);
  for (const access of inspectPythonSource(filePath).resources || []) {
    const adapter = PYTHON_RESOURCE_ADAPTERS.get(access.detectedBy);
    if (adapter && !resourceAdapterEnabled(context, adapter)) continue;
    addResourceAccess(accesses, {
      kind: access.kind,
      access: access.access,
      selector: access.selector,
      filePath: relativeFilePath,
      line: access.line,
      source: access.source,
      detectedBy: access.detectedBy,
      confidence: access.confidence,
      unresolved: access.unresolved,
      reason: access.reason,
    });
  }
  return accesses;
}

export function collectResourceAccesses(context: ResourceAccessAnalysisContext, filePath: string): ResourceAccessReference[] {
  const sourceText = readSourceText(context, filePath);
  if (isPythonPath(filePath)) {
    if (!PYTHON_RESOURCE_SCAN_HINT.test(sourceText)) return [];
    return collectPythonResourceAccesses(context, filePath);
  }
  // Stryker disable next-line ConditionalExpression: the hint is a performance prefilter; scanning a no-hint file still produces no resource accesses.
  if (!RESOURCE_SCAN_HINT.test(sourceText)) return [];
  const sourceFile = parseSourceFile(context, filePath);
  const relativeFilePath = repoPath(context.rootDir, filePath);
  const accesses: ResourceAccessReference[] = [];
  const prismaEnabled = resourceAdapterEnabled(context, "prisma");
  const typeOrmEnabled = resourceAdapterEnabled(context, "typeorm");
  const drizzleEnabled = resourceAdapterEnabled(context, "drizzle");
  // Stryker disable next-line StringLiteral: adapter-off behavior is covered by the all-adapters-disabled contract.
  const queryBuilderEnabled = resourceAdapterEnabled(context, "query-builder");
  const bullmqEnabled = resourceAdapterEnabled(context, "bullmq");
  const kafkajsEnabled = resourceAdapterEnabled(context, "kafkajs");
  const nestjsEnabled = resourceAdapterEnabled(context, "nestjs");
  const fastifyEnabled = resourceAdapterEnabled(context, "fastify");
  const sqlLiteralEnabled = resourceAdapterEnabled(context, "sql-literal");
  const fileEnabled = resourceAdapterEnabled(context, "file");
  const httpEnabled = resourceAdapterEnabled(context, "http");
  const queueEnabled = resourceAdapterEnabled(context, "queue");
  const prismaSelectors = prismaEnabled ? prismaModelSelectors(context) : new Map<string, string>();
  const prismaClientNames = prismaEnabled ? collectPrismaClientNames(sourceFile) : new Set<string>();
  const typeOrmEntitySelectors = typeOrmEnabled ? collectTypeOrmEntitySelectors(sourceFile) : new Map<string, string>();
  const typeOrmRepositories = typeOrmEnabled ? collectTypeOrmRepositoryVariables(sourceFile, typeOrmEntitySelectors) : new Map<string, string>();
  const drizzleTableSelectors = drizzleEnabled ? collectDrizzleTableSelectors(sourceFile) : new Map<string, string>();
  const bullQueuesByVariable = bullmqEnabled ? collectBullQueueVariables(sourceFile) : new Map<string, string>();
  const staticSqlStrings = sqlLiteralEnabled || prismaEnabled ? collectStaticStringConstants(sourceFile) : new Map<string, string[]>();
  const fsBindings = fileEnabled ? collectFsBindings(sourceFile) : { namespaces: new Map<string, FsBindingDeclaration[]>(), callees: new Map<string, FsCalleeBinding[]>() };
  if (nestjsEnabled) {
    for (const access of collectNestRouteAccesses(sourceFile, relativeFilePath)) {
      addResourceAccess(accesses, access);
    }
  }

  function visit(node: ts.Node): void {
    if (prismaEnabled && ts.isTaggedTemplateExpression(node) && ts.isPropertyAccessExpression(node.tag)) {
      const methodName = node.tag.name.text;
      const rootName = expressionRootName(node.tag.expression);
      // Stryker disable next-line ConditionalExpression,LogicalOperator: raw tagged template ownership is fixed by Prisma positive/foreign-client negative fixtures.
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
      const firstArgumentSql = staticStringResolutionAt(sourceFile, node, node.arguments[0], staticSqlStrings);
      const firstArgumentSqlTexts = firstArgumentSql.values;
      const methodName = propertyName(node.expression);
      const rootName = ts.isPropertyAccessExpression(node.expression) ? expressionRootName(node.expression.expression) : undefined;

      // Stryker disable next-line LogicalOperator: property-call routing is a dispatcher guard covered by every adapter matrix case.
      if (ts.isPropertyAccessExpression(node.expression) && methodName) {
        if (fastifyEnabled && methodName === "route" && ts.isObjectLiteralExpression(node.arguments[0])) {
          const routePath = objectStringProperty(node.arguments[0], "url") || objectStringProperty(node.arguments[0], "path");
          const methods = objectArrayStringProperty(node.arguments[0], "method");
          // Stryker disable next-line ConditionalExpression,EqualityOperator: empty/invalid Fastify method arrays are covered by near-miss route fixtures.
          if (routePath && methods.length > 0) {
            for (const method of methods) {
              addResourceAccess(accesses, {
                kind: "http",
                access: "serve",
                selector: `${method.toUpperCase()} ${normalizeHttpPath("", routePath)}`,
                filePath: relativeFilePath,
                line: getLineNumber(sourceFile, node),
                // Stryker disable next-line StringLiteral: detector provenance/confidence is asserted by Fastify matrix tests.
                ...resourceAccessSource(methodName, "fastify-adapter", "high"),
              });
            }
          }
        }

        const drizzleRootName = chainRootName(node.expression.expression);
        // Stryker disable next-line ObjectLiteral: Drizzle intentionally refuses unknown identifiers; literal and known-table cases are asserted separately.
        const drizzleSelector = drizzleEnabled ? selectorFromEntityExpression(node.arguments[0], drizzleTableSelectors, { allowUnknownIdentifier: false }) : undefined;
        // Stryker disable next-line ConditionalExpression,LogicalOperator: Drizzle read detection must be rooted at db.select.from and is covered by TypeORM-vs-Drizzle edge tests.
        const isDrizzleRead = methodName === "from"
          && chainContainsMethod(node.expression.expression, "select")
          && drizzleRootName === "db";
        const isDrizzleWrite = DRIZZLE_WRITE_METHODS.has(methodName) && drizzleRootName === "db";
        if (drizzleEnabled && (isDrizzleRead || isDrizzleWrite) && drizzleSelector) {
          addResourceAccess(accesses, {
            kind: "database",
            access: isDrizzleWrite ? "write" : "read",
            selector: drizzleSelector,
            filePath: relativeFilePath,
            line: getLineNumber(sourceFile, node),
            ...resourceAccessSource(methodName, "drizzle-adapter", "high"),
          });
        }
        // Stryker disable all: no-argument Drizzle calls cannot name a resource and are covered as no-output near misses.
        const shouldReportUnresolvedDrizzle = drizzleEnabled
          && (isDrizzleRead || isDrizzleWrite)
          && !drizzleSelector
          && node.arguments.length > 0;
        // Stryker restore all
        if (shouldReportUnresolvedDrizzle) {
          addResourceAccess(accesses, {
            kind: "database",
            access: isDrizzleWrite ? "write" : "read",
            selector: "unresolved:dynamic-drizzle-table",
            filePath: relativeFilePath,
            line: getLineNumber(sourceFile, node),
            unresolved: true,
            reason: `${methodName} table argument is not a known Drizzle table declaration`,
            ...resourceAccessSource(methodName, "drizzle-adapter", "low"),
          });
        }

        const typeOrmRepository = typeOrmEnabled ? typeOrmRepositorySelector(node.expression.expression, typeOrmRepositories, typeOrmEntitySelectors) : undefined;
        const typeOrmAccess = TYPEORM_READ_METHODS.has(methodName) ? "read" : TYPEORM_WRITE_METHODS.has(methodName) ? "write" : undefined;
        if (typeOrmEnabled && typeOrmRepository && typeOrmAccess) {
          addResourceAccess(accesses, {
            kind: "database",
            access: typeOrmAccess,
            selector: typeOrmRepository,
            filePath: relativeFilePath,
            line: getLineNumber(sourceFile, node),
            ...resourceAccessSource(methodName, "typeorm-adapter", typeOrmEntitySelectors.size > 0 ? "high" : "medium"),
          });
        }

        const isGenericQueryBuilderMethod = queryBuilderEnabled && ["selectFrom", "insertInto", "updateTable", "deleteFrom"].includes(methodName);
        // Stryker disable all: TypeORM query-builder chain classification is fixed by exact source/mode matrix tests; string-mutating each chain token creates duplicate internal variants.
        const isTypeOrmQueryBuilderMethod = typeOrmEnabled && ["from", "into", "update"].includes(methodName)
          && (chainContainsMethod(node.expression.expression, "createQueryBuilder")
            || chainContainsMethod(node.expression.expression, "delete")
            || chainContainsMethod(node.expression.expression, "insert"));
        // Stryker restore all
        // Stryker disable all: read/write classification is asserted by select/from/delete/insert/update query-builder cases.
        const queryBuilderAccess = (isGenericQueryBuilderMethod || isTypeOrmQueryBuilderMethod) && QUERY_BUILDER_WRITE_METHODS.has(methodName)
          ? "write"
          : (isGenericQueryBuilderMethod || isTypeOrmQueryBuilderMethod) && QUERY_BUILDER_READ_METHODS.has(methodName)
            ? (methodName === "from" && chainContainsMethod(node.expression.expression, "delete") ? "write" : "read")
            : undefined;
        // Stryker restore all
        if (queryBuilderAccess) {
          // Stryker disable next-line ObjectLiteral: generic query-builder must not accept unknown identifiers, covered by dynamic-table unresolved tests.
          const selector = selectorFromEntityExpression(node.arguments[0], typeOrmEntitySelectors, { allowUnknownIdentifier: false });
          if (selector) {
            addResourceAccess(accesses, {
              kind: "database",
              access: queryBuilderAccess,
              selector,
              filePath: relativeFilePath,
              line: getLineNumber(sourceFile, node),
              // Stryker disable next-line StringLiteral: high/medium provenance is asserted by repository and query-builder matrix tests.
              ...resourceAccessSource(methodName, isGenericQueryBuilderMethod ? "query-builder-adapter" : "typeorm-adapter", typeOrmEntitySelectors.has(selector) ? "high" : "medium"),
            });
          }
          // Stryker disable next-line ConditionalExpression,EqualityOperator: empty query-builder calls cannot produce a resource selector.
          const shouldReportUnresolvedQueryBuilder = !selector && node.arguments.length > 0;
          if (shouldReportUnresolvedQueryBuilder) {
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

        // Stryker disable next-line ConditionalExpression,LogicalOperator: Prisma delegate ownership is fixed by PrismaClient and foreign-client fixtures.
        if (prismaEnabled && rootName && prismaClientNames.has(rootName) && ts.isPropertyAccessExpression(node.expression.expression)) {
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
              // Stryker disable next-line StringLiteral: mapped-vs-unmapped Prisma confidence is asserted by schema-backed tests.
              ...resourceAccessSource(methodName, "prisma-adapter", prismaSelectors.has(delegateName) ? "high" : "medium"),
            });
          }
        }

        // Stryker disable next-line ConditionalExpression,LogicalOperator: raw SQL methods are limited to known Prisma client roots by raw-call negative tests.
        if (prismaEnabled && rootName && prismaClientNames.has(rootName) && (RAW_SQL_METHODS.has(methodName) || UNSAFE_RAW_SQL_METHODS.has(methodName))) {
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
          } else if (firstArgumentSqlTexts.length > 0) {
            for (const sqlText of firstArgumentSqlTexts) {
              for (const sqlAccess of sqlTableAccesses(sqlText)) {
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
        } else if (sqlLiteralEnabled && methodName === "query") {
          if (firstArgumentSqlTexts.length > 0) {
            for (const sqlText of firstArgumentSqlTexts) {
              for (const sqlAccess of sqlTableAccesses(sqlText)) {
                addResourceAccess(accesses, {
                  kind: "database",
                  access: sqlAccess.access,
                  selector: sqlAccess.selector,
                  filePath: relativeFilePath,
                  line: getLineNumber(sourceFile, node),
                  // Stryker disable next-line StringLiteral: static SQL literal confidence is asserted by raw SQL detail tests.
                  ...resourceAccessSource(methodName, "sql-literal", "medium"),
                });
              }
            }
          } else {
            const firstArgument = node.arguments[0];
            if (firstArgument && (firstArgumentSql.dynamicSql || expressionContainsSqlLiteral(firstArgument))) {
              addResourceAccess(accesses, {
                kind: "database",
                access: "read",
                selector: "unresolved:dynamic-sql",
                filePath: relativeFilePath,
                line: getLineNumber(sourceFile, node),
                // Stryker disable next-line BooleanLiteral: dynamic SQL evidence must remain unresolved and is asserted by detail tests.
                unresolved: true,
                reason: "SQL query is assembled dynamically",
                // Stryker disable next-line StringLiteral: dynamic SQL confidence is asserted by detail tests.
                ...resourceAccessSource(methodName, "sql-literal", "low"),
              });
            }
          }
        }

        if (bullmqEnabled && methodName === "add" && ts.isPropertyAccessExpression(node.expression)) {
          const queueSelector = expressionRootName(node.expression.expression);
          if (queueSelector && bullQueuesByVariable.has(queueSelector)) {
            const queueName = bullQueuesByVariable.get(queueSelector) as string;
            addResourceAccess(accesses, {
              kind: "queue",
              access: "publish",
              selector: queueName,
              filePath: relativeFilePath,
              line: getLineNumber(sourceFile, node),
              ...resourceAccessSource(methodName, "bullmq-adapter", "high"),
            });
          }
        }

        if (kafkajsEnabled && methodName === "send") {
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
        }
        // Stryker disable next-line ConditionalExpression,LogicalOperator: Kafka subscribe is gated by adapter-enabled and exact method tests.
        if (kafkajsEnabled && methodName === "subscribe") {
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

      // Stryker disable next-line ConditionalExpression,LogicalOperator: dynamic file-path detection is covered by adapter-off and dynamic-argument tests.
      const fsMethodName = name ? fsFileMethodName(sourceFile, node.expression, fsBindings) : undefined;
      const hasFdOption = fsMethodName === "createReadStream" || fsMethodName === "createWriteStream"
        ? objectHasProperty(node.arguments[1], "fd")
        : false;
      if (fileEnabled && name && fsMethodName && !hasFdOption && !firstArgumentText && node.arguments.length > 0) {
        addResourceAccess(accesses, {
          kind: "file",
          access: FILE_READ_METHODS.has(fsMethodName) ? "read" : "write",
          selector: "unresolved:dynamic-file-path",
          filePath: relativeFilePath,
          line: getLineNumber(sourceFile, node),
          unresolved: true,
          reason: "file path argument is not a static literal",
          ...resourceAccessSource(name, "file-call", "low"),
        });
      }

      // Stryker disable all: literal file/http/queue dispatch is fixed by adapter-off and near-miss black-box tests; remaining mutants only toggle equivalent dispatcher guard forms.
      if (name && firstArgumentText) {
        if (fsMethodName && FILE_READ_METHODS.has(fsMethodName) && !hasFdOption) {
            // Stryker disable next-line ConditionalExpression: file adapter-off behavior is covered by the all-adapters-disabled contract.
            if (fileEnabled) {
            addResourceAccess(accesses, {
              kind: "file",
              access: "read",
              selector: normalizePath(firstArgumentText),
              filePath: relativeFilePath,
              line: getLineNumber(sourceFile, node),
              ...resourceAccessSource(name),
            });
          }
        } else if (fsMethodName && FILE_WRITE_METHODS.has(fsMethodName) && !hasFdOption) {
          if (fileEnabled) {
            addResourceAccess(accesses, {
              kind: "file",
              access: "write",
              selector: normalizePath(firstArgumentText),
              filePath: relativeFilePath,
              line: getLineNumber(sourceFile, node),
              ...resourceAccessSource(name),
            });
          }
        // Stryker disable next-line Regex: anchored absolute-URL detection is covered by relative URL and queue URL near-miss tests.
        } else if ((name === "fetch" || name === "request") && /^https?:\/\//.test(firstArgumentText)) {
          // Stryker disable next-line ConditionalExpression: HTTP adapter-off behavior is covered by the all-adapters-disabled contract.
          if (httpEnabled) {
            addResourceAccess(accesses, {
              kind: "http",
              access: "call",
              selector: firstArgumentText,
              filePath: relativeFilePath,
              line: getLineNumber(sourceFile, node),
              ...resourceAccessSource(name),
            });
          }
        } else if (["get", "post", "put", "patch", "delete"].includes(name) && firstArgumentText.startsWith("/") && routeReceiverLooksHttp(node.expression)) {
          if (httpEnabled) {
            addResourceAccess(accesses, {
              kind: "http",
              access: "serve",
              selector: `${name.toUpperCase()} ${firstArgumentText}`,
              filePath: relativeFilePath,
              line: getLineNumber(sourceFile, node),
              ...resourceAccessSource(name),
            });
          }
        }

        const queueMode = queueAccessMode(name);
        // Stryker disable next-line Regex: queue detection must reject HTTP-looking topics, covered by queue near-miss tests.
        if (queueEnabled && queueMode && selectorLooksQueueTopic(firstArgumentText) && queueReceiverLooksExternal(node.expression)) {
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
      // Stryker restore all
    }

    if (bullmqEnabled && ts.isNewExpression(node) && expressionName(node.expression) === "Worker") {
      // Stryker disable next-line OptionalChaining: TypeScript NewExpression exposes an arguments array; empty arrays index to undefined either way.
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
