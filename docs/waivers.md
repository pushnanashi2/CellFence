# Signed Waivers

CellFence waivers are signed, time-boxed exceptions. A source comment is only a pointer to an external attestation; `approved-by` text in source is treated as self-claimed request metadata and never as approval.

## Flow

1. Generate a request:

```bash
cellfence waivers request \
  --rule CELLFENCE_UNRESOLVED_IMPORT \
  --file src/core/public.ts \
  --line 12 \
  --expires 2026-09-30 \
  --reason "temporary migration while the public entry is split" \
  --approved-by owner \
  --json > waiver-request.json
```

2. Put the returned source directive immediately before the finding line:

```ts
// cellfence-ignore CELLFENCE_UNRESOLVED_IMPORT attestation:waiver-2026-09-core-import
import { legacy } from "./legacy";
```

3. Sign the request from a trusted approval environment:

```bash
CELLFENCE_WAIVER_ATTESTATION_HMAC_KEY="$WAIVER_SIGNING_SECRET" \
CELLFENCE_REPOSITORY_IDENTITY="git@github.com:owner/repo.git" \
cellfence waivers sign \
  --from waiver-request.json \
  --attestation-id waiver-2026-09-core-import \
  --finding-fingerprint <active-finding-sha256> \
  --output .cellfence/waiver-attestations/waiver-2026-09-core-import.json
```

4. Verify in CI:

```bash
CELLFENCE_APPROVERS="owner,security-reviewer" \
CELLFENCE_WAIVER_ATTESTATION_HMAC_KEY="$WAIVER_VERIFY_SECRET" \
CELLFENCE_REPOSITORY_IDENTITY="git@github.com:owner/repo.git" \
cellfence check
```

## Attestation Binding

`cellfence.waiver-attestation.v1` is signed with HMAC-SHA256 over canonical JSON without the `signature` field. Validation requires:

- `attestation:<id>` in source and a matching entry in `.cellfence/waiver-attestations.json` or `.cellfence/waiver-attestations/*.json`.
- `repository`, `headSha`, `sourceSha256`, `filePath`, `line`, `ruleId`, and `findingFingerprint` match the evaluated repository state.
- The directive line is immediately before the attested finding line.
- `expiresAt` is not expired and is at most 90 days from evaluation.
- `approver` appears in trusted `CELLFENCE_APPROVERS`.
- `signature.digest` verifies with `CELLFENCE_WAIVER_ATTESTATION_HMAC_KEY`, and `signature.keyId` matches `CELLFENCE_WAIVER_ATTESTATION_HMAC_KEY_ID` when configured.

Required rules (`CORE_REQUIRED_RULES` plus `governance.requiredRules`) cannot be waived. Attempts are reported as `CELLFENCE_WAIVER_INVALID`.

## Secret Handling

Do not expose `CELLFENCE_WAIVER_ATTESTATION_HMAC_KEY` to untrusted pull-request code. Treat it like a signing credential: use it only in a trusted approval job, an isolated verifier, or an external signing service. PR checks may verify signed waivers only when the secret is protected from repository-controlled scripts.

Use `CELLFENCE_WAIVER_ATTESTATIONS` to point validation at one or more files/directories, separated by the platform path delimiter. Otherwise CellFence reads `.cellfence/waiver-attestations.json` and `.cellfence/waiver-attestations/*.json`.
