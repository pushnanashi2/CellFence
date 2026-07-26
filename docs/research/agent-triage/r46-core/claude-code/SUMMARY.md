# r46-core Claude Code Agent Triage

This is agent-only non-claim triage, not external human/org evidence.

The two finding-label passes were run in separate agent sessions. Because both
passes used the same model family, the agreement result is only a
self-consistency check. High agreement is not evidence that the rubric is valid;
the most useful signal would be disagreements. The sample is also the first
25 findings and first 10 manifest subjects, so it should not be treated as
representative of the whole packet.

## Finding Labels

- pass1 rows: 25
- pass2 rows: 25
- compared findings: 25
- agreement: 25
- agreement rate: 1.000
- disagreements: 0

Label counts were identical in both passes:

- `needs_policy`: 20
- `true_positive`: 2
- `out_of_scope`: 3
- `false_positive`: 0
- `needs_review`: 0
- `invalid_setup`: 0

Stage1 manifest-only judgments were identical in both passes:

- `allowed_by_manifest`: 23
- `disallowed_by_manifest`: 2
- `undetermined_from_manifest`: 0

Subjects represented in the 25 finding sample:

- `ajaxorg-ace`: 16
- `6pac-slickgrid`: 3
- `ant-design-ant-design-pro`: 3
- `alibaba-page-agent`: 2
- `antfu-collective-ni`: 1

## Manifest Triage

- manifest rows: 10
- `attest`: 7
- `needs_scope_decision`: 3
- `needs_review`: 0
- `reject`: 0

Manifest subjects reviewed:

- `changesets`: attest
- `redux-toolkit`: needs_scope_decision
- `typescript-eslint`: attest
- `jest`: attest
- `lerna`: attest
- `vue-core`: attest
- `tanstack-query`: attest
- `tanstack-router`: needs_scope_decision
- `remix`: needs_scope_decision
- `hono`: attest

## Recurring Patterns

No `false_positive` labels were produced in this 25-finding sample.

The dominant `needs_policy` pattern is private implementation imports across an
otherwise declared consume edge. Examples include SlickGrid root modules, Ace
`lib/*` internals, Ant Design Pro `@/utils/format`, and `ni` command-to-runner
imports. The manifest says the consumer edge exists, but a human policy decision
is still needed on whether only the declared `publicEntry` is public or whether
the repository intentionally exposes multiple internal module paths.

The 2 `true_positive` findings are Page Agent `website -> page-agent` imports:
the manifest has no declared consume edge for that relationship and the upstream
package metadata does not establish it as an allowed workspace dependency.

The 3 `out_of_scope` findings are Ace `*_test.js` files. Because the r46-core
claim profile is limited to boundary-core rules, any `out_of_scope` result is a
packet or claim-profile bug candidate. The likely issue is that test-file
filtering allowed sampled findings from test files into the external packet.

After production-scope filtering was hardened for the named
`ts-js-boundary-core-v1` profile, r46-core should be treated as `limited-use`:
keep it sealed as diagnostic triage, but do not use it as the public claim
denominator. A replacement packet, for example `r47-core`, must be regenerated
under the hardened filter before any 0.1.x boundary-core precision claim.

The `publicEntry` bypass pattern is not a schema expressiveness gap in the
current engine. `consumes` authorizes the producer cell relationship, while
`CELLFENCE_PRIVATE_IMPORT` still requires cross-cell source imports to use the
producer `publicEntry` or a resolved public package surface. The 20
`needs_policy` rows therefore need external reviewer confirmation under that
rule semantic rather than a rubric-only allowance.

Manifest triage found three scope decisions before external attestation:

- `redux-toolkit`: docs, publish-ci examples, and nested toolkit subpackages need
  an explicit include/exclude policy.
- `tanstack-router`: large benchmark/e2e/example surface and a few missing
  monorepo package roots need a scope decision.
- `remix`: nested bench/demo/test package roots need an explicit source-boundary
  policy before attestation.

## Human Review Priorities

1. Decide whether direct imports into declared producer cells are violations
   whenever they bypass `publicEntry`, or whether selected repositories may have
   multi-entry public internals.
2. Remove or explicitly quarantine test-file findings from boundary-core claim
   packets; the Ace `*_test.js` rows should not silently stay in the claim
   denominator.
3. Add a manifest scope rubric for examples, demos, benchmarks, e2e fixtures,
   nested package.json files, and package subpath roots before external
   manifest attestation.
4. Have external human/org reviewers relabel the same cases after the above
   policy decisions; these agent outputs must remain outside the claim lane.

## Claim Status

0.1.x boundary-core precision claim: `HOLD`.

- external human/org finding labels: `0/650`
- external manifest attestations: `0/160`
- r46-core contains 3 test-file findings and is `limited-use` after filter
  hardening
- agent-only triage is not counted toward either external gate

## Validation

- label validator: pass1 `ok 25 rows`, pass2 `ok 25 rows`
- manifest validator: `ok 10 rows`
- packet immutability check: `packet unchanged`
- whitespace check: `git diff --check` clean
