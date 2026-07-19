import fs from "node:fs";
import path from "node:path";

import {
  absolutePath,
  normalizePath,
  repoPath,
  sourceFilesForCell,
  sourceFilesUnderGovernance,
} from "../file-index.js";
import type { ResourceAccessReference } from "../resource-access.js";
import type { AnalysisContext, PluginImportReference } from "../types.js";
import { assessEvidence } from "./evidence-assessment.js";
import type {
  EvidenceAssessment,
  FileObservation,
  ObservationFamily,
  RawObservationReport,
  SubjectSnapshot,
} from "./model.js";
import { createRawObservationReport } from "./observation-report.js";
import { createSubjectSnapshotFromFiles, type SubjectSnapshotInputFile } from "./subject-snapshot.js";

function addGovernanceSubjectFile(
  subjectFiles: Map<string, SubjectSnapshotInputFile>,
  rootDir: string,
  relativePath: string,
  role: SubjectSnapshotInputFile["role"],
): void {
  const normalizedPath = normalizePath(relativePath);
  if (subjectFiles.has(normalizedPath)) return;
  const absoluteFilePath = absolutePath(rootDir, normalizedPath);
  if (!fs.existsSync(absoluteFilePath) || !fs.statSync(absoluteFilePath).isFile()) return;
  subjectFiles.set(normalizedPath, {
    path: normalizedPath,
    content: fs.readFileSync(absoluteFilePath, "utf8"),
    role,
  });
}

function governanceSubjectFiles(
  context: AnalysisContext,
  manifestPath: string,
  baselinePath: string | undefined,
  evidencePaths: string[],
): SubjectSnapshotInputFile[] {
  const subjectFiles = new Map<string, SubjectSnapshotInputFile>();
  addGovernanceSubjectFile(subjectFiles, context.rootDir, repoPath(context.rootDir, manifestPath), "manifest");
  if (baselinePath) addGovernanceSubjectFile(subjectFiles, context.rootDir, repoPath(context.rootDir, baselinePath), "baseline");
  const tsconfigPath = path.join(context.rootDir, "tsconfig.json");
  addGovernanceSubjectFile(subjectFiles, context.rootDir, repoPath(context.rootDir, tsconfigPath), "config");
  for (const evidencePath of evidencePaths) addGovernanceSubjectFile(subjectFiles, context.rootDir, repoPath(context.rootDir, evidencePath), "runtime-evidence");
  for (const cell of context.manifest.cells) {
    for (const sourceFilePath of sourceFilesForCell(context.rootDir, cell, context)) {
      addGovernanceSubjectFile(subjectFiles, context.rootDir, repoPath(context.rootDir, sourceFilePath), "source");
    }
  }
  for (const governedFilePath of sourceFilesUnderGovernance(context.rootDir, context.manifest, context)) {
    addGovernanceSubjectFile(subjectFiles, context.rootDir, repoPath(context.rootDir, governedFilePath), "source");
  }
  return [...subjectFiles.values()].sort((left, right) => left.path.localeCompare(right.path));
}

function requiredGovernanceFamilies(baselinePath: string | undefined): ObservationFamily[] {
  const families: ObservationFamily[] = ["manifest", "ownership", "public-surface", "imports", "resources"];
  if (baselinePath) families.push("baseline");
  return families;
}

export type GovernanceEvidenceEnvelope = {
  snapshot: SubjectSnapshot;
  report: RawObservationReport;
  assessment: EvidenceAssessment;
};

export function governanceEvidenceEnvelopeForCheck(
  context: AnalysisContext,
  manifestPath: string,
  baselinePath: string | undefined,
  evidencePaths: string[],
  observedImports: PluginImportReference[],
  accessesByCell: Map<string, ResourceAccessReference[]>,
): GovernanceEvidenceEnvelope {
  const snapshot = createSubjectSnapshotFromFiles(governanceSubjectFiles(context, manifestPath, baselinePath, evidencePaths));
  const statuses: FileObservation[] = snapshot.files.flatMap((file): FileObservation[] => {
    if (file.role === "manifest") {
      return [
        { filePath: file.path, family: "manifest" as const, status: "processed" as const },
        { filePath: file.path, family: "ownership" as const, status: "processed" as const },
      ];
    }
    if (file.role === "baseline") return [{ filePath: file.path, family: "baseline" as const, status: "processed" as const }];
    if (file.role === "runtime-evidence") return [{ filePath: file.path, family: "resources" as const, status: "processed" as const }];
    if (file.role === "source") {
      return [
        { filePath: file.path, family: "imports" as const, status: "processed" as const },
        { filePath: file.path, family: "public-surface" as const, status: "processed" as const },
        { filePath: file.path, family: "resources" as const, status: "processed" as const },
      ];
    }
    return [{ filePath: file.path, family: "imports" as const, status: "not-applicable" as const }];
  });
  const resourceObservationCount = [...accessesByCell.values()].reduce(
    (count, accesses) => count + accesses.length,
    0,
  );
  const report = createRawObservationReport({
    observer: "cellfence-engine",
    snapshot,
    statuses,
    importObservationCount: observedImports.length,
    resourceObservationCount,
    publicSurfaceObservationCount: context.manifest.cells.length,
  });
  return {
    snapshot,
    report,
    assessment: assessEvidence(snapshot, report, { requiredFamilies: requiredGovernanceFamilies(baselinePath) }),
  };
}
