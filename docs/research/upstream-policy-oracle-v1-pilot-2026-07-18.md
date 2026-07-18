# Upstream Policy Oracle v1 Pilot, 2026-07-18

This pilot ran the upstream policy oracle harness against five public OSS repositories with exact commits. The run used package/workspace metadata as the reference oracle and ran CellFence inference with package entry/dependency policy hints disabled. Workspace membership and package names remained available, so this is an entry-and-dependency-hint ablation rather than strict structure-blind inference.

Command:

```sh
npm run research:oracle --silent -- --clone-mode shallow --discard-checkouts
```

Summary:

| Metric | Value |
| --- | ---: |
| Subjects | 5 |
| Completed | 5 |
| Failed | 0 |
| Raw ablated-manifest findings | 1,881 |
| Policy questions | 437 |
| Raw-finding-to-policy-question count ratio | 4.30:1 |
| Oracle-resolvable questions | 437 |
| Planned mutation cases | 731 |
| Consumer edge micro precision before answers | 0.333333 |
| Consumer edge micro recall before answers | 0.002342 |
| Consumer edge subject-macro precision before answers | 0.333333 |
| Consumer edge subject-macro recall before answers | 0.003906 |
| Consumer edge micro precision after answers | 1.00 |
| Consumer edge micro recall after answers | 1.00 |
| Consumer edge subject-macro precision after answers | 1.00 |
| Consumer edge subject-macro recall after answers | 1.00 |
| Ownership agreement before/after | 1.00 / 1.00 |
| Public entry exact match before/after | 1.00 / 1.00 |
| Artifact set hash | `6420182cb1cef36f4bb6e3262040713fac3176607037929d0da4bee0655a27f1` |

Finding-to-question mapping:

| Metric | Value |
| --- | ---: |
| Policy-relevant findings | 1,520 |
| Uniquely mapped findings | 1,501 |
| Mapped policy-relevant findings | 1,500 |
| Unmapped findings | 380 |
| Unmapped policy-relevant findings | 20 |
| Zero-impact questions | 107 |
| Overlapping mappings | 2 |
| Projected resolved findings | 1,501 |
| Observed resolved mapped findings | 1,353 |
| Observed total finding reduction | 1,375 |
| Actionable policy questions | 330 |
| Observed resolved finding / actionable question ratio | 4.10:1 |

Consumer edge set counts:

| Phase | Reference edges | Inferred edges | Common edges | Exact-set subjects | No-reference-edge subjects | No-inferred-edge subjects |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Before oracle answers | 427 | 3 | 1 | 1 | 1 | 2 |
| After oracle answers | 427 | 427 | 427 | 5 | 1 | 1 |

Question kinds:

| Kind | Count |
| --- | ---: |
| `consumer-visibility` | 426 |
| `consumer-deny` | 2 |
| `cell-boundary` | 9 |

Subject breakdown:

| Subject | Reference cells | Reference edges | Blind findings | Policy questions | Mutation plans |
| --- | ---: | ---: | ---: | ---: | ---: |
| `changesets-changesets-2026-07-18` | 22 | 64 | 117 | 63 | 75 |
| `reduxjs-redux-toolkit-2026-07-18` | 27 | 26 | 196 | 28 | 52 |
| `typescript-eslint-typescript-eslint-2026-07-18` | 18 | 55 | 980 | 55 | 110 |
| `jestjs-jest-2026-07-18` | 70 | 282 | 566 | 284 | 494 |
| `lerna-lerna-2026-07-18` | 2 | 0 | 22 | 7 | 0 |

## Interpretation

This is evidence for the onboarding mechanism, not evidence that every finding is a true upstream defect. The reference policy is upstream-declared package/workspace structure: package names, workspace membership, dependency declarations, and package entry metadata. It is a stronger oracle than a CellFence-authored manifest, but it is still not full ground truth.

The useful signal is that ablation gaps are representable as deterministic policy questions with manifest patches, and the reference oracle can answer those questions in a way that restores consumer edge micro and subject-macro precision/recall to 1.0 for the chosen policy surface.

The raw-finding-to-policy-question count ratio is not a claim that each question resolves 4.30 findings. The observed mapping shows 1,501 unique findings attached to at least one policy question, 1,353 mapped findings absent after applying oracle patches, and 330 actionable questions after excluding zero-impact questions. The observed resolved finding / actionable question ratio is 4.10:1 for this run.

Subject-macro edge rates exclude subjects where the denominator is zero; the no-reference-edge and no-inferred-edge counts above make those N/A cases explicit. The artifact set hash is computed from logical artifact keys and content SHA-256 values, not from the local output directory path.

The less flattering signal is also useful: the first pilot produced 437 questions, mostly consumer visibility decisions. That is too many for a human onboarding flow on very large workspaces if surfaced one edge at a time. The next tuning step should group consumer edges by package family, workspace pattern, and dependency source before asking humans to approve them.

## Limitations

- v1 imports only package/workspace policy from `package.json`.
- v1 questions are oracle-conditioned: they are generated from the comparison between the ablated manifest and the upstream-declared reference manifest. This validates deterministic question and patch construction once a reference difference is known, not independent question discovery from blind observations alone.
- It does not yet import Nx dep constraints, dependency-cruiser rules, ESLint boundary rules, TypeScript project references, CODEOWNERS, pnpm workspace YAML, or Bazel visibility.
- Mutation cases are planned but not executed in v1.
- Raw findings include unresolved imports, resource selector issues, and unsupported dynamic import/require observations that are not all answerable by package policy.
- `publicEntry` agreement was already 1.0 in this pilot; the fixture test covers the mismatch path, but this 5-repo sample did not stress it.

## Reproducibility

The fixed corpus is `docs/research/upstream-policy-oracle-v1/corpus.json`. By default the generated evidence bundle is written under `reports/upstream-policy-oracle-v1/`, which is intentionally ignored by git because it includes large per-run artifacts and machine-local paths.
