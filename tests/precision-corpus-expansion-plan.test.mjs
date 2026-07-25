import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const repoRoot = path.resolve(".");
const scriptPath = path.join(repoRoot, "scripts", "precision-corpus-expansion-plan.mjs");

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function writeJsonl(filePath, values) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, values.length > 0 ? `${values.map((value) => JSON.stringify(value)).join("\n")}\n` : "");
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function posixify(value) {
  return String(value).replace(/\\/g, "/").split(path.sep).join("/");
}

function finding(overrides) {
  return {
    findingId: overrides.findingId,
    subjectId: overrides.subjectId,
    repository: overrides.repository,
    commit: overrides.commit || "a".repeat(40),
    ruleId: overrides.ruleId,
    severity: overrides.severity || "error",
    precisionEligible: overrides.precisionEligible ?? true,
    manifestStrategy: overrides.manifestStrategy || "copy",
    manifestReviewStatus: overrides.manifestReviewStatus || "reviewed",
  };
}

function createFixture(rootDir) {
  const currentBundle = path.join(rootDir, "current-bundle");
  const candidateBundle = path.join(rootDir, "candidate-bundle");
  const candidateCorpus = path.join(rootDir, "candidate-corpus.json");
  const currentCorpus = path.join(rootDir, "current-corpus.json");
  const currentFindings = [
    finding({
      findingId: "current-private-1",
      subjectId: "already-reviewed",
      repository: "https://github.com/example/already.git",
      ruleId: "CELLFENCE_PRIVATE_IMPORT",
    }),
    finding({
      findingId: "current-dynamic-1",
      subjectId: "already-reviewed",
      repository: "https://github.com/example/already.git",
      ruleId: "CELLFENCE_UNSUPPORTED_DYNAMIC_IMPORT",
    }),
  ];
  writeJson(path.join(currentBundle, "sampling.json"), {
    schemaVersion: "cellfence.corpus-sampling.v1",
    sampledFindingIds: currentFindings.map((entry) => entry.findingId),
  });
  writeJsonl(path.join(currentBundle, "findings.normalized.jsonl"), currentFindings);

  writeJson(candidateCorpus, {
    schemaVersion: "cellfence.corpus.v1",
    subjects: [
      {
        id: "dynamic-heavy",
        repository: "https://github.com/example/dynamic-heavy.git",
        commit: "b".repeat(40),
        metadata: { stars: 100, diskUsageKb: 123 },
        manifest: { strategy: "infer" },
      },
      {
        id: "public-surface",
        repository: "https://github.com/example/public-surface.git",
        commit: "c".repeat(40),
        metadata: { stars: 10, diskUsageKb: 456 },
        manifest: { strategy: "infer" },
      },
      {
        id: "no-copy",
        repository: "https://github.com/example/no-copy.git",
        commit: "d".repeat(40),
        manifest: { strategy: "infer" },
      },
      {
        id: "duplicate-repo",
        repository: "https://github.com/example/already.git",
        commit: "e".repeat(40),
        manifest: { strategy: "infer" },
      },
    ],
  });
  writeJson(currentCorpus, {
    schemaVersion: "cellfence.corpus.v1",
    subjects: [
      {
        id: "already-reviewed",
        repository: "https://github.com/example/already.git",
        commit: "a".repeat(40),
        manifest: { strategy: "copy", reviewStatus: "reviewed" },
      },
      {
        id: "public-surface",
        repository: "https://github.com/example/public-surface",
        commit: "c".repeat(40),
        manifest: { strategy: "copy", reviewStatus: "reviewed" },
      },
    ],
  });
  writeJson(path.join(candidateBundle, "study.json"), {
    schemaVersion: "cellfence.corpus-evidence-bundle.v1",
    manifestCopies: [
      { subjectId: "dynamic-heavy", path: "manifests/dynamic-heavy.json" },
      { subjectId: "public-surface", path: "manifests/public-surface.json" },
      { subjectId: "duplicate-repo", path: "manifests/duplicate-repo.json" },
    ],
  });
  const candidateFindings = [];
  for (let index = 0; index < 6; index += 1) {
    candidateFindings.push(finding({
      findingId: `dynamic-heavy-${index}`,
      subjectId: "dynamic-heavy",
      repository: "https://github.com/example/dynamic-heavy.git",
      ruleId: "CELLFENCE_UNSUPPORTED_DYNAMIC_IMPORT",
      commit: "b".repeat(40),
      precisionEligible: false,
      manifestStrategy: "infer",
      manifestReviewStatus: "unknown",
    }));
  }
  candidateFindings.push(finding({
    findingId: "public-surface-1",
    subjectId: "public-surface",
    repository: "https://github.com/example/public-surface.git",
    ruleId: "CELLFENCE_PUBLIC_SYMBOL_MISMATCH",
    commit: "c".repeat(40),
    precisionEligible: false,
    manifestStrategy: "infer",
    manifestReviewStatus: "unknown",
  }));
  candidateFindings.push(finding({
    findingId: "no-copy-1",
    subjectId: "no-copy",
    repository: "https://github.com/example/no-copy.git",
    ruleId: "CELLFENCE_PUBLIC_SYMBOL_MISMATCH",
    commit: "d".repeat(40),
    precisionEligible: false,
    manifestStrategy: "infer",
    manifestReviewStatus: "unknown",
  }));
  candidateFindings.push(finding({
    findingId: "duplicate-repo-1",
    subjectId: "duplicate-repo",
    repository: "https://github.com/example/already.git",
    ruleId: "CELLFENCE_PUBLIC_SYMBOL_MISMATCH",
    commit: "e".repeat(40),
    precisionEligible: false,
    manifestStrategy: "infer",
    manifestReviewStatus: "unknown",
  }));
  writeJson(path.join(candidateBundle, "sampling.json"), {
    schemaVersion: "cellfence.corpus-sampling.v1",
    sampledFindingIds: candidateFindings.slice(0, 3).map((entry) => entry.findingId),
  });
  writeJsonl(path.join(candidateBundle, "findings.normalized.jsonl"), candidateFindings);
  return { currentBundle, candidateBundle, candidateCorpus, currentCorpus };
}

function runPlan(args) {
  return spawnSync(process.execPath, [scriptPath, ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 100 * 1024 * 1024,
  });
}

test("precision corpus expansion plan ranks non-reviewed diagnostic candidates without claiming them", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-expansion-plan-"));
  try {
    const { currentBundle, candidateBundle, candidateCorpus } = createFixture(rootDir);
    const outPath = path.join(rootDir, "plan.json");
    const markdownPath = path.join(rootDir, "plan.md");
    const result = runPlan([
      "--current-bundle",
      currentBundle,
      "--candidate-corpus",
      candidateCorpus,
      "--candidate-bundle",
      candidateBundle,
      "--out",
      outPath,
      "--markdown",
      markdownPath,
      "--top",
      "5",
    ]);

    assert.equal(result.status, 0, result.stderr || result.stdout);
    const report = readJson(outPath);
    assert.equal(report.schemaVersion, "cellfence.precision-corpus-expansion-plan.v1");
    assert.equal(report.current.sampledPrecisionEligibleFindings, 2);
    assert.equal(report.current.deficits.CELLFENCE_UNSUPPORTED_DYNAMIC_IMPORT, 298);
    assert.deepEqual(report.candidatePool.topCandidates.map((candidate) => candidate.subjectId), [
      "dynamic-heavy",
      "public-surface",
    ]);
    assert.equal(report.candidatePool.topCandidates[0].diagnosticSampledFindings, 3);
    assert.equal(report.candidatePool.topCandidates[0].projectionReliability, "diagnostic_candidate_sampling_only_recompute_after_promotion");
    assert.equal(report.candidatePool.topCandidates[0].nextAction, "copy_manifest_then_agent_review_before_claim_use");
    assert.match(report.candidatePool.topCandidates[0].riskNotes.join("\n"), /recomputed after promotion/);
    assert.match(report.blockers.join("\n"), /does not create reviewed evidence/);
    assert.match(report.blockers.join("\n"), /external human\/organization labels/);
    assert.match(fs.readFileSync(markdownPath, "utf8"), /Precision Corpus Expansion Plan/);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("precision corpus expansion plan infers current corpus from the current bundle", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-expansion-plan-bundled-current-"));
  try {
    const { currentBundle, candidateBundle, candidateCorpus } = createFixture(rootDir);
    writeJson(path.join(currentBundle, "corpus.json"), {
      schemaVersion: "cellfence.corpus.v1",
      subjects: [
        {
          id: "public-surface-reviewed",
          repository: "https://github.com/example/public-surface",
          commit: "c".repeat(40),
          manifest: { strategy: "copy", reviewStatus: "reviewed" },
        },
      ],
    });

    const result = runPlan([
      "--current-bundle",
      currentBundle,
      "--candidate-corpus",
      candidateCorpus,
      "--candidate-bundle",
      candidateBundle,
      "--top",
      "5",
    ]);

    assert.equal(result.status, 0, result.stderr || result.stdout);
    const report = JSON.parse(result.stdout);
    assert.equal(report.inputs.currentCorpus, posixify(path.join(currentBundle, "corpus.json")));
    assert.equal(report.inputs.currentCorpusSource, "current-bundle");
    assert.equal(report.candidatePool.topCandidates.some((candidate) => candidate.subjectId === "public-surface"), false);
    assert.equal(report.candidatePool.topCandidates[0].subjectId, "dynamic-heavy");
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("precision corpus expansion plan can exclude every current corpus subject by normalized repository", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-expansion-plan-current-"));
  try {
    const { currentBundle, candidateBundle, candidateCorpus, currentCorpus } = createFixture(rootDir);
    const result = runPlan([
      "--current-bundle",
      currentBundle,
      "--current-corpus",
      currentCorpus,
      "--candidate-corpus",
      candidateCorpus,
      "--candidate-bundle",
      candidateBundle,
      "--top",
      "5",
    ]);

    assert.equal(result.status, 0, result.stderr || result.stdout);
    const report = JSON.parse(result.stdout);
    assert.equal(report.inputs.currentCorpus, posixify(currentCorpus));
    assert.equal(report.candidatePool.topCandidates.some((candidate) => candidate.subjectId === "public-surface"), false);
    assert.equal(report.candidatePool.topCandidates[0].subjectId, "dynamic-heavy");
    assert.equal(report.candidatePool.topCandidates[0].projectedSelectedFindings, 3);
    assert.equal(report.candidatePool.topCandidates[0].reviewWorkloadFindings, 6);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("precision corpus expansion plan rejects missing option values before reading bundles", () => {
  const result = runPlan(["--current-bundle"]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /--current-bundle requires a value/);
});
