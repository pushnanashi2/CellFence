import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { checkRepository } from "../packages/engine/dist/index.js";

const rootDir = process.cwd();
const casesPath = path.join(rootDir, "tests/conformance/resolution/resolution-cases.json");
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

function publicSymbolsFor(language) {
  return language === "python" ? ["exposed"] : ["exposed"];
}

function baseCell(id, language, patch = {}) {
  const extension = language === "python" ? "py" : "ts";
  return {
    id,
    ownedPaths: [`src/${id}/**`],
    publicEntry: `src/${id}/public.${extension}`,
    publicSymbols: id === "producer" ? publicSymbolsFor(language) : ["consumerValue"],
    consumes: [],
    producesArtifacts: [],
    ...patch,
  };
}

function defaultFiles(testRoot, language) {
  if (language === "python") {
    writeFile(path.join(testRoot, "src/producer/public.py"), [
      "__all__ = ['exposed']",
      "exposed = True",
    ]);
    writeFile(path.join(testRoot, "src/producer/internal.py"), [
      "secret = True",
    ]);
    writeFile(path.join(testRoot, "src/consumer/public.py"), [
      "consumerValue = True",
    ]);
    return;
  }
  writeFile(path.join(testRoot, "src/producer/public.ts"), [
    "export const exposed = true;",
  ]);
  writeFile(path.join(testRoot, "src/producer/internal.ts"), [
    "export const secret = true;",
  ]);
  writeFile(path.join(testRoot, "src/consumer/public.ts"), [
    "export const consumerValue = true;",
  ]);
}

function renderCase(testRoot, conformanceCase) {
  const language = conformanceCase.language || "typescript";
  defaultFiles(testRoot, language);
  writeFile(path.join(testRoot, conformanceCase.sourceFile), conformanceCase.source);

  for (const [relativePath, contents] of Object.entries(conformanceCase.extraFiles || {})) {
    writeFile(path.join(testRoot, relativePath), contents);
  }
  for (const [relativePath, contents] of Object.entries(conformanceCase.tsconfigs || {})) {
    writeJson(path.join(testRoot, relativePath), contents);
  }
  if (conformanceCase.rootPackageJson) {
    writeJson(path.join(testRoot, "package.json"), conformanceCase.rootPackageJson);
  }
  if (conformanceCase.producerPackageJson) {
    writeJson(path.join(testRoot, "src/producer/package.json"), conformanceCase.producerPackageJson);
  }

  writeJson(path.join(testRoot, "cellfence.manifest.json"), {
    schemaVersion: "cellfence.manifest.v1",
    governance: {
      requireOwnership: true,
      include: ["src/**"],
      exclude: [],
    },
    cells: [
      baseCell("producer", language, {
        ...(conformanceCase.producerPackageName ? { packageName: conformanceCase.producerPackageName } : {}),
      }),
      baseCell("consumer", language, {
        consumes: conformanceCase.consumerConsumesProducer === false ? [] : [{ cell: "producer" }],
      }),
    ],
  });
}

function expectedFinding(profile, conformanceCase) {
  const expected = conformanceCase.expected;
  const base = {
    severity: "error",
    filePath: conformanceCase.sourceFile,
  };
  if (profile === "clean") return [];
  if (profile === "private-import") {
    return [{
      ...base,
      ruleId: "CELLFENCE_PRIVATE_IMPORT",
      cellId: "consumer",
      producerCellId: "producer",
      line: expected.line,
      specifier: expected.specifier,
      targetPath: expected.targetPath,
    }];
  }
  if (profile === "undeclared-public") {
    return [{
      ...base,
      ruleId: "CELLFENCE_UNDECLARED_CONSUMER",
      cellId: "consumer",
      producerCellId: "producer",
      line: expected.line,
      specifier: expected.specifier,
      kind: expected.kind,
      typeOnly: expected.typeOnly,
    }];
  }
  if (profile === "unresolved-import") {
    return [{
      ...base,
      ruleId: "CELLFENCE_UNRESOLVED_IMPORT",
      line: expected.line,
      specifier: expected.specifier,
    }];
  }
  throw new Error(`unknown expected profile ${profile} in ${conformanceCase.id}`);
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
  for (const key of ["line", "specifier", "targetPath", "kind", "typeOnly"]) {
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
  const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), `cellfence-resolution-conformance-${conformanceCase.id}-`));
  try {
    renderCase(testRoot, conformanceCase);
    return checkRepository({ rootDir: testRoot, manifestPath: "cellfence.manifest.json" });
  } finally {
    fs.rmSync(testRoot, { recursive: true, force: true });
  }
}

function expectedResult(conformanceCase) {
  const findings = normalizeFindings(expectedFinding(conformanceCase.expected.profile, conformanceCase));
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

test("resolution conformance ledger covers the P0 resolver matrix", () => {
  assert.equal(ledger.schemaVersion, "cellfence.resolution-conformance.v1");
  assert.ok(Array.isArray(ledger.cases));
  assert.ok(ledger.cases.length >= 10);
  assert.deepEqual(new Set(ledger.statuses), supportedStatuses);

  const ids = new Set();
  for (const conformanceCase of ledger.cases) {
    assert.equal(ids.has(conformanceCase.id), false, `duplicate case id ${conformanceCase.id}`);
    ids.add(conformanceCase.id);
    assert.ok(supportedStatuses.has(conformanceCase.status), `${conformanceCase.id} has unknown status`);
    assert.ok(ledger.coverageAxes.resolverFamilies.includes(conformanceCase.resolverFamily), `${conformanceCase.id} has unknown resolver family`);
    assert.ok(conformanceCase.sourceFile.startsWith("src/consumer/"), `${conformanceCase.id} source file must be owned by consumer`);
    assert.equal(Array.isArray(conformanceCase.source), true, `${conformanceCase.id} source must be line based`);
    assert.equal(typeof conformanceCase.expected?.profile, "string", `${conformanceCase.id} must declare an expected profile`);
  }

  const coveredFamilies = new Set(ledger.cases.map((entry) => entry.resolverFamily));
  for (const family of ledger.coverageAxes.resolverFamilies) {
    assert.ok(coveredFamilies.has(family), `missing resolution conformance coverage for ${family}`);
  }
});

for (const conformanceCase of ledger.cases) {
  test(`resolution conformance: ${conformanceCase.id}`, () => {
    const result = runCase(conformanceCase);
    const expected = expectedResult(conformanceCase);

    assert.equal(result.ok, expected.ok, JSON.stringify(result.findings, null, 2));
    assert.deepEqual(normalizeFindings(result.findings), expected.findings);
    assert.deepEqual(normalizeFindings(result.warnings), expected.warnings);
    assertFingerprints(result);
  });
}

test("resolution conformance findings are deterministic for the same case", () => {
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
