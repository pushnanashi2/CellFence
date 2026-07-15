import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import ts from "typescript";

import {
  SOURCE_EXTENSIONS,
  literalPrefix,
  listFiles,
  matchesPattern,
  normalizePath,
  parseSourceFile,
  pathOwnedByCell,
  pathIsGoverned,
  patternCoveredByOwnedPaths,
  readSourceText,
  sourceFilesUnderGovernance,
  sourceFilesForCell,
  sourceKindForPath,
} from "../packages/engine/dist/file-index.js";

test("file index matches single-star patterns and scans a cell without a context cache", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-file-index-"));
  try {
    fs.mkdirSync(path.join(rootDir, "src/core"), { recursive: true });
    fs.mkdirSync(path.join(rootDir, "src/core/nested"), { recursive: true });
    fs.writeFileSync(path.join(rootDir, "src/core/public.ts"), "export const api = true;\n");
    fs.writeFileSync(path.join(rootDir, "src/core/nested/private.ts"), "export const hidden = true;\n");
    fs.writeFileSync(path.join(rootDir, "src/core/readme.md"), "# ignored\n");

    assert.equal(matchesPattern("src/core/public.ts", "src/*/public.ts"), true);
    assert.equal(matchesPattern("src/core/nested/private.ts", "src/*/public.ts"), false);
    assert.equal(literalPrefix("src/core/public.ts"), "src/core/public.ts");

    const files = sourceFilesForCell(rootDir, {
      id: "core",
      ownedPaths: ["src/core/**"],
      publicEntry: "src/core/public.ts",
      publicSymbols: ["api"],
      consumes: [],
      producesArtifacts: [],
    }).map((filePath) => path.relative(rootDir, filePath).split(path.sep).join("/"));

    assert.deepEqual(files, [
      "src/core/nested/private.ts",
      "src/core/public.ts",
    ]);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("file index covers governance defaults, ownership helpers, and parse caches", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-file-index-helpers-"));
  try {
    fs.mkdirSync(path.join(rootDir, "src/core"), { recursive: true });
    fs.mkdirSync(path.join(rootDir, "src/other"), { recursive: true });
    fs.writeFileSync(path.join(rootDir, "src/core/view.tsx"), "export const view = <div />;\n");
    fs.writeFileSync(path.join(rootDir, "src/core/component.jsx"), "export const component = true;\n");
    fs.writeFileSync(path.join(rootDir, "src/other/ignored.ts"), "export const ignored = true;\n");

    const manifest = {
      schemaVersion: "cellfence.manifest.v1",
      governance: { requireOwnership: true },
      cells: [{
        id: "core",
        ownedPaths: ["src/core/**"],
        publicEntry: "src/core/view.tsx",
        publicSymbols: ["view"],
        consumes: [],
        producesArtifacts: [],
      }, {
        id: "empty",
        ownedPaths: ["src/empty/**"],
        publicEntry: "src/empty/public.ts",
        publicSymbols: [],
        consumes: [],
        producesArtifacts: [],
      }],
    };
    const context = {
      rootDir,
      manifest,
      sourceFilesForCellCache: new Map(),
      sourceTextCache: new Map(),
      sourceFileCache: new Map(),
    };

    assert.deepEqual(sourceFilesUnderGovernance(rootDir, manifest, context), []);
    assert.equal(pathIsGoverned(manifest, "src/core/view.tsx"), false);
    assert.equal(pathIsGoverned({ ...manifest, governance: undefined }, "src/core/view.tsx"), false);
    assert.deepEqual(sourceFilesForCell(rootDir, manifest.cells[1], context), []);
    assert.deepEqual(sourceFilesForCell(rootDir, {
      id: "unknown",
      ownedPaths: ["src/unknown/**"],
      publicEntry: "src/unknown/public.ts",
      publicSymbols: [],
      consumes: [],
      producesArtifacts: [],
    }, context), []);
    assert.equal(patternCoveredByOwnedPaths("", ["src/core/**"]), false);
    assert.equal(patternCoveredByOwnedPaths("src/core/view.tsx", ["src/core/**"]), true);
    assert.equal(sourceKindForPath("src/core/view.tsx"), 4);
    assert.equal(sourceKindForPath("src/core/component.jsx"), 2);

    const viewPath = path.join(rootDir, "src/core/view.tsx");
    assert.equal(readSourceText(context, viewPath), readSourceText(context, viewPath));
    assert.equal(parseSourceFile(context, viewPath), parseSourceFile(context, viewPath));
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("file index exposes the full supported source extension set", () => {
  assert.deepEqual(SOURCE_EXTENSIONS, [
    ".ts",
    ".tsx",
    ".js",
    ".jsx",
    ".mts",
    ".cts",
    ".mjs",
    ".cjs",
  ]);
});

test("file index glob matching distinguishes single-star, double-star, and literals", () => {
  assert.equal(matchesPattern("src/core/public.ts", "src/*/public.ts"), true);
  assert.equal(matchesPattern("src/public.ts", "src/**/public.ts"), false);
  assert.equal(matchesPattern("src/core/nested/public.ts", "src/*/public.ts"), false);
  assert.equal(matchesPattern("src/core/nested/public.ts", "src/**/public.ts"), true);
  assert.equal(matchesPattern("src/core/public.ts", "src/**/*.ts"), true);
  assert.equal(matchesPattern("src/core/public.ts", "src/**/private.ts"), false);
  assert.equal(matchesPattern("src/core/public.ts", "src/core/public.ts"), true);
  assert.equal(matchesPattern("src/core/public.ts", "src/core/public.js"), false);

  assert.equal(literalPrefix("src/core/*.ts"), "src/core");
  assert.equal(literalPrefix("src/core///**"), "src/core");
  assert.equal(literalPrefix("src/core/public.ts"), "src/core/public.ts");
});

test("file index listFiles sorts results, ignores generated directories, and caches per context", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-list-files-"));
  try {
    for (const directory of [
      "src/core",
      "node_modules/pkg",
      ".git/hooks",
      "dist",
      "coverage",
      ".turbo",
    ]) {
      fs.mkdirSync(path.join(rootDir, directory), { recursive: true });
    }
    fs.writeFileSync(path.join(rootDir, "src/core/z.ts"), "export const z = true;\n");
    fs.writeFileSync(path.join(rootDir, "src/core/a.ts"), "export const a = true;\n");
    fs.writeFileSync(path.join(rootDir, "node_modules/pkg/index.ts"), "export const ignored = true;\n");
    fs.writeFileSync(path.join(rootDir, ".git/hooks/pre-commit.ts"), "export const ignored = true;\n");
    fs.writeFileSync(path.join(rootDir, "dist/out.ts"), "export const ignored = true;\n");
    fs.writeFileSync(path.join(rootDir, "coverage/out.ts"), "export const ignored = true;\n");
    fs.writeFileSync(path.join(rootDir, ".turbo/out.ts"), "export const ignored = true;\n");
    fs.symlinkSync(path.join(rootDir, "src/core/a.ts"), path.join(rootDir, "src/core/link.ts"));

    const context = {
      rootDir,
      manifest: {
        schemaVersion: "cellfence.manifest.v1",
        cells: [],
      },
      sourceFilesForCellCache: new Map(),
      sourceTextCache: new Map(),
      sourceFileCache: new Map(),
    };

    const first = listFiles(rootDir, context).map((filePath) => normalizePath(path.relative(rootDir, filePath)));
    assert.deepEqual(first, ["src/core/a.ts", "src/core/z.ts"]);

    fs.writeFileSync(path.join(rootDir, "src/core/new.ts"), "export const fresh = true;\n");
    const cached = listFiles(rootDir, context).map((filePath) => normalizePath(path.relative(rootDir, filePath)));
    assert.deepEqual(cached, first);

    const uncached = listFiles(rootDir).map((filePath) => normalizePath(path.relative(rootDir, filePath)));
    assert.deepEqual(uncached, ["src/core/a.ts", "src/core/new.ts", "src/core/z.ts"]);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("file index sorting is deterministic even when filesystem order is not", () => {
  const originalReaddirSync = fs.readdirSync;
  try {
    fs.readdirSync = () => [
      {
        name: "z.ts",
        isDirectory: () => false,
        isFile: () => true,
      },
      {
        name: "a.ts",
        isDirectory: () => false,
        isFile: () => true,
      },
    ];

    assert.deepEqual(listFiles("/repo").map(normalizePath), ["/repo/a.ts", "/repo/z.ts"]);
  } finally {
    fs.readdirSync = originalReaddirSync;
  }
});

test("file index source files are indexed by any owned path and cached per context", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-source-index-"));
  try {
    fs.mkdirSync(path.join(rootDir, "src/core"), { recursive: true });
    fs.mkdirSync(path.join(rootDir, "src/addon"), { recursive: true });
    fs.mkdirSync(path.join(rootDir, "src/other"), { recursive: true });
    fs.writeFileSync(path.join(rootDir, "src/core/b.ts"), "export const b = true;\n");
    fs.writeFileSync(path.join(rootDir, "src/core/a.ts"), "export const a = true;\n");
    fs.writeFileSync(path.join(rootDir, "src/addon/x.ts"), "export const x = true;\n");
    fs.writeFileSync(path.join(rootDir, "src/core/readme.md"), "# ignored\n");
    fs.writeFileSync(path.join(rootDir, "src/other/out.ts"), "export const out = true;\n");

    const cell = {
      id: "core",
      ownedPaths: ["src/core/**", "src/addon/**"],
      publicEntry: "src/core/a.ts",
      publicSymbols: ["a"],
      consumes: [],
      producesArtifacts: [],
    };
    const manifest = {
      schemaVersion: "cellfence.manifest.v1",
      cells: [
        cell,
        {
          id: "other",
          ownedPaths: ["src/other/**"],
          publicEntry: "src/other/out.ts",
          publicSymbols: ["out"],
          consumes: [],
          producesArtifacts: [],
        },
      ],
    };
    const context = {
      rootDir,
      manifest,
      sourceFilesForCellCache: new Map(),
      sourceTextCache: new Map(),
      sourceFileCache: new Map(),
    };

    const indexed = sourceFilesForCell(rootDir, cell, context)
      .map((filePath) => normalizePath(path.relative(rootDir, filePath)));
    assert.deepEqual(indexed, ["src/addon/x.ts", "src/core/a.ts", "src/core/b.ts"]);

    const noContext = sourceFilesForCell(rootDir, cell)
      .map((filePath) => normalizePath(path.relative(rootDir, filePath)));
    assert.deepEqual(noContext, ["src/addon/x.ts", "src/core/a.ts", "src/core/b.ts"]);

    context.sourceFilesByCellIndex = new Map([
      ["core", [path.join(rootDir, "src/core/manual.ts")]],
    ]);
    const preIndexed = sourceFilesForCell(rootDir, cell, context)
      .map((filePath) => normalizePath(path.relative(rootDir, filePath)));
    assert.deepEqual(preIndexed, ["src/core/manual.ts"]);
    context.sourceFilesByCellIndex = undefined;
    context.listFilesCache = [
      path.join(rootDir, "src/core/b.ts"),
      path.join(rootDir, "src/core/a.ts"),
      path.join(rootDir, "src/addon/x.ts"),
    ];
    const sortedFromCachedList = sourceFilesForCell(rootDir, cell, context)
      .map((filePath) => normalizePath(path.relative(rootDir, filePath)));
    assert.deepEqual(sortedFromCachedList, ["src/addon/x.ts", "src/core/a.ts", "src/core/b.ts"]);

    fs.writeFileSync(path.join(rootDir, "src/core/new.ts"), "export const fresh = true;\n");
    const cached = sourceFilesForCell(rootDir, cell, context)
      .map((filePath) => normalizePath(path.relative(rootDir, filePath)));
    assert.deepEqual(cached, indexed);

    const freshContext = {
      rootDir,
      manifest,
      sourceFilesForCellCache: new Map(),
      sourceTextCache: new Map(),
      sourceFileCache: new Map(),
    };
    const fresh = sourceFilesForCell(rootDir, cell, freshContext)
      .map((filePath) => normalizePath(path.relative(rootDir, filePath)));
    assert.deepEqual(fresh, ["src/addon/x.ts", "src/core/a.ts", "src/core/b.ts", "src/core/new.ts"]);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("file index governance include and exclude rules are enforced for paths and source scans", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-governance-"));
  try {
    fs.mkdirSync(path.join(rootDir, "src/core"), { recursive: true });
    fs.mkdirSync(path.join(rootDir, "src/ignored"), { recursive: true });
    fs.writeFileSync(path.join(rootDir, "src/core/public.ts"), "export const api = true;\n");
    fs.writeFileSync(path.join(rootDir, "src/core/public.test.ts"), "export const testOnly = true;\n");
    fs.writeFileSync(path.join(rootDir, "src/core/view.tsx"), "export const view = <div />;\n");
    fs.writeFileSync(path.join(rootDir, "src/core/readme.md"), "# ignored\n");
    fs.writeFileSync(path.join(rootDir, "src/ignored/skip.ts"), "export const skip = true;\n");

    const manifest = {
      schemaVersion: "cellfence.manifest.v1",
      governance: {
        requireOwnership: true,
        include: ["src/**"],
        exclude: ["src/**/*.test.ts", "src/ignored/**"],
      },
      cells: [],
    };
    const governed = sourceFilesUnderGovernance(rootDir, manifest)
      .map((filePath) => normalizePath(path.relative(rootDir, filePath)));
    assert.deepEqual(governed, ["src/core/public.ts", "src/core/view.tsx"]);

    assert.equal(pathIsGoverned(manifest, "src/core/public.ts"), true);
    assert.equal(pathIsGoverned(manifest, "src/core/public.test.ts"), false);
    assert.equal(pathIsGoverned(manifest, "src/ignored/skip.ts"), false);
    assert.equal(pathIsGoverned({ ...manifest, governance: { include: ["src/**"] } }, "src/core/public.ts"), false);
    assert.equal(pathIsGoverned({ ...manifest, governance: { requireOwnership: true, include: ["src/**"] } }, "src/core/public.ts"), true);
    assert.equal(pathIsGoverned({ ...manifest, governance: { requireOwnership: true } }, "Stryker was here"), false);
    assert.equal(pathIsGoverned({ ...manifest, governance: { requireOwnership: true, include: ["Stryker was here"] } }, "Stryker was here"), true);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("file index ownership and coverage helpers accept any matching owned path without widening", () => {
  const cell = {
    id: "core",
    ownedPaths: ["src/core/**", "src/addon/**"],
    publicEntry: "src/core/public.ts",
    publicSymbols: [],
    consumes: [],
    producesArtifacts: [],
  };

  assert.equal(pathOwnedByCell(cell, "src/core/public.ts"), true);
  assert.equal(pathOwnedByCell(cell, "src/addon/helper.ts"), true);
  assert.equal(pathOwnedByCell(cell, "src/other/helper.ts"), false);

  assert.equal(patternCoveredByOwnedPaths("*.ts", ["*.ts"]), true);
  assert.equal(patternCoveredByOwnedPaths("src/core/public.ts", ["src/core/**", "src/other/**"]), true);
  assert.equal(patternCoveredByOwnedPaths("src/core/nested/**", ["src/core/**"]), true);
  assert.equal(patternCoveredByOwnedPaths("src/core/nested/**", ["src/core"]), true);
  assert.equal(patternCoveredByOwnedPaths("src/core/**", ["src/core/**"]), true);
  assert.equal(patternCoveredByOwnedPaths("src/core/**", ["src/core"]), true);
  assert.equal(patternCoveredByOwnedPaths("src/core*", ["src/core/**"]), false);
  assert.equal(patternCoveredByOwnedPaths("src/core/**", ["*.ts"]), false);
  assert.equal(patternCoveredByOwnedPaths("src/a*/**", ["src/a/**"]), false);
  assert.equal(patternCoveredByOwnedPaths("src/corex/**", ["src/core/**"]), false);
  assert.equal(patternCoveredByOwnedPaths("src/core/**", ["src/core/private/**"]), false);
});

test("file index source kind mapping covers all JS and TS extensions", () => {
  assert.equal(sourceKindForPath("src/core/file.ts"), ts.ScriptKind.TS);
  assert.equal(sourceKindForPath("src/core/file.mts"), ts.ScriptKind.TS);
  assert.equal(sourceKindForPath("src/core/file.cts"), ts.ScriptKind.TS);
  assert.equal(sourceKindForPath("src/core/file.tsx"), ts.ScriptKind.TSX);
  assert.equal(sourceKindForPath("src/core/file.jsx"), ts.ScriptKind.JSX);
  assert.equal(sourceKindForPath("src/core/file.js"), ts.ScriptKind.JS);
  assert.equal(sourceKindForPath("src/core/file.mjs"), ts.ScriptKind.JS);
  assert.equal(sourceKindForPath("src/core/file.cjs"), ts.ScriptKind.JS);
});

test("file index source text and AST parsing cache file contents with parent links", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-source-cache-"));
  try {
    fs.mkdirSync(path.join(rootDir, "src/core"), { recursive: true });
    const filePath = path.join(rootDir, "src/core/public.ts");
    fs.writeFileSync(filePath, "export const first = true;\n");
    const context = {
      rootDir,
      manifest: {
        schemaVersion: "cellfence.manifest.v1",
        cells: [],
      },
      sourceFilesForCellCache: new Map(),
      sourceTextCache: new Map(),
      sourceFileCache: new Map(),
    };

    const firstText = readSourceText(context, filePath);
    const firstSource = parseSourceFile(context, filePath);
    assert.equal(firstText, "export const first = true;\n");
    assert.equal(firstSource.statements[0].parent, firstSource);

    fs.writeFileSync(filePath, "export const second = true;\n");
    assert.equal(readSourceText(context, filePath), firstText);
    assert.equal(parseSourceFile(context, filePath), firstSource);

    const freshContext = {
      ...context,
      sourceTextCache: new Map(),
      sourceFileCache: new Map(),
    };
    assert.equal(readSourceText(freshContext, filePath), "export const second = true;\n");
    assert.notEqual(parseSourceFile(freshContext, filePath), firstSource);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});
