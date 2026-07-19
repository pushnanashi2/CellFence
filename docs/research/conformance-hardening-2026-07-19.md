# Conformance Hardening - 2026-07-19

This note records the post-engine-split conformance baseline. It is a regression
guard for product behavior, not an external precision claim.

## Scope

The standalone conformance ledgers now cover:

| Suite | Purpose |
| --- | --- |
| `imports` | Import syntax, public/private surfaces, dynamic import/require diagnostics |
| `resolution` | Relative, package, subpath, package imports, tsconfig paths, Python source-root resolution |
| `ownership` | Segment-aware path ownership, overlap detection, public entries, artifact ownership, strict coverage |
| `public-surface` | TypeScript and Python public symbol extraction plus manifest mismatch diagnostics |
| `resources` | Static and runtime resource contract enforcement across file, HTTP, database, and queue observations |
| `ratchet` | Baseline comparison and locked baseline update guard behavior |
| `malformed` | Fail-closed handling for invalid manifests, baselines, resource evidence, and waivers |

Run the full conformance baseline with:

```sh
npm run conformance:all
```

## Claim Boundary

These suites demonstrate that CellFence's declared policy mechanics are stable
on controlled fixtures. They do not claim precision on arbitrary public OSS.
Precision claims still require reviewed manifests, frozen corpus artifacts,
labels, adjudication, and a passing research claim report.

## Maintenance Rule

When changing resolver, ownership, public-surface, resource, baseline, or input
validation behavior, update the corresponding JSON ledger in the same patch and
run the targeted suite before the full gate set.
