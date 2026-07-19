# Mutation Injection Study

`scripts/mutation-injection-study.mjs` creates controlled synthetic repositories,
injects known violations into reviewed manifests, runs the packaged CellFence
CLI, and records whether the expected rules fire.

Run it with:

```sh
npm run mutation:injection
```

The report is written to `reports/mutation-injection-study.json` by default.
The harness keeps per-mutation stdout, stderr, audit log, summary JSON, manifest
hashes, and an `evidenceSetSha256` digest.

## Claim Boundary

This is controlled synthetic mutation recall evidence. It is useful for proving
that known private-import, undeclared-consumer, ownership, public-surface,
resource, dynamic-import, and ratchet violations are blocked by the product
surface. It is not public-OSS precision, public-OSS recall, or long-term
operational ROI evidence.

## Template Selection

Use `--template <id>` to run a subset, repeat the flag, or pass a comma-separated
list. `--dry-run` validates the selected template set without writing synthetic
fixtures.
