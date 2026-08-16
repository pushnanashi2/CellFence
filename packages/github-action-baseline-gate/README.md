# `@cellfence/github-action-baseline-gate`

Detect CellFence baseline changes in a pull request and require an
explicit governance-change approval before merge. The action is
split source with a committed runtime bundle: `dist/index.js` is an
`esbuild` CommonJS bundle that
inlines `@actions/core` and `@actions/github`, so consumers do
not need a `node_modules` tree at runtime.

The action's source code lives in
`packages/github-action-baseline-gate/src/`. The baseline comparison
logic is in `baseline-gate.ts`, which delegates to the engine
baseline-change detector and is then inlined into the action bundle
by `node scripts/bundle-github-action.mjs` (invoked from
`npm run build`).

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
    permissions:
      contents: read
      pull-requests: write
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - uses: cellfence/baseline-gate@v0
        with:
          github-token: ${{ github.token }}
          cellfence-version: "0.2.1"
          baseline-codeowners: "@alice,@bob"
          require-separate-pr: "true"
          comment-mode: "update"
```

Pass `github-token: ${{ github.token }}` explicitly so the action can
read PR reviews, attach the sticky PR comment, and apply or remove the
`governance-change` label. A baseline change approval is accepted only
when it comes from an allowed reviewer and targets the current PR head
commit.

## Inputs

| Name | Required | Default | Description |
| --- | --- | --- | --- |
| `github-token` | yes | (none) | GitHub token used to read PR reviews and update labels/comments. Pass `${{ github.token }}`. |
| `cellfence-version` | no | `0.2.1` | CellFence release version this bundled gate is paired with. The action itself does not invoke the CLI; it reads the two baseline files directly. |
| `baseline-codeowners` | no | (resolved from `CODEOWNERS`) | Comma-separated list of GitHub usernames that can approve a baseline change. Team entries are not resolved by this prototype. Defaults to the `CODEOWNERS` entry that matches `baseline-file` at the PR base SHA. |
| `require-separate-pr` | no | `true` | When `true`, a mixed PR (baseline + implementation) is surfaced as a sticky comment and fails by default. |
| `fail-on-mixed-pr` | no | `true` | When `true`, the action exits non-zero on a mixed PR. Ignored unless `require-separate-pr` is `true`. |
| `comment-mode` | no | `update` | One of `update`, `create`, `disabled`. Controls whether the action reuses the existing sticky comment or creates a new one. |
| `baseline-file` | no | `.cellfence/baselines/cellfence.baseline.json` | Repo-relative path to the baseline JSON. |
| `base-ref` | no | PR base SHA | Git ref used to read the base baseline. |
| `head-ref` | no | PR head SHA | Git ref used to read the head baseline. |

## Recommended CODEOWNERS entry

```
/.cellfence/baselines/   @alice @bob
```

Keeping baseline ownership separate from cell ownership is what
makes the gate meaningful — if the cell owner can also widen the
baseline, the gate does not change anything.
