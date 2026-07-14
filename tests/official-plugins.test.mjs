import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import ts from "typescript";

import { checkRepository } from "../packages/engine/dist/index.js";
import { validateResourceEvidence } from "../packages/schema/dist/index.js";
import { callPatternAdapter } from "../packages/adapter-call-pattern/dist/index.js";
import { openTelemetryToResourceEvidence } from "../packages/adapter-opentelemetry/dist/index.js";
import { CELLFENCE_PLUGIN_API_VERSION } from "../packages/plugin-api/dist/index.js";
import { agentBudgetPlugin } from "../packages/plugin-agent-budget/dist/index.js";
import { blastRadiusPlugin } from "../packages/plugin-blast-radius/dist/index.js";
import { dependencySovereigntyPlugin } from "../packages/plugin-dependency-sovereignty/dist/index.js";
import { geoPurityPlugin } from "../packages/plugin-geo-purity/dist/index.js";
import { legacyStranglerPlugin } from "../packages/plugin-legacy-strangler/dist/index.js";
import { quantsTrendPlugin } from "../packages/plugin-quants-trend/dist/index.js";
import { createEconomyMatrix, economyMatrixPlugin, economyMatrixReporter } from "../packages/reporter-economy-matrix/dist/index.js";

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function createRepo() {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-official-plugins-"));
  fs.mkdirSync(path.join(rootDir, "src/core"), { recursive: true });
  fs.mkdirSync(path.join(rootDir, "src/mid"), { recursive: true });
  fs.mkdirSync(path.join(rootDir, "src/app"), { recursive: true });
  fs.mkdirSync(path.join(rootDir, "src/legacy"), { recursive: true });
  fs.writeFileSync(path.join(rootDir, "src/core/public.ts"), "export const coreApi = true;\nexport const newApi = true;\n");
  fs.writeFileSync(path.join(rootDir, "src/mid/public.ts"), "import { coreApi } from '../core/public';\nexport const midApi = coreApi;\n");
  fs.writeFileSync(path.join(rootDir, "src/app/public.ts"), "import { midApi } from '../mid/public';\nimport { legacyApi } from '../legacy/public';\ndeclare const internalDb: { write(table: string): void };\ninternalDb.write('T_ORDER');\nexport const appApi = Boolean(midApi && legacyApi);\n");
  fs.writeFileSync(path.join(rootDir, "src/legacy/public.ts"), "export const legacyApi = true;\n");
  writeJson(path.join(rootDir, "cellfence.manifest.json"), {
    schemaVersion: "cellfence.manifest.v1",
    cells: [
      {
        id: "core",
        ownedPaths: ["src/core/**"],
        publicEntry: "src/core/public.ts",
        publicSymbols: ["coreApi", "newApi"],
        consumes: [],
        producesArtifacts: [],
      },
      {
        id: "mid",
        ownedPaths: ["src/mid/**"],
        publicEntry: "src/mid/public.ts",
        publicSymbols: ["midApi"],
        consumes: [{ cell: "core" }],
        producesArtifacts: [],
      },
      {
        id: "app",
        ownedPaths: ["src/app/**"],
        publicEntry: "src/app/public.ts",
        publicSymbols: ["appApi"],
        consumes: [{ cell: "mid" }, { cell: "legacy" }],
        producesArtifacts: [],
      },
      {
        id: "legacy",
        ownedPaths: ["src/legacy/**"],
        publicEntry: "src/legacy/public.ts",
        publicSymbols: ["legacyApi"],
        consumes: [],
        producesArtifacts: [],
      },
    ],
  });
  writeJson(path.join(rootDir, "cellfence.baseline.json"), {
    schemaVersion: "cellfence.baseline.v1",
    generatedAt: "2026-01-01T00:00:00.000Z",
    cells: {
      core: {
        ownedPathPatterns: 1,
        publicSymbols: 1,
        publicSurfaceLines: 1,
        crossCellDependencies: 0,
        publicSymbolSet: ["coreApi"],
        dependencyEdges: [],
        resourceAccesses: [],
      },
      mid: {
        ownedPathPatterns: 1,
        publicSymbols: 1,
        publicSurfaceLines: 1,
        crossCellDependencies: 1,
        publicSymbolSet: ["midApi"],
        dependencyEdges: ["mid->core"],
        resourceAccesses: [],
      },
      app: {
        ownedPathPatterns: 1,
        publicSymbols: 1,
        publicSurfaceLines: 1,
        crossCellDependencies: 1,
        publicSymbolSet: ["appApi"],
        dependencyEdges: ["app->mid"],
        resourceAccesses: [],
      },
      legacy: {
        ownedPathPatterns: 1,
        publicSymbols: 1,
        publicSurfaceLines: 1,
        crossCellDependencies: 0,
        publicSymbolSet: ["legacyApi"],
        dependencyEdges: [],
        resourceAccesses: [],
      },
    },
  });
  return rootDir;
}

function directRule(plugin, ruleId) {
  assert.equal(plugin.apiVersion, CELLFENCE_PLUGIN_API_VERSION);
  assert.ok(plugin.rules?.[ruleId], `${plugin.name} missing ${ruleId}`);
  return plugin.rules[ruleId];
}

function baseRepository(patch = {}) {
  const manifest = {
    schemaVersion: "cellfence.manifest.v1",
    cells: [{
      id: "core",
      ownedPaths: ["src/core/**"],
      publicEntry: "src/core/public.ts",
      publicSymbols: ["coreApi", "newApi"],
      consumes: [],
      producesArtifacts: [{ id: "core-out", paths: ["src/core/out/**"] }],
    }, {
      id: "mid",
      ownedPaths: ["src/mid/**"],
      publicEntry: "src/mid/public.ts",
      publicSymbols: ["midApi"],
      consumes: [{ cell: "core" }],
      producesArtifacts: [],
    }, {
      id: "app",
      ownedPaths: ["src/app/**"],
      publicEntry: "src/app/public.ts",
      publicSymbols: ["appApi"],
      consumes: [{ cell: "mid" }, { cell: "legacy" }],
      producesArtifacts: [],
    }, {
      id: "legacy",
      ownedPaths: ["src/legacy/**"],
      publicEntry: "src/legacy/public.ts",
      publicSymbols: ["legacyApi"],
      consumes: [],
      producesArtifacts: [],
    }],
  };
  return {
    rootDir: "/repo",
    manifest,
    baseline: {
      schemaVersion: "cellfence.baseline.v1",
      generatedAt: "2026-01-01T00:00:00.000Z",
      cells: {
        core: {
          ownedPathPatterns: 1,
          publicSymbols: 1,
          publicSurfaceLines: 1,
          crossCellDependencies: 0,
          publicSymbolSet: ["coreApi"],
          dependencyEdges: [],
          resourceAccesses: [],
        },
        mid: {
          ownedPathPatterns: 1,
          publicSymbols: 1,
          publicSurfaceLines: 1,
          crossCellDependencies: 1,
          publicSymbolSet: ["midApi"],
          dependencyEdges: ["mid->core"],
          resourceAccesses: [],
        },
        app: {
          ownedPathPatterns: 1,
          publicSymbols: 1,
          publicSurfaceLines: 1,
          crossCellDependencies: 1,
          publicSymbolSet: ["appApi"],
          dependencyEdges: ["app->mid"],
          resourceAccesses: [],
        },
        legacy: {
          ownedPathPatterns: 1,
          publicSymbols: 1,
          publicSurfaceLines: 1,
          crossCellDependencies: 0,
          publicSymbolSet: ["legacyApi"],
          dependencyEdges: [],
          resourceAccesses: [],
        },
      },
    },
    files: {
      all: ["src/core/public.ts", "src/mid/public.ts", "src/app/public.ts", "src/legacy/public.ts"],
      governed: ["src/core/public.ts", "src/mid/public.ts", "src/app/public.ts", "src/legacy/public.ts"],
      byCell: {
        core: ["src/core/public.ts", "src/core/extra.ts"],
        mid: ["src/mid/public.ts"],
        app: ["src/app/public.ts"],
        legacy: ["src/legacy/public.ts"],
      },
      contents: {
        "src/core/public.ts": "export const coreApi = true;\nexport const newApi = true;\n",
        "src/core/extra.ts": "const a = 1;\nconst b = 2;\nconst c = 3;\n",
        "src/mid/public.ts": "export const midApi = true;\n",
        "src/app/public.ts": "export const appApi = true;\n",
        "src/legacy/public.ts": "export const legacyApi = true;\n",
      },
    },
    imports: [
      { importerCellId: "mid", targetCellId: "core" },
      { importerCellId: "app", targetCellId: "mid" },
      { importerCellId: "app", targetCellId: "legacy" },
    ],
    resources: [
      { cellId: "core", kind: "database", access: "read", selector: "app.users" },
      { cellId: "app", kind: "queue", access: "publish", selector: "orders.created" },
    ],
    metrics: {
      core: {
        ownedPathPatterns: 1,
        publicSymbols: 2,
        publicSurfaceLines: 2,
        crossCellDependencies: 0,
        publicSymbolSet: ["coreApi", "newApi"],
        dependencyEdges: [],
        resourceAccesses: [],
      },
      mid: {
        ownedPathPatterns: 1,
        publicSymbols: 1,
        publicSurfaceLines: 1,
        crossCellDependencies: 1,
        publicSymbolSet: ["midApi"],
        dependencyEdges: ["mid->core"],
        resourceAccesses: [],
      },
      app: {
        ownedPathPatterns: 1,
        publicSymbols: 1,
        publicSurfaceLines: 1,
        crossCellDependencies: 2,
        publicSymbolSet: ["appApi"],
        dependencyEdges: ["app->legacy", "app->mid"],
        resourceAccesses: [],
      },
      legacy: {
        ownedPathPatterns: 1,
        publicSymbols: 1,
        publicSurfaceLines: 1,
        crossCellDependencies: 0,
        publicSymbolSet: ["legacyApi"],
        dependencyEdges: [],
        resourceAccesses: [],
      },
    },
    changedFiles: new Set(["src/core/public.ts", "src/app/public.ts"]),
    ...patch,
  };
}

function directContext(repository = baseRepository()) {
  return {
    repository,
    cells: repository.manifest.cells,
    report() {},
  };
}

function qualifiedCallName(node) {
  if (ts.isIdentifier(node)) return node.text;
  if (ts.isPropertyAccessExpression(node)) {
    const left = qualifiedCallName(node.expression);
    return left ? `${left}.${node.name.text}` : node.name.text;
  }
  return undefined;
}

function detectCallPatterns(sourceText, patterns) {
  const adapter = callPatternAdapter({ name: "company-db", patterns });
  const sourceFile = ts.createSourceFile("src/runtime/public.ts", sourceText, ts.ScriptTarget.ESNext, true, ts.ScriptKind.TS);
  return adapter.detect({
    repository: baseRepository(),
    cell: baseRepository().manifest.cells[0],
    filePath: "src/runtime/public.ts",
    sourceText,
    sourceFile,
    helpers: {
      getQualifiedCallName(node) {
        return ts.isCallExpression(node) ? qualifiedCallName(node.expression) : undefined;
      },
      getStaticStringArgument(node, index) {
        const argument = node.arguments[index];
        if (!argument) return undefined;
        return ts.isStringLiteral(argument) || ts.isNoSubstitutionTemplateLiteral(argument) ? argument.text : undefined;
      },
      lineOf(node) {
        return sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
      },
    },
  });
}

test("official rule plugins produce concrete findings", () => {
  const rootDir = createRepo();
  try {
    const budgetResult = checkRepository({
      rootDir,
      manifestPath: "cellfence.manifest.json",
      baselinePath: "cellfence.baseline.json",
      changedFiles: ["src/core/public.ts", "src/app/public.ts"],
      plugins: [agentBudgetPlugin({ allowedCells: ["app"], maxFiles: 1, maxPublicSymbolsAdded: 0 })],
    });
    assert.ok(budgetResult.findings.some((finding) => finding.ruleId === "agent-budget/disallowed-cell"));
    assert.ok(budgetResult.findings.some((finding) => finding.ruleId === "agent-budget/public-symbol-budget"));

    const blastResult = checkRepository({
      rootDir,
      manifestPath: "cellfence.manifest.json",
      changedFiles: ["src/core/public.ts"],
      plugins: [blastRadiusPlugin({ maxAffectedCells: 1, severity: "error" })],
    });
    assert.ok(blastResult.findings.some((finding) => finding.ruleId === "blast-radius/affected-cells"));

    const legacyResult = checkRepository({
      rootDir,
      manifestPath: "cellfence.manifest.json",
      baselinePath: "cellfence.baseline.json",
      plugins: [legacyStranglerPlugin({ legacyCells: ["legacy"] })],
    });
    assert.ok(legacyResult.findings.some((finding) => finding.ruleId === "legacy-strangler/no-new-legacy-dependency"));

    const trendResult = checkRepository({
      rootDir,
      manifestPath: "cellfence.manifest.json",
      plugins: [quantsTrendPlugin({
        history: [
          { schemaVersion: "cellfence.baseline.v1", generatedAt: "2026-01-01T00:00:00.000Z", cells: { core: { ownedPathPatterns: 1, publicSymbols: 1, publicSurfaceLines: 1, crossCellDependencies: 0 } } },
          { schemaVersion: "cellfence.baseline.v1", generatedAt: "2026-01-02T00:00:00.000Z", cells: { core: { ownedPathPatterns: 1, publicSymbols: 1, publicSurfaceLines: 1, crossCellDependencies: 0 } } },
        ],
        minimumGrowth: 0,
        multiplier: 1,
      })],
    });
    assert.ok(trendResult.warnings.some((finding) => finding.ruleId === "quants-trend/architecture-momentum"));

    const geoResult = checkRepository({
      rootDir,
      manifestPath: "cellfence.manifest.json",
      plugins: [geoPurityPlugin({ requirePublicJsdoc: true, severity: "error" })],
    });
    assert.ok(geoResult.findings.some((finding) => finding.ruleId === "geo-purity/public-symbol-undocumented"));

    const sovereigntyResult = checkRepository({
      rootDir,
      manifestPath: "cellfence.manifest.json",
      baselinePath: "cellfence.baseline.json",
      plugins: [dependencySovereigntyPlugin({ actor: "team-app", cellOwners: { legacy: ["team-legacy"] } })],
    });
    assert.ok(sovereigntyResult.findings.some((finding) => finding.ruleId === "dependency-sovereignty/approval-required"));
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("official plugin metadata is stable and machine-readable", () => {
  const plugins = [
    agentBudgetPlugin({ severity: "warning" }),
    blastRadiusPlugin({ severity: "error" }),
    dependencySovereigntyPlugin({ cellOwners: { core: ["team-core"] }, changedOnly: true }),
    geoPurityPlugin({ severity: "error" }),
    legacyStranglerPlugin({ legacyCells: ["legacy"], severity: "warning" }),
    quantsTrendPlugin({ history: [{ schemaVersion: "cellfence.baseline.v1", generatedAt: "2026-01-01T00:00:00.000Z", cells: {} }, { schemaVersion: "cellfence.baseline.v1", generatedAt: "2026-01-02T00:00:00.000Z", cells: {} }] }),
    economyMatrixPlugin(),
  ];

  assert.deepEqual(plugins.map((plugin) => ({
    apiVersion: plugin.apiVersion,
    name: plugin.name,
    version: plugin.version,
    capabilities: plugin.capabilities || {},
    ruleIds: Object.keys(plugin.rules || {}),
    reporterNames: (plugin.reporters || []).map((reporter) => reporter.name),
  })), [{
    apiVersion: 1,
    name: "@cellfence/plugin-agent-budget",
    version: "0.1.8",
    capabilities: { needsGitDiff: true },
    ruleIds: ["agent-budget/change-budget"],
    reporterNames: [],
  }, {
    apiVersion: 1,
    name: "@cellfence/plugin-blast-radius",
    version: "0.1.8",
    capabilities: { needsGitDiff: true },
    ruleIds: ["blast-radius/affected-cells"],
    reporterNames: [],
  }, {
    apiVersion: 1,
    name: "@cellfence/plugin-dependency-sovereignty",
    version: "0.1.8",
    capabilities: { needsGitDiff: true },
    ruleIds: ["dependency-sovereignty/approval-required"],
    reporterNames: [],
  }, {
    apiVersion: 1,
    name: "@cellfence/plugin-geo-purity",
    version: "0.1.8",
    capabilities: {},
    ruleIds: ["geo-purity/context-shape"],
    reporterNames: [],
  }, {
    apiVersion: 1,
    name: "@cellfence/plugin-legacy-strangler",
    version: "0.1.8",
    capabilities: {},
    ruleIds: ["legacy-strangler/no-new-legacy-dependency"],
    reporterNames: [],
  }, {
    apiVersion: 1,
    name: "@cellfence/plugin-quants-trend",
    version: "0.1.8",
    capabilities: {},
    ruleIds: ["quants-trend/architecture-momentum"],
    reporterNames: [],
  }, {
    apiVersion: 1,
    name: "@cellfence/reporter-economy-matrix",
    version: "0.1.8",
    capabilities: {},
    ruleIds: [],
    reporterNames: ["@cellfence/reporter-economy-matrix"],
  }]);

  assert.deepEqual(directRule(agentBudgetPlugin({ severity: "warning" }), "agent-budget/change-budget").meta, {
    description: "Rejects changed files and architecture growth outside an agent budget.",
    defaultSeverity: "warning",
    category: "agent-governance",
  });
  assert.deepEqual(directRule(blastRadiusPlugin({ severity: "error" }), "blast-radius/affected-cells").meta, {
    description: "Warns when changed cells have too many downstream consumers.",
    defaultSeverity: "error",
    category: "change-risk",
  });
  assert.deepEqual(directRule(dependencySovereigntyPlugin({ cellOwners: { core: ["team-core"] } }), "dependency-sovereignty/approval-required").meta, {
    description: "Requires owner approval before depending on protected cells.",
    defaultSeverity: "error",
    category: "team-governance",
  });
});

test("agent budget plugin emits exact budget findings", () => {
  const rule = directRule(agentBudgetPlugin({
    allowedCells: ["app"],
    forbiddenPaths: ["src/app/*"],
    maxFiles: 1,
    maxPublicSymbolsAdded: 0,
    maxDependencyEdgesAdded: 0,
    severity: "warning",
  }), "agent-budget/change-budget");

  assert.deepEqual(rule.run(directContext()), [{
    ruleId: "agent-budget/change-budget",
    severity: "warning",
    message: "changed file count 2 exceeds budget 1",
    details: {
      changedFiles: ["src/app/public.ts", "src/core/public.ts"],
      maxFiles: 1,
    },
  }, {
    ruleId: "agent-budget/forbidden-path",
    severity: "warning",
    filePath: "src/app/public.ts",
    message: "src/app/public.ts is forbidden by the agent budget",
    details: { forbiddenPaths: ["src/app/*"] },
  }, {
    ruleId: "agent-budget/disallowed-cell",
    severity: "warning",
    filePath: "src/core/public.ts",
    cellId: "core",
    message: "src/core/public.ts belongs to core, which is outside allowedCells",
    details: { allowedCells: ["app"] },
  }, {
    ruleId: "agent-budget/public-symbol-budget",
    severity: "warning",
    cellId: "core",
    message: "core added 1 public symbols, exceeding budget 0",
    details: { publicSymbolsAdded: 1, maxPublicSymbolsAdded: 0 },
  }, {
    ruleId: "agent-budget/dependency-budget",
    severity: "warning",
    cellId: "app",
    message: "app added 1 dependency edges, exceeding budget 0",
    details: { dependencyEdgesAdded: 1, maxDependencyEdgesAdded: 0 },
  }]);
});

test("agent budget plugin covers glob, ownership fallback, and boundary budgets", () => {
  const rule = directRule(agentBudgetPlugin({
    allowedCells: ["app"],
    forbiddenPaths: [
      "src/core/*.ts",
      "src/core/**",
      "src/core/public.ts",
      "src/core/windows.ts",
    ],
    maxFiles: 4,
    maxPublicSymbolsAdded: 0,
    maxDependencyEdgesAdded: 0,
  }), "agent-budget/change-budget");
  assert.equal(rule.id, "agent-budget/change-budget");
  assert.deepEqual(rule.meta, {
    description: "Rejects changed files and architecture growth outside an agent budget.",
    defaultSeverity: "error",
    category: "agent-governance",
  });

  const repository = baseRepository({
    manifest: {
      schemaVersion: "cellfence.manifest.v1",
      cells: [{
        id: "core",
        ownedPaths: ["src/core/**", "src/other/**"],
        publicEntry: "src/core/public.ts",
        publicSymbols: ["coreApi"],
        consumes: [],
        producesArtifacts: [],
      }, {
        id: "app",
        ownedPaths: ["src/app/**"],
        publicEntry: "src/app/public.ts",
        publicSymbols: ["appApi"],
        consumes: [],
        producesArtifacts: [],
      }],
    },
    files: {
      ...baseRepository().files,
      byCell: {
        core: ["generated/core-owned.ts"],
        app: ["src/app/public.ts"],
      },
    },
    changedFiles: new Set([
      "generated/core-owned.ts",
      "src/core/deep/nested.ts",
      "src/core/public.ts",
      "src\\core\\windows.ts",
    ]),
    baseline: {
      schemaVersion: "cellfence.baseline.v1",
      generatedAt: "2026-01-01T00:00:00.000Z",
      cells: {
        core: {
          publicSymbolSet: undefined,
          dependencyEdges: undefined,
        },
      },
    },
    metrics: {
      core: {
        publicSymbolSet: undefined,
        dependencyEdges: undefined,
      },
    },
  });

  assert.deepEqual(rule.run(directContext(repository)), [{
    ruleId: "agent-budget/disallowed-cell",
    severity: "error",
    filePath: "generated/core-owned.ts",
    cellId: "core",
    message: "generated/core-owned.ts belongs to core, which is outside allowedCells",
    details: { allowedCells: ["app"] },
  }, {
    ruleId: "agent-budget/forbidden-path",
    severity: "error",
    filePath: "src/core/deep/nested.ts",
    message: "src/core/deep/nested.ts is forbidden by the agent budget",
    details: {
      forbiddenPaths: [
        "src/core/*.ts",
        "src/core/**",
        "src/core/public.ts",
        "src/core/windows.ts",
      ],
    },
  }, {
    ruleId: "agent-budget/disallowed-cell",
    severity: "error",
    filePath: "src/core/deep/nested.ts",
    cellId: "core",
    message: "src/core/deep/nested.ts belongs to core, which is outside allowedCells",
    details: { allowedCells: ["app"] },
  }, {
    ruleId: "agent-budget/forbidden-path",
    severity: "error",
    filePath: "src/core/public.ts",
    message: "src/core/public.ts is forbidden by the agent budget",
    details: {
      forbiddenPaths: [
        "src/core/*.ts",
        "src/core/**",
        "src/core/public.ts",
        "src/core/windows.ts",
      ],
    },
  }, {
    ruleId: "agent-budget/disallowed-cell",
    severity: "error",
    filePath: "src/core/public.ts",
    cellId: "core",
    message: "src/core/public.ts belongs to core, which is outside allowedCells",
    details: { allowedCells: ["app"] },
  }, {
    ruleId: "agent-budget/forbidden-path",
    severity: "error",
    filePath: "src\\core\\windows.ts",
    message: "src\\core\\windows.ts is forbidden by the agent budget",
    details: {
      forbiddenPaths: [
        "src/core/*.ts",
        "src/core/**",
        "src/core/public.ts",
        "src/core/windows.ts",
      ],
    },
  }, {
    ruleId: "agent-budget/disallowed-cell",
    severity: "error",
    filePath: "src\\core\\windows.ts",
    cellId: "core",
    message: "src\\core\\windows.ts belongs to core, which is outside allowedCells",
    details: { allowedCells: ["app"] },
  }]);
});

test("agent budget plugin handles isolated glob and default-array edge cases", () => {
  const exactContext = (changedFiles = ["src/core/one.ts"]) => directContext(baseRepository({
    manifest: {
      schemaVersion: "cellfence.manifest.v1",
      cells: [{
        id: "core",
        ownedPaths: ["src/core/**"],
        publicEntry: "src/core/public.ts",
        publicSymbols: ["coreApi"],
        consumes: [],
        producesArtifacts: [],
      }],
    },
    files: {
      ...baseRepository().files,
      byCell: {},
    },
    changedFiles: new Set(changedFiles),
    baseline: null,
    metrics: {},
  }));

  assert.deepEqual(
    directRule(agentBudgetPlugin({ forbiddenPaths: ["src/core/*.ts"] }), "agent-budget/change-budget")
      .run(exactContext()).map((finding) => finding.ruleId),
    ["agent-budget/forbidden-path"],
  );
  assert.deepEqual(
    directRule(agentBudgetPlugin({ forbiddenPaths: ["src/core/*.ts"] }), "agent-budget/change-budget")
      .run(exactContext(["src/core/deep/nested.ts"])),
    [],
  );
  assert.deepEqual(
    directRule(agentBudgetPlugin({ forbiddenPaths: ["src/core/public.ts"] }), "agent-budget/change-budget")
      .run(exactContext(["src/core/public.ts"])).map((finding) => finding.ruleId),
    ["agent-budget/forbidden-path"],
  );
  assert.deepEqual(
    directRule(agentBudgetPlugin(), "agent-budget/change-budget")
      .run(exactContext(["Stryker was here"])),
    [],
  );

  const symbolBudgetRule = directRule(agentBudgetPlugin({ maxPublicSymbolsAdded: 0 }), "agent-budget/change-budget");
  assert.deepEqual(symbolBudgetRule.run(directContext(baseRepository({
    baseline: {
      schemaVersion: "cellfence.baseline.v1",
      generatedAt: "2026-01-01T00:00:00.000Z",
      cells: { core: { publicSymbolSet: undefined } },
    },
    metrics: { core: { publicSymbolSet: ["Stryker was here"] } },
    changedFiles: new Set([]),
  }))).map((finding) => finding.ruleId), ["agent-budget/public-symbol-budget"]);
  assert.deepEqual(symbolBudgetRule.run(directContext(baseRepository({
    baseline: {
      schemaVersion: "cellfence.baseline.v1",
      generatedAt: "2026-01-01T00:00:00.000Z",
      cells: { core: { publicSymbolSet: undefined } },
    },
    metrics: { core: { publicSymbolSet: undefined } },
    changedFiles: new Set([]),
  }))), []);
});

test("blast radius plugin emits exact downstream impact findings", () => {
  const rule = directRule(blastRadiusPlugin({ maxAffectedCells: 1, severity: "error" }), "blast-radius/affected-cells");
  const repository = baseRepository({
    changedFiles: new Set(["src/core/public.ts"]),
    imports: [
      { importerCellId: "mid", targetCellId: "core" },
      { importerCellId: "app", targetCellId: "mid" },
      { importerCellId: "app", targetCellId: "app" },
      { importerCellId: "orphan" },
    ],
  });
  assert.deepEqual(rule.run(directContext(repository)), [{
    ruleId: "blast-radius/affected-cells",
    severity: "error",
    message: "change affects 2 downstream cells, exceeding budget 1",
    details: {
      changedCells: ["core"],
      affectedCells: ["app", "mid"],
      maxAffectedCells: 1,
    },
  }]);
  assert.deepEqual(rule.run(directContext(baseRepository({ changedFiles: new Set(["README.md"]) }))), []);
});

test("blast radius plugin covers glob, self-edge, and threshold boundaries", () => {
  const defaultRule = directRule(blastRadiusPlugin(), "blast-radius/affected-cells");
  assert.equal(defaultRule.id, "blast-radius/affected-cells");
  assert.deepEqual(defaultRule.meta, {
    description: "Warns when changed cells have too many downstream consumers.",
    defaultSeverity: "warning",
    category: "change-risk",
  });

  const boundaryRepository = baseRepository({
    manifest: {
      schemaVersion: "cellfence.manifest.v1",
      cells: [{
        id: "alpha",
        ownedPaths: ["src/alpha/*.ts"],
        publicEntry: "src/alpha/public.ts",
        publicSymbols: [],
      }, {
        id: "beta",
        ownedPaths: ["src/beta/**", "src/other/**"],
        publicEntry: "src/beta/public.ts",
        publicSymbols: [],
      }, {
        id: "app",
        ownedPaths: ["src/app/**"],
        publicEntry: "src/app/public.ts",
        publicSymbols: [],
      }],
    },
    changedFiles: new Set(["src/beta/deep/nested.ts", "src/alpha/public.ts"]),
    imports: [
      { importerCellId: "app", targetCellId: "alpha" },
      { importerCellId: "app", targetCellId: "beta" },
    ],
  });
  assert.deepEqual(directRule(blastRadiusPlugin({ maxAffectedCells: 0, severity: "error" }), "blast-radius/affected-cells")
    .run(directContext(boundaryRepository)), [{
    ruleId: "blast-radius/affected-cells",
    severity: "error",
    message: "change affects 1 downstream cells, exceeding budget 0",
    details: {
      changedCells: ["alpha", "beta"],
      affectedCells: ["app"],
      maxAffectedCells: 0,
    },
  }]);

  const selfOnlyRepository = baseRepository({
    manifest: {
      schemaVersion: "cellfence.manifest.v1",
      cells: [{
        id: "core",
        ownedPaths: ["src/core/**", "src\\core\\**"],
        publicEntry: "src/core/public.ts",
        publicSymbols: [],
      }],
    },
    changedFiles: new Set(["src\\core\\windows.ts"]),
    imports: [
      { importerCellId: "core", targetCellId: "core" },
      { importerCellId: "orphan" },
    ],
  });
  assert.deepEqual(directRule(blastRadiusPlugin({ maxAffectedCells: 0 }), "blast-radius/affected-cells")
    .run(directContext(selfOnlyRepository)), []);

  const equalBudgetRepository = baseRepository({
    manifest: {
      schemaVersion: "cellfence.manifest.v1",
      cells: [{
        id: "core",
        ownedPaths: ["src/core/**"],
        publicEntry: "src/core/public.ts",
        publicSymbols: [],
      }],
    },
    changedFiles: new Set(["src/core/public.ts"]),
    imports: [{ importerCellId: "app", targetCellId: "core" }],
  });
  assert.deepEqual(directRule(blastRadiusPlugin({ maxAffectedCells: 1 }), "blast-radius/affected-cells")
    .run(directContext(equalBudgetRepository)), []);

  const exactAndWindowsRepository = baseRepository({
    manifest: {
      schemaVersion: "cellfence.manifest.v1",
      cells: [{
        id: "exact",
        ownedPaths: ["src/exact/public.ts"],
        publicEntry: "src/exact/public.ts",
        publicSymbols: [],
      }, {
        id: "win",
        ownedPaths: ["src/win/**"],
        publicEntry: "src/win/public.ts",
        publicSymbols: [],
      }],
    },
    changedFiles: new Set(["src/exact/public.ts", "src\\win\\public.ts"]),
    imports: [
      { importerCellId: "app", targetCellId: "exact" },
      { importerCellId: "worker", targetCellId: "win" },
    ],
  });
  assert.deepEqual(directRule(blastRadiusPlugin({ maxAffectedCells: 0 }), "blast-radius/affected-cells")
    .run(directContext(exactAndWindowsRepository)), [{
    ruleId: "blast-radius/affected-cells",
    severity: "warning",
    message: "change affects 2 downstream cells, exceeding budget 0",
    details: {
      changedCells: ["exact", "win"],
      affectedCells: ["app", "worker"],
      maxAffectedCells: 0,
    },
  }]);
});

test("dependency sovereignty plugin emits exact approval findings", () => {
  const rule = directRule(dependencySovereigntyPlugin({
    actor: "team-app",
    cellOwners: { legacy: ["team-legacy"] },
    changedOnly: true,
    severity: "error",
  }), "dependency-sovereignty/approval-required");
  assert.deepEqual(rule.run(directContext()), [{
    ruleId: "dependency-sovereignty/approval-required",
    severity: "error",
    cellId: "app",
    producerCellId: "legacy",
    message: "team-app added dependency app->legacy, but legacy requires owner approval",
    details: {
      edge: "app->legacy",
      actor: "team-app",
      owners: ["team-legacy"],
      approvedCells: [],
    },
    suggestedResolutions: [{
      kind: "ask-human",
      title: "Request approval from legacy owners",
      approvalRequired: true,
      details: {
        owners: ["team-legacy"],
        producer: "legacy",
        consumer: "app",
      },
    }],
  }]);
  const ownerRule = directRule(dependencySovereigntyPlugin({
    actor: "team-legacy",
    cellOwners: { legacy: ["team-legacy"] },
  }), "dependency-sovereignty/approval-required");
  assert.deepEqual(ownerRule.run(directContext()), []);
});

test("dependency sovereignty plugin covers sorting, changedOnly, and defaults", () => {
  const defaultRule = directRule(dependencySovereigntyPlugin({
    cellOwners: { legacy: ["team-legacy"] },
    approvedCells: ["other"],
  }), "dependency-sovereignty/approval-required");
  assert.equal(defaultRule.id, "dependency-sovereignty/approval-required");
  assert.deepEqual(defaultRule.meta, {
    description: "Requires owner approval before depending on protected cells.",
    defaultSeverity: "error",
    category: "team-governance",
  });
  assert.deepEqual(defaultRule.run(directContext(baseRepository({
    baseline: null,
    imports: [
      { importerCellId: "zeta", targetCellId: "legacy" },
      { importerCellId: "legacy", targetCellId: "legacy" },
      { importerCellId: "orphan" },
      { importerCellId: "app", targetCellId: "legacy" },
    ],
  }))).map((finding) => ({
    message: finding.message,
    details: finding.details,
  })), [{
    message: "unknown added dependency app->legacy, but legacy requires owner approval",
    details: {
      edge: "app->legacy",
      actor: "unknown",
      owners: ["team-legacy"],
      approvedCells: ["other"],
    },
  }, {
    message: "unknown added dependency zeta->legacy, but legacy requires owner approval",
    details: {
      edge: "zeta->legacy",
      actor: "unknown",
      owners: ["team-legacy"],
      approvedCells: ["other"],
    },
  }]);

  const changedOnlyFalseRule = directRule(dependencySovereigntyPlugin({
    actor: "team-app",
    cellOwners: { legacy: ["team-legacy"] },
    changedOnly: false,
  }), "dependency-sovereignty/approval-required");
  assert.equal(changedOnlyFalseRule.run(directContext(baseRepository({
    baseline: null,
    changedFiles: new Set([]),
    imports: [{ importerCellId: "app", targetCellId: "legacy" }],
  }))).length, 1);

  const changedOnlyTrueRule = directRule(dependencySovereigntyPlugin({
    actor: "team-app",
    cellOwners: { legacy: ["team-legacy"] },
    changedOnly: true,
  }), "dependency-sovereignty/approval-required");
  assert.deepEqual(changedOnlyTrueRule.run(directContext(baseRepository({
    baseline: null,
    changedFiles: new Set(["src/core/public.ts"]),
    files: {
      ...baseRepository().files,
      byCell: {
        app: ["src/app/public.ts"],
        core: ["src/core/public.ts"],
      },
    },
    imports: [{ importerCellId: "app", targetCellId: "legacy" }],
  }))), []);

  const ownerFallbackRule = directRule(dependencySovereigntyPlugin({
    actor: "Stryker was here",
    cellOwners: {},
    protectedCells: ["legacy"],
  }), "dependency-sovereignty/approval-required");
  assert.deepEqual(ownerFallbackRule.run(directContext(baseRepository({
    baseline: null,
    imports: [{ importerCellId: "app", targetCellId: "legacy" }],
  }))).map((finding) => finding.details), [{
    edge: "app->legacy",
    actor: "Stryker was here",
    owners: [],
    approvedCells: [],
  }]);
});

test("geo purity plugin emits exact context-shape findings", () => {
  const rule = directRule(geoPurityPlugin({
    maxPublicEntryLines: 1,
    maxOwnedFileLines: 2,
    requirePublicJsdoc: true,
    severity: "error",
  }), "geo-purity/context-shape");
  assert.deepEqual(rule.run(directContext()), [{
    ruleId: "geo-purity/public-entry-too-large",
    severity: "error",
    cellId: "core",
    filePath: "src/core/public.ts",
    message: "core public entry has 3 lines, exceeding 1",
    details: { lines: 3, maxPublicEntryLines: 1 },
  }, {
    ruleId: "geo-purity/public-symbol-undocumented",
    severity: "error",
    cellId: "core",
    filePath: "src/core/public.ts",
    message: "core public symbol coreApi is missing nearby JSDoc",
    details: { symbol: "coreApi" },
  }, {
    ruleId: "geo-purity/public-symbol-undocumented",
    severity: "error",
    cellId: "core",
    filePath: "src/core/public.ts",
    message: "core public symbol newApi is missing nearby JSDoc",
    details: { symbol: "newApi" },
  }, {
    ruleId: "geo-purity/owned-file-too-large",
    severity: "error",
    cellId: "core",
    filePath: "src/core/public.ts",
    message: "src/core/public.ts has 3 lines, exceeding 2",
    details: { lines: 3, maxOwnedFileLines: 2 },
  }, {
    ruleId: "geo-purity/owned-file-too-large",
    severity: "error",
    cellId: "core",
    filePath: "src/core/extra.ts",
    message: "src/core/extra.ts has 4 lines, exceeding 2",
    details: { lines: 4, maxOwnedFileLines: 2 },
  }, {
    ruleId: "geo-purity/public-entry-too-large",
    severity: "error",
    cellId: "mid",
    filePath: "src/mid/public.ts",
    message: "mid public entry has 2 lines, exceeding 1",
    details: { lines: 2, maxPublicEntryLines: 1 },
  }, {
    ruleId: "geo-purity/public-symbol-undocumented",
    severity: "error",
    cellId: "mid",
    filePath: "src/mid/public.ts",
    message: "mid public symbol midApi is missing nearby JSDoc",
    details: { symbol: "midApi" },
  }, {
    ruleId: "geo-purity/public-entry-too-large",
    severity: "error",
    cellId: "app",
    filePath: "src/app/public.ts",
    message: "app public entry has 2 lines, exceeding 1",
    details: { lines: 2, maxPublicEntryLines: 1 },
  }, {
    ruleId: "geo-purity/public-symbol-undocumented",
    severity: "error",
    cellId: "app",
    filePath: "src/app/public.ts",
    message: "app public symbol appApi is missing nearby JSDoc",
    details: { symbol: "appApi" },
  }, {
    ruleId: "geo-purity/public-entry-too-large",
    severity: "error",
    cellId: "legacy",
    filePath: "src/legacy/public.ts",
    message: "legacy public entry has 2 lines, exceeding 1",
    details: { lines: 2, maxPublicEntryLines: 1 },
  }, {
    ruleId: "geo-purity/public-symbol-undocumented",
    severity: "error",
    cellId: "legacy",
    filePath: "src/legacy/public.ts",
    message: "legacy public symbol legacyApi is missing nearby JSDoc",
    details: { symbol: "legacyApi" },
  }]);
});

test("geo purity plugin covers defaults, line boundaries, and escaped symbols", () => {
  const defaultRule = directRule(geoPurityPlugin(), "geo-purity/context-shape");
  assert.equal(defaultRule.id, "geo-purity/context-shape");
  assert.deepEqual(defaultRule.meta, {
    description: "Checks public API docs and overly large context surfaces for AI agents.",
    defaultSeverity: "warning",
    category: "agent-context",
  });

  const repository = baseRepository({
    manifest: {
      schemaVersion: "cellfence.manifest.v1",
      cells: [{
        id: "core",
        ownedPaths: ["src/core/**"],
        publicEntry: "src/core/public.ts",
        publicSymbols: ["undocumented"],
      }, {
        id: "empty",
        ownedPaths: ["src/empty/**"],
        publicEntry: "src/empty/public.ts",
        publicSymbols: [],
      }, {
        id: "special",
        ownedPaths: ["src/special/**"],
        publicEntry: "src/special/public.ts",
        publicSymbols: ["a$b"],
      }],
    },
    files: {
      all: [],
      governed: [],
      byCell: {
        core: ["src/core/public.ts"],
        special: ["src/special/public.ts"],
      },
      contents: {
        "src/core/public.ts": "export const undocumented = true;\n",
        "src/empty/public.ts": "",
        "src/special/public.ts": "/** Documents a different symbol. */\nexport const ab = true;\n",
        "Stryker was here": "too\nlarge\n",
      },
    },
  });

  assert.deepEqual(defaultRule.run(directContext(repository)), []);
  assert.deepEqual(directRule(geoPurityPlugin({
    maxPublicEntryLines: 3,
    maxOwnedFileLines: 3,
    requirePublicJsdoc: true,
    severity: "error",
  }), "geo-purity/context-shape").run(directContext(repository)), [{
    ruleId: "geo-purity/public-symbol-undocumented",
    severity: "error",
    cellId: "core",
    filePath: "src/core/public.ts",
    message: "core public symbol undocumented is missing nearby JSDoc",
    details: { symbol: "undocumented" },
  }, {
    ruleId: "geo-purity/public-symbol-undocumented",
    severity: "error",
    cellId: "special",
    filePath: "src/special/public.ts",
    message: "special public symbol a$b is missing nearby JSDoc",
    details: { symbol: "a$b" },
  }]);

  assert.deepEqual(directRule(geoPurityPlugin({
    maxPublicEntryLines: 0,
    maxOwnedFileLines: 0,
  }), "geo-purity/context-shape").run(directContext(baseRepository({
    manifest: {
      schemaVersion: "cellfence.manifest.v1",
      cells: [{
        id: "empty",
        ownedPaths: ["src/empty/**"],
        publicEntry: "src/empty/public.ts",
        publicSymbols: [],
      }],
    },
    files: {
      all: [],
      governed: [],
      byCell: {},
      contents: {
        "src/empty/public.ts": "",
        "Stryker was here": "too\nlarge\n",
      },
    },
  }))), []);
});

test("legacy strangler plugin emits exact legacy dependency findings", () => {
  const rule = directRule(legacyStranglerPlugin({
    legacyCells: ["legacy"],
    maxIncomingDependencies: { legacy: 0 },
    severity: "warning",
  }), "legacy-strangler/no-new-legacy-dependency");
  assert.deepEqual(rule.run(directContext()), [{
    ruleId: "legacy-strangler/no-new-legacy-dependency",
    severity: "warning",
    cellId: "legacy",
    message: "new dependency into legacy cell is not allowed: app->legacy",
    details: { edge: "app->legacy", legacyCells: ["legacy"] },
  }, {
    ruleId: "legacy-strangler/incoming-target",
    severity: "warning",
    cellId: "legacy",
    message: "legacy has 1 incoming legacy dependencies, exceeding target 0",
    details: { cellId: "legacy", count: 1, maxIncoming: 0 },
  }]);
});

test("legacy strangler plugin covers baseline filtering, sorting, and target boundaries", () => {
  const defaultRule = directRule(legacyStranglerPlugin({ legacyCells: ["legacy"] }), "legacy-strangler/no-new-legacy-dependency");
  assert.equal(defaultRule.id, "legacy-strangler/no-new-legacy-dependency");
  assert.deepEqual(defaultRule.meta, {
    description: "Rejects new dependencies into legacy cells.",
    defaultSeverity: "error",
    category: "migration",
  });

  const repository = baseRepository({
    baseline: {
      schemaVersion: "cellfence.baseline.v1",
      generatedAt: "2026-01-01T00:00:00.000Z",
      cells: {
        app: { dependencyEdges: ["app->legacy", "app->modern"] },
        empty: { dependencyEdges: undefined },
      },
    },
    metrics: {
      zeta: { dependencyEdges: ["zeta->legacy"] },
      app: { dependencyEdges: ["app->legacy", "app->modern"] },
      malformed: { dependencyEdges: ["legacy", "Stryker was here"] },
    },
  });
  assert.deepEqual(defaultRule.run(directContext(repository)), [{
    ruleId: "legacy-strangler/no-new-legacy-dependency",
    severity: "error",
    cellId: "legacy",
    message: "new dependency into legacy cell is not allowed: zeta->legacy",
    details: { edge: "zeta->legacy", legacyCells: ["legacy"] },
  }]);
  assert.deepEqual(defaultRule.run(directContext(baseRepository({
    baseline: null,
    metrics: {
      zeta: { dependencyEdges: ["zeta->legacy"] },
      app: { dependencyEdges: ["app->legacy"] },
    },
  }))).map((finding) => finding.details.edge), ["app->legacy", "zeta->legacy"]);

  const targetRule = directRule(legacyStranglerPlugin({
    legacyCells: ["legacy", "other"],
    maxIncomingDependencies: { legacy: 1 },
  }), "legacy-strangler/no-new-legacy-dependency");
  assert.deepEqual(targetRule.run(directContext(baseRepository({
    baseline: {
      schemaVersion: "cellfence.baseline.v1",
      generatedAt: "2026-01-01T00:00:00.000Z",
      cells: {
        app: { dependencyEdges: ["app->legacy", "app->other"] },
      },
    },
    metrics: {
      app: { dependencyEdges: ["app->legacy", "app->other"] },
    },
  }))), []);
});

test("quants trend plugin emits exact momentum findings", () => {
  const history = [{
    schemaVersion: "cellfence.baseline.v1",
    generatedAt: "2026-01-01T00:00:00.000Z",
    cells: { core: { publicSymbols: 1, crossCellDependencies: 0, publicSurfaceLines: 1 } },
  }, {
    schemaVersion: "cellfence.baseline.v1",
    generatedAt: "2026-01-02T00:00:00.000Z",
    cells: { core: { publicSymbols: 1, crossCellDependencies: 0, publicSurfaceLines: 1 } },
  }];
  const rule = directRule(quantsTrendPlugin({
    history,
    metrics: ["publicSymbols", "publicSurfaceLines"],
    multiplier: 2,
    minimumGrowth: 0,
    severity: "error",
  }), "quants-trend/architecture-momentum");
  const repository = baseRepository({
    metrics: {
      core: baseRepository().metrics.core,
    },
  });
  assert.deepEqual(rule.run(directContext(repository)), [{
    ruleId: "quants-trend/architecture-momentum",
    severity: "error",
    cellId: "core",
    message: "core.publicSymbols grew by 1, above momentum threshold 0",
    details: {
      cellId: "core",
      metric: "publicSymbols",
      currentDelta: 1,
      averageDelta: 0,
      threshold: 0,
      history: [1, 1],
    },
  }, {
    ruleId: "quants-trend/architecture-momentum",
    severity: "error",
    cellId: "core",
    message: "core.publicSurfaceLines grew by 1, above momentum threshold 0",
    details: {
      cellId: "core",
      metric: "publicSurfaceLines",
      currentDelta: 1,
      averageDelta: 0,
      threshold: 0,
      history: [1, 1],
    },
  }]);
});

test("quants trend plugin covers defaults, moving average math, and equality boundary", () => {
  const defaultRule = directRule(quantsTrendPlugin({
    history: [{
      schemaVersion: "cellfence.baseline.v1",
      generatedAt: "2026-01-01T00:00:00.000Z",
      cells: { core: { publicSymbols: 1, crossCellDependencies: 1 } },
    }, {
      schemaVersion: "cellfence.baseline.v1",
      generatedAt: "2026-01-02T00:00:00.000Z",
      cells: { core: { publicSymbols: 2, crossCellDependencies: 1 } },
    }],
  }), "quants-trend/architecture-momentum");
  assert.equal(defaultRule.id, "quants-trend/architecture-momentum");
  assert.deepEqual(defaultRule.meta, {
    description: "Warns when architecture surface grows faster than recent baseline momentum.",
    defaultSeverity: "warning",
    category: "architecture-trend",
  });
  assert.deepEqual(defaultRule.run(directContext(baseRepository({
    metrics: {
      core: { publicSymbols: 5, crossCellDependencies: 4 },
    },
  }))).map((finding) => finding.details), [{
    cellId: "core",
    metric: "publicSymbols",
    currentDelta: 3,
    averageDelta: 1,
    threshold: 2,
    history: [1, 2],
  }, {
    cellId: "core",
    metric: "crossCellDependencies",
    currentDelta: 3,
    averageDelta: 0,
    threshold: 2,
    history: [1, 1],
  }]);

  const averageRule = directRule(quantsTrendPlugin({
    history: [{
      schemaVersion: "cellfence.baseline.v1",
      generatedAt: "2026-01-01T00:00:00.000Z",
      cells: { core: { publicSurfaceLines: 1 } },
    }, {
      schemaVersion: "cellfence.baseline.v1",
      generatedAt: "2026-01-02T00:00:00.000Z",
      cells: { core: { publicSurfaceLines: 3 } },
    }, {
      schemaVersion: "cellfence.baseline.v1",
      generatedAt: "2026-01-03T00:00:00.000Z",
      cells: { core: { publicSurfaceLines: 4 } },
    }],
    metrics: ["publicSurfaceLines"],
    multiplier: 2,
    minimumGrowth: 0,
    severity: "error",
  }), "quants-trend/architecture-momentum");
  assert.deepEqual(averageRule.run(directContext(baseRepository({
    metrics: { core: { publicSurfaceLines: 8 } },
  }))), [{
    ruleId: "quants-trend/architecture-momentum",
    severity: "error",
    cellId: "core",
    message: "core.publicSurfaceLines grew by 4, above momentum threshold 3",
    details: {
      cellId: "core",
      metric: "publicSurfaceLines",
      currentDelta: 4,
      averageDelta: 1.5,
      threshold: 3,
      history: [1, 3, 4],
    },
  }]);
  assert.deepEqual(averageRule.run(directContext(baseRepository({
    metrics: { core: { publicSurfaceLines: 7 } },
  }))), []);
});

test("economy matrix reporter emits exact sorted rows and markdown", () => {
  const repository = baseRepository();
  const context = { repository, findings: [], warnings: [] };
  assert.deepEqual(createEconomyMatrix(context), [{
    cellId: "core",
    producesPublicSymbols: 2,
    producesArtifacts: 1,
    consumesCells: 0,
    consumesResources: 1,
    observedImports: 0,
  }, {
    cellId: "app",
    producesPublicSymbols: 1,
    producesArtifacts: 0,
    consumesCells: 2,
    consumesResources: 1,
    observedImports: 2,
  }, {
    cellId: "mid",
    producesPublicSymbols: 1,
    producesArtifacts: 0,
    consumesCells: 1,
    consumesResources: 0,
    observedImports: 1,
  }, {
    cellId: "legacy",
    producesPublicSymbols: 1,
    producesArtifacts: 0,
    consumesCells: 0,
    consumesResources: 0,
    observedImports: 0,
  }]);
  assert.equal(economyMatrixReporter().report(context), [
    "| cell | public symbols | artifact lanes | declared imports | observed imports | resource accesses |",
    "|---|---:|---:|---:|---:|---:|",
    "| core | 2 | 1 | 0 | 0 | 1 |",
    "| app | 1 | 0 | 2 | 2 | 1 |",
    "| mid | 1 | 0 | 1 | 1 | 0 |",
    "| legacy | 1 | 0 | 0 | 0 | 0 |",
  ].join("\n"));
});

test("economy matrix reporter ignores self imports and missing optional arrays", () => {
  assert.deepEqual(createEconomyMatrix({
    repository: {
      manifest: {
        schemaVersion: "cellfence.manifest.v1",
        cells: [{
          id: "solo",
          ownedPaths: ["src/solo/**"],
          publicEntry: "src/solo/public.ts",
          publicSymbols: [],
        }],
      },
      imports: [
        { importerCellId: "solo", targetCellId: "solo" },
        { importerCellId: "solo" },
      ],
      resources: [],
    },
    findings: [],
    warnings: [],
  }), [{
    cellId: "solo",
    producesPublicSymbols: 0,
    producesArtifacts: 0,
    consumesCells: 0,
    consumesResources: 0,
    observedImports: 0,
  }]);
});

test("declarative call-pattern adapter feeds resource contracts", () => {
  const rootDir = createRepo();
  try {
    const result = checkRepository({
      rootDir,
      manifestPath: "cellfence.manifest.json",
      plugins: [{
        apiVersion: 1,
        name: "company-patterns",
        version: "1.0.0",
        adapters: [
          callPatternAdapter({
            name: "company-internal-db",
            patterns: [{ call: "internalDb.write", resourceArgument: 0, resourceKind: "database", operation: "write" }],
          }),
        ],
      }],
    });
    assert.ok(result.findings.some((finding) =>
      finding.ruleId === "CELLFENCE_UNDECLARED_RESOURCE_ACCESS"
      && finding.details?.detectedBy === "company-internal-db"
      && finding.details?.selector === "T_ORDER"));
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("opentelemetry adapter converts spans into resource evidence", () => {
  const evidence = openTelemetryToResourceEvidence({
    resourceSpans: [{
      scopeSpans: [{
        spans: [{
          name: "SELECT users",
          attributes: {
            "service.name": "runtime",
            "db.system": "mysql",
            "db.sql.table": "app.users",
            "db.operation": "SELECT",
          },
        }],
      }],
    }],
  }, { generatedAt: "2026-01-01T00:00:00.000Z" });
  const validation = validateResourceEvidence(evidence);
  assert.equal(validation.ok, true);
  assert.deepEqual(evidence.accesses, [{
    kind: "database",
    access: "read",
    selector: "app.users",
    cellId: "runtime",
    observedAt: "2026-01-01T00:00:00.000Z",
    detectedBy: "opentelemetry",
    confidence: "runtime",
  }]);
});

test("economy matrix reporter summarizes producer and consumer load", () => {
  const context = {
    repository: {
      manifest: {
        schemaVersion: "cellfence.manifest.v1",
        cells: [{
          id: "core",
          ownedPaths: ["src/core/**"],
          publicEntry: "src/core/public.ts",
          publicSymbols: ["a", "b"],
          consumes: [],
          producesArtifacts: [{ id: "core-out", paths: ["artifacts/core/**"] }],
        }],
      },
      imports: [{ importerCellId: "app", targetCellId: "core" }],
      resources: [{ cellId: "core" }],
    },
    findings: [],
    warnings: [],
  };
  const rows = createEconomyMatrix(context);
  assert.deepEqual(rows[0], {
    cellId: "core",
    producesPublicSymbols: 2,
    producesArtifacts: 1,
    consumesCells: 0,
    consumesResources: 1,
    observedImports: 0,
  });
  assert.match(economyMatrixReporter().report(context), /\| core \| 2 \| 1 \| 0 \| 0 \| 1 \|/);
});

test("official rule plugins cover pass, warning, and secondary budget branches", () => {
  const rootDir = createRepo();
  try {
    fs.writeFileSync(path.join(rootDir, "src/app/extra.ts"), "export const extra = true;\n");

    const budgetResult = checkRepository({
      rootDir,
      manifestPath: "cellfence.manifest.json",
      baselinePath: "cellfence.baseline.json",
      changedFiles: ["src/app/extra.ts", "src/core/public.ts"],
      plugins: [agentBudgetPlugin({
        allowedCells: ["app", "core"],
        forbiddenPaths: ["src/app/*"],
        maxFiles: 1,
        maxDependencyEdgesAdded: 0,
        severity: "warning",
      })],
    });
    assert.ok(budgetResult.warnings.some((finding) => finding.ruleId === "agent-budget/change-budget"));
    assert.ok(budgetResult.warnings.some((finding) => finding.ruleId === "agent-budget/forbidden-path"));
    assert.ok(budgetResult.warnings.some((finding) => finding.ruleId === "agent-budget/dependency-budget"));

    const geoResult = checkRepository({
      rootDir,
      manifestPath: "cellfence.manifest.json",
      plugins: [geoPurityPlugin({ maxPublicEntryLines: 1, maxOwnedFileLines: 1, severity: "error" })],
    });
    assert.ok(geoResult.findings.some((finding) => finding.ruleId === "geo-purity/public-entry-too-large"));
    assert.ok(geoResult.findings.some((finding) => finding.ruleId === "geo-purity/owned-file-too-large"));

    const legacyResult = checkRepository({
      rootDir,
      manifestPath: "cellfence.manifest.json",
      baselinePath: "cellfence.baseline.json",
      plugins: [legacyStranglerPlugin({ legacyCells: ["legacy"], maxIncomingDependencies: { legacy: 0 }, severity: "warning" })],
    });
    assert.ok(legacyResult.warnings.some((finding) => finding.ruleId === "legacy-strangler/incoming-target"));

    const ownerResult = checkRepository({
      rootDir,
      manifestPath: "cellfence.manifest.json",
      baselinePath: "cellfence.baseline.json",
      changedFiles: ["src/app/public.ts"],
      plugins: [dependencySovereigntyPlugin({
        actor: "team-legacy",
        cellOwners: { legacy: ["team-legacy"] },
        changedOnly: true,
      })],
    });
    assert.deepEqual(ownerResult.findings.filter((finding) => finding.ruleId === "dependency-sovereignty/approval-required"), []);

    const approvedResult = checkRepository({
      rootDir,
      manifestPath: "cellfence.manifest.json",
      baselinePath: "cellfence.baseline.json",
      changedFiles: ["src/app/public.ts"],
      plugins: [dependencySovereigntyPlugin({
        actor: "team-app",
        cellOwners: { legacy: ["team-legacy"] },
        approvedCells: ["legacy"],
        changedOnly: true,
      })],
    });
    assert.deepEqual(approvedResult.findings.filter((finding) => finding.ruleId === "dependency-sovereignty/approval-required"), []);

    const blastPass = checkRepository({
      rootDir,
      manifestPath: "cellfence.manifest.json",
      changedFiles: ["README.md"],
      plugins: [blastRadiusPlugin({ maxAffectedCells: 0 })],
    });
    assert.deepEqual(blastPass.warnings.filter((finding) => finding.ruleId === "blast-radius/affected-cells"), []);

    const shortTrend = checkRepository({
      rootDir,
      manifestPath: "cellfence.manifest.json",
      plugins: [quantsTrendPlugin({ history: [], severity: "error" })],
    });
    assert.deepEqual(shortTrend.findings.filter((finding) => finding.ruleId === "quants-trend/architecture-momentum"), []);

    const unownedBudgetResult = checkRepository({
      rootDir,
      manifestPath: "cellfence.manifest.json",
      changedFiles: ["README.md"],
      plugins: [agentBudgetPlugin({ allowedCells: ["app"] })],
    });
    assert.deepEqual(unownedBudgetResult.findings.filter((finding) => finding.ruleId.startsWith("agent-budget/")), []);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("geo purity accepts documented public symbols", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-geo-documented-"));
  try {
    fs.mkdirSync(path.join(rootDir, "src/core"), { recursive: true });
    fs.writeFileSync(
      path.join(rootDir, "src/core/public.ts"),
      [
        "/** Public constant used by downstream cells. */",
        "export const documented = true;",
        "/** Public type used by downstream cells. */",
        "export type Documented = { ok: boolean };",
        "const named = true;",
        "/** Named export facade. */",
        "export { named };",
        "",
      ].join("\n"),
    );
    writeJson(path.join(rootDir, "cellfence.manifest.json"), {
      schemaVersion: "cellfence.manifest.v1",
      cells: [{
        id: "core",
        ownedPaths: ["src/core/**"],
        publicEntry: "src/core/public.ts",
        publicSymbols: ["documented", "Documented", "named"],
        consumes: [],
        producesArtifacts: [],
      }],
    });

    const result = checkRepository({
      rootDir,
      manifestPath: "cellfence.manifest.json",
      plugins: [geoPurityPlugin({ requirePublicJsdoc: true })],
    });
    assert.deepEqual(result.warnings.filter((finding) => finding.ruleId.startsWith("geo-purity/")), []);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("opentelemetry adapter handles nested, array, and semantic-convention variants", () => {
  const evidence = openTelemetryToResourceEvidence([
    {
      instrumentationLibrarySpans: [{
        spans: [{
          name: "fallback-file-name",
          attributes: [
            { key: "cellfence.resource.kind", value: { stringValue: "file" } },
            { key: "cellfence.resource.operation", value: { stringValue: "write" } },
            { key: "service.name", value: { stringValue: "runtime" } },
          ],
        }],
      }],
    },
    {
      scopeSpans: [{
        spans: [{
          attributes: {
            "messaging.system": "messaging",
            "messaging.destination.name": "orders.created",
            "messaging.operation": "receive",
            "cell.id": "worker",
          },
        }],
      }],
    },
    {
      spans: [{
        name: "GET /health",
        attributes: {
          "rpc.system": "rpc",
          "http.request.method": "server",
          "http.route": "/health",
          time: "2026-01-01T00:00:00.000Z",
        },
      }, {
        name: "",
        attributes: {
          "cellfence.resource.kind": "file",
        },
      }],
    },
  ], {
    defaultCellId: "fallback-cell",
    commitSha: "abc123",
    generatedAt: "2026-01-01T00:00:00.000Z",
  });

  assert.equal(evidence.commitSha, "abc123");
  assert.deepEqual(evidence.accesses.map((access) => `${access.cellId}:${access.kind}:${access.access}:${access.selector}`), [
    "runtime:file:write:fallback-file-name",
    "worker:queue:subscribe:orders.created",
    "fallback-cell:http:serve:/health",
  ]);
});

test("opentelemetry adapter ignores non-span objects and malformed attributes", () => {
  assert.deepEqual(openTelemetryToResourceEvidence("not-an-object").accesses, []);
  assert.deepEqual(openTelemetryToResourceEvidence({ notSpans: true }, { generatedAt: "2026-01-01T00:00:00.000Z" }).accesses, []);
  assert.deepEqual(openTelemetryToResourceEvidence({
    spans: [{
      name: "bad attributes",
      attributes: "not-an-attribute-map",
    }],
  }, { generatedAt: "2026-01-01T00:00:00.000Z" }).accesses, []);
});

test("opentelemetry adapter covers default inference branches", () => {
  const evidence = openTelemetryToResourceEvidence({
    spans: [{
      name: "insert span",
      attributes: {
        "cellfence.resource.kind": "db",
        "cellfence.resource.selector": "app.orders",
        "db.operation": "INSERT",
      },
    }, {
      name: "publish span",
      attributes: {
        "messaging.destination.name": "orders.created",
      },
    }, {
      name: "http span",
      attributes: {
        "url.full": "https://api.example.test/status",
      },
    }, {
      name: "generic write",
      attributes: {
        "cellfence.resource.kind": "file",
        "cellfence.resource.operation": "overwrite",
        "cellfence.resource.selector": "data/output.json",
      },
    }, {
      name: "generic read",
      attributes: {
        "cellfence.resource.kind": "file",
        "cellfence.resource.selector": "data/input.json",
      },
    }],
  });

  assert.equal(Date.parse(evidence.generatedAt) > 0, true);
  assert.deepEqual(evidence.accesses.map((access) => `${access.kind}:${access.access}:${access.selector}`), [
    "database:write:app.orders",
    "queue:publish:orders.created",
    "http:call:https://api.example.test/status",
    "file:write:data/output.json",
    "file:read:data/input.json",
  ]);
});

test("opentelemetry adapter preserves explicit kind aliases and operation modes", () => {
  const evidence = openTelemetryToResourceEvidence({
    spans: [{
      name: "file-kind",
      attributes: {
        "cellfence.resource.kind": "file",
        "cellfence.resource.operation": "publish",
        "cellfence.resource.selector": "data/file.json",
        "cellfence.cell": "file-cell",
      },
    }, {
      name: "database-kind",
      attributes: {
        "cellfence.resource.kind": "database",
        "cellfence.resource.operation": "subscribe",
        "cellfence.resource.selector": "app.events",
      },
    }, {
      name: "queue-kind",
      attributes: {
        "cellfence.resource.kind": "queue",
        "cellfence.resource.operation": "read",
        "cellfence.resource.selector": "orders.created",
      },
    }, {
      name: "http-kind",
      attributes: {
        "cellfence.resource.kind": "http",
        "cellfence.resource.operation": "write",
        "cellfence.resource.selector": "https://api.example.test/orders",
      },
    }, {
      name: "db-alias",
      attributes: {
        "cellfence.resource.kind": "db",
        "cellfence.resource.operation": "call",
        "cellfence.resource.selector": "app.alias",
      },
    }, {
      name: "queue-alias",
      attributes: {
        "cellfence.resource.kind": "queue_topic",
        "cellfence.resource.operation": "serve",
        "cellfence.resource.selector": "orders.alias",
      },
    }, {
      name: "rpc-alias",
      attributes: {
        "cellfence.resource.kind": "rpc",
        "cellfence.resource.operation": "publish",
        "cellfence.resource.selector": "legacy-auth",
      },
    }],
  }, { generatedAt: "2026-01-01T00:00:00.000Z" });

  assert.deepEqual(evidence.accesses.map((access) => ({
    kind: access.kind,
    access: access.access,
    selector: access.selector,
    cellId: access.cellId,
  })), [{
    kind: "file",
    access: "publish",
    selector: "data/file.json",
    cellId: "file-cell",
  }, {
    kind: "database",
    access: "subscribe",
    selector: "app.events",
    cellId: undefined,
  }, {
    kind: "queue",
    access: "read",
    selector: "orders.created",
    cellId: undefined,
  }, {
    kind: "http",
    access: "write",
    selector: "https://api.example.test/orders",
    cellId: undefined,
  }, {
    kind: "database",
    access: "call",
    selector: "app.alias",
    cellId: undefined,
  }, {
    kind: "queue",
    access: "serve",
    selector: "orders.alias",
    cellId: undefined,
  }, {
    kind: "http",
    access: "publish",
    selector: "legacy-auth",
    cellId: undefined,
  }]);
});

test("opentelemetry adapter ignores blank attributes and malformed attribute arrays", () => {
  const evidence = openTelemetryToResourceEvidence({
    spans: [{
      name: "   ",
      attributes: {
        "cellfence.resource.kind": "file",
        "cellfence.resource.selector": "   ",
      },
    }, {
      name: "   ",
      attributes: {
        "cellfence.resource.kind": { stringValue: "file" },
        "cellfence.resource.selector": { stringValue: "   " },
      },
    }, {
      name: "blank kind",
      attributes: {
        "cellfence.resource.kind": "   ",
        "cellfence.resource.selector": "data/ignored.json",
      },
    }, {
      name: "valid after malformed array attributes",
      attributes: [
        null,
        "bad",
        { key: 123, value: { stringValue: "ignored" } },
        { key: "cellfence.resource.kind" },
        { key: "cellfence.resource.kind", value: { stringValue: "http" } },
        { key: "url.full", value: { stringValue: "https://api.example.test/array" } },
      ],
    }],
  }, { generatedAt: "2026-01-01T00:00:00.000Z" });

  assert.deepEqual(evidence.accesses, [{
    kind: "http",
    access: "call",
    selector: "https://api.example.test/array",
    cellId: undefined,
    observedAt: "2026-01-01T00:00:00.000Z",
    detectedBy: "opentelemetry",
    confidence: "runtime",
  }]);
});

test("opentelemetry adapter applies selector and timestamp priority exactly", () => {
  const evidence = openTelemetryToResourceEvidence({
    spans: [{
      name: "span fallback should lose",
      attributes: {
        "db.name": "app.db",
        "db.sql.table": "app.table",
        "cellfence.resource.selector": "manual.selector",
        "service.name": "service-cell",
        "cell.id": "cell-id",
        "cellfence.cell": "explicit-cell",
        "time": "2026-01-02T03:04:05.000Z",
      },
    }, {
      name: "span-name-fallback",
      attributes: {
        "cellfence.resource.kind": "file",
      },
    }],
  }, {
    defaultCellId: "default-cell",
    generatedAt: "2026-01-01T00:00:00.000Z",
  });

  assert.deepEqual(evidence.accesses, [{
    kind: "database",
    access: "read",
    selector: "manual.selector",
    cellId: "explicit-cell",
    observedAt: "2026-01-02T03:04:05.000Z",
    detectedBy: "opentelemetry",
    confidence: "runtime",
  }, {
    kind: "file",
    access: "read",
    selector: "span-name-fallback",
    cellId: "default-cell",
    observedAt: "2026-01-01T00:00:00.000Z",
    detectedBy: "opentelemetry",
    confidence: "runtime",
  }]);
});

test("opentelemetry adapter recognizes semantic-convention keys without fallback hints", () => {
  const evidence = openTelemetryToResourceEvidence({
    spans: [{
      name: "db-system-name-selector",
      attributes: { "db.system": "database" },
    }, {
      name: "messaging-system-name-selector",
      attributes: { "messaging.system": "messaging" },
    }, {
      name: "rpc-system-name-selector",
      attributes: { "rpc.system": "rpc" },
    }, {
      name: "http-scheme-name-selector",
      attributes: { "http.scheme": "http" },
    }, {
      name: "url-scheme-name-selector",
      attributes: { "url.scheme": "http" },
    }, {
      name: "db-name-inferred",
      attributes: { "db.name": "app.database" },
    }, {
      name: "http-route-inferred",
      attributes: { "http.route": "/orders/:id" },
    }, {
      name: "queue-destination-fallback",
      attributes: {
        "cellfence.resource.kind": "queue",
        "messaging.destination": "orders.fallback",
      },
    }],
  }, { generatedAt: "2026-01-01T00:00:00.000Z" });

  assert.deepEqual(evidence.accesses.map((access) => `${access.kind}:${access.access}:${access.selector}`), [
    "database:read:db-system-name-selector",
    "queue:publish:messaging-system-name-selector",
    "http:call:rpc-system-name-selector",
    "http:call:http-scheme-name-selector",
    "http:call:url-scheme-name-selector",
    "database:read:app.database",
    "http:call:/orders/:id",
    "queue:publish:orders.fallback",
  ]);
});

test("opentelemetry adapter distinguishes unmatched operations from semantic matches", () => {
  const evidence = openTelemetryToResourceEvidence({
    spans: [{
      name: "queue-send",
      attributes: {
        "cellfence.resource.kind": "queue",
        "cellfence.resource.selector": "orders.send",
        "messaging.operation": "send",
      },
    }, {
      name: "http-client-get",
      attributes: {
        "cellfence.resource.kind": "http",
        "cellfence.resource.selector": "https://api.example.test/orders",
        "http.request.method": "GET",
      },
    }, {
      name: "file-append",
      attributes: {
        "cellfence.resource.kind": "file",
        "cellfence.resource.selector": "data/events.log",
        "cellfence.resource.operation": "append",
      },
    }, {
      name: "database-delete",
      attributes: {
        "cellfence.resource.kind": "database",
        "cellfence.resource.selector": "app.orders",
        "db.operation": "DELETE",
      },
    }],
  }, { generatedAt: "2026-01-01T00:00:00.000Z" });

  assert.deepEqual(evidence.accesses.map((access) => `${access.kind}:${access.access}:${access.selector}`), [
    "queue:publish:orders.send",
    "http:call:https://api.example.test/orders",
    "file:read:data/events.log",
    "database:write:app.orders",
  ]);
});

test("opentelemetry adapter ignores non-string wrapped values without throwing", () => {
  const evidence = openTelemetryToResourceEvidence({
    spans: [{
      name: "numeric stringValue",
      attributes: {
        "cellfence.resource.kind": { stringValue: 123 },
        "cellfence.resource.selector": "data/ignored.json",
      },
    }, {
      name: "scalar attributes are ignored",
      attributes: 123,
    }, {
      name: "boxed key must not override real inference",
      attributes: [
        { key: new String("cellfence.resource.kind"), value: { stringValue: "file" } },
        { key: "url.full", value: { stringValue: "https://api.example.test/boxed" } },
      ],
    }],
  }, { generatedAt: "2026-01-01T00:00:00.000Z" });

  assert.deepEqual(evidence.accesses, [{
    kind: "http",
    access: "call",
    selector: "https://api.example.test/boxed",
    cellId: undefined,
    observedAt: "2026-01-01T00:00:00.000Z",
    detectedBy: "opentelemetry",
    confidence: "runtime",
  }]);
});

test("declarative call-pattern adapter records dynamic resource arguments as unresolved", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-call-pattern-dynamic-"));
  try {
    fs.mkdirSync(path.join(rootDir, "src/runtime"), { recursive: true });
    fs.writeFileSync(
      path.join(rootDir, "src/runtime/public.ts"),
      [
        "declare const internalDb: { read(table: string): unknown };",
        "export function readDynamic(tableName: string): unknown {",
        "  return internalDb.read(tableName);",
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
        publicSymbols: ["readDynamic"],
        consumes: [],
        producesArtifacts: [],
        resourceContracts: [{
          id: "dynamic-db",
          kind: "database",
          access: ["read"],
          selectors: ["unresolved:company-db:internalDb.read"],
        }],
      }],
    });

    const result = checkRepository({
      rootDir,
      manifestPath: "cellfence.manifest.json",
      plugins: [{
        apiVersion: 1,
        name: "company-db",
        version: "1.0.0",
        adapters: [callPatternAdapter({
          name: "company-db",
          patterns: [{ call: "internalDb.read", resourceArgument: 0, resourceKind: "database", operation: "read" }],
        })],
      }],
    });

    assert.equal(result.ok, true, JSON.stringify(result.findings));
    assert.deepEqual(result.metrics.runtime.resourceAccesses, [{
      kind: "database",
      access: "read",
      selector: "unresolved:company-db:internalDb.read",
      detectedBy: "company-db",
      confidence: "low",
    }]);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("declarative call-pattern adapter emits exact static and dynamic accesses", () => {
  assert.deepEqual(detectCallPatterns([
    "declare const internalDb: { audit(table: string): void; read(table: string): void; write(table: string): void };",
    "const tableName = 'T_RUNTIME';",
    "internalDb.audit('IGNORED');",
    "internalDb.write('T_ORDER');",
    "internalDb.read(tableName);",
    "",
  ].join("\n"), [{
    call: "internalDb.read",
    resourceArgument: 0,
    resourceKind: "database",
    operation: "read",
  }, {
    call: "internalDb.write",
    resourceArgument: 0,
    resourceKind: "database",
    operation: "write",
  }]), [{
    kind: "database",
    access: "write",
    selector: "T_ORDER",
    filePath: "src/runtime/public.ts",
    line: 4,
    source: "internalDb.write",
    detectedBy: "company-db",
    confidence: "high",
    unresolved: false,
    reason: undefined,
  }, {
    kind: "database",
    access: "read",
    selector: "unresolved:company-db:internalDb.read",
    filePath: "src/runtime/public.ts",
    line: 5,
    source: "internalDb.read",
    detectedBy: "company-db",
    confidence: "low",
    unresolved: true,
    reason: "argument 0 for internalDb.read is dynamic",
  }]);
});

test("official plugins cover direct rule default and empty-edge branches", () => {
  const manifest = {
    schemaVersion: "cellfence.manifest.v1",
    cells: [{
      id: "core",
      ownedPaths: ["src/*/**"],
      publicEntry: "src/core/public.ts",
      publicSymbols: ["api"],
    }, {
      id: "legacy",
      ownedPaths: ["src/legacy/**"],
      publicEntry: "src/legacy/public.ts",
      publicSymbols: [],
    }],
  };
  const repository = {
    rootDir: "/repo",
    manifest,
    baseline: null,
    files: {
      all: ["src/core/new.ts", "src/legacy/public.ts"],
      governed: [],
      byCell: {},
      contents: {
        "src/core/public.ts": "",
      },
    },
    imports: [
      { importerCellId: "core" },
      { importerCellId: "core", targetCellId: "core" },
      { importerCellId: "legacy", targetCellId: "core" },
      { importerCellId: "core", targetCellId: "legacy" },
    ],
    resources: [{ cellId: "core" }, {}],
    metrics: {
      core: { publicSymbols: 0, crossCellDependencies: 0, publicSurfaceLines: 0, dependencyEdges: ["core->legacy", "malformed-edge"] },
      legacy: { dependencyEdges: undefined },
    },
    changedFiles: new Set(["src/core/new.ts"]),
  };
  const context = { repository, cells: manifest.cells, report() {} };

  const noForbiddenBudget = agentBudgetPlugin({ allowedCells: ["core"] }).rules["agent-budget/change-budget"].run(context);
  assert.deepEqual(noForbiddenBudget, []);

  const budget = agentBudgetPlugin({
    allowedCells: ["legacy"],
    maxPublicSymbolsAdded: 0,
    maxDependencyEdgesAdded: 0,
  }).rules["agent-budget/change-budget"].run({
    ...context,
    repository: {
      ...repository,
      baseline: {
        schemaVersion: "cellfence.baseline.v1",
        generatedAt: "2026-01-01T00:00:00.000Z",
        cells: { core: { publicSymbols: 0, crossCellDependencies: 0, publicSurfaceLines: 0, publicSymbolSet: undefined, dependencyEdges: undefined } },
      },
    },
  });
  assert.ok(budget.some((finding) => finding.ruleId === "agent-budget/disallowed-cell"));

  const blast = blastRadiusPlugin({ maxAffectedCells: 0, severity: "error" }).rules["blast-radius/affected-cells"].run(context);
  assert.ok(blast.some((finding) => finding.ruleId === "blast-radius/affected-cells"));
  assert.deepEqual(blastRadiusPlugin().rules["blast-radius/affected-cells"].run(context), []);

  const sovereignty = dependencySovereigntyPlugin({ cellOwners: {}, protectedCells: ["legacy"] }).rules["dependency-sovereignty/approval-required"].run(context);
  assert.ok(sovereignty.some((finding) => finding.producerCellId === "legacy"));
  const sovereigntyWithBaseline = dependencySovereigntyPlugin({ cellOwners: {}, protectedCells: ["legacy"] }).rules["dependency-sovereignty/approval-required"].run({
    ...context,
    repository: {
      ...repository,
      baseline: {
        schemaVersion: "cellfence.baseline.v1",
        generatedAt: "2026-01-01T00:00:00.000Z",
        cells: {
          empty: { dependencyEdges: undefined },
          core: { dependencyEdges: ["core->legacy"] },
        },
      },
    },
  });
  assert.deepEqual(sovereigntyWithBaseline, []);
  const changedOnlySkip = dependencySovereigntyPlugin({
    cellOwners: { legacy: ["owner"] },
    changedOnly: true,
  }).rules["dependency-sovereignty/approval-required"].run({
    ...context,
    repository: { ...repository, changedFiles: new Set([]) },
  });
  assert.deepEqual(changedOnlySkip, []);

  const ownerSkip = dependencySovereigntyPlugin({ actor: "owner", cellOwners: { legacy: ["owner"] } }).rules["dependency-sovereignty/approval-required"].run(context);
  assert.deepEqual(ownerSkip, []);

  const geo = geoPurityPlugin({ requirePublicJsdoc: true, maxOwnedFileLines: 0 }).rules["geo-purity/context-shape"].run({
    ...context,
    repository: {
      ...repository,
      files: {
        ...repository.files,
        byCell: { core: ["src/core/missing.ts"] },
      },
    },
  });
  assert.ok(geo.some((finding) => finding.ruleId === "geo-purity/public-symbol-undocumented"));

  const legacy = legacyStranglerPlugin({ legacyCells: ["legacy"] }).rules["legacy-strangler/no-new-legacy-dependency"].run({
    ...context,
    repository: {
      ...repository,
      baseline: {
        schemaVersion: "cellfence.baseline.v1",
        generatedAt: "2026-01-01T00:00:00.000Z",
        cells: {
          none: { dependencyEdges: undefined },
          modern: { dependencyEdges: ["malformed-edge", "core->modern", "app->legacy"] },
        },
      },
    },
  });
  assert.ok(legacy.some((finding) => finding.ruleId === "legacy-strangler/no-new-legacy-dependency"));
  assert.deepEqual(legacyStranglerPlugin({ legacyCells: ["legacy"] }).rules["legacy-strangler/no-new-legacy-dependency"].run({
    ...context,
    repository: { ...repository, baseline: null, metrics: { core: { dependencyEdges: [] } } },
  }), []);

  assert.deepEqual(quantsTrendPlugin({
    history: [
      { schemaVersion: "cellfence.baseline.v1", generatedAt: "2026-01-01T00:00:00.000Z", cells: { core: { publicSurfaceLines: 0 } } },
      { schemaVersion: "cellfence.baseline.v1", generatedAt: "2026-01-02T00:00:00.000Z", cells: { core: { publicSurfaceLines: 0 } } },
    ],
    metrics: ["publicSurfaceLines"],
  }).rules["quants-trend/architecture-momentum"].run({
    ...context,
    repository: { ...repository, metrics: { core: { publicSurfaceLines: 0 } } },
  }), []);
  assert.deepEqual(quantsTrendPlugin({
    history: [
      { schemaVersion: "cellfence.baseline.v1", generatedAt: "2026-01-01T00:00:00.000Z", cells: { core: {} } },
      { schemaVersion: "cellfence.baseline.v1", generatedAt: "2026-01-02T00:00:00.000Z", cells: { core: {} } },
    ],
    metrics: ["publicSymbols"],
  }).rules["quants-trend/architecture-momentum"].run({
    ...context,
    repository: { ...repository, metrics: { core: { publicSymbols: 0 } } },
  }), []);

  const trend = quantsTrendPlugin({
    history: [
      { schemaVersion: "cellfence.baseline.v1", generatedAt: "2026-01-01T00:00:00.000Z", cells: {} },
      { schemaVersion: "cellfence.baseline.v1", generatedAt: "2026-01-02T00:00:00.000Z", cells: {} },
    ],
    metrics: ["publicSurfaceLines"],
    minimumGrowth: 0,
    multiplier: 1,
  }).rules["quants-trend/architecture-momentum"].run({
    ...context,
    repository: {
      ...repository,
      metrics: { core: { publicSurfaceLines: 1 } },
    },
  });
  assert.ok(trend.some((finding) => finding.details.metric === "publicSurfaceLines"));

  assert.deepEqual(createEconomyMatrix({ repository, findings: [], warnings: [] }).map((row) => row.cellId), ["core", "legacy"]);
});

test("economy matrix plugin exposes the reporter through plugin metadata", () => {
  const plugin = economyMatrixPlugin();
  assert.equal(plugin.name, "@cellfence/reporter-economy-matrix");
  assert.equal(plugin.reporters.length, 1);
  assert.equal(plugin.reporters[0].name, "@cellfence/reporter-economy-matrix");
});
