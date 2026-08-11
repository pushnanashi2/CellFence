import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  CellFenceClaimCasConflict,
  GitHubArtifactClaimStore,
  LocalFileClaimStore,
  emptyClaimStoreState,
} from "../packages/engine/dist/index.js";

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
    await assert.rejects(
      store.write({ ...emptyClaimStoreState(), claims: [] }, previous),
      (error) => error instanceof CellFenceClaimCasConflict,
    );
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
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(secondAcquired, false);
    await release1();
    await second;
    assert.equal(secondAcquired, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("GitHubArtifactClaimStore accepts the first write and rejects lock acquisition", async () => {
  const store = new GitHubArtifactClaimStore({ artifactName: "cellfence-claims" });
  const previous = await store.read();
  await store.write({ ...emptyClaimStoreState(), claims: [] }, previous);
  await assert.rejects(() => store.lock(1000), /github-artifact backend does not provide a lock/);
});

test("GitHubArtifactClaimStore surfaces a CAS conflict when the in-memory state moved", async () => {
  const store = new GitHubArtifactClaimStore({ artifactName: "cellfence-claims" });
  const previous = await store.read();
  // The 0.4.0 wiring will round-trip through the GitHub artifact
  // API. For the prototype we simulate a concurrent write by
  // re-pointing the store's lastObserved at a new state directly.
  store.lastObserved = { ...emptyClaimStoreState(), claims: [] };
  await assert.rejects(
    () => store.write({ ...emptyClaimStoreState(), claims: [] }, previous),
    (error) => error instanceof CellFenceClaimCasConflict,
  );
});
