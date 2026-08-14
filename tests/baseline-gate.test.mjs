import assert from "node:assert/strict";
import test from "node:test";

import { detectBaselineChanges } from "../packages/engine/dist/index.js";
import { runBaselineGateCommand } from "../packages/cli/dist/baseline-gate-command.js";


function makeBaseline(overrides = {}) {
  return {
    schemaVersion: "cellfence.baseline.v1",
    generatedAt: "2026-01-01T00:00:00.000Z",
    cells: {
      api: {
        ownedPathPatterns: 1,
        publicSymbols: 1,
        publicSurfaceLines: 1,
        crossCellDependencies: 0,
        ownedPathSet: ["src/api/**"],
        publicSymbolSet: ["run"],
        dependencyEdges: [],
        resourceAccesses: [],
      },
      worker: {
        ownedPathPatterns: 1,
        publicSymbols: 1,
        publicSurfaceLines: 1,
        crossCellDependencies: 0,
        ownedPathSet: ["src/worker/**"],
        publicSymbolSet: ["consume"],
        dependencyEdges: [],
        resourceAccesses: [],
      },
    },
    ...overrides,
  };
}

test("detectBaselineChanges flags added and removed owned paths", () => {
  const baseBaseline = makeBaseline();
  const headBaseline = makeBaseline();
  headBaseline.cells.api.ownedPathSet = ["src/api/**", "src/api/internal/**"];
  const report = detectBaselineChanges(baseBaseline, headBaseline, "base.json", "head.json");
  assert.equal(report.schemaVersion, "cellfence.governance-change.v1");
  const ownedPaths = report.deltas.find((delta) => delta.dimension === "ownedPaths");
  assert.ok(ownedPaths, "ownedPaths delta missing");
  assert.deepEqual(ownedPaths.added, ["api: src/api/internal/**"]);
  assert.deepEqual(ownedPaths.removed, []);
});

test("detectBaselineChanges flags public symbol additions", () => {
  const baseBaseline = makeBaseline();
  const headBaseline = makeBaseline();
  headBaseline.cells.api.publicSymbolSet = ["run", "stream"];
  const report = detectBaselineChanges(baseBaseline, headBaseline, "base.json", "head.json");
  const publicSymbols = report.deltas.find((delta) => delta.dimension === "publicSymbols");
  assert.ok(publicSymbols);
  assert.deepEqual(publicSymbols.added, ["api.stream"]);
});

test("runBaselineGateCommand returns exit 1 when governance changed", () => {
  // 0.4.x: CLI help declares '0 no violations / 1 governance violations';
  // governance change IS the violation the gate exists to surface, so
  // the gate must exit 1 when hasChange is true (the previous
  // implementation inverted the codes and tests followed suit).
  const baseBaseline = makeBaseline();
  const headBaseline = makeBaseline();
  headBaseline.cells.worker.ownedPathSet = ["src/worker/**", "src/worker/integration/**"];
  const result = runBaselineGateCommand({
    baseBaseline,
    headBaseline,
    baseBaselinePath: "base.json",
    headBaselinePath: "head.json",
    format: "json",
    hasImplementationChanges: false,
  });
  assert.equal(result.exitCode, 1);
  assert.equal(result.report.hasChange, true);
  assert.equal(result.warnings.length, 0);
});

test("runBaselineGateCommand returns exit 0 when nothing changed", () => {
  // 0.4.x: counterpart to the governance-changed test above. The
  // gate exits 0 only when the two baselines are byte-equivalent
  // across the dimensions detectBaselineChanges inspects.
  const baseBaseline = makeBaseline();
  const headBaseline = makeBaseline();
  const result = runBaselineGateCommand({
    baseBaseline,
    headBaseline,
    baseBaselinePath: "base.json",
    headBaselinePath: "head.json",
    format: "json",
    hasImplementationChanges: false,
  });
  assert.equal(result.exitCode, 0);
  assert.equal(result.report.hasChange, false);
});

test("runBaselineGateCommand warns when baseline and implementation changes are mixed", () => {
  const baseBaseline = makeBaseline();
  const headBaseline = makeBaseline();
  headBaseline.cells.worker.publicSymbolSet = ["consume", "replay"];
  const result = runBaselineGateCommand({
    baseBaseline,
    headBaseline,
    baseBaselinePath: "base.json",
    headBaselinePath: "head.json",
    format: "json",
    hasImplementationChanges: true,
  });
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0], /baseline changes and implementation changes/);
});
