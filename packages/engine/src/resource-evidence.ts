import fs from "node:fs";
import path from "node:path";

import {
  validateResourceEvidence,
  type CellFenceBaseline,
  type CellFenceResourceEvidence,
  type CellManifest,
} from "@cellfence/schema";

import { errorMessage } from "./errors.js";
import { addFinding, codeResolution, manifestResolution } from "./findings.js";
import { repoPath } from "./file-index.js";
import { readJsonFile } from "./json-file.js";
import { addResourceAccess, type ResourceAccessMode, type ResourceAccessReference } from "./resource-access.js";
import type { AnalysisContext, Finding } from "./types.js";

type ResourceEvidenceDependencies = {
  gitCommand(rootDir: string, args: string[]): string;
  resourceAccessDeclaredByBaseline(cell: CellManifest, baseline: CellFenceBaseline | undefined, access: ResourceAccessReference): boolean;
  resourceAccessDeclaredByManifest(cell: CellManifest, access: ResourceAccessReference): boolean;
  resourceAccessVerb(access: ResourceAccessMode): string;
  targetIsInsideRoot(rootDir: string, targetPath: string): boolean;
};

export function evidencePathsForOptions(rootDir: string, evidencePaths: string[] | undefined): string[] {
  return (evidencePaths || []).map((evidencePath) => path.resolve(rootDir, evidencePath));
}

function comparableRealPath(inputPath: string): string {
  const absolutePath = path.resolve(inputPath);
  let realPath: string;
  try {
    realPath = fs.realpathSync.native(absolutePath);
  } catch {
    try {
      realPath = fs.realpathSync(absolutePath);
    } catch {
      realPath = absolutePath;
    }
  }
  const normalized = path.normalize(realPath);
  if (process.platform !== "win32") return normalized;
  return normalized.replace(/^\\\\\?\\/, "").replace(/\\/g, "/").toLowerCase();
}

function gitHeadForExactRoot(rootDir: string, dependencies: ResourceEvidenceDependencies): string | undefined {
  try {
    const topLevel = dependencies.gitCommand(rootDir, ["rev-parse", "--show-toplevel"]);
    if (comparableRealPath(topLevel) !== comparableRealPath(rootDir)) return undefined;
    return dependencies.gitCommand(rootDir, ["rev-parse", "HEAD"]);
  } catch {
    return undefined;
  }
}

export function addAccessToCell(accessesByCell: Map<string, ResourceAccessReference[]>, cellId: string, access: ResourceAccessReference): void {
  const currentAccesses = accessesByCell.get(cellId) || [];
  addResourceAccess(currentAccesses, access);
  accessesByCell.set(cellId, currentAccesses);
}

export function resourceEvidenceAccesses(
  context: AnalysisContext,
  evidencePaths: string[],
  findings: Finding[],
  baseline: CellFenceBaseline | undefined,
  dependencies: ResourceEvidenceDependencies,
): Map<string, ResourceAccessReference[]> {
  const accessesByCell = new Map<string, ResourceAccessReference[]>();
  const headCommit = gitHeadForExactRoot(context.rootDir, dependencies);
  for (const evidencePath of evidencePaths) {
    const evidenceRealPath = fs.existsSync(evidencePath) ? fs.realpathSync(evidencePath) : path.resolve(evidencePath);
    if (!dependencies.targetIsInsideRoot(context.rootDir, evidenceRealPath)) {
      addFinding(findings, {
        ruleId: "CELLFENCE_RESOURCE_EVIDENCE_INVALID",
        severity: "error",
        filePath: repoPath(context.rootDir, evidencePath),
        message: `resource evidence path is outside the repository: ${repoPath(context.rootDir, evidencePath)}`,
      });
      continue;
    }

    let evidence: CellFenceResourceEvidence;
    try {
      const validation = validateResourceEvidence(readJsonFile(evidencePath));
      if (!validation.ok || !validation.value) {
        addFinding(findings, {
          ruleId: "CELLFENCE_RESOURCE_EVIDENCE_INVALID",
          severity: "error",
          filePath: repoPath(context.rootDir, evidencePath),
          message: `resource evidence is invalid: ${validation.errors.join("; ")}`,
        });
        continue;
      }
      evidence = validation.value;
    } catch (error) {
      addFinding(findings, {
        ruleId: "CELLFENCE_RESOURCE_EVIDENCE_INVALID",
        severity: "error",
        filePath: repoPath(context.rootDir, evidencePath),
        message: `failed to read resource evidence: ${errorMessage(error)}`,
      });
      continue;
    }

    if (headCommit && evidence.commitSha && evidence.commitSha !== headCommit) {
      addFinding(findings, {
        ruleId: "CELLFENCE_RESOURCE_EVIDENCE_INVALID",
        severity: "error",
        filePath: repoPath(context.rootDir, evidencePath),
        message: `resource evidence commitSha ${evidence.commitSha} does not match repository HEAD ${headCommit}`,
        details: { evidenceCommitSha: evidence.commitSha, headCommit },
      });
      continue;
    }

    for (const [entryIndex, entry] of evidence.accesses.entries()) {
      const cellId = entry.cellId || evidence.cellId;
      if (!cellId || !context.cellsById.has(cellId)) {
        addFinding(findings, {
          ruleId: "CELLFENCE_RESOURCE_EVIDENCE_INVALID",
          severity: "error",
          filePath: repoPath(context.rootDir, evidencePath),
          message: `resource evidence access ${entryIndex} references unknown cell ${cellId || "(missing)"}`,
          details: { entryIndex, cellId },
        });
        continue;
      }

      const cell = context.cellsById.get(cellId) as CellManifest;
      const access: ResourceAccessReference = {
        kind: entry.kind,
        access: entry.access,
        selector: entry.selector,
        filePath: repoPath(context.rootDir, evidencePath),
        line: 1,
        source: entry.detectedBy || "resource-evidence",
        detectedBy: entry.detectedBy || "runtime-evidence",
        confidence: entry.confidence || "runtime",
      };
      addAccessToCell(accessesByCell, cellId, access);

      if (
        dependencies.resourceAccessDeclaredByManifest(cell, access)
        || dependencies.resourceAccessDeclaredByBaseline(cell, baseline, access)
      ) {
        continue;
      }
      addFinding(findings, {
        ruleId: "CELLFENCE_UNDECLARED_RESOURCE_ACCESS",
        severity: "error",
        cellId,
        filePath: access.filePath,
        message: `${cellId} ${dependencies.resourceAccessVerb(access.access)} undeclared runtime ${access.kind} resource ${access.selector}`,
        details: {
          kind: access.kind,
          access: access.access,
          selector: access.selector,
          source: access.source,
          detectedBy: access.detectedBy,
          confidence: access.confidence,
        },
        suggestedResolutions: [
          codeResolution(`Stop emitting runtime evidence for undeclared ${access.kind} access if it is accidental`, {
            kind: access.kind,
            access: access.access,
            selector: access.selector,
          }),
          manifestResolution(`Declare runtime ${access.kind} ${access.access} access for ${access.selector}`, Boolean(cell.locked), {
            cell: cell.id,
            resourceContract: {
              kind: access.kind,
              access: [access.access],
              selectors: [access.selector],
            },
          }),
        ],
      });
    }
  }
  return accessesByCell;
}

export function mergeAccessesByCell(target: Map<string, ResourceAccessReference[]>, source: Map<string, ResourceAccessReference[]>): void {
  for (const [cellId, accesses] of source.entries()) {
    for (const access of accesses) {
      addAccessToCell(target, cellId, access);
    }
  }
}
