import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { checkRepository } from "../packages/engine/dist/index.js";

const rootDir = process.cwd();
const casesPath = path.join(rootDir, "tests/conformance/resources/resource-cases.json");
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

// H-4 (0.3.0): see the matching helper in
// tests/conformance-malformed.test.mjs; substitute the live HEAD
// for the literal "HEAD" placeholder in evidence fixtures so the
// v2 freshness check has a real value to compare against.
const headSha = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();

function substituteHead(value) {
  if (typeof value === "string") return value === "HEAD" ? headSha : value;
  if (Array.isArray(value)) return value.map(substituteHead);
  if (value && typeof value === "object") {
    const result = {};
    for (const [k, v] of Object.entries(value)) result[k] = substituteHead(v);
    return result;
  }
  return value;
}

function renderCase(testRoot, conformanceCase) {
  for (const [relativePath, contents] of Object.entries(conformanceCase.files || {})) {
    writeFile(path.join(testRoot, relativePath), contents);
  }
  for (const [relativePath, contents] of Object.entries(conformanceCase.evidence || {})) {
    writeJson(path.join(testRoot, relativePath), substituteHead(contents));
  }
  writeJson(path.join(testRoot, "cellfence.manifest.json"), conformanceCase.manifest);
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
  for (const key of ["kind", "access", "selector", "detectedBy"]) {
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
  // H-4 (0.3.0): the v2 freshness check requires the evidence to bind
  // to the live HEAD of the repository the test root sits inside.
  // Create the test root under the cellfence repo (not under
  // os.tmpdir) so the engine's `git rev-parse --show-toplevel`
  // resolves to the same repository as the substituted commitSha.
  const testRoot = fs.mkdtempSync(path.join(rootDir, `.cellfence-resource-${conformanceCase.id}-`));
  try {
    renderCase(testRoot, conformanceCase);
    return checkRepository({
      rootDir: testRoot,
      manifestPath: "cellfence.manifest.json",
      evidencePaths: Object.keys(conformanceCase.evidence || {}),
    });
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

test("resource conformance ledger covers the P0 resource matrix", () => {
  assert.equal(ledger.schemaVersion, "cellfence.resource-conformance.v1");
  assert.ok(Array.isArray(ledger.cases));
  assert.ok(ledger.cases.length >= 9);
  assert.deepEqual(new Set(ledger.statuses), supportedStatuses);

  const ids = new Set();
  for (const conformanceCase of ledger.cases) {
    assert.equal(ids.has(conformanceCase.id), false, `duplicate case id ${conformanceCase.id}`);
    ids.add(conformanceCase.id);
    assert.ok(supportedStatuses.has(conformanceCase.status), `${conformanceCase.id} has unknown status`);
    assert.ok(ledger.coverageAxes.resourceFamilies.includes(conformanceCase.resourceFamily), `${conformanceCase.id} has unknown resource family`);
    assert.equal(typeof conformanceCase.manifest?.schemaVersion, "string", `${conformanceCase.id} must declare a manifest`);
    assert.equal(typeof conformanceCase.expected, "object", `${conformanceCase.id} must declare expected output`);
  }

  const coveredFamilies = new Set(ledger.cases.map((entry) => entry.resourceFamily));
  for (const family of ledger.coverageAxes.resourceFamilies) {
    assert.ok(coveredFamilies.has(family), `missing resource conformance coverage for ${family}`);
  }
});

for (const conformanceCase of ledger.cases) {
  test(`resource conformance: ${conformanceCase.id}`, () => {
    const result = runCase(conformanceCase);
    const expectedFindings = normalizeFindings(conformanceCase.expected.findings || []);
    const expectedWarnings = normalizeFindings(conformanceCase.expected.warnings || []);

    assert.equal(result.ok, expectedFindings.length === 0, JSON.stringify(result.findings, null, 2));
    assert.deepEqual(normalizeFindings(result.findings), expectedFindings);
    assert.deepEqual(normalizeFindings(result.warnings), expectedWarnings);
    assertFingerprints(result);
  });
}

test("resource conformance findings are deterministic for the same case", () => {
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
