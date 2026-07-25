# Round32 Frontier Work Plan Hardening

Round32 keeps the public 99% precision claim blocked, but makes the remaining
work machine-readable and harder to overstate.

## What changed

- `precision-frontier-report` now emits a `workPlan` section with:
  - rule-level selected-finding, label, and zero-failure trial gaps;
  - repository-balance outside-finding requirements;
  - external independent label and external manifest attestation gaps;
  - candidate-promotion counts for reviewed manifests, blind labels, external
    labels, and claim-preflight-ready findings.
- Candidate bundles count distinct external raters, not duplicate external
  label rows.
- External manifest attestations with agent/bot-like reviewer IDs are rejected
  by the final claim evaluator and ignored by frontier promotion checks.
- The frontier markdown now includes the work plan so each failed claim attempt
  can hand exact remaining tasks to the next round.

## Claim boundary

This round does not add external human or organization labels and does not
claim 99% precision. It prevents agent-only or duplicate-row evidence from
being treated as external evidence, and it reports the concrete gaps that must
be closed before another claim preflight can matter.

## Verification

```bash
node --test tests/precision-frontier-report.test.mjs
node --test tests/corpus-precision-claim.test.mjs tests/precision-frontier-report.test.mjs
```
