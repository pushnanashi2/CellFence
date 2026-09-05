import type {
  EvidenceAssessment,
  EvidenceDefect,
  FileObservation,
  ObservationFamily,
  RawObservationReport,
  SubjectSnapshot,
} from "./model.js";
import { observationFamiliesForReport } from "./observation-report.js";
import { verifySubjectSnapshotIntegrity } from "./subject-snapshot.js";

export type ObservationRequirement = {
  filePath: string;
  family: ObservationFamily;
  reason?: string;
};

type RequiredObservationDefect = Omit<EvidenceDefect, "code"> & {
  code: "MISSING_REQUIRED_OBSERVATION";
};

type InternalEvidenceDefect = EvidenceDefect | RequiredObservationDefect;

export type EvidenceAssessmentWithRequirements = EvidenceAssessment & {
  requiredObservations: ObservationRequirement[];
};

export type EvidenceAssessmentOptions = {
  requiredFamilies?: ObservationFamily[];
  requiredObservations?: ObservationRequirement[];
};

function observationKey(observation: FileObservation): string {
  return `${normalizeEvidencePath(observation.filePath)}:${observation.family}`;
}

function requirementKey(requirement: ObservationRequirement): string {
  return `${normalizeEvidencePath(requirement.filePath)}:${requirement.family}`;
}

function normalizeEvidencePath(filePath: string): string {
  return filePath.replace(/\\/g, "/").replace(/^\.\//, "");
}

function sortedRequirements(requirements: ObservationRequirement[] | undefined): ObservationRequirement[] {
  const byKey = new Map<string, ObservationRequirement>();
  for (const requirement of requirements || []) {
    const normalized = {
      ...requirement,
      filePath: normalizeEvidencePath(requirement.filePath),
    };
    byKey.set(requirementKey(normalized), normalized);
  }
  return [...byKey.values()].sort((left, right) =>
    `${left.filePath}:${left.family}:${left.reason || ""}`.localeCompare(`${right.filePath}:${right.family}:${right.reason || ""}`));
}

function addDefect(defects: InternalEvidenceDefect[], defect: InternalEvidenceDefect): void {
  defects.push(defect);
}

export function assessEvidence(
  snapshot: SubjectSnapshot,
  report: RawObservationReport,
  options: EvidenceAssessmentOptions,
): EvidenceAssessmentWithRequirements {
  const defects: InternalEvidenceDefect[] = [];
  if (report.snapshotDigest !== snapshot.snapshotDigest) {
    addDefect(defects, {
      code: "SNAPSHOT_DIGEST_MISMATCH",
      message: "raw observation report targets a different subject snapshot",
    });
  }
  if (!verifySubjectSnapshotIntegrity(snapshot)) {
    addDefect(defects, {
      code: "SNAPSHOT_INTEGRITY_MISMATCH",
      message: "subject snapshot digest does not match its file entries",
    });
  }

  const snapshotFiles = new Set(snapshot.files.map((file) => file.path));
  const seenObservations = new Set<string>();
  const observationByRequirement = new Map<string, FileObservation>();
  const observedFiles = new Set<string>();
  for (const observation of report.statuses) {
    const normalizedFilePath = normalizeEvidencePath(observation.filePath);
    if (!snapshotFiles.has(normalizedFilePath)) {
      addDefect(defects, {
        code: "UNKNOWN_OBSERVED_FILE",
        filePath: normalizedFilePath,
        family: observation.family,
        message: `observation references file outside the subject snapshot: ${normalizedFilePath}`,
      });
    }
    const key = observationKey(observation);
    if (seenObservations.has(key)) {
      addDefect(defects, {
        code: "DUPLICATE_FILE_OBSERVATION",
        filePath: observation.filePath,
        family: observation.family,
        message: `duplicate observation for ${observation.filePath} in ${observation.family}`,
      });
    }
    seenObservations.add(key);
    if (!observationByRequirement.has(key)) observationByRequirement.set(key, { ...observation, filePath: normalizedFilePath });
    observedFiles.add(normalizedFilePath);
    if (observation.status === "parse-error") {
      addDefect(defects, {
        code: "PARSE_ERROR",
        filePath: normalizedFilePath,
        family: observation.family,
        message: observation.message || `parse error while observing ${normalizedFilePath}`,
      });
    }
    if (observation.status === "unsupported") {
      addDefect(defects, {
        code: "UNSUPPORTED_OBSERVATION",
        filePath: normalizedFilePath,
        family: observation.family,
        message: observation.message || `unsupported observation for ${normalizedFilePath}`,
      });
    }
  }

  for (const file of snapshot.files) {
    if (observedFiles.has(file.path)) continue;
    addDefect(defects, {
      code: "MISSING_FILE_OBSERVATION",
      filePath: file.path,
      message: `subject file has no terminal observation: ${file.path}`,
    });
  }

  const requiredObservations = sortedRequirements(options.requiredObservations);
  for (const requirement of requiredObservations) {
    const observed = observationByRequirement.get(requirementKey(requirement));
    if (!observed) {
      addDefect(defects, {
        code: "MISSING_REQUIRED_OBSERVATION",
        filePath: requirement.filePath,
        family: requirement.family,
        message: `required ${requirement.family} observation is missing for ${requirement.filePath}${requirement.reason ? ` (${requirement.reason})` : ""}`,
      });
      continue;
    }
    if (observed.status === "not-applicable") {
      addDefect(defects, {
        code: "MISSING_REQUIRED_OBSERVATION",
        filePath: requirement.filePath,
        family: requirement.family,
        message: `required ${requirement.family} observation for ${requirement.filePath} was reported not-applicable${requirement.reason ? ` (${requirement.reason})` : ""}`,
      });
    }
  }

  const observedFamilies = observationFamiliesForReport(report);
  const observedFamilySet = new Set<ObservationFamily>(observedFamilies);
  for (const family of options.requiredFamilies || []) {
    if (observedFamilySet.has(family)) continue;
    addDefect(defects, {
      code: "MISSING_OBSERVATION_FAMILY",
      family,
      message: `required observation family is missing: ${family}`,
    });
  }

  return {
    schemaVersion: "cellfence.evidence-assessment.v1",
    snapshotDigest: snapshot.snapshotDigest,
    status: defects.length === 0 ? "COMPLETE" : "INCOMPLETE",
    defects: defects as EvidenceDefect[],
    observedFamilies,
    requiredObservations,
  };
}
