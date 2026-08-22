import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";

import {
  BASELINE_ED25519_KEY_ID_ENV,
  BASELINE_ED25519_PRIVATE_KEY_ENV,
  BASELINE_ED25519_PUBLIC_KEY_ENV,
  BASELINE_HMAC_KEY_ENV,
  BASELINE_HMAC_KEY_ID_ENV,
  sealBaselineIfConfigured,
  validateBaselineSealFindings,
} from "../packages/engine/dist/baseline-seal.js";

const legacySealCollator = new Intl.Collator("en-US", {
  usage: "sort",
  sensitivity: "variant",
  ignorePunctuation: false,
  numeric: false,
});

function legacyCanonicalJson(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return `[${value.map((item) => legacyCanonicalJson(item)).join(",")}]`;
  if (typeof value === "object") {
    return `{${Object.entries(value)
      .filter((entry) => entry[1] !== undefined)
      .sort(([left], [right]) => legacySealCollator.compare(left, right))
      .map(([key, entryValue]) => `${JSON.stringify(key)}:${legacyCanonicalJson(entryValue)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function baselineWithCellIds() {
  return {
    schemaVersion: "cellfence.baseline.v1",
    generatedAt: "2026-01-01T00:00:00.000Z",
    cellIds: ["core"],
    cells: {
      core: {
        ownedPathPatterns: 1,
        publicSymbols: 1,
        publicSurfaceLines: 1,
        crossCellDependencies: 0,
        ownedPathSet: ["src/core/**"],
        publicSymbolSet: ["core"],
        dependencyEdges: [],
        resourceAccesses: [],
        artifactContracts: [],
      },
    },
  };
}

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

test("baseline HMAC verifier accepts legacy seals without payload metadata", () => {
  const previousSecret = process.env[BASELINE_HMAC_KEY_ENV];
  const previousPublicKey = process.env[BASELINE_ED25519_PUBLIC_KEY_ENV];
  try {
    delete process.env[BASELINE_ED25519_PUBLIC_KEY_ENV];
    process.env[BASELINE_HMAC_KEY_ENV] = "test-baseline-secret";
    const unsignedBaseline = baselineWithCellIds();
    const baseline = {
      ...unsignedBaseline,
      seal: {
        algorithm: "hmac-sha256",
        keyId: "legacy-key",
        digest: crypto.createHmac("sha256", process.env[BASELINE_HMAC_KEY_ENV])
          .update(legacyCanonicalJson(unsignedBaseline))
          .digest("hex"),
      },
    };
    assert.deepEqual(
      validateBaselineSealFindings({ schemaVersion: "cellfence.manifest.v1", cells: [] }, baseline, "cellfence.baseline.json", true),
      [],
    );
  } finally {
    if (previousSecret === undefined) delete process.env[BASELINE_HMAC_KEY_ENV];
    else process.env[BASELINE_HMAC_KEY_ENV] = previousSecret;
    if (previousPublicKey === undefined) delete process.env[BASELINE_ED25519_PUBLIC_KEY_ENV];
    else process.env[BASELINE_ED25519_PUBLIC_KEY_ENV] = previousPublicKey;
  }
});

test("baseline HMAC seal binds key metadata for newly sealed baselines", () => {
  const previousSecret = process.env[BASELINE_HMAC_KEY_ENV];
  const previousKeyId = process.env[BASELINE_HMAC_KEY_ID_ENV];
  const previousPublicKey = process.env[BASELINE_ED25519_PUBLIC_KEY_ENV];
  try {
    delete process.env[BASELINE_ED25519_PUBLIC_KEY_ENV];
    process.env[BASELINE_HMAC_KEY_ENV] = "test-baseline-secret";
    process.env[BASELINE_HMAC_KEY_ID_ENV] = "key-a";
    const manifest = { schemaVersion: "cellfence.manifest.v1", cells: [] };
    const baseline = sealBaselineIfConfigured({
      schemaVersion: "cellfence.baseline.v1",
      generatedAt: "2026-01-01T00:00:00.000Z",
      cells: {},
    });

    assert.equal(baseline.seal?.payloadVersion, "seal-metadata-v1");
    assert.deepEqual(validateBaselineSealFindings(manifest, baseline, "cellfence.baseline.json", true), []);
    const tamperedKeyId = {
      ...baseline,
      seal: {
        ...baseline.seal,
        keyId: "key-b",
      },
    };
    assert.deepEqual(
      validateBaselineSealFindings(manifest, tamperedKeyId, "cellfence.baseline.json", true).map((finding) => finding.ruleId),
      ["CELLFENCE_BASELINE_SEAL_INVALID"],
    );
  } finally {
    if (previousSecret === undefined) delete process.env[BASELINE_HMAC_KEY_ENV];
    else process.env[BASELINE_HMAC_KEY_ENV] = previousSecret;
    if (previousKeyId === undefined) delete process.env[BASELINE_HMAC_KEY_ID_ENV];
    else process.env[BASELINE_HMAC_KEY_ID_ENV] = previousKeyId;
    if (previousPublicKey === undefined) delete process.env[BASELINE_ED25519_PUBLIC_KEY_ENV];
    else process.env[BASELINE_ED25519_PUBLIC_KEY_ENV] = previousPublicKey;
  }
});

test("baseline Ed25519 verifier accepts legacy seals without payload metadata", () => {
  const previousPrivateKey = process.env[BASELINE_ED25519_PRIVATE_KEY_ENV];
  const previousPublicKey = process.env[BASELINE_ED25519_PUBLIC_KEY_ENV];
  const previousKeyId = process.env[BASELINE_ED25519_KEY_ID_ENV];
  const previousSecret = process.env[BASELINE_HMAC_KEY_ENV];
  try {
    delete process.env[BASELINE_HMAC_KEY_ENV];
    const pair = crypto.generateKeyPairSync("ed25519");
    const privatePem = pair.privateKey.export({ type: "pkcs8", format: "pem" });
    const publicPem = pair.publicKey.export({ type: "spki", format: "pem" });
    const unsignedBaseline = baselineWithCellIds();
    const baseline = {
      ...unsignedBaseline,
      seal: {
        algorithm: "ed25519",
        keyId: "legacy-ed-key",
        signature: crypto.sign(null, Buffer.from(legacyCanonicalJson(unsignedBaseline), "utf8"), String(privatePem)).toString("base64"),
      },
    };
    process.env[BASELINE_ED25519_PUBLIC_KEY_ENV] = String(publicPem);

    assert.deepEqual(
      validateBaselineSealFindings({ schemaVersion: "cellfence.manifest.v1", cells: [] }, baseline, "cellfence.baseline.json", true),
      [],
    );
  } finally {
    if (previousPrivateKey === undefined) delete process.env[BASELINE_ED25519_PRIVATE_KEY_ENV];
    else process.env[BASELINE_ED25519_PRIVATE_KEY_ENV] = previousPrivateKey;
    if (previousPublicKey === undefined) delete process.env[BASELINE_ED25519_PUBLIC_KEY_ENV];
    else process.env[BASELINE_ED25519_PUBLIC_KEY_ENV] = previousPublicKey;
    if (previousKeyId === undefined) delete process.env[BASELINE_ED25519_KEY_ID_ENV];
    else process.env[BASELINE_ED25519_KEY_ID_ENV] = previousKeyId;
    if (previousSecret === undefined) delete process.env[BASELINE_HMAC_KEY_ENV];
    else process.env[BASELINE_HMAC_KEY_ENV] = previousSecret;
  }
});

test("baseline Ed25519 seal binds key metadata for newly sealed baselines", () => {
  const previousPrivateKey = process.env[BASELINE_ED25519_PRIVATE_KEY_ENV];
  const previousPublicKey = process.env[BASELINE_ED25519_PUBLIC_KEY_ENV];
  const previousKeyId = process.env[BASELINE_ED25519_KEY_ID_ENV];
  const previousSecret = process.env[BASELINE_HMAC_KEY_ENV];
  try {
    delete process.env[BASELINE_HMAC_KEY_ENV];
    const pair = crypto.generateKeyPairSync("ed25519");
    const privatePem = pair.privateKey.export({ type: "pkcs8", format: "pem" });
    const publicPem = pair.publicKey.export({ type: "spki", format: "pem" });
    process.env[BASELINE_ED25519_PRIVATE_KEY_ENV] = String(privatePem);
    process.env[BASELINE_ED25519_KEY_ID_ENV] = "ed-key-a";
    const manifest = { schemaVersion: "cellfence.manifest.v1", cells: [] };
    const baseline = sealBaselineIfConfigured({
      schemaVersion: "cellfence.baseline.v1",
      generatedAt: "2026-01-01T00:00:00.000Z",
      cells: {},
    });
    delete process.env[BASELINE_ED25519_PRIVATE_KEY_ENV];
    process.env[BASELINE_ED25519_PUBLIC_KEY_ENV] = String(publicPem);

    assert.equal(baseline.seal?.payloadVersion, "seal-metadata-v1");
    assert.deepEqual(validateBaselineSealFindings(manifest, baseline, "cellfence.baseline.json", true), []);
    const tamperedKeyId = {
      ...baseline,
      seal: {
        ...baseline.seal,
        keyId: "ed-key-b",
      },
    };
    assert.deepEqual(
      validateBaselineSealFindings(manifest, tamperedKeyId, "cellfence.baseline.json", true).map((finding) => finding.ruleId),
      ["CELLFENCE_BASELINE_SEAL_INVALID"],
    );
  } finally {
    if (previousPrivateKey === undefined) delete process.env[BASELINE_ED25519_PRIVATE_KEY_ENV];
    else process.env[BASELINE_ED25519_PRIVATE_KEY_ENV] = previousPrivateKey;
    if (previousPublicKey === undefined) delete process.env[BASELINE_ED25519_PUBLIC_KEY_ENV];
    else process.env[BASELINE_ED25519_PUBLIC_KEY_ENV] = previousPublicKey;
    if (previousKeyId === undefined) delete process.env[BASELINE_ED25519_KEY_ID_ENV];
    else process.env[BASELINE_ED25519_KEY_ID_ENV] = previousKeyId;
    if (previousSecret === undefined) delete process.env[BASELINE_HMAC_KEY_ENV];
    else process.env[BASELINE_HMAC_KEY_ENV] = previousSecret;
  }
});

test("baseline Ed25519 verifier errors do not echo configured key material", () => {
  const previousPrivateKey = process.env[BASELINE_ED25519_PRIVATE_KEY_ENV];
  const previousPublicKey = process.env[BASELINE_ED25519_PUBLIC_KEY_ENV];
  const previousKeyId = process.env[BASELINE_ED25519_KEY_ID_ENV];
  const previousSecret = process.env[BASELINE_HMAC_KEY_ENV];
  try {
    delete process.env[BASELINE_HMAC_KEY_ENV];
    const pair = crypto.generateKeyPairSync("ed25519");
    const privatePem = pair.privateKey.export({ type: "pkcs8", format: "pem" });
    process.env[BASELINE_ED25519_PRIVATE_KEY_ENV] = String(privatePem);
    process.env[BASELINE_ED25519_KEY_ID_ENV] = "ed-key-a";
    const baseline = sealBaselineIfConfigured({
      schemaVersion: "cellfence.baseline.v1",
      generatedAt: "2026-01-01T00:00:00.000Z",
      cells: {},
    });
    delete process.env[BASELINE_ED25519_PRIVATE_KEY_ENV];
    const sentinel = "SECRET-PUBLIC-KEY-MATERIAL";
    process.env[BASELINE_ED25519_PUBLIC_KEY_ENV] = `-----BEGIN PUBLIC KEY-----\n${sentinel}\n-----END PUBLIC KEY-----`;

    const findings = validateBaselineSealFindings(
      { schemaVersion: "cellfence.manifest.v1", cells: [] },
      baseline,
      "cellfence.baseline.json",
      true,
    );
    assert.equal(findings.length, 1);
    assert.match(findings[0].message, /could not be verified with the configured public key/);
    assert.doesNotMatch(JSON.stringify(findings), new RegExp(sentinel));
    assert.doesNotMatch(JSON.stringify(findings), /BEGIN PUBLIC KEY/);
  } finally {
    if (previousPrivateKey === undefined) delete process.env[BASELINE_ED25519_PRIVATE_KEY_ENV];
    else process.env[BASELINE_ED25519_PRIVATE_KEY_ENV] = previousPrivateKey;
    if (previousPublicKey === undefined) delete process.env[BASELINE_ED25519_PUBLIC_KEY_ENV];
    else process.env[BASELINE_ED25519_PUBLIC_KEY_ENV] = previousPublicKey;
    if (previousKeyId === undefined) delete process.env[BASELINE_ED25519_KEY_ID_ENV];
    else process.env[BASELINE_ED25519_KEY_ID_ENV] = previousKeyId;
    if (previousSecret === undefined) delete process.env[BASELINE_HMAC_KEY_ENV];
    else process.env[BASELINE_HMAC_KEY_ENV] = previousSecret;
  }
});
