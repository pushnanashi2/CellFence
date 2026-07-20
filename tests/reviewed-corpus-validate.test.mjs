import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const root = process.cwd();
const scriptPath = path.join(root, "scripts", "reviewed-corpus-validate.mjs");

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function runValidator(args) {
  return spawnSync(process.execPath, [scriptPath, ...args], {
    cwd: root,
    encoding: "utf8",
  });
}

test("reviewed corpus validator accepts exact commits with reviewed copy manifests", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-reviewed-corpus-ok-"));
  try {
    const corpusPath = path.join(tempDir, "corpus.json");
    writeJson(path.join(tempDir, "manifests", "demo.json"), { schemaVersion: "cellfence.manifest.v1", cells: [] });
    writeJson(corpusPath, {
      schemaVersion: "cellfence.corpus.v1",
      selectionPolicy: {
        date: "2026-07-19",
        source: "fixture",
      },
      subjects: [
        {
          id: "demo",
          repository: "https://github.com/example/demo.git",
          commit: "0123456789abcdef0123456789abcdef01234567",
          manifest: {
            strategy: "copy",
            source: "manifests/demo.json",
            reviewStatus: "reviewed",
            review: {
              reviewers: ["reviewer-a"],
              boundaryEvidence: ["package exports"],
            },
          },
        },
      ],
    });

    const result = runValidator(["--corpus", corpusPath]);

    assert.equal(result.status, 0, result.stderr || result.stdout);
    const report = JSON.parse(result.stdout);
    assert.equal(report.ok, true);
    assert.equal(report.summary.precisionEligibleSubjects, 1);
    assert.equal(report.summary.ineligibleSubjects, 0);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("reviewed corpus validator rejects infer and unreviewed copy manifests", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-reviewed-corpus-reject-"));
  try {
    const corpusPath = path.join(tempDir, "corpus.json");
    writeJson(corpusPath, {
      schemaVersion: "cellfence.corpus.v1",
      subjects: [
        {
          id: "infer-only",
          repository: "https://github.com/example/infer.git",
          commit: "0123456789abcdef0123456789abcdef01234567",
          manifest: { strategy: "infer" },
        },
        {
          id: "copy-unreviewed",
          repository: "https://github.com/example/copy.git",
          commit: "1111111111111111111111111111111111111111",
          manifest: { strategy: "copy", source: "manifests/copy.json" },
        },
      ],
    });

    const result = runValidator(["--corpus", corpusPath]);

    assert.equal(result.status, 1);
    const report = JSON.parse(result.stdout);
    assert.equal(report.ok, false);
    assert.equal(report.summary.ineligibleSubjects, 2);
    assert.match(report.issues.join("\n"), /manifest\.strategy=infer/);
    assert.match(report.issues.join("\n"), /reviewStatus=reviewed/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("reviewed corpus validator requires explicit review metadata for existing manifests", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-reviewed-corpus-existing-"));
  try {
    const corpusPath = path.join(tempDir, "corpus.json");
    writeJson(corpusPath, {
      schemaVersion: "cellfence.corpus.v1",
      subjects: [
        {
          id: "existing-unreviewed",
          repository: "https://github.com/example/existing.git",
          commit: "0123456789abcdef0123456789abcdef01234567",
          manifest: {
            strategy: "existing",
            path: "cellfence.manifest.json",
          },
        },
      ],
    });

    const result = runValidator(["--corpus", corpusPath]);

    assert.equal(result.status, 1);
    const report = JSON.parse(result.stdout);
    assert.equal(report.ok, false);
    assert.match(report.issues.join("\n"), /existing manifest must set reviewStatus=reviewed/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
