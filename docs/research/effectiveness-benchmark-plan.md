# CellFence Effectiveness Benchmark Plan

CellFence research must measure usefulness, not only frequency. A Git mining
pass can show that governance pressure exists, but it cannot prove that a rule
blocks the right changes with acceptable friction.

## Benchmark Shape

1. Freeze a small corpus.
   - Use 20 to 40 repositories.
   - Pin every repository by exact commit SHA or release tag.
   - Store the corpus manifest as the reproducibility root.
   - Run the failure-inclusive onboarding/check harness in
     `docs/research/corpus-precision-study.md`.

2. Label events.
   - Extract candidate events such as public surface changes, cross-cell moves,
     workflow control changes, baseline changes, and protected path changes.
   - Label each event as:
     - positive: a boundary break CellFence should stop;
     - negative: a legitimate reviewed change CellFence should not block, or
       should route through an explicit approval path.
   - Prefer Git evidence for labels: reviewed PRs, reverts, follow-up bugfixes,
     reviewer discussion, or release notes.

3. Score detectors.
   - Report precision and recall per rule family.
   - Track false-positive examples as fixtures.
   - Track false-negative examples as detector backlog.

4. Score friction.
   - For negative events, record whether CellFence would stop the change.
   - Report friction rate separately from precision/recall.
   - A detector can be precise and still operationally expensive if it blocks
     too many legitimate changes.

5. Publish the table per release.
   - Every detector change must show whether precision, recall, and friction
     improved or regressed.
   - A one-off study becomes useful only when it turns into a regression
     benchmark.

## Ratchet Bypass A/B Study

`cellfence-friction-study/` contains a deterministic harness for one focused
question: whether exposing next accepted baseline material in ratchet errors increases
baseline hand-edit bypasses.

That study is intentionally narrower than the full benchmark. It measures agent
behavior after ratchet friction, while the benchmark above measures whether the
ratchet should have fired at all.

## Claims This Plan Allows

Allowed:

- "Rule family X has measured precision/recall on this frozen corpus."
- "Change Y reduced bypass rate in the ratchet friction study."
- "This release reduced false positives for detector Z against the frozen
  fixtures."

Not allowed:

- "CellFence is market-validated" from broad keyword mining alone.
- "Large OSS adoption pressure is proven" from repository names or star counts.
- "A rule is useful" before positive/negative labels exist.
