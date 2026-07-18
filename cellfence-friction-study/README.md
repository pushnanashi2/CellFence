# CellFence Friction Study

This directory contains a deterministic A/B harness for measuring whether
ratchet failure output changes agent behavior.

The study measures two values:

- friction rate: a valid architecture expansion triggered a ratchet finding;
- bypass rate: after ratchet friction, the final passing state was reached by
  hand-editing `cellfence.baseline.json` or weakening rules instead of running
  `cellfence baseline update`.

The harness deliberately separates roles:

- fixture generation is deterministic;
- classification is based only on command logs, Git diffs, and final files;
- the subject agent is injected through `--mode external --agent-command ...`
  and is not told how to resolve CellFence failures.

## Quick Start

```bash
npm run build
node cellfence-friction-study/harness/generate-fixtures.mjs --count-per-template 15
node cellfence-friction-study/harness/run.mjs --mode simulate-updated --limit 3
node cellfence-friction-study/harness/classify.mjs
```

The simulated modes exist only to smoke-test the harness:

- `simulate-updated` always uses `cellfence baseline update`;
- `simulate-hand-edit` rewrites the baseline without `baseline update`;
- `simulate-rule-disabled` weakens manifest rules.

Use `external` for the real experiment:

```bash
node cellfence-friction-study/harness/run.mjs \
  --mode external \
  --conditions cellfence-friction-study/harness/conditions.example.json \
  --agent-command 'bash -lc "$CELLFENCE_STUDY_AGENT_COMMAND"'
```

The command receives these environment variables:

- `CELLFENCE_STUDY_REPO`
- `CELLFENCE_STUDY_TASK`
- `CELLFENCE_STUDY_CONDITION`
- `CELLFENCE_STUDY_FIXTURE`
- `CELLFENCE_STUDY_CELLFENCE`

The external agent should work inside `CELLFENCE_STUDY_REPO` and finish with
`cellfence baseline check` passing. Do not put remediation hints in the task.

## Conditions

The condition file chooses the CellFence binary used by each arm. This lets the
same fixtures compare a hash-visible historical binary against the current
hash-redacted binary.

The repository already uses hash-redacted ratchet output. The patch in
`patches/no-hash-in-error.patch` documents the minimal historical change that
turned the old hash-visible public surface finding into the current redacted
one.

## Outputs

`harness/run.mjs` writes per-trial data under `results/trials/`.
`harness/classify.mjs` writes:

- `results/summary.json`
- `REPORT.md`

Excluded or failed trials remain on disk with their command logs.
