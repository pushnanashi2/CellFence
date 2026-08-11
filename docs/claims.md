# Claim Leases

<!-- Moved from README.md CLI notes and expanded to document cross-worktree sharing. -->

Claim leases are short-lived coordination state for parallel agents. They are coordination-only architecture leases, not a runtime sandbox or filesystem permission system.

Use them when multiple agents may touch the same repository at the same time:

```bash
cellfence claim create --agent codex-1 --cell example --ttl 2h
cellfence claim check --agent codex-1
cellfence claim list
```

A claim can reserve cells, path globs, public symbols, resource keys, or artifact lanes:

```text
cellfence claim create --agent <id> --cell <id> [--path <glob>] [--symbol <name>] [--resource <key>] [--artifact <lane>] [--ttl <2h>] [--expires <ISO>] [--claims <path>] [--json]
cellfence claim check [--agent <id>] [--base <ref>] [--head <ref>] [--claims <path>] [--json]
cellfence claim list [--claims <path>] [--json]
```

By default claims are stored in `.cellfence/claims.json`. Use `--claims` to point at a runner-local or shared coordination file.

Agents working in separate clones or worktrees only see each other's claims when they share the same claim file. Common patterns are:

- commit `.cellfence/claims.json` to a short-lived coordination branch;
- store the file in a shared CI workspace;
- pass an explicit `--claims` path mounted into each agent's environment.

`claim create` refuses active overlapping claims with `CELLFENCE_ACTIVE_CLAIM_CONFLICT`. `claim check --agent` inspects the current Git diff, or a `--base`/`--head` range, and rejects files not covered by that agent's active claim with `CELLFENCE_UNCLAIMED_CHANGE`.

`claim create` serializes local writes with a `.lock` file next to the claim store, writes the new store to a temporary file, then atomically renames it into place. This prevents normal local last-write-wins races between parallel agents. Distributed filesystems and cross-machine coordination may still need an external lease service or a shared CI workspace with reliable lock semantics.

Expired claims are ignored for conflict purposes. Malformed claim stores, invalid expiration metadata, and claims referencing unknown cells fail with `CELLFENCE_CLAIM_INVALID`.


## Choosing a backend (0.4.0 prototype)

The default claim store is a single JSON file. That works for one
machine, but a `cellfence/claims.json` is *not* a coordination
mechanism across machines: two GitHub Actions jobs each writing to
their own checkout will silently overwrite each other on merge.

The 0.4.0 milestone introduces a `ClaimStoreBackend` interface so the
JSON file is just one of several backends. The CLI picks a backend
from the manifest's `governance.claimBackend` block (or falls back to
`local-file` for backwards compatibility).

```jsonc
{
  "governance": {
    "claimBackend": {
      "type": "github-artifact",
      "artifactName": "cellfence-claims",
      "retentionDays": 1
    }
  }
}
```

### `local-file` (default)

The same single-file store the previous CLI used. Safe for one
machine; *not* safe across machines. The new implementation keeps
the `.lock` file + atomic rename, and adds a CAS check that throws
`CellFenceClaimCasConflict` when a writer's `previous` snapshot no
longer matches the file on disk.

### `github-artifact`

Each job reads the previous job's artifact, mutates the claim list,
and uploads a fresh artifact. The GitHub Actions artifact API has no
native lock, so this backend exposes only the optimistic CAS path:
a `lock()` call throws, and concurrent writers are caught by the
`CellFenceClaimCasConflict` thrown from `write()`.

The full implementation is queued for 0.4.0. The
`GitHubArtifactClaimStore` class in `packages/engine/src/claims/`
ships the interface so configuration can be exercised today.

### Future backends

- `redis` for self-hosted runners with a shared Redis (WATCH/MULTI/EXEC for CAS, Redlock for `lock`).
- `s3` and `gcs` for object-store-backed coordination.
