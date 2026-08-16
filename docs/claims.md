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

`claim create` serializes local writes with a `.lock` file next to the claim store, writes the new store to a temporary file, then atomically renames it into place. Lock files record the creating PID, hostname, boot id when available, creation time, and a reclaim token; stale reclaim trusts PID liveness only for locks created on the same host/boot. This prevents normal local last-write-wins races between parallel agents. Distributed filesystems and cross-machine coordination may still need an external lease service or a shared CI workspace with reliable lock semantics.

Expired claims are ignored for conflict purposes. Malformed claim stores, invalid expiration metadata, and claims referencing unknown cells fail with `CELLFENCE_CLAIM_INVALID`.


## Choosing a backend

The default claim store is a single JSON file. That works for one
machine, but a `cellfence/claims.json` is *not* a coordination
mechanism across machines: two GitHub Actions jobs each writing to
their own checkout will silently overwrite each other on merge.

CellFence currently exposes only the local JSON-file backend through
manifest configuration. Other backends must not be claimed as
production-ready until they actually persist state across processes.

```jsonc
{
  "governance": {
    "claimBackend": {
      "type": "local-file"
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

### Future backends

- `github-artifact` after it downloads/uploads real artifacts and proves cross-job persistence.
- `redis` for self-hosted runners with a shared Redis (WATCH/MULTI/EXEC for CAS, Redlock for `lock`).
- `s3` and `gcs` for object-store-backed coordination.
