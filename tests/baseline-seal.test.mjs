import assert from "node:assert/strict";
import test from "node:test";

import {
  BASELINE_ED25519_PUBLIC_KEY_ENV,
  BASELINE_HMAC_KEY_ENV,
  sealBaselineIfConfigured,
  validateBaselineSealFindings,
} from "../packages/engine/dist/baseline-seal.js";

test("baseline HMAC verifier rejects malformed digest strings before timing-safe comparison", () => {
  const previousSecret = process.env[BASELINE_HMAC_KEY_ENV];
  const previousPublicKey = process.env[BASELINE_ED25519_PUBLIC_KEY_ENV];
  try {
    delete process.env[BASELINE_ED25519_PUBLIC_KEY_ENV];
    process.env[BASELINE_HMAC_KEY_ENV] = "test-baseline-secret";
    const manifest = {
      schemaVersion: "cellfence.manifest.v1",
      cells: [],
    };
    const baseline = sealBaselineIfConfigured({
      schemaVersion: "cellfence.baseline.v1",
      generatedAt: "2026-01-01T00:00:00.000Z",
      cells: {},
    });
    assert.equal(baseline.seal?.algorithm, "hmac-sha256");
    const digest = baseline.seal.digest;

    for (const malformedDigest of [digest.toUpperCase(), `${digest}0`, digest.slice(1), "not-hex"]) {
      const findings = validateBaselineSealFindings(
        manifest,
        {
          ...baseline,
          seal: {
            ...baseline.seal,
            digest: malformedDigest,
          },
        },
        "cellfence.baseline.json",
        true,
      );
      assert.deepEqual(findings.map((finding) => finding.ruleId), ["CELLFENCE_BASELINE_SEAL_INVALID"]);
    }
  } finally {
    if (previousSecret === undefined) delete process.env[BASELINE_HMAC_KEY_ENV];
    else process.env[BASELINE_HMAC_KEY_ENV] = previousSecret;
    if (previousPublicKey === undefined) delete process.env[BASELINE_ED25519_PUBLIC_KEY_ENV];
    else process.env[BASELINE_ED25519_PUBLIC_KEY_ENV] = previousPublicKey;
  }
});
