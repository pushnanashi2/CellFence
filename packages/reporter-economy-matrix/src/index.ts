import {
  CELLFENCE_PLUGIN_API_VERSION,
  definePlugin,
  defineReporter,
  type CellFencePlugin,
  type CellFenceReporter,
  type CellFenceReporterContext,
} from "@cellfence/plugin-api";

export type EconomyMatrixRow = {
  cellId: string;
  producesPublicSymbols: number;
  producesArtifacts: number;
  consumesCells: number;
  consumesResources: number;
  observedImports: number;
};

export function createEconomyMatrix(context: CellFenceReporterContext): EconomyMatrixRow[] {
  return context.repository.manifest.cells.map((cell) => {
    const observedImports = context.repository.imports.filter((reference) => reference.importerCellId === cell.id && reference.targetCellId && reference.targetCellId !== cell.id).length;
    const consumesResources = context.repository.resources.filter((resource) => resource.cellId === cell.id).length;
    return {
      cellId: cell.id,
      producesPublicSymbols: cell.publicSymbols.length,
      producesArtifacts: (cell.producesArtifacts || []).length,
      consumesCells: (cell.consumes || []).length,
      consumesResources,
      observedImports,
    };
  }).sort((left, right) => right.producesPublicSymbols + right.consumesResources - (left.producesPublicSymbols + left.consumesResources));
}

export function economyMatrixReporter(): CellFenceReporter {
  return defineReporter({
    name: "@cellfence/reporter-economy-matrix",
    report(context) {
      const rows = createEconomyMatrix(context);
      const lines = [
        "| cell | public symbols | artifact lanes | declared imports | observed imports | resource accesses |",
        "|---|---:|---:|---:|---:|---:|",
      ];
      for (const row of rows) {
        lines.push(`| ${row.cellId} | ${row.producesPublicSymbols} | ${row.producesArtifacts} | ${row.consumesCells} | ${row.observedImports} | ${row.consumesResources} |`);
      }
      return lines.join("\n");
    },
  });
}

export function economyMatrixPlugin(): CellFencePlugin {
  return definePlugin({
    apiVersion: CELLFENCE_PLUGIN_API_VERSION,
    name: "@cellfence/reporter-economy-matrix",
    version: "0.1.8",
    reporters: [economyMatrixReporter()],
  });
}
