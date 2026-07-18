import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { checkRepository } from "../packages/engine/dist/index.js";

const root = process.cwd();

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
  const previous = process.env.CELLFENCE_BASELINE_HMAC_KEY;
  process.env.CELLFENCE_BASELINE_HMAC_KEY = "test-baseline-secret";
  try {
    return callback();
  } finally {
    if (previous === undefined) delete process.env.CELLFENCE_BASELINE_HMAC_KEY;
    else process.env.CELLFENCE_BASELINE_HMAC_KEY = previous;
  }
}

for (const group of ["valid", "invalid"]) {
  for (const fixturePath of fixtureDirectories(group)) {
    const fixtureName = path.relative(path.join(root, "fixtures"), fixturePath);
    test(`fixture ${fixtureName}`, () => {
      const expected = readExpected(fixturePath);
      const check = () => checkRepository({
        rootDir: fixturePath,
        manifestPath: "cellfence.manifest.json",
        baselinePath: expected.mode === "baseline-check" ? "cellfence.baseline.json" : undefined,
        evidencePaths: expected.evidencePaths || [],
      });
      const result = expected.mode === "baseline-check" && baselineHasSeal(fixturePath) ? withBaselineVerifier(check) : check();

      assert.equal(result.ok, expected.ok);
      assert.deepEqual(sortedRuleIds(result.findings), [...expected.errorRuleIds].sort());
      assert.deepEqual(sortedRuleIds(result.warnings), [...expected.warningRuleIds].sort());
    });
  }
}

test("fixture inventory meets initial conformance floor", () => {
  assert.ok(fixtureDirectories("valid").length >= 10);
  assert.ok(fixtureDirectories("invalid").length >= 15);
});
