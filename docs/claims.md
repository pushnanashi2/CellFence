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

Expired claims are ignored for conflict purposes. Malformed claim stores, invalid expiration metadata, and claims referencing unknown cells fail with `CELLFENCE_CLAIM_INVALID`.
