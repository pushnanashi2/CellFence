# Semantic Event Detector v3.2 Freeze Record

Status: frozen
Date: 2026-07-17

## Input Run

| metric | value |
|---|---:|
| attempted repositories | 200 |
| OK repositories | 190 |
| failed repositories | 10 |
| non-merge commits analyzed | 11,987 |
| recent-head lineage clusters | 190 |

## Comparable Tombstones

| group | total | REMOVED_FP | REMOVED_TP | UNCLEAR |
|---|---:|---:|---:|---:|
| controls | 113 | 113 | 0 | 0 |
| events | 22 | 22 | 0 | 0 |

Comparable control tombstones by kind:

| kind | count | verdict |
|---|---:|---|
| `action_reference` | 72 | removed v3 false positives |
| `failure_enforcement` | 41 | removed v3 run-block false positives |

## Window Drift

Rows whose base commit was present in v3 but absent from the v3.2 recent-head signature are classified as `OUT_OF_COMPARISON_WINDOW` and are not recall-regression candidates.

| group | window-drift rows |
|---|---:|
| controls | 298 |
| events | 187 |

## Freeze Decision

The freeze condition is:

```text
comparable tombstones: REMOVED_TP = 0
```

v3.2 satisfies this condition for comparable control and event tombstones. The previously suspicious workflow deletion case is covered by fixture, and the suppression replacement case is detected as granular `failure_enforcement` deltas.
