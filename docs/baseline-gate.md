# Baseline update gate (0.4.0 prototype)

`cellfence baseline update` is convenient but dangerous in
agent-driven workflows: a coding agent that hits a CellFence
violation can silence the violation by widening the baseline. The
baseline update gate turns baseline changes from a CLI invocation
into a first-class governance event that requires human review.

## Two layers

### 1. Detection — `cellfence baseline gate`

```sh
cellfence baseline gate \
  --baseline-base base.json \
  --baseline-head head.json \
  --format json
```

Emits a `GovernanceChangeReport` that lists the dimensions in which
the head baseline differs from the base baseline:

- **ownedPaths** — `+api: src/api/internal/**`
- **publicSymbols** — `+api.stream`
- **crossCellEdges** — `+worker: api.consume`
- **resourceAccesses** — `+worker: queue:orders.ready:subscribe`

A non-empty report means a governance change. Exit 0 means "yes, the
PR widens governance"; exit 1 means "no, the baseline is unchanged".

### 2. Enforcement — `@cellfence/github-action-baseline-gate`

The companion action:

1. Applies the `governance-change` label to the PR.
2. Upserts a sticky comment summarising the change so reviewers can
   see what widened without diffing JSON.
3. Blocks merge until an approver from the `baseline-codeowners`
   list (or the `.cellfence/baselines/` CODEOWNERS section) has
   reviewed the PR.
4. Warns (or, with `fail-on-mixed-pr: true`, fails) when the PR
   mixes baseline changes with implementation changes. The default
   is warn — a future flag will make the warn/fail choice a hard
   policy decision rather than a config knob.

## Minimum setup

1. Add the action to a workflow that triggers on `pull_request` and
   on paths matching `.cellfence/baselines/**` or
   `cellfence.manifest.json`.
2. Add a CODEOWNERS entry under `.cellfence/baselines/`. Keep this
   ownership separate from cell ownership.
3. Adopt the AGENTS.md snippet from `docs/agents/agents-md-snippet.md`
   so agentic tools stop trying to widen the baseline themselves.

## Why not just protect the manifest path?

Protecting only `cellfence.manifest.json` would miss the
single-cell baseline files CellFence writes under
`.cellfence/baselines/`. The gate's whole point is to surface the
*contents* of the change, not just the fact that the file moved.
