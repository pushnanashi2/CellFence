import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  parsePythonResolutionOracleArgs,
  pythonResolutionOracleCases,
  runPythonResolutionOracleConformance,
} from "../scripts/python-resolution-oracle-conformance.mjs";

test("Python resolution oracle argument parser accepts explicit local controls", () => {
  const options = parsePythonResolutionOracleArgs([
    "--out=tmp/python-oracle.json",
    "--python", "/opt/pinned/python3",
    "--fixture-parent", "tmp/python-oracle-fixtures",
    "--keep-fixtures",
  ]);

  assert.deepEqual(options, {
    outPath: path.resolve("tmp/python-oracle.json"),
    pythonExecutable: "/opt/pinned/python3",
    fixtureParent: path.resolve("tmp/python-oracle-fixtures"),
    keepFixtures: true,
  });
  assert.deepEqual(parsePythonResolutionOracleArgs(["--help"]), { help: true });
  assert.throws(() => parsePythonResolutionOracleArgs(["--python"]), /requires a value/);
  assert.throws(() => parsePythonResolutionOracleArgs(["--unknown"]), /unknown argument/);
});

test("Python resolution oracle agrees with importlib across local fixture layouts", () => {
  const fixtureParent = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-python-oracle-test-"));
  try {
    const { report, exitCode, fixtureRoot } = runPythonResolutionOracleConformance({
      fixtureParent,
      keepFixtures: true,
    }, {
      now: () => new Date("2026-01-01T00:00:00.000Z"),
    });

    assert.equal(exitCode, 0);
    assert.equal(report.schemaVersion, "cellfence.python-resolution-oracle-conformance.v1");
    assert.equal(report.fixtureSet, "embedded-local-v1");
    assert.match(report.oracle, /^python-importlib /);
    assert.deepEqual(report.summary.statuses, {
      conformant: 8,
      divergent: 0,
      not_comparable: 1,
      oracle_error: 0,
    });
    assert.deepEqual(
      fs.readdirSync(fixtureRoot),
      pythonResolutionOracleCases.map((fixtureCase, index) => `${String(index + 1).padStart(2, "0")}-${fixtureCase.id}`),
    );

    const results = Object.fromEntries(report.cases.map((entry) => [entry.id, entry]));
    assert.equal(results["src-layout-module"].oracleTargetPath, "src/oracle_src_target.py");
    assert.equal(results["flat-layout-module"].oracleTargetPath, "oracle_flat_target.py");
    assert.equal(results["relative-sibling"].oracleTargetPath, "src/oracle_relative/nested/helper.py");
    assert.equal(results["relative-parent"].oracleTargetPath, "src/oracle_relative/shared.py");
    assert.equal(results["pyproject-package-dir"].oracleTargetPath, "lib/oracle_pyproject_target/feature.py");
    assert.ok(results["pyproject-package-dir"].cellfenceSourceRoots.includes("lib"));
    assert.equal(results["setup-cfg-package-dir"].oracleTargetPath, "python/oracle_setup_target/feature.py");
    assert.ok(results["setup-cfg-package-dir"].cellfenceSourceRoots.includes("python"));
    assert.equal(results["unresolved-src-import"].oracleTargetPath, null);
    assert.equal(results["standard-library-out-of-scope"].status, "not_comparable");
    assert.match(results["standard-library-out-of-scope"].reason, /fixture-local/);
  } finally {
    fs.rmSync(fixtureParent, { recursive: true, force: true });
  }
});

test("Python resolution oracle fails on injected divergence and records oracle errors", () => {
  const cases = [pythonResolutionOracleCases[0]];
  const divergent = runPythonResolutionOracleConformance({ cases }, {
    oracleName: "injected-divergence",
    oracleResolver: () => ({ comparable: true, targetPath: "src/injected-wrong-target.py" }),
  });

  assert.equal(divergent.exitCode, 1);
  assert.equal(divergent.report.cases[0].status, "divergent");
  assert.equal(divergent.report.cases[0].cellfenceTargetPath, "src/oracle_src_target.py");
  assert.equal(divergent.report.cases[0].oracleTargetPath, "src/injected-wrong-target.py");

  const oracleError = runPythonResolutionOracleConformance({ cases }, {
    oracleName: "injected-error",
    oracleResolver: () => {
      throw new Error("injected importlib failure");
    },
  });
  assert.equal(oracleError.exitCode, 1);
  assert.equal(oracleError.report.cases[0].status, "oracle_error");
  assert.equal(oracleError.report.cases[0].error, "injected importlib failure");
});
