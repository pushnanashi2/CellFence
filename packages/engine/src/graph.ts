import path from "node:path";

import type { CellFenceManifest, ResourceBaselineEntry } from "@cellfence/schema";

import { DEFAULT_MANIFEST_PATH } from "./constants.js";
import { isIsoDate } from "./dates.js";
import { normalizePath } from "./file-index.js";
import { sortedResourceBaselineEntries } from "./baseline-ratchet.js";
import type { ResourceAccessReference } from "./resource-access.js";
import type {
  AnalysisContext,
  AutoAllocation,
  AutoAllocateOptions,
  CellFenceContext,
  CheckOptions,
  CouplingGraph,
  CouplingGraphEdge,
  CouplingGraphNode,
  Finding,
  ContextBudgetEntry,
  WaiverRequest,
  WaiverRequestOptions,
} from "./types.js";

type GraphOperationDependencies = {
  createCellContext(options: { rootDir?: string; manifestPath?: string; baselinePath?: string; evidencePaths?: string[]; cellId: string }): CellFenceContext;
  createContext(rootDir: string, manifest: CellFenceManifest): AnalysisContext;
  evidencePathsForOptions(rootDir: string, evidencePaths: string[] | undefined): string[];
  loadManifestFromFile(manifestPath: string): CellFenceManifest;
  mergeAccessesByCell(target: Map<string, ResourceAccessReference[]>, source: Map<string, ResourceAccessReference[]>): void;
  resourceEvidenceAccesses(
    context: AnalysisContext,
    evidencePaths: string[],
    findings: Finding[],
    baseline: undefined,
  ): Map<string, ResourceAccessReference[]>;
  validateImports(context: AnalysisContext, findings: Finding[], warnings: Finding[]): Map<string, Set<string>>;
  validateResourceAccesses(
    context: AnalysisContext,
    findings: Finding[],
    warnings: Finding[],
    baseline: undefined,
  ): Map<string, ResourceAccessReference[]>;
};

function graphNodeKey(kind: CouplingGraphNode["kind"], id: string): string {
  return `${kind}:${id}`;
}

function addGraphNode(nodes: Map<string, CouplingGraphNode>, node: CouplingGraphNode): void {
  nodes.set(graphNodeKey(node.kind, node.id), node);
}

function addGraphEdge(edges: Map<string, CouplingGraphEdge>, edge: CouplingGraphEdge): void {
  edges.set(`${edge.from}->${edge.to}:${edge.kind}:${edge.label}`, edge);
}

function resourceNodeId(access: ResourceBaselineEntry): string {
  return `${access.kind}:${access.selector}`;
}

export function createCouplingGraph(
  options: CheckOptions = {},
  dependencies: GraphOperationDependencies,
): CouplingGraph {
  const rootDir = path.resolve(options.rootDir || process.cwd());
  const manifestPath = path.resolve(rootDir, options.manifestPath || DEFAULT_MANIFEST_PATH);
  const manifest = dependencies.loadManifestFromFile(manifestPath);
  const context = dependencies.createContext(rootDir, manifest);
  const findings: Finding[] = [];
  const warnings: Finding[] = [];
  const nodes = new Map<string, CouplingGraphNode>();
  const edges = new Map<string, CouplingGraphEdge>();

  for (const cell of manifest.cells) {
    addGraphNode(nodes, { id: cell.id, label: cell.id, kind: "cell" });
    for (const consumer of cell.consumes ?? []) {
      addGraphEdge(edges, {
        from: cell.id,
        to: consumer.cell,
        kind: "declared-consumer",
        label: "declares",
      });
      for (const lane of consumer.artifactLanes || []) {
        const artifactId = `artifact:${consumer.cell}:${lane}`;
        addGraphNode(nodes, { id: artifactId, label: lane, kind: "artifact" });
        addGraphEdge(edges, {
          from: consumer.cell,
          to: artifactId,
          kind: "artifact-lane",
          label: "produces",
        });
        addGraphEdge(edges, {
          from: cell.id,
          to: artifactId,
          kind: "artifact-lane",
          label: "consumes",
        });
      }
    }
  }

  const observedImports = dependencies.validateImports(context, findings, warnings);
  for (const [consumerCellId, producerCells] of observedImports.entries()) {
    for (const producerCellId of producerCells) {
      addGraphEdge(edges, {
        from: consumerCellId,
        to: producerCellId,
        kind: "observed-import",
        label: "imports",
      });
    }
  }

  const accessesByCell = dependencies.validateResourceAccesses(context, findings, warnings, undefined);
  dependencies.mergeAccessesByCell(
    accessesByCell,
    dependencies.resourceEvidenceAccesses(
      context,
      dependencies.evidencePathsForOptions(rootDir, options.evidencePaths),
      findings,
      undefined,
    ),
  );
  for (const [cellId, accesses] of accessesByCell.entries()) {
    for (const access of sortedResourceBaselineEntries(accesses)) {
      const nodeId = resourceNodeId(access);
      addGraphNode(nodes, { id: nodeId, label: nodeId, kind: "resource" });
      addGraphEdge(edges, {
        from: cellId,
        to: nodeId,
        kind: "resource-access",
        label: access.access,
      });
    }
  }

  return {
    schemaVersion: "cellfence.coupling-graph.v1",
    nodes: [...nodes.values()].sort((left, right) => graphNodeKey(left.kind, left.id).localeCompare(graphNodeKey(right.kind, right.id))),
    edges: [...edges.values()].sort((left, right) => `${left.from}:${left.to}:${left.kind}:${left.label}`.localeCompare(`${right.from}:${right.to}:${right.kind}:${right.label}`)),
  };
}

function mermaidId(value: string): string {
  return value.replace(/[^A-Za-z0-9_]/g, "_");
}

export function formatCouplingGraphMermaid(graph: CouplingGraph): string {
  const lines = ["flowchart LR"];
  for (const node of graph.nodes) {
    lines.push(`  ${mermaidId(node.id)}["${node.label.replace(/"/g, "'")}"]`);
  }
  for (const edge of graph.edges) {
    lines.push(`  ${mermaidId(edge.from)} -- "${edge.label} (${edge.kind})" --> ${mermaidId(edge.to)}`);
  }
  return lines.join("\n");
}

function taskMatchesCell(task: string, cell: CellFenceManifest["cells"][number]): boolean {
  const text = task.toLowerCase();
  if (cell.id.toLowerCase().split(/[-_]/).some((part) => part.length > 2 && text.includes(part))) return true;
  if (text.includes(cell.id.toLowerCase())) return true;
  if (cell.packageName && text.includes(cell.packageName.toLowerCase())) return true;
  if (cell.publicSymbols.some((symbol) => text.includes(symbol.toLowerCase()))) return true;
  return cell.ownedPaths.some((ownedPath) => text.includes(ownedPath.toLowerCase().replace(/\*\*/g, "").replace(/\*/g, "")));
}

export function createAutoAllocation(
  options: AutoAllocateOptions = {},
  dependencies: GraphOperationDependencies,
): AutoAllocation {
  const rootDir = path.resolve(options.rootDir || process.cwd());
  const manifestPath = path.resolve(rootDir, options.manifestPath || DEFAULT_MANIFEST_PATH);
  const manifest = dependencies.loadManifestFromFile(manifestPath);
  const graph = createCouplingGraph(options, dependencies);
  const selectedCells = new Set<string>();
  const task = options.task || "";
  if (options.cellId) selectedCells.add(options.cellId);
  if (task.trim().length > 0) {
    for (const cell of manifest.cells) {
      if (taskMatchesCell(task, cell)) selectedCells.add(cell.id);
    }
  }

  const contextCells = new Set(selectedCells);
  for (const edge of graph.edges) {
    if (selectedCells.has(edge.from) && graph.nodes.some((node) => node.kind === "cell" && node.id === edge.to)) {
      contextCells.add(edge.to);
    }
  }

  const includePaths = new Set<string>();
  const publicEntries = new Set<string>();
  const resourceSelectors = new Set<string>();
  const budgets: Record<string, Record<string, ContextBudgetEntry>> = {};
  for (const cell of manifest.cells) {
    if (selectedCells.has(cell.id)) {
      cell.ownedPaths.forEach((ownedPath) => includePaths.add(ownedPath));
    }
    if (contextCells.has(cell.id)) {
      const cellContext = dependencies.createCellContext({
        rootDir,
        manifestPath,
        baselinePath: options.baselinePath,
        evidencePaths: options.evidencePaths,
        cellId: cell.id,
      });
      publicEntries.add(cell.publicEntry);
      budgets[cell.id] = Object.fromEntries(Object.entries(cellContext.budgets));
      for (const contract of cellContext.allowedResources) {
        for (const access of contract.access) {
          for (const selector of contract.selectors) resourceSelectors.add(`${contract.kind}:${access}:${selector}`);
        }
      }
      for (const resource of cellContext.baselineResources) {
        resourceSelectors.add(`${resource.kind}:${resource.access}:${resource.selector}`);
      }
    }
  }

  return {
    schemaVersion: "cellfence.auto-allocation.v1",
    task,
    selectedCells: [...selectedCells].sort(),
    contextCells: [...contextCells].sort(),
    includePaths: [...includePaths].sort(),
    publicEntries: [...publicEntries].sort(),
    resourceSelectors: [...resourceSelectors].sort(),
    budgets,
    guidance: [
      "Read selected cell owned paths only when implementation edits are needed.",
      "Read context cell public entries for dependency contracts; avoid internal files from context cells.",
      "If selectedCells is empty, ask for a target cell or a more specific task before editing.",
    ],
  };
}

export function createWaiverRequest(options: WaiverRequestOptions): WaiverRequest {
  if (!isIsoDate(options.expires)) throw new Error("expires must be YYYY-MM-DD");
  if (options.reason.trim().length < 12) throw new Error("reason must explain the waiver in at least 12 characters");
  const approvedBy = options.approvedBy || "PENDING";
  const directive = `// cellfence-ignore ${options.ruleId} expires:${options.expires} approved-by:${approvedBy} reason:${options.reason.trim()}`;
  const markdown = [
    "## CellFence Waiver Request",
    "",
    `- Rule: ${options.ruleId}`,
    `- File: ${normalizePath(options.filePath)}:${options.line}`,
    `- Expires: ${options.expires}`,
    `- Approved by: ${approvedBy}`,
    `- Reason: ${options.reason.trim()}`,
    "",
    "Approved directive:",
    "",
    "```ts",
    directive,
    "```",
  ].join("\n");
  return {
    schemaVersion: "cellfence.waiver-request.v1",
    directive,
    markdown,
    approvalRequired: true,
    ruleId: options.ruleId,
    filePath: normalizePath(options.filePath),
    line: options.line,
    expires: options.expires,
    approvedBy,
    reason: options.reason.trim(),
  };
}
