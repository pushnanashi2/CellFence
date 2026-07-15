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
  assert.deepEqual(noExtension.slice(9), [
    "dir/file/index.ts",
    "dir/file/index.tsx",
    "dir/file/index.js",
    "dir/file/index.jsx",
    "dir/file/index.mts",
    "dir/file/index.cts",
    "dir/file/index.mjs",
    "dir/file/index.cjs",
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
        "require('./ignored.js', name);",
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
        "const local = 1;",
        "export { local as exposed };",
        "export * as tools from './tools.js';",
        "export * from './tools.js';",
        "export default 1;",
        "",
      ].join("\n"),
    );
    assert.deepEqual([...extractPublicSymbols(publicPath)].sort(), [
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

test("module resolution public surface hash is a precise normalized contract digest", () => {
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
      "ClassDeclaration:Box:export class Box { value = 1; }",
      "EnumDeclaration:Rank:export enum Rank { One = 1 }",
      "ClassDeclaration:default:export default class DefaultBox {}",
      "export-star:./tools.js",
      "export:default",
      "export:exposed",
      "function:alpha(value:string,count:number):number",
      "function:inferred(value:):",
      "InterfaceDeclaration:Shape:export interface Shape { name: string; }",
      "namespace:tools",
      "TypeAliasDeclaration:Mode:export type Mode = \"a\" | \"b\";",
      "variable:version:string",
    ].sort((left, right) => left.localeCompare(right));
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
