import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { detectBaselineChanges } from "../packages/engine/dist/index.js";
import { runBaselineGateCommand } from "../packages/cli/dist/baseline-gate-command.js";

const root = process.cwd();


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
        artifactContracts: [],
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
        artifactContracts: [],
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

test("runBaselineGateCommand preserves skipped-cell fail-closed state", () => {
  const baseBaseline = makeBaseline();
  const headBaseline = makeBaseline();
  delete baseBaseline.cells.api.ownedPathSet;
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
  assert.deepEqual(result.report.deltas.find((delta) => delta.dimension === "ownedPaths")?.skippedCells, ["api"]);
});

test("detectBaselineChanges flags artifact contract changes", () => {
  const baseBaseline = makeBaseline();
  const headBaseline = makeBaseline();
  headBaseline.cells.worker.artifactContracts = ["produce:events:src/worker/events/**"];
  const report = detectBaselineChanges(baseBaseline, headBaseline, "base.json", "head.json");
  const artifactContracts = report.deltas.find((delta) => delta.dimension === "artifactContracts");
  assert.ok(artifactContracts);
  assert.deepEqual(artifactContracts.added, ["worker: produce:events:src/worker/events/**"]);
});

test("baseline gate action metadata declares every source input", () => {
  const source = fs.readFileSync(path.join(root, "packages/github-action-baseline-gate/src/index.ts"), "utf8");
  const actionYaml = fs.readFileSync(path.join(root, "packages/github-action-baseline-gate/action.yml"), "utf8");
  const sourceMatch = /const ACTION_METADATA_INPUT_NAMES = \[([\s\S]*?)\] as const;/m.exec(source);
  assert.ok(sourceMatch, "ACTION_METADATA_INPUT_NAMES missing");
  const sourceInputs = [...sourceMatch[1].matchAll(/"([^"]+)"/g)].map((match) => match[1]).sort();
  const yamlInputs = [...actionYaml.matchAll(/^ {2}([a-z][a-z0-9-]*):$/gm)].map((match) => match[1]).sort();
  assert.deepEqual(yamlInputs, sourceInputs);
  assert.match(actionYaml, /github-token:\r?\n\s+description: "GitHub token used to read PR reviews and update labels\/comments\. Pass `\$\{\{ github\.token \}\}`\."\r?\n\s+required: true/);
  assert.match(actionYaml, /baseline-file:\r?\n\s+description: "Repo-relative path to the baseline JSON\."\r?\n\s+required: false\r?\n\s+default: "\.cellfence\/baselines\/cellfence\.baseline\.json"/);
  assert.match(source, /core\.getInput\("github-token", \{ required: true \}\)/);
  assert.match(source, /review\.state === "APPROVED" && review\.commitId === headSha/);
  assert.match(source, /mode === "create"/);
  assert.match(source, /removeLabelIfPresent/);
});
