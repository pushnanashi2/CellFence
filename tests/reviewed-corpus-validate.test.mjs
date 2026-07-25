import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
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

test("reviewed corpus validator rejects existing manifests for external claims", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-reviewed-corpus-existing-external-"));
  try {
    const corpusPath = path.join(tempDir, "corpus.json");
    writeJson(corpusPath, {
      schemaVersion: "cellfence.corpus.v1",
      subjects: [
        {
          id: "existing-reviewed",
          repository: "https://github.com/example/existing.git",
          commit: "0123456789abcdef0123456789abcdef01234567",
          manifest: {
            strategy: "existing",
            path: "cellfence.manifest.json",
            reviewStatus: "reviewed",
            review: {
              reviewers: [
                {
                  id: "reviewer-a",
                  reviewerType: "human",
                  independent: true,
                },
              ],
              reviewedAt: "2026-07-20",
              reviewedManifestSha256: "0".repeat(64),
              scope: "package/workspace boundary manifest review",
              boundaryEvidence: ["package exports"],
            },
          },
        },
      ],
    });

    const result = runValidator(["--corpus", corpusPath, "--external-claim"]);

    assert.equal(result.status, 1);
    const report = JSON.parse(result.stdout);
    assert.match(report.issues.join("\n"), /external claim requires a copy manifest/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("reviewed corpus validator requires attested review metadata for external claims", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-reviewed-corpus-external-"));
  try {
    const corpusPath = path.join(tempDir, "corpus.json");
    const manifestPath = path.join(tempDir, "manifests", "demo.json");
    writeJson(manifestPath, { schemaVersion: "cellfence.manifest.v1", cells: [] });
    writeJson(corpusPath, {
      schemaVersion: "cellfence.corpus.v1",
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
              reviewers: ["codex-agent-reviewer"],
              boundaryEvidence: ["package exports"],
            },
          },
        },
      ],
    });

    const rejected = runValidator(["--corpus", corpusPath, "--external-claim"]);

    assert.equal(rejected.status, 1);
    let report = JSON.parse(rejected.stdout);
    assert.match(report.issues.join("\n"), /reviewerAttestations/);
    assert.match(report.issues.join("\n"), /reviewedManifestSha256/);

    const manifestSha256 = crypto.createHash("sha256").update(fs.readFileSync(manifestPath)).digest("hex");
    writeJson(corpusPath, {
      schemaVersion: "cellfence.corpus.v1",
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
              reviewerAttestations: [
                {
                  id: "reviewer-a",
                  reviewerType: "human",
                  independent: true,
                },
              ],
              reviewedAt: "2026-07-20",
              reviewedManifestSha256: manifestSha256,
              scope: "package/workspace boundary manifest review",
              boundaryEvidence: ["package exports"],
            },
          },
        },
      ],
    });

    const accepted = runValidator(["--corpus", corpusPath, "--external-claim"]);

    assert.equal(accepted.status, 0, accepted.stderr || accepted.stdout);
    report = JSON.parse(accepted.stdout);
    assert.equal(report.ok, true);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("reviewed corpus validator accepts reviewed reuse-before history replay corpora", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-reviewed-history-ok-"));
  try {
    const corpusPath = path.join(tempDir, "history.json");
    const manifestPath = path.join(tempDir, "manifests", "public-surface.json");
    writeJson(manifestPath, { schemaVersion: "cellfence.manifest.v1", cells: [] });
    const manifestSha256 = crypto.createHash("sha256").update(fs.readFileSync(manifestPath)).digest("hex");
    writeJson(corpusPath, {
      schemaVersion: "cellfence.history-replay.v1",
      selectionPolicy: {
        date: "2026-07-25",
        source: "fixture history replay",
      },
      subjects: [
        {
          id: "public-surface-replay",
          repository: "https://github.com/example/public-surface.git",
          beforeCommit: "0123456789abcdef0123456789abcdef01234567",
          afterCommit: "1111111111111111111111111111111111111111",
          before: {
            manifest: {
              strategy: "copy",
              source: "manifests/public-surface.json",
              reviewed: true,
              reviewStatus: "reviewed",
              review: {
                reviewerAttestations: [
                  {
                    id: "reviewer-a",
                    reviewerType: "organization",
                    independent: true,
                  },
                ],
                reviewedAt: "2026-07-25",
                reviewedManifestSha256: manifestSha256,
                scope: "public surface stale-contract replay fixture",
                boundaryEvidence: ["fixture before manifest"],
              },
            },
          },
          after: {
            manifest: {
              strategy: "reuse-before",
            },
          },
        },
      ],
    });

    const result = runValidator(["--corpus", corpusPath, "--external-claim"]);

    assert.equal(result.status, 0, result.stderr || result.stdout);
    const report = JSON.parse(result.stdout);
    assert.equal(report.ok, true);
    assert.equal(report.summary.precisionEligibleSubjects, 1);
    assert.equal(report.subjects[0].manifestStrategy, "copy->reuse-before");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("reviewed corpus validator rejects history replay corpora without proof-eligible manifests", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-reviewed-history-reject-"));
  try {
    const corpusPath = path.join(tempDir, "history.json");
    writeJson(corpusPath, {
      schemaVersion: "cellfence.history-replay.v1",
      subjects: [
        {
          id: "public-surface-replay",
          repository: "https://github.com/example/public-surface.git",
          beforeCommit: "0123456789abcdef0123456789abcdef01234567",
          afterCommit: "1111111111111111111111111111111111111111",
          before: {
            manifest: {
              strategy: "existing",
              reviewStatus: "reviewed",
            },
          },
          after: {
            manifest: {
              strategy: "copy",
              source: "manifests/after.json",
            },
          },
        },
      ],
    });

    const result = runValidator(["--corpus", corpusPath]);

    assert.equal(result.status, 1);
    const report = JSON.parse(result.stdout);
    assert.equal(report.ok, false);
    assert.match(report.issues.join("\n"), /before\.manifest\.strategy=copy/);
    assert.match(report.issues.join("\n"), /after\.manifest\.strategy=reuse-before/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("reviewed corpus validator rejects history replay equal commits", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-reviewed-history-equal-"));
  try {
    const corpusPath = path.join(tempDir, "history.json");
    const manifestPath = path.join(tempDir, "manifests", "public-surface.json");
    writeJson(manifestPath, { schemaVersion: "cellfence.manifest.v1", cells: [] });
    writeJson(corpusPath, {
      schemaVersion: "cellfence.history-replay.v1",
      subjects: [
        {
          id: "public-surface-replay",
          repository: "https://github.com/example/public-surface.git",
          beforeCommit: "0123456789abcdef0123456789abcdef01234567",
          afterCommit: "0123456789abcdef0123456789abcdef01234567",
          before: {
            manifest: {
              strategy: "copy",
              source: "manifests/public-surface.json",
              reviewed: true,
              reviewStatus: "reviewed",
              review: {
                reviewers: ["reviewer-a"],
                boundaryEvidence: ["fixture before manifest"],
              },
            },
          },
          after: {
            manifest: {
              strategy: "reuse-before",
            },
          },
        },
      ],
    });

    const result = runValidator(["--corpus", corpusPath]);

    assert.equal(result.status, 1);
    const report = JSON.parse(result.stdout);
    assert.match(report.issues.join("\n"), /before and after commits must differ/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("reviewed corpus validator rejects reuse-before manifest modifiers", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-reviewed-history-modifiers-"));
  try {
    const cases = [
      ["source", { source: "manifests/after.json" }, /reuse-before cannot set manifest\.source/],
      ["from", { from: ["cellfence.extra.json"] }, /reuse-before cannot set manifest\.from/],
      ["preset", { preset: "node" }, /reuse-before cannot set manifest\.preset/],
      ["path", { path: "custom.cellfence.manifest.json" }, /reuse-before only supports cellfence\.manifest\.json/],
    ];
    writeJson(path.join(tempDir, "manifests", "public-surface.json"), { schemaVersion: "cellfence.manifest.v1", cells: [] });
    for (const [name, afterManifestPatch, expected] of cases) {
      const corpusPath = path.join(tempDir, `${name}.json`);
      writeJson(corpusPath, {
        schemaVersion: "cellfence.history-replay.v1",
        subjects: [
          {
            id: `public-surface-replay-${name}`,
            repository: "https://github.com/example/public-surface.git",
            beforeCommit: "0123456789abcdef0123456789abcdef01234567",
            afterCommit: "1111111111111111111111111111111111111111",
            before: {
              manifest: {
                strategy: "copy",
                source: "manifests/public-surface.json",
                reviewed: true,
                reviewStatus: "reviewed",
                review: {
                  reviewers: ["reviewer-a"],
                  boundaryEvidence: ["fixture before manifest"],
                },
              },
            },
            after: {
              manifest: {
                strategy: "reuse-before",
                ...afterManifestPatch,
              },
            },
          },
        ],
      });

      const result = runValidator(["--corpus", corpusPath]);

      assert.equal(result.status, 1);
      const report = JSON.parse(result.stdout);
      assert.match(report.issues.join("\n"), expected);
    }
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
