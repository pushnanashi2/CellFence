import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function git(rootDir, args) {
  const result = spawnSync("git", args, { cwd: rootDir, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout.trim();
}

function runHistoryReplay(args) {
  return spawnSync(process.execPath, ["scripts/history-replay-study.mjs", ...args], {
    cwd: path.resolve("."),
    encoding: "utf8",
    maxBuffer: 100 * 1024 * 1024,
  });
}

function createReplayRepository(rootDir, options = {}) {
  git(rootDir, ["init"]);
  git(rootDir, ["config", "user.email", "cellfence@example.invalid"]);
  git(rootDir, ["config", "user.name", "CellFence Test"]);
  fs.mkdirSync(path.join(rootDir, "src/core"), { recursive: true });
  fs.mkdirSync(path.join(rootDir, "src/app"), { recursive: true });
  fs.writeFileSync(path.join(rootDir, "src/core/public.ts"), "export const core = true;\n");
  fs.writeFileSync(path.join(rootDir, "src/core/internal.ts"), "export const hidden = true;\n");
  fs.writeFileSync(path.join(rootDir, "src/app/public.ts"), "import { core } from '../core/public';\nexport const app = core;\n");
  if (options.invalidEvidence) fs.writeFileSync(path.join(rootDir, "resource-evidence.before.json"), "{}\n");
  writeJson(path.join(rootDir, "cellfence.manifest.json"), {
    schemaVersion: "cellfence.manifest.v1",
    governance: {
      requireOwnership: true,
      include: ["src/**"],
      requiredRules: [
        "CELLFENCE_PRIVATE_IMPORT",
        "CELLFENCE_UNDECLARED_CONSUMER",
        "CELLFENCE_UNOWNED_SOURCE",
      ],
    },
    cells: [
      {
        id: "app",
        ownedPaths: ["src/app/**"],
        publicEntry: "src/app/public.ts",
        publicSymbols: ["app"],
        consumes: [{ cell: "core" }],
        producesArtifacts: [],
      },
      {
        id: "core",
        ownedPaths: ["src/core/**"],
        publicEntry: "src/core/public.ts",
        publicSymbols: ["core"],
        consumes: [],
        producesArtifacts: [],
      },
    ],
  });
  git(rootDir, ["add", "."]);
  git(rootDir, ["commit", "--quiet", "-m", "initial"]);
  const beforeCommit = git(rootDir, ["rev-parse", "HEAD"]);

  fs.writeFileSync(path.join(rootDir, "src/app/leak.ts"), "import { hidden } from '../core/internal';\nexport const leak = hidden;\n");
  git(rootDir, ["add", "."]);
  git(rootDir, ["commit", "--quiet", "-m", "introduce private import"]);
  const afterCommit = git(rootDir, ["rev-parse", "HEAD"]);

  return { beforeCommit, afterCommit };
}

test("history replay detects introduced findings between exact commits", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-history-replay-"));
  try {
    const sourceRepo = path.join(rootDir, "source");
    fs.mkdirSync(sourceRepo, { recursive: true });
    const { beforeCommit, afterCommit } = createReplayRepository(sourceRepo);
    const corpusPath = path.join(rootDir, "history.json");
    const outPath = path.join(rootDir, "report.json");
    writeJson(corpusPath, {
      schemaVersion: "cellfence.history-replay.v1",
      subjects: [
        {
          id: "private-import-intro",
          repository: sourceRepo,
          beforeCommit,
          afterCommit,
          manifest: {
            strategy: "existing",
            path: "cellfence.manifest.json",
          },
          baseline: {
            enabled: true,
          },
          expected: {
            beforeExitCode: 0,
            afterExitCode: 1,
            introducedRuleIds: ["CELLFENCE_PRIVATE_IMPORT"],
            baselineRuleIds: ["CELLFENCE_PRIVATE_IMPORT"],
          },
        },
      ],
    });

    const result = runHistoryReplay(["--corpus", corpusPath, "--workdir", path.join(rootDir, "work"), "--out", outPath]);

    assert.equal(result.status, 0, result.stderr || result.stdout);
    const report = JSON.parse(fs.readFileSync(outPath, "utf8"));
    assert.equal(report.schemaVersion, "cellfence.history-replay-study.v1");
    assert.match(report.evidenceSetSha256, /^[a-f0-9]{64}$/);
    assert.equal(report.summary.total, 1);
    assert.equal(report.summary.replayed, 1);
    assert.equal(report.summary.singleCommitIntroductions, 1);
    assert.equal(report.summary.subjectsWithIntroducedFindings, 1);
    assert.equal(report.summary.expectations.passed, 1);
    assert.equal(report.summary.introducedFindingsByRule.CELLFENCE_PRIVATE_IMPORT, 1);
    assert.equal(report.summary.baselineReplays, 1);
    assert.equal(report.summary.baselineChecksWithFindings, 1);
    const subject = report.subjects[0];
    assert.equal(subject.status, "replayed_introduced_findings");
    assert.equal(subject.replayKind, "single_commit_intro");
    assert.equal(subject.ancestry.beforeIsAncestorOfAfter, true);
    assert.equal(subject.ancestry.commitDistance, 1);
    assert.equal(subject.before.check.exitCode, 0);
    assert.equal(subject.after.check.exitCode, 1);
    assert.equal(subject.before.subjectWorktreeCleanAfterReplay, true);
    assert.equal(subject.after.subjectWorktreeCleanAfterReplay, true);
    assert.equal(subject.introducedFindingCount, 1);
    assert.equal(subject.introducedFindings[0].ruleId, "CELLFENCE_PRIVATE_IMPORT");
    assert.equal(subject.introducedFindings[0].changedFile, true);
    assert.match(subject.before.manifest.sha256, /^[a-f0-9]{64}$/);
    assert.match(subject.after.manifest.sha256, /^[a-f0-9]{64}$/);
    assert.match(subject.baselineReplay.baselineSha256, /^[a-f0-9]{64}$/);
    assert.ok(fs.existsSync(path.join(subject.subjectDir, "before", "logs", "check.audit.jsonl")));
    assert.ok(fs.existsSync(path.join(subject.subjectDir, "after", "logs", "check.audit.jsonl")));
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("history replay rejects floating refs by default", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-history-floating-"));
  try {
    const corpusPath = path.join(rootDir, "history.json");
    writeJson(corpusPath, {
      schemaVersion: "cellfence.history-replay.v1",
      subjects: [
        {
          id: "floating",
          repository: ".",
          before: { ref: "main" },
          after: { ref: "main" },
          manifest: { strategy: "existing" },
        },
      ],
    });

    const result = runHistoryReplay(["--corpus", corpusPath, "--dry-run", "--out", path.join(rootDir, "report.json")]);

    assert.equal(result.status, 2);
    assert.match(result.stderr, /requires exact 40-hex before commit/);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("history replay marks shallow ancestry ambiguity as proof-ineligible", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-history-shallow-ancestry-"));
  try {
    const sourceRepo = path.join(rootDir, "source");
    fs.mkdirSync(sourceRepo, { recursive: true });
    const { beforeCommit, afterCommit } = createReplayRepository(sourceRepo);
    const corpusPath = path.join(rootDir, "history.json");
    const outPath = path.join(rootDir, "report.json");
    writeJson(corpusPath, {
      schemaVersion: "cellfence.history-replay.v1",
      subjects: [
        {
          id: "shallow-ancestry",
          repository: pathToFileURL(sourceRepo).href,
          beforeCommit,
          afterCommit,
          manifest: { strategy: "existing" },
          expected: {
            introducedRuleIds: ["CELLFENCE_PRIVATE_IMPORT"],
          },
        },
      ],
    });

    const result = runHistoryReplay([
      "--corpus",
      corpusPath,
      "--workdir",
      path.join(rootDir, "work"),
      "--out",
      outPath,
      "--clone-mode",
      "shallow",
    ]);

    assert.equal(result.status, 0, result.stderr || result.stdout);
    const report = JSON.parse(fs.readFileSync(outPath, "utf8"));
    const subject = report.subjects[0];
    assert.equal(report.summary.singleCommitIntroductions, 0);
    assert.equal(subject.cloneMode, "shallow");
    assert.equal(subject.status, "replayed_introduced_findings");
    assert.equal(subject.replayKind, "unknown_ancestry");
    assert.equal(subject.ancestry.beforeIsAncestorOfAfter, null);
    assert.match(subject.ancestry.error, /shallow clone boundary/);
    assert.equal(subject.proofEligibility, "not_eligible_unknown_ancestry");
    assert.ok(subject.diff.changedFiles.includes("src/app/leak.ts"));
    assert.equal(subject.introducedFindings[0].ruleId, "CELLFENCE_PRIVATE_IMPORT");
    assert.equal(subject.introducedFindings[0].changedFile, true);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("history replay dry-run validates exact replay subjects without cloning", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-history-dry-run-"));
  try {
    const corpusPath = path.join(rootDir, "history.json");
    const outPath = path.join(rootDir, "report.json");
    writeJson(corpusPath, {
      schemaVersion: "cellfence.history-replay.v1",
      subjects: [
        {
          id: "planned",
          repository: "https://example.invalid/repo.git",
          beforeCommit: "0123456789abcdef0123456789abcdef01234567",
          afterCommit: "fedcba9876543210fedcba9876543210fedcba98",
          manifest: { strategy: "existing" },
        },
      ],
    });

    const result = runHistoryReplay(["--corpus", corpusPath, "--dry-run", "--out", outPath]);

    assert.equal(result.status, 0, result.stderr || result.stdout);
    const report = JSON.parse(fs.readFileSync(outPath, "utf8"));
    assert.equal(report.summary.planned, 1);
    assert.equal(report.summary.failed, 0);
    assert.equal(report.subjects[0].status, "planned");
    assert.equal(report.subjects[0].before.requestedCommit, "0123456789abcdef0123456789abcdef01234567");
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("history replay can discard checkouts after preserving logs and manifests", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-history-discard-"));
  try {
    const sourceRepo = path.join(rootDir, "source");
    fs.mkdirSync(sourceRepo, { recursive: true });
    const { beforeCommit, afterCommit } = createReplayRepository(sourceRepo);
    const corpusPath = path.join(rootDir, "history.json");
    const outPath = path.join(rootDir, "report.json");
    writeJson(corpusPath, {
      schemaVersion: "cellfence.history-replay.v1",
      subjects: [
        {
          id: "discard",
          repository: sourceRepo,
          beforeCommit,
          afterCommit,
          manifest: { strategy: "existing" },
          expected: {
            introducedRuleIds: ["CELLFENCE_PRIVATE_IMPORT"],
          },
        },
      ],
    });

    const result = runHistoryReplay([
      "--corpus",
      corpusPath,
      "--workdir",
      path.join(rootDir, "work"),
      "--out",
      outPath,
      "--clone-mode",
      "shallow",
      "--discard-checkouts",
    ]);

    assert.equal(result.status, 0, result.stderr || result.stdout);
    const report = JSON.parse(fs.readFileSync(outPath, "utf8"));
    const subject = report.subjects[0];
    assert.equal(report.cloneMode, "shallow");
    assert.equal(subject.cloneMode, "shallow");
    assert.equal(subject.checkoutsDiscarded, true);
    assert.equal(fs.existsSync(path.join(subject.subjectDir, "before", "checkout")), false);
    assert.equal(fs.existsSync(path.join(subject.subjectDir, "after", "checkout")), false);
    assert.equal(fs.existsSync(path.join(subject.subjectDir, "before", "logs", "check.audit.jsonl")), true);
    assert.equal(fs.existsSync(path.join(subject.subjectDir, "after", "logs", "check.audit.jsonl")), true);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("history replay treats enabled baseline replay failures as harness failures", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-history-baseline-failure-"));
  try {
    const sourceRepo = path.join(rootDir, "source");
    fs.mkdirSync(sourceRepo, { recursive: true });
    const { beforeCommit, afterCommit } = createReplayRepository(sourceRepo);
    const corpusPath = path.join(rootDir, "history.json");
    const outPath = path.join(rootDir, "report.json");
    writeJson(corpusPath, {
      schemaVersion: "cellfence.history-replay.v1",
      subjects: [
        {
          id: "baseline-failure",
          repository: sourceRepo,
          beforeCommit,
          afterCommit,
          manifest: { strategy: "existing" },
          baseline: {
            enabled: true,
            evidenceBefore: ["missing-resource-evidence.json"],
          },
        },
      ],
    });

    const result = runHistoryReplay(["--corpus", corpusPath, "--workdir", path.join(rootDir, "work"), "--out", outPath]);

    assert.equal(result.status, 1);
    const report = JSON.parse(fs.readFileSync(outPath, "utf8"));
    assert.equal(report.summary.failed, 1);
    assert.equal(report.summary.baselineFailures, 1);
    assert.equal(report.summary.configurationErrors, 1);
    assert.equal(report.subjects[0].status, "baseline_configuration_error_failed");
    assert.equal(report.subjects[0].baselineReplay.status, "configuration_error");
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});
