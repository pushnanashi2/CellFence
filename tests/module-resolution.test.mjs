import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import ts from "typescript";

import {
  candidateModulePaths,
  collectPublicDeclarationRoots,
  declarationEmitCompilerOptions,
  declarationPublicSurfaceSignatureParts,
  declarationTextForRoot,
  extractImports,
  extractPublicSymbols,
  getLineNumber,
  literalText,
  publicSurfaceHash,
  readPathAliases,
  readWorkspacePathAliases,
  resolveNearestPathAliasTarget,
  resolvePackageExportTarget,
  resolvePackageImportsTarget,
  resolvePathAliasTarget,
  resolvePythonImport,
  resolveRelativeImport,
  syntaxPublicSurfaceSignatureParts,
} from "../packages/engine/dist/module-resolution.js";
import { inspectPythonSource } from "../packages/engine/dist/python-analysis.js";

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

function packageFreeTempRoot(prefix) {
  const candidateRoot = process.platform === "win32" ? os.tmpdir() : "/var/tmp";
  const rootParent = fs.existsSync(candidateRoot) ? candidateRoot : os.tmpdir();
  return fs.mkdtempSync(path.join(rootParent, prefix));
}

test("module resolution maps NodeNext runtime specifiers to source files", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-module-runtime-"));
  try {
    fs.mkdirSync(path.join(rootDir, "src/core"), { recursive: true });
    fs.writeFileSync(path.join(rootDir, "src/core/public.ts"), "export const core = true;\n");
    fs.writeFileSync(path.join(rootDir, "src/core/view.tsx"), "export const view = true;\n");
    fs.writeFileSync(path.join(rootDir, "src/core/mod.mts"), "export const mod = true;\n");
    fs.writeFileSync(path.join(rootDir, "src/core/legacy.cts"), "export const legacy = true;\n");
    fs.mkdirSync(path.join(rootDir, "src/routes"), { recursive: true });
    fs.writeFileSync(path.join(rootDir, "src/routes/posts.$postId.tsx"), "export const route = true;\n");
    fs.writeFileSync(path.join(rootDir, "src/routes/es2015.symbol.ts"), "export const symbol = true;\n");
    fs.writeFileSync(path.join(rootDir, "src/routes/raw-template.ts"), "export const raw = true;\n");
    fs.writeFileSync(path.join(rootDir, "src/routes/package.json"), "{\"name\":\"fixture\"}\n");
    fs.writeFileSync(path.join(rootDir, "src/rules.d.ts"), "export interface RuleDocs {}\n");
    fs.writeFileSync(path.join(rootDir, "src/dom.ts"), "export interface DOMShape {}\n");
    fs.writeFileSync(path.join(rootDir, "src/app.ts"), "export const app = true;\n");

    assert.equal(resolveRelativeImport(rootDir, "src/app.ts", "./core/public.js"), "src/core/public.ts");
    assert.equal(resolveRelativeImport(rootDir, "src/app.ts", "./core/view.jsx"), "src/core/view.tsx");
    assert.equal(resolveRelativeImport(rootDir, "src/app.ts", "./core/mod.mjs"), "src/core/mod.mts");
    assert.equal(resolveRelativeImport(rootDir, "src/app.ts", "./core/legacy.cjs"), "src/core/legacy.cts");
    assert.equal(resolveRelativeImport(rootDir, "src/app.ts", "./routes/posts.$postId"), "src/routes/posts.$postId.tsx");
    assert.equal(resolveRelativeImport(rootDir, "src/app.ts", "./routes/es2015.symbol"), "src/routes/es2015.symbol.ts");
    assert.equal(resolveRelativeImport(rootDir, "src/app.ts", "./routes/raw-template?script-string"), "src/routes/raw-template.ts");
    assert.equal(resolveRelativeImport(rootDir, "src/app.ts", "./routes/package.json?raw"), "src/routes/package.json");
    assert.equal(resolveRelativeImport(rootDir, "src/app.ts", "./rules"), "src/rules.d.ts");
    assert.equal(resolveRelativeImport(rootDir, "src/app.ts", "./dom.d.ts"), "src/dom.ts");
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
  for (const extension of [
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
  ]) {
    assert.deepEqual(
      candidateModulePaths(path.join(root, `asset${extension}`)).map((candidate) => candidate.slice(root.length + 1)),
      [`asset${extension}`],
      `expected ${extension} to remain an exact module specifier`,
    );
  }
  const dottedBasename = candidateModulePaths(path.join(root, "routes/posts.$postId")).map((candidate) => candidate.slice(root.length + 1));
  assert.deepEqual(dottedBasename.slice(0, 4), [
    "routes/posts.$postId",
    "routes/posts.$postId.ts",
    "routes/posts.$postId.tsx",
    "routes/posts.$postId.js",
  ]);
  assert.ok(dottedBasename.includes("routes/posts.$postId/index.ts"));
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
  assert.deepEqual(noExtension.slice(10, 13), [
    "dir/file.d.ts",
    "dir/file.d.mts",
    "dir/file.d.cts",
  ]);
  assert.deepEqual(noExtension.slice(13), [
    "dir/file/index.ts",
    "dir/file/index.tsx",
    "dir/file/index.js",
    "dir/file/index.jsx",
    "dir/file/index.mts",
    "dir/file/index.cts",
    "dir/file/index.mjs",
    "dir/file/index.cjs",
    "dir/file/index.py",
    "dir/file/index.d.ts",
    "dir/file/index.d.mts",
    "dir/file/index.d.cts",
  ]);
  assert.deepEqual(candidateModulePaths(path.join(root, "contract.d.ts")).map((candidate) => candidate.slice(root.length + 1)), [
    "contract.d.ts",
    "contract.ts",
    "contract.tsx",
  ]);
  assert.deepEqual(candidateModulePaths(path.join(root, "contract.d.mts")).map((candidate) => candidate.slice(root.length + 1)), [
    "contract.d.mts",
    "contract.mts",
  ]);
  assert.deepEqual(candidateModulePaths(path.join(root, "contract.d.cts")).map((candidate) => candidate.slice(root.length + 1)), [
    "contract.d.cts",
    "contract.cts",
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
    fs.writeFileSync(path.join(rootDir, "packages/core/src/literal.ts"), "export const literal = true;\n");
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
    assert.equal(resolvePathAliasTarget({ rootDir, pathAliases: aliases }, "@corX@core"), undefined);
    assert.equal(resolvePathAliasTarget({ rootDir, pathAliases: aliases }, "@core/index.js"), "packages/core/src/index.ts");
    assert.equal(resolvePathAliasTarget({ rootDir, pathAliases: aliases }, "@feature/core/public"), "packages/features/core/index.ts");
    assert.equal(resolvePathAliasTarget({ rootDir, pathAliases: aliases }, "@feature/core/private"), undefined);
    assert.equal(resolvePathAliasTarget({
      rootDir,
      pathAliases: [{ pattern: "@fixed/*", targets: [path.join(rootDir, "packages/core/src/index").split(path.sep).join("/")] }],
    }, "@fixed/anything"), "packages/core/src/index.ts");
    assert.equal(resolvePathAliasTarget({
      rootDir,
      pathAliases: [{ pattern: "@literal", targets: [path.join(rootDir, "packages/core/src/*literal").split(path.sep).join("/")] }],
    }, "@literal"), "packages/core/src/literal.ts");
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("workspace alias discovery reads exact tsconfig names and deduplicates aliases", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-workspace-aliases-"));
  try {
    fs.mkdirSync(path.join(rootDir, "src"), { recursive: true });
    fs.mkdirSync(path.join(rootDir, "packages/plain/src"), { recursive: true });
    fs.mkdirSync(path.join(rootDir, "packages/build/src"), { recursive: true });
    fs.mkdirSync(path.join(rootDir, "packages/ignored/src"), { recursive: true });
    writeJson(path.join(rootDir, "tsconfig.json"), {
      compilerOptions: { paths: { "@root/*": ["src/*"], "@collision/*": ["/a", "/b/c"] } },
    });
    writeJson(path.join(rootDir, "packages/plain/tsconfig.json"), {
      compilerOptions: {
        paths: {
          "@plain/*": ["src/*"],
          "@root/*": ["../../src/*"],
          "@collision/*": ["/a/b", "/c"],
        },
      },
    });
    writeJson(path.join(rootDir, "packages/build/tsconfig.build.json"), {
      compilerOptions: { paths: { "@build/*": ["src/*"] } },
    });
    for (const fileName of [
      "x-tsconfig.json",
      "tsconfigx.json",
      "tsconfig.buildxjson",
      "tsconfig.json.bak",
    ]) {
      writeJson(path.join(rootDir, "packages/ignored", fileName), {
        compilerOptions: { paths: { "@ignored/*": ["src/*"] } },
      });
    }

    const aliases = readWorkspacePathAliases(rootDir);
    assert.deepEqual(
      aliases.map((alias) => alias.pattern),
      ["@root/*", "@collision/*", "@build/*", "@plain/*", "@collision/*"],
    );
    assert.equal(aliases.filter((alias) => alias.pattern === "@root/*").length, 1);
    assert.equal(aliases.filter((alias) => alias.pattern === "@collision/*").length, 2);
    assert.equal(aliases.some((alias) => alias.pattern === "@ignored/*"), false);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("workspace package export resolution separates public, private, generated, and unknown states", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-package-export-state-"));
  try {
    fs.mkdirSync(path.join(rootDir, "packages/core/src"), { recursive: true });
    fs.writeFileSync(path.join(rootDir, "packages/core/src/public.ts"), "export const publicSymbol = true;\n");
    writeJson(path.join(rootDir, "packages/core/package.json"), {
      name: "@scope/core",
      exports: {
        ".": "./src/public.js",
        "./generated": "./dist/generated.js",
        "./blocked": null,
      },
    });
    fs.mkdirSync(path.join(rootDir, "packages/wildcard/src"), { recursive: true });
    fs.writeFileSync(path.join(rootDir, "packages/wildcard/src/public.ts"), "export const wildcardPublic = true;\n");
    fs.writeFileSync(path.join(rootDir, "packages/wildcard/src/feature.ts"), "export const wildcard = true;\n");
    writeJson(path.join(rootDir, "packages/wildcard/package.json"), {
      name: "@scope/wildcard",
      exports: {
        ".": "./src/public.js",
        "./*": "./src/*.js",
        "./suffix/*": "./src/*.js",
        "./suffix/*.private": null,
        "./private/*": null,
        "./array-private/*": [null],
      },
    });
    fs.mkdirSync(path.join(rootDir, "packages/array/src"), { recursive: true });
    fs.writeFileSync(path.join(rootDir, "packages/array/src/index.ts"), "export const arrayRoot = true;\n");
    writeJson(path.join(rootDir, "packages/array/package.json"), {
      name: "@scope/array-root",
      exports: [null, "./src/index.js"],
    });
    fs.mkdirSync(path.join(rootDir, "packages/string/src"), { recursive: true });
    fs.writeFileSync(path.join(rootDir, "packages/string/src/index.ts"), "export const stringRoot = true;\n");
    writeJson(path.join(rootDir, "packages/string/package.json"), {
      name: "@scope/string-root",
      exports: "./src/index.js",
    });
    fs.mkdirSync(path.join(rootDir, "packages/conditional/src"), { recursive: true });
    fs.writeFileSync(path.join(rootDir, "packages/conditional/src/index.ts"), "export const conditionalRoot = true;\n");
    writeJson(path.join(rootDir, "packages/conditional/package.json"), {
      name: "@scope/conditional-root",
      exports: { import: "./src/index.js" },
    });

    assert.deepEqual(resolvePackageExportTarget(rootDir, "packages/core", "@scope/core", "@scope/core"), {
      state: "PUBLIC_RESOLVED",
      exported: true,
      targetPath: "packages/core/src/public.ts",
    });
    assert.deepEqual(resolvePackageExportTarget(rootDir, "packages/core", "@scope/core", "@scope/core/generated"), {
      state: "PUBLIC_DECLARED_GENERATED_TARGET_MISSING",
      exported: true,
      reason: "export target is declared but no source checkout file was found",
    });
    assert.deepEqual(resolvePackageExportTarget(rootDir, "packages/core", "@scope/core", "@scope/core/private"), {
      state: "NOT_EXPORTED_PRIVATE",
      exported: false,
      reason: "specifier is not declared in the package exports map",
    });
    assert.deepEqual(resolvePackageExportTarget(rootDir, "packages/core", "@scope/core", "@scope/core/blocked"), {
      state: "NOT_EXPORTED_PRIVATE",
      exported: false,
      reason: "specifier is explicitly excluded by the package exports map",
    });
    assert.deepEqual(resolvePackageExportTarget(rootDir, "packages/wildcard", "@scope/wildcard", "@scope/wildcard/feature"), {
      state: "PUBLIC_RESOLVED",
      exported: true,
      targetPath: "packages/wildcard/src/feature.ts",
    });
    assert.deepEqual(resolvePackageExportTarget(rootDir, "packages/wildcard", "@scope/wildcard", "@scope/wildcard/private/feature"), {
      state: "NOT_EXPORTED_PRIVATE",
      exported: false,
      reason: "specifier is explicitly excluded by the package exports map",
    });
    assert.deepEqual(resolvePackageExportTarget(rootDir, "packages/wildcard", "@scope/wildcard", "@scope/wildcard/suffix/feature.private"), {
      state: "NOT_EXPORTED_PRIVATE",
      exported: false,
      reason: "specifier is explicitly excluded by the package exports map",
    });
    assert.deepEqual(resolvePackageExportTarget(rootDir, "packages/wildcard", "@scope/wildcard", "@scope/wildcard/array-private/feature"), {
      state: "NOT_EXPORTED_PRIVATE",
      exported: false,
      reason: "specifier is explicitly excluded by the package exports map",
    });
    assert.deepEqual(resolvePackageExportTarget(rootDir, "packages/array", "@scope/array-root", "@scope/array-root"), {
      state: "PUBLIC_RESOLVED",
      exported: true,
      targetPath: "packages/array/src/index.ts",
    });
    assert.deepEqual(resolvePackageExportTarget(rootDir, "packages/string", "@scope/string-root", "@scope/string-root"), {
      state: "PUBLIC_RESOLVED",
      exported: true,
      targetPath: "packages/string/src/index.ts",
    });
    assert.deepEqual(resolvePackageExportTarget(rootDir, "packages/conditional", "@scope/conditional-root", "@scope/conditional-root"), {
      state: "PUBLIC_RESOLVED",
      exported: true,
      targetPath: "packages/conditional/src/index.ts",
    });
    assert.deepEqual(resolvePackageExportTarget(rootDir, "packages/core", "@scope/core", "@scope/other"), {
      state: "UNRESOLVED_UNKNOWN",
      exported: false,
      reason: "specifier does not target the workspace package",
    });
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("package maps honor condition order, arrays, wildcard precedence, and package boundaries", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-package-map-matrix-"));
  try {
    const packageRoot = path.join(rootDir, "packages/app");
    fs.mkdirSync(path.join(packageRoot, "src"), { recursive: true });
    fs.mkdirSync(path.join(rootDir, "outside"), { recursive: true });
    for (const name of ["default", "fallback", "feature", "import", "node", "require", "types", "unknown"]) {
      fs.writeFileSync(path.join(packageRoot, `src/${name}.ts`), `export const value = ${JSON.stringify(name)};\n`);
    }
    fs.writeFileSync(path.join(rootDir, "outside/escaped.ts"), "export const escaped = true;\n");
    fs.writeFileSync(path.join(packageRoot, "src/importer.ts"), "export const importer = true;\n");
    const conditionPriorities = {
      types: ["types", "import", "node", "default", "require"],
      require: ["require", "node", "default", "import", "types"],
      import: ["import", "node", "default", "require", "types"],
    };
    const conditionImports = {};
    for (const [mode, priorities] of Object.entries(conditionPriorities)) {
      for (const condition of priorities) {
        conditionImports[`#priority-${mode}-${condition}`] = {
          custom: "./src/unknown.js",
          [condition]: `./src/${condition}.js`,
        };
      }
    }
    writeJson(path.join(packageRoot, "package.json"), {
      name: "plain",
      imports: {
        "#array": [{ browser: false }, null, "./src/fallback.js"],
        "#blocked": [null, { browser: false }],
        "#condition": {
          types: "./src/types.js",
          import: "./src/import.js",
          require: "./src/require.js",
          default: "./src/default.js",
        },
        "#default-priority": {
          types: "./src/types.js",
          require: "./src/require.js",
          default: "./src/default.js",
        },
        "#empty-array": [],
        "#feature/*": "./src/*.js",
        "#feature/*.private": null,
        "#invalid/*": { browser: false },
        "#invalid-fallback": { import: false, browser: false, custom: "./src/unknown.js" },
        "#suffix/*.private": "./src/*.js",
        "#bare": "src/feature.js",
        "#outside": "./../../outside/escaped.js",
        "#node-priority": {
          types: "./src/types.js",
          require: "./src/require.js",
          default: "./src/default.js",
          node: "./src/node.js",
        },
        "#require-fallback": {
          types: "./src/types.js",
          require: "./src/require.js",
        },
        "#types-fallback": { types: "./src/types.js" },
        "#unknown": { custom: "./src/unknown.js" },
        "plain/feature": "./src/feature.js",
        ...conditionImports,
      },
      exports: {
        ".": {
          types: "./src/types.js",
          import: "./src/import.js",
          require: "./src/require.js",
          default: "./src/default.js",
        },
        "./feature": "./src/feature.js",
        "./outside": "./../../outside/escaped.js",
      },
    });

    const importerPath = "packages/app/src/importer.ts";
    assert.equal(resolvePackageImportsTarget(rootDir, importerPath, "#condition", "types"), "packages/app/src/types.ts");
    assert.equal(resolvePackageImportsTarget(rootDir, importerPath, "#condition", "import"), "packages/app/src/import.ts");
    assert.equal(resolvePackageImportsTarget(rootDir, importerPath, "#condition", "require"), "packages/app/src/require.ts");
    assert.equal(resolvePackageImportsTarget(rootDir, importerPath, "#array"), "packages/app/src/fallback.ts");
    assert.equal(resolvePackageImportsTarget(rootDir, importerPath, "#blocked"), undefined);
    assert.equal(resolvePackageImportsTarget(rootDir, importerPath, "#empty-array"), undefined);
    assert.equal(resolvePackageImportsTarget(rootDir, importerPath, "#feature/feature"), "packages/app/src/feature.ts");
    assert.equal(resolvePackageImportsTarget(rootDir, importerPath, "#feature/feature.private"), undefined);
    assert.equal(resolvePackageImportsTarget(rootDir, importerPath, "#invalid/feature"), undefined);
    assert.equal(resolvePackageImportsTarget(rootDir, importerPath, "#invalid-fallback"), "packages/app/src/unknown.ts");
    assert.equal(resolvePackageImportsTarget(rootDir, importerPath, "#suffix/feature.private"), "packages/app/src/feature.ts");
    assert.equal(resolvePackageImportsTarget(rootDir, importerPath, "#bare"), undefined);
    assert.equal(resolvePackageImportsTarget(rootDir, importerPath, "#outside"), undefined);
    assert.equal(resolvePackageImportsTarget(rootDir, importerPath, "#unknown"), "packages/app/src/unknown.ts");
    Object.defineProperty(Object.prototype, "import", {
      configurable: true,
      value: "./src/import.js",
    });
    try {
      assert.equal(resolvePackageImportsTarget(rootDir, importerPath, "#unknown"), "packages/app/src/unknown.ts");
    } finally {
      delete Object.prototype.import;
    }
    assert.equal(resolvePackageImportsTarget(rootDir, importerPath, "#node-priority", "import"), "packages/app/src/node.ts");
    assert.equal(resolvePackageImportsTarget(rootDir, importerPath, "#default-priority", "import"), "packages/app/src/default.ts");
    assert.equal(resolvePackageImportsTarget(rootDir, importerPath, "#require-fallback", "import"), "packages/app/src/require.ts");
    assert.equal(resolvePackageImportsTarget(rootDir, importerPath, "#types-fallback", "import"), "packages/app/src/types.ts");
    assert.equal(resolvePackageImportsTarget(rootDir, importerPath, "plain/feature"), undefined);
    assert.equal(resolvePackageImportsTarget(rootDir, "orphan/importer.ts", "#condition"), undefined);
    for (const [mode, priorities] of Object.entries(conditionPriorities)) {
      for (const condition of priorities) {
        assert.equal(
          resolvePackageImportsTarget(rootDir, importerPath, `#priority-${mode}-${condition}`, mode),
          `packages/app/src/${condition}.ts`,
        );
      }
    }

    assert.deepEqual(resolvePackageExportTarget(rootDir, "packages/app", "plain", "plain", "types"), {
      state: "PUBLIC_RESOLVED",
      exported: true,
      targetPath: "packages/app/src/types.ts",
    });
    assert.deepEqual(resolvePackageExportTarget(rootDir, "packages/app", "plain", "plain", "import"), {
      state: "PUBLIC_RESOLVED",
      exported: true,
      targetPath: "packages/app/src/import.ts",
    });
    assert.deepEqual(resolvePackageExportTarget(rootDir, "packages/app", "plain", "plain", "require"), {
      state: "PUBLIC_RESOLVED",
      exported: true,
      targetPath: "packages/app/src/require.ts",
    });
    assert.deepEqual(resolvePackageExportTarget(rootDir, "packages/app", "plain", "plain/feature"), {
      state: "PUBLIC_RESOLVED",
      exported: true,
      targetPath: "packages/app/src/feature.ts",
    });
    assert.deepEqual(resolvePackageExportTarget(rootDir, "packages/app", "plain", "plain/outside"), {
      state: "PUBLIC_DECLARED_GENERATED_TARGET_MISSING",
      exported: true,
      reason: "export target is declared but no source checkout file was found",
    });
    assert.deepEqual(resolvePackageExportTarget(rootDir, "packages/app", "plain", "plain/private."), {
      state: "NOT_EXPORTED_PRIVATE",
      exported: false,
      reason: "specifier is not declared in the package exports map",
    });

    fs.mkdirSync(path.join(rootDir, "packages/no-exports"), { recursive: true });
    writeJson(path.join(rootDir, "packages/no-exports/package.json"), { name: "no-exports" });
    assert.deepEqual(resolvePackageExportTarget(rootDir, "packages/no-exports", "no-exports", "no-exports"), {
      state: "NOT_EXPORTED_PRIVATE",
      exported: false,
      reason: "package has no exports map",
    });
    assert.deepEqual(resolvePackageExportTarget(rootDir, "packages/missing", "missing", "missing"), {
      state: "UNRESOLVED_UNKNOWN",
      exported: false,
      reason: "package.json could not be read",
    });
    fs.mkdirSync(path.join(rootDir, "packages/scalar/src"), { recursive: true });
    fs.writeFileSync(path.join(rootDir, "packages/scalar/src/index.ts"), "export const root = true;\n");
    writeJson(path.join(rootDir, "packages/scalar/package.json"), { name: "scalar", exports: "./src/index.js" });
    assert.deepEqual(resolvePackageExportTarget(rootDir, "packages/scalar", "scalar", "scalar"), {
      state: "PUBLIC_RESOLVED",
      exported: true,
      targetPath: "packages/scalar/src/index.ts",
    });
    assert.deepEqual(resolvePackageExportTarget(rootDir, "packages/scalar", "scalar", "scalar/private"), {
      state: "NOT_EXPORTED_PRIVATE",
      exported: false,
      reason: "specifier is not declared in the package exports map",
    });
    fs.mkdirSync(path.join(rootDir, "packages/array-map/src"), { recursive: true });
    fs.writeFileSync(path.join(rootDir, "packages/array-map/src/index.ts"), "export const root = true;\n");
    writeJson(path.join(rootDir, "packages/array-map/package.json"), { name: "array-map", exports: ["./src/index.js"] });
    assert.deepEqual(resolvePackageExportTarget(rootDir, "packages/array-map", "array-map", "array-map"), {
      state: "PUBLIC_RESOLVED",
      exported: true,
      targetPath: "packages/array-map/src/index.ts",
    });
    assert.deepEqual(resolvePackageExportTarget(rootDir, "packages/array-map", "array-map", "array-map/private"), {
      state: "NOT_EXPORTED_PRIVATE",
      exported: false,
      reason: "specifier is not declared in the package exports map",
    });
    fs.mkdirSync(path.join(rootDir, "packages/empty"), { recursive: true });
    writeJson(path.join(rootDir, "packages/empty/package.json"), { name: "empty", exports: [] });
    assert.deepEqual(resolvePackageExportTarget(rootDir, "packages/empty", "empty", "empty"), {
      state: "NOT_EXPORTED_PRIVATE",
      exported: false,
      reason: "specifier is not declared in the package exports map",
    });
    fs.mkdirSync(path.join(rootDir, "packages/null-map"), { recursive: true });
    writeJson(path.join(rootDir, "packages/null-map/package.json"), { name: "null-map", exports: null });
    assert.deepEqual(resolvePackageExportTarget(rootDir, "packages/null-map", "null-map", "null-map/private"), {
      state: "NOT_EXPORTED_PRIVATE",
      exported: false,
      reason: "specifier is not declared in the package exports map",
    });
    fs.mkdirSync(path.join(rootDir, "packages/mixed/src"), { recursive: true });
    fs.writeFileSync(path.join(rootDir, "packages/mixed/src/root.ts"), "export const root = true;\n");
    fs.writeFileSync(path.join(rootDir, "packages/mixed/src/wrong.ts"), "export const wrong = true;\n");
    writeJson(path.join(rootDir, "packages/mixed/package.json"), {
      name: "mixed",
      exports: {
        import: "./src/wrong.js",
        ".": "./src/root.js",
      },
    });
    assert.deepEqual(resolvePackageExportTarget(rootDir, "packages/mixed", "mixed", "mixed"), {
      state: "PUBLIC_RESOLVED",
      exported: true,
      targetPath: "packages/mixed/src/root.ts",
    });
    fs.mkdirSync(path.join(rootDir, "packages/ends/src"), { recursive: true });
    fs.writeFileSync(path.join(rootDir, "packages/ends/src/root.ts"), "export const root = true;\n");
    fs.writeFileSync(path.join(rootDir, "packages/ends/src/wrong.ts"), "export const wrong = true;\n");
    writeJson(path.join(rootDir, "packages/ends/package.json"), {
      name: "ends",
      exports: {
        "condition./": "./src/wrong.js",
        import: "./src/root.js",
      },
    });
    assert.deepEqual(resolvePackageExportTarget(rootDir, "packages/ends", "ends", "ends"), {
      state: "PUBLIC_RESOLVED",
      exported: true,
      targetPath: "packages/ends/src/root.ts",
    });
    for (const [directoryName, invalidJson] of [
      ["array-json", []],
      ["null-json", null],
      ["string-json", "package"],
    ]) {
      fs.mkdirSync(path.join(rootDir, `packages/${directoryName}`), { recursive: true });
      writeJson(path.join(rootDir, `packages/${directoryName}/package.json`), invalidJson);
      assert.deepEqual(resolvePackageExportTarget(rootDir, `packages/${directoryName}`, directoryName, directoryName), {
        state: "UNRESOLVED_UNKNOWN",
        exported: false,
        reason: "package.json could not be read",
      });
    }
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("nearest path alias resolution uses the closest tsconfig and fails closed without one", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-nearest-alias-"));
  try {
    fs.mkdirSync(path.join(rootDir, "packages/app/src"), { recursive: true });
    fs.mkdirSync(path.join(rootDir, "packages/app/lib"), { recursive: true });
    fs.writeFileSync(path.join(rootDir, "packages/app/src/app.ts"), "export const app = true;\n");
    fs.writeFileSync(path.join(rootDir, "packages/app/lib/value.ts"), "export const value = true;\n");
    writeJson(path.join(rootDir, "packages/app/tsconfig.json"), {
      compilerOptions: {
        baseUrl: ".",
        paths: { "@local/*": ["lib/*"] },
      },
    });
    assert.equal(
      resolveNearestPathAliasTarget(rootDir, "packages/app/src/app.ts", "@local/value.js"),
      "packages/app/lib/value.ts",
    );
    assert.equal(resolveNearestPathAliasTarget(rootDir, "outside/app.ts", "@local/value.js"), undefined);
    assert.equal(resolveNearestPathAliasTarget(rootDir, "packages/app/src/app.ts", "@missing/value.js"), undefined);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("package import and self export resolution fail closed without package metadata", () => {
  const rootDir = packageFreeTempRoot("cellfence-package-free-resolution-");
  try {
    fs.mkdirSync(path.join(rootDir, "src"), { recursive: true });
    const importerPath = path.join(rootDir, "src/importer.ts");
    fs.writeFileSync(importerPath, "import '#missing';\nexport * from 'missing/self';\n");
    assert.equal(resolvePackageImportsTarget(rootDir, "src/importer.ts", "#missing"), undefined);
    assert.deepEqual([...extractPublicSymbols(importerPath)], []);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("public re-export resolution independently follows package imports, self exports, and aliases", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-project-resolution-matrix-"));
  try {
    fs.mkdirSync(path.join(rootDir, "src/contracts"), { recursive: true });
    fs.writeFileSync(path.join(rootDir, "src/contracts/import-types.ts"), "export interface ImportType { value: string }\n");
    fs.writeFileSync(path.join(rootDir, "src/contracts/import-runtime.ts"), "export interface WrongImportType { value: string }\n");
    fs.writeFileSync(path.join(rootDir, "src/contracts/self-types.ts"), "export interface SelfType { value: string }\n");
    fs.writeFileSync(path.join(rootDir, "src/contracts/self-runtime.ts"), "export interface WrongSelfType { value: string }\n");
    fs.writeFileSync(path.join(rootDir, "src/contracts/root-types.ts"), "export interface RootType { value: string }\n");
    fs.writeFileSync(path.join(rootDir, "src/contracts/alias.ts"), "export interface AliasType { value: string }\n");
    fs.writeFileSync(path.join(rootDir, "blocked.ts"), "export interface WrongBlockedType { value: string }\n");
    fs.writeFileSync(path.join(rootDir, "fallback.ts"), "export interface FallbackType { value: string }\n");
    writeJson(path.join(rootDir, "package.json"), {
      name: "@example/project",
      imports: {
        "#contract": {
          import: "./src/contracts/import-runtime.js",
          types: "./src/contracts/import-types.js",
        },
      },
      exports: {
        ".": { types: "./src/contracts/root-types.js" },
        "./self": {
          import: "./src/contracts/self-runtime.js",
          types: "./src/contracts/self-types.js",
        },
        "./blocked": null,
      },
    });
    writeJson(path.join(rootDir, "tsconfig.json"), {
      compilerOptions: {
        baseUrl: ".",
        paths: { "@alias/*": ["src/contracts/*"] },
      },
    });
    const importPublicPath = path.join(rootDir, "src/import-public.ts");
    const selfPublicPath = path.join(rootDir, "src/self-public.ts");
    const selfRootPublicPath = path.join(rootDir, "src/self-root-public.ts");
    const aliasPublicPath = path.join(rootDir, "src/alias-public.ts");
    const blockedPublicPath = path.join(rootDir, "src/blocked-public.ts");
    const fallbackPublicPath = path.join(rootDir, "src/fallback-public.ts");
    const mismatchedPublicPath = path.join(rootDir, "src/mismatched-public.ts");
    const emptyNamePublicPath = path.join(rootDir, "src/empty-name-public.ts");
    fs.writeFileSync(importPublicPath, "export * from '#contract';\n");
    fs.writeFileSync(selfPublicPath, "export * from '@example/project/self';\n");
    fs.writeFileSync(selfRootPublicPath, "export * from '@example/project';\n");
    fs.writeFileSync(aliasPublicPath, "export * from '@alias/alias';\n");
    fs.writeFileSync(blockedPublicPath, "export * from '@example/project/blocked';\n");
    fs.writeFileSync(fallbackPublicPath, "export * from '@example/project/fallback';\n");
    fs.writeFileSync(mismatchedPublicPath, "export * from 'differentpackage/self';\n");
    fs.writeFileSync(emptyNamePublicPath, "export * from '';\n");

    assert.deepEqual([...extractPublicSymbols(importPublicPath)], ["ImportType"]);
    assert.deepEqual([...extractPublicSymbols(selfPublicPath)], ["SelfType"]);
    assert.deepEqual([...extractPublicSymbols(selfRootPublicPath)], ["RootType"]);
    assert.deepEqual([...extractPublicSymbols(aliasPublicPath)], ["AliasType"]);
    assert.deepEqual([...extractPublicSymbols(blockedPublicPath)], []);
    assert.deepEqual([...extractPublicSymbols(fallbackPublicPath)], ["FallbackType"]);
    assert.deepEqual([...extractPublicSymbols(mismatchedPublicPath)], []);

    writeJson(path.join(rootDir, "package.json"), { name: "@example/project" });
    assert.deepEqual([...extractPublicSymbols(selfRootPublicPath)], []);

    writeJson(path.join(rootDir, "package.json"), {
      name: 42,
      exports: { "./self": "./src/contracts/self-types.js" },
    });
    assert.deepEqual([...extractPublicSymbols(selfPublicPath)], []);

    writeJson(path.join(rootDir, "package.json"), {
      name: "",
      exports: { ".": "./src/contracts/root-types.js" },
    });
    assert.deepEqual([...extractPublicSymbols(emptyNamePublicPath)], []);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("Python module resolution handles relative depth, package roots, and source-root precedence", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-python-resolution-matrix-"));
  try {
    fs.mkdirSync(path.join(rootDir, "src/pkg/nested"), { recursive: true });
    fs.mkdirSync(path.join(rootDir, "vendor/pkg"), { recursive: true });
    fs.writeFileSync(path.join(rootDir, "root_module.py"), "value = 1\n");
    fs.writeFileSync(path.join(rootDir, "__init__.py"), "value = 1\n");
    fs.writeFileSync(path.join(rootDir, "src/pkg/__init__.py"), "");
    fs.writeFileSync(path.join(rootDir, "src/pkg/sibling.py"), "value = 1\n");
    fs.writeFileSync(path.join(rootDir, "src/pkg/nested/__init__.py"), "");
    fs.writeFileSync(path.join(rootDir, "src/pkg/nested/consumer.py"), "");
    fs.writeFileSync(path.join(rootDir, "src/pkg/nested/local.py"), "value = 1\n");
    fs.writeFileSync(path.join(rootDir, "src/pkg/nested/pkg.py"), "value = 1\n");
    fs.writeFileSync(path.join(rootDir, "src/pkg/nested/pkg.ts"), "export const value = 1;\n");
    fs.writeFileSync(path.join(rootDir, "src/pkg/nested/.local.ts"), "export const local = true;\n");
    fs.writeFileSync(path.join(rootDir, "vendor/pkg/__init__.py"), "");

    const importerPath = "src/pkg/nested/consumer.py";
    assert.equal(resolvePythonImport(rootDir, importerPath, ".local"), "src/pkg/nested/local.py");
    assert.equal(resolvePythonImport(rootDir, importerPath, "..sibling"), "src/pkg/sibling.py");
    assert.equal(resolvePythonImport(rootDir, importerPath, ".."), "src/pkg/__init__.py");
    assert.equal(resolvePythonImport(rootDir, importerPath, "pkg", ["src", "vendor"]), "src/pkg/__init__.py");
    assert.equal(resolvePythonImport(rootDir, importerPath, "pkg", ["vendor", "src"]), "vendor/pkg/__init__.py");
    assert.equal(resolvePythonImport(rootDir, importerPath, "root_module"), "root_module.py");
    assert.equal(resolvePythonImport(rootDir, importerPath, ""), undefined);
    assert.equal(resolvePythonImport(rootDir, importerPath, "missing"), undefined);
    assert.equal(resolvePythonImport(rootDir, "src/pkg/nested/consumer.ts", "pkg", ["src"]), undefined);
    assert.equal(resolvePythonImport(rootDir, importerPath, "...missing"), undefined);
    assert.equal(resolveRelativeImport(rootDir, importerPath, ".local"), "src/pkg/nested/local.py");
    assert.equal(resolveRelativeImport(rootDir, importerPath, "./local.py?raw"), "src/pkg/nested/local.py");
    assert.equal(resolveRelativeImport(rootDir, importerPath, "../sibling.py"), "src/pkg/sibling.py");
    assert.equal(resolveRelativeImport(rootDir, importerPath, "pkg"), "src/pkg/nested/pkg.ts");
    assert.equal(resolveRelativeImport(rootDir, "src/pkg/nested/consumer.ts", ".local"), "src/pkg/nested/.local.ts");
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
        "let mutableName = './mutable.js';",
        "const workerModule = 'cloudflare:workers';",
        "require('./d.js');",
        "require('./extra-arg.js', name);",
        "require(name);",
        "require(mutableName);",
        "require(require.resolve('@babel/core'));",
        "import('./e.js');",
        "import(workerModule);",
        "import(mutableName);",
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
      ["require", "./c.js", false],
      ["require", "@babel/core", false],
      ["dynamic-import", "./e.js", false],
      ["dynamic-import", "cloudflare:workers", false],
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
        message: "computed require() cannot be resolved statically at line 10",
        details: { line: 10 },
      },
      {
        ruleId: "CELLFENCE_UNSUPPORTED_DYNAMIC_IMPORT",
        severity: "warning",
        filePath: "src/app.ts",
        message: "computed dynamic import cannot be resolved statically at line 14",
        details: { line: 14 },
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
        "const allowedRuntimeModules = new Set(['chalk']);",
        "const unresolvedRuntimeModules = new Set(['one', 'two']);",
        "declare const allowedModuleName: string;",
        "declare const unresolvedModuleName: string;",
        "module.require('./module-require.js');",
        "req('./alias-require.js');",
        "localRequire('./created-require.js');",
        "let target = './dynamic.js';",
        "req(target);",
        "if (allowedRuntimeModules.has(allowedModuleName)) {",
        "  req(allowedModuleName);",
        "}",
        "if (unresolvedRuntimeModules.has(unresolvedModuleName)) {",
        "  req(unresolvedModuleName);",
        "}",
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
      message: "computed req() cannot be resolved statically at line 13",
      details: { line: 13 },
    }, {
      ruleId: "CELLFENCE_UNSUPPORTED_DYNAMIC_REQUIRE",
      severity: "warning",
      filePath: "src/app.ts",
      message: "computed req() cannot be resolved statically at line 15",
      details: { line: 15 },
    }, {
      ruleId: "CELLFENCE_UNSUPPORTED_DYNAMIC_REQUIRE",
      severity: "warning",
      filePath: "src/app.ts",
      message: "computed req() cannot be resolved statically at line 18",
      details: { line: 18 },
    }]);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("module resolution unwraps TypeScript expression wrappers exactly", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-module-expression-wrappers-"));
  try {
    fs.mkdirSync(path.join(rootDir, "src"), { recursive: true });
    const filePath = path.join(rootDir, "src/app.ts");
    fs.writeFileSync(filePath, [
      "(require as typeof require)('./as.js');",
      "(<typeof require>require)('./type-assertion.js');",
      "require!('./non-null.js');",
      "(0 + require)('./not-comma.js');",
      "",
    ].join("\n"));
    const warnings = [];
    assert.deepEqual(extractImports(context(rootDir), filePath, warnings).map((reference) => reference.specifier), [
      "./as.js",
      "./type-assertion.js",
      "./non-null.js",
    ]);
    assert.deepEqual(warnings, []);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("module resolution rejects require-like structural near misses", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-module-require-near-misses-"));
  try {
    fs.mkdirSync(path.join(rootDir, "src"), { recursive: true });
    const cases = [
      ["empty-require", "require();", []],
      ["wrong-resolve-method", "require(require.other('./not-resolve.js'));", []],
      ["function-this", "function load() { this.require('./not-top-level-this.js'); }", []],
      ["wrong-global-property", "global.load('./not-global-property.js');", []],
      ["wrong-global-receiver", "other.require('./not-global-receiver.js');", []],
      ["wrong-module-property", "module.load('./not-module-property.js');", []],
      ["wrong-process-property", "process.mainModule.load('./not-process-property.js');", []],
      ["wrong-process-middle", "process.other.require('./not-process-middle.js');", []],
      ["wrong-process-root", "other.mainModule.require('./not-process-root.js');", []],
      ["string-process-root", "'process'.mainModule.require('./not-string-process.js');", []],
      ["wrong-constructor-property", "module.constructor.load('./not-constructor-property.js');", []],
      ["wrong-constructor-middle", "module.other._load('./not-constructor-middle.js');", []],
      ["wrong-constructor-root", "other.constructor._load('./not-constructor-root.js');", []],
      [
        "string-module-object",
        "const fake = 'module'; const { require: req } = fake; req('./not-string-module.js');",
        [],
      ],
      [
        "non-module-namespace",
        "const ns = require('not-module'); const req = ns.createRequire(import.meta.url); req('./not-created.js');",
        ["not-module"],
      ],
      [
        "direct-non-module-namespace",
        "const req = require('not-module').createRequire(import.meta.url); req('./not-direct-created.js');",
        ["not-module"],
      ],
      [
        "computed-namespace",
        "const ns = factory(); const req = ns.createRequire(import.meta.url); req('./not-computed-created.js');",
        [],
      ],
      [
        "fake-create-require",
        "const req = fakeFactory(import.meta.url); req('./not-factory-created.js');",
        [],
      ],
      [
        "wrong-create-require-property",
        "import * as Module from 'node:module'; const req = Module.notCreateRequire(import.meta.url); req('./not-property-created.js');",
        ["node:module"],
      ],
      [
        "wrong-bind-property",
        "const req = require.other(null); req('./not-bound.js');",
        [],
      ],
      [
        "non-module-require-result",
        "const ns = require('not-module'); const create = ns.createRequire; const req = create(import.meta.url); req('./not-result-created.js');",
        ["not-module"],
      ],
    ];
    for (const [name, source, expectedSpecifiers] of cases) {
      const filePath = path.join(rootDir, `src/${name}.ts`);
      fs.writeFileSync(filePath, `// require scan hint\n${source}\n`);
      const warnings = [];
      assert.deepEqual(
        extractImports(context(rootDir), filePath, warnings).map((reference) => reference.specifier),
        expectedSpecifiers,
        name,
      );
    }

    const shadowedGlobalsPath = path.join(rootDir, "src/shadowed-global-properties.ts");
    fs.writeFileSync(shadowedGlobalsPath, [
      "const global = { require(value: string) { return value; } };",
      "const globalThis = global;",
      "global.require('./not-shadowed-global.js');",
      "globalThis.require('./not-shadowed-global-this.js');",
      "",
    ].join("\n"));
    assert.deepEqual(extractImports(context(rootDir), shadowedGlobalsPath, []), []);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("module resolution reports dynamic require compatibility forms exactly", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-module-dynamic-require-forms-"));
  try {
    fs.mkdirSync(path.join(rootDir, "src"), { recursive: true });
    const filePath = path.join(rootDir, "src/app.ts");
    fs.writeFileSync(filePath, [
      "declare const candidate: string;",
      "global.require(candidate);",
      "globalThis.require(candidate);",
      "this.require(candidate);",
      "require.call(null, candidate);",
      "module.require.call(null, candidate);",
      "require.apply(null, [candidate]);",
      "module.require.apply(null, [candidate]);",
      "Reflect.apply(require, null, [candidate]);",
      "require.call();",
      "require.apply();",
      "Reflect.apply(require, null);",
      "Reflect.call(require, null, ['./not-reflect-call.js']);",
      "Reflect.apply(other, null, ['./not-reflect-receiver.js']);",
      "require();",
      "require.apply(null, candidate);",
      "Other.apply(require, null, ['./not-other-apply.js']);",
      "",
    ].join("\n"));
    const warnings = [];
    assert.deepEqual(extractImports(context(rootDir), filePath, warnings), []);
    assert.deepEqual(warnings.map((warning) => warning.message), [
      "computed global.require() cannot be resolved statically at line 2",
      "computed globalThis.require() cannot be resolved statically at line 3",
      "computed this.require() cannot be resolved statically at line 4",
      "computed require.call() cannot be resolved statically at line 5",
      "computed module.require.call() cannot be resolved statically at line 6",
      "computed require.apply() cannot be resolved statically at line 7",
      "computed module.require.apply() cannot be resolved statically at line 8",
      "computed Reflect.apply(require)() cannot be resolved statically at line 9",
      "computed require.call() cannot be resolved statically at line 10",
      "computed require.apply() cannot be resolved statically at line 11",
      "computed require.apply() cannot be resolved statically at line 16",
    ]);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("dynamic execution scanning distinguishes require syntax and shadowed evaluators", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-module-dynamic-execution-matrix-"));
  try {
    fs.mkdirSync(path.join(rootDir, "src"), { recursive: true });
    const filePath = path.join(rootDir, "src/app.ts");
    fs.writeFileSync(filePath, [
      "eval(\"require('./matched.js')\");",
      "eval(\"requireX('./not-require-x.js')\");",
      "eval(\"require(foo'./not-require-gap.js')\");",
      "object.eval(\"require('./not-property-eval.js')\");",
      "const Function = (source: string) => source;",
      "Function(\"require('./not-shadowed-function.js')\");",
      "",
    ].join("\n"));
    const warnings = [];
    assert.deepEqual(extractImports(context(rootDir), filePath, warnings), [{
      importerPath: "src/app.ts",
      specifier: "./matched.js",
      kind: "require",
      typeOnly: false,
      line: 1,
    }]);
    assert.deepEqual(warnings, []);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("readonly singleton Set guards require an exact return-require shape", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-module-set-return-shapes-"));
  try {
    fs.mkdirSync(path.join(rootDir, "src"), { recursive: true });
    const cases = [
      ["wrong-callee", "if (singletonModules.has(candidate)) return fake(candidate);", [], 0],
      ["literal-argument", "if (singletonModules.has(candidate)) return require('./literal.js');", ["./literal.js"], 0],
      ["wrong-identifier", "if (singletonModules.has(candidate)) return require(otherCandidate);", [], 1],
      ["multiple-statements", "if (singletonModules.has(candidate)) { return require(candidate); after(); }", [], 1],
      ["non-return", "if (singletonModules.has(candidate)) require(candidate);", [], 1],
      ["non-call-return", "if (singletonModules.has(candidate)) return candidate;", [], 0],
      ["missing-guard-argument", "if (singletonModules.has()) return require(candidate);", [], 1],
      ["extra-guard-argument", "if (singletonModules.has(candidate, candidate = otherCandidate)) return require(candidate);", [], 1],
      ["literal-guard-argument", "if (singletonModules.has('candidate')) return require(candidate);", [], 1],
      ["empty-return", "if (singletonModules.has(candidate)) return;", [], 0],
      ["empty-require", "if (singletonModules.has(candidate)) return require();", [], 0],
    ];
    for (const [name, guardedSource, expectedSpecifiers, expectedWarningCount] of cases) {
      const filePath = path.join(rootDir, `src/${name}.ts`);
      fs.writeFileSync(filePath, [
        "declare const otherCandidate: string;",
        "const singletonModules = new Set(['chalk']);",
        "export function load(candidate: string) {",
        `  ${guardedSource}`,
        "}",
        "",
      ].join("\n"));
      const warnings = [];
      assert.deepEqual(extractImports(context(rootDir), filePath, warnings).map((reference) => reference.specifier), expectedSpecifiers, name);
      assert.equal(warnings.length, expectedWarningCount, name);
    }

    const elsePath = path.join(rootDir, "src/else-branch.ts");
    fs.writeFileSync(elsePath, [
      "const singletonModules = new Set(['chalk']);",
      "export function load(candidate: string) {",
      "  if (singletonModules.has(candidate)) return require(candidate);",
      "  else return require('./fallback.js');",
      "}",
      "",
    ].join("\n"));
    assert.deepEqual(extractImports(context(rootDir), elsePath, []).map((reference) => reference.specifier), ["chalk", "./fallback.js"]);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("non-Node module namespaces cannot manufacture a createRequire binding", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-module-non-node-create-require-"));
  try {
    fs.mkdirSync(path.join(rootDir, "src"), { recursive: true });
    const filePath = path.join(rootDir, "src/app.ts");
    fs.writeFileSync(filePath, [
      "import * as toolkit from 'not-node-module';",
      "const fakeRequire = toolkit.createRequire(import.meta.url);",
      "fakeRequire('./must-not-be-treated-as-require.js');",
      "",
    ].join("\n"));
    const warnings = [];
    assert.deepEqual(extractImports(context(rootDir), filePath, warnings), [{
      importerPath: "src/app.ts",
      specifier: "not-node-module",
      kind: "import",
      typeOnly: false,
      line: 1,
    }]);
    assert.deepEqual(warnings, []);
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

test("module resolution predeclares every shadowing declaration form", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-module-predeclare-matrix-"));
  try {
    fs.mkdirSync(path.join(rootDir, "src"), { recursive: true });
    const cases = [
      ["variable", "require('./blocked.js'); const require = fake;", []],
      ["function", "require('./blocked.js'); function require() {}", []],
      ["class", "module.require('./blocked.js'); class module {}", []],
      ["default-import", "require('./blocked.js'); import require from 'fixture';", ["fixture"]],
      ["namespace-import", "module.require('./blocked.js'); import * as module from 'fixture';", ["fixture"]],
      ["named-import", "require('./blocked.js'); import { value as require } from 'fixture';", ["fixture"]],
      ["import-equals", "require('./blocked.js'); import require = require('fixture');", ["fixture"]],
      ["side-effect-import", "import 'fixture'; require('./allowed.js');", ["fixture", "./allowed.js"]],
    ];
    for (const [name, source, expectedSpecifiers] of cases) {
      const filePath = path.join(rootDir, `src/${name}.ts`);
      fs.writeFileSync(filePath, `${source}\n`);
      assert.deepEqual(extractImports(context(rootDir), filePath, []).map((reference) => reference.specifier), expectedSpecifiers, name);
    }

    const blockPath = path.join(rootDir, "src/block.ts");
    fs.writeFileSync(blockPath, [
      "const req = require;",
      "{",
      "  req('./blocked-function.js');",
      "  function req() {}",
      "}",
      "req('./outer-function.js');",
      "{",
      "  module.require('./blocked-class.js');",
      "  class module {}",
      "}",
      "module.require('./outer-module.js');",
      "",
    ].join("\n"));
    assert.deepEqual(extractImports(context(rootDir), blockPath, []).map((reference) => reference.specifier), [
      "./outer-function.js",
      "./outer-module.js",
    ]);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("module resolution binds node module imports and destructuring exactly", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-module-node-module-bindings-"));
  try {
    fs.mkdirSync(path.join(rootDir, "src"), { recursive: true });
    const filePath = path.join(rootDir, "src/app.ts");
    fs.writeFileSync(filePath, [
      "import type TypeModule from 'node:module';",
      "import { type createRequire as typeFactory, createRequire, builtinModules as notFactory } from 'node:module';",
      "import * as Module from 'module';",
      "const reqFromImport = createRequire(import.meta.url);",
      "reqFromImport('./from-import.js');",
      "typeFactory('./not-type-import.js');",
      "notFactory('./not-unrelated-import.js');",
      "const typeOnlyReq = typeFactory(import.meta.url);",
      "typeOnlyReq('./not-type-factory.js');",
      "const unrelatedReq = notFactory(import.meta.url);",
      "unrelatedReq('./not-unrelated-factory.js');",
      "const typeReq = TypeModule.createRequire(import.meta.url);",
      "typeReq('./not-type-default.js');",
      "const namespaceReq = Module.createRequire(import.meta.url);",
      "namespaceReq('./from-namespace.js');",
      "const { createRequire: fromCjs, builtinModules: notFromCjs } = require('module');",
      "const cjsReq = fromCjs(__filename);",
      "cjsReq('./from-cjs.js');",
      "notFromCjs('./not-cjs-property.js');",
      "const unrelatedCjsReq = notFromCjs(__filename);",
      "unrelatedCjsReq('./not-cjs-factory.js');",
      "const { createRequire } = require('module');",
      "const shorthandReq = createRequire(__filename);",
      "shorthandReq('./from-cjs-shorthand.js');",
      "const { createRequire: otherFactory } = require('other-module');",
      "const otherReq = otherFactory(__filename);",
      "otherReq('./not-other-module.js');",
      "const { createRequire: { nestedFactory } } = require('module');",
      "nestedFactory('./not-nested-binding.js');",
      "const { require: moduleReq, filename: notModuleReq } = module;",
      "moduleReq('./from-module-object.js');",
      "notModuleReq('./not-module-property.js');",
      "{ const { require } = module; require('./from-module-shorthand.js'); }",
      "{ const { 'require': quotedRequire } = module; quotedRequire('./not-quoted-module-property.js'); }",
      "",
    ].join("\n"));
    const warnings = [];
    assert.deepEqual(extractImports(context(rootDir), filePath, warnings).map((reference) => reference.specifier), [
      "node:module",
      "node:module",
      "module",
      "./from-import.js",
      "./from-namespace.js",
      "module",
      "./from-cjs.js",
      "module",
      "./from-cjs-shorthand.js",
      "other-module",
      "module",
      "./from-module-object.js",
      "./from-module-shorthand.js",
    ]);
    assert.deepEqual(warnings, []);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("module resolution visits loop, switch, and catch positions without leaking scopes", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-module-control-flow-scopes-"));
  try {
    fs.mkdirSync(path.join(rootDir, "src"), { recursive: true });
    const filePath = path.join(rootDir, "src/app.ts");
    fs.writeFileSync(filePath, [
      "for (require('./for-init.js'); require('./for-condition.js'); require('./for-increment.js')) { require('./for-body.js'); break; }",
      "for (;;) { break; }",
      "for (const key in require('./for-in-expression.js')) { require('./for-in-body.js'); }",
      "for (const value of require('./for-of-expression.js')) { require('./for-of-body.js'); }",
      "switch (require('./switch-expression.js')) {",
      "  case require('./case-expression.js'): {",
      "    req('./blocked-switch.js');",
      "    const req = fake;",
      "    break;",
      "  }",
      "  default: require('./switch-default.js');",
      "}",
      "try { throw new Error(); } catch (require) { require('./blocked-catch.js'); }",
      "try { throw new Error(); } catch { require('./catch-without-binding.js'); }",
      "require('./after-control-flow.js');",
      "",
    ].join("\n"));
    const warnings = [];
    assert.deepEqual(extractImports(context(rootDir), filePath, warnings).map((reference) => reference.specifier), [
      "./for-init.js",
      "./for-condition.js",
      "./for-increment.js",
      "./for-body.js",
      "./for-in-expression.js",
      "./for-in-body.js",
      "./for-of-expression.js",
      "./for-of-body.js",
      "./switch-expression.js",
      "./case-expression.js",
      "./switch-default.js",
      "./catch-without-binding.js",
      "./after-control-flow.js",
    ]);
    assert.deepEqual(warnings, []);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("module resolution binds destructuring declarations in for-loop scopes", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-module-for-binding-scopes-"));
  try {
    fs.mkdirSync(path.join(rootDir, "src"), { recursive: true });
    const filePath = path.join(rootDir, "src/app.ts");
    fs.writeFileSync(filePath, [
      "import { createRequire as factory } from 'node:module';",
      "declare const values: Array<{ factory: (value: string) => unknown }> ;",
      "for (const { factory } of values) {",
      "  const req = factory(import.meta.url);",
      "  req('./not-for-of-binding.js');",
      "}",
      "for (const { factory } = values[0]; false;) {",
      "  const req = factory(import.meta.url);",
      "  req('./not-for-initializer-binding.js');",
      "}",
      "",
    ].join("\n"));
    assert.deepEqual(extractImports(context(rootDir), filePath, []).map((reference) => reference.specifier), [
      "node:module",
    ]);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("module resolution preserves loop, switch, and catch scope lifetimes", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-module-control-scope-lifetimes-"));
  try {
    fs.mkdirSync(path.join(rootDir, "src"), { recursive: true });
    const cases = [
      [
        "for-statement-var",
        [
          "for (var require = fake; false;) {}",
          "require('./blocked-after-for.js');",
        ],
        [],
      ],
      [
        "for-in-lexical",
        [
          "import { createRequire as factory } from 'node:module';",
          "declare const values: object;",
          "for (const factory in values) { factory('./not-for-in.js'); }",
          "const req = factory(import.meta.url);",
          "req('./after-for-in.js');",
        ],
        ["node:module", "./after-for-in.js"],
      ],
      [
        "for-of-lexical",
        [
          "import { createRequire as factory } from 'node:module';",
          "declare const values: Array<(value: string) => unknown>;",
          "for (const factory of values) { factory('./not-for-of.js'); }",
          "const req = factory(import.meta.url);",
          "req('./after-for-of.js');",
        ],
        ["node:module", "./after-for-of.js"],
      ],
      [
        "for-in-var",
        [
          "declare const values: object;",
          "for (var require in values) {}",
          "require('./blocked-after-for-in-var.js');",
        ],
        [],
      ],
      [
        "switch-predeclare",
        [
          "const req = require;",
          "switch (value) {",
          "  case 1: req('./blocked-across-clauses.js'); break;",
          "  default: const req = fake;",
          "}",
          "req('./after-switch.js');",
        ],
        ["./after-switch.js"],
      ],
      [
        "switch-var",
        [
          "switch (value) { default: var require = fake; }",
          "require('./blocked-after-switch.js');",
        ],
        [],
      ],
      [
        "catch-var",
        [
          "try { throw value; } catch { var require = fake; }",
          "require('./blocked-after-catch.js');",
        ],
        [],
      ],
    ];
    for (const [name, lines, expectedSpecifiers] of cases) {
      const filePath = path.join(rootDir, `src/${name}.ts`);
      fs.writeFileSync(filePath, `${lines.join("\n")}\n`);
      assert.deepEqual(extractImports(context(rootDir), filePath, []).map((reference) => reference.specifier), expectedSpecifiers, name);
    }
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("module resolution ignores computed TypeScript import-equals specifiers", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-module-import-equals-computed-"));
  try {
    fs.mkdirSync(path.join(rootDir, "src"), { recursive: true });
    const filePath = path.join(rootDir, "src/app.ts");
    fs.writeFileSync(filePath, "import dependency = require(moduleName);\n");
    assert.deepEqual(extractImports(context(rootDir), filePath, []), []);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("module resolution does not treat local exports as export-from references", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-module-local-export-"));
  try {
    fs.mkdirSync(path.join(rootDir, "src"), { recursive: true });
    const filePath = path.join(rootDir, "src/app.ts");
    fs.writeFileSync(filePath, "const local = 1;\nexport { local };\n");
    assert.deepEqual(extractImports(context(rootDir), filePath, []), []);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("module resolution does not reuse constant module specifiers across shadowed scopes or mutable Set guards", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-module-constant-scope-"));
  try {
    fs.mkdirSync(path.join(rootDir, "src"), { recursive: true });
    const filePath = path.join(rootDir, "src/app.ts");
    fs.writeFileSync(
      filePath,
      [
        "const moduleName = './outer.js';",
        "const singletonModules = new Set(['chalk']);",
        "require(moduleName);",
        "function shadowsParam(moduleName: string, candidate: string) {",
        "  require(moduleName);",
        "  if (singletonModules.has(candidate)) {",
        "    require(candidate);",
        "  }",
        "}",
        "function shadowsSet(singletonModules: Set<string>, candidate: string) {",
        "  if (singletonModules.has(candidate)) {",
        "    require(candidate);",
        "  }",
        "}",
        "",
      ].join("\n"),
    );

    const warnings = [];
    const references = extractImports(context(rootDir), filePath, warnings);

    assert.deepEqual(references.map((reference) => [reference.kind, reference.specifier, reference.line]), [
      ["require", "./outer.js", 3],
    ]);
    assert.deepEqual(warnings, [{
      ruleId: "CELLFENCE_UNSUPPORTED_DYNAMIC_REQUIRE",
      severity: "warning",
      filePath: "src/app.ts",
      message: "computed require() cannot be resolved statically at line 5",
      details: { line: 5 },
    }, {
      ruleId: "CELLFENCE_UNSUPPORTED_DYNAMIC_REQUIRE",
      severity: "warning",
      filePath: "src/app.ts",
      message: "computed require() cannot be resolved statically at line 7",
      details: { line: 7 },
    }, {
      ruleId: "CELLFENCE_UNSUPPORTED_DYNAMIC_REQUIRE",
      severity: "warning",
      filePath: "src/app.ts",
      message: "computed require() cannot be resolved statically at line 12",
      details: { line: 12 },
    }]);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("module resolution does not resolve an outer singleton Set through an inner lexical binding", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-module-singleton-set-shadow-"));
  try {
    fs.mkdirSync(path.join(rootDir, "src"), { recursive: true });
    const filePath = path.join(rootDir, "src/app.ts");
    fs.writeFileSync(filePath, [
      "const singletonModules = new Set(['chalk']);",
      "export function load(candidate: string) {",
      "  const singletonModules = new Set<string>();",
      "  if (singletonModules.has(candidate)) return require(candidate);",
      "}",
      "",
    ].join("\n"));

    const warnings = [];
    assert.deepEqual(extractImports(context(rootDir), filePath, warnings), []);
    assert.deepEqual(warnings, [{
      ruleId: "CELLFENCE_UNSUPPORTED_DYNAMIC_REQUIRE",
      severity: "warning",
      filePath: "src/app.ts",
      message: "computed require() cannot be resolved statically at line 4",
      details: { line: 4 },
    }]);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("module resolution resolves a readonly singleton Set guard for direct return require only", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-module-singleton-set-guard-"));
  try {
    fs.mkdirSync(path.join(rootDir, "src"), { recursive: true });
    const filePath = path.join(rootDir, "src/app.ts");
    fs.writeFileSync(
      filePath,
      [
        "const singletonModules = new Set(['chalk']);",
        "const mutatedModules = new Set(['left-pad']);",
        "const multiModules = new Set(['alpha', 'beta']);",
        "mutatedModules.add('escape');",
        "export function safe(candidate: string) {",
        "  if (singletonModules.has(candidate)) {",
        "    return require(candidate);",
        "  }",
        "  return undefined;",
        "}",
        "export function unsafeMutation(candidate: string) {",
        "  if (mutatedModules.has(candidate)) {",
        "    return require(candidate);",
        "  }",
        "}",
        "export function unsafeMulti(candidate: string) {",
        "  if (multiModules.has(candidate)) {",
        "    return require(candidate);",
        "  }",
        "}",
        "export function unsafeNonReturn(candidate: string) {",
        "  if (singletonModules.has(candidate)) {",
        "    require(candidate);",
        "  }",
        "}",
        "",
      ].join("\n"),
    );

    const warnings = [];
    const references = extractImports(context(rootDir), filePath, warnings);

    assert.deepEqual(references.map((reference) => [reference.kind, reference.specifier, reference.line]), [
      ["require", "chalk", 7],
    ]);
    assert.deepEqual(warnings, [{
      ruleId: "CELLFENCE_UNSUPPORTED_DYNAMIC_REQUIRE",
      severity: "warning",
      filePath: "src/app.ts",
      message: "computed require() cannot be resolved statically at line 13",
      details: { line: 13 },
    }, {
      ruleId: "CELLFENCE_UNSUPPORTED_DYNAMIC_REQUIRE",
      severity: "warning",
      filePath: "src/app.ts",
      message: "computed require() cannot be resolved statically at line 18",
      details: { line: 18 },
    }, {
      ruleId: "CELLFENCE_UNSUPPORTED_DYNAMIC_REQUIRE",
      severity: "warning",
      filePath: "src/app.ts",
      message: "computed require() cannot be resolved statically at line 23",
      details: { line: 23 },
    }]);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("module resolution refuses singleton Set guards when Set or has escapes", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-module-singleton-set-unsafe-"));
  try {
    fs.mkdirSync(path.join(rootDir, "src"), { recursive: true });
    const aliasPath = path.join(rootDir, "src/alias.ts");
    fs.writeFileSync(
      aliasPath,
      [
        "const singletonModules = new Set(['chalk']);",
        "const has = singletonModules.has;",
        "export function run(candidate: string) {",
        "  if (singletonModules.has(candidate)) {",
        "    return require(candidate);",
        "  }",
        "}",
        "",
      ].join("\n"),
    );
    const shadowPath = path.join(rootDir, "src/shadow.ts");
    fs.writeFileSync(
      shadowPath,
      [
        "class Set<T> {",
        "  constructor(values: T[]) {}",
        "  has(value: T): boolean { return true; }",
        "}",
        "const singletonModules = new Set(['chalk']);",
        "export function run(candidate: string) {",
        "  if (singletonModules.has(candidate)) {",
        "    return require(candidate);",
        "  }",
        "}",
        "",
      ].join("\n"),
    );
    const prototypePath = path.join(rootDir, "src/prototype.ts");
    fs.writeFileSync(
      prototypePath,
      [
        "Set.prototype.has = () => true;",
        "const singletonModules = new Set(['chalk']);",
        "export function run(candidate: string) {",
        "  if (singletonModules.has(candidate)) {",
        "    return require(candidate);",
        "  }",
        "}",
        "",
      ].join("\n"),
    );
    const prototypeElementPath = path.join(rootDir, "src/prototype-element.ts");
    fs.writeFileSync(
      prototypeElementPath,
      [
        "Set.prototype['has'] = () => true;",
        "const singletonModules = new Set(['chalk']);",
        "export function run(candidate: string) {",
        "  if (singletonModules.has(candidate)) {",
        "    return require(candidate);",
        "  }",
        "}",
        "",
      ].join("\n"),
    );

    for (const filePath of [aliasPath, shadowPath, prototypePath, prototypeElementPath]) {
      const warnings = [];
      assert.deepEqual(extractImports(context(rootDir), filePath, warnings), []);
      assert.equal(warnings.length, 1);
      assert.equal(warnings[0].ruleId, "CELLFENCE_UNSUPPORTED_DYNAMIC_REQUIRE");
    }
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("singleton Set guards reject every prototype assignment operator", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-module-set-assignment-"));
  try {
    fs.mkdirSync(path.join(rootDir, "src"), { recursive: true });
    const assignmentOperators = [
      "=", "+=", "-=", "*=", "**=", "/=", "%=", "<<=", ">>=", ">>>=", "&=", "|=", "^=", "&&=", "||=", "??=",
    ];
    for (const [index, operator] of assignmentOperators.entries()) {
      const filePath = path.join(rootDir, `src/operator-${index}.ts`);
      fs.writeFileSync(filePath, [
        `Set.prototype.has ${operator} (() => true);`,
        "const singletonModules = new Set(['chalk']);",
        "export function load(candidate: string) {",
        "  if (singletonModules.has(candidate)) return require(candidate);",
        "}",
        "",
      ].join("\n"));
      const warnings = [];
      assert.deepEqual(extractImports(context(rootDir), filePath, warnings), [], operator);
      assert.equal(warnings.length, 1, operator);
      assert.equal(warnings[0].ruleId, "CELLFENCE_UNSUPPORTED_DYNAMIC_REQUIRE", operator);
    }

    const nonAssignmentPath = path.join(rootDir, "src/non-assignment.ts");
    fs.writeFileSync(nonAssignmentPath, [
      "Set.prototype.has + (() => true);",
      "const singletonModules = new Set(['chalk']);",
      "export function load(candidate: string) {",
      "  if (singletonModules.has(candidate)) return require(candidate);",
      "}",
      "",
    ].join("\n"));
    assert.deepEqual(extractImports(context(rootDir), nonAssignmentPath, []), [{
      importerPath: "src/non-assignment.ts",
      specifier: "chalk",
      kind: "require",
      typeOnly: false,
      line: 4,
    }]);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("singleton Set prototype mutation detection distinguishes near misses", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-module-set-prototype-matrix-"));
  try {
    fs.mkdirSync(path.join(rootDir, "src"), { recursive: true });
    const cases = [
      ["positive", "Object.defineProperty(Set.prototype, 'has', { value: () => true });", false],
      ["reflect-define-property", "Reflect.defineProperty(Set.prototype, 'has', { value: () => true });", false],
      ["computed-define-property", "declare const propertyName: string; Object.defineProperty(Set.prototype, propertyName, {});", false],
      ["object-define-properties", "Object.defineProperties(Set.prototype, { has: { value: () => true } });", false],
      ["object-define-properties-mixed", "Object.defineProperties(Set.prototype, { size: {}, has: {} });", false],
      ["object-define-properties-computed", "Object.defineProperties(Set.prototype, { ['size']: {} });", true],
      ["object-define-properties-computed-unknown", "declare const propertyName: string; Object.defineProperties(Set.prototype, { [propertyName]: {} });", false],
      ["object-define-properties-spread", "declare const descriptors: object; Object.defineProperties(Set.prototype, { ...descriptors });", false],
      ["object-define-properties-other", "Object.defineProperties(Set.prototype, { size: { value: 1 } });", true],
      ["foreign-define-property", "declare const Namespace: any; Namespace['defineProperty'](Set['prototype'], 'has', {});", true],
      ["foreign-define-properties", "declare const Namespace: any; Namespace['defineProperties'](Set['prototype'], { has: {} });", true],
      ["wrong-prototype", "Object.defineProperty(Array.prototype, 'has', { value: () => true });", true],
      ["wrong-property", "Object.defineProperty(Set.prototype, 'size', { value: 1 });", true],
      ["too-few-arguments", "Object.defineProperty(Set.prototype);", true],
      ["define-properties-too-few-arguments", "Object.defineProperties(Set.prototype);", true],
    ];
    for (const [name, mutationSource, safe] of cases) {
      const filePath = path.join(rootDir, `src/${name}.ts`);
      fs.writeFileSync(filePath, [
        mutationSource,
        "const singletonModules = new Set(['chalk']);",
        "export function load(candidate: string) {",
        "  if (singletonModules.has(candidate)) return require(candidate);",
        "}",
        "",
      ].join("\n"));
      const warnings = [];
      const references = extractImports(context(rootDir), filePath, warnings);
      assert.deepEqual(references.map((reference) => reference.specifier), safe ? ["chalk"] : [], name);
      assert.equal(warnings.length, safe ? 0 : 1, name);
    }
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("singleton Set inference rejects invalid initializers and unsafe uses", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-module-set-initializer-matrix-"));
  try {
    fs.mkdirSync(path.join(rootDir, "src"), { recursive: true });
    const filePath = path.join(rootDir, "src/app.ts");
    fs.writeFileSync(filePath, [
      "declare const candidateValue: string;",
      "const safe = new Set(['safe-package']);",
      "const noArgument = new Set();",
      "const nonArray = new Set('chalk');",
      "const empty = new Set([]);",
      "const multiple = new Set(['one', 'two']);",
      "const computed = new Set([candidateValue]);",
      "const wrongConstructor = new WeakSet([{ name: 'chalk' }]);",
      "export function load(candidate: string) {",
      "  if (safe.has(candidate)) return require(candidate);",
      "  if (noArgument.has(candidate)) return require(candidate);",
      "  if (nonArray.has(candidate)) return require(candidate);",
      "  if (empty.has(candidate)) return require(candidate);",
      "  if (multiple.has(candidate)) return require(candidate);",
      "  if (computed.has(candidate)) return require(candidate);",
      "  if (wrongConstructor.has({ name: candidate })) return require(candidate);",
      "}",
      "",
    ].join("\n"));
    const warnings = [];
    const references = extractImports(context(rootDir), filePath, warnings);
    assert.deepEqual(references.map((reference) => [reference.specifier, reference.line]), [["safe-package", 10]]);
    assert.equal(warnings.length, 6);
    assert.equal(warnings.every((warning) => warning.ruleId === "CELLFENCE_UNSUPPORTED_DYNAMIC_REQUIRE"), true);

    const unsafeUsesPath = path.join(rootDir, "src/unsafe-uses.ts");
    fs.writeFileSync(unsafeUsesPath, [
      "const bySize = new Set(['size-package']);",
      "const outsideIf = new Set(['outside-package']);",
      "const compoundGuard = new Set(['compound-package']);",
      "void bySize.size;",
      "outsideIf.has(candidateValue);",
      "export function load(candidate: string) {",
      "  if (bySize.has(candidate)) return require(candidate);",
      "  if (outsideIf.has(candidate)) return require(candidate);",
      "  if (compoundGuard.has(candidate) && true) return require(candidate);",
      "}",
      "",
    ].join("\n"));
    const unsafeWarnings = [];
    assert.deepEqual(extractImports(context(rootDir), unsafeUsesPath, unsafeWarnings), []);
    assert.equal(unsafeWarnings.length, 3);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("singleton Set inference counts shadowing declaration forms", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-module-set-shadow-matrix-"));
  try {
    fs.mkdirSync(path.join(rootDir, "src"), { recursive: true });
    const shadowDeclarations = [
      "function probe(singletonModules: Set<string>) { return singletonModules; }",
      "function singletonModules() { return undefined; }",
      "class singletonModules {}",
      "import singletonModules from 'fixture';",
      "import * as singletonModules from 'fixture';",
      "import { value as singletonModules } from 'fixture';",
      "import singletonModules = require('fixture');",
      "try {} catch (singletonModules) { void singletonModules; }",
    ];
    for (const [index, shadowDeclaration] of shadowDeclarations.entries()) {
      const filePath = path.join(rootDir, `src/shadow-${index}.ts`);
      fs.writeFileSync(filePath, [
        "const singletonModules = new Set(['chalk']);",
        shadowDeclaration,
        "export function load(candidate: string) {",
        "  if (singletonModules.has(candidate)) return require(candidate);",
        "}",
        "",
      ].join("\n"));
      const warnings = [];
      assert.deepEqual(extractImports(context(rootDir), filePath, warnings).map((reference) => reference.specifier),
        shadowDeclaration.startsWith("import") ? ["fixture"] : [],
        shadowDeclaration);
      assert.equal(warnings.length, 1, shadowDeclaration);
    }
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("singleton Set inference rejects each unsafe reference shape independently", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-module-set-reference-shapes-"));
  try {
    fs.mkdirSync(path.join(rootDir, "src"), { recursive: true });
    const cases = [
      ["direct-alias", "const alias = singletonModules;"],
      ["wrong-method", "singletonModules.other(candidateValue);"],
      ["method-as-argument", "invoke(singletonModules.has);"],
      ["call-outside-if", "const observed = singletonModules.has(candidateValue);"],
    ];
    for (const [name, unsafeUse] of cases) {
      const filePath = path.join(rootDir, `src/${name}.ts`);
      fs.writeFileSync(filePath, [
        "declare const candidateValue: string;",
        "declare function invoke(value: unknown): void;",
        "const singletonModules = new Set(['chalk']);",
        unsafeUse,
        "export function load(candidate: string) {",
        "  if (singletonModules.has(candidate)) return require(candidate);",
        "}",
        "",
      ].join("\n"));
      const warnings = [];
      assert.deepEqual(extractImports(context(rootDir), filePath, warnings), [], name);
      assert.equal(warnings.length, 1, name);
    }

    const propertyNamePath = path.join(rootDir, "src/property-name.ts");
    fs.writeFileSync(propertyNamePath, [
      "declare const namespace: any;",
      "const has = new Set(['chalk']);",
      "void namespace.has;",
      "export function load(candidate: string) {",
      "  if (has.has(candidate)) return require(candidate);",
      "}",
      "",
    ].join("\n"));
    const propertyWarnings = [];
    assert.deepEqual(extractImports(context(rootDir), propertyNamePath, propertyWarnings), []);
    assert.equal(propertyWarnings.length, 1);

    const guardShapeCases = [
      ["callable-set", "if ((singletonModules)(candidate)) {}"],
      ["wrong-guard-method", "if (singletonModules.other(candidate)) {}"],
      ["method-as-guard-argument", "if (invoke(singletonModules.has)) {}"],
    ];
    for (const [name, unsafeGuard] of guardShapeCases) {
      const filePath = path.join(rootDir, `src/${name}.ts`);
      fs.writeFileSync(filePath, [
        "declare function invoke(value: unknown): boolean;",
        "const singletonModules = new Set(['chalk']);",
        "export function load(candidate: string) {",
        `  ${unsafeGuard}`,
        "  if (singletonModules.has(candidate)) return require(candidate);",
        "}",
        "",
      ].join("\n"));
      const warnings = [];
      assert.deepEqual(extractImports(context(rootDir), filePath, warnings), [], name);
      assert.equal(warnings.length, 1, name);
    }

    const propertyGuardPath = path.join(rootDir, "src/property-name-guard.ts");
    fs.writeFileSync(propertyGuardPath, [
      "declare const namespace: any;",
      "const has = new Set(['chalk']);",
      "export function load(candidate: string) {",
      "  if (namespace.has(candidate)) {}",
      "  if (has.has(candidate)) return require(candidate);",
      "}",
      "",
    ].join("\n"));
    const propertyGuardWarnings = [];
    assert.deepEqual(extractImports(context(rootDir), propertyGuardPath, propertyGuardWarnings), []);
    assert.equal(propertyGuardWarnings.length, 1);

    const textNearMissPath = path.join(rootDir, "src/text-near-miss.ts");
    fs.writeFileSync(textNearMissPath, [
      "const modules = new Set(['chalk']);",
      "void 'modules';",
      "export function load(candidate: string) {",
      "  if (modules.has(candidate)) return require(candidate);",
      "}",
      "",
    ].join("\n"));
    const textNearMissWarnings = [];
    assert.deepEqual(extractImports(context(rootDir), textNearMissPath, textNearMissWarnings).map((reference) => reference.specifier), ["chalk"]);
    assert.deepEqual(textNearMissWarnings, []);

    const stringReceiverPath = path.join(rootDir, "src/string-receiver.ts");
    fs.writeFileSync(stringReceiverPath, [
      "const modules = new Set(['chalk']);",
      "export function load(candidate: string) {",
      "  if (('modules' as any).has(candidate)) return require(candidate);",
      "}",
      "",
    ].join("\n"));
    const stringReceiverWarnings = [];
    assert.deepEqual(extractImports(context(rootDir), stringReceiverPath, stringReceiverWarnings), []);
    assert.equal(stringReceiverWarnings.length, 1);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("singleton Set inference distinguishes constructor and prototype near misses", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-module-set-near-misses-"));
  try {
    fs.mkdirSync(path.join(rootDir, "src"), { recursive: true });
    const invalidConstructors = [
      ["wrong-identifier", "new FakeSet(['fake-package'])"],
      ["property-constructor", "new Namespace.Set(['fake-package'])"],
      ["string-constructor", "new ('Set')(['fake-package'])"],
      ["missing-arguments", "new Set"],
      ["not-new", "Set(['fake-package'])"],
    ];
    for (const [name, initializer] of invalidConstructors) {
      const filePath = path.join(rootDir, `src/${name}.ts`);
      fs.writeFileSync(filePath, [
        `const singletonModules = ${initializer};`,
        "export function load(candidate: string) {",
        "  if (singletonModules.has(candidate)) return require(candidate);",
        "}",
        "",
      ].join("\n"));
      const warnings = [];
      assert.deepEqual(extractImports(context(rootDir), filePath, warnings), [], name);
      assert.equal(warnings.length, 1, name);
    }

    const nonMutations = [
      ["wrong-member", "Set.prototype.size = 0;"],
      ["wrong-receiver", "Array.prototype.has = () => true;"],
      ["wrong-prototype-member", "Set.notPrototype.has = () => true;"],
      ["plain-assignment", "arbitrary = () => true;"],
      ["define-wrong-member", "Object.defineProperty(Set.notPrototype, 'has', {});"],
      ["define-properties-other-member", "Object.defineProperties(Set.prototype, { size: {} });"],
      ["define-arbitrary", "Object.defineProperty(arbitrary, 'has', {});"],
      ["define-fake-method", "Object.fake(Set.prototype, 'has');"],
    ];
    for (const [name, source] of nonMutations) {
      const filePath = path.join(rootDir, `src/${name}.ts`);
      fs.writeFileSync(filePath, [
        source,
        "const singletonModules = new Set(['chalk']);",
        "export function load(candidate: string) {",
        "  if (singletonModules.has(candidate)) return require(candidate);",
        "}",
        "",
      ].join("\n"));
      const warnings = [];
      assert.deepEqual(
        extractImports(context(rootDir), filePath, warnings).filter((reference) => reference.kind === "require").map((reference) => reference.specifier),
        ["chalk"],
        name,
      );
      assert.deepEqual(warnings, [], name);
    }

    const twoArgumentMutationPath = path.join(rootDir, "src/two-argument-define.ts");
    fs.writeFileSync(twoArgumentMutationPath, [
      "Object.defineProperty(Set.prototype, 'has');",
      "const singletonModules = new Set(['chalk']);",
      "export function load(candidate: string) {",
      "  if (singletonModules.has(candidate)) return require(candidate);",
      "}",
      "",
    ].join("\n"));
    const mutationWarnings = [];
    assert.deepEqual(extractImports(context(rootDir), twoArgumentMutationPath, mutationWarnings), []);
    assert.equal(mutationWarnings.length, 1);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("singleton Set inference counts Set and candidate binding patterns", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-module-set-binding-patterns-"));
  try {
    fs.mkdirSync(path.join(rootDir, "src"), { recursive: true });
    const setDeclarations = [
      ["parameter", "function probe(Set: unknown) { return Set; }"],
      ["function", "function Set() { return undefined; }"],
      ["default-import", "import Set from 'fixture';"],
      ["namespace-import", "import * as Set from 'fixture';"],
      ["named-import", "import { value as Set } from 'fixture';"],
      ["import-equals", "import Set = require('fixture');"],
      ["catch-binding", "try {} catch (Set) { void Set; }"],
      ["object-binding", "const { Set } = source;"],
      ["array-binding", "const [, Set] = source;"],
    ];
    for (const [name, declaration] of setDeclarations) {
      const filePath = path.join(rootDir, `src/${name}.ts`);
      fs.writeFileSync(filePath, [
        declaration,
        "const singletonModules = new Set(['chalk']);",
        "export function load(candidate: string) {",
        "  if (singletonModules.has(candidate)) return require(candidate);",
        "}",
        "",
      ].join("\n"));
      const warnings = [];
      const references = extractImports(context(rootDir), filePath, warnings);
      assert.deepEqual(references.filter((reference) => reference.kind === "require" && reference.specifier === "chalk"), [], name);
      assert.equal(warnings.some((warning) => warning.ruleId === "CELLFENCE_UNSUPPORTED_DYNAMIC_REQUIRE"), true, name);
    }

    const anonymousDeclarations = [
      ["anonymous-function", "export default function () {}"],
      ["anonymous-class", "export default class {}"],
    ];
    for (const [name, declaration] of anonymousDeclarations) {
      const filePath = path.join(rootDir, `src/${name}.ts`);
      fs.writeFileSync(filePath, [
        declaration,
        "const singletonModules = new Set(['chalk']);",
        "export function load(candidate: string) {",
        "  if (singletonModules.has(candidate)) return require(candidate);",
        "}",
        "",
      ].join("\n"));
      const warnings = [];
      assert.deepEqual(extractImports(context(rootDir), filePath, warnings).map((reference) => reference.specifier), ["chalk"], name);
      assert.deepEqual(warnings, [], name);
    }

    const duplicateBindings = [
      ["identifier", "{ const singletonModules = new Set(['other']); }"],
      ["object", "{ const { singletonModules } = source; }"],
      ["array", "{ const [, singletonModules] = source; }"],
    ];
    for (const [name, declaration] of duplicateBindings) {
      const filePath = path.join(rootDir, `src/duplicate-${name}.ts`);
      fs.writeFileSync(filePath, [
        "const singletonModules = new Set(['chalk']);",
        declaration,
        "export function load(candidate: string) {",
        "  if (singletonModules.has(candidate)) return require(candidate);",
        "}",
        "",
      ].join("\n"));
      const warnings = [];
      assert.deepEqual(extractImports(context(rootDir), filePath, warnings), [], name);
      assert.equal(warnings.length, 1, name);
    }
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("binding patterns and builtin names do not manufacture require-like calls", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-module-binding-pattern-shadow-"));
  try {
    fs.mkdirSync(path.join(rootDir, "src"), { recursive: true });
    const filePath = path.join(rootDir, "src/app.ts");
    fs.writeFileSync(filePath, [
      "const req = require;",
      "function setShadow() { const req = new Set(['chalk']); req('./not-require-set.js'); }",
      "function objectShadow({ require }: { require(value: string): void }) { require('./not-object.js'); }",
      "function arrayShadow([, require]: Array<(value: string) => void>) { require('./not-array.js'); }",
      "function moduleShadow({ module }: { module: { require(value: string): void } }) { module.require('./not-module.js'); }",
      "other.require('./not-builtin-module.js');",
      "",
    ].join("\n"));
    const warnings = [];
    assert.deepEqual(extractImports(context(rootDir), filePath, warnings), []);
    assert.deepEqual(warnings, []);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("shadowed globals and var-scoped constants do not escape their lexical semantics", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-module-shadow-builtins-"));
  try {
    fs.mkdirSync(path.join(rootDir, "src"), { recursive: true });
    const filePath = path.join(rootDir, "src/app.ts");
    fs.writeFileSync(filePath, [
      "const process = 'shadow';",
      "const Reflect = 'shadow';",
      "process.mainModule.require('./not-process.js');",
      "Reflect.apply(require, null, ['./not-reflect.js']);",
      "export function load() {",
      "  { var req = require; }",
      "  return req('./var-scoped.js');",
      "}",
      "",
    ].join("\n"));
    const warnings = [];
    assert.deepEqual(extractImports(context(rootDir), filePath, warnings).map((reference) => reference.specifier), ["./var-scoped.js"]);
    assert.deepEqual(warnings, []);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("module resolution keeps lexical constant module specifiers inside loop and switch scopes", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-module-constant-lexical-scope-"));
  try {
    fs.mkdirSync(path.join(rootDir, "src"), { recursive: true });
    const filePath = path.join(rootDir, "src/app.ts");
    fs.writeFileSync(
      filePath,
      [
        "declare const dynamicName: string;",
        "for (const moduleName = './loop.js'; false;) {",
        "  require(moduleName);",
        "}",
        "require(moduleName);",
        "switch (dynamicName) {",
        "  case 'x': {",
        "    const switchName = './switch.js';",
        "    require(switchName);",
        "    break;",
        "  }",
        "}",
        "require(switchName);",
        "switch (dynamicName) {",
        "  case require('./case-expression.js'):",
        "    break;",
        "}",
        "",
      ].join("\n"),
    );

    const warnings = [];
    const references = extractImports(context(rootDir), filePath, warnings);

    assert.deepEqual(references.map((reference) => [reference.kind, reference.specifier, reference.line]), [
      ["require", "./loop.js", 3],
      ["require", "./switch.js", 9],
      ["require", "./case-expression.js", 15],
    ]);
    assert.deepEqual(warnings, [{
      ruleId: "CELLFENCE_UNSUPPORTED_DYNAMIC_REQUIRE",
      severity: "warning",
      filePath: "src/app.ts",
      message: "computed require() cannot be resolved statically at line 5",
      details: { line: 5 },
    }, {
      ruleId: "CELLFENCE_UNSUPPORTED_DYNAMIC_REQUIRE",
      severity: "warning",
      filePath: "src/app.ts",
      message: "computed require() cannot be resolved statically at line 13",
      details: { line: 13 },
    }]);
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
        "type Invalid = import(123).Missing;",
        "type InvalidIdentifier = import(Foo).Missing;",
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
    assert.deepEqual(warnings, [{
      ruleId: "CELLFENCE_UNSUPPORTED_TYPESCRIPT_SYNTAX",
      severity: "warning",
      filePath: "src/broken.ts",
      message: "TypeScript source cannot be parsed statically at line 1: Expression expected.",
      details: { line: 1, offset: 16 },
    }]);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("module resolution preserves nested TypeScript diagnostic message boundaries", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-module-diagnostic-chain-"));
  try {
    fs.mkdirSync(path.join(rootDir, "src"), { recursive: true });
    const filePath = path.join(rootDir, "src/broken.ts");
    fs.writeFileSync(filePath, "");
    const sourceFile = ts.createSourceFile(filePath, "", ts.ScriptTarget.Latest, true);
    sourceFile.parseDiagnostics = [{
      file: sourceFile,
      start: 0,
      length: 0,
      category: ts.DiagnosticCategory.Error,
      code: 9999,
      messageText: {
        messageText: "Outer diagnostic",
        category: ts.DiagnosticCategory.Error,
        code: 9999,
        next: [{
          messageText: "Inner detail",
          category: ts.DiagnosticCategory.Error,
          code: 9998,
        }],
      },
    }];
    const scanContext = context(rootDir);
    scanContext.sourceFileCache.set(path.resolve(filePath), sourceFile);
    const warnings = [];

    assert.deepEqual(extractImports(scanContext, filePath, warnings), []);
    assert.equal(
      warnings[0].message,
      "TypeScript source cannot be parsed statically at line 1: Outer diagnostic\n  Inner detail",
    );
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
    assert.deepEqual(references, [{
      importerPath: "src/app/public.py",
      specifier: "importlib",
      candidateSpecifiers: undefined,
      kind: "import",
      typeOnly: false,
      line: 1,
    }]);
    assert.deepEqual(warnings, [{
      ruleId: "CELLFENCE_UNSUPPORTED_DYNAMIC_IMPORT",
      severity: "warning",
      filePath: "src/app/public.py",
      message: "computed Python importlib.import_module cannot be resolved statically at line 3",
      details: { kind: "dynamic_import", line: 3 },
    }, {
      ruleId: "CELLFENCE_UNSUPPORTED_DYNAMIC_IMPORT",
      severity: "warning",
      filePath: "src/app/public.py",
      message: "computed Python exec cannot be resolved statically at line 4",
      details: { kind: "dynamic_import", line: 4 },
    }]);
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
    const errors = [];
    assert.deepEqual(extractImports(context(rootDir), filePath, warnings, errors), []);
    const [syntaxError] = inspectPythonSource(filePath).errors;
    assert.deepEqual(
      { kind: syntaxError.kind, line: syntaxError.line, offset: syntaxError.offset },
      { kind: "syntax_error", line: 1, offset: 9 },
    );
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0].ruleId, "CELLFENCE_UNSUPPORTED_PYTHON_SYNTAX");
    assert.equal(warnings[0].severity, "warning");
    assert.equal(warnings[0].filePath, "src/core/template.py");
    assert.equal(warnings[0].message, `Python source cannot be parsed statically at line 1: ${syntaxError.message}`);
    assert.deepEqual(warnings[0].details, { kind: "syntax_error", line: 1, offset: 9 });
    assert.deepEqual(errors, []);
    assert.deepEqual([...extractPublicSymbols(filePath)], []);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("module resolution preserves Python read errors without inventing source positions", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-python-read-error-"));
  try {
    fs.mkdirSync(path.join(rootDir, "src/core"), { recursive: true });
    const filePath = path.join(rootDir, "src/core/invalid-encoding.py");
    fs.writeFileSync(filePath, Buffer.from([0xff, 0xfe, 0xfd]));

    const warnings = [];
    assert.deepEqual(extractImports(context(rootDir), filePath, warnings), []);
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0].ruleId, "CELLFENCE_UNSUPPORTED_PYTHON_SYNTAX");
    assert.equal(warnings[0].severity, "warning");
    assert.equal(warnings[0].filePath, "src/core/invalid-encoding.py");
    assert.deepEqual(warnings[0].details, { kind: "read_error" });
    assert.match(warnings[0].message, /^Python source cannot be parsed statically: /);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("module resolution routes Python inspector failures to the error lane", { skip: process.platform === "win32" }, () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-python-inspector-error-"));
  try {
    const filePath = path.join(rootDir, "src/core/public.py");
    const emptyBin = path.join(rootDir, "bin");
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.mkdirSync(emptyBin);
    fs.writeFileSync(filePath, "PUBLIC = True\n");

    const moduleUrl = new URL("../packages/engine/dist/module-resolution.js", import.meta.url).href;
    const script = [
      `import { extractImports } from ${JSON.stringify(moduleUrl)};`,
      `const rootDir = ${JSON.stringify(rootDir)};`,
      `const filePath = ${JSON.stringify(filePath)};`,
      "const warnings = [];",
      "const errors = [];",
      "const references = extractImports({ rootDir, manifest: { schemaVersion: 'cellfence.manifest.v1', cells: [] }, sourceFilesForCellCache: new Map(), sourceTextCache: new Map(), sourceFileCache: new Map() }, filePath, warnings, errors);",
      "console.log(JSON.stringify({ references, warnings, errors }));",
    ].join("\n");
    const result = spawnSync(process.execPath, ["--input-type=module", "--eval", script], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: { ...process.env, PATH: emptyBin },
    });

    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.deepEqual(output.references, []);
    assert.deepEqual(output.warnings, []);
    assert.equal(output.errors.length, 1);
    assert.equal(output.errors[0].ruleId, "CELLFENCE_UNSUPPORTED_PYTHON_SYNTAX");
    assert.equal(output.errors[0].severity, "error");
    assert.equal(output.errors[0].filePath, "src/core/public.py");
    assert.equal(output.errors[0].details.kind, "inspector_error");
    assert.match(output.errors[0].message, /^Python source cannot be parsed statically: /);
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

test("module resolution public surface hashes declaration re-exports without declaration emit", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-module-public-dts-"));
  try {
    fs.mkdirSync(path.join(rootDir, "src/core"), { recursive: true });
    const publicPath = path.join(rootDir, "src/core/public.ts");
    const apiPath = path.join(rootDir, "src/core/api.d.ts");
    fs.writeFileSync(publicPath, "export * from './api';\n");
    fs.writeFileSync(
      apiPath,
      [
        "/** public docs */",
        "export interface Api { /** property docs */ readonly name: string }",
        "/** @internal */",
        "export interface Hidden { value: string }",
        "",
      ].join("\n"),
    );

    assert.equal(extractPublicSymbols(publicPath).has("Api"), true);
    const firstHash = publicSurfaceHash(publicPath);
    assert.match(firstHash, /^[a-f0-9]{64}$/);

    fs.writeFileSync(
      apiPath,
      [
        "/** changed public docs */",
        "export interface Api { /** changed property docs */ readonly name: string }",
        "/** @internal */",
        "export interface Hidden { value: number }",
        "",
      ].join("\n"),
    );
    assert.equal(publicSurfaceHash(publicPath), firstHash);

    fs.writeFileSync(apiPath, "export interface Api { readonly name: string; readonly version: string }\n");
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
    assert.deepEqual(syntaxPublicSurfaceSignatureParts(inferredPath), expectedParts);
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
        "export const { alpha, nested: { beta }, alias: gamma } = source;",
        "export const [, delta] = items;",
        "export namespace API { export const flag = true; }",
        "export import legacy = require('./legacy.js');",
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
      "alpha",
      "beta",
      "default",
      "delta",
      "exposed",
      "gamma",
      "helper",
      "legacy",
      "run",
      "tools",
      "value",
    ]);

    const externalPath = path.join(rootDir, "src/core/external.ts");
    fs.writeFileSync(externalPath, "export const shouldStayPrivate = true;\n");
    const packageOnlyPath = path.join(rootDir, "src/core/package-only.ts");
    fs.writeFileSync(packageOnlyPath, "export * from 'external';\n");
    assert.deepEqual([...extractPublicSymbols(packageOnlyPath)], []);
    const packageDirectoryPath = path.join(rootDir, "src/core/package-directory.ts");
    fs.writeFileSync(packageDirectoryPath, "export * from 'external/';\n");
    fs.mkdirSync(path.join(rootDir, "src/core/external"));
    fs.writeFileSync(path.join(rootDir, "src/core/external/index.ts"), "export const shouldAlsoStayPrivate = true;\n");
    assert.deepEqual([...extractPublicSymbols(packageDirectoryPath)], []);

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
    fs.writeFileSync(publicPath, "export function () { return 1; }\nexport module \"\" {}\nexport *;\nexport const valid = true;\n");
    assert.deepEqual([...extractPublicSymbols(publicPath)], ["valid"]);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("module resolution syntax surface parts encode every supported declaration form deterministically", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-module-syntax-surface-"));
  try {
    fs.mkdirSync(path.join(rootDir, "src/core"), { recursive: true });
    const publicPath = path.join(rootDir, "src/core/public.ts");
    fs.writeFileSync(publicPath, [
      "export namespace API { export const flag = true; }",
      "export default function run(value: string, count: number): boolean { return value.length === count; }",
      "export default class {}",
      "export default 1;",
      "export function loose(value): void {}",
      "export function () {}",
      "export class {}",
      "export module \"\" {}",
      "export class Box { value: number = 1; }",
      "export interface Shape { name:   string; }",
      "export type Mode = 'a' | 'b';",
      "export enum Rank { One = 1 }",
      "export const { alpha, nested: { beta } } = source;",
      "export import legacy = require('./legacy.js');",
      "const local = true;",
      "export { local as exposed };",
      "export * as tools from './tools.js';",
      "export * from './more.js';",
      "",
    ].join("\n"));

    assert.deepEqual(syntaxPublicSurfaceSignatureParts(publicPath), [
      "ClassDeclaration:Box:export class Box { value: number = 1; }",
      "ClassDeclaration:default:export default class {}",
      "EnumDeclaration:Rank:export enum Rank { One = 1 }",
      "export-import:legacy:require('./legacy.js')",
      "export-star:./more.js",
      "export:default",
      "export:exposed",
      "function:default(value:string,count:number):boolean",
      "function:loose(value:):void",
      "InterfaceDeclaration:Shape:export interface Shape { name: string; }",
      "namespace:API:export namespace API { export const flag = true; }",
      "namespace:tools",
      "TypeAliasDeclaration:Mode:export type Mode = 'a' | 'b';",
      "variable:alpha:",
      "variable:beta:",
    ].sort((left, right) => left.localeCompare(right)));
    assert.deepEqual(syntaxPublicSurfaceSignatureParts(path.join(rootDir, "src/core/missing.ts")), []);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("module resolution declaration compiler options preserve project settings and force safe emit settings", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-module-declaration-options-"));
  try {
    fs.mkdirSync(path.join(rootDir, "src"), { recursive: true });
    const filePath = path.join(rootDir, "src/public.ts");
    fs.writeFileSync(filePath, "export const value = true;\n");
    const expectedDefaults = {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
      jsx: ts.JsxEmit.ReactJSX,
      strict: false,
      skipLibCheck: true,
    };
    const forced = {
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
    const pickOptions = (options) => ({
      target: options.target,
      module: options.module,
      moduleResolution: options.moduleResolution,
      jsx: options.jsx,
      strict: options.strict,
      skipLibCheck: options.skipLibCheck,
    });
    assert.deepEqual(pickOptions(declarationEmitCompilerOptions(filePath)), expectedDefaults);

    fs.writeFileSync(path.join(rootDir, "tsconfig.json"), "{");
    assert.deepEqual(pickOptions(declarationEmitCompilerOptions(filePath)), expectedDefaults);

    writeJson(path.join(rootDir, "tsconfig.json"), {
      compilerOptions: {
        target: "ES5",
        module: "CommonJS",
        moduleResolution: "Node10",
        jsx: "preserve",
        strict: true,
        skipLibCheck: false,
        allowJs: false,
        checkJs: true,
        declaration: false,
        declarationMap: true,
        emitDeclarationOnly: false,
        inlineSourceMap: true,
        noEmit: true,
        noEmitOnError: true,
        newLine: "crlf",
        removeComments: false,
        sourceMap: true,
        stripInternal: false,
        incremental: true,
        tsBuildInfoFile: "cache.tsbuildinfo",
        baseUrl: "./types",
      },
    });
    const options = declarationEmitCompilerOptions(filePath);
    assert.deepEqual(pickOptions(options), {
      target: ts.ScriptTarget.ES5,
      module: ts.ModuleKind.CommonJS,
      moduleResolution: ts.ModuleResolutionKind.Node10,
      jsx: ts.JsxEmit.Preserve,
      strict: true,
      skipLibCheck: false,
    });
    assert.equal(options.incremental, true);
    assert.equal(path.normalize(options.baseUrl), path.normalize(path.join(rootDir, "types")));
    assert.deepEqual(Object.fromEntries(Object.keys(forced).map((key) => [key, options[key]])), forced);

    const boundaryRoot = path.join(rootDir, "boundary");
    fs.mkdirSync(path.join(boundaryRoot, ".git"), { recursive: true });
    fs.mkdirSync(path.join(boundaryRoot, "src"));
    const boundaryFile = path.join(boundaryRoot, "src/public.ts");
    fs.writeFileSync(boundaryFile, "export const boundary = true;\n");
    assert.deepEqual(pickOptions(declarationEmitCompilerOptions(boundaryFile)), expectedDefaults);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("module resolution declaration roots follow only public type edges in deterministic DFS order", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-module-declaration-roots-"));
  try {
    fs.mkdirSync(path.join(rootDir, "src"), { recursive: true });
    const publicPath = path.join(rootDir, "src/public.ts");
    fs.writeFileSync(publicPath, [
      "export * from './z.js';",
      "import type { A } from './a.js';",
      "import { type C, Runtime } from './c.js';",
      "import type B from './b.js';",
      "import './side.js';",
      "import D from './d.js';",
      "import * as ns from './ns.js';",
      "import type { External } from 'external';",
      "export * from 'external';",
      "",
    ].join("\n"));
    fs.writeFileSync(path.join(rootDir, "src/z.ts"), "export * from './b.js';\nexport * from './public.js';\n");
    for (const name of ["a", "b", "c", "d", "ns", "side"]) {
      fs.writeFileSync(path.join(rootDir, `src/${name}.ts`), `export interface ${name.toUpperCase()} { value: string }\n`);
    }

    assert.deepEqual(
      collectPublicDeclarationRoots(publicPath).map((filePath) => path.relative(rootDir, filePath).split(path.sep).join("/")),
      ["src/public.ts", "src/z.ts", "src/b.ts", "src/a.ts", "src/c.ts"],
    );
    assert.deepEqual(collectPublicDeclarationRoots(path.join(rootDir, "src/missing.ts")), []);
    assert.deepEqual(collectPublicDeclarationRoots(publicPath, new Set([path.resolve(publicPath)])), []);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("module resolution declaration text strips docs and internal declarations", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-module-declaration-text-"));
  try {
    const declarationPath = path.join(rootDir, "api.d.ts");
    fs.writeFileSync(declarationPath, [
      "/** @deprecated use NextPublic */",
      "export interface Public {",
      "  /** docs */ value: string;",
      "  /** @internal */ hidden: number;",
      "}",
      "/** @internal */",
      "export interface Hidden { secret: boolean }",
      "",
    ].join("\r\n"));
    assert.equal(declarationTextForRoot(declarationPath, {}), "export interface Public {\n    value: string;\n}\n");

    const sourcePath = path.join(rootDir, "api.ts");
    fs.writeFileSync(sourcePath, [
      "/** @internal */ export const hidden = true;",
      "export function visible(value: string): string { return value; }",
      "",
    ].join("\n"));
    assert.equal(
      declarationTextForRoot(sourcePath, { declaration: true, emitDeclarationOnly: true, stripInternal: true }),
      "export declare function visible(value: string): string;\n",
    );
    assert.equal(declarationTextForRoot(path.join(rootDir, "missing.ts"), {}), "");
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("module resolution declaration parts use relative-key order and syntax fallback", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-module-declaration-order-"));
  try {
    fs.mkdirSync(path.join(rootDir, "a"), { recursive: true });
    fs.mkdirSync(path.join(rootDir, "z"), { recursive: true });
    writeJson(path.join(rootDir, "tsconfig.json"), {
      compilerOptions: { baseUrl: ".", paths: { "@z/*": ["z/*"] } },
    });
    const publicPath = path.join(rootDir, "a/public.ts");
    fs.writeFileSync(publicPath, "export * from '@z/zeta';\nexport * from './alpha.js';\n");
    fs.writeFileSync(path.join(rootDir, "a/alpha.ts"), "export interface Alpha { value: string }\n");
    fs.writeFileSync(path.join(rootDir, "z/zeta.ts"), "export interface Zeta { value: number }\n");
    assert.deepEqual(declarationPublicSurfaceSignatureParts(publicPath), [
      "dts:export interface Zeta {\nvalue: number;\n}",
      "dts:export interface Alpha {\nvalue: string;\n}",
      "dts:export * from '@z/zeta';\nexport * from './alpha.js';",
    ]);

    const fallbackPath = path.join(rootDir, "a/fallback.d.ts");
    fs.writeFileSync(fallbackPath, "/** @internal */\nexport interface Hidden { value: string }\n");
    const fallbackParts = ["InterfaceDeclaration:Hidden:export interface Hidden { value: string }"];
    assert.deepEqual(declarationPublicSurfaceSignatureParts(fallbackPath), []);
    assert.equal(publicSurfaceHash(fallbackPath), sha256(fallbackParts.join("\n")));

    const emptyPath = path.join(rootDir, "a/empty.ts");
    fs.writeFileSync(emptyPath, "");
    assert.deepEqual(declarationPublicSurfaceSignatureParts(emptyPath), ["dts:export {};"]);
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
    assert.deepEqual(declarationPublicSurfaceSignatureParts(publicPath), expectedParts);
    assert.equal(publicSurfaceHash(publicPath), sha256(expectedParts.join("\n")));
    assert.deepEqual(declarationPublicSurfaceSignatureParts(path.join(rootDir, "src/core/missing.ts")), []);
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
