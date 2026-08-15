import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { resolveClaimBackend } from "../packages/engine/dist/index.js";

const root = process.cwd();

test("resolveClaimBackend defaults to local-file when no manifest is given", () => {
  const dir = fs.mkdtempSync(path.join(root, ".cellfence-selector-"));
  try {
    const filePath = path.join(dir, "claims.json");
    const resolved = resolveClaimBackend({ rootDir: dir, defaultFilePath: filePath });
    assert.equal(resolved.type, "local-file");
    assert.equal(resolved.source, "default");
    assert.equal(resolved.backend.id, "local-file");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveClaimBackend rejects unimplemented github-artifact manifests", () => {
  const dir = fs.mkdtempSync(path.join(root, ".cellfence-selector-"));
  try {
    const filePath = path.join(dir, "claims.json");
    const manifest = {
      schemaVersion: "cellfence.manifest.v1",
      governance: {
        claimBackend: {
          type: "github-artifact",
          artifactName: "cellfence-claims-staging",
          retentionDays: 2,
        },
      },
      cells: [],
    };
    assert.throws(
      () => resolveClaimBackend({ rootDir: dir, defaultFilePath: filePath, manifest }),
      /unsupported claim backend github-artifact/,
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveClaimBackend honours the local-file env override", () => {
  const dir = fs.mkdtempSync(path.join(root, ".cellfence-selector-"));
  try {
    const filePath = path.join(dir, "claims.json");
    const manifest = {
      schemaVersion: "cellfence.manifest.v1",
      governance: {
        claimBackend: { type: "local-file" },
      },
      cells: [],
    };
    const previous = process.env.CELLFENCE_CLAIM_BACKEND;
    process.env.CELLFENCE_CLAIM_BACKEND = "local-file";
    try {
      const resolved = resolveClaimBackend({ rootDir: dir, defaultFilePath: filePath, manifest });
      assert.equal(resolved.type, "local-file");
      assert.equal(resolved.source, "env");
    } finally {
      if (previous === undefined) delete process.env.CELLFENCE_CLAIM_BACKEND;
      else process.env.CELLFENCE_CLAIM_BACKEND = previous;
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveClaimBackend rejects unknown backend types", () => {
  const dir = fs.mkdtempSync(path.join(root, ".cellfence-selector-"));
  try {
    const filePath = path.join(dir, "claims.json");
    const manifest = {
      schemaVersion: "cellfence.manifest.v1",
      governance: {
        claimBackend: { type: "redis-not-shipped" },
      },
      cells: [],
    };
    assert.throws(
      () => resolveClaimBackend({ rootDir: dir, defaultFilePath: filePath, manifest }),
      /unsupported claim backend redis-not-shipped/,
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
