// 0.4.0: real implementation of cellfence-baseline-gate. The
// prototype emitted a warning and exited; this version downloads
// the PR's baseline files via the GitHub API, calls into
// `runBaselineGateFull`, applies the `governance-change` label,
// and fails the check if the PR's approvals do not include a
// baseline-codeowner. The sticky comment and the mixed-PR
// detection are queued for 0.4.1.

import * as core from "@actions/core";
import * as github from "@actions/github";

import {
  runBaselineGateFull,
  type BaselineGateResult,
} from "@cellfence/cli";

const GOVERNANCE_LABEL = "governance-change";

async function ensureLabel(octokit: ReturnType<typeof github.getOctokit>, owner: string, repo: string, label: string): Promise<void> {
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
  octokit: ReturnType<typeof github.getOctokit>,
  owner: string,
  repo: string,
  pullNumber: number,
  codeowners: string[],
): Promise<boolean> {
  if (codeowners.length === 0) return true;
  const reviews = await octokit.paginate(octokit.rest.pulls.listReviews, {
    owner,
    repo,
    pull_number: pullNumber,
    per_page: 100,
  });
  for (const review of reviews) {
    if (review.state !== "APPROVED") continue;
    if (userMatchesAllowlist(review.user, codeowners)) return true;
  }
  return false;
}

function parseCodeowners(input: string | undefined): string[] {
  if (!input) return [];
  return input.split(",").map((entry) => entry.trim()).filter(Boolean);
}

export async function runAction(): Promise<void> {
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    core.setFailed("GITHUB_TOKEN is required");
    return;
  }
  const baselineCodeowners = parseCodeowners(core.getInput("baseline-codeowners"));
  const baselineFile = core.getInput("baseline-file") || ".cellfence/baselines/cellfence.baseline.json";
  const baseRef = core.getInput("base-ref") || "main";
  const headRef = core.getInput("head-ref");
  if (!headRef) {
    core.setFailed("head-ref input is required");
    return;
  }
  const context = github.context;
  if (!context.payload.pull_request) {
    core.warning("cellfence-baseline-gate only runs on pull_request events; skipping");
    return;
  }
  const pullNumber = context.payload.pull_request.number;
  const octokit = github.getOctokit(token);
  let gate: BaselineGateResult;
  try {
    gate = runBaselineGateFull({
      rootDir: process.cwd(),
      baselineFile,
      baseRef,
      headRef,
      format: "json",
    });
  } catch (error) {
    core.setFailed(`baseline gate failed: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }
  if (!gate.report.hasChange) {
    core.info("no governance change detected; nothing to gate");
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
  const approved = await approveFromCodeowner(octokit, context.repo.owner, context.repo.repo, pullNumber, baselineCodeowners);
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
