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

for (const group of ["valid", "invalid"]) {
  for (const fixturePath of fixtureDirectories(group)) {
    const fixtureName = path.relative(path.join(root, "fixtures"), fixturePath);
    test(`fixture ${fixtureName}`, () => {
      const expected = readExpected(fixturePath);
      const result = checkRepository({
        rootDir: fixturePath,
        manifestPath: "cellfence.manifest.json",
        baselinePath: expected.mode === "baseline-check" ? "cellfence.baseline.json" : undefined,
      });

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
