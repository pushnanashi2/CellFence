import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { checkRepository } from "../packages/engine/dist/index.js";

const rootDir = process.cwd();
const casesPath = path.join(rootDir, "tests/conformance/public-surface/public-surface-cases.json");
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

function expectedFinding(conformanceCase) {
  const expected = conformanceCase.expected;
  const cell = conformanceCase.manifest.cells[0];
  if (expected.profile === "clean") return [];
  if (expected.profile === "symbol-mismatch") {
    return [{
      ruleId: "CELLFENCE_PUBLIC_SYMBOL_MISMATCH",
      severity: "error",
      cellId: cell.id,
      filePath: cell.publicEntry,
      missingSymbols: expected.missingSymbols,
      undeclaredSymbols: expected.undeclaredSymbols,
    }];
  }
  if (expected.profile === "entry-missing") {
    return [{
      ruleId: "CELLFENCE_PUBLIC_ENTRY_MISSING",
      severity: "error",
      cellId: cell.id,
      filePath: cell.publicEntry,
    }];
  }
  throw new Error(`unknown expected profile ${expected.profile} in ${conformanceCase.id}`);
}

function normalizedFinding(finding) {
  const details = finding.details || {};
  const normalized = {
    ruleId: finding.ruleId,
    severity: finding.severity,
  };
  for (const key of ["filePath", "cellId"]) {
    if (finding[key] !== undefined) normalized[key] = finding[key];
  }
  for (const key of ["missingSymbols", "undeclaredSymbols"]) {
    if (details[key] !== undefined) normalized[key] = [...details[key]].sort();
    else if (finding[key] !== undefined) normalized[key] = [...finding[key]].sort();
  }
  return normalized;
}

function normalizeFindings(findings) {
  return findings
    .map(normalizedFinding)
    .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
}

function runCase(conformanceCase) {
  const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), `cellfence-public-surface-conformance-${conformanceCase.id}-`));
  try {
    renderCase(testRoot, conformanceCase);
    return checkRepository({ rootDir: testRoot, manifestPath: "cellfence.manifest.json" });
  } finally {
    fs.rmSync(testRoot, { recursive: true, force: true });
  }
}

function expectedResult(conformanceCase) {
  const findings = normalizeFindings(expectedFinding(conformanceCase));
  return {
    ok: findings.length === 0,
    findings,
    warnings: [],
  };
}

function assertFingerprints(result) {
  for (const finding of result.findings) {
    assert.equal(typeof finding.fingerprint, "string", `${finding.ruleId} should carry a fingerprint`);
    assert.match(finding.fingerprint, /^[a-f0-9]{64}$/);
  }
}

test("public surface conformance ledger covers the P0 surface matrix", () => {
  assert.equal(ledger.schemaVersion, "cellfence.public-surface-conformance.v1");
  assert.ok(Array.isArray(ledger.cases));
  assert.ok(ledger.cases.length >= 10);
  assert.deepEqual(new Set(ledger.statuses), supportedStatuses);

  const ids = new Set();
  for (const conformanceCase of ledger.cases) {
    assert.equal(ids.has(conformanceCase.id), false, `duplicate case id ${conformanceCase.id}`);
    ids.add(conformanceCase.id);
    assert.ok(supportedStatuses.has(conformanceCase.status), `${conformanceCase.id} has unknown status`);
    assert.ok(ledger.coverageAxes.surfaceFamilies.includes(conformanceCase.surfaceFamily), `${conformanceCase.id} has unknown surface family`);
    assert.equal(typeof conformanceCase.manifest?.schemaVersion, "string", `${conformanceCase.id} must declare a manifest`);
    assert.equal(typeof conformanceCase.expected?.profile, "string", `${conformanceCase.id} must declare an expected profile`);
  }

  const coveredFamilies = new Set(ledger.cases.map((entry) => entry.surfaceFamily));
  for (const family of ledger.coverageAxes.surfaceFamilies) {
    assert.ok(coveredFamilies.has(family), `missing public surface conformance coverage for ${family}`);
  }
});

for (const conformanceCase of ledger.cases) {
  test(`public surface conformance: ${conformanceCase.id}`, () => {
    const result = runCase(conformanceCase);
    const expected = expectedResult(conformanceCase);

    assert.equal(result.ok, expected.ok, JSON.stringify(result.findings, null, 2));
    assert.deepEqual(normalizeFindings(result.findings), expected.findings);
    assert.deepEqual(normalizeFindings(result.warnings), expected.warnings);
    assertFingerprints(result);
  });
}

test("public surface conformance findings are deterministic for the same case", () => {
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
