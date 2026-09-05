// Coverage collector — proof-of-concept for the 0.4.0 `cellfence coverage`
// subcommand. Each analyzer (import resolver, resource adapters, public
// surface fingerprinter) can call into this collector while it walks the
// repository, tagging AST nodes that look like a resource / import / public
// surface target but could not be resolved to a real declaration. The
// coverage command then rolls these up into a single report so the user can
// see *which* pieces of their codebase CellFence could not see through.
//
// The collector is deliberately minimal for the prototype: it just records
// locations and human-readable reasons, and the CLI formats them. The real
// work (asking each adapter to call into the collector, distinguishing
// "unsupported" from "observed but unresolved", wiring SARIF output) is
// queued for the full 0.4.0 implementation.

import path from "node:path";

export type CoverageKind = "import" | "resource" | "public-surface" | "configuration";

export type CoverageUnresolved = {
  /** Cell id that the unresolved observation belongs to, or undefined if it could not be attributed. */
  cellId?: string;
  /** Coarse bucket of what the observation is. */
  kind: CoverageKind;
  /** Path of the file the unresolved observation came from (relative to rootDir). */
  filePath: string;
  /** 1-based line number, if available. */
  line?: number;
  /** Short, adapter-specific shape (e.g. `sequelize.query`, `require(variable)`, `import("computed")`). */
  shape: string;
  /** Human-readable reason the analyzer could not resolve this observation. */
  reason: string;
  /** Optional adapter hint suggesting how the user can make the observation resolvable. */
  suggestion?: string;
};

export type CoverageSummary = {
  totalFiles: number;
  analyzedFiles: number;
  coverage: number;
  unresolvedImports: number;
  unresolvedResources: number;
  unresolvedPublicSurface: number;
  unresolvedConfiguration: number;
};

export type CoverageReport = {
  schemaVersion: "cellfence.coverage.v1";
  generatedAt: string;
  rootDir: string;
  summary: CoverageSummary;
  findings: CoverageUnresolved[];
};

export type CoverageInput = {
  rootDir: string;
  totalFiles: number;
  /** File paths (relative to rootDir) the analyzer successfully walked end-to-end. */
  analyzedFiles: string[];
  /** Unresolved observations collected during the walk. */
  unresolved: CoverageUnresolved[];
};

function repoPath(rootDir: string, filePath: string): string {
  return path.isAbsolute(filePath) ? path.relative(rootDir, filePath) || filePath : filePath;
}

/**
 * Roll a set of unresolved observations into a coverage report. This is
 * deliberately a pure function so the CLI and the engine can both call it
 * without paying for an extra repository walk.
 */
export function buildCoverageReport(input: CoverageInput): CoverageReport {
  const findings = input.unresolved.map((entry) => ({
    ...entry,
    filePath: repoPath(input.rootDir, entry.filePath),
  }));
  const unresolvedImports = findings.filter((entry) => entry.kind === "import").length;
  const unresolvedResources = findings.filter((entry) => entry.kind === "resource").length;
  const unresolvedPublicSurface = findings.filter((entry) => entry.kind === "public-surface").length;
  const unresolvedConfiguration = findings.filter((entry) => entry.kind === "configuration").length;
  // Coverage is computed against the analyzer's actual reach rather than
  // raw file count, since the latter gets dragged around by tests, build
  // output, fixtures, and other sources of noise.
  const coverage = input.totalFiles > 0 ? Math.min(1, input.analyzedFiles.length / input.totalFiles) : 0;
  return {
    schemaVersion: "cellfence.coverage.v1",
    generatedAt: new Date().toISOString(),
    rootDir: input.rootDir,
    summary: {
      totalFiles: input.totalFiles,
      analyzedFiles: input.analyzedFiles.length,
      coverage: Number(coverage.toFixed(4)),
      unresolvedImports,
      unresolvedResources,
      unresolvedPublicSurface,
      unresolvedConfiguration,
    },
    findings,
  };
}

/**
 * Convenience helper adapters can call to register an unresolved observation
 * without having to construct the full object by hand.
 */
export function recordUnresolved(
  collector: CoverageUnresolved[],
  entry: Omit<CoverageUnresolved, "kind"> & { kind: CoverageKind },
): void {
  collector.push(entry);
}
