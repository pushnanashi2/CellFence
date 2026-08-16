import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  CellFenceClaimCasConflict,
  LocalFileClaimStore,
  createClaim,
  emptyClaimStoreState,
} from "../packages/engine/dist/index.js";
import { GitHubArtifactClaimStore } from "../packages/engine/dist/claims/backends/github-artifact.js";

const root = process.cwd();

test("LocalFileClaimStore persists a write and returns the same state on read", async () => {
  const dir = fs.mkdtempSync(path.join(root, ".cellfence-claim-backend-"));
  try {
    const filePath = path.join(dir, "claims.json");
    const store = new LocalFileClaimStore({ filePath });
    const previous = await store.read();
    const next = {
      ...emptyClaimStoreState(),
      claims: [
        {
          id: "claim-1",
          agent: "agent-a",
          cellId: "api",
          paths: ["src/api/**"],
          symbols: ["run"],
          resources: [],
          artifactLanes: [],
          expiresAt: "2099-01-01T00:00:00.000Z",
          fingerprint: "unused-here",
        },
      ],
    };
    await store.write(next, previous);
    const reread = await store.read();
    assert.equal(reread.claims.length, 1);
    assert.equal(reread.claims[0].id, "claim-1");
    assert.ok(fs.existsSync(filePath));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("LocalFileClaimStore raises CellFenceClaimCasConflict when state moves under us", async () => {
  const dir = fs.mkdtempSync(path.join(root, ".cellfence-claim-conflict-"));
  try {
    const filePath = path.join(dir, "claims.json");
    const store = new LocalFileClaimStore({ filePath });
    const previous = await store.read();
    const otherStore = new LocalFileClaimStore({ filePath });
    // The other writer commits a non-empty state so the fingerprint
    // moves; writing back the original `previous` should be rejected.
    await otherStore.write(
      { ...emptyClaimStoreState(), claims: [{ id: "claim-other", agent: "agent-b", cellId: "worker", paths: ["src/worker/**"], symbols: [], resources: [], artifactLanes: [], expiresAt: "2099-01-01T00:00:00.000Z", fingerprint: "ignored" }] },
      emptyClaimStoreState(),
    );
    assert.throws(
      () => store.write({ ...emptyClaimStoreState(), claims: [] }, previous),
      (error) => error instanceof CellFenceClaimCasConflict,
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("LocalFileClaimStore rejects corrupt stores instead of treating them as empty", async () => {
  const dir = fs.mkdtempSync(path.join(root, ".cellfence-claim-corrupt-"));
  try {
    const filePath = path.join(dir, "claims.json");
    fs.writeFileSync(filePath, "{ not json");
    assert.throws(
      () => new LocalFileClaimStore({ filePath }).read(),
      /claim store is corrupt/,
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("LocalFileClaimStore rejects invalid store schemas instead of overwriting them", async () => {
  const dir = fs.mkdtempSync(path.join(root, ".cellfence-claim-invalid-schema-"));
  try {
    const filePath = path.join(dir, "claims.json");
    fs.writeFileSync(filePath, JSON.stringify({ schemaVersion: "wrong", claims: [] }));
    assert.throws(
      () => new LocalFileClaimStore({ filePath }).read(),
      /claim store is corrupt/,
    );
    assert.equal(JSON.parse(fs.readFileSync(filePath, "utf8")).schemaVersion, "wrong");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("LocalFileClaimStore.lock serialises concurrent writers", async () => {
  const dir = fs.mkdtempSync(path.join(root, ".cellfence-claim-lock-"));
  try {
    const filePath = path.join(dir, "claims.json");
    const store = new LocalFileClaimStore({ filePath });
    const release1 = await store.lock(1000);
    let secondAcquired = false;
    const second = store.lock(1000).then((release2) => {
      secondAcquired = true;
      return release2;
    });
    // Give the second lock a tick to be queued behind the first.
    assert.equal(secondAcquired, false);
    await release1();
    await second;
    assert.equal(secondAcquired, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("createClaim returns a structured failure when the backend CAS write conflicts", () => {
  const dir = fs.mkdtempSync(path.join(root, ".cellfence-claim-create-cas-"));
  const originalWrite = LocalFileClaimStore.prototype.write;
  try {
    fs.mkdirSync(path.join(dir, "src/core"), { recursive: true });
    fs.writeFileSync(path.join(dir, "src/core/public.ts"), "export const core = true;\n");
    fs.writeFileSync(path.join(dir, "cellfence.manifest.json"), `${JSON.stringify({
      schemaVersion: "cellfence.manifest.v1",
      governance: {
        claimBackend: { type: "local-file" },
      },
      cells: [{
        id: "core",
        ownedPaths: ["src/core/**"],
        publicEntry: "src/core/public.ts",
        publicSymbols: ["core"],
        consumes: [],
        producesArtifacts: [],
      }],
    }, null, 2)}\n`);
    LocalFileClaimStore.prototype.write = function writeWithForcedConflict() {
      throw new CellFenceClaimCasConflict("forced CAS conflict");
    };

    const result = createClaim({
      rootDir: dir,
      agent: "agent-a",
      cells: ["core"],
      claimId: "claim-core",
      ttl: "30m",
      now: new Date("2026-01-01T00:00:00.000Z"),
    });
    assert.equal(result.exitCode, 1);
    assert.equal(result.createdClaim, undefined);
    assert.ok(result.findings.some((finding) =>
      finding.ruleId === "CELLFENCE_CLAIM_INVALID"
      && /refresh claims and retry/.test(finding.message)
    ), JSON.stringify(result.findings));
  } finally {
    LocalFileClaimStore.prototype.write = originalWrite;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("GitHubArtifactClaimStore fails closed until artifact persistence is implemented", async () => {
  assert.throws(
    () => new GitHubArtifactClaimStore({ artifactName: " " }),
    /requires a non-empty artifactName/,
  );
  assert.throws(
    () => new GitHubArtifactClaimStore({ artifactName: "claims", retentionDays: 0 }),
    /retentionDays must be an integer from 1 to 90/,
  );

  const store = new GitHubArtifactClaimStore({ artifactName: "claims", retentionDays: 1 });
  await assert.rejects(() => store.read(), /not implemented/);
  await assert.rejects(
    () => store.write(emptyClaimStoreState(), emptyClaimStoreState()),
    /no artifact download\/upload CAS is available/,
  );
  await assert.rejects(() => store.lock(1000), /not implemented/);
});
