# Reviewed TS/JS Precision Pilot 10 Round 2

This is a round2 diagnostic rerun of the reviewed-manifest public-OSS precision
pilot. It is not a public precision claim.

## Scope

- Date: 2026-07-19
- Subjects: the same 10 exact-commit public TypeScript/JavaScript repositories
  as `ts-js-reviewed-pilot-10-2026-07-19`
- Corpus: `docs/research/corpora/ts-js-reviewed-pilot-10-2026-07-19.json`
- Protocol:
  `docs/research/protocols/ts-js-reviewed-pilot-10-2026-07-19-round2.preliminary.json`
- Labels:
  `docs/research/labels/ts-js-reviewed-pilot-10-2026-07-19-round2.codex-preliminary.labels.jsonl`
- Labels are two Codex-generated preliminary passes, not independent human blind
  labels.
- Safety: static CellFence checks only; no dependency install, package scripts,
  issues, PRs, or target repository writes.

## Round2 Tuning

Round2 targeted blockers from the first pilot instead of expanding the corpus:

- package subpath exports now have a public-package path in the import resolver;
- workspace package imports are checked against package public exports before
  TypeScript path aliases, so aliases cannot turn exported package imports into
  private source imports;
- route-style dotted filenames, declaration specifiers, and import query/hash
  suffixes are resolved more accurately;
- production scope excludes more generated, fixture, template, guide, and
  top-level integration/demo surfaces;
- upstream policy oracle reference manifests use the engine public-symbol
  extractor instead of a regex fallback when the built engine is available;
- the reviewed manifests were refreshed to match the tuned production scope and
  public-symbol extraction.

## Run Summary

The fixed corpus completed all 10 subjects with no clone, configuration, tool,
timeout, or evidence graph verification failures.

```text
subjects: 10
checks clean: 2
checks with findings: 8
evidence graphs verified: 10
evidence graph failures: 0
raw check findings: 89
bundle normalized findings: 302
sampled findings: 32
label rows: 64
fully labeled sampled findings: 32
adjudicated disagreements: 0
label readiness issues: 0
```

The first pilot found 2406 raw findings and 2692 normalized bundle findings.
Round2 reduced that to 89 raw findings and 302 normalized bundle findings on
the same frozen subjects. This is evidence that the tuning removed large
classes of harness/scope noise, not evidence of a final precision number.

## Preliminary Labels

All sampled findings have two preliminary Codex labels. Final sampled-label
counts before the claim filter were:

```text
needs_policy: 14
true_positive: 9
false_positive: 5
out_of_scope: 4
```

The claim protocol only counts blocking `error` severities, so warning-level
unresolved file-resource samples are labeled for diagnosis but do not enter the
blocking precision denominator.

For the 25 sampled blocking error findings included by the preliminary protocol:

```text
true_positive: 9
false_positive: 5
needs_policy: 8
out_of_scope: 3
blocking trials: 22
observed blocking precision: 0.4091
one-sided 95% lower bound: 0.2327
semantic correctness: 0.7727
decision: insufficient_evidence
```

The `insufficient_evidence` decision is expected and correct. This dataset must
not be summarized as "CellFence precision is 40.9%"; it is a small, agent-labeled
diagnostic sample after a tuning pass.

## What Looks Strong

The dynamic loader rules were clean in this sample. Blocking samples for
`CELLFENCE_UNSUPPORTED_DYNAMIC_IMPORT` and
`CELLFENCE_UNSUPPORTED_DYNAMIC_REQUIRE` were labeled true positive when they
covered runtime-computed module URLs, caller-provided file paths, or custom
runtime loaders. These remain the strongest externally legible rule families.

The corpus runner, evidence graph verification, deterministic sampling, label
readiness validation, and claim verifier all worked end to end.

## Remaining Precision Blockers

The resource detector still overreaches in several important cases:

- NUL separators inside hash construction were interpreted as database
  resources;
- `fs.createWriteStream("ignored", { fd })` treated a dummy fd path as a real
  file resource;
- local router lifecycle events such as `router.subscribe("onResolved")` were
  interpreted as queue subscriptions;
- route-map helpers such as `map.get("/")` were interpreted as HTTP route
  serving.

Package public-surface modeling improved materially. The TanStack Router
package-export false positives disappeared after package imports were resolved
before TypeScript path aliases. The remaining private-import samples are Remix
script wiring and Vue compat internal runtime edges; both need explicit policy,
not silent acceptance.

Generated artifact handling is still unresolved. `typescript-eslint` imports
generated `ast-spec` artifacts that are absent in the fixed checkout. This needs
generated-artifact evidence or a pre-generation protocol before the findings can
support a precision claim.

Scope hygiene improved, but private tooling and demo surfaces still reached the
sample in places such as codemod test utilities, Remix demos, and Vue
`template-explorer`.

## Next Actions

Before any external precision claim:

- narrow TypeScript resource detectors for hash separators, fd-only file writes,
  in-process event callbacks, and non-server `.get("/")` calls;
- keep hardening package-export public surfaces, especially conditional outputs
  whose built `dist` targets are absent in source checkouts;
- add generated artifact lanes or a controlled pre-generation protocol;
- harden production scope around private tooling/demo fixtures without hiding
  real package code;
- regenerate the bundle from a clean commit, then repeat labeling with a larger
  sealed sample and preferably human blind labels.
