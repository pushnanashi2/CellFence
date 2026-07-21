# Reviewed TS/JS Precision Pilot 10 Round 15 Frontier

This is a frontier report for the round14 reviewed TS/JS pilot after the sealed
worklist requirements landed. It is not a new precision claim and it does not
reuse old diagnostic labels as claim-bound labels.

## Scope

- Date: 2026-07-21
- Reviewed bundle checked:
  `reports/corpus/ts-js-reviewed-pilot-10-2026-07-20-round14-labeled-bundle`
- Live claim report:
  `reports/corpus/ts-js-reviewed-pilot-10-2026-07-21-round15-live-claim-report.json`
- Frontier report:
  `reports/corpus/ts-js-reviewed-pilot-10-2026-07-21-round15-frontier.json`
- Frontier markdown:
  `reports/corpus/ts-js-reviewed-pilot-10-2026-07-21-round15-frontier.md`
- Candidate pool:
  `reports/corpus/oss-ts-js-200-2026-07-18-production-scope-bundle`
- Safety: static CellFence artifacts only; no dependency install, package
  scripts, upstream issues, PRs, or target repository writes.

## Live Gate Result

The saved round14 prose remains historically useful, but the old labeled bundle
is not valid under the current sealed-label protocol. Live validation now marks
it `invalid` because the old labels predate the current claim metadata contract:

- old diagnostic labels contain fields that are no longer allowed in
  claim-bound rows, such as `confidence`, `method`, `transferredFrom`,
  supplemental metadata;
- independent labels do not declare `sourceBundleContainsLabels=false`;
- independent labels do not declare `claimUse=blind_labeling`;
- adjudication labels are not bound to a sealed adjudication worklist;
- the protocol does not bind `worklistArtifactSetSha256s`.

That is the correct failure mode. The old rows can guide diagnosis, but they
must not be silently upgraded into claim evidence. A fresh sealed blind worklist
was generated from the unlabeled round14 bundle instead:

```text
worklist: reports/corpus/ts-js-reviewed-pilot-10-2026-07-21-round15-blind-worklist
artifactSetSha256: f14d7ed93f2876342d46e35b0950cd168c72f30b3a3dffd2ebeb5a75eba52b44
selected findings: 71
assignments: 142
raters: codex-blind-a, codex-blind-b
rater type: agent
```

This worklist is ready for fresh labels, but it is still agent-labeling only.
It does not satisfy an external human or organization claim.

## Frontier Summary

The live claim status is `invalid`, and even ignoring label invalidity the
round14 data is far below the 99% one-sided 95% confidence threshold. The
frontier report computes the per-rule lower-bound frontier: the minimum number
of additional zero-failure labeled trials each rule would need from the current
state before the rule-level lower-bound gate alone could pass.

```text
CELLFENCE_PRIVATE_IMPORT: 297
CELLFENCE_UNDECLARED_CONSUMER: 895
CELLFENCE_UNSUPPORTED_DYNAMIC_IMPORT: 290
CELLFENCE_UNSUPPORTED_DYNAMIC_REQUIRE: 448
CELLFENCE_UNRESOLVED_IMPORT: 299
CELLFENCE_UNDECLARED_RESOURCE_ACCESS: 909
CELLFENCE_UNRESOLVED_RESOURCE_ACCESS: 626
```

Repository balance also fails the 10% contribution cap:

```text
jest: add at least 180 outside-repository trials
vue-core: add at least 110 outside-repository trials
remix: add at least 50 outside-repository trials
```

These are not tuning targets for the same corpus. They are the minimum evidence
frontier for a separate holdout.

## Candidate Pool

The 200-repository production-scope bundle contains substantial candidate
material after filtering to the claim's blocking severity set (`error`):

```text
included findings: 24359
sampled included findings: 445
claim-ready included findings: 0
raw precision-eligible included findings: 0
requirement counts: {"reviewed_manifest_required":24359}
```

Every included candidate finding in that bundle comes from an infer-generated
manifest. Therefore the bundle is useful for selecting repositories to review,
but none of its findings can enter a precision claim until the relevant
manifest is reviewed and frozen as a copied manifest.

`CELLFENCE_UNSUPPORTED_DYNAMIC_IMPORT` and
`CELLFENCE_UNSUPPORTED_DYNAMIC_REQUIRE` are more syntax-evidence-like than
manifest-policy-like: they detect computed module-load expressions that
CellFence cannot statically resolve. They may support a separate
`syntax_evidence_precision` study in the future, but that claim must not be
described as architecture policy precision, repository defects, or reviewed
manifest boundary precision. The current 200-repository production-scope bundle
is still not sufficient for that separate claim because it was produced from a
dirty harness, has no sealed worklist or labels, and contains only 118 dynamic
findings before sampling.

Top review candidates by sampled included findings:

```text
vuejs-vue-cli: 24 sampled / 58 total
gitlawb-openclaude: 23 sampled / 9183 total
floating-ui-floating-ui: 15 sampled / 58 total
tanstack-table: 14 sampled / 299 total
gitroomhq-postiz-app: 14 sampled / 239 total
ajaxorg-ace: 13 sampled / 1179 total
heyputer-puter: 13 sampled / 219 total
react-create-react-app: 12 sampled / 62 total
```

These are review queues, not proof rows. The next confirmation corpus should
prefer subjects whose boundary evidence can be reviewed from package/workspace
metadata, Nx/dependency-cruiser/ESLint boundaries, CODEOWNERS, or explicit
package exports.

## Required Next Step

Do not try to make the old labels pass. The next valid sequence is:

1. Freeze a separate holdout from candidate subjects.
2. Review and copy manifests for that holdout before seeing fresh labels.
3. Generate a sealed blind worklist from the unlabeled holdout bundle.
4. Collect two independent labels per finding.
5. Generate a sealed adjudication worklist for disagreements.
6. Run claim preflight and claim report.
7. Report `insufficient_evidence` unless occurrence, rule-level,
   unique-fingerprint, repository-macro, and repository-cap gates all pass.
