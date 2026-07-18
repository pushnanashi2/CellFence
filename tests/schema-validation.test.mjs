import assert from "node:assert/strict";
import test from "node:test";

import {
  CELLFENCE_BASELINE_SCHEMA_VERSION,
  CELLFENCE_MANIFEST_SCHEMA_VERSION,
  CELLFENCE_RESOURCE_EVIDENCE_SCHEMA_VERSION,
  validateBaseline,
  validateManifest,
  validateResourceEvidence,
} from "../packages/schema/dist/index.js";

const validCell = {
  id: "core",
  ownedPaths: ["src/core/**"],
  publicEntry: "src/core/public.ts",
  publicSymbols: ["api"],
  consumes: [],
  producesArtifacts: [],
};

function validManifest(patch = {}) {
  return {
    schemaVersion: CELLFENCE_MANIFEST_SCHEMA_VERSION,
    cells: [validCell],
    ...patch,
  };
}

function validBaseline(patch = {}) {
  return {
    schemaVersion: CELLFENCE_BASELINE_SCHEMA_VERSION,
    generatedAt: "2026-01-01T00:00:00.000Z",
    cells: {
      core: {
        ownedPathPatterns: 1,
        publicSymbols: 1,
        publicSurfaceLines: 1,
        crossCellDependencies: 0,
      },
    },
    ...patch,
  };
}

function validEvidence(patch = {}) {
  return {
    schemaVersion: CELLFENCE_RESOURCE_EVIDENCE_SCHEMA_VERSION,
    cellId: "runtime",
    accesses: [{
      kind: "database",
      access: "read",
      selector: "app.users",
      detectedBy: "test",
      confidence: "runtime",
    }],
    ...patch,
  };
}

function assertInvalid(result, text) {
  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), text);
}

test("schema validation accepts maximal valid manifests", () => {
  assert.equal(CELLFENCE_MANIFEST_SCHEMA_VERSION, "cellfence.manifest.v1");
  assert.equal(CELLFENCE_BASELINE_SCHEMA_VERSION, "cellfence.baseline.v1");
  assert.equal(CELLFENCE_RESOURCE_EVIDENCE_SCHEMA_VERSION, "cellfence.resource-evidence.v1");
  assert.deepEqual(validateManifest(validManifest()).errors, []);

  const manifest = validManifest({
    governance: {
      requireOwnership: true,
      include: ["src/**"],
      exclude: ["src/**/*.test.ts"],
      requiredRules: ["ownership/unowned-source"],
      resourceAdapters: {
        file: "on",
        http: "off",
        queue: "on",
        "sql-literal": "off",
        prisma: "on",
        typeorm: "off",
        drizzle: "off",
        "query-builder": "off",
        bullmq: "on",
        kafkajs: "on",
        nestjs: "off",
        fastify: "off",
      },
    },
    rules: {
      "ownership/unowned-source": "error",
      "public-api/symbol-drift": "warning",
    },
    overrides: [{
      files: ["tests/**"],
      rules: {
        "resources/undeclared-access": "off",
      },
    }],
    cells: [{
      ...validCell,
      packageName: "@example/core",
      locked: true,
      consumes: [{ cell: "platform", artifactLanes: ["events-v1"] }],
      producesArtifacts: [{
        id: "events-v1",
        paths: ["src/core/artifacts/**"],
        description: "runtime artifacts produced by core",
        locked: true,
      }],
      resourceContracts: [{
        id: "users-read",
        kind: "database",
        access: ["read", "write"],
        selectors: ["app.users"],
        description: "reads and writes user rows",
      }],
      budgets: {
        ownedPathPatterns: 1,
        publicSymbols: 2,
        publicSurfaceLines: 30,
        crossCellDependencies: 1,
      },
      rules: {
        "resources/undeclared-access": "error",
      },
    }],
  });

  const result = validateManifest(manifest);
  assert.equal(result.ok, true, result.errors.join("\n"));
  assert.deepEqual(result.errors, []);
  assert.equal(result.value.cells[0].id, "core");
});

test("schema validation rejects malformed manifest root and reserved loaders", () => {
  assertInvalid(validateManifest(null), /manifest must be an object/);
  assertInvalid(validateManifest([]), /manifest must be an object/);
  assertInvalid(validateManifest(validManifest({ schemaVersion: "v0" })), /schemaVersion must be/);
  assertInvalid(validateManifest(validManifest({ extends: "base" })), /extends must be an array/);
  assertInvalid(validateManifest(validManifest({ extends: [""] })), /extends must be an array/);
  const reservedExtends = validateManifest(validManifest({ extends: ["./base.json"] }));
  assertInvalid(reservedExtends, /extends is reserved/);
  assert.equal(reservedExtends.errors.some((error) => error.includes("extends must be an array")), false);
  assertInvalid(validateManifest(validManifest({ plugins: "plugin" })), /plugins must be an array/);
  assertInvalid(validateManifest(validManifest({ plugins: ["plugin"] })), /plugins is reserved/);
  assertInvalid(validateManifest(validManifest({ plugins: [1] })), /plugins\[0\] must be a package string/);
  assertInvalid(validateManifest(validManifest({ plugins: [{}] })), /plugins\[0\]\.package must be a non-empty string/);
  assertInvalid(validateManifest(validManifest({ plugins: [{ package: "plugin", options: "bad" }] })), /options must be an object/);
  assertInvalid(validateManifest(validManifest({ rules: [] })), /rules must be an object mapping rule ids/);
  assertInvalid(validateManifest(validManifest({ rules: { "": "error", rule: "fatal" } })), /empty rule id[\s\S]*rule must be off\|warning\|error/);
});

test("schema validation rejects malformed manifest governance and overrides", () => {
  assertInvalid(validateManifest(validManifest({ governance: [] })), /governance must be an object/);
  assertInvalid(validateManifest(validManifest({ governance: { requireOwnership: "yes" } })), /requireOwnership must be a boolean/);
  assertInvalid(validateManifest(validManifest({ governance: { requireOwnership: true, include: [] } })), /include must contain at least one pattern/);
  assertInvalid(validateManifest(validManifest({ governance: { include: [""] } })), /include must be an array/);
  assertInvalid(validateManifest(validManifest({ governance: { exclude: [1] } })), /exclude must be an array/);
  assertInvalid(validateManifest(validManifest({ governance: { requiredRules: [false] } })), /requiredRules must be an array/);
  assertInvalid(validateManifest(validManifest({ governance: { resourceAdapters: "all" } })), /resourceAdapters must be an object/);
  assertInvalid(
    validateManifest(validManifest({ governance: { resourceAdapters: { unknown: "on", file: "maybe" } } })),
    /unknown must be a known built-in adapter[\s\S]*file must be on\|off/,
  );

  assertInvalid(validateManifest(validManifest({ overrides: "bad" })), /overrides must be an array/);
  assertInvalid(validateManifest(validManifest({ overrides: [null] })), /overrides\[0\] must be an object/);
  assertInvalid(validateManifest(validManifest({ overrides: [{ files: [""], rules: undefined }] })), /files must be an array[\s\S]*rules is required/);
  assertInvalid(validateManifest(validManifest({ overrides: [{ files: ["src/**"], rules: { bad: "fatal" } }] })), /rules\.bad must be off\|warning\|error/);
});

test("schema validation rejects malformed cells and nested contracts", () => {
  assertInvalid(validateManifest(validManifest({ cells: "bad" })), /cells must be an array/);
  assertInvalid(validateManifest(validManifest({ cells: [null] })), /cells\[0\] must be an object/);
  assertInvalid(
    validateManifest(validManifest({
      cells: [{
        id: "",
        ownedPaths: [""],
        publicEntry: "",
        publicSymbols: [""],
        packageName: 1,
        locked: "yes",
        consumes: "bad",
        producesArtifacts: "bad",
        resourceContracts: "bad",
        budgets: "bad",
        rules: { bad: "fatal" },
      }],
    })),
    /id must be a non-empty string[\s\S]*ownedPaths must be an array[\s\S]*publicEntry must be a non-empty string[\s\S]*publicSymbols must be an array[\s\S]*packageName must be a string[\s\S]*locked must be a boolean[\s\S]*consumes must be an array[\s\S]*producesArtifacts must be an array[\s\S]*resourceContracts must be an array[\s\S]*budgets must be an object[\s\S]*rules\.bad must be off\|warning\|error/,
  );
  assertInvalid(
    validateManifest(validManifest({
      cells: [{
        ...validCell,
        consumes: [null, { cell: "", artifactLanes: [1] }],
        producesArtifacts: [null, { id: "", paths: [""], description: 1, locked: "yes" }],
        resourceContracts: [null, { id: "", kind: "socket", access: ["execute"], selectors: [""], description: 1 }],
        budgets: {
          ownedPathPatterns: -1,
          publicSymbols: 1.2,
          publicSurfaceLines: "many",
          crossCellDependencies: -2,
        },
      }],
    })),
    /consumes\[0\] must be an object[\s\S]*consumes\[1\]\.cell[\s\S]*artifactLanes[\s\S]*producesArtifacts\[0\] must be an object[\s\S]*producesArtifacts\[1\]\.id[\s\S]*producesArtifacts\[1\]\.paths[\s\S]*description must be a string[\s\S]*locked must be a boolean[\s\S]*resourceContracts\[0\] must be an object[\s\S]*kind must be file\|database\|queue\|http[\s\S]*access must contain[\s\S]*selectors must be an array[\s\S]*ownedPathPatterns must be a non-negative integer/,
  );
});

test("schema validation accepts and rejects baseline records", () => {
  const minimalBaseline = validateBaseline(validBaseline());
  assert.equal(minimalBaseline.ok, true);
  assert.deepEqual(minimalBaseline.errors, []);
  const richBaseline = validateBaseline(validBaseline({
    cellIds: ["core"],
    seal: {
      algorithm: "hmac-sha256",
      keyId: "ci-key",
      digest: "a".repeat(64),
    },
    cells: {
      core: {
        ownedPathPatterns: 1,
        publicSymbols: 1,
        publicSurfaceLines: 1,
        crossCellDependencies: 0,
        ownedPathSet: ["src/core/**"],
        publicEntryPath: "src/core/public.ts",
        publicSymbolSet: ["api"],
        publicSurfaceHash: "abc",
        dependencyEdges: ["core->platform"],
        artifactContracts: ["events-v1"],
        resourceAccesses: [{
          kind: "file",
          access: "read",
          selector: "data/input.json",
          detectedBy: "trace",
          confidence: "high",
        }],
      },
    },
  }));
  assert.equal(richBaseline.ok, true);
  assert.deepEqual(richBaseline.errors, []);

  assertInvalid(validateBaseline(false), /baseline must be an object/);
  assertInvalid(validateBaseline(validBaseline({ schemaVersion: "v0" })), /schemaVersion must be/);
  assertInvalid(validateBaseline(validBaseline({ generatedAt: 1 })), /generatedAt must be a non-empty string/);
  assertInvalid(validateBaseline(validBaseline({ generatedAt: "" })), /generatedAt must be a non-empty string/);
  assertInvalid(validateBaseline(validBaseline({ generatedAt: "   " })), /generatedAt must be a non-empty string/);
  assertInvalid(validateBaseline(validBaseline({ cellIds: [1] })), /cellIds must be an array/);
  assertInvalid(validateBaseline(validBaseline({ cells: [] })), /cells must be an object/);
  assertInvalid(validateBaseline(validBaseline({ cells: { core: null } })), /cells\.core must be an object/);
  assertInvalid(validateBaseline(validBaseline({ seal: "sealed" })), /seal must be an object/);
  assertInvalid(validateBaseline(validBaseline({ seal: { algorithm: "sha256", digest: "a".repeat(64) } })), /seal\.algorithm must be hmac-sha256/);
  assertInvalid(validateBaseline(validBaseline({ seal: { algorithm: "hmac-sha256", keyId: 1, digest: "a".repeat(64) } })), /seal\.keyId must be a string/);
  assertInvalid(validateBaseline(validBaseline({ seal: { algorithm: "hmac-sha256", digest: "not-hex" } })), /seal\.digest must be a 64-character lowercase hex string/);
  assertInvalid(
    validateBaseline(validBaseline({
      cells: {
        core: {
          ownedPathPatterns: -1,
          publicSymbols: 1.5,
          publicSurfaceLines: "one",
          crossCellDependencies: -2,
          ownedPathSet: [""],
          publicSymbolSet: [1],
          dependencyEdges: [null],
          artifactContracts: [false],
          publicEntryPath: 1,
          publicSurfaceHash: false,
          resourceAccesses: "bad",
        },
      },
    })),
    /ownedPathPatterns must be a non-negative integer[\s\S]*publicSymbols must be a non-negative integer[\s\S]*publicSurfaceLines must be a non-negative integer[\s\S]*crossCellDependencies must be a non-negative integer[\s\S]*ownedPathSet must be an array[\s\S]*publicEntryPath must be a string[\s\S]*publicSurfaceHash must be a string[\s\S]*resourceAccesses must be an array/,
  );
  for (const key of ["publicSymbolSet", "dependencyEdges", "artifactContracts"]) {
    assertInvalid(
      validateBaseline(validBaseline({
        cells: {
          core: {
            ownedPathPatterns: 1,
            publicSymbols: 1,
            publicSurfaceLines: 1,
            crossCellDependencies: 0,
            [key]: [""],
          },
        },
      })),
      new RegExp(`${key} must be an array of non-empty strings`),
    );
  }
  assertInvalid(
    validateBaseline(validBaseline({
      cells: {
        core: {
          ownedPathPatterns: 1,
          publicSymbols: 1,
          publicSurfaceLines: 1,
          crossCellDependencies: 0,
          resourceAccesses: [null],
        },
      },
    })),
    /cells\.core\.resourceAccesses\[0\] must be an object/,
  );
  assertInvalid(
    validateBaseline(validBaseline({
      cells: {
        core: {
          ownedPathPatterns: 1,
          publicSymbols: 1,
          publicSurfaceLines: 1,
          crossCellDependencies: 0,
          resourceAccesses: [{ kind: "socket", access: "execute", selector: "", detectedBy: 1, confidence: "maybe" }],
        },
      },
    })),
    /kind must be file\|database\|queue\|http[\s\S]*access must be read\|write[\s\S]*selector must be a non-empty string[\s\S]*detectedBy must be a string[\s\S]*confidence must be high\|medium\|low\|runtime/,
  );
});

test("schema validation accepts and rejects resource evidence", () => {
  const minimalEvidence = validateResourceEvidence(validEvidence());
  assert.equal(minimalEvidence.ok, true);
  assert.deepEqual(minimalEvidence.errors, []);
  const richEvidence = validateResourceEvidence(validEvidence({
    commitSha: "abc123",
    generatedAt: "2026-01-01T00:00:00.000Z",
    accesses: [{
      kind: "queue",
      access: "publish",
      selector: "events.v1",
      cellId: "publisher",
      observedAt: "2026-01-01T00:00:01.000Z",
      detectedBy: "trace",
      confidence: "runtime",
    }],
  }));
  assert.equal(richEvidence.ok, true);
  assert.deepEqual(richEvidence.errors, []);

  assertInvalid(validateResourceEvidence("bad"), /resource evidence must be an object/);
  assertInvalid(validateResourceEvidence(validEvidence({ schemaVersion: "v0" })), /schemaVersion must be/);
  assertInvalid(validateResourceEvidence(validEvidence({ commitSha: 1 })), /commitSha must be a string/);
  assertInvalid(validateResourceEvidence(validEvidence({ generatedAt: 1 })), /generatedAt must be a string/);
  assertInvalid(validateResourceEvidence(validEvidence({ cellId: 1 })), /cellId must be a string/);
  assertInvalid(validateResourceEvidence(validEvidence({ accesses: "bad" })), /accesses must be an array/);
  assertInvalid(validateResourceEvidence(validEvidence({ accesses: [123] })), /accesses\[0\] must be an object/);
  assertInvalid(
    validateResourceEvidence({
      schemaVersion: CELLFENCE_RESOURCE_EVIDENCE_SCHEMA_VERSION,
      accesses: [{
        kind: "file",
        access: "read",
        selector: "data/input.json",
        cellId: 1,
        observedAt: 1,
      }],
    }),
    /cellId must be a string[\s\S]*observedAt must be a string[\s\S]*cellId is required/,
  );
});
