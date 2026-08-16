import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { checkRepository } from "../packages/engine/dist/index.js";

const rootDir = process.cwd();
const casesPath = path.join(rootDir, "tests/conformance/malformed/malformed-cases.json");
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

// H-4 (0.3.0): the v2 resource evidence schema requires commitSha to
// match the repository HEAD at validation time. Conformance cases
// ship with the literal placeholder "HEAD" so the test driver can
// substitute the live sha at write time without hard-coding a value
// that would go stale between commits.
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

  if (conformanceCase.manifestText !== undefined) {
    writeFile(path.join(testRoot, "cellfence.manifest.json"), conformanceCase.manifestText);
  } else if (conformanceCase.manifest) {
    writeJson(path.join(testRoot, "cellfence.manifest.json"), conformanceCase.manifest);
  }

  if (conformanceCase.baselineText !== undefined) {
    writeFile(path.join(testRoot, "cellfence.baseline.json"), conformanceCase.baselineText);
  } else if (conformanceCase.baseline) {
    writeJson(path.join(testRoot, "cellfence.baseline.json"), conformanceCase.baseline);
  }

  for (const [relativePath, contents] of Object.entries(conformanceCase.evidenceText || {})) {
    writeFile(path.join(testRoot, relativePath), contents);
  }
  for (const [relativePath, contents] of Object.entries(conformanceCase.evidence || {})) {
    writeJson(path.join(testRoot, relativePath), substituteHead(contents));
  }
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
  for (const key of ["cellId"]) {
    if (details[key] !== undefined) normalized[key] = details[key];
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
  const testRoot = fs.mkdtempSync(path.join(rootDir, `.cellfence-malformed-${conformanceCase.id}-`));
  try {
    renderCase(testRoot, conformanceCase);
    const hasBaseline = conformanceCase.baseline || conformanceCase.baselineText !== undefined;
    return checkRepository({
      rootDir: testRoot,
      manifestPath: "cellfence.manifest.json",
      ...(hasBaseline ? { baselinePath: "cellfence.baseline.json" } : {}),
      evidencePaths: [
        ...Object.keys(conformanceCase.evidence || {}),
        ...Object.keys(conformanceCase.evidenceText || {}),
      ],
    });
  } finally {
    fs.rmSync(testRoot, { recursive: true, force: true });
  }
}

test("malformed conformance ledger covers fail-closed input families", () => {
  assert.equal(ledger.schemaVersion, "cellfence.malformed-conformance.v1");
  assert.ok(Array.isArray(ledger.cases));
  assert.ok(ledger.cases.length >= 8);
  assert.deepEqual(new Set(ledger.statuses), supportedStatuses);

  const ids = new Set();
  for (const conformanceCase of ledger.cases) {
    assert.equal(ids.has(conformanceCase.id), false, `duplicate case id ${conformanceCase.id}`);
    ids.add(conformanceCase.id);
    assert.ok(supportedStatuses.has(conformanceCase.status), `${conformanceCase.id} has unknown status`);
    assert.ok(ledger.coverageAxes.malformedFamilies.includes(conformanceCase.malformedFamily), `${conformanceCase.id} has unknown malformed family`);
    assert.equal(typeof conformanceCase.expected, "object", `${conformanceCase.id} must declare expected output`);
  }

  const coveredFamilies = new Set(ledger.cases.map((entry) => entry.malformedFamily));
  for (const family of ledger.coverageAxes.malformedFamilies) {
    assert.ok(coveredFamilies.has(family), `missing malformed conformance coverage for ${family}`);
  }
});

for (const conformanceCase of ledger.cases) {
  test(`malformed conformance: ${conformanceCase.id}`, () => {
    const result = runCase(conformanceCase);
    const expected = conformanceCase.expected;

    assert.equal(result.ok, expected.ok, JSON.stringify(result.findings, null, 2));
    assert.equal(result.exitCode, expected.exitCode);
    assert.deepEqual(normalizeFindings(result.findings), normalizeFindings(expected.findings || []));
    assert.deepEqual(normalizeFindings(result.warnings), normalizeFindings(expected.warnings || []));
  });
}

test("malformed conformance findings are deterministic for the same case", () => {
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
    assert.equal(first.exitCode, second.exitCode, `${conformanceCase.id} produced nondeterministic exit codes`);
  }
});
