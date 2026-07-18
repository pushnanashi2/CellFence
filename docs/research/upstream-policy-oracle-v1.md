# Upstream Policy Oracle v1

This study treats existing upstream package/workspace policy as a reference oracle for CellFence onboarding mechanics. It is not a claim that CellFence has discovered the true architecture of a project, and it is not a crawler. The harness clones only the repositories listed in a fixed corpus, checks out exact commits, does not run package installs, and does not write to the subject checkout.

## Claim Under Test

The measurable claim is:

> CellFence can turn blind manifest inference gaps into deterministic policy questions, attach manifest patches to those questions, answer them from upstream-declared reference policy, and improve manifest agreement after applying the answers.

This is different from proving that a third-party maintainer can complete onboarding quickly. That user-experience claim needs real users. The oracle study measures the step before that: whether the tool can express the missing design decisions in a reviewable, patchable form.

## Inputs

The v1 corpus lives at `docs/research/upstream-policy-oracle-v1/corpus.json`.

The first five-repository pilot is summarized in `docs/research/upstream-policy-oracle-v1-pilot-2026-07-18.md`.

Each subject must provide:

```json
{
  "id": "example-project",
  "repository": "https://github.com/example/project.git",
  "commit": "0123456789abcdef0123456789abcdef01234567",
  "policy": {
    "strategy": "package-workspaces",
    "packageRoot": ".",
    "scope": "production"
  }
}
```

`commit` must be an exact 40-hex SHA unless an exploratory run explicitly uses `--allow-floating-ref`.

## Method

For each subject, the harness:

1. Clones the repository and checks out the exact commit.
2. Builds a reference CellFence manifest from upstream `package.json` workspaces, package names, package entry fields, `exports`, and workspace dependency declarations.
3. Runs CellFence blind inference with `policyHints: "ignore"`, so package `exports` and dependency declarations are not used by the inferred manifest.
4. Compares the inferred manifest against the reference manifest.
5. Generates deterministic policy questions for missing or extra cell boundaries, consumer edges, and public entries.
6. Answers those questions from the reference manifest and applies their manifest patches.
7. Re-computes agreement after the oracle answers.
8. Emits planned mutation cases for accepted public imports and rejected private imports.

The harness records package policy source hashes for provenance. It does not install dependencies, run test scripts, open issues, create pull requests, or claim that findings are upstream defects.

## Artifacts

By default, `npm run research:oracle -- --clone-mode shallow --discard-checkouts` writes:

```text
reports/upstream-policy-oracle-v1/
  corpus.json
  references/
  provenance/
  inferred/
  questions/
  oracle-answers/
  resolved-manifests/
  mutations/
  report.json
```

`questions/*.json` is the core product evidence. Every question includes a `decisionKey`, affected finding count, evidence, choices, and a manifest patch. The patch is the bridge from noisy observations to a reviewable governance change.

## Metrics

The report includes:

- file ownership agreement against reference-owned files;
- cell id precision and recall;
- public entry exact match rate;
- consumer edge precision and recall;
- raw CellFence findings on the blind inferred manifest;
- policy question count;
- compression ratio from raw findings to questions;
- oracle-resolvable question count;
- before/after agreement after oracle answers;
- planned mutation count.

The precision wording is intentionally scoped. This run can say that CellFence moved closer to upstream-declared policy after deterministic questions were answered. It cannot say that every upstream policy is correct, that every CellFence finding is a true positive, or that onboarding time has been proven.

## Running

```sh
npm run build
npm run research:oracle -- --clone-mode shallow --discard-checkouts
```

For a small local check:

```sh
npm run research:oracle -- --max-subjects 1 --clone-mode shallow --discard-checkouts
```

The command exits non-zero only when a subject fails to clone, checkout, build a reference policy, or complete the oracle pass.
