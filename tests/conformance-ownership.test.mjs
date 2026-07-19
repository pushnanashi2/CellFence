import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { checkRepository } from "../packages/engine/dist/index.js";

const rootDir = process.cwd();
const casesPath = path.join(rootDir, "tests/conformance/ownership/ownership-cases.json");
const ledger = JSON.parse(fs.readFileSync(casesPath, "utf8"));

const supportedStatuses = new Set([
  "supported-and-tested",
  "unsupported-but-diagnosed",
  "not-applicable",
]);

function writeFile(filePath, lines) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${Array.isArray(lines) ? lines.join("\n") : lines}\n`);
}

function writeJson(filePath, value) {
  writeFile(filePath, JSON.stringify(value, null, 2));
}

function renderCase(testRoot, conformanceCase) {
  for (const [relativePath, contents] of Object.entries(conformanceCase.files || {})) {
    writeFile(path.join(testRoot, relativePath), contents);
  }
  writeJson(path.join(testRoot, "cellfence.manifest.json"), conformanceCase.manifest);
}

function normalizedFinding(finding) {
  const details = finding.details || {};
  const normalized = {
    ruleId: finding.ruleId,
    severity: finding.severity,
  };
  for (const key of ["filePath", "cellId", "producerCellId"]) {
    if (finding[key] !== undefined) normalized[key] = finding[key];
  }
  for (const key of [
    "leftPattern",
    "rightPattern",
    "publicEntry",
    "artifactLaneId",
    "artifactPath",
    "path",
  ]) {
    if (details[key] !== undefined) normalized[key] = details[key];
    else if (finding[key] !== undefined) normalized[key] = finding[key];
  }
  return normalized;
}

function normalizeFindings(findings) {
  return findings
    .map(normalizedFinding)
    .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
}

function runCase(conformanceCase) {
  const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), `cellfence-ownership-conformance-${conformanceCase.id}-`));
  try {
    renderCase(testRoot, conformanceCase);
    return checkRepository({ rootDir: testRoot, manifestPath: "cellfence.manifest.json" });
  } finally {
    fs.rmSync(testRoot, { recursive: true, force: true });
  }
}

function assertFingerprints(result) {
  for (const finding of [...result.findings, ...result.warnings]) {
    assert.equal(typeof finding.fingerprint, "string", `${finding.ruleId} should carry a fingerprint`);
    assert.match(finding.fingerprint, /^[a-f0-9]{64}$/);
  }
}

test("ownership conformance ledger covers the P0 ownership matrix", () => {
  assert.equal(ledger.schemaVersion, "cellfence.ownership-conformance.v1");
  assert.ok(Array.isArray(ledger.cases));
  assert.ok(ledger.cases.length >= 8);
  assert.deepEqual(new Set(ledger.statuses), supportedStatuses);

  const ids = new Set();
  for (const conformanceCase of ledger.cases) {
    assert.equal(ids.has(conformanceCase.id), false, `duplicate case id ${conformanceCase.id}`);
    ids.add(conformanceCase.id);
    assert.ok(supportedStatuses.has(conformanceCase.status), `${conformanceCase.id} has unknown status`);
    assert.ok(ledger.coverageAxes.ownershipFamilies.includes(conformanceCase.ownershipFamily), `${conformanceCase.id} has unknown ownership family`);
    assert.equal(typeof conformanceCase.manifest?.schemaVersion, "string", `${conformanceCase.id} must declare a manifest`);
    assert.equal(typeof conformanceCase.expected, "object", `${conformanceCase.id} must declare expected output`);
  }

  const coveredFamilies = new Set(ledger.cases.map((entry) => entry.ownershipFamily));
  for (const family of ledger.coverageAxes.ownershipFamilies) {
    assert.ok(coveredFamilies.has(family), `missing ownership conformance coverage for ${family}`);
  }
});

for (const conformanceCase of ledger.cases) {
  test(`ownership conformance: ${conformanceCase.id}`, () => {
    const result = runCase(conformanceCase);
    const expectedFindings = normalizeFindings(conformanceCase.expected.findings || []);
    const expectedWarnings = normalizeFindings(conformanceCase.expected.warnings || []);

    assert.equal(result.ok, expectedFindings.length === 0, JSON.stringify(result.findings, null, 2));
    assert.deepEqual(normalizeFindings(result.findings), expectedFindings);
    assert.deepEqual(normalizeFindings(result.warnings), expectedWarnings);
    assertFingerprints(result);
  });
}

test("ownership conformance findings are deterministic for the same case", () => {
  for (const conformanceCase of ledger.cases) {
    const first = runCase(conformanceCase);
    const second = runCase(conformanceCase);
    assert.deepEqual(
      normalizeFindings(first.findings),
      normalizeFindings(second.findings),
      `${conformanceCase.id} produced nondeterministic findings`,
    );
    assert.deepEqual(
      normalizeFindings(first.warnings),
      normalizeFindings(second.warnings),
      `${conformanceCase.id} produced nondeterministic warnings`,
    );
    assert.deepEqual(
      [...first.findings, ...first.warnings].map((finding) => finding.fingerprint).sort(),
      [...second.findings, ...second.warnings].map((finding) => finding.fingerprint).sort(),
      `${conformanceCase.id} produced nondeterministic fingerprints`,
    );
  }
});
