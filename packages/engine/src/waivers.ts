import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import type { CellFenceManifest } from "@cellfence/schema";
import { validateManifest } from "@cellfence/schema";
import { CORE_REQUIRED_RULES, DEFAULT_MANIFEST_PATH } from "./constants.js";
import { daysBetween, isIsoDate, todayIsoDate } from "./dates.js";
import { readJsonFile } from "./json-file.js";
import { sourceFilesForCell, normalizePath, repoPath } from "./file-index.js";
import { createContext } from "./analysis-context.js";
import { execCommandSync } from "./command-execution.js";
import { stableCanonicalJson } from "./governance/canonicalization.js";
import type { AnalysisContext, CellFenceWaiver, CheckOptions, Finding, WaiverAttestation, WaiverAttestationUnsigned } from "./types.js";

const WAIVER_PATTERN = /cellfence-ignore\s+([A-Z0-9_*]+)\s+(.*)$/;
const WAIVER_ATTESTATION_SCHEMA_VERSION = "cellfence.waiver-attestation.v1";
export const WAIVER_ATTESTATION_HMAC_KEY_ENV = "CELLFENCE_WAIVER_ATTESTATION_HMAC_KEY";
export const WAIVER_ATTESTATION_HMAC_KEY_ID_ENV = "CELLFENCE_WAIVER_ATTESTATION_HMAC_KEY_ID";
export const WAIVER_ATTESTATIONS_PATH_ENV = "CELLFENCE_WAIVER_ATTESTATIONS";
export const WAIVER_REPOSITORY_IDENTITY_ENV = "CELLFENCE_REPOSITORY_IDENTITY";

/**
 * Maximum allowed waiver duration. Waivers that outlive this window are
 * rejected at parse time so that an agent cannot bake a permanent exemption
 * into a single comment.
 */
export const MAX_WAIVER_DAYS = 90;


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
 * `CELLFENCE_APPROVERS` is the only trusted source because it is supplied by
 * the caller's execution environment. Repository files are intentionally not
 * read here: a pull request can edit CODEOWNERS or `.cellfence/approvers.txt`
 * in the same diff as a waiver directive, so those files are policy hints, not
 * proof that an external approval happened.
 */
export function getApprovalAllowlist(rootDir: string): string[] {
  void rootDir;
  const allow = new Set<string>();
  const fromEnv = process.env.CELLFENCE_APPROVERS;
  if (fromEnv) {
    for (const item of fromEnv.split(",")) {
      const trimmed = item.trim();
      if (trimmed) allow.add(trimmed);
    }
    return [...allow];
  }
  return [...allow];
}

type WaiverAttestationIndex = {
  attestations: Map<string, WaiverAttestation>;
  errors: Map<string, string[]>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function gitOutput(rootDir: string, args: string[]): string | undefined {
  try {
    return execCommandSync("git", args, { cwd: rootDir, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return undefined;
  }
}

function currentHeadSha(rootDir: string): string | undefined {
  return gitOutput(rootDir, ["rev-parse", "--verify", "--end-of-options", "HEAD^{commit}"]);
}

function repositoryIdentity(rootDir: string): string {
  const fromEnv = process.env[WAIVER_REPOSITORY_IDENTITY_ENV]?.trim();
  if (fromEnv) return fromEnv;
  const remote = gitOutput(rootDir, ["config", "--get", "remote.origin.url"]);
  if (remote) return remote;
  return `file://${rootDir}`;
}

function isoDatePart(value: string): string {
  return value.slice(0, 10);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function fileSha256(filePath: string): string | undefined {
  try {
    return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
  } catch {
    return undefined;
  }
}

function unsignedWaiverAttestation(attestation: WaiverAttestation): WaiverAttestationUnsigned {
  const { signature: _signature, ...unsigned } = attestation;
  return unsigned;
}

export function waiverAttestationHmacDigest(attestation: WaiverAttestation | WaiverAttestationUnsigned, secret: string): string {
  const unsigned = "signature" in attestation ? unsignedWaiverAttestation(attestation) : attestation;
  return crypto.createHmac("sha256", secret).update(stableCanonicalJson(unsigned)).digest("hex");
}

function timingSafeHexEqual(left: string, right: string): boolean {
  if (!/^[a-f0-9]{64}$/.test(left) || !/^[a-f0-9]{64}$/.test(right)) return false;
  const leftBuffer = Buffer.from(left, "hex");
  const rightBuffer = Buffer.from(right, "hex");
  return leftBuffer.length === rightBuffer.length && crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function validateWaiverAttestationShape(value: unknown, source: string): { attestation?: WaiverAttestation; errors: string[] } {
  const errors: string[] = [];
  if (!isRecord(value)) return { errors: [`${source}: attestation must be an object`] };
  const signature = value.signature;
  if (value.schemaVersion !== WAIVER_ATTESTATION_SCHEMA_VERSION) errors.push(`${source}: schemaVersion must be ${WAIVER_ATTESTATION_SCHEMA_VERSION}`);
  for (const field of ["attestationId", "repository", "headSha", "sourceSha256", "ruleId", "findingFingerprint", "filePath", "expiresAt", "reason", "approver", "issuedAt"]) {
    if (typeof value[field] !== "string" || String(value[field]).trim().length === 0) errors.push(`${source}: ${field} must be a non-empty string`);
  }
  if (!Number.isInteger(value.line) || Number(value.line) <= 0) errors.push(`${source}: line must be a positive integer`);
  if (!isRecord(signature)) {
    errors.push(`${source}: signature must be an object`);
  } else {
    if (signature.algorithm !== "hmac-sha256") errors.push(`${source}: signature.algorithm must be hmac-sha256`);
    if (signature.keyId !== undefined && typeof signature.keyId !== "string") errors.push(`${source}: signature.keyId must be a string when present`);
    if (typeof signature.digest !== "string" || !/^[a-f0-9]{64}$/.test(signature.digest)) errors.push(`${source}: signature.digest must be a lowercase sha256 hex string`);
  }
  if (!/^CELLFENCE_[A-Z0-9_]+$/.test(String(value.ruleId || ""))) errors.push(`${source}: ruleId must be a concrete CELLFENCE_* rule`);
  if (typeof value.findingFingerprint === "string" && !/^[a-f0-9]{64}$/.test(value.findingFingerprint)) errors.push(`${source}: findingFingerprint must be a lowercase sha256 hex string`);
  if (typeof value.sourceSha256 === "string" && !/^[a-f0-9]{64}$/.test(value.sourceSha256)) errors.push(`${source}: sourceSha256 must be a lowercase sha256 hex string`);
  if (typeof value.expiresAt === "string" && Number.isNaN(Date.parse(value.expiresAt))) errors.push(`${source}: expiresAt must be an ISO date or date-time`);
  if (typeof value.issuedAt === "string" && Number.isNaN(Date.parse(value.issuedAt))) errors.push(`${source}: issuedAt must be an ISO date or date-time`);
  return errors.length > 0 ? { errors } : { attestation: value as WaiverAttestation, errors };
}

function attestationValuesFromParsed(parsed: unknown): unknown[] {
  if (Array.isArray(parsed)) return parsed;
  if (isRecord(parsed) && Array.isArray(parsed.attestations)) return parsed.attestations;
  return [parsed];
}

function loadAttestationFile(filePath: string, index: WaiverAttestationIndex): void {
  let parsed: unknown;
  try {
    parsed = readJsonFile(filePath);
  } catch (error) {
    index.errors.set(filePath, [`${filePath}: failed to read waiver attestation: ${error instanceof Error ? error.message : String(error)}`]);
    return;
  }
  for (const [entryIndex, value] of attestationValuesFromParsed(parsed).entries()) {
    const source = `${filePath}[${entryIndex}]`;
    const validation = validateWaiverAttestationShape(value, source);
    const id = validation.attestation?.attestationId || (isRecord(value) && typeof value.attestationId === "string" ? value.attestationId : source);
    if (validation.errors.length > 0) {
      index.errors.set(id, [...(index.errors.get(id) || []), ...validation.errors]);
      continue;
    }
    if (index.attestations.has(id)) {
      index.errors.set(id, [...(index.errors.get(id) || []), `${source}: duplicate waiver attestation id ${id}`]);
      continue;
    }
    index.attestations.set(id, validation.attestation as WaiverAttestation);
  }
}

function attestationCandidatePaths(rootDir: string): string[] {
  const configured = process.env[WAIVER_ATTESTATIONS_PATH_ENV];
  if (configured) {
    return configured.split(path.delimiter).map((entry) => entry.trim()).filter(Boolean)
      .map((entry) => path.isAbsolute(entry) ? entry : path.resolve(rootDir, entry));
  }
  return [
    path.join(rootDir, ".cellfence/waiver-attestations.json"),
    path.join(rootDir, ".cellfence/waiver-attestations"),
  ];
}

function loadWaiverAttestations(rootDir: string): WaiverAttestationIndex {
  const index: WaiverAttestationIndex = { attestations: new Map(), errors: new Map() };
  for (const candidate of attestationCandidatePaths(rootDir)) {
    if (!fs.existsSync(candidate)) continue;
    const stat = fs.statSync(candidate);
    if (stat.isDirectory()) {
      for (const entry of fs.readdirSync(candidate).filter((name) => name.endsWith(".json")).sort()) {
        loadAttestationFile(path.join(candidate, entry), index);
      }
    } else if (stat.isFile()) {
      loadAttestationFile(candidate, index);
    }
  }
  return index;
}

function validateWaiverAttestation(
  rootDir: string,
  sourceFilePath: string,
  ruleId: string,
  attestationId: string,
  index: WaiverAttestationIndex,
): { attestation?: WaiverAttestation; errors: string[]; untrustedApprover: boolean } {
  const errors: string[] = [];
  const attestation = index.attestations.get(attestationId);
  if (!attestation) {
    errors.push(...(index.errors.get(attestationId) || [`attestation:${attestationId} was not found`]));
    return { errors, untrustedApprover: false };
  }
  errors.push(...(index.errors.get(attestationId) || []));
  if (attestation.ruleId !== ruleId) errors.push(`attestation:${attestationId} ruleId does not match source directive`);
  if (normalizePath(attestation.filePath) !== repoPath(rootDir, sourceFilePath)) errors.push(`attestation:${attestationId} filePath does not match source directive`);
  const sourceDigest = fileSha256(sourceFilePath);
  if (!sourceDigest) errors.push(`attestation:${attestationId} sourceSha256 cannot be verified because the source file is unavailable`);
  else if (attestation.sourceSha256 !== sourceDigest) errors.push(`attestation:${attestationId} sourceSha256 does not match the evaluated source file`);
  const directiveLine = (() => {
    try {
      const lines = fs.readFileSync(sourceFilePath, "utf8").split(/\r?\n/);
      const directivePattern = new RegExp(`\\bcellfence-ignore\\s+${escapeRegExp(ruleId)}\\b.*\\battestation:${escapeRegExp(attestationId)}\\b`);
      const directiveIndex = lines.findIndex((line) => directivePattern.test(line));
      return directiveIndex >= 0 ? directiveIndex + 1 : undefined;
    } catch {
      return undefined;
    }
  })();
  if (directiveLine && attestation.line !== directiveLine + 1) {
    errors.push(`attestation:${attestationId} line must target the finding immediately after the source directive`);
  }
  const headSha = currentHeadSha(rootDir);
  if (!headSha) errors.push(`attestation:${attestationId} headSha cannot be verified because HEAD is unavailable`);
  else if (attestation.headSha !== headSha) errors.push(`attestation:${attestationId} headSha does not match the evaluated HEAD`);
  const expectedRepository = repositoryIdentity(rootDir);
  if (attestation.repository !== expectedRepository) errors.push(`attestation:${attestationId} repository does not match ${expectedRepository}`);
  const expiresAtMs = Date.parse(attestation.expiresAt);
  if (Number.isNaN(expiresAtMs) || expiresAtMs < Date.now()) errors.push(`attestation:${attestationId} is expired`);
  else {
    const span = daysBetween(todayIsoDate(), isoDatePart(attestation.expiresAt));
    if (span > MAX_WAIVER_DAYS) {
      errors.push(`attestation:${attestationId} expiresAt must be at most ${MAX_WAIVER_DAYS} days from today (got ${span})`);
    }
  }
  const allowlist = getApprovalAllowlist(rootDir);
  const untrustedApprover = !allowlist.includes(attestation.approver);
  if (untrustedApprover) {
    if (allowlist.length === 0) errors.push(`approval allowlist is empty; set CELLFENCE_APPROVERS from a trusted CI secret before accepting waiver attestations`);
    else errors.push(`attestation:${attestationId} approver ${attestation.approver} is not in the approval allowlist (CELLFENCE_APPROVERS)`);
  }
  const secret = process.env[WAIVER_ATTESTATION_HMAC_KEY_ENV];
  if (!secret) {
    errors.push(`attestation:${attestationId} cannot be verified; set ${WAIVER_ATTESTATION_HMAC_KEY_ENV}`);
  } else {
    const expectedDigest = waiverAttestationHmacDigest(attestation, secret);
    if (!timingSafeHexEqual(attestation.signature.digest, expectedDigest)) errors.push(`attestation:${attestationId} signature does not match`);
    const expectedKeyId = process.env[WAIVER_ATTESTATION_HMAC_KEY_ID_ENV];
    if (expectedKeyId && attestation.signature.keyId !== expectedKeyId) errors.push(`attestation:${attestationId} signature keyId does not match ${WAIVER_ATTESTATION_HMAC_KEY_ID_ENV}`);
  }
  return { attestation, errors, untrustedApprover };
}

function parseWaiverDirective(rootDir: string, filePath: string, line: number, text: string, attestations: WaiverAttestationIndex): CellFenceWaiver | undefined {
  const match = WAIVER_PATTERN.exec(text);
  if (!match) return undefined;
  const [, ruleId, suffix] = match;
  const expiresMatch = /\bexpires:(\d{4}-\d{2}-\d{2})\b/.exec(suffix);
  const approvedByMatch = /\bapproved-by:([^\s]+)/.exec(suffix);
  const attestationMatch = /\battestation:([A-Za-z0-9_.:-]+)\b/.exec(suffix);
  const reasonMatch = /\breason:(.+)$/.exec(suffix);
  const attestationId = attestationMatch?.[1] || "";
  const approvedBy = approvedByMatch?.[1] || "";
  const attestationValidation = attestationId
    ? validateWaiverAttestation(rootDir, filePath, ruleId, attestationId, attestations)
    : undefined;
  const attestation = attestationValidation?.attestation;
  const expires = attestation?.expiresAt || expiresMatch?.[1] || "";
  const reason = attestation?.reason || (reasonMatch ? reasonMatch[1].trim() : "");
  const approvedByDisplay = attestation?.approver || approvedBy;
  const errors: string[] = [];
  if (!/^CELLFENCE_[A-Z0-9_]+$/.test(ruleId)) errors.push("rule id must be a concrete CELLFENCE_* rule");
  if (!attestationId) errors.push("signed waiver attestation is required; source approved-by is a request only");
  if (approvedBy) errors.push("approved-by in source is not an approval; use attestation:<id> signed by a trusted approver");
  if (!attestation && (!expires || !isIsoDate(expires))) errors.push("expires must be YYYY-MM-DD until a valid attestation supplies expiresAt");
  if (approvedBy.toUpperCase() === "PENDING") errors.push("approved-by:PENDING is a request placeholder, not an approval");
  if (reason.length < 12) errors.push("reason must explain the waiver in at least 12 characters");
  if (!attestation && expires && isIsoDate(expires)) {
    const today = todayIsoDate();
    const span = daysBetween(today, expires);
    if (span < 0) {
      errors.push("waiver is expired");
    } else if (span > MAX_WAIVER_DAYS) {
      errors.push(`expires must be at most ${MAX_WAIVER_DAYS} days from today (got ${span})`);
    }
  }
  if (attestationValidation) errors.push(...attestationValidation.errors);
  const expired = Boolean(expires) && Date.parse(expires) < Date.now();
  if (expired) errors.push("waiver is expired");
  const untrustedApprover = Boolean(attestationValidation?.untrustedApprover);
  return {
    ruleId,
    filePath: repoPath(rootDir, filePath),
    line,
    expires,
    approvedBy: approvedByDisplay,
    attestationId: attestationId || undefined,
    attestation,
    findingFingerprint: attestation?.findingFingerprint,
    reason,
    expired,
    valid: errors.length === 0,
    untrustedApprover,
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

export function collectWaiversForManifest(rootDir: string, manifest: CellFenceManifest, findings?: Finding[]): CellFenceWaiver[] {
  // 0.4.0: cells that opt out of waiver parsing (waiverParsing === false)
  // keep ownership of their files but their // cellfence-ignore directives
  // are not interpreted as waivers. This is the escape hatch for cells that
  // contain deliberately invalid waiver test fixtures (CellFence's own
  // scripts/ and tests/ trees, for example).
  const skipCells = new Set(
    manifest.cells.filter((cell) => cell.waiverParsing === false).map((cell) => cell.id),
  );
  // 0.4.x (N-5): surface a warning per cell that opts out of
  // waiver parsing so the exemption shows up in the same log as
  // the rest of the findings. Without this, a deliberately
  // invalid directive in scripts/ or tests/ looks identical
  // to a clean cell, and CI cannot tell why the engine did
  // not surface an error.
  if (findings && skipCells.size > 0) {
    for (const cellId of skipCells) {
            findings.push({
        ruleId: "CELLFENCE_WAIVER_PARSING_DISABLED",
        severity: "warning",
        message: `${cellId} declared waiverParsing: false; // cellfence-ignore directives in this cell's files will not be interpreted as waivers.`,
        details: { cellId },
      });
    }
  }
  const skipFiles = new Set<string>();
  if (skipCells.size > 0) {
    const ctx = createContext(rootDir, manifest);
    for (const cell of manifest.cells) {
      if (!skipCells.has(cell.id)) continue;
      for (const file of sourceFilesForCell(rootDir, cell, ctx)) {
        skipFiles.add(file);
      }
    }
  }
  const waivers: CellFenceWaiver[] = [];
  const attestations = loadWaiverAttestations(rootDir);
  const requiredRules = new Set<string>([
    ...CORE_REQUIRED_RULES,
    ...(manifest.governance?.requiredRules || []),
  ]);
  for (const sourceFile of sourceFilesForManifest(rootDir, manifest)) {
    if (skipFiles.has(sourceFile)) continue;
    const lines = fs.readFileSync(sourceFile, "utf8").split(/\r?\n/);
    for (const [index, line] of lines.entries()) {
      const waiver = parseWaiverDirective(rootDir, sourceFile, index + 1, line, attestations);
      if (!waiver) continue;
      if (requiredRules.has(waiver.ruleId)) {
        waiver.errors.push(`rule ${waiver.ruleId} is required and cannot be waived`);
        waiver.valid = false;
      }
      waivers.push(waiver);
      if (waiver.untrustedApprover && findings) {
        findings.push({
          ruleId: "CELLFENCE_WAIVER_UNTRUSTED_APPROVER",
          severity: "warning",
          filePath: waiver.filePath,
          message: `waiver approves ${waiver.ruleId} but approved-by:${waiver.approvedBy} is not in the approval allowlist (CELLFENCE_APPROVERS)`,
          details: { approvedBy: waiver.approvedBy, ruleId: waiver.ruleId, line: waiver.line },
        });
      }
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
  if (waiver.findingFingerprint && finding.fingerprint !== waiver.findingFingerprint) return false;
  const findingLine = lineForFinding(finding);
  if (!findingLine) return false;
  const attestedLine = waiver.attestation?.line;
  if (attestedLine) return attestedLine === findingLine;
  return waiver.line === findingLine || waiver.line === findingLine - 1;
}

function waiverTargetsFindingLocation(waiver: CellFenceWaiver, finding: Finding): boolean {
  if (!finding.filePath || waiver.filePath !== normalizePath(finding.filePath)) return false;
  if (waiver.ruleId !== finding.ruleId) return false;
  const findingLine = lineForFinding(finding);
  if (!findingLine) return false;
  const attestedLine = waiver.attestation?.line;
  if (attestedLine) return attestedLine === findingLine;
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
        attestationId: waiver.attestationId,
      },
    }));
  for (const waiver of waivers.filter((candidate) => candidate.valid && candidate.findingFingerprint)) {
    const targetedFinding = findings.find((finding) => waiverTargetsFindingLocation(waiver, finding));
    if (targetedFinding && !waiverMatchesFinding(waiver, targetedFinding)) {
      waiverFindings.push({
        ruleId: "CELLFENCE_WAIVER_INVALID",
        severity: "error",
        filePath: waiver.filePath,
        message: `invalid CellFence waiver at line ${waiver.line}: attestation findingFingerprint does not match the active finding`,
        details: {
          line: waiver.line,
          ruleId: waiver.ruleId,
          attestationId: waiver.attestationId,
          expectedFingerprint: targetedFinding.fingerprint,
          attestedFingerprint: waiver.findingFingerprint,
        },
      });
    }
  }

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
