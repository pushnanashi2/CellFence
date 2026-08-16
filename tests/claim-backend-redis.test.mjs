import assert from "node:assert/strict";
import test from "node:test";

import {CellFenceClaimCasConflict, RedisClaimStore, emptyClaimStoreState} from "../packages/engine/dist/index.js";

function claimState(id) {
  return {
    ...emptyClaimStoreState(),
    claims: [{
      id,
      agent: "agent-a",
      cells: ["api"],
      paths: [],
      symbols: [],
      resources: [],
      artifactLanes: [],
      createdAt: "2026-01-01T00:00:00.000Z",
      expiresAt: "2099-01-01T00:00:00.000Z",
    }],
  };
}

function createFakeRedis(initial = new Map()) {
  const values = new Map(initial);
  let watchedKey;
  const calls = [];
  return {
    values,
    calls,
    client: {
      async watch(key) {
        calls.push(["watch", key]);
        watchedKey = key;
      },
      async unwatch() {
        calls.push(["unwatch", watchedKey]);
        watchedKey = undefined;
      },
      async get(key) {
        calls.push(["get", key]);
        return values.get(key) ?? null;
      },
      multi() {
        const queued = [];
        return {
          set(key, value) {
            queued.push([key, value]);
          },
          async exec() {
            calls.push(["exec", watchedKey]);
            for (const [key, value] of queued) values.set(key, value);
            watchedKey = undefined;
            return queued.map(() => "OK");
          },
        };
      },
      async set(key, value, ...args) {
        calls.push(["set", key, value, ...args]);
        const nx = args.some((arg) => arg === "NX" || (arg && typeof arg === "object" && arg.NX === true));
        if (nx && values.has(key)) return null;
        values.set(key, value);
        return "OK";
      },
      async del(key) {
        calls.push(["del", key]);
        const existed = values.delete(key);
        return existed ? 1 : 0;
      },
      async eval(_script, numKeysOrOptions, ...args) {
        const key = typeof numKeysOrOptions === "number" ? args[0] : numKeysOrOptions.keys[0];
        const token = typeof numKeysOrOptions === "number" ? args[1] : numKeysOrOptions.arguments[0];
        calls.push(["eval", key, token]);
        if (values.get(key) !== token) return 0;
        values.delete(key);
        return 1;
      },
    },
  };
}

test("RedisClaimStore reports the redis id and a default key", () => {
  const store = new RedisClaimStore({ url: "redis://localhost:6379/0" });
  assert.equal(store.id, "redis");
});

test("RedisClaimStore.read returns an empty state when the key is unset", async () => {
  // We do not have a live Redis available; the dynamic import of
  // the optional 'redis' package will throw and the read() method
  // should surface that as a clear error rather than silently
  // returning a corrupt state.
  const store = new RedisClaimStore({ url: "redis://127.0.0.1:1/0" });
  await assert.rejects(() => store.read(), /redis claim backend requires the optional 'redis' dependency/);
});

test("RedisClaimStore.write surfaces the missing optional dependency on CAS conflict", async () => {
  const store = new RedisClaimStore({ url: "redis://127.0.0.1:1/0" });
  await assert.rejects(
    () => store.write(emptyClaimStoreState(), emptyClaimStoreState()),
    /redis claim backend requires the optional 'redis' dependency/,
  );
});

test("RedisClaimStore.lock throws when the optional redis dep is missing", async () => {
  const store = new RedisClaimStore({ url: "redis://127.0.0.1:1/0" });
  await assert.rejects(() => store.lock(1000), /redis claim backend requires the optional 'redis' dependency/);
});

test("RedisClaimStore writes the first empty-key state through CAS", async () => {
  const fake = createFakeRedis();
  const store = new RedisClaimStore({
    url: "redis://example.test/0",
    clientFactory: () => fake.client,
  });
  const next = claimState("claim-1");
  await store.write(next, emptyClaimStoreState());
  assert.deepEqual(JSON.parse(fake.values.get("cellfence:claims")), next);
});

test("RedisClaimStore CAS conflict unwatches without deleting the claim store key", async () => {
  const current = claimState("existing");
  const fake = createFakeRedis(new Map([["cellfence:claims", JSON.stringify(current)]]));
  const store = new RedisClaimStore({
    url: "redis://example.test/0",
    clientFactory: () => fake.client,
  });
  await assert.rejects(
    () => store.write(claimState("next"), emptyClaimStoreState()),
    (error) => error instanceof CellFenceClaimCasConflict,
  );
  assert.deepEqual(JSON.parse(fake.values.get("cellfence:claims")), current);
  assert.ok(fake.calls.some((call) => call[0] === "unwatch"));
  assert.equal(fake.calls.some((call) => call[0] === "del" && call[1] === "cellfence:claims"), false);
});

test("RedisClaimStore lock releases only the matching lease token", async () => {
  const fake = createFakeRedis();
  const store = new RedisClaimStore({
    url: "redis://example.test/0",
    clientFactory: () => fake.client,
  });
  const release = await store.lock(5000);
  assert.equal(typeof fake.values.get("cellfence:claims:lock"), "string");
  await release();
  assert.equal(fake.values.has("cellfence:claims:lock"), false);

  fake.values.set("cellfence:claims:lock", "other-token");
  await assert.rejects(() => store.lock(5000), /lock is held/);
  assert.equal(fake.values.get("cellfence:claims:lock"), "other-token");
});
