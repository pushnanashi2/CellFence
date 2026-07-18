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

function createSimpleRepository(rootDir, options = {}) {
  git(rootDir, ["init"]);
  git(rootDir, ["config", "user.email", "cellfence@example.invalid"]);
  git(rootDir, ["config", "user.name", "CellFence Test"]);
  fs.mkdirSync(path.join(rootDir, "src/app"), { recursive: true });
  fs.writeFileSync(path.join(rootDir, "src/app/public.ts"), "export const app = true;\n");
  if (options.manifest !== false) {
    writeJson(path.join(rootDir, "cellfence.manifest.json"), options.manifest || {
      schemaVersion: "cellfence.manifest.v1",
      governance: {
        requireOwnership: true,
        include: ["src/**"],
        requiredRules: ["CELLFENCE_UNOWNED_SOURCE"],
      },
      cells: [
        {
          id: "app",
          ownedPaths: ["src/app/**"],
          publicEntry: "src/app/public.ts",
          publicSymbols: ["app"],
          consumes: [],
          producesArtifacts: [],
        },
      ],
    });
  }
  git(rootDir, ["add", "."]);
  git(rootDir, ["commit", "--quiet", "-m", "initial"]);
  return git(rootDir, ["rev-parse", "HEAD"]);
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
    assert.equal(report.summary.checksClean, 1);
    assert.equal(report.summary.expectations.passed, 1);
    assert.equal(report.subjects[0].status, "checked_clean");
    assert.equal(report.subjects[0].commit, commit);
    assert.match(report.subjects[0].gitTree, /^[a-f0-9]{40}$/);
    assert.match(report.subjects[0].manifest.sha256, /^[a-f0-9]{64}$/);
    assert.equal(report.subjects[0].check.exitCode, 0);
    assert.equal(report.subjects[0].check.findingsByRule.CELLFENCE_OWNERSHIP_OVERLAP, undefined);
    assert.ok(fs.existsSync(path.join(report.subjects[0].subjectDir, "logs", "check.stdout.log")));
    assert.ok(fs.existsSync(path.join(report.subjects[0].subjectDir, "logs", "check.audit.jsonl")));
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

test("corpus precision study rejects unsafe subject ids before touching the workdir", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-corpus-unsafe-id-"));
  try {
    const corpusPath = path.join(rootDir, "corpus.json");
    writeJson(corpusPath, {
      schemaVersion: "cellfence.corpus.v1",
      subjects: [
        {
          id: "..",
          repository: "https://example.invalid/repo.git",
          commit: "0123456789abcdef0123456789abcdef01234567",
          manifest: { strategy: "existing" },
        },
      ],
    });

    const result = runCorpusStudy(["--corpus", corpusPath, "--dry-run", "--out", path.join(rootDir, "report.json")]);

    assert.equal(result.status, 2);
    assert.match(result.stderr, /subject id is not allowed/);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("corpus precision study keeps sanitized subject ids in distinct hashed directories", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-corpus-id-digest-"));
  try {
    const corpusPath = path.join(rootDir, "corpus.json");
    const outPath = path.join(rootDir, "report.json");
    writeJson(corpusPath, {
      schemaVersion: "cellfence.corpus.v1",
      subjects: [
        {
          id: "foo/bar",
          repository: "https://example.invalid/repo.git",
          commit: "0123456789abcdef0123456789abcdef01234567",
          manifest: { strategy: "existing" },
        },
        {
          id: "foo-bar",
          repository: "https://example.invalid/repo.git",
          commit: "0123456789abcdef0123456789abcdef01234567",
          manifest: { strategy: "existing" },
        },
      ],
    });

    const result = runCorpusStudy(["--corpus", corpusPath, "--dry-run", "--out", outPath]);

    assert.equal(result.status, 0, result.stderr || result.stdout);
    const report = JSON.parse(fs.readFileSync(outPath, "utf8"));
    assert.notEqual(report.subjects[0].subjectDir, report.subjects[1].subjectDir);
    assert.match(path.basename(report.subjects[0].subjectDir), /^foo-bar-[a-f0-9]{12}$/);
    assert.match(path.basename(report.subjects[1].subjectDir), /^foo-bar-[a-f0-9]{12}$/);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("corpus precision study rejects manifest path escape", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-corpus-path-escape-"));
  try {
    const corpusPath = path.join(rootDir, "corpus.json");
    writeJson(corpusPath, {
      schemaVersion: "cellfence.corpus.v1",
      subjects: [
        {
          id: "escape",
          repository: "https://example.invalid/repo.git",
          commit: "0123456789abcdef0123456789abcdef01234567",
          manifest: { strategy: "existing", path: "../outside.json" },
        },
      ],
    });

    const result = runCorpusStudy(["--corpus", corpusPath, "--dry-run", "--out", path.join(rootDir, "report.json")]);

    assert.equal(result.status, 2);
    assert.match(result.stderr, /manifest\.path escapes its root/);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("corpus precision study rejects manifest source outside the corpus directory", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-corpus-source-escape-"));
  try {
    fs.writeFileSync(path.join(rootDir, "secret.json"), "{}\n");
    const corpusDir = path.join(rootDir, "corpus");
    const corpusPath = path.join(corpusDir, "corpus.json");
    writeJson(corpusPath, {
      schemaVersion: "cellfence.corpus.v1",
      subjects: [
        {
          id: "copy-escape",
          repository: "https://example.invalid/repo.git",
          commit: "0123456789abcdef0123456789abcdef01234567",
          manifest: { strategy: "copy", source: "../secret.json" },
        },
      ],
    });

    const result = runCorpusStudy(["--corpus", corpusPath, "--dry-run", "--out", path.join(rootDir, "report.json")]);

    assert.equal(result.status, 2);
    assert.match(result.stderr, /manifest\.source escapes its root/);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("corpus precision study rejects check args that override fixed execution controls", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-corpus-check-args-"));
  try {
    const corpusPath = path.join(rootDir, "corpus.json");
    writeJson(corpusPath, {
      schemaVersion: "cellfence.corpus.v1",
      subjects: [
        {
          id: "override",
          repository: "https://example.invalid/repo.git",
          commit: "0123456789abcdef0123456789abcdef01234567",
          manifest: { strategy: "existing" },
          check: { args: ["--manifest=elsewhere.json"] },
        },
      ],
    });

    const result = runCorpusStudy(["--corpus", corpusPath, "--dry-run", "--out", path.join(rootDir, "report.json")]);

    assert.equal(result.status, 2);
    assert.match(result.stderr, /cannot override fixed CellFence check argument --manifest/);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("corpus precision study supports copy manifests from the corpus directory", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-corpus-copy-"));
  try {
    const sourceRepo = path.join(rootDir, "source");
    fs.mkdirSync(sourceRepo, { recursive: true });
    const commit = createSimpleRepository(sourceRepo, { manifest: false });
    const manifestSource = path.join(rootDir, "manifests", "copied.json");
    writeJson(manifestSource, {
      schemaVersion: "cellfence.manifest.v1",
      governance: {
        requireOwnership: true,
        include: ["src/**"],
        requiredRules: ["CELLFENCE_UNOWNED_SOURCE"],
      },
      cells: [
        {
          id: "app",
          ownedPaths: ["src/app/**"],
          publicEntry: "src/app/public.ts",
          publicSymbols: ["app"],
          consumes: [],
          producesArtifacts: [],
        },
      ],
    });
    const corpusPath = path.join(rootDir, "corpus.json");
    const outPath = path.join(rootDir, "report.json");
    writeJson(corpusPath, {
      schemaVersion: "cellfence.corpus.v1",
      subjects: [
        {
          id: "copy",
          repository: sourceRepo,
          commit,
          manifest: { strategy: "copy", source: "manifests/copied.json" },
        },
      ],
    });

    const result = runCorpusStudy(["--corpus", corpusPath, "--workdir", path.join(rootDir, "work"), "--out", outPath]);

    assert.equal(result.status, 0, result.stderr || result.stdout);
    const report = JSON.parse(fs.readFileSync(outPath, "utf8"));
    assert.equal(report.subjects[0].status, "checked_clean");
    assert.match(report.subjects[0].manifest.sha256, /^[a-f0-9]{64}$/);
    assert.ok(report.subjects[0].manifest.effectivePath.includes(`${path.sep}control${path.sep}`));
    assert.equal(fs.existsSync(path.join(report.subjects[0].subjectDir, "checkout", "cellfence.manifest.json")), false);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("corpus precision study supports infer manifests with the default path", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-corpus-infer-"));
  try {
    const sourceRepo = path.join(rootDir, "source");
    fs.mkdirSync(sourceRepo, { recursive: true });
    const commit = createSimpleRepository(sourceRepo, { manifest: false });
    const corpusPath = path.join(rootDir, "corpus.json");
    const outPath = path.join(rootDir, "report.json");
    writeJson(corpusPath, {
      schemaVersion: "cellfence.corpus.v1",
      subjects: [
        {
          id: "infer",
          repository: sourceRepo,
          commit,
          manifest: { strategy: "infer" },
        },
      ],
    });

    const result = runCorpusStudy(["--corpus", corpusPath, "--workdir", path.join(rootDir, "work"), "--out", outPath]);

    assert.equal(result.status, 0, result.stderr || result.stdout);
    const report = JSON.parse(fs.readFileSync(outPath, "utf8"));
    assert.equal(report.subjects[0].status, "checked_clean");
    assert.equal(report.subjects[0].manifest.path, "cellfence.manifest.json");
    assert.ok(report.subjects[0].manifest.effectivePath.includes(`${path.sep}control${path.sep}`));
    assert.match(report.subjects[0].manifest.sha256, /^[a-f0-9]{64}$/);
    assert.equal(report.subjects[0].subjectWorktreeCleanBeforeManifest, true);
    assert.equal(report.subjects[0].subjectWorktreeCleanBeforeCheck, true);
    assert.equal(fs.existsSync(path.join(report.subjects[0].subjectDir, "checkout", "cellfence.manifest.json")), false);
    assert.equal(fs.existsSync(path.join(report.subjects[0].subjectDir, "checkout", "src", "example", "public.ts")), false);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("corpus precision study infer does not follow a dangling checkout manifest symlink", { skip: process.platform === "win32" ? "symlink setup requires elevated privileges on Windows" : false }, () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-corpus-infer-symlink-"));
  try {
    const sourceRepo = path.join(rootDir, "source");
    fs.mkdirSync(sourceRepo, { recursive: true });
    const escapedPath = path.join(rootDir, "escaped-manifest.json");
    fs.symlinkSync(escapedPath, path.join(sourceRepo, "cellfence.manifest.json"));
    const commit = createSimpleRepository(sourceRepo, { manifest: false });
    const corpusPath = path.join(rootDir, "corpus.json");
    const outPath = path.join(rootDir, "report.json");
    writeJson(corpusPath, {
      schemaVersion: "cellfence.corpus.v1",
      subjects: [
        {
          id: "infer-symlink",
          repository: sourceRepo,
          commit,
          manifest: { strategy: "infer" },
        },
      ],
    });

    const result = runCorpusStudy(["--corpus", corpusPath, "--workdir", path.join(rootDir, "work"), "--out", outPath]);

    assert.equal(result.status, 0, result.stderr || result.stdout);
    const report = JSON.parse(fs.readFileSync(outPath, "utf8"));
    assert.equal(report.subjects[0].status, "checked_clean");
    assert.equal(report.subjects[0].subjectWorktreeCleanBeforeCheck, true);
    assert.equal(fs.existsSync(escapedPath), false);
    assert.equal(fs.lstatSync(path.join(report.subjects[0].subjectDir, "checkout", "cellfence.manifest.json")).isSymbolicLink(), true);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("corpus precision study classifies CellFence configuration errors as harness failures", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-corpus-config-error-"));
  try {
    const sourceRepo = path.join(rootDir, "source");
    fs.mkdirSync(sourceRepo, { recursive: true });
    const commit = createSimpleRepository(sourceRepo, {
      manifest: {
        schemaVersion: "not-cellfence",
        cells: [],
      },
    });
    const corpusPath = path.join(rootDir, "corpus.json");
    const outPath = path.join(rootDir, "report.json");
    writeJson(corpusPath, {
      schemaVersion: "cellfence.corpus.v1",
      subjects: [
        {
          id: "config-error",
          repository: sourceRepo,
          commit,
          manifest: { strategy: "existing" },
        },
      ],
    });

    const result = runCorpusStudy(["--corpus", corpusPath, "--workdir", path.join(rootDir, "work"), "--out", outPath]);

    assert.equal(result.status, 1);
    const report = JSON.parse(fs.readFileSync(outPath, "utf8"));
    assert.equal(report.summary.failed, 1);
    assert.equal(report.summary.configurationErrors, 1);
    assert.equal(report.subjects[0].status, "configuration_error");
    assert.equal(report.subjects[0].check.exitCode, 2);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("corpus precision study keeps clone failures in the denominator", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-corpus-clone-failure-"));
  try {
    const corpusPath = path.join(rootDir, "corpus.json");
    const outPath = path.join(rootDir, "report.json");
    writeJson(corpusPath, {
      schemaVersion: "cellfence.corpus.v1",
      subjects: [
        {
          id: "missing-repo",
          repository: path.join(rootDir, "missing"),
          commit: "0123456789abcdef0123456789abcdef01234567",
          manifest: { strategy: "existing" },
        },
      ],
    });

    const result = runCorpusStudy(["--corpus", corpusPath, "--workdir", path.join(rootDir, "work"), "--out", outPath]);

    assert.equal(result.status, 1);
    const report = JSON.parse(fs.readFileSync(outPath, "utf8"));
    assert.equal(report.summary.total, 1);
    assert.equal(report.summary.failed, 1);
    assert.equal(report.subjects[0].status, "clone_failed");
    assert.equal(report.subjects[0].stage, "clone");
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("corpus precision study records check timeouts and continues to the next subject", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-corpus-timeout-"));
  try {
    const sourceRepo = path.join(rootDir, "source");
    fs.mkdirSync(sourceRepo, { recursive: true });
    const commit = createSimpleRepository(sourceRepo);
    const corpusPath = path.join(rootDir, "corpus.json");
    const outPath = path.join(rootDir, "report.json");
    writeJson(corpusPath, {
      schemaVersion: "cellfence.corpus.v1",
      subjects: [
        {
          id: "timeout",
          repository: sourceRepo,
          commit,
          manifest: { strategy: "existing" },
          check: { timeoutMs: 1 },
        },
        {
          id: "after-timeout",
          repository: sourceRepo,
          commit,
          manifest: { strategy: "existing" },
        },
      ],
    });

    const result = runCorpusStudy(["--corpus", corpusPath, "--workdir", path.join(rootDir, "work"), "--out", outPath]);

    assert.equal(result.status, 1);
    const report = JSON.parse(fs.readFileSync(outPath, "utf8"));
    assert.equal(report.summary.total, 2);
    assert.equal(report.summary.timeouts, 1);
    assert.equal(report.subjects[0].status, "timeout");
    assert.equal(report.subjects[0].check.status, "timeout");
    assert.equal(report.subjects[1].status, "checked_clean");
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});
