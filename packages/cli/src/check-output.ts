import crypto from "node:crypto";

import {
  formatHumanResult,
  type CheckResult,
  type Finding,
} from "@cellfence/engine";

export type CheckRunMetadata = {
  command: string;
  runId: string;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  commit: string | null;
};

export type CheckOutputFormat = "human" | "json" | "markdown" | "sarif";

type CheckOutputOptions = {
  json: boolean;
  format?: string;
};

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item)).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
}

export function findingFingerprint(finding: Finding): string {
  /* c8 ignore next -- CLI cannot currently load plugins that emit precomputed finding fingerprints. */
  if (finding.fingerprint) return finding.fingerprint;
  return crypto.createHash("sha256").update(stableJson({
    ruleId: finding.ruleId,
    severity: finding.severity,
    filePath: finding.filePath,
    cellId: finding.cellId,
    producerCellId: finding.producerCellId,
    details: finding.details,
  })).digest("hex");
}

function countBy<T extends string>(values: T[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const value of values) counts[value] = (counts[value] || 0) + 1;
  return counts;
}

export function checkSummary(result: CheckResult, metadata: CheckRunMetadata): Record<string, unknown> {
  const allFindings = [...result.findings, ...result.warnings];
  const cells = allFindings.map((finding) => finding.cellId).filter((cellId): cellId is string => Boolean(cellId));
  return {
    schemaVersion: "cellfence.summary.v1",
    runId: metadata.runId,
    command: metadata.command,
    commit: metadata.commit,
    startedAt: metadata.startedAt,
    completedAt: metadata.completedAt,
    durationMs: metadata.durationMs,
    ok: result.ok,
    exitCode: result.exitCode,
    counts: {
      findings: result.findings.length,
      warnings: result.warnings.length,
      changedFiles: result.changedFiles?.length || 0,
      baseFindings: result.baseFindingCount,
      impactedCells: new Set(cells).size,
    },
    failedRules: [...new Set(result.findings.map((finding) => finding.ruleId))].sort(),
    warningRules: [...new Set(result.warnings.map((finding) => finding.ruleId))].sort(),
    findingsByRule: countBy(result.findings.map((finding) => finding.ruleId)),
    warningsByRule: countBy(result.warnings.map((finding) => finding.ruleId)),
    findingsByCell: countBy(cells),
    findingFingerprints: result.findings.map((finding) => findingFingerprint(finding)),
    warningFingerprints: result.warnings.map((finding) => findingFingerprint(finding)),
  };
}

export function checkOutputFormat(options: CheckOutputOptions): CheckOutputFormat | undefined {
  if (options.json && options.format) return undefined;
  if (options.json) return "json";
  if (!options.format) return "human";
  if (options.format === "markdown" || options.format === "sarif") return options.format;
  return undefined;
}

function findingLine(finding: Finding): number | undefined {
  const line = finding.details?.line;
  return typeof line === "number" && Number.isInteger(line) && line > 0 ? line : undefined;
}

function findingLocation(finding: Finding): string {
  const line = findingLine(finding);
  if (!finding.filePath) return "(repository)";
  return line ? `${finding.filePath}:${line}` : finding.filePath;
}

function markdownTableCell(value: unknown): string {
  return String(value ?? "")
    .replace(/\|/g, "\\|")
    .replace(/\r?\n/g, "<br>")
    .trim();
}

function formatCheckResultMarkdown(result: CheckResult, metadata: CheckRunMetadata): string {
  const summary = checkSummary(result, metadata);
  const allFindings = [...result.findings, ...result.warnings];
  const lines: string[] = [];
  lines.push("# CellFence Check");
  lines.push("");
  lines.push(`**Result:** ${result.ok ? "passed" : "failed"}`);
  lines.push("");
  lines.push("| Metric | Value |");
  lines.push("|---|---:|");
  lines.push(`| Findings | ${result.findings.length} |`);
  lines.push(`| Warnings | ${result.warnings.length} |`);
  lines.push(`| Changed files | ${result.changedFiles?.length || 0} |`);
  lines.push(`| Impacted cells | ${(summary.counts as Record<string, number>).impactedCells || 0} |`);
  lines.push(`| Duration | ${metadata.durationMs} ms |`);
  if (metadata.commit) lines.push(`| Commit | \`${metadata.commit}\` |`);
  if (result.baseFindingCount !== undefined) lines.push(`| Baseline findings | ${result.baseFindingCount} |`);
  lines.push("");
  if (allFindings.length === 0) {
    lines.push("No CellFence findings.");
  } else {
    lines.push("| Severity | Rule | Location | Cell | Message |");
    lines.push("|---|---|---|---|---|");
    for (const finding of allFindings) {
      lines.push([
        finding.severity,
        `\`${finding.ruleId}\``,
        findingLocation(finding),
        finding.cellId || "",
        finding.message,
      ].map(markdownTableCell).join(" | ").replace(/^/, "| ").replace(/$/, " |"));
    }
  }
  return lines.join("\n");
}

function sarifLevel(finding: Finding): "error" | "warning" {
  return finding.severity === "error" ? "error" : "warning";
}

function formatCheckResultSarif(result: CheckResult, metadata: CheckRunMetadata): string {
  const allFindings = [...result.findings, ...result.warnings];
  const ruleIds = [...new Set(allFindings.map((finding) => finding.ruleId))].sort((left, right) => left.localeCompare(right));
  const sarifResults = allFindings.map((finding) => {
    const line = findingLine(finding);
    const sarifResult: Record<string, unknown> = {
      ruleId: finding.ruleId,
      level: sarifLevel(finding),
      message: { text: finding.message },
      partialFingerprints: {
        cellfence: findingFingerprint(finding),
      },
      properties: {
        severity: finding.severity,
        cellId: finding.cellId,
        producerCellId: finding.producerCellId,
        details: finding.details,
      },
    };
    if (finding.filePath) {
      sarifResult.locations = [{
        physicalLocation: {
          artifactLocation: { uri: finding.filePath },
          ...(line ? { region: { startLine: line } } : {}),
        },
      }];
    }
    return sarifResult;
  });
  return `${JSON.stringify({
    version: "2.1.0",
    $schema: "https://json.schemastore.org/sarif-2.1.0.json",
    runs: [{
      tool: {
        driver: {
          name: "CellFence",
          informationUri: "https://github.com/pushnanashi2/CellFence",
          rules: ruleIds.map((ruleId) => ({
            id: ruleId,
            name: ruleId,
            shortDescription: { text: ruleId },
          })),
        },
      },
      invocations: [{
        executionSuccessful: result.exitCode !== 3,
        startTimeUtc: metadata.startedAt,
        endTimeUtc: metadata.completedAt,
        properties: {
          command: metadata.command,
          runId: metadata.runId,
          commit: metadata.commit,
          durationMs: metadata.durationMs,
          ok: result.ok,
        },
      }],
      results: sarifResults,
    }],
  }, null, 2)}\n`;
}

export function printCheckResult(format: CheckOutputFormat, result: CheckResult, metadata: CheckRunMetadata): void {
  if (format === "json") console.log(JSON.stringify(result, null, 2));
  else if (format === "markdown") console.log(formatCheckResultMarkdown(result, metadata));
  else if (format === "sarif") process.stdout.write(formatCheckResultSarif(result, metadata));
  else console.log(formatHumanResult(result));
}
