import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { checkRepository } from "../packages/engine/dist/index.js";

const rootDir = process.cwd();
const casesPath = path.join(rootDir, "tests/conformance/imports/import-syntax-cases.json");
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

function baseCell(id, patch = {}) {
  return {
    id,
    ownedPaths: [`src/${id}/**`],
    publicEntry: `src/${id}/public.ts`,
    publicSymbols: [id === "producer" ? "exposed" : "consumerValue"],
    consumes: [],
    producesArtifacts: [],
    ...patch,
  };
}

function renderCase(testRoot, conformanceCase) {
  writeFile(path.join(testRoot, "src/producer/public.ts"), [
    "export const exposed = true;",
  ]);
  writeFile(path.join(testRoot, "src/producer/internal.ts"), [
    "export const secret = true;",
    "export type SecretType = { secret: true };",
    "export default secret;",
  ]);
  writeFile(path.join(testRoot, "src/consumer/public.ts"), [
    "export const consumerValue = true;",
  ]);
  writeFile(path.join(testRoot, conformanceCase.sourceFile), conformanceCase.source);

  for (const [relativePath, contents] of Object.entries(conformanceCase.extraFiles || {})) {
    writeFile(path.join(testRoot, relativePath), contents);
  }
  if (conformanceCase.producerPackageJson) {
    writeJson(path.join(testRoot, "src/producer/package.json"), {
      name: conformanceCase.producerPackageName,
      type: "module",
      main: "./public.js",
      exports: {
        ".": "./public.js",
        ...(conformanceCase.producerPackageJsonExportsInternal ? { "./internal": "./internal.js" } : {}),
      },
    });
  }

  writeJson(path.join(testRoot, "cellfence.manifest.json"), {
    schemaVersion: "cellfence.manifest.v1",
    governance: {
      requireOwnership: true,
      include: ["src/**"],
      exclude: [],
    },
    cells: [
      baseCell("producer", {
        ...(conformanceCase.producerPackageName ? { packageName: conformanceCase.producerPackageName } : {}),
      }),
      baseCell("consumer", {
        consumes: conformanceCase.consumerConsumesProducer === false ? [] : [{ cell: "producer" }],
      }),
    ],
  });
}

function expectedFinding(profile, conformanceCase) {
  const expected = conformanceCase.expected;
  const filePath = conformanceCase.sourceFile;
  const base = {
    severity: "error",
    filePath,
  };
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
  if (profile === "private-and-undeclared") {
    return [
      {
        ...base,
        ruleId: "CELLFENCE_PRIVATE_IMPORT",
        cellId: "consumer",
        producerCellId: "producer",
        line: expected.line,
        specifier: expected.specifier,
        targetPath: expected.targetPath,
      },
      {
        ...base,
        ruleId: "CELLFENCE_UNDECLARED_CONSUMER",
        cellId: "consumer",
        producerCellId: "producer",
        line: expected.line,
        specifier: expected.specifier,
        kind: expected.kind,
        typeOnly: expected.typeOnly,
      },
    ];
  }
  if (profile === "unsupported-dynamic-import") {
    return [{
      ...base,
      ruleId: "CELLFENCE_UNSUPPORTED_DYNAMIC_IMPORT",
      line: expected.line,
    }];
  }
  if (profile === "unsupported-dynamic-require") {
    return [{
      ...base,
      ruleId: "CELLFENCE_UNSUPPORTED_DYNAMIC_REQUIRE",
      line: expected.line,
    }];
  }
  if (profile === "clean") return [];
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

function findingSortKey(finding) {
  return JSON.stringify(finding);
}

function normalizeFindings(findings) {
  return findings
    .map(normalizedFinding)
    .sort((left, right) => findingSortKey(left).localeCompare(findingSortKey(right)));
}

function assertFingerprints(result) {
  for (const finding of result.findings) {
    assert.equal(typeof finding.fingerprint, "string", `${finding.ruleId} should carry a fingerprint`);
    assert.match(finding.fingerprint, /^[a-f0-9]{64}$/);
  }
}

function runCase(conformanceCase) {
  const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), `cellfence-import-conformance-${conformanceCase.id}-`));
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

test("import conformance ledger covers the P0 syntax matrix", () => {
  assert.equal(ledger.schemaVersion, "cellfence.import-conformance.v1");
  assert.ok(Array.isArray(ledger.cases));
  assert.ok(ledger.cases.length >= 40);
  assert.deepEqual(new Set(ledger.statuses), supportedStatuses);

  const ids = new Set();
  for (const conformanceCase of ledger.cases) {
    assert.equal(ids.has(conformanceCase.id), false, `duplicate case id ${conformanceCase.id}`);
    ids.add(conformanceCase.id);
    assert.ok(supportedStatuses.has(conformanceCase.status), `${conformanceCase.id} has unknown status`);
    assert.ok(ledger.coverageAxes.syntaxFamilies.includes(conformanceCase.syntaxFamily), `${conformanceCase.id} has unknown syntax family`);
    assert.ok(conformanceCase.sourceFile.startsWith("src/consumer/"), `${conformanceCase.id} source file must be owned by consumer`);
    assert.equal(Array.isArray(conformanceCase.source), true, `${conformanceCase.id} source must be line based`);
    assert.equal(typeof conformanceCase.expected?.profile, "string", `${conformanceCase.id} must declare an expected profile`);
  }

  const coveredExtensions = new Set(ledger.cases.map((entry) => path.extname(entry.sourceFile)));
  for (const extension of ledger.coverageAxes.sourceExtensions) {
    assert.ok(coveredExtensions.has(extension), `missing import conformance coverage for ${extension}`);
  }

  const coveredFamilies = new Set(ledger.cases.map((entry) => entry.syntaxFamily));
  for (const family of ledger.coverageAxes.syntaxFamilies) {
    assert.ok(coveredFamilies.has(family), `missing import conformance coverage for ${family}`);
  }
});

for (const conformanceCase of ledger.cases) {
  test(`import conformance: ${conformanceCase.id}`, () => {
    const result = runCase(conformanceCase);
    const expected = expectedResult(conformanceCase);

    assert.equal(result.ok, expected.ok, JSON.stringify(result.findings, null, 2));
    assert.deepEqual(normalizeFindings(result.findings), expected.findings);
    assert.deepEqual(normalizeFindings(result.warnings), expected.warnings);
    assertFingerprints(result);
  });
}

test("import conformance findings are deterministic for the same case", () => {
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
