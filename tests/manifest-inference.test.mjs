import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { checkRepository, inferManifest } from "../packages/engine/dist/index.js";

const defaultRequiredRules = [
  "CELLFENCE_OWNERSHIP_OVERLAP",
  "CELLFENCE_UNOWNED_SOURCE",
  "CELLFENCE_UNOWNED_IMPORT_TARGET",
  "CELLFENCE_PUBLIC_ENTRY_OUTSIDE_OWNERSHIP",
  "CELLFENCE_ARTIFACT_OUTSIDE_OWNERSHIP",
  "CELLFENCE_SYMLINK_TARGET_OUTSIDE_OWNERSHIP",
  "CELLFENCE_PRIVATE_IMPORT",
  "CELLFENCE_UNSUPPORTED_DYNAMIC_IMPORT",
  "CELLFENCE_UNSUPPORTED_DYNAMIC_REQUIRE",
  "CELLFENCE_REQUIRED_RULE_DISABLED",
  "CELLFENCE_WAIVER_INVALID",
];

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function writeText(filePath, text) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, text);
}

function writeManifest(rootDir, manifest) {
  writeJson(path.join(rootDir, "cellfence.manifest.json"), manifest);
}

test("manifest inference discovers src cells, workspace cells, public entries, aliases, and consumers", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-manifest-infer-main-"));
  try {
    writeJson(path.join(rootDir, "package.json"), { workspaces: ["packages/*"] });
    writeJson(path.join(rootDir, "tsconfig.json"), {
      compilerOptions: {
        baseUrl: ".",
        paths: {
          "@parser/*": ["src/parser/*"],
        },
      },
    });
    writeJson(path.join(rootDir, "packages/worker/package.json"), { name: "@demo/worker" });
    writeText(path.join(rootDir, "src/parser/public.ts"), "export function parse(value: string): string { return value; }\n");
    writeText(path.join(rootDir, "src/reporting/index.ts"), "import 'node:fs';\nimport { parse } from '@parser/public.js';\nexport const report = parse('ok');\n");
    writeText(path.join(rootDir, "packages/worker/src/index.ts"), "import { parse } from '../../../src/parser/public.js';\nexport const run = () => parse('job');\n");

    const manifest = inferManifest({ rootDir });
    assert.deepEqual(manifest.governance, {
      requireOwnership: true,
      include: ["packages/worker/src/**", "src/**"],
      exclude: [],
      requiredRules: defaultRequiredRules,
    });
    assert.deepEqual(manifest.cells.map((cell) => [cell.id, cell.publicEntry, cell.publicSymbols, cell.consumes]), [
      ["parser", "src/parser/public.ts", ["parse"], []],
      ["reporting", "src/reporting/index.ts", ["report"], [{ cell: "parser" }]],
      ["worker", "packages/worker/src/index.ts", ["run"], [{ cell: "parser" }]],
    ]);
    writeManifest(rootDir, manifest);
    assert.equal(checkRepository({ rootDir }).ok, true);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("manifest inference handles object workspaces, broad wildcards, duplicates, and root source fallback", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-manifest-infer-workspaces-"));
  try {
    writeJson(path.join(rootDir, "package.json"), {
      workspaces: {
        packages: ["*", "libs/core", "packages/*", "packages/dup-a", "missing", "missing/*"],
      },
    });
    writeJson(path.join(rootDir, "loose/package.json"), { name: "/" });
    writeJson(path.join(rootDir, "libs/core/package.json"), { name: "" });
    writeJson(path.join(rootDir, "packages/dup-a/package.json"), { name: "@demo/dup" });
    writeJson(path.join(rootDir, "packages/dup-b/package.json"), { name: "@demo/dup" });
    writeText(path.join(rootDir, "src/helper.ts"), "export const helper = true;\n");
    writeText(path.join(rootDir, "loose/src/index.ts"), "export const loose = true;\n");
    writeText(path.join(rootDir, "libs/core/src/custom.ts"), "export const core = true;\n");
    writeText(path.join(rootDir, "packages/dup-a/src/index.ts"), "export const first = true;\n");
    writeText(path.join(rootDir, "packages/dup-b/src/index.ts"), "export const second = true;\n");

    const manifest = inferManifest({ rootDir });
    assert.deepEqual(manifest.cells.map((cell) => [cell.id, cell.ownedPaths[0], cell.publicEntry, cell.packageName]), [
      ["cell", "loose/src/**", "loose/src/index.ts", "/"],
      ["core", "libs/core/src/**", "libs/core/src/custom.ts", undefined],
      ["dup", "packages/dup-a/src/**", "packages/dup-a/src/index.ts", "@demo/dup"],
      ["dup-2", "packages/dup-b/src/**", "packages/dup-b/src/index.ts", "@demo/dup"],
      ["src-root", "src/*", "src/helper.ts", undefined],
    ]);
    writeManifest(rootDir, manifest);
    assert.equal(checkRepository({ rootDir }).ok, true);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("manifest inference normalizes ids, filters workspace noise, prioritizes public entries, and ignores self imports", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-manifest-infer-priority-"));
  try {
    writeJson(path.join(rootDir, "package.json"), {
      workspaces: ["libs/*", 42, false],
    });
    writeJson(path.join(rootDir, "libs/mixed/package.json"), { name: "@Scope/FooBar--" });
    writeJson(path.join(rootDir, "libs/blank/package.json"), { name: "   " });
    writeJson(path.join(rootDir, "libs/number-name/package.json"), { name: 7 });
    writeText(path.join(rootDir, "src/helper.ts"), "export const helper = true;\n");
    writeText(path.join(rootDir, "src/public.mts"), "export const publicRoot = true;\n");
    writeText(path.join(rootDir, "libs/mixed/src/a.ts"), "export const fallbackOnly = true;\n");
    writeText(path.join(rootDir, "libs/mixed/src/index.ts"), "export const indexSymbol = true;\n");
    writeText(path.join(rootDir, "libs/mixed/src/internal.ts"), "export const internal = true;\n");
    writeText(path.join(rootDir, "libs/mixed/src/public.ts"), "import { internal } from './internal.js';\nexport const publicSymbol = internal;\nexport const alpha = true;\n");
    writeText(path.join(rootDir, "libs/blank/src/index.ts"), "import 'node:fs';\nexport const blank = true;\n");
    writeText(path.join(rootDir, "libs/number-name/src/index.ts"), "export const numbered = true;\n");

    const manifest = inferManifest({ rootDir });
    assert.deepEqual(manifest.cells.map((cell) => [cell.id, cell.publicEntry, cell.publicSymbols, cell.consumes]), [
      ["blank", "libs/blank/src/index.ts", ["blank"], []],
      ["foo-bar", "libs/mixed/src/public.ts", ["alpha", "publicSymbol"], []],
      ["number-name", "libs/number-name/src/index.ts", ["numbered"], []],
      ["src-root", "src/public.mts", ["publicRoot"], []],
    ]);
    writeManifest(rootDir, manifest);
    assert.equal(checkRepository({ rootDir }).ok, true);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("manifest inference falls back to the example manifest for empty or malformed repositories", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-manifest-infer-empty-"));
  const previousCwd = process.cwd();
  try {
    fs.writeFileSync(path.join(rootDir, "package.json"), "{");
    process.chdir(rootDir);
    const manifest = inferManifest();
    assert.deepEqual(manifest, {
      schemaVersion: "cellfence.manifest.v1",
      governance: {
        requireOwnership: true,
        include: ["src/**"],
        exclude: [],
        requiredRules: defaultRequiredRules,
      },
      cells: [
        {
          id: "example",
          ownedPaths: ["src/example/**"],
          publicEntry: "src/example/public.ts",
          publicSymbols: ["example"],
          consumes: [],
          producesArtifacts: [],
        },
      ],
    });
  } finally {
    process.chdir(previousCwd);
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});
