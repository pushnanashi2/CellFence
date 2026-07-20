# Reviewed TS/JS Precision Pilot 10 Round 10

This is a post-label hardening rerun of the same 10 exact-commit reviewed
TS/JS repositories after round9 blind labels identified statically resolvable
dynamic import/require false positives. It is not a public 99% precision claim.

## Scope

- Date: 2026-07-20
- Corpus: `docs/research/corpora/ts-js-reviewed-pilot-10-2026-07-19.json`
- Report: `reports/corpus/ts-js-reviewed-pilot-10-2026-07-20.round10.json`
- Evidence bundle:
  `reports/corpus/ts-js-reviewed-pilot-10-2026-07-20-round10-bundle`
- Labeled bundle:
  `reports/corpus/ts-js-reviewed-pilot-10-2026-07-20-round10-labeled-bundle`
- Harness commit: `5c96b6eb93e62a50ae9b7c69b796de799a209b6b`
- Harness dirty: `false`
- Pre-label artifact set SHA-256:
  `4e2336e0f53923279b012d83a72e2e7b8f4e580ca2acf0de4ee070b0ba5b1ab0`
- Labeled artifact set SHA-256:
  `68c9af0e2e7054756dd8edcd782928644ecc6915184ec269de12b4d38d7048c3`
- Safety: static CellFence checks only; no dependency install, package scripts,
  issues, PRs, or target repository writes.

The report was regenerated from the committed implementation with a clean
worktree before labels and claim evaluation were applied. It is still
diagnostic regression evidence, not a public external precision claim.

## Detector Hardening

Round10 resolves only statically bounded module loads:

- `const specifier = "module"; require(specifier)`;
- `const specifier = "module"; import(specifier)`;
- `require(require.resolve("module"))`;
- the same forms through existing `require.call`, `require.apply`, and
  `Reflect.apply(require, ...)` extraction.

It intentionally keeps these forms fail-closed:

- mutable `let`/`var` specifiers;
- function parameters and shadowed names;
- block-scoped constants after leaving loop, switch, catch, or nested block
  scope;
- `Set.has(name)` narrowing, because `Set` contents and `name` can be mutated
  without a flow-sensitive proof.

## Run Summary

The fixed corpus completed all 10 subjects with no clone, configuration, tool,
timeout, or evidence graph verification failures.

```text
subjects: 10
checks clean: 3
checks with findings: 7
evidence graphs verified: 10
evidence graph failures: 0
raw rejected findings: 71
sampled findings: 71
```

Round9 to round10 change:

```text
total findings: 75 -> 71
CELLFENCE_UNSUPPORTED_DYNAMIC_IMPORT: 11 -> 10
CELLFENCE_UNSUPPORTED_DYNAMIC_REQUIRE: 29 -> 26
```

The four removed findings were the labeled false positives for Hono
`cloudflare:workers`, Jest `require(require.resolve("@babel/generator"))`,
Jest `require(require.resolve("@babel/core"))`, and typescript-eslint
`require(TYPESCRIPT_ESLINT_PARSER)`.

## Label And Claim Status

The round9 labels were carried forward by stable finding ID after removing the
four fixed findings:

```text
labels: 152
fully labeled findings: 71
adjudicated findings: 10
issues: 0
true_positive: 49
false_positive: 1
needs_policy: 10
out_of_scope: 8
invalid_setup: 3
```

The claim evaluator still rejects a 99% blocking-precision claim:

```text
blocking precision: 49 / 60 = 81.7%
blocking one-sided 95% lower bound: 71.5%
semantic correctness: 59 / 60 = 98.3%
semantic one-sided 95% lower bound: 92.3%
decision: insufficient_evidence
```

This is the correct result. The current evidence says the detector can already
separate many real boundary observations from noise, but it does not yet justify
the external sentence "CellFence has 99% precision on reviewed TS/JS OSS."

## Remaining Work To Reach A 99% Claim

- Resolve or explicitly waive the remaining `Set.has(name)` dynamic require
  pattern with a sound policy; do not infer it from mutable `Set` alone.
- Convert Remix resource findings into reviewed resource-contract policy or
  exclude that resource surface from the precision denominator.
- Decide how Vue/Remix internal wiring and type-only or build-time-erased edges
  should be represented in manifest policy.
- Handle generated artifact setup for missing generated imports before counting
  unresolved imports.
- Add more reviewed repositories so rule-level, repository-macro,
  unique-fingerprint, and max-repository-contribution gates have enough power.
