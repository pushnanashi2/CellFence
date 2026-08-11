// 0.4.0 (prototype) — distributed claim backend interface.
//
// Today every claim is written to a single `.cellfence/claims.json`
// file. That is fine for one developer and one laptop but breaks down
// the moment two parallel CI jobs try to take a claim at the same
// time, because the file is not concurrency-safe. The full 0.4.0 work
// replaces the file with a pluggable backend, the same way the
// reporter or seal subsystems already do.
//
// The interface is intentionally minimal: read the current state,
// compare-and-swap a new state in, and a lock that the caller can
// release when it is done. Concrete backends (local file, GitHub
// Actions artifact, Redis, …) plug in behind it. The 0.4.0
// implementation will refactor packages/engine/src/claims.ts to
// resolve its backend through this interface; for now the prototype
// only ships the interface plus two reference implementations.

export type ClaimStoreState = {
  /** Schema version the state was serialised with. */
  schemaVersion: "cellfence.claims.v1";
  claims: ClaimStoreEntry[];
};

export type ClaimStoreEntry = {
  id: string;
  agent: string;
  cellId: string;
  paths: string[];
  symbols: string[];
  resources: string[];
  artifactLanes: string[];
  expiresAt: string;
  /** SHA-256 fingerprint of the canonical JSON of the claim, used for optimistic CAS. */
  fingerprint: string;
};

export type ClaimStoreBackend = {
  /** Backend identifier so the resolver can record which one is in use. */
  readonly id: string;
  /**
   * Read the current state. The returned state is what subsequent
   * `write` calls must pass as `previous` to opt into optimistic CAS.
   * Backends without a true compare-and-swap (e.g. the GitHub Actions
   * artifact backend) MUST return the last-known state so the engine
   * can detect a lost update.
   */
  read(): Promise<ClaimStoreState>;
  /**
   * Persist `next`, conditional on the previously observed state
   * being `previous`. The implementation MUST throw a
   * `CellFenceClaimCasConflict` if the current state no longer
   * matches `previous`.
   */
  write(next: ClaimStoreState, previous: ClaimStoreState): Promise<void>;
  /**
   * Acquire a distributed lock with the given TTL (ms). Returns a
   * release function. The lock is advisory: callers MUST still
   * perform CAS. Backends without a true lock (GitHub Actions
   * artifact) can throw to signal "no lock available" and let the
   * caller fall back to optimistic CAS only.
   */
  lock(ttlMs: number): Promise<() => Promise<void>>;
};

export class CellFenceClaimCasConflict extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CellFenceClaimCasConflict";
  }
}

export function emptyClaimStoreState(): ClaimStoreState {
  return { schemaVersion: "cellfence.claims.v1", claims: [] };
}
