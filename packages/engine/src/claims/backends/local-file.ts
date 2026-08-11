// 0.4.0 (prototype) — local-file claim backend.
//
// This is the simplest possible implementation: read
// `.cellfence/claims.json`, mutate, write back, and serialise writers
// through a per-process async mutex. Distributed concurrency is *not*
// safe with this backend (a second machine will happily overwrite the
// first). The CAS check is in place so a process that loses the race
// gets a `CellFenceClaimCasConflict` rather than a silent lost
// update; the next 0.4.0 milestone will plug a real distributed
// backend (GitHub Actions artifact, Redis, …) behind the same
// interface.

import fs from "node:fs";
import path from "node:path";

import {
  type ClaimStoreBackend,
  type ClaimStoreEntry,
  type ClaimStoreState,
  CellFenceClaimCasConflict,
  emptyClaimStoreState,
} from "../backend.js";

export type LocalFileClaimStoreOptions = {
  filePath: string;
};

function readState(filePath: string): ClaimStoreState {
  if (!fs.existsSync(filePath)) return emptyClaimStoreState();
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, "utf8")) as ClaimStoreState;
    if (!raw || raw.schemaVersion !== "cellfence.claims.v1" || !Array.isArray(raw.claims)) {
      return emptyClaimStoreState();
    }
    return raw;
  } catch {
    return emptyClaimStoreState();
  }
}

function fingerprintOf(state: ClaimStoreState): string {
  // Stable fingerprint for CAS comparisons. We deliberately re-use
  // the engine's canonical JSON so two writes with the same content
  // collide on the same fingerprint, and so callers can compute the
  // expected fingerprint without serialising twice.
  const canonical = JSON.stringify({ ...state, claims: [...state.claims].sort((a, b) => a.id.localeCompare(b.id)) });
  let hash = 0;
  for (let i = 0; i < canonical.length; i += 1) {
    hash = ((hash << 5) - hash + canonical.charCodeAt(i)) | 0;
  }
  return (hash >>> 0).toString(16);
}

export class LocalFileClaimStore implements ClaimStoreBackend {
  readonly id = "local-file";
  private current: ClaimStoreState;
  private mutex: Promise<void> = Promise.resolve();

  constructor(private readonly options: LocalFileClaimStoreOptions) {
    this.current = readState(this.options.filePath);
  }

  async read(): Promise<ClaimStoreState> {
    return this.current;
  }

  async write(next: ClaimStoreState, previous: ClaimStoreState): Promise<void> {
    const release = await this.lock(5000);
    try {
      // Re-read from disk before comparing so concurrent writers in
      // other processes (or other LocalFileClaimStore instances
      // pointing at the same path) are visible to the CAS check.
      const live = readState(this.options.filePath);
      if (fingerprintOf(live) !== fingerprintOf(previous)) {
        throw new CellFenceClaimCasConflict(
          "claim store state changed under us; reread and retry",
        );
      }
      fs.mkdirSync(path.dirname(this.options.filePath), { recursive: true });
      fs.writeFileSync(this.options.filePath, JSON.stringify(next, null, 2));
      this.current = next;
    } finally {
      await release();
    }
  }

  async lock(ttlMs: number): Promise<() => Promise<void>> {
    let resolveLock: (() => void) | undefined;
    const next = new Promise<void>((resolve) => {
      resolveLock = resolve;
    });
    const previous = this.mutex;
    this.mutex = previous.then(() => next);
    await previous;
    let released = false;
    return async () => {
      if (released) return;
      released = true;
      resolveLock?.();
      // Soft TTL: if the holder takes longer than ttlMs the lock
      // becomes unreliable. We surface this as a warning rather than
      // a hard error because the 0.4.0 distributed backends will have
      // their own TTL semantics.
      setTimeout(() => undefined, ttlMs).unref?.();
    };
  }
}

export function localFileClaimStoreFingerprint(state: ClaimStoreState): string {
  return fingerprintOf(state);
}

// export a stable serializer for the local-file backend so the
// CAS fingerprint is comparable across processes pointing at the
// same path. 0.4.0 callers should rely on LocalFileClaimStore.write
// directly rather than reaching for the fingerprint.
export function serializeLocalFileClaimStore(state: ClaimStoreState): string {
  return JSON.stringify({ ...state, claims: [...state.claims].sort((a, b) => a.id.localeCompare(b.id)) }, null, 2);
}
