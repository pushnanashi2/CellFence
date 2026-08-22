// SARIF writer for the coverage command. The reporter converts a
// CoverageReport into the SARIF 2.1.0 shape so the output can be
// uploaded to GitHub Code Scanning. We render a single run with one
// result per unresolved observation; the rule id is
// `CELLFENCE_COVERAGE_<KIND>` so users can filter on kind in the Code
// Scanning UI.

import type { CoverageReport, CoverageUnresolved } from "@cellfence/engine";

type SarifLog = {
  $schema: string;
  version: "2.1.0";
  runs: SarifRun[];
};

type SarifRun = {
  tool: {
    driver: {
      name: string;
      version: string;
      informationUri: string;
      rules: SarifRule[];
    };
  };
  results: SarifResult[];
};

type SarifRule = {
  id: string;
  name: string;
  shortDescription: { text: string };
  fullDescription: { text: string };
  defaultConfiguration: { level: "warning" | "note" };
};

type SarifResult = {
  ruleId: string;
  level: "warning" | "note";
  message: { text: string };
  locations?: SarifLocation[];
};

type SarifLocation = {
  physicalLocation: {
    artifactLocation: { uri: string };
    region?: { startLine?: number };
  };
};

const RULE_PREFIX = "CELLFENCE_COVERAGE_";
const KIND_TO_LEVEL: Record<CoverageUnresolved["kind"], SarifRule["defaultConfiguration"]["level"]> = {
  "import": "warning",
  "resource": "warning",
  "public-surface": "note",
};

function ruleIdForKind(kind: CoverageUnresolved["kind"]): string {
  return `${RULE_PREFIX}${kind.toUpperCase().replace(/-/g, "_")}`;
}

export function coverageReportToSarif(report: CoverageReport): SarifLog {
  const ruleIds = new Set<CoverageUnresolved["kind"]>();
  for (const entry of report.findings) ruleIds.add(entry.kind);

  const rules: SarifRule[] = [...ruleIds].map((kind) => ({
    id: ruleIdForKind(kind),
    name: ruleIdForKind(kind),
    shortDescription: { text: `Unresolved ${kind} observation` },
    fullDescription: { text: `CellFence could not resolve a ${kind} observation. See the JSON report for the reason and a suggested fix.` },
    defaultConfiguration: { level: KIND_TO_LEVEL[kind] },
  }));

  const results: SarifResult[] = report.findings.map((entry) => ({
    ruleId: ruleIdForKind(entry.kind),
    level: KIND_TO_LEVEL[entry.kind],
    message: { text: entry.suggestion ? `${entry.reason} (suggestion: ${entry.suggestion})` : entry.reason },
    locations: [
      {
        physicalLocation: {
          artifactLocation: { uri: entry.filePath },
          ...(entry.line !== undefined ? { region: { startLine: entry.line } } : {}),
        },
      },
    ],
  }));

  return {
    $schema: "https://json.schemastore.org/sarif-2.1.0.json",
    version: "2.1.0",
    runs: [
      {
        tool: {
          driver: {
            name: "cellfence-coverage",
            version: "0.2.1",
            informationUri: "https://github.com/pushnanashi2/CellFence",
            rules,
          },
        },
        results,
      },
    ],
  };
}
