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



After the npm package is published, a consuming repository can run CellFence as an ordinary required CI command:

```yaml
name: CellFence

on:
  pull_request:
  push:
    branches: [main]

permissions:
  contents: read

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
        run: |
          mkdir -p tmp/cellfence
          npx cellfence baseline check \
            --manifest cellfence.manifest.json \
            --baseline cellfence.baseline.json \
            --audit-log tmp/cellfence/audit.jsonl \
            --summary-json tmp/cellfence/summary.json
      - uses: actions/upload-artifact@v4
        if: always()
        with:
          name: cellfence-audit-${{ github.sha }}
          path: tmp/cellfence/
```

The current repository runs its source-built CLI in `.github/workflows/ci.yml`. A reusable externally pinned GitHub Action remains pre-release.

For real enforcement, configure the architecture job as a required status check on a protected branch. A workflow file inside the repository is not, by itself, a root of trust.
