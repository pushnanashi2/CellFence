import type { SubjectFile, SubjectFileRole, SubjectSnapshot } from "./model.js";
import { stableDigest, sha256Hex } from "./canonicalization.js";

export type SubjectSnapshotInputFile = {
  path: string;
  content: string;
  role: SubjectFileRole;
};

function normalizeSubjectPath(filePath: string): string {
  return filePath.replace(/\\/g, "/").replace(/^\.\/+/, "");
}

function subjectFileSortKey(file: Pick<SubjectFile, "path" | "role">): string {
  return `${file.path}:${file.role}`;
}

export function createSubjectSnapshotFromFiles(files: SubjectSnapshotInputFile[]): SubjectSnapshot {
  const subjectFiles = files
    .map((file): SubjectFile => ({
      path: normalizeSubjectPath(file.path),
      role: file.role,
      digest: sha256Hex(file.content),
      size: file.content.length,
    }))
    .sort((left, right) => subjectFileSortKey(left).localeCompare(subjectFileSortKey(right)));
  return {
    schemaVersion: "cellfence.governance-subject.v1",
    files: subjectFiles,
    snapshotDigest: stableDigest({ files: subjectFiles }),
  };
}

export function verifySubjectSnapshotIntegrity(snapshot: SubjectSnapshot): boolean {
  return snapshot.snapshotDigest === stableDigest({ files: snapshot.files });
}
