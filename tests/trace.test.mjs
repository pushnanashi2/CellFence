import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

const root = process.cwd();
const tracePath = path.join(root, "packages/trace/dist/index.js");

function withoutTraceCommitEnv(extra = {}) {
  return {
    ...Object.fromEntries(Object.entries(process.env).filter(([name]) =>
      name !== "CELLFENCE_TRACE_COMMIT_SHA" && name !== "GITHUB_SHA")),
    ...extra,
  };
}

test("trace hook emits runtime file resource evidence", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-trace-"));
  fs.mkdirSync(path.join(tempDir, "data"), { recursive: true });
  fs.writeFileSync(path.join(tempDir, "data/input.json"), "{\"ok\":true}\n");
  fs.writeFileSync(path.join(tempDir, "app.mjs"), `
    import fs from "node:fs";
    fs.readFileSync("data/input.json", "utf8");
    fs.writeFileSync("data/output.json", "{}\\n");
  `);

  const evidencePath = path.join(tempDir, "resource-evidence.json");
  const result = spawnSync(process.execPath, [
    "--import",
    pathToFileURL(tracePath).href,
    "app.mjs",
  ], {
    cwd: tempDir,
    encoding: "utf8",
    env: {
      ...process.env,
      CELLFENCE_TRACE_CELL: "runtime",
      CELLFENCE_TRACE_OUT: evidencePath,
    },
  });

  assert.equal(result.status, 0, result.stderr);
  const evidence = JSON.parse(fs.readFileSync(evidencePath, "utf8"));
  assert.equal(evidence.schemaVersion, "cellfence.resource-evidence.v2");
  assert.equal(evidence.transcriptStatus, "active");
  assert.equal(evidence.cellId, "runtime");
  assert.deepEqual(evidence.accesses, [
    {
      kind: "file",
      access: "read",
      selector: "data/input.json",
      cellId: "runtime",
      detectedBy: "cellfence-trace",
      confidence: "transient",
    },
    {
      kind: "file",
      access: "write",
      selector: "data/output.json",
      cellId: "runtime",
      detectedBy: "cellfence-trace",
      confidence: "transient",
    },
  ]);
});

test("trace hook emits async and append file evidence while ignoring source files", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-trace-async-"));
  fs.mkdirSync(path.join(tempDir, "data"), { recursive: true });
  fs.writeFileSync(path.join(tempDir, "data/input.json"), "{\"ok\":true}\n");
  fs.writeFileSync(path.join(tempDir, "data/orders data.json"), "{\"ok\":true}\n");
  for (const extension of ["js", "cjs", "ts", "tsx", "jsx", "mts", "cts"]) {
    fs.writeFileSync(path.join(tempDir, `source.${extension}`), "export const ignored = true;\n");
  }
  fs.writeFileSync(path.join(tempDir, "app.mjs"), `
    import fs from "node:fs";
    import { appendFile, readFile, writeFile } from "node:fs/promises";
    await readFile("data/input.json", "utf8");
    fs.readFileSync(new URL("./data/input.json", import.meta.url), "utf8");
    fs.readFileSync(new URL("./data/orders data.json", import.meta.url), "utf8");
    await writeFile("data/promise-write.json", "{}\\n");
    await appendFile("data/promise-append.json", "{}\\n");
    fs.appendFileSync("data/sync-output.json", "{}\\n");
    fs.readFileSync("app.mjs", "utf8");
    for (const extension of ["js", "cjs", "ts", "tsx", "jsx", "mts", "cts"]) {
      fs.readFileSync(\`source.\${extension}\`, "utf8");
    }
  `);

  const evidencePath = path.join(tempDir, "resource-evidence.json");
  const result = spawnSync(process.execPath, [
    "--import",
    pathToFileURL(tracePath).href,
    "app.mjs",
  ], {
    cwd: tempDir,
    encoding: "utf8",
    env: {
      ...process.env,
      CELLFENCE_TRACE_CELL: "runtime",
      CELLFENCE_TRACE_OUT: evidencePath,
    },
  });

  assert.equal(result.status, 0, result.stderr);
  const evidence = JSON.parse(fs.readFileSync(evidencePath, "utf8"));
  const observed = evidence.accesses.map((access) => `${access.access}:${access.selector}`);
  assert.ok(observed.includes("read:data/input.json"));
  assert.ok(observed.some((entry) => entry.startsWith("read:") && entry.endsWith("/data/input.json")));
  assert.ok(observed.some((entry) => entry.startsWith("read:") && entry.endsWith("/data/orders data.json")));
  assert.equal(observed.some((entry) => entry.includes("orders%20data.json")), false);
  assert.ok(observed.includes("write:data/promise-write.json"));
  assert.ok(observed.includes("write:data/promise-append.json"));
  assert.ok(observed.includes("write:data/sync-output.json"));
  assert.equal(observed.some((entry) => entry.endsWith("app.mjs")), false);
  assert.equal(observed.some((entry) => entry.includes("source.")), false);
});

test("trace hook labels appendFileSync accesses as writes", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-trace-append-sync-"));
  fs.writeFileSync(path.join(tempDir, "app.mjs"), `
    import fs from "node:fs";
    fs.appendFileSync("append-only.dat", "x");
  `);

  const evidencePath = path.join(tempDir, "resource-evidence.json");
  const result = spawnSync(process.execPath, [
    "--import",
    pathToFileURL(tracePath).href,
    "app.mjs",
  ], {
    cwd: tempDir,
    encoding: "utf8",
    env: {
      ...process.env,
      CELLFENCE_TRACE_CELL: "runtime",
      CELLFENCE_TRACE_OUT: evidencePath,
    },
  });

  assert.equal(result.status, 0, result.stderr);
  const evidence = JSON.parse(fs.readFileSync(evidencePath, "utf8"));
  assert.deepEqual(evidence.accesses, [{
    kind: "file",
    access: "write",
    selector: "append-only.dat",
    cellId: "runtime",
    detectedBy: "cellfence-trace",
    confidence: "transient",
  }]);
});

test("trace hook skips disabled output but writes active empty transcripts", () => {
  const disabledDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-trace-disabled-"));
  fs.writeFileSync(path.join(disabledDir, "app.mjs"), "import fs from 'node:fs'; fs.writeFileSync('data.json', '{}');\n");
  const disabledEvidence = path.join(disabledDir, "resource-evidence.json");
  const disabled = spawnSync(process.execPath, [
    "--import",
    pathToFileURL(tracePath).href,
    "app.mjs",
  ], {
    cwd: disabledDir,
    encoding: "utf8",
    env: {
      ...process.env,
      CELLFENCE_TRACE_DISABLE: "1",
      CELLFENCE_TRACE_OUT: disabledEvidence,
    },
  });
  assert.equal(disabled.status, 0, disabled.stderr);
  assert.equal(fs.existsSync(disabledEvidence), false);

  const unusedDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-trace-unused-"));
  fs.writeFileSync(path.join(unusedDir, "app.mjs"), "console.log('no resource access');\n");
  const unusedEvidence = path.join(unusedDir, "resource-evidence.json");
  const unused = spawnSync(process.execPath, [
    "--import",
    pathToFileURL(tracePath).href,
    "app.mjs",
  ], {
    cwd: unusedDir,
    encoding: "utf8",
    env: {
      ...process.env,
      CELLFENCE_TRACE_OUT: unusedEvidence,
    },
  });
  assert.equal(unused.status, 0, unused.stderr);
  assert.equal(fs.existsSync(unusedEvidence), true);
  const evidence = JSON.parse(fs.readFileSync(unusedEvidence, "utf8"));
  assert.equal(evidence.transcriptStatus, "active");
  assert.deepEqual(evidence.accesses, []);
});

test("trace hook emits runtime manual database, queue, and HTTP evidence", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-trace-manual-"));
  fs.writeFileSync(path.join(tempDir, "app.mjs"), `
    import { recordDatabaseAccess, recordHttpAccess, recordQueueAccess } from ${JSON.stringify(pathToFileURL(tracePath).href)};
    recordDatabaseAccess("app_users", "read");
    recordDatabaseAccess("app_users", "write");
    recordHttpAccess("https://api.example.test/v1/status");
    recordQueueAccess("kafka:research.events", "publish");
  `);

  const evidencePath = path.join(tempDir, "resource-evidence.json");
  const result = spawnSync(process.execPath, ["app.mjs"], {
    cwd: tempDir,
    encoding: "utf8",
    env: {
      ...process.env,
      CELLFENCE_TRACE_CELL: "runtime",
      CELLFENCE_TRACE_OUT: evidencePath,
    },
  });

  assert.equal(result.status, 0, result.stderr);
  const evidence = JSON.parse(fs.readFileSync(evidencePath, "utf8"));
  assert.deepEqual(evidence.accesses.map((access) => `${access.kind}:${access.access}:${access.selector}`), [
    "database:read:app_users",
    "database:write:app_users",
    "http:call:https://api.example.test/v1/status",
    "queue:publish:kafka:research.events",
  ]);
});

test("trace hook caps unique accesses and marks capped transcripts incomplete", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-trace-access-cap-"));
  fs.writeFileSync(path.join(tempDir, "app.mjs"), `
    import { recordDatabaseAccess } from ${JSON.stringify(pathToFileURL(tracePath).href)};
    recordDatabaseAccess("app_users", "read");
    recordDatabaseAccess("app_orders", "read");
    recordDatabaseAccess("app_fills", "read");
  `);

  const evidencePath = path.join(tempDir, "resource-evidence.json");
  const result = spawnSync(process.execPath, ["app.mjs"], {
    cwd: tempDir,
    encoding: "utf8",
    env: {
      ...process.env,
      CELLFENCE_TRACE_CELL: "runtime",
      CELLFENCE_TRACE_MAX_ACCESSES: "2",
      CELLFENCE_TRACE_OUT: evidencePath,
    },
  });

  assert.equal(result.status, 0, result.stderr);
  const evidence = JSON.parse(fs.readFileSync(evidencePath, "utf8"));
  assert.equal(evidence.transcriptStatus, "incomplete");
  assert.deepEqual(evidence.accesses.map((access) => access.selector), ["app_orders", "app_users"]);
});

test("trace hook ignores invalid access cap values", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-trace-invalid-access-cap-"));
  fs.writeFileSync(path.join(tempDir, "app.mjs"), `
    import { recordDatabaseAccess } from ${JSON.stringify(pathToFileURL(tracePath).href)};
    recordDatabaseAccess("app_users", "read");
    recordDatabaseAccess("app_orders", "read");
  `);

  const evidencePath = path.join(tempDir, "resource-evidence.json");
  const result = spawnSync(process.execPath, ["app.mjs"], {
    cwd: tempDir,
    encoding: "utf8",
    env: {
      ...process.env,
      CELLFENCE_TRACE_CELL: "runtime",
      CELLFENCE_TRACE_MAX_ACCESSES: "0",
      CELLFENCE_TRACE_OUT: evidencePath,
    },
  });

  assert.equal(result.status, 0, result.stderr);
  const evidence = JSON.parse(fs.readFileSync(evidencePath, "utf8"));
  assert.equal(evidence.transcriptStatus, "active");
  assert.deepEqual(evidence.accesses.map((access) => access.selector), ["app_orders", "app_users"]);
});

test("plain trace imports do not monkey-patch file access", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-trace-plain-import-"));
  fs.writeFileSync(path.join(tempDir, "app.mjs"), `
    import fs from "node:fs";
    await import(${JSON.stringify(`${pathToFileURL(tracePath).href}?plain-import`)});
    fs.writeFileSync("should-not-be-traced.json", "{}\\n");
  `);

  const evidencePath = path.join(tempDir, "resource-evidence.json");
  const result = spawnSync(process.execPath, ["app.mjs"], {
    cwd: tempDir,
    encoding: "utf8",
    env: {
      ...process.env,
      CELLFENCE_TRACE_CELL: "runtime",
      CELLFENCE_TRACE_OUT: evidencePath,
    },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.existsSync(evidencePath), false);
});

test("plain trace imports stay silent even when flush is called", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-trace-plain-flush-"));
  fs.writeFileSync(path.join(tempDir, "app.mjs"), `
    const trace = await import(${JSON.stringify(`${pathToFileURL(tracePath).href}?plain-flush`)});
    trace.flushEvidence();
  `);

  const evidencePath = path.join(tempDir, "resource-evidence.json");
  const result = spawnSync(process.execPath, ["app.mjs"], {
    cwd: tempDir,
    encoding: "utf8",
    env: {
      ...process.env,
      CELLFENCE_TRACE_CELL: "runtime",
      CELLFENCE_TRACE_OUT: evidencePath,
    },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.existsSync(evidencePath), false);
});

test("trace auto-installs for package preload forms and explicit env opt-in", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-trace-package-preload-"));
  const appPath = path.join(tempDir, "app.mjs");
  fs.writeFileSync(appPath, `
    import fs from "node:fs";
    process.chdir(${JSON.stringify(tempDir)});
    fs.writeFileSync("package-preload.json", "{}\\n");
  `);
  const packageEvidencePath = path.join(tempDir, "package-resource-evidence.json");
  const packagePreload = spawnSync(process.execPath, [
    "--import=@cellfence/trace",
    appPath,
  ], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      CELLFENCE_TRACE_CELL: "runtime",
      CELLFENCE_TRACE_OUT: packageEvidencePath,
    },
  });
  assert.equal(packagePreload.status, 0, packagePreload.stderr);
  assert.ok(JSON.parse(fs.readFileSync(packageEvidencePath, "utf8")).accesses.some((access) => access.selector === "package-preload.json"));

  const autoPath = path.join(tempDir, "auto.mjs");
  fs.writeFileSync(autoPath, `
    import fs from "node:fs";
    process.chdir(${JSON.stringify(tempDir)});
    fs.writeFileSync("auto-preload.json", "{}\\n");
  `);
  const autoEvidencePath = path.join(tempDir, "auto-resource-evidence.json");
  const autoPreload = spawnSync(process.execPath, [
    "--import",
    "@cellfence/trace/auto",
    autoPath,
  ], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      CELLFENCE_TRACE_CELL: "runtime",
      CELLFENCE_TRACE_OUT: autoEvidencePath,
    },
  });
  assert.equal(autoPreload.status, 0, autoPreload.stderr);
  assert.ok(JSON.parse(fs.readFileSync(autoEvidencePath, "utf8")).accesses.some((access) => access.selector === "auto-preload.json"));

  const envPath = path.join(tempDir, "env.mjs");
  fs.writeFileSync(envPath, `
    import fs from "node:fs";
    import { traceDiagnostics } from ${JSON.stringify(pathToFileURL(tracePath).href)};
    process.chdir(${JSON.stringify(tempDir)});
    if (!traceDiagnostics().installed) throw new Error("env opt-in did not install trace");
    fs.writeFileSync("env-preload.json", "{}\\n");
  `);
  const envEvidencePath = path.join(tempDir, "env-resource-evidence.json");
  const envOptIn = spawnSync(process.execPath, [envPath], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      CELLFENCE_TRACE_AUTO_INSTALL: "1",
      CELLFENCE_TRACE_CELL: "runtime",
      CELLFENCE_TRACE_OUT: envEvidencePath,
    },
  });
  assert.equal(envOptIn.status, 0, envOptIn.stderr);
  assert.ok(JSON.parse(fs.readFileSync(envEvidencePath, "utf8")).accesses.some((access) => access.selector === "env-preload.json"));
});

test("unrelated preloads do not make trace imports install globally", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-trace-unrelated-preload-"));
  fs.writeFileSync(path.join(tempDir, "app.mjs"), `
    import fs from "node:fs";
    await import(${JSON.stringify(`${pathToFileURL(tracePath).href}?unrelated-preload`)});
    fs.writeFileSync("unrelated-preload.json", "{}\\n");
  `);
  const evidencePath = path.join(tempDir, "resource-evidence.json");
  const result = spawnSync(process.execPath, [
    "--import",
    "data:text/javascript,globalThis.__cellfence_unrelated_preload=true",
    "app.mjs",
  ], {
    cwd: tempDir,
    encoding: "utf8",
    env: {
      ...process.env,
      CELLFENCE_TRACE_CELL: "runtime",
      CELLFENCE_TRACE_OUT: evidencePath,
    },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.existsSync(evidencePath), false);
});

test("synthetic execArgv entries do not trick trace preload detection", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-trace-fake-execargv-"));
  fs.writeFileSync(path.join(tempDir, "app.mjs"), `
    import fs from "node:fs";
    const traceUrl = ${JSON.stringify(pathToFileURL(tracePath).href)};
    process.execArgv.push("not-import", traceUrl, \`xxxxxxxxx\${traceUrl}\`);
    await import(\`\${traceUrl}?fake-execargv\`);
    fs.writeFileSync("fake-execargv.json", "{}\\n");
  `);
  const evidencePath = path.join(tempDir, "resource-evidence.json");
  const result = spawnSync(process.execPath, ["app.mjs"], {
    cwd: tempDir,
    encoding: "utf8",
    env: {
      ...process.env,
      CELLFENCE_TRACE_CELL: "runtime",
      CELLFENCE_TRACE_OUT: evidencePath,
    },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.existsSync(evidencePath), false);
});

test("trace preload detection accepts only exact CellFence import flags", async () => {
  const trace = await import(`${pathToFileURL(tracePath).href}?preload-detection`);
  assert.equal(trace.__testing.preloadRequestedThisModule(["--import", "@cellfence/trace"]), true);
  assert.equal(trace.__testing.preloadRequestedThisModule(["--import=@cellfence/trace"]), true);
  assert.equal(trace.__testing.preloadRequestedThisModule(["--import", pathToFileURL(tracePath).href]), true);
  assert.equal(trace.__testing.preloadRequestedThisModule(["--import", "data:text/javascript,"]), false);
  assert.equal(trace.__testing.preloadRequestedThisModule(["--import=data:text/javascript,"]), false);
  assert.equal(trace.__testing.preloadRequestedThisModule(["--import"]), false);
  assert.equal(trace.__testing.preloadRequestedThisModule(["not-import", pathToFileURL(tracePath).href]), false);
});

test("trace hook records fetch calls without requiring successful network responses", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-trace-fetch-"));
  fs.writeFileSync(path.join(tempDir, "app.mjs"), `
    try {
      await fetch("https://example.invalid/cellfence");
    } catch {}
  `);

  const evidencePath = path.join(tempDir, "resource-evidence.json");
  const result = spawnSync(process.execPath, [
    "--import",
    pathToFileURL(tracePath).href,
    "app.mjs",
  ], {
    cwd: tempDir,
    encoding: "utf8",
    env: {
      ...process.env,
      CELLFENCE_TRACE_CELL: "runtime",
      CELLFENCE_TRACE_OUT: evidencePath,
    },
  });

  assert.equal(result.status, 0, result.stderr);
  const evidence = JSON.parse(fs.readFileSync(evidencePath, "utf8"));
  assert.deepEqual(evidence.accesses, [
    {
      kind: "http",
      access: "call",
      selector: "https://example.invalid/cellfence",
      cellId: "runtime",
      detectedBy: "cellfence-trace",
      confidence: "transient",
    },
  ]);
});

test("trace hook records URL and Request fetch inputs", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-trace-fetch-objects-"));
  fs.writeFileSync(path.join(tempDir, "app.mjs"), `
    for (const input of [
      new URL("https://example.invalid/url-object"),
      new Request("https://example.invalid/request-object")
    ]) {
      try {
        await fetch(input);
      } catch {}
    }
  `);

  const evidencePath = path.join(tempDir, "resource-evidence.json");
  const result = spawnSync(process.execPath, [
    "--import",
    pathToFileURL(tracePath).href,
    "app.mjs",
  ], {
    cwd: tempDir,
    encoding: "utf8",
    env: {
      ...process.env,
      CELLFENCE_TRACE_CELL: "runtime",
      CELLFENCE_TRACE_OUT: evidencePath,
    },
  });

  assert.equal(result.status, 0, result.stderr);
  const evidence = JSON.parse(fs.readFileSync(evidencePath, "utf8"));
  assert.deepEqual(evidence.accesses.map((access) => access.selector), [
    "https://example.invalid/request-object",
    "https://example.invalid/url-object",
  ]);
});

test("trace hook ignores fetch inputs that do not expose a URL selector", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-trace-fetch-unknown-"));
  fs.writeFileSync(path.join(tempDir, "app.mjs"), `
    for (const input of [{}, { url: "https://example.invalid/not-a-request" }]) {
      try {
        await fetch(input);
      } catch {}
    }
  `);

  const evidencePath = path.join(tempDir, "resource-evidence.json");
  const result = spawnSync(process.execPath, [
    "--import",
    pathToFileURL(tracePath).href,
    "app.mjs",
  ], {
    cwd: tempDir,
    encoding: "utf8",
    env: {
      ...process.env,
      CELLFENCE_TRACE_OUT: evidencePath,
    },
  });

  assert.equal(result.status, 0, result.stderr);
  const evidence = JSON.parse(fs.readFileSync(evidencePath, "utf8"));
  assert.equal(evidence.transcriptStatus, "active");
  assert.deepEqual(evidence.accesses, []);
});

test("trace hook covers default cell/output and fd based skips", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-trace-defaults-"));
  fs.mkdirSync(path.join(tempDir, "data"), { recursive: true });
  fs.writeFileSync(path.join(tempDir, "data/input.json"), "{\"ok\":true}\n");
  fs.writeFileSync(path.join(tempDir, "app.mjs"), `
    import fs from "node:fs";
    import { appendFile, readFile, writeFile } from "node:fs/promises";
    import { recordDatabaseAccess } from ${JSON.stringify(pathToFileURL(tracePath).href)};
    const fd = fs.openSync("data/input.json", "r");
    fs.readFileSync(fd, "utf8");
    fs.closeSync(fd);
    fs.writeFileSync("cellfence.resource-evidence.json", "{}");
    const handle = await fs.promises.open("data/input.json", "r+");
    try {
      await readFile(handle, "utf8");
      await writeFile(handle, "x");
      await appendFile(handle, "y");
    } finally {
      await handle.close();
    }
    recordDatabaseAccess("app_defaults");
  `);

  const result = spawnSync(process.execPath, [
    "--import",
    pathToFileURL(tracePath).href,
    "app.mjs",
  ], {
    cwd: tempDir,
    encoding: "utf8",
    env: {
      ...Object.fromEntries(Object.entries(process.env).filter(([name]) => name !== "CELLFENCE_TRACE_OUT" && name !== "CELLFENCE_TRACE_CELL")),
      CELLFENCE_CELL_ID: "fallback-runtime",
    },
  });

  assert.equal(result.status, 0, result.stderr);
  const evidence = JSON.parse(fs.readFileSync(path.join(tempDir, "cellfence.resource-evidence.json"), "utf8"));
  assert.equal(evidence.cellId, "fallback-runtime");
  assert.deepEqual(evidence.accesses, [{
    kind: "database",
    access: "read",
    selector: "app_defaults",
    cellId: "fallback-runtime",
    detectedBy: "cellfence-trace",
    confidence: "transient",
  }]);
});

test("trace hook can emit evidence without a cell id", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-trace-no-cell-"));
  fs.writeFileSync(path.join(tempDir, "app.mjs"), `
    import { recordDatabaseAccess } from ${JSON.stringify(pathToFileURL(tracePath).href)};
    recordDatabaseAccess("app_no_cell");
  `);

  const evidencePath = path.join(tempDir, "resource-evidence.json");
  const result = spawnSync(process.execPath, ["app.mjs"], {
    cwd: tempDir,
    encoding: "utf8",
    env: {
      ...Object.fromEntries(Object.entries(process.env).filter(([name]) => name !== "CELLFENCE_TRACE_CELL" && name !== "CELLFENCE_CELL_ID")),
      CELLFENCE_TRACE_OUT: evidencePath,
    },
  });

  assert.equal(result.status, 0, result.stderr);
  const evidence = JSON.parse(fs.readFileSync(evidencePath, "utf8"));
  assert.equal("cellId" in evidence, false);
  assert.deepEqual(evidence.accesses, [{
    kind: "database",
    access: "read",
    selector: "app_no_cell",
    detectedBy: "cellfence-trace",
    confidence: "transient",
  }]);
});

test("trace hook keeps identical selectors separate by cell id", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-trace-cell-key-"));
  fs.writeFileSync(path.join(tempDir, "app.mjs"), `
    import { recordDatabaseAccess } from ${JSON.stringify(pathToFileURL(tracePath).href)};
    recordDatabaseAccess("shared_table", "read", "alpha");
    recordDatabaseAccess("shared_table", "read", "beta");
    recordDatabaseAccess("shared_table", "read", "Stryker was here!");
    recordDatabaseAccess("shared_table", "read");
  `);

  const evidencePath = path.join(tempDir, "resource-evidence.json");
  const result = spawnSync(process.execPath, ["app.mjs"], {
    cwd: tempDir,
    encoding: "utf8",
    env: {
      ...Object.fromEntries(Object.entries(process.env).filter(([name]) => name !== "CELLFENCE_TRACE_CELL" && name !== "CELLFENCE_CELL_ID")),
      CELLFENCE_TRACE_OUT: evidencePath,
    },
  });

  assert.equal(result.status, 0, result.stderr);
  const evidence = JSON.parse(fs.readFileSync(evidencePath, "utf8"));
  assert.equal(evidence.accesses.length, 4);
  assert.deepEqual(new Set(evidence.accesses.map((access) => access.cellId)), new Set([
    undefined,
    "Stryker was here!",
    "alpha",
    "beta",
  ]));
});

test("trace install is idempotent and registers the expected flush hooks", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-trace-install-"));
  fs.writeFileSync(path.join(tempDir, "app.mjs"), `
    const observedEvents = [];
    const originalOnce = process.once.bind(process);
    process.once = (eventName, listener) => {
      observedEvents.push(eventName);
      return originalOnce(eventName, listener);
    };
    const trace = await import(${JSON.stringify(`${pathToFileURL(tracePath).href}?install-idempotent`)});
    trace.installTrace();
    trace.installTrace();
    trace.recordDatabaseAccess("idempotent-extra");
    if (JSON.stringify(observedEvents) !== JSON.stringify(["beforeExit", "exit"])) {
      throw new Error(\`unexpected trace hooks: \${JSON.stringify(observedEvents)}\`);
    }
    if (!trace.traceDiagnostics().installed || !trace.traceDiagnostics().flushHooksRegistered) {
      throw new Error("trace diagnostics did not report the installed hook state");
    }
  `);

  const result = spawnSync(process.execPath, ["app.mjs"], {
    cwd: tempDir,
    encoding: "utf8",
    env: {
      ...process.env,
      CELLFENCE_TRACE_OUT: path.join(tempDir, "resource-evidence.json"),
    },
  });

  assert.equal(result.status, 0, result.stderr);
});

test("trace hook writes commit fallback and flushes only once", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-trace-flush-"));
  fs.writeFileSync(path.join(tempDir, "app.mjs"), `
    import { flushEvidence, recordDatabaseAccess } from ${JSON.stringify(pathToFileURL(tracePath).href)};
    recordDatabaseAccess("first_flush");
    flushEvidence();
    recordDatabaseAccess("second_flush");
    flushEvidence();
  `);

  const evidencePath = path.join(tempDir, "resource-evidence.json");
  const result = spawnSync(process.execPath, ["app.mjs"], {
    cwd: tempDir,
    encoding: "utf8",
    env: {
      ...Object.fromEntries(Object.entries(process.env).filter(([name]) => name !== "GITHUB_SHA")),
      CELLFENCE_TRACE_CELL: "runtime",
      CELLFENCE_TRACE_COMMIT_SHA: "trace-fallback-sha",
      CELLFENCE_TRACE_OUT: evidencePath,
    },
  });

  assert.equal(result.status, 0, result.stderr);
  const evidence = JSON.parse(fs.readFileSync(evidencePath, "utf8"));
  assert.equal(evidence.commitSha, "trace-fallback-sha");
  assert.deepEqual(evidence.accesses.map((access) => access.selector), ["first_flush"]);
});

test("trace hook trims env commit fallback before writing evidence", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-trace-commit-env-"));
  fs.writeFileSync(path.join(tempDir, "app.mjs"), `
    import { recordDatabaseAccess } from ${JSON.stringify(pathToFileURL(tracePath).href)};
    recordDatabaseAccess("commit_env");
  `);

  const evidencePath = path.join(tempDir, "resource-evidence.json");
  const result = spawnSync(process.execPath, ["app.mjs"], {
    cwd: tempDir,
    encoding: "utf8",
    env: withoutTraceCommitEnv({
      CELLFENCE_TRACE_COMMIT_SHA: "  trace-env-sha  ",
      CELLFENCE_TRACE_OUT: evidencePath,
    }),
  });

  assert.equal(result.status, 0, result.stderr);
  const evidence = JSON.parse(fs.readFileSync(evidencePath, "utf8"));
  assert.equal(evidence.commitSha, "trace-env-sha");
});

test("trace hook ignores blank commit env fallbacks", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-trace-blank-commit-env-"));
  fs.writeFileSync(path.join(tempDir, "app.mjs"), `
    import { recordDatabaseAccess } from ${JSON.stringify(pathToFileURL(tracePath).href)};
    recordDatabaseAccess("blank_commit_env");
  `);

  const evidencePath = path.join(tempDir, "resource-evidence.json");
  const result = spawnSync(process.execPath, ["app.mjs"], {
    cwd: tempDir,
    encoding: "utf8",
    env: withoutTraceCommitEnv({
      GIT_CONFIG_NOSYSTEM: "1",
      HOME: tempDir,
      CELLFENCE_TRACE_COMMIT_SHA: "   ",
      CELLFENCE_TRACE_OUT: evidencePath,
    }),
  });

  assert.equal(result.status, 0, result.stderr);
  const evidence = JSON.parse(fs.readFileSync(evidencePath, "utf8"));
  assert.equal(evidence.commitSha, "");
});

test("trace hook falls back to git HEAD and then to an empty commit outside git", () => {
  const gitDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-trace-git-commit-"));
  execFileSync("git", ["init"], { cwd: gitDir, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "trace@example.invalid"], { cwd: gitDir });
  execFileSync("git", ["config", "user.name", "Trace Test"], { cwd: gitDir });
  fs.writeFileSync(path.join(gitDir, "tracked.txt"), "tracked\n");
  execFileSync("git", ["add", "tracked.txt"], { cwd: gitDir });
  execFileSync("git", ["commit", "-m", "trace fixture"], { cwd: gitDir, stdio: "ignore" });
  const expectedSha = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: gitDir,
    encoding: "utf8",
  }).trim();
  fs.writeFileSync(path.join(gitDir, "app.mjs"), `
    import { recordDatabaseAccess } from ${JSON.stringify(pathToFileURL(tracePath).href)};
    recordDatabaseAccess("commit_git");
  `);
  const gitEvidencePath = path.join(gitDir, "resource-evidence.json");
  const gitResult = spawnSync(process.execPath, ["app.mjs"], {
    cwd: gitDir,
    encoding: "utf8",
    env: withoutTraceCommitEnv({ CELLFENCE_TRACE_OUT: gitEvidencePath }),
  });

  assert.equal(gitResult.status, 0, gitResult.stderr);
  const gitEvidence = JSON.parse(fs.readFileSync(gitEvidencePath, "utf8"));
  assert.equal(gitEvidence.commitSha, expectedSha);

  fs.rmSync(gitEvidencePath, { force: true });
  const blankEnvResult = spawnSync(process.execPath, ["app.mjs"], {
    cwd: gitDir,
    encoding: "utf8",
    env: withoutTraceCommitEnv({
      CELLFENCE_TRACE_COMMIT_SHA: "   ",
      CELLFENCE_TRACE_OUT: gitEvidencePath,
    }),
  });

  assert.equal(blankEnvResult.status, 0, blankEnvResult.stderr);
  const blankEnvEvidence = JSON.parse(fs.readFileSync(gitEvidencePath, "utf8"));
  assert.equal(blankEnvEvidence.commitSha, expectedSha);

  const nonGitDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-trace-no-git-commit-"));
  fs.writeFileSync(path.join(nonGitDir, "app.mjs"), `
    import { recordDatabaseAccess } from ${JSON.stringify(pathToFileURL(tracePath).href)};
    recordDatabaseAccess("commit_missing");
  `);
  const nonGitEvidencePath = path.join(nonGitDir, "resource-evidence.json");
  const nonGitResult = spawnSync(process.execPath, ["app.mjs"], {
    cwd: nonGitDir,
    encoding: "utf8",
    env: withoutTraceCommitEnv({
      GIT_CONFIG_NOSYSTEM: "1",
      HOME: nonGitDir,
      CELLFENCE_TRACE_OUT: nonGitEvidencePath,
    }),
  });

  assert.equal(nonGitResult.status, 0, nonGitResult.stderr);
  const nonGitEvidence = JSON.parse(fs.readFileSync(nonGitEvidencePath, "utf8"));
  assert.equal(nonGitEvidence.commitSha, "");
});

test("trace disable flag is exact and transcript status uses the load-time decision", () => {
  const activeDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-trace-empty-disable-"));
  fs.writeFileSync(path.join(activeDir, "app.mjs"), `
    import fs from "node:fs";
    fs.writeFileSync("active-output.json", "{}\\n");
  `);
  const activeEvidencePath = path.join(activeDir, "resource-evidence.json");
  const active = spawnSync(process.execPath, [
    "--import",
    pathToFileURL(tracePath).href,
    "app.mjs",
  ], {
    cwd: activeDir,
    encoding: "utf8",
    env: withoutTraceCommitEnv({
      CELLFENCE_TRACE_DISABLE: "",
      CELLFENCE_TRACE_OUT: activeEvidencePath,
    }),
  });

  assert.equal(active.status, 0, active.stderr);
  const activeEvidence = JSON.parse(fs.readFileSync(activeEvidencePath, "utf8"));
  assert.equal(activeEvidence.transcriptStatus, "active");

  const disabledScript = `
    import assert from "node:assert/strict";
    const { transcriptStatus } = await import(${JSON.stringify(`${pathToFileURL(tracePath).href}?disabled-status`)});
    assert.equal(transcriptStatus(), "inactive");
  `;
  const disabled = spawnSync(process.execPath, ["--input-type=module", "-e", disabledScript], {
    cwd: fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-trace-disabled-status-")),
    encoding: "utf8",
    env: withoutTraceCommitEnv({ CELLFENCE_TRACE_DISABLE: "1" }),
  });

  assert.equal(disabled.status, 0, disabled.stderr);
});

test("trace transcript derivation rejects inactive, incomplete, and spoofed evidence states", () => {
  const script = `
    import assert from "node:assert/strict";
    const { deriveTranscriptStatus } = await import(${JSON.stringify(`${pathToFileURL(tracePath).href}?derive-status`)});
    assert.equal(deriveTranscriptStatus({ transcriptStatus: "active", accesses: [{ selector: "x" }] }, { disabled: true, hookInstalled: true }), "inactive");
    assert.equal(deriveTranscriptStatus({ transcriptStatus: "active", accesses: [{ selector: "x" }] }, { disabled: false, hookInstalled: false }), "inactive");
    assert.equal(deriveTranscriptStatus({ transcriptStatus: "inactive", accesses: [{ selector: "x" }] }, { disabled: false, hookInstalled: true }), "inactive");
    assert.equal(deriveTranscriptStatus({ transcriptStatus: "active", accesses: [{ selector: "x" }] }, { disabled: false, hookInstalled: true }), "active");
    assert.equal(deriveTranscriptStatus({ transcriptStatus: "active", accesses: [] }, { disabled: false, hookInstalled: true }), "incomplete");
    assert.equal(deriveTranscriptStatus({ transcriptStatus: "active" }, { disabled: false, hookInstalled: true }), "incomplete");
    assert.equal(deriveTranscriptStatus({ transcriptStatus: "incomplete", accesses: [{ selector: "x" }] }, { disabled: false, hookInstalled: true }), "incomplete");
    assert.equal(deriveTranscriptStatus({ transcriptStatus: "spoofed", accesses: [{ selector: "x" }] }, { disabled: false, hookInstalled: true }), "incomplete");
  `;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    cwd: fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-trace-derive-")),
    encoding: "utf8",
    env: withoutTraceCommitEnv(),
  });

  assert.equal(result.status, 0, result.stderr);
});

test("trace hook tolerates runtimes without fetch", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-trace-no-fetch-"));
  fs.writeFileSync(path.join(tempDir, "app.mjs"), `
    import fs from "node:fs";
    globalThis.fetch = undefined;
    const trace = await import(${JSON.stringify(`${pathToFileURL(tracePath).href}?no-fetch`)});
    trace.installTrace();
    if (typeof globalThis.fetch !== "undefined") {
      throw new Error("trace should not install fetch when no original fetch exists");
    }
    fs.writeFileSync("runtime-output.json", "{}\\n");
  `);

  const evidencePath = path.join(tempDir, "resource-evidence.json");
  const result = spawnSync(process.execPath, ["app.mjs"], {
    cwd: tempDir,
    encoding: "utf8",
    env: {
      ...process.env,
      CELLFENCE_TRACE_CELL: "runtime",
      CELLFENCE_TRACE_OUT: evidencePath,
    },
  });

  assert.equal(result.status, 0, result.stderr);
  const evidence = JSON.parse(fs.readFileSync(evidencePath, "utf8"));
  assert.deepEqual(evidence.accesses.map((access) => `${access.access}:${access.selector}`), [
    "write:runtime-output.json",
  ]);
});

test("trace hook treats Request as optional when fetch exists", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-trace-no-request-"));
  fs.writeFileSync(path.join(tempDir, "app.mjs"), `
    globalThis.Request = undefined;
    globalThis.fetch = async () => ({ ok: true });
    const trace = await import(${JSON.stringify(`${pathToFileURL(tracePath).href}?no-request`)});
    trace.installTrace();
    await fetch({ url: "https://example.invalid/not-a-real-request" });
  `);

  const evidencePath = path.join(tempDir, "resource-evidence.json");
  const result = spawnSync(process.execPath, ["app.mjs"], {
    cwd: tempDir,
    encoding: "utf8",
    env: {
      ...process.env,
      CELLFENCE_TRACE_CELL: "runtime",
      CELLFENCE_TRACE_OUT: evidencePath,
    },
  });

  assert.equal(result.status, 0, result.stderr);
  const evidence = JSON.parse(fs.readFileSync(evidencePath, "utf8"));
  assert.equal(evidence.transcriptStatus, "active");
  assert.deepEqual(evidence.accesses, []);
});
