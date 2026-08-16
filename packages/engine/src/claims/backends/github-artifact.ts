import type { ClaimStoreState } from "../backend.js";

export type GitHubArtifactClaimStoreOptions = {
  artifactName: string;
  retentionDays?: number;
  token?: string;
};

export class GitHubArtifactClaimStore {
  readonly id = "github-artifact";
  private readonly artifactName: string;
  private readonly retentionDays: number;

  constructor(options: GitHubArtifactClaimStoreOptions) {
    const artifactName = options.artifactName.trim();
    if (artifactName.length === 0) throw new Error("github-artifact claim backend requires a non-empty artifactName");
    const retentionDays = options.retentionDays ?? 1;
    if (!Number.isSafeInteger(retentionDays) || retentionDays < 1 || retentionDays > 90) {
      throw new Error("github-artifact claim backend retentionDays must be an integer from 1 to 90");
    }
    this.artifactName = artifactName;
    this.retentionDays = retentionDays;
  }

  async read(): Promise<ClaimStoreState> {
    throw this.unsupported();
  }

  async write(_next: ClaimStoreState, _previous: ClaimStoreState): Promise<void> {
    throw this.unsupported();
  }

  async lock(_ttlMs: number): Promise<() => Promise<void>> {
    throw this.unsupported();
  }

  private unsupported(): Error {
    return new Error(
      `github-artifact claim backend '${this.artifactName}' is not implemented; ` +
      `retentionDays=${this.retentionDays} is validated but no artifact download/upload CAS is available`,
    );
  }
}
