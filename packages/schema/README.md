# @cellfence/schema

Schema constants, TypeScript types, and strict validators for CellFence manifests, governance coverage, rule severity policy, baselines, and resource evidence.

Waiver attestation JSON (`cellfence.waiver-attestation.v1` and `cellfence.waiver-attestations.v1`) is currently validated by `@cellfence/engine` because verification depends on repository HEAD, source hashes, trusted environment variables, and HMAC secrets. A standalone JSON Schema export is intentionally not published until that trust-bound validation contract is split from runtime verification.

See the main CellFence README: https://github.com/pushnanashi2/CellFence#readme
