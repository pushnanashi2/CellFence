import crypto from "node:crypto";

import type { CellFenceBaseline, CellFenceManifest } from "@cellfence/schema";
import { stableCanonicalJson } from "./governance/canonicalization.js";
import type { Finding } from "./index.js";

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

function baselineHmacDigest(baseline: CellFenceBaseline | Omit<CellFenceBaseline, "seal">, secret: string): string {
  return crypto
    .createHmac("sha256", secret)
    .update(stableCanonicalJson("seal" in baseline ? baselineWithoutSeal(baseline) : baseline))
    .digest("hex");
}

function baselineSealPayload(baseline: CellFenceBaseline | Omit<CellFenceBaseline, "seal">): Buffer {
  return Buffer.from(stableCanonicalJson("seal" in baseline ? baselineWithoutSeal(baseline) : baseline), "utf8");
}

function baselineKeyMaterial(value: string): string {
  return value.includes("\\n") ? value.replace(/\\n/g, "\n") : value;
}

function baselineEd25519Signature(baseline: CellFenceBaseline | Omit<CellFenceBaseline, "seal">, privateKeyPem: string): string {
  const key = crypto.createPrivateKey(baselineKeyMaterial(privateKeyPem));
  return crypto.sign(null, baselineSealPayload(baseline), key).toString("base64");
}

function baselineEd25519SignatureValid(baseline: CellFenceBaseline, publicKeyPem: string): boolean {
  if (baseline.seal?.algorithm !== "ed25519") return false;
  const key = crypto.createPublicKey(baselineKeyMaterial(publicKeyPem));
  return crypto.verify(null, baselineSealPayload(baseline), key, Buffer.from(baseline.seal.signature, "base64"));
}

export function sealBaselineIfConfigured(baseline: CellFenceBaseline): CellFenceBaseline {
  const privateKey = process.env[BASELINE_ED25519_PRIVATE_KEY_ENV];
  if (privateKey) {
    const unsignedBaseline = baselineWithoutSeal(baseline);
    return {
      ...unsignedBaseline,
      seal: {
        algorithm: "ed25519",
        ...(process.env[BASELINE_ED25519_KEY_ID_ENV] ? { keyId: process.env[BASELINE_ED25519_KEY_ID_ENV] } : {}),
        signature: baselineEd25519Signature(unsignedBaseline, privateKey),
      },
    };
  }
  const secret = process.env[BASELINE_HMAC_KEY_ENV];
  if (!secret) return baseline;
  const unsignedBaseline = baselineWithoutSeal(baseline);
  return {
    ...unsignedBaseline,
    seal: {
      algorithm: "hmac-sha256",
      ...(process.env[BASELINE_HMAC_KEY_ID_ENV] ? { keyId: process.env[BASELINE_HMAC_KEY_ID_ENV] } : {}),
      digest: baselineHmacDigest(unsignedBaseline, secret),
    },
  };
}

function configuredSealVerifier(): "ed25519" | "hmac-sha256" | undefined {
  if (process.env[BASELINE_ED25519_PUBLIC_KEY_ENV]) return "ed25519";
  if (process.env[BASELINE_HMAC_KEY_ENV]) return "hmac-sha256";
  return undefined;
}

export function validateBaselineSealFindings(
  manifest: CellFenceManifest,
  baseline: CellFenceBaseline,
  baselinePath: string,
  requireConfiguredVerifier = false,
): Finding[] {
  const findings: Finding[] = [];
  const secret = process.env[BASELINE_HMAC_KEY_ENV];
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
      });
    } else if (requireConfiguredVerifier) {
      findings.push({
        ruleId: "CELLFENCE_BASELINE_SEAL_INVALID",
        severity: "error",
        filePath: baselinePath,
        message: `baseline verification requires ${BASELINE_ED25519_PUBLIC_KEY_ENV} or ${BASELINE_HMAC_KEY_ENV}`,
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
  const expectedDigest = baselineHmacDigest(baseline, secret as string);
  if (baseline.seal.digest !== expectedDigest) {
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
