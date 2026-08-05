import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { runResolutionOracleConformance } from "../scripts/resolution-oracle-conformance.mjs";

const ledgerPath = path.resolve("tests/conformance/resolution/resolution-cases.json");

test("resolution oracle harness agrees with TypeScript for comparable resolver families", () => {
  const { report, exitCode } = runResolutionOracleConformance({ ledgerPath, keepFixtures: false });
  assert.equal(exitCode, 0);
  assert.equal(report.schemaVersion, "cellfence.resolution-oracle-conformance.v1");
  assert.match(report.oracle, /^typescript@/);
  assert.equal(report.summary.statuses.conformant, 13);
  assert.equal(report.summary.statuses.not_comparable, 1);
  assert.equal(report.summary.statuses.divergent, undefined);
  assert.ok(report.cases.filter((entry) => entry.status === "not_comparable").every((entry) => entry.reason));
});

test("resolution oracle harness exposes divergence and unavailable states through injection", () => {
  const ledger = {
    schemaVersion: "cellfence.resolution-conformance.v1",
    cases: [{
      id: "relative",
      status: "supported-and-tested",
      resolverFamily: "relative-runtime-extension",
      sourceFile: "src/consumer/use.ts",
      source: ["import { exposed } from '../producer/public.js';"],
      expected: { profile: "clean" },
    }],
  };
  const divergent = runResolutionOracleConformance({ ledger, keepFixtures: false }, {
    oracleName: "injected",
    oracleResolver: () => ({ available: true, targetPath: "src/other.ts" }),
  });
  assert.equal(divergent.exitCode, 1);
  assert.equal(divergent.report.cases[0].status, "divergent");

  const unavailable = runResolutionOracleConformance({ ledger, keepFixtures: false }, {
    oracleName: "missing",
    oracleResolver: () => ({ available: false, reason: "oracle is not installed" }),
  });
  assert.equal(unavailable.exitCode, 0);
  assert.equal(unavailable.report.cases[0].status, "unavailable");
  assert.equal(unavailable.report.cases[0].reason, "oracle is not installed");
});
