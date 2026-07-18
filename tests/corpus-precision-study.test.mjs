import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function git(rootDir, args) {
  const result = spawnSync("git", args, { cwd: rootDir, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout.trim();
}

function createSiblingPrefixRepository(rootDir) {
  git(rootDir, ["init"]);
  git(rootDir, ["config", "user.email", "cellfence@example.invalid"]);
  git(rootDir, ["config", "user.name", "CellFence Test"]);
  fs.mkdirSync(path.join(rootDir, "src/user"), { recursive: true });
  fs.mkdirSync(path.join(rootDir, "src/users"), { recursive: true });
  fs.writeFileSync(path.join(rootDir, "src/user/public.ts"), "export const user = true;\n");
  fs.writeFileSync(path.join(rootDir, "src/users/public.ts"), "export const users = true;\n");
  writeJson(path.join(rootDir, "cellfence.manifest.json"), {
    schemaVersion: "cellfence.manifest.v1",
    governance: {
      requireOwnership: true,
      include: ["src/**"],
      requiredRules: ["CELLFENCE_OWNERSHIP_OVERLAP", "CELLFENCE_UNOWNED_SOURCE"],
    },
    cells: [
      {
        id: "user",
        ownedPaths: ["src/user/**"],
        publicEntry: "src/user/public.ts",
        publicSymbols: ["user"],
        consumes: [],
        producesArtifacts: [],
      },
      {
        id: "users",
        ownedPaths: ["src/users/**"],
        publicEntry: "src/users/public.ts",
        publicSymbols: ["users"],
        consumes: [],
        producesArtifacts: [],
      },
    ],
  });
  git(rootDir, ["add", "."]);
  git(rootDir, ["commit", "--quiet", "-m", "initial"]);
  return git(rootDir, ["rev-parse", "HEAD"]);
}

function runCorpusStudy(args) {
  return spawnSync(process.execPath, ["scripts/corpus-precision-study.mjs", ...args], {
    cwd: path.resolve("."),
    encoding: "utf8",
    maxBuffer: 100 * 1024 * 1024,
  });
}

test("corpus precision study clones an exact commit and records CellFence check results", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-corpus-study-"));
  try {
    const sourceRepo = path.join(rootDir, "source");
    fs.mkdirSync(sourceRepo, { recursive: true });
    const commit = createSiblingPrefixRepository(sourceRepo);
    const corpusPath = path.join(rootDir, "corpus.json");
    const workDir = path.join(rootDir, "work");
    const outPath = path.join(rootDir, "report.json");
    writeJson(corpusPath, {
      schemaVersion: "cellfence.corpus.v1",
      subjects: [
        {
          id: "sibling-prefix",
          repository: sourceRepo,
          commit,
          manifest: {
            strategy: "existing",
            path: "cellfence.manifest.json",
          },
          expected: {
            exitCode: 0,
            forbiddenRuleIds: ["CELLFENCE_OWNERSHIP_OVERLAP"],
          },
        },
      ],
    });

    const result = runCorpusStudy(["--corpus", corpusPath, "--workdir", workDir, "--out", outPath]);

    assert.equal(result.status, 0, result.stderr || result.stdout);
    const report = JSON.parse(fs.readFileSync(outPath, "utf8"));
    assert.equal(report.schemaVersion, "cellfence.corpus-study.v1");
    assert.equal(report.summary.total, 1);
    assert.equal(report.summary.completed, 1);
    assert.equal(report.summary.expectations.passed, 1);
    assert.equal(report.subjects[0].commit, commit);
    assert.equal(report.subjects[0].check.exitCode, 0);
    assert.equal(report.subjects[0].check.findingsByRule.CELLFENCE_OWNERSHIP_OVERLAP, undefined);
    assert.ok(fs.existsSync(path.join(workDir, "sibling-prefix", "logs", "check.stdout.log")));
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("corpus precision study rejects floating refs by default", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-corpus-floating-"));
  try {
    const corpusPath = path.join(rootDir, "corpus.json");
    writeJson(corpusPath, {
      schemaVersion: "cellfence.corpus.v1",
      subjects: [
        {
          id: "floating",
          repository: ".",
          ref: "main",
          manifest: { strategy: "existing" },
        },
      ],
    });

    const result = runCorpusStudy(["--corpus", corpusPath, "--dry-run", "--out", path.join(rootDir, "report.json")]);

    assert.equal(result.status, 2);
    assert.match(result.stderr, /requires exact 40-hex commit/);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("corpus precision study dry-run validates frozen corpus entries without cloning", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-corpus-dry-run-"));
  try {
    const corpusPath = path.join(rootDir, "corpus.json");
    const outPath = path.join(rootDir, "report.json");
    writeJson(corpusPath, {
      schemaVersion: "cellfence.corpus.v1",
      subjects: [
        {
          id: "planned",
          repository: "https://example.invalid/repo.git",
          commit: "0123456789abcdef0123456789abcdef01234567",
          manifest: { strategy: "existing" },
        },
      ],
    });

    const result = runCorpusStudy(["--corpus", corpusPath, "--dry-run", "--out", outPath]);

    assert.equal(result.status, 0, result.stderr || result.stdout);
    const report = JSON.parse(fs.readFileSync(outPath, "utf8"));
    assert.equal(report.summary.planned, 1);
    assert.equal(report.summary.failed, 0);
    assert.equal(report.subjects[0].status, "planned");
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});
