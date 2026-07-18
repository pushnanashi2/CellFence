import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  checkChangedRepository,
  checkClaims,
  checkRepository,
  createAutoAllocation,
  createBaseline,
  createCellContext,
  createClaim,
  createCouplingGraph,
  createPruneReport,
  createWaiverRequest,
  formatCouplingGraphMermaid,
  formatHumanResult,
  guardBaselineUpdate,
  inferManifest,
  listClaims,
  listWaivers,
  loadManifestFromFile,
} from "../packages/engine/dist/index.js";

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
  "CELLFENCE_UNSUPPORTED_TYPESCRIPT_SYNTAX",
  "CELLFENCE_UNSUPPORTED_PYTHON_SYNTAX",
  "CELLFENCE_REQUIRED_RULE_DISABLED",
  "CELLFENCE_WAIVER_INVALID",
];

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function writeFakeNodeCommand(binDir, commandName, script) {
  fs.mkdirSync(binDir, { recursive: true });
  const scriptPath = path.join(binDir, `${commandName}-fake.cjs`);
  fs.writeFileSync(scriptPath, script);
  const posixPath = path.join(binDir, commandName);
  fs.writeFileSync(posixPath, `#!/usr/bin/env node\n${script}`);
  fs.chmodSync(posixPath, 0o755);
  fs.writeFileSync(path.join(binDir, `${commandName}.cmd`), `@echo off\r\n"${process.execPath}" "%~dp0${commandName}-fake.cjs" %*\r\n`);
}

function findExecutable(commandName) {
  const locator = process.platform === "win32" ? "where.exe" : "which";
  const result = spawnSync(locator, [commandName], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)[0];
}

function writeCell(rootDir, cellId, sourceText = `export const ${cellId} = true;\n`) {
  fs.mkdirSync(path.join(rootDir, "src", cellId), { recursive: true });
  fs.writeFileSync(path.join(rootDir, "src", cellId, "public.ts"), sourceText);
}

function writeManifest(rootDir, cells, extra = {}) {
  writeJson(path.join(rootDir, "cellfence.manifest.json"), {
    schemaVersion: "cellfence.manifest.v1",
    cells,
    ...extra,
  });
}

function baseCell(cellId, patch = {}) {
  return {
    id: cellId,
    ownedPaths: [`src/${cellId}/**`],
    publicEntry: `src/${cellId}/public.ts`,
    publicSymbols: [cellId],
    consumes: [],
    producesArtifacts: [],
    ...patch,
  };
}

function initGit(rootDir) {
  for (const args of [
    ["init"],
    ["config", "user.email", "cellfence@example.invalid"],
    ["config", "user.name", "CellFence Test"],
  ]) {
    const result = spawnSync("git", args, { cwd: rootDir, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr || result.stdout);
  }
}

function git(rootDir, args) {
  const result = spawnSync("git", args, { cwd: rootDir, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout.trim();
}

test("engine treats sibling owned path prefixes as separate path segments", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-engine-sibling-owned-paths-"));
  try {
    writeCell(rootDir, "user");
    writeCell(rootDir, "users");
    writeCell(rootDir, "cell1");
    writeCell(rootDir, "cell10");
    writeManifest(rootDir, [
      baseCell("user"),
      baseCell("users"),
      baseCell("cell1"),
      baseCell("cell10"),
    ]);

    const result = checkRepository({ rootDir, manifestPath: "cellfence.manifest.json" });

    assert.equal(result.ok, true, JSON.stringify(result.findings));
    assert.equal(result.findings.some((finding) => finding.ruleId === "CELLFENCE_OWNERSHIP_OVERLAP"), false);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("engine still rejects nested owned path overlap on a segment boundary", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-engine-nested-owned-paths-"));
  try {
    writeCell(rootDir, "shared");
    fs.mkdirSync(path.join(rootDir, "src/shared/narrow"), { recursive: true });
    fs.writeFileSync(path.join(rootDir, "src/shared/narrow/public.ts"), "export const narrow = true;\n");
    writeManifest(rootDir, [
      baseCell("shared"),
      baseCell("narrow", {
        ownedPaths: ["src/shared/narrow/**"],
        publicEntry: "src/shared/narrow/public.ts",
        publicSymbols: ["narrow"],
      }),
    ]);

    const result = checkRepository({ rootDir, manifestPath: "cellfence.manifest.json" });

    assert.equal(result.ok, false);
    assert.ok(result.findings.some((finding) => finding.ruleId === "CELLFENCE_OWNERSHIP_OVERLAP"));
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("engine does not treat a root file glob as owning nested directory files", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-engine-root-file-glob-"));
  try {
    fs.mkdirSync(path.join(rootDir, "src/build"), { recursive: true });
    fs.writeFileSync(path.join(rootDir, "src/root.ts"), "export const root = true;\n");
    fs.writeFileSync(path.join(rootDir, "src/build/public.ts"), "export const build = true;\n");
    writeManifest(rootDir, [
      {
        id: "src-root",
        ownedPaths: ["src/*"],
        publicEntry: "src/root.ts",
        publicSymbols: ["root"],
        consumes: [],
        producesArtifacts: [],
      },
      baseCell("build", {
        ownedPaths: ["src/build/**"],
        publicEntry: "src/build/public.ts",
        publicSymbols: ["build"],
      }),
    ]);

    const result = checkRepository({ rootDir, manifestPath: "cellfence.manifest.json" });

    assert.equal(result.ok, true, JSON.stringify(result.findings));
    assert.equal(result.findings.some((finding) => finding.ruleId === "CELLFENCE_OWNERSHIP_OVERLAP"), false);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("engine handles invalid runtime evidence inputs without false green results", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-engine-evidence-"));
  try {
    writeCell(rootDir, "core");
    writeManifest(rootDir, [baseCell("core")]);
    writeJson(path.join(rootDir, "invalid-evidence.json"), { schemaVersion: "wrong", accesses: [] });
    writeJson(path.join(rootDir, "unknown-cell-evidence.json"), {
      schemaVersion: "cellfence.resource-evidence.v1",
      accesses: [{ kind: "database", access: "read", selector: "app.users", cellId: "missing" }],
    });
    writeJson(path.join(rootDir, "missing-cell-evidence.json"), {
      schemaVersion: "cellfence.resource-evidence.v1",
      cellId: "",
      accesses: [{ kind: "database", access: "read", selector: "app.users" }],
    });

    const result = checkRepository({
      rootDir,
      manifestPath: "cellfence.manifest.json",
      evidencePaths: ["invalid-evidence.json", "missing-evidence.json", "unknown-cell-evidence.json", "missing-cell-evidence.json"],
    });

    assert.equal(result.ok, false);
    assert.equal(result.findings.filter((finding) => finding.ruleId === "CELLFENCE_RESOURCE_EVIDENCE_INVALID").length, 4);
    assert.ok(result.findings.some((finding) => /failed to read resource evidence/.test(finding.message)));
    assert.ok(result.findings.some((finding) => /references unknown cell missing/.test(finding.message)));
    assert.ok(result.findings.some((finding) => /references unknown cell \(missing\)/.test(finding.message)));
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("engine resolves exact tsconfig path aliases and package-name public imports", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-engine-resolution-"));
  try {
    writeCell(rootDir, "core");
    fs.writeFileSync(path.join(rootDir, "src/core/package.json"), "{\"name\":\"@cell/core\"}\n");
    fs.mkdirSync(path.join(rootDir, "src/app"), { recursive: true });
    fs.writeFileSync(
      path.join(rootDir, "src/app/public.ts"),
      [
        "import { core as viaAlias } from '@core';",
        "import { core as viaPackage } from '@cell/core';",
        "import '@missing';",
        "export const app = viaAlias && viaPackage;",
        "",
      ].join("\n"),
    );
    writeJson(path.join(rootDir, "tsconfig.json"), {
      compilerOptions: {
        baseUrl: ".",
        paths: {
          "@core": ["src/core/public.ts"],
          "@missing": ["src/missing"],
        },
      },
    });
    writeManifest(rootDir, [
      baseCell("core", { packageName: "@cell/core" }),
      baseCell("app", { publicSymbols: ["app"], consumes: [{ cell: "core" }] }),
    ]);

    const result = checkRepository({ rootDir, manifestPath: "cellfence.manifest.json" });
    assert.equal(result.ok, true, JSON.stringify(result.findings));
    assert.equal(result.metrics.app.crossCellDependencies, 1);

    writeCell(rootDir, "loose", "export const loose = true;\n");
    fs.mkdirSync(path.join(rootDir, "src/loose-consumer"), { recursive: true });
    fs.writeFileSync(path.join(rootDir, "src/loose/internal.ts"), "export const privateLoose = true;\n");
    fs.writeFileSync(path.join(rootDir, "src/loose-consumer/public.ts"), "import { privateLoose } from '@cell/loose/internal';\nexport const looseConsumer = privateLoose;\n");
    writeManifest(rootDir, [
      baseCell("loose", { packageName: "@cell/loose" }),
      baseCell("loose-consumer", {
        publicSymbols: ["looseConsumer"],
        consumes: [{ cell: "loose" }],
      }),
    ]);
    const looseResult = checkRepository({ rootDir, manifestPath: "cellfence.manifest.json" });
    assert.equal(looseResult.ok, false);
    assert.ok(looseResult.findings.some((finding) =>
      finding.ruleId === "CELLFENCE_PRIVATE_IMPORT"
      && finding.details?.specifier === "@cell/loose/internal"
      && finding.details?.targetPath === undefined));
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("engine rejects TypeScript import-equals private dependency bypasses", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-engine-import-equals-"));
  try {
    fs.mkdirSync(path.join(rootDir, "src/producer"), { recursive: true });
    fs.mkdirSync(path.join(rootDir, "src/consumer"), { recursive: true });
    fs.writeFileSync(path.join(rootDir, "src/producer/public.ts"), "export const exposed = true;\n");
    fs.writeFileSync(path.join(rootDir, "src/producer/internal.ts"), "export const hidden = true;\n");
    fs.writeFileSync(
      path.join(rootDir, "src/consumer/public.ts"),
      [
        "import secret = require('../producer/internal');",
        "export const app = secret.hidden;",
        "",
      ].join("\n"),
    );
    writeManifest(rootDir, [
      baseCell("producer", { publicSymbols: ["exposed"] }),
      baseCell("consumer", { publicSymbols: ["app"] }),
    ]);

    const result = checkRepository({ rootDir, manifestPath: "cellfence.manifest.json" });

    assert.equal(result.ok, false);
    assert.ok(result.findings.some((finding) =>
      finding.ruleId === "CELLFENCE_PRIVATE_IMPORT"
      && finding.filePath === "src/consumer/public.ts"
      && finding.producerCellId === "producer"
      && finding.cellId === "consumer"
      && finding.details?.specifier === "../producer/internal"
      && finding.details?.line === 1
      && typeof finding.fingerprint === "string"));
    assert.ok(result.findings.some((finding) =>
      finding.ruleId === "CELLFENCE_UNDECLARED_CONSUMER"
      && finding.filePath === "src/consumer/public.ts"
      && finding.producerCellId === "producer"
      && finding.cellId === "consumer"
      && finding.details?.specifier === "../producer/internal"
      && typeof finding.fingerprint === "string"));
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("engine reports invalid TypeScript syntax as a required fail-closed finding", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-engine-invalid-ts-"));
  try {
    fs.mkdirSync(path.join(rootDir, "src/app"), { recursive: true });
    fs.writeFileSync(path.join(rootDir, "src/app/public.ts"), "export const app = ;\n");
    writeManifest(rootDir, [baseCell("app", { publicSymbols: ["app"] })]);

    const result = checkRepository({ rootDir, manifestPath: "cellfence.manifest.json" });

    assert.equal(result.ok, false);
    const syntaxFinding = result.findings.find((finding) => finding.ruleId === "CELLFENCE_UNSUPPORTED_TYPESCRIPT_SYNTAX");
    assert.ok(syntaxFinding);
    assert.equal(syntaxFinding.severity, "error");
    assert.equal(syntaxFinding.filePath, "src/app/public.ts");
    assert.equal(syntaxFinding.details?.line, 1);
    assert.equal(typeof syntaxFinding.fingerprint, "string");
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("engine extracts default and namespace public surface contracts", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-engine-public-surface-"));
  try {
    fs.mkdirSync(path.join(rootDir, "src/defaulted"), { recursive: true });
    fs.writeFileSync(
      path.join(rootDir, "src/defaulted/public.ts"),
      [
        "export default function run(value: string): string { return value; }",
        "const source = { destructured: true };",
        "export const { destructured } = source;",
        "export * as tools from './tools';",
        "export * from './loop-a';",
        "export * from './missing-tools';",
        "export * from 'external-package';",
        "",
      ].join("\n"),
    );
    fs.writeFileSync(path.join(rootDir, "src/defaulted/tools.ts"), "export const helper = true;\n");
    fs.writeFileSync(path.join(rootDir, "src/defaulted/loop-a.ts"), "export * from './loop-b';\n");
    fs.writeFileSync(path.join(rootDir, "src/defaulted/loop-b.ts"), "export * from './loop-a';\n");
    fs.mkdirSync(path.join(rootDir, "src/assigned"), { recursive: true });
    fs.writeFileSync(
      path.join(rootDir, "src/assigned/public.ts"),
      [
        "const assigned = true;",
        "export default assigned;",
        "",
      ].join("\n"),
    );
    fs.mkdirSync(path.join(rootDir, "src/anonymous"), { recursive: true });
    fs.writeFileSync(path.join(rootDir, "src/anonymous/public.ts"), "export default class {}\n");
    writeManifest(rootDir, [
      baseCell("defaulted", { publicSymbols: ["default", "tools"] }),
      baseCell("assigned", { publicSymbols: ["default"] }),
      baseCell("anonymous", { publicSymbols: ["default"] }),
    ]);

    const result = checkRepository({ rootDir, manifestPath: "cellfence.manifest.json" });
    assert.equal(result.ok, false);
    assert.ok(result.findings.some((finding) =>
      finding.ruleId === "CELLFENCE_UNRESOLVED_IMPORT"
      && finding.filePath === "src/defaulted/public.ts"));
    assert.match(result.metrics.defaulted.publicSurfaceHash || "", /^[a-f0-9]{64}$/);
    assert.match(result.metrics.assigned.publicSurfaceHash || "", /^[a-f0-9]{64}$/);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("engine reports semantic baseline contract changes beyond simple count growth", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-engine-baseline-semantic-"));
  try {
    writeCell(rootDir, "core", "export const core = true;\n");
    writeManifest(rootDir, [
      baseCell("core", {
        producesArtifacts: [{ id: "reports", paths: ["src/core/artifacts/**"] }],
      }),
    ]);
    writeJson(path.join(rootDir, "cellfence.baseline.json"), {
      schemaVersion: "cellfence.baseline.v1",
      generatedAt: "2026-01-01T00:00:00.000Z",
      cells: {
        core: {
          ownedPathPatterns: 1,
          publicSymbols: 1,
          publicSurfaceLines: 20,
          crossCellDependencies: 0,
          ownedPathSet: ["src/core/**"],
          publicEntryPath: "src/core/old-public.ts",
          publicSymbolSet: ["core"],
          publicSurfaceHash: "previous-hash",
          dependencyEdges: [],
          artifactContracts: [],
          resourceAccesses: [{ kind: "database", access: "read", selector: "app.old" }],
        },
      },
    });

    const result = checkRepository({ rootDir, manifestPath: "cellfence.manifest.json", baselinePath: "cellfence.baseline.json" });
    const ruleIds = result.findings.map((finding) => finding.ruleId);
    assert.ok(ruleIds.includes("CELLFENCE_RATCHET_PUBLIC_ENTRY_CHANGE"));
    assert.ok(ruleIds.includes("CELLFENCE_RATCHET_ARTIFACT_CONTRACT_CHANGE"));
    assert.ok(ruleIds.includes("CELLFENCE_RATCHET_PUBLIC_SURFACE_SIGNATURE_CHANGE"));
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("engine applies path overrides and rejects required-rule weakening in overrides", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-engine-overrides-"));
  try {
    writeCell(rootDir, "core", "export const core = true;\nexport const extra = true;\n");
    writeManifest(rootDir, [baseCell("core")], {
      governance: { requiredRules: ["CELLFENCE_PUBLIC_SYMBOL_MISMATCH"] },
      overrides: [{
        files: ["src/core/**"],
        rules: { CELLFENCE_PUBLIC_SYMBOL_MISMATCH: "warning" },
      }],
    });

    const result = checkRepository({ rootDir, manifestPath: "cellfence.manifest.json" });
    assert.equal(result.ok, false);
    assert.ok(result.findings.some((finding) => finding.ruleId === "CELLFENCE_PUBLIC_SYMBOL_MISMATCH"));
    assert.ok(result.findings.some((finding) =>
      finding.ruleId === "CELLFENCE_REQUIRED_RULE_DISABLED"
      && /override 0/.test(finding.message)));
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("engine applies cell and CLI rule severity overrides without weakening required rules silently", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-engine-severity-"));
  try {
    writeCell(rootDir, "core", "export const core = true;\nexport const extra = true;\n");
    writeManifest(rootDir, [baseCell("core", {
      rules: { CELLFENCE_PUBLIC_SYMBOL_MISMATCH: "warning" },
    })]);

    const cellOverride = checkRepository({ rootDir, manifestPath: "cellfence.manifest.json" });
    assert.equal(cellOverride.ok, true, JSON.stringify(cellOverride.findings));
    assert.ok(cellOverride.warnings.some((finding) => finding.ruleId === "CELLFENCE_PUBLIC_SYMBOL_MISMATCH"));

    writeManifest(rootDir, [baseCell("core")]);
    const cliOverride = checkRepository({
      rootDir,
      manifestPath: "cellfence.manifest.json",
      ruleSeverities: { CELLFENCE_PUBLIC_SYMBOL_MISMATCH: "warning" },
    });
    assert.equal(cliOverride.ok, true, JSON.stringify(cliOverride.findings));
    assert.ok(cliOverride.warnings.some((finding) => finding.ruleId === "CELLFENCE_PUBLIC_SYMBOL_MISMATCH"));

    writeManifest(rootDir, [baseCell("core", {
      rules: { CELLFENCE_PUBLIC_SYMBOL_MISMATCH: "error" },
    })], {
      governance: { requiredRules: ["CELLFENCE_PUBLIC_SYMBOL_MISMATCH"] },
      rules: { CELLFENCE_PUBLIC_SYMBOL_MISMATCH: "error" },
      overrides: [{ files: ["src/core/**"], rules: { CELLFENCE_PUBLIC_SYMBOL_MISMATCH: "error" } }],
    });
    const requiredStillError = checkRepository({ rootDir, manifestPath: "cellfence.manifest.json" });
    assert.equal(requiredStillError.ok, false);
    assert.equal(requiredStillError.findings.filter((finding) => finding.ruleId === "CELLFENCE_REQUIRED_RULE_DISABLED").length, 0);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("engine reports manifest and baseline load failures through public APIs", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-engine-load-failures-"));
  try {
    writeCell(rootDir, "core");
    writeManifest(rootDir, [baseCell("core")]);
    writeJson(path.join(rootDir, "bad-baseline.json"), { schemaVersion: "wrong", cells: {} });

    assert.throws(
      () => loadManifestFromFile(path.join(rootDir, "missing-manifest.json")),
      /no such file|ENOENT/,
    );
    writeJson(path.join(rootDir, "invalid-manifest.json"), { schemaVersion: "wrong", cells: [] });
    assert.throws(
      () => loadManifestFromFile(path.join(rootDir, "invalid-manifest.json")),
      /schemaVersion must be cellfence\.manifest\.v1/,
    );
    const missingManifest = checkRepository({ rootDir, manifestPath: "missing-manifest.json" });
    assert.equal(missingManifest.exitCode, 2);
    assert.match(missingManifest.findings[0].message, /failed to read manifest/);

    const badBaseline = checkRepository({ rootDir, manifestPath: "cellfence.manifest.json", baselinePath: "bad-baseline.json" });
    assert.equal(badBaseline.ok, false);
    assert.match(badBaseline.findings[0].message, /baseline is invalid/);

    const missingBaseline = checkRepository({ rootDir, manifestPath: "cellfence.manifest.json", baselinePath: "missing-baseline.json" });
    assert.equal(missingBaseline.ok, false);
    assert.match(missingBaseline.findings[0].message, /failed to read baseline/);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("engine validates waiver syntax and can waive findings without line metadata", () => {
  const invalidRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-engine-waiver-invalid-"));
  try {
    fs.mkdirSync(path.join(invalidRoot, "src/core"), { recursive: true });
    fs.writeFileSync(
      path.join(invalidRoot, "src/core/public.ts"),
      [
        "// cellfence-ignore * expires:2099-01-01 approved-by:test-owner reason:temporary invalid wildcard waiver",
        "// cellfence-ignore CELLFENCE_PUBLIC_SYMBOL_MISMATCH reason:short",
        "// cellfence-ignore CELLFENCE_PUBLIC_SYMBOL_MISMATCH expires:2099-01-01 approved-by:test-owner",
        "export const core = true;",
        "",
      ].join("\n"),
    );
    writeManifest(invalidRoot, [baseCell("core")]);

    const invalid = checkRepository({ rootDir: invalidRoot, manifestPath: "cellfence.manifest.json" });
    assert.equal(invalid.ok, false);
    const invalidWaivers = invalid.findings.filter((finding) => finding.ruleId === "CELLFENCE_WAIVER_INVALID");
    assert.equal(invalidWaivers.length, 3);
    assert.ok(invalidWaivers.some((finding) => /concrete CELLFENCE_\*/.test(finding.message)));
    assert.ok(invalidWaivers.some((finding) => /expires must be YYYY-MM-DD/.test(finding.message)));
    assert.ok(invalidWaivers.some((finding) => /approved-by is required/.test(finding.message)));
    assert.ok(invalidWaivers.some((finding) => /reason must explain/.test(finding.message)));
  } finally {
    fs.rmSync(invalidRoot, { recursive: true, force: true });
  }

  const mismatchRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-engine-waiver-mismatch-"));
  try {
    fs.mkdirSync(path.join(mismatchRoot, "src/core"), { recursive: true });
    fs.writeFileSync(
      path.join(mismatchRoot, "src/core/public.ts"),
      [
        "// cellfence-ignore CELLFENCE_PRIVATE_IMPORT expires:2099-01-01 approved-by:test-owner reason:temporary unrelated waiver fixture",
        "export const extra = true;",
        "",
      ].join("\n"),
    );
    writeManifest(mismatchRoot, [baseCell("core", { publicSymbols: [] })]);
    const mismatch = checkRepository({ rootDir: mismatchRoot, manifestPath: "cellfence.manifest.json" });
    assert.equal(mismatch.ok, false);
    assert.ok(mismatch.findings.some((finding) => finding.ruleId === "CELLFENCE_PUBLIC_SYMBOL_MISMATCH"));
  } finally {
    fs.rmSync(mismatchRoot, { recursive: true, force: true });
  }

  const waivedRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-engine-waiver-line-free-"));
  const previousCwd = process.cwd();
  try {
    fs.mkdirSync(path.join(waivedRoot, "src/core"), { recursive: true });
    fs.writeFileSync(
      path.join(waivedRoot, "src/core/public.ts"),
      [
        "// cellfence-ignore CELLFENCE_PUBLIC_SYMBOL_MISMATCH expires:2099-01-01 approved-by:test-owner reason:temporary public surface mismatch fixture",
        "export const extra = true;",
        "",
      ].join("\n"),
    );
    writeManifest(waivedRoot, [baseCell("core", { publicSymbols: [] })]);

    const waived = checkRepository({ rootDir: waivedRoot, manifestPath: "cellfence.manifest.json" });
    assert.equal(waived.ok, true, JSON.stringify(waived.findings));
    assert.deepEqual(waived.findings.filter((finding) => finding.ruleId === "CELLFENCE_PUBLIC_SYMBOL_MISMATCH"), []);

    process.chdir(waivedRoot);
    const waivers = listWaivers();
    assert.equal(waivers.length, 1);
    assert.equal(waivers[0].ruleId, "CELLFENCE_PUBLIC_SYMBOL_MISMATCH");
  } finally {
    process.chdir(previousCwd);
    fs.rmSync(waivedRoot, { recursive: true, force: true });
  }
});

test("engine covers tsconfig alias fallback and runtime evidence default fields", () => {
  const invalidTsconfigRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-engine-bad-tsconfig-"));
  try {
    writeCell(invalidTsconfigRoot, "core");
    writeManifest(invalidTsconfigRoot, [baseCell("core")]);
    fs.writeFileSync(path.join(invalidTsconfigRoot, "tsconfig.json"), "{not-json");
    const invalidTsconfig = checkRepository({ rootDir: invalidTsconfigRoot, manifestPath: "cellfence.manifest.json" });
    assert.equal(invalidTsconfig.exitCode, 0, JSON.stringify(invalidTsconfig.findings));
  } finally {
    fs.rmSync(invalidTsconfigRoot, { recursive: true, force: true });
  }

  const noPathsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-engine-no-paths-"));
  try {
    writeCell(noPathsRoot, "core");
    writeManifest(noPathsRoot, [baseCell("core")]);
    writeJson(path.join(noPathsRoot, "tsconfig.json"), { compilerOptions: {} });
    const noPaths = checkRepository({ rootDir: noPathsRoot, manifestPath: "cellfence.manifest.json" });
    assert.equal(noPaths.exitCode, 0, JSON.stringify(noPaths.findings));
  } finally {
    fs.rmSync(noPathsRoot, { recursive: true, force: true });
  }

  const aliasRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-engine-alias-default-base-"));
  try {
    writeCell(aliasRoot, "core");
    fs.mkdirSync(path.join(aliasRoot, "src/app"), { recursive: true });
    fs.writeFileSync(path.join(aliasRoot, "src/app/public.ts"), "import { core } from '@core';\nexport const app = core;\n");
    writeManifest(aliasRoot, [
      baseCell("core"),
      baseCell("app", { publicSymbols: ["app"], consumes: [{ cell: "core" }] }),
    ]);
    writeJson(path.join(aliasRoot, "tsconfig.json"), { compilerOptions: { paths: { "@core": ["src/core/public.ts"] } } });
    const alias = checkRepository({ rootDir: aliasRoot, manifestPath: "cellfence.manifest.json" });
    assert.equal(alias.ok, true, JSON.stringify(alias.findings));
  } finally {
    fs.rmSync(aliasRoot, { recursive: true, force: true });
  }

  const evidenceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-engine-evidence-defaults-"));
  try {
    writeCell(evidenceRoot, "core");
    writeManifest(evidenceRoot, [baseCell("core", {
      resourceContracts: [{
        id: "runtime-file",
        kind: "file",
        access: ["read"],
        selectors: ["data/input.json"],
      }],
    })]);
    writeJson(path.join(evidenceRoot, "evidence.json"), {
      schemaVersion: "cellfence.resource-evidence.v1",
      cellId: "core",
      accesses: [{ kind: "file", access: "read", selector: "data/input.json" }],
    });
    const evidence = checkRepository({ rootDir: evidenceRoot, manifestPath: "cellfence.manifest.json", evidencePaths: ["evidence.json"] });
    assert.equal(evidence.ok, true, JSON.stringify(evidence.findings));
    assert.deepEqual(evidence.metrics.core.resourceAccesses, [{
      kind: "file",
      access: "read",
      selector: "data/input.json",
      detectedBy: "runtime-evidence",
      confidence: "runtime",
    }]);
  } finally {
    fs.rmSync(evidenceRoot, { recursive: true, force: true });
  }
});

test("engine waiver requests and human formatting reject weak inputs", () => {
  assert.throws(
    () => createWaiverRequest({
      ruleId: "CELLFENCE_PRIVATE_IMPORT",
      filePath: "src/core/public.ts",
      line: 1,
      expires: "bad-date",
      reason: "temporary migration reason",
    }),
    /expires must be YYYY-MM-DD/,
  );
  assert.throws(
    () => createWaiverRequest({
      ruleId: "CELLFENCE_PRIVATE_IMPORT",
      filePath: "src/core/public.ts",
      line: 1,
      expires: "2099-01-01",
      reason: "short",
    }),
    /reason must explain/,
  );
  assert.match(formatHumanResult({
    ok: false,
    exitCode: 1,
    findings: [{ ruleId: "CELLFENCE_TEST", severity: "error", message: "without file path" }],
    warnings: [],
    metrics: {},
  }), /\[error\] CELLFENCE_TEST: without file path/);
  assert.match(formatHumanResult({
    ok: false,
    exitCode: 1,
    findings: [{ ruleId: "CELLFENCE_TEST", severity: "error", filePath: "src/core/public.ts", message: "with file path" }],
    warnings: [],
    metrics: {},
  }), /\[error\] CELLFENCE_TEST src\/core\/public\.ts: with file path/);
});

test("engine changed checks cover explicit head refs and base-check failure paths", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-engine-changed-"));
  try {
    initGit(rootDir);
    fs.mkdirSync(path.join(rootDir, "src/core"), { recursive: true });
    fs.writeFileSync(path.join(rootDir, "src/core/public.ts"), "export const core = true;\n");
    writeJson(path.join(rootDir, "cellfence.manifest.json"), { schemaVersion: "wrong", cells: [] });
    writeJson(path.join(rootDir, "evidence.json"), {
      schemaVersion: "cellfence.resource-evidence.v1",
      cellId: "core",
      accesses: [],
    });
    git(rootDir, ["add", "."]);
    git(rootDir, ["commit", "-m", "bad-base"]);

    writeManifest(rootDir, [baseCell("core")]);
    fs.appendFileSync(path.join(rootDir, "src/core/public.ts"), "// second commit\n");
    git(rootDir, ["add", "."]);
    git(rootDir, ["commit", "-m", "valid-head"]);
    const head = git(rootDir, ["rev-parse", "HEAD"]);

    const baseFailure = checkChangedRepository({ rootDir, manifestPath: "cellfence.manifest.json", baseRef: "HEAD~1", headRef: head, evidencePaths: ["evidence.json"] });
    assert.equal(baseFailure.exitCode, 2);
    assert.ok(baseFailure.findings.some((finding) => /base check failed before changed-finding diff/.test(finding.message)));

    const explicitHead = checkChangedRepository({ rootDir, manifestPath: "cellfence.manifest.json", baseRef: "HEAD", headRef: head });
    assert.equal(explicitHead.exitCode, 0);
    assert.deepEqual(explicitHead.changedFiles, []);

    git(rootDir, ["update-ref", "refs/remotes/origin/main", "HEAD"]);
    const previousCwd = process.cwd();
    try {
      process.chdir(rootDir);
      const defaultRange = checkChangedRepository();
      assert.equal(defaultRange.exitCode, 0, JSON.stringify(defaultRange.findings));
      assert.deepEqual(defaultRange.changedFiles, []);
    } finally {
      process.chdir(previousCwd);
    }
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("engine changed checks return the current manifest error before base diffing", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-engine-changed-current-error-"));
  try {
    initGit(rootDir);
    writeCell(rootDir, "core");
    writeManifest(rootDir, [baseCell("core")]);
    git(rootDir, ["add", "."]);
    git(rootDir, ["commit", "-m", "base"]);

    writeJson(path.join(rootDir, "cellfence.manifest.json"), { schemaVersion: "wrong", cells: [] });
    const result = checkChangedRepository({ rootDir, manifestPath: "cellfence.manifest.json", baseRef: "HEAD" });
    assert.equal(result.exitCode, 2);
    assert.deepEqual(result.changedFiles, ["cellfence.manifest.json"]);
    assert.ok(result.findings.some((finding) => finding.ruleId === "CELLFENCE_MANIFEST_INVALID"));
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("engine changed check finding identity is stable across message wording changes", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-engine-changed-fingerprint-"));
  try {
    initGit(rootDir);
    writeCell(rootDir, "core", "export const core = \"base\";\n");
    writeManifest(rootDir, [baseCell("core")]);
    git(rootDir, ["add", "."]);
    git(rootDir, ["commit", "-m", "base"]);

    fs.writeFileSync(path.join(rootDir, "src/core/public.ts"), "export const core = \"head\";\n");
    git(rootDir, ["add", "."]);
    git(rootDir, ["commit", "-m", "head"]);

    const noisyMessagePlugin = {
      apiVersion: 1,
      name: "@cellfence/test-message-noise",
      version: "1.0.0",
      rules: {
        "test/message-noise": {
          meta: {
            description: "Emits the same finding with message text derived from current file content.",
            defaultSeverity: "error",
            category: "test",
          },
          run(context) {
            const publicFile = path.join(context.repository.rootDir, "src/core/public.ts");
            const content = fs.readFileSync(publicFile, "utf8").trim();
            return [{
              ruleId: "test/message-noise",
              severity: "error",
              cellId: "core",
              filePath: "src/core/public.ts",
              message: `same violation, wording ${content}`,
              details: { contract: "stable" },
            }];
          },
        },
      },
    };

    const result = checkChangedRepository({
      rootDir,
      manifestPath: "cellfence.manifest.json",
      baseRef: "HEAD~1",
      headRef: "HEAD",
      plugins: [noisyMessagePlugin],
    });
    assert.equal(result.exitCode, 0, JSON.stringify(result.findings));
    assert.deepEqual(result.findings, []);
    assert.deepEqual(result.changedFiles, ["src/core/public.ts"]);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("engine changed check cleanup does not hide a successful result when worktree removal fails", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-engine-worktree-cleanup-"));
  const fakeBin = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-fake-git-"));
  const realGit = findExecutable("git");
  const previousPath = process.env.PATH;
  try {
    initGit(rootDir);
    writeCell(rootDir, "core");
    writeManifest(rootDir, [baseCell("core")]);
    git(rootDir, ["add", "."]);
    git(rootDir, ["commit", "-m", "base"]);

    writeFakeNodeCommand(
      fakeBin,
      "git",
      [
        "const { spawnSync } = require('node:child_process');",
        "if (process.argv[2] === 'worktree' && process.argv[3] === 'remove') process.exit(1);",
        `const result = spawnSync(${JSON.stringify(realGit)}, process.argv.slice(2), { stdio: 'inherit' });`,
        "process.exit(result.status ?? 1);",
        "",
      ].join("\n"),
    );
    process.env.PATH = `${fakeBin}${path.delimiter}${previousPath}`;

    const result = checkChangedRepository({ rootDir, manifestPath: "cellfence.manifest.json", baseRef: "HEAD" });
    assert.equal(result.exitCode, 0, JSON.stringify(result.findings));
    assert.equal(result.ok, true);
  } finally {
    process.env.PATH = previousPath;
    fs.rmSync(fakeBin, { recursive: true, force: true });
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("engine changed check reports git stderr when metadata commands fail", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-engine-git-stderr-"));
  const fakeBin = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-fake-git-stderr-"));
  const previousPath = process.env.PATH;
  try {
    writeCell(rootDir, "core");
    writeManifest(rootDir, [baseCell("core")]);
    writeFakeNodeCommand(fakeBin, "git", "console.error('fatal: synthetic metadata failure');\nprocess.exit(128);\n");
    process.env.PATH = `${fakeBin}${path.delimiter}${previousPath}`;

    const result = checkChangedRepository({ rootDir, manifestPath: "cellfence.manifest.json", baseRef: "HEAD" });
    assert.equal(result.exitCode, 2);
    assert.match(result.findings[0].message, /synthetic metadata failure/);
  } finally {
    process.env.PATH = previousPath;
    fs.rmSync(fakeBin, { recursive: true, force: true });
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("engine changed check reports git spawn failures without raw stderr", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-engine-git-missing-"));
  const previousPath = process.env.PATH;
  try {
    writeCell(rootDir, "core");
    writeManifest(rootDir, [baseCell("core")]);
    process.env.PATH = "";
    const result = checkChangedRepository({ rootDir, manifestPath: "cellfence.manifest.json", baseRef: "HEAD" });
    assert.equal(result.exitCode, 2);
    assert.match(result.findings[0].message, /spawnSync git ENOENT|git command failed/);
  } finally {
    process.env.PATH = previousPath;
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("engine claim APIs fail closed for malformed stores, bad surfaces, and conflicting agents", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-engine-claims-"));
  try {
    writeCell(rootDir, "core");
    writeManifest(rootDir, [baseCell("core")]);
    initGit(rootDir);
    git(rootDir, ["add", "."]);
    git(rootDir, ["commit", "-m", "base"]);

    const missingManifest = checkClaims({ rootDir, manifestPath: "missing-manifest.json" });
    assert.equal(missingManifest.exitCode, 2);
    const missingManifestCreate = createClaim({ rootDir, manifestPath: "missing-manifest.json", agent: "codex", cells: ["core"] });
    assert.equal(missingManifestCreate.exitCode, 2);

    const badStorePath = ".cellfence/bad-claims.json";
    writeJson(path.join(rootDir, badStorePath), { schemaVersion: "wrong", claims: [] });
    const badStore = checkClaims({ rootDir, claimsPath: badStorePath });
    assert.equal(badStore.exitCode, 1);
    assert.match(badStore.findings[0].message, /claim store must have schemaVersion/);

    fs.writeFileSync(path.join(rootDir, badStorePath), "{not-json");
    const unreadableStore = checkClaims({ rootDir, claimsPath: badStorePath });
    assert.equal(unreadableStore.exitCode, 1);
    assert.match(unreadableStore.findings[0].message, /failed to read claim store/);

    writeJson(path.join(rootDir, badStorePath), {
      schemaVersion: "cellfence.claims.v1",
      claims: [
        null,
        {
          id: "",
          agent: 12,
          cells: ["missing"],
          paths: ["src/other/**"],
          symbols: "bad",
          resources: [],
          artifactLanes: [],
          createdAt: "bad-date",
          expiresAt: "bad-date",
        },
      ],
    });
    const malformedClaims = checkClaims({ rootDir, claimsPath: badStorePath });
    assert.equal(malformedClaims.exitCode, 1);
    assert.ok(malformedClaims.findings.some((finding) => /must be an object/.test(finding.message)));
    assert.ok(malformedClaims.findings.some((finding) => /is invalid/.test(finding.message)));

    const edgeStorePath = ".cellfence/edge-claims.json";
    writeJson(path.join(rootDir, edgeStorePath), {
      schemaVersion: "cellfence.claims.v1",
      claims: [{
        id: "unknown-cell",
        agent: "codex-u",
        cells: ["missing"],
        paths: [],
        symbols: [],
        resources: [],
        artifactLanes: [],
        createdAt: "2026-01-01T00:00:00.000Z",
        expiresAt: "2099-01-01T00:00:00.000Z",
      }, {
        id: "outside-path",
        agent: "codex-o",
        cells: ["core"],
        paths: ["src/other/**"],
        symbols: [],
        resources: [],
        artifactLanes: [],
        createdAt: "2026-01-01T00:00:00.000Z",
        expiresAt: "2099-01-01T00:00:00.000Z",
      }, {
        id: "path-a",
        agent: "codex-a",
        cells: [],
        paths: ["src/core"],
        symbols: [],
        resources: [],
        artifactLanes: [],
        createdAt: "2026-01-01T00:00:00.000Z",
        expiresAt: "2099-01-01T00:00:00.000Z",
      }, {
        id: "path-b",
        agent: "codex-b",
        cells: [],
        paths: ["src/core/sub"],
        symbols: [],
        resources: [],
        artifactLanes: [],
        createdAt: "2026-01-01T00:00:00.000Z",
        expiresAt: "2099-01-01T00:00:00.000Z",
      }],
    });
    const edgeClaims = checkClaims({ rootDir, claimsPath: edgeStorePath });
    assert.equal(edgeClaims.exitCode, 1);
    assert.ok(edgeClaims.findings.some((finding) => /references unknown cells: missing/.test(finding.message)));
    assert.ok(edgeClaims.findings.some((finding) => /path src\/other\/\*\* is outside claimed cell ownership/.test(finding.message)));
    assert.ok(edgeClaims.findings.some((finding) => finding.ruleId === "CELLFENCE_ACTIVE_CLAIM_CONFLICT"));

    const noGitDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-engine-claims-nogit-"));
    try {
      writeCell(noGitDir, "core");
      writeManifest(noGitDir, [baseCell("core")]);
      const noGit = checkClaims({ rootDir: noGitDir, agent: "codex" });
      assert.equal(noGit.exitCode, 1);
      assert.ok(noGit.findings.some((finding) => finding.ruleId === "CELLFENCE_GIT_METADATA_UNAVAILABLE"));
    } finally {
      fs.rmSync(noGitDir, { recursive: true, force: true });
    }

    const invalidCreate = createClaim({ rootDir, agent: " ", ttl: "soon" });
    assert.equal(invalidCreate.exitCode, 1);
    assert.ok(invalidCreate.findings.some((finding) => /claim requires --ttl/.test(finding.message)));
    assert.ok(invalidCreate.findings.some((finding) => /non-empty agent/.test(finding.message)));
    assert.ok(invalidCreate.findings.some((finding) => /must reserve at least one/.test(finding.message)));

    const first = createClaim({ rootDir, agent: "codex-a", cells: ["core"], paths: ["src/core/**"], ttl: "1d", claimId: "claim-a" });
    assert.equal(first.exitCode, 0, JSON.stringify(first.findings));
    const conflict = createClaim({ rootDir, agent: "codex-b", paths: ["src/core/public.ts"], expiresAt: "2099-01-01T00:00:00.000Z", claimId: "claim-b" });
    assert.equal(conflict.exitCode, 1);
    assert.ok(conflict.findings.some((finding) => finding.ruleId === "CELLFENCE_ACTIVE_CLAIM_CONFLICT"));

    fs.appendFileSync(path.join(rootDir, "src/core/public.ts"), "// claimed by another agent\n");
    const otherAgent = checkClaims({ rootDir, agent: "codex-z" });
    assert.equal(otherAgent.exitCode, 1);
    assert.ok(otherAgent.findings.some((finding) => /belongs to codex-a/.test(finding.message)));

    const baseRef = git(rootDir, ["rev-parse", "HEAD"]);
    const baseMode = checkClaims({ rootDir, agent: "codex-a", baseRef, headRef: "HEAD" });
    assert.equal(baseMode.exitCode, 0, JSON.stringify(baseMode.findings));

    writeJson(path.join(rootDir, ".cellfence/missing-cell-claims.json"), {
      schemaVersion: "cellfence.claims.v1",
      claims: [{
        id: "missing-cell-active",
        agent: "codex-missing",
        cells: ["missing"],
        paths: [],
        symbols: [],
        resources: [],
        artifactLanes: [],
        createdAt: "2026-01-01T00:00:00.000Z",
        expiresAt: "2099-01-01T00:00:00.000Z",
      }],
    });
    const missingCellCoverage = checkClaims({ rootDir, claimsPath: ".cellfence/missing-cell-claims.json", agent: "other-agent" });
    assert.equal(missingCellCoverage.exitCode, 1);
    assert.ok(missingCellCoverage.findings.some((finding) => /references unknown cells: missing/.test(finding.message)));
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("engine locked baseline guard reports each semantic expansion type", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-engine-guard-"));
  try {
    writeCell(rootDir, "core");
    writeManifest(rootDir, [baseCell("core", { locked: true })]);
    writeJson(path.join(rootDir, "cellfence.baseline.json"), {
      schemaVersion: "cellfence.baseline.v1",
      generatedAt: "2026-01-01T00:00:00.000Z",
      cells: {
        core: {
          ownedPathPatterns: 1,
          publicSymbols: 1,
          publicSurfaceLines: 1,
          crossCellDependencies: 0,
          ownedPathSet: ["src/core/**"],
          publicEntryPath: "src/core/public.ts",
          publicSymbolSet: ["core"],
          publicSurfaceHash: "old-hash",
          dependencyEdges: [],
          artifactContracts: [],
          resourceAccesses: [{ kind: "database", access: "read", selector: "app.old" }],
        },
      },
    });

    assert.deepEqual(
      guardBaselineUpdate({
        rootDir,
        manifestPath: "cellfence.manifest.json",
        baselinePath: "missing-baseline.json",
        nextBaseline: { schemaVersion: "cellfence.baseline.v1", generatedAt: "now", cells: {} },
      }),
      { ok: true, findings: [] },
    );

    fs.writeFileSync(path.join(rootDir, "bad-baseline.json"), "{not-json");
    assert.throws(
      () => guardBaselineUpdate({
        rootDir,
        manifestPath: "cellfence.manifest.json",
        baselinePath: "bad-baseline.json",
        nextBaseline: { schemaVersion: "cellfence.baseline.v1", generatedAt: "now", cells: {} },
      }),
      /Expected property name|JSON/,
    );

    writeJson(path.join(rootDir, "invalid-baseline.json"), { schemaVersion: "wrong", cells: {} });
    assert.throws(
      () => guardBaselineUpdate({
        rootDir,
        manifestPath: "cellfence.manifest.json",
        baselinePath: "invalid-baseline.json",
        nextBaseline: { schemaVersion: "cellfence.baseline.v1", generatedAt: "now", cells: {} },
      }),
      /baseline is invalid/,
    );

    const result = guardBaselineUpdate({
      rootDir,
      manifestPath: "cellfence.manifest.json",
      baselinePath: "cellfence.baseline.json",
      nextBaseline: {
        schemaVersion: "cellfence.baseline.v1",
        generatedAt: "2026-01-02T00:00:00.000Z",
        cells: {
          core: {
            ownedPathPatterns: 2,
            publicSymbols: 2,
            publicSurfaceLines: 3,
            crossCellDependencies: 1,
            ownedPathSet: ["src/core/**", "src/new-core/**"],
            publicEntryPath: "src/core/new-public.ts",
            publicSymbolSet: ["core", "extra"],
            publicSurfaceHash: "new-hash",
            dependencyEdges: ["core->other"],
            artifactContracts: ["produce:reports:src/core/reports/**"],
            resourceAccesses: [
              { kind: "database", access: "read", selector: "app.old" },
              { kind: "database", access: "read", selector: "app.users" },
            ],
          },
        },
      },
    });

    assert.equal(result.ok, false);
    const messages = result.findings.map((finding) => finding.message).join("\n");
    for (const expected of [
      "ownedPathPatterns would grow",
      "publicSymbols would grow",
      "publicSurfaceLines would grow",
      "crossCellDependencies would grow",
      "ownership scope would expand",
      "public entry would change",
      "public symbols would be added",
      "dependency edges would be added",
      "artifact contracts would be added",
      "public surface signature hash would change",
      "baseline update would grandfather database read app.users",
    ]) {
      assert.match(messages, new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    }

    writeManifest(rootDir, [
      baseCell("core", { locked: true }),
      baseCell("missing-next", { locked: true }),
    ]);
    writeJson(path.join(rootDir, "legacy-baseline.json"), {
      schemaVersion: "cellfence.baseline.v1",
      generatedAt: "2026-01-01T00:00:00.000Z",
      cells: {
        core: {
          ownedPathPatterns: 1,
          publicSymbols: 1,
          publicSurfaceLines: 1,
          crossCellDependencies: 0,
        },
      },
    });
    const legacyCompatible = guardBaselineUpdate({
      rootDir,
      manifestPath: "cellfence.manifest.json",
      baselinePath: "legacy-baseline.json",
      nextBaseline: {
        schemaVersion: "cellfence.baseline.v1",
        generatedAt: "2026-01-03T00:00:00.000Z",
        cells: {
          core: {
            ownedPathPatterns: 1,
            publicSymbols: 1,
            publicSurfaceLines: 1,
            crossCellDependencies: 0,
          },
        },
      },
    });
    assert.equal(legacyCompatible.ok, true, JSON.stringify(legacyCompatible.findings));

    const shrinkCompatible = guardBaselineUpdate({
      rootDir,
      manifestPath: "cellfence.manifest.json",
      baselinePath: "legacy-baseline.json",
      nextBaseline: {
        schemaVersion: "cellfence.baseline.v1",
        generatedAt: "2026-01-04T00:00:00.000Z",
        cells: {},
      },
    });
    assert.equal(shrinkCompatible.ok, true, JSON.stringify(shrinkCompatible.findings));
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("engine context and graph APIs expose artifact lanes, resources, and error boundaries", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-engine-context-"));
  try {
    writeCell(rootDir, "producer");
    fs.mkdirSync(path.join(rootDir, "src/consumer"), { recursive: true });
    fs.writeFileSync(
      path.join(rootDir, "src/consumer/public.ts"),
      [
        "import { producer } from '../producer/public';",
        "export const consumer = producer;",
        "",
      ].join("\n"),
    );
    writeManifest(rootDir, [
      baseCell("producer", {
        publicSymbols: ["producer"],
        producesArtifacts: [{ id: "snapshots", paths: ["src/producer/snapshots/**"] }],
      }),
      baseCell("consumer", {
        publicSymbols: ["consumer"],
        consumes: [{ cell: "producer", artifactLanes: ["snapshots"] }],
        resourceContracts: [{ id: "consumer-db", kind: "database", access: ["read"], selectors: ["app.users"] }],
        budgets: { publicSymbols: 5 },
      }),
    ]);
    writeJson(path.join(rootDir, "cellfence.baseline.json"), {
      schemaVersion: "cellfence.baseline.v1",
      generatedAt: "2026-01-01T00:00:00.000Z",
      cells: {
        consumer: {
          ownedPathPatterns: 1,
          publicSymbols: 1,
          publicSurfaceLines: 20,
          crossCellDependencies: 1,
          resourceAccesses: [{ kind: "file", access: "read", selector: "data/input.json" }],
        },
        producer: {
          ownedPathPatterns: 1,
          publicSymbols: 1,
          publicSurfaceLines: 20,
          crossCellDependencies: 0,
          resourceAccesses: [],
        },
      },
    });

    assert.throws(
      () => createCellContext({ rootDir, manifestPath: "cellfence.manifest.json", cellId: "missing" }),
      /unknown cell missing/,
    );
    writeJson(path.join(rootDir, "bad-baseline.json"), { schemaVersion: "wrong", cells: {} });
    assert.throws(
      () => createCellContext({ rootDir, manifestPath: "cellfence.manifest.json", baselinePath: "bad-baseline.json", cellId: "consumer" }),
      /baseline is invalid/,
    );

    const context = createCellContext({ rootDir, manifestPath: "cellfence.manifest.json", baselinePath: "cellfence.baseline.json", cellId: "consumer" });
    assert.equal(context.budgets.publicSymbols.source, "manifest-budget");
    assert.deepEqual(context.allowedImports[0].artifactLanes, ["snapshots"]);

    const graph = createCouplingGraph({ rootDir, manifestPath: "cellfence.manifest.json" });
    const mermaid = formatCouplingGraphMermaid(graph);
    assert.match(mermaid, /snapshots/);
    assert.ok(graph.edges.some((edge) => edge.kind === "artifact-lane" && edge.label === "consumes"));

    const allocation = createAutoAllocation({
      rootDir,
      manifestPath: "cellfence.manifest.json",
      baselinePath: "cellfence.baseline.json",
      cellId: "consumer",
      task: "consumer database work",
    });
    assert.ok(allocation.resourceSelectors.includes("database:read:app.users"));
    assert.ok(allocation.resourceSelectors.includes("file:read:data/input.json"));

    const previousCwd = process.cwd();
    try {
      process.chdir(rootDir);
      const defaultCheck = checkRepository();
      assert.equal(defaultCheck.ok, true, JSON.stringify(defaultCheck.findings));
      const defaultContext = createCellContext({ cellId: "consumer" });
      assert.equal(defaultContext.cell.id, "consumer");
      const defaultGraph = createCouplingGraph();
      assert.ok(defaultGraph.nodes.some((node) => node.id === "consumer"));
      const defaultAllocation = createAutoAllocation({ task: "producer" });
      assert.deepEqual(defaultAllocation.selectedCells, ["producer"]);
      const defaultClaims = listClaims();
      assert.equal(defaultClaims.exitCode, 0, JSON.stringify(defaultClaims.findings));
      const defaultGuard = guardBaselineUpdate({
        nextBaseline: createBaseline(),
      });
      assert.equal(defaultGuard.ok, true, JSON.stringify(defaultGuard.findings));
    } finally {
      process.chdir(previousCwd);
    }
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("engine prune report detects dead manifest declarations and stale governance exceptions", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-engine-prune-"));
  try {
    fs.mkdirSync(path.join(rootDir, "src/producer"), { recursive: true });
    fs.mkdirSync(path.join(rootDir, "src/consumer"), { recursive: true });
    fs.mkdirSync(path.join(rootDir, "src/unused"), { recursive: true });
    fs.mkdirSync(path.join(rootDir, "src/bare"), { recursive: true });
    fs.writeFileSync(
      path.join(rootDir, "src/producer/public.ts"),
      "export const used = true;\nexport const unused = true;\n",
    );
    fs.writeFileSync(
      path.join(rootDir, "src/consumer/public.ts"),
      [
        "// cellfence-ignore CELLFENCE_PRIVATE_IMPORT expires:2099-01-01 approved-by:test-owner reason:temporary stale waiver fixture",
        "import { used } from '../producer/public';",
        "export const consumer = used;",
        "",
      ].join("\n"),
    );
    fs.writeFileSync(path.join(rootDir, "src/unused/public.ts"), "export const unusedCell = true;\n");
    writeManifest(rootDir, [
      baseCell("producer", {
        publicSymbols: ["used", "unused"],
        producesArtifacts: [
          { id: "snapshots", paths: ["src/producer/artifacts/**"] },
          { id: "used-lane", paths: ["src/producer/used/**"] },
        ],
      }),
      baseCell("consumer", {
        publicSymbols: ["consumer"],
        consumes: [{ cell: "producer", artifactLanes: ["used-lane"] }, { cell: "unused" }],
      }),
      baseCell("unused", { publicSymbols: ["unusedCell"] }),
      {
        id: "bare",
        ownedPaths: ["src/bare/**"],
        publicEntry: "src/bare/public.ts",
        publicSymbols: [],
      },
    ]);
    fs.writeFileSync(path.join(rootDir, "src/bare/public.ts"), "\n");
    writeJson(path.join(rootDir, "cellfence.baseline.json"), {
      schemaVersion: "cellfence.baseline.v1",
      generatedAt: "2026-01-01T00:00:00.000Z",
      cells: {
        producer: {
          ownedPathPatterns: 1,
          publicSymbols: 2,
          publicSurfaceLines: 20,
          crossCellDependencies: 0,
          resourceAccesses: [{ kind: "file", access: "read", selector: "data/current.json" }],
        },
        consumer: {
          ownedPathPatterns: 1,
          publicSymbols: 1,
          publicSurfaceLines: 20,
          crossCellDependencies: 1,
          resourceAccesses: [{ kind: "database", access: "read", selector: "app.old" }],
        },
        unused: {
          ownedPathPatterns: 1,
          publicSymbols: 1,
          publicSurfaceLines: 20,
          crossCellDependencies: 0,
        },
      },
    });
    writeJson(path.join(rootDir, "resource-evidence.json"), {
      schemaVersion: "cellfence.resource-evidence.v1",
      cellId: "producer",
      accesses: [{ kind: "file", access: "read", selector: "data/current.json" }],
    });

    const report = createPruneReport({ rootDir, baselinePath: "cellfence.baseline.json", evidencePaths: ["resource-evidence.json"] });
    assert.equal(report.ok, false);
    assert.ok(report.candidates.some((candidate) =>
      candidate.kind === "unused-consumer"
      && candidate.cellId === "consumer"
      && candidate.producerCellId === "unused"));
    assert.ok(report.candidates.some((candidate) =>
      candidate.kind === "unconsumed-artifact-lane"
      && candidate.cellId === "producer"
      && candidate.artifactLaneId === "snapshots"));
    assert.equal(report.candidates.some((candidate) =>
      candidate.kind === "unconsumed-artifact-lane"
      && candidate.cellId === "producer"
      && candidate.artifactLaneId === "used-lane"), false);
    assert.ok(report.candidates.some((candidate) =>
      candidate.kind === "unused-public-symbol"
      && candidate.cellId === "producer"
      && candidate.symbol === "unused"));
    assert.ok(report.candidates.some((candidate) =>
      candidate.kind === "stale-waiver"
      && candidate.ruleId === "CELLFENCE_PRIVATE_IMPORT"
      && candidate.filePath === "src/consumer/public.ts"));
    assert.ok(report.candidates.some((candidate) =>
      candidate.kind === "stale-baseline-resource"
      && candidate.cellId === "consumer"
      && candidate.resource?.selector === "app.old"));
    assert.equal(report.candidates.some((candidate) =>
      candidate.kind === "stale-baseline-resource"
      && candidate.cellId === "producer"
      && candidate.resource?.selector === "data/current.json"), false);
    assert.equal(report.metrics.candidates, report.candidates.length);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("engine prune report keeps active waivers out of stale-waiver candidates", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-engine-prune-active-waiver-"));
  try {
    fs.mkdirSync(path.join(rootDir, "src/core"), { recursive: true });
    fs.writeFileSync(
      path.join(rootDir, "src/core/public.ts"),
      [
        "// cellfence-ignore CELLFENCE_PUBLIC_SYMBOL_MISMATCH expires:2099-01-01 approved-by:test-owner reason:temporary public symbol mismatch fixture",
        "export const extra = true;",
        "",
      ].join("\n"),
    );
    writeManifest(rootDir, [baseCell("core", { publicSymbols: [] })]);
    const report = createPruneReport({ rootDir });
    assert.equal(report.candidates.some((candidate) => candidate.kind === "stale-waiver"), false, JSON.stringify(report.candidates));
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("engine prune report uses the current working directory when rootDir is omitted", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-engine-prune-cwd-"));
  const previousCwd = process.cwd();
  try {
    fs.mkdirSync(path.join(rootDir, "src/core"), { recursive: true });
    fs.writeFileSync(path.join(rootDir, "src/core/public.ts"), "export const core = true;\n");
    writeManifest(rootDir, [baseCell("core")]);
    process.chdir(rootDir);
    const report = createPruneReport();
    assert.equal(report.schemaVersion, "cellfence.prune.v1");
    assert.equal(report.ok, false);
    assert.ok(report.candidates.some((candidate) =>
      candidate.kind === "unused-public-symbol"
      && candidate.cellId === "core"
      && candidate.symbol === "core"));
  } finally {
    process.chdir(previousCwd);
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("engine prune report recognizes public symbol use through default imports and re-exports", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-engine-prune-exports-"));
  try {
    fs.mkdirSync(path.join(rootDir, "src/producer"), { recursive: true });
    fs.mkdirSync(path.join(rootDir, "src/consumer"), { recursive: true });
    fs.writeFileSync(
      path.join(rootDir, "src/producer/public.ts"),
      "export default function run() { return true; }\nexport const named = true;\nexport const other = true;\n",
    );
    fs.writeFileSync(
      path.join(rootDir, "src/consumer/public.ts"),
      [
        "import run, * as producer from '../producer/public';",
        "export { named as renamed } from '../producer/public';",
        "export * from '../producer/public';",
        "export * as producerNamespace from '../producer/public';",
        "export const consumer = run() && producer.named;",
        "",
      ].join("\n"),
    );
    writeManifest(rootDir, [
      baseCell("producer", { publicSymbols: ["default", "named", "other"] }),
      baseCell("consumer", { publicSymbols: ["consumer", "renamed", "named", "other", "producerNamespace"], consumes: [{ cell: "producer" }] }),
    ]);

    const report = createPruneReport({ rootDir });
    assert.equal(report.candidates.some((candidate) =>
      candidate.kind === "unused-public-symbol"
      && candidate.cellId === "producer"), false, JSON.stringify(report.candidates));
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("engine does not let artifact lanes legitimize private source imports", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-engine-artifact-private-"));
  try {
    fs.mkdirSync(path.join(rootDir, "src/producer"), { recursive: true });
    fs.mkdirSync(path.join(rootDir, "src/consumer"), { recursive: true });
    fs.writeFileSync(path.join(rootDir, "src/producer/public.ts"), "export const producer = true;\n");
    fs.writeFileSync(path.join(rootDir, "src/producer/private.ts"), "export const secret = true;\n");
    fs.writeFileSync(path.join(rootDir, "src/consumer/public.ts"), "import { secret } from '../producer/private';\nexport const consumer = secret;\n");
    writeManifest(rootDir, [
      baseCell("producer", {
        publicSymbols: ["producer"],
        producesArtifacts: [{ id: "source-lane", paths: ["src/producer/**"] }],
      }),
      baseCell("consumer", {
        publicSymbols: ["consumer"],
        consumes: [{ cell: "producer", artifactLanes: ["source-lane"] }],
      }),
    ]);

    const result = checkRepository({ rootDir, manifestPath: "cellfence.manifest.json" });
    assert.equal(result.ok, false);
    assert.ok(result.findings.some((finding) =>
      finding.ruleId === "CELLFENCE_PRIVATE_IMPORT"
      && finding.details?.specifier === "../producer/private"));
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("engine resolves runtime extensions, alias suffixes, and optional manifest surfaces", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-engine-resolver-edges-"));
  try {
    fs.mkdirSync(path.join(rootDir, "src/lib"), { recursive: true });
    fs.mkdirSync(path.join(rootDir, "src/app"), { recursive: true });
    fs.mkdirSync(path.join(rootDir, "src/plain"), { recursive: true });
    fs.mkdirSync(path.join(rootDir, "src/rogue"), { recursive: true });
    fs.writeFileSync(path.join(rootDir, "src/lib/public.ts"), "export const api = true;\n");
    fs.writeFileSync(path.join(rootDir, "src/plain/public.ts"), "export const plain = true;\n");
    fs.writeFileSync(path.join(rootDir, "src/plain/internal.ts"), "export const plainSecret = true;\n");
    fs.writeFileSync(path.join(rootDir, "src/rogue/public.ts"), "import { plain } from '../plain/public';\nexport const rogue = plain;\n");
    fs.writeFileSync(path.join(rootDir, "src/lib/view.tsx"), "export const view = true;\n");
    fs.writeFileSync(path.join(rootDir, "src/lib/module.mts"), "export const moduleValue = true;\n");
    fs.writeFileSync(path.join(rootDir, "src/lib/common.cts"), "export const commonValue = true;\n");
    fs.mkdirSync(path.join(rootDir, "src/lib/events"), { recursive: true });
    fs.mkdirSync(path.join(rootDir, "src/shared"), { recursive: true });
    fs.writeFileSync(path.join(rootDir, "src/lib/events/private.ts"), "export const eventValue = true;\n");
    fs.writeFileSync(path.join(rootDir, "src/shared/helper.ts"), "export const sharedHelper = true;\n");
    fs.writeFileSync(path.join(rootDir, "src/app/public.ts"), [
      "import { view } from '../lib/view.jsx';",
      "import { moduleValue } from '../lib/module.mjs';",
      "import { commonValue } from '../lib/common.cjs';",
      "import { eventValue } from '@lib-event';",
      "import { sharedHelper } from '@shared-helper';",
      "import '@cell/core/private';",
      "export const app = Boolean(view && moduleValue && commonValue && eventValue && sharedHelper);",
      "",
    ].join("\n"));
    fs.writeFileSync(path.join(rootDir, "src/empty.ts"), "");
    writeJson(path.join(rootDir, "tsconfig.json"), {
      compilerOptions: {
        paths: {
          "@lib": ["src/lib/public.ts"],
          "@lib-event": ["src/lib/events/private.ts"],
          "@shared-helper": ["src/shared/helper.ts"],
          "@cell/*/public": ["src/*/public.ts"],
        },
      },
    });
    writeJson(path.join(rootDir, "cellfence.manifest.json"), {
      schemaVersion: "cellfence.manifest.v1",
      governance: { requireOwnership: true, include: ["src/**"], exclude: [] },
      cells: [{
        id: "lib",
        packageName: "@pkg/lib",
        ownedPaths: ["src/lib/**"],
        publicEntry: "src/lib/public.ts",
        publicSymbols: ["api"],
        producesArtifacts: [{ id: "events", paths: ["src/lib/events/**"] }],
      }, {
        id: "plain",
        ownedPaths: ["src/plain/**"],
        publicEntry: "src/plain/public.ts",
        publicSymbols: ["plain"],
      }, {
        id: "rogue",
        ownedPaths: ["src/rogue/**"],
        publicEntry: "src/rogue/public.ts",
        publicSymbols: ["rogue"],
      }, {
        id: "app",
        ownedPaths: ["src/app/**"],
        publicEntry: "src/app/public.ts",
        publicSymbols: ["app"],
        consumes: [{ cell: "lib", artifactLanes: ["events"] }, { cell: "missing" }],
      }, {
        id: "empty",
        ownedPaths: ["src/empty.ts"],
        publicEntry: "src/empty.ts",
        publicSymbols: [],
      }],
    });

    const result = checkRepository({ rootDir, manifestPath: "cellfence.manifest.json" });
    assert.equal(result.ok, false);
    assert.equal(result.metrics.empty.publicSurfaceLines, 0);
    assert.deepEqual(result.metrics.lib.artifactContracts, ["produce:events:src/lib/events/**"]);
    assert.ok(result.findings.some((finding) =>
      finding.ruleId === "CELLFENCE_PRIVATE_IMPORT"
      && finding.details?.specifier === "../lib/view.jsx"));
    assert.ok(result.findings.some((finding) =>
      finding.ruleId === "CELLFENCE_PRIVATE_IMPORT"
      && finding.details?.specifier === "../lib/module.mjs"));
    assert.ok(result.findings.some((finding) =>
      finding.ruleId === "CELLFENCE_PRIVATE_IMPORT"
      && finding.details?.specifier === "../lib/common.cjs"));
    assert.ok(result.findings.some((finding) =>
      finding.ruleId === "CELLFENCE_UNDECLARED_CONSUMER"
      && finding.cellId === "rogue"));
    assert.ok(result.findings.some((finding) =>
      finding.ruleId === "CELLFENCE_UNOWNED_IMPORT_TARGET"
      && finding.details?.specifier === "@shared-helper"));

    const context = createCellContext({ rootDir, manifestPath: "cellfence.manifest.json", cellId: "app" });
    assert.deepEqual(context.allowedImports.map((entry) => entry.cell), ["lib"]);
    assert.deepEqual(createCellContext({ rootDir, manifestPath: "cellfence.manifest.json", cellId: "plain" }).allowedImports, []);
    assert.ok(createCouplingGraph({ rootDir, manifestPath: "cellfence.manifest.json" }).nodes.some((node) => node.id === "plain"));
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("engine claim API covers ttl units, explicit expiry, and non-path conflict surfaces", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-engine-claim-edges-"));
  try {
    writeCell(rootDir, "core");
    writeManifest(rootDir, [baseCell("core")]);

    const now = new Date("2026-01-01T00:00:00.000Z");
    const defaultTtlClaim = createClaim({ rootDir, agent: "agent-default", resources: ["database:read:default"], claimId: "claim-default", now });
    assert.equal(defaultTtlClaim.exitCode, 0, JSON.stringify(defaultTtlClaim.findings));
    assert.equal(defaultTtlClaim.createdClaim.expiresAt, "2026-01-01T02:00:00.000Z");

    const minuteClaim = createClaim({ rootDir, agent: "agent-m", cells: ["core"], ttl: "30m", claimId: "claim-m", now });
    assert.equal(minuteClaim.exitCode, 0, JSON.stringify(minuteClaim.findings));
    assert.equal(minuteClaim.createdClaim.expiresAt, "2026-01-01T00:30:00.000Z");

    const hourClaim = createClaim({ rootDir, agent: "agent-h", symbols: ["core-api"], ttl: "2h", claimId: "claim-h", now });
    assert.equal(hourClaim.exitCode, 0, JSON.stringify(hourClaim.findings));
    assert.equal(hourClaim.createdClaim.expiresAt, "2026-01-01T02:00:00.000Z");

    const explicitClaim = createClaim({ rootDir, agent: "agent-explicit", resources: ["database:read:app.users"], expiresAt: "2026-01-02T00:00:00.000Z", claimId: "claim-explicit", now });
    assert.equal(explicitClaim.exitCode, 0, JSON.stringify(explicitClaim.findings));
    assert.equal(explicitClaim.createdClaim.expiresAt, "2026-01-02T00:00:00.000Z");

    const invalidExpiry = createClaim({ rootDir, agent: "agent-bad-expiry", artifactLanes: ["events"], expiresAt: "not-a-date", claimId: "claim-bad-expiry", now });
    assert.equal(invalidExpiry.exitCode, 1);
    assert.ok(invalidExpiry.findings.some((finding) => /claim requires --ttl/.test(finding.message)));

    const zeroTtl = createClaim({ rootDir, agent: "agent-zero", artifactLanes: ["events"], ttl: "0m", claimId: "claim-zero", now });
    assert.equal(zeroTtl.exitCode, 1);
    assert.ok(zeroTtl.findings.some((finding) => /claim requires --ttl/.test(finding.message)));

    writeJson(path.join(rootDir, ".cellfence/claims.json"), {
      schemaVersion: "cellfence.claims.v1",
      claims: [{
        id: "shape",
        agent: "agent-shape",
        cells: "bad",
        paths: "bad",
        symbols: "bad",
        resources: "bad",
        artifactLanes: "bad",
        createdAt: "2026-01-01T00:00:00.000Z",
        expiresAt: "2026-01-01T01:00:00.000Z",
      }, {
        id: "duplicate",
        agent: "agent-dup-a",
        cells: [],
        paths: ["src/same"],
        symbols: [],
        resources: [],
        artifactLanes: [],
        createdAt: "2026-01-01T00:00:00.000Z",
        expiresAt: "2099-01-01T00:00:00.000Z",
      }, {
        id: "duplicate",
        agent: "agent-dup-b",
        cells: [],
        paths: ["src/same"],
        symbols: [],
        resources: [],
        artifactLanes: [],
        createdAt: "2026-01-01T00:00:00.000Z",
        expiresAt: "2099-01-01T00:00:00.000Z",
      }, {
        id: "same-path-a",
        agent: "agent-path-a",
        cells: [],
        paths: ["src/same-path"],
        symbols: [],
        resources: [],
        artifactLanes: [],
        createdAt: "2026-01-01T00:00:00.000Z",
        expiresAt: "2099-01-01T00:00:00.000Z",
      }, {
        id: "same-path-b",
        agent: "agent-path-b",
        cells: [],
        paths: ["src/same-path"],
        symbols: [],
        resources: [],
        artifactLanes: [],
        createdAt: "2026-01-01T00:00:00.000Z",
        expiresAt: "2099-01-01T00:00:00.000Z",
      }, {
        id: "wildcard-right-a",
        agent: "agent-wild-right-a",
        cells: [],
        paths: ["src/right-wild"],
        symbols: [],
        resources: [],
        artifactLanes: [],
        createdAt: "2026-01-01T00:00:00.000Z",
        expiresAt: "2099-01-01T00:00:00.000Z",
      }, {
        id: "wildcard-a",
        agent: "agent-wild-a",
        cells: [],
        paths: ["*"],
        symbols: [],
        resources: [],
        artifactLanes: [],
        createdAt: "2026-01-01T00:00:00.000Z",
        expiresAt: "2099-01-01T00:00:00.000Z",
      }, {
        id: "wildcard-b",
        agent: "agent-wild-b",
        cells: [],
        paths: ["src/wild"],
        symbols: [],
        resources: [],
        artifactLanes: [],
        createdAt: "2026-01-01T00:00:00.000Z",
        expiresAt: "2099-01-01T00:00:00.000Z",
      }, {
        id: "surface-a",
        agent: "agent-a",
        cells: [],
        paths: [],
        symbols: ["shared-symbol"],
        resources: ["database:read:app.users"],
        artifactLanes: ["events-v1"],
        createdAt: "2026-01-01T00:00:00.000Z",
        expiresAt: "2099-01-01T00:00:00.000Z",
      }, {
        id: "surface-b",
        agent: "agent-b",
        cells: [],
        paths: [],
        symbols: ["shared-symbol"],
        resources: ["database:read:app.users"],
        artifactLanes: ["events-v1"],
        createdAt: "2026-01-01T00:00:00.000Z",
        expiresAt: "2099-01-01T00:00:00.000Z",
      }],
    });
    const claims = checkClaims({ rootDir, now });
    assert.equal(claims.exitCode, 1);
    assert.ok(claims.findings.some((finding) => /cells must be a string array/.test(finding.message)));
    const conflict = claims.findings.find((finding) =>
      finding.ruleId === "CELLFENCE_ACTIVE_CLAIM_CONFLICT"
      && finding.details?.left?.id === "surface-a");
    assert.ok(conflict);
    assert.deepEqual(conflict.details.surfaces, [
      "artifact:events-v1",
      "resource:database:read:app.users",
      "symbol:shared-symbol",
    ]);

  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("engine claim APIs use the current working directory and preserve task metadata", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-engine-claim-cwd-"));
  const previousCwd = process.cwd();
  try {
    writeCell(rootDir, "core");
    writeManifest(rootDir, [baseCell("core")]);
    initGit(rootDir);
    git(rootDir, ["add", "."]);
    git(rootDir, ["commit", "-m", "base"]);
    process.chdir(rootDir);
    const now = new Date("2026-01-01T00:00:00.000Z");
    const created = createClaim({ agent: "agent-cwd", task: "cover task field", resources: ["database:read:cwd"], claimId: "claim-cwd", now });
    assert.equal(created.exitCode, 0, JSON.stringify(created.findings));
    assert.equal(created.createdClaim.task, "cover task field");
    const checked = checkClaims({ agent: "agent-cwd", now });
    assert.equal(checked.exitCode, 0, JSON.stringify(checked.findings));
  } finally {
    process.chdir(previousCwd);
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("engine auto allocation matches package names, public symbols, owned path hints, and empty tasks", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-engine-auto-edges-"));
  try {
    fs.mkdirSync(path.join(rootDir, "src/payments-service"), { recursive: true });
    fs.mkdirSync(path.join(rootDir, "src/reporting"), { recursive: true });
    fs.mkdirSync(path.join(rootDir, "src/xy"), { recursive: true });
    fs.mkdirSync(path.join(rootDir, "src/zz"), { recursive: true });
    fs.writeFileSync(path.join(rootDir, "src/payments-service/public.ts"), "export const ChargeCard = true;\n");
    fs.writeFileSync(path.join(rootDir, "src/reporting/public.ts"), "export const report = true;\n");
    fs.writeFileSync(path.join(rootDir, "src/xy/public.ts"), "export const xyApi = true;\n");
    fs.writeFileSync(path.join(rootDir, "src/zz/public.ts"), "export const zzApi = true;\n");
    writeJson(path.join(rootDir, "cellfence.manifest.json"), {
      schemaVersion: "cellfence.manifest.v1",
      cells: [{
        id: "payments-service",
        packageName: "@acme/payments",
        ownedPaths: ["src/payments-service/**"],
        publicEntry: "src/payments-service/public.ts",
        publicSymbols: ["ChargeCard"],
        consumes: [],
        producesArtifacts: [],
      }, {
        id: "reporting",
        ownedPaths: ["src/reporting/**"],
        publicEntry: "src/reporting/public.ts",
        publicSymbols: ["report"],
        consumes: [],
        producesArtifacts: [],
      }, {
        id: "xy",
        ownedPaths: ["src/xy/**"],
        publicEntry: "src/xy/public.ts",
        publicSymbols: ["xyApi"],
        consumes: [],
        producesArtifacts: [],
      }, {
        id: "zz",
        packageName: "@acme/package-only",
        ownedPaths: ["src/zz/**"],
        publicEntry: "src/zz/public.ts",
        publicSymbols: ["zzApi"],
        consumes: [],
        producesArtifacts: [],
      }],
    });

    assert.deepEqual(createAutoAllocation({ rootDir, manifestPath: "cellfence.manifest.json" }).selectedCells, []);
    assert.deepEqual(createAutoAllocation({ rootDir, manifestPath: "cellfence.manifest.json", task: "touch @acme/payments" }).selectedCells, ["payments-service"]);
    assert.deepEqual(createAutoAllocation({ rootDir, manifestPath: "cellfence.manifest.json", task: "fix ChargeCard behavior" }).selectedCells, ["payments-service"]);
    assert.deepEqual(createAutoAllocation({ rootDir, manifestPath: "cellfence.manifest.json", task: "edit src/payments-service internals" }).selectedCells, ["payments-service"]);
    assert.deepEqual(createAutoAllocation({ rootDir, manifestPath: "cellfence.manifest.json", task: "xy" }).selectedCells, ["xy"]);
    assert.deepEqual(createAutoAllocation({ rootDir, manifestPath: "cellfence.manifest.json", task: "touch @acme/package-only" }).selectedCells, ["zz"]);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("engine inferManifest handles malformed workspaces and src root fallback through cwd", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-infer-api-"));
  const previousCwd = process.cwd();
  try {
    writeJson(path.join(rootDir, "package.json"), { workspaces: "packages/*" });
    fs.mkdirSync(path.join(rootDir, "src"), { recursive: true });
    fs.writeFileSync(path.join(rootDir, "src/helper.ts"), "export const helper = true;\n");
    process.chdir(rootDir);
    const manifest = inferManifest();
    assert.deepEqual(manifest.governance, {
      requireOwnership: true,
      include: ["src/**"],
      exclude: [],
      requiredRules: defaultRequiredRules,
    });
    assert.deepEqual(manifest.cells, [
      {
        id: "src-root",
        ownedPaths: ["src/*"],
        publicEntry: "src/helper.ts",
        publicSymbols: ["helper"],
        consumes: [],
        producesArtifacts: [],
      },
    ]);
  } finally {
    process.chdir(previousCwd);
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("engine reports unsupported Python syntax as a finding instead of a tool error", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-engine-python-syntax-"));
  try {
    fs.mkdirSync(path.join(rootDir, "src/core"), { recursive: true });
    fs.writeFileSync(path.join(rootDir, "src/core/public.py"), "def run():\n    return True\n");
    fs.writeFileSync(path.join(rootDir, "src/core/template.py"), "def get_{{ cookiecutter.name }}():\n    return True\n");
    writeManifest(rootDir, [
      baseCell("core", {
        ownedPaths: ["src/core/**"],
        publicEntry: "src/core/public.py",
        publicSymbols: ["run"],
      }),
    ], {
      governance: {
        requiredRules: ["CELLFENCE_UNSUPPORTED_PYTHON_SYNTAX"],
      },
    });

    const result = checkRepository({ rootDir });
    assert.equal(result.exitCode, 1);
    const syntaxFinding = result.findings.find((finding) => finding.ruleId === "CELLFENCE_UNSUPPORTED_PYTHON_SYNTAX");
    assert.ok(syntaxFinding);
    assert.equal(syntaxFinding.filePath, "src/core/template.py");
    assert.equal(syntaxFinding.details.kind, "syntax_error");
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("engine createBaseline throws when the repository cannot be checked", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-engine-create-baseline-"));
  try {
    writeJson(path.join(rootDir, "cellfence.manifest.json"), { schemaVersion: "wrong", cells: [] });
    assert.throws(
      () => createBaseline({ rootDir, manifestPath: "cellfence.manifest.json" }),
      /schemaVersion must be cellfence\.manifest\.v1/,
    );
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("engine plugin adapter helpers handle nested and non-call expressions", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-engine-helper-edges-"));
  try {
    fs.mkdirSync(path.join(rootDir, "src/core"), { recursive: true });
    fs.writeFileSync(
      path.join(rootDir, "src/core/public.ts"),
      [
        "declare const factory: () => () => unknown;",
        "declare const db: Record<string, (() => unknown) & { run(): unknown }>;",
        "export function core(): void {",
        "  factory()();",
        "  db['select']();",
        "  db['select'].run();",
        "}",
        "",
      ].join("\n"),
    );
    writeManifest(rootDir, [baseCell("core")]);
    const observedNames = [];
    const helperPlugin = {
      apiVersion: 1,
      name: "helper-edge-plugin",
      version: "1.0.0",
      adapters: [{
        name: "helper-edge-adapter",
        detect(context) {
          observedNames.push(context.helpers.getQualifiedCallName(context.sourceFile));
          function visit(node) {
            if (node.kind === context.sourceFile.kind) return;
            const name = context.helpers.getQualifiedCallName(node);
            if (Array.isArray(node.arguments)) {
              observedNames.push(context.helpers.getStaticStringArgument(node, 99));
            }
            if (name !== undefined || node.getText?.(context.sourceFile)?.includes("select")) {
              observedNames.push(name);
            }
            node.forEachChild(visit);
          }
          context.sourceFile.forEachChild(visit);
          return [];
        },
      }],
    };

    const result = checkRepository({ rootDir, manifestPath: "cellfence.manifest.json", plugins: [helperPlugin] });
    assert.equal(result.ok, true, JSON.stringify(result.findings));
    assert.ok(observedNames.includes("factory"));
    assert.ok(observedNames.includes(undefined));
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("engine validates plugin resource accesses with warning and error unresolved defaults", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-engine-plugin-resource-edges-"));
  try {
    writeCell(rootDir, "core");
    writeManifest(rootDir, [baseCell("core")]);
    const plugin = {
      apiVersion: 1,
      name: "resource-edge-plugin",
      version: "1.0.0",
      adapters: [{
        name: "resource-edge-adapter",
        detect() {
          return [{
            kind: "file",
            access: "read",
            selector: "unresolved:file",
            unresolved: true,
          }, {
            kind: "database",
            access: "read",
            selector: "unresolved:db",
            unresolved: true,
          }];
        },
      }],
    };

    const result = checkRepository({ rootDir, manifestPath: "cellfence.manifest.json", plugins: [plugin] });
    assert.equal(result.ok, false);
    assert.ok(result.warnings.some((finding) =>
      finding.ruleId === "CELLFENCE_UNRESOLVED_RESOURCE_ACCESS"
      && /resource access is not statically resolvable/.test(finding.message)));
    assert.ok(result.findings.some((finding) =>
      finding.ruleId === "CELLFENCE_UNRESOLVED_RESOURCE_ACCESS"
      && /resource access is not statically resolvable/.test(finding.message)));
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("engine reports undeclared subscribe resources with the subscribe verb", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-engine-subscribe-verb-"));
  try {
    fs.mkdirSync(path.join(rootDir, "src/core"), { recursive: true });
    fs.writeFileSync(
      path.join(rootDir, "src/core/public.ts"),
      [
        "declare const consumer: { subscribe(config: unknown): void };",
        "export function core(): void {",
        "  consumer.subscribe({ topic: 'orders' });",
        "}",
        "",
      ].join("\n"),
    );
    writeManifest(rootDir, [baseCell("core", { publicSymbols: ["core"] })]);

    const result = checkRepository({ rootDir, manifestPath: "cellfence.manifest.json" });
    assert.equal(result.ok, false);
    assert.ok(result.findings.some((finding) =>
      finding.ruleId === "CELLFENCE_UNDECLARED_RESOURCE_ACCESS"
      && /subscribes to undeclared queue resource kafka:orders/.test(finding.message)));
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});
