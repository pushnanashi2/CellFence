import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import ts from "typescript";

import {
  candidateModulePaths,
  extractImports,
  extractPublicSymbols,
  getLineNumber,
  literalText,
  publicSurfaceHash,
  readPathAliases,
  resolvePathAliasTarget,
  resolvePythonImport,
  resolveRelativeImport,
} from "../packages/engine/dist/module-resolution.js";

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function context(rootDir) {
  return {
    rootDir,
    manifest: { schemaVersion: "cellfence.manifest.v1", cells: [] },
    sourceFilesForCellCache: new Map(),
    sourceTextCache: new Map(),
    sourceFileCache: new Map(),
  };
}

function sha256(text) {
  return crypto.createHash("sha256").update(text).digest("hex");
}

test("module resolution maps NodeNext runtime specifiers to source files", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-module-runtime-"));
  try {
    fs.mkdirSync(path.join(rootDir, "src/core"), { recursive: true });
    fs.writeFileSync(path.join(rootDir, "src/core/public.ts"), "export const core = true;\n");
    fs.writeFileSync(path.join(rootDir, "src/core/view.tsx"), "export const view = true;\n");
    fs.writeFileSync(path.join(rootDir, "src/core/mod.mts"), "export const mod = true;\n");
    fs.writeFileSync(path.join(rootDir, "src/core/legacy.cts"), "export const legacy = true;\n");
    fs.writeFileSync(path.join(rootDir, "src/app.ts"), "export const app = true;\n");

    assert.equal(resolveRelativeImport(rootDir, "src/app.ts", "./core/public.js"), "src/core/public.ts");
    assert.equal(resolveRelativeImport(rootDir, "src/app.ts", "./core/view.jsx"), "src/core/view.tsx");
    assert.equal(resolveRelativeImport(rootDir, "src/app.ts", "./core/mod.mjs"), "src/core/mod.mts");
    assert.equal(resolveRelativeImport(rootDir, "src/app.ts", "./core/legacy.cjs"), "src/core/legacy.cts");
    assert.ok(candidateModulePaths(path.join(rootDir, "src/core/public.js")).some((candidate) => candidate.endsWith("public.ts")));
    assert.equal(resolveRelativeImport(rootDir, "src/app.ts", "./core/missing.js"), undefined);
    assert.equal(resolveRelativeImport(rootDir, "src/app.ts", "./core"), undefined);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("module resolution candidate paths preserve runtime and source extension order", () => {
  const root = path.join(os.tmpdir(), "cellfence-candidates");
  assert.deepEqual(candidateModulePaths(path.join(root, "file.js")).map((candidate) => candidate.slice(root.length + 1)), [
    "file.js",
    "file.ts",
    "file.tsx",
    "file.jsx",
  ]);
  assert.deepEqual(candidateModulePaths(path.join(root, "file.jsx")).map((candidate) => candidate.slice(root.length + 1)), [
    "file.jsx",
    "file.tsx",
  ]);
  assert.deepEqual(candidateModulePaths(path.join(root, "file.mjs")).map((candidate) => candidate.slice(root.length + 1)), [
    "file.mjs",
    "file.mts",
  ]);
  assert.deepEqual(candidateModulePaths(path.join(root, "file.cjs")).map((candidate) => candidate.slice(root.length + 1)), [
    "file.cjs",
    "file.cts",
  ]);
  assert.deepEqual(candidateModulePaths(path.join(root, "file.json")).map((candidate) => candidate.slice(root.length + 1)), [
    "file.json",
  ]);
  const noExtension = candidateModulePaths(path.join(root, "dir/file")).map((candidate) => candidate.slice(root.length + 1));
  assert.deepEqual(noExtension.slice(0, 9), [
    "dir/file",
    "dir/file.ts",
    "dir/file.tsx",
    "dir/file.js",
    "dir/file.jsx",
    "dir/file.mts",
    "dir/file.cts",
    "dir/file.mjs",
    "dir/file.cjs",
  ]);
  assert.deepEqual(noExtension.slice(9, 10), [
    "dir/file.py",
  ]);
  assert.deepEqual(noExtension.slice(10), [
    "dir/file/index.ts",
    "dir/file/index.tsx",
    "dir/file/index.js",
    "dir/file/index.jsx",
    "dir/file/index.mts",
    "dir/file/index.cts",
    "dir/file/index.mjs",
    "dir/file/index.cjs",
    "dir/file/index.py",
  ]);
});

test("module resolution follows tsconfig extends path aliases", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-module-alias-"));
  try {
    fs.mkdirSync(path.join(rootDir, "src/core"), { recursive: true });
    fs.writeFileSync(path.join(rootDir, "src/core/public.ts"), "export const core = true;\n");
    writeJson(path.join(rootDir, "tsconfig.json"), { extends: "./tsconfig.base.json" });
    writeJson(path.join(rootDir, "tsconfig.base.json"), {
      compilerOptions: {
        baseUrl: ".",
        paths: { "@core/*": ["src/core/*"] },
      },
    });
    const aliases = readPathAliases(rootDir);
    assert.deepEqual(aliases, [{ pattern: "@core/*", targets: [path.join(rootDir, "src/core/*").split(path.sep).join("/")] }]);
    assert.equal(resolvePathAliasTarget({ pathAliases: aliases }, "@core/public.js"), path.join(rootDir, "src/core/public.ts").split(path.sep).join("/"));
    assert.equal(resolvePathAliasTarget({ rootDir, pathAliases: aliases }, "@core/public.js"), "src/core/public.ts");
    assert.equal(resolvePathAliasTarget({ rootDir, pathAliases: aliases }, "@core/missing.js"), undefined);
    assert.equal(resolvePathAliasTarget({ rootDir, pathAliases: aliases }, "@other/public.js"), undefined);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("module resolution reads alias edge cases without widening invalid config", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-module-alias-edge-"));
  try {
    assert.deepEqual(readPathAliases(rootDir), []);
    fs.writeFileSync(path.join(rootDir, "tsconfig.json"), "{");
    assert.deepEqual(readPathAliases(rootDir), []);
    writeJson(path.join(rootDir, "tsconfig.json"), { compilerOptions: {} });
    assert.deepEqual(readPathAliases(rootDir), []);
    fs.mkdirSync(path.join(rootDir, "packages/core/src"), { recursive: true });
    fs.mkdirSync(path.join(rootDir, "packages/features/core"), { recursive: true });
    fs.writeFileSync(path.join(rootDir, "packages/core/src/index.ts"), "export const core = true;\n");
    fs.writeFileSync(path.join(rootDir, "packages/features/core/index.ts"), "export const feature = true;\n");
    writeJson(path.join(rootDir, "tsconfig.json"), {
      compilerOptions: {
        baseUrl: "packages",
        paths: {
          "@empty/*": ["   "],
          "@core": ["core/src/index"],
          "@core/*": ["core/src/*"],
          "@feature/*/public": ["features/*/index"],
        },
      },
    });
    const aliases = readPathAliases(rootDir);
    assert.deepEqual(aliases.map((alias) => alias.pattern), ["@core", "@core/*", "@feature/*/public"]);
    assert.equal(resolvePathAliasTarget({ rootDir, pathAliases: aliases }, "@core"), "packages/core/src/index.ts");
    assert.equal(resolvePathAliasTarget({ rootDir, pathAliases: aliases }, "@core/index.js"), "packages/core/src/index.ts");
    assert.equal(resolvePathAliasTarget({ rootDir, pathAliases: aliases }, "@feature/core/public"), "packages/features/core/index.ts");
    assert.equal(resolvePathAliasTarget({ rootDir, pathAliases: aliases }, "@feature/core/private"), undefined);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("module resolution extracts imports and reports computed module loading", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-module-imports-"));
  try {
    fs.mkdirSync(path.join(rootDir, "src"), { recursive: true });
    const filePath = path.join(rootDir, "src/app.ts");
    fs.writeFileSync(
      filePath,
      [
        "import type { A } from './a.js';",
        "import './side-effect.js';",
        "export type { B } from './b.js';",
        "const name = './c.js';",
        "require('./d.js');",
        "require('./extra-arg.js', name);",
        "require(name);",
        "import('./e.js');",
        "import(name);",
        "",
      ].join("\n"),
    );
    const warnings = [];
    const references = extractImports(context(rootDir), filePath, warnings);
    assert.deepEqual(references.map((reference) => [reference.kind, reference.specifier, reference.typeOnly]), [
      ["import", "./a.js", true],
      ["import", "./side-effect.js", false],
      ["export-from", "./b.js", true],
      ["require", "./d.js", false],
      ["require", "./extra-arg.js", false],
      ["dynamic-import", "./e.js", false],
    ]);
    assert.deepEqual(warnings.map((warning) => warning.ruleId), [
      "CELLFENCE_UNSUPPORTED_DYNAMIC_REQUIRE",
      "CELLFENCE_UNSUPPORTED_DYNAMIC_IMPORT",
    ]);
    assert.deepEqual(warnings, [
      {
        ruleId: "CELLFENCE_UNSUPPORTED_DYNAMIC_REQUIRE",
        severity: "warning",
        filePath: "src/app.ts",
        message: "computed require() cannot be resolved statically at line 7",
        details: { line: 7 },
      },
      {
        ruleId: "CELLFENCE_UNSUPPORTED_DYNAMIC_IMPORT",
        severity: "warning",
        filePath: "src/app.ts",
        message: "computed dynamic import cannot be resolved statically at line 9",
        details: { line: 9 },
      },
    ]);
    fs.writeFileSync(path.join(rootDir, "src/no-imports.ts"), "const value = 1;\n");
    assert.deepEqual(extractImports(context(rootDir), path.join(rootDir, "src/no-imports.ts"), []), []);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("module resolution extracts TypeScript CommonJS compatibility forms", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-module-commonjs-forms-"));
  try {
    fs.mkdirSync(path.join(rootDir, "src"), { recursive: true });
    const filePath = path.join(rootDir, "src/app.ts");
    fs.writeFileSync(
      filePath,
      [
        "import { createRequire as makeRequire } from 'node:module';",
        "import legacy = require('./legacy.js');",
        "const req = require;",
        "const localRequire = makeRequire(import.meta.url);",
        "module.require('./module-require.js');",
        "req('./alias-require.js');",
        "localRequire('./created-require.js');",
        "const target = './dynamic.js';",
        "req(target);",
        "const loader = { require }; loader.require('./not-commonjs.js');",
        "const { createRequire: makeRequireFromCjs } = require('module');",
        "const moduleRequire = module.require;",
        "const nodeModule = require('node:module');",
        "const namespaceCreateRequire = nodeModule.createRequire;",
        "const cjsRequire = makeRequireFromCjs(__filename);",
        "const namespaceRequire = namespaceCreateRequire(__filename);",
        "moduleRequire('./module-alias.js');",
        "cjsRequire('./cjs-created.js');",
        "namespaceRequire('./namespace-created.js');",
        "(require)('./paren-require.js');",
        "(0, require)('./comma-require.js');",
        "require.call(null, './call-require.js');",
        "require.apply(null, ['./apply-require.js']);",
        "Reflect.apply(require, null, ['./reflect-apply-require.js']);",
        "const boundRequire = require.bind(null);",
        "boundRequire('./bound-require.js');",
        "module['require']('./element-module-require.js');",
        "const moduleAlias = module;",
        "moduleAlias.require('./module-object-alias.js');",
        "const { require: destructuredRequire } = module;",
        "destructuredRequire('./destructured-module-require.js');",
        "import Module from 'node:module';",
        "const defaultRequire = Module.createRequire(import.meta.url);",
        "defaultRequire('./default-create-require.js');",
        "const inlineRequire = require('node:module').createRequire(__filename);",
        "inlineRequire('./inline-create-require.js');",
        "const commaCreateRequire = (0, makeRequire)(import.meta.url);",
        "commaCreateRequire('./comma-create-require.js');",
        "globalThis.require('./global-require.js');",
        "global.require('./node-global-require.js');",
        "global['require']('./node-global-element-require.js');",
        "this.require('./top-level-this-require.js');",
        "const globalRequire = global.require;",
        "globalRequire('./global-alias-require.js');",
        "process.mainModule.require('./process-main-module-require.js');",
        "module.constructor._load('./module-constructor-load.js');",
        "export const app = legacy;",
        "",
      ].join("\n"),
    );

    const warnings = [];
    const references = extractImports(context(rootDir), filePath, warnings);

    assert.deepEqual(references.map((reference) => [reference.kind, reference.specifier, reference.typeOnly]), [
      ["import", "node:module", false],
      ["require", "./legacy.js", false],
      ["require", "./module-require.js", false],
      ["require", "./alias-require.js", false],
      ["require", "./created-require.js", false],
      ["require", "module", false],
      ["require", "node:module", false],
      ["require", "./module-alias.js", false],
      ["require", "./cjs-created.js", false],
      ["require", "./namespace-created.js", false],
      ["require", "./paren-require.js", false],
      ["require", "./comma-require.js", false],
      ["require", "./call-require.js", false],
      ["require", "./apply-require.js", false],
      ["require", "./reflect-apply-require.js", false],
      ["require", "./bound-require.js", false],
      ["require", "./element-module-require.js", false],
      ["require", "./module-object-alias.js", false],
      ["require", "./destructured-module-require.js", false],
      ["import", "node:module", false],
      ["require", "./default-create-require.js", false],
      ["require", "node:module", false],
      ["require", "./inline-create-require.js", false],
      ["require", "./comma-create-require.js", false],
      ["require", "./global-require.js", false],
      ["require", "./node-global-require.js", false],
      ["require", "./node-global-element-require.js", false],
      ["require", "./top-level-this-require.js", false],
      ["require", "./global-alias-require.js", false],
      ["require", "./process-main-module-require.js", false],
      ["require", "./module-constructor-load.js", false],
    ]);
    assert.deepEqual(warnings, [{
      ruleId: "CELLFENCE_UNSUPPORTED_DYNAMIC_REQUIRE",
      severity: "warning",
      filePath: "src/app.ts",
      message: "computed req() cannot be resolved statically at line 9",
      details: { line: 9 },
    }]);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("module resolution fails closed for string execution require forms", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-module-string-exec-"));
  try {
    fs.mkdirSync(path.join(rootDir, "src"), { recursive: true });
    const filePath = path.join(rootDir, "src/app.ts");
    fs.writeFileSync(
      filePath,
      [
        "const code = \"require('./computed.js')\";",
        "eval(\"require('./eval.js')\");",
        "Function(\"return require('./function.js')\")();",
        "eval(code);",
        "",
      ].join("\n"),
    );

    const warnings = [];
    const references = extractImports(context(rootDir), filePath, warnings);

    assert.deepEqual(references.map((reference) => [reference.kind, reference.specifier, reference.line]), [
      ["require", "./eval.js", 2],
      ["require", "./function.js", 3],
    ]);
    assert.deepEqual(warnings, [{
      ruleId: "CELLFENCE_UNSUPPORTED_DYNAMIC_REQUIRE",
      severity: "warning",
      filePath: "src/app.ts",
      message: "computed eval() source cannot be resolved statically at line 4",
      details: { line: 4 },
    }]);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("module resolution tracks CommonJS aliases without crossing shadowed scopes", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-module-commonjs-scope-"));
  try {
    fs.mkdirSync(path.join(rootDir, "src"), { recursive: true });
    const filePath = path.join(rootDir, "src/app.ts");
    fs.writeFileSync(
      filePath,
      [
        "const req = require;",
        "req('./top-level.js');",
        "function usesOuter() {",
        "  req('./outer-alias.js');",
        "}",
        "function shadowsParam(req: (value: string) => unknown) {",
        "  req('./not-require-param.js');",
        "}",
        "function shadowsLocal() {",
        "  const req = (value: string) => value;",
        "  req('./not-require-local.js');",
        "}",
        "{",
        "  const module = { require(value: string) { return value; } };",
        "  module.require('./not-node-module.js');",
        "}",
        "module.require('./node-module.js');",
        "",
      ].join("\n"),
    );

    const warnings = [];
    const references = extractImports(context(rootDir), filePath, warnings);

    assert.deepEqual(references.map((reference) => [reference.kind, reference.specifier, reference.line]), [
      ["require", "./top-level.js", 2],
      ["require", "./outer-alias.js", 4],
      ["require", "./node-module.js", 17],
    ]);
    assert.deepEqual(warnings, []);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("module resolution extracts TypeScript import type nodes", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-module-import-type-node-"));
  try {
    fs.mkdirSync(path.join(rootDir, "src"), { recursive: true });
    const filePath = path.join(rootDir, "src/app.ts");
    fs.writeFileSync(
      filePath,
      [
        "type Secret = import('./internal.js').Secret;",
        "export const app: Secret = { ok: true };",
        "",
      ].join("\n"),
    );

    const references = extractImports(context(rootDir), filePath, []);
    assert.deepEqual(references.map((reference) => [reference.kind, reference.specifier, reference.typeOnly, reference.line]), [
      ["import", "./internal.js", true, 1],
    ]);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("module resolution reports invalid TypeScript syntax as fail-closed analysis input", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-module-invalid-ts-"));
  try {
    fs.mkdirSync(path.join(rootDir, "src"), { recursive: true });
    const filePath = path.join(rootDir, "src/broken.ts");
    fs.writeFileSync(filePath, "const broken = ;\n");

    const warnings = [];
    assert.deepEqual(extractImports(context(rootDir), filePath, warnings), []);
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0].ruleId, "CELLFENCE_UNSUPPORTED_TYPESCRIPT_SYNTAX");
    assert.equal(warnings[0].filePath, "src/broken.ts");
    assert.equal(warnings[0].details.line, 1);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("module resolution extracts and resolves Python imports", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-python-imports-"));
  try {
    fs.mkdirSync(path.join(rootDir, "src/producer"), { recursive: true });
    fs.mkdirSync(path.join(rootDir, "src/consumer"), { recursive: true });
    fs.writeFileSync(path.join(rootDir, "src/producer/public.py"), "__all__ = ['exposed']\nfrom .internal import exposed\n");
    fs.writeFileSync(path.join(rootDir, "src/producer/internal.py"), "def exposed():\n    return True\n");
    const consumerPath = path.join(rootDir, "src/consumer/public.py");
    fs.writeFileSync(
      consumerPath,
      [
        "from producer.internal import exposed as _hidden",
        "from .helpers import local_helper",
        "import producer.public as producer_public",
        "def used():",
        "    return _hidden()",
        "",
      ].join("\n"),
    );
    fs.writeFileSync(path.join(rootDir, "src/consumer/helpers.py"), "def local_helper():\n    return True\n");

    const references = extractImports(context(rootDir), consumerPath, []);
    assert.deepEqual(references.map((reference) => [reference.specifier, reference.line]), [
      ["producer.internal", 1],
      [".helpers", 2],
      ["producer.public", 3],
    ]);
    assert.equal(resolvePythonImport(rootDir, "src/consumer/public.py", "producer.internal", ["src"]), "src/producer/internal.py");
    assert.equal(resolvePythonImport(rootDir, "src/consumer/public.py", ".helpers", ["src"]), "src/consumer/helpers.py");
    assert.equal(resolvePythonImport(rootDir, "src/consumer/public.py", "external.package", ["src"]), undefined);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("module resolution extracts Python submodule from-imports and literal dynamic imports", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-python-submodule-imports-"));
  try {
    fs.mkdirSync(path.join(rootDir, "src/producer"), { recursive: true });
    fs.mkdirSync(path.join(rootDir, "src/consumer"), { recursive: true });
    fs.writeFileSync(path.join(rootDir, "src/producer/__init__.py"), "");
    fs.writeFileSync(path.join(rootDir, "src/producer/internal.py"), "def hidden():\n    return True\n");
    const consumerPath = path.join(rootDir, "src/consumer/public.py");
    fs.writeFileSync(
      consumerPath,
      [
        "from producer import internal as _internal",
        "import importlib as _importlib",
        "import builtins",
        "from pkgutil import resolve_name",
        "mod = _importlib.import_module('producer.internal')",
        "also = __import__('producer.internal', fromlist=['hidden'])",
        "again = builtins.__import__('producer.internal')",
        "resolved = resolve_name('producer.internal:hidden')",
        "load = _importlib.import_module",
        "via_getattr = getattr(_importlib, 'import_module')",
        "loaded = load('producer.internal')",
        "got = getattr(_importlib, 'import_module')('producer.internal')",
        "again = via_getattr('producer.internal')",
        "evaluated = eval(\"__import__('producer.internal')\")",
        "exec(\"__import__('producer.internal')\")",
        "",
      ].join("\n"),
    );

    const warnings = [];
    const references = extractImports(context(rootDir), consumerPath, warnings);
    assert.deepEqual(references.map((reference) => [reference.specifier, reference.candidateSpecifiers, reference.line]), [
      ["producer", ["producer.internal"], 1],
      ["importlib", undefined, 2],
      ["builtins", undefined, 3],
      ["pkgutil", ["pkgutil.resolve_name"], 4],
      ["producer.internal", undefined, 5],
      ["producer.internal", undefined, 6],
      ["producer.internal", undefined, 7],
      ["producer.internal", undefined, 8],
      ["producer.internal", undefined, 11],
      ["producer.internal", undefined, 12],
      ["producer.internal", undefined, 13],
      ["producer.internal", undefined, 14],
      ["producer.internal", undefined, 15],
    ]);
    assert.deepEqual(warnings, []);
    assert.equal(resolvePythonImport(rootDir, "src/consumer/public.py", references[0].candidateSpecifiers[0], ["src"]), "src/producer/internal.py");
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("module resolution reports computed Python dynamic imports", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-python-dynamic-imports-"));
  try {
    fs.mkdirSync(path.join(rootDir, "src/app"), { recursive: true });
    const filePath = path.join(rootDir, "src/app/public.py");
    fs.writeFileSync(
      filePath,
      [
        "import importlib",
        "target = 'producer.internal'",
        "mod = importlib.import_module(target)",
        "exec(target)",
        "",
      ].join("\n"),
    );

    const warnings = [];
    const references = extractImports(context(rootDir), filePath, warnings);
    assert.deepEqual(references.map((reference) => reference.specifier), ["importlib"]);
    assert.deepEqual(warnings.map((warning) => warning.ruleId), [
      "CELLFENCE_UNSUPPORTED_DYNAMIC_IMPORT",
      "CELLFENCE_UNSUPPORTED_DYNAMIC_IMPORT",
    ]);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("module resolution uses Python AST for multiline imports and __all__", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-python-ast-"));
  try {
    fs.mkdirSync(path.join(rootDir, "src/producer"), { recursive: true });
    fs.mkdirSync(path.join(rootDir, "src/consumer"), { recursive: true });
    fs.writeFileSync(path.join(rootDir, "src/producer/internal.py"), "def hidden():\n    return True\n");
    const consumerPath = path.join(rootDir, "src/consumer/public.py");
    fs.writeFileSync(
      consumerPath,
      [
        "from producer.internal import (",
        "    hidden as _hidden,",
        ")",
        "__all__ = [",
        "    'Client',",
        "    'run',",
        "]",
        "class Client:",
        "    pass",
        "def run(value):",
        "    return value",
        "",
      ].join("\n"),
    );

    const references = extractImports(context(rootDir), consumerPath, []);
    assert.deepEqual(references.map((reference) => [reference.specifier, reference.line]), [
      ["producer.internal", 1],
    ]);
    assert.deepEqual([...extractPublicSymbols(consumerPath)].sort(), ["Client", "run"]);
    const firstHash = publicSurfaceHash(consumerPath);
    fs.writeFileSync(
      consumerPath,
      [
        "from producer.internal import (",
        "    hidden as _hidden,",
        ")",
        "__all__ = [",
        "    'Client',",
        "    'run',",
        "    'Mode',",
        "]",
        "class Client:",
        "    pass",
        "def run(value):",
        "    return value",
        "",
      ].join("\n"),
    );
    assert.notEqual(publicSurfaceHash(consumerPath), firstHash);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("module resolution reports unsupported Python syntax without throwing", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-python-unsupported-syntax-"));
  try {
    fs.mkdirSync(path.join(rootDir, "src/core"), { recursive: true });
    const filePath = path.join(rootDir, "src/core/template.py");
    fs.writeFileSync(filePath, "def get_{{ cookiecutter.name }}():\n    return True\n");

    const warnings = [];
    assert.deepEqual(extractImports(context(rootDir), filePath, warnings), []);
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0].ruleId, "CELLFENCE_UNSUPPORTED_PYTHON_SYNTAX");
    assert.equal(warnings[0].severity, "warning");
    assert.equal(warnings[0].filePath, "src/core/template.py");
    assert.equal(warnings[0].details.kind, "syntax_error");
    assert.equal(warnings[0].details.line, 1);
    assert.deepEqual([...extractPublicSymbols(filePath)], []);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("module resolution exposes literal and line helpers exactly", () => {
  const sourceFile = ts.createSourceFile(
    "sample.ts",
    "\nconst text = `hello`;\nconst plain = 'world';\nconst numeric = 1;\n",
    ts.ScriptTarget.Latest,
    true,
  );
  const statements = sourceFile.statements;
  const templateDeclaration = statements[0].declarationList.declarations[0];
  const stringDeclaration = statements[1].declarationList.declarations[0];
  const numericDeclaration = statements[2].declarationList.declarations[0];
  assert.equal(getLineNumber(sourceFile, statements[0]), 2);
  assert.equal(literalText(undefined), undefined);
  assert.equal(literalText(templateDeclaration.initializer), "hello");
  assert.equal(literalText(stringDeclaration.initializer), "world");
  assert.equal(literalText(numericDeclaration.initializer), undefined);
});

test("module resolution public symbols and signature hashes react to exported contracts", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-module-public-"));
  try {
    fs.mkdirSync(path.join(rootDir, "src/core"), { recursive: true });
    const publicPath = path.join(rootDir, "src/core/public.ts");
    fs.writeFileSync(path.join(rootDir, "src/core/tools.ts"), "export interface Tool { name: string }\nexport const helper = true;\n");
    fs.writeFileSync(
      publicPath,
      [
        "export default function run(value: string): string { return value; }",
        "export * as tools from './tools.js';",
        "export * from './tools.js';",
        "",
      ].join("\n"),
    );
    const symbols = extractPublicSymbols(publicPath);
    assert.equal(symbols.has("default"), true);
    assert.equal(symbols.has("tools"), true);
    assert.equal(symbols.has("Tool"), true);
    assert.equal(symbols.has("helper"), true);

    const firstHash = publicSurfaceHash(publicPath);
    fs.writeFileSync(
      publicPath,
      [
        "export default function run(value: string, mode?: string): string { return value + (mode || ''); }",
        "export * as tools from './tools.js';",
        "export * from './tools.js';",
        "",
      ].join("\n"),
    );
    assert.notEqual(publicSurfaceHash(publicPath), firstHash);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("module resolution extracts Python public symbols and surface hashes", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-python-public-"));
  try {
    fs.mkdirSync(path.join(rootDir, "src/core"), { recursive: true });
    const allPath = path.join(rootDir, "src/core/public.py");
    fs.writeFileSync(allPath, "__all__ = ['run', 'Box']\nfrom .impl import run, Box, hidden\n");
    assert.deepEqual([...extractPublicSymbols(allPath)].sort(), ["Box", "run"]);
    const allHash = publicSurfaceHash(allPath);
    fs.writeFileSync(allPath, "__all__ = ['run', 'Box', 'Mode']\nfrom .impl import run, Box, Mode\n");
    assert.notEqual(publicSurfaceHash(allPath), allHash);

    const inferredPath = path.join(rootDir, "src/core/inferred.py");
    fs.writeFileSync(
      inferredPath,
      [
        "from .impl import helper as public_helper, hidden as _hidden",
        "VERSION: str = '1'",
        "_private = True",
        "async def fetch(value, limit=1):",
        "    return value",
        "def run(value):",
        "    return value",
        "class Box(Base):",
        "    pass",
        "",
      ].join("\n"),
    );
    assert.deepEqual([...extractPublicSymbols(inferredPath)].sort(), ["Box", "VERSION", "fetch", "public_helper", "run"]);
    const expectedParts = [
      "py:class:Box(Base)",
      "py:function:fetch(value,limit=1)",
      "py:function:run(value)",
      "py:import:public_helper",
      "py:variable:VERSION:str",
    ].sort((left, right) => left.localeCompare(right));
    assert.equal(publicSurfaceHash(inferredPath), sha256(expectedParts.join("\n")));
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("module resolution public symbols cover declarations, aliases, defaults, cycles, and star defaults", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-module-symbols-"));
  try {
    fs.mkdirSync(path.join(rootDir, "src/core"), { recursive: true });
    const publicPath = path.join(rootDir, "src/core/public.ts");
    fs.writeFileSync(
      path.join(rootDir, "src/core/tools.ts"),
      [
        "export default function hiddenDefault() { return 1; }",
        "export class ToolClass {}",
        "export interface ToolShape { ok: boolean }",
        "export type ToolMode = 'on';",
        "export enum ToolRank { One = 1 }",
        "export const helper = true;",
        "export * from './cycle.js';",
        "",
      ].join("\n"),
    );
    fs.writeFileSync(path.join(rootDir, "src/core/cycle.ts"), "export * from './tools.js';\n");
    fs.writeFileSync(
      publicPath,
      [
        "export function run(): void {}",
        "export class Box {}",
        "export interface Shape { name: string }",
        "export type Mode = 'a';",
        "export enum Rank { One = 1 }",
        "export const value = 1;",
        "export namespace API { export const flag = true; }",
        "const local = 1;",
        "export { local as exposed };",
        "export * as tools from './tools.js';",
        "export * from './tools.js';",
        "export default 1;",
        "",
      ].join("\n"),
    );
    assert.deepEqual([...extractPublicSymbols(publicPath)].sort(), [
      "API",
      "Box",
      "Mode",
      "Rank",
      "Shape",
      "ToolClass",
      "ToolMode",
      "ToolRank",
      "ToolShape",
      "default",
      "exposed",
      "helper",
      "run",
      "tools",
      "value",
    ]);

    const externalPath = path.join(rootDir, "src/core/external.ts");
    fs.writeFileSync(externalPath, "export const shouldStayPrivate = true;\n");
    const packageOnlyPath = path.join(rootDir, "src/core/package-only.ts");
    fs.writeFileSync(packageOnlyPath, "export * from 'external';\n");
    assert.deepEqual([...extractPublicSymbols(packageOnlyPath)], []);

    const starDefaultOnlyPath = path.join(rootDir, "src/core/star-default-only.ts");
    fs.writeFileSync(starDefaultOnlyPath, "export * from './tools.js';\n");
    const starDefaultSymbols = extractPublicSymbols(starDefaultOnlyPath);
    assert.equal(starDefaultSymbols.has("default"), false);
    assert.equal(starDefaultSymbols.has("ToolClass"), true);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("module resolution ignores invalid nameless non-default exports defensively", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-module-invalid-export-"));
  try {
    fs.mkdirSync(path.join(rootDir, "src/core"), { recursive: true });
    const publicPath = path.join(rootDir, "src/core/public.ts");
    fs.writeFileSync(publicPath, "export function () { return 1; }\nexport const valid = true;\n");
    assert.deepEqual([...extractPublicSymbols(publicPath)], ["valid"]);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("module resolution public surface hash is a declaration-emit contract digest", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-module-surface-hash-"));
  try {
    fs.mkdirSync(path.join(rootDir, "src/core"), { recursive: true });
    const publicPath = path.join(rootDir, "src/core/public.ts");
    fs.writeFileSync(
      publicPath,
      [
        "export function alpha(value: string, count: number): number { return value.length + count; }",
        "export function inferred(value) { return value; }",
        "export default class DefaultBox {}",
        "export class Box { value = 1; }",
        "export interface Shape {\n  name:  string;\n}",
        "export type Mode = \"a\" | \"b\";",
        "export enum Rank { One = 1 }",
        "export const version: string = \"1\";",
        "const local = 1;",
        "export { local as exposed };",
        "export * as tools from \"./tools.js\";",
        "export * from \"./tools.js\";",
        "export default 1;",
        "",
      ].join("\n"),
    );
    const expectedParts = [
      [
        "dts:export declare function alpha(value: string, count: number): number;",
        "export declare function inferred(value: any): any;",
        "export default class DefaultBox {",
        "}",
        "export declare class Box {",
        "value: number;",
        "}",
        "export interface Shape {",
        "name: string;",
        "}",
        "export type Mode = \"a\" | \"b\";",
        "export declare enum Rank {",
        "One = 1",
        "}",
        "export declare const version: string;",
        "declare const local = 1;",
        "export { local as exposed };",
        "export * as tools from \"./tools.js\";",
        "export * from \"./tools.js\";",
        "declare const _default: 1;",
        "export default _default;",
      ].join("\n"),
    ];
    assert.equal(publicSurfaceHash(publicPath), sha256(expectedParts.join("\n")));
    assert.equal(publicSurfaceHash(path.join(rootDir, "src/core/missing.ts")), sha256(""));

    fs.writeFileSync(
      publicPath,
      [
        "export function alpha(value: string, count: number, mode: Mode): number { return value.length + count; }",
        "export function inferred(value) { return value; }",
        "export default class DefaultBox {}",
        "export class Box { value = 1; }",
        "export interface Shape { name:  string; }",
        "export type Mode = \"a\" | \"b\";",
        "export enum Rank { One = 1 }",
        "export const version: string = \"1\";",
        "const local = 1;",
        "export { local as exposed };",
        "export * as tools from \"./tools.js\";",
        "export * from \"./tools.js\";",
        "export default 1;",
        "",
      ].join("\n"),
    );
    assert.notEqual(publicSurfaceHash(publicPath), sha256(expectedParts.join("\n")));
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("module resolution declaration surface hash follows API types without class body churn", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-module-surface-types-"));
  try {
    fs.mkdirSync(path.join(rootDir, "src/core"), { recursive: true });
    const publicPath = path.join(rootDir, "src/core/public.ts");
    const writeSurface = ({ methodBody = "return 1", inferredReturn = "return 1", genericConstraint = "string", answer = "42" } = {}) => {
      fs.writeFileSync(
        publicPath,
        [
          `export function generic<T extends ${genericConstraint}>(value: T): T { return value; }`,
          `export function inferred() { ${inferredReturn}; }`,
          `export const answer = ${answer};`,
          `export class Box { method(): number { ${methodBody}; } }`,
          "export namespace API { export const flag = true; }",
          "",
        ].join("\n"),
      );
    };

    writeSurface();
    assert.deepEqual([...extractPublicSymbols(publicPath)].sort(), ["API", "Box", "answer", "generic", "inferred"]);
    const firstHash = publicSurfaceHash(publicPath);

    writeSurface({ methodBody: "return 2" });
    assert.equal(publicSurfaceHash(publicPath), firstHash);

    writeSurface({ inferredReturn: "return 'one'" });
    assert.notEqual(publicSurfaceHash(publicPath), firstHash);

    writeSurface({ genericConstraint: "number" });
    assert.notEqual(publicSurfaceHash(publicPath), firstHash);

    writeSurface({ answer: "'42'" });
    assert.notEqual(publicSurfaceHash(publicPath), firstHash);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("module resolution declaration surface hash follows alias and package self re-exports", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-module-surface-project-resolve-"));
  try {
    fs.mkdirSync(path.join(rootDir, "src/core"), { recursive: true });
    writeJson(path.join(rootDir, "package.json"), { name: "@example/core" });
    writeJson(path.join(rootDir, "tsconfig.json"), {
      compilerOptions: {
        baseUrl: ".",
        paths: { "@core/*": ["src/core/*"] },
      },
    });
    const publicPath = path.join(rootDir, "src/core/public.ts");
    const toolsPath = path.join(rootDir, "src/core/tools.ts");
    const internalPath = path.join(rootDir, "src/core/internal.ts");
    fs.writeFileSync(publicPath, [
      "import type { Internal } from './internal.js';",
      "export type PublicAlias = Internal;",
      "export { Tool } from '@core/tools';",
      "export { SelfTool } from '@example/core/tools';",
      "",
    ].join("\n"));
    fs.writeFileSync(toolsPath, "export type Tool = { value: number };\nexport type SelfTool = { value: number };\n");
    fs.writeFileSync(internalPath, "export type Internal = { id: string };\n");
    const firstHash = publicSurfaceHash(publicPath);

    fs.writeFileSync(internalPath, "export type Internal = { id: number };\n");
    assert.notEqual(publicSurfaceHash(publicPath), firstHash);

    const secondHash = publicSurfaceHash(publicPath);
    fs.writeFileSync(toolsPath, "export type Tool = { value: string };\nexport type SelfTool = { value: string };\n");
    assert.notEqual(publicSurfaceHash(publicPath), secondHash);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});
