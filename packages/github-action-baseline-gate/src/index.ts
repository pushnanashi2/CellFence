// 0.4.x: the gate surfaces the governance change as a sticky PR
// comment (configurable via the `comment-mode` input), resolves
// the default baseline-codeowner list from the repo's
// `CODEOWNERS` file when the workflow does not pass an explicit
// list, and detects mixed PRs that change both the baseline and
// implementation files.
//
// The action is self-contained: it imports the baseline-gate
// logic from a local module (./baseline-gate.js) so the ncc bundle
// only depends on `@actions/core` + `@actions/github`. This keeps
// the published action a single distributable file that does not
// need a node_modules tree at runtime.

import * as core from "@actions/core";
import * as github from "@actions/github";

import { runBaselineGateFull, type BaselineGateResult } from "./baseline-gate.js";

const GOVERNANCE_LABEL = "governance-change";
const STICKY_COMMENT_MARKER = "<!-- cellfence-baseline-gate -->";
const STICKY_COMMENT_RESOLVED_MARKER = "<!-- cellfence-baseline-gate:resolved -->";
const DEFAULT_BASELINE_PATH = ".cellfence/baselines/cellfence.baseline.json";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Octokit = any;

async function ensureLabel(octokit: Octokit, owner: string, repo: string, label: string): Promise<void> {
  try {
    await octokit.rest.issues.getLabel({ owner, repo, name: label });
  } catch (error) {
    const status = typeof error === "object" && error !== null && "status" in error ? (error as { status: number }).status : 0;
    if (status === 404) {
      await octokit.rest.issues.createLabel({
        owner,
        repo,
        name: label,
        color: "d93f0b",
        description: "CellFence governance change — requires baseline-codeowner approval",
      });
    }
  }
}

function userMatchesAllowlist(user: { login?: string } | null | undefined, allowlist: string[]): boolean {
  if (!user || !user.login) return false;
  const candidate = user.login.toLowerCase();
  return allowlist.some((entry) => entry.toLowerCase() === candidate || entry.toLowerCase() === `@${candidate}`);
}

async function approveFromCodeowner(
  octokit: Octokit,
  owner: string,
  repo: string,
  pullNumber: number,
  codeowners: string[],
  headSha: string,
): Promise<boolean> {
  if (codeowners.length === 0) return false;
  const reviews = await octokit.paginate(octokit.rest.pulls.listReviews, {
    owner,
    repo,
    pull_number: pullNumber,
    per_page: 100,
  });
  // Aggregate the most recent review per reviewer; GitHub returns
  // them in chronological order so the last entry for each user
  // wins. An approval that has since been dismissed or replaced
  // by a CHANGES_REQUESTED is therefore correctly ignored.
  const latest = new Map<string, { state: string; commitId: string | null }>();
  for (const review of reviews) {
    if (!review.user?.login) continue;
    latest.set(review.user.login, {
      state: review.state,
      commitId: typeof review.commit_id === "string" ? review.commit_id : null,
    });
  }
  for (const [login, review] of latest) {
    if (review.state === "APPROVED" && review.commitId === headSha && userMatchesAllowlist({ login }, codeowners)) return true;
  }
  return false;
}

function parseCodeowners(input: string | undefined): string[] {
  if (!input) return [];
  const codeowners = input.split(",").map((entry) => entry.trim()).filter(Boolean);
  validateUsernameCodeowners(codeowners);
  return codeowners;
}

function validateUsernameCodeowners(codeowners: string[]): void {
  const teamEntries = codeowners.filter((entry) => /^@?[^/\s]+\/[^/\s]+$/.test(entry));
  if (teamEntries.length === 0) return;
  throw new Error(
    `baseline-codeowners currently supports GitHub usernames only; team entries are not resolved: ${teamEntries.join(", ")}`,
  );
}

// Minimal CODEOWNERS parser: only enough to pull out the entries
// that apply to the baseline path. The full CODEOWNERS spec has
// many edge cases (negations, escape rules); for the gate's
// default-allowlist purpose we only need "who owns the baseline
// file". Falls back to an empty list on parse failure.
function codeownersForPath(codeownersText: string, targetPath: string): string[] {
  const target = targetPath.replace(/^\.\//, "").replace(/\\/g, "/");
  const candidates: { pattern: string; owners: string[] }[] = [];
  for (const rawLine of codeownersText.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, "").trim();
    if (!line) continue;
    const [pattern, ...owners] = line.split(/\s+/);
    if (!pattern || owners.length === 0) continue;
    candidates.push({ pattern, owners });
  }
  // CODEOWNERS: latest match wins. Patterns are not full globs;
  // we approximate by checking substring + trailing /**.
  const matches = candidates.filter(({ pattern }) => {
    const norm = pattern.replace(/^\//, "");
    if (norm === target) return true;
    if (norm.endsWith("/**") && target.startsWith(norm.slice(0, -2))) return true;
    if (target.startsWith(norm.replace(/\/$/, "") + "/")) return true;
    return false;
  });
  if (matches.length === 0) return [];
  return matches[matches.length - 1].owners;
}

async function loadCodeownersFromRepo(
  octokit: Octokit,
  owner: string,
  repo: string,
  baselineFile: string,
): Promise<string[]> {
  for (const codeownersPath of [".github/CODEOWNERS", "CODEOWNERS", "docs/CODEOWNERS"]) {
    let text: string;
    try {
      const response = await octokit.rest.repos.getContent({ owner, repo, path: codeownersPath });
      const data = response.data;
      if (Array.isArray(data) || !("content" in data) || typeof data.content !== "string") continue;
      text = Buffer.from(data.content, "base64").toString("utf8");
    } catch (error) {
      const status = typeof error === "object" && error !== null && "status" in error ? (error as { status: number }).status : 0;
      if (status !== 404) {
        core.warning(`CODEOWNERS lookup at ${codeownersPath} failed: ${error instanceof Error ? error.message : String(error)}`);
      }
      continue;
    }
    const owners = codeownersForPath(text, baselineFile);
    if (owners.length === 0) continue;
    validateUsernameCodeowners(owners);
    return owners;
  }
  return [];
}

function formatGateComment(input: {
  headSha: string;
  baseSha: string;
  report: { hasChange: boolean; deltas: { dimension: string; added: string[]; removed: string[]; skippedCells?: string[] }[] };
  approved: boolean;
  codeowners: string[];
}): string {
  const dims = input.report.deltas ?? [];
  const lines: string[] = [
    STICKY_COMMENT_MARKER,
    "## CellFence baseline gate",
    "",
    `- Base SHA: \`${input.baseSha}\``,
    `- Head SHA: \`${input.headSha}\``,
    `- Status: ${input.approved ? "approved" : "pending approval"}`,
  ];
  const changedDims = dims.filter((dim) => dim.added.length > 0 || dim.removed.length > 0);
  if (changedDims.length > 0) {
    lines.push("", `Governance changes: ${changedDims.map((dim) => dim.dimension).join(", ")}`);
  }
  if (dims.length > 0) {
    lines.push("", "| Dimension | Added | Removed |", "| --- | --- | --- |");
    for (const dim of dims) {
      const changed = dim.added.length > 0 || dim.removed.length > 0;
      lines.push(`| ${dim.dimension} | ${dim.added.length} | ${dim.removed.length}${changed ? " ⚠️" : ""} |`);
    }
  }
  if (!input.approved) {
    lines.push(
      "",
      `Approval required from: ${input.codeowners.length === 0 ? "_no baseline-codeowner configured — set baseline-codeowners or add a CODEOWNERS entry_" : input.codeowners.map((o) => `${o}`).join(", ")}`,
    );
  }
  return `${lines.join("\n")}\n`;
}

function formatResolvedComment(headSha: string): string {
  return [
    STICKY_COMMENT_RESOLVED_MARKER,
    STICKY_COMMENT_MARKER,
    "## CellFence baseline gate",
    "",
    `No outstanding governance change at \`${headSha}\`. The previous gate notification is now resolved.`,
    "",
  ].join("\n");
}

async function upsertStickyComment(
  octokit: Octokit,
  owner: string,
  repo: string,
  pullNumber: number,
  body: string,
  mode: "update" | "create" | "disabled",
): Promise<void> {
  if (mode === "disabled") return;
  if (mode === "create") {
    await octokit.rest.issues.createComment({ owner, repo, issue_number: pullNumber, body });
    return;
  }
  const comments = await octokit.paginate(octokit.rest.issues.listComments, {
    owner,
    repo,
    issue_number: pullNumber,
    per_page: 100,
  });
  const previous = comments.find((comment: { body?: string; id: number; user?: { login?: string; type?: string } }) => {
    const text = comment.body ?? "";
    if (!text.includes(STICKY_COMMENT_MARKER) && !text.includes(STICKY_COMMENT_RESOLVED_MARKER)) return false;
    const login = comment.user?.login ?? "";
    return login === "github-actions[bot]" || login.endsWith("[bot]") || comment.user?.type === "Bot";
  });
  if (previous) {
    await octokit.rest.issues.updateComment({
      owner,
      repo,
      comment_id: previous.id,
      body,
    });
    return;
  }
  await octokit.rest.issues.createComment({ owner, repo, issue_number: pullNumber, body });
}

async function changedFilesTouchBaseline(
  octokit: Octokit,
  owner: string,
  repo: string,
  pullNumber: number,
  baselineFile: string,
): Promise<{ baseline: boolean; implementation: boolean; names: string[] }> {
  const files = await octokit.paginate(octokit.rest.pulls.listFiles, {
    owner,
    repo,
    pull_number: pullNumber,
    per_page: 100,
  });
  const names = files.map((f: { filename: string }) => f.filename);
  const baseline = names.some((name: string) => name === baselineFile || name.endsWith("/" + baselineFile));
  const implementation = names.some((name: string) => !name.startsWith(".cellfence/") && !name.endsWith(".md") && name !== "PROGRESS.md");
  return { baseline, implementation, names };
}

function parseCommentMode(value: string | undefined): "update" | "create" | "disabled" {
  const normalized = value || "update";
  if (normalized === "update" || normalized === "create" || normalized === "disabled") return normalized;
  throw new Error(`invalid comment-mode ${JSON.stringify(value)}; expected update, create, or disabled`);
}

function parseBooleanInput(name: string, defaultValue: boolean): boolean {
  const raw = core.getInput(name);
  if (!raw) return defaultValue;
  const normalized = raw.toLowerCase();
  if (normalized === "true") return true;
  if (normalized === "false") return false;
  throw new Error(`invalid ${name} ${JSON.stringify(raw)}; expected true or false`);
}

async function removeLabelIfPresent(octokit: Octokit, owner: string, repo: string, pullNumber: number, label: string): Promise<void> {
  try {
    await octokit.rest.issues.removeLabel({ owner, repo, issue_number: pullNumber, name: label });
  } catch (error) {
    const status = typeof error === "object" && error !== null && "status" in error ? (error as { status: number }).status : 0;
    if (status !== 404) throw error;
  }
}

export async function runAction(): Promise<void> {
  const context = github.context;
  if (!context.payload.pull_request) {
    // No-op outside of pull_request events. The action is a CI gate;
    // GitHub Actions convention is to skip cleanly so the workflow
    // does not fail on push events or manual dispatch.
    core.warning("cellfence-baseline-gate only runs on pull_request events; skipping");
    return;
  }
  const pullRequest = context.payload.pull_request as {
    number: number;
    head: { sha: string; ref: string };
    base: { sha: string; ref: string };
  };
  const token = core.getInput("github-token", { required: true });
  if (!token) {
    core.setFailed("github-token input is required");
    return;
  }
  const commentMode = parseCommentMode(core.getInput("comment-mode"));
  const requireSeparatePr = parseBooleanInput("require-separate-pr", true);
  const failOnMixedPr = parseBooleanInput("fail-on-mixed-pr", false);
  let baselineCodeowners = parseCodeowners(core.getInput("baseline-codeowners"));
  const baselineFile = core.getInput("baseline-file") || DEFAULT_BASELINE_PATH;
  // base-ref and head-ref default to the PR's base/head refs when the
  // workflow does not pass them explicitly, so the action can be
  // reused across PRs without per-workflow configuration.
  const explicitHeadRef = core.getInput("head-ref");
  const explicitBaseRef = core.getInput("base-ref");
  const pullNumber = pullRequest.number;
  const headSha = pullRequest.head.sha;
  const baseSha = pullRequest.base.sha;
  const headRef = explicitHeadRef || pullRequest.head.sha;
  const baseRef = explicitBaseRef || pullRequest.base.sha;
  const octokit = github.getOctokit(token) as unknown as Octokit;
  if (baselineCodeowners.length === 0) {
    baselineCodeowners = await loadCodeownersFromRepo(octokit, context.repo.owner, context.repo.repo, baselineFile);
    if (baselineCodeowners.length === 0) {
      core.setFailed(
        `no baseline-codeowners configured; pass \`baseline-codeowners:\` to the action or add a CODEOWNERS entry for \`${baselineFile}\``,
      );
      return;
    }
    core.info(`resolved baseline-codeowners from CODEOWNERS: ${baselineCodeowners.join(", ")}`);
  }
  let gate: BaselineGateResult;
  try {
    gate = runBaselineGateFull({
      rootDir: process.cwd(),
      baselineFile,
      baseRef,
      headRef,
      hasImplementationChanges: false,
    });
  } catch (error) {
    core.setFailed(`baseline gate failed: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }
  const { baseline: changedBaseline, implementation: changedImplementation } = await changedFilesTouchBaseline(
    octokit, context.repo.owner, context.repo.repo, pullNumber, baselineFile,
  );
  let mixedPrTelemetry = "";
  if (requireSeparatePr && changedBaseline && changedImplementation) {
    // 0.4.1: surface the mixed-PR diagnostic as a sticky comment
    // even when the gate is not failing, so reviewers see the
    // governance change AND the mixed-PR warning on the PR
    // conversation. The previous version only logged a warning,
    // which disappeared from the PR view as soon as the workflow
    // finished. The "mixed" marker in the body lets downstream
    // automation (and humans) grep for the failure mode without
    // having to re-run the changed-files check.
    const filesResult = await octokit.paginate(octokit.rest.pulls.listFiles, {
      owner: context.repo.owner,
      repo: context.repo.repo,
      pull_number: pullNumber,
      per_page: 100,
    });
    const baselineFiles = filesResult
      .map((f: { filename: string }) => f.filename)
      .filter((name: string) => name === baselineFile || name.endsWith("/" + baselineFile));
    const implementationFiles = filesResult
      .map((f: { filename: string }) => f.filename)
      .filter((name: string) => !name.startsWith(".cellfence/") && !name.endsWith(".md") && name !== "PROGRESS.md");
    const truncatedBaseline = baselineFiles.slice(0, 10).map((name: string) => `\`${name}\``).join(", ");
    const truncatedImplementation = implementationFiles.slice(0, 10).map((name: string) => `\`${name}\``).join(", ");
    const moreBaseline = baselineFiles.length > 10 ? ` (+${baselineFiles.length - 10} more)` : "";
    const moreImplementation = implementationFiles.length > 10 ? ` (+${implementationFiles.length - 10} more)` : "";
    const message = `pull request mixes baseline and implementation changes; split into two PRs to keep governance changes reviewable`;
    mixedPrTelemetry = [
      "",
      `<!-- cellfence-baseline-gate:mixed-pr -->`,
      `> **Mixed-PR warning**: this pull request changes both the baseline (${baselineFiles.length} file${baselineFiles.length === 1 ? "" : "s"}: ${truncatedBaseline}${moreBaseline}) and the implementation (${implementationFiles.length} file${implementationFiles.length === 1 ? "" : "s"}: ${truncatedImplementation}${moreImplementation}). Consider splitting into two PRs so the governance change can be reviewed in isolation.`,
      "",
      `> ${message}`,
    ].join("\n");
    await upsertStickyComment(
      octokit, context.repo.owner, context.repo.repo, pullNumber,
      formatGateComment({
        headSha, baseSha,
        report: gate.report,
        approved: false,
        codeowners: baselineCodeowners,
      }) + mixedPrTelemetry,
      commentMode,
    );
    if (failOnMixedPr) {
      core.setFailed(message);
      return;
    }
    core.warning(message);
  }
  if (!gate.report.hasChange) {
    core.info("no governance change detected; nothing to gate");
    await upsertStickyComment(
      octokit, context.repo.owner, context.repo.repo, pullNumber,
      formatResolvedComment(headSha),
      commentMode,
    );
    await removeLabelIfPresent(octokit, context.repo.owner, context.repo.repo, pullNumber, GOVERNANCE_LABEL);
    return;
  }
  await ensureLabel(octokit, context.repo.owner, context.repo.repo, GOVERNANCE_LABEL);
  try {
    await octokit.rest.issues.addLabels({
      owner: context.repo.owner,
      repo: context.repo.repo,
      issue_number: pullNumber,
      labels: [GOVERNANCE_LABEL],
    });
  } catch (error) {
    core.warning(`failed to add ${GOVERNANCE_LABEL} label: ${error instanceof Error ? error.message : String(error)}`);
  }
  const approved = await approveFromCodeowner(octokit, context.repo.owner, context.repo.repo, pullNumber, baselineCodeowners, headSha);
  await upsertStickyComment(
    octokit, context.repo.owner, context.repo.repo, pullNumber,
    formatGateComment({
      headSha, baseSha,
      report: gate.report,
      approved,
      codeowners: baselineCodeowners,
    }) + mixedPrTelemetry,
    commentMode,
  );
  if (!approved) {
    core.setFailed(
      `governance change detected; ${GOVERNANCE_LABEL} label applied and merge blocked until a baseline codeowner (${baselineCodeowners.join(", ") || "configured CODEOWNERS entry under .cellfence/baselines/"}) approves`,
    );
    return;
  }
  core.info("governance change approved by a baseline codeowner");
}

runAction().catch((error) => {
  core.setFailed(error instanceof Error ? error.message : String(error));
});

// 0.4.1: surface the action.yml / source input contract as a
// module-level constant so the test suite can assert the two
// stay in sync. The constant is intentionally a list of input
// names; action.yml must declare every name and use the same
// defaults. Mismatches trip the action-contract test in
// `tests/github-action.test.mjs`.
const ACTION_METADATA_INPUT_NAMES = [
  "comment-mode",
  "fail-on-mixed-pr",
  "github-token",
  "require-separate-pr",
  "baseline-codeowners",
  "baseline-file",
  "cellfence-version",
  "base-ref",
  "head-ref",
] as const;
void ACTION_METADATA_INPUT_NAMES;

export const ACTION_INPUT_NAMES = [
  "comment-mode",
  "fail-on-mixed-pr",
  "github-token",
  "require-separate-pr",
  "baseline-codeowners",
  "baseline-file",
  "cellfence-version",
  "base-ref",
  "head-ref",
] as const;
