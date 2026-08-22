# Baseline Governance Gate

`cellfence baseline update` is intentionally powerful: it accepts architectural growth after review. In agent-driven workflows, that same command can become a self-authorization path if a pull request silently widens the baseline to make a violation disappear.

The baseline governance gate turns baseline changes into an explicit PR event. It detects what changed, labels the PR, writes a reviewer-readable summary, and can require approval from baseline owners before merge.

## Detection CLI

Use the CLI when comparing two baseline files or two immutable Git refs:

```bash
npx cellfence baseline gate \
  --baseline .cellfence/baselines/cellfence.baseline.json \
  --base-ref origin/main \
  --head-ref HEAD \
  --format human
```

File-path form is also supported:

```bash
npx cellfence baseline gate \
  --baseline-base base.json \
  --baseline-head head.json \
  --json
```

The command emits a `GovernanceChangeReport`. Exit code `1` means the baseline changed in a governance-relevant way; exit code `0` means no governance delta was detected; configuration or tool failures use the normal CellFence configuration/internal-error exit codes.

Current delta dimensions include:

- **cellIds** — a cell was added or removed from the accepted baseline set;
- **ownedPaths** — a cell's accepted ownership scope changed;
- **publicSymbols** — a public symbol was added or removed;
- **crossCellEdges** — an accepted dependency edge changed;
- **signatures** — the baseline seal changed;
- **publicSurfaceMetadata** — public entry path, declaration-derived public surface fingerprint, or legacy public-surface count metadata changed;
- **dependencyCounts** — legacy cross-cell dependency count changed;
- **artifactContracts** — an accepted producer/consumer artifact lane changed;
- **resourceAccesses** — accepted resource inventory changed;
- **externalDependencies** — accepted third-party dependency inventory changed.

## GitHub Action

`packages/github-action-baseline-gate` is a bundled, repository-local Action. It does not install the CLI at runtime; `dist/index.js` contains the baseline comparison and the minimal GitHub API client dependencies needed for labels, comments, and review checks.

Minimum workflow shape:

```yaml
name: cellfence-baseline-gate

on:
  pull_request:
    paths:
      - ".cellfence/baselines/**"
      - "cellfence.manifest.json"

permissions:
  contents: read
  pull-requests: write

jobs:
  gate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0 # v7
        with:
          fetch-depth: 0
      - uses: ./packages/github-action-baseline-gate
        with:
          github-token: ${{ github.token }}
          baseline-codeowners: "@alice,@bob"
          require-separate-pr: "true"
          fail-on-mixed-pr: "true"
```

The Action:

1. applies or removes the `governance-change` label;
2. writes a sticky PR comment summarizing the exact baseline dimensions that changed;
3. checks that an allowed baseline owner approved the current PR head SHA;
4. fails by default when implementation files and baseline files are mixed in one PR.

`baseline-codeowners` accepts explicit GitHub usernames. If omitted, the Action reads the `CODEOWNERS` entry for `baseline-file` from the PR base SHA. Team entries must be expanded before use; they are not resolved automatically.

## Minimum Policy

1. Keep `.cellfence/baselines/**` ownership separate from ordinary cell ownership.
2. Require both the normal CellFence check and the baseline governance gate on protected branches.
3. Keep `fail-on-mixed-pr: true` unless intentionally running the gate in warning mode.
4. Adopt the agent instruction snippet from `docs/agents/agents-md-snippet.md` so agents are told not to widen the baseline merely to make a check pass.

## Why Not Only Protect The Manifest?

Protecting only `cellfence.manifest.json` misses accepted baseline files under `.cellfence/baselines/**`. Those files are where historical ownership, dependency edges, public surfaces, artifact lanes, resource inventory, and external dependency inventory become accepted. The gate reviews the content of that acceptance, not just the fact that a JSON file changed.
