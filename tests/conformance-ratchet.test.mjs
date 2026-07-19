import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { checkRepository, guardBaselineUpdate } from "../packages/engine/dist/index.js";

const rootDir = process.cwd();
const casesPath = path.join(rootDir, "tests/conformance/ratchet/ratchet-cases.json");
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
  writeJson(path.join(testRoot, "cellfence.baseline.json"), conformanceCase.baseline);
}

function normalizedFinding(finding) {
  const details = finding.details || {};
  const normalized = {
    ruleId: finding.ruleId,
    severity: finding.severity,
  };
  for (const key of ["cellId"]) {
    if (finding[key] !== undefined) normalized[key] = finding[key];
  }
  for (const key of [
    "addedSymbols",
    "addedEdges",
    "metric",
    "addedPublicSymbols",
    "resourceAccess",
  ]) {
    if (details[key] !== undefined) normalized[key] = Array.isArray(details[key]) ? [...details[key]].sort() : details[key];
    else if (finding[key] !== undefined) normalized[key] = Array.isArray(finding[key]) ? [...finding[key]].sort() : finding[key];
  }
  return normalized;
}

function normalizeFindings(findings) {
  return findings
    .map(normalizedFinding)
    .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
}

function runCase(conformanceCase) {
  const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), `cellfence-ratchet-conformance-${conformanceCase.id}-`));
  try {
    renderCase(testRoot, conformanceCase);
    if (conformanceCase.mode === "check") {
      return checkRepository({
        rootDir: testRoot,
        manifestPath: "cellfence.manifest.json",
        baselinePath: "cellfence.baseline.json",
      });
    }
    if (conformanceCase.mode === "guard-update") {
      const guarded = guardBaselineUpdate({
        rootDir: testRoot,
        manifestPath: "cellfence.manifest.json",
        baselinePath: "cellfence.baseline.json",
        nextBaseline: conformanceCase.nextBaseline,
      });
      return { ok: guarded.ok, findings: guarded.findings, warnings: [] };
    }
    throw new Error(`unknown ratchet conformance mode ${conformanceCase.mode}`);
  } finally {
    fs.rmSync(testRoot, { recursive: true, force: true });
  }
}

function assertFingerprints(result) {
  for (const finding of result.findings) {
    assert.equal(typeof finding.fingerprint, "string", `${finding.ruleId} should carry a fingerprint`);
    assert.match(finding.fingerprint, /^[a-f0-9]{64}$/);
  }
}

test("ratchet conformance ledger covers the P0 ratchet matrix", () => {
  assert.equal(ledger.schemaVersion, "cellfence.ratchet-conformance.v1");
  assert.ok(Array.isArray(ledger.cases));
  assert.ok(ledger.cases.length >= 7);
  assert.deepEqual(new Set(ledger.statuses), supportedStatuses);

  const ids = new Set();
  for (const conformanceCase of ledger.cases) {
    assert.equal(ids.has(conformanceCase.id), false, `duplicate case id ${conformanceCase.id}`);
    ids.add(conformanceCase.id);
    assert.ok(supportedStatuses.has(conformanceCase.status), `${conformanceCase.id} has unknown status`);
    assert.ok(ledger.coverageAxes.ratchetFamilies.includes(conformanceCase.ratchetFamily), `${conformanceCase.id} has unknown ratchet family`);
    assert.ok(ledger.coverageAxes.modes.includes(conformanceCase.mode), `${conformanceCase.id} has unknown mode`);
    assert.equal(typeof conformanceCase.manifest?.schemaVersion, "string", `${conformanceCase.id} must declare a manifest`);
    assert.equal(typeof conformanceCase.baseline?.schemaVersion, "string", `${conformanceCase.id} must declare a baseline`);
    assert.equal(typeof conformanceCase.expected, "object", `${conformanceCase.id} must declare expected output`);
  }

  const coveredFamilies = new Set(ledger.cases.map((entry) => entry.ratchetFamily));
  for (const family of ledger.coverageAxes.ratchetFamilies) {
    assert.ok(coveredFamilies.has(family), `missing ratchet conformance coverage for ${family}`);
  }
});

for (const conformanceCase of ledger.cases) {
  test(`ratchet conformance: ${conformanceCase.id}`, () => {
    const result = runCase(conformanceCase);
    const expectedFindings = normalizeFindings(conformanceCase.expected.findings || []);

    assert.equal(result.ok, expectedFindings.length === 0, JSON.stringify(result.findings, null, 2));
    assert.deepEqual(normalizeFindings(result.findings), expectedFindings);
    assert.deepEqual(normalizeFindings(result.warnings), []);
    assertFingerprints(result);
  });
}

test("ratchet conformance findings are deterministic for the same case", () => {
  for (const conformanceCase of ledger.cases) {
    const first = runCase(conformanceCase);
    const second = runCase(conformanceCase);
    assert.deepEqual(
      normalizeFindings(first.findings),
      normalizeFindings(second.findings),
      `${conformanceCase.id} produced nondeterministic findings`,
    );
    assert.deepEqual(
      first.findings.map((finding) => finding.fingerprint).sort(),
      second.findings.map((finding) => finding.fingerprint).sort(),
      `${conformanceCase.id} produced nondeterministic fingerprints`,
    );
  }
});
