# Analysis Coverage And Blind Spots

`cellfence coverage` reports the repository surface that CellFence could not analyze with confidence. It is a visibility report over the same parser, resolver, resource-adapter, manifest, baseline, and runtime-evidence inputs used by `cellfence check`.

The command does not grant exceptions and does not replace `check` or `baseline check`. Use it to make blind spots explicit before tightening a manifest, adding an adapter, supplying runtime evidence, or deciding that an unsupported pattern needs an ordinary reviewed waiver.

## Command

```bash
npx cellfence coverage \
  --manifest cellfence.manifest.json \
  --baseline cellfence.baseline.json \
  --evidence resource-evidence.json \
  --format human
```

Supported output forms:

- `--json` or the default format writes a `cellfence.coverage.v1` report.
- `--format human` prints a grouped terminal summary.
- `--format sarif` emits SARIF for code-scanning style review.
- `--coverage-output coverage.json` writes the JSON report, or SARIF when `--format sarif` is selected, to a file.
- `--fail-under 0.95` or `CELLFENCE_COVERAGE_FAIL_UNDER=0.95` exits non-zero when the computed coverage ratio is lower than the threshold.

Example human output:

```text
cellfence coverage: 95.35% (1189/1247 files analysed, 49 unresolved observations)
```

## What Counts As Unresolved

Coverage observations are grouped into three buckets:

- **Unresolved imports** — computed dynamic imports, computed CommonJS `require()` calls, unresolved local specifiers, and parser diagnostics that prevent reliable boundary analysis.
- **Unresolved resources** — dynamic or unsupported file, SQL, ORM, queue, broker, route, or runtime-evidence shapes that cannot be safely mapped to a declared `resourceContracts` selector or accepted baseline resource.
- **Unresolved public surface** — public entries whose declaration-facing shape cannot be fingerprinted well enough for the baseline ratchet.

Ordinary rule findings that do not represent analysis visibility, such as a plugin warning or an intentional policy violation, do not reduce the coverage ratio.

## How To Improve Coverage

Typical remediation paths are:

- rewrite computed imports or resource names into static, reviewable forms;
- add explicit `resourceContracts` for intentional high-value couplings;
- let the baseline grandfather known existing resources, then review only new deltas;
- pass runtime evidence through `--evidence` for resources that are only visible while tests or services run;
- enable built-in adapters that match the stack, or write a programmatic adapter with `@cellfence/plugin-api`;
- use a short-lived signed waiver only when the blind spot is reviewed and temporary.

## Relationship To `init --infer`

`cellfence init --from ...` and `cellfence init --preset ...` create a natural starting manifest. `cellfence coverage` is the follow-up visibility loop: run it after the first checks, look at unresolved imports/resources/public surface, and decide whether the manifest, source shape, adapter set, or runtime evidence should change.

The coverage report intentionally stays diagnostic. It does not auto-edit manifests, create baselines, or infer ownership from unsupported code paths.
