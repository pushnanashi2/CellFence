// 0.4.0: Redis claim backend (prototype). Real self-hosted
// deployments can use Redis to coordinate claims across runners
// that do not share a filesystem. The CAS path uses WATCH/MULTI/EXEC
// against a single key, and the lock() implementation uses a
// single-instance SET NX PX lease. The `redis` package is an optional
// peer dependency; the backend throws a clear error when a Redis
// operation is attempted without it.

import crypto from "node:crypto";

import {
  type ClaimStoreBackend,
  type ClaimStoreState,
  CellFenceClaimCasConflict,
  emptyClaimStoreState,
} from "../backend.js";

export type RedisClaimStoreOptions = {
  /** Redis connection URL, e.g. `redis://localhost:6379/0`. */
  url: string;
  /** Key under which the claim store is stored. */
  key?: string;
  /** Lock TTL (ms) used by the Redlock implementation. */
  lockTtlMs?: number;
  /** Maximum number of CAS retries before giving up. */
  maxCasRetries?: number;
  /** Test hook / advanced adapter injection. */
  clientFactory?: () => RedisLike | Promise<RedisLike>;
};

export type RedisLike = {
  watch(key: string): Promise<void>;
  unwatch?: () => Promise<void>;
  multi(): { set(key: string, value: string): unknown; exec(): Promise<unknown> };
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ...args: unknown[]): Promise<unknown>;
  del(key: string): Promise<number>;
  eval(script: string, numKeysOrOptions: number | { keys: string[]; arguments: string[] }, ...args: (string | number)[]): Promise<unknown>;
  connect?: () => Promise<void>;
  isOpen?: boolean;
};

export class RedisClaimStore implements ClaimStoreBackend {
  readonly id = "redis";
  private readonly key: string;
  private readonly lockTtlMs: number;
  private readonly maxCasRetries: number;
  private readonly url: string;
  private clientPromise: Promise<RedisLike> | undefined;

  constructor(private readonly options: RedisClaimStoreOptions) {
    this.key = options.key || "cellfence:claims";
    this.lockTtlMs = options.lockTtlMs ?? 5000;
    this.maxCasRetries = options.maxCasRetries ?? 3;
    this.url = options.url;
  }

  private async client(): Promise<RedisLike> {
    if (this.clientPromise) return this.clientPromise;
    this.clientPromise = this.createClient();
    return this.clientPromise;
  }

  private async createClient(): Promise<RedisLike> {
    if (this.options.clientFactory) return this.options.clientFactory();
    let mod: { createClient?: (options: { url: string }) => RedisLike; default?: { createClient?: (options: { url: string }) => RedisLike } };
    try {
      // node-redis v4 exposes createClient(). We dynamic-import so
      // the optional dep does not become a hard
      // requirement of the engine package.
      mod = (await import("redis" as string)) as typeof mod;
    } catch (error) {
      throw new Error(
        `redis claim backend requires the optional 'redis' dependency: ${(error as Error).message}`,
        { cause: error },
      );
    }
    const createClient = mod.createClient ?? mod.default?.createClient;
    if (!createClient) throw new Error("redis claim backend requires redis.createClient()");
    const client = createClient({ url: this.url });
    if (client.connect && client.isOpen !== true) await client.connect();
    return client;
  }

  private static stableState(state: ClaimStoreState): string {
    return JSON.stringify({ ...state, claims: [...state.claims].sort((a, b) => a.id.localeCompare(b.id)) });
  }

  private static stateDigest(state: ClaimStoreState): string {
    return crypto.createHash("sha256").update(RedisClaimStore.stableState(state)).digest("hex");
  }

  private static parseState(raw: string | null): ClaimStoreState {
    if (!raw) return emptyClaimStoreState();
    try {
      const parsed = JSON.parse(raw) as ClaimStoreState;
      if (!parsed || parsed.schemaVersion !== "cellfence.claims.v1" || !Array.isArray(parsed.claims)) {
        throw new Error("claim store must have schemaVersion cellfence.claims.v1 and claims array");
      }
      return parsed;
    } catch (error) {
      throw new Error(`redis claim store is corrupt: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
  }

  async read(): Promise<ClaimStoreState> {
    const client = await this.client();
    const raw = await client.get(this.key);
    return RedisClaimStore.parseState(raw);
  }

  async write(next: ClaimStoreState, previous: ClaimStoreState): Promise<void> {
    const client = await this.client();
    const payload = JSON.stringify(next);
    for (let attempt = 0; attempt < this.maxCasRetries; attempt += 1) {
      await client.watch(this.key);
      const current = await client.get(this.key);
      if (RedisClaimStore.stateDigest(RedisClaimStore.parseState(current)) !== RedisClaimStore.stateDigest(previous)) {
        await client.unwatch?.();
        throw new CellFenceClaimCasConflict("redis claim store state changed under us; reread and retry");
      }
      const tx = client.multi();
      tx.set(this.key, payload);
      const result = await tx.exec();
      if (result !== null) return;
    }
    throw new CellFenceClaimCasConflict("redis claim store CAS exhausted retries");
  }

  async lock(ttlMs: number): Promise<() => Promise<void>> {
    // Single-instance Redlock-style lock via SET NX PX. Multi-node
    // Redlock is a 0.4.1 follow-up; for the prototype we acquire a
    // single key and release it explicitly.
    const client = await this.client();
    const token = `${process.pid}-${Date.now()}-${crypto.randomBytes(16).toString("hex")}`;
    // node-redis v4 ships overloaded set(). We type the stub to
    // accept a generic (key, value, ...args) signature so the call
    // below doesn't have to track every overload.
    const ok = await redisSetNxPx(client, this.key + ":lock", token, ttlMs);
    if (ok === null) {
      throw new Error("redis claim store lock is held by another process");
    }
    return async () => {
      // Atomic release via a Lua compare-and-delete.
      await redisEvalRelease(client, this.key + ":lock", token);
    };
  }
}

async function redisSetNxPx(client: RedisLike, key: string, value: string, ttlMs: number): Promise<unknown> {
  try {
    return await client.set(key, value, { PX: ttlMs, NX: true });
  } catch {
    return client.set(key, value, "PX", ttlMs, "NX");
  }
}

async function redisEvalRelease(client: RedisLike, key: string, token: string): Promise<unknown> {
  const script = "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end";
  try {
    return await client.eval(script, { keys: [key], arguments: [token] });
  } catch {
    return client.eval(script, 1, key, token);
  }
}
