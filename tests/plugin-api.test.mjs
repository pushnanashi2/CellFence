import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import ts from "typescript";

import { checkRepository } from "../packages/engine/dist/index.js";
import { defineAdapter, definePlugin, defineRule } from "../packages/plugin-api/dist/index.js";

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
