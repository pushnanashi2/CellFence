import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const repoRoot = path.resolve(".");
const promoteScript = path.join(repoRoot, "scripts", "precision-corpus-promote-candidates.mjs");
const validateScript = path.join(repoRoot, "scripts", "reviewed-corpus-validate.mjs");

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function run(scriptPath, args) {
  return spawnSync(process.execPath, [scriptPath, ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 100 * 1024 * 1024,
  });
}

function createFixture(rootDir) {
  const currentCorpus = path.join(rootDir, "current.json");
  const candidateCorpus = path.join(rootDir, "candidate.json");
  const candidateBundle = path.join(rootDir, "candidate-bundle");
  const expansionPlan = path.join(rootDir, "plan.json");
  const manifest = {
    schemaVersion: "cellfence.manifest.v1",
    governance: {
      include: ["src/**"],
      requiredRules: ["CELLFENCE_PRIVATE_IMPORT"],
    },
    cells: [
      {
        id: "src",
        ownedPaths: ["src/**"],
        publicEntry: "src/index.ts",
        publicSymbols: ["run"],
        consumes: [],
      },
    ],
  };
  const manifestText = `${JSON.stringify(manifest, null, 2)}\n`;
  writeJson(path.join(candidateBundle, "manifests", "candidate-a.json"), manifest);
  writeJson(path.join(candidateBundle, "manifests", "not-in-plan.json"), manifest);
  writeJson(path.join(candidateBundle, "study.json"), {
    schemaVersion: "cellfence.corpus-evidence-bundle.v1",
    manifestCopies: [
      {
        subjectId: "candidate-a",
        path: "manifests/candidate-a.json",
        sha256: sha256(manifestText),
      },
      {
        subjectId: "not-in-plan",
        path: "manifests/not-in-plan.json",
        sha256: sha256(manifestText),
      },
    ],
  });
  writeJson(currentCorpus, {
    schemaVersion: "cellfence.corpus.v1",
    description: "Current reviewed fixture.",
    selectionPolicy: {
      date: "2026-07-25",
      source: "fixture",
      constraints: [
        "stale candidate sampled included findings between 2 and 12",
      ],
      projectedBalance: {
        stale: true,
      },
    },
    subjects: [
      {
        id: "current-a",
        repository: "https://github.com/example/current-a.git",
        commit: "a".repeat(40),
        manifest: {
          strategy: "copy",
          source: "manifests/current-a.json",
          reviewStatus: "reviewed",
          review: {
            reviewers: ["codex-agent-reviewer"],
            boundaryEvidence: ["fixture"],
          },
        },
      },
    ],
  });
  writeJson(path.join(rootDir, "manifests", "current-a.json"), { schemaVersion: "cellfence.manifest.v1", cells: [] });
  writeJson(candidateCorpus, {
    schemaVersion: "cellfence.corpus.v1",
    subjects: [
      {
        id: "candidate-a",
        repository: "https://github.com/example/candidate-a.git",
        commit: "b".repeat(40),
        metadata: {
          stars: 12,
          diskUsageKb: 34,
        },
        manifest: {
          strategy: "infer",
        },
      },
      {
        id: "not-in-plan",
        repository: "https://github.com/example/not-in-plan.git",
        commit: "c".repeat(40),
        manifest: {
          strategy: "infer",
        },
      },
    ],
  });
  writeJson(expansionPlan, {
    schemaVersion: "cellfence.precision-corpus-expansion-plan.v1",
    candidatePool: {
      topCandidates: [
        {
          subjectId: "candidate-a",
          sampledCountsByRule: {
            CELLFENCE_UNSUPPORTED_DYNAMIC_IMPORT: 2,
          },
          totalCountsByRule: {
            CELLFENCE_UNSUPPORTED_DYNAMIC_IMPORT: 4,
          },
          projectionReliability: "diagnostic_candidate_sampling_only_recompute_after_promotion",
        },
      ],
    },
  });
  return { currentCorpus, candidateCorpus, candidateBundle, expansionPlan };
}

test("precision corpus promotion copies manifests and produces a reviewed-corpus work queue", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-corpus-promote-"));
  try {
    const { currentCorpus, candidateCorpus, candidateBundle, expansionPlan } = createFixture(rootDir);
    const outCorpus = path.join(rootDir, "next.json");
    const reportPath = path.join(rootDir, "promotion.json");
    const markdownPath = path.join(rootDir, "promotion.md");
    const result = run(promoteScript, [
      "--current-corpus",
      currentCorpus,
      "--candidate-corpus",
      candidateCorpus,
      "--candidate-bundle",
      candidateBundle,
      "--expansion-plan",
      expansionPlan,
      "--out-corpus",
      outCorpus,
      "--top",
      "1",
      "--report",
      reportPath,
      "--markdown",
      markdownPath,
      "--reviewed-at",
      "2026-07-25",
    ]);

    assert.equal(result.status, 0, result.stderr || result.stdout);
    const corpus = readJson(outCorpus);
    assert.equal(corpus.subjects.length, 2);
    const promoted = corpus.subjects[1];
    assert.equal(promoted.id, "candidate-a");
    assert.equal(promoted.manifest.strategy, "copy");
    assert.equal(promoted.manifest.reviewStatus, "reviewed");
    assert.match(promoted.manifest.review.limitation, /not external-human\/org attested/);
    assert.deepEqual(promoted.metadata.promotionSource.diagnosticSampledCountsByRule, {
      CELLFENCE_UNSUPPORTED_DYNAMIC_IMPORT: 2,
    });
    assert.equal(fs.existsSync(path.join(rootDir, promoted.manifest.source)), true);
    assert.match(corpus.description, /not external-claim-ready/);
    assert.match(corpus.selectionPolicy.source, /frozen precision corpus expansion plan/);
    assert.equal(corpus.selectionPolicy.constraints.includes("stale candidate sampled included findings between 2 and 12"), false);
    assert.equal("projectedBalance" in corpus.selectionPolicy, false);
    assert.match(corpus.selectionPolicy.promotion.sourceCorpusSelectionPolicy, /not copied wholesale/);

    const report = readJson(reportPath);
    assert.equal(report.summary.externalClaimReady, false);
    assert.equal(report.promotedSubjects[0].subjectId, "candidate-a");
    assert.match(fs.readFileSync(markdownPath, "utf8"), /Precision Corpus Promotion/);

    const validation = run(validateScript, ["--corpus", outCorpus]);
    assert.equal(validation.status, 0, validation.stderr || validation.stdout);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("precision corpus promotion rejects subjects missing from the expansion plan", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-corpus-promote-missing-plan-"));
  try {
    const { currentCorpus, candidateCorpus, candidateBundle, expansionPlan } = createFixture(rootDir);
    const result = run(promoteScript, [
      "--current-corpus",
      currentCorpus,
      "--candidate-corpus",
      candidateCorpus,
      "--candidate-bundle",
      candidateBundle,
      "--expansion-plan",
      expansionPlan,
      "--out-corpus",
      path.join(rootDir, "next.json"),
      "--subjects",
      "not-in-plan",
    ]);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /not present in the expansion plan topCandidates/);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("precision corpus promotion rejects duplicate repository promotion", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-corpus-promote-duplicate-"));
  try {
    const { currentCorpus, candidateCorpus, candidateBundle, expansionPlan } = createFixture(rootDir);
    const candidate = readJson(candidateCorpus);
    candidate.subjects[0].repository = "https://github.com/example/current-a.git";
    writeJson(candidateCorpus, candidate);

    const result = run(promoteScript, [
      "--current-corpus",
      currentCorpus,
      "--candidate-corpus",
      candidateCorpus,
      "--candidate-bundle",
      candidateBundle,
      "--expansion-plan",
      expansionPlan,
      "--out-corpus",
      path.join(rootDir, "next.json"),
      "--subjects",
      "candidate-a",
    ]);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /repository already exists in current corpus/);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});
