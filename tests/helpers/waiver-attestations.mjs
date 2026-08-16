import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { waiverAttestationHmacDigest } from "../../packages/engine/dist/waivers.js";

export const TEST_WAIVER_APPROVER = "test-owner";
export const TEST_WAIVER_SECRET = "cellfence-test-waiver-attestation-secret";

export function waiverRepositoryIdentity(rootDir) {
  return `file://${path.resolve(rootDir)}`;
}

function normalizePath(filePath) {
  return filePath.replace(/\\/g, "/");
}

export function gitOutput(rootDir, args) {
  return execFileSync("git", args, {
    cwd: rootDir,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

export function initGitRepo(rootDir) {
  if (!fs.existsSync(path.join(rootDir, ".git"))) {
    try {
      gitOutput(rootDir, ["init", "-q", "-b", "main"]);
    } catch {
      gitOutput(rootDir, ["init", "-q"]);
    }
  }
  gitOutput(rootDir, ["config", "user.email", "test@example.com"]);
  gitOutput(rootDir, ["config", "user.name", "Test User"]);
  gitOutput(rootDir, ["add", "."]);
  gitOutput(rootDir, ["commit", "--allow-empty", "-qm", "fixture"]);
  return gitOutput(rootDir, ["rev-parse", "--verify", "--end-of-options", "HEAD^{commit}"]);
}

export function currentGitHead(rootDir) {
  return gitOutput(rootDir, ["rev-parse", "--verify", "--end-of-options", "HEAD^{commit}"]);
}

export function waiverEnv(rootDir, overrides = {}) {
  const env = {
    CELLFENCE_APPROVERS: TEST_WAIVER_APPROVER,
    CELLFENCE_WAIVER_ATTESTATION_HMAC_KEY: TEST_WAIVER_SECRET,
    CELLFENCE_REPOSITORY_IDENTITY: waiverRepositoryIdentity(rootDir),
    ...overrides,
  };
  if (env.CELLFENCE_WAIVER_ATTESTATION_HMAC_KEY_ID === undefined) {
    delete env.CELLFENCE_WAIVER_ATTESTATION_HMAC_KEY_ID;
  }
  return env;
}

export function withWaiverEnv(rootDir, callback, overrides = {}) {
  const patch = waiverEnv(rootDir, overrides);
  const keys = [
    "CELLFENCE_APPROVERS",
    "CELLFENCE_WAIVER_ATTESTATION_HMAC_KEY",
    "CELLFENCE_WAIVER_ATTESTATION_HMAC_KEY_ID",
    "CELLFENCE_WAIVER_ATTESTATIONS",
    "CELLFENCE_REPOSITORY_IDENTITY",
  ];
  const original = new Map(keys.map((key) => [key, process.env[key]]));
  try {
    for (const key of keys) {
      if (Object.hasOwn(patch, key) && patch[key] !== undefined) process.env[key] = patch[key];
      else delete process.env[key];
    }
    return callback();
  } finally {
    for (const key of keys) {
      const value = original.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

export function readWaiverAttestationFile(rootDir) {
  const filePath = path.join(rootDir, ".cellfence/waiver-attestations.json");
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

export function writeWaiverAttestationFile(rootDir, attestations) {
  const filePath = path.join(rootDir, ".cellfence/waiver-attestations.json");
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(
    filePath,
    `${JSON.stringify({
      schemaVersion: "cellfence.waiver-attestations.v1",
      attestations,
    }, null, 2)}\n`,
  );
  return filePath;
}

export function writeSignedWaiverAttestation(rootDir, values = {}, options = {}) {
  const unsignedOverrides = { ...values };
  delete unsignedOverrides.signature;
  const filePath = normalizePath(unsignedOverrides.filePath || "src/consumer/public.ts");
  const sourcePath = path.join(rootDir, filePath);
  const sourceSha256 = fs.existsSync(sourcePath)
    ? crypto.createHash("sha256").update(fs.readFileSync(sourcePath)).digest("hex")
    : "a".repeat(64);
  const unsigned = {
    schemaVersion: "cellfence.waiver-attestation.v1",
    attestationId: "waiver-test-1",
    repository: waiverRepositoryIdentity(rootDir),
    headSha: currentGitHead(rootDir),
    sourceSha256,
    ruleId: "CELLFENCE_PRIVATE_IMPORT",
    findingFingerprint: "a".repeat(64),
    filePath,
    line: 1,
    expiresAt: new Date(Date.now() + 30 * 86400 * 1000).toISOString(),
    reason: "temporary signed waiver fixture",
    approver: TEST_WAIVER_APPROVER,
    issuedAt: "2026-01-01T00:00:00.000Z",
    ...unsignedOverrides,
  };
  unsigned.filePath = normalizePath(unsigned.filePath);
  const secret = options.secret || TEST_WAIVER_SECRET;
  const signature = {
    algorithm: "hmac-sha256",
    ...(options.keyId ? { keyId: options.keyId } : {}),
    digest: waiverAttestationHmacDigest(unsigned, secret),
  };
  const attestation = { ...unsigned, signature };
  const attestationFilePath = path.join(rootDir, ".cellfence/waiver-attestations.json");
  const existing = fs.existsSync(attestationFilePath)
    ? readWaiverAttestationFile(rootDir).attestations
    : [];
  assert.ok(Array.isArray(existing), "waiver attestation fixture must contain an attestations array");
  writeWaiverAttestationFile(rootDir, [...existing, attestation]);
  return attestation;
}
