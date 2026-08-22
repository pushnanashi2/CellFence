import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import ts from "typescript";

import { checkRepository } from "../packages/engine/dist/index.js";
import {
  addResourceAccess,
  collectResourceAccesses,
  resourceAccessTestHooks,
} from "../packages/engine/dist/resource-access.js";

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function createResourceContext(rootDir, governance = {}) {
  return {
    rootDir,
    manifest: {
      schemaVersion: "cellfence.manifest.v1",
      governance,
      cells: [{
        id: "runtime",
        ownedPaths: ["src/runtime/**"],
        publicEntry: "src/runtime/public.ts",
        publicSymbols: ["runRuntime"],
        consumes: [],
        producesArtifacts: [],
      }],
    },
    sourceFilesForCellCache: new Map(),
    sourceTextCache: new Map(),
    sourceFileCache: new Map(),
  };
}

function accessKey(access) {
  return [
    access.kind,
    access.access,
    access.selector,
    access.source || "",
    access.detectedBy,
    access.confidence,
    access.unresolved ? "unresolved" : "resolved",
    access.reason || "",
  ].join("|");
}

function summarizeAccesses(accesses) {
  return accesses
    .map((access) => ({
      kind: access.kind,
      access: access.access,
      selector: access.selector,
      source: access.source,
      detectedBy: access.detectedBy,
      confidence: access.confidence,
      unresolved: access.unresolved || false,
      reason: access.reason || "",
      line: access.line,
    }))
    .sort((left, right) => accessKey(left).localeCompare(accessKey(right)) || left.line - right.line);
}

function writeRuntimeSource(rootDir, lines) {
  fs.mkdirSync(path.join(rootDir, "src/runtime"), { recursive: true });
  const filePath = path.join(rootDir, "src/runtime/public.ts");
  fs.writeFileSync(filePath, `${lines.join("\n")}\n`);
  return filePath;
}

function writePythonSource(rootDir, lines) {
  fs.mkdirSync(path.join(rootDir, "src/runtime"), { recursive: true });
  const filePath = path.join(rootDir, "src/runtime/public.py");
  fs.writeFileSync(filePath, `${lines.join("\n")}\n`);
  return filePath;
}

function lineOf(lines, needle) {
  const index = lines.findIndex((line) => line.includes(needle));
  assert.notEqual(index, -1, `missing source line containing ${needle}`);
  return index + 1;
}

function countMatching(accesses, predicate) {
  return accesses.filter(predicate).length;
}

test("addResourceAccess only suppresses exact duplicate resource observations", () => {
  const accesses = [];
  const baseAccess = {
    kind: "database",
    access: "read",
    selector: "app_users",
    filePath: "src/runtime/public.ts",
    line: 10,
    source: "findMany",
    detectedBy: "prisma-adapter",
    confidence: "high",
  };

  addResourceAccess(accesses, baseAccess);
  addResourceAccess(accesses, { ...baseAccess });
  addResourceAccess(accesses, { ...baseAccess, access: "write" });
  addResourceAccess(accesses, { ...baseAccess, kind: "queue" });
  addResourceAccess(accesses, { ...baseAccess, selector: "audit_logs" });
  addResourceAccess(accesses, { ...baseAccess, filePath: "src/runtime/other.ts" });
  addResourceAccess(accesses, { ...baseAccess, line: 11 });

  assert.equal(accesses.length, 6);
  assert.deepEqual(accesses.map((access) => `${access.kind}:${access.access}:${access.selector}:${access.filePath}:${access.line}`), [
    "database:read:app_users:src/runtime/public.ts:10",
    "database:write:app_users:src/runtime/public.ts:10",
    "queue:read:app_users:src/runtime/public.ts:10",
    "database:read:audit_logs:src/runtime/public.ts:10",
    "database:read:app_users:src/runtime/other.ts:10",
    "database:read:app_users:src/runtime/public.ts:11",
  ]);
});

function parseTypeScript(sourceText) {
  return ts.createSourceFile("fixture.ts", sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

function expressionFrom(sourceText) {
  const sourceFile = parseTypeScript(`${sourceText};`);
  const statement = sourceFile.statements[0];
  assert.ok(ts.isExpressionStatement(statement));
  return statement.expression;
}

function callArgument(sourceFile, callName) {
  let argument;
  function visit(node) {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === callName) {
      argument = node.arguments[0];
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  assert.ok(argument, `missing ${callName} argument`);
  return argument;
}

test("resource AST helpers preserve wrappers, properties, bindings, and assignment semantics", () => {
  const {
    unwrapExpression,
    objectHasProperty,
    expressionContainsSqlLiteral,
    bindingIdentifiers,
    assignedIdentifier,
    isAssignmentOperatorKind,
    emptyStaticStringResolution,
    sqlIdentifierName,
    textLooksSql,
  } = resourceAccessTestHooks;

  for (const wrapped of ["(target)", "target as string", "<string>target", "target!", "(ignored, target)"]) {
    assert.equal(unwrapExpression(expressionFrom(wrapped)).getText(), "target", wrapped);
    assert.equal(assignedIdentifier(expressionFrom(wrapped))?.toString(), "target", wrapped);
  }
  assert.equal(assignedIdentifier(expressionFrom("holder.target")), undefined);

  const object = expressionFrom("({ fd: 1, 'path': 'x', shorthand, method() {} })");
  assert.ok(ts.isParenthesizedExpression(object));
  const objectLiteral = unwrapExpression(object);
  assert.ok(ts.isObjectLiteralExpression(objectLiteral));
  assert.equal(objectHasProperty(objectLiteral, "fd"), true);
  assert.equal(objectHasProperty(objectLiteral, "path"), true);
  assert.equal(objectHasProperty(objectLiteral, "shorthand"), true);
  assert.equal(objectHasProperty(objectLiteral, "method"), false);
  assert.equal(objectHasProperty(objectLiteral, "missing"), false);
  assert.equal(objectHasProperty(expressionFrom("target"), "fd"), false);

  assert.equal(expressionContainsSqlLiteral(undefined), false);
  assert.equal(expressionContainsSqlLiteral(expressionFrom("wrapper({ text: 'select * from users' })")), true);
  assert.equal(expressionContainsSqlLiteral(expressionFrom("wrapper({ text: 'plain text' })")), false);

  const bindingSource = parseTypeScript("const { alpha, renamed: beta, ...rest } = input; const [first, , third] = list;");
  const bindingNames = bindingSource.statements.flatMap((statement) => {
    assert.ok(ts.isVariableStatement(statement));
    return bindingIdentifiers(statement.declarationList.declarations[0].name);
  });
  assert.deepEqual(bindingNames, ["alpha", "beta", "rest", "first", "third"]);

  const assignmentKinds = [
    ts.SyntaxKind.EqualsToken,
    ts.SyntaxKind.PlusEqualsToken,
    ts.SyntaxKind.MinusEqualsToken,
    ts.SyntaxKind.AsteriskEqualsToken,
    ts.SyntaxKind.AsteriskAsteriskEqualsToken,
    ts.SyntaxKind.SlashEqualsToken,
    ts.SyntaxKind.PercentEqualsToken,
    ts.SyntaxKind.LessThanLessThanEqualsToken,
    ts.SyntaxKind.GreaterThanGreaterThanEqualsToken,
    ts.SyntaxKind.GreaterThanGreaterThanGreaterThanEqualsToken,
    ts.SyntaxKind.AmpersandEqualsToken,
    ts.SyntaxKind.BarEqualsToken,
    ts.SyntaxKind.CaretEqualsToken,
    ts.SyntaxKind.AmpersandAmpersandEqualsToken,
    ts.SyntaxKind.BarBarEqualsToken,
    ts.SyntaxKind.QuestionQuestionEqualsToken,
  ];
  assert.ok(assignmentKinds.every((kind) => isAssignmentOperatorKind(kind)));
  assert.equal(isAssignmentOperatorKind(ts.SyntaxKind.PlusToken), false);
  assert.deepEqual(emptyStaticStringResolution(), { values: [], dynamicSql: false, localBinding: false });
  for (const name of ["sql", "SQLTEXT", "query", "queryText", "queryString"]) assert.equal(sqlIdentifierName(name), true, name);
  for (const name of ["sqlSuffix", "prefixQuery", "queries", "text"]) assert.equal(sqlIdentifierName(name), false, name);
  for (const sql of ["SELECT 1", "insert into users", "update users", "delete from users", "join roles"]) assert.equal(textLooksSql(sql), true, sql);
  assert.equal(textLooksSql("plain application text"), false);
});

test("resource static string resolution handles aliases, branches, concatenation, scopes, and mutation", () => {
  const {
    collectStaticStringConstants,
    staticStringValues,
    collectLocalStaticStringResolution,
    staticStringResolutionAt,
    isStatementContainer,
    statementsForContainer,
    nearestStatementContainer,
  } = resourceAccessTestHooks;
  const constantsSource = parseTypeScript([
    "const BASE = '/api';",
    "const COPY = BASE;",
    "const CONDITIONAL = flag ? '/one' : '/two';",
    "const JOINED = BASE + '/users';",
    "const TEMPLATE = `literal`;",
    "const CYCLE_A = CYCLE_B;",
    "const CYCLE_B = CYCLE_A;",
    "let MUTABLE = '/ignored';",
    "const DYNAMIC = makePath();",
  ].join("\n"));
  const constants = collectStaticStringConstants(constantsSource);
  assert.deepEqual(Object.fromEntries(constants), {
    BASE: ["/api"],
    COPY: ["/api"],
    CONDITIONAL: ["/one", "/two"],
    JOINED: ["/api/users"],
    TEMPLATE: ["literal"],
  });
  assert.deepEqual(staticStringValues(undefined, constants), []);
  assert.deepEqual(staticStringValues(expressionFrom("'/literal'"), constants), ["/literal"]);
  assert.deepEqual(staticStringValues(expressionFrom("COPY"), constants), ["/api"]);
  assert.deepEqual(staticStringValues(expressionFrom("MISSING"), constants), []);
  assert.deepEqual(staticStringValues(expressionFrom("BASE + '/x'"), constants), []);

  const localSource = parseTypeScript([
    "const GLOBAL = '/global';",
    "function run(flag: boolean, parameter: string) {",
    "  const literal = '/literal';",
    "  const alias = literal;",
    "  const conditional = flag ? '/one' : '/two';",
    "  const joined = literal + '/child';",
    "  let reassigned = 'select * from users';",
    "  reassigned += ' where active = true';",
    "  sinkAlias(alias);",
    "  sinkConditional(conditional);",
    "  sinkJoined(joined);",
    "  sinkReassigned(reassigned);",
    "  sinkParameter(parameter);",
    "  sinkGlobal(GLOBAL);",
    "}",
  ].join("\n"));
  const globalConstants = collectStaticStringConstants(localSource);
  const resolutions = {
    alias: collectLocalStaticStringResolution(localSource, callArgument(localSource, "sinkAlias"), "alias", globalConstants),
    conditional: collectLocalStaticStringResolution(localSource, callArgument(localSource, "sinkConditional"), "conditional", globalConstants),
    joined: collectLocalStaticStringResolution(localSource, callArgument(localSource, "sinkJoined"), "joined", globalConstants),
    reassigned: collectLocalStaticStringResolution(localSource, callArgument(localSource, "sinkReassigned"), "reassigned", globalConstants),
    parameter: collectLocalStaticStringResolution(localSource, callArgument(localSource, "sinkParameter"), "parameter", globalConstants),
  };
  assert.deepEqual(resolutions.alias, { values: ["/literal"], dynamicSql: false, localBinding: true });
  assert.deepEqual(resolutions.conditional, { values: ["/one", "/two"], dynamicSql: false, localBinding: true });
  assert.deepEqual(resolutions.joined, { values: ["/literal/child"], dynamicSql: false, localBinding: true });
  assert.deepEqual(resolutions.reassigned, { values: [], dynamicSql: true, localBinding: true });
  assert.deepEqual(resolutions.parameter, { values: [], dynamicSql: false, localBinding: true });
  assert.deepEqual(
    staticStringResolutionAt(localSource, callArgument(localSource, "sinkGlobal"), callArgument(localSource, "sinkGlobal"), globalConstants),
    { values: ["/global"], dynamicSql: false, localBinding: false },
  );
  assert.deepEqual(staticStringResolutionAt(localSource, localSource, undefined, globalConstants), emptyResolution());

  assert.equal(isStatementContainer(localSource), true);
  const run = localSource.statements.find(ts.isFunctionDeclaration);
  assert.ok(run?.body);
  assert.equal(isStatementContainer(run.body), true);
  assert.equal(isStatementContainer(run), false);
  assert.equal(statementsForContainer(run.body).length, 12);
  assert.equal(nearestStatementContainer(callArgument(localSource, "sinkAlias")), run.body);
});

test("resource local resolution fails closed across shadowing and control-flow boundaries", () => {
  const {
    collectStaticStringConstants,
    collectLocalStaticStringResolution,
    staticStringResolutionAt,
    isStatementContainer,
    statementsForContainer,
    nearestStatementContainer,
  } = resourceAccessTestHooks;
  const sourceFile = parseTypeScript([
    "const FORWARD = LATER;",
    "const LATER = '/later';",
    "const DUPLICATE = flag ? '/same' : '/same';",
    "function run(query: string) {",
    "  let incremented = '/count';",
    "  incremented++;",
    "  const dynamic = wrapper('select * from users', value);",
    "  const unresolvedBranch = flag ? '/known' : makePath();",
    "  const unresolvedJoin = '/known' + makePath();",
    "  let nestedSafe = '/safe';",
    "  function nested() { nestedSafe = '/changed'; }",
    "  let arrowSafe = '/arrow-safe';",
    "  const mutateLater = () => { arrowSafe = '/changed'; };",
    "  sinkIncremented(incremented);",
    "  sinkDynamic(dynamic);",
    "  sinkBranch(unresolvedBranch);",
    "  sinkJoin(unresolvedJoin);",
    "  sinkNested(nestedSafe);",
    "  sinkArrow(arrowSafe);",
    "  sinkParameter(query);",
    "  sinkBefore(laterLocal);",
    "  const laterLocal = '/too-late';",
    "}",
    "try { throw new Error(); } catch (query) { sinkCatch(query); }",
    "switch (kind) { case 'one': sinkCase(FORWARD); break; default: sinkDefault(DUPLICATE); }",
    "namespace Scope { export const value = '/module'; sinkModule(value); }",
  ].join("\n"));
  const constants = collectStaticStringConstants(sourceFile);
  assert.deepEqual(constants.get("FORWARD"), ["/later"]);
  assert.deepEqual(constants.get("DUPLICATE"), ["/same"]);

  const resolve = (callName, targetName) => collectLocalStaticStringResolution(
    sourceFile,
    callArgument(sourceFile, callName),
    targetName,
    constants,
  );
  assert.deepEqual(resolve("sinkIncremented", "incremented"), { values: [], dynamicSql: false, localBinding: true });
  assert.deepEqual(resolve("sinkDynamic", "dynamic"), { values: [], dynamicSql: true, localBinding: true });
  assert.deepEqual(resolve("sinkBranch", "unresolvedBranch"), { values: [], dynamicSql: false, localBinding: true });
  assert.deepEqual(resolve("sinkJoin", "unresolvedJoin"), { values: [], dynamicSql: false, localBinding: true });
  assert.deepEqual(resolve("sinkNested", "nestedSafe"), { values: [], dynamicSql: false, localBinding: true });
  assert.deepEqual(resolve("sinkArrow", "arrowSafe"), { values: ["/arrow-safe"], dynamicSql: false, localBinding: true });
  assert.deepEqual(resolve("sinkParameter", "query"), { values: [], dynamicSql: true, localBinding: true });
  assert.deepEqual(resolve("sinkBefore", "laterLocal"), { values: [], dynamicSql: false, localBinding: true });
  assert.deepEqual(resolve("sinkCatch", "query"), { values: [], dynamicSql: true, localBinding: true });

  assert.deepEqual(
    staticStringResolutionAt(sourceFile, callArgument(sourceFile, "sinkCase"), callArgument(sourceFile, "sinkCase"), constants),
    { values: ["/later"], dynamicSql: false, localBinding: false },
  );
  const switchStatement = sourceFile.statements.find(ts.isSwitchStatement);
  assert.ok(switchStatement);
  const [caseClause, defaultClause] = switchStatement.caseBlock.clauses;
  assert.equal(isStatementContainer(caseClause), true);
  assert.equal(isStatementContainer(defaultClause), true);
  assert.equal(statementsForContainer(caseClause).length, 2);
  assert.equal(statementsForContainer(defaultClause).length, 1);
  assert.equal(nearestStatementContainer(callArgument(sourceFile, "sinkCase")), caseClause);

  const moduleDeclaration = sourceFile.statements.find(ts.isModuleDeclaration);
  assert.ok(moduleDeclaration?.body && ts.isModuleBlock(moduleDeclaration.body));
  assert.equal(isStatementContainer(moduleDeclaration.body), true);
  assert.equal(statementsForContainer(moduleDeclaration.body).length, 2);
  assert.equal(nearestStatementContainer(callArgument(sourceFile, "sinkModule")), moduleDeclaration.body);
});

function emptyResolution() {
  return { values: [], dynamicSql: false, localBinding: false };
}

test("resource detector vocabularies and receiver heuristics reject near misses", () => {
  const hooks = resourceAccessTestHooks;
  assert.deepEqual([...hooks.prismaReadMethods], ["findMany", "findFirst", "findUnique", "count", "aggregate", "groupBy"]);
  assert.deepEqual([...hooks.prismaWriteMethods], ["create", "createMany", "update", "updateMany", "upsert", "delete", "deleteMany"]);
  assert.deepEqual([...hooks.typeOrmReadMethods], ["find", "findBy", "findOne", "findOneBy", "count", "countBy", "exist"]);
  assert.deepEqual([...hooks.typeOrmWriteMethods], ["save", "insert", "update", "upsert", "delete", "remove", "softDelete", "restore"]);
  assert.deepEqual([...hooks.queryBuilderReadMethods], ["selectFrom", "from"]);
  assert.deepEqual([...hooks.queryBuilderWriteMethods], ["insertInto", "updateTable", "deleteFrom", "into", "update"]);
  assert.deepEqual([...hooks.genericSqlMethods], ["query", "execute"]);
  assert.deepEqual([...hooks.fileReadMethods], ["readFile", "readFileSync", "createReadStream", "readdir", "readdirSync", "open", "openSync"]);
  assert.deepEqual([...hooks.fileWriteMethods], ["writeFile", "writeFileSync", "appendFile", "appendFileSync", "createWriteStream", "rm", "rmSync", "unlink", "unlinkSync"]);
  assert.deepEqual([...hooks.fileCopyMethods], ["copyFile", "copyFileSync"]);
  assert.deepEqual([...hooks.fsModuleSpecifiers], ["fs", "node:fs", "fs/promises", "node:fs/promises"]);
  assert.deepEqual([...hooks.commandExecutionMethods], ["execSync", "execFileSync", "spawnSync"]);
  assert.deepEqual([...hooks.pythonResourceAdapters], [
    ["django-adapter", "django"],
    ["fastapi-adapter", "fastapi"],
    ["sqlalchemy-adapter", "sqlalchemy"],
    ["celery-adapter", "celery"],
  ]);
  for (const text of ["PrismaClient", "readFileSync", "openSync", "rmSync", "copyFileSync", "DatabaseSync", "execFileSync", "$queryRaw", "route", "subscribe"]) {
    assert.equal(hooks.resourceScanHint.test(text), true, text);
  }
  for (const text of ["FastAPI", "models.Model", "__tablename__", "apply_async"]) assert.equal(hooks.pythonResourceScanHint.test(text), true, text);
  assert.equal(hooks.resourceScanHint.test("ordinary business logic"), false);
  assert.equal(hooks.pythonResourceScanHint.test("ordinary python logic"), false);

  const receiver = (text) => expressionFrom(`${text}.get`);
  for (const name of ["app", "api", "router", "server", "fastify", "adminApp", "nestedRouter", "httpServer"]) {
    assert.equal(hooks.routeReceiverLooksHttp(receiver(name)), true, name);
  }
  for (const name of ["map", "application", "routerState", "serverValue", "client"]) {
    assert.equal(hooks.routeReceiverLooksHttp(receiver(name)), false, name);
  }
  assert.equal(hooks.routeReceiverLooksHttp(expressionFrom("factory().get")), false);
  for (const name of ["bus", "eventBroker", "channel", "consumer", "messageClient", "producer", "pubsub", "queue", "topicStore"]) {
    assert.equal(hooks.queueReceiverLooksExternal(expressionFrom(`${name}.subscribe`)), true, name);
  }
  for (const name of ["router", "state", "subscription", "client"]) {
    assert.equal(hooks.queueReceiverLooksExternal(expressionFrom(`${name}.subscribe`)), false, name);
  }
  assert.equal(hooks.queueReceiverLooksExternal(expressionFrom("factory().subscribe")), false);
  for (const selector of ["orders.created", "queue-name", "lowercase"]) assert.equal(hooks.selectorLooksQueueTopic(selector), true, selector);
  for (const selector of ["/route", "http://example.test", "https://example.test", "prefixhttp://example.test", "prefixhttps://example.test", "onResolved"]) {
    assert.equal(hooks.selectorLooksQueueTopic(selector), false, selector);
  }
  for (const selector of ["prefixonResolved", "topic/http://example.test"]) {
    assert.equal(hooks.selectorLooksQueueTopic(selector), true, selector);
  }
});

test("collectResourceAccesses returns no observations for source without resource hints", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-resource-no-hints-"));
  try {
    const typeScriptPath = writeRuntimeSource(rootDir, [
      "export function runRuntime(): number {",
      "  const value = 42;",
      "  return value;",
      "}",
    ]);
    assert.deepEqual(collectResourceAccesses(createResourceContext(rootDir), typeScriptPath), []);

    const pythonPath = writePythonSource(rootDir, [
      "def run_runtime():",
      "    value = 42",
      "    return value",
    ]);
    assert.deepEqual(collectResourceAccesses(createResourceContext(rootDir), pythonPath), []);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("collectResourceAccesses detects FastAPI route decorators in Python source", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-resource-fastapi-python-"));
  try {
    const lines = [
      "from fastapi import FastAPI, APIRouter",
      "app = FastAPI()",
      "router = APIRouter(prefix='/v1')",
      "@app.get('/health')",
      "def health():",
      "    return {'ok': True}",
      "@router.post('/items')",
      "async def create_item():",
      "    return {'ok': True}",
      "@router.api_route('/search', methods=['GET', 'POST'])",
      "def search():",
      "    return {'ok': True}",
    ];
    const filePath = writePythonSource(rootDir, lines);
    const accesses = summarizeAccesses(collectResourceAccesses(createResourceContext(rootDir), filePath));

    assert.deepEqual(accesses.filter((access) => access.detectedBy === "fastapi-adapter").map((access) => access.selector), [
      "GET /health",
      "GET /v1/search",
      "POST /v1/items",
      "POST /v1/search",
    ].sort());
    assert.ok(accesses.every((access) => access.kind === "http" && access.access === "serve"));
    assert.ok(accesses.every((access) => access.confidence === "high"));
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("collectResourceAccesses resolves FastAPI constants, route methods, websockets, and include_router prefixes", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-resource-fastapi-edges-"));
  try {
    const lines = [
      "from fastapi import FastAPI, APIRouter",
      "PREFIX = '/api'",
      "ITEMS = '/items'",
      "METHODS = ['POST', 'PUT']",
      "app = FastAPI()",
      "router = APIRouter(prefix='/v1')",
      "app.include_router(router, prefix=PREFIX)",
      "@router.get(path=ITEMS)",
      "def items():",
      "    return []",
      "@app.route('/fallback', methods=METHODS)",
      "def fallback():",
      "    return {}",
      "@app.websocket('/ws')",
      "async def ws():",
      "    return None",
    ];
    const filePath = writePythonSource(rootDir, lines);
    const selectors = summarizeAccesses(collectResourceAccesses(createResourceContext(rootDir), filePath))
      .filter((access) => access.detectedBy === "fastapi-adapter")
      .map((access) => access.selector)
      .sort();

    assert.deepEqual(selectors, [
      "GET /api/v1/items",
      "POST /fallback",
      "PUT /fallback",
      "WEBSOCKET /ws",
    ]);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("collectResourceAccesses detects Django URLConf and model manager accesses", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-resource-django-python-"));
  try {
    const lines = [
      "from django.db import models",
      "from django.urls import path, re_path",
      "class Order(models.Model):",
      "    class Meta:",
      "        db_table = 'orders'",
      "urlpatterns = [",
      "    path('orders/', lambda request: None),",
      "    re_path(r'^health/$', lambda request: None),",
      "]",
      "def run():",
      "    Order.objects.filter(status='open').count()",
      "    Order.objects.create(status='open')",
      "    Order.objects.filter(status='stale').delete()",
    ];
    const filePath = writePythonSource(rootDir, lines);
    const accesses = summarizeAccesses(collectResourceAccesses(createResourceContext(rootDir), filePath));

    assert.deepEqual(accesses.filter((access) => access.kind === "http").map((access) => access.selector), [
      "ANY /orders",
      "ANY regex:^health/$",
    ]);
    assert.equal(countMatching(accesses, (access) => access.detectedBy === "django-adapter" && access.kind === "database" && access.access === "read" && access.selector === "orders"), 2);
    assert.equal(countMatching(accesses, (access) => access.detectedBy === "django-adapter" && access.kind === "database" && access.access === "write" && access.selector === "orders"), 2);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("collectResourceAccesses resolves Django URL aliases, constants, managers, and instance writes", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-resource-django-edges-"));
  try {
    const lines = [
      "from django.db import models",
      "import django.urls as urls",
      "ROUTE = 'orders/'",
      "class Order(models.Model):",
      "    class Meta:",
      "        db_table = 'orders'",
      "urlpatterns = [urls.path(route=ROUTE, view=lambda request: None)]",
      "def run():",
      "    manager = Order.objects",
      "    manager.raw('select * from orders')",
      "    Order._default_manager.get(id=1)",
      "    Order.objects.bulk_update([], ['status'])",
      "    order = Order()",
      "    order.save()",
    ];
    const filePath = writePythonSource(rootDir, lines);
    const accesses = summarizeAccesses(collectResourceAccesses(createResourceContext(rootDir), filePath));

    assert.ok(accesses.some((access) => access.kind === "http" && access.selector === "ANY /orders"));
    assert.equal(countMatching(accesses, (access) => access.detectedBy === "django-adapter" && access.access === "read" && access.selector === "orders"), 2);
    assert.equal(countMatching(accesses, (access) => access.detectedBy === "django-adapter" && access.access === "write" && access.selector === "orders"), 2);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("collectResourceAccesses detects SQLAlchemy model, table, query, and SQL literal accesses", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-resource-sqlalchemy-python-"));
  try {
    const lines = [
      "from sqlalchemy import Table, select, insert, text",
      "users = Table('app_users', metadata)",
      "class Audit(Base):",
      "    __tablename__ = 'audit_log'",
      "def run(session):",
      "    session.query(Audit)",
      "    session.execute(select(users))",
      "    session.execute(insert(Audit))",
      "    session.add(Audit())",
      "    session.execute(text('select * from app_users join audit_log on 1 = 1'))",
    ];
    const filePath = writePythonSource(rootDir, lines);
    const accesses = summarizeAccesses(collectResourceAccesses(createResourceContext(rootDir), filePath));

    assert.equal(countMatching(accesses, (access) => access.detectedBy === "sqlalchemy-adapter" && access.access === "read" && access.selector === "audit_log"), 2);
    assert.equal(countMatching(accesses, (access) => access.detectedBy === "sqlalchemy-adapter" && access.access === "write" && access.selector === "audit_log"), 2);
    assert.equal(countMatching(accesses, (access) => access.detectedBy === "sqlalchemy-adapter" && access.access === "read" && access.selector === "app_users"), 2);
    assert.ok(accesses.every((access) => access.kind === "database"));
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("collectResourceAccesses resolves SQLAlchemy constants, attribute selectors, table methods, and driver SQL", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-resource-sqlalchemy-edges-"));
  try {
    const lines = [
      "from sqlalchemy import Table, select",
      "TABLE = 'app_users'",
      "SQL = 'delete from app_users where id = 1'",
      "users = Table(TABLE, metadata)",
      "class User(Base):",
      "    __tablename__ = TABLE",
      "def run(session, conn):",
      "    session.execute(select(User.id))",
      "    session.get(User, 1)",
      "    users.insert()",
      "    users.update()",
      "    users.delete()",
      "    conn.exec_driver_sql(SQL)",
    ];
    const filePath = writePythonSource(rootDir, lines);
    const accesses = summarizeAccesses(collectResourceAccesses(createResourceContext(rootDir), filePath));

    assert.equal(countMatching(accesses, (access) => access.detectedBy === "sqlalchemy-adapter" && access.access === "read" && access.selector === "app_users"), 2);
    assert.equal(countMatching(accesses, (access) => access.detectedBy === "sqlalchemy-adapter" && access.access === "write" && access.selector === "app_users"), 4);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("collectResourceAccesses detects SQLAlchemy session get and bulk writes without import hints", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-resource-sqlalchemy-no-hint-"));
  try {
    const lines = [
      "class User(Base):",
      "    __tablename__ = 'app_users'",
      "def run(session):",
      "    session.get(User, 1)",
      "    session.bulk_save_objects([User()])",
      "    session.bulk_insert_mappings(User, [{'id': 1}])",
      "    session.bulk_update_mappings(User, [{'id': 1}])",
    ];
    const filePath = writePythonSource(rootDir, lines);
    const accesses = summarizeAccesses(collectResourceAccesses(createResourceContext(rootDir), filePath));

    assert.equal(countMatching(accesses, (access) => access.detectedBy === "sqlalchemy-adapter" && access.access === "read" && access.selector === "app_users"), 1);
    assert.equal(countMatching(accesses, (access) => access.detectedBy === "sqlalchemy-adapter" && access.access === "write" && access.selector === "app_users"), 3);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("collectResourceAccesses detects Celery task declarations and publish calls", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-resource-celery-python-"));
  try {
    const lines = [
      "from celery import Celery, shared_task",
      "app = Celery('orders')",
      "@app.task(name='orders.rebuild')",
      "def rebuild():",
      "    return None",
      "@shared_task",
      "def cleanup():",
      "    return None",
      "def run():",
      "    app.send_task('orders.rebuild')",
      "    rebuild.delay()",
    ];
    const filePath = writePythonSource(rootDir, lines);
    const accesses = summarizeAccesses(collectResourceAccesses(createResourceContext(rootDir), filePath));

    assert.deepEqual(accesses.map((access) => `${access.access}:${access.selector}:${access.detectedBy}`), [
      "publish:celery:orders.rebuild:celery-adapter",
      "publish:celery:orders.rebuild:celery-adapter",
      "subscribe:celery:cleanup:celery-adapter",
      "subscribe:celery:orders.rebuild:celery-adapter",
    ]);
    assert.ok(accesses.every((access) => access.kind === "queue"));
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("collectResourceAccesses does not treat arbitrary delay methods as Celery publishes", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-resource-celery-no-fp-"));
  try {
    const lines = [
      "from celery import Celery",
      "app = Celery('orders')",
      "class Email:",
      "    def delay(self):",
      "        return None",
      "email = Email()",
      "def run():",
      "    email.delay()",
    ];
    const filePath = writePythonSource(rootDir, lines);
    const accesses = summarizeAccesses(collectResourceAccesses(createResourceContext(rootDir), filePath));

    assert.deepEqual(accesses.filter((access) => access.detectedBy === "celery-adapter"), []);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("collectResourceAccesses resolves Celery task constants and signature publish calls", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-resource-celery-edges-"));
  try {
    const lines = [
      "from celery import Celery, signature",
      "TASK = 'orders.rebuild'",
      "app = Celery('orders')",
      "@app.task(name=TASK)",
      "def rebuild():",
      "    return None",
      "def run():",
      "    signature(TASK).delay()",
    ];
    const filePath = writePythonSource(rootDir, lines);
    const accesses = summarizeAccesses(collectResourceAccesses(createResourceContext(rootDir), filePath));

    assert.equal(countMatching(accesses, (access) => access.detectedBy === "celery-adapter" && access.access === "subscribe" && access.selector === "celery:orders.rebuild"), 1);
    assert.equal(countMatching(accesses, (access) => access.detectedBy === "celery-adapter" && access.access === "publish" && access.selector === "celery:orders.rebuild"), 1);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("collectResourceAccesses honors Python framework resource adapter switches", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-resource-python-adapter-off-"));
  try {
    const lines = [
      "from fastapi import FastAPI",
      "app = FastAPI()",
      "@app.get('/health')",
      "def health():",
      "    return {'ok': True}",
    ];
    const filePath = writePythonSource(rootDir, lines);
    const accesses = collectResourceAccesses(createResourceContext(rootDir, { resourceAdapters: { fastapi: "off" } }), filePath);

    assert.deepEqual(accesses, []);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("collectResourceAccesses covers the full Prisma delegate method vocabulary", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-resource-prisma-vocabulary-"));
  try {
    fs.mkdirSync(path.join(rootDir, "prisma"), { recursive: true });
    fs.writeFileSync(
      path.join(rootDir, "prisma/schema.prisma"),
      [
        "model User {",
        "  id Int @id",
        "  @@map(\"app_users\")",
        "}",
        "",
      ].join("\n"),
    );
    const lines = [
      "declare const PrismaClient: new () => { user: {",
      "  findMany(): unknown; findFirst(): unknown; findUnique(): unknown; count(): unknown; aggregate(): unknown; groupBy(): unknown;",
      "  create(input: unknown): unknown; createMany(input: unknown): unknown; update(input: unknown): unknown; updateMany(input: unknown): unknown;",
      "  upsert(input: unknown): unknown; delete(input: unknown): unknown; deleteMany(input: unknown): unknown; unknownMethod(): unknown;",
      "} };",
      "const client = new PrismaClient();",
      "export function runRuntime(): void {",
      "  client.user.findMany();",
      "  client.user.findFirst();",
      "  client.user.findUnique();",
      "  client.user.count();",
      "  client.user.aggregate();",
      "  client.user.groupBy();",
      "  client.user.create({});",
      "  client.user.createMany({});",
      "  client.user.update({});",
      "  client.user.updateMany({});",
      "  client.user.upsert({});",
      "  client.user.delete({});",
      "  client.user.deleteMany({});",
      "  client.user.unknownMethod();",
      "}",
    ];
    const filePath = writeRuntimeSource(rootDir, lines);
    const accesses = collectResourceAccesses(createResourceContext(rootDir), filePath);
    const prismaAccesses = accesses.filter((access) => access.detectedBy === "prisma-adapter" && access.selector === "app_users");

    assert.equal(countMatching(prismaAccesses, (access) => access.access === "read"), 6);
    assert.equal(countMatching(prismaAccesses, (access) => access.access === "write"), 7);
    assert.equal(countMatching(accesses, (access) => access.source === "unknownMethod"), 0);
    assert.equal(prismaAccesses.find((access) => access.source === "findMany")?.line, lineOf(lines, "client.user.findMany"));
    assert.ok(prismaAccesses.every((access) => access.confidence === "high"));
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("collectResourceAccesses covers TypeORM repository read and write vocabularies", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-resource-typeorm-vocabulary-"));
  try {
    const lines = [
      "declare function Entity(options?: unknown): ClassDecorator;",
      "@Entity({ name: 'app_users' })",
      "class User {}",
      "declare function getRepository(entity: unknown): {",
      "  find(): unknown; findBy(input: unknown): unknown; findOne(input: unknown): unknown; findOneBy(input: unknown): unknown;",
      "  count(): unknown; countBy(input: unknown): unknown; exist(input: unknown): unknown;",
      "  save(input: unknown): unknown; insert(input: unknown): unknown; update(input: unknown): unknown; upsert(input: unknown): unknown;",
      "  delete(input: unknown): unknown; remove(input: unknown): unknown; softDelete(input: unknown): unknown; restore(input: unknown): unknown;",
      "};",
      "const repo = getRepository(User);",
      "export function runRuntime(): void {",
      "  repo.find();",
      "  repo.findBy({});",
      "  repo.findOne({});",
      "  repo.findOneBy({});",
      "  repo.count();",
      "  repo.countBy({});",
      "  repo.exist({});",
      "  repo.save({});",
      "  repo.insert({});",
      "  repo.update({});",
      "  repo.upsert({});",
      "  repo.delete({});",
      "  repo.remove({});",
      "  repo.softDelete({});",
      "  repo.restore({});",
      "}",
    ];
    const filePath = writeRuntimeSource(rootDir, lines);
    const accesses = collectResourceAccesses(createResourceContext(rootDir), filePath)
      .filter((access) => access.detectedBy === "typeorm-adapter" && access.selector === "app_users");

    assert.equal(countMatching(accesses, (access) => access.access === "read"), 7);
    assert.equal(countMatching(accesses, (access) => access.access === "write"), 8);
    assert.equal(accesses.find((access) => access.source === "save")?.line, lineOf(lines, "repo.save"));
    assert.ok(accesses.every((access) => access.confidence === "high"));
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("collectResourceAccesses covers file, HTTP, and generic queue call vocabularies", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-resource-call-vocabulary-"));
  try {
    const lines = [
      "import fsDefault, { appendFile, appendFileSync, copyFileSync, createReadStream, createWriteStream, openSync, readFile, readFileSync, readdir, readdirSync, rmSync, writeFile, writeFileSync } from 'node:fs';",
      "import { readFile as readFileFromPromises, writeFile as writeFileFromPromises } from 'node:fs/promises';",
      "import * as fsNamespace from 'fs';",
      "const SERVICE_URL = 'https://api.example.test/const';",
      "declare const pathName: string;",
      "declare const fd: unknown;",
      "declare const dynamicUrl: string;",
      "declare const DatabaseSync: new (path: string) => unknown;",
      "declare const childProcess: { execSync(command: string): unknown };",
      "declare function fetch(url: string): unknown;",
      "declare function request(url: string): unknown;",
      "declare const router: { get(path: string): unknown; post(path: string): unknown; put(path: string): unknown; patch(path: string): unknown; delete(path: string): unknown };",
      "declare const bus: { publish(topic: string): unknown; enqueue(topic: string): unknown; emitEvent(topic: string): unknown; sendMessage(topic: string): unknown;",
      "  subscribe(topic: string): unknown; consume(topic: string): unknown; dequeue(topic: string): unknown; receiveMessage(topic: string): unknown;",
      "  publishLater(topic: string): unknown; subscribeLater(topic: string): unknown };",
      "export function runRuntime(): void {",
      "  readFile('data/read.txt');",
      "  readFileSync('data/read-sync.txt');",
      "  createReadStream('data/read-stream.txt');",
      "  readdir('data/dir');",
      "  readdirSync('data/dir-sync');",
      "  writeFile('data/write.txt', '');",
      "  writeFileSync('data/write-sync.txt', '');",
      "  appendFile('data/append.txt', '');",
      "  appendFileSync('data/append-sync.txt', '');",
      "  createWriteStream('data/write-stream.txt');",
      "  openSync('data/open.txt', 'r');",
      "  rmSync('data/delete.txt');",
      "  copyFileSync('data/source.txt', 'data/dest.txt');",
      "  new DatabaseSync('app.db');",
      "  childProcess.execSync('psql -c \"select * from app_users\"');",
      "  childProcess.execSync('curl https://api.example.test/from-command');",
      "  fsDefault.readFileSync('data/default-read-sync.txt');",
      "  fsNamespace.createWriteStream('data/namespace-write-stream.txt');",
      "  fsNamespace.createWriteStream(pathName, { fd });",
      "  readFileFromPromises('data/promises-read.txt');",
      "  writeFileFromPromises('data/promises-write.txt', '');",
      "  readFile(pathName);",
      "  fetch('https://api.example.test/fetch');",
      "  fetch('/api/v1/users');",
      "  fetch('api/v1/users');",
      "  fetch('ws://api.example.test/socket');",
      "  fetch(new URL('https://api.example.test/url'));",
      "  fetch(SERVICE_URL);",
      "  fetch(dynamicUrl);",
      "  request('http://api.example.test/request');",
      "  router.get('/get');",
      "  router.post('/post');",
      "  router.put('/put');",
      "  router.patch('/patch');",
      "  router.delete('/delete');",
      "  bus.publish('events.publish');",
      "  bus.enqueue('events.enqueue');",
      "  bus.emitEvent('events.emit');",
      "  bus.sendMessage('events.message');",
      "  bus.subscribe('events.subscribe');",
      "  bus.consume('events.consume');",
      "  bus.dequeue('events.dequeue');",
      "  bus.receiveMessage('events.receive');",
      "  bus.publishLater('events.later');",
      "  bus.subscribeLater('events.later');",
      "}",
    ];
    const filePath = writeRuntimeSource(rootDir, lines);
    const accesses = summarizeAccesses(collectResourceAccesses(createResourceContext(rootDir), filePath));

    assert.equal(countMatching(accesses, (access) => access.kind === "file" && access.access === "read" && !access.unresolved), 9);
    assert.equal(countMatching(accesses, (access) => access.kind === "file" && access.access === "write" && !access.unresolved), 9);
    assert.equal(countMatching(accesses, (access) => access.kind === "file" && access.selector === "unresolved:dynamic-file-path" && access.unresolved), 1);
    assert.equal(countMatching(accesses, (access) => access.kind === "http" && access.access === "call"), 9);
    assert.equal(countMatching(accesses, (access) => access.kind === "http" && access.access === "serve"), 5);
    assert.equal(countMatching(accesses, (access) => access.kind === "queue" && access.access === "publish"), 4);
    assert.equal(countMatching(accesses, (access) => access.kind === "queue" && access.access === "subscribe"), 4);
    assert.equal(accesses.find((access) => access.selector === "data/read.txt")?.detectedBy, "readFile");
    assert.equal(accesses.find((access) => access.selector === "data/source.txt")?.access, "read");
    assert.equal(accesses.find((access) => access.selector === "data/dest.txt")?.access, "write");
    assert.equal(accesses.find((access) => access.selector === "sqlite:app.db")?.detectedBy, "node-sqlite-adapter");
    assert.deepEqual(
      accesses
        .filter((access) => access.selector === "unresolved:external-command-sql" || access.selector === "unresolved:external-command-http")
        .map((access) => `${access.kind}:${access.access}:${access.selector}:${access.source}:${access.detectedBy}:${access.confidence}:${access.unresolved}:${access.reason}`)
        .sort(),
      [
        "database:read:unresolved:external-command-sql:execSync:external-command:low:true:external command may access database resources",
        "http:call:unresolved:external-command-http:execSync:external-command:low:true:external command may access HTTP resources",
      ],
    );
    assert.deepEqual(
      accesses
        .filter((access) => access.selector === "unresolved:dynamic-http-url")
        .map((access) => `${access.kind}:${access.access}:${access.source}:${access.detectedBy}:${access.confidence}:${access.unresolved}:${access.reason}`),
      ["http:call:fetch:http-call:low:true:HTTP URL argument is not a static literal"],
    );
    assert.equal(accesses.find((access) => access.selector === "GET /get")?.line, lineOf(lines, "router.get"));
    assert.equal(accesses.find((access) => access.selector === "unresolved:dynamic-file-path")?.reason, "file path argument is not a static literal");
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("collectResourceAccesses keeps HTTP selector resolution strict", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-resource-http-strict-"));
  try {
    const lines = [
      "declare const flag: boolean;",
      "declare const dynamicUrl: string;",
      "const CLEAN_URL = flag ? 'https://api.example.test/clean' : '';",
      "const BLANK_URL = flag ? '   ' : 'https://api.example.test/blank';",
      "declare function fetch(url?: unknown): unknown;",
      "declare const Request: new (url: string) => unknown;",
      "export function runRuntime(): void {",
      "  fetch();",
      "  fetch(new URL('https://api.example.test/url'));",
      "  fetch(new Request('https://api.example.test/request-object'));",
      "  fetch(CLEAN_URL);",
      "  fetch(BLANK_URL);",
      "  fetch(dynamicUrl);",
      "}",
    ];
    const filePath = writeRuntimeSource(rootDir, lines);
    const accesses = summarizeAccesses(collectResourceAccesses(createResourceContext(rootDir), filePath));

    assert.deepEqual(accesses.map((access) => `${access.kind}:${access.access}:${access.selector}:${access.detectedBy}:${access.confidence}:${access.unresolved}:${access.reason}`), [
      "http:call:https://api.example.test/blank:fetch:high:false:",
      "http:call:https://api.example.test/clean:fetch:high:false:",
      "http:call:https://api.example.test/url:fetch:high:false:",
      "http:call:unresolved:dynamic-http-url:http-call:low:true:HTTP URL argument is not a static literal",
      "http:call:unresolved:dynamic-http-url:http-call:low:true:HTTP URL argument is not a static literal",
    ]);
    assert.equal(accesses.some((access) => access.selector.trim().length === 0), false);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("collectResourceAccesses classifies extended fs and command vocabularies exactly", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-resource-extended-vocab-"));
  try {
    const lines = [
      "import { copyFile, open, rm, unlink, unlinkSync } from 'node:fs';",
      "declare const cp: { execFileSync(command: string): unknown; spawnSync(command: string): unknown };",
      "declare const dynamicPath: string;",
      "export function runRuntime(): void {",
      "  open('data/open-read.txt', 'r');",
      "  open('data/open-write.txt', 'w');",
      "  rm('data/remove.txt');",
      "  unlink('data/unlink.txt');",
      "  unlinkSync('data/unlink-sync.txt');",
      "  copyFile('data/copy-source.txt', 'data/copy-dest.txt');",
      "  copyFile(dynamicPath, 'data/dynamic-source-dest.txt');",
      "  copyFile('data/dynamic-dest-source.txt', dynamicPath);",
      "  cp.execFileSync('wget https://api.example.test/archive');",
      "  cp.spawnSync('sqlite3');",
      "}",
    ];
    const filePath = writeRuntimeSource(rootDir, lines);
    const accesses = summarizeAccesses(collectResourceAccesses(createResourceContext(rootDir), filePath));

    assert.deepEqual(accesses.map((access) => `${access.kind}:${access.access}:${access.selector}:${access.source}:${access.detectedBy}:${access.confidence}:${access.unresolved}:${access.reason}`), [
      "database:read:unresolved:external-command-sql:spawnSync:external-command:low:true:external command may access database resources",
      "file:read:data/copy-source.txt:copyFile:copyFile:high:false:",
      "file:read:data/dynamic-dest-source.txt:copyFile:copyFile:high:false:",
      "file:read:data/open-read.txt:open:open:high:false:",
      "file:read:unresolved:dynamic-file-path:copyFile:file-call:low:true:file path argument is not a static literal",
      "file:write:data/copy-dest.txt:copyFile:copyFile:high:false:",
      "file:write:data/open-write.txt:open:open:high:false:",
      "file:write:data/remove.txt:rm:rm:high:false:",
      "file:write:data/unlink-sync.txt:unlinkSync:unlinkSync:high:false:",
      "file:write:data/unlink.txt:unlink:unlink:high:false:",
      "file:write:unresolved:dynamic-file-path:copyFile:file-call:low:true:file path argument is not a static literal",
      "http:call:unresolved:external-command-http:execFileSync:external-command:low:true:external command may access HTTP resources",
    ]);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("collectResourceAccesses honors HTTP and SQL adapter gates for external commands", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-resource-command-gates-"));
  try {
    const lines = [
      "declare const childProcess: { execSync(command: string): unknown };",
      "export function runRuntime(): void {",
      "  childProcess.execSync('curl https://api.example.test/from-shell');",
      "  childProcess.execSync('psql -c \"select * from app_users\"');",
      "}",
    ];
    const filePath = writeRuntimeSource(rootDir, lines);
    const commandSelectors = (governance = {}) => summarizeAccesses(collectResourceAccesses(createResourceContext(rootDir, governance), filePath))
      .map((access) => `${access.kind}:${access.access}:${access.selector}:${access.source}:${access.detectedBy}:${access.confidence}:${access.unresolved}`);

    assert.deepEqual(commandSelectors(), [
      "database:read:unresolved:external-command-sql:execSync:external-command:low:true",
      "http:call:unresolved:external-command-http:execSync:external-command:low:true",
    ]);
    assert.deepEqual(commandSelectors({ resourceAdapters: { http: "off" } }), [
      "database:read:unresolved:external-command-sql:execSync:external-command:low:true",
    ]);
    assert.deepEqual(commandSelectors({ resourceAdapters: { "sql-literal": "off" } }), [
      "http:call:unresolved:external-command-http:execSync:external-command:low:true",
    ]);
    assert.deepEqual(commandSelectors({ resourceAdapters: { http: "off", "sql-literal": "off" } }), []);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("collectResourceAccesses handles dynamic fs paths and descriptor-backed streams exactly", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-resource-fs-dynamic-"));
  try {
    const lines = [
      "import * as fs from 'node:fs';",
      "declare const dynamicPath: string;",
      "declare const fd: number;",
      "export function runRuntime(): void {",
      "  fs.createReadStream(dynamicPath, { fd });",
      "  fs.createWriteStream(dynamicPath, { fd });",
      "  fs.readFileSync();",
      "  fs.readFile(dynamicPath, { fd });",
      "  fs.readFileSync(dynamicPath);",
      "}",
    ];
    const filePath = writeRuntimeSource(rootDir, lines);
    assert.deepEqual(summarizeAccesses(collectResourceAccesses(createResourceContext(rootDir), filePath)), [
      {
        kind: "file",
        access: "read",
        selector: "unresolved:dynamic-file-path",
        source: "readFile",
        detectedBy: "file-call",
        confidence: "low",
        unresolved: true,
        reason: "file path argument is not a static literal",
        line: lineOf(lines, "fs.readFile(dynamicPath"),
      },
      {
        kind: "file",
        access: "read",
        selector: "unresolved:dynamic-file-path",
        source: "readFileSync",
        detectedBy: "file-call",
        confidence: "low",
        unresolved: true,
        reason: "file path argument is not a static literal",
        line: lineOf(lines, "fs.readFileSync(dynamicPath)"),
      },
    ]);

    const disabledContext = createResourceContext(rootDir, { resourceAdapters: { file: "off" } });
    assert.deepEqual(collectResourceAccesses(disabledContext, filePath), []);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("collectResourceAccesses treats only fs-bound helpers as direct file accesses", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-resource-fs-provenance-"));
  try {
    const lines = [
      "const fsRequire = require('fs');",
      "const { readFile: requireReadFile, promises: fsPromises } = require('node:fs');",
      "const { readFile: promiseDestructuredRead } = require('node:fs').promises;",
      "const { promises: { readFile: nestedPromiseRead } } = require('node:fs');",
      "const requireWriteFile = require('node:fs').writeFileSync;",
      "import * as importedFs from 'node:fs';",
      "import { readFile as hoistedShadowReadFile } from 'node:fs';",
      "import type { readFile as typeOnlyReadFile } from 'node:fs';",
      "import { type writeFile as typeOnlyWriteFile } from 'node:fs';",
      "const importedReadFile = importedFs.readFileSync;",
      "const { readFile: importedPromiseRead } = importedFs.promises;",
      "declare function readFile(path: string): unknown;",
      "declare function leakedReadFile(path: string): unknown;",
      "declare const leakedFs: { readFileSync(path: string): unknown };",
      "declare const loader: { require(specifier: string): { readFileSync(path: string): unknown } };",
      "function setupScopedBindings(): void {",
      "  const leakedReadFile = require('node:fs').readFileSync;",
      "  const leakedFs = require('node:fs');",
      "  leakedReadFile('data/scoped-only-read-sync.txt');",
      "  leakedFs.readFileSync('data/scoped-only-namespace-read-sync.txt');",
      "}",
      "export function runRuntime(readFileSync: (path: string) => unknown): void {",
      "  fsRequire.readFileSync('data/require-read-sync.txt');",
      "  requireReadFile('data/require-read.txt');",
      "  fsPromises.writeFile('data/require-promises-write.txt', '');",
      "  requireWriteFile('data/require-write-sync.txt', '');",
      "  require('node:fs').readFileSync('data/inline-require-read-sync.txt');",
      "  require('node:fs/promises').writeFile('data/inline-require-promises-write.txt', '');",
      "  require('node:fs').promises.readFile('data/inline-require-promises-read.txt');",
      "  importedReadFile('data/imported-alias-read-sync.txt');",
      "  importedPromiseRead('data/imported-promise-read.txt');",
      "  promiseDestructuredRead('data/promises-destructured-read.txt');",
      "  nestedPromiseRead('data/nested-promises-read.txt');",
      "  {",
      "    const scopedFs = require('node:fs');",
      "    const { writeFile: scopedWriteFile } = require('node:fs/promises');",
      "    const scopedReadFile = scopedFs.readFileSync;",
      "    scopedFs.readFileSync('data/scoped-require-read-sync.txt');",
      "    scopedWriteFile('data/scoped-require-promises-write.txt', '');",
      "    scopedReadFile('data/scoped-alias-read-sync.txt');",
      "  }",
      "  function setupVarBinding(): void {",
      "    if (true) {",
      "      var varFs = require('node:fs');",
      "      var { readFileSync: varReadFileSync } = require('node:fs');",
      "    }",
      "    varFs.readFileSync('data/var-scope-read-sync.txt');",
      "    varReadFileSync('data/var-alias-read-sync.txt');",
      "  }",
      "  function setupShadowedRequire(require: (specifier: string) => { readFileSync(path: string): unknown }): void {",
      "    const localFs = require('node:fs');",
      "    localFs.readFileSync('local-require-param-read-sync.txt');",
      "  }",
      "  function setupLocalRequire(): void {",
      "    const require = (specifier: string): { readFileSync(path: string): unknown } => ({ readFileSync: (path: string): unknown => path });",
      "    const localFs = require('node:fs');",
      "    localFs.readFileSync('local-require-const-read-sync.txt');",
      "  }",
      "  function setupHoistedRequireShadow(): void {",
      "    const localFs = require('node:fs');",
      "    localFs.readFileSync('local-require-hoisted-shadow-read-sync.txt');",
      "    function require(specifier: string): { readFileSync(path: string): unknown } {",
      "      return { readFileSync: (path: string): unknown => path };",
      "    }",
      "  }",
      "  function setupHoistedFsShadow(): void {",
      "    hoistedShadowReadFile('local-hoisted-function-shadow-read.txt');",
      "    function hoistedShadowReadFile(path: string): unknown { return path; }",
      "  }",
      "  function setupVarFsShadow(): void {",
      "    hoistedShadowReadFile('local-var-shadow-read.txt');",
      "    var hoistedShadowReadFile = (path: string): unknown => path;",
      "  }",
      "  function setupNestedVarFsShadow(cond: boolean): void {",
      "    if (cond) {",
      "      var hoistedShadowReadFile = (path: string): unknown => path;",
      "    }",
      "    hoistedShadowReadFile('local-nested-var-shadow-read.txt');",
      "  }",
      "  readFile('local-helper-read.txt');",
      "  typeOnlyReadFile('type-only-read.txt');",
      "  typeOnlyWriteFile('type-only-write.txt', '');",
      "  leakedReadFile('local-helper-leaked-read.txt');",
      "  leakedFs.readFileSync('local-facade-leaked-read-sync.txt');",
      "  loader.require('node:fs').readFileSync('local-loader-require-read-sync.txt');",
      "  readFileSync('shadowed-param-read.txt');",
      "  {",
      "  const requireReadFile = (path: string) => path;",
      "  requireReadFile('shadowed-local-read.txt');",
      "  }",
      "}",
    ];
    const filePath = writeRuntimeSource(rootDir, lines);
    const accesses = summarizeAccesses(collectResourceAccesses(createResourceContext(rootDir), filePath));

    assert.deepEqual(accesses.map((access) => `${access.kind}:${access.access}:${access.selector}:${access.detectedBy}`), [
      "file:read:data/imported-alias-read-sync.txt:importedReadFile",
      "file:read:data/imported-promise-read.txt:importedPromiseRead",
      "file:read:data/inline-require-promises-read.txt:readFile",
      "file:read:data/inline-require-read-sync.txt:readFileSync",
      "file:read:data/require-read-sync.txt:readFileSync",
      "file:read:data/require-read.txt:requireReadFile",
      "file:read:data/nested-promises-read.txt:nestedPromiseRead",
      "file:read:data/promises-destructured-read.txt:promiseDestructuredRead",
      "file:read:data/scoped-alias-read-sync.txt:scopedReadFile",
      "file:read:data/scoped-only-namespace-read-sync.txt:readFileSync",
      "file:read:data/scoped-only-read-sync.txt:leakedReadFile",
      "file:read:data/scoped-require-read-sync.txt:readFileSync",
      "file:read:data/var-alias-read-sync.txt:varReadFileSync",
      "file:read:data/var-scope-read-sync.txt:readFileSync",
      "file:write:data/scoped-require-promises-write.txt:scopedWriteFile",
      "file:write:data/inline-require-promises-write.txt:writeFile",
      "file:write:data/require-promises-write.txt:writeFile",
      "file:write:data/require-write-sync.txt:requireWriteFile",
    ].sort());
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("collectResourceAccesses keeps adapter disabled switches fail-closed for every built-in detector", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-resource-disabled-direct-"));
  try {
    const lines = [
      "declare const PrismaClient: new () => { user: { findMany(): unknown } };",
      "const prismaClient = new PrismaClient();",
      "declare function Entity(options?: unknown): ClassDecorator;",
      "@Entity('app_users')",
      "class User {}",
      "declare function getRepository(entity: unknown): { find(): unknown };",
      "declare function pgTable(name: string): unknown;",
      "const users = pgTable('users');",
      "declare const db: { select: { from(table: unknown): unknown } };",
      "declare function createQueryBuilder(): { from(table: string): unknown };",
      "declare function Controller(path?: string): ClassDecorator;",
      "declare function Get(path?: string): MethodDecorator;",
      "@Controller('/api')",
      "class ApiController { @Get('/health') health(): void {} }",
      "declare const server: { route(config: unknown): void };",
      "declare const Queue: new (queueName: string) => { add(name: string, payload: unknown): void };",
      "declare const Worker: new (queueName: string, processor: unknown) => unknown;",
      "const jobs = new Queue('jobs');",
      "declare const kafkaProducer: { send(config: unknown): void };",
      "declare const sqlClient: { query(sql: string): void };",
      "import { readFile } from 'node:fs';",
      "declare function fetch(url: string): unknown;",
      "declare const childProcess: { execSync(command: string): unknown };",
      "declare const bus: { publish(topic: string): unknown };",
      "export function runRuntime(): void {",
      "  prismaClient.user.findMany();",
      "  getRepository(User).find();",
      "  db.select.from(users);",
      "  createQueryBuilder().from('audit_logs');",
      "  server.route({ path: '/status', method: 'GET' });",
      "  jobs.add('run', {});",
      "  new Worker('jobs', () => undefined);",
      "  kafkaProducer.send({ topic: 'orders.created' });",
      "  sqlClient.query('select * from app_users');",
      "  readFile('data/input.json');",
      "  fetch('https://api.example.test');",
      "  childProcess.execSync('curl https://api.example.test');",
      "  childProcess.execSync('psql -c \"select * from app_users\"');",
      "  bus.publish('domain.events');",
      "}",
    ];
    const filePath = writeRuntimeSource(rootDir, lines);
    const context = createResourceContext(rootDir, {
      resourceAdapters: {
        file: "off",
        http: "off",
        queue: "off",
        "sql-literal": "off",
        prisma: "off",
        typeorm: "off",
        drizzle: "off",
        "query-builder": "off",
        bullmq: "off",
        kafkajs: "off",
        nestjs: "off",
        fastify: "off",
      },
    });

    assert.deepEqual(collectResourceAccesses(context, filePath), []);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("collectResourceAccesses covers NestJS decorators and normalized route paths exactly", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-resource-nest-vocabulary-"));
  try {
    const lines = [
      "declare function Controller(path?: string): ClassDecorator;",
      "declare function Get(path?: string): MethodDecorator;",
      "declare function Post(path?: string): MethodDecorator;",
      "declare function Put(path?: string): MethodDecorator;",
      "declare function Patch(path?: string): MethodDecorator;",
      "declare function Delete(path?: string): MethodDecorator;",
      "declare function Options(path?: string): MethodDecorator;",
      "declare function Head(path?: string): MethodDecorator;",
      "declare function All(path?: string): MethodDecorator;",
      "declare function Other(path?: string): MethodDecorator;",
      "@Controller(' /api//v1/ ')",
      "class ApiController {",
      "  @Get(' /users// ')",
      "  list(): void {}",
      "  @Post('/users')",
      "  create(): void {}",
      "  @Put('/users/:id')",
      "  replace(): void {}",
      "  @Patch('/users/:id')",
      "  update(): void {}",
      "  @Delete('/users/:id')",
      "  remove(): void {}",
      "  @Options('/users')",
      "  options(): void {}",
      "  @Head('/users')",
      "  head(): void {}",
      "  @All('/everything')",
      "  all(): void {}",
      "  @Other('/ignored')",
      "  ignored(): void {}",
      "}",
      "@Other('/not-controller')",
      "class OtherController { @Get('/ignored-other') ignored(): void {} }",
      "class PlainController { @Get('/ignored') ignored(): void {} }",
      "export const done = true;",
    ];
    const filePath = writeRuntimeSource(rootDir, lines);
    const accesses = summarizeAccesses(collectResourceAccesses(createResourceContext(rootDir), filePath))
      .filter((access) => access.detectedBy === "nestjs-adapter");

    assert.deepEqual(accesses.map((access) => `${access.selector}:${access.source}:${access.line}`), [
      `ALL /api/v1/everything:All:${lineOf(lines, "@All")}`,
      `DELETE /api/v1/users/:id:Delete:${lineOf(lines, "@Delete")}`,
      `GET /api/v1/users:Get:${lineOf(lines, "@Get(' /users// ')")}`,
      `HEAD /api/v1/users:Head:${lineOf(lines, "@Head")}`,
      `OPTIONS /api/v1/users:Options:${lineOf(lines, "@Options")}`,
      `PATCH /api/v1/users/:id:Patch:${lineOf(lines, "@Patch")}`,
      `POST /api/v1/users:Post:${lineOf(lines, "@Post")}`,
      `PUT /api/v1/users/:id:Put:${lineOf(lines, "@Put")}`,
    ]);
    assert.ok(accesses.every((access) => access.confidence === "high"));
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("collectResourceAccesses rejects near-miss object properties and non-resource calls", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-resource-near-misses-"));
  try {
    const lines = [
      "declare const server: { route(config: unknown): void };",
      "declare const kafkaProducer: { send(config: unknown): void };",
      "declare const kafkaConsumer: { subscribe(config: unknown): void };",
      "declare const tableName: string;",
      "declare const sqlClient: { query(input: unknown): void; execute(input: unknown): void };",
      "declare const analyticsClient: { query(input: unknown): void; inspect(input: unknown): void };",
      "declare const localFs: { readFile(path: string): unknown; writeFileSync(path: string, data: string): unknown };",
      "declare const fsFacade: { createReadStream(path: string): unknown };",
      "declare function fetch(url: string): unknown;",
      "declare function get(path: string): unknown;",
      "declare function publish(topic: string): unknown;",
      "declare function subscribe(topic: string): unknown;",
      "declare function readFile(path: string): unknown;",
      "declare const router: { get(path: string): unknown };",
      "declare const routeMap: { get(path: string): unknown };",
      "declare const bus: { publish(topic: string): unknown; sendMessage(topic: string): unknown };",
      "declare const stateRouter: { subscribe(event: string): unknown };",
      "declare const fsWithFd: { createWriteStream(path: string, options: { fd: unknown }): unknown };",
      "declare const fd: unknown;",
      "declare const hash: { update(chunk: string, encoding?: string): typeof hash; digest(format: string): string };",
      "export function runRuntime(): void {",
      "  const callback = () => () => undefined;",
      "  callback()();",
      "  server.route({ 'wrong': '/wrong', 'path': ' /status// ', 'method': ['get', 'post', 1] });",
      "  server.route({ path: '/no-method' });",
      "  server.route({ method: 'GET' });",
      "  server.route({ path: '/numeric-methods', method: [1] });",
      "  server.route({ wrong: '/missing-method' });",
      "  kafkaProducer.send({ 'wrongTopic': 'ignored', 'topic': 'orders.created' });",
      "  kafkaConsumer.subscribe({ 'wrongTopic': 'ignored', 'topic': 'orders.created' });",
      "  sqlClient.query('select * from app_users join audit_logs on true');",
      "  sqlClient.query('insert into audit_logs values (1)');",
      "  sqlClient.query('update app_users set id = id');",
      "  sqlClient.query('this is not sql');",
      "  const metadataTableSql = tableName ? 'select * from information_schema.tables' : 'select * from information_schema.columns';",
      "  sqlClient.query(metadataTableSql);",
      "  const literalPrefix = 'select * from ';",
      "  const staticConcatSql = literalPrefix + 'information_schema.columns';",
      "  sqlClient.query(staticConcatSql);",
      "  const dynamicSql = 'select * from ' + tableName;",
      "  const notSql = 'hello ' + tableName;",
      "  sqlClient.query(dynamicSql);",
      "  sqlClient.query(notSql);",
      "  sqlClient.query(tableName);",
      "  sqlClient.execute(tableName);",
      "  sqlClient.inspect(tableName);",
      "  analyticsClient.query(tableName);",
      "  analyticsClient.inspect(tableName);",
      "  sqlClient.query();",
      "  hash.update('\\0', 'utf8').update('cache-key').digest('hex');",
      "  fetch();",
      "  fetch('/relative-not-http');",
      "  readFile('local-helper.txt');",
      "  localFs.readFile('local-object.txt');",
      "  localFs.writeFileSync('local-object-write.txt', '');",
      "  fsFacade.createReadStream('facade.txt');",
      "  get('/bare-route-helper');",
      "  publish('events.barePublish');",
      "  subscribe('events.bareSubscribe');",
      "  router.get('relative-route');",
      "  routeMap.get('/');",
      "  bus.publish('/not-a-queue-route');",
      "  bus.publish('http://not-a-queue.example/topic');",
      "  bus.sendMessage('https://not-a-queue.example.test/topic');",
      "  stateRouter.subscribe('onResolved');",
      "  fsWithFd.createWriteStream('ignored', { fd });",
      "  readFile();",
      "}",
    ];
    const filePath = writeRuntimeSource(rootDir, lines);
    const accesses = summarizeAccesses(collectResourceAccesses(createResourceContext(rootDir), filePath));

    assert.deepEqual(accesses.map((access) => `${access.kind}:${access.access}:${access.selector}:${access.detectedBy}:${access.reason}`), [
      "database:read:app_users:sql-literal:",
      "database:read:audit_logs:sql-literal:",
      "database:read:information_schema.columns:sql-literal:",
      "database:read:information_schema.columns:sql-literal:",
      "database:read:information_schema.tables:sql-literal:",
      "database:read:unresolved:dynamic-sql:sql-literal:SQL query receiver was previously observed but this argument is not a static literal",
      "database:read:unresolved:dynamic-sql:sql-literal:SQL query is assembled dynamically",
      "database:read:unresolved:dynamic-sql:sql-literal:SQL query receiver was previously observed but this argument is not a static literal",
      "database:read:unresolved:dynamic-sql:sql-literal:SQL query receiver was previously observed but this argument is not a static literal",
      "database:write:app_users:sql-literal:",
      "database:write:audit_logs:sql-literal:",
      "http:call:/relative-not-http:fetch:",
      "http:serve:GET /status:fastify-adapter:",
      "http:serve:POST /status:fastify-adapter:",
      "queue:publish:kafka:orders.created:kafkajs-adapter:",
      "queue:subscribe:kafka:orders.created:kafkajs-adapter:",
    ]);
    assert.equal(accesses.find((access) => access.selector === "GET /status")?.line, lineOf(lines, "server.route({ 'wrong': '/wrong'"));
    const fastifyGet = accesses.find((access) => access.selector === "GET /status");
    assert.deepEqual({
      kind: fastifyGet?.kind,
      source: fastifyGet?.source,
      confidence: fastifyGet?.confidence,
    }, {
      kind: "http",
      source: "route",
      confidence: "high",
    });
    const kafkaPublish = accesses.find((access) => access.selector === "kafka:orders.created" && access.access === "publish");
    assert.deepEqual({
      kind: kafkaPublish?.kind,
      source: kafkaPublish?.source,
      confidence: kafkaPublish?.confidence,
    }, {
      kind: "queue",
      source: "send",
      confidence: "medium",
    });
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("collectResourceAccesses keeps SQL string resolution lexical and fail-closed for reassignment", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-resource-sql-lexical-"));
  try {
    const lines = [
      "declare const sqlClient: { query(input: unknown): void };",
      "declare const flag: boolean;",
      "const topLevelSql = 'select * from top_level_users';",
      "const topLevelPrefix = 'select * from ';",
      "export function topLevel(): void {",
      "  sqlClient.query(topLevelSql);",
      "}",
      "export function parameter(sql: string): void {",
      "  sqlClient.query(sql); // parameter",
      "}",
      "export function unrelated(): void {",
      "  const sql = 'select * from unrelated_users';",
      "}",
      "export function outerBlock(): void {",
      "  const sql = 'select * from outer_block_users';",
      "  if (flag) {",
      "    sqlClient.query(sql); // outer block",
      "  }",
      "}",
      "export function shadowedDependency(topLevelPrefix: string): void {",
      "  const sql = topLevelPrefix + 'shadowed_users';",
      "  sqlClient.query(sql); // shadowed dependency",
      "}",
      "export function reassigned(): void {",
      "  let sqlText = 'select * from app_users';",
      "  if (flag) sqlText = 'delete from audit_logs';",
      "  sqlClient.query(sqlText);",
      "}",
      "export function notSql(tableName: string): void {",
      "  const notSql = 'hello ' + tableName;",
      "  sqlClient.query(notSql);",
      "}",
    ];
    const filePath = writeRuntimeSource(rootDir, lines);
    const accesses = summarizeAccesses(collectResourceAccesses(createResourceContext(rootDir), filePath));
    const expected = [
      `database:read:outer_block_users:sql-literal::${lineOf(lines, "outer block")}`,
      `database:read:top_level_users:sql-literal::${lineOf(lines, "sqlClient.query(topLevelSql)")}`,
      `database:read:unresolved:dynamic-sql:sql-literal:SQL query is assembled dynamically:${lineOf(lines, "// parameter")}`,
      `database:read:unresolved:dynamic-sql:sql-literal:SQL query is assembled dynamically:${lineOf(lines, "shadowed dependency")}`,
      `database:read:unresolved:dynamic-sql:sql-literal:SQL query is assembled dynamically:${lineOf(lines, "sqlClient.query(sqlText)")}`,
      `database:read:unresolved:dynamic-sql:sql-literal:SQL query receiver was previously observed but this argument is not a static literal:${lineOf(lines, "sqlClient.query(notSql)")}`,
    ].sort();

    assert.deepEqual(accesses.map((access) => `${access.kind}:${access.access}:${access.selector}:${access.detectedBy}:${access.reason}:${access.line}`).sort(), expected);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("collectResourceAccesses keeps query-builder, BullMQ, and Kafka edge guards precise", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-resource-edge-guards-"));
  try {
    const lines = [
      "declare function createQueryBuilder(): { select(): { from(table: string): unknown }, delete(): { from(table: string): unknown }, update(table: string): unknown, from(table: string): unknown };",
      "declare const queryDb: { selectFrom(table: string): unknown; insertInto(table: string): unknown; updateTable(table: string): unknown; deleteFrom(table: string): unknown };",
      "declare const db: { select: { from(table: unknown): unknown }, update(table: unknown): unknown };",
      "declare const notDb: { update(table: unknown): unknown };",
      "declare function pgTable(name: string): unknown;",
      "const users = pgTable('users');",
      "declare const Queue: new (queueName: string) => { add(name: string, payload: unknown): void; notAdd(name: string): void };",
      "declare const Worker: new (queueName?: string, processor?: unknown) => unknown;",
      "declare const NotWorker: new (queueName: string) => unknown;",
      "const jobs = new Queue('jobs');",
      "const unknownQueue = { add(name: string): void {} };",
      "declare const kafkaProducer: { send(config: unknown): void };",
      "declare const kafkaConsumer: { subscribe(config: unknown): void };",
      "export function runRuntime(): void {",
      "  createQueryBuilder().select().from('read_table');",
      "  createQueryBuilder().delete().from('delete_table');",
      "  createQueryBuilder().update('update_table');",
      "  createQueryBuilder().from('plain_from_table');",
      "  queryDb.selectFrom('generic_read');",
      "  queryDb.insertInto('generic_insert');",
      "  queryDb.updateTable('generic_update');",
      "  queryDb.deleteFrom('generic_delete');",
      "  db.select.from(users);",
      "  db.update(users);",
      "  notDb.update(users);",
      "  jobs.add('run', {});",
      "  jobs.notAdd('not-bullmq-add');",
      "  unknownQueue.add('ignored');",
      "  new Worker('jobs', () => undefined);",
      "  new Worker();",
      "  new NotWorker('jobs');",
      "  kafkaProducer.send({ topic: 'orders.created' });",
      "  kafkaProducer.send({ topicName: 'ignored' });",
      "  kafkaConsumer.subscribe({ topic: 'orders.created' });",
      "  kafkaConsumer.subscribe({ topicName: 'ignored' });",
      "}",
    ];
    const filePath = writeRuntimeSource(rootDir, lines);
    const accesses = summarizeAccesses(collectResourceAccesses(createResourceContext(rootDir), filePath));

    assert.deepEqual(accesses.map((access) => `${access.kind}:${access.access}:${access.selector}:${access.detectedBy}:${access.source}:${access.confidence}`), [
      "database:read:generic_read:query-builder-adapter:selectFrom:medium",
      "database:read:plain_from_table:typeorm-adapter:from:medium",
      "database:read:read_table:typeorm-adapter:from:medium",
      "database:read:users:drizzle-adapter:from:high",
      "database:write:delete_table:typeorm-adapter:from:medium",
      "database:write:generic_delete:query-builder-adapter:deleteFrom:medium",
      "database:write:generic_insert:query-builder-adapter:insertInto:medium",
      "database:write:generic_update:query-builder-adapter:updateTable:medium",
      "database:write:update_table:typeorm-adapter:update:medium",
      "database:write:users:drizzle-adapter:update:high",
      "queue:publish:bullmq:jobs:bullmq-adapter:add:high",
      "queue:publish:kafka:orders.created:kafkajs-adapter:send:medium",
      "queue:subscribe:bullmq:jobs:bullmq-adapter:Worker:high",
      "queue:subscribe:kafka:orders.created:kafkajs-adapter:subscribe:medium",
    ]);
    assert.equal(accesses.find((access) => access.selector === "bullmq:jobs" && access.access === "subscribe")?.line, lineOf(lines, "new Worker('jobs'"));
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("collectResourceAccesses reports raw SQL unresolved reasons and unsafe calls exactly", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-resource-raw-details-"));
  try {
    const lines = [
      "declare const prisma: {",
      "  $queryRaw(input: unknown): unknown; $executeRaw(input: unknown): unknown;",
      "  $queryRawUnsafe(input: unknown): unknown; $executeRawUnsafe(input: unknown): unknown;",
      "};",
      "declare const other: { $queryRawUnsafe(input: unknown): unknown };",
      "export function runRuntime(tableName: string): void {",
      "  prisma.$queryRaw('select * from app_users');",
      "  prisma.$executeRaw('update app_users set id = id');",
      "  prisma.$queryRaw(tableName);",
      "  prisma.$queryRawUnsafe('select * from app_users');",
      "  prisma.$executeRawUnsafe('update app_users set id = id');",
      "  prisma.$queryRaw`select * from ${tableName}`;",
      "  prisma.$queryRawUnsafe`select * from app_users`;",
      "  other.$queryRawUnsafe('select * from ignored_table');",
      "}",
    ];
    const filePath = writeRuntimeSource(rootDir, lines);
    const accesses = summarizeAccesses(collectResourceAccesses(createResourceContext(rootDir), filePath));

    assert.deepEqual(accesses.map((access) => `${access.kind}:${access.access}:${access.selector}:${access.source}:${access.detectedBy}:${access.confidence}:${access.unresolved}:${access.reason}:${access.line}`), [
      `database:read:app_users:$queryRaw:prisma-adapter:medium:false::${lineOf(lines, "prisma.$queryRaw('select")}`,
      `database:read:unresolved:dynamic-sql:$executeRawUnsafe:prisma-adapter:low:true:unsafe raw SQL call:${lineOf(lines, "prisma.$executeRawUnsafe")}`,
      `database:read:unresolved:dynamic-sql:$queryRaw:prisma-adapter:low:true:raw SQL argument is not a static literal:${lineOf(lines, "prisma.$queryRaw(tableName)")}`,
      `database:read:unresolved:dynamic-sql:$queryRaw:prisma-adapter:low:true:raw SQL template contains dynamic interpolation:${lineOf(lines, "prisma.$queryRaw`")}`,
      `database:read:unresolved:dynamic-sql:$queryRawUnsafe:prisma-adapter:low:true:unsafe raw SQL call:${lineOf(lines, "prisma.$queryRawUnsafe('")}`,
      `database:read:unresolved:dynamic-sql:$queryRawUnsafe:prisma-adapter:low:true:unsafe raw SQL call:${lineOf(lines, "prisma.$queryRawUnsafe`")}`,
      `database:write:app_users:$executeRaw:prisma-adapter:medium:false::${lineOf(lines, "prisma.$executeRaw('")}`,
    ]);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("collectResourceAccesses reports unresolved dynamic table reasons exactly", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-resource-dynamic-table-details-"));
  try {
    const lines = [
      "declare const tableName: string;",
      "declare const queryDb: { selectFrom(table: unknown): unknown; insertInto(table: unknown): unknown };",
      "declare function createQueryBuilder(): { from(table: unknown): unknown; insert(): { into(table: unknown): unknown } };",
      "declare const db: { select: { from(table: unknown): unknown }, insert(table: unknown): unknown };",
      "export function runRuntime(): void {",
      "  queryDb.selectFrom(tableName);",
      "  queryDb.insertInto(tableName);",
      "  createQueryBuilder().from(tableName);",
      "  createQueryBuilder().insert().into(tableName);",
      "  db.select.from(tableName);",
      "  db.insert(tableName);",
      "}",
    ];
    const filePath = writeRuntimeSource(rootDir, lines);
    const accesses = summarizeAccesses(collectResourceAccesses(createResourceContext(rootDir), filePath));

    assert.deepEqual(accesses.map((access) => `${access.kind}:${access.access}:${access.selector}:${access.detectedBy}:${access.source}:${access.confidence}:${access.unresolved}:${access.reason}`), [
      "database:read:unresolved:dynamic-drizzle-table:drizzle-adapter:from:low:true:from table argument is not a known Drizzle table declaration",
      "database:read:unresolved:dynamic-query-builder-table:typeorm-adapter:from:low:true:from table argument is not a static literal or known entity",
      "database:read:unresolved:dynamic-query-builder-table:query-builder-adapter:selectFrom:low:true:selectFrom table argument is not a static literal or known entity",
      "database:write:unresolved:dynamic-drizzle-table:drizzle-adapter:insert:low:true:insert table argument is not a known Drizzle table declaration",
      "database:write:unresolved:dynamic-query-builder-table:query-builder-adapter:insertInto:low:true:insertInto table argument is not a static literal or known entity",
      "database:write:unresolved:dynamic-query-builder-table:typeorm-adapter:into:low:true:into table argument is not a static literal or known entity",
    ]);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("resource access detects Prisma raw SQL calls and static file writes", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-resource-raw-"));
  try {
    fs.mkdirSync(path.join(rootDir, "src/runtime"), { recursive: true });
    fs.writeFileSync(
      path.join(rootDir, "src/runtime/public.ts"),
      [
        "declare const prisma: {",
        "  $queryRaw(sql: string): Promise<unknown>;",
        "  $executeRaw(sql: string): Promise<unknown>;",
        "};",
        "import * as fs from 'node:fs';",
        "export async function runRuntime(sql: string): Promise<void> {",
        "  await prisma.$queryRaw('select * from app_users');",
        "  await prisma.$executeRaw('update app_users set id = id');",
        "  await prisma.$queryRaw(sql);",
        "  fs.writeFileSync('data/output.json', '{}');",
        "  fs.appendFileSync('data/append.json', '{}');",
        "}",
        "",
      ].join("\n"),
    );
    writeJson(path.join(rootDir, "cellfence.manifest.json"), {
      schemaVersion: "cellfence.manifest.v1",
      cells: [{
        id: "runtime",
        ownedPaths: ["src/runtime/**"],
        publicEntry: "src/runtime/public.ts",
        publicSymbols: ["runRuntime"],
        consumes: [],
        producesArtifacts: [],
        resourceContracts: [{
          id: "runtime-resources",
          kind: "database",
          access: ["read", "write"],
          selectors: ["app_users", "unresolved:dynamic-sql"],
        }, {
          id: "runtime-files",
          kind: "file",
          access: ["write"],
          selectors: ["data/output.json", "data/append.json"],
        }],
      }],
    });

    const result = checkRepository({ rootDir, manifestPath: "cellfence.manifest.json" });
    assert.equal(result.ok, true, JSON.stringify(result.findings));
    assert.deepEqual(result.metrics.runtime.resourceAccesses, [
      {
        kind: "database",
        access: "read",
        selector: "app_users",
        detectedBy: "prisma-adapter",
        confidence: "medium",
      },
      {
        kind: "database",
        access: "read",
        selector: "unresolved:dynamic-sql",
        detectedBy: "prisma-adapter",
        confidence: "low",
      },
      {
        kind: "database",
        access: "write",
        selector: "app_users",
        detectedBy: "prisma-adapter",
        confidence: "medium",
      },
      {
        kind: "file",
        access: "write",
        selector: "data/append.json",
        detectedBy: "appendFileSync",
        confidence: "high",
      },
      {
        kind: "file",
        access: "write",
        selector: "data/output.json",
        detectedBy: "writeFileSync",
        confidence: "high",
      },
    ]);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("resource access detects Prisma tagged raw SQL templates", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-resource-tagged-"));
  try {
    fs.mkdirSync(path.join(rootDir, "src/runtime"), { recursive: true });
    fs.writeFileSync(
      path.join(rootDir, "src/runtime/public.ts"),
      [
        "declare const prisma: {",
        "  $queryRaw(strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown>;",
        "  $queryRawUnsafe(strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown>;",
        "};",
        "export async function runRuntime(tableName: string): Promise<void> {",
        "  await prisma.$queryRaw`select * from app_users`;",
        "  await prisma.$queryRaw`select * from ${tableName}`;",
        "  await prisma.$queryRawUnsafe`select * from app_users`;",
        "}",
        "",
      ].join("\n"),
    );
    writeJson(path.join(rootDir, "cellfence.manifest.json"), {
      schemaVersion: "cellfence.manifest.v1",
      cells: [{
        id: "runtime",
        ownedPaths: ["src/runtime/**"],
        publicEntry: "src/runtime/public.ts",
        publicSymbols: ["runRuntime"],
        consumes: [],
        producesArtifacts: [],
        resourceContracts: [{
          id: "runtime-sql",
          kind: "database",
          access: ["read"],
          selectors: ["app_users", "unresolved:dynamic-sql"],
        }],
      }],
    });

    const result = checkRepository({ rootDir, manifestPath: "cellfence.manifest.json" });
    assert.equal(result.ok, true, JSON.stringify(result.findings));
    assert.deepEqual(result.metrics.runtime.resourceAccesses, [
      {
        kind: "database",
        access: "read",
        selector: "app_users",
        detectedBy: "prisma-adapter",
        confidence: "medium",
      },
      {
        kind: "database",
        access: "read",
        selector: "unresolved:dynamic-sql",
        detectedBy: "prisma-adapter",
        confidence: "low",
      },
    ]);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("resource access covers decorator, route, query-builder, and repository edge forms", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-resource-edges-"));
  try {
    fs.mkdirSync(path.join(rootDir, "src/runtime"), { recursive: true });
    fs.writeFileSync(
      path.join(rootDir, "src/runtime/public.ts"),
      [
        "declare const PrismaClient: new () => { user: { findMany(): unknown } };",
        "declare function PrismaFactory(): unknown;",
        "const prisma = new PrismaClient();",
        "const ignoredPrisma = new (PrismaFactory as never)();",
        "declare function pgTable(tableName: string): unknown;",
        "const users = pgTable('users');",
        "declare function Entity(options?: unknown): ClassDecorator;",
        "@Entity({ name: 'app_users' })",
        "class User {}",
        "declare function getRepository(entity: unknown): { find(): unknown };",
        "declare function createQueryBuilder(): { from(tableName: string, alias: string): unknown };",
        "declare const tableName: string;",
        "declare const UnknownEntity: unknown;",
        "declare const getDb: unknown;",
        "declare const db: { select: { from(table: unknown): unknown }, insert(table: unknown): unknown };",
        "declare const server: { route(config: unknown): void };",
        "declare const producer: { send(config: unknown): void };",
        "export function runRuntime(): void {",
        "  prisma.user.findMany();",
        "  getRepository(User).find();",
        "  createQueryBuilder().from('audit_logs', 'audit');",
        "  createQueryBuilder().from(UnknownEntity, 'unknown');",
        "  createQueryBuilder().from(tableName, 'dynamic');",
        "  (getDb as { (): { select(): { from(table: unknown): unknown } } })().select().from(tableName);",
        "  db.select.from(users);",
        "  db.insert(tableName);",
        "  server.route({ path: '/status', method: 'GET' });",
        "  server.route({ url: '/single-method', method: 'post' });",
        "  server.route({ url: '/bad-method', method: 1 });",
        "  server.route({ url: '/missing-method' });",
        "  producer.send({});",
        "}",
        "",
      ].join("\n"),
    );
    writeJson(path.join(rootDir, "cellfence.manifest.json"), {
      schemaVersion: "cellfence.manifest.v1",
      cells: [{
        id: "runtime",
        ownedPaths: ["src/runtime/**"],
        publicEntry: "src/runtime/public.ts",
        publicSymbols: ["runRuntime"],
        consumes: [],
        producesArtifacts: [],
        resourceContracts: [{
          id: "runtime-database",
          kind: "database",
          access: ["read", "write"],
          selectors: ["prisma.user", "app_users", "audit_logs", "users", "unresolved:dynamic-query-builder-table", "unresolved:dynamic-drizzle-table"],
        }, {
          id: "runtime-http",
          kind: "http",
          access: ["serve"],
          selectors: ["GET /status", "POST /single-method"],
        }],
      }],
    });

    const result = checkRepository({ rootDir, manifestPath: "cellfence.manifest.json" });
    assert.equal(result.ok, true, JSON.stringify(result.findings));
    assert.ok(result.metrics.runtime.resourceAccesses.some((access) =>
      access.detectedBy === "typeorm-adapter" && access.selector === "app_users"));
    assert.ok(result.metrics.runtime.resourceAccesses.some((access) =>
      access.detectedBy === "fastify-adapter" && access.selector === "GET /status"));
    assert.ok(result.metrics.runtime.resourceAccesses.some((access) =>
      access.selector === "unresolved:dynamic-query-builder-table"));
    assert.ok(result.metrics.runtime.resourceAccesses.some((access) =>
      access.selector === "unresolved:dynamic-drizzle-table" && access.access === "write"));
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("resource access covers TypeORM selector fallback and NestJS decorator edge forms", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-resource-fallbacks-"));
  try {
    fs.mkdirSync(path.join(rootDir, "src/runtime"), { recursive: true });
    fs.writeFileSync(
      path.join(rootDir, "src/runtime/public.ts"),
      [
        "declare const UnknownEntity: unknown;",
        "declare function getRepository(entity: unknown): { find(): unknown };",
        "declare function Controller(prefix?: string): ClassDecorator;",
        "declare function Get(path?: string): MethodDecorator;",
        "declare function factory(path?: string): MethodDecorator;",
        "@Controller('api')",
        "class ApiController {",
        "  @((Get as never))('/ignored')",
        "  ignored(): void {}",
        "  @factory('/also-ignored')",
        "  ignoredByName(): void {}",
        "}",
        "export function runRuntime(): void {",
        "  getRepository(UnknownEntity).find();",
        "  getRepository('literal_repo').find();",
        "}",
        "",
      ].join("\n"),
    );
    writeJson(path.join(rootDir, "cellfence.manifest.json"), {
      schemaVersion: "cellfence.manifest.v1",
      cells: [{
        id: "runtime",
        ownedPaths: ["src/runtime/**"],
        publicEntry: "src/runtime/public.ts",
        publicSymbols: ["runRuntime"],
        consumes: [],
        producesArtifacts: [],
        resourceContracts: [{
          id: "typeorm-fallbacks",
          kind: "database",
          access: ["read"],
          selectors: ["UnknownEntity", "literal_repo"],
        }],
      }],
    });

    const result = checkRepository({ rootDir, manifestPath: "cellfence.manifest.json" });
    assert.equal(result.ok, true, JSON.stringify(result.findings));
    assert.ok(result.metrics.runtime.resourceAccesses.some((access) =>
      access.detectedBy === "typeorm-adapter" && access.selector === "UnknownEntity" && access.confidence === "medium"));
    assert.ok(result.metrics.runtime.resourceAccesses.some((access) =>
      access.detectedBy === "typeorm-adapter" && access.selector === "literal_repo" && access.confidence === "medium"));
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("resource access covers adapter-off branches and alternate framework shapes", () => {
  const disabledRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-resource-disabled-all-"));
  try {
    fs.mkdirSync(path.join(disabledRoot, "src/runtime"), { recursive: true });
    fs.writeFileSync(
      path.join(disabledRoot, "src/runtime/public.ts"),
      [
        "declare const prisma: { user: { findMany(): unknown } };",
        "import * as fs from 'node:fs';",
        "export function ignored(tableName: string): unknown {",
        "  fs.readFileSync(tableName);",
        "  return prisma.user.findMany();",
        "}",
        "",
      ].join("\n"),
    );
    writeJson(path.join(disabledRoot, "cellfence.manifest.json"), {
      schemaVersion: "cellfence.manifest.v1",
      governance: {
        resourceAdapters: {
          file: "off",
          http: "off",
          queue: "off",
          "sql-literal": "off",
          prisma: "off",
          typeorm: "off",
          drizzle: "off",
          "query-builder": "off",
          bullmq: "off",
          kafkajs: "off",
          nestjs: "off",
          fastify: "off",
        },
      },
      cells: [{
        id: "runtime",
        ownedPaths: ["src/runtime/**"],
        publicEntry: "src/runtime/public.ts",
        publicSymbols: ["ignored"],
        consumes: [],
        producesArtifacts: [],
      }],
    });

    const disabled = checkRepository({ rootDir: disabledRoot, manifestPath: "cellfence.manifest.json" });
    assert.equal(disabled.ok, true, JSON.stringify(disabled.findings));
    assert.deepEqual(disabled.metrics.runtime.resourceAccesses, []);
  } finally {
    fs.rmSync(disabledRoot, { recursive: true, force: true });
  }

  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-resource-alt-shapes-"));
  try {
    fs.mkdirSync(path.join(rootDir, "src/runtime"), { recursive: true });
    fs.mkdirSync(path.join(rootDir, "prisma"), { recursive: true });
    fs.writeFileSync(
      path.join(rootDir, "prisma/schema.prisma"),
      [
        "model Account {",
        "  id Int @id",
        "  @@map(\"app_accounts\")",
        "}",
        "model Post {",
        "  id Int @id",
        "}",
        "",
      ].join("\n"),
    );
    fs.writeFileSync(
      path.join(rootDir, "src/runtime/extra.ts"),
      [
        "declare const PrismaClient: new () => { account: { count(): unknown } };",
        "const cachedClient = new PrismaClient();",
        "export function cachedSchemaUse(): unknown {",
        "  return cachedClient.account.count();",
        "}",
        "",
      ].join("\n"),
    );
    fs.writeFileSync(
      path.join(rootDir, "src/runtime/public.ts"),
      [
        "declare const PrismaClient: new () => { account: { create(input: unknown): unknown, count(): unknown, unknownMethod(): unknown }, post: { findFirst(): unknown } };",
        "const dbClient = new PrismaClient();",
        "declare function pgTable(tableName: string): unknown;",
        "const users = pgTable('users');",
        "const ignoredTableFactory = (pgTable)('ignored');",
        "declare const db: { insert(table: unknown): unknown, update(table: unknown): unknown, delete(table: unknown): unknown };",
        "declare const tableName: unknown;",
        "declare function Entity(options?: unknown): ClassDecorator;",
        "@Entity()",
        "class PlainEntity {}",
        "declare function getRepository(entity: unknown): { save(input: unknown): unknown, find(): unknown };",
        "declare function createQueryBuilder(): { delete(): { from(table: unknown, alias?: string): unknown }, insert(): { into(table: unknown): unknown }, update(table: unknown): unknown };",
        "declare const queryDb: { selectFrom(table: unknown): unknown, insertInto(table: unknown): unknown, updateTable(table: unknown): unknown, deleteFrom(table: unknown): unknown };",
        "declare function Controller(path?: string): ClassDecorator;",
        "declare function Get(path?: string): MethodDecorator;",
        "declare function Other(): MethodDecorator;",
        "@Controller()",
        "class HealthController {",
        "  label = 'health';",
        "  @Get()",
        "  health(): void {}",
        "  @Get",
        "  undecoratedCall(): void {}",
        "  @Other()",
        "  ignored(): void {}",
        "}",
        "@Controller('/api')",
        "class ApiController {",
        "  @Get('/health')",
        "  health(): void {}",
        "}",
        "class PlainController {",
        "  @Get('/no-controller')",
        "  ignored(): void {}",
        "}",
        "declare const Queue: new (queueName: string) => { add(name: string, payload: unknown): void };",
        "declare const Worker: new (queueName: string, processor: unknown) => unknown;",
        "const jobs = new Queue('jobs');",
        "declare const server: { route(config: unknown): void };",
        "declare const config: unknown;",
        "declare const kafkaProducer: { send(config: unknown): void };",
        "declare const kafkaConsumer: { subscribe(config: unknown): void };",
        "declare const sqlClient: { query(sql: string): void };",
        "import * as fs from 'node:fs';",
        "declare const eventBus: { publish(topic: string): void, subscribe(topic: string): void, receiveMessage(queue: string): void };",
        "declare const fetch: (url: string) => unknown;",
        "declare const request: (url: string) => unknown;",
        "declare const get: (path: string) => unknown;",
        "export function runRuntime(filePath: string): void {",
        "  dbClient.account.create({});",
        "  dbClient.account.count();",
        "  dbClient.account.unknownMethod();",
        "  dbClient.post.findFirst();",
        "  getRepository(PlainEntity).save({});",
        "  getRepository('literal_repo').find();",
        "  createQueryBuilder().delete().from(PlainEntity);",
        "  createQueryBuilder().insert().into('audit_logs');",
        "  createQueryBuilder().update('audit_logs');",
        "  queryDb.selectFrom('audit_logs');",
        "  queryDb.selectFrom(filePath);",
        "  queryDb.insertInto('audit_logs');",
        "  queryDb.updateTable('audit_logs');",
        "  queryDb.deleteFrom('audit_logs');",
        "  server.route({ 'url': '/multi', 'method': ['get', 'post'] });",
        "  server.route({ ...config });",
        "  server.route({ 'url': '/partial', 'method': ['get', 1] });",
        "  db.insert(users);",
        "  db.update(users);",
        "  db.delete(users);",
        "  db.select.from(tableName);",
        "  fs.writeFile(filePath, '{}');",
        "  fs.readFile('data/input.json');",
        "  fs.readdirSync('data/list');",
        "  fs.createWriteStream('data/stream.json');",
        "  fetch('https://api.example.test/fetch');",
        "  request('https://api.example.test/v1');",
        "  get('/local');",
        "  jobs.add('run', {});",
        "  new Worker('jobs', () => undefined);",
        "  kafkaProducer.send({ topic: 'orders.created' });",
        "  kafkaConsumer.subscribe({ topic: 'orders.created' });",
        "  sqlClient.query('select * from app_users');",
        "  const dynamicSql = 'select * from ' + filePath;",
        "  sqlClient.query(dynamicSql);",
        "  eventBus.publish('domain.events');",
        "  eventBus.subscribe('domain.events');",
        "  eventBus.receiveMessage('domain.queue');",
        "}",
        "",
      ].join("\n"),
    );
    writeJson(path.join(rootDir, "cellfence.manifest.json"), {
      schemaVersion: "cellfence.manifest.v1",
      cells: [{
        id: "runtime",
        ownedPaths: ["src/runtime/**"],
        publicEntry: "src/runtime/public.ts",
        publicSymbols: ["runRuntime"],
        consumes: [],
        producesArtifacts: [],
        resourceContracts: [{
          id: "runtime-database",
          kind: "database",
          access: ["read", "write"],
          selectors: ["app_accounts", "Post", "PlainEntity", "literal_repo", "audit_logs", "users", "app_users", "unresolved:dynamic-sql", "unresolved:dynamic-drizzle-table", "unresolved:dynamic-query-builder-table"],
        }, {
          id: "runtime-http",
          kind: "http",
          access: ["call", "serve"],
          selectors: ["https://api.example.test/v1", "https://api.example.test/fetch", "GET /", "GET /api/health", "GET /local", "GET /multi", "GET /partial", "POST /multi"],
        }, {
          id: "runtime-file",
          kind: "file",
          access: ["read", "write"],
          selectors: ["unresolved:dynamic-file-path", "data/input.json", "data/list", "data/stream.json"],
        }, {
          id: "runtime-queue",
          kind: "queue",
          access: ["publish", "subscribe"],
          selectors: ["domain.events", "domain.queue", "bullmq:jobs", "kafka:orders.created"],
        }],
      }],
    });

    const result = checkRepository({ rootDir, manifestPath: "cellfence.manifest.json" });
    assert.equal(result.ok, true, JSON.stringify(result.findings));
    assert.ok(result.metrics.runtime.resourceAccesses.some((access) =>
      access.detectedBy === "prisma-adapter" && access.selector === "app_accounts" && access.access === "write"));
    assert.ok(result.metrics.runtime.resourceAccesses.some((access) =>
      access.detectedBy === "prisma-adapter" && access.selector === "app_accounts" && access.access === "read"));
    assert.ok(result.metrics.runtime.resourceAccesses.some((access) =>
      access.detectedBy === "typeorm-adapter" && access.selector === "PlainEntity" && access.access === "write"));
    assert.ok(result.metrics.runtime.resourceAccesses.some((access) =>
      access.detectedBy === "typeorm-adapter" && access.selector === "literal_repo" && access.access === "read"));
    assert.ok(result.metrics.runtime.resourceAccesses.some((access) =>
      access.detectedBy === "query-builder-adapter" && access.selector === "audit_logs" && access.access === "write"));
    assert.ok(result.metrics.runtime.resourceAccesses.some((access) =>
      access.detectedBy === "query-builder-adapter" && access.selector === "unresolved:dynamic-query-builder-table" && access.access === "read"));
    assert.ok(result.metrics.runtime.resourceAccesses.some((access) =>
      access.detectedBy === "drizzle-adapter" && access.selector === "users" && access.access === "write"));
    assert.ok(result.metrics.runtime.resourceAccesses.some((access) =>
      access.detectedBy === "drizzle-adapter" && access.selector === "unresolved:dynamic-drizzle-table" && access.access === "read"));
    assert.ok(result.metrics.runtime.resourceAccesses.some((access) =>
      access.detectedBy === "nestjs-adapter" && access.selector === "GET /"));
    assert.ok(result.metrics.runtime.resourceAccesses.some((access) =>
      access.detectedBy === "nestjs-adapter" && access.selector === "GET /api/health"));
    assert.ok(result.metrics.runtime.resourceAccesses.some((access) =>
      access.detectedBy === "fastify-adapter" && access.selector === "POST /multi"));
    assert.ok(result.metrics.runtime.resourceAccesses.some((access) =>
      access.detectedBy === "file-call" && access.selector === "unresolved:dynamic-file-path" && access.access === "write"));
    assert.ok(result.metrics.runtime.resourceAccesses.some((access) =>
      access.detectedBy === "bullmq-adapter" && access.selector === "bullmq:jobs" && access.access === "publish"));
    assert.ok(result.metrics.runtime.resourceAccesses.some((access) =>
      access.detectedBy === "kafkajs-adapter" && access.selector === "kafka:orders.created" && access.access === "subscribe"));
    assert.ok(result.metrics.runtime.resourceAccesses.some((access) =>
      access.detectedBy === "receiveMessage" && access.access === "subscribe"));
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});
