import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { spawnSync } from "node:child_process";

import { checkRepository } from "../packages/engine/dist/index.js";

const categories = ["language-independent", "python", "js-ts"];

function parseArgs(argv) {
  const options = {
    iterations: 100,
    category: "",
    json: false,
    keep: false,
    outPath: "",
  };
  for (let index = 2; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--json") {
      options.json = true;
    } else if (argument === "--keep") {
      options.keep = true;
    } else if (argument === "--iterations") {
      index += 1;
      options.iterations = Number(argv[index]);
    } else if (argument.startsWith("--iterations=")) {
      options.iterations = Number(argument.slice("--iterations=".length));
    } else if (argument === "--category") {
      index += 1;
      options.category = argv[index] || "";
    } else if (argument.startsWith("--category=")) {
      options.category = argument.slice("--category=".length);
    } else if (argument === "--out") {
      index += 1;
      options.outPath = argv[index] || "";
    } else if (argument.startsWith("--out=")) {
      options.outPath = argument.slice("--out=".length);
    } else {
      throw new Error(`unknown option ${argument}`);
    }
  }
  if (!Number.isInteger(options.iterations) || options.iterations < 1) {
    throw new Error("--iterations must be a positive integer");
  }
  if (options.category && !categories.includes(options.category)) {
    throw new Error(`--category must be one of: ${categories.join(", ")}`);
  }
  return options;
}

function mkdir(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function write(filePath, text) {
  mkdir(filePath);
  fs.writeFileSync(filePath, text);
}

function writeJson(filePath, value) {
  write(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function git(rootDir, args) {
  const result = spawnSync("git", args, { cwd: rootDir, encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout || `git ${args.join(" ")} failed`);
  return result.stdout.trim();
}

function initGitRepo(rootDir) {
  git(rootDir, ["init"]);
  git(rootDir, ["config", "user.email", "cellfence@example.invalid"]);
  git(rootDir, ["config", "user.name", "CellFence Adversarial"]);
}

function symbolName(prefix, index) {
  return `${prefix}${String(index).padStart(3, "0")}`;
}

function tsCell(id, patch = {}) {
  const publicSymbol = symbolName(id.replace(/[^A-Za-z0-9_]/g, ""), 0);
  return {
    id,
    ownedPaths: [`src/${id}/**`],
    publicEntry: `src/${id}/public.ts`,
    publicSymbols: [publicSymbol],
    consumes: [],
    producesArtifacts: [],
    ...patch,
  };
}

function pyCell(id, patch = {}) {
  return {
    id,
    ownedPaths: [`src/${id}/**`],
    publicEntry: `src/${id}/public.py`,
    publicSymbols: [symbolName(id, 0)],
    consumes: [],
    producesArtifacts: [],
    ...patch,
  };
}

function manifest(cells, governance = {}) {
  return {
    schemaVersion: "cellfence.manifest.v1",
    governance: {
      requireOwnership: true,
      include: ["src/**"],
      exclude: [],
      ...governance,
    },
    cells,
  };
}

function writeTsPublic(rootDir, cellId, body = "") {
  write(path.join(rootDir, "src", cellId, "public.ts"), body || `export const ${symbolName(cellId, 0)} = true;\n`);
}

function writePyPublic(rootDir, cellId, body = "") {
  write(path.join(rootDir, "src", cellId, "public.py"), body || `${symbolName(cellId, 0)} = True\n`);
}

function writeTsTwoCellRepo(rootDir, index, options = {}) {
  const producer = options.producer || `producer${index}`;
  const consumer = options.consumer || `consumer${index}`;
  const producerSymbol = symbolName(producer, 0);
  const consumerSymbol = symbolName(consumer, 0);
  write(path.join(rootDir, "src", producer, "public.ts"), `export const ${producerSymbol} = true;\n`);
  write(path.join(rootDir, "src", producer, "internal.ts"), `export const secret${index} = true;\n`);
  write(path.join(rootDir, "src", consumer, "public.ts"), options.consumerSource || `export const ${consumerSymbol} = true;\n`);
  const consumerCell = tsCell(consumer, {
    publicSymbols: [consumerSymbol],
    consumes: options.consumes === false ? [] : [{ cell: producer }],
  });
  writeJson(path.join(rootDir, "cellfence.manifest.json"), manifest([
    tsCell(producer, { publicSymbols: [producerSymbol], packageName: options.packageName }),
    consumerCell,
  ]));
  return { producer, consumer };
}

function writePyTwoCellRepo(rootDir, index, options = {}) {
  const producer = options.producer || `producer${index}`;
  const consumer = options.consumer || `consumer${index}`;
  const producerSymbol = symbolName(producer, 0);
  const consumerSymbol = symbolName(consumer, 0);
  write(path.join(rootDir, "src", producer, "public.py"), `${producerSymbol} = True\n`);
  write(path.join(rootDir, "src", producer, "internal.py"), `secret${index} = True\n`);
  write(path.join(rootDir, "src", consumer, "public.py"), options.consumerSource || `${consumerSymbol} = True\n`);
  writeJson(path.join(rootDir, "cellfence.manifest.json"), manifest([
    pyCell(producer, { publicSymbols: [producerSymbol] }),
    pyCell(consumer, {
      publicSymbols: [consumerSymbol],
      consumes: options.consumes === false ? [] : [{ cell: producer }],
    }),
  ]));
  return { producer, consumer };
}

function baselineFor(cells) {
  return {
    schemaVersion: "cellfence.baseline.v1",
    generatedAt: "2026-01-01T00:00:00.000Z",
    cellIds: cells.map((cell) => cell.id).sort((left, right) => left.localeCompare(right)),
    cells: Object.fromEntries(cells.map((cell) => [cell.id, {
      ownedPathPatterns: cell.ownedPaths.length,
      publicSymbols: cell.publicSymbols.length,
      publicSurfaceLines: 1,
      crossCellDependencies: (cell.consumes || []).length,
      ownedPathSet: [...cell.ownedPaths],
      publicEntryPath: cell.publicEntry,
      publicSymbolSet: [...cell.publicSymbols],
      dependencyEdges: (cell.consumes || []).map((consumer) => `import:${consumer.cell}`),
      artifactContracts: [],
      resourceAccesses: [],
    }])),
  };
}

function runCheck(rootDir, options = {}) {
  return checkRepository({
    rootDir,
    manifestPath: "cellfence.manifest.json",
    baselinePath: options.baselinePath,
    evidencePaths: options.evidencePaths || [],
  });
}

function hasAllRules(result, ruleIds) {
  const observed = new Set([...result.findings, ...result.warnings].map((finding) => finding.ruleId));
  return ruleIds.every((ruleId) => observed.has(ruleId));
}

function findingRules(result) {
  return [...new Set(result.findings.map((finding) => finding.ruleId))].sort();
}

function warningRules(result) {
  return [...new Set(result.warnings.map((finding) => finding.ruleId))].sort();
}

function languageIndependentTemplates() {
  return [{
    id: "unknown-manifest-root-field",
    expectedOk: false,
    ruleIds: ["CELLFENCE_MANIFEST_INVALID"],
    setup(rootDir, index) {
      writeTsPublic(rootDir, `core${index}`);
      const cell = tsCell(`core${index}`);
      writeJson(path.join(rootDir, "cellfence.manifest.json"), { ...manifest([cell]), requireOwnershp: true });
    },
  }, {
    id: "unknown-cell-policy-field",
    expectedOk: false,
    ruleIds: ["CELLFENCE_MANIFEST_INVALID"],
    setup(rootDir, index) {
      writeTsPublic(rootDir, `core${index}`);
      writeJson(path.join(rootDir, "cellfence.manifest.json"), manifest([{
        ...tsCell(`core${index}`),
        consume: [{ cell: "other" }],
      }]));
    },
  }, {
    id: "duplicate-package-name",
    expectedOk: false,
    ruleIds: ["CELLFENCE_MANIFEST_INVALID"],
    setup(rootDir, index) {
      writeTsPublic(rootDir, `api${index}`);
      writeTsPublic(rootDir, `web${index}`);
      writeJson(path.join(rootDir, "cellfence.manifest.json"), manifest([
        tsCell(`api${index}`, { packageName: `@demo/dup${index}` }),
        tsCell(`web${index}`, { packageName: `@demo/dup${index}` }),
      ]));
    },
  }, {
    id: "sibling-prefix-ownership-control",
    expectedOk: true,
    ruleIds: [],
    setup(rootDir, index) {
      writeTsPublic(rootDir, `user${index}`);
      writeTsPublic(rootDir, `users${index}`);
      writeJson(path.join(rootDir, "cellfence.manifest.json"), manifest([
        tsCell(`user${index}`),
        tsCell(`users${index}`),
      ]));
    },
  }, {
    id: "nested-owned-path-overlap",
    expectedOk: false,
    ruleIds: ["CELLFENCE_OWNERSHIP_OVERLAP"],
    setup(rootDir, index) {
      writeTsPublic(rootDir, `core${index}`);
      write(path.join(rootDir, "src", `core${index}`, "internal", "public.ts"), `export const nested${index} = true;\n`);
      writeJson(path.join(rootDir, "cellfence.manifest.json"), manifest([
        tsCell(`core${index}`),
        tsCell(`nested${index}`, {
          ownedPaths: [`src/core${index}/internal/**`],
          publicEntry: `src/core${index}/internal/public.ts`,
          publicSymbols: [`nested${index}`],
        }),
      ]));
    },
  }, {
    id: "wildcard-owned-path-overlap",
    expectedOk: false,
    ruleIds: ["CELLFENCE_OWNERSHIP_OVERLAP"],
    setup(rootDir, index) {
      const rootCell = `root${index}`;
      const featureCell = `feature${index}`;
      write(path.join(rootDir, "src", "shared", "public.ts"), `export const ${symbolName(rootCell, 0)} = true;\n`);
      write(path.join(rootDir, "src", "shared", "feature.ts"), `export const ${symbolName(featureCell, 0)} = true;\n`);
      writeJson(path.join(rootDir, "cellfence.manifest.json"), manifest([
        tsCell(rootCell, {
          ownedPaths: ["src/*/public.ts"],
          publicEntry: "src/shared/public.ts",
          publicSymbols: [symbolName(rootCell, 0)],
        }),
        tsCell(featureCell, {
          ownedPaths: ["src/shared/*.ts"],
          publicEntry: "src/shared/feature.ts",
          publicSymbols: [symbolName(featureCell, 0)],
        }),
      ]));
    },
  }, {
    id: "unowned-governed-source",
    expectedOk: false,
    ruleIds: ["CELLFENCE_UNOWNED_SOURCE"],
    setup(rootDir, index) {
      writeTsPublic(rootDir, `core${index}`);
      write(path.join(rootDir, "src", "rogue", `secret-${index}.ts`), "export const rogue = true;\n");
      writeJson(path.join(rootDir, "cellfence.manifest.json"), manifest([tsCell(`core${index}`)]));
    },
  }, {
    id: "artifact-path-outside-owner",
    expectedOk: false,
    ruleIds: ["CELLFENCE_ARTIFACT_OUTSIDE_OWNERSHIP"],
    setup(rootDir, index) {
      const cell = tsCell(`core${index}`, {
        producesArtifacts: [{ id: `lane${index}`, paths: [`artifacts/${index}/**`] }],
      });
      writeTsPublic(rootDir, cell.id);
      writeJson(path.join(rootDir, "cellfence.manifest.json"), manifest([cell]));
    },
  }, {
    id: "baseline-unknown-field",
    expectedOk: false,
    ruleIds: ["CELLFENCE_MANIFEST_INVALID"],
    runOptions: { baselinePath: "cellfence.baseline.json" },
    setup(rootDir, index) {
      const cell = tsCell(`core${index}`);
      writeTsPublic(rootDir, cell.id);
      writeJson(path.join(rootDir, "cellfence.manifest.json"), manifest([cell]));
      writeJson(path.join(rootDir, "cellfence.baseline.json"), { ...baselineFor([cell]), unexpected: true });
    },
  }, {
    id: "resource-evidence-unknown-field",
    expectedOk: false,
    ruleIds: ["CELLFENCE_RESOURCE_EVIDENCE_INVALID"],
    runOptions: { evidencePaths: ["evidence.json"] },
    setup(rootDir, index) {
      const cell = tsCell(`core${index}`);
      writeTsPublic(rootDir, cell.id);
      writeJson(path.join(rootDir, "cellfence.manifest.json"), manifest([cell]));
      writeJson(path.join(rootDir, "evidence.json"), {
        schemaVersion: "cellfence.resource-evidence.v1",
        commitSha: "0".repeat(40),
        accesses: [],
        extra: "typo",
      });
    },
  }, {
    id: "stale-runtime-evidence-commit-sha",
    expectedOk: false,
    ruleIds: ["CELLFENCE_RESOURCE_EVIDENCE_INVALID"],
    runOptions: { evidencePaths: ["evidence.json"] },
    setup(rootDir, index) {
      const cell = tsCell(`core${index}`, {
        resourceContracts: [{
          id: `orders${index}`,
          kind: "database",
          access: ["read"],
          selectors: [`app_orders_${index}`],
        }],
      });
      writeTsPublic(rootDir, cell.id);
      writeJson(path.join(rootDir, "cellfence.manifest.json"), manifest([cell]));
      initGitRepo(rootDir);
      git(rootDir, ["add", "."]);
      git(rootDir, ["commit", "-m", "initial"]);
      writeJson(path.join(rootDir, "evidence.json"), {
        schemaVersion: "cellfence.resource-evidence.v1",
        commitSha: "0".repeat(40),
        cellId: cell.id,
        accesses: [{ kind: "database", access: "read", selector: `app_orders_${index}` }],
      });
    },
  }, {
    id: "required-rule-disabled",
    expectedOk: false,
    ruleIds: ["CELLFENCE_REQUIRED_RULE_DISABLED"],
    setup(rootDir, index) {
      const cell = tsCell(`core${index}`);
      writeTsPublic(rootDir, cell.id);
      writeJson(path.join(rootDir, "cellfence.manifest.json"), {
        ...manifest([cell]),
        rules: { CELLFENCE_PRIVATE_IMPORT: "off" },
      });
    },
  }, {
    id: "unknown-consumer-cell",
    expectedOk: false,
    ruleIds: ["CELLFENCE_MANIFEST_INVALID"],
    setup(rootDir, index) {
      writeTsPublic(rootDir, `core${index}`);
      writeJson(path.join(rootDir, "cellfence.manifest.json"), manifest([
        tsCell(`core${index}`, { consumes: [{ cell: `ghost${index}` }] }),
      ]));
    },
  }, {
    id: "baseline-cell-set-growth",
    expectedOk: false,
    ruleIds: ["CELLFENCE_RATCHET_CELL_SET_GROWTH"],
    runOptions: { baselinePath: "cellfence.baseline.json" },
    setup(rootDir, index) {
      const core = tsCell(`core${index}`);
      const extra = tsCell(`extra${index}`);
      writeTsPublic(rootDir, core.id);
      writeTsPublic(rootDir, extra.id);
      writeJson(path.join(rootDir, "cellfence.manifest.json"), manifest([core, extra]));
      writeJson(path.join(rootDir, "cellfence.baseline.json"), baselineFor([core]));
    },
  }, {
    id: "manifest-path-root-escape",
    expectedOk: false,
    ruleIds: ["CELLFENCE_MANIFEST_INVALID"],
    setup(rootDir, index) {
      writeTsPublic(rootDir, `core${index}`);
      writeJson(path.join(rootDir, "cellfence.manifest.json"), manifest([{
        ...tsCell(`core${index}`),
        ownedPaths: [`../core${index}/**`],
        publicEntry: `/tmp/cellfence-outside-${index}.ts`,
      }]));
    },
  }, {
    id: "duplicate-json-key-manifest",
    expectedOk: false,
    ruleIds: ["CELLFENCE_MANIFEST_INVALID"],
    setup(rootDir, index) {
      writeTsPublic(rootDir, `core${index}`);
      const cell = tsCell(`core${index}`);
      write(path.join(rootDir, "cellfence.manifest.json"), [
        "{",
        `  "schemaVersion": "cellfence.manifest.v1",`,
        `  "cells": [],`,
        `  "cells": ${JSON.stringify([cell], null, 2)}`,
        "}",
        "",
      ].join("\n"));
    },
  }, {
    id: "escaped-duplicate-json-key-manifest",
    expectedOk: false,
    ruleIds: ["CELLFENCE_MANIFEST_INVALID"],
    setup(rootDir, index) {
      writeTsPublic(rootDir, `core${index}`);
      const cell = tsCell(`core${index}`);
      write(path.join(rootDir, "cellfence.manifest.json"), [
        "{",
        `  "schemaVersion": "cellfence.manifest.v1",`,
        `  "cells": [],`,
        `  "\\u0063ells": ${JSON.stringify([cell], null, 2)}`,
        "}",
        "",
      ].join("\n"));
    },
  }, {
    id: "sealed-baseline-requires-verifier",
    expectedOk: false,
    ruleIds: ["CELLFENCE_BASELINE_SEAL_INVALID"],
    runOptions: { baselinePath: "cellfence.baseline.json" },
    setup(rootDir, index) {
      const cell = tsCell(`core${index}`);
      writeTsPublic(rootDir, cell.id);
      writeJson(path.join(rootDir, "cellfence.manifest.json"), manifest([cell]));
      writeJson(path.join(rootDir, "cellfence.baseline.json"), {
        ...baselineFor([cell]),
        seal: { algorithm: "hmac-sha256", digest: "0".repeat(64) },
      });
    },
  }, {
    id: "pending-waiver-does-not-authorize",
    expectedOk: false,
    ruleIds: ["CELLFENCE_WAIVER_INVALID", "CELLFENCE_PRIVATE_IMPORT"],
    setup(rootDir, index) {
      const producer = `producer${index}`;
      const source = [
        "// cellfence-ignore CELLFENCE_PRIVATE_IMPORT expires:2099-01-01 approved-by:PENDING reason:temporary request",
        `import { secret${index} } from "../${producer}/internal";`,
        `export const ${symbolName(`consumer${index}`, 0)} = secret${index};`,
        "",
      ].join("\n");
      writeTsTwoCellRepo(rootDir, index, { producer, consumerSource: source });
    },
  }, {
    id: "source-waiver-cannot-suppress-required-private-import",
    expectedOk: false,
    ruleIds: ["CELLFENCE_PRIVATE_IMPORT"],
    setup(rootDir, index) {
      const producer = `producer${index}`;
      const source = [
        "// cellfence-ignore CELLFENCE_PRIVATE_IMPORT expires:2099-01-01 approved-by:test-owner reason:temporary adversarial required-rule fixture",
        `import { secret${index} } from "../${producer}/internal";`,
        `export const ${symbolName(`consumer${index}`, 0)} = secret${index};`,
        "",
      ].join("\n");
      writeTsTwoCellRepo(rootDir, index, { producer, consumerSource: source });
    },
  }, {
    id: "unsealed-baseline-cannot-grandfather-runtime-evidence",
    expectedOk: false,
    ruleIds: ["CELLFENCE_UNDECLARED_RESOURCE_ACCESS"],
    runOptions: { baselinePath: "cellfence.baseline.json", evidencePaths: ["evidence.json"] },
    setup(rootDir, index) {
      const cell = tsCell(`core${index}`);
      const base = baselineFor([cell]);
      writeTsPublic(rootDir, cell.id);
      writeJson(path.join(rootDir, "cellfence.manifest.json"), manifest([cell]));
      writeJson(path.join(rootDir, "cellfence.baseline.json"), {
        ...base,
        cells: {
          [cell.id]: {
            ...base.cells[cell.id],
            resourceAccesses: [{ kind: "database", access: "read", selector: `app_users_${index}` }],
          },
        },
      });
      writeJson(path.join(rootDir, "evidence.json"), {
        schemaVersion: "cellfence.resource-evidence.v1",
        cellId: cell.id,
        accesses: [{ kind: "database", access: "read", selector: `app_users_${index}` }],
      });
    },
  }];
}

function pythonTemplates() {
  return [{
    id: "absolute-private-from-import",
    expectedOk: false,
    ruleIds: ["CELLFENCE_PRIVATE_IMPORT"],
    setup(rootDir, index) {
      const producer = `producer${index}`;
      const consumerSource = [
        `from ${producer}.internal import secret${index}`,
        `${symbolName(`consumer${index}`, 0)} = secret${index}`,
        "",
      ].join("\n");
      writePyTwoCellRepo(rootDir, index, { producer, consumerSource });
    },
  }, {
    id: "absolute-private-import-module",
    expectedOk: false,
    ruleIds: ["CELLFENCE_PRIVATE_IMPORT"],
    setup(rootDir, index) {
      const producer = `producer${index}`;
      const consumerSource = [
        `import ${producer}.internal as hidden`,
        `${symbolName(`consumer${index}`, 0)} = hidden.secret${index}`,
        "",
      ].join("\n");
      writePyTwoCellRepo(rootDir, index, { producer, consumerSource });
    },
  }, {
    id: "relative-private-from-import",
    expectedOk: false,
    ruleIds: ["CELLFENCE_PRIVATE_IMPORT"],
    setup(rootDir, index) {
      const producer = `producer${index}`;
      const consumerSource = [
        `from ..${producer}.internal import secret${index}`,
        `${symbolName(`consumer${index}`, 0)} = secret${index}`,
        "",
      ].join("\n");
      writePyTwoCellRepo(rootDir, index, { producer, consumerSource });
      write(path.join(rootDir, "src", "__init__.py"), "");
    },
  }, {
    id: "undeclared-python-consumer",
    expectedOk: false,
    ruleIds: ["CELLFENCE_UNDECLARED_CONSUMER"],
    setup(rootDir, index) {
      const producer = `producer${index}`;
      const consumerSource = [
        `from ${producer}.public import ${symbolName(producer, 0)}`,
        `${symbolName(`consumer${index}`, 0)} = ${symbolName(producer, 0)}`,
        "",
      ].join("\n");
      writePyTwoCellRepo(rootDir, index, { producer, consumerSource, consumes: false });
    },
  }, {
    id: "pyproject-src-layout-private-import",
    expectedOk: false,
    ruleIds: ["CELLFENCE_PRIVATE_IMPORT"],
    setup(rootDir, index) {
      const producer = `pkgproducer${index}`;
      const consumer = `pkgconsumer${index}`;
      writeJson(path.join(rootDir, "pyproject.toml"), {});
      write(path.join(rootDir, "pyproject.toml"), "[project]\nname = 'demo'\n[tool.setuptools.packages.find]\nwhere = ['lib/python']\n");
      write(path.join(rootDir, "lib", "python", producer, "public.py"), `${symbolName(producer, 0)} = True\n`);
      write(path.join(rootDir, "lib", "python", producer, "internal.py"), `secret${index} = True\n`);
      write(path.join(rootDir, "lib", "python", consumer, "public.py"), `from ${producer}.internal import secret${index}\n${symbolName(consumer, 0)} = secret${index}\n`);
      writeJson(path.join(rootDir, "cellfence.manifest.json"), manifest([
        pyCell(producer, {
          ownedPaths: [`lib/python/${producer}/**`],
          publicEntry: `lib/python/${producer}/public.py`,
          publicSymbols: [symbolName(producer, 0)],
        }),
        pyCell(consumer, {
          ownedPaths: [`lib/python/${consumer}/**`],
          publicEntry: `lib/python/${consumer}/public.py`,
          publicSymbols: [symbolName(consumer, 0)],
          consumes: [{ cell: producer }],
        }),
      ], { include: ["lib/python/**"] }));
    },
  }, {
    id: "from-package-submodule-private",
    expectedOk: false,
    ruleIds: ["CELLFENCE_PRIVATE_IMPORT"],
    setup(rootDir, index) {
      const producer = `producer${index}`;
      const consumerSource = [
        `from ${producer} import internal as _internal`,
        `${symbolName(`consumer${index}`, 0)} = _internal.secret${index}`,
        "",
      ].join("\n");
      writePyTwoCellRepo(rootDir, index, { producer, consumerSource });
      write(path.join(rootDir, "src", producer, "__init__.py"), "");
    },
  }, {
    id: "literal-importlib-private",
    expectedOk: false,
    ruleIds: ["CELLFENCE_PRIVATE_IMPORT"],
    setup(rootDir, index) {
      const producer = `producer${index}`;
      const consumerSource = [
        "import importlib as _importlib",
        `secret = _importlib.import_module("${producer}.internal")`,
        `${symbolName(`consumer${index}`, 0)} = secret.secret${index}`,
        "",
      ].join("\n");
      writePyTwoCellRepo(rootDir, index, { producer, consumerSource });
    },
  }, {
    id: "importlib-alias-private",
    expectedOk: false,
    ruleIds: ["CELLFENCE_PRIVATE_IMPORT"],
    setup(rootDir, index) {
      const producer = `producer${index}`;
      const consumerSource = [
        "import importlib",
        "load = importlib.import_module",
        `secret = load("${producer}.internal")`,
        `${symbolName(`consumer${index}`, 0)} = secret.secret${index}`,
        "",
      ].join("\n");
      writePyTwoCellRepo(rootDir, index, { producer, consumerSource });
    },
  }, {
    id: "importlib-getattr-private",
    expectedOk: false,
    ruleIds: ["CELLFENCE_PRIVATE_IMPORT"],
    setup(rootDir, index) {
      const producer = `producer${index}`;
      const consumerSource = [
        "import importlib",
        `secret = getattr(importlib, "import_module")("${producer}.internal")`,
        `${symbolName(`consumer${index}`, 0)} = secret.secret${index}`,
        "",
      ].join("\n");
      writePyTwoCellRepo(rootDir, index, { producer, consumerSource });
    },
  }, {
    id: "eval-dunder-import-private",
    expectedOk: false,
    ruleIds: ["CELLFENCE_PRIVATE_IMPORT"],
    setup(rootDir, index) {
      const producer = `producer${index}`;
      const consumerSource = [
        `secret = eval("__import__('${producer}.internal')")`,
        `${symbolName(`consumer${index}`, 0)} = bool(secret)`,
        "",
      ].join("\n");
      writePyTwoCellRepo(rootDir, index, { producer, consumerSource });
    },
  }, {
    id: "computed-python-dynamic-import-fail-closed",
    expectedOk: false,
    ruleIds: ["CELLFENCE_UNSUPPORTED_DYNAMIC_IMPORT"],
    setup(rootDir, index) {
      const producer = `producer${index}`;
      const consumerSource = [
        "import importlib",
        `target = "${producer}.internal"`,
        "secret = importlib.import_module(target)",
        `${symbolName(`consumer${index}`, 0)} = bool(secret)`,
        "",
      ].join("\n");
      writePyTwoCellRepo(rootDir, index, { producer, consumerSource });
    },
  }, {
    id: "python-syntax-recovery-fail-closed",
    expectedOk: false,
    ruleIds: ["CELLFENCE_UNSUPPORTED_PYTHON_SYNTAX"],
    setup(rootDir, index) {
      const cell = pyCell(`core${index}`);
      write(path.join(rootDir, "src", cell.id, "public.py"), `${symbolName(cell.id, 0)} = \n`);
      writeJson(path.join(rootDir, "cellfence.manifest.json"), manifest([cell]));
    },
  }, {
    id: "fastapi-route-without-contract",
    expectedOk: false,
    ruleIds: ["CELLFENCE_UNDECLARED_RESOURCE_ACCESS"],
    setup(rootDir, index) {
      const cell = pyCell(`api${index}`, { publicSymbols: ["health"] });
      write(path.join(rootDir, "src", cell.id, "public.py"), [
        "from fastapi import FastAPI, APIRouter",
        "app = FastAPI()",
        "router = APIRouter(prefix='/v1')",
        "@app.get('/health')",
        "def health():",
        "    return {'ok': True}",
        "@router.post('/items')",
        "def create_item():",
        "    return {'ok': True}",
        "",
      ].join("\n"));
      writeJson(path.join(rootDir, "cellfence.manifest.json"), manifest([cell]));
    },
  }, {
    id: "django-model-manager-without-contract",
    expectedOk: false,
    ruleIds: ["CELLFENCE_UNDECLARED_RESOURCE_ACCESS"],
    setup(rootDir, index) {
      const cell = pyCell(`django${index}`, { publicSymbols: ["run"] });
      write(path.join(rootDir, "src", cell.id, "public.py"), [
        "from django.db import models",
        "from django.urls import path",
        "class Order(models.Model):",
        "    class Meta:",
        `        db_table = 'orders_${index}'`,
        "urlpatterns = [path('orders/', lambda request: None)]",
        "def run():",
        "    Order.objects.filter(status='open').count()",
        "",
      ].join("\n"));
      writeJson(path.join(rootDir, "cellfence.manifest.json"), manifest([cell]));
    },
  }, {
    id: "sqlalchemy-dynamic-text-without-contract",
    expectedOk: false,
    ruleIds: ["CELLFENCE_UNDECLARED_RESOURCE_ACCESS"],
    setup(rootDir, index) {
      const cell = pyCell(`db${index}`, { publicSymbols: ["run"] });
      write(path.join(rootDir, "src", cell.id, "public.py"), [
        "from sqlalchemy import Table, select, insert, text",
        `users = Table('app_users_${index}', metadata)`,
        "def run(session):",
        "    session.execute(select(users))",
        `    session.execute(text('select * from app_users_${index}'))`,
        "",
      ].join("\n"));
      writeJson(path.join(rootDir, "cellfence.manifest.json"), manifest([cell]));
    },
  }, {
    id: "sqlalchemy-session-get-no-hint",
    expectedOk: false,
    ruleIds: ["CELLFENCE_UNDECLARED_RESOURCE_ACCESS"],
    setup(rootDir, index) {
      const cell = pyCell(`dbget${index}`, { publicSymbols: ["run"] });
      write(path.join(rootDir, "src", cell.id, "public.py"), [
        "class User(Base):",
        `    __tablename__ = 'app_users_${index}'`,
        "def run(session):",
        "    session.get(User, 1)",
        "",
      ].join("\n"));
      writeJson(path.join(rootDir, "cellfence.manifest.json"), manifest([cell]));
    },
  }, {
    id: "sqlalchemy-bulk-write-no-hint",
    expectedOk: false,
    ruleIds: ["CELLFENCE_UNDECLARED_RESOURCE_ACCESS"],
    setup(rootDir, index) {
      const cell = pyCell(`dbbulk${index}`, { publicSymbols: ["run"] });
      write(path.join(rootDir, "src", cell.id, "public.py"), [
        "class User(Base):",
        `    __tablename__ = 'bulk_users_${index}'`,
        "def run(session):",
        "    session.bulk_save_objects([User()])",
        "",
      ].join("\n"));
      writeJson(path.join(rootDir, "cellfence.manifest.json"), manifest([cell]));
    },
  }, {
    id: "celery-task-without-contract",
    expectedOk: false,
    ruleIds: ["CELLFENCE_UNDECLARED_RESOURCE_ACCESS"],
    setup(rootDir, index) {
      const cell = pyCell(`queue${index}`, { publicSymbols: ["run", "rebuild"] });
      write(path.join(rootDir, "src", cell.id, "public.py"), [
        "from celery import Celery, shared_task",
        "app = Celery('orders')",
        `@app.task(name='orders.rebuild.${index}')`,
        "def rebuild():",
        "    return None",
        "def run():",
        `    app.send_task('orders.rebuild.${index}')`,
        "",
      ].join("\n"));
      writeJson(path.join(rootDir, "cellfence.manifest.json"), manifest([cell]));
    },
  }, {
    id: "celery-delay-near-miss-control",
    expectedOk: true,
    ruleIds: [],
    setup(rootDir, index) {
      const cell = pyCell(`queuecontrol${index}`, { publicSymbols: ["run"] });
      write(path.join(rootDir, "src", cell.id, "public.py"), [
        "from celery import Celery as _Celery",
        "_app = _Celery('orders')",
        "class _Email:",
        "    def delay(self):",
        "        return None",
        "_email = _Email()",
        "def run():",
        "    _email.delay()",
        "",
      ].join("\n"));
      writeJson(path.join(rootDir, "cellfence.manifest.json"), manifest([cell]));
    },
  }, {
    id: "python-public-import-control",
    expectedOk: true,
    ruleIds: [],
    setup(rootDir, index) {
      const producer = `producer${index}`;
      const consumer = `consumer${index}`;
      const consumerSource = [
        `from ${producer}.public import ${symbolName(producer, 0)} as _producer_api`,
        `${symbolName(consumer, 0)} = _producer_api`,
        "",
      ].join("\n");
      writePyTwoCellRepo(rootDir, index, { producer, consumer, consumerSource });
    },
  }];
}

function jsTsTemplates() {
  return [{
    id: "import-equals-private",
    expectedOk: false,
    ruleIds: ["CELLFENCE_PRIVATE_IMPORT"],
    setup(rootDir, index) {
      const producer = `producer${index}`;
      const consumerSource = [
        `import secret = require("../${producer}/internal");`,
        `export const ${symbolName(`consumer${index}`, 0)} = secret.secret${index};`,
        "",
      ].join("\n");
      writeTsTwoCellRepo(rootDir, index, { producer, consumerSource });
    },
  }, {
    id: "module-require-private",
    expectedOk: false,
    ruleIds: ["CELLFENCE_PRIVATE_IMPORT"],
    setup(rootDir, index) {
      const producer = `producer${index}`;
      const consumerSource = [
        `const secret = module.require("../${producer}/internal");`,
        `export const ${symbolName(`consumer${index}`, 0)} = secret.secret${index};`,
        "",
      ].join("\n");
      writeTsTwoCellRepo(rootDir, index, { producer, consumerSource });
    },
  }, {
    id: "require-alias-private",
    expectedOk: false,
    ruleIds: ["CELLFENCE_PRIVATE_IMPORT"],
    setup(rootDir, index) {
      const producer = `producer${index}`;
      const consumerSource = [
        "const req = require;",
        `const secret = req("../${producer}/internal");`,
        `export const ${symbolName(`consumer${index}`, 0)} = secret.secret${index};`,
        "",
      ].join("\n");
      writeTsTwoCellRepo(rootDir, index, { producer, consumerSource });
    },
  }, {
    id: "create-require-private",
    expectedOk: false,
    ruleIds: ["CELLFENCE_PRIVATE_IMPORT"],
    setup(rootDir, index) {
      const producer = `producer${index}`;
      const consumerSource = [
        "import { createRequire as makeRequire } from 'node:module';",
        "const localRequire = makeRequire(import.meta.url);",
        `const secret = localRequire("../${producer}/internal");`,
        `export const ${symbolName(`consumer${index}`, 0)} = secret.secret${index};`,
        "",
      ].join("\n");
      writeTsTwoCellRepo(rootDir, index, { producer, consumerSource });
    },
  }, {
    id: "cjs-create-require-private",
    expectedOk: false,
    ruleIds: ["CELLFENCE_PRIVATE_IMPORT"],
    setup(rootDir, index) {
      const producer = `producer${index}`;
      const consumerSource = [
        "const { createRequire: makeRequire } = require('module');",
        "const localRequire = makeRequire(__filename);",
        `const secret = localRequire("../${producer}/internal");`,
        `export const ${symbolName(`consumer${index}`, 0)} = secret.secret${index};`,
        "",
      ].join("\n");
      writeTsTwoCellRepo(rootDir, index, { producer, consumerSource });
    },
  }, {
    id: "computed-require-fail-closed",
    expectedOk: false,
    ruleIds: ["CELLFENCE_UNSUPPORTED_DYNAMIC_REQUIRE"],
    setup(rootDir, index) {
      const producer = `producer${index}`;
      const consumerSource = [
        "const req = require;",
        `const target = "../${producer}/internal";`,
        "const secret = req(target);",
        `export const ${symbolName(`consumer${index}`, 0)} = Boolean(secret);`,
        "",
      ].join("\n");
      writeTsTwoCellRepo(rootDir, index, { producer, consumerSource });
    },
  }, {
    id: "computed-dynamic-import-fail-closed",
    expectedOk: false,
    ruleIds: ["CELLFENCE_UNSUPPORTED_DYNAMIC_IMPORT"],
    setup(rootDir, index) {
      const producer = `producer${index}`;
      const consumerSource = [
        `const target = "../${producer}/internal";`,
        `export async function ${symbolName(`consumer${index}`, 0)}() {`,
        "  return import(target);",
        "}",
        "",
      ].join("\n");
      writeTsTwoCellRepo(rootDir, index, {
        producer,
        consumerSource,
        consumer: `consumer${index}`,
      });
    },
  }, {
    id: "package-subpath-private",
    expectedOk: false,
    ruleIds: ["CELLFENCE_PRIVATE_IMPORT"],
    setup(rootDir, index) {
      const producer = `producer${index}`;
      const consumer = `consumer${index}`;
      const packageName = `@demo/${producer}`;
      writeJson(path.join(rootDir, "src", producer, "package.json"), { name: packageName });
      const consumerSource = [
        `import { secret${index} } from "${packageName}/internal";`,
        `export const ${symbolName(consumer, 0)} = secret${index};`,
        "",
      ].join("\n");
      writeTsTwoCellRepo(rootDir, index, { producer, consumer, consumerSource, packageName });
    },
  }, {
    id: "global-this-require-private",
    expectedOk: false,
    ruleIds: ["CELLFENCE_PRIVATE_IMPORT"],
    setup(rootDir, index) {
      const producer = `producer${index}`;
      const consumerSource = [
        `const secret = globalThis.require("../${producer}/internal");`,
        `export const ${symbolName(`consumer${index}`, 0)} = secret.secret${index};`,
        "",
      ].join("\n");
      writeTsTwoCellRepo(rootDir, index, { producer, consumerSource });
    },
  }, {
    id: "global-require-private",
    expectedOk: false,
    ruleIds: ["CELLFENCE_PRIVATE_IMPORT"],
    setup(rootDir, index) {
      const producer = `producer${index}`;
      const consumerSource = [
        `const secret = global.require("../${producer}/internal");`,
        `export const ${symbolName(`consumer${index}`, 0)} = secret.secret${index};`,
        "",
      ].join("\n");
      writeTsTwoCellRepo(rootDir, index, { producer, consumerSource });
    },
  }, {
    id: "top-level-this-require-private",
    expectedOk: false,
    ruleIds: ["CELLFENCE_PRIVATE_IMPORT"],
    setup(rootDir, index) {
      const producer = `producer${index}`;
      const consumerSource = [
        `const secret = this.require("../${producer}/internal");`,
        `export const ${symbolName(`consumer${index}`, 0)} = secret.secret${index};`,
        "",
      ].join("\n");
      writeTsTwoCellRepo(rootDir, index, { producer, consumerSource });
    },
  }, {
    id: "process-main-module-require-private",
    expectedOk: false,
    ruleIds: ["CELLFENCE_PRIVATE_IMPORT"],
    setup(rootDir, index) {
      const producer = `producer${index}`;
      const consumerSource = [
        `const secret = process.mainModule.require("../${producer}/internal");`,
        `export const ${symbolName(`consumer${index}`, 0)} = secret.secret${index};`,
        "",
      ].join("\n");
      writeTsTwoCellRepo(rootDir, index, { producer, consumerSource });
    },
  }, {
    id: "module-constructor-load-private",
    expectedOk: false,
    ruleIds: ["CELLFENCE_PRIVATE_IMPORT"],
    setup(rootDir, index) {
      const producer = `producer${index}`;
      const consumerSource = [
        `const secret = module.constructor._load("../${producer}/internal");`,
        `export const ${symbolName(`consumer${index}`, 0)} = secret.secret${index};`,
        "",
      ].join("\n");
      writeTsTwoCellRepo(rootDir, index, { producer, consumerSource });
    },
  }, {
    id: "eval-string-require-private",
    expectedOk: false,
    ruleIds: ["CELLFENCE_PRIVATE_IMPORT"],
    setup(rootDir, index) {
      const producer = `producer${index}`;
      const consumerSource = [
        `const secret = eval("require('../${producer}/internal')");`,
        `export const ${symbolName(`consumer${index}`, 0)} = Boolean(secret);`,
        "",
      ].join("\n");
      writeTsTwoCellRepo(rootDir, index, { producer, consumerSource });
    },
  }, {
    id: "computed-eval-string-require-fail-closed",
    expectedOk: false,
    ruleIds: ["CELLFENCE_UNSUPPORTED_DYNAMIC_REQUIRE"],
    setup(rootDir, index) {
      const producer = `producer${index}`;
      const consumerSource = [
        `const target = "../${producer}/internal";`,
        "const code = `require('${target}')`;",
        "const secret = eval(code);",
        `export const ${symbolName(`consumer${index}`, 0)} = Boolean(secret);`,
        "",
      ].join("\n");
      writeTsTwoCellRepo(rootDir, index, { producer, consumerSource });
    },
  }, {
    id: "import-type-node-private",
    expectedOk: false,
    ruleIds: ["CELLFENCE_PRIVATE_IMPORT"],
    setup(rootDir, index) {
      const producer = `producer${index}`;
      const consumerSource = [
        `type Secret = import("../${producer}/internal").secret${index};`,
        `export const ${symbolName(`consumer${index}`, 0)}: Secret = true;`,
        "",
      ].join("\n");
      writeTsTwoCellRepo(rootDir, index, { producer, consumerSource });
    },
  }, {
    id: "nested-tsconfig-alias-private",
    expectedOk: false,
    ruleIds: ["CELLFENCE_PRIVATE_IMPORT"],
    setup(rootDir, index) {
      const producer = `producer${index}`;
      const consumer = `consumer${index}`;
      write(path.join(rootDir, "packages", producer, "src", "public.ts"), `export const ${symbolName(producer, 0)} = true;\n`);
      write(path.join(rootDir, "packages", producer, "src", "internal.ts"), `export const secret${index} = true;\n`);
      write(path.join(rootDir, "packages", consumer, "src", "public.ts"), [
        `import { secret${index} } from "@${producer}/internal";`,
        `export const ${symbolName(consumer, 0)} = secret${index};`,
        "",
      ].join("\n"));
      writeJson(path.join(rootDir, "packages", consumer, "tsconfig.json"), {
        compilerOptions: {
          baseUrl: ".",
          paths: { [`@${producer}/*`]: [`../${producer}/src/*`] },
        },
      });
      writeJson(path.join(rootDir, "cellfence.manifest.json"), manifest([
        tsCell(producer, {
          ownedPaths: [`packages/${producer}/src/**`],
          publicEntry: `packages/${producer}/src/public.ts`,
          publicSymbols: [symbolName(producer, 0)],
        }),
        tsCell(consumer, {
          ownedPaths: [`packages/${consumer}/src/**`],
          publicEntry: `packages/${consumer}/src/public.ts`,
          publicSymbols: [symbolName(consumer, 0)],
          consumes: [{ cell: producer }],
        }),
      ], { include: ["packages/**"] }));
    },
  }, {
    id: "package-imports-map-private",
    expectedOk: false,
    ruleIds: ["CELLFENCE_PRIVATE_IMPORT"],
    setup(rootDir, index) {
      const producer = `producer${index}`;
      const consumer = `consumer${index}`;
      write(path.join(rootDir, "src", producer, "public.ts"), `export const ${symbolName(producer, 0)} = true;\n`);
      write(path.join(rootDir, "src", producer, "internal.ts"), `export const secret${index} = true;\n`);
      write(path.join(rootDir, "src", consumer, "public.ts"), [
        `import { secret${index} } from "#${producer}/internal";`,
        `export const ${symbolName(consumer, 0)} = secret${index};`,
        "",
      ].join("\n"));
      writeJson(path.join(rootDir, "package.json"), {
        imports: { [`#${producer}/internal`]: `./src/${producer}/internal.ts` },
      });
      writeJson(path.join(rootDir, "cellfence.manifest.json"), manifest([
        tsCell(producer, { publicSymbols: [symbolName(producer, 0)] }),
        tsCell(consumer, {
          publicSymbols: [symbolName(consumer, 0)],
          consumes: [{ cell: producer }],
        }),
      ]));
    },
  }, {
    id: "package-imports-types-condition-runtime-private",
    expectedOk: false,
    ruleIds: ["CELLFENCE_PRIVATE_IMPORT"],
    setup(rootDir, index) {
      const producer = `producer${index}`;
      const consumer = `consumer${index}`;
      write(path.join(rootDir, "src", producer, "public.ts"), `export const ${symbolName(producer, 0)} = true;\n`);
      write(path.join(rootDir, "src", producer, "internal.ts"), `export const secret${index} = true;\n`);
      write(path.join(rootDir, "src", consumer, "public.ts"), [
        `import { secret${index} } from "#${producer}/internal";`,
        `export const ${symbolName(consumer, 0)} = secret${index};`,
        "",
      ].join("\n"));
      writeJson(path.join(rootDir, "package.json"), {
        imports: {
          [`#${producer}/internal`]: {
            types: `./src/${producer}/public.ts`,
            default: `./src/${producer}/internal.ts`,
          },
        },
      });
      writeJson(path.join(rootDir, "cellfence.manifest.json"), manifest([
        tsCell(producer, { publicSymbols: [symbolName(producer, 0)] }),
        tsCell(consumer, {
          publicSymbols: [symbolName(consumer, 0)],
          consumes: [{ cell: producer }],
        }),
      ]));
    },
  }, {
    id: "typescript-syntax-recovery-fail-closed",
    expectedOk: false,
    ruleIds: ["CELLFENCE_UNSUPPORTED_TYPESCRIPT_SYNTAX"],
    setup(rootDir, index) {
      const cell = tsCell(`core${index}`);
      write(path.join(rootDir, "src", cell.id, "public.ts"), `export const ${symbolName(cell.id, 0)} = ;\n`);
      writeJson(path.join(rootDir, "cellfence.manifest.json"), manifest([cell]));
    },
  }, {
    id: "shadowed-require-control",
    expectedOk: true,
    ruleIds: [],
    setup(rootDir, index) {
      const producer = `producer${index}`;
      const consumerSource = [
        "const req = require;",
        "function harmless(req: (value: string) => string) {",
        `  return req("../${producer}/internal");`,
        "}",
        `export const ${symbolName(`consumer${index}`, 0)} = harmless((value) => value);`,
        "",
      ].join("\n");
      writeTsTwoCellRepo(rootDir, index, { producer, consumerSource });
    },
  }, {
    id: "namespace-public-symbol-control",
    expectedOk: true,
    ruleIds: [],
    setup(rootDir, index) {
      const cell = tsCell(`core${index}`, { publicSymbols: [`Api${index}`] });
      write(path.join(rootDir, "src", cell.id, "public.ts"), [
        `export namespace Api${index} {`,
        "  export const value = true;",
        "}",
        "",
      ].join("\n"));
      writeJson(path.join(rootDir, "cellfence.manifest.json"), manifest([cell]));
    },
  }];
}

const templatesByCategory = {
  "language-independent": languageIndependentTemplates(),
  python: pythonTemplates(),
  "js-ts": jsTsTemplates(),
};

function executeCase(category, iteration, options) {
  const templates = templatesByCategory[category];
  const template = templates[iteration % templates.length];
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), `cellfence-adversarial-${category}-`));
  const startedAt = performance.now();
  try {
    template.setup(rootDir, iteration);
    const result = runCheck(rootDir, template.runOptions || {});
    const passed = template.expectedOk
      ? result.ok === true && result.findings.length === 0
      : result.ok === false && hasAllRules(result, template.ruleIds);
    return {
      category,
      iteration,
      templateId: template.id,
      ok: passed,
      expectedOk: template.expectedOk,
      expectedRuleIds: template.ruleIds,
      observedOk: result.ok,
      exitCode: result.exitCode,
      findingRuleIds: findingRules(result),
      warningRuleIds: warningRules(result),
      durationMs: Math.round(performance.now() - startedAt),
      rootDir: options.keep ? rootDir : undefined,
    };
  } catch (error) {
    return {
      category,
      iteration,
      templateId: template.id,
      ok: false,
      expectedOk: template.expectedOk,
      expectedRuleIds: template.ruleIds,
      error: error instanceof Error ? error.stack || error.message : String(error),
      durationMs: Math.round(performance.now() - startedAt),
      rootDir: options.keep ? rootDir : undefined,
    };
  } finally {
    if (!options.keep) fs.rmSync(rootDir, { recursive: true, force: true });
  }
}

export function runAdversarialValidation(options = {}) {
  const iterations = options.iterations || 100;
  const selectedCategories = options.category ? [options.category] : categories;
  const startedAt = performance.now();
  const cases = [];
  for (const category of selectedCategories) {
    for (let iteration = 0; iteration < iterations; iteration += 1) {
      cases.push(executeCase(category, iteration, options));
    }
  }
  const summary = Object.fromEntries(selectedCategories.map((category) => {
    const categoryCases = cases.filter((testCase) => testCase.category === category);
    return [category, {
      total: categoryCases.length,
      passed: categoryCases.filter((testCase) => testCase.ok).length,
      failed: categoryCases.filter((testCase) => !testCase.ok).length,
      expectedBlocks: categoryCases.filter((testCase) => !testCase.expectedOk).length,
      confirmedBlocks: categoryCases.filter((testCase) => !testCase.expectedOk && testCase.observedOk === false).length,
      expectedGreens: categoryCases.filter((testCase) => testCase.expectedOk).length,
      confirmedGreens: categoryCases.filter((testCase) => testCase.expectedOk && testCase.observedOk === true && testCase.findingRuleIds?.length === 0).length,
      templates: [...new Set(categoryCases.map((testCase) => testCase.templateId))].sort(),
    }];
  }));
  return {
    schemaVersion: "cellfence.adversarial-validation.v1",
    generatedAt: new Date().toISOString(),
    iterationsPerCategory: iterations,
    categories: selectedCategories,
    ok: cases.every((testCase) => testCase.ok),
    durationMs: Math.round(performance.now() - startedAt),
    summary,
    failures: cases.filter((testCase) => !testCase.ok),
    cases,
  };
}

function printHumanReport(report) {
  console.log(`CellFence adversarial validation ${report.ok ? "passed" : "failed"}`);
  console.log(`iterations per category: ${report.iterationsPerCategory}`);
  for (const category of report.categories) {
    const item = report.summary[category];
    console.log(`${category}: ${item.passed}/${item.total} expected outcomes matched; blocks ${item.confirmedBlocks}/${item.expectedBlocks}; greens ${item.confirmedGreens}/${item.expectedGreens}`);
  }
  if (!report.ok) {
    for (const failure of report.failures.slice(0, 20)) {
      console.error(`FAIL ${failure.category}#${failure.iteration} ${failure.templateId}: expected ${failure.expectedOk ? "green" : failure.expectedRuleIds.join(",")} observed ${failure.observedOk} ${failure.findingRuleIds?.join(",") || failure.error || ""}`);
    }
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const options = parseArgs(process.argv);
    const report = runAdversarialValidation(options);
    if (options.outPath) writeJson(path.resolve(options.outPath), report);
    if (options.json) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      printHumanReport(report);
    }
    process.exitCode = report.ok ? 0 : 1;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
  }
}
