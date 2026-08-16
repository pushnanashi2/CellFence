import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { detectBaselineChanges } from "../packages/engine/dist/index.js";
import { runBaselineGateCommand } from "../packages/cli/dist/baseline-gate-command.js";
import { runBaselineGateFull as runCliBaselineGateFull } from "../packages/cli/dist/baseline-gate-full.js";
import { runBaselineGateFull } from "../packages/github-action-baseline-gate/dist/baseline-gate.js";

const root = process.cwd();
const bundledActionEntrypoint = path.join(root, "packages/github-action-baseline-gate/dist/index.js");


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

function git(rootDir, args) {
  return execFileSync("git", args, { cwd: rootDir, encoding: "utf8" });
}

function writeBaseline(rootDir, baseline) {
  fs.writeFileSync(path.join(rootDir, "cellfence.baseline.json"), `${JSON.stringify(baseline, null, 2)}\n`);
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function createBaselineRepository(context) {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-baseline-gate-action-"));
  context.after(() => fs.rmSync(rootDir, { recursive: true, force: true }));
  git(rootDir, ["init", "-q", "-b", "main"]);
  git(rootDir, ["config", "user.name", "CellFence Test"]);
  git(rootDir, ["config", "user.email", "test@example.com"]);
  writeBaseline(rootDir, makeBaseline());
  git(rootDir, ["add", "cellfence.baseline.json"]);
  git(rootDir, ["commit", "-qm", "base baseline"]);
  return rootDir;
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

test("detectBaselineChanges flags accepted cellId changes even when cell records are stale", () => {
  const baseBaseline = makeBaseline({ cellIds: ["api"] });
  const headBaseline = makeBaseline({ cellIds: ["api", "worker"] });
  const report = detectBaselineChanges(baseBaseline, headBaseline, "base.json", "head.json");
  const cellIds = report.deltas.find((delta) => delta.dimension === "cellIds");
  assert.equal(report.hasChange, true);
  assert.deepEqual(cellIds?.added, ["worker"]);
  assert.deepEqual(cellIds?.removed, []);
  assert.deepEqual(report.deltas.find((delta) => delta.dimension === "ownedPaths")?.added, ["worker: src/worker/**"]);
  assert.deepEqual(report.deltas.find((delta) => delta.dimension === "publicSymbols")?.added, ["worker.consume"]);
  assert.deepEqual(report.deltas.find((delta) => delta.dimension === "dependencyCounts")?.added, ["worker: head=0"]);
});

test("detectBaselineChanges ignores stale cell records outside accepted cellIds", () => {
  const baseBaseline = makeBaseline({ cellIds: ["api"] });
  const headBaseline = makeBaseline({ cellIds: ["api"] });
  headBaseline.cells.worker.publicSymbolSet = ["consume", "stale"];
  const report = detectBaselineChanges(baseBaseline, headBaseline, "base.json", "head.json");
  assert.equal(report.hasChange, false);
  assert.deepEqual(report.deltas, []);
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

test("github action baseline gate reads base ref and working tree baseline", (context) => {
  const rootDir = createBaselineRepository(context);
  const headBaseline = makeBaseline();
  headBaseline.cells.worker.publicSymbolSet = ["consume", "replay"];
  writeBaseline(rootDir, headBaseline);

  const result = runBaselineGateFull({
    rootDir,
    baselineFile: "cellfence.baseline.json",
    baseRef: "HEAD",
    hasImplementationChanges: true,
  });

  assert.equal(result.exitCode, 1);
  assert.equal(result.report.hasChange, true);
  assert.equal(result.report.baseBaselinePath, "HEAD:cellfence.baseline.json");
  assert.equal(result.report.headBaselinePath, path.join(rootDir, "cellfence.baseline.json"));
  assert.deepEqual(result.warnings, ["baseline changes and implementation changes are mixed in the same pull request"]);
  assert.deepEqual(result.report.deltas.find((delta) => delta.dimension === "publicSymbols")?.added, [
    "worker.replay",
  ]);
});

test("github action baseline gate reads git ref baselines relative to repository root", (context) => {
  const rootDir = createBaselineRepository(context);
  const packageDir = path.join(rootDir, "packages/app");
  fs.mkdirSync(packageDir, { recursive: true });
  const headBaseline = makeBaseline();
  headBaseline.cells.worker.publicSymbolSet = ["consume", "subdir"];
  writeBaseline(rootDir, headBaseline);

  const result = runBaselineGateFull({
    rootDir: packageDir,
    baselineFile: path.join(rootDir, "cellfence.baseline.json"),
    baseRef: "HEAD",
    hasImplementationChanges: false,
  });

  assert.equal(result.exitCode, 1);
  assert.equal(result.report.hasChange, true);
  assert.deepEqual(result.report.deltas.find((delta) => delta.dimension === "publicSymbols")?.added, [
    "worker.subdir",
  ]);
});

test("github action baseline gate validates baseline JSON before diffing", (context) => {
  const rootDir = createBaselineRepository(context);
  fs.writeFileSync(path.join(rootDir, "cellfence.baseline.json"), JSON.stringify({
    schemaVersion: "wrong",
    generatedAt: "not-a-date",
    cells: {},
  }));
  assert.throws(
    () => runBaselineGateFull({
      rootDir,
      baselineFile: "cellfence.baseline.json",
      baseRef: "HEAD",
    }),
    /not a valid CellFenceBaseline: schemaVersion must be cellfence\.baseline\.v1; generatedAt must be an ISO 8601 date-time string/,
  );
});

test("baseline gate reports baselines introduced or removed across git refs", (context) => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-baseline-gate-missing-"));
  context.after(() => fs.rmSync(rootDir, { recursive: true, force: true }));
  git(rootDir, ["init", "-q", "-b", "main"]);
  git(rootDir, ["config", "user.name", "CellFence Test"]);
  git(rootDir, ["config", "user.email", "test@example.com"]);
  fs.writeFileSync(path.join(rootDir, "README.md"), "no baseline yet\n");
  git(rootDir, ["add", "README.md"]);
  git(rootDir, ["commit", "-qm", "initial without baseline"]);
  const emptyRef = git(rootDir, ["rev-parse", "HEAD"]).trim();
  writeBaseline(rootDir, makeBaseline());
  git(rootDir, ["add", "cellfence.baseline.json"]);
  git(rootDir, ["commit", "-qm", "add baseline"]);

  for (const runGate of [runBaselineGateFull, (options) => runCliBaselineGateFull({ ...options, format: "json" })]) {
    const added = runGate({
      rootDir,
      baselineFile: "cellfence.baseline.json",
      baseRef: emptyRef,
      headRef: "HEAD",
    });
    assert.equal(added.exitCode, 1);
    assert.deepEqual(added.report.deltas.find((delta) => delta.dimension === "cellIds"), {
      dimension: "cellIds",
      added: ["api", "worker"],
      removed: [],
    });

    const removed = runGate({
      rootDir,
      baselineFile: "cellfence.baseline.json",
      baseRef: "HEAD",
      headRef: emptyRef,
    });
    assert.equal(removed.exitCode, 1);
    assert.deepEqual(removed.report.deltas.find((delta) => delta.dimension === "cellIds"), {
      dimension: "cellIds",
      added: [],
      removed: ["api", "worker"],
    });
  }
});

test("baseline gate treats baselines missing on both git sides as unchanged empty baselines", (context) => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-baseline-gate-both-missing-"));
  context.after(() => fs.rmSync(rootDir, { recursive: true, force: true }));
  git(rootDir, ["init", "-q", "-b", "main"]);
  git(rootDir, ["config", "user.name", "CellFence Test"]);
  git(rootDir, ["config", "user.email", "test@example.com"]);
  fs.writeFileSync(path.join(rootDir, "README.md"), "no baseline on either side\n");
  git(rootDir, ["add", "README.md"]);
  git(rootDir, ["commit", "-qm", "without baseline"]);

  const result = runBaselineGateFull({
    rootDir,
    baselineFile: "missing/cellfence.baseline.json",
    baseRef: "HEAD",
    headRef: "HEAD",
  });

  assert.equal(result.exitCode, 0);
  assert.equal(result.report.hasChange, false);
  assert.deepEqual(result.report.deltas, []);
});

test("github action baseline gate rejects invalid git ref syntax before git lookup", (context) => {
  const rootDir = createBaselineRepository(context);
  for (const ref of ["bad ref abcd", "abcd ref", "feature\nbranch"]) {
    assert.throws(
      () => runBaselineGateFull({
        rootDir,
        baselineFile: "cellfence.baseline.json",
        baseRef: ref,
      }),
      /refused to read baseline at invalid git ref/,
    );
  }
});

test("github action baseline gate rejects baseline paths outside the repository", (context) => {
  const rootDir = createBaselineRepository(context);
  const outsideBaseline = path.join(rootDir, "..", "outside.baseline.json");

  assert.throws(
    () => runBaselineGateFull({
      rootDir,
      baselineFile: outsideBaseline,
      baseRef: "HEAD",
    }),
    /baseline file must stay inside the git repository/,
  );
});

test("github action baseline gate fails closed for unresolved git refs", (context) => {
  const rootDir = createBaselineRepository(context);

  assert.throws(
    () => runBaselineGateFull({
      rootDir,
      baselineFile: "cellfence.baseline.json",
      baseRef: "missing/ref",
    }),
    (error) => {
      assert.match(error.message, /cannot resolve git ref missing\/ref/);
      assert.ok(error.cause instanceof Error);
      return true;
    },
  );
});

test("github action baseline gate treats missing working-tree baseline as empty", (context) => {
  const rootDir = createBaselineRepository(context);
  fs.rmSync(path.join(rootDir, "cellfence.baseline.json"));
  const result = runBaselineGateFull({
    rootDir,
    baselineFile: "cellfence.baseline.json",
    baseRef: "HEAD",
  });

  assert.equal(result.exitCode, 1);
  assert.deepEqual(result.report.deltas.find((delta) => delta.dimension === "cellIds"), {
    dimension: "cellIds",
    added: [],
    removed: ["api", "worker"],
  });
});

test("github action baseline gate preserves parse errors for malformed working-tree baseline", (context) => {
  const rootDir = createBaselineRepository(context);
  fs.writeFileSync(path.join(rootDir, "cellfence.baseline.json"), "{not-json");

  assert.throws(
    () => runBaselineGateFull({
      rootDir,
      baselineFile: "cellfence.baseline.json",
      baseRef: "HEAD",
    }),
    SyntaxError,
  );
});

test("cli baseline gate validates full baseline schema before diffing", (context) => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-baseline-gate-schema-"));
  context.after(() => fs.rmSync(rootDir, { recursive: true, force: true }));
  const basePath = path.join(rootDir, "base.baseline.json");
  const headPath = path.join(rootDir, "head.baseline.json");
  writeJson(basePath, {
    schemaVersion: "cellfence.baseline.v1",
    generatedAt: "not-a-date",
    cells: {},
  });
  writeBaseline(rootDir, makeBaseline());
  fs.renameSync(path.join(rootDir, "cellfence.baseline.json"), headPath);

  assert.throws(
    () => runCliBaselineGateFull({
      rootDir,
      baselineFile: "cellfence.baseline.json",
      basePath,
      headPath,
      format: "json",
    }),
    /not a valid CellFenceBaseline: generatedAt must be an ISO 8601 date-time string/,
  );
});

test("github action baseline gate reads working tree baseline and head ref", (context) => {
  const rootDir = createBaselineRepository(context);
  const headBaseline = makeBaseline();
  headBaseline.cells.worker.ownedPathSet = ["src/worker/**", "src/worker/integration/**"];
  writeBaseline(rootDir, headBaseline);
  git(rootDir, ["add", "cellfence.baseline.json"]);
  git(rootDir, ["commit", "-qm", "head baseline"]);
  writeBaseline(rootDir, makeBaseline());

  const result = runBaselineGateFull({
    rootDir,
    baselineFile: path.join(rootDir, "cellfence.baseline.json"),
    headRef: "HEAD",
    hasImplementationChanges: false,
  });

  assert.equal(result.exitCode, 1);
  assert.equal(result.report.hasChange, true);
  assert.equal(result.report.baseBaselinePath, path.join(rootDir, "cellfence.baseline.json"));
  assert.equal(result.report.headBaselinePath, "HEAD:cellfence.baseline.json");
  assert.deepEqual(result.warnings, []);
  assert.deepEqual(result.report.deltas.find((delta) => delta.dimension === "ownedPaths")?.added, [
    "worker: src/worker/integration/**",
  ]);
});

test("github action baseline gate exits zero for unchanged ref and file baselines", (context) => {
  const rootDir = createBaselineRepository(context);
  const result = runBaselineGateFull({
    rootDir,
    baselineFile: "cellfence.baseline.json",
    baseRef: "HEAD",
    hasImplementationChanges: true,
  });

  assert.equal(result.exitCode, 0);
  assert.equal(result.report.hasChange, false);
  assert.equal(result.report.baseBaselinePath, "HEAD:cellfence.baseline.json");
  assert.equal(result.report.headBaselinePath, path.join(rootDir, "cellfence.baseline.json"));
  assert.deepEqual(result.report.deltas, []);
  assert.deepEqual(result.warnings, []);
});

test("github action baseline gate rejects runs without any baseline ref", (context) => {
  const rootDir = createBaselineRepository(context);
  assert.throws(
    () => runBaselineGateFull({ rootDir, baselineFile: "cellfence.baseline.json" }),
    /either a base-ref or a head-ref is required/,
  );
});

test("bundled github action baseline gate fails outside pull request events", () => {
  const result = spawnSync(process.execPath, [bundledActionEntrypoint], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      GITHUB_EVENT_NAME: "push",
      GITHUB_EVENT_PATH: "",
      INPUT_GITHUB_TOKEN: "",
    },
  });

  assert.equal(result.status, 1, result.stderr);
  assert.match(`${result.stdout}\n${result.stderr}`, /requires a pull_request event/);
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
  const exportedMatch = /export const ACTION_INPUT_NAMES = \[([\s\S]*?)\] as const;/m.exec(source);
  assert.ok(exportedMatch, "ACTION_INPUT_NAMES missing");
  const exportedInputs = [...exportedMatch[1].matchAll(/"([^"]+)"/g)].map((match) => match[1]).sort();
  const yamlInputs = [...actionYaml.matchAll(/^ {2}([a-z][a-z0-9-]*):$/gm)].map((match) => match[1]).sort();
  assert.deepEqual(yamlInputs, sourceInputs);
  assert.deepEqual(exportedInputs, yamlInputs);
  assert.match(actionYaml, /github-token:\r?\n\s+description: "GitHub token used to read PR reviews and update labels\/comments\. Pass `\$\{\{ github\.token \}\}`\."\r?\n\s+required: true/);
  assert.match(actionYaml, /baseline-codeowners:\r?\n\s+description: "Comma-separated list of GitHub usernames who can approve a baseline change\. Team entries are not resolved in this prototype\./);
  assert.match(actionYaml, /baseline-file:\r?\n\s+description: "Repo-relative path to the baseline JSON\."\r?\n\s+required: false\r?\n\s+default: "\.cellfence\/baselines\/cellfence\.baseline\.json"/);
  assert.match(source, /core\.getInput\("github-token", \{ required: true \}\)/);
  assert.match(source, /parseBooleanInput\("fail-on-mixed-pr", true\)/);
  assert.match(actionYaml, /fail-on-mixed-pr:\r?\n\s+description: "When `require-separate-pr` is true, exit non-zero if the PR mixes baseline and implementation changes\."\r?\n\s+required: false\r?\n\s+default: "true"/);
  assert.match(source, /baseline-codeowners currently supports GitHub usernames only/);
  assert.match(source, /repos\.getContent\(\{ owner, repo, path: codeownersPath, ref \}\)/);
  assert.match(source, /loadCodeownersFromRepo\(octokit, context\.repo\.owner, context\.repo\.repo, baselineFile, baseSha\)/);
  assert.match(source, /assertPullRequestRevision\(octokit, owner, repo, pullNumber, expectedBaseSha, expectedHeadSha\)/);
  assert.match(source, /review\.state === "APPROVED" && review\.commitId === headSha/);
  assert.doesNotMatch(source, /codeowners\.length === 0\)\s*return true/);
  assert.match(source, /codeowners\.length === 0\)\s*return false/);
  assert.match(source, /function changedFileIsBaseline\(name: string, baselineFile: string\): boolean/);
  assert.match(source, /if \(changedFileIsBaseline\(normalized, baselineFile\)\) return false/);
  assert.match(source, /mode === "create"/);
  assert.match(source, /removeLabelIfPresent/);
});
