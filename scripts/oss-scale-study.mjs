import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  environmentMetadata,
  runSubject,
  summarize,
  validateCorpus,
} from "./corpus-precision-study.mjs";
import { isExactCommit } from "./evidence-harness-lib.mjs";
import { measureTrackedSource } from "./product-evidence-corpus.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scriptPath = path.resolve(fileURLToPath(import.meta.url));
const defaultApiBaseUrl = "https://api.github.com";
const defaultWorkDir = path.join(repoRoot, "tmp", "oss-scale-study");
const defaultOutPath = path.join(repoRoot, "reports", "oss-scale-study.json");
const defaultCorpusOutPath = path.join(repoRoot, "reports", "oss-scale-corpus.json");
const defaultLanguages = ["TypeScript", "JavaScript", "Python"];
const defaultManifestPath = "cellfence.manifest.json";
const maxGitHubSearchPage = 10;
const maxGitHubSearchLimit = 1000;

function usage() {
  console.error(`Usage: node scripts/oss-scale-study.mjs [--language TypeScript ... | --languages TypeScript,JavaScript,Python] [--limit-per-language 3000] [--corpus existing.json] [--apply-corpus-only] [--corpus-out reports/oss-scale-corpus.json] [--out reports/oss-scale-study.json] [--workdir tmp/oss-scale-study] [--clone-mode full|shallow] [--infer-scope all|production] [--max-subjects n] [--collect-only] [--dry-run] [--discard-checkouts] [--min-stars 1] [--max-repo-size-kb n] [--token-env GITHUB_TOKEN] [--include-forks] [--include-archived]

Collects popular GitHub OSS repositories by language using descending star
order, pins default branches to exact commits, runs CellFence init/check with an
inferred production manifest, and reports whether the generated manifest looks
natural enough to execute without target repository installs.`);
}

function readValue(argv, index, optionName) {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${optionName} requires a value`);
  return value;
}

function parsePositiveInteger(value, optionName, maximum = Number.MAX_SAFE_INTEGER) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > maximum) {
    throw new Error(`${optionName} must be an integer from 1 to ${maximum}`);
  }
  return parsed;
}

function splitList(value) {
  return String(value || "").split(",").map((entry) => entry.trim()).filter(Boolean);
}

function uniqueValues(values) {
  return [...new Set(values)];
}

export function parseOssScaleArgs(argv) {
  const options = {
    languages: [],
    limitPerLanguage: 3000,
    minStars: 1,
    corpusPath: "",
    corpusOutPath: defaultCorpusOutPath,
    outPath: defaultOutPath,
    workDir: defaultWorkDir,
    tokenEnvironmentVariable: "GITHUB_TOKEN",
    apiBaseUrl: defaultApiBaseUrl,
    includeForks: false,
    includeArchived: false,
    maxRepoSizeKb: undefined,
    cloneMode: "shallow",
    inferScope: "production",
    maxSubjects: undefined,
    collectOnly: false,
    applyCorpusOnly: false,
    dryRun: false,
    discardCheckouts: false,
    perPage: 100,
    searchPageLimit: maxGitHubSearchPage,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--language") {
      options.languages.push(readValue(argv, index, "--language"));
      index += 1;
    } else if (argument.startsWith("--language=")) options.languages.push(argument.slice(11));
    else if (argument === "--languages") {
      options.languages.push(...splitList(readValue(argv, index, "--languages")));
      index += 1;
    } else if (argument.startsWith("--languages=")) options.languages.push(...splitList(argument.slice(12)));
    else if (argument === "--limit-per-language") {
      options.limitPerLanguage = parsePositiveInteger(readValue(argv, index, "--limit-per-language"), "--limit-per-language", 3000);
      index += 1;
    } else if (argument.startsWith("--limit-per-language=")) {
      options.limitPerLanguage = parsePositiveInteger(argument.slice(21), "--limit-per-language", 3000);
    } else if (argument === "--min-stars") {
      options.minStars = parsePositiveInteger(readValue(argv, index, "--min-stars"), "--min-stars");
      index += 1;
    } else if (argument.startsWith("--min-stars=")) options.minStars = parsePositiveInteger(argument.slice(12), "--min-stars");
    else if (argument === "--corpus") {
      options.corpusPath = path.resolve(readValue(argv, index, "--corpus"));
      index += 1;
    } else if (argument.startsWith("--corpus=")) options.corpusPath = path.resolve(argument.slice(9));
    else if (argument === "--corpus-out") {
      options.corpusOutPath = path.resolve(readValue(argv, index, "--corpus-out"));
      index += 1;
    } else if (argument.startsWith("--corpus-out=")) options.corpusOutPath = path.resolve(argument.slice(13));
    else if (argument === "--out") {
      options.outPath = path.resolve(readValue(argv, index, "--out"));
      index += 1;
    } else if (argument.startsWith("--out=")) options.outPath = path.resolve(argument.slice(6));
    else if (argument === "--workdir") {
      options.workDir = path.resolve(readValue(argv, index, "--workdir"));
      index += 1;
    } else if (argument.startsWith("--workdir=")) options.workDir = path.resolve(argument.slice(10));
    else if (argument === "--token-env") {
      options.tokenEnvironmentVariable = readValue(argv, index, "--token-env");
      index += 1;
    } else if (argument.startsWith("--token-env=")) options.tokenEnvironmentVariable = argument.slice(12);
    else if (argument === "--api-base-url") {
      options.apiBaseUrl = normalizeApiBaseUrl(readValue(argv, index, "--api-base-url"));
      index += 1;
    } else if (argument.startsWith("--api-base-url=")) options.apiBaseUrl = normalizeApiBaseUrl(argument.slice(15));
    else if (argument === "--include-forks") options.includeForks = true;
    else if (argument === "--include-archived") options.includeArchived = true;
    else if (argument === "--max-repo-size-kb") {
      options.maxRepoSizeKb = parsePositiveInteger(readValue(argv, index, "--max-repo-size-kb"), "--max-repo-size-kb");
      index += 1;
    } else if (argument.startsWith("--max-repo-size-kb=")) {
      options.maxRepoSizeKb = parsePositiveInteger(argument.slice(19), "--max-repo-size-kb");
    }
    else if (argument === "--clone-mode") {
      options.cloneMode = readValue(argv, index, "--clone-mode");
      index += 1;
    } else if (argument.startsWith("--clone-mode=")) options.cloneMode = argument.slice(13);
    else if (argument === "--infer-scope") {
      options.inferScope = readValue(argv, index, "--infer-scope");
      index += 1;
    } else if (argument.startsWith("--infer-scope=")) options.inferScope = argument.slice(14);
    else if (argument === "--max-subjects") {
      options.maxSubjects = parsePositiveInteger(readValue(argv, index, "--max-subjects"), "--max-subjects");
      index += 1;
    } else if (argument.startsWith("--max-subjects=")) options.maxSubjects = parsePositiveInteger(argument.slice(15), "--max-subjects");
    else if (argument === "--collect-only") options.collectOnly = true;
    else if (argument === "--apply-corpus-only") options.applyCorpusOnly = true;
    else if (argument === "--dry-run") options.dryRun = true;
    else if (argument === "--discard-checkouts") options.discardCheckouts = true;
    else if (argument === "--per-page") {
      options.perPage = parsePositiveInteger(readValue(argv, index, "--per-page"), "--per-page", 100);
      index += 1;
    } else if (argument.startsWith("--per-page=")) options.perPage = parsePositiveInteger(argument.slice(11), "--per-page", 100);
    else if (argument === "--search-page-limit") {
      options.searchPageLimit = parsePositiveInteger(readValue(argv, index, "--search-page-limit"), "--search-page-limit", maxGitHubSearchPage);
      index += 1;
    } else if (argument.startsWith("--search-page-limit=")) {
      options.searchPageLimit = parsePositiveInteger(argument.slice(20), "--search-page-limit", maxGitHubSearchPage);
    } else if (argument === "--help" || argument === "-h") return { help: true };
    else throw new Error(`unknown argument: ${argument}`);
  }
  options.languages = uniqueValues(options.languages.map((language) => language.trim()).filter(Boolean));
  if (options.languages.length === 0) options.languages = defaultLanguages;
  if (!["full", "shallow"].includes(options.cloneMode)) throw new Error("--clone-mode must be full or shallow");
  if (!["all", "production"].includes(options.inferScope)) throw new Error("--infer-scope must be all or production");
  if (options.applyCorpusOnly && !options.corpusPath) throw new Error("--apply-corpus-only requires --corpus");
  if (options.applyCorpusOnly && options.collectOnly) throw new Error("--apply-corpus-only cannot be combined with --collect-only");
  options.apiBaseUrl = normalizeApiBaseUrl(options.apiBaseUrl);
  return options;
}

function normalizeApiBaseUrl(value) {
  try {
    const url = new URL(value);
    if (!/^https?:$/.test(url.protocol)) throw new Error("unsupported protocol");
    return url.href.replace(/\/$/, "");
  } catch {
    throw new Error("--api-base-url must be an absolute HTTP(S) URL");
  }
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

function uniqueSubjectId(fullName, language, ids) {
  const languagePrefix = slug(language);
  const base = `${languagePrefix}-${slug(fullName.replace("/", "-"))}`;
  if (!ids.has(base)) return base;
  for (let suffix = 2; ; suffix += 1) {
    const candidate = `${base}-${suffix}`;
    if (!ids.has(candidate)) return candidate;
  }
}

function validateBaseCorpus(corpus) {
  if (corpus.schemaVersion !== "cellfence.corpus.v1") {
    throw new Error("corpus schemaVersion must be cellfence.corpus.v1");
  }
  if (!Array.isArray(corpus.subjects)) throw new Error("corpus subjects must be an array");
  for (const subject of corpus.subjects) {
    if (!isExactCommit(subject.commit)) {
      throw new Error(`corpus subject ${subject.id || "<unknown>"} is not pinned to an exact commit`);
    }
  }
}

function apiHeaders(token) {
  return {
    Accept: "application/vnd.github+json",
    "User-Agent": "cellfence-oss-scale-study",
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

function languageQualifier(language) {
  return /^[A-Za-z0-9_+-]+$/.test(language) ? `language:${language}` : `language:${JSON.stringify(language)}`;
}

export function githubLanguageQuery(language, minStars, starCeiling) {
  const starQualifier = starCeiling === undefined
    ? `stars:>=${minStars}`
    : `stars:${minStars}..${starCeiling}`;
  return `${languageQualifier(language)} ${starQualifier}`;
}

function repositorySubject(item, commit, id, language, rank, collectedAt) {
  return {
    id,
    repository: item.clone_url || `https://github.com/${item.full_name}.git`,
    commit,
    manifest: { strategy: "infer", scope: "production" },
    metadata: {
      source: "github-search-stars-window",
      githubFullName: item.full_name,
      htmlUrl: item.html_url || `https://github.com/${item.full_name}`,
      defaultBranch: item.default_branch,
      stars: Number(item.stargazers_count || 0),
      forks: Number(item.forks_count || 0),
      diskUsageKb: Number(item.size || 0),
      language,
      languageRank: rank,
      collectedAt,
    },
  };
}

async function resolveDefaultBranchCommit(item, options, headers, fetchImpl) {
  const [owner, repositoryName] = item.full_name.split("/");
  if (!owner || !repositoryName || typeof item.default_branch !== "string") return undefined;
  const commitUrl = `${options.apiBaseUrl}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repositoryName)}/commits/${encodeURIComponent(item.default_branch)}`;
  const commitResponse = await fetchJson(fetchImpl, commitUrl, headers);
  return isExactCommit(commitResponse.sha) ? commitResponse.sha.toLowerCase() : undefined;
}

export async function collectPopularGitHubCorpus(options, dependencies = {}) {
  const fetchImpl = dependencies.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== "function") throw new Error("GitHub collection requires a fetch implementation");
  const now = dependencies.now || (() => new Date());
  const token = options.token || process.env[options.tokenEnvironmentVariable || "GITHUB_TOKEN"] || "";
  const headers = apiHeaders(token);
  const collectedAt = now().toISOString();
  const baseCorpus = options.baseCorpus || { schemaVersion: "cellfence.corpus.v1", subjects: [] };
  validateBaseCorpus(baseCorpus);
  const existingRepositories = new Set(baseCorpus.subjects.map((subject) => normalizedRepository(subject.repository)));
  const subjectIds = new Set(baseCorpus.subjects.map((subject) => subject.id));
  const added = [];
  const skipped = [];
  const languageSummaries = [];
  let apiRequests = 0;

  for (const language of options.languages) {
    let addedForLanguage = 0;
    let starCeiling;
    let rank = 0;
    const languageStartedAt = added.length;
    while (addedForLanguage < options.limitPerLanguage) {
      const remaining = options.limitPerLanguage - addedForLanguage;
      const perPage = Math.min(options.perPage || 100, remaining, 100);
      const query = githubLanguageQuery(language, options.minStars || 1, starCeiling);
      let pageProducedItems = false;
      let lastPageLowestStars;
      const pageLimit = Math.min(options.searchPageLimit || maxGitHubSearchPage, Math.floor(maxGitHubSearchLimit / perPage));
      for (let page = 1; page <= pageLimit && addedForLanguage < options.limitPerLanguage; page += 1) {
        const searchUrl = new URL(`${options.apiBaseUrl || defaultApiBaseUrl}/search/repositories`);
        searchUrl.searchParams.set("q", query);
        searchUrl.searchParams.set("sort", "stars");
        searchUrl.searchParams.set("order", "desc");
        searchUrl.searchParams.set("per_page", String(perPage));
        searchUrl.searchParams.set("page", String(page));
        apiRequests += 1;
        const search = await fetchJson(fetchImpl, searchUrl.href, headers);
        if (!Array.isArray(search.items)) throw new Error("GitHub repository search response is missing items");
        if (search.items.length === 0) break;
        pageProducedItems = true;
        for (const item of search.items) {
          lastPageLowestStars = Number(item?.stargazers_count || 0);
          if (addedForLanguage >= options.limitPerLanguage) break;
          if (!item || typeof item.full_name !== "string" || typeof item.default_branch !== "string") {
            skipped.push({ language, repository: item?.full_name || null, reason: "incomplete_repository_metadata" });
            continue;
          }
          if (item.fork && !options.includeForks) {
            skipped.push({ language, repository: item.full_name, reason: "fork_excluded" });
            continue;
          }
          if (item.archived && !options.includeArchived) {
            skipped.push({ language, repository: item.full_name, reason: "archived_excluded" });
            continue;
          }
          if (Number.isInteger(options.maxRepoSizeKb) && Number(item.size || 0) > options.maxRepoSizeKb) {
            skipped.push({
              language,
              repository: item.full_name,
              reason: "size_excluded",
              diskUsageKb: Number(item.size || 0),
              maxRepoSizeKb: options.maxRepoSizeKb,
            });
            continue;
          }
          const repositoryKey = normalizedRepository(item.clone_url || `https://github.com/${item.full_name}`);
          if (existingRepositories.has(repositoryKey)) {
            skipped.push({ language, repository: item.full_name, reason: "already_in_corpus" });
            continue;
          }
          let commit;
          try {
            apiRequests += 1;
            commit = await resolveDefaultBranchCommit(item, options, headers, fetchImpl);
          } catch (error) {
            skipped.push({
              language,
              repository: item.full_name,
              reason: "commit_lookup_failed",
              error: error instanceof Error ? error.message : String(error),
            });
            continue;
          }
          if (!commit) {
            skipped.push({ language, repository: item.full_name, reason: "commit_lookup_not_pinned" });
            continue;
          }
          rank += 1;
          const id = uniqueSubjectId(item.full_name, language, subjectIds);
          subjectIds.add(id);
          existingRepositories.add(repositoryKey);
          added.push(repositorySubject(item, commit, id, language, rank, collectedAt));
          addedForLanguage += 1;
        }
        if (search.items.length < perPage) break;
      }
      if (!pageProducedItems || !Number.isFinite(lastPageLowestStars) || lastPageLowestStars <= (options.minStars || 1)) break;
      starCeiling = lastPageLowestStars - 1;
    }
    languageSummaries.push({
      language,
      requestedSubjects: options.limitPerLanguage,
      addedSubjects: added.length - languageStartedAt,
    });
  }

  return {
    schemaVersion: "cellfence.corpus.v1",
    collection: {
      schemaVersion: "cellfence.oss-scale-collection.v1",
      collectedAt,
      requestedSubjectsPerLanguage: options.limitPerLanguage,
      minStars: options.minStars || 1,
      languages: languageSummaries,
      apiRequests,
      exactCommitsRequired: true,
      filters: {
        includeForks: options.includeForks === true,
        includeArchived: options.includeArchived === true,
        ...(Number.isInteger(options.maxRepoSizeKb) ? { maxRepoSizeKb: options.maxRepoSizeKb } : {}),
      },
      skipped,
    },
    subjects: [...baseCorpus.subjects, ...added],
  };
}

function pathWithin(rootDir, candidatePath) {
  const relative = path.relative(path.resolve(rootDir), path.resolve(candidatePath));
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function safeReadManifest(manifestPath) {
  try {
    return readJson(manifestPath);
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

export function diagnoseInferredManifest(subjectResult) {
  const checkoutDir = path.join(subjectResult.subjectDir, "checkout");
  const effectivePath = subjectResult.manifest?.effectivePath;
  if (!effectivePath) {
    return { status: "manifest_unavailable", natural: false, reason: "manifest was not produced" };
  }
  const manifestPath = path.isAbsolute(effectivePath) ? effectivePath : path.resolve(checkoutDir, effectivePath);
  if (!pathWithin(subjectResult.subjectDir, manifestPath) && !pathWithin(checkoutDir, manifestPath)) {
    return { status: "manifest_unavailable", natural: false, reason: "manifest path escapes subject workspace" };
  }
  const manifest = safeReadManifest(manifestPath);
  if (manifest.error) return { status: "manifest_unreadable", natural: false, reason: manifest.error };
  const cells = Array.isArray(manifest.cells) ? manifest.cells : [];
  const fallbackExample = cells.length === 1 && cells[0]?.id === "example" && cells[0]?.publicEntry === "src/example/public.ts";
  const missingPublicEntries = [];
  for (const cell of cells) {
    if (typeof cell?.publicEntry !== "string") {
      missingPublicEntries.push(`${cell?.id || "<unknown>"}:<missing>`);
      continue;
    }
    if (!fs.existsSync(path.join(checkoutDir, cell.publicEntry))) missingPublicEntries.push(`${cell.id || "<unknown>"}:${cell.publicEntry}`);
  }
  const scale = fs.existsSync(checkoutDir) ? measureTrackedSource(checkoutDir, manifestPath) : { status: "unavailable" };
  let status = "natural";
  let reason;
  if (fallbackExample) {
    status = "fallback_example";
    reason = "init fell back to the example manifest";
  } else if (cells.length === 0) {
    status = "empty_manifest";
    reason = "manifest contains no cells";
  } else if (missingPublicEntries.length > 0) {
    status = "missing_public_entry";
    reason = "one or more publicEntry paths do not exist";
  } else if (scale.status !== "measured" || !Number.isFinite(scale.sourceFiles) || scale.sourceFiles < 1) {
    status = "no_governed_source";
    reason = "manifest governs no tracked source files";
  }
  return {
    status,
    natural: status === "natural",
    ...(reason ? { reason } : {}),
    cells: cells.length,
    packageBackedCells: cells.filter((cell) => typeof cell?.packageName === "string").length,
    includePatterns: Array.isArray(manifest.governance?.include) ? manifest.governance.include.length : 0,
    missingPublicEntries,
    sourceFiles: scale.sourceFiles ?? null,
    sourceLines: scale.sourceLines ?? null,
    trackedSourceFiles: scale.trackedSourceFiles ?? null,
  };
}

function naturalnessSummary(subjects) {
  const byStatus = {};
  const byLanguage = {};
  for (const subject of subjects) {
    const status = subject.manifestDiagnostics?.status || "not_run";
    byStatus[status] = (byStatus[status] || 0) + 1;
    const language = subject.metadata?.language || subject.language || "unknown";
    if (!byLanguage[language]) byLanguage[language] = { total: 0, natural: 0, statuses: {} };
    byLanguage[language].total += 1;
    if (subject.manifestDiagnostics?.natural) byLanguage[language].natural += 1;
    byLanguage[language].statuses[status] = (byLanguage[language].statuses[status] || 0) + 1;
  }
  return {
    byStatus: Object.fromEntries(Object.entries(byStatus).sort(([left], [right]) => left.localeCompare(right))),
    byLanguage: Object.fromEntries(Object.entries(byLanguage).sort(([left], [right]) => left.localeCompare(right))),
  };
}

function selectedSubjects(corpus, options) {
  return corpus.subjects.slice(0, options.maxSubjects || corpus.subjects.length);
}

export function runOssScaleStudy(corpus, options) {
  validateCorpus(corpus, {
    workDir: options.workDir,
    allowFloatingRef: false,
    cloneMode: options.cloneMode,
    discardCheckouts: options.discardCheckouts,
    inferScope: options.inferScope,
    verifyEvidenceGraphs: false,
    dryRun: options.dryRun,
  }, path.dirname(options.corpusOutPath || options.corpusPath || repoRoot));
  fs.mkdirSync(options.workDir, { recursive: true });
  const subjects = selectedSubjects(corpus, options).map((subject) => {
    const result = runSubject(subject, path.dirname(options.corpusOutPath || options.corpusPath || repoRoot), {
      workDir: options.workDir,
      allowFloatingRef: false,
      cloneMode: options.cloneMode,
      discardCheckouts: false,
      inferScope: options.inferScope,
      verifyEvidenceGraphs: false,
      dryRun: options.dryRun,
    });
    const diagnostics = options.dryRun ? { status: "planned", natural: false } : diagnoseInferredManifest(result);
    if (options.discardCheckouts && !options.dryRun) fs.rmSync(path.join(result.subjectDir, "checkout"), { recursive: true, force: true });
    return {
      ...result,
      metadata: subject.metadata || {},
      manifestDiagnostics: diagnostics,
      ...(options.discardCheckouts && !options.dryRun ? { checkoutDiscarded: true } : {}),
    };
  });
  return {
    schemaVersion: "cellfence.oss-scale-study.v1",
    generatedAt: new Date().toISOString(),
    corpusPath: options.corpusPath || null,
    corpusOutPath: options.corpusOutPath,
    dryRun: options.dryRun,
    collectOnly: false,
    cloneMode: options.cloneMode,
    inferScope: options.inferScope,
    safety: {
      exactCommitsRequired: true,
      targetRepositoryInstalls: "not_performed_by_harness",
      targetRepositoryScripts: "not_run_by_harness",
      shellExecution: "spawn-shell-disabled",
      manifestStrategy: `${defaultManifestPath}:infer`,
    },
    environment: environmentMetadata(options.corpusOutPath || options.corpusPath),
    subjects,
    summary: {
      corpusStudy: summarize(subjects),
      manifestNaturalness: naturalnessSummary(subjects),
    },
  };
}

function shouldFail(report) {
  const summary = report.summary.corpusStudy;
  return summary.failed > 0
    || summary.configurationErrors > 0
    || summary.toolErrors > 0
    || summary.unparseableOutputs > 0
    || summary.timeouts > 0;
}

export async function main(argv = process.argv.slice(2), dependencies = {}) {
  let options;
  try {
    options = parseOssScaleArgs(argv);
    if (options.help) {
      usage();
      return 0;
    }
    if (!options.dryRun && !options.collectOnly && !fs.existsSync(path.join(repoRoot, "packages", "cli", "dist", "index.js"))) {
      throw new Error("CellFence CLI dist is missing; run npm run build before the OSS scale study");
    }
    const baseCorpus = options.corpusPath ? readJson(options.corpusPath) : { schemaVersion: "cellfence.corpus.v1", subjects: [] };
    const corpus = options.applyCorpusOnly
      ? baseCorpus
      : await collectPopularGitHubCorpus({
        ...options,
        baseCorpus,
      }, dependencies);
    writeJson(options.corpusOutPath, corpus);
    if (options.collectOnly) {
      const report = {
        schemaVersion: "cellfence.oss-scale-study.v1",
        generatedAt: new Date().toISOString(),
        corpusPath: options.corpusPath || null,
        corpusOutPath: options.corpusOutPath,
        collectOnly: true,
        collection: corpus.collection,
        subjectsPlanned: corpus.subjects.length,
        environment: environmentMetadata(options.corpusOutPath),
      };
      writeJson(options.outPath, report);
      console.log(JSON.stringify({ collection: corpus.collection, subjectsPlanned: corpus.subjects.length }, null, 2));
      return 0;
    }
    const report = runOssScaleStudy(corpus, options);
    writeJson(options.outPath, report);
    console.log(JSON.stringify(report.summary, null, 2));
    return shouldFail(report) ? 1 : 0;
  } catch (error) {
    usage();
    console.error(error instanceof Error ? error.message : String(error));
    return 2;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  process.exitCode = await main();
}
