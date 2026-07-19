# History Replay Study

History replay is CellFence's counterfactual evidence track. It asks a narrower
and stronger question than onboarding corpus scans:

> At the commit where a boundary or resource-contract finding appeared, would
> CellFence have produced a new blocking fingerprint?

This is not a crawler and not an upstream bug-report bot. The harness only runs
against a predeclared corpus of public or local repositories pinned by exact
before/after commits. It never installs target dependencies, never runs target
package scripts, never opens pull requests, and never files issues.

## Corpus Shape

```json
{
  "schemaVersion": "cellfence.history-replay.v1",
  "subjects": [
    {
      "id": "example-private-import",
      "repository": "https://github.com/example/project.git",
      "beforeCommit": "0123456789abcdef0123456789abcdef01234567",
      "afterCommit": "89abcdef0123456789abcdef0123456789abcdef",
      "manifest": {
        "strategy": "copy",
        "source": "manifests/example-project.reviewed.json",
        "reviewed": true
      },
      "baseline": {
        "enabled": true,
        "evidenceBefore": ["resource-evidence.before.json"],
        "evidenceAfter": ["resource-evidence.after.json"]
      },
      "expected": {
        "introducedRuleIds": ["CELLFENCE_PRIVATE_IMPORT"]
      }
    }
  ]
}
```

`beforeCommit` and `afterCommit` must be exact 40-hex commits unless
`--allow-floating-ref` is used for exploratory runs. The report records whether
`beforeCommit` is an ancestor of `afterCommit`, and distinguishes
`single_commit_intro` from wider `window_replay` windows.

## Running

Run the local mechanism smoke first:

```bash
npm run history:replay:smoke
```

The smoke creates a temporary local git repository, replays a clean before
commit against an after commit that introduces a private import, runs baseline
create/check, and writes `reports/history-replay-smoke.json`. It proves the
history-replay machinery works on exact commits; it is not public-OSS precision,
public-OSS recall, or upstream-defect evidence.

```bash
npm run research:history -- \
  --corpus docs/research/corpora/history-replay.json \
  --out reports/history-replay.json \
  --workdir tmp/history-replay-study \
  --clone-mode full
```

For larger frozen replay sets:

```bash
npm run research:history -- \
  --corpus docs/research/corpora/history-replay.json \
  --out reports/history-replay.json \
  --workdir tmp/history-replay-study \
  --clone-mode shallow \
  --discard-checkouts
```

`--clone-mode shallow` is useful for broad scouting runs, but shallow history can
make ancestry ambiguous after the harness fetches the before commit. In that
case the row is reported as `replayKind: "unknown_ancestry"` and
`proofEligibility: "not_eligible_unknown_ancestry"`. Use `--clone-mode full` for
rows intended as proof that a specific commit introduced a finding.

The script:

- clones separate before and after checkouts;
- checks out and verifies the requested commits;
- prepares manifests by `existing`, `copy`, or non-destructive `infer`;
- verifies manifest preparation leaves each checkout clean;
- runs `cellfence check --json` at both commits;
- compares after finding fingerprints against before finding fingerprints,
  preserving duplicate fingerprint occurrences;
- records changed files, diff metadata, actual commits, tree hashes, manifest
  hashes, audit-log hashes, environment metadata, an evidence-set SHA-256, and
  proof eligibility;
- optionally creates a baseline at `before` and runs `baseline check` at
  `after`, including supplied relative evidence paths.

## Proof Eligibility

The strongest replay rows have:

- `replayKind: "single_commit_intro"`;
- `manifest.strategy: "existing"` or a `copy` manifest recorded as reviewed;
- introduced findings whose files are changed by the replay diff;
- manual labels tying the finding to the intended event.

If `baseline.enabled` is true, baseline create/check failures are harness
failures. A green replay with baseline enabled means the before-baseline was
created, the after-baseline check ran, and any findings are recorded as replay
evidence rather than swallowed as tool noise.

Rows using `infer` manifests are still useful, but they are onboarding or
detector-pressure evidence. They are not precision/recall denominators until a
human-reviewed manifest or upstream policy oracle exists.

## Claim Boundaries

Allowed:

- "This frozen replay produced N new CellFence fingerprints at the after
  commit."
- "For manually labeled event X, CellFence would have blocked the introducing
  commit under the reviewed manifest."
- "The before-baseline replay produced ratchet findings at the after commit."

Not allowed:

- "The upstream project had a bug" from a raw finding alone.
- "CellFence proves precision/recall" without event labels.
- "CellFence changes agent behavior" from history replay; that requires an
  agent A/B study.
- "Infer replay proves catchability" before the inferred manifest is reviewed.
