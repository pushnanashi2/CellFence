# Reviewed TS/JS Precision Pilot 10 Round 14

This is a diagnostic rerun of the same 10 exact-commit reviewed TS/JS
repositories after resource evidence and generated-artifact false-positive
hardening. It is not a public 99% precision claim.

## Scope

- Date: 2026-07-20
- Corpus: `docs/research/corpora/ts-js-reviewed-pilot-10-2026-07-19.json`
- Report: `reports/corpus/ts-js-reviewed-pilot-10-2026-07-20.round14.json`
- Evidence bundle:
  `reports/corpus/ts-js-reviewed-pilot-10-2026-07-20-round14-bundle`
- Labeled bundle:
  `reports/corpus/ts-js-reviewed-pilot-10-2026-07-20-round14-labeled-bundle`
- Claim protocol:
  `docs/research/protocols/ts-js-reviewed-pilot-10-2026-07-20-round14.claim.json`
- Harness commit: `cc608cdc524101e9693f5d196c5139d8f425dbd7`
- Harness dirty: `false`
- Pre-label artifact set SHA-256:
  `6ba35bd9ade352ccdfa9e82cb408e379aaf94c4d85ee1b9eac8c34ff5db2cb6b`
- Labeled artifact set SHA-256:
  `164892ac0b1278163259c0b34c6bb9db63f0a87727f190a414a8ba5ff4953e55`
- Safety: static CellFence checks only; no dependency install, package scripts,
  upstream issues, PRs, or target repository writes.

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

Rule distribution:

```text
CELLFENCE_UNSUPPORTED_DYNAMIC_IMPORT: 10
CELLFENCE_UNSUPPORTED_DYNAMIC_REQUIRE: 25
CELLFENCE_UNRESOLVED_IMPORT: 3
CELLFENCE_UNDECLARED_CONSUMER: 25
CELLFENCE_PRIVATE_IMPORT: 2
CELLFENCE_UNDECLARED_RESOURCE_ACCESS: 4
CELLFENCE_UNRESOLVED_RESOURCE_ACCESS: 2
```

## Labels

Round14 carries forward round10 labels by stable `findingId`, drops 3 stale
source findings, and adds supplemental blind labels for 3 newly surfaced Remix
resource findings.

```text
labels: 149
fully labeled findings: 71
adjudicated findings: 7
label readiness issues: 0
raterType policy: agent labels allowed and required
true_positive: 49
false_positive: 0
needs_policy: 11
out_of_scope: 8
invalid_setup: 3
```

The supplemental Remix resource labels are all `needs_policy`: the observed
database introspection or caller-provided SQL forwarding is real evidence, but
the reviewed manifest does not yet say whether that resource surface should be
declared, waived, or excluded from a narrower blocking claim.

## Claim Status

The round14 bundle is well-formed, label-ready, and hash-bound, but the claim
decision remains `insufficient_evidence`.

```text
blocking precision: 49 / 60 = 81.7%
blocking one-sided 95% lower bound: 71.5%
semantic correctness: 60 / 60 = 100.0%
semantic one-sided 95% lower bound: 95.1%
repository macro precision: 88.3%
decision: insufficient_evidence
```

This distinction is important. The diagnostic evidence says the findings are
semantically meaningful after the latest detector hardening. It does not say
that every semantically meaningful finding should be a CI-blocking failure in a
real adopter repository.

## Why This Still Cannot Claim 99%

The pre-registered protocol requests 99% precision at one-sided 95%
confidence. With zero blocking failures, each included rule needs 299 sampled
findings. Round14 has fewer findings for every rule:

```text
PRIVATE_IMPORT: 2 / 299
UNDECLARED_CONSUMER: 25 / 299
UNSUPPORTED_DYNAMIC_IMPORT: 10 / 299
UNSUPPORTED_DYNAMIC_REQUIRE: 25 / 299
UNRESOLVED_IMPORT: 3 / 299
UNDECLARED_RESOURCE_ACCESS: 4 / 299
UNRESOLVED_RESOURCE_ACCESS: 2 / 299
```

The sample is also repository-concentrated. Selected findings span 7
repositories, but a 10% per-repository cap needs at least 10 repositories with
selected findings. Jest and Vue each contribute 24 findings, or 33.8% of the
selected sample. Remix contributes 12 findings, or 16.9%. The preflight now
reports the exact dilution required: at least 169 additional sampled findings
from other repositories for Jest, 169 for Vue, and 49 for Remix, or a narrower
sample with those repositories reduced.

Finally, this is still agent-labeled diagnostic evidence. A public external
claim must use a sealed holdout corpus, independently attested reviewed
manifests, and human or organization label provenance unless the claim text
explicitly says it is agent-labeled.

## Next Confirmation Shape

Do not tune this corpus until it passes. Use it as the tuning corpus. The next
confirmation attempt should freeze a separate holdout with:

- at least 10 repositories that each contribute selected findings;
- narrower rule inclusion, probably `PRIVATE_IMPORT` and
  `UNDECLARED_CONSUMER` first;
- resource rules either backed by reviewed resource contracts or excluded;
- generated artifacts prepared or excluded before unresolved imports enter the
  denominator;
- manifest review attestations with independent human or organization reviewer
  metadata for external claims;
- label rows with explicit `raterType` and blind/adjudication metadata.
