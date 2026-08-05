#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

import { stableDigest } from "../packages/engine/dist/governance/canonicalization.js";

export const INPUT_SCHEMA_VERSION = "cellfence.adversarial-evidence.v1";
export const REPORT_SCHEMA_VERSION = "cellfence.adversarial-evidence-report.v1";

const verifierVersion = "cellfence.adversarial-evidence-verifier.v1";
const sha256Pattern = "^[a-f0-9]{64}$";
const sha256Regex = /^[a-f0-9]{64}$/;
const categoryRegex = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const attemptIdRegex = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const classifications = ["reproduced_bypass", "blocked", "invalid_setup", "tool_error"];
const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const defaultCliPath = path.resolve(scriptDirectory, "../packages/cli/dist/index.js");

export const ADVERSARIAL_EVIDENCE_INPUT_SCHEMA = Object.freeze({
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://cellfence.dev/schemas/adversarial-evidence.v1.json",
  title: "CellFence adversarial self-play evidence",
  type: "object",
  additionalProperties: false,
  required: ["schemaVersion", "attempts"],
  properties: {
    schemaVersion: { const: INPUT_SCHEMA_VERSION },
    attempts: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "id",
          "fixtureRoot",
          "fixtureTreeSha256",
          "manifest",
          "expectedViolation",
          "commandEvidence",
          "claimedBypass",
        ],
        properties: {
          id: { type: "string", pattern: attemptIdRegex.source },
          fixtureRoot: { type: "string", description: "POSIX path relative to --fixtures-root" },
          fixtureTreeSha256: { type: "string", pattern: sha256Pattern },
          manifest: {
            type: "object",
            additionalProperties: false,
            required: ["path", "sha256"],
            properties: {
              path: { type: "string", description: "POSIX path relative to fixtureRoot" },
              sha256: { type: "string", pattern: sha256Pattern },
            },
          },
          expectedViolation: {
            type: "object",
            additionalProperties: false,
            required: ["category", "description", "witness"],
            properties: {
              category: { type: "string", pattern: categoryRegex.source },
              description: { type: "string", minLength: 1 },
              witness: {
                type: "object",
                additionalProperties: false,
                required: ["path", "sha256", "startLine", "endLine", "excerpt"],
                properties: {
                  path: { type: "string", description: "POSIX path relative to fixtureRoot" },
                  sha256: { type: "string", pattern: sha256Pattern },
                  startLine: { type: "integer", minimum: 1 },
                  endLine: { type: "integer", minimum: 1 },
                  excerpt: { type: "string", minLength: 1 },
                },
              },
            },
          },
          commandEvidence: {
            type: "object",
            additionalProperties: false,
            required: ["cwd", "argv", "exitCode", "stdoutPath", "stdoutSha256"],
            properties: {
              cwd: { const: "." },
              argv: {
                type: "array",
                description: "Canonical historical command; validated but never executed",
                items: { type: "string" },
              },
              exitCode: { const: 0 },
              stdoutPath: { type: "string", description: "POSIX path relative to fixtureRoot" },
              stdoutSha256: { type: "string", pattern: sha256Pattern },
            },
          },
          claimedBypass: {
            type: "object",
            additionalProperties: false,
            required: ["kind", "summary"],
            properties: {
              kind: { const: "accepted-human-obvious-violation" },
              summary: { type: "string", minLength: 1 },
            },
          },
        },
      },
    },
  },
});

export class AdversarialEvidenceInputError extends Error {
  constructor(message) {
    super(message);
    this.name = "AdversarialEvidenceInputError";
  }
}

class AttemptSetupError extends Error {
  constructor(message) {
    super(message);
    this.name = "AttemptSetupError";
  }
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

export function canonicalSha256(value) {
  return stableDigest(value);
}

export function fileSha256(filePath) {
  return sha256(fs.readFileSync(filePath));
}

function posixRelativePath(value, label, { allowDot = false } = {}) {
  if (typeof value !== "string" || value.length === 0) {
    throw new AttemptSetupError(`${label} must be a non-empty relative POSIX path`);
  }
  if (value.includes("\0") || value.includes("\\") || path.posix.isAbsolute(value)
    || /^[A-Za-z]:/.test(value) || value.startsWith("//")) {
    throw new AttemptSetupError(`${label} must be a relative POSIX path`);
  }
  if (allowDot && value === ".") return value;
  const segments = value.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")
    || path.posix.normalize(value) !== value) {
    throw new AttemptSetupError(`${label} must not contain empty, dot, or parent segments`);
  }
  return value;
}

function pathFromPosix(base, relativePath) {
  if (relativePath === ".") return base;
  return path.join(base, ...relativePath.split("/"));
}

function isWithin(base, candidate, allowEqual = true) {
  const relative = path.relative(base, candidate);
  if (relative === "") return allowEqual;
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function realpathOrSetupError(filePath, label) {
  try {
    return fs.realpathSync.native(filePath);
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? error.code : "unreadable";
    throw new AttemptSetupError(`${label} does not resolve to a readable path (${code})`);
  }
}

function lstatOrSetupError(filePath, label) {
  try {
    return fs.lstatSync(filePath);
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? error.code : "unreadable";
    throw new AttemptSetupError(`${label} is not readable (${code})`);
  }
}

function assertNoSymlinkSegments(base, relativePath, label) {
  if (relativePath === ".") return;
  let current = base;
  for (const segment of relativePath.split("/")) {
    current = path.join(current, segment);
    if (lstatOrSetupError(current, label).isSymbolicLink()) {
      throw new AttemptSetupError(`${label} must not traverse a symbolic link`);
    }
  }
}

function resolveInside(base, baseReal, relativePath, label, expectedType) {
  assertNoSymlinkSegments(base, relativePath, label);
  const candidate = pathFromPosix(base, relativePath);
  const candidateReal = realpathOrSetupError(candidate, label);
  if (!isWithin(baseReal, candidateReal)) {
    throw new AttemptSetupError(`${label} resolves outside the supplied fixtures root`);
  }
  const stats = lstatOrSetupError(candidate, label);
  if (expectedType === "directory" && !stats.isDirectory()) {
    throw new AttemptSetupError(`${label} must resolve to a directory`);
  }
  if (expectedType === "file" && !stats.isFile()) {
    throw new AttemptSetupError(`${label} must resolve to a regular file`);
  }
  return candidateReal;
}

function fixtureFileRecords(rootDir) {
  const records = [];
  function visit(directory, prefix) {
    let entries;
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true })
        .sort((left, right) => left.name.localeCompare(right.name));
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error ? error.code : "unreadable";
      throw new AttemptSetupError(`fixture tree is not readable (${code})`);
    }
    for (const entry of entries) {
      const entryPath = path.join(directory, entry.name);
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      const stats = lstatOrSetupError(entryPath, `fixture entry ${relativePath}`);
      if (stats.isSymbolicLink()) {
        throw new AttemptSetupError(`fixture tree contains a symbolic link: ${relativePath}`);
      }
      if (stats.isDirectory()) {
        visit(entryPath, relativePath);
      } else if (stats.isFile()) {
        records.push({ path: relativePath, sha256: fileSha256(entryPath), size: stats.size });
      } else {
        throw new AttemptSetupError(`fixture tree contains a non-regular entry: ${relativePath}`);
      }
    }
  }
  visit(rootDir, "");
  return records;
}

export function fixtureTreeSha256(rootDir) {
  const stats = lstatOrSetupError(rootDir, "fixture root");
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new AttemptSetupError("fixture root must be a real directory, not a symbolic link");
  }
  return canonicalSha256({ files: fixtureFileRecords(rootDir) });
}

function assertOnlyKeys(record, keys, label) {
  const allowed = new Set(keys);
  const unexpected = Object.keys(record).filter((key) => !allowed.has(key)).sort();
  if (unexpected.length > 0) {
    throw new AttemptSetupError(`${label} has unexpected field(s): ${unexpected.join(", ")}`);
  }
}

function requiredRecord(value, label, keys) {
  if (!isRecord(value)) throw new AttemptSetupError(`${label} must be an object`);
  assertOnlyKeys(value, keys, label);
  return value;
}

function requiredText(value, label) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new AttemptSetupError(`${label} must be a non-empty string`);
  }
  return value;
}

function requiredSha(value, label) {
  if (typeof value !== "string" || !sha256Regex.test(value)) {
    throw new AttemptSetupError(`${label} must be a lowercase SHA-256 digest`);
  }
  return value;
}

function expectedHistoricalArgv(manifestPath) {
  return ["cellfence", "check", "--root", ".", "--manifest", manifestPath, "--json"];
}

function validateCommandEvidence(value, manifestPath, fixtureDir, fixtureReal) {
  const evidence = requiredRecord(value, "commandEvidence", ["cwd", "argv", "exitCode", "stdoutPath", "stdoutSha256"]);
  if (evidence.cwd !== ".") throw new AttemptSetupError("commandEvidence.cwd must be .");
  const expectedArgv = expectedHistoricalArgv(manifestPath);
  if (!Array.isArray(evidence.argv) || evidence.argv.length !== expectedArgv.length
    || evidence.argv.some((argument, index) => argument !== expectedArgv[index])) {
    throw new AttemptSetupError(`commandEvidence.argv must equal ${JSON.stringify(expectedArgv)}`);
  }
  if (evidence.exitCode !== 0) {
    throw new AttemptSetupError("commandEvidence.exitCode must be 0 for a claimed bypass");
  }
  const stdoutPath = posixRelativePath(evidence.stdoutPath, "commandEvidence.stdoutPath");
  const stdoutSha256 = requiredSha(evidence.stdoutSha256, "commandEvidence.stdoutSha256");
  const resolvedStdout = resolveInside(fixtureDir, fixtureReal, stdoutPath, "commandEvidence.stdoutPath", "file");
  if (fileSha256(resolvedStdout) !== stdoutSha256) {
    throw new AttemptSetupError("commandEvidence.stdoutSha256 does not match commandEvidence.stdoutPath");
  }
  return {
    cwd: evidence.cwd,
    argv: [...evidence.argv],
    exitCode: evidence.exitCode,
    stdoutPath,
    stdoutSha256,
  };
}

function validateClaim(value) {
  const claim = requiredRecord(value, "claimedBypass", ["kind", "summary"]);
  if (claim.kind !== "accepted-human-obvious-violation") {
    throw new AttemptSetupError("claimedBypass.kind must be accepted-human-obvious-violation");
  }
  return { kind: claim.kind, summary: requiredText(claim.summary, "claimedBypass.summary") };
}

function validateWitness(value, fixtureDir, fixtureReal) {
  const witness = requiredRecord(value, "expectedViolation.witness", ["path", "sha256", "startLine", "endLine", "excerpt"]);
  const witnessPath = posixRelativePath(witness.path, "expectedViolation.witness.path");
  const witnessSha = requiredSha(witness.sha256, "expectedViolation.witness.sha256");
  if (!Number.isInteger(witness.startLine) || witness.startLine < 1
    || !Number.isInteger(witness.endLine) || witness.endLine < witness.startLine) {
    throw new AttemptSetupError("expectedViolation witness lines must be positive and endLine must be >= startLine");
  }
  const excerpt = requiredText(witness.excerpt, "expectedViolation.witness.excerpt");
  const resolved = resolveInside(fixtureDir, fixtureReal, witnessPath, "expectedViolation.witness.path", "file");
  if (fileSha256(resolved) !== witnessSha) {
    throw new AttemptSetupError("expectedViolation.witness.sha256 does not match the witness file");
  }
  let contents;
  try {
    contents = fs.readFileSync(resolved, "utf8");
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? error.code : "unreadable";
    throw new AttemptSetupError(`expected violation witness is not readable (${code})`);
  }
  const lines = contents.split(/\r?\n/);
  if (witness.endLine > lines.length) {
    throw new AttemptSetupError("expectedViolation.witness line range is outside the witness file");
  }
  const selected = lines.slice(witness.startLine - 1, witness.endLine).join("\n");
  if (!selected.includes(excerpt)) {
    throw new AttemptSetupError("expectedViolation.witness.excerpt is not present in the declared line range");
  }
  return {
    path: witnessPath,
    sha256: witnessSha,
    startLine: witness.startLine,
    endLine: witness.endLine,
    excerpt,
  };
}

function validateAttempt(attempt, sourceIndex, context) {
  const value = requiredRecord(attempt, `attempts[${sourceIndex}]`, [
    "id",
    "fixtureRoot",
    "fixtureTreeSha256",
    "manifest",
    "expectedViolation",
    "commandEvidence",
    "claimedBypass",
  ]);
  if (typeof value.id !== "string" || !attemptIdRegex.test(value.id)) {
    throw new AttemptSetupError(`attempts[${sourceIndex}].id must be a stable ID using letters, digits, dot, underscore, or hyphen`);
  }
  if (context.duplicateIds.has(value.id)) {
    throw new AttemptSetupError(`attempt id is duplicated: ${value.id}`);
  }
  const fixtureRoot = posixRelativePath(value.fixtureRoot, "fixtureRoot", { allowDot: true });
  const pinnedTreeSha = requiredSha(value.fixtureTreeSha256, "fixtureTreeSha256");
  const fixtureDir = resolveInside(context.fixturesRoot, context.fixturesReal, fixtureRoot, "fixtureRoot", "directory");
  const fixtureReal = realpathOrSetupError(fixtureDir, "fixtureRoot");
  const observedTreeSha = fixtureTreeSha256(fixtureDir);
  if (observedTreeSha !== pinnedTreeSha) {
    throw new AttemptSetupError("fixtureTreeSha256 does not match the complete fixture tree");
  }

  const manifest = requiredRecord(value.manifest, "manifest", ["path", "sha256"]);
  const manifestPath = posixRelativePath(manifest.path, "manifest.path");
  const manifestSha = requiredSha(manifest.sha256, "manifest.sha256");
  const manifestResolved = resolveInside(fixtureDir, fixtureReal, manifestPath, "manifest.path", "file");
  if (fileSha256(manifestResolved) !== manifestSha) {
    throw new AttemptSetupError("manifest.sha256 does not match the manifest file");
  }
  try {
    const parsedManifest = JSON.parse(fs.readFileSync(manifestResolved, "utf8"));
    if (!isRecord(parsedManifest)) throw new Error("manifest root is not an object");
  } catch {
    throw new AttemptSetupError("manifest.path must contain a JSON object");
  }

  const expectedViolation = requiredRecord(value.expectedViolation, "expectedViolation", ["category", "description", "witness"]);
  if (typeof expectedViolation.category !== "string" || !categoryRegex.test(expectedViolation.category)) {
    throw new AttemptSetupError("expectedViolation.category must be a lowercase kebab-case category");
  }
  const validatedViolation = {
    category: expectedViolation.category,
    description: requiredText(expectedViolation.description, "expectedViolation.description"),
    witness: validateWitness(expectedViolation.witness, fixtureDir, fixtureReal),
  };
  return {
    id: value.id,
    sourceIndex,
    fixtureDir,
    fixtureRoot,
    fixtureTreeSha256: observedTreeSha,
    manifest: { path: manifestPath, sha256: manifestSha },
    expectedViolation: validatedViolation,
    commandEvidence: validateCommandEvidence(value.commandEvidence, manifestPath, fixtureDir, fixtureReal),
    claimedBypass: validateClaim(value.claimedBypass),
  };
}

function sanitizedEnvironment() {
  const executableDirectories = [...new Set([
    path.dirname(process.execPath),
    ...(process.platform === "win32" ? [] : ["/usr/bin", "/bin"]),
  ])];
  return {
    PATH: executableDirectories.join(path.delimiter),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_LFS_SKIP_SMUDGE: "1",
    GIT_TERMINAL_PROMPT: "0",
    LANG: "C",
    LC_ALL: "C",
    NO_COLOR: "1",
    PYTHONNOUSERSITE: "1",
    TZ: "UTC",
  };
}

export function runLocalCellFence(invocation) {
  return spawnSync(invocation.command, invocation.args, {
    cwd: invocation.cwd,
    encoding: "utf8",
    env: invocation.env,
    maxBuffer: 16 * 1024 * 1024,
    shell: false,
    timeout: invocation.timeoutMs,
    windowsHide: true,
  });
}

function runnerExitCode(result) {
  if (Number.isInteger(result?.status)) return result.status;
  if (Number.isInteger(result?.exitCode)) return result.exitCode;
  return null;
}

function runnerTimedOut(result) {
  const code = result?.error && typeof result.error === "object" && "code" in result.error
    ? result.error.code
    : result?.errorCode;
  return result?.timedOut === true || code === "ETIMEDOUT";
}

function parseCellFenceOutput(result, exitCode) {
  const raw = Buffer.isBuffer(result?.stdout) ? result.stdout.toString("utf8") : result?.stdout;
  if (typeof raw !== "string" || raw.trim().length === 0) return { error: "missing_json_output" };
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { error: "malformed_json_output" };
  }
  if (!isRecord(parsed) || parsed.exitCode !== exitCode || parsed.ok !== (exitCode === 0)
    || !Array.isArray(parsed.findings) || !Array.isArray(parsed.warnings)) {
    return { error: "inconsistent_json_output" };
  }
  const ruleIds = (items) => [...new Set(items
    .map((item) => isRecord(item) && typeof item.ruleId === "string" ? item.ruleId : "")
    .filter(Boolean))].sort();
  return {
    ok: parsed.ok,
    findingRuleIds: ruleIds(parsed.findings),
    warningRuleIds: ruleIds(parsed.warnings),
  };
}

function rerunAttempt(attempt, context) {
  const invocation = {
    command: process.execPath,
    args: [
      context.cliPath,
      "check",
      "--root",
      attempt.fixtureDir,
      "--manifest",
      attempt.manifest.path,
      "--json",
    ],
    cwd: attempt.fixtureDir,
    env: sanitizedEnvironment(),
    timeoutMs: context.timeoutMs,
  };
  let result;
  try {
    result = context.runner(invocation);
  } catch {
    return { classification: "tool_error", rerun: { reason: "runner_threw", timeoutMs: context.timeoutMs } };
  }
  if (runnerTimedOut(result)) {
    return { classification: "tool_error", rerun: { reason: "timeout", timeoutMs: context.timeoutMs } };
  }
  const exitCode = runnerExitCode(result);
  if (result?.error || result?.signal || exitCode === null) {
    return { classification: "tool_error", rerun: { reason: "runner_failed", timeoutMs: context.timeoutMs } };
  }
  if (exitCode === 2) {
    return {
      classification: "invalid_setup",
      rerun: { reason: "cellfence_configuration_error", timeoutMs: context.timeoutMs, exitCode },
    };
  }
  if (exitCode === 3 || (exitCode !== 0 && exitCode !== 1)) {
    return {
      classification: "tool_error",
      rerun: { reason: "cellfence_tool_error", timeoutMs: context.timeoutMs, exitCode },
    };
  }
  const parsed = parseCellFenceOutput(result, exitCode);
  if (parsed.error) {
    return {
      classification: "tool_error",
      rerun: { reason: parsed.error, timeoutMs: context.timeoutMs, exitCode },
    };
  }
  return {
    classification: exitCode === 0 ? "reproduced_bypass" : "blocked",
    rerun: {
      reason: exitCode === 0 ? "cellfence_accepted_witnessed_violation" : "cellfence_reported_violation",
      timeoutMs: context.timeoutMs,
      exitCode,
      ok: parsed.ok,
      findingRuleIds: parsed.findingRuleIds,
      warningRuleIds: parsed.warningRuleIds,
    },
  };
}

function setupFailure(attempt, sourceIndex, error) {
  const id = isRecord(attempt) && typeof attempt.id === "string" && attemptIdRegex.test(attempt.id)
    ? attempt.id
    : `invalid-attempt-${String(sourceIndex + 1).padStart(4, "0")}`;
  return {
    id,
    sourceIndex,
    classification: "invalid_setup",
    setupErrors: [error instanceof Error ? error.message : "invalid attempt setup"],
    promotionCandidate: null,
  };
}

function verifiedAttemptReport(attempt, result) {
  const base = {
    id: attempt.id,
    sourceIndex: attempt.sourceIndex,
    classification: result.classification,
    fixture: {
      root: attempt.fixtureRoot,
      treeSha256: attempt.fixtureTreeSha256,
      manifest: attempt.manifest,
    },
    expectedViolation: attempt.expectedViolation,
    commandEvidence: attempt.commandEvidence,
    claimedBypass: attempt.claimedBypass,
    rerun: result.rerun,
  };
  return {
    ...base,
    promotionCandidate: result.classification === "reproduced_bypass" ? {
      schemaVersion: "cellfence.adversarial-promotion-candidate.v1",
      attemptId: attempt.id,
      fixture: base.fixture,
      expectedViolation: attempt.expectedViolation,
      claimedBypass: attempt.claimedBypass,
      automaticTestModification: false,
    } : null,
  };
}

function validateTopLevel(input) {
  if (!isRecord(input)) throw new AdversarialEvidenceInputError("input must be a JSON object");
  const unexpected = Object.keys(input).filter((key) => !new Set(["schemaVersion", "attempts"]).has(key)).sort();
  if (unexpected.length > 0) {
    throw new AdversarialEvidenceInputError(`input has unexpected field(s): ${unexpected.join(", ")}`);
  }
  if (input.schemaVersion !== INPUT_SCHEMA_VERSION) {
    throw new AdversarialEvidenceInputError(`schemaVersion must be ${INPUT_SCHEMA_VERSION}`);
  }
  if (!Array.isArray(input.attempts) || input.attempts.length === 0) {
    throw new AdversarialEvidenceInputError("attempts must be a non-empty array");
  }
}

function duplicateAttemptIds(attempts) {
  const counts = new Map();
  for (const attempt of attempts) {
    if (isRecord(attempt) && typeof attempt.id === "string") {
      counts.set(attempt.id, (counts.get(attempt.id) || 0) + 1);
    }
  }
  return new Set([...counts].filter(([, count]) => count > 1).map(([id]) => id));
}

export function verifyAdversarialEvidence(input, options = {}) {
  validateTopLevel(input);
  if (typeof options.fixturesRoot !== "string" || options.fixturesRoot.length === 0) {
    throw new AdversarialEvidenceInputError("options.fixturesRoot is required");
  }
  const timeoutMs = options.timeoutMs ?? 10_000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) {
    throw new AdversarialEvidenceInputError("timeoutMs must be an integer from 1 through 60000");
  }
  const fixturesRoot = path.resolve(options.fixturesRoot);
  let fixturesReal;
  try {
    fixturesReal = realpathOrSetupError(fixturesRoot, "supplied fixtures root");
    if (!lstatOrSetupError(fixturesRoot, "supplied fixtures root").isDirectory()) {
      throw new AttemptSetupError("supplied fixtures root must resolve to a directory");
    }
  } catch (error) {
    throw new AdversarialEvidenceInputError(error instanceof Error ? error.message : "invalid supplied fixtures root");
  }
  const context = {
    fixturesRoot,
    fixturesReal,
    duplicateIds: duplicateAttemptIds(input.attempts),
    timeoutMs,
    cliPath: defaultCliPath,
    runner: options.runner || runLocalCellFence,
  };
  const attempts = input.attempts.map((attempt, sourceIndex) => {
    try {
      const validated = validateAttempt(attempt, sourceIndex, context);
      return verifiedAttemptReport(validated, rerunAttempt(validated, context));
    } catch (error) {
      return setupFailure(attempt, sourceIndex, error);
    }
  }).sort((left, right) => left.id.localeCompare(right.id) || left.sourceIndex - right.sourceIndex);
  const byClassification = Object.fromEntries(classifications.map((classification) => [
    classification,
    attempts.filter((attempt) => attempt.classification === classification).length,
  ]));
  return {
    schemaVersion: REPORT_SCHEMA_VERSION,
    verifier: verifierVersion,
    ok: byClassification.reproduced_bypass === 0
      && byClassification.invalid_setup === 0
      && byClassification.tool_error === 0,
    input: {
      schemaVersion: input.schemaVersion,
      canonicalSha256: canonicalSha256(input),
    },
    executionPolicy: {
      localCellFenceOnly: true,
      shell: false,
      install: false,
      network: false,
      timeoutMs,
    },
    summary: { total: attempts.length, byClassification },
    attempts,
  };
}

function usage() {
  console.error(`Usage:
  node scripts/adversarial-evidence-verify.mjs --input attempts.json --fixtures-root fixtures [--out report.json] [--timeout-ms 10000]
  node scripts/adversarial-evidence-verify.mjs --print-schema

All fixture, manifest, and witness paths in the input are relative to the supplied
fixtures root. Submitted command evidence is validated and never executed.`);
}

function requireOptionValue(argv, index, name) {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) throw new AdversarialEvidenceInputError(`${name} requires a value`);
  return value;
}

function parseArgs(argv) {
  const parsed = { inputPath: "", fixturesRoot: "", outPath: "", timeoutMs: 10_000, printSchema: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--input") {
      parsed.inputPath = path.resolve(requireOptionValue(argv, index, "--input"));
      index += 1;
    } else if (argument.startsWith("--input=")) {
      parsed.inputPath = path.resolve(argument.slice("--input=".length));
    } else if (argument === "--fixtures-root") {
      parsed.fixturesRoot = path.resolve(requireOptionValue(argv, index, "--fixtures-root"));
      index += 1;
    } else if (argument.startsWith("--fixtures-root=")) {
      parsed.fixturesRoot = path.resolve(argument.slice("--fixtures-root=".length));
    } else if (argument === "--out") {
      parsed.outPath = path.resolve(requireOptionValue(argv, index, "--out"));
      index += 1;
    } else if (argument.startsWith("--out=")) {
      parsed.outPath = path.resolve(argument.slice("--out=".length));
    } else if (argument === "--timeout-ms") {
      parsed.timeoutMs = Number(requireOptionValue(argv, index, "--timeout-ms"));
      index += 1;
    } else if (argument.startsWith("--timeout-ms=")) {
      parsed.timeoutMs = Number(argument.slice("--timeout-ms=".length));
    } else if (argument === "--print-schema") {
      parsed.printSchema = true;
    } else if (argument === "--help" || argument === "-h") {
      usage();
      return null;
    } else {
      throw new AdversarialEvidenceInputError(`unknown argument: ${argument}`);
    }
  }
  if (parsed.printSchema) return parsed;
  if (!parsed.inputPath || !parsed.fixturesRoot) {
    throw new AdversarialEvidenceInputError("--input and --fixtures-root are required");
  }
  return parsed;
}

function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
    if (options === null) return 0;
    if (options.printSchema) {
      process.stdout.write(`${JSON.stringify(ADVERSARIAL_EVIDENCE_INPUT_SCHEMA, null, 2)}\n`);
      return 0;
    }
    const input = JSON.parse(fs.readFileSync(options.inputPath, "utf8"));
    const report = verifyAdversarialEvidence(input, options);
    const output = `${JSON.stringify(report, null, 2)}\n`;
    if (options.outPath) {
      fs.mkdirSync(path.dirname(options.outPath), { recursive: true });
      fs.writeFileSync(options.outPath, output);
    }
    process.stdout.write(output);
    if (report.summary.byClassification.invalid_setup > 0 || report.summary.byClassification.tool_error > 0) return 2;
    return report.summary.byClassification.reproduced_bypass > 0 ? 1 : 0;
  } catch (error) {
    usage();
    console.error(error instanceof Error ? error.message : String(error));
    return 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = main();
}
