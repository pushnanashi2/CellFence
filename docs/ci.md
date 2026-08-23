# CI And Agent Completion

<!-- Moved from README.md to keep the repository root README concise. -->


CellFence is agent-agnostic. It can be used with Codex, Claude Code, Cursor, custom coding agents, CI bots, or human developers as long as the workflow can run a command before accepting a change.

Install the completion rule into `AGENTS.md` or the equivalent agent instruction file:

```bash
npx cellfence install --target agents-md --file AGENTS.md
npx cellfence install --target claude-md --file CLAUDE.md
```

The generated block is checksumed. `cellfence install --check` fails when the block is missing, hand-edited, stale against the current CLI, or duplicated as unmanaged CellFence instructions elsewhere in the file.

For the current source build, replace `npx cellfence` with:

```text
node /path/to/CellFence/packages/cli/dist/index.js
```

Why this works well for coding agents:

- the contract is repository-local and versioned;
- results are deterministic;
- JSON output is machine-readable;
- exit codes distinguish governance failures from configuration failures;
- the same command runs locally, in an agent loop, and in CI;
- the tool evaluates the resulting repository rather than trusting the agent's explanation.

In a consuming repository, run CellFence as an ordinary required CI command:

```yaml
name: CellFence

on:
  pull_request:
  push:
    branches: [main]

permissions:
  contents: read
  security-events: write

jobs:
  architecture:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
      - uses: actions/setup-node@v6
        with:
          node-version: 20
          cache: npm
      - run: npm ci
      - name: Verify agent-facing CellFence instructions
        run: npx cellfence install --check --file AGENTS.md
      - name: Enforce CellFence architecture
        id: cellfence
        continue-on-error: true
        run: |
          mkdir -p tmp/cellfence
          npx cellfence baseline check \
            --manifest cellfence.manifest.json \
            --baseline cellfence.baseline.json \
            --format markdown \
            --audit-log tmp/cellfence/audit.jsonl \
            --summary-json tmp/cellfence/summary.json \
            > tmp/cellfence/comment.md
      - name: Emit SARIF for code scanning
        if: always()
        continue-on-error: true
        run: |
          npx cellfence baseline check \
            --manifest cellfence.manifest.json \
            --baseline cellfence.baseline.json \
            --format sarif \
            > tmp/cellfence/cellfence.sarif
      - uses: github/codeql-action/upload-sarif@v3
        if: always()
        with:
          sarif_file: tmp/cellfence/cellfence.sarif
      - uses: actions/upload-artifact@v5
        if: always()
        with:
          name: cellfence-audit-${{ github.sha }}
          path: tmp/cellfence/
      - name: Fail when CellFence found violations
        if: steps.cellfence.outcome == 'failure'
        run: exit 1
```

The current repository runs its source-built CLI in `.github/workflows/ci.yml`, pins GitHub-hosted Actions to audited commit SHAs with tag comments, uses Node 20 for the main Linux jobs, runs Node 22 smoke coverage on Linux, macOS, and Windows, and includes an additional Linux Node 24 smoke job for forward compatibility. The reusable check Action runs the published npm CLI through its `version` input, not the source tree from the Action ref.

Pull requests also run the `mutation changed` check. It selects mutation scopes from the merge-base diff, narrows lockfile-only changes when the affected workspace can be identified, supports bounded parallelism with `--jobs 1..4`, preserves a pull-request-local incremental cache, and uploads its machine-readable plan and summary on success or failure. The separate `Full Mutation Audit` workflow runs every scope without incremental reuse on a daily schedule, by manual dispatch, and as a required reusable job before npm publishing. The changed check is fast feedback; only the full audit is repository-wide mutation evidence. Configure `mutation changed`, `external-oracles`, and the normal CellFence check as required status checks on `main` so repository workflow changes cannot bypass them by convention alone.

For PR discussion, post or summarize `tmp/cellfence/comment.md`; it is generated from the same findings as JSON and SARIF.

The reusable Action wrapper accepts a `version` input. The checked-in Action defaults to the current package version for reproducibility. For required checks, keep it pinned to an exact published version:

```yaml
- uses: OWNER/REPOSITORY/packages/github-action@v0.2.1
  with:
    version: 0.2.1
    manifest: cellfence.manifest.json
    baseline: cellfence.baseline.json
```

`npm run release:verify` fails if the Action bypasses the `version` input or drifts from the root package version.

## Baseline Governance Gate

If pull requests can edit `.cellfence/baselines/**`, add the bundled baseline gate Action from `packages/github-action-baseline-gate`. It compares the PR base and head baseline at immutable SHAs, applies a `governance-change` label, writes a sticky summary comment, checks approval from baseline owners, and fails mixed implementation-plus-baseline PRs by default. See [docs/baseline-gate.md](baseline-gate.md) for the complete workflow.

For real enforcement, configure the architecture job as a required status check on a protected branch. A workflow file inside the repository is not, by itself, a root of trust.

Signed waivers require the same credential separation discipline as HMAC baseline verification. Do not expose `CELLFENCE_WAIVER_ATTESTATION_HMAC_KEY` to untrusted pull-request code; use it only in a trusted approval/signing job, an isolated verifier, or an external signing service. PR checks should set `CELLFENCE_APPROVERS` and `CELLFENCE_REPOSITORY_IDENTITY` from protected CI configuration, not from repository files.

## Signed Baseline Workflows

Use asymmetric baseline signing when untrusted pull requests can edit `cellfence.baseline.json`. PR checks should receive only `CELLFENCE_BASELINE_ED25519_PUBLIC_KEY`; the private key belongs only to an approval-controlled signing workflow or an external signing service.

Pull request verification:

```yaml
name: CellFence Baseline Verify

on:
  pull_request:

permissions:
  contents: read

jobs:
  verify:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0 # v7
      - uses: actions/setup-node@249970729cb0ef3589644e2896645e5dc5ba9c38 # v6
        with:
          node-version: 20
          cache: npm
      - run: npm ci
      - name: Verify signed baseline
        env:
          CELLFENCE_BASELINE_ED25519_PUBLIC_KEY: ${{ vars.CELLFENCE_BASELINE_ED25519_PUBLIC_KEY }}
        run: npx cellfence baseline verify --manifest cellfence.manifest.json --baseline cellfence.baseline.json
      - name: Enforce accepted baseline
        env:
          CELLFENCE_BASELINE_ED25519_PUBLIC_KEY: ${{ vars.CELLFENCE_BASELINE_ED25519_PUBLIC_KEY }}
        run: npx cellfence baseline check --manifest cellfence.manifest.json --baseline cellfence.baseline.json
```

Approval-controlled signing:

```yaml
name: CellFence Baseline Sign

on:
  workflow_dispatch:
    inputs:
      approved_branch:
        description: Reviewed repository branch to sign
        required: true

permissions:
  contents: write

jobs:
  sign:
    runs-on: ubuntu-latest
    environment: baseline-signing
    steps:
      - uses: actions/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0 # v7
        with:
          ref: ${{ inputs.approved_branch }}
      - uses: actions/setup-node@249970729cb0ef3589644e2896645e5dc5ba9c38 # v6
        with:
          node-version: 22
      - name: Install reviewed CellFence package
        env:
          CELLFENCE_VERSION: 0.2.1 # replace with the exact published version approved for this workflow
        run: npm install --global "cellfence@${CELLFENCE_VERSION}"
      - name: Sign reviewed baseline only
        env:
          CELLFENCE_BASELINE_ED25519_PRIVATE_KEY: ${{ secrets.CELLFENCE_BASELINE_ED25519_PRIVATE_KEY }}
          CELLFENCE_BASELINE_ED25519_KEY_ID: baseline-2026q3
        run: cellfence baseline sign --baseline cellfence.baseline.json
      - name: Commit signed baseline
        run: |
          git config user.name "cellfence-baseline-signer"
          git config user.email "cellfence-baseline-signer@example.invalid"
          git add cellfence.baseline.json
          git commit -m "Sign CellFence baseline"
          git push origin HEAD:${{ inputs.approved_branch }}
```

The signing job checks out the reviewed branch so it can write the signature back, but it does not run `npm ci`, package scripts, tests, or any repository code from that branch while the private key is present. If the workflow needs to inspect or regenerate the baseline, do that in a separate public-key-only job and require human approval before signing.

Do not use `pull_request_target` to check out and execute pull-request code. `pull_request_target` can access privileged context and secrets from the base repository; combining it with an untrusted checkout gives the PR author a path to the signing key. If you must use `pull_request_target` for labels or comments, keep it read-only and never run the PR branch's code in that workflow.
