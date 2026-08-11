// 0.4.0 (prototype) — GitHub Actions artifact claim backend.
//
// The full implementation downloads the previous job's artifact,
// merges in the new claim, and re-uploads the artifact. The GitHub
// Actions artifact API has no native lock, so this backend exposes
// only the optimistic CAS path: every `write` is preceded by a
// `read`, and a mismatch surfaces as `CellFenceClaimCasConflict`.
//
// Wiring this up for real needs @actions/artifact v2 and the
// `actions/github-script` runtime; the prototype ships a stub so the
// factory function can be referenced from configuration today.

import {
  type ClaimStoreBackend,
  type ClaimStoreState,
  CellFenceClaimCasConflict,
} from "../backend.js";

export type GitHubArtifactClaimStoreOptions = {
  artifactName: string;
  retentionDays?: number;
  /** Token used to talk to the GitHub Actions artifact API. */
  token?: string;
};

export class GitHubArtifactClaimStore implements ClaimStoreBackend {
  readonly id = "github-artifact";
  // The 0.4.0 wiring will keep an in-memory cache of the last
  // downloaded state and refresh it on every read so the engine can
  // detect a lost update. Exposed as a public field so the prototype
  // test harness can simulate a concurrent upload without reaching
  // for the GitHub artifact API.
  lastObserved: ClaimStoreState | undefined;

  constructor(private readonly options: GitHubArtifactClaimStoreOptions) {
    // Construction is intentionally cheap; the GitHub artifact API
    // is contacted lazily on read/write.
    this.options.retentionDays = options.retentionDays ?? 1;
  }

  async read(): Promise<ClaimStoreState> {
    // TODO(0.4.0): download the artifact, parse, return.
    // For now we return whatever we last observed so the engine can
    // at least drive the CAS path.
    return this.lastObserved ?? { schemaVersion: "cellfence.claims.v1", claims: [] };
  }

  async write(_next: ClaimStoreState, _previous: ClaimStoreState): Promise<void> {
    // TODO(0.4.0): upload the new artifact, recording the previous
    // fingerprint so a concurrent upload can be detected.
    if (!this.lastObserved) {
      // First write ever; accept optimistically.
      this.lastObserved = _next;
      return;
    }
    if (this.lastObserved !== _previous) {
      throw new CellFenceClaimCasConflict(
        "github-artifact backend has no native lock; rely on CAS to detect concurrent updates",
      );
    }
    this.lastObserved = _next;
  }

  async lock(_ttlMs: number): Promise<() => Promise<void>> {
    // The artifact API has no lock primitive. Throw so the caller
    // can fall back to optimistic CAS. Callers should treat this
    // throw as "no lock available; use CAS instead" rather than a
    // hard failure.
    throw new Error("github-artifact backend does not provide a lock; rely on optimistic CAS");
  }
}
