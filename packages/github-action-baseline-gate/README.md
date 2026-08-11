# `@cellfence/github-action-baseline-gate`

> 0.4.0 prototype. The action is wired up so a workflow can be drafted
> against `@cellfence/github-action-baseline-gate@v0`, but the
> enforcement code path is not yet implemented. See
> `docs/baseline-gate.md` in the CellFence repo for the design and
> `docs/agents/agents-md-snippet.md` for the AGENTS.md boilerplate
> every repo that uses this action should adopt.

## Minimum workflow

```yaml
name: cellfence-baseline-gate
on:
  pull_request:
    paths:
      - ".cellfence/baselines/**"
      - "cellfence.manifest.json"
jobs:
  gate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - uses: cellfence/baseline-gate@v0
        with:
          cellfence-version: "0.2.1"
          baseline-codeowners: "@acme/architecture"
          require-separate-pr: "true"
          comment-mode: "update"
```

## Recommended CODEOWNERS entry

```
/.cellfence/baselines/   @acme/architecture
```

Keeping baseline ownership separate from cell ownership is what makes
the gate meaningful — if the cell owner can also widen the baseline,
the gate does not change anything.
