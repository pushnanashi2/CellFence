import crypto from "node:crypto";

import { stableCanonicalJson } from "./governance/canonicalization.js";
import { normalizePath } from "./file-index.js";
import type { Finding, SuggestedResolution } from "./types.js";

function normalizedFindingDetails(details: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!details) return undefined;
  const normalizedEntries = Object.entries(details)
    .filter(([key]) => !["message", "currentHash", "nextHash"].includes(key))
    .map(([key, value]) => [key, value] as const);
  return normalizedEntries.length > 0 ? Object.fromEntries(normalizedEntries) : undefined;
}

export function findingFingerprint(finding: Finding): string {
  return crypto
    .createHash("sha256")
    .update(stableCanonicalJson({
      ruleId: finding.ruleId,
      severity: finding.severity,
      filePath: finding.filePath ? normalizePath(finding.filePath) : undefined,
      cellId: finding.cellId,
      producerCellId: finding.producerCellId,
      details: normalizedFindingDetails(finding.details),
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
