import crypto from "node:crypto";

import { stableCanonicalJson } from "./governance/canonicalization.js";
import { normalizePath } from "./file-index.js";
import type { Finding, SuggestedResolution } from "./types.js";

export const FINDING_FINGERPRINT_VERSION = "cellfence.finding-fingerprint.v1";

function fingerprintDetails(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(fingerprintDetails);
  if (!value || typeof value !== "object") return value;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([key]) => key !== "line" && key !== "offset")
    .map(([key, entryValue]) => [key, fingerprintDetails(entryValue)]);
  return Object.fromEntries(entries);
}

export function findingFingerprint(finding: Finding): string {
  return crypto
    .createHash("sha256")
    .update(stableCanonicalJson({
      fingerprintVersion: FINDING_FINGERPRINT_VERSION,
      ruleId: finding.ruleId,
      severity: finding.severity,
      filePath: finding.filePath ? normalizePath(finding.filePath) : undefined,
      cellId: finding.cellId,
      producerCellId: finding.producerCellId,
      details: fingerprintDetails(finding.details),
    }))
    .digest("hex");
}

export function withFindingFingerprint(finding: Finding): Finding {
  return {
    ...finding,
    fingerprint: finding.fingerprint || findingFingerprint(finding),
  };
}

export function addFinding(findings: Finding[], finding: Finding): void {
  findings.push(withFindingFingerprint(finding));
}

export function codeResolution(title: string, details?: Record<string, unknown>): SuggestedResolution {
  return { kind: "change-code", title, approvalRequired: false, details };
}

export function manifestResolution(title: string, approvalRequired: boolean, details?: Record<string, unknown>): SuggestedResolution {
  return { kind: "change-manifest", title, approvalRequired, details };
}

export function baselineResolution(title: string, approvalRequired: boolean, details?: Record<string, unknown>): SuggestedResolution {
  return { kind: "update-baseline", title, approvalRequired, details };
}

export function humanResolution(title: string, details?: Record<string, unknown>): SuggestedResolution {
  return { kind: "ask-human", title, approvalRequired: true, details };
}
