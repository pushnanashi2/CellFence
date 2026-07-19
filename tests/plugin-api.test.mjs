import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import ts from "typescript";

import { checkRepository } from "../packages/engine/dist/index.js";
import { defineAdapter, definePlugin, defineReporter, defineRule } from "../packages/plugin-api/dist/index.js";

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function createRepository(manifestPatch = {}) {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-plugin-"));
  fs.mkdirSync(path.join(rootDir, "src/core"), { recursive: true });
  fs.writeFileSync(
    path.join(rootDir, "src/core/public.ts"),
    [
      "declare const dbAccess: { select(tableName: string): unknown };",
      "export function readCustomer(): unknown {",
      "  return dbAccess.select(\"T_CUSTOMER\");",
      "}",
      "",
    ].join("\n"),
  );
  writeJson(path.join(rootDir, "cellfence.manifest.json"), {
    schemaVersion: "cellfence.manifest.v1",
    cells: [
      {
        id: "core",
        ownedPaths: ["src/core/**"],
        publicEntry: "src/core/public.ts",
        publicSymbols: ["readCustomer"],
        consumes: [],
        producesArtifacts: [],
        ...(manifestPatch.cell || {}),
      },
    ],
    ...manifestPatch.root,
  });
  return rootDir;
}

const companyDatabaseAdapter = defineAdapter({
  name: "company-database",
  detect(context) {
    const accesses = [];
    function visit(node) {
      if (ts.isCallExpression(node) && context.helpers.getQualifiedCallName(node) === "dbAccess.select") {
        const selector = context.helpers.getStaticStringArgument(node, 0);
        accesses.push({
          kind: "database",
          access: "read",
          selector: selector || "unresolved:company-database",
          filePath: context.filePath,
          line: context.helpers.lineOf(node),
          source: "dbAccess.select",
          detectedBy: "company-database",
          confidence: selector ? "high" : "low",
          unresolved: !selector,
          reason: selector ? undefined : "company database table argument is dynamic",
        });
      }
      ts.forEachChild(node, visit);
    }
    visit(context.sourceFile);
    return accesses;
  },
});

const requiredFileRule = defineRule({
  id: "company/required-file",
  meta: {
    description: "Requires a project-specific marker file for plugin API regression coverage.",
    defaultSeverity: "error",
    category: "company",
  },
  run(context) {
    const files = context.repository.files.byCell.core || [];
    if (files.includes("src/core/required.ts")) return [];
    return [{
      ruleId: "company/required-file",
      severity: "error",
      cellId: "core",
      filePath: "src/core/public.ts",
      message: "core is missing src/core/required.ts",
    }];
  },
});

test("plugin API define helpers return the exact objects passed in", () => {
  const reporter = {
    name: "company/reporter",
    report() {
      return "ok";
    },
  };
  assert.equal(defineAdapter(companyDatabaseAdapter), companyDatabaseAdapter);
  assert.equal(defineRule(requiredFileRule), requiredFileRule);
  assert.equal(defineReporter(reporter), reporter);
  const plugin = companyPlugin();
  assert.equal(definePlugin(plugin), plugin);
});

function companyPlugin() {
  return definePlugin({
    apiVersion: 1,
    name: "@company/cellfence-plugin",
    version: "1.0.0",
    capabilities: { needsAst: true },
    adapters: [companyDatabaseAdapter],
    rules: {
      "company/required-file": requiredFileRule,
    },
  });
}

function createBoundaryRepository() {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-plugin-cache-"));
  fs.mkdirSync(path.join(rootDir, "src/producer"), { recursive: true });
  fs.mkdirSync(path.join(rootDir, "src/consumer"), { recursive: true });
  fs.writeFileSync(path.join(rootDir, "src/producer/public.ts"), "export const publicValue = true;\n");
  fs.writeFileSync(path.join(rootDir, "src/producer/internal.ts"), "export const privateValue = true;\n");
  fs.writeFileSync(path.join(rootDir, "src/consumer/public.ts"), "import { publicValue } from '../producer/public';\nexport const used = publicValue;\n");
  writeJson(path.join(rootDir, "cellfence.manifest.json"), {
    schemaVersion: "cellfence.manifest.v1",
    governance: {
      requireOwnership: true,
      include: ["src/**"],
      exclude: [],
    },
    cells: [
      {
        id: "producer",
        ownedPaths: ["src/producer/**"],
        publicEntry: "src/producer/public.ts",
        publicSymbols: ["publicValue"],
        consumes: [],
        producesArtifacts: [],
      },
      {
        id: "consumer",
        ownedPaths: ["src/consumer/**"],
        publicEntry: "src/consumer/public.ts",
        publicSymbols: ["used"],
        consumes: [{ cell: "producer" }],
        producesArtifacts: [],
      },
    ],
  });
  return rootDir;
}

test("repeated engine checks see source files added after the first check", () => {
  const rootDir = createBoundaryRepository();
  try {
    const first = checkRepository({ rootDir, manifestPath: "cellfence.manifest.json" });
    assert.equal(first.ok, true);
    assert.deepEqual(first.findings, []);

    fs.writeFileSync(path.join(rootDir, "src/consumer/late-private-import.ts"), "import { privateValue } from '../producer/internal';\nexport const leaked = privateValue;\n");
    const second = checkRepository({ rootDir, manifestPath: "cellfence.manifest.json" });
    assert.equal(second.ok, false);
    assert.ok(second.findings.some((finding) =>
      finding.ruleId === "CELLFENCE_PRIVATE_IMPORT"
      && finding.filePath === "src/consumer/late-private-import.ts"));
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("plugin repository imports expose package export resolution state", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-plugin-import-state-"));
  let observedImports = [];
  const importObserverPlugin = definePlugin({
    apiVersion: 1,
    name: "@company/import-observer",
    version: "1.0.0",
    rules: {
      "company/import-observer": defineRule({
        id: "company/import-observer",
        meta: {
          description: "Captures import resolver metadata for plugin API regression coverage.",
          defaultSeverity: "error",
          category: "test",
        },
        run(context) {
          observedImports = context.repository.imports
            .map((reference) => ({
              specifier: reference.specifier,
              targetCellId: reference.targetCellId,
              targetPath: reference.targetPath,
              isPublicPackage: reference.isPublicPackage,
              packageExportState: reference.packageExportState,
              packageExportReason: reference.packageExportReason,
            }))
            .sort((left, right) => left.specifier.localeCompare(right.specifier));
          return [];
        },
      }),
    },
  });

  try {
    fs.mkdirSync(path.join(rootDir, "src/producer"), { recursive: true });
    fs.mkdirSync(path.join(rootDir, "src/consumer"), { recursive: true });
    fs.writeFileSync(path.join(rootDir, "src/producer/public.ts"), "export const publicValue = true;\n");
    fs.writeFileSync(path.join(rootDir, "src/producer/blocked.ts"), "export const privateValue = true;\n");
    fs.writeFileSync(
      path.join(rootDir, "src/consumer/public.ts"),
      [
        "import { publicValue } from '@scope/producer';",
        "import { privateValue } from '@scope/producer/blocked';",
        "import { generatedValue } from '@scope/producer/generated';",
        "export const used = publicValue || privateValue || generatedValue;",
        "",
      ].join("\n"),
    );
    writeJson(path.join(rootDir, "src/producer/package.json"), {
      name: "@scope/producer",
      type: "module",
      exports: {
        ".": "./public.js",
        "./blocked": null,
        "./generated": "./dist/generated.js",
      },
    });
    writeJson(path.join(rootDir, "cellfence.manifest.json"), {
      schemaVersion: "cellfence.manifest.v1",
      governance: {
        requireOwnership: true,
        include: ["src/**"],
        exclude: [],
      },
      cells: [
        {
          id: "producer",
          ownedPaths: ["src/producer/**"],
          publicEntry: "src/producer/public.ts",
          publicSymbols: ["publicValue"],
          packageName: "@scope/producer",
          consumes: [],
          producesArtifacts: [],
        },
        {
          id: "consumer",
          ownedPaths: ["src/consumer/**"],
          publicEntry: "src/consumer/public.ts",
          publicSymbols: ["used"],
          consumes: [{ cell: "producer" }],
          producesArtifacts: [],
        },
      ],
    });

    const result = checkRepository({
      rootDir,
      manifestPath: "cellfence.manifest.json",
      plugins: [importObserverPlugin],
    });

    assert.equal(result.ok, false);
    assert.ok(result.findings.some((finding) =>
      finding.ruleId === "CELLFENCE_PRIVATE_IMPORT"
      && finding.details?.specifier === "@scope/producer/blocked"));
    assert.deepEqual(observedImports, [
      {
        specifier: "@scope/producer",
        targetCellId: "producer",
        targetPath: "src/producer/public.ts",
        isPublicPackage: true,
        packageExportState: "PUBLIC_RESOLVED",
        packageExportReason: undefined,
      },
      {
        specifier: "@scope/producer/blocked",
        targetCellId: "producer",
        targetPath: "src/producer/blocked.ts",
        isPublicPackage: false,
        packageExportState: "NOT_EXPORTED_PRIVATE",
        packageExportReason: "specifier is explicitly excluded by the package exports map",
      },
      {
        specifier: "@scope/producer/generated",
        targetCellId: "producer",
        targetPath: undefined,
        isPublicPackage: true,
        packageExportState: "PUBLIC_DECLARED_GENERATED_TARGET_MISSING",
        packageExportReason: "export target is declared but no source checkout file was found",
      },
    ]);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("declared unresolved file access is recorded without warning", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-dynamic-file-contract-"));
  try {
    fs.mkdirSync(path.join(rootDir, "src/core"), { recursive: true });
    fs.writeFileSync(
      path.join(rootDir, "src/core/public.ts"),
      [
        "import fs from 'node:fs';",
        "export function readConfigured(filePath: string): string {",
        "  return fs.readFileSync(filePath, 'utf8');",
        "}",
        "",
      ].join("\n"),
    );
    writeJson(path.join(rootDir, "cellfence.manifest.json"), {
      schemaVersion: "cellfence.manifest.v1",
      governance: {
        requireOwnership: true,
        include: ["src/**"],
        exclude: [],
      },
      cells: [
        {
          id: "core",
          ownedPaths: ["src/core/**"],
          publicEntry: "src/core/public.ts",
          publicSymbols: ["readConfigured"],
          consumes: [],
          producesArtifacts: [],
          resourceContracts: [
            {
              id: "caller-supplied-file-read",
              kind: "file",
              access: ["read"],
              selectors: ["unresolved:dynamic-file-path"],
            },
          ],
        },
      ],
    });

    const result = checkRepository({ rootDir, manifestPath: "cellfence.manifest.json" });
    assert.equal(result.ok, true);
    assert.deepEqual(result.findings, []);
    assert.deepEqual(result.warnings, []);
    assert.deepEqual(result.metrics.core.resourceAccesses, [
      {
        kind: "file",
        access: "read",
        selector: "unresolved:dynamic-file-path",
        detectedBy: "file-call",
        confidence: "low",
      },
    ]);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("built-in resource adapters can be disabled when unused by a repository", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-adapter-off-"));
  try {
    fs.mkdirSync(path.join(rootDir, "src/core"), { recursive: true });
    fs.writeFileSync(
      path.join(rootDir, "src/core/public.ts"),
      [
        "declare const db: { query(sql: string): unknown };",
        "export function docOnlyQueryExample(): unknown {",
        "  return db.query(\"select * from T_CUSTOMER\");",
        "}",
        "",
      ].join("\n"),
    );
    writeJson(path.join(rootDir, "cellfence.manifest.json"), {
      schemaVersion: "cellfence.manifest.v1",
      governance: {
        requireOwnership: true,
        include: ["src/**"],
        exclude: [],
        resourceAdapters: {
          "sql-literal": "off",
        },
      },
      cells: [
        {
          id: "core",
          ownedPaths: ["src/core/**"],
          publicEntry: "src/core/public.ts",
          publicSymbols: ["docOnlyQueryExample"],
          consumes: [],
          producesArtifacts: [],
        },
      ],
    });

    const result = checkRepository({ rootDir, manifestPath: "cellfence.manifest.json" });
    assert.equal(result.ok, true);
    assert.deepEqual(result.findings, []);
    assert.deepEqual(result.warnings, []);
    assert.deepEqual(result.metrics.core.resourceAccesses, []);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("unknown built-in resource adapter names are rejected", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-adapter-typo-"));
  try {
    fs.mkdirSync(path.join(rootDir, "src/core"), { recursive: true });
    fs.writeFileSync(path.join(rootDir, "src/core/public.ts"), "export const core = true;\n");
    writeJson(path.join(rootDir, "cellfence.manifest.json"), {
      schemaVersion: "cellfence.manifest.v1",
      governance: {
        requireOwnership: true,
        include: ["src/**"],
        exclude: [],
        resourceAdapters: {
          express: "off",
        },
      },
      cells: [
        {
          id: "core",
          ownedPaths: ["src/core/**"],
          publicEntry: "src/core/public.ts",
          publicSymbols: ["core"],
          consumes: [],
          producesArtifacts: [],
        },
      ],
    });

    const result = checkRepository({ rootDir, manifestPath: "cellfence.manifest.json" });
    assert.equal(result.ok, false);
    assert.equal(result.exitCode, 2);
    assert.equal(result.findings[0].ruleId, "CELLFENCE_MANIFEST_INVALID");
    assert.match(result.findings[0].message, /resourceAdapters\.express/);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("plugin adapter output is governed by resource contracts", () => {
  const rootDir = createRepository();
  try {
    const result = checkRepository({ rootDir, manifestPath: "cellfence.manifest.json", plugins: [companyPlugin()] });
    assert.equal(result.ok, false);
    assert.ok(result.findings.some((finding) =>
      finding.ruleId === "CELLFENCE_UNDECLARED_RESOURCE_ACCESS"
      && finding.details?.detectedBy === "company-database"
      && finding.details?.selector === "T_CUSTOMER"));
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("plugin adapter resources are recorded in metrics when declared", () => {
  const rootDir = createRepository({
    cell: {
      resourceContracts: [
        {
          id: "company-db",
          kind: "database",
          access: ["read"],
          selectors: ["T_CUSTOMER"],
        },
      ],
    },
    root: {
      rules: {
        "company/required-file": "off",
      },
    },
  });
  try {
    const result = checkRepository({ rootDir, manifestPath: "cellfence.manifest.json", plugins: [companyPlugin()] });
    assert.equal(result.ok, true);
    assert.deepEqual(result.metrics.core.resourceAccesses, [
      {
        kind: "database",
        access: "read",
        selector: "T_CUSTOMER",
        detectedBy: "company-database",
        confidence: "high",
      },
    ]);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("plugin rule findings follow repository severity configuration", () => {
  const rootDir = createRepository({
    cell: {
      resourceContracts: [
        {
          id: "company-db",
          kind: "database",
          access: ["read"],
          selectors: ["T_CUSTOMER"],
        },
      ],
    },
    root: {
      rules: {
        "company/required-file": "warning",
      },
    },
  });
  try {
    const result = checkRepository({ rootDir, manifestPath: "cellfence.manifest.json", plugins: [companyPlugin()] });
    assert.equal(result.ok, true);
    assert.deepEqual(result.findings, []);
    assert.ok(result.warnings.some((finding) => finding.ruleId === "company/required-file"));
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("requiredRules fail when a plugin rule is disabled", () => {
  const rootDir = createRepository({
    cell: {
      resourceContracts: [
        {
          id: "company-db",
          kind: "database",
          access: ["read"],
          selectors: ["T_CUSTOMER"],
        },
      ],
    },
    root: {
      governance: {
        requiredRules: ["company/required-file"],
      },
      rules: {
        "company/required-file": "off",
      },
    },
  });
  try {
    const result = checkRepository({ rootDir, manifestPath: "cellfence.manifest.json", plugins: [companyPlugin()] });
    assert.equal(result.ok, false);
    assert.ok(result.findings.some((finding) => finding.ruleId === "CELLFENCE_REQUIRED_RULE_DISABLED"));
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("plugin runtime fails closed for invalid plugin APIs, adapters, and rules", () => {
  const rootDir = createRepository();
  const unsupportedApiPlugin = {
    apiVersion: 999,
    name: "@company/unsupported-plugin",
    version: "1.0.0",
    rules: {},
  };
  const unnamedUnsupportedApiPlugin = {
    apiVersion: 999,
    rules: {},
  };
  const throwingAdapterPlugin = definePlugin({
    apiVersion: 1,
    name: "@company/throwing-adapter",
    version: "1.0.0",
    adapters: [defineAdapter({
      name: "throwing",
      detect() {
        throw new Error("adapter boom");
      },
    })],
  });
  const stringThrowingAdapterPlugin = definePlugin({
    apiVersion: 1,
    name: "@company/string-throwing-adapter",
    version: "1.0.0",
    adapters: [defineAdapter({
      name: "string-throwing",
      detect() {
        throw "string adapter boom";
      },
    })],
  });
  const unknownCellAdapterPlugin = definePlugin({
    apiVersion: 1,
    name: "@company/unknown-cell-adapter",
    version: "1.0.0",
    adapters: [defineAdapter({
      name: "unknown-cell",
      detect(context) {
        return [{
          kind: "database",
          access: "read",
          selector: "T_UNKNOWN",
          filePath: context.filePath,
          line: 1,
          source: "unknown-cell",
          detectedBy: "unknown-cell",
          confidence: "high",
          cellId: "missing-cell",
        }];
      },
    })],
  });
  const fallbackAccessAdapterPlugin = definePlugin({
    apiVersion: 1,
    name: "@company/fallback-access-adapter",
    version: "1.0.0",
    adapters: [defineAdapter({
      name: "fallback-access",
      detect() {
        return [{
          kind: "file",
          access: "read",
          selector: "unresolved:fallback-access",
          confidence: "low",
          unresolved: true,
        }];
      },
    })],
  });
  const rulePlugin = definePlugin({
    apiVersion: 1,
    name: "@company/rule-plugin",
    version: "1.0.0",
    rules: {
      "company/reported": defineRule({
        id: "company/reported",
        meta: {
          description: "Reports a finding through both supported rule channels.",
          defaultSeverity: "error",
          category: "test",
        },
        run(context) {
          context.report({
            severity: "error",
            message: "reported finding",
          });
          return [{
            severity: "error",
          message: "returned finding",
        }];
      },
    }),
      "company/undefined": defineRule({
        id: "company/undefined",
        meta: {
          description: "Returns undefined to verify optional rule output is treated as empty.",
          defaultSeverity: "error",
          category: "test",
        },
        run() {
          return undefined;
        },
      }),
      "company/throws": defineRule({
        id: "company/throws",
        meta: {
          description: "Throws to verify plugin rule failures are findings.",
          defaultSeverity: "error",
          category: "test",
        },
        run() {
          throw new Error("rule boom");
        },
      }),
      "company/string-throws": defineRule({
        id: "company/string-throws",
        meta: {
          description: "Throws a non-Error value to verify safe message rendering.",
          defaultSeverity: "error",
          category: "test",
        },
        run() {
          throw "string rule boom";
        },
      }),
    },
  });

  try {
    const result = checkRepository({
      rootDir,
      manifestPath: "cellfence.manifest.json",
      plugins: [
        unsupportedApiPlugin,
        unnamedUnsupportedApiPlugin,
        throwingAdapterPlugin,
        stringThrowingAdapterPlugin,
        unknownCellAdapterPlugin,
        fallbackAccessAdapterPlugin,
        rulePlugin,
      ],
    });
    assert.equal(result.ok, false);
    assert.ok(result.findings.some((finding) =>
      finding.ruleId === "CELLFENCE_PLUGIN_INVALID"
      && /unsupported CellFence plugin API/.test(finding.message)));
    assert.ok(result.findings.some((finding) =>
      finding.ruleId === "CELLFENCE_PLUGIN_INVALID"
      && /adapter boom/.test(finding.message)));
    assert.ok(result.findings.some((finding) =>
      finding.ruleId === "CELLFENCE_PLUGIN_INVALID"
      && /plugin \(unnamed\)/.test(finding.message)));
    assert.ok(result.findings.some((finding) =>
      finding.ruleId === "CELLFENCE_PLUGIN_INVALID"
      && /string adapter boom/.test(finding.message)));
    assert.ok(result.findings.some((finding) =>
      finding.ruleId === "CELLFENCE_PLUGIN_INVALID"
      && /unknown cell missing-cell/.test(finding.message)));
    assert.ok(result.findings.some((finding) =>
      finding.ruleId === "CELLFENCE_PLUGIN_INVALID"
      && /rule boom/.test(finding.message)));
    assert.ok(result.findings.some((finding) =>
      finding.ruleId === "CELLFENCE_PLUGIN_INVALID"
      && /string rule boom/.test(finding.message)));
    assert.ok(result.warnings.some((finding) =>
      finding.ruleId === "CELLFENCE_UNRESOLVED_RESOURCE_ACCESS"
      && /resource access is not statically resolvable/.test(finding.message)));
    assert.equal(result.findings.filter((finding) => finding.ruleId === "company/reported").length, 2);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});
