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

Do not collapse every result into a single "CellFence precision" percentage.
The public claim must name the layer being measured:

| Layer | What it can prove | Appropriate evidence |
| --- | --- | --- |
| Policy conformance | A finding violates the reviewed manifest semantics. | Formal rule spec, proof witnesses, structural evidence graph verification, and an independent rule verifier. |
| Frontend correctness | Imports, ownership, resolution, and public surface extraction are correct. | Conformance, property, and differential tests. |
| Blocking precision | A blocking finding should have failed CI in a real repository. | Sealed holdout corpus, independent labels, statistical lower bound. |

The first external claim should stay narrow:

> For reviewed TS/JS manifests and the `CELLFENCE_PRIVATE_IMPORT` and
> `CELLFENCE_UNDECLARED_CONSUMER` blocking rules, CellFence `<commit>` reached
> the pre-registered one-sided 95% lower confidence bound for blocking
> precision.

Resource rules, Python framework adapters, inferred manifests, and public
surface drift should be reported as separate studies until they have their own
reviewed manifests, labels, and recall evidence.

Before a corpus can feed a blocking-precision claim, validate that it is a
reviewed-manifest corpus:

```bash
npm run research:reviewed-corpus -- \
  --corpus docs/research/corpora/ts-js-blocking-reviewed.json \
  --out reports/corpus/ts-js-blocking-reviewed.corpus-validation.json
```

For an external public claim, require review attestations that bind independent
human or organization reviewers to the exact copied manifest hash:

```bash
npm run research:reviewed-corpus -- \
  --corpus docs/research/corpora/ts-js-blocking-reviewed.json \
  --external-claim \
  --out reports/corpus/ts-js-blocking-reviewed.external-validation.json
```

Each precision-eligible copied manifest should include `review.reviewedAt`,
`review.scope`, `review.reviewedManifestSha256`, and
`review.reviewerAttestations` entries with `id`, `reviewerType`, and
`independent: true`. Agent-reviewed manifests remain useful for diagnostics,
but do not satisfy the default external-claim bar. The final claim protocol
should also set `manifestReviewPlan.requireExternalAttestations: true`, so the
claim evaluator independently checks the sealed bundle's copied manifest hash
against the review attestation.

This intentionally rejects `manifest.strategy: infer` corpora. Infer runs are
still valuable for onboarding, robustness, and tuning, but their findings are
not treated as evidence of real repository defects until the manifest is
reviewed and frozen.

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

For larger onboarding runs where disk is the limiting factor, use shallow clones
and discard subject checkouts after each check:

```bash
npm run research:corpus -- \
  --corpus docs/research/corpora/oss-ts-js-200-2026-07-18.json \
  --out reports/corpus/oss-ts-js-200-2026-07-18.json \
  --workdir tmp/corpus-precision-study-200 \
  --clone-mode shallow \
  --discard-checkouts
```

For unreviewed `infer` onboarding studies, use production scope when the goal is
to tune manifest inference rather than count every test, fixture, generated
file, vendored file, or asset import:

```bash
npm run research:corpus -- \
  --corpus docs/research/corpora/oss-ts-js-200-2026-07-18.json \
  --out reports/corpus/oss-ts-js-200-2026-07-18.production-scope.json \
  --workdir tmp/corpus-precision-study-200-production \
  --clone-mode shallow \
  --discard-checkouts \
  --infer-scope production
```

The same harness is used for Python onboarding evidence. The first frozen Python
pilot is documented in
[oss-python-10-2026-07-18.md](oss-python-10-2026-07-18.md):

```bash
npm run research:corpus -- \
  --corpus docs/research/corpora/oss-python-10-2026-07-18.json \
  --out reports/corpus/oss-python-10-2026-07-18.json \
  --workdir tmp/corpus-python-10-2026-07-18 \
  --clone-mode shallow \
  --discard-checkouts \
  --infer-scope production
```

The larger Django, FastAPI, SQLAlchemy, and Celery topic run is documented in
[oss-python-framework-800-2026-07-18.md](oss-python-framework-800-2026-07-18.md).

The first reviewed-manifest TS/JS precision pilot is documented in
[ts-js-reviewed-pilot-10-2026-07-19.md](ts-js-reviewed-pilot-10-2026-07-19.md).
It is a pipeline and diagnosis artifact, not a public precision claim: the
preliminary labels exposed package subpath export, resolver, and scope hygiene
work that must be fixed before an external precision number is defensible.
The round2 rerun is documented in
[ts-js-reviewed-pilot-10-2026-07-19-round2.md](ts-js-reviewed-pilot-10-2026-07-19-round2.md):
it reduces the same frozen corpus from 2406 raw findings to 89, but still
reports `insufficient_evidence` because preliminary labels identify resource
detector, generated-artifact, and internal package-policy blockers.
The round3 diagnostic rerun is documented in
[ts-js-reviewed-pilot-10-2026-07-19-round3.md](ts-js-reviewed-pilot-10-2026-07-19-round3.md):
it narrows the concrete resource detector false positives and reduces raw
findings from 89 to 75 while leaving generated artifacts and internal wiring as
explicit decision-required evidence.
The round4 diagnostic rerun is documented in
[ts-js-reviewed-pilot-10-2026-07-19-round4.md](ts-js-reviewed-pilot-10-2026-07-19-round4.md):
it adds explicit package-export resolution states and method-name-only
HTTP/queue near-miss guards while preserving the round3 raw finding count.
The round5 diagnostic rerun is documented in
[ts-js-reviewed-pilot-10-2026-07-19-round5.md](ts-js-reviewed-pilot-10-2026-07-19-round5.md):
it adds Node fs import/require provenance and package exports null/shorthand
semantics while preserving the round4 raw finding count.
The round6 diagnostic rerun is documented in
[ts-js-reviewed-pilot-10-2026-07-19-round6.md](ts-js-reviewed-pilot-10-2026-07-19-round6.md):
it closes second-pass review gaps for scoped fs bindings, fs namespace aliases,
wildcard export specificity, package target array fallback, and exact package
import state propagation while preserving the round4/round5 raw finding count.
The round7 diagnostic rerun is documented in
[ts-js-reviewed-pilot-10-2026-07-19-round7.md](ts-js-reviewed-pilot-10-2026-07-19-round7.md):
it closes the final scoped fs leakage and array-wrapped null export gaps while
preserving the round4-round6 raw finding count.
The round8 diagnostic rerun is documented in
[ts-js-reviewed-pilot-10-2026-07-19-round8.md](ts-js-reviewed-pilot-10-2026-07-19-round8.md):
it adds inline fs require support while preserving the round4-round7 raw
finding count.
The round9 diagnostic rerun is documented in
[ts-js-reviewed-pilot-10-2026-07-20-round9.md](ts-js-reviewed-pilot-10-2026-07-20-round9.md):
it preserves the round8 finding count and hardens the evidence bundle, blind
labeling, and claim gates so a small or malformed sample cannot be reported as a
99% precision result.
The round14 diagnostic rerun is documented in
[ts-js-reviewed-pilot-10-2026-07-20-round14.md](ts-js-reviewed-pilot-10-2026-07-20-round14.md):
it carries labels forward by stable finding ID, records agent rater provenance,
adds supplemental blind labels for newly surfaced Remix resource findings, and
keeps the 99% claim blocked as `insufficient_evidence` rather than `invalid`.

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

With `--discard-checkouts`, the subject checkout directory is removed after the
run while command logs, audit logs, and control manifests remain.

`--infer-scope production` only affects `manifest.strategy: infer` subjects. It
runs `cellfence init --production-scope`, records the effective scope in the
report, and writes research-friendly `governance.exclude` patterns for tests,
fixtures, examples, generated output, build output, vendored code, styles, and
common static assets. It does not relax required rules for production source
that remains in scope.

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

Run the local evidence-pipeline smoke before publishing or sharing a corpus
claim:

```bash
npm run precision:pipeline:smoke
```

The smoke builds a tiny local corpus report, freezes an evidence bundle, injects
two independent labels for each sampled finding, validates checksums, and runs
`corpus-precision-claim`. The expected claim decision is
`insufficient_evidence`: the sample is deliberately too small for a 99% lower
bound. A passing smoke proves the bundle, labeling, and claim machinery is wired;
it is not public-OSS precision evidence.

Run the evidence graph structural smoke before using graph artifacts as witness
inputs:

```bash
npm run evidence:graph:smoke
```

The verifier rejects malformed graph shape, dangling references, missing finding
witnesses, and missing file anchors. It is documented in
[evidence-graph-verifier.md](evidence-graph-verifier.md). Passing it means the
artifact is structurally usable; it is not a formal policy proof.

For corpus studies that should produce independently checkable witness
artifacts, enable graph verification during the run:

```bash
npm run research:corpus -- \
  --corpus docs/research/corpora/ts-js-blocking-reviewed.json \
  --out reports/corpus/ts-js-blocking-reviewed.json \
  --workdir tmp/corpus-ts-js-blocking-reviewed \
  --verify-evidence-graphs
```

Each successful subject writes `logs/evidence-graph.json` and
`logs/evidence-graph-verifier.json`. The verifier is a separate Node process
over the serialized graph; a missing or rejected graph makes the corpus harness
fail.

After a corpus run, freeze the evidence bundle before labeling:

```bash
npm run research:bundle -- \
  --study-id ts-js-workspace-pilot-2026-07-18 \
  --corpus docs/research/corpora/ts-js-workspace-pilot-10.json \
  --report reports/corpus/ts-js-workspace-pilot-10.nondestructive.json \
  --out-dir reports/corpus/ts-js-workspace-pilot-2026-07-18-bundle
```

Record the pre-label artifact set before any labels are written. This digest is
stored in `study.preregistration.preLabelArtifactSetSha256`; it is recomputed
from corpus, report, findings, sampling, manifests, and logs, excluding
`labels.jsonl`, `study.json`, and `SHA256SUMS`:

```bash
node -e 'const fs=require("fs"); const s=JSON.parse(fs.readFileSync("reports/corpus/ts-js-workspace-pilot-2026-07-18-bundle/study.json","utf8")); console.log(s.preregistration.preLabelArtifactSetSha256)'
```

When rebuilding the labeled bundle, pass that digest back into the bundle so the
final artifact records the pre-label registration boundary:

```bash
npm run research:bundle -- \
  --study-id ts-js-workspace-pilot-2026-07-18 \
  --corpus docs/research/corpora/ts-js-workspace-pilot-10.json \
  --report reports/corpus/ts-js-workspace-pilot-10.nondestructive.json \
  --labels docs/research/labels/ts-js-workspace-pilot.labels.jsonl \
  --prelabel-artifact-set-sha256 <pre-label-artifact-set-sha256> \
  --out-dir reports/corpus/ts-js-workspace-pilot-2026-07-18-labeled-bundle
```

Validate an existing bundle with:

```bash
npm run research:bundle -- --validate --bundle reports/corpus/ts-js-workspace-pilot-2026-07-18-bundle
```

Before running the statistical claim evaluator, validate label readiness:

```bash
npm run precision:labels:validate -- \
  --bundle reports/corpus/ts-js-workspace-pilot-2026-07-18-bundle \
  --out reports/corpus/ts-js-workspace-pilot-2026-07-18-label-readiness.json
```

The label readiness gate requires the sampled precision-eligible findings to
have exactly one `blind_first` and one `blind_second` independent label from
separate raters. Independent label rows must declare `assignmentId`,
`evidencePackageId`, and `sawPeerLabels: false`. If independent labels
disagree, a separate adjudicator must resolve the final label with
`round: "adjudication"`; adjudication by an independent rater, missing
adjudication for a disagreement, or adjudication after unanimous independent
labels is rejected. This gate only checks the labeling process;
`corpus-precision-claim` still decides whether the labeled sample supports a
pre-registered precision claim.

When rerunning a fixed corpus, transfer existing labels by stable finding ID and
record any newly sampled findings for supplemental labeling:

```bash
npm run precision:labels:transfer -- \
  --source-bundle reports/corpus/ts-js-confirmation-v1-labeled-bundle \
  --target-bundle reports/corpus/ts-js-confirmation-v2-bundle \
  --out docs/research/labels/ts-js-confirmation-v2.labels.jsonl \
  --report reports/corpus/ts-js-confirmation-v2-label-transfer.json
```

Use `--allow-partial` only for an intermediate worklist. A claim-eligible label
file should transfer or supplement every sampled precision-eligible finding.
If the source labels predate rater-provenance metadata, add a declared default
with `--default-rater-type agent` or backfill the actual human or organization
types before running the claim protocol.

Rater provenance can also be enforced at validation time:

```bash
npm run precision:labels:validate -- \
  --bundle reports/corpus/ts-js-confirmation-v2-labeled-bundle \
  --allowed-rater-types human,organization \
  --require-known-rater-type \
  --disallow-non-human-raters
```

Agent-only labels may be pre-registered for diagnostic studies by allowing
`agent` in the protocol. They should not be described as human-reviewed
external confirmation evidence.

Run the claim preflight before spending reviewer time or before invoking the
final claim evaluator:

```bash
npm run precision:claim:preflight -- \
  --bundle reports/corpus/ts-js-workspace-pilot-2026-07-18-bundle \
  --protocol docs/research/protocols/ts-js-confirmation-v1.json \
  --out reports/corpus/ts-js-confirmation-v1-preflight.json
```

The preflight can run before labeling. It reports the protocol-selected
findings, per-rule sample deficits, repository concentration, dirty harness
state, missing independent labels, and whether any labels appear to be
agent-only. Exit code `0` means the bundle is ready to attempt the claim. Exit
code `1` means the bundle is well-formed but underpowered, unbalanced, or
incompletely labeled. Exit code `2` means the protocol and bundle do not match,
the labeling provenance violates protocol, manifest review provenance is not
hash-bound, or the inputs are malformed. A preflight failure is not a detector
failure; it is the guardrail that prevents a small tuning corpus from being
presented as a 99% precision result.

The bundle contains:

- `study.json`, `corpus.json`, and `report.json`;
- `findings.raw.jsonl` copied from CellFence audit events;
- `findings.normalized.jsonl` with stable `findingId` values derived from
  `subjectId + commit + manifestSha256 + ruleId + fingerprint`, plus a stable
  occurrence index when the same audit fingerprint is emitted more than once;
- `findings.sampled.jsonl` and `sampling.json`;
- copied manifests under `manifests/` and command/audit logs under `logs/`;
- `labels.jsonl` and `SHA256SUMS`.

The validator rejects unknown `findingId` references, duplicate
`rater/findingId` labels, unknown label values, missing rationales, unsorted
normalized findings, manifest hash mismatches, missing audit logs for claimed
findings, audit-log/report finding count mismatches, and SHA-256 mismatches.
`findings.raw.jsonl` is derived from rejected CellFence audit findings; warnings
remain in the subject logs and evidence graphs, but they are not part of the
blocking-precision denominator.

Sampling is deterministic. The default per-rule cap is power-based rather than
a fixed "50 findings per rule" shortcut: it uses the zero-false-positive sample
size required for a one-sided 95% lower bound of 99% precision. That is 299
labeled findings per rule when enough findings exist. If a different threshold
is desired, pre-register it and pass matching `--minimum-precision`,
`--confidence`, or `--per-rule-cap` values when building the bundle.

## Claim Evaluation Gates

`corpus-precision-claim` is deliberately harder to pass than a pooled
occurrence precision calculation. A claim protocol must pre-register
`claim.toolCommit`, `claim.preLabelArtifactSetSha256`,
`claim.artifactSetSha256`, included rules, target precision, confidence,
blocking severities, and repository contribution limit. The pre-label digest
binds the corpus, report, findings, sampling, manifests, and logs before
labeling, excluding mutable labeling and bundle metadata files; the final
artifact digest binds the labeled bundle. The claim
evaluator recomputes every bundle file listed in `SHA256SUMS`; changing
`labels.jsonl`, `study.json`, sampled findings, manifests, or logs after sealing
makes the claim invalid even if `SHA256SUMS` itself is unchanged.

A `pass` decision requires all of these to meet the requested threshold:

- pooled blocking occurrence lower bound;
- unique-fingerprint lower bound, with duplicated occurrences collapsed by
  subject, rule, and CellFence fingerprint;
- every included rule's lower bound;
- repository macro observed precision;
- every repository's observed blocking precision;
- no design warnings, including excessive single-repository contribution.

If any gate fails, the result is `insufficient_evidence` when the evidence is
well-formed, or `invalid` when the protocol, bundle, hashing, or label process
is malformed. This is intentional: a small or skewed perfect sample must not be
reported as 99% precision.

For example, the default bundle sampling plan is equivalent to:

```bash
npm run research:bundle -- \
  --study-id ts-js-confirmation-v1 \
  --corpus docs/research/corpora/ts-js-confirmation-v1.json \
  --report reports/corpus/ts-js-confirmation-v1.json \
  --out-dir reports/corpus/ts-js-confirmation-v1-bundle \
  --minimum-precision 0.99 \
  --confidence 0.95
```

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
against the checkout. A corpus may set `manifest.scope: "production"` per
subject, or the harness may pass `--infer-scope production` globally, to add
research-friendly production excludes. This is useful for onboarding friction,
but it is not a precision study until the generated manifest is reviewed or
compared against existing boundary configuration. The generated manifest is
stored outside the target checkout, custom manifest paths are rejected for this
strategy, and the harness fails the subject if manifest preparation leaves the
checkout dirty.

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
Use a predeclared sampling rule derived from the precision lower bound you want
to claim. If a rule has fewer sampled findings than the required sample size,
the correct result is `insufficient_evidence`, not "precision failed".

Allowed bundle labels are `true_positive`, `false_positive`, `needs_policy`,
`needs_review`, `invalid_setup`, and `out_of_scope`. Every label row must include
`findingId`, `rater`, `label`, and `rationale`.

Confirmation studies require at least two independent labels per included
finding. If the independent raters disagree, add an adjudication row with
`"role": "adjudicator"`. The adjudicator must be distinct from the independent
raters. Do not drop `needs_review` from the denominator; count it as a
blocking failure until adjudication resolves it.

`manifest.strategy: infer` findings may be labeled for tuning and onboarding
friction, but they are excluded from precision denominators. Precision
denominators are limited to findings from `existing` manifests or `copy`
manifests whose translation has been reviewed and recorded as `reviewed`.

Report at least:

- semantic correctness: `(true positive + needs policy) / (true positive + false positive + needs policy + needs review)`;
- blocking precision: `true positive / (true positive + false positive + needs policy + needs review)`;
- translation error rate: `invalid setup / all labeled findings`.

## Precision Claim Reports

Before looking at confirmation results, write a protocol file:

```json
{
  "schemaVersion": "cellfence.precision-claim-protocol.v1",
  "studyId": "ts-js-confirmation-v1",
  "claim": {
    "toolCommit": "0123456789abcdef0123456789abcdef01234567",
    "targetPopulation": "reviewed TS/JS workspace repositories",
    "supportedSyntaxProfile": "ts-js-supported-v1",
    "includedRules": [
      "CELLFENCE_PRIVATE_IMPORT",
      "CELLFENCE_UNDECLARED_CONSUMER"
    ],
    "primaryMetric": "blocking_precision",
    "minimumPrecision": 0.99,
    "confidence": 0.95
  },
  "samplingPlan": {
    "maxRepositoryContribution": 0.1
  },
  "labelingPlan": {
    "minimumIndependentRaters": 2,
    "requireAdjudicationForDisagreements": true
  },
  "manifestReviewPlan": {
    "requireExternalAttestations": true,
    "allowedReviewerTypes": ["human", "organization"]
  },
  "exclusionRules": []
}
```

Then evaluate the labeled bundle:

```bash
npm run research:claim -- \
  --bundle reports/corpus/ts-js-confirmation-v1-bundle \
  --protocol docs/research/protocols/ts-js-confirmation-v1.json \
  --out reports/corpus/ts-js-confirmation-v1-claim.json
```

The claim verifier reports occurrence precision, unique-fingerprint precision,
rule-level precision, repository macro precision, repository contribution, and
leave-one-repository-out sensitivity. Exit code `0` means the pre-registered
claim passes. Exit code `1` means the labels are usable but the evidence is
underpowered or biased by repository concentration. Exit code `2` means the
protocol, bundle, or labeling procedure is invalid.

For an exact binomial lower bound, 50 perfect labels only support a one-sided
95% lower bound of about 94.2%. A 99% lower-bound claim needs at least 299
independent labeled trials with zero blocking failures, and more if there are
any false positives, `needs_policy`, or `needs_review` labels.

The verifier is intentionally conservative. It does not treat unreviewed
`infer` manifests as detector precision evidence, does not let one repository
dominate the denominator by default, and does not treat `needs_policy` as a
blocking success even though it counts toward semantic correctness.

## Ethical Boundaries

Local static analysis of public repositories is acceptable research practice.
Do not publish a named shame table. Do not file automated issues against target
repositories. If a real upstream bug is found, report it manually and narrowly.

## Relationship To Stronger Evidence

The corpus precision study answers "does CellFence flag real repository states
with tolerable false-positive pressure?"

History replay asks a stronger question: "Would CellFence have produced a new
blocking fingerprint at the commit where a boundary break was introduced?" The
dedicated protocol is [history-replay-study.md](history-replay-study.md).

Agent A/B asks the product question: "With the same repository and task, do
agents produce fewer boundary violations under CellFence, and what friction does
the fence add?"

Use all three. Corpus precision earns detector trust; history replay earns
counterfactual credibility; agent A/B measures the claim that the tool changes
agent behavior.

The first frozen onboarding pilot is recorded in
`docs/research/ts-js-workspace-pilot-2026-07-18.md`.
