import crypto from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { stableDigest } from "./governance/canonicalization.js";
import type { CheckResult } from "./types.js";

const CACHE_SCHEMA_VERSION = "cellfence.changed-base-cache.v1";
let implementationDigest: string | undefined;

type ChangedBaseCacheEntry = {
  schemaVersion: typeof CACHE_SCHEMA_VERSION;
  key: string;
  result: CheckResult;
};

function implementationFiles(directory: string, relativeDirectory = ""): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const relativePath = path.posix.join(relativeDirectory, entry.name);
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...implementationFiles(absolutePath, relativePath));
    else if (entry.isFile() && entry.name.endsWith(".js")) files.push(relativePath);
  }
  return files.sort();
}

function modulePathFromStack(): string | undefined {
  const stack = new Error().stack || "";
  for (const line of stack.split("\n")) {
    const fileUrlMatch = line.match(/\bfile:\/\/[^:)]+(?=:\d+:\d+)/);
    if (fileUrlMatch) return fileURLToPath(fileUrlMatch[0]);
    const pathMatch = line.match(/\((\/[^:)]+):\d+:\d+\)|\bat (\/[^:)]+):\d+:\d+/);
    const absolutePath = pathMatch?.[1] || pathMatch?.[2];
    if (absolutePath) return absolutePath;
  }
  return undefined;
}

export function changedCheckImplementationDigest(): string {
  if (implementationDigest) return implementationDigest;
  const implementationPath = modulePathFromStack();
  const implementationDirectory = implementationPath ? path.dirname(implementationPath) : process.cwd();
  const require = createRequire(implementationPath ? pathToFileURL(implementationPath) : path.join(process.cwd(), "package.json"));
  const hash = crypto.createHash("sha256");
  for (const relativePath of implementationFiles(implementationDirectory)) {
    hash.update(relativePath);
    hash.update("\0");
    hash.update(fs.readFileSync(path.join(implementationDirectory, relativePath)));
    hash.update("\0");
  }
  const schemaImplementationPath = require.resolve("@cellfence/schema");
  hash.update("@cellfence/schema\0");
  hash.update(fs.readFileSync(schemaImplementationPath));
  hash.update("\0");
  implementationDigest = hash.digest("hex");
  return implementationDigest;
}

export function changedBaseCacheKey(input: Record<string, unknown>): string {
  return stableDigest({
    schemaVersion: CACHE_SCHEMA_VERSION,
    implementationDigest: changedCheckImplementationDigest(),
    ...input,
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCheckResult(value: unknown): value is CheckResult {
  if (!isRecord(value)) return false;
  return typeof value.ok === "boolean"
    && (value.exitCode === 0 || value.exitCode === 1 || value.exitCode === 2 || value.exitCode === 3)
    && Array.isArray(value.findings)
    && Array.isArray(value.warnings)
    && isRecord(value.metrics);
}

function isReusableCleanResult(value: unknown): value is CheckResult {
  return isCheckResult(value)
    && value.ok === true
    && value.exitCode === 0
    && value.findings.length === 0;
}

function cacheFilePath(cacheDirectory: string, key: string): string {
  return path.join(cacheDirectory, `${key}.json`);
}

export function readChangedBaseCache(cacheDirectory: string, key: string): CheckResult | undefined {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(cacheFilePath(cacheDirectory, key), "utf8"));
    if (!isRecord(parsed)
      || parsed.schemaVersion !== CACHE_SCHEMA_VERSION
      || parsed.key !== key
      || !isReusableCleanResult(parsed.result)) return undefined;
    return parsed.result;
  } catch {
    return undefined;
  }
}

export function writeChangedBaseCache(cacheDirectory: string, key: string, result: CheckResult): boolean {
  if (!isReusableCleanResult(result)) return false;
  let temporaryPath: string | undefined;
  try {
    fs.mkdirSync(cacheDirectory, { recursive: true });
    const filePath = cacheFilePath(cacheDirectory, key);
    temporaryPath = `${filePath}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`;
    const entry: ChangedBaseCacheEntry = { schemaVersion: CACHE_SCHEMA_VERSION, key, result };
    fs.writeFileSync(temporaryPath, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
    fs.renameSync(temporaryPath, filePath);
    temporaryPath = undefined;
    return true;
  } catch {
    return false;
  } finally {
    if (temporaryPath) fs.rmSync(temporaryPath, { force: true });
  }
}
