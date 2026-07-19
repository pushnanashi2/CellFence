import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const root = process.cwd();
const oracleScript = path.join(root, "scripts", "upstream-policy-oracle.mjs");

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function writeText(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, value);
}

function runGit(args, cwd) {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "CellFence Test",
      GIT_AUTHOR_EMAIL: "cellfence-test@example.invalid",
      GIT_COMMITTER_NAME: "CellFence Test",
      GIT_COMMITTER_EMAIL: "cellfence-test@example.invalid",
    },
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout.trim();
}

test("upstream policy oracle builds a reference manifest and resolves ablation questions", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-upstream-oracle-"));
  const fixtureRepo = path.join(tempDir, "fixture-repo");
  const corpusPath = path.join(tempDir, "corpus.json");
  const outDir = path.join(tempDir, "oracle-out");
  const workDir = path.join(tempDir, "oracle-work");
  try {
    fs.mkdirSync(fixtureRepo, { recursive: true });
    writeJson(path.join(fixtureRepo, "package.json"), {
      private: true,
      workspaces: ["packages/*"],
    });
    writeJson(path.join(fixtureRepo, "packages/core/package.json"), {
      name: "@demo/core",
      exports: {
        ".": {
          types: "./src/entry.ts",
        },
      },
    });
    writeJson(path.join(fixtureRepo, "packages/web/package.json"), {
      name: "@demo/web",
      dependencies: {
        "@demo/core": "workspace:*",
      },
    });
    writeText(path.join(fixtureRepo, "packages/core/src/index.ts"), "export const internal = true;\n");
    writeText(path.join(fixtureRepo, "packages/core/src/entry.ts"), "export const core = true;\n");
    writeText(path.join(fixtureRepo, "packages/web/src/index.ts"), "export const web = true;\n");
    runGit(["init", "--initial-branch=main"], fixtureRepo);
    runGit(["add", "."], fixtureRepo);
    runGit(["commit", "-m", "Fixture upstream policy"], fixtureRepo);
    const commit = runGit(["rev-parse", "HEAD"], fixtureRepo);
    writeJson(corpusPath, {
      schemaVersion: "cellfence.upstream-policy-oracle.corpus.v1",
      subjects: [
        {
          id: "fixture-workspace",
          repository: fixtureRepo,
          commit,
          policy: {
            strategy: "package-workspaces",
            packageRoot: ".",
            scope: "production",
          },
        },
      ],
    });

    const result = spawnSync(process.execPath, [
      oracleScript,
      "--corpus",
      corpusPath,
      "--out-dir",
      outDir,
      "--workdir",
      workDir,
      "--clone-mode",
      "full",
      "--discard-checkouts",
    ], {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 20 * 1024 * 1024,
    });

    assert.equal(result.status, 0, result.stderr || result.stdout);
    const report = JSON.parse(fs.readFileSync(path.join(outDir, "report.json"), "utf8"));
    assert.equal(report.schemaVersion, "cellfence.upstream-policy-oracle.report.v1");
    assert.equal(report.summary.completed, 1);
    assert.equal(report.summary.failed, 0);
    assert.equal(report.summary.policyQuestions, 2);
    assert.deepEqual(report.summary.questionKinds, {
      "consumer-visibility": 1,
      "public-entry": 1,
    });
    assert.equal(report.summary.rawFindingToPolicyQuestionCountRatio, 0);
    assert.deepEqual(report.summary.before.consumerEdges, {
      reference: 1,
      inferred: 0,
      common: 0,
      microPrecision: null,
      microRecall: 0,
      subjectMacroPrecision: null,
      subjectMacroRecall: 0,
      subjectsWithExactEdgeSetAgreement: 0,
      subjectsWithNoReferenceConsumerEdges: 0,
      subjectsWithNoInferredConsumerEdges: 1,
    });
    assert.equal(report.summary.after.consumerEdges.microPrecision, 1);
    assert.equal(report.summary.after.consumerEdges.microRecall, 1);
    assert.equal(report.summary.before.publicEntryExactMatchRateSubjectMacro, 0.5);
    assert.equal(report.summary.after.publicEntryExactMatchRateSubjectMacro, 1);
    const subject = report.subjects[0];
    assert.equal(subject.checkoutDiscarded, true);
    assert.equal(subject.policyQuestions.oracleResolvable, 2);
    assert.equal(subject.policyQuestions.rawFindingToPolicyQuestionCountRatio, 0);
    assert.equal(subject.policyQuestions.findingMapping.zeroImpactQuestions, 2);
    assert.equal(subject.policyQuestions.findingMapping.uniquelyMappedFindings, 0);
    assert.equal(subject.policyQuestions.findingMapping.observedResolvedFindingToActionableQuestionRatio, null);
    assert.equal(subject.blindInference.packagePolicyHints, "ignore");
    assert.equal(subject.blindInference.ablation, "entry-and-dependency-hints");
    assert.equal(subject.resolvedCheck.exitCode, 0);
    assert.equal(subject.mutations.planned, 2);
    assert.equal(subject.artifactSetSha256.length, 64);

    const reference = JSON.parse(fs.readFileSync(path.join(outDir, "references", "fixture-workspace.reference-manifest.json"), "utf8"));
    const inferred = JSON.parse(fs.readFileSync(path.join(outDir, "inferred", "fixture-workspace.manifest.json"), "utf8"));
    const resolved = JSON.parse(fs.readFileSync(path.join(outDir, "resolved-manifests", "fixture-workspace.manifest.json"), "utf8"));
    assert.deepEqual(reference.cells.find((cell) => cell.id === "core").publicEntry, "packages/core/src/entry.ts");
    assert.deepEqual(inferred.cells.find((cell) => cell.id === "core").publicEntry, "packages/core/src/index.ts");
    assert.deepEqual(reference.cells.find((cell) => cell.id === "web").consumes, [{ cell: "core" }]);
    assert.deepEqual(inferred.cells.find((cell) => cell.id === "web").consumes, []);
    assert.deepEqual(resolved.cells.find((cell) => cell.id === "core").publicEntry, "packages/core/src/entry.ts");
    assert.deepEqual(resolved.cells.find((cell) => cell.id === "web").consumes, [{ cell: "core" }]);

    const questions = JSON.parse(fs.readFileSync(path.join(outDir, "questions", "fixture-workspace.questions.json"), "utf8"));
    assert.equal(questions.schemaVersion, "cellfence.policy-questions.v1");
    assert.ok(questions.questions.every((question) => Array.isArray(question.choices[0].manifestPatch)));
    assert.ok(questions.questions.every((question) => Array.isArray(question.affectedFindingFingerprints)));
    assert.ok(questions.questions.some((question) => question.choices[0].manifestPatch.some((operation) => operation.op === "add")));
    const provenance = JSON.parse(fs.readFileSync(path.join(outDir, "provenance", "fixture-workspace.provenance.json"), "utf8"));
    assert.equal(provenance.policySources.length, 3);
    assert.ok(provenance.policySources.every((source) => source.sha256.length === 64));
    const mutations = JSON.parse(fs.readFileSync(path.join(outDir, "mutations", "fixture-workspace.mutations.json"), "utf8"));
    assert.equal(mutations.schemaVersion, "cellfence.oracle-mutations.v1");
    assert.deepEqual(new Set(mutations.plans.map((plan) => plan.kind)), new Set(["allowed-public-import", "private-import"]));
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("upstream policy oracle reads pnpm workspace packages and scoped roots", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-upstream-oracle-pnpm-"));
  const fixtureRepo = path.join(tempDir, "fixture-repo");
  const corpusPath = path.join(tempDir, "corpus.json");
  const outDir = path.join(tempDir, "oracle-out");
  const workDir = path.join(tempDir, "oracle-work");
  try {
    fs.mkdirSync(fixtureRepo, { recursive: true });
    writeJson(path.join(fixtureRepo, "package.json"), { private: true });
    writeText(path.join(fixtureRepo, "pnpm-workspace.yaml"), [
      "packages:",
      "  - 'packages/*'",
      "  - 'packages/@scope/*'",
      "",
    ].join("\n"));
    writeJson(path.join(fixtureRepo, "packages/core/package.json"), {
      name: "@demo/core",
    });
    writeJson(path.join(fixtureRepo, "packages/@scope/web/package.json"), {
      name: "@demo/web",
      dependencies: {
        "@demo/core": "workspace:*",
      },
    });
    writeText(path.join(fixtureRepo, "packages/core/src/index.ts"), "export const core = true;\n");
    writeText(path.join(fixtureRepo, "packages/@scope/web/src/index.ts"), "export const web = true;\n");
    runGit(["init", "--initial-branch=main"], fixtureRepo);
    runGit(["add", "."], fixtureRepo);
    runGit(["commit", "-m", "Fixture pnpm upstream policy"], fixtureRepo);
    const commit = runGit(["rev-parse", "HEAD"], fixtureRepo);
    writeJson(corpusPath, {
      schemaVersion: "cellfence.upstream-policy-oracle.corpus.v1",
      subjects: [
        {
          id: "fixture-pnpm-workspace",
          repository: fixtureRepo,
          commit,
          policy: {
            strategy: "package-workspaces",
            packageRoot: ".",
            scope: "production",
          },
        },
      ],
    });

    const result = spawnSync(process.execPath, [
      oracleScript,
      "--corpus",
      corpusPath,
      "--out-dir",
      outDir,
      "--workdir",
      workDir,
      "--clone-mode",
      "full",
      "--discard-checkouts",
    ], {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 20 * 1024 * 1024,
    });

    assert.equal(result.status, 0, result.stderr || result.stdout);
    const reference = JSON.parse(fs.readFileSync(path.join(outDir, "references", "fixture-pnpm-workspace.reference-manifest.json"), "utf8"));
    assert.deepEqual(reference.cells.map((cell) => [cell.id, cell.ownedPaths[0], cell.packageName, cell.consumes]), [
      ["core", "packages/core/src/**", "@demo/core", []],
      ["web", "packages/@scope/web/src/**", "@demo/web", [{ cell: "core" }]],
    ]);
    const provenance = JSON.parse(fs.readFileSync(path.join(outDir, "provenance", "fixture-pnpm-workspace.provenance.json"), "utf8"));
    assert.ok(provenance.policySources.some((source) => source.kind === "pnpm-workspace"));
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
