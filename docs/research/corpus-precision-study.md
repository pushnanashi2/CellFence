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

- clones each repository into `tmp/corpus-precision-study/`;
- checks out the exact commit;
- prepares the manifest by `existing`, `copy`, or `infer` strategy;
- runs `cellfence check --json`;
- writes command logs under each subject directory;
- writes a summary JSON report under `reports/`.

It does not install dependencies or execute target repository package scripts.
If a separate experiment needs package installation, use an isolated runner and
`npm ci --ignore-scripts` unless the experiment explicitly studies runtime
install behavior.

Exploratory runs may pass `--allow-floating-ref`, but those results are not
eligible for external claims.

Use `--dry-run` to validate the frozen corpus manifest and produce a planned
report without cloning repositories.

## Manifest Strategies

`existing` uses a manifest already present in the target repository. This is the
cleanest strategy for CellFence's own dogfood and future adopters.

`copy` copies a checked manifest from the corpus directory into the checkout.
Use this when comparing against an existing boundary tool and preserving the
reviewed CellFence translation next to the corpus manifest.

`infer` runs `cellfence init` inside the checkout. This is useful for onboarding
friction, but it is not a precision study until the generated manifest is
reviewed or compared against existing boundary configuration.

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
