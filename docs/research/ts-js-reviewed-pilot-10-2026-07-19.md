# Reviewed TS/JS Precision Pilot 10

This is the first reviewed-manifest public-OSS precision pilot for CellFence.
It is a pipeline and diagnosis artifact, not a public precision claim.

Round2 follow-up: `docs/research/ts-js-reviewed-pilot-10-2026-07-19-round2.md`
reruns the same frozen corpus after package-export, resolver, scope, and
public-surface tuning.

## Scope

- Date: 2026-07-19
- Subjects: 10 exact-commit public TypeScript/JavaScript repositories
- Corpus: `docs/research/corpora/ts-js-reviewed-pilot-10-2026-07-19.json`
- Manifest source: package/workspace policy reference or resolved manifests
- Labels: preliminary Codex-generated labels, not independent human blind labels
- Safety: static CellFence checks only; no dependency install, package scripts,
  issues, PRs, or target repository writes

## Run Summary

The reviewed-corpus gate accepted all 10 subjects. The corpus run completed all
10 subjects with no clone, configuration, tool, timeout, or evidence graph
verification failures.

```text
subjects: 10
checks clean: 1
checks with findings: 9
evidence graphs verified: 10
evidence graph failures: 0
raw check findings: 2406
bundle normalized findings: 2692
sampled findings: 18
label rows: 40
fully labeled sampled findings: 18
adjudicated disagreements: 4
```

The claim report is intentionally `insufficient_evidence`. Among the 14 sampled
blocking error findings included by the preliminary protocol, the final labels
were:

```text
false_positive: 4
needs_policy: 4
invalid_setup: 1
out_of_scope: 5
true_positive: 0
```

That means this pilot should not be summarized as "CellFence precision is X%".
It should be summarized as: the reviewed-manifest pipeline works end to end, and
the first sampled labels exposed concrete precision blockers.

## Main Findings

The biggest false-positive class is package subpath exports. Examples:
`@reduxjs/toolkit/query/react` and `@typescript-eslint/utils/json-schema` are
declared package exports, but the one-public-entry cell model labeled the
imports as private implementation imports.

The second concrete false-positive class is resolver coverage. The sampled
route-style import `./posts.$postId` points at an existing
`posts.$postId.tsx` file, and `./es2015.symbol` points at an existing
`es2015.symbol.ts` file, but both were reported unresolved.

The largest denominator hygiene issue is scope. Examples, benchmarks, e2e
fixture generation, and codemod output fixtures entered the sample. These are
useful detector-pressure signals, but they should not be mixed into a production
blocking-precision denominator.

The remaining `needs_policy` labels are mostly real dynamic resource or runtime
loader patterns that require explicit resource contracts, waivers, or manifest
policy decisions before they can fairly count as blocking precision evidence.

## Interpretation

This pilot is a useful HOLD, not a failed product verdict. It proves the
measurement machinery can run on real OSS with reviewed manifests, evidence
graphs, two-pass labels, adjudication, and claim metrics. It also identifies the
next tuning work before any external precision number is defensible:

- support package subpath public surfaces;
- fix unresolved relative imports for route-style and dotted filenames;
- harden production-scope exclusions for examples, benchmarks, e2e, fixtures,
  and generated outputs;
- improve public-surface extraction/review for type-only exports and large
  package entry files;
- rerun the same frozen corpus after the fixes, then label a larger sealed
  sample.
