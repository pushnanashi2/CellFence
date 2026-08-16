import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { checkRepository } from "@cellfence/engine";

const root = process.cwd();

// H-4 (0.3.0): the evidence fixtures ship a `commitSha` of
// "HEAD" so the same fixture is valid for every checkout. The
// test runner resolves that marker to the current `git
// rev-parse HEAD` at run time, writes a temporary copy next
// to the fixture, and hands the temp path to the engine. The
// engine's H-4 binding check then runs against the real
// commit the developer is on, and the working tree stays
// clean across `npm test` runs.

import { execFileSync } from "node:child_process";

function headCommitSha() {
  // Resolve HEAD from the repo root, not from the fixture directory.
  // Both paths happen to be the same git repo, but the engine reads
  // HEAD from `rootDir` and we want the value it sees to match the
  // value we wrote into the resolved evidence file.
  return execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
}

function resolveEvidenceFixturePath(fixturePath, evidenceRelPath) {
  const evidenceSrc = path.join(fixturePath, evidenceRelPath);
  const evidence = JSON.parse(fs.readFileSync(evidenceSrc, "utf8"));
  if (evidence.commitSha === "HEAD") {
    evidence.commitSha = headCommitSha();
  }
  // Place the resolved copy inside the fixture directory itself so the
  // engine's `git rev-parse HEAD` (run from `rootDir = fixturePath`)
  // sees a repo and returns the SHA we just stamped on the evidence.
  // Use a hidden subdirectory so a stray `git status` does not show
  // the file; clean it up at the end of the test.
  const resolvedDir = path.join(fixturePath, ".resolved");
  fs.mkdirSync(resolvedDir, { recursive: true });
  const resolvedPath = path.join(resolvedDir, evidenceRelPath);
  fs.writeFileSync(resolvedPath, JSON.stringify(evidence, null, 2));
  return resolvedPath;
}

function cleanupResolvedEvidence(fixturePath) {
  const resolvedDir = path.join(fixturePath, ".resolved");
  if (fs.existsSync(resolvedDir)) {
    fs.rmSync(resolvedDir, { recursive: true, force: true });
  }
}
function fixtureDirectories(group) {
  const groupPath = path.join(root, "fixtures", group);
  return fs
    .readdirSync(groupPath, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(groupPath, entry.name));
}

function readExpected(fixturePath) {
  return JSON.parse(fs.readFileSync(path.join(fixturePath, "expected-result.json"), "utf8"));
}

function sortedRuleIds(findings) {
  return [...new Set(findings.map((finding) => finding.ruleId))].sort();
}

function baselineHasSeal(fixturePath) {
  try {
    const baseline = JSON.parse(fs.readFileSync(path.join(fixturePath, "cellfence.baseline.json"), "utf8"));
    return Boolean(baseline.seal);
  } catch {
    return false;
  }
}

function withBaselineVerifier(callback) {
  // The fixture runner is hermetic: a developer's shell can carry a real
  // CELLFENCE_BASELINE_HMAC_KEY that would otherwise make every
  // unsigned fixture fail with CELLFENCE_BASELINE_SEAL_INVALID.
  // Save the existing env, then explicitly decide whether the case
  // is a sealed-baseline check (set a test key) or a plain check
  // (clear the env so the unsigned fixture does not surprise us).
  const previous = process.env.CELLFENCE_BASELINE_HMAC_KEY;
  process.env.CELLFENCE_BASELINE_HMAC_KEY = "test-baseline-secret";
  try {
    return callback();
  } finally {
    if (previous === undefined) delete process.env.CELLFENCE_BASELINE_HMAC_KEY;
    else process.env.CELLFENCE_BASELINE_HMAC_KEY = previous;
  }
}

function withoutBaselineVerifier(callback) {
  // The inverse of withBaselineVerifier: clear all seal env vars so
  // the unsigned fixture is checked under "no verifier" semantics.
  const saved = {};
  for (const name of [
    "CELLFENCE_BASELINE_HMAC_KEY",
    "CELLFENCE_BASELINE_HMAC_KEY_ID",
    "CELLFENCE_BASELINE_ED25519_PRIVATE_KEY",
    "CELLFENCE_BASELINE_ED25519_PUBLIC_KEY",
    "CELLFENCE_BASELINE_ED25519_KEY_ID",
  ]) {
    if (Object.prototype.hasOwnProperty.call(process.env, name)) {
      saved[name] = process.env[name];
      delete process.env[name];
    }
  }
  try {
    return callback();
  } finally {
    for (const name of Object.keys(saved)) {
      process.env[name] = saved[name];
    }
  }
}

for (const group of ["valid", "invalid"]) {
  for (const fixturePath of fixtureDirectories(group)) {
    const fixtureName = path.relative(path.join(root, "fixtures"), fixturePath);
    test(`fixture ${fixtureName}`, () => {
      try {
      const expected = readExpected(fixturePath);
      const evidencePaths = (expected.evidencePaths || []).map((rel) =>
        resolveEvidenceFixturePath(fixturePath, rel),
      );
        const check = () => checkRepository({
        rootDir: fixturePath,
        manifestPath: "cellfence.manifest.json",
        baselinePath: expected.mode === "baseline-check" ? "cellfence.baseline.json" : undefined,
        evidencePaths,
      });
      const result = expected.mode === "baseline-check" && baselineHasSeal(fixturePath)
        ? withBaselineVerifier(check)
        : withoutBaselineVerifier(check);

      assert.equal(result.ok, expected.ok);
      assert.deepEqual(sortedRuleIds(result.findings), [...expected.errorRuleIds].sort());
      assert.deepEqual(sortedRuleIds(result.warnings), [...expected.warningRuleIds].sort());
    } finally {
      cleanupResolvedEvidence(fixturePath);
    }
  });
}
}

test("fixture inventory meets initial conformance floor", () => {
  assert.ok(fixtureDirectories("valid").length >= 10);
  assert.ok(fixtureDirectories("invalid").length >= 15);
});
