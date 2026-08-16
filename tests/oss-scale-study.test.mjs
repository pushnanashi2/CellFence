import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  collectPopularGitHubCorpus,
  diagnoseInferredManifest,
  githubLanguageQuery,
  parseOssScaleArgs,
} from "../scripts/oss-scale-study.mjs";

function response(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

function git(rootDir, args) {
  return execFileSync("git", args, { cwd: rootDir, encoding: "utf8" });
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

test("OSS scale args default to supported high-signal languages and production inference", () => {
  assert.deepEqual(parseOssScaleArgs([]).languages, ["TypeScript", "JavaScript", "Python"]);
  assert.equal(parseOssScaleArgs([]).limitPerLanguage, 3000);
  assert.equal(parseOssScaleArgs([]).cloneMode, "shallow");
  assert.equal(parseOssScaleArgs([]).inferScope, "production");
  assert.equal(parseOssScaleArgs(["--max-repo-size-kb", "250000"]).maxRepoSizeKb, 250000);
  assert.equal(parseOssScaleArgs(["--corpus", "corpus.json", "--apply-corpus-only"]).applyCorpusOnly, true);
  assert.deepEqual(parseOssScaleArgs(["--language", "Go", "--languages", "Rust,Python"]).languages, ["Go", "Rust", "Python"]);
  assert.throws(() => parseOssScaleArgs(["--limit-per-language", "3001"]), /1 to 3000/);
  assert.throws(() => parseOssScaleArgs(["--clone-mode", "partial"]), /full or shallow/);
  assert.throws(() => parseOssScaleArgs(["--apply-corpus-only"]), /requires --corpus/);
});

test("GitHub language query uses star windows to move beyond a single search cap", () => {
  assert.equal(githubLanguageQuery("TypeScript", 1, undefined), "language:TypeScript stars:>=1");
  assert.equal(githubLanguageQuery("C++", 100, 999), "language:C++ stars:100..999");
});

test("popular GitHub corpus collection slices star windows and pins commits", async () => {
  const requests = [];
  const commits = new Map([
    ["oss/alpha", "a".repeat(40)],
    ["oss/beta", "b".repeat(40)],
    ["oss/gamma", "c".repeat(40)],
  ]);
  const repo = (fullName, stars, size = 42) => ({
    full_name: fullName,
    default_branch: "main",
    clone_url: `https://github.com/${fullName}.git`,
    html_url: `https://github.com/${fullName}`,
    stargazers_count: stars,
    forks_count: 1,
    size,
    fork: false,
    archived: false,
  });
  const fetchImpl = async (url, options) => {
    requests.push({ url, options });
    const parsed = new URL(url);
    if (parsed.pathname === "/search/repositories") {
      const query = parsed.searchParams.get("q");
      if (query === "language:TypeScript stars:>=1") return response({ items: [repo("oss/skip-large", 110, 101), repo("oss/alpha", 100), repo("oss/beta", 90)] });
      if (query === "language:TypeScript stars:1..89") return response({ items: [repo("oss/gamma", 80)] });
      return response({ items: [] });
    }
    const match = parsed.pathname.match(/\/repos\/([^/]+)\/([^/]+)\/commits\//);
    const fullName = `${decodeURIComponent(match[1])}/${decodeURIComponent(match[2])}`;
    return response({ sha: commits.get(fullName) });
  };

  const corpus = await collectPopularGitHubCorpus({
    languages: ["TypeScript"],
    limitPerLanguage: 3,
    minStars: 1,
    perPage: 2,
    searchPageLimit: 1,
    maxRepoSizeKb: 100,
    apiBaseUrl: "https://api.github.test",
    token: "secret",
  }, {
    fetchImpl,
    now: () => new Date("2026-08-16T00:00:00.000Z"),
  });

  assert.equal(corpus.schemaVersion, "cellfence.corpus.v1");
  assert.deepEqual(corpus.subjects.map((subject) => subject.id), [
    "typescript-oss-alpha",
    "typescript-oss-beta",
    "typescript-oss-gamma",
  ]);
  assert.deepEqual(corpus.subjects.map((subject) => subject.commit), ["a".repeat(40), "b".repeat(40), "c".repeat(40)]);
  assert.equal(corpus.collection.languages[0].addedSubjects, 3);
  assert.equal(corpus.collection.skipped[0].reason, "size_excluded");
  assert.equal(corpus.subjects[0].manifest.strategy, "infer");
  assert.equal(corpus.subjects[0].manifest.scope, "production");
  assert.ok(requests.every((request) => request.options.headers.Authorization === "Bearer secret"));
});

test("inferred manifest diagnostics flag example fallback and natural manifests", (context) => {
  const subjectDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-oss-scale-"));
  context.after(() => fs.rmSync(subjectDir, { recursive: true, force: true }));
  const checkoutDir = path.join(subjectDir, "checkout");
  const controlDir = path.join(subjectDir, "control");
  fs.mkdirSync(path.join(checkoutDir, "src"), { recursive: true });
  fs.writeFileSync(path.join(checkoutDir, "src/index.ts"), "export const value = 1;\n");
  git(checkoutDir, ["init", "-q", "-b", "main"]);
  git(checkoutDir, ["add", "src/index.ts"]);

  const manifestPath = path.join(controlDir, "cellfence.manifest.json");
  writeJson(manifestPath, {
    schemaVersion: "cellfence.manifest.v1",
    governance: { requireOwnership: true, include: ["src/**"], exclude: [] },
    cells: [{
      id: "src-root",
      ownedPaths: ["src/**"],
      publicEntry: "src/index.ts",
      publicSymbols: ["value"],
      consumes: [],
      producesArtifacts: [],
    }],
  });
  assert.deepEqual(diagnoseInferredManifest({
    subjectDir,
    manifest: { effectivePath: manifestPath },
  }), {
    status: "natural",
    natural: true,
    cells: 1,
    packageBackedCells: 0,
    includePatterns: 1,
    missingPublicEntries: [],
    sourceFiles: 1,
    sourceLines: 1,
    trackedSourceFiles: 1,
  });

  writeJson(manifestPath, {
    schemaVersion: "cellfence.manifest.v1",
    governance: { requireOwnership: true, include: ["src/**"], exclude: [] },
    cells: [{
      id: "example",
      ownedPaths: ["src/example/**"],
      publicEntry: "src/example/public.ts",
      publicSymbols: ["example"],
      consumes: [],
      producesArtifacts: [],
    }],
  });
  assert.equal(diagnoseInferredManifest({
    subjectDir,
    manifest: { effectivePath: manifestPath },
  }).status, "fallback_example");
});
