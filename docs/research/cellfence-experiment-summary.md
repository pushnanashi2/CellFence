# CellFence experiment summary

Generated: 2026-07-17
CellFence snapshot: `0.1.11`, repository commit `e8353a829954`

This document summarizes the experiments used to shape the current CellFence roadmap. It is intended as a handoff document for another reviewer or model.

Important wording:

- `version` means the exact evidence available for the run: release tag when a retained clone had one, otherwise default branch plus analyzed commit SHA.
- The broad 2,800 repository pass is a candidate radar, not a market-size proof.
- The diff-backed and semantic-detector passes are stronger evidence for rule design because they inspect Git deltas.

## 1. What Was Run

| experiment | corpus | method | main purpose | strength |
|---|---:|---|---|---|
| Stratified refactor mining | 2,800 repositories | commit-message and keyword-conditioned mining | find repeated change pressure across repository types | broad, noisy radar |
| Local diff event pilot | CellFence plus Cash-derived lineages | `git diff-tree` and path/status analysis | map Cash-derived ideas to generic Git events | direct delta evidence, small corpus |
| Diff-backed market study | 200 attempted repositories, 190 usable | cloned repositories, recent non-merge commits, path/status diff, targeted hunk checks | validate that candidate rule families appear outside Cash | medium-strength roadmap evidence |
| Semantic event detector v3.2 | same 190 usable repositories | semantic extraction for workflow controls, action references, entrypoint exports, boundary moves | freeze detector behavior and reduce false positives | strongest detector-quality evidence so far |

## 2. Broad Stratified Mining

Source artifacts:

- `cellfence-research-stratified-fast/out/consolidated-stratified-refactor-report.md`
- `cellfence-research-stratified-fast/out/summary.json`
- `cellfence-research-stratified-fast/out/strict-summary.json`

Corpus:

| bucket | target repos | usable repos | failed repos | commits counted | keyword matches |
|---|---:|---:|---:|---:|---:|
| large OSS | 300 | 297 | 3 | 5,063,195 | 1,070,102 |
| monorepo | 500 | 499 | 1 | 528,820 | 130,163 |
| AI or agent repos | 500 | 499 | 1 | 2,042,489 | 355,197 |
| public random stream | 1,500 | 1,398 | 102 | 974,652 | 173,162 |
| total | 2,800 | 2,693 | 107 | 8,609,156 | 1,728,624 |

Strict category hits from this pass:

| candidate signal | commits | repositories |
|---|---:|---:|
| cell completeness | 443 | 164 |
| forbidden peer roots | 24,276 | 614 |
| approval-required paths | 8,044 | 483 |
| compatibility wrapper thinness | 55,175 | 758 |
| agent attempt ledger | 50,815 | 811 |
| branch identity guard | 1,364 | 264 |
| control-plane failure is fatal | 8,186 | 556 |
| feature survival ledger | 15,983 | 562 |
| baseline ratchet | 6,707 | 446 |
| boundary and ownership | 5,430 | 458 |

Interpretation:

- The broad pass is useful for prioritization: these topics recur across repository classes.
- It does not prove exact prevalence because the detector is keyword-conditioned.
- It did justify moving several Cash-derived governance ideas into a more generic CellFence design vocabulary.

## 3. Diff-Backed Market Study

Source artifacts:

- `cellfence-research-stratified-fast/out/diff-backed-market-study.md`
- `cellfence-research-stratified-fast/out/diff-backed-market-study.json`
- `cellfence-research-stratified-fast/out/diff-backed-market-study-precision-sample.jsonl`

Run shape:

| bucket | attempted | usable |
|---|---:|---:|
| large OSS | 25 | 25 |
| monorepo | 50 | 50 |
| AI or agent repos | 50 | 50 |
| random stream | 75 | 65 |
| total | 200 | 190 |

The run analyzed 11,971 non-merge commits across 190 repositories.

Event counts:

| event | repositories | repo rate | commits | CellFence implication |
|---|---:|---:|---:|---|
| protected path change | 132 | 69.5% | 2,513 | `protectedPaths` / approval-required paths |
| control-plane failure trace | 107 | 56.3% | 1,259 | gate failure should stop downstream generation |
| public surface change | 93 | 48.9% | 773 | public surface hash / declaration ratchet |
| compatibility or wrapper trace | 69 | 36.3% | 311 | wrapper thinness rule |
| agent attempt or branch trace | 65 | 34.2% | 293 | attempt ledger and branch identity guard |
| test weakening | 52 | 27.4% | 399 | test weakening detector |
| baseline or threshold change | 45 | 23.7% | 285 | baseline / threshold ratchet |
| cross-boundary move or copy | 17 | 8.9% | 32 | cross-cell move detector |
| new top-level or workspace root | 10 | 5.3% | 56 | cell completeness and unowned source |
| baseline-only commit | 7 | 3.7% | 23 | baseline-only commit guard |
| source/runtime mixed commit | 4 | 2.1% | 64 | source/runtime boundary policy |

Interpretation:

- This is the first pass that can be used as external-facing support for the claim that these change pressures are not Cash-only.
- It is still a pilot: 190 usable repositories and recent commit windows are enough for rule prioritization, not a final market-size claim.

## 4. Semantic Detector v3.2

Source artifacts:

- `cellfence-research-stratified-fast/out/semantic-event-detector-pilot-v32.md`
- `cellfence-research-stratified-fast/out/semantic-event-detector-pilot-v32.json`
- `cellfence-research-stratified-fast/out/semantic-event-detector-pilot-v32-precision-sample.jsonl`
- `tests/fixtures/semantic-event-detector-v32/freeze-summary.json`

Run shape:

| item | count |
|---|---:|
| attempted repositories | 200 |
| usable repositories | 190 |
| failed repositories | 10 |
| non-merge commits analyzed | 11,987 |
| recent-head lineage clusters | 190 |

Semantic event counts:

| event | repositories | repo rate | commits |
|---|---:|---:|---:|
| cross-boundary source rename | 11 | 5.8% | 24 |
| workflow and governance control event | 71 | 37.4% | 325 |
| workflow action reference change | 69 | 36.3% | 316 |
| entrypoint export declaration change | 42 | 22.1% | 178 |
| threshold decrease | 0 | 0.0% | 0 |

Detector-quality result:

- v3.2 froze the detector after removing comparable false-positive tombstones.
- Comparable control tombstones: 113 total, 113 removed false positives, 0 removed true positives.
- Comparable event tombstones: 22 total, 22 removed false positives, 0 removed true positives.
- Window-drift rows were excluded from recall-regression denominators.
- Frozen regression fixtures cover workflow deletion and suppression replacement.

Interpretation:

- v3.2 is acceptable as a detector-validation baseline.
- It is not a claim of full GitHub Actions coverage.
- `threshold_decrease` remains unproven because the v3.2 corpus produced no positive examples.

## 5. Version Evidence Policy

This report no longer uses repository fame or star counts as validation
evidence. A prominent repository name proves only that the mining script saw a
well-known project, not that a CellFence rule is useful.

For external claims, the next benchmark must freeze each repository by exact Git
commit SHA or release tag, retain the corpus manifest, and label positive and
negative events against those frozen commits. The broad and diff-backed runs
remain useful roadmap inputs, but they are not a substitute for a labeled
precision/recall benchmark.

The retained research artifacts still contain individual repository examples
and commit SHAs where available. Those examples should be treated as traceability
for the pilot, not as a ranked or market-size claim.

## 6. What CellFence Absorbed From These Experiments

Implemented or frozen in CellFence after the experiments:

| outcome | CellFence form | evidence source |
|---|---|---|
| Cross-boundary moves should be first-class, not inferred from imports only | `CELLFENCE_CROSS_CELL_MOVE` | diff-backed and v3.2 semantic detector |
| Workflow and governance controls need semantic comparison | v3.2 semantic detector fixtures and docs | v3.2 precision and tombstone review |
| Entrypoint/public declarations should be tracked as contract surface | entrypoint declaration detector and public surface roadmap | diff-backed public surface changes |
| Protected path changes should require explicit policy | `protectedPaths` / approval-required path model | diff-backed protected-path prevalence |
| Baseline-only and baseline/threshold changes should be suspicious | baseline audit and threshold-change detector roadmap | diff-backed baseline events |
| Source/runtime mixed commits need policy support | path-class and source/runtime boundary model | diff-backed source/runtime events |
| Agent loop changes need branch and attempt identity | task/claim and run-attempt ledger roadmap | broad and diff-backed agent traces |
| Compatibility wrappers should stay thin | wrapper thinness rule candidate | broad and diff-backed compatibility traces |
| Language support should not be hardwired to TS/JS only | Python boundary support started and expanded | follow-on language strategy, not the market pass itself |

## 7. What Is Not Proven Yet

- The broad 2,800 repository pass does not prove market size. It proves candidate signals are easy to find and worth deeper inspection.
- The 190-repository diff-backed pass is enough for roadmap prioritization, but still a pilot.
- `threshold_decrease` has no positive v3.2 examples and should not be marketed as validated.
- The study does not validate every ORM, HTTP, queue, or runtime-evidence adapter. Those require adapter-specific corpora.
- The current famous-OSS list is a sampled set, not an exhaustive benchmark suite.
- “Version” is not uniformly a release version. Most rows are tied to a default branch and commit SHA.

## 8. Recommended Next Step

The strongest next validation is a small, repeatable benchmark suite. The
protocol is defined in `docs/research/effectiveness-benchmark-plan.md`:

1. Freeze 20 to 40 repository snapshots with exact commit SHAs.
2. Label a balanced sample of positive and negative events for each rule family.
3. Track precision and recall per detector.
4. Track friction rate for legitimate changes.
5. Publish the corpus manifest and detector score table with each CellFence release.

That would turn the current pilot into a repeatable benchmark rather than a one-off research run.

For ratchet-specific operator behavior, use `cellfence-friction-study/` to
measure whether a ratchet error causes a subject agent to take the reviewed
baseline update path or a bypass path such as hand-editing the baseline.
