const WAVING_INTO_THE_FUTURE = (() => {
  const d = new Date(Date.now() + 89 * 86400 * 1000);
  return d.toISOString().slice(0, 10);
})();

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { checkRepository } from "../packages/engine/dist/index.js";
import { collectWaiversForManifest, waiverMatchesFinding } from "../packages/engine/dist/waivers.js";
import {
  initGitRepo,
  readWaiverAttestationFile,
  TEST_WAIVER_APPROVER,
  waiverEnv,
  withWaiverEnv,
  writeSignedWaiverAttestation,
  writeWaiverAttestationFile,
} from "./helpers/waiver-attestations.mjs";

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function readManifest(rootDir) {
  return JSON.parse(fs.readFileSync(path.join(rootDir, "cellfence.manifest.json"), "utf8"));
}

function writeCollectProject(rootDir, directive, includeCell = true) {
  fs.mkdirSync(path.join(rootDir, "src/a"), { recursive: true });
  writeJson(path.join(rootDir, "cellfence.manifest.json"), {
    schemaVersion: "cellfence.manifest.v1",
    cells: includeCell
      ? [{ id: "a", ownedPaths: ["src/a/**"], publicEntry: "src/a/public.ts", publicSymbols: ["a"] }]
      : [],
  });
  fs.writeFileSync(
    path.join(rootDir, "src/a/public.ts"),
    ["export const a = 1;", directive, ""].filter((line) => line !== undefined).join("\n"),
  );
}

function writeSignedCollectProject(rootDir, values = {}) {
  const attestationId = values.attestationId || "waiver-test-1";
  const { directiveRuleId = "CELLFENCE_UNRESOLVED_IMPORT", ...attestationValues } = values;
  writeCollectProject(rootDir, `// cellfence-ignore ${directiveRuleId} attestation:${attestationId}`);
  initGitRepo(rootDir);
  writeSignedWaiverAttestation(rootDir, {
    attestationId,
    filePath: "src/a/public.ts",
    line: 3,
    ruleId: directiveRuleId,
    expiresAt: `${WAVING_INTO_THE_FUTURE}T00:00:00.000Z`,
    reason: "temporary strict allowlist test fixture",
    ...attestationValues,
  });
  return readManifest(rootDir);
}

function writeUnresolvedImportProject(rootDir, directive) {
  fs.mkdirSync(path.join(rootDir, "src/core"), { recursive: true });
  writeJson(path.join(rootDir, "cellfence.manifest.json"), {
    schemaVersion: "cellfence.manifest.v1",
    governance: {
      requireOwnership: true,
      include: ["src/**"],
      exclude: [],
    },
    cells: [{
      id: "core",
      ownedPaths: ["src/core/**"],
      publicEntry: "src/core/public.ts",
      publicSymbols: ["core"],
    }],
  });
  const lines = [
    directive,
    'import { missing } from "./missing";',
    "export const core = missing;",
    "",
  ].filter((line) => line !== undefined);
  fs.writeFileSync(path.join(rootDir, "src/core/public.ts"), lines.join("\n"));
}

function writePrivateImportProject(rootDir, directive) {
  fs.mkdirSync(path.join(rootDir, "src/producer"), { recursive: true });
  fs.mkdirSync(path.join(rootDir, "src/consumer"), { recursive: true });
  fs.writeFileSync(path.join(rootDir, "src/producer/public.ts"), "export const exposed = true;\n");
  fs.writeFileSync(path.join(rootDir, "src/producer/internal.ts"), "export const hidden = true;\n");
  fs.writeFileSync(
    path.join(rootDir, "src/consumer/public.ts"),
    [directive, 'import { hidden } from "../producer/internal";', "export const used = hidden;", ""].filter((line) => line !== undefined).join("\n"),
  );
  writeJson(path.join(rootDir, "cellfence.manifest.json"), {
    schemaVersion: "cellfence.manifest.v1",
    cells: [
      {
        id: "producer",
        ownedPaths: ["src/producer/**"],
        publicEntry: "src/producer/public.ts",
        publicSymbols: ["exposed"],
        consumes: [],
        producesArtifacts: [],
      },
      {
        id: "consumer",
        ownedPaths: ["src/consumer/**"],
        publicEntry: "src/consumer/public.ts",
        publicSymbols: ["used"],
        consumes: [{ cell: "producer" }],
        producesArtifacts: [],
      },
    ],
  });
}

function findRule(result, ruleId) {
  return [...result.findings, ...result.warnings].find((finding) => finding.ruleId === ruleId);
}

test("source approved-by is never treated as an approval", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-waiver-source-approval-"));
  try {
    writeCollectProject(
      tempDir,
      `// cellfence-ignore CELLFENCE_PRIVATE_IMPORT expires:${WAVING_INTO_THE_FUTURE} approved-by:${TEST_WAIVER_APPROVER} reason:temporary strict allowlist test fixture`,
    );
    const waivers = withWaiverEnv(tempDir, () => collectWaiversForManifest(tempDir, readManifest(tempDir)));
    assert.equal(waivers.length, 1);
    assert.equal(waivers[0].valid, false);
    assert.equal(waivers[0].untrustedApprover, false);
    assert.ok(waivers[0].errors.includes("signed waiver attestation is required; source approved-by is a request only"));
    assert.ok(waivers[0].errors.includes("approved-by in source is not an approval; use attestation:<id> signed by a trusted approver"));
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("B-02: signed waiver with untrusted approver is marked invalid", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-b02-"));
  try {
    const manifest = writeSignedCollectProject(tempDir, { approver: "rogue-agent" });
    const waivers = withWaiverEnv(tempDir, () => collectWaiversForManifest(tempDir, manifest));
    assert.equal(waivers.length, 1);
    assert.equal(waivers[0].untrustedApprover, true);
    assert.equal(waivers[0].valid, false);
    assert.ok(
      waivers[0].errors.some((error) => error.includes("rogue-agent is not in the approval allowlist")),
      `expected allowlist error in ${JSON.stringify(waivers[0].errors)}`,
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("B-02: signed waiver with trusted approver remains valid", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-b02-trusted-"));
  try {
    const manifest = writeSignedCollectProject(tempDir, { approver: TEST_WAIVER_APPROVER });
    const waivers = withWaiverEnv(tempDir, () => collectWaiversForManifest(tempDir, manifest));
    assert.equal(waivers.length, 1);
    assert.equal(waivers[0].untrustedApprover, false);
    assert.equal(waivers[0].valid, true);
    assert.equal(waivers[0].attestationId, "waiver-test-1");
    assert.equal(waivers[0].approvedBy, TEST_WAIVER_APPROVER);
    assert.deepEqual(waivers[0].errors, []);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("CELLFENCE_APPROVERS overrides repository-local waiver approvers", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-waiver-env-override-"));
  try {
    fs.mkdirSync(path.join(tempDir, ".cellfence"), { recursive: true });
    fs.writeFileSync(path.join(tempDir, ".cellfence/approvers.txt"), "repo-owner\n");
    const manifest = writeSignedCollectProject(tempDir, { approver: "repo-owner" });
    const waivers = withWaiverEnv(tempDir, () => collectWaiversForManifest(tempDir, manifest), {
      CELLFENCE_APPROVERS: "ci-owner",
    });
    assert.equal(waivers.length, 1);
    assert.equal(waivers[0].valid, false);
    assert.ok(waivers[0].errors.some((error) => error.includes("repo-owner is not in the approval allowlist")));
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("repository-local waiver approvers are not trusted without environment approval", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-waiver-repo-allowlist-"));
  try {
    fs.mkdirSync(path.join(tempDir, ".cellfence"), { recursive: true });
    fs.writeFileSync(path.join(tempDir, ".cellfence/approvers.txt"), "repo-owner\n");
    const manifest = writeSignedCollectProject(tempDir, { approver: "repo-owner" });
    const waivers = withWaiverEnv(tempDir, () => collectWaiversForManifest(tempDir, manifest), {
      CELLFENCE_APPROVERS: undefined,
    });
    assert.equal(waivers.length, 1);
    assert.equal(waivers[0].valid, false);
    assert.ok(waivers[0].errors.some((error) => error.includes("approval allowlist is empty")));
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("B-02: CELLFENCE_WAIVER_UNTRUSTED_APPROVER warning is emitted alongside the hard error", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-b02-warn-"));
  try {
    const manifest = writeSignedCollectProject(tempDir, { approver: "rogue-agent" });
    const findings = [];
    const waivers = withWaiverEnv(tempDir, () => collectWaiversForManifest(tempDir, manifest, findings));
    assert.equal(waivers.length, 1);
    assert.equal(waivers[0].valid, false);
    const warning = findings.find((finding) => finding.ruleId === "CELLFENCE_WAIVER_UNTRUSTED_APPROVER");
    assert.ok(warning, `expected warning in ${JSON.stringify(findings.map((finding) => finding.ruleId))}`);
    assert.equal(warning.severity, "warning");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("waivers require line metadata and matching finding fingerprints", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-waiver-line-required-"));
  try {
    const fingerprint = "b".repeat(64);
    const manifest = writeSignedCollectProject(tempDir, { findingFingerprint: fingerprint });
    const [waiver] = withWaiverEnv(tempDir, () => collectWaiversForManifest(tempDir, manifest));
    assert.equal(waiver.valid, true);
    assert.equal(waiverMatchesFinding(waiver, {
      ruleId: "CELLFENCE_UNRESOLVED_IMPORT",
      severity: "error",
      filePath: "src/a/public.ts",
      message: "line-less finding fixture",
      fingerprint,
    }), false);
    assert.equal(waiverMatchesFinding(waiver, {
      ruleId: "CELLFENCE_UNRESOLVED_IMPORT",
      severity: "error",
      filePath: "src/a/public.ts",
      message: "wrong fingerprint fixture",
      details: { line: waiver.attestation.line },
      fingerprint: "c".repeat(64),
    }), false);
    assert.equal(waiverMatchesFinding(waiver, {
      ruleId: "CELLFENCE_UNRESOLVED_IMPORT",
      severity: "error",
      filePath: "src/a/public.ts",
      message: "line finding fixture",
      details: { line: waiver.attestation.line },
      fingerprint,
    }), true);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("waiver attestation is bound to the evaluated HEAD", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-waiver-stale-head-"));
  try {
    const manifest = writeSignedCollectProject(tempDir, { headSha: "0".repeat(40) });
    const [waiver] = withWaiverEnv(tempDir, () => collectWaiversForManifest(tempDir, manifest));
    assert.equal(waiver.valid, false);
    assert.ok(waiver.errors.some((error) => error.includes("headSha does not match the evaluated HEAD")));
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("waiver attestation enforces the same 90-day expiry cap as request generation", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-waiver-long-expiry-"));
  try {
    const manifest = writeSignedCollectProject(tempDir, { expiresAt: "2099-01-01T00:00:00.000Z" });
    const [waiver] = withWaiverEnv(tempDir, () => collectWaiversForManifest(tempDir, manifest));
    assert.equal(waiver.valid, false);
    assert.ok(waiver.errors.some((error) => error.includes("expiresAt must be at most 90 days")));
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("waiver attestation is bound to the evaluated source file bytes", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-waiver-source-sha-"));
  try {
    const manifest = writeSignedCollectProject(tempDir);
    fs.appendFileSync(path.join(tempDir, "src/a/public.ts"), "export const changed = true;\n");
    const [waiver] = withWaiverEnv(tempDir, () => collectWaiversForManifest(tempDir, manifest));
    assert.equal(waiver.valid, false);
    assert.ok(waiver.errors.some((error) => error.includes("sourceSha256 does not match")));
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("waiver attestation verification requires the HMAC key and matching key id", () => {
  const missingKeyRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-waiver-missing-key-"));
  try {
    const manifest = writeSignedCollectProject(missingKeyRoot);
    const [waiver] = withWaiverEnv(missingKeyRoot, () => collectWaiversForManifest(missingKeyRoot, manifest), {
      CELLFENCE_WAIVER_ATTESTATION_HMAC_KEY: undefined,
    });
    assert.equal(waiver.valid, false);
    assert.ok(waiver.errors.some((error) => error.includes("cannot be verified; set CELLFENCE_WAIVER_ATTESTATION_HMAC_KEY")));
  } finally {
    fs.rmSync(missingKeyRoot, { recursive: true, force: true });
  }

  const keyIdRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-waiver-key-id-"));
  try {
    const manifest = writeSignedCollectProject(keyIdRoot);
    const [waiver] = withWaiverEnv(keyIdRoot, () => collectWaiversForManifest(keyIdRoot, manifest), {
      CELLFENCE_WAIVER_ATTESTATION_HMAC_KEY_ID: "ci-key-2",
    });
    assert.equal(waiver.valid, false);
    assert.ok(waiver.errors.some((error) => error.includes("signature keyId does not match")));
  } finally {
    fs.rmSync(keyIdRoot, { recursive: true, force: true });
  }
});

test("waiver attestation ids are unique and line-bound to the source directive", () => {
  const duplicateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-waiver-duplicate-id-"));
  try {
    const manifest = writeSignedCollectProject(duplicateRoot);
    writeSignedWaiverAttestation(duplicateRoot, {
      attestationId: "waiver-test-1",
      filePath: "src/a/public.ts",
      line: 3,
      ruleId: "CELLFENCE_UNRESOLVED_IMPORT",
      expiresAt: `${WAVING_INTO_THE_FUTURE}T00:00:00.000Z`,
      reason: "temporary duplicate waiver fixture",
    });
    const [waiver] = withWaiverEnv(duplicateRoot, () => collectWaiversForManifest(duplicateRoot, manifest));
    assert.equal(waiver.valid, false);
    assert.ok(waiver.errors.some((error) => error.includes("duplicate waiver attestation id")));
  } finally {
    fs.rmSync(duplicateRoot, { recursive: true, force: true });
  }

  const lineRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-waiver-line-binding-"));
  try {
    const manifest = writeSignedCollectProject(lineRoot, { line: 4 });
    const [waiver] = withWaiverEnv(lineRoot, () => collectWaiversForManifest(lineRoot, manifest));
    assert.equal(waiver.valid, false);
    assert.ok(waiver.errors.some((error) => error.includes("line must target the finding immediately after the source directive")));
  } finally {
    fs.rmSync(lineRoot, { recursive: true, force: true });
  }
});

test("waiver attestation must match the source directive file and rule", () => {
  const fileMismatchRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-waiver-file-mismatch-"));
  try {
    const manifest = writeSignedCollectProject(fileMismatchRoot, { filePath: "src/a/other.ts" });
    const [waiver] = withWaiverEnv(fileMismatchRoot, () => collectWaiversForManifest(fileMismatchRoot, manifest));
    assert.equal(waiver.valid, false);
    assert.ok(waiver.errors.some((error) => error.includes("filePath does not match source directive")));
  } finally {
    fs.rmSync(fileMismatchRoot, { recursive: true, force: true });
  }

  const ruleMismatchRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-waiver-rule-mismatch-"));
  try {
    const manifest = writeSignedCollectProject(ruleMismatchRoot, { ruleId: "CELLFENCE_PUBLIC_ENTRY_MISSING" });
    const [waiver] = withWaiverEnv(ruleMismatchRoot, () => collectWaiversForManifest(ruleMismatchRoot, manifest));
    assert.equal(waiver.valid, false);
    assert.ok(waiver.errors.some((error) => error.includes("ruleId does not match source directive")));
  } finally {
    fs.rmSync(ruleMismatchRoot, { recursive: true, force: true });
  }
});

test("waiver attestation tampering invalidates the signature", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-waiver-tamper-"));
  try {
    const manifest = writeSignedCollectProject(tempDir);
    const parsed = readWaiverAttestationFile(tempDir);
    parsed.attestations[0].expiresAt = new Date(Date.now() + 45 * 86400 * 1000).toISOString();
    parsed.attestations[0].approver = "rogue-after-signing";
    writeWaiverAttestationFile(tempDir, parsed.attestations);
    const [waiver] = withWaiverEnv(tempDir, () => collectWaiversForManifest(tempDir, manifest), {
      CELLFENCE_APPROVERS: `${TEST_WAIVER_APPROVER},rogue-after-signing`,
    });
    assert.equal(waiver.valid, false);
    assert.ok(waiver.errors.some((error) => error.includes("signature does not match")));
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("valid signed waiver suppresses a non-required active finding", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-waiver-active-"));
  try {
    writeUnresolvedImportProject(tempDir);
    writeUnresolvedImportProject(tempDir, "// cellfence-ignore CELLFENCE_UNRESOLVED_IMPORT attestation:waiver-active-1");
    const initial = checkRepository({ rootDir: tempDir, manifestPath: "cellfence.manifest.json" });
    const unresolved = findRule(initial, "CELLFENCE_UNRESOLVED_IMPORT");
    assert.ok(unresolved?.fingerprint, JSON.stringify(initial.findings));
    initGitRepo(tempDir);
    writeSignedWaiverAttestation(tempDir, {
      attestationId: "waiver-active-1",
      ruleId: "CELLFENCE_UNRESOLVED_IMPORT",
      filePath: "src/core/public.ts",
      line: 2,
      findingFingerprint: unresolved.fingerprint,
      reason: "temporary unresolved import migration",
    });

    const result = withWaiverEnv(tempDir, () => checkRepository({ rootDir: tempDir, manifestPath: "cellfence.manifest.json" }));
    assert.equal(result.findings.length, 0, JSON.stringify(result.findings));
    assert.equal(findRule(result, "CELLFENCE_UNRESOLVED_IMPORT"), undefined);
    assert.equal(findRule(result, "CELLFENCE_WAIVER_INVALID"), undefined);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("active finding fingerprint mismatch keeps the finding and invalidates the waiver", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-waiver-fingerprint-mismatch-"));
  try {
    writeUnresolvedImportProject(tempDir, "// cellfence-ignore CELLFENCE_UNRESOLVED_IMPORT attestation:waiver-mismatch-1");
    initGitRepo(tempDir);
    writeSignedWaiverAttestation(tempDir, {
      attestationId: "waiver-mismatch-1",
      ruleId: "CELLFENCE_UNRESOLVED_IMPORT",
      filePath: "src/core/public.ts",
      line: 2,
      findingFingerprint: "f".repeat(64),
      reason: "temporary unresolved import migration",
    });

    const result = withWaiverEnv(tempDir, () => checkRepository({ rootDir: tempDir, manifestPath: "cellfence.manifest.json" }));
    assert.equal(result.ok, false);
    assert.ok(findRule(result, "CELLFENCE_UNRESOLVED_IMPORT"));
    assert.match(findRule(result, "CELLFENCE_WAIVER_INVALID").message, /findingFingerprint does not match/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("required rules cannot be suppressed and are reported as invalid waiver attempts", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-waiver-required-rule-"));
  try {
    writePrivateImportProject(tempDir);
    const initial = checkRepository({ rootDir: tempDir, manifestPath: "cellfence.manifest.json" });
    const privateImport = findRule(initial, "CELLFENCE_PRIVATE_IMPORT");
    assert.ok(privateImport?.fingerprint, JSON.stringify(initial.findings));

    writePrivateImportProject(tempDir, "// cellfence-ignore CELLFENCE_PRIVATE_IMPORT attestation:waiver-required-1");
    initGitRepo(tempDir);
    writeSignedWaiverAttestation(tempDir, {
      attestationId: "waiver-required-1",
      ruleId: "CELLFENCE_PRIVATE_IMPORT",
      filePath: "src/consumer/public.ts",
      line: 2,
      findingFingerprint: privateImport.fingerprint,
      reason: "temporary private import migration",
    });

    const result = withWaiverEnv(tempDir, () => checkRepository({ rootDir: tempDir, manifestPath: "cellfence.manifest.json" }));
    assert.equal(result.ok, false);
    assert.ok(findRule(result, "CELLFENCE_PRIVATE_IMPORT"));
    assert.match(findRule(result, "CELLFENCE_WAIVER_INVALID").message, /required and cannot be waived/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
