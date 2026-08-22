import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import ts from "typescript";

import {
  SOURCE_EXTENSIONS,
  absolutePath,
  literalPrefix,
  listFiles,
  listSymlinks,
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
import {
  ownedPathPatternsOverlap,
  pathPatternSubset,
  pathPatternsOverlap,
} from "../packages/engine/dist/glob-overlap.js";

test("file index normalizes empty and Windows-style paths and resolves absolute paths", () => {
  assert.equal(normalizePath(""), "");
  assert.equal(normalizePath("src\\core\\public.ts"), "src/core/public.ts");
  assert.equal(absolutePath("/repo", "src\\core\\public.ts"), path.resolve("/repo/src/core/public.ts"));
});

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
    assert.equal(matchesPattern("src/core", "src\\core\\"), true);
    assert.equal(pathPatternsOverlap("src\\core\\", "src/core"), true);
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
    ".py",
    ".pyi",
  ]);
});

test("file index glob matching distinguishes single-star, double-star, and literals", () => {
  assert.equal(matchesPattern("src/core/public.ts", "src/*/public.ts"), true);
  assert.equal(matchesPattern("src/public.ts", "src/**/public.ts"), true);
  assert.equal(matchesPattern("src/core/nested/public.ts", "src/*/public.ts"), false);
  assert.equal(matchesPattern("src/core/nested/public.ts", "src/**/public.ts"), true);
  assert.equal(matchesPattern("src/a.ts", "src/**/*.ts"), true);
  assert.equal(matchesPattern("src/core/public.ts", "src/**/*.ts"), true);
  assert.equal(matchesPattern("src/a.ts", "src/**.ts"), true);
  assert.equal(matchesPattern("src/core/a.ts", "src/**.ts"), false);
  assert.equal(matchesPattern("src/a", "src/**/**/a"), true);
  assert.equal(matchesPattern("src/core/a", "src/**/**/a"), true);
  assert.equal(matchesPattern("src/core/a.ts", "**"), true);
  assert.equal(matchesPattern("src", "src/**"), false);
  assert.equal(matchesPattern("src/core", "src/**"), true);
  assert.equal(matchesPattern("src/core", "src/core///"), true);
  assert.equal(matchesPattern("src/file?.ts", "src/file?.ts"), true);
  assert.equal(matchesPattern("src/file1.ts", "src/file?.ts"), false);
  assert.equal(matchesPattern("test/a.ts", "**/test/**"), true);
  assert.equal(matchesPattern("src/test/a.ts", "**/test/**"), true);
  assert.equal(matchesPattern("src/core/public.ts", "src/**/private.ts"), false);
  assert.equal(matchesPattern("src/core/public.ts", "src/core/public.ts"), true);
  assert.equal(matchesPattern("src/core/public.ts", "src/core/public.js"), false);
  assert.equal(matchesPattern("src/core/a.ts", "./src/core/**"), true);
  assert.equal(matchesPattern("src/core/a.ts", "src/./core/**"), true);
  assert.equal(matchesPattern("src/core/a.ts", "src//core/**"), true);
  assert.equal(matchesPattern("src/core/a.ts", "src/core/"), true);

  assert.equal(literalPrefix("src/core/*.ts"), "src/core");
  assert.equal(literalPrefix("src/core///**"), "src/core");
  assert.equal(literalPrefix("src/core/public.ts"), "src/core/public.ts");
  assert.equal(literalPrefix("src/core/file?.ts"), "src/core/file?.ts");
});

test("file index treats unsupported glob operators as literal text", () => {
  for (const [pattern, expandedPath] of [
    ["src/file?.ts", "src/file1.ts"],
    ["src/{a,b}.ts", "src/a.ts"],
    ["src/[ab].ts", "src/a.ts"],
    ["src/!(a).ts", "src/b.ts"],
    ["src/+(a).ts", "src/a.ts"],
    ["src/@(a).ts", "src/a.ts"],
  ]) {
    assert.equal(matchesPattern(pattern, pattern), true);
    assert.equal(matchesPattern(expandedPath, pattern), false);
    assert.equal(pathPatternsOverlap(pattern, pattern), true);
    assert.equal(pathPatternsOverlap(pattern, expandedPath), false);
  }

  assert.equal(matchesPattern("src/prefix(a).ts", "src/*(a).ts"), true);
  assert.equal(matchesPattern("src/aaa.ts", "src/*(a).ts"), false);
  assert.equal(pathPatternsOverlap("src/*(a).ts", "src/prefix(a).ts"), true);
  assert.equal(pathPatternsOverlap("src/*(a).ts", "src/aaa.ts"), false);
});

test("file index removes every trailing Windows path separator from patterns", () => {
  const windowsPattern = `src\\core${"\\".repeat(3)}`;
  assert.equal(matchesPattern("src/core", windowsPattern), true);
  assert.equal(pathPatternsOverlap(windowsPattern, "src/core/file.ts"), true);
});

test("glob overlap follows matcher semantics and canonicalizes trailing separators", () => {
  assert.equal(pathPatternsOverlap("src/core", "src/core/file.ts"), true);
  assert.equal(pathPatternsOverlap("src/core/", "src/core/file.ts"), true);
  assert.equal(pathPatternsOverlap("src/core/file.ts", "src/core/"), true);
  assert.equal(pathPatternsOverlap("src/core/*.ts", "src/core/"), true);
  assert.equal(pathPatternsOverlap("src/core////", "src/core/file.ts"), true);
  assert.equal(pathPatternsOverlap("src/**/public.ts", "src/public.ts"), true);
  assert.equal(pathPatternsOverlap("src/**/**/public.ts", "src/public.ts"), true);
  assert.equal(pathPatternsOverlap("src/**.ts", "src/nested/a.ts"), false);
  assert.equal(pathPatternsOverlap("src/**.ts", "src/a.ts"), true);
  assert.equal(pathPatternsOverlap("src/**", "src"), false);
  assert.equal(ownedPathPatternsOverlap("src/**", "src"), true);
  assert.equal(ownedPathPatternsOverlap("src/**", "src/core"), true);
  assert.equal(ownedPathPatternsOverlap("src/core", "src/core/**"), true);
  assert.equal(ownedPathPatternsOverlap("src/**/a", "src/a"), true);
  assert.equal(ownedPathPatternsOverlap("src/**.ts", "src/nested/a.ts"), false);
  assert.equal(ownedPathPatternsOverlap("src/file?.ts", "src/file?.ts"), true);
  assert.equal(ownedPathPatternsOverlap("src/file?.ts", "src/file1.ts"), false);
});

test("glob overlap agrees with concrete matcher witnesses across a bounded dialect corpus", () => {
  const patterns = [
    "a",
    "b",
    "src",
    "src/a",
    "src/b",
    "src/*",
    "src/*.ts",
    "src/**.ts",
    "src/**",
    "src/**/a",
    "src/**/**/a",
    "**",
    "**/a",
    "**/test/**",
    "test/**",
    "*/a",
    "a*",
    "a/**/b",
    "a/*/b",
  ];
  const pathSegments = ["a", "b", "src", "test", "x", "a.ts", "b.ts"];
  const paths = [];
  const appendPaths = (prefix, remaining) => {
    if (prefix.length > 0) paths.push(prefix.join("/"));
    if (remaining === 0) return;
    for (const segment of pathSegments) appendPaths([...prefix, segment], remaining - 1);
  };
  appendPaths([], 4);
  const expandOwnedPattern = (pattern) => {
    if (pattern.includes("*")) return [pattern];
    const trimmed = pattern.replace(/\/+$/, "");
    return [trimmed, `${trimmed}/**`];
  };

  for (const left of patterns) {
    for (const right of patterns) {
      const concreteIntersection = paths.some((candidate) =>
        matchesPattern(candidate, left) && matchesPattern(candidate, right));
      const concreteOwnedIntersection = paths.some((candidate) =>
        expandOwnedPattern(left).some((pattern) => matchesPattern(candidate, pattern))
        && expandOwnedPattern(right).some((pattern) => matchesPattern(candidate, pattern)));
      assert.equal(
        ownedPathPatternsOverlap(left, right),
        concreteOwnedIntersection,
        `owned overlap mismatch: left=${left} right=${right}`,
      );
      const literalAncestor = !left.includes("*")
        && !right.includes("*")
        && (left.startsWith(`${right}/`) || right.startsWith(`${left}/`));
      assert.equal(
        pathPatternsOverlap(left, right),
        concreteIntersection || literalAncestor,
        `claim overlap mismatch: left=${left} right=${right}`,
      );
    }
  }
});

test("glob subset distinguishes literal, slash, non-slash, and any transitions", () => {
  const trueSubsets = [
    ["src/a.ts", "src/*"],
    ["src/a.ts", "src/**"],
    ["src/a.ts", "**"],
    ["src/core/*", "src/core/**"],
    ["src/**", "**"],
    ["src/**/a.ts", "src/**"],
    ["src/*/a.ts", "src/**/a.ts"],
    ["src/*.ts", "src/**.ts"],
    ["src/**.ts", "src/*.ts"],
    ["*", "**"],
    ["src/file?.ts", "src/file?.ts"],
  ];
  for (const [inner, outer] of trueSubsets) {
    assert.equal(pathPatternSubset(inner, outer), true, `expected ${inner} subset ${outer}`);
  }

  const falseSubsets = [
    ["src/**", "src/*"],
    ["src/*", "src/*.ts"],
    ["src/**", "src/**/a.ts"],
    ["src/a/b.ts", "src/**.ts"],
    ["src/a", "src/a/b"],
    ["src/file1.ts", "src/file?.ts"],
    ["src/a/b", "src/*/c"],
    ["src/**/a", "src/*/a"],
    ["**", "*"],
    ["**", "src/**"],
  ];
  for (const [inner, outer] of falseSubsets) {
    assert.equal(pathPatternSubset(inner, outer), false, `expected ${inner} not subset ${outer}`);
  }

  assert.equal(patternCoveredByOwnedPaths("src/core/a.ts", ["src/core/"]), true);
  assert.equal(pathPatternSubset("", "**"), false);
  assert.equal(pathPatternSubset("src/core/", "src/core/**"), false);
  assert.equal(pathPatternSubset("src/core/**", "src/core/"), true);
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
      ".venv/pkg",
      "venv/pkg",
      ".tox/pkg",
      ".nox/pkg",
      "__pycache__/pkg",
      ".mypy_cache/pkg",
      ".pytest_cache/pkg",
      ".ruff_cache/pkg",
    ]) {
      fs.mkdirSync(path.join(rootDir, directory), { recursive: true });
    }
    fs.writeFileSync(path.join(rootDir, "src/core/z.ts"), "export const z = true;\n");
    fs.writeFileSync(path.join(rootDir, "src/core/types.PYI"), "value: int\n");
    fs.writeFileSync(path.join(rootDir, "src/core/a.ts"), "export const a = true;\n");
    fs.writeFileSync(path.join(rootDir, "node_modules/pkg/index.ts"), "export const ignored = true;\n");
    fs.writeFileSync(path.join(rootDir, ".git/hooks/pre-commit.ts"), "export const ignored = true;\n");
    fs.writeFileSync(path.join(rootDir, "dist/out.ts"), "export const ignored = true;\n");
    fs.writeFileSync(path.join(rootDir, "coverage/out.ts"), "export const ignored = true;\n");
    fs.writeFileSync(path.join(rootDir, ".turbo/out.ts"), "export const ignored = true;\n");
    for (const directory of [".venv", "venv", ".tox", ".nox", "__pycache__", ".mypy_cache", ".pytest_cache", ".ruff_cache"]) {
      fs.writeFileSync(path.join(rootDir, directory, "pkg/out.py"), "ignored = True\n");
    }
    fs.symlinkSync(path.join(rootDir, "src/core/a.ts"), path.join(rootDir, "src/core/link.ts"));
    fs.symlinkSync(path.join(rootDir, "src/core"), path.join(rootDir, "src/core-link"));
    fs.symlinkSync(path.join(rootDir, "src/core/missing.ts"), path.join(rootDir, "src/core/broken.ts"));

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
    assert.deepEqual(first, ["src/core/a.ts", "src/core/link.ts", "src/core/types.PYI", "src/core/z.ts"]);

    fs.writeFileSync(path.join(rootDir, "src/core/new.ts"), "export const fresh = true;\n");
    const cached = listFiles(rootDir, context).map((filePath) => normalizePath(path.relative(rootDir, filePath)));
    assert.deepEqual(cached, first);

    const uncached = listFiles(rootDir).map((filePath) => normalizePath(path.relative(rootDir, filePath)));
    assert.deepEqual(uncached, ["src/core/a.ts", "src/core/link.ts", "src/core/new.ts", "src/core/types.PYI", "src/core/z.ts"]);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("file index follows only safe directory symlinks during source scans", () => {
  const originalExistsSync = fs.existsSync;
  const originalReaddirSync = fs.readdirSync;
  const originalRealpathSync = fs.realpathSync;
  const originalStatSync = fs.statSync;
  try {
    fs.existsSync = (filePath) => ["/repo", "/repo/linked", "/repo/dist", "/repo/outside"].includes(normalizePath(String(filePath)));
    fs.readdirSync = (directoryPath) => {
      const normalized = normalizePath(String(directoryPath));
      if (normalized === "/repo") {
        return [
          {
            name: "linked",
            isDirectory: () => false,
            isFile: () => false,
            isSymbolicLink: () => true,
          },
          {
            name: "dist",
            isDirectory: () => false,
            isFile: () => false,
            isSymbolicLink: () => true,
          },
          {
            name: "outside",
            isDirectory: () => false,
            isFile: () => false,
            isSymbolicLink: () => true,
          },
        ];
      }
      if (normalized === "/repo/linked") {
        return [{
          name: "inside.ts",
          isDirectory: () => false,
          isFile: () => true,
          isSymbolicLink: () => false,
        }];
      }
      if (normalized === "/repo/dist") {
        return [{
          name: "generated.ts",
          isDirectory: () => false,
          isFile: () => true,
          isSymbolicLink: () => false,
        }];
      }
      if (normalized === "/repo/outside") {
        return [{
          name: "escape.ts",
          isDirectory: () => false,
          isFile: () => true,
          isSymbolicLink: () => false,
        }];
      }
      return [];
    };
    fs.realpathSync = (filePath) => {
      const normalized = normalizePath(String(filePath));
      if (normalized === "/repo/outside") return "/outside";
      return normalized;
    };
    fs.statSync = (filePath) => {
      const normalized = normalizePath(String(filePath));
      return {
        isFile: () => false,
        isDirectory: () => ["/repo/linked", "/repo/dist", "/repo/outside"].includes(normalized),
      };
    };

    assert.deepEqual(listFiles("/repo").map(normalizePath), ["/repo/linked/inside.ts"]);
  } finally {
    fs.existsSync = originalExistsSync;
    fs.readdirSync = originalReaddirSync;
    fs.realpathSync = originalRealpathSync;
    fs.statSync = originalStatSync;
  }
});

test("file index honors explicitly governed generated directories", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-list-files-dist-governed-"));
  try {
    fs.mkdirSync(path.join(rootDir, "dist"), { recursive: true });
    fs.mkdirSync(path.join(rootDir, "coverage"), { recursive: true });
    fs.writeFileSync(path.join(rootDir, "dist/runtime.ts"), "export const runtime = true;\n");
    fs.writeFileSync(path.join(rootDir, "coverage/report.ts"), "export const report = true;\n");
    const includeOnlyContext = {
      rootDir,
      manifest: {
        schemaVersion: "cellfence.manifest.v1",
        governance: {
          requireOwnership: true,
          include: ["src/other/**", "dist/**/*.ts"],
          exclude: [],
        },
        cells: [{
          id: "runtime",
          ownedPaths: ["src/runtime/**"],
          publicEntry: "dist/runtime.ts",
          publicSymbols: ["runtime"],
        }],
      },
      sourceFilesForCellCache: new Map(),
      sourceTextCache: new Map(),
      sourceFileCache: new Map(),
    };
    const ownedOnlyContext = {
      ...includeOnlyContext,
      manifest: {
        ...includeOnlyContext.manifest,
        governance: {
          requireOwnership: true,
          include: ["src/**"],
          exclude: [],
        },
        cells: [{
          id: "coverage",
          ownedPaths: ["src/other/**", "coverage/**/*.ts"],
          publicEntry: "coverage/report.ts",
          publicSymbols: ["report"],
        }],
      },
      listFilesCache: undefined,
      sourceFilesForCellCache: new Map(),
      sourceTextCache: new Map(),
      sourceFileCache: new Map(),
    };
    const includeWithoutExcludeContext = {
      ...includeOnlyContext,
      manifest: {
        ...includeOnlyContext.manifest,
        governance: {
          requireOwnership: true,
          include: ["dist/**/*.ts"],
        },
        cells: [{
          id: "runtime",
          ownedPaths: ["src/runtime/**"],
          publicEntry: "dist/runtime.ts",
          publicSymbols: ["runtime"],
        }],
      },
      listFilesCache: undefined,
      sourceFilesForCellCache: new Map(),
      sourceTextCache: new Map(),
      sourceFileCache: new Map(),
    };
    const governanceWithoutIncludeContext = {
      ...includeOnlyContext,
      manifest: {
        ...includeOnlyContext.manifest,
        governance: {
          requireOwnership: true,
          exclude: [],
        },
        cells: [{
          id: "coverage",
          ownedPaths: ["coverage/**/*.ts"],
          publicEntry: "coverage/report.ts",
          publicSymbols: ["report"],
        }],
      },
      listFilesCache: undefined,
      sourceFilesForCellCache: new Map(),
      sourceTextCache: new Map(),
      sourceFileCache: new Map(),
    };
    const excludedGeneratedContext = {
      ...includeOnlyContext,
      manifest: {
        ...includeOnlyContext.manifest,
        governance: {
          requireOwnership: true,
          include: ["dist/**/*.ts"],
          exclude: ["never/**", "dist/**"],
        },
        cells: [{
          id: "runtime",
          ownedPaths: ["dist/**/*.ts"],
          publicEntry: "dist/runtime.ts",
          publicSymbols: ["runtime"],
        }],
      },
      listFilesCache: undefined,
      sourceFilesForCellCache: new Map(),
      sourceTextCache: new Map(),
      sourceFileCache: new Map(),
    };

    assert.deepEqual(listFiles(rootDir, includeOnlyContext).map((filePath) => normalizePath(path.relative(rootDir, filePath))), ["dist/runtime.ts"]);
    assert.deepEqual(sourceFilesUnderGovernance(rootDir, includeOnlyContext.manifest, includeOnlyContext).map((filePath) => normalizePath(path.relative(rootDir, filePath))), ["dist/runtime.ts"]);
    assert.deepEqual(listFiles(rootDir, includeWithoutExcludeContext).map((filePath) => normalizePath(path.relative(rootDir, filePath))), ["dist/runtime.ts"]);
    assert.deepEqual(listFiles(rootDir, ownedOnlyContext).map((filePath) => normalizePath(path.relative(rootDir, filePath))), ["coverage/report.ts"]);
    assert.deepEqual(sourceFilesForCell(rootDir, ownedOnlyContext.manifest.cells[0], ownedOnlyContext).map((filePath) => normalizePath(path.relative(rootDir, filePath))), ["coverage/report.ts"]);
    assert.deepEqual(listFiles(rootDir, governanceWithoutIncludeContext).map((filePath) => normalizePath(path.relative(rootDir, filePath))), ["coverage/report.ts"]);
    assert.deepEqual(listFiles(rootDir, excludedGeneratedContext).map((filePath) => normalizePath(path.relative(rootDir, filePath))), []);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("file index sorting is deterministic even when filesystem order is not", () => {
  const originalReaddirSync = fs.readdirSync;
  const originalStatSync = fs.statSync;
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
      {
        name: "ignored-special",
        isDirectory: () => false,
        isFile: () => false,
        isSymbolicLink: () => false,
      },
    ];
    fs.statSync = (filePath) => {
      assert.equal(normalizePath(String(filePath)), "/repo/ignored-special");
      return { isFile: () => true };
    };

    assert.deepEqual(listFiles("/repo").map(normalizePath), ["/repo/a.ts", "/repo/z.ts"]);
  } finally {
    fs.readdirSync = originalReaddirSync;
    fs.statSync = originalStatSync;
  }
});

test("file index inventories valid and broken symlinks while ignoring regular and generated entries", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-list-symlinks-"));
  try {
    fs.mkdirSync(path.join(rootDir, "src/nested"), { recursive: true });
    fs.mkdirSync(path.join(rootDir, "node_modules/pkg"), { recursive: true });
    fs.writeFileSync(path.join(rootDir, "src/target.ts"), "export const target = true;\n");
    fs.writeFileSync(path.join(rootDir, "src/regular.ts"), "export const regular = true;\n");
    fs.symlinkSync(path.join(rootDir, "src/target.ts"), path.join(rootDir, "src/z-link.ts"));
    fs.symlinkSync(path.join(rootDir, "src/target.ts"), path.join(rootDir, "src/nested/a-link.ts"));
    fs.symlinkSync(path.join(rootDir, "src/missing.ts"), path.join(rootDir, "src/broken.ts"));
    fs.symlinkSync(path.join(rootDir, "src/target.ts"), path.join(rootDir, "node_modules/pkg/ignored.ts"));

    const realRootDir = fs.realpathSync(rootDir);
    const symlinks = listSymlinks(rootDir).map((entry) => ({
      ...entry,
      path: normalizePath(path.relative(rootDir, entry.path)),
      targetPath: entry.targetPath ? normalizePath(path.relative(realRootDir, entry.targetPath)) : undefined,
    }));

    assert.deepEqual(symlinks.map((entry) => entry.path), [
      "src/broken.ts",
      "src/nested/a-link.ts",
      "src/z-link.ts",
    ]);
    assert.equal(typeof symlinks[0].error, "string");
    assert.equal(symlinks[0].targetPath, undefined);
    assert.equal(symlinks[1].targetPath, "src/target.ts");
    assert.equal(symlinks[2].targetPath, "src/target.ts");
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("file index symlink inventory sorting does not depend on directory iteration order", () => {
  const originalReaddirSync = fs.readdirSync;
  const originalRealpathSync = fs.realpathSync;
  const originalStatSync = fs.statSync;
  try {
    fs.readdirSync = () => [
      {
        name: "z-link.ts",
        isDirectory: () => false,
        isSymbolicLink: () => true,
      },
      {
        name: "a-link.ts",
        isDirectory: () => false,
        isSymbolicLink: () => true,
      },
      {
        name: "m-link.ts",
        isDirectory: () => false,
        isSymbolicLink: () => true,
      },
    ];
    fs.realpathSync = (filePath) => filePath;
    fs.statSync = (filePath) => {
      const normalized = normalizePath(String(filePath));
      return {
        isFile: () => normalized.endsWith("z-link.ts"),
        isDirectory: () => normalized.endsWith("m-link.ts"),
      };
    };

    assert.deepEqual(listSymlinks("/repo").map((entry) => ({
      path: normalizePath(entry.path),
      targetType: entry.targetType,
    })), [
      { path: "/repo/a-link.ts", targetType: "other" },
      { path: "/repo/m-link.ts", targetType: "directory" },
      { path: "/repo/z-link.ts", targetType: "file" },
    ]);
  } finally {
    fs.readdirSync = originalReaddirSync;
    fs.realpathSync = originalRealpathSync;
    fs.statSync = originalStatSync;
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

    const excludedContext = {
      ...context,
      manifest: { ...manifest, governance: { exclude: ["src/core/b.ts"] } },
      sourceFilesByCellIndex: undefined,
      listFilesCache: undefined,
    };
    const excludingGovernance = sourceFilesForCell(rootDir, cell, excludedContext)
      .map((filePath) => normalizePath(path.relative(rootDir, filePath)));
    assert.deepEqual(excludingGovernance, ["src/addon/x.ts", "src/core/a.ts"]);

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
    assert.deepEqual(sourceFilesUnderGovernance(rootDir, { ...manifest, governance: undefined }), []);
    assert.deepEqual(sourceFilesUnderGovernance(rootDir, {
      ...manifest,
      governance: { requireOwnership: false, include: ["src/**"] },
    }), []);

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
  assert.equal(pathOwnedByCell({ ...cell, ownedPaths: ["src/core"] }, "src/core/public.ts"), true);

  assert.equal(patternCoveredByOwnedPaths("*.ts", ["*.ts"]), true);
  assert.equal(patternCoveredByOwnedPaths("src/core/public.ts", ["src/core/**", "src/other/**"]), true);
  assert.equal(patternCoveredByOwnedPaths("src/core/nested/**", ["src/core/**"]), true);
  assert.equal(patternCoveredByOwnedPaths("src/core/nested/**", ["src/core"]), true);
  assert.equal(patternCoveredByOwnedPaths("src/core", ["src/core"]), true);
  assert.equal(patternCoveredByOwnedPaths("src/core/", ["src/core"]), true);
  assert.equal(patternCoveredByOwnedPaths("src/core/**", ["src/core/**"]), true);
  assert.equal(patternCoveredByOwnedPaths("src/core/**", ["src/core"]), true);
  assert.equal(patternCoveredByOwnedPaths("src/core/", ["src/core/**"]), false);
  assert.equal(patternCoveredByOwnedPaths("src/corex", ["src/core"]), false);
  assert.equal(patternCoveredByOwnedPaths("src/core/file.ts", ["src/*"]), false);
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
  assert.equal(sourceKindForPath("src/core/file.py"), ts.ScriptKind.Unknown);
  assert.equal(sourceKindForPath("src/core/file.PYI"), ts.ScriptKind.Unknown);
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
