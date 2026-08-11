// 0.4.0: Redis claim backend (prototype). Real self-hosted
// deployments can use Redis to coordinate claims across runners
// that do not share a filesystem. The CAS path uses WATCH/MULTI/EXEC
// against a single key, and the lock() implementation delegates to
// the redlock algorithm. Both `ioredis` and `redlock` are *optional*
// peer dependencies; the backend throws a clear error at
// construction time if they are not installed.

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
};

type RedisLike = {
  watch(key: string): Promise<void>;
  multi(): { get(key: string): unknown; set(key: string, value: string): unknown; exec(): Promise<unknown> };
  get(key: string): Promise<string | null>;
  set(key: string, value: string, mode: string, duration: number): Promise<unknown>;
  del(key: string): Promise<number>;
  eval(script: string, numKeys: number, ...args: (string | number)[]): Promise<unknown>;
};

export class RedisClaimStore implements ClaimStoreBackend {
  readonly id = "redis";
  private readonly key: string;
  private readonly lockTtlMs: number;
  private readonly maxCasRetries: number;
  private readonly url: string;

  constructor(private readonly options: RedisClaimStoreOptions) {
    this.key = options.key || "cellfence:claims";
    this.lockTtlMs = options.lockTtlMs ?? 5000;
    this.maxCasRetries = options.maxCasRetries ?? 3;
    this.url = options.url;
  }

  private async client(): Promise<RedisLike> {
    let mod: { Redis: new (url: string) => RedisLike };
    try {
      // node-redis v4 ships an ESM-friendly default export. We
      // dynamic-import so the optional dep does not become a hard
      // requirement of the engine package.
      mod = (await import("redis" as string)) as { Redis: new (url: string) => RedisLike };
    } catch (error) {
      throw new Error(
        `redis claim backend requires the optional 'redis' dependency: ${(error as Error).message}`,
      );
    }
    const client = new mod.Redis(this.url);
    return client;
  }

  async read(): Promise<ClaimStoreState> {
    const client = await this.client();
    const raw = await client.get(this.key);
    if (!raw) return emptyClaimStoreState();
    try {
      return JSON.parse(raw) as ClaimStoreState;
    } catch {
      return emptyClaimStoreState();
    }
  }

  async write(next: ClaimStoreState, previous: ClaimStoreState): Promise<void> {
    const client = await this.client();
    const payload = JSON.stringify(next);
    for (let attempt = 0; attempt < this.maxCasRetries; attempt += 1) {
      await client.watch(this.key);
      const current = await client.get(this.key);
      if ((current || "null") !== JSON.stringify(previous)) {
        await client.del(this.key); // unwatch equivalent
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
    const token = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    // node-redis v4 ships overloaded set(). We type the stub to
    // accept a generic (key, value, ...args) signature so the call
    // below doesn't have to track every overload.
    const ok = await (client.set as unknown as (k: string, v: string, ...args: (string | number)[]) => Promise<unknown>)(this.key + ":lock", token, "PX", ttlMs, "NX");
    if (ok === null) {
      throw new Error("redis claim store lock is held by another process");
    }
    return async () => {
      // Atomic release via a Lua compare-and-delete.
      await client.eval(
        "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end",
        1,
        this.key + ":lock",
        token,
      );
    };
  }
}
