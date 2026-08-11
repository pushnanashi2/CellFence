import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { checkRepository } from "../packages/engine/dist/index.js";

const root = process.cwd();

// H-4 (0.3.0): evidence files in fixtures carry a HEAD placeholder
// commitSha so the repository can be checked in cleanly. Resolve the
// live repository HEAD here so the engine's commit-binding check has
// a chance to pass when the fixture is exercised.
function resolveRepositoryHead() {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "";
  }
}

const repositoryHead = resolveRepositoryHead();

function rebindEvidenceCommitShas(fixturePath, evidencePaths) {
  if (!repositoryHead) return;
  for (const relative of evidencePaths) {
    const evidencePath = path.join(fixturePath, relative);
    if (!fs.existsSync(evidencePath)) continue;
    const evidence = JSON.parse(fs.readFileSync(evidencePath, "utf8"));
    if (typeof evidence !== "object" || evidence === null) continue;
    if (typeof evidence.commitSha !== "string") continue;
    if (evidence.commitSha === repositoryHead) continue;
    evidence.commitSha = repositoryHead;
    fs.writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}
`);
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
      const evidencePaths = expected.evidencePaths || [];
      rebindEvidenceCommitShas(fixturePath, evidencePaths);
      const check = () => checkRepository({
        rootDir: fixturePath,
        manifestPath: "cellfence.manifest.json",
        baselinePath: expected.mode === "baseline-check" ? "cellfence.baseline.json" : undefined,
        evidencePaths,
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
