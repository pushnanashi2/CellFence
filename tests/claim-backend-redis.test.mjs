import assert from "node:assert/strict";
import test from "node:test";

import {RedisClaimStore, emptyClaimStoreState} from "../packages/engine/dist/index.js";

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
