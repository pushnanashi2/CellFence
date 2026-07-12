import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";

import { checkRepository } from "../packages/engine/dist/index.js";

const scenarios = [
  { files: 10_000, cells: 20 },
  { files: 50_000, cells: 100 },
  { files: 100_000, cells: 300 },
];

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function cellName(index) {
  return `cell${String(index).padStart(4, "0")}`;
}

function createScenario(rootDir, scenario) {
  const cells = [];
  const publicFiles = scenario.cells;
  const extraFiles = Math.max(0, scenario.files - publicFiles);
  const templatePaths = new Map();
  for (let index = 0; index < scenario.cells; index += 1) {
    const id = cellName(index);
    const templatePath = path.join(rootDir, `${id}.template`);
    fs.writeFileSync(templatePath, "const value = 1;\nvoid value;\n");
    templatePaths.set(id, templatePath);
    const cellRoot = path.join(rootDir, "src", id);
    fs.mkdirSync(cellRoot, { recursive: true });
    fs.writeFileSync(path.join(cellRoot, "public.ts"), `export const ${id}Public = ${index};\n`);
    cells.push({
      id,
      ownedPaths: [`src/${id}/**`],
      publicEntry: `src/${id}/public.ts`,
      publicSymbols: [`${id}Public`],
      consumes: [],
      producesArtifacts: [],
    });
  }

  for (let index = 0; index < extraFiles; index += 1) {
    const owner = cellName(index % scenario.cells);
    const shard = Math.floor(index / scenario.cells);
    const directory = path.join(rootDir, "src", owner, `shard-${String(shard % 100).padStart(3, "0")}`);
    fs.mkdirSync(directory, { recursive: true });
    fs.linkSync(templatePaths.get(owner), path.join(directory, `file-${index}.ts`));
  }

  writeJson(path.join(rootDir, "cellfence.manifest.json"), {
    schemaVersion: "cellfence.manifest.v1",
    governance: {
      requireOwnership: true,
      include: ["src/**"],
      exclude: [],
    },
    cells,
  });
}

function runScenario(scenario) {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-scale-"));
  try {
    createScenario(tempRoot, scenario);
    const startedAt = performance.now();
    const result = checkRepository({ rootDir: tempRoot, manifestPath: "cellfence.manifest.json" });
    const durationMs = Math.round(performance.now() - startedAt);
    if (!result.ok) {
      throw new Error(`scale benchmark failed for ${scenario.files} files/${scenario.cells} cells: ${result.findings.map((finding) => finding.ruleId).join(", ")}`);
    }
    return {
      ...scenario,
      durationMs,
      findings: result.findings.length,
      warnings: result.warnings.length,
    };
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

const results = [];
for (const scenario of scenarios) {
  const result = runScenario(scenario);
  results.push(result);
  console.log(JSON.stringify({ schemaVersion: "cellfence.scale-benchmark-progress.v1", result }));
}
console.log(JSON.stringify({ schemaVersion: "cellfence.scale-benchmark.v1", results }, null, 2));
