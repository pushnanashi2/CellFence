# TS/JS Workspace Corpus Pilot - 2026-07-18

This is the first frozen-corpus CellFence pilot run. It is an onboarding and
finding-distribution measurement, not a precision claim. No target repository
dependencies were installed and no target package scripts were executed.
Named subjects identify the reproducible corpus only; unlabeled findings should
not be read as upstream defects.

## Corpus

Corpus manifest: `docs/research/corpora/ts-js-workspace-pilot-10.json`

Selection:

- 10 public TypeScript/JavaScript workspace-style repositories;
- exact 40-hex Git commits fixed before running the check;
- first-run `manifest.strategy: infer` to measure bootstrap behavior;
- avoided very large repositories for the first local pilot.

## Command

```bash
npm run research:corpus -- \
  --corpus docs/research/corpora/ts-js-workspace-pilot-10.json \
  --out reports/corpus/ts-js-workspace-pilot-10.json
```

## Summary

| metric | value |
|---|---:|
| subjects | 10 |
| clone/checkout/manifest completed | 10 |
| failed before check | 0 |
| CellFence checks run | 10 |
| checks with exit 0 | 7 |
| checks with findings | 3 |
| configuration errors | 0 |
| total findings | 1,773 |

Findings by rule:

| rule | findings |
|---|---:|
| `CELLFENCE_UNDECLARED_CONSUMER` | 990 |
| `CELLFENCE_UNDECLARED_RESOURCE_ACCESS` | 545 |
| `CELLFENCE_PRIVATE_IMPORT` | 189 |
| `CELLFENCE_UNRESOLVED_RESOURCE_ACCESS` | 36 |
| `CELLFENCE_UNSUPPORTED_DYNAMIC_IMPORT` | 12 |
| `CELLFENCE_UNRESOLVED_IMPORT` | 1 |
| `CELLFENCE_OWNERSHIP_OVERLAP` | 0 |

Subject results:

| subject | commit | exit | findings | warnings | rule counts |
|---|---|---:|---:|---:|---|
| vite | `e16ff3a1199293ac9cdfa6132c08fdea162215f3` | 0 | 0 | 0 | none |
| vue-core | `fa2885d8c48768d26f1666a01bd540ffe3b20f9b` | 0 | 0 | 0 | none |
| tanstack-query | `b955f60d7965cc521df6ee8b1ce91b3d0e8c046d` | 0 | 0 | 0 | none |
| tanstack-router | `31a634d84ecf393dfb95adcf713fd5f1a13ab347` | 0 | 0 | 0 | none |
| trpc | `340811ba5320637fbaf48fccf3dbfdd258bd34db` | 0 | 0 | 0 | none |
| changesets | `180833ed1ceb7e2f3bbcfd9fefa48b0c631a8bb6` | 1 | 176 | 98 | undeclared consumer 173; resource 1; dynamic import 2 |
| remix | `2c0ef67220714e1005162be4acdb91fbf355c664` | 1 | 1,539 | 128 | undeclared consumer 817; private import 136; resource 543; unresolved resource 36; dynamic import 6; unresolved import 1 |
| svelte-kit | `385f7ed7671f955e544004cae404bf53932dd6de` | 0 | 0 | 0 | none |
| nitro | `bfc2f5ef445494cec0f61ef3fe43ece4956dc14d` | 1 | 58 | 68 | private import 53; resource 1; dynamic import 4 |
| nuxt | `2a6ab991ad52bca658ad010633dea8231bbb5722` | 0 | 0 | 0 | none |

## What The Pilot Proves

- The frozen corpus harness can clone, checkout, infer manifests, run checks,
  and produce failure-inclusive aggregate results on real public repositories.
- Manifest inference can produce usable zero-finding starter fences for several
  workspace repositories.
- Real repositories immediately produce concentrated follow-up work instead of
  vague feature requests.

## What It Does Not Prove

- These findings are not yet labeled true positives or false positives.
- `manifest.strategy: infer` is not equivalent to a reviewed architecture
  contract.
- This does not show long-term operational value or agent behavior changes.
- This is not a benchmark against dependency-cruiser, Nx, ESLint boundaries, or
  CODEOWNERS yet.

## Bug Found During The Pilot

The first run produced `CELLFENCE_OWNERSHIP_OVERLAP` findings for Nitro where
the inferred manifest had a root-file glob such as `src/*` and nested directory
ownership such as `src/build/**`. Since CellFence checks file paths, `src/*`
does not own `src/build/file.ts`; treating those patterns as overlapping was a
false positive.

The ownership overlap helper was tightened and covered with a regression test.
After rerunning the same frozen corpus, `CELLFENCE_OWNERSHIP_OVERLAP` dropped
from 9 to 0.

## Labeling Backlog

Next manual labels should start with:

- Changesets `CELLFENCE_UNDECLARED_CONSUMER`: determine how many package imports
  are already represented by package dependencies and should become inferred
  `consumes` edges.
- Remix `CELLFENCE_PRIVATE_IMPORT`: separate intentional subpath exports from
  actual internal implementation reaches.
- Remix and Nitro resource findings: classify static file, HTTP, and dynamic
  resource detections as true positive, needs policy, or invalid setup.
- Nitro private imports: inspect whether source-relative imports are crossing
  inferred cells that should be merged or explicitly declared.

Only after that labeling pass should this corpus produce precision numbers.
