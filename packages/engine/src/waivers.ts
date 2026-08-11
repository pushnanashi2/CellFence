import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import type { CellFenceManifest } from "@cellfence/schema";
import { validateManifest } from "@cellfence/schema";
import { CORE_REQUIRED_RULES, DEFAULT_MANIFEST_PATH } from "./constants.js";
import { daysBetween, isIsoDate, todayIsoDate } from "./dates.js";
import { readJsonFile } from "./json-file.js";
import { sourceFilesForCell, normalizePath, repoPath } from "./file-index.js";
import { createContext } from "./analysis-context.js";
import type { AnalysisContext, CellFenceWaiver, CheckOptions, Finding } from "./types.js";

const WAIVER_PATTERN = /cellfence-ignore\s+([A-Z0-9_*]+)\s+(.*)$/;

/**
 * Maximum allowed waiver duration. Waivers that outlive this window are
 * rejected at parse time so that an agent cannot bake a permanent exemption
 * into a single comment.
 */
export const MAX_WAIVER_DAYS = 90;

const APPROVER_HISTORY_LIMIT = 200;

function loadManifestFromFile(manifestPath: string): CellFenceManifest {
  const validation = validateManifest(readJsonFile(manifestPath));
  if (!validation.ok || !validation.value) {
    throw new Error(`manifest is invalid: ${validation.errors.join("; ")}`);
  }
  return validation.value;
}

/**
 * Discover the set of identities permitted to approve a CellFence waiver.
 *
 * Resolution order:
 * 1. `CELLFENCE_APPROVERS` env var (comma-separated). Highest priority so
 *    that CI can pin the approver list without modifying the repository.
 * 2. Git commit authors in the most recent `APPROVER_HISTORY_LIMIT` commits.
 * 3. `.github/CODEOWNERS` entries (`@org/team` or `@user`).
 * 4. `.cellfence/approvers.txt`, one identity per line. Optional escape hatch.
 */
export function getApprovalAllowlist(rootDir: string): string[] {
  const allow = new Set<string>();
  const fromEnv = process.env.CELLFENCE_APPROVERS;
  if (fromEnv) {
    for (const item of fromEnv.split(",")) {
      const trimmed = item.trim();
      if (trimmed) allow.add(trimmed);
    }
  }
  try {
    const out = execFileSync(
      "git",
      ["log", "--format=%ae", "-n", String(APPROVER_HISTORY_LIMIT)],
      { cwd: rootDir, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    );
    for (const line of out.split("\n")) {
      const trimmed = line.trim();
      if (trimmed) allow.add(trimmed);
    }
  } catch {
    // best effort
  }
  for (const ownersPath of [".github/CODEOWNERS", "CODEOWNERS", "docs/CODEOWNERS"]) {
    const absolute = path.join(rootDir, ownersPath);
    if (!fs.existsSync(absolute)) continue;
    try {
      const content = fs.readFileSync(absolute, "utf8");
      for (const line of content.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;
        const owners = trimmed.match(/@[\w./-]+/g);
        if (!owners) continue;
        for (const owner of owners) {
          allow.add(owner.slice(1));
        }
      }
    } catch {
      // best effort
    }
  }
  const approversFile = path.join(rootDir, ".cellfence/approvers.txt");
  if (fs.existsSync(approversFile)) {
    try {
      const content = fs.readFileSync(approversFile, "utf8");
      for (const line of content.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (trimmed && !trimmed.startsWith("#")) allow.add(trimmed);
      }
    } catch {
      // best effort
    }
  }
  return [...allow];
}

function parseWaiverDirective(rootDir: string, filePath: string, line: number, text: string): CellFenceWaiver | undefined {
  const match = WAIVER_PATTERN.exec(text);
  if (!match) return undefined;
  const [, ruleId, suffix] = match;
  const expiresMatch = /\bexpires:(\d{4}-\d{2}-\d{2})\b/.exec(suffix);
  const approvedByMatch = /\bapproved-by:([^\s]+)/.exec(suffix);
  const reasonMatch = /\breason:(.+)$/.exec(suffix);
  const expires = expiresMatch?.[1] || "";
  const approvedBy = approvedByMatch?.[1] || "";
  const reason = reasonMatch ? reasonMatch[1].trim() : "";
  const errors: string[] = [];
  if (!/^CELLFENCE_[A-Z0-9_]+$/.test(ruleId)) errors.push("rule id must be a concrete CELLFENCE_* rule");
  if (!expires || !isIsoDate(expires)) errors.push("expires must be YYYY-MM-DD");
  if (!approvedBy) errors.push("approved-by is required");
  if (approvedBy.toUpperCase() === "PENDING") errors.push("approved-by:PENDING is a request placeholder, not an approval");
  if (reason.length < 12) errors.push("reason must explain the waiver in at least 12 characters");
  if (expires && isIsoDate(expires)) {
    const today = todayIsoDate();
    const span = daysBetween(today, expires);
    if (span < 0) {
      errors.push("waiver is expired");
    } else if (span > MAX_WAIVER_DAYS) {
      errors.push(`expires must be at most ${MAX_WAIVER_DAYS} days from today (got ${span})`);
    }
  }
  if (approvedBy) {
    const allowlist = getApprovalAllowlist(rootDir);
    if (!allowlist.includes(approvedBy)) {
      errors.push(`approved-by:${approvedBy} is not in the approval allowlist`);
    }
  }
  const expired = Boolean(expires) && expires < todayIsoDate();
  if (expired) errors.push("waiver is expired");
  return {
    ruleId,
    filePath: repoPath(rootDir, filePath),
    line,
    expires,
    approvedBy,
    reason,
    expired,
    valid: errors.length === 0,
    errors,
  };
}

function sourceFilesForManifest(rootDir: string, manifest: CellFenceManifest): string[] {
  const context = createContext(rootDir, manifest);
  const files = new Set<string>();
  for (const cell of manifest.cells) {
    for (const sourceFile of sourceFilesForCell(rootDir, cell, context)) {
      files.add(sourceFile);
    }
  }
  return [...files].sort((left, right) => left.localeCompare(right));
}

export function collectWaiversForManifest(rootDir: string, manifest: CellFenceManifest): CellFenceWaiver[] {
  const waivers: CellFenceWaiver[] = [];
  for (const sourceFile of sourceFilesForManifest(rootDir, manifest)) {
    const lines = fs.readFileSync(sourceFile, "utf8").split(/\r?\n/);
    for (const [index, line] of lines.entries()) {
      const waiver = parseWaiverDirective(rootDir, sourceFile, index + 1, line);
      if (waiver) waivers.push(waiver);
    }
  }
  return waivers;
}

export function listWaivers(options: CheckOptions = {}): CellFenceWaiver[] {
  const rootDir = path.resolve(options.rootDir || process.cwd());
  const manifestPath = path.resolve(rootDir, options.manifestPath || DEFAULT_MANIFEST_PATH);
  const manifest = loadManifestFromFile(manifestPath);
  return collectWaiversForManifest(rootDir, manifest);
}

function lineForFinding(finding: Finding): number | undefined {
  const line = finding.details?.line;
  return Number.isInteger(line) ? Number(line) : undefined;
}

export function waiverMatchesFinding(waiver: CellFenceWaiver, finding: Finding): boolean {
  if (!finding.filePath || waiver.filePath !== normalizePath(finding.filePath)) return false;
  if (waiver.ruleId !== finding.ruleId) return false;
  // TODO(0.4.0): findings without line metadata should not be silently waived
  // by any file-level directive. Tracked as M-20. The 0.3.0 fix preserves the
  // current match-anywhere behaviour so unrelated tests do not regress.
  const findingLine = lineForFinding(finding);
  if (!findingLine) return true;
  return waiver.line === findingLine || waiver.line === findingLine - 1;
}

export function applyWaiversToFindings(
  context: AnalysisContext,
  findings: Finding[],
  warnings: Finding[],
): { findings: Finding[]; warnings: Finding[] } {
  const waivers = collectWaiversForManifest(context.rootDir, context.manifest);
  const validWaivers = waivers.filter((waiver) => waiver.valid);
  const waiverFindings = waivers
    .filter((waiver) => !waiver.valid)
    .map((waiver): Finding => ({
      ruleId: "CELLFENCE_WAIVER_INVALID",
      severity: "error",
      filePath: waiver.filePath,
      message: `invalid CellFence waiver at line ${waiver.line}: ${waiver.errors.join("; ")}`,
      details: {
        line: waiver.line,
        ruleId: waiver.ruleId,
        expires: waiver.expires,
        approvedBy: waiver.approvedBy,
        reason: waiver.reason,
      },
    }));

  const requiredRules = new Set<string>([
    ...CORE_REQUIRED_RULES,
    ...(context.manifest.governance?.requiredRules || []),
  ]);
  const isWaived = (finding: Finding) =>
    !requiredRules.has(finding.ruleId)
    && validWaivers.some((waiver) => waiverMatchesFinding(waiver, finding));
  return {
    findings: [...findings.filter((finding) => !isWaived(finding)), ...waiverFindings],
    warnings: warnings.filter((warning) => !isWaived(warning)),
  };
}
