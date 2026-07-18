# Corpus Precision Study

This protocol turns "CellFence works on my fixtures" into a repeatable external
measurement. It is intentionally boring: freeze repositories before running,
run the same static command everywhere, report failures, and label a sample by
hand before making precision claims.

## What This Measures

The corpus pass measures:

- onboarding rate: how many frozen repositories can be cloned, checked out,
  given a CellFence manifest, and checked without special-case repair;
- finding distribution: which CellFence rules fire on real repositories;
- false-positive pressure: which findings survive manual review;
- manifest friction: which repositories cannot be represented without awkward
  CellFence-specific manifest work.

It does not measure long-term operational value. That belongs to dogfooding and
agent A/B runs.

This study estimates conditional finding precision and onboarding friction. It
does not estimate recall, false-negative rate, causal effectiveness, or
long-term operational value. Recall requires history replay, mutation
injection, or an independent ground-truth boundary set.

## Frozen Corpus Manifest

Store the corpus manifest before running the study:

```json
{
  "schemaVersion": "cellfence.corpus.v1",
  "subjects": [
    {
      "id": "example-service",
      "repository": "https://github.com/example/example-service.git",
      "commit": "0123456789abcdef0123456789abcdef01234567",
      "manifest": {
        "strategy": "existing",
        "path": "cellfence.manifest.json"
      },
      "expected": {
        "exitCode": 0,
        "forbiddenRuleIds": ["CELLFENCE_OWNERSHIP_OVERLAP"]
      }
    }
  ]
}
```

Rules for corpus selection:

- choose the repository set before running the tool;
- pin every subject by exact 40-hex Git commit;
- keep failed clones, checkout failures, manifest failures, and configuration
  errors in the denominator;
- split tuning and reporting corpora so fixes do not overfit the public table;
- prefer repositories that already have Nx, dependency-cruiser, ESLint boundary,
  CODEOWNERS, or similar boundary evidence when comparing with adjacent tools.

## Running

Build the CLI and run:

```bash
npm run research:corpus -- --corpus docs/research/corpora/ts-monorepo-50.json --out reports/corpus/ts-monorepo-50.json
```

The script:

- clones each repository into a hash-suffixed subject directory under
  `tmp/corpus-precision-study/`;
- checks out the exact commit;
- prepares the manifest by `existing`, `copy`, or non-destructive `infer`
  strategy;
- runs `cellfence check --json`;
- writes command logs and a fixed CellFence audit log under each subject
  directory;
- writes a summary JSON report under `reports/`;
- records environment metadata, manifest SHA-256, actual commit, Git tree
  hashes, and whether the subject worktree was clean before checking.

Subject status is classified as:

| Status | Meaning |
| --- | --- |
| `checked_clean` | CellFence exited 0. |
| `checked_findings` | CellFence exited 1 with parsed findings. This is a normal research result, not a harness failure. |
| `configuration_error` | CellFence exited 2. The harness exits non-zero. |
| `tool_error` | CellFence exited with an internal/tool error. |
| `unparseable_output` | CellFence output could not be parsed as JSON. |
| `timeout` | A command exceeded its stage timeout. |

It does not install dependencies or execute target repository package scripts.
If a separate experiment needs package installation, use an isolated runner and
`npm ci --ignore-scripts` unless the experiment explicitly studies runtime
install behavior.

Exploratory runs may pass `--allow-floating-ref`, but those results are not
eligible for external claims.

Use `--dry-run` to validate the frozen corpus manifest and produce a planned
report without cloning repositories.

## Evidence Bundles

After a corpus run, freeze the evidence bundle before labeling:

```bash
npm run research:bundle -- \
  --study-id ts-js-workspace-pilot-2026-07-18 \
  --corpus docs/research/corpora/ts-js-workspace-pilot-10.json \
  --report reports/corpus/ts-js-workspace-pilot-10.nondestructive.json \
  --out-dir reports/corpus/ts-js-workspace-pilot-2026-07-18-bundle
```

Validate an existing bundle with:

```bash
npm run research:bundle -- --validate --bundle reports/corpus/ts-js-workspace-pilot-2026-07-18-bundle
```

The bundle contains:

- `study.json`, `corpus.json`, and `report.json`;
- `findings.raw.jsonl` copied from CellFence audit events;
- `findings.normalized.jsonl` with stable `findingId` values derived from
  `subjectId + commit + manifestSha256 + ruleId + fingerprint`;
- `findings.sampled.jsonl` and `sampling.json`;
- copied manifests under `manifests/` and command/audit logs under `logs/`;
- `labels.jsonl` and `SHA256SUMS`.

The validator rejects unknown `findingId` references, duplicate
`rater/findingId` labels, unknown label values, missing rationales, unsorted
normalized findings, manifest hash mismatches, and SHA-256 mismatches.

Sampling is deterministic. The default rule is to include every finding for
rule families with 50 or fewer findings, otherwise sample 50 per rule using a
seed derived from the corpus SHA-256, then ensure at least three findings per
repository when available.

## Manifest Strategies

`existing` uses a manifest already present in the target repository. This is the
cleanest strategy for CellFence's own dogfood and future adopters.

`copy` copies a checked manifest from the corpus directory into the subject
control directory.
Use this when comparing against an existing boundary tool and preserving the
reviewed CellFence translation next to the corpus manifest.
For safety and reproducibility, `copy` sources must be relative paths inside the
corpus directory. The effective manifest is copied into the subject control
directory, outside the target checkout, and passed to CellFence by absolute path.

`infer` runs `cellfence init --output <subject-control-dir>/cellfence.manifest.json --no-scaffold`
against the checkout. This is useful for onboarding friction, but it is not a
precision study until the generated manifest is reviewed or compared against
existing boundary configuration. The generated manifest is stored outside the
target checkout, custom manifest paths are rejected for this strategy, and the
harness fails the subject if manifest preparation leaves the checkout dirty.

Additional `subject.check.args` cannot override fixed execution controls such as
`--root`, `--manifest`, `--json`, `--format`, `--audit-log`, `--summary-json`,
`--changed`, `--base`, or `--head`.

## Manual Labels

Raw findings are not truth. For each rule family, sample findings and label:

- true positive: the finding blocks an unintended or policy-violating boundary
  change;
- false positive: the finding blocks an intended architecture that the manifest
  or detector cannot represent cleanly;
- needs policy: the finding is accurate but needs an approval workflow rather
  than a hard failure;
- invalid setup: the manifest translation, not the detector, caused the finding.

Report precision only on labeled rows. Report onboarding failures separately.
Use a predeclared sampling rule. A recommended default is to label every finding
for rule families with 50 or fewer findings and otherwise sample 50 findings per
rule using a seed derived from the corpus hash.

Allowed bundle labels are `true_positive`, `false_positive`, `needs_policy`,
`needs_review`, `invalid_setup`, and `out_of_scope`. Every label row must include
`findingId`, `rater`, `label`, and `rationale`.

`manifest.strategy: infer` findings may be labeled for tuning and onboarding
friction, but they are excluded from precision denominators. Precision
denominators are limited to findings from `existing` manifests or `copy`
manifests whose translation has been reviewed and recorded as `reviewed`.

Report at least:

- semantic correctness: `(true positive + needs policy) / (true positive + needs policy + false positive)`;
- blocking precision: `true positive / (true positive + needs policy + false positive)`;
- translation error rate: `invalid setup / all labeled findings`.

## Ethical Boundaries

Local static analysis of public repositories is acceptable research practice.
Do not publish a named shame table. Do not file automated issues against target
repositories. If a real upstream bug is found, report it manually and narrowly.

## Relationship To Stronger Evidence

The corpus precision study answers "does CellFence flag real repository states
with tolerable false-positive pressure?"

History replay asks a stronger question: "Would CellFence have stopped a real
boundary break at the commit where it was introduced?"

Agent A/B asks the product question: "With the same repository and task, do
agents produce fewer boundary violations under CellFence, and what friction does
the fence add?"

Use all three. Corpus precision earns detector trust; history replay earns
counterfactual credibility; agent A/B measures the claim that the tool changes
agent behavior.

The first frozen onboarding pilot is recorded in
`docs/research/ts-js-workspace-pilot-2026-07-18.md`.
