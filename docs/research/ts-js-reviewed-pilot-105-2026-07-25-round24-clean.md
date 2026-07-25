# TS/JS Reviewed Pilot 105 Round24 Clean

Round24 repeats the 105-subject corpus run after committing the round23 harness
and corpus changes. Its purpose is to remove the dirty-worktree blocker from the
claim preflight while preserving the same no-label, no-external-claim boundary.

## Clean Corpus Run

The clean run is bound to CellFence commit:

```text
2dbbf61d3b907f523d9efc7823d24ea037d1463d
```

Run summary:

```text
completed: 105 / 105
harnessDirty: false
toolErrors: 0
timeouts: 0
configurationErrors: 0
evidenceGraphsVerified: 105
evidenceGraphFailures: 0
totalFindings: 21188
corpusSha256: 4e26dba34f061e1a3caa0cc0ccff264c3a5d15e47773f5c312311b4baddc2608
```

The finding distribution is unchanged from round23.

## Clean Next-Cycle Artifacts

The clean next-cycle build produced a sealed unlabeled bundle and blind worklist:

```text
preLabelArtifactSetSha256:
  590ff0946e4363ae460f19f89d1e027946c2907ba264cdba4633d1b3286230ce
blindWorklistArtifactSetSha256:
  ec13ed57b025c94044df5881389df700b9c9ecb24259a71e30cbf5c36f36eaae
selected findings: 1386
blind assignments: 2772
claim blockers: 388
```

The dirty-worktree blocker from round23 is gone. The remaining gate failures are:

- 1386 selected findings are not fully independently labeled;
- 1386 selected findings lack an external human/organization independent label;
- 105 copied manifests still need external review attestations;
- `Gitlawb/openclaude` contributes 14.2% of selected findings;
- `Dokploy/dokploy` contributes 12.3% of selected findings;
- five included rules are still below the 299 zero-false-positive sample size
  needed for a one-sided 95% lower bound of 99% precision.

Rule deficits before labeling:

```text
CELLFENCE_PUBLIC_SYMBOL_MISMATCH: 293
CELLFENCE_UNDECLARED_CONSUMER: 158
CELLFENCE_UNRESOLVED_IMPORT: 160
CELLFENCE_UNSUPPORTED_DYNAMIC_IMPORT: 255
CELLFENCE_UNSUPPORTED_DYNAMIC_REQUIRE: 197
```

## Boundary

Round24 is stronger than round23 because the clean preflight is bound to a clean
tool commit. It is still not a public 99% precision claim: no external labels,
no external manifest attestations, and no adjudication labels have been supplied.
