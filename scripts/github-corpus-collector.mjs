import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { isExactCommit } from "./evidence-harness-lib.mjs";

const scriptPath = path.resolve(fileURLToPath(import.meta.url));
const defaultApiBaseUrl = "https://api.github.com";

function usage() {
  console.error(`Usage: node scripts/github-corpus-collector.mjs --query "language:TypeScript stars:>=100" --out corpus.json [--base-corpus existing.json] [--limit 25] [--api-base-url https://api.github.com] [--token-env GITHUB_TOKEN] [--include-forks] [--include-archived]

Collects GitHub repositories into a CellFence corpus. Every added repository is
pinned by resolving its default branch to an exact commit SHA.`);
}

function requireValue(argv, index, optionName) {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${optionName} requires a value`);
  return value;
}

export function parseGitHubCollectorArgs(argv) {
  const options = {
    query: "",
    outPath: "",
    baseCorpusPath: "",
    apiBaseUrl: defaultApiBaseUrl,
    tokenEnvironmentVariable: "GITHUB_TOKEN",
    limit: 25,
    includeForks: false,
    includeArchived: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--query") {
      options.query = requireValue(argv, index, "--query");
      index += 1;
    } else if (argument.startsWith("--query=")) options.query = argument.slice(8);
    else if (argument === "--out") {
      options.outPath = path.resolve(requireValue(argv, index, "--out"));
      index += 1;
    } else if (argument.startsWith("--out=")) options.outPath = path.resolve(argument.slice(6));
    else if (argument === "--base-corpus") {
      options.baseCorpusPath = path.resolve(requireValue(argv, index, "--base-corpus"));
      index += 1;
    } else if (argument.startsWith("--base-corpus=")) options.baseCorpusPath = path.resolve(argument.slice(14));
    else if (argument === "--limit") {
      options.limit = Number(requireValue(argv, index, "--limit"));
      index += 1;
    } else if (argument.startsWith("--limit=")) options.limit = Number(argument.slice(8));
    else if (argument === "--api-base-url") {
      options.apiBaseUrl = requireValue(argv, index, "--api-base-url");
      index += 1;
    } else if (argument.startsWith("--api-base-url=")) options.apiBaseUrl = argument.slice(15);
    else if (argument === "--token-env") {
      options.tokenEnvironmentVariable = requireValue(argv, index, "--token-env");
      index += 1;
    } else if (argument.startsWith("--token-env=")) options.tokenEnvironmentVariable = argument.slice(12);
    else if (argument === "--include-forks") options.includeForks = true;
    else if (argument === "--include-archived") options.includeArchived = true;
    else if (argument === "--help" || argument === "-h") return { help: true };
    else throw new Error(`unknown argument: ${argument}`);
  }
  if (!options.query.trim()) throw new Error("--query is required");
  if (!options.outPath) throw new Error("--out is required");
  if (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > 1000) {
    throw new Error("--limit must be an integer from 1 to 1000");
  }
  try {
    const apiUrl = new URL(options.apiBaseUrl);
    if (!/^https?:$/.test(apiUrl.protocol)) throw new Error("unsupported protocol");
    options.apiBaseUrl = apiUrl.href.replace(/\/$/, "");
  } catch {
    throw new Error("--api-base-url must be an absolute HTTP(S) URL");
  }
  return options;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function normalizedRepository(value) {
  return String(value || "").trim().toLowerCase().replace(/\.git$/, "").replace(/\/+$/, "");
}

function slug(value) {
  return String(value).toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "github-subject";
}

function uniqueSubjectId(fullName, ids) {
  const base = slug(fullName.replace("/", "-"));
  if (!ids.has(base)) return base;
  for (let suffix = 2; ; suffix += 1) {
    const candidate = `${base}-${suffix}`;
    if (!ids.has(candidate)) return candidate;
  }
}

function validateBaseCorpus(corpus) {
  if (corpus.schemaVersion !== "cellfence.corpus.v1") {
    throw new Error("base corpus schemaVersion must be cellfence.corpus.v1");
  }
  if (!Array.isArray(corpus.subjects)) throw new Error("base corpus subjects must be an array");
  for (const subject of corpus.subjects) {
    if (!isExactCommit(subject.commit)) throw new Error(`base corpus subject ${subject.id || "<unknown>"} is not pinned to an exact commit`);
  }
}

function apiHeaders(token) {
  return {
    Accept: "application/vnd.github+json",
    "User-Agent": "cellfence-corpus-collector",
    "X-GitHub-Api-Version": "2022-11-28",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

async function fetchJson(fetchImpl, url, headers) {
  const response = await fetchImpl(url, { method: "GET", headers });
  let body;
  try {
    body = await response.json();
  } catch {
    throw new Error(`GitHub API returned non-JSON response for ${url}`);
  }
  if (!response.ok) {
    const message = body && typeof body.message === "string" ? body.message : `HTTP ${response.status}`;
    throw new Error(`GitHub API request failed (${response.status}): ${message}`);
  }
  return body;
}

function repositorySubject(item, commit, id, collectedAt) {
  const repository = typeof item.clone_url === "string" && item.clone_url
    ? item.clone_url
    : `https://github.com/${item.full_name}.git`;
  return {
    id,
    repository,
    commit,
    manifest: { strategy: "infer", scope: "production" },
    metadata: {
      source: "github-search",
      githubFullName: item.full_name,
      htmlUrl: item.html_url || `https://github.com/${item.full_name}`,
      defaultBranch: item.default_branch,
      stars: Number(item.stargazers_count || 0),
      forks: Number(item.forks_count || 0),
      diskUsageKb: Number(item.size || 0),
      language: item.language || null,
      collectedAt,
    },
  };
}

export async function collectGitHubCorpus(options, dependencies = {}) {
  const fetchImpl = dependencies.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== "function") throw new Error("GitHub collection requires a fetch implementation");
  const now = dependencies.now || (() => new Date());
  const baseCorpus = options.baseCorpus || { schemaVersion: "cellfence.corpus.v1", subjects: [] };
  validateBaseCorpus(baseCorpus);
  const collectedAt = now().toISOString();
  const token = options.token || "";
  const headers = apiHeaders(token);
  const existingRepositories = new Set(baseCorpus.subjects.map((subject) => normalizedRepository(subject.repository)));
  const subjectIds = new Set(baseCorpus.subjects.map((subject) => subject.id));
  const added = [];
  const skipped = [];
  let apiRequests = 0;
  const perPage = Math.min(100, Math.max(10, options.limit));
  const maxPages = Math.ceil(1000 / perPage);

  for (let page = 1; page <= maxPages && added.length < options.limit; page += 1) {
    const searchUrl = new URL(`${options.apiBaseUrl || defaultApiBaseUrl}/search/repositories`);
    searchUrl.searchParams.set("q", options.query);
    searchUrl.searchParams.set("sort", "stars");
    searchUrl.searchParams.set("order", "desc");
    searchUrl.searchParams.set("per_page", String(perPage));
    searchUrl.searchParams.set("page", String(page));
    apiRequests += 1;
    const search = await fetchJson(fetchImpl, searchUrl.href, headers);
    if (!Array.isArray(search.items)) throw new Error("GitHub repository search response is missing items");
    if (search.items.length === 0) break;
    for (const item of search.items) {
      if (added.length >= options.limit) break;
      if (!item || typeof item.full_name !== "string" || typeof item.default_branch !== "string") {
        skipped.push({ repository: item?.full_name || null, reason: "incomplete_repository_metadata" });
        continue;
      }
      if (item.fork && !options.includeForks) {
        skipped.push({ repository: item.full_name, reason: "fork_excluded" });
        continue;
      }
      if (item.archived && !options.includeArchived) {
        skipped.push({ repository: item.full_name, reason: "archived_excluded" });
        continue;
      }
      const repositoryKey = normalizedRepository(item.clone_url || `https://github.com/${item.full_name}`);
      if (existingRepositories.has(repositoryKey)) {
        skipped.push({ repository: item.full_name, reason: "already_in_corpus" });
        continue;
      }
      const [owner, repositoryName] = item.full_name.split("/");
      if (!owner || !repositoryName) {
        skipped.push({ repository: item.full_name, reason: "invalid_full_name" });
        continue;
      }
      const commitUrl = `${options.apiBaseUrl || defaultApiBaseUrl}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repositoryName)}/commits/${encodeURIComponent(item.default_branch)}`;
      let commitResponse;
      try {
        apiRequests += 1;
        commitResponse = await fetchJson(fetchImpl, commitUrl, headers);
      } catch (error) {
        skipped.push({
          repository: item.full_name,
          reason: "commit_lookup_failed",
          error: error instanceof Error ? error.message : String(error),
        });
        continue;
      }
      if (!isExactCommit(commitResponse.sha)) {
        skipped.push({ repository: item.full_name, reason: "commit_lookup_not_pinned" });
        continue;
      }
      const id = uniqueSubjectId(item.full_name, subjectIds);
      subjectIds.add(id);
      existingRepositories.add(repositoryKey);
      added.push(repositorySubject(item, commitResponse.sha.toLowerCase(), id, collectedAt));
    }
    if (search.items.length < perPage) break;
  }

  return {
    schemaVersion: "cellfence.corpus.v1",
    collection: {
      schemaVersion: "cellfence.github-corpus-collection.v1",
      collectedAt,
      query: options.query,
      requestedSubjects: options.limit,
      baseSubjects: baseCorpus.subjects.length,
      addedSubjects: added.length,
      apiRequests,
      exactCommitsRequired: true,
      filters: {
        includeForks: options.includeForks === true,
        includeArchived: options.includeArchived === true,
      },
      skipped,
    },
    subjects: [...baseCorpus.subjects, ...added],
  };
}

export async function main(argv = process.argv.slice(2), dependencies = {}) {
  try {
    const options = parseGitHubCollectorArgs(argv);
    if (options.help) {
      usage();
      return 0;
    }
    const baseCorpus = options.baseCorpusPath
      ? readJson(options.baseCorpusPath)
      : { schemaVersion: "cellfence.corpus.v1", subjects: [] };
    const corpus = await collectGitHubCorpus({
      ...options,
      baseCorpus,
      token: process.env[options.tokenEnvironmentVariable] || "",
    }, dependencies);
    writeJson(options.outPath, corpus);
    console.log(JSON.stringify(corpus.collection, null, 2));
    return corpus.collection.addedSubjects > 0 ? 0 : 1;
  } catch (error) {
    usage();
    console.error(error instanceof Error ? error.message : String(error));
    return 2;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  main().then((exitCode) => {
    process.exitCode = exitCode;
  });
}
