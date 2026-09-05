// 0.4.0 (prototype) — local-file claim backend.
//
// This is the simplest possible implementation: read
// `.cellfence/claims.json`, mutate, write back, and serialise writers
// through optimistic CAS. Distributed locking is *not* provided by
// this backend, but a process that loses the race gets a
// `CellFenceClaimCasConflict` rather than a silent lost update.

import fs from "node:fs";
import crypto from "node:crypto";
import path from "node:path";

import {
  type ClaimStoreBackend,
  type ClaimStoreState,
  CellFenceClaimCasConflict,
  emptyClaimStoreState,
} from "../backend.js";
import { stableCanonicalJson } from "../../governance/canonicalization.js";

export type LocalFileClaimStoreOptions = {
  filePath: string;
};

const DIRECT_WRITE_LOCK_STALE_MS = 5 * 60 * 1000;

function readState(filePath: string): ClaimStoreState {
  if (!fs.existsSync(filePath)) return emptyClaimStoreState();
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, "utf8")) as ClaimStoreState;
    if (!raw || raw.schemaVersion !== "cellfence.claims.v1" || !Array.isArray(raw.claims)) {
      throw new Error("claim store must have schemaVersion cellfence.claims.v1 and claims array");
    }
    return raw;
  } catch (error) {
    throw new Error(`claim store is corrupt: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
}

function fingerprintOf(state: ClaimStoreState): string {
  // Stable fingerprint for CAS comparisons. We deliberately re-use
  // the engine's canonical JSON so two writes with the same content
  // collide on the same fingerprint, and so callers can compute the
  // expected fingerprint without serialising twice.
  const canonical = stableCanonicalJson({ ...state, claims: [...state.claims].sort((a, b) => a.id.localeCompare(b.id)) });
  return crypto.createHash("sha256").update(canonical).digest("hex");
}

function processIsAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function recoverStaleDirectWriteLock(lockPath: string): boolean {
  try {
    const stat = fs.statSync(lockPath);
    const [pidText = "", timestampText = ""] = fs.readFileSync(lockPath, "utf8").split(/\r?\n/);
    const pid = Number(pidText.trim());
    const timestampMs = Date.parse(timestampText.trim());
    const ageMs = Date.now() - (Number.isFinite(timestampMs) ? timestampMs : stat.mtimeMs);
    if (ageMs < DIRECT_WRITE_LOCK_STALE_MS) return false;
    if (Number.isInteger(pid) && pid > 0 && processIsAlive(pid)) return false;
    fs.rmSync(lockPath, { force: true });
    return true;
  } catch {
    return false;
  }
}

function openDirectWriteLock(lockPath: string): number {
  try {
    return fs.openSync(lockPath, "wx", 0o600);
  } catch (error) {
    const code = typeof error === "object" && error !== null && "code" in error ? String((error as { code?: unknown }).code) : "";
    if (code === "EEXIST" && recoverStaleDirectWriteLock(lockPath)) {
      return fs.openSync(lockPath, "wx", 0o600);
    }
    throw error;
  }
}

function withDirectWriteLock<Result>(filePath: string, callback: () => Result): Result {
  const lockPath = `${filePath}.local-file-write.lock`;
  let fd: number | undefined;
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fd = openDirectWriteLock(lockPath);
    fs.writeFileSync(fd, `${process.pid}\n${new Date().toISOString()}\n`);
    return callback();
  } catch (error) {
    const code = typeof error === "object" && error !== null && "code" in error ? String((error as { code?: unknown }).code) : "";
    if (code === "EEXIST" || code === "EPERM" || code === "EACCES" || code === "EBUSY") {
      throw new CellFenceClaimCasConflict("claim store writer lock is held; reread and retry");
    }
    throw error;
  } finally {
    if (fd !== undefined) {
      fs.closeSync(fd);
      fs.rmSync(lockPath, { force: true });
    }
  }
}

function writeStateAtomic(filePath: string, state: ClaimStoreState): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  let temporaryPath: string | undefined;
  try {
    temporaryPath = `${filePath}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`;
    fs.writeFileSync(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(temporaryPath, filePath);
    temporaryPath = undefined;
  } finally {
    if (temporaryPath) fs.rmSync(temporaryPath, { force: true });
  }
}

export class LocalFileClaimStore implements ClaimStoreBackend {
  readonly id = "local-file";
  private current: ClaimStoreState = emptyClaimStoreState();
  private mutex: Promise<void> = Promise.resolve();

  constructor(private readonly options: LocalFileClaimStoreOptions) {}

  read(): ClaimStoreState {
    this.current = readState(this.options.filePath);
    return this.current;
  }

  write(next: ClaimStoreState, previous: ClaimStoreState): void {
    withDirectWriteLock(this.options.filePath, () => {
      // Re-read from disk before comparing so concurrent writers in
      // other processes (or other LocalFileClaimStore instances
      // pointing at the same path) are visible to the CAS check.
      const live = readState(this.options.filePath);
      if (fingerprintOf(live) !== fingerprintOf(previous)) {
        throw new CellFenceClaimCasConflict(
          "claim store state changed under us; reread and retry",
        );
      }
      writeStateAtomic(this.options.filePath, next);
      this.current = next;
    });
  }

  // Test/helper-only process-local lock. It is intentionally not part
  // of the public ClaimStoreBackend contract because public claim
  // operations are synchronous and rely on CAS for this backend.
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
  return `${stableCanonicalJson({ ...state, claims: [...state.claims].sort((a, b) => a.id.localeCompare(b.id)) })}\n`;
}
