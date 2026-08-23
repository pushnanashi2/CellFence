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
import type { AnalysisContext, Finding, PluginImportReference } from "../types.js";
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

function diagnosticsByFile(diagnostics: Finding[]): Map<string, Finding[]> {
  const byFile = new Map<string, Finding[]>();
  for (const finding of diagnostics) {
    if (!finding.filePath) continue;
    const filePath = normalizePath(finding.filePath);
    const bucket = byFile.get(filePath) ?? [];
    bucket.push(finding);
    byFile.set(filePath, bucket);
  }
  return byFile;
}

function observationStatusFor(filePath: string, family: ObservationFamily, diagnostics: Map<string, Finding[]>): FileObservation {
  const fileDiagnostics = diagnostics.get(normalizePath(filePath)) ?? [];
  if (family === "imports") {
    const syntax = fileDiagnostics.find((finding) =>
      finding.ruleId === "CELLFENCE_UNSUPPORTED_TYPESCRIPT_SYNTAX"
      || finding.ruleId === "CELLFENCE_UNSUPPORTED_PYTHON_SYNTAX");
    if (syntax) return { filePath, family, status: "parse-error", message: syntax.message };
    const unsupported = fileDiagnostics.find((finding) =>
      finding.ruleId === "CELLFENCE_UNSUPPORTED_DYNAMIC_IMPORT"
      || finding.ruleId === "CELLFENCE_UNSUPPORTED_DYNAMIC_REQUIRE"
      || finding.ruleId === "CELLFENCE_UNRESOLVED_IMPORT"
      || finding.ruleId === "CELLFENCE_IMPORT_TARGET_OUTSIDE_ROOT"
      || finding.ruleId === "CELLFENCE_UNRESOLVED_REQUIRE");
    if (unsupported) return { filePath, family, status: "unsupported", message: unsupported.message };
  }
  if (family === "resources") {
    const unsupported = fileDiagnostics.find((finding) =>
      finding.ruleId === "CELLFENCE_RESOURCE_EVIDENCE_INVALID"
      || finding.ruleId === "CELLFENCE_RESOURCE_EVIDENCE_TRANSCRIPT_INACTIVE"
      || finding.ruleId === "CELLFENCE_RESOURCE_EVIDENCE_TRANSCRIPT_INCOMPLETE");
    if (unsupported) return { filePath, family, status: "unsupported", message: unsupported.message };
  }
  return { filePath, family, status: "processed" };
}

export type GovernanceEvidenceEnvelope = {
  snapshot: SubjectSnapshot;
  report: RawObservationReport;
  assessment: EvidenceAssessment;
};

type ObservedFilesByFamily = Partial<Record<ObservationFamily, Iterable<string>>>;

function normalizedObservedFiles(files: Iterable<string> | undefined): Set<string> {
  const result = new Set<string>();
  if (!files) return result;
  for (const file of files) result.add(normalizePath(file));
  return result;
}

function sourceObservationStatusFor(
  filePath: string,
  family: ObservationFamily,
  observedFiles: Set<string>,
  diagnostics: Map<string, Finding[]>,
): FileObservation {
  const diagnosticStatus = observationStatusFor(filePath, family, diagnostics);
  if (diagnosticStatus.status !== "processed") return diagnosticStatus;
  if (observedFiles.has(normalizePath(filePath))) return diagnosticStatus;
  if (family === "public-surface") return { filePath, family, status: "not-applicable" };
  return {
    filePath,
    family,
    status: "unsupported",
    message: `${family} analysis did not record an observation for ${filePath}`,
  };
}

export function governanceEvidenceEnvelopeForCheck(
  context: AnalysisContext,
  manifestPath: string,
  baselinePath: string | undefined,
  evidencePaths: string[],
  observedImports: PluginImportReference[],
  accessesByCell: Map<string, ResourceAccessReference[]>,
  diagnostics: Finding[] = [],
  observedFilesByFamily: ObservedFilesByFamily = {},
): GovernanceEvidenceEnvelope {
  const snapshot = createSubjectSnapshotFromFiles(governanceSubjectFiles(context, manifestPath, baselinePath, evidencePaths));
  const diagnosticIndex = diagnosticsByFile(diagnostics);
  const observedImportFiles = normalizedObservedFiles(observedFilesByFamily.imports);
  for (const observedImport of observedImports) observedImportFiles.add(normalizePath(observedImport.importerPath));
  const observedResourceFiles = normalizedObservedFiles(observedFilesByFamily.resources);
  for (const accesses of accessesByCell.values()) {
    for (const access of accesses) observedResourceFiles.add(normalizePath(access.filePath));
  }
  const observedPublicSurfaceFiles = normalizedObservedFiles(observedFilesByFamily["public-surface"]);
  const statuses: FileObservation[] = snapshot.files.flatMap((file): FileObservation[] => {
    if (file.role === "manifest") {
      return [
        { filePath: file.path, family: "manifest" as const, status: "processed" as const },
        { filePath: file.path, family: "ownership" as const, status: "processed" as const },
      ];
    }
    if (file.role === "baseline") return [{ filePath: file.path, family: "baseline" as const, status: "processed" as const }];
    if (file.role === "runtime-evidence") return [observationStatusFor(file.path, "resources", diagnosticIndex)];
    if (file.role === "source") {
      return [
        sourceObservationStatusFor(file.path, "imports", observedImportFiles, diagnosticIndex),
        sourceObservationStatusFor(file.path, "public-surface", observedPublicSurfaceFiles, diagnosticIndex),
        sourceObservationStatusFor(file.path, "resources", observedResourceFiles, diagnosticIndex),
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
    publicSurfaceObservationCount: observedPublicSurfaceFiles.size,
  });
  return {
    snapshot,
    report,
    assessment: assessEvidence(snapshot, report, { requiredFamilies: requiredGovernanceFamilies(baselinePath) }),
  };
}
