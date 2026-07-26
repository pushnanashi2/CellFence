import assert from "node:assert/strict";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const root = process.cwd();
const scriptPath = path.join(root, "scripts", "precision-review-packet-export.mjs");

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function writeText(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, value.endsWith("\n") ? value : `${value}\n`);
}

function hashText(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function runExport(args) {
  return spawnSync(process.execPath, [scriptPath, ...args], {
    cwd: root,
    encoding: "utf8",
  });
}

function makeTempDir(prefix) {
  const baseDir = path.join(root, "tmp");
  fs.mkdirSync(baseDir, { recursive: true });
  return fs.mkdtempSync(path.join(baseDir, prefix));
}

function createFixture(tempDir) {
  const roundDir = path.join(tempDir, "round");
  const bundleDir = path.join(roundDir, "bundle-unlabeled");
  const blindWorklistDir = path.join(roundDir, "blind-worklist");
  const manifestWorklistDir = path.join(tempDir, "manifest-worklist");
  const gapWorklistPath = path.join(tempDir, "gap-worklist.json");
  const gapMarkdownPath = path.join(tempDir, "gap-worklist.md");
  const studyId = "packet-fixture";

  writeJson(path.join(roundDir, ".cellfence-precision-next-cycle"), {
    schemaVersion: "cellfence.precision-next-cycle-marker.v1",
  });
  writeText(path.join(roundDir, "SUMMARY.md"), "# packet-fixture\n");
  writeJson(path.join(roundDir, "summary.json"), {
    schemaVersion: "cellfence.precision-next-cycle.v1",
    studyId,
    claimProfile: "ts-js-boundary-core-v1",
    includedRules: ["CELLFENCE_PRIVATE_IMPORT"],
    digests: {
      unlabeledBundleArtifactSetSha256: "a".repeat(64),
      blindWorklistArtifactSetSha256: "b".repeat(64),
    },
    blockers: ["650 selected findings lack 1 external human/organization independent label(s)"],
  });
  writeJson(path.join(roundDir, "reviewed-corpus-validation.json"), { ok: true });
  writeJson(path.join(roundDir, "reviewed-corpus-external-validation.json"), { ok: false });
  writeJson(path.join(roundDir, "protocol.worklist.json"), { schemaVersion: "cellfence.precision-claim-protocol.v1" });
  writeJson(path.join(roundDir, "protocol.prelabel-preflight.json"), { schemaVersion: "cellfence.precision-claim-protocol.v1" });
  writeJson(path.join(roundDir, "claim-preflight.prelabel.json"), { ok: false });

  writeJson(path.join(bundleDir, "corpus.json"), { schemaVersion: "cellfence.corpus.v1", subjects: [] });
  writeJson(path.join(bundleDir, "study.json"), {
    schemaVersion: "cellfence.corpus-evidence-bundle.v1",
    studyId,
    environment: {
      harnessCommit: "c".repeat(40),
      harnessDirty: false,
      corpusSha256: "d".repeat(64),
    },
    manifestCopies: [{ path: "manifests/example.json" }],
  });
  writeJson(path.join(bundleDir, "report.json"), {
    schemaVersion: "cellfence.corpus-study.v1",
    subjectDir: path.join(root, "tmp", "subject"),
    ordinaryRepoPath: "packages/website/src/pages/home/HeroSection.tsx",
  });
  writeJson(path.join(bundleDir, "sampling.json"), { population: { sampledFindings: 1 } });
  writeText(path.join(bundleDir, "findings.sampled.jsonl"), `${JSON.stringify({
    schemaVersion: "cellfence.corpus-normalized-finding.v1",
    studyId,
    findingId: `sha256:${hashText("finding")}`,
    subjectId: "example",
    ruleId: "CELLFENCE_PRIVATE_IMPORT",
  })}\n`);
  writeText(path.join(bundleDir, "labels.jsonl"), "");
  writeJson(path.join(bundleDir, "manifests", "example.json"), { cells: [] });
  writeText(path.join(bundleDir, "findings.raw.jsonl"), "must not be copied\n");
  writeText(path.join(bundleDir, "findings.normalized.jsonl"), "must not be copied\n");
  writeText(path.join(bundleDir, "logs", "example", "check.audit.jsonl"), "must not be copied\n");
  writeText(path.join(bundleDir, "SHA256SUMS"), "source bundle sums\n");

  const longBlindAssignmentPath = "assignments/blind_first/example-owner-example-repository-with-a-long-name-CELLFENCE_PRIVATE_IMPORT-deadbeefcafebabe-0123456789abcdef.json";
  const longManifestAssignmentPath = "assignments/example-owner-example-repository-with-a-long-name-manifest-external-human-reviewer-1-aeb263c9c59f.json";

  writeJson(path.join(blindWorklistDir, "worklist.json"), {
    schemaVersion: "cellfence.precision-label-worklist.v1",
    studyId,
    summary: {
      selectedFindings: 1,
      selectedByRule: { CELLFENCE_PRIVATE_IMPORT: 1 },
      selectedBySubject: { example: 1 },
    },
    assignments: [{
      path: longBlindAssignmentPath,
      assignmentId: "assignment-example",
      findingId: `sha256:${hashText("finding")}`,
      subjectId: "example",
      ruleId: "CELLFENCE_PRIVATE_IMPORT",
      round: "blind_first",
      rater: "external-human-reviewer-1",
    }],
  });
  writeJson(path.join(blindWorklistDir, longBlindAssignmentPath), {
    schemaVersion: "cellfence.precision-label-assignment.v1",
    studyId,
  });
  writeText(path.join(blindWorklistDir, "SHA256SUMS"), "blind sums\n");

  writeText(path.join(manifestWorklistDir, ".cellfence-manifest-attestation-worklist"), "marker\n");
  writeJson(path.join(manifestWorklistDir, "worklist.json"), {
    schemaVersion: "cellfence.manifest-attestation-worklist.v1",
    studyId,
    summary: {
      subjects: 1,
      assignments: 2,
    },
    assignments: [{
      path: longManifestAssignmentPath,
      assignmentId: "manifest-attestation-example",
      subjectId: "example",
      reviewer: "external-human-reviewer-1",
    }],
  });
  writeJson(path.join(manifestWorklistDir, longManifestAssignmentPath), {
    schemaVersion: "cellfence.manifest-attestation-assignment.v1",
  });
  writeText(path.join(manifestWorklistDir, "SHA256SUMS"), "manifest sums\n");
  writeJson(gapWorklistPath, {
    schemaVersion: "cellfence.precision-evidence-gap-worklist.v1",
    tasks: [{ type: "external_independent_label" }],
  });
  writeText(gapMarkdownPath, "# Gaps\n");

  return { roundDir, manifestWorklistDir, gapWorklistPath, gapMarkdownPath };
}

test("precision review packet export writes a compact external review packet", () => {
  const tempDir = makeTempDir("cellfence-review-packet-");
  try {
    const { roundDir, manifestWorklistDir, gapWorklistPath, gapMarkdownPath } = createFixture(tempDir);
    const outDir = path.join(tempDir, "packet");
    const result = runExport([
      "--round-dir",
      roundDir,
      "--manifest-worklist-dir",
      manifestWorklistDir,
      "--gap-worklist",
      gapWorklistPath,
      "--gap-markdown",
      gapMarkdownPath,
      "--out-dir",
      outDir,
    ]);

    assert.equal(result.status, 0, result.stderr || result.stdout);
    const packet = readJson(path.join(outDir, "review-packet.json"));
    assert.equal(packet.schemaVersion, "cellfence.precision-review-packet.v1");
    assert.equal(packet.selectedFindings, 1);
    assert.equal(packet.blindAssignments, 1);
    assert.equal(packet.manifestAttestation.subjects, 1);
    assert.equal(packet.gapWorklist.json.path, "cycle/gap-worklist.json");
    assert.equal(packet.source.harnessDirty, false);
    const blindWorklist = readJson(path.join(outDir, "blind-worklist", "worklist.json"));
    const blindAssignmentPath = blindWorklist.assignments[0].path;
    assert.match(blindAssignmentPath, /^assignments\/bf\/a-[a-f0-9]{16}\.json$/);
    assert.equal(blindWorklist.assignments[0].sourcePath, "assignments/blind_first/example-owner-example-repository-with-a-long-name-CELLFENCE_PRIVATE_IMPORT-deadbeefcafebabe-0123456789abcdef.json");
    assert.ok(fs.existsSync(path.join(outDir, "blind-worklist", blindAssignmentPath)));
    assert.ok(fs.existsSync(path.join(outDir, "blind-worklist", "source-worklist.json")));
    assert.ok(fs.existsSync(path.join(outDir, "blind-worklist", "source-SHA256SUMS")));
    assert.ok(fs.existsSync(path.join(outDir, "blind-worklist", "path-map.jsonl")));
    const manifestWorklist = readJson(path.join(outDir, "manifest-attestation-worklist", "worklist.json"));
    const manifestAssignmentPath = manifestWorklist.assignments[0].path;
    assert.match(manifestAssignmentPath, /^assignments\/m\/m-[a-f0-9]{16}\.json$/);
    assert.ok(fs.existsSync(path.join(outDir, "manifest-attestation-worklist", manifestAssignmentPath)));
    assert.ok(fs.existsSync(path.join(outDir, "manifest-attestation-worklist", "source-worklist.json")));
    assert.ok(fs.existsSync(path.join(outDir, "source-bundle", "manifests", "example.json")));
    assert.ok(fs.existsSync(path.join(outDir, "source-bundle", "findings.sampled.jsonl")));
    assert.ok(fs.existsSync(path.join(outDir, "cycle", "gap-worklist.json")));
    assert.ok(fs.existsSync(path.join(outDir, "cycle", "gap-worklist.md")));
    const exportedReport = fs.readFileSync(path.join(outDir, "source-bundle", "report.json"), "utf8");
    assert.doesNotMatch(exportedReport, new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.match(exportedReport, /<cellfence-repo>\/tmp\/subject/);
    assert.match(exportedReport, /packages\/website\/src\/pages\/home\/HeroSection\.tsx/);
    assert.ok(!fs.existsSync(path.join(outDir, "source-bundle", "findings.raw.jsonl")));
    assert.ok(!fs.existsSync(path.join(outDir, "source-bundle", "findings.normalized.jsonl")));
    assert.ok(!fs.existsSync(path.join(outDir, "source-bundle", "logs")));
    assert.match(fs.readFileSync(path.join(outDir, "README.md"), "utf8"), /not a final precision claim/);
    assert.match(fs.readFileSync(path.join(outDir, "EXTERNAL_REVIEW_REQUEST.md"), "utf8"), /Agent output is useful only for non-claim triage/);
    assert.match(fs.readFileSync(path.join(outDir, "SHA256SUMS"), "utf8"), /review-packet\.json/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("precision review packet export refuses to replace unmarked directories", () => {
  const tempDir = makeTempDir("cellfence-review-packet-force-");
  try {
    const { roundDir, manifestWorklistDir } = createFixture(tempDir);
    const outDir = path.join(tempDir, "packet");
    fs.mkdirSync(outDir);
    writeText(path.join(outDir, "user-file.txt"), "keep me\n");

    const result = runExport([
      "--round-dir",
      roundDir,
      "--manifest-worklist-dir",
      manifestWorklistDir,
      "--out-dir",
      outDir,
      "--force",
    ]);

    assert.equal(result.status, 2);
    assert.match(result.stderr, /refusing to delete unmarked output directory/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
