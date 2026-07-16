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

export type EvidenceAssessmentOptions = {
  requiredFamilies: ObservationFamily[];
};

function observationKey(observation: FileObservation): string {
  return `${observation.filePath}:${observation.family}`;
}

function addDefect(defects: EvidenceDefect[], defect: EvidenceDefect): void {
  defects.push(defect);
}

export function assessEvidence(
  snapshot: SubjectSnapshot,
  report: RawObservationReport,
  options: EvidenceAssessmentOptions,
): EvidenceAssessment {
  const defects: EvidenceDefect[] = [];
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
  const observedFiles = new Set<string>();
  for (const observation of report.statuses) {
    if (!snapshotFiles.has(observation.filePath)) {
      addDefect(defects, {
        code: "UNKNOWN_OBSERVED_FILE",
        filePath: observation.filePath,
        family: observation.family,
        message: `observation references file outside the subject snapshot: ${observation.filePath}`,
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
    observedFiles.add(observation.filePath);
    if (observation.status === "parse-error") {
      addDefect(defects, {
        code: "PARSE_ERROR",
        filePath: observation.filePath,
        family: observation.family,
        message: observation.message || `parse error while observing ${observation.filePath}`,
      });
    }
    if (observation.status === "unsupported") {
      addDefect(defects, {
        code: "UNSUPPORTED_OBSERVATION",
        filePath: observation.filePath,
        family: observation.family,
        message: observation.message || `unsupported observation for ${observation.filePath}`,
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

  const observedFamilies = observationFamiliesForReport(report);
  const observedFamilySet = new Set<ObservationFamily>(observedFamilies);
  for (const family of options.requiredFamilies) {
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
    defects,
    observedFamilies,
  };
}
