import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { checkRepository } from "../packages/engine/dist/index.js";
import { validateResourceEvidence } from "../packages/schema/dist/index.js";
import { callPatternAdapter } from "../packages/adapter-call-pattern/dist/index.js";
import { openTelemetryToResourceEvidence } from "../packages/adapter-opentelemetry/dist/index.js";
import { agentBudgetPlugin } from "../packages/plugin-agent-budget/dist/index.js";
import { blastRadiusPlugin } from "../packages/plugin-blast-radius/dist/index.js";
import { dependencySovereigntyPlugin } from "../packages/plugin-dependency-sovereignty/dist/index.js";
import { geoPurityPlugin } from "../packages/plugin-geo-purity/dist/index.js";
import { legacyStranglerPlugin } from "../packages/plugin-legacy-strangler/dist/index.js";
import { quantsTrendPlugin } from "../packages/plugin-quants-trend/dist/index.js";
import { createEconomyMatrix, economyMatrixReporter } from "../packages/reporter-economy-matrix/dist/index.js";

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
