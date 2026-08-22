import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  checkRepository,
  createBaseline,
  createCellContext,
  guardBaselineUpdate,
  sealBaselineWithConfiguredKey,
} from "../packages/engine/dist/index.js";

function writeFile(filePath, contents) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${contents.trimEnd()}\n`);
}

function writeJson(filePath, value) {
  writeFile(filePath, JSON.stringify(value, null, 2));
}

function baseManifest(cells) {
  return {
    schemaVersion: "cellfence.manifest.v1",
    governance: {
      requireOwnership: true,
      include: ["src/**"],
      exclude: [],
    },
    cells,
  };
}

function cell(id, patch = {}) {
  return {
    id,
    ownedPaths: [`src/${id}/**`],
    publicEntry: `src/${id}/public.ts`,
    publicSymbols: [id],
    consumes: [],
    producesArtifacts: [],
    ...patch,
  };
}

function baselineFor(cells) {
  const records = {};
  for (const { id, externalDependencySet = [] } of cells) {
    records[id] = {
      ownedPathPatterns: 1,
      publicSymbols: 1,
      publicSurfaceLines: 99,
      crossCellDependencies: 0,
      ownedPathSet: [`src/${id}/**`],
      publicEntryPath: `src/${id}/public.ts`,
      publicSymbolSet: [id],
      dependencyEdges: [],
      artifactContracts: [],
      resourceAccesses: [],
      externalDependencySet,
    };
  }
  return {
    schemaVersion: "cellfence.baseline.v1",
    generatedAt: "2026-01-01T00:00:00.000Z",
    cellIds: cells.map(({ id }) => id),
    cells: records,
  };
}

function setup(rootDir, manifest, files, baseline) {
  writeJson(path.join(rootDir, "cellfence.manifest.json"), manifest);
  if (baseline) writeJson(path.join(rootDir, "cellfence.baseline.json"), baseline);
  for (const [relativePath, contents] of Object.entries(files)) writeFile(path.join(rootDir, relativePath), contents);
}

function run(rootDir, baseline = false) {
  return checkRepository({
    rootDir,
    manifestPath: "cellfence.manifest.json",
    baselinePath: baseline ? "cellfence.baseline.json" : undefined,
  });
}

function withHmacSeal(callback) {
  const previous = process.env.CELLFENCE_BASELINE_HMAC_KEY;
  process.env.CELLFENCE_BASELINE_HMAC_KEY = "test-baseline-secret";
  try {
    return callback();
  } finally {
    if (previous === undefined) delete process.env.CELLFENCE_BASELINE_HMAC_KEY;
    else process.env.CELLFENCE_BASELINE_HMAC_KEY = previous;
  }
}

function ruleIds(result) {
  return result.findings.map((finding) => finding.ruleId).sort();
}

test("external dependency claims are exclusive and baseline cannot justify another cell's use", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-external-claim-"));
  try {
    setup(
      rootDir,
      baseManifest([
        cell("money", { externalDependencies: { claim: ["npm:decimal.js"] } }),
        cell("domain"),
      ]),
      {
        "src/money/public.ts": 'import Decimal from "decimal.js";\nexport const money = Decimal;',
        "src/domain/public.ts": 'import Decimal from "decimal.js";\nexport const domain = Decimal;',
      },
      baselineFor([
        { id: "money", externalDependencySet: ["npm:decimal.js"] },
        { id: "domain", externalDependencySet: ["npm:decimal.js"] },
      ]),
    );

    const result = run(rootDir, true);
    assert.equal(result.ok, false);
    assert.deepEqual(ruleIds(result), ["CELLFENCE_EXTERNAL_DEPENDENCY_CLAIM_VIOLATION"]);
    assert.equal(result.findings[0].cellId, "domain");
    assert.equal(result.findings[0].details.dependencyId, "npm:decimal.js");
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("external dependency ratchet honors baseline, allow, and locked-cell expansion order", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-external-ratchet-"));
  try {
    const manifest = baseManifest([
      cell("app", {
        externalDependencies: { allow: ["npm:decimal.js"] },
        locked: true,
      }),
    ]);
    const baseline = withHmacSeal(() => sealBaselineWithConfiguredKey(baselineFor([{ id: "app", externalDependencySet: ["npm:zod"] }])));
    setup(rootDir, manifest, {
      "src/app/public.ts": `
        import Decimal from "decimal.js";
        import { z } from "zod";
        export const app = Decimal && z;
      `,
    }, baseline);

    const result = withHmacSeal(() => run(rootDir, true));
    assert.equal(result.ok, false);
    assert.deepEqual(ruleIds(result), ["CELLFENCE_LOCKED_EXTERNAL_DEPENDENCY_EXPANSION"]);
    assert.equal(result.findings[0].details.dependencyId, "npm:decimal.js");
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("external dependency additions are ratcheted when absent from baseline and manifest", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-external-added-"));
  try {
    setup(
      rootDir,
      baseManifest([cell("app")]),
      {
        "src/app/public.ts": 'import Decimal from "decimal.js";\nexport const app = Decimal;',
      },
      baselineFor([{ id: "app", externalDependencySet: [] }]),
    );

    const result = run(rootDir, true);
    assert.equal(result.ok, false);
    assert.deepEqual(ruleIds(result), ["CELLFENCE_RATCHET_EXTERNAL_DEPENDENCY_ADDED"]);
    assert.equal(result.findings[0].details.dependencyId, "npm:decimal.js");
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("external dependency ratchet treats missing baseline sets as a legacy migration", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-external-legacy-baseline-"));
  try {
    const unsealedLegacyBaseline = baselineFor([{ id: "app" }]);
    delete unsealedLegacyBaseline.cells.app.externalDependencySet;
    const legacyBaseline = withHmacSeal(() => sealBaselineWithConfiguredKey(unsealedLegacyBaseline));
    setup(
      rootDir,
      baseManifest([cell("app", { locked: true })]),
      {
        "src/app/public.ts": 'import Decimal from "decimal.js";\nexport const app = Decimal;',
      },
      legacyBaseline,
    );

    const result = withHmacSeal(() => run(rootDir, true));
    assert.equal(result.ok, true, JSON.stringify(result.findings, null, 2));

    const nextBaseline = baselineFor([{ id: "app", externalDependencySet: ["npm:decimal.js"] }]);
    const guard = guardBaselineUpdate({
      rootDir,
      manifestPath: "cellfence.manifest.json",
      baselinePath: "cellfence.baseline.json",
      nextBaseline,
    });
    assert.equal(guard.ok, true, JSON.stringify(guard.findings, null, 2));
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("external dependency observations canonicalize JS and Python packages while excluding builtins and local resolution", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-external-observe-"));
  try {
    setup(
      rootDir,
      baseManifest([
        cell("app", {
          externalDependencies: {
            allow: ["npm:zod", "npm:decimal.js", "npm:@scope/pkg"],
          },
        }),
        {
          id: "py",
          ownedPaths: ["src/py/**"],
          publicEntry: "src/py/public.py",
          publicSymbols: ["py"],
          externalDependencies: {
            allow: ["python-import:yaml", "python-import:pydantic"],
          },
        },
      ]),
      {
        "package.json": JSON.stringify({ imports: { "#internal": "./src/app/internal.ts" } }),
        "tsconfig.json": JSON.stringify({ compilerOptions: { baseUrl: ".", paths: { "@app/*": ["src/app/*"] } } }),
        "src/app/public.ts": "export const app = true;",
        "src/app/internal.ts": "export const internal = true;",
        "src/app/uses.ts": `
          import fs from "fs";
          import path from "node:path";
          import type { ZodType } from "zod";
          export * from "decimal.js";
          export { widget } from "@scope/pkg/subpath";
          import { internal } from "#internal";
          import { app } from "@app/public";
          const required = require("zod");
          export async function load() { return [fs, path, internal, app, required, import("zod")]; }
        `,
        "src/py/public.py": `
__all__ = ["py"]
import yaml
import json
from pydantic import BaseModel
def py():
    return yaml, json, BaseModel
        `,
      },
    );

    const baseline = createBaseline({ rootDir, manifestPath: "cellfence.manifest.json" });
    assert.deepEqual(baseline.cells.app.externalDependencySet, [
      "npm:@scope/pkg",
      "npm:decimal.js",
      "npm:zod",
    ]);
    assert.deepEqual(baseline.cells.py.externalDependencySet, [
      "python-import:pydantic",
      "python-import:yaml",
    ]);

    const result = run(rootDir);
    assert.equal(result.ok, true, JSON.stringify(result.findings, null, 2));
    assert.deepEqual(result.metrics.app.externalDependencySet, baseline.cells.app.externalDependencySet);
    assert.deepEqual(result.metrics.py.externalDependencySet, baseline.cells.py.externalDependencySet);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("external dependency context reports manifest and baseline grants separately", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-external-context-"));
  try {
    setup(
      rootDir,
      baseManifest([
        cell("app", {
          externalDependencies: {
            claim: ["npm:decimal.js"],
            allow: ["npm:zod"],
          },
        }),
      ]),
      {
        "src/app/public.ts": 'import Decimal from "decimal.js";\nimport { z } from "zod";\nexport const app = Decimal && z;',
      },
      baselineFor([{ id: "app", externalDependencySet: ["npm:legacy"] }]),
    );

    const context = createCellContext({
      rootDir,
      manifestPath: "cellfence.manifest.json",
      baselinePath: "cellfence.baseline.json",
      cellId: "app",
    });
    assert.deepEqual(context.claimedExternalDependencies, [{ dependencyId: "npm:decimal.js", source: "claim" }]);
    assert.deepEqual(context.allowedExternalDependencies, [{ dependencyId: "npm:zod", source: "allow" }]);
    assert.deepEqual(context.baselineExternalDependencies, ["npm:legacy"]);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("locked baseline guard rejects external dependency grandfathering", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-external-guard-"));
  try {
    setup(
      rootDir,
      baseManifest([cell("app", { locked: true })]),
      {
        "src/app/public.ts": "export const app = true;",
      },
      baselineFor([{ id: "app", externalDependencySet: [] }]),
    );
    const nextBaseline = baselineFor([{ id: "app", externalDependencySet: ["npm:decimal.js"] }]);
    const result = guardBaselineUpdate({
      rootDir,
      manifestPath: "cellfence.manifest.json",
      baselinePath: "cellfence.baseline.json",
      nextBaseline,
    });
    assert.equal(result.ok, false);
    assert.deepEqual(ruleIds(result), ["CELLFENCE_LOCKED_BASELINE_EXPANSION"]);
    assert.match(result.findings[0].message, /external dependencies would be added/);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});
