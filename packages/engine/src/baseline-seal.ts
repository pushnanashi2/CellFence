import crypto from "node:crypto";

import type { BaselineSeal, CellFenceBaseline, CellFenceManifest } from "@cellfence/schema";
import { humanResolution } from "./findings.js";
import { stableCanonicalJson } from "./governance/canonicalization.js";
import type { Finding } from "./types.js";

export const BASELINE_HMAC_KEY_ENV = "CELLFENCE_BASELINE_HMAC_KEY";
export const BASELINE_HMAC_KEY_ID_ENV = "CELLFENCE_BASELINE_HMAC_KEY_ID";
export const BASELINE_ED25519_PRIVATE_KEY_ENV = "CELLFENCE_BASELINE_ED25519_PRIVATE_KEY";
export const BASELINE_ED25519_PUBLIC_KEY_ENV = "CELLFENCE_BASELINE_ED25519_PUBLIC_KEY";
export const BASELINE_ED25519_KEY_ID_ENV = "CELLFENCE_BASELINE_ED25519_KEY_ID";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function baselineWithoutSeal(baseline: CellFenceBaseline): Omit<CellFenceBaseline, "seal"> {
  const { seal: _seal, ...unsignedBaseline } = baseline;
  return unsignedBaseline;
}

type BaselineSealMetadata = Pick<BaselineSeal, "algorithm" | "keyId" | "payloadVersion">;

const BASELINE_SEAL_PAYLOAD_VERSION = "seal-metadata-v1" as const;

function baselineSealMetadata(seal: BaselineSeal): BaselineSealMetadata | undefined {
  const payloadVersion = (seal as { payloadVersion?: string }).payloadVersion;
  if (payloadVersion === undefined) return undefined;
  if (payloadVersion !== BASELINE_SEAL_PAYLOAD_VERSION) {
    throw new Error(`unsupported baseline seal payloadVersion ${payloadVersion}`);
  }
  return {
    algorithm: seal.algorithm,
    ...(seal.keyId ? { keyId: seal.keyId } : {}),
    payloadVersion: BASELINE_SEAL_PAYLOAD_VERSION,
  };
}

function baselineSealPayloadValue(
  baseline: CellFenceBaseline | Omit<CellFenceBaseline, "seal">,
  sealMetadata?: BaselineSealMetadata,
): Omit<CellFenceBaseline, "seal"> | (Omit<CellFenceBaseline, "seal"> & { seal: BaselineSealMetadata }) {
  const unsignedBaseline = "seal" in baseline ? baselineWithoutSeal(baseline) : baseline;
  return sealMetadata ? { ...unsignedBaseline, seal: sealMetadata } : unsignedBaseline;
}

function baselineHmacDigest(
  baseline: CellFenceBaseline | Omit<CellFenceBaseline, "seal">,
  secret: string,
  sealMetadata?: BaselineSealMetadata,
): string {
  return crypto
    .createHmac("sha256", secret)
    .update(stableCanonicalJson(baselineSealPayloadValue(baseline, sealMetadata)))
    .digest("hex");
}

function timingSafeHexEqual(left: string, right: string): boolean {
  if (!/^[a-f0-9]{64}$/.test(left) || !/^[a-f0-9]{64}$/.test(right)) return false;
  const leftBuffer = Buffer.from(left, "hex");
  const rightBuffer = Buffer.from(right, "hex");
  return leftBuffer.length === rightBuffer.length && crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function baselineSealPayload(
  baseline: CellFenceBaseline | Omit<CellFenceBaseline, "seal">,
  sealMetadata?: BaselineSealMetadata,
): Buffer {
  return Buffer.from(stableCanonicalJson(baselineSealPayloadValue(baseline, sealMetadata)), "utf8");
}

function baselineKeyMaterial(value: string): string {
  return value.includes("\\n") ? value.replace(/\\n/g, "\n") : value;
}

function configuredHmacSecret(): string | undefined {
  const secret = process.env[BASELINE_HMAC_KEY_ENV];
  if (secret === undefined || secret.trim().length === 0) return undefined;
  return secret;
}

function baselineEd25519Signature(
  baseline: CellFenceBaseline | Omit<CellFenceBaseline, "seal">,
  privateKeyPem: string,
  sealMetadata?: BaselineSealMetadata,
): string {
  const key = crypto.createPrivateKey(baselineKeyMaterial(privateKeyPem));
  return crypto.sign(null, baselineSealPayload(baseline, sealMetadata), key).toString("base64");
}

function baselineEd25519SignatureValid(baseline: CellFenceBaseline, publicKeyPem: string): boolean {
  if (baseline.seal?.algorithm !== "ed25519") return false;
  const key = crypto.createPublicKey(baselineKeyMaterial(publicKeyPem));
  return crypto.verify(null, baselineSealPayload(baseline, baselineSealMetadata(baseline.seal)), key, Buffer.from(baseline.seal.signature, "base64"));
}

export function sealBaselineIfConfigured(baseline: CellFenceBaseline): CellFenceBaseline {
  const privateKey = process.env[BASELINE_ED25519_PRIVATE_KEY_ENV];
  if (privateKey) {
    const unsignedBaseline = baselineWithoutSeal(baseline);
    const sealMetadata = {
      algorithm: "ed25519",
      ...(process.env[BASELINE_ED25519_KEY_ID_ENV] ? { keyId: process.env[BASELINE_ED25519_KEY_ID_ENV] } : {}),
      payloadVersion: BASELINE_SEAL_PAYLOAD_VERSION,
    } satisfies BaselineSealMetadata;
    return {
      ...unsignedBaseline,
      seal: {
        ...sealMetadata,
        signature: baselineEd25519Signature(unsignedBaseline, privateKey, sealMetadata),
      },
    };
  }
  const secret = configuredHmacSecret();
  if (!secret) return baseline;
  const unsignedBaseline = baselineWithoutSeal(baseline);
  const sealMetadata = {
    algorithm: "hmac-sha256",
    ...(process.env[BASELINE_HMAC_KEY_ID_ENV] ? { keyId: process.env[BASELINE_HMAC_KEY_ID_ENV] } : {}),
    payloadVersion: BASELINE_SEAL_PAYLOAD_VERSION,
  } satisfies BaselineSealMetadata;
  return {
    ...unsignedBaseline,
    seal: {
      ...sealMetadata,
      digest: baselineHmacDigest(unsignedBaseline, secret, sealMetadata),
    },
  };
}

function configuredSealVerifier(): "ed25519" | "hmac-sha256" | undefined {
  if (process.env[BASELINE_ED25519_PUBLIC_KEY_ENV]) return "ed25519";
  if (configuredHmacSecret()) return "hmac-sha256";
  return undefined;
}

function verifierResolutionDetails(extra?: Record<string, unknown>): Record<string, unknown> {
  return {
    ed25519PublicKeyEnv: BASELINE_ED25519_PUBLIC_KEY_ENV,
    ed25519PrivateKeyEnv: BASELINE_ED25519_PRIVATE_KEY_ENV,
    hmacKeyEnv: BASELINE_HMAC_KEY_ENV,
    signCommand: "cellfence baseline sign --baseline cellfence.baseline.json",
    ...extra,
  };
}

function configureVerifierResolutions(extra?: Record<string, unknown>): Finding["suggestedResolutions"] {
  const details = verifierResolutionDetails(extra);
  return [
    humanResolution(`Configure baseline check with ${BASELINE_ED25519_PUBLIC_KEY_ENV} or ${BASELINE_HMAC_KEY_ENV}`, details),
    humanResolution(`Sign the accepted baseline with ${BASELINE_ED25519_PRIVATE_KEY_ENV} or ${BASELINE_HMAC_KEY_ENV}`, details),
  ];
}

export function validateBaselineSealFindings(
  manifest: CellFenceManifest,
  baseline: CellFenceBaseline,
  baselinePath: string,
  requireConfiguredVerifier = false,
): Finding[] {
  const findings: Finding[] = [];
  const secret = configuredHmacSecret();
  const publicKey = process.env[BASELINE_ED25519_PUBLIC_KEY_ENV];
  const verifier = configuredSealVerifier();
  const lockedCells = manifest.cells.filter((cell) => cell.locked);
  if (!verifier && lockedCells.length > 0) {
    findings.push({
      ruleId: "CELLFENCE_BASELINE_SEAL_INVALID",
      severity: "error",
      filePath: baselinePath,
      message: `locked cells require ${BASELINE_ED25519_PUBLIC_KEY_ENV} or ${BASELINE_HMAC_KEY_ENV} during baseline check`,
      details: { lockedCells: lockedCells.map((cell) => cell.id) },
      suggestedResolutions: configureVerifierResolutions({ lockedCells: lockedCells.map((cell) => cell.id) }),
    });
    return findings;
  }
  if (!verifier) {
    if (baseline.seal) {
      findings.push({
        ruleId: "CELLFENCE_BASELINE_SEAL_INVALID",
        severity: "error",
        filePath: baselinePath,
        message: `baseline has a seal but no verifier is configured; set ${BASELINE_ED25519_PUBLIC_KEY_ENV} or ${BASELINE_HMAC_KEY_ENV}`,
        details: { algorithm: baseline.seal.algorithm, keyId: baseline.seal.keyId },
        suggestedResolutions: [
          humanResolution(`Configure baseline check with the verifier for ${baseline.seal.algorithm}`, verifierResolutionDetails({
            algorithm: baseline.seal.algorithm,
            keyId: baseline.seal.keyId,
          })),
        ],
      });
    } else if (requireConfiguredVerifier) {
      findings.push({
        ruleId: "CELLFENCE_BASELINE_SEAL_INVALID",
        severity: "error",
        filePath: baselinePath,
        message: `baseline verification requires ${BASELINE_ED25519_PUBLIC_KEY_ENV} or ${BASELINE_HMAC_KEY_ENV}`,
        suggestedResolutions: configureVerifierResolutions(),
      });
    }
    return findings;
  }
  if (!baseline.seal) {
    findings.push({
      ruleId: "CELLFENCE_BASELINE_SEAL_INVALID",
      severity: "error",
      filePath: baselinePath,
      message: "baseline is not sealed; sign the baseline before enabling sealed baseline verification",
      suggestedResolutions: [
        humanResolution(`Sign the accepted baseline with ${BASELINE_ED25519_PRIVATE_KEY_ENV} or ${BASELINE_HMAC_KEY_ENV}`, verifierResolutionDetails()),
      ],
    });
    return findings;
  }
  if (verifier === "ed25519") {
    if (baseline.seal.algorithm !== "ed25519") {
      findings.push({
        ruleId: "CELLFENCE_BASELINE_SEAL_INVALID",
        severity: "error",
        filePath: baselinePath,
        message: "baseline seal algorithm does not match the configured Ed25519 verifier",
        details: { algorithm: baseline.seal.algorithm, keyId: baseline.seal.keyId },
      });
      return findings;
    }
    try {
      if (publicKey && baselineEd25519SignatureValid(baseline, publicKey)) return findings;
    } catch (error) {
      findings.push({
        ruleId: "CELLFENCE_BASELINE_SEAL_INVALID",
        severity: "error",
        filePath: baselinePath,
        message: `baseline Ed25519 seal could not be verified: ${errorMessage(error)}`,
        details: { algorithm: baseline.seal.algorithm, keyId: baseline.seal.keyId },
      });
      return findings;
    }
    findings.push({
      ruleId: "CELLFENCE_BASELINE_SEAL_INVALID",
      severity: "error",
      filePath: baselinePath,
      message: "baseline Ed25519 seal does not match the checked baseline content",
      details: { algorithm: baseline.seal.algorithm, keyId: baseline.seal.keyId },
    });
    return findings;
  }
  if (baseline.seal.algorithm !== "hmac-sha256") {
    findings.push({
      ruleId: "CELLFENCE_BASELINE_SEAL_INVALID",
      severity: "error",
      filePath: baselinePath,
      message: "baseline seal algorithm does not match the configured HMAC verifier",
      details: { algorithm: baseline.seal.algorithm, keyId: baseline.seal.keyId },
    });
    return findings;
  }
  let expectedDigest: string;
  try {
    expectedDigest = baselineHmacDigest(baseline, secret as string, baselineSealMetadata(baseline.seal));
  } catch (error) {
    findings.push({
      ruleId: "CELLFENCE_BASELINE_SEAL_INVALID",
      severity: "error",
      filePath: baselinePath,
      message: `baseline HMAC seal could not be verified: ${errorMessage(error)}`,
      details: { algorithm: baseline.seal.algorithm, keyId: baseline.seal.keyId, payloadVersion: baseline.seal.payloadVersion },
    });
    return findings;
  }
  if (!timingSafeHexEqual(baseline.seal.digest, expectedDigest)) {
    findings.push({
      ruleId: "CELLFENCE_BASELINE_SEAL_INVALID",
      severity: "error",
      filePath: baselinePath,
      message: "baseline HMAC seal does not match the checked baseline content",
      details: { algorithm: baseline.seal.algorithm, keyId: baseline.seal.keyId },
    });
  }
  return findings;
}
