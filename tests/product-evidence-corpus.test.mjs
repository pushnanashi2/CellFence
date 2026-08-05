import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const repoRoot = path.resolve(".");
const scriptPath = path.join(repoRoot, "scripts", "product-evidence-corpus.mjs");

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function git(rootDir, args) {
  const result = spawnSync("git", args, { cwd: rootDir, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout.trim();
}

function createRepository(rootDir) {
  git(rootDir, ["init", "--quiet"]);
  git(rootDir, ["config", "user.email", "cellfence@example.invalid"]);
  git(rootDir, ["config", "user.name", "CellFence Test"]);
  fs.mkdirSync(path.join(rootDir, "src", "app"), { recursive: true });
  const sourceLines = ["export const app = true;"];
  for (let index = 1; index < 1000; index += 1) sourceLines.push(`// evidence line ${index}`);
  fs.writeFileSync(path.join(rootDir, "src", "app", "public.ts"), `${sourceLines.join("\n")}\n`);
  writeJson(path.join(rootDir, "package.json"), {
    name: "target-install-trap",
    scripts: { postinstall: "node -e \"require('fs').writeFileSync('INSTALL_RAN', 'unsafe')\"" },
  });
  writeJson(path.join(rootDir, "cellfence.manifest.json"), {
    schemaVersion: "cellfence.manifest.v1",
    governance: { requireOwnership: true, include: ["src/**"] },
    cells: [{
      id: "app",
      ownedPaths: ["src/app/**"],
      publicEntry: "src/app/public.ts",
      publicSymbols: ["app"],
      consumes: [],
      producesArtifacts: [],
    }],
  });
  git(rootDir, ["add", "."]);
  git(rootDir, ["commit", "--quiet", "-m", "fixture"]);
  return git(rootDir, ["rev-parse", "HEAD"]);
}

test("product corpus evidence stays pinned, refuses installs, and records scale and exit classes", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-product-evidence-"));
  try {
    const sourceRepo = path.join(rootDir, "source");
    fs.mkdirSync(sourceRepo, { recursive: true });
    const commit = createRepository(sourceRepo);
    const corpusPath = path.join(rootDir, "corpus.json");
    const analyzersPath = path.join(rootDir, "analyzers.json");
    const outPath = path.join(rootDir, "report.json");
    const findingAnalyzer = path.join(rootDir, "finding-analyzer.mjs");
    const slowAnalyzer = path.join(rootDir, "slow-analyzer.mjs");
    fs.writeFileSync(findingAnalyzer, "process.stdout.write('finding\\n'); process.exitCode = 7;\n");
    fs.writeFileSync(slowAnalyzer, "setTimeout(() => {}, 10_000);\n");
    writeJson(corpusPath, {
      schemaVersion: "cellfence.corpus.v1",
      subjects: [{
        id: "safe-target",
        repository: sourceRepo,
        commit,
        manifest: { strategy: "existing", path: "cellfence.manifest.json" },
      }],
    });
    writeJson(analyzersPath, {
      schemaVersion: "cellfence.evidence-analyzers.v1",
      analyzers: [
        {
          id: "preprovisioned",
          command: process.execPath,
          args: [findingAnalyzer, "{root}"],
          exitCodes: { findings: [7] },
        },
        {
          id: "target-install",
          command: "npm",
          args: ["install"],
          requiresTargetInstall: true,
        },
        {
          id: "missing-tool",
          command: path.join(rootDir, "missing-analyzer"),
        },
        {
          id: "slow-tool",
          command: process.execPath,
          args: [slowAnalyzer],
          timeoutMs: 20,
        },
      ],
    });

    const result = spawnSync(process.execPath, [
      scriptPath,
      "--corpus", corpusPath,
      "--analyzers", analyzersPath,
      "--workdir", path.join(rootDir, "work"),
      "--out", outPath,
      "--timeout-ms", "5000",
    ], { cwd: repoRoot, encoding: "utf8", maxBuffer: 100 * 1024 * 1024 });

    assert.equal(result.status, 1, result.stderr || result.stdout);
    const report = JSON.parse(fs.readFileSync(outPath, "utf8"));
    assert.equal(report.schemaVersion, "cellfence.product-evidence-corpus.v1");
    assert.equal(report.safety.exactCommitsRequired, true);
    assert.equal(report.safety.targetRepositoryInstalls, "not_performed_by_harness");
    assert.equal(report.safety.analyzerDescriptors, "trusted_preprovisioned_code");
    assert.equal(report.subjects[0].commit, commit);
    assert.equal(report.subjects[0].scale.sourceLines, 1000);
    assert.equal(report.subjects[0].scale.kloc, 1);
    const analyzerById = new Map(report.subjects[0].analyzers.map((analyzer) => [analyzer.id, analyzer]));
    assert.equal(analyzerById.get("cellfence").classification, "clean");
    assert.equal(analyzerById.get("cellfence").msPerKloc, analyzerById.get("cellfence").latencyMs);
    assert.equal(analyzerById.get("preprovisioned").classification, "findings");
    assert.equal(analyzerById.get("target-install").classification, "not_comparable");
    assert.equal(analyzerById.get("missing-tool").classification, "unavailable");
    assert.equal(analyzerById.get("slow-tool").classification, "timeout");
    assert.equal(report.summary.evidence.latencyByAnalyzer.cellfence.count, 1);
    assert.equal(fs.existsSync(path.join(report.subjects[0].subjectDir, "checkout", "INSTALL_RAN")), false);
    assert.equal(fs.existsSync(path.join(sourceRepo, "INSTALL_RAN")), false);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("product corpus evidence rejects floating refs even in dry-run mode", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-product-floating-"));
  try {
    const corpusPath = path.join(rootDir, "corpus.json");
    writeJson(corpusPath, {
      schemaVersion: "cellfence.corpus.v1",
      subjects: [{
        id: "floating",
        repository: "https://example.invalid/repo.git",
        commit: "main",
        manifest: { strategy: "existing" },
      }],
    });
    const result = spawnSync(process.execPath, [scriptPath, "--corpus", corpusPath, "--dry-run"], {
      cwd: repoRoot,
      encoding: "utf8",
    });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /requires exact 40-hex commit/);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});
