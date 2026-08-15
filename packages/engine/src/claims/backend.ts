// 0.4.0 (prototype) — claim backend interface.
//
// Today every claim is written to a single `.cellfence/claims.json`
// file. That is fine for one developer and one laptop but breaks down
// the moment two parallel CI jobs try to take a claim at the same
// time, because the file is not concurrency-safe. The shipped backend
// interface stays synchronous because the public claim commands are
// synchronous today. Async/distributed backends remain internal until
// the claim API itself grows an async path.
//
// The public type accepts both the original async prototype surface
// and the synchronous local-file runtime used by the shipped CLI.
// Manifest-selected backends are still constrained by the resolver:
// synchronous claim commands reject Promise-returning implementations
// with a structured claim finding rather than awaiting arbitrary
// distributed backends in a sync path.

export type ClaimStoreState = {
  /** Schema version the state was serialised with. */
  schemaVersion: "cellfence.claims.v1";
  claims: ClaimStoreEntry[];
};

export type ClaimStoreEntry = {
  id: string;
  agent: string;
  task?: string;
  cells: string[];
  paths: string[];
  symbols: string[];
  resources: string[];
  artifactLanes: string[];
  createdAt: string;
  expiresAt: string;
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
  read(): ClaimStoreState | Promise<ClaimStoreState>;
  /**
   * Persist `next`, conditional on the previously observed state
   * being `previous`. The implementation MUST throw a
   * `CellFenceClaimCasConflict` if the current state no longer
   * matches `previous`.
   */
  write(next: ClaimStoreState, previous: ClaimStoreState): void | Promise<void>;
  /**
   * Optional distributed lock retained for compatibility with the
   * 0.4.0 prototype backend surface. Synchronous claim commands do
   * not require it; CAS remains mandatory.
   */
  lock?(ttlMs: number): Promise<() => Promise<void>>;
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
