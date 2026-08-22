import * as core from "@actions/core";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Octokit = any;

export function parseCodeowners(input: string | undefined): string[] {
  if (!input) return [];
  const codeowners = input.split(",").map((entry) => entry.trim()).filter(Boolean);
  validateUsernameCodeowners(codeowners);
  return codeowners;
}

export function validateUsernameCodeowners(codeowners: string[]): void {
  const teamEntries = codeowners.filter((entry) => /^@?[^/\s]+\/[^/\s]+$/.test(entry));
  if (teamEntries.length === 0) return;
  throw new Error(
    `baseline-codeowners currently supports GitHub usernames only; team entries are not resolved: ${teamEntries.join(", ")}`,
  );
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function stripCodeownersComment(line: string): string {
  if (/^\s*#/.test(line)) return "";
  return line.replace(/\s+#.*$/, "").trim();
}

function codeownersGlobToRegex(pattern: string): RegExp | undefined {
  let normalized = pattern.trim().replace(/\\/g, "/");
  if (!normalized || normalized.startsWith("!")) return undefined;
  const anchored = normalized.startsWith("/");
  normalized = normalized.replace(/^\/+/, "");
  if (!normalized) return undefined;
  if (normalized.endsWith("/")) normalized = `${normalized}**`;
  const hasSlash = normalized.includes("/");
  const exactLiteral = !/[?*]/.test(normalized);
  if (exactLiteral) {
    const literal = escapeRegExp(normalized.replace(/\/+$/, ""));
    const prefix = anchored || hasSlash ? "^" : "^(?:.*/)?";
    const suffix = pattern.endsWith("/") ? "(?:/.*)?$" : "$";
    return new RegExp(`${prefix}${literal}${suffix}`);
  }
  let body = "";
  for (let index = 0; index < normalized.length; index += 1) {
    const char = normalized[index];
    if (char === "*" && normalized[index + 1] === "*") {
      body += ".*";
      index += 1;
    } else if (char === "*") {
      body += "[^/]*";
    } else if (char === "?") {
      body += "[^/]";
    } else {
      body += escapeRegExp(char);
    }
  }
  const prefix = anchored || hasSlash ? "^" : "^(?:.*/)?";
  return new RegExp(`${prefix}${body}$`);
}

export function codeownersForPath(codeownersText: string, targetPath: string): string[] {
  const target = targetPath.replace(/^\.\//, "").replace(/\\/g, "/");
  const candidates: { pattern: string; owners: string[] }[] = [];
  for (const rawLine of codeownersText.split(/\r?\n/)) {
    const line = stripCodeownersComment(rawLine);
    if (!line) continue;
    const [pattern, ...owners] = line.split(/\s+/);
    if (!pattern || owners.length === 0) continue;
    candidates.push({ pattern, owners });
  }
  const matches = candidates.filter(({ pattern }) => {
    const regex = codeownersGlobToRegex(pattern);
    return Boolean(regex?.test(target));
  });
  if (matches.length === 0) return [];
  return matches[matches.length - 1].owners;
}

export async function loadCodeownersFromRepo(
  octokit: Octokit,
  owner: string,
  repo: string,
  baselineFile: string,
  ref: string,
): Promise<string[]> {
  for (const codeownersPath of [".github/CODEOWNERS", "CODEOWNERS", "docs/CODEOWNERS"]) {
    let text: string;
    try {
      const response = await octokit.rest.repos.getContent({ owner, repo, path: codeownersPath, ref });
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
    validateUsernameCodeowners(owners);
    return owners;
  }
  return [];
}

function normalizeRepoPathForAction(filePath: string): string {
  return filePath.replace(/\\/g, "/").replace(/^\.\//, "");
}

export function changedFileIsBaseline(name: string, baselineFile: string): boolean {
  return normalizeRepoPathForAction(name) === normalizeRepoPathForAction(baselineFile);
}

export function changedFileIsImplementation(name: string, baselineFile: string): boolean {
  const normalized = normalizeRepoPathForAction(name);
  if (changedFileIsBaseline(normalized, baselineFile)) return false;
  if (normalized.startsWith(".cellfence/")) return false;
  if (normalized.endsWith(".md") || normalized === "PROGRESS.md") return false;
  return /\.(?:c|cc|cpp|cs|cts|cxx|go|java|js|jsx|kt|kts|mjs|mts|php|py|rb|rs|scala|sh|swift|ts|tsx)$/i.test(normalized);
}
