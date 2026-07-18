# Upstream Policy Oracle v1 Pilot, 2026-07-18

This pilot ran the upstream policy oracle harness against five public OSS repositories with exact commits. The run used package/workspace metadata only as the reference oracle and ran blind CellFence inference with package policy hints disabled.

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
| Raw blind-manifest findings | 1,881 |
| Policy questions | 437 |
| Raw-to-question compression | 4.30:1 |
| Oracle-resolvable questions | 437 |
| Planned mutation cases | 731 |
| Consumer edge precision before answers | 0.60 |
| Consumer edge recall before answers | 0.203125 |
| Consumer edge precision after answers | 1.00 |
| Consumer edge recall after answers | 1.00 |
| Ownership agreement before/after | 1.00 / 1.00 |
| Public entry exact match before/after | 1.00 / 1.00 |

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

The useful signal is that blind inference gaps are representable as deterministic policy questions with manifest patches, and the reference oracle can answer those questions in a way that restores consumer edge precision and recall to 1.0 for the chosen policy surface.

The less flattering signal is also useful: the first pilot produced 437 questions, mostly consumer visibility decisions. That is too many for a human onboarding flow on very large workspaces if surfaced one edge at a time. The next tuning step should group consumer edges by package family, workspace pattern, and dependency source before asking humans to approve them.

## Limitations

- v1 imports only package/workspace policy from `package.json`.
- It does not yet import Nx dep constraints, dependency-cruiser rules, ESLint boundary rules, TypeScript project references, CODEOWNERS, pnpm workspace YAML, or Bazel visibility.
- Mutation cases are planned but not executed in v1.
- Raw findings include unresolved imports, resource selector issues, and unsupported dynamic import/require observations that are not all answerable by package policy.
- `publicEntry` agreement was already 1.0 in this pilot; the fixture test covers the mismatch path, but this 5-repo sample did not stress it.

## Reproducibility

The fixed corpus is `docs/research/upstream-policy-oracle-v1/corpus.json`. By default the generated evidence bundle is written under `reports/upstream-policy-oracle-v1/`, which is intentionally ignored by git because it includes large per-run artifacts and machine-local paths.
