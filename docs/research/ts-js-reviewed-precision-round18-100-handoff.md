# Precision Rounds 18-100 Handoff

This ledger carries the round17 precision deficits through the requested
round range. It is not new evidence and it does not create external labels,
reviewed repositories, or a public 99% claim.

**Status: handoff only. Evidence progress: false.**

## Source

- Claim report SHA-256: `c3995be7e74a448ffff423027dd7ad86ab2f30b5628f9b1ac73ac2fc6a99537f`
- Preflight SHA-256: `1598fa5e398dfcb55404d7dc4f18ec91c8bef86929b5adcaca055e001c6f9dcd`
- Rounds: 18-100 (83)

## Current Numeric State

| metric | value |
|---|---:|
| decision | insufficient_evidence |
| blocking precision | 75 / 86 = 87.2% |
| blocking 95% one-sided lower bound | 79.7% |
| semantic correctness | 86 / 86 = 100.0% |
| semantic 95% one-sided lower bound | 96.6% |
| external human/org label coverage | 0 / 97 |
| missing external labels | 97 |
| additional TP trials needed | 1732 |
| zero-failure target per included rule | 299 |
| max repository contribution | 25.8% (limit 10.0%) |

## Carry-Forward Task Packet

- `external-labels` (blocked): 97 selected findings need 1 external human/organization independent label(s). Generate a sealed external worklist and collect labels from non-agent human or organization raters; do not relabel them as agent output.
- `repo-balance` (open): 9 repositories represented; max contribution 25.8% with limit 10.0%. Add reviewed repositories with small/medium finding counts before sampling more from already-heavy subjects.
  - https://github.com/floating-ui/floating-ui.git: 25 findings, 25.8%, add 153 other findings or reduce this subject.
  - https://github.com/jestjs/jest.git: 24 findings, 24.7%, add 143 other findings or reduce this subject.
  - https://github.com/vuejs/core.git: 24 findings, 24.7%, add 143 other findings or reduce this subject.
  - https://github.com/remix-run/remix.git: 12 findings, 12.4%, add 23 other findings or reduce this subject.
- `sample-size` (open): 1732 additional true-positive blocking trials are needed if no new failures occur. Increase balanced reviewed corpus coverage; keep failures in the denominator instead of reclassifying them away.
- `policy-decisions` (open): 11 needs_policy findings block the strict precision denominator. Resolve each as explicit policy, waiver, manifest correction, or retained blocking failure before making a public claim.
- `rule-coverage` (open): 8 included rules are below the registered lower-bound target or have no blocking trials. Balance sampling by rule, especially rules with zero or tiny blocking denominators.

## Round Ledger

| round | status | blocking precision | lower bound | external labels | max repo contribution | carry-forward | handoff |
|---:|---|---:|---:|---:|---:|---|---:|
| 18 | insufficient-evidence | 87.2% | 79.7% | 0/97 | 25.8% | external-labels, repo-balance, sample-size, policy-decisions, rule-coverage | 19 |
| 19 | insufficient-evidence | 87.2% | 79.7% | 0/97 | 25.8% | external-labels, repo-balance, sample-size, policy-decisions, rule-coverage | 20 |
| 20 | insufficient-evidence | 87.2% | 79.7% | 0/97 | 25.8% | external-labels, repo-balance, sample-size, policy-decisions, rule-coverage | 21 |
| 21 | insufficient-evidence | 87.2% | 79.7% | 0/97 | 25.8% | external-labels, repo-balance, sample-size, policy-decisions, rule-coverage | 22 |
| 22 | insufficient-evidence | 87.2% | 79.7% | 0/97 | 25.8% | external-labels, repo-balance, sample-size, policy-decisions, rule-coverage | 23 |
| 23 | insufficient-evidence | 87.2% | 79.7% | 0/97 | 25.8% | external-labels, repo-balance, sample-size, policy-decisions, rule-coverage | 24 |
| 24 | insufficient-evidence | 87.2% | 79.7% | 0/97 | 25.8% | external-labels, repo-balance, sample-size, policy-decisions, rule-coverage | 25 |
| 25 | insufficient-evidence | 87.2% | 79.7% | 0/97 | 25.8% | external-labels, repo-balance, sample-size, policy-decisions, rule-coverage | 26 |
| 26 | insufficient-evidence | 87.2% | 79.7% | 0/97 | 25.8% | external-labels, repo-balance, sample-size, policy-decisions, rule-coverage | 27 |
| 27 | insufficient-evidence | 87.2% | 79.7% | 0/97 | 25.8% | external-labels, repo-balance, sample-size, policy-decisions, rule-coverage | 28 |
| 28 | insufficient-evidence | 87.2% | 79.7% | 0/97 | 25.8% | external-labels, repo-balance, sample-size, policy-decisions, rule-coverage | 29 |
| 29 | insufficient-evidence | 87.2% | 79.7% | 0/97 | 25.8% | external-labels, repo-balance, sample-size, policy-decisions, rule-coverage | 30 |
| 30 | insufficient-evidence | 87.2% | 79.7% | 0/97 | 25.8% | external-labels, repo-balance, sample-size, policy-decisions, rule-coverage | 31 |
| 31 | insufficient-evidence | 87.2% | 79.7% | 0/97 | 25.8% | external-labels, repo-balance, sample-size, policy-decisions, rule-coverage | 32 |
| 32 | insufficient-evidence | 87.2% | 79.7% | 0/97 | 25.8% | external-labels, repo-balance, sample-size, policy-decisions, rule-coverage | 33 |
| 33 | insufficient-evidence | 87.2% | 79.7% | 0/97 | 25.8% | external-labels, repo-balance, sample-size, policy-decisions, rule-coverage | 34 |
| 34 | insufficient-evidence | 87.2% | 79.7% | 0/97 | 25.8% | external-labels, repo-balance, sample-size, policy-decisions, rule-coverage | 35 |
| 35 | insufficient-evidence | 87.2% | 79.7% | 0/97 | 25.8% | external-labels, repo-balance, sample-size, policy-decisions, rule-coverage | 36 |
| 36 | insufficient-evidence | 87.2% | 79.7% | 0/97 | 25.8% | external-labels, repo-balance, sample-size, policy-decisions, rule-coverage | 37 |
| 37 | insufficient-evidence | 87.2% | 79.7% | 0/97 | 25.8% | external-labels, repo-balance, sample-size, policy-decisions, rule-coverage | 38 |
| 38 | insufficient-evidence | 87.2% | 79.7% | 0/97 | 25.8% | external-labels, repo-balance, sample-size, policy-decisions, rule-coverage | 39 |
| 39 | insufficient-evidence | 87.2% | 79.7% | 0/97 | 25.8% | external-labels, repo-balance, sample-size, policy-decisions, rule-coverage | 40 |
| 40 | insufficient-evidence | 87.2% | 79.7% | 0/97 | 25.8% | external-labels, repo-balance, sample-size, policy-decisions, rule-coverage | 41 |
| 41 | insufficient-evidence | 87.2% | 79.7% | 0/97 | 25.8% | external-labels, repo-balance, sample-size, policy-decisions, rule-coverage | 42 |
| 42 | insufficient-evidence | 87.2% | 79.7% | 0/97 | 25.8% | external-labels, repo-balance, sample-size, policy-decisions, rule-coverage | 43 |
| 43 | insufficient-evidence | 87.2% | 79.7% | 0/97 | 25.8% | external-labels, repo-balance, sample-size, policy-decisions, rule-coverage | 44 |
| 44 | insufficient-evidence | 87.2% | 79.7% | 0/97 | 25.8% | external-labels, repo-balance, sample-size, policy-decisions, rule-coverage | 45 |
| 45 | insufficient-evidence | 87.2% | 79.7% | 0/97 | 25.8% | external-labels, repo-balance, sample-size, policy-decisions, rule-coverage | 46 |
| 46 | insufficient-evidence | 87.2% | 79.7% | 0/97 | 25.8% | external-labels, repo-balance, sample-size, policy-decisions, rule-coverage | 47 |
| 47 | insufficient-evidence | 87.2% | 79.7% | 0/97 | 25.8% | external-labels, repo-balance, sample-size, policy-decisions, rule-coverage | 48 |
| 48 | insufficient-evidence | 87.2% | 79.7% | 0/97 | 25.8% | external-labels, repo-balance, sample-size, policy-decisions, rule-coverage | 49 |
| 49 | insufficient-evidence | 87.2% | 79.7% | 0/97 | 25.8% | external-labels, repo-balance, sample-size, policy-decisions, rule-coverage | 50 |
| 50 | insufficient-evidence | 87.2% | 79.7% | 0/97 | 25.8% | external-labels, repo-balance, sample-size, policy-decisions, rule-coverage | 51 |
| 51 | insufficient-evidence | 87.2% | 79.7% | 0/97 | 25.8% | external-labels, repo-balance, sample-size, policy-decisions, rule-coverage | 52 |
| 52 | insufficient-evidence | 87.2% | 79.7% | 0/97 | 25.8% | external-labels, repo-balance, sample-size, policy-decisions, rule-coverage | 53 |
| 53 | insufficient-evidence | 87.2% | 79.7% | 0/97 | 25.8% | external-labels, repo-balance, sample-size, policy-decisions, rule-coverage | 54 |
| 54 | insufficient-evidence | 87.2% | 79.7% | 0/97 | 25.8% | external-labels, repo-balance, sample-size, policy-decisions, rule-coverage | 55 |
| 55 | insufficient-evidence | 87.2% | 79.7% | 0/97 | 25.8% | external-labels, repo-balance, sample-size, policy-decisions, rule-coverage | 56 |
| 56 | insufficient-evidence | 87.2% | 79.7% | 0/97 | 25.8% | external-labels, repo-balance, sample-size, policy-decisions, rule-coverage | 57 |
| 57 | insufficient-evidence | 87.2% | 79.7% | 0/97 | 25.8% | external-labels, repo-balance, sample-size, policy-decisions, rule-coverage | 58 |
| 58 | insufficient-evidence | 87.2% | 79.7% | 0/97 | 25.8% | external-labels, repo-balance, sample-size, policy-decisions, rule-coverage | 59 |
| 59 | insufficient-evidence | 87.2% | 79.7% | 0/97 | 25.8% | external-labels, repo-balance, sample-size, policy-decisions, rule-coverage | 60 |
| 60 | insufficient-evidence | 87.2% | 79.7% | 0/97 | 25.8% | external-labels, repo-balance, sample-size, policy-decisions, rule-coverage | 61 |
| 61 | insufficient-evidence | 87.2% | 79.7% | 0/97 | 25.8% | external-labels, repo-balance, sample-size, policy-decisions, rule-coverage | 62 |
| 62 | insufficient-evidence | 87.2% | 79.7% | 0/97 | 25.8% | external-labels, repo-balance, sample-size, policy-decisions, rule-coverage | 63 |
| 63 | insufficient-evidence | 87.2% | 79.7% | 0/97 | 25.8% | external-labels, repo-balance, sample-size, policy-decisions, rule-coverage | 64 |
| 64 | insufficient-evidence | 87.2% | 79.7% | 0/97 | 25.8% | external-labels, repo-balance, sample-size, policy-decisions, rule-coverage | 65 |
| 65 | insufficient-evidence | 87.2% | 79.7% | 0/97 | 25.8% | external-labels, repo-balance, sample-size, policy-decisions, rule-coverage | 66 |
| 66 | insufficient-evidence | 87.2% | 79.7% | 0/97 | 25.8% | external-labels, repo-balance, sample-size, policy-decisions, rule-coverage | 67 |
| 67 | insufficient-evidence | 87.2% | 79.7% | 0/97 | 25.8% | external-labels, repo-balance, sample-size, policy-decisions, rule-coverage | 68 |
| 68 | insufficient-evidence | 87.2% | 79.7% | 0/97 | 25.8% | external-labels, repo-balance, sample-size, policy-decisions, rule-coverage | 69 |
| 69 | insufficient-evidence | 87.2% | 79.7% | 0/97 | 25.8% | external-labels, repo-balance, sample-size, policy-decisions, rule-coverage | 70 |
| 70 | insufficient-evidence | 87.2% | 79.7% | 0/97 | 25.8% | external-labels, repo-balance, sample-size, policy-decisions, rule-coverage | 71 |
| 71 | insufficient-evidence | 87.2% | 79.7% | 0/97 | 25.8% | external-labels, repo-balance, sample-size, policy-decisions, rule-coverage | 72 |
| 72 | insufficient-evidence | 87.2% | 79.7% | 0/97 | 25.8% | external-labels, repo-balance, sample-size, policy-decisions, rule-coverage | 73 |
| 73 | insufficient-evidence | 87.2% | 79.7% | 0/97 | 25.8% | external-labels, repo-balance, sample-size, policy-decisions, rule-coverage | 74 |
| 74 | insufficient-evidence | 87.2% | 79.7% | 0/97 | 25.8% | external-labels, repo-balance, sample-size, policy-decisions, rule-coverage | 75 |
| 75 | insufficient-evidence | 87.2% | 79.7% | 0/97 | 25.8% | external-labels, repo-balance, sample-size, policy-decisions, rule-coverage | 76 |
| 76 | insufficient-evidence | 87.2% | 79.7% | 0/97 | 25.8% | external-labels, repo-balance, sample-size, policy-decisions, rule-coverage | 77 |
| 77 | insufficient-evidence | 87.2% | 79.7% | 0/97 | 25.8% | external-labels, repo-balance, sample-size, policy-decisions, rule-coverage | 78 |
| 78 | insufficient-evidence | 87.2% | 79.7% | 0/97 | 25.8% | external-labels, repo-balance, sample-size, policy-decisions, rule-coverage | 79 |
| 79 | insufficient-evidence | 87.2% | 79.7% | 0/97 | 25.8% | external-labels, repo-balance, sample-size, policy-decisions, rule-coverage | 80 |
| 80 | insufficient-evidence | 87.2% | 79.7% | 0/97 | 25.8% | external-labels, repo-balance, sample-size, policy-decisions, rule-coverage | 81 |
| 81 | insufficient-evidence | 87.2% | 79.7% | 0/97 | 25.8% | external-labels, repo-balance, sample-size, policy-decisions, rule-coverage | 82 |
| 82 | insufficient-evidence | 87.2% | 79.7% | 0/97 | 25.8% | external-labels, repo-balance, sample-size, policy-decisions, rule-coverage | 83 |
| 83 | insufficient-evidence | 87.2% | 79.7% | 0/97 | 25.8% | external-labels, repo-balance, sample-size, policy-decisions, rule-coverage | 84 |
| 84 | insufficient-evidence | 87.2% | 79.7% | 0/97 | 25.8% | external-labels, repo-balance, sample-size, policy-decisions, rule-coverage | 85 |
| 85 | insufficient-evidence | 87.2% | 79.7% | 0/97 | 25.8% | external-labels, repo-balance, sample-size, policy-decisions, rule-coverage | 86 |
| 86 | insufficient-evidence | 87.2% | 79.7% | 0/97 | 25.8% | external-labels, repo-balance, sample-size, policy-decisions, rule-coverage | 87 |
| 87 | insufficient-evidence | 87.2% | 79.7% | 0/97 | 25.8% | external-labels, repo-balance, sample-size, policy-decisions, rule-coverage | 88 |
| 88 | insufficient-evidence | 87.2% | 79.7% | 0/97 | 25.8% | external-labels, repo-balance, sample-size, policy-decisions, rule-coverage | 89 |
| 89 | insufficient-evidence | 87.2% | 79.7% | 0/97 | 25.8% | external-labels, repo-balance, sample-size, policy-decisions, rule-coverage | 90 |
| 90 | insufficient-evidence | 87.2% | 79.7% | 0/97 | 25.8% | external-labels, repo-balance, sample-size, policy-decisions, rule-coverage | 91 |
| 91 | insufficient-evidence | 87.2% | 79.7% | 0/97 | 25.8% | external-labels, repo-balance, sample-size, policy-decisions, rule-coverage | 92 |
| 92 | insufficient-evidence | 87.2% | 79.7% | 0/97 | 25.8% | external-labels, repo-balance, sample-size, policy-decisions, rule-coverage | 93 |
| 93 | insufficient-evidence | 87.2% | 79.7% | 0/97 | 25.8% | external-labels, repo-balance, sample-size, policy-decisions, rule-coverage | 94 |
| 94 | insufficient-evidence | 87.2% | 79.7% | 0/97 | 25.8% | external-labels, repo-balance, sample-size, policy-decisions, rule-coverage | 95 |
| 95 | insufficient-evidence | 87.2% | 79.7% | 0/97 | 25.8% | external-labels, repo-balance, sample-size, policy-decisions, rule-coverage | 96 |
| 96 | insufficient-evidence | 87.2% | 79.7% | 0/97 | 25.8% | external-labels, repo-balance, sample-size, policy-decisions, rule-coverage | 97 |
| 97 | insufficient-evidence | 87.2% | 79.7% | 0/97 | 25.8% | external-labels, repo-balance, sample-size, policy-decisions, rule-coverage | 98 |
| 98 | insufficient-evidence | 87.2% | 79.7% | 0/97 | 25.8% | external-labels, repo-balance, sample-size, policy-decisions, rule-coverage | 99 |
| 99 | insufficient-evidence | 87.2% | 79.7% | 0/97 | 25.8% | external-labels, repo-balance, sample-size, policy-decisions, rule-coverage | 100 |
| 100 | insufficient-evidence | 87.2% | 79.7% | 0/97 | 25.8% | external-labels, repo-balance, sample-size, policy-decisions, rule-coverage |  |

## Non-Negotiable Gate

Agent-only relabeling can improve diagnostics, but it cannot satisfy the
registered external human/organization label gate. Until sealed external
labels and a larger balanced reviewed corpus are supplied, every round in
this ledger remains `insufficient-evidence` for a public 99% precision claim.
