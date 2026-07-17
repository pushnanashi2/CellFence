import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import {
  CELLFENCE_MANIFEST_SCHEMA_VERSION,
  type CellFenceManifest,
  type CellManifest,
  type CheckProfileManifest,
  type PathClassKind,
  type PathClassManifest,
  type RuleSeverityMap,
} from "@cellfence/schema";
import { listFiles, matchesPattern, normalizePath, repoPath, SOURCE_EXTENSIONS } from "./file-index.js";
import { extractPublicSymbols, publicSurfaceHash } from "./module-resolution.js";

export type AdvancedFinding = {
  ruleId: string;
  severity: "error" | "warning";
  message: string;
  filePath?: string;
  cellId?: string;
  details?: Record<string, unknown>;
};

type ServiceJson = {
  serviceId?: unknown;
  ownedPaths?: unknown;
  allowedServiceImports?: unknown;
  consumes?: unknown;
  produces?: unknown;
  owner?: unknown;
  ownerAgent?: unknown;
};

type ServiceMappingWarning = {
  serviceId: string;
  field: string;
  message: string;
};

export type ServiceManifestImportResult = {
  schemaVersion: "cellfence.service-manifest-import.v1";
  manifest: CellFenceManifest;
  warnings: ServiceMappingWarning[];
};

export type ServiceManifestVerifyResult = {
  schemaVersion: "cellfence.service-manifest-verify.v1";
  ok: boolean;
  findings: AdvancedFinding[];
  generatedManifest: CellFenceManifest;
  warnings: ServiceMappingWarning[];
};

export type BaselineAuditResult = {
  schemaVersion: "cellfence.baseline-audit.v1";
  ok: boolean;
  baselinePath: string;
  commitsScanned: number;
  touches: number;
  baselineOnlyCommits: number;
  lockedExpansionMentions: number;
  touchedByCommit: Array<{ commit: string; subject: string; files: string[] }>;
  recommendations: string[];
};

export type CommitEvidenceResult = {
  schemaVersion: "cellfence.commit-evidence.v1";
  ok: boolean;
  findings: AdvancedFinding[];
  commits: Array<{
    sha: string;
    subject: string;
    changedCells: string[];
    trailers: Record<string, string>;
    sections: Record<string, string>;
  }>;
};

export type TaskCheckResult = {
  schemaVersion: "cellfence.task-check.v1";
  ok: boolean;
  findings: AdvancedFinding[];
  changedFiles: string[];
};

export type DocsCheckResult = {
  schemaVersion: "cellfence.docs-check.v1";
  ok: boolean;
  findings: AdvancedFinding[];
  checkedDocs: number;
};

export type MutationCheckResult = {
  schemaVersion: "cellfence.mutation-check.v1";
  ok: boolean;
  findings: AdvancedFinding[];
  cells: Record<string, { killed: number; survived: number; timeout: number; noCoverage: number; ignored: number; score: number }>;
};

type CommitFile = {
  status: string;
  path: string;
};

function readJson(filePath: string): unknown {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0) : [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function serviceProducesEntry(produces: unknown): string | undefined {
  if (!isRecord(produces)) return undefined;
  const exportsValue = produces.exports;
  if (!isRecord(exportsValue)) return undefined;
  return typeof exportsValue.entry === "string" && exportsValue.entry.trim().length > 0 ? exportsValue.entry : undefined;
}

function serviceProducesSymbols(produces: unknown): string[] {
  if (!isRecord(produces) || !isRecord(produces.exports)) return [];
  return asStringArray(produces.exports.symbols);
}

function serviceConsumesSystems(consumes: unknown): string[] {
  if (!isRecord(consumes)) return [];
  return asStringArray(consumes.systems);
}

function pathExists(rootDir: string, relativePath: string): boolean {
  return fs.existsSync(path.resolve(rootDir, relativePath));
}

function expandInputPaths(rootDir: string, inputPaths: string[]): string[] {
  const files = new Set<string>();
  for (const inputPath of inputPaths.length > 0 ? inputPaths : ["systems/*/service.json"]) {
    const normalizedInput = normalizePath(inputPath);
    if (!normalizedInput.includes("*")) {
      const absolute = path.resolve(rootDir, normalizedInput);
      if (fs.existsSync(absolute) && fs.statSync(absolute).isDirectory()) {
        for (const filePath of listFiles(absolute)) {
          if (path.basename(filePath) === "service.json") files.add(filePath);
        }
      } else if (fs.existsSync(absolute)) {
        files.add(absolute);
      }
      continue;
    }
    for (const filePath of listFiles(rootDir)) {
      const relativePath = repoPath(rootDir, filePath);
      if (matchesPattern(relativePath, normalizedInput)) files.add(filePath);
    }
  }
  return [...files].sort((left, right) => left.localeCompare(right));
}

function publicSymbolsForEntry(rootDir: string, entry: string, declaredSymbols: string[]): string[] {
  const entryPath = path.resolve(rootDir, entry);
  if (!fs.existsSync(entryPath)) return declaredSymbols;
  const extracted = [...extractPublicSymbols(entryPath)].sort((left, right) => left.localeCompare(right));
  return extracted.length > 0 ? extracted : declaredSymbols;
}

export function createManifestFromServiceManifests(options: { rootDir?: string; serviceManifestPaths?: string[]; locked?: boolean } = {}): ServiceManifestImportResult {
  const rootDir = path.resolve(options.rootDir || process.cwd());
  const warnings: ServiceMappingWarning[] = [];
  const cells: CellManifest[] = [];
  for (const filePath of expandInputPaths(rootDir, options.serviceManifestPaths || [])) {
    const service = readJson(filePath) as ServiceJson;
    const serviceId = typeof service.serviceId === "string" && service.serviceId.trim().length > 0
      ? service.serviceId
      : path.basename(path.dirname(filePath));
    const ownedPaths = asStringArray(service.ownedPaths);
    if (ownedPaths.length === 0) warnings.push({ serviceId, field: "ownedPaths", message: "service manifest has no ownedPaths; generated cell will own only the service directory" });
    const publicEntry = serviceProducesEntry(service.produces) || `systems/${serviceId}/public.ts`;
    if (!pathExists(rootDir, publicEntry)) warnings.push({ serviceId, field: "publicEntry", message: `public entry does not exist: ${publicEntry}` });
    const allowedImports = asStringArray(service.allowedServiceImports);
    const consumesSystems = serviceConsumesSystems(service.consumes);
    const consumes = [...new Set([...allowedImports, ...consumesSystems])]
      .filter((cell) => cell !== serviceId)
      .sort((left, right) => left.localeCompare(right))
      .map((cell) => ({ cell }));
    for (const field of ["produces.artifacts", "produces.http", "ownedData", "readOnlyArtifacts", "writePaths", "scheduled"]) {
      warnings.push({ serviceId, field, message: "field is not mapped by service-manifest adapter v1" });
    }
    cells.push({
      id: serviceId,
      ownedPaths: ownedPaths.length > 0 ? ownedPaths : [`systems/${serviceId}/**`],
      publicEntry,
      publicSymbols: publicSymbolsForEntry(rootDir, publicEntry, serviceProducesSymbols(service.produces)),
      locked: options.locked ?? true,
      consumes,
      producesArtifacts: [],
    });
  }
  return {
    schemaVersion: "cellfence.service-manifest-import.v1",
    manifest: {
      schemaVersion: CELLFENCE_MANIFEST_SCHEMA_VERSION,
      governance: {
        requireOwnership: true,
        include: ["systems/**", "packages/**"],
        exclude: ["systems/**/node_modules/**"],
      },
      cells: cells.sort((left, right) => left.id.localeCompare(right.id)),
    },
    warnings,
  };
}

function compareArrayField(findings: AdvancedFinding[], cellId: string, field: keyof CellManifest, current: unknown, expected: unknown): void {
  const currentValues = Array.isArray(current) ? current.map((entry) => JSON.stringify(entry)).sort() : [];
  const expectedValues = Array.isArray(expected) ? expected.map((entry) => JSON.stringify(entry)).sort() : [];
  if (JSON.stringify(currentValues) === JSON.stringify(expectedValues)) return;
  findings.push({
    ruleId: "CELLFENCE_SERVICE_MANIFEST_DRIFT",
    severity: "error",
    cellId,
    message: `${cellId} ${String(field)} differs from service-manifest adapter output`,
    details: { field, current, expected },
  });
}

export function verifyManifestFromServiceManifests(options: { rootDir?: string; manifest: CellFenceManifest; serviceManifestPaths?: string[] }): ServiceManifestVerifyResult {
  const generated = createManifestFromServiceManifests(options);
  const generatedById = new Map(generated.manifest.cells.map((cell) => [cell.id, cell]));
  const findings: AdvancedFinding[] = [];
  for (const generatedCell of generated.manifest.cells) {
    const current = options.manifest.cells.find((cell) => cell.id === generatedCell.id);
    if (!current) {
      findings.push({
        ruleId: "CELLFENCE_SERVICE_MANIFEST_DRIFT",
        severity: "error",
        cellId: generatedCell.id,
        message: `${generatedCell.id} is present in service manifests but missing from CellFence manifest`,
      });
      continue;
    }
    compareArrayField(findings, generatedCell.id, "ownedPaths", current.ownedPaths, generatedCell.ownedPaths);
    if (current.publicEntry !== generatedCell.publicEntry) {
      findings.push({
        ruleId: "CELLFENCE_SERVICE_MANIFEST_DRIFT",
        severity: "error",
        cellId: generatedCell.id,
        message: `${generatedCell.id} publicEntry differs from service-manifest adapter output`,
        details: { current: current.publicEntry, expected: generatedCell.publicEntry },
      });
    }
    compareArrayField(findings, generatedCell.id, "consumes", current.consumes || [], generatedCell.consumes || []);
  }
  for (const current of options.manifest.cells) {
    if (generatedById.has(current.id)) continue;
    findings.push({
      ruleId: "CELLFENCE_SERVICE_MANIFEST_DRIFT",
      severity: "warning",
      cellId: current.id,
      message: `${current.id} exists in CellFence manifest but not in service manifests`,
    });
  }
  return {
    schemaVersion: "cellfence.service-manifest-verify.v1",
    ok: findings.every((finding) => finding.severity !== "error"),
    findings,
    generatedManifest: generated.manifest,
    warnings: generated.warnings,
  };
}

function git(rootDir: string, args: string[]): string {
  return execFileSync("git", args, { cwd: rootDir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function commitFiles(rootDir: string, commit: string): CommitFile[] {
  const output = git(rootDir, ["show", "--name-status", "--format=", commit]);
  return output.split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .flatMap((line) => {
      const [status, firstPath, secondPath] = line.split(/\s+/);
      const filePath = normalizePath(secondPath || firstPath || "");
      return filePath ? [{ status, path: filePath }] : [];
    });
}

function commitsForRange(rootDir: string, baseRef?: string, headRef?: string, commit?: string, limit = 100): string[] {
  if (commit) return [git(rootDir, ["rev-parse", "--verify", `${commit}^{commit}`])];
  const range = baseRef ? `${baseRef}..${headRef || "HEAD"}` : headRef || "HEAD";
  const output = git(rootDir, ["log", "--no-merges", `--max-count=${limit}`, "--format=%H", range]);
  return output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

function commitSubject(rootDir: string, commit: string): string {
  return git(rootDir, ["show", "-s", "--format=%s", commit]);
}

export function createBaselineAudit(options: { rootDir?: string; baselinePath?: string; maxCommits?: number } = {}): BaselineAuditResult {
  const rootDir = path.resolve(options.rootDir || process.cwd());
  const baselinePath = normalizePath(options.baselinePath || "cellfence.baseline.json");
  const commits = git(rootDir, ["log", `--max-count=${options.maxCommits || 1000}`, "--format=%H"]).split(/\r?\n/).filter(Boolean);
  const touchedByCommit: BaselineAuditResult["touchedByCommit"] = [];
  let baselineOnlyCommits = 0;
  let lockedExpansionMentions = 0;
  for (const commit of commits) {
    const files = commitFiles(rootDir, commit).map((entry) => entry.path);
    if (!files.includes(baselinePath)) continue;
    const subject = commitSubject(rootDir, commit);
    if (files.every((filePath) => filePath === baselinePath)) baselineOnlyCommits += 1;
    const body = git(rootDir, ["show", "-s", "--format=%B", commit]);
    if (/locked|expansion|ratchet|baseline/i.test(body)) lockedExpansionMentions += 1;
    touchedByCommit.push({ commit: commit.slice(0, 12), subject, files });
  }
  const recommendations: string[] = [];
  if (touchedByCommit.length > Math.max(5, commits.length * 0.05)) recommendations.push("baseline churn is high; split coarse baselines or move high-value contracts into manifest-owned resourceContracts");
  if (baselineOnlyCommits > 0) recommendations.push("baseline-only commits should require human review because they change the accepted architecture without source context");
  return {
    schemaVersion: "cellfence.baseline-audit.v1",
    ok: baselineOnlyCommits === 0,
    baselinePath,
    commitsScanned: commits.length,
    touches: touchedByCommit.length,
    baselineOnlyCommits,
    lockedExpansionMentions,
    touchedByCommit,
    recommendations,
  };
}

function parseSections(message: string): Record<string, string> {
  const sections: Record<string, string> = {};
  const names = ["Problem", "Change", "Behavior", "Tests", "Known-Gaps"];
  const pattern = new RegExp(`^(${names.join("|")}):\\s*$`, "m");
  const lines = message.split(/\r?\n/);
  let current: string | undefined;
  for (const line of lines) {
    const match = /^([A-Za-z-]+):\s*$/.exec(line);
    if (match && names.includes(match[1])) {
      current = match[1];
      sections[current] = "";
      continue;
    }
    if (current) sections[current] = `${sections[current]}${line}\n`;
  }
  for (const key of Object.keys(sections)) sections[key] = sections[key].trim();
  return sections;
}

function parseTrailers(message: string): Record<string, string> {
  const trailers: Record<string, string> = {};
  for (const line of message.split(/\r?\n/)) {
    const match = /^([A-Za-z][A-Za-z0-9-]*):\s*(.+?)\s*$/.exec(line);
    if (match) trailers[match[1]] = match[2];
  }
  return trailers;
}

function owningCellsForFiles(manifest: CellFenceManifest, files: string[]): string[] {
  const cells = new Set<string>();
  for (const filePath of files) {
    for (const cell of manifest.cells) {
      if (cell.ownedPaths.some((pattern) => matchesPattern(filePath, pattern))) cells.add(cell.id);
    }
  }
  return [...cells].sort((left, right) => left.localeCompare(right));
}

function csv(value: string | undefined): string[] {
  return (value || "").split(/[,\s]+/).map((entry) => entry.trim()).filter(Boolean).sort((left, right) => left.localeCompare(right));
}

function looksPlaceholder(value: string): boolean {
  return value.trim().length < 12 || /^(n\/a|none|todo|tbd|same|misc|update)$/i.test(value.trim());
}

export function checkCommitEvidence(options: { rootDir?: string; manifest: CellFenceManifest; baseRef?: string; headRef?: string; commit?: string; maxCommits?: number }): CommitEvidenceResult {
  const rootDir = path.resolve(options.rootDir || process.cwd());
  const findings: AdvancedFinding[] = [];
  const requiredSections = ["Problem", "Change", "Behavior", "Tests", "Known-Gaps"];
  const requiredTrailers = ["Change-Type", "Changed-Cells", "Tests-Added", "Tests-Modified", "Test-Impact", "Tests-Not-Added-Reason", "Agent-Run-Id", "Agent-Task-Id"];
  const commits = commitsForRange(rootDir, options.baseRef, options.headRef, options.commit, options.maxCommits);
  const summaries: CommitEvidenceResult["commits"] = [];
  for (const commit of commits) {
    const message = git(rootDir, ["show", "-s", "--format=%B", commit]);
    const sections = parseSections(message);
    const trailers = parseTrailers(message);
    const files = commitFiles(rootDir, commit);
    const filePaths = files.map((entry) => entry.path);
    const changedCells = owningCellsForFiles(options.manifest, filePaths);
    for (const section of requiredSections) {
      if (!sections[section] || looksPlaceholder(sections[section])) {
        findings.push({ ruleId: "CELLFENCE_COMMIT_EVIDENCE_MISSING", severity: "error", message: `${commit.slice(0, 12)} missing concrete ${section} section`, details: { commit, section } });
      }
    }
    for (const trailer of requiredTrailers) {
      if (!trailers[trailer] || looksPlaceholder(trailers[trailer])) {
        findings.push({ ruleId: "CELLFENCE_COMMIT_TRAILER_MISSING", severity: "error", message: `${commit.slice(0, 12)} missing concrete ${trailer} trailer`, details: { commit, trailer } });
      }
    }
    const declaredCells = csv(trailers["Changed-Cells"]);
    if (declaredCells.length > 0 && JSON.stringify(declaredCells) !== JSON.stringify(changedCells)) {
      findings.push({ ruleId: "CELLFENCE_COMMIT_CHANGED_CELLS_MISMATCH", severity: "error", message: `${commit.slice(0, 12)} Changed-Cells does not match git diff`, details: { commit, declaredCells, changedCells } });
    }
    const addedTests = files.filter((entry) => entry.status.startsWith("A") && /(^|\/)(tests?|__tests__)\//.test(entry.path)).map((entry) => entry.path).sort();
    const modifiedTests = files.filter((entry) => !entry.status.startsWith("A") && /(^|\/)(tests?|__tests__)\//.test(entry.path)).map((entry) => entry.path).sort();
    if (csv(trailers["Tests-Added"]).join(",") !== addedTests.join(",")) {
      findings.push({ ruleId: "CELLFENCE_COMMIT_TEST_EVIDENCE_MISMATCH", severity: "error", message: `${commit.slice(0, 12)} Tests-Added does not match git diff`, details: { commit, declared: csv(trailers["Tests-Added"]), actual: addedTests } });
    }
    if (csv(trailers["Tests-Modified"]).join(",") !== modifiedTests.join(",")) {
      findings.push({ ruleId: "CELLFENCE_COMMIT_TEST_EVIDENCE_MISMATCH", severity: "error", message: `${commit.slice(0, 12)} Tests-Modified does not match git diff`, details: { commit, declared: csv(trailers["Tests-Modified"]), actual: modifiedTests } });
    }
    const productionChanged = filePaths.some((filePath) => SOURCE_EXTENSIONS.includes(path.extname(filePath)) && !/(^|\/)(tests?|__tests__)\//.test(filePath));
    if (productionChanged && addedTests.length + modifiedTests.length === 0 && looksPlaceholder(trailers["Tests-Not-Added-Reason"] || "")) {
      findings.push({ ruleId: "CELLFENCE_COMMIT_TEST_REASON_REQUIRED", severity: "error", message: `${commit.slice(0, 12)} changes production source without concrete test reason`, details: { commit } });
    }
    for (const filePath of filePaths.filter((entry) => /(^|\/)(tests?|__tests__)\//.test(entry))) {
      const content = git(rootDir, ["show", `${commit}:${filePath}`]);
      if (/\.(only|skip)\s*\(/.test(content) || /TODO\s+test/i.test(content)) {
        findings.push({ ruleId: "CELLFENCE_COMMIT_TEST_WEAKENING", severity: "error", filePath, message: `${commit.slice(0, 12)} adds skipped/focused/TODO test marker`, details: { commit, filePath } });
      }
    }
    summaries.push({ sha: commit, subject: commitSubject(rootDir, commit), changedCells, trailers, sections });
  }
  return { schemaVersion: "cellfence.commit-evidence.v1", ok: findings.length === 0, findings, commits: summaries };
}

function pathClassForPath(pathClasses: PathClassManifest[] | undefined, filePath: string): PathClassManifest | undefined {
  return (pathClasses || []).find((pathClass) => pathClass.paths.some((pattern) => matchesPattern(filePath, pattern)));
}

export function validatePathClassImports(options: {
  pathClasses?: PathClassManifest[];
  imports: Array<{ importerPath: string; targetPath?: string; importerCellId?: string }>;
}): AdvancedFinding[] {
  const findings: AdvancedFinding[] = [];
  for (const reference of options.imports) {
    if (!reference.targetPath) continue;
    const importerClass = pathClassForPath(options.pathClasses, reference.importerPath);
    const targetClass = pathClassForPath(options.pathClasses, reference.targetPath);
    if (importerClass?.kind === "source" && targetClass?.kind === "runtime") {
      findings.push({
        ruleId: "CELLFENCE_SOURCE_IMPORTS_RUNTIME",
        severity: "error",
        cellId: reference.importerCellId,
        filePath: reference.importerPath,
        message: `source path imports runtime path ${reference.targetPath}`,
        details: { importerClass: importerClass.id, targetClass: targetClass.id, targetPath: reference.targetPath },
      });
    }
  }
  return findings;
}

export function validateChangedPathClasses(options: { pathClasses?: PathClassManifest[]; changedFiles?: string[] }): AdvancedFinding[] {
  const findings: AdvancedFinding[] = [];
  const changedFiles = (options.changedFiles || []).map(normalizePath);
  if (changedFiles.length === 0) return findings;
  const changedKinds = new Map<PathClassKind, string[]>();
  for (const filePath of changedFiles) {
    const pathClass = pathClassForPath(options.pathClasses, filePath);
    if (!pathClass) continue;
    const files = changedKinds.get(pathClass.kind) || [];
    files.push(filePath);
    changedKinds.set(pathClass.kind, files);
  }
  if (changedKinds.has("source") && changedKinds.has("runtime")) {
    findings.push({
      ruleId: "CELLFENCE_MIXED_SOURCE_RUNTIME_CHANGE",
      severity: "warning",
      message: "change mixes source and runtime path classes; require explicit commit evidence or split the change",
      details: { source: changedKinds.get("source"), runtime: changedKinds.get("runtime") },
    });
  }
  if (changedKinds.has("generated")) {
    findings.push({
      ruleId: "CELLFENCE_GENERATED_PATH_CHANGED",
      severity: "warning",
      message: "generated path changed; provenance evidence should be attached",
      details: { generated: changedKinds.get("generated") },
    });
  }
  return findings;
}

export function checkTaskManifest(options: { rootDir?: string; manifest: CellFenceManifest; taskPath: string; baseRef?: string; headRef?: string }): TaskCheckResult {
  const rootDir = path.resolve(options.rootDir || process.cwd());
  const taskPath = path.resolve(rootDir, options.taskPath);
  const task = readJson(taskPath);
  const findings: AdvancedFinding[] = [];
  if (!isRecord(task)) {
    return { schemaVersion: "cellfence.task-check.v1", ok: false, findings: [{ ruleId: "CELLFENCE_TASK_INVALID", severity: "error", message: "task manifest must be an object" }], changedFiles: [] };
  }
  const allowedWritePaths = asStringArray(task.allowedWritePaths);
  const forbiddenPaths = asStringArray(task.forbiddenPaths);
  const requiredGates = asStringArray(task.requiredGates);
  const maxFilesChanged = typeof task.maxFilesChanged === "number" ? task.maxFilesChanged : undefined;
  if (allowedWritePaths.length === 0) findings.push({ ruleId: "CELLFENCE_TASK_INVALID", severity: "error", filePath: repoPath(rootDir, taskPath), message: "task manifest requires allowedWritePaths" });
  if (requiredGates.length === 0) findings.push({ ruleId: "CELLFENCE_TASK_INVALID", severity: "error", filePath: repoPath(rootDir, taskPath), message: "task manifest requires requiredGates" });
  const changedFiles = changedFilesForTask(rootDir, options.baseRef, options.headRef);
  for (const filePath of changedFiles) {
    if (allowedWritePaths.length > 0 && !allowedWritePaths.some((pattern) => matchesPattern(filePath, pattern))) {
      findings.push({ ruleId: "CELLFENCE_TASK_WRITE_OUTSIDE_ALLOWLIST", severity: "error", filePath, message: `${filePath} is outside task allowedWritePaths` });
    }
    if (forbiddenPaths.some((pattern) => matchesPattern(filePath, pattern))) {
      findings.push({ ruleId: "CELLFENCE_TASK_FORBIDDEN_PATH", severity: "error", filePath, message: `${filePath} matches task forbiddenPaths` });
    }
  }
  if (maxFilesChanged !== undefined && changedFiles.length > maxFilesChanged) {
    findings.push({ ruleId: "CELLFENCE_TASK_CHANGE_BUDGET_EXCEEDED", severity: "error", message: `changed file count ${changedFiles.length} exceeds task maxFilesChanged ${maxFilesChanged}`, details: { changedFiles, maxFilesChanged } });
  }
  return { schemaVersion: "cellfence.task-check.v1", ok: findings.length === 0, findings, changedFiles };
}

function changedFilesForTask(rootDir: string, baseRef?: string, headRef?: string): string[] {
  const range = baseRef ? `${baseRef}...${headRef || "HEAD"}` : undefined;
  const args = range ? ["diff", "--name-only", "--diff-filter=ACMR", range] : ["diff", "--name-only", "--diff-filter=ACMR"];
  const files = new Set(git(rootDir, args).split(/\r?\n/).map((line) => normalizePath(line.trim())).filter(Boolean));
  const untracked = git(rootDir, ["ls-files", "--others", "--exclude-standard"]).split(/\r?\n/).map((line) => normalizePath(line.trim())).filter(Boolean);
  for (const filePath of untracked) files.add(filePath);
  return [...files].sort((left, right) => left.localeCompare(right));
}

function markdownFiles(rootDir: string, inputPaths: string[]): string[] {
  const docsRoot = path.join(rootDir, "docs");
  const files = inputPaths.length > 0
    ? inputPaths.map((entry) => path.resolve(rootDir, entry))
    : fs.existsSync(docsRoot)
      ? listFiles(docsRoot).filter((filePath) => filePath.endsWith(".md"))
      : [];
  return files.filter((filePath) => fs.existsSync(filePath) && fs.statSync(filePath).isFile()).sort((left, right) => left.localeCompare(right));
}

function docMetadata(text: string): Record<string, string> {
  const metadata: Record<string, string> = {};
  for (const line of text.split(/\r?\n/).slice(0, 40)) {
    const match = /^cellfence:([A-Za-z0-9_-]+):\s*(.+?)\s*$/.exec(line.trim());
    if (match) metadata[match[1]] = match[2];
  }
  return metadata;
}

export function checkDesignDocs(options: { rootDir?: string; manifest: CellFenceManifest; docPaths?: string[] }): DocsCheckResult {
  const rootDir = path.resolve(options.rootDir || process.cwd());
  const findings: AdvancedFinding[] = [];
  let checkedDocs = 0;
  for (const filePath of markdownFiles(rootDir, options.docPaths || [])) {
    const relativePath = repoPath(rootDir, filePath);
    const metadata = docMetadata(fs.readFileSync(filePath, "utf8"));
    if (!metadata.cell && !metadata.surfaceHash) continue;
    checkedDocs += 1;
    const cell = options.manifest.cells.find((candidate) => candidate.id === metadata.cell);
    if (!cell) {
      findings.push({ ruleId: "CELLFENCE_DOC_UNKNOWN_CELL", severity: "error", filePath: relativePath, message: `${relativePath} references unknown cell ${metadata.cell || "(missing)"}` });
      continue;
    }
    const currentHash = publicSurfaceHash(path.resolve(rootDir, cell.publicEntry));
    if (metadata.surfaceHash !== currentHash) {
      findings.push({ ruleId: "CELLFENCE_DOC_SURFACE_STALE", severity: "error", cellId: cell.id, filePath: relativePath, message: `${relativePath} surface hash is stale for ${cell.id}`, details: { expected: currentHash, actual: metadata.surfaceHash } });
    }
  }
  return { schemaVersion: "cellfence.docs-check.v1", ok: findings.length === 0, findings, checkedDocs };
}

export function stampDesignDoc(options: { rootDir?: string; manifest: CellFenceManifest; cellId: string; docPath: string }): DocsCheckResult {
  const rootDir = path.resolve(options.rootDir || process.cwd());
  const cell = options.manifest.cells.find((candidate) => candidate.id === options.cellId);
  if (!cell) {
    return { schemaVersion: "cellfence.docs-check.v1", ok: false, checkedDocs: 0, findings: [{ ruleId: "CELLFENCE_DOC_UNKNOWN_CELL", severity: "error", message: `unknown cell ${options.cellId}` }] };
  }
  const filePath = path.resolve(rootDir, options.docPath);
  const current = fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8") : "";
  const hash = publicSurfaceHash(path.resolve(rootDir, cell.publicEntry));
  const metadata = [`cellfence:cell: ${cell.id}`, `cellfence:surfaceHash: ${hash}`].join("\n");
  const next = current.includes("cellfence:cell:")
    ? current.replace(/^cellfence:cell:.*$/m, `cellfence:cell: ${cell.id}`).replace(/^cellfence:surfaceHash:.*$/m, `cellfence:surfaceHash: ${hash}`)
    : `${metadata}\n\n${current}`;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, next);
  return checkDesignDocs({ rootDir, manifest: options.manifest, docPaths: [options.docPath] });
}

type MutationCounts = { killed: number; survived: number; timeout: number; noCoverage: number; ignored: number };

function emptyMutationCounts(): MutationCounts {
  return { killed: 0, survived: 0, timeout: 0, noCoverage: 0, ignored: 0 };
}

function addMutationStatus(counts: MutationCounts, status: string): void {
  const normalized = status.toLowerCase();
  if (normalized === "killed") counts.killed += 1;
  else if (normalized === "survived") counts.survived += 1;
  else if (normalized === "timeout") counts.timeout += 1;
  else if (normalized === "nocoverage" || normalized === "no_coverage") counts.noCoverage += 1;
  else if (normalized === "ignored") counts.ignored += 1;
}

function collectMutants(input: unknown, currentFile: string | undefined, output: Array<{ file?: string; status: string }>): void {
  if (Array.isArray(input)) {
    for (const entry of input) collectMutants(entry, currentFile, output);
    return;
  }
  if (!isRecord(input)) return;
  const nextFile = typeof input.source === "string"
    ? input.source
    : typeof input.fileName === "string"
      ? input.fileName
      : typeof input.path === "string"
        ? input.path
        : currentFile;
  if (typeof input.status === "string") output.push({ file: nextFile, status: input.status });
  for (const [key, value] of Object.entries(input)) {
    const keyedFile = SOURCE_EXTENSIONS.includes(path.extname(key)) ? normalizePath(key) : nextFile;
    collectMutants(value, keyedFile, output);
  }
}

export function checkMutationReport(options: { rootDir?: string; manifest: CellFenceManifest; reportPath: string; minScore?: number }): MutationCheckResult {
  const rootDir = path.resolve(options.rootDir || process.cwd());
  const report = readJson(path.resolve(rootDir, options.reportPath));
  const mutants: Array<{ file?: string; status: string }> = [];
  collectMutants(report, undefined, mutants);
  const countsByCell = new Map<string, MutationCounts>();
  for (const mutant of mutants) {
    const filePath = mutant.file ? normalizePath(mutant.file) : "";
    const cell = options.manifest.cells.find((candidate) => candidate.ownedPaths.some((pattern) => matchesPattern(filePath, pattern)));
    if (!cell) continue;
    const counts = countsByCell.get(cell.id) || emptyMutationCounts();
    addMutationStatus(counts, mutant.status);
    countsByCell.set(cell.id, counts);
  }
  const cells: MutationCheckResult["cells"] = {};
  const findings: AdvancedFinding[] = [];
  const minScore = options.minScore ?? 0;
  for (const [cellId, counts] of [...countsByCell.entries()].sort((left, right) => left[0].localeCompare(right[0]))) {
    const denominator = counts.killed + counts.survived + counts.timeout + counts.noCoverage;
    const score = denominator === 0 ? 100 : (counts.killed / denominator) * 100;
    cells[cellId] = { ...counts, score };
    if (score < minScore) {
      findings.push({ ruleId: "CELLFENCE_MUTATION_SCORE_BELOW_THRESHOLD", severity: "error", cellId, message: `${cellId} mutation score ${score.toFixed(2)} is below ${minScore}`, details: counts });
    }
  }
  return { schemaVersion: "cellfence.mutation-check.v1", ok: findings.length === 0, findings, cells };
}

export function profileRuleSeverities(manifest: CellFenceManifest, profileName: string | undefined): RuleSeverityMap | undefined {
  if (!profileName) return undefined;
  return manifest.profiles?.[profileName]?.rules;
}

export function profileConfig(manifest: CellFenceManifest, profileName: string | undefined): CheckProfileManifest | undefined {
  return profileName ? manifest.profiles?.[profileName] : undefined;
}
