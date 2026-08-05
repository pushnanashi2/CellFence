import assert from "node:assert/strict";
import test from "node:test";

import { collectGitHubCorpus } from "../scripts/github-corpus-collector.mjs";

function response(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

test("GitHub corpus collection resolves default branches to pinned SHAs through an injected API", async () => {
  const requests = [];
  const commits = new Map([
    ["bad/sha", "not-a-sha"],
    ["new/alpha", "b".repeat(40)],
    ["new/beta", "c".repeat(40)],
  ]);
  const item = (fullName, patch = {}) => ({
    full_name: fullName,
    default_branch: "main",
    clone_url: `https://github.com/${fullName}.git`,
    html_url: `https://github.com/${fullName}`,
    stargazers_count: 100,
    forks_count: 5,
    size: 123,
    language: "TypeScript",
    fork: false,
    archived: false,
    ...patch,
  });
  const fetchImpl = async (url, options) => {
    requests.push({ url, options });
    if (url.includes("/search/repositories")) {
      return response({ items: [
        item("base/existing"),
        item("skip/fork", { fork: true }),
        item("skip/archive", { archived: true }),
        item("bad/sha"),
        item("new/alpha"),
        item("new/beta"),
      ] });
    }
    const match = new URL(url).pathname.match(/\/repos\/([^/]+)\/([^/]+)\/commits\//);
    const fullName = `${decodeURIComponent(match[1])}/${decodeURIComponent(match[2])}`;
    return response({ sha: commits.get(fullName) });
  };
  const baseCorpus = {
    schemaVersion: "cellfence.corpus.v1",
    subjects: [{
      id: "existing",
      repository: "https://github.com/base/existing.git",
      commit: "a".repeat(40),
      manifest: { strategy: "existing" },
    }],
  };

  const corpus = await collectGitHubCorpus({
    query: "language:TypeScript stars:>=100",
    limit: 2,
    apiBaseUrl: "https://api.github.test",
    token: "secret",
    baseCorpus,
    includeForks: false,
    includeArchived: false,
  }, {
    fetchImpl,
    now: () => new Date("2026-08-05T00:00:00.000Z"),
  });

  assert.equal(corpus.schemaVersion, "cellfence.corpus.v1");
  assert.equal(corpus.collection.addedSubjects, 2);
  assert.equal(corpus.collection.apiRequests, 4);
  assert.deepEqual(corpus.subjects.slice(1).map((subject) => subject.id), ["new-alpha", "new-beta"]);
  assert.deepEqual(corpus.subjects.slice(1).map((subject) => subject.commit), ["b".repeat(40), "c".repeat(40)]);
  assert.ok(corpus.subjects.every((subject) => /^[a-f0-9]{40}$/.test(subject.commit)));
  assert.equal(corpus.subjects[1].metadata.collectedAt, "2026-08-05T00:00:00.000Z");
  assert.deepEqual(corpus.collection.skipped.map((entry) => entry.reason), [
    "already_in_corpus",
    "fork_excluded",
    "archived_excluded",
    "commit_lookup_not_pinned",
  ]);
  assert.ok(requests.every((request) => request.options.headers.Authorization === "Bearer secret"));
});

test("GitHub corpus collection records commit API failures without emitting floating subjects", async () => {
  const fetchImpl = async (url) => {
    if (url.includes("/search/repositories")) {
      return response({ items: [{
        full_name: "broken/repo",
        default_branch: "main",
        clone_url: "https://github.com/broken/repo.git",
        fork: false,
        archived: false,
      }] });
    }
    return response({ message: "rate limited" }, 403);
  };
  const corpus = await collectGitHubCorpus({
    query: "language:JavaScript",
    limit: 1,
    apiBaseUrl: "https://api.github.test",
    baseCorpus: { schemaVersion: "cellfence.corpus.v1", subjects: [] },
  }, { fetchImpl });
  assert.equal(corpus.subjects.length, 0);
  assert.equal(corpus.collection.skipped[0].reason, "commit_lookup_failed");
  assert.match(corpus.collection.skipped[0].error, /rate limited/);
});
