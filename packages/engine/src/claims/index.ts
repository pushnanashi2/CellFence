// 0.4.0: barrel export for the claim backend subsystem. The
// default JSON-file implementation lives in ./backends/local-file.ts
// and the prototype GitHub Actions artifact backend lives in
// ./backends/github-artifact.ts; the resolver lives in ./selector.ts.

export {
  CellFenceClaimCasConflict,
  emptyClaimStoreState,
  type ClaimStoreBackend,
  type ClaimStoreEntry,
  type ClaimStoreState,
} from "./backend.js";

export {
  LocalFileClaimStore,
  serializeLocalFileClaimStore,
  type LocalFileClaimStoreOptions,
} from "./backends/local-file.js";

export {
  GitHubArtifactClaimStore,
  type GitHubArtifactClaimStoreOptions,
} from "./backends/github-artifact.js";

export {
  RedisClaimStore,
  type RedisLike,
  type RedisClaimStoreOptions,
} from "./backends/redis.js";

export {
  resolveClaimBackend,
  type ClaimBackendType,
  type ResolvedClaimBackend,
  type ResolveOptions,
} from "./selector.js";
