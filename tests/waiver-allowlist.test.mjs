const WAVING_INTO_THE_FUTURE = (() => {
  const d = new Date(Date.now() + 89 * 86400 * 1000);
  return d.toISOString().slice(0, 10);
})();

// New test file for B-02: strict allowlist enforcement on waivers
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { collectWaiversForManifest, waiverMatchesFinding } from "../packages/engine/dist/waivers.js";

function writeProject(rootDir, approver, includeCell = true) {
  fs.mkdirSync(path.join(rootDir, "src/a"), { recursive: true });
  const manifest = {
    schemaVersion: "cellfence.manifest.v1",
    cells: includeCell
      ? [{ id: "a", ownedPaths: ["src/a/**"] }]
      : [],
  };
  fs.writeFileSync(path.join(rootDir, "cellfence.manifest.json"), JSON.stringify(manifest));
  // waiver with an approver NOT in the allowlist
  const waiverText = `// cellfence-ignore CELLFENCE_PRIVATE_IMPORT expires:${WAVING_INTO_THE_FUTURE} approved-by:${approver} reason:temporary strict allowlist test fixture\n`;
  fs.writeFileSync(path.join(rootDir, "src/a/public.ts"), `export const a = 1;\n${waiverText}`);
}

test("B-02: waiver with untrusted approver is marked invalid", () => {
  const original = process.env.CELLFENCE_APPROVERS;
  process.env.CELLFENCE_APPROVERS = "test-owner";
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-b02-"));
  try {
    writeProject(tempDir, "rogue-agent");
    const manifest = JSON.parse(fs.readFileSync(path.join(tempDir, "cellfence.manifest.json"), "utf8"));
    const waivers = collectWaiversForManifest(tempDir, manifest);
    assert.equal(waivers.length, 1);
    const w = waivers[0];
    assert.equal(w.untrustedApprover, true);
    assert.equal(w.valid, false);
    assert.ok(
      w.errors.some((e) => e.includes("not in the approval allowlist")),
      `expected allowlist error in ${JSON.stringify(w.errors)}`,
    );
  } finally {
    if (original === undefined) delete process.env.CELLFENCE_APPROVERS;
    else process.env.CELLFENCE_APPROVERS = original;
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("B-02: waiver with trusted approver remains valid", () => {
  const original = process.env.CELLFENCE_APPROVERS;
  process.env.CELLFENCE_APPROVERS = "test-owner";
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-b02-trusted-"));
  try {
    writeProject(tempDir, "test-owner");
    const manifest = JSON.parse(fs.readFileSync(path.join(tempDir, "cellfence.manifest.json"), "utf8"));
    const waivers = collectWaiversForManifest(tempDir, manifest);
    assert.equal(waivers.length, 1);
    const w = waivers[0];
    assert.equal(w.untrustedApprover, false);
    assert.equal(w.valid, true);
    assert.ok(w.errors.length === 0, `expected no errors, got ${JSON.stringify(w.errors)}`);
  } finally {
    if (original === undefined) delete process.env.CELLFENCE_APPROVERS;
    else process.env.CELLFENCE_APPROVERS = original;
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("B-02: CELLFENCE_WAIVER_UNTRUSTED_APPROVER warning is emitted alongside the hard error", () => {
  const original = process.env.CELLFENCE_APPROVERS;
  process.env.CELLFENCE_APPROVERS = "test-owner";
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-b02-warn-"));
  try {
    writeProject(tempDir, "rogue-agent");
    const manifest = JSON.parse(fs.readFileSync(path.join(tempDir, "cellfence.manifest.json"), "utf8"));
    const findings = [];
    const waivers = collectWaiversForManifest(tempDir, manifest, findings);
    assert.equal(waivers.length, 1);
    assert.equal(waivers[0].valid, false);
    const warning = findings.find((f) => f.ruleId === "CELLFENCE_WAIVER_UNTRUSTED_APPROVER");
    assert.ok(warning, `expected warning in ${JSON.stringify(findings.map((f) => f.ruleId))}`);
    assert.equal(warning.severity, "warning");
  } finally {
    if (original === undefined) delete process.env.CELLFENCE_APPROVERS;
    else process.env.CELLFENCE_APPROVERS = original;
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("waivers do not suppress findings that lack line metadata", () => {
  const original = process.env.CELLFENCE_APPROVERS;
  process.env.CELLFENCE_APPROVERS = "test-owner";
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-waiver-line-required-"));
  try {
    writeProject(tempDir, "test-owner");
    const manifest = JSON.parse(fs.readFileSync(path.join(tempDir, "cellfence.manifest.json"), "utf8"));
    const [waiver] = collectWaiversForManifest(tempDir, manifest);
    assert.equal(waiverMatchesFinding(waiver, {
      ruleId: "CELLFENCE_PRIVATE_IMPORT",
      severity: "error",
      filePath: "src/a/public.ts",
      message: "line-less finding fixture",
    }), false);
    assert.equal(waiverMatchesFinding(waiver, {
      ruleId: "CELLFENCE_PRIVATE_IMPORT",
      severity: "error",
      filePath: "src/a/public.ts",
      message: "line finding fixture",
      details: { line: waiver.line },
    }), true);
  } finally {
    if (original === undefined) delete process.env.CELLFENCE_APPROVERS;
    else process.env.CELLFENCE_APPROVERS = original;
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
