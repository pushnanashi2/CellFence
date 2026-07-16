import type {
  FileObservation,
  ObservationFamily,
  RawObservationReport,
  SubjectSnapshot,
} from "./model.js";

export type RawObservationReportInput = {
  observer: string;
  snapshot: SubjectSnapshot;
  statuses: FileObservation[];
  importObservationCount?: number;
  resourceObservationCount?: number;
  publicSurfaceObservationCount?: number;
};

function sortObservation(left: FileObservation, right: FileObservation): number {
  return `${left.filePath}:${left.family}:${left.status}:${left.message || ""}`
    .localeCompare(`${right.filePath}:${right.family}:${right.status}:${right.message || ""}`);
}

export function createRawObservationReport(input: RawObservationReportInput): RawObservationReport {
  return {
    schemaVersion: "cellfence.raw-observation.v1",
    observer: input.observer,
    snapshotDigest: input.snapshot.snapshotDigest,
    statuses: [...input.statuses].sort(sortObservation),
    importObservationCount: input.importObservationCount || 0,
    resourceObservationCount: input.resourceObservationCount || 0,
    publicSurfaceObservationCount: input.publicSurfaceObservationCount || 0,
  };
}

export function observationFamiliesForReport(report: RawObservationReport): ObservationFamily[] {
  const families = new Set<ObservationFamily>();
  for (const status of report.statuses) families.add(status.family);
  if (report.importObservationCount > 0) families.add("imports");
  if (report.resourceObservationCount > 0) families.add("resources");
  if (report.publicSurfaceObservationCount > 0) families.add("public-surface");
  return [...families].sort((left, right) => left.localeCompare(right));
}
