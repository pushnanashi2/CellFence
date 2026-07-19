# Reviewed TS/JS Precision Pilot 10 Round 3

This is an unlabeled diagnostic rerun after narrowing resource-access
detectors that produced clear false positives in round2. It is not a public
precision claim.

## Scope

- Date: 2026-07-19
- Subjects: the same 10 exact-commit public TypeScript/JavaScript repositories
  as `ts-js-reviewed-pilot-10-2026-07-19`
- Corpus: `docs/research/corpora/ts-js-reviewed-pilot-10-2026-07-19.json`
- Report: `reports/corpus/ts-js-reviewed-pilot-10-2026-07-19.round3.json`
- Safety: static CellFence checks only; no dependency install, package scripts,
  issues, PRs, or target repository writes.

## Detector Changes

Round3 fixes four cases that round2 labeled as detector false positives:

- chained cache-key hashing such as `hash.update("\0").update(...)` is no
  longer treated as a TypeORM query-builder table update;
- `fs.createWriteStream("ignored", { fd })` and fd-backed read streams no
  longer report the dummy path string as a file resource;
- local lifecycle events such as `router.subscribe("onResolved")` no longer
  count as generic queue subscriptions;
- map lookups such as `map.get("/")` no longer count as HTTP route handlers
  unless the receiver looks like a route/server object.

## Run Summary

The fixed corpus completed all 10 subjects with no clone, configuration, tool,
timeout, or evidence graph verification failures.

```text
subjects: 10
checks clean: 2
checks with findings: 8
evidence graphs verified: 10
evidence graph failures: 0
raw check findings: 75
```

Round2 found 89 raw findings on the same subjects. Round3 reduced that to 75.
The resource-related findings dropped from 19 to 5:

```text
CELLFENCE_UNRESOLVED_RESOURCE_ACCESS: 8 -> 3
CELLFENCE_UNDECLARED_RESOURCE_ACCESS: 11 -> 2
```

The round2 false-positive selectors `\0`, `ignored`, `onResolved`, and `GET /`
were absent from the round3 report.

## Remaining Judgment Required

These are not detector fixes and must not be silently allowed by CellFence:

- Generated `ast-spec` imports in `typescript-eslint` still require either a
  generated-artifact lane, generated artifact evidence, or a controlled
  pre-generation protocol. Until one is chosen, these stay as unresolved-import
  policy/setup questions.
- Remix script/tooling edges and Vue compat internal runtime edges require an
  explicit reviewed manifest decision, scope exclusion, or waiver. They should
  remain visible as `needs_policy` evidence rather than being auto-accepted by
  heuristics.
- Private development tooling such as Vue `template-explorer` needs an explicit
  corpus-scope decision before it enters or leaves a production precision
  denominator.

The remaining resource findings in round3 are concrete dynamic SQL / package
metadata file accesses and are candidates for policy review, not automatic
detector suppression.

The follow-up round4 diagnostic is documented in
[ts-js-reviewed-pilot-10-2026-07-19-round4.md](ts-js-reviewed-pilot-10-2026-07-19-round4.md).
