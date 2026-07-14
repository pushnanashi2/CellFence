import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

const root = process.cwd();
const tracePath = path.join(root, "packages/trace/dist/index.js");

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
  assert.equal(evidence.schemaVersion, "cellfence.resource-evidence.v1");
  assert.equal(evidence.cellId, "runtime");
  assert.deepEqual(evidence.accesses, [
    {
      kind: "file",
      access: "read",
      selector: "data/input.json",
      cellId: "runtime",
      detectedBy: "cellfence-trace",
      confidence: "runtime",
    },
    {
      kind: "file",
      access: "write",
      selector: "data/output.json",
      cellId: "runtime",
      detectedBy: "cellfence-trace",
      confidence: "runtime",
    },
  ]);
});

test("trace hook emits async and append file evidence while ignoring source files", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-trace-async-"));
  fs.mkdirSync(path.join(tempDir, "data"), { recursive: true });
  fs.writeFileSync(path.join(tempDir, "data/input.json"), "{\"ok\":true}\n");
  for (const extension of ["js", "cjs", "ts", "tsx", "jsx", "mts", "cts"]) {
    fs.writeFileSync(path.join(tempDir, `source.${extension}`), "export const ignored = true;\n");
  }
  fs.writeFileSync(path.join(tempDir, "app.mjs"), `
    import fs from "node:fs";
    import { appendFile, readFile, writeFile } from "node:fs/promises";
    await readFile("data/input.json", "utf8");
    fs.readFileSync(new URL("./data/input.json", import.meta.url), "utf8");
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
    confidence: "runtime",
  }]);
});

test("trace hook skips evidence output when disabled or unused", () => {
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
  assert.equal(fs.existsSync(unusedEvidence), false);
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
      confidence: "runtime",
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
  assert.equal(fs.existsSync(evidencePath), false);
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
    confidence: "runtime",
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
    confidence: "runtime",
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
    if (JSON.stringify(observedEvents) !== JSON.stringify(["beforeExit", "exit"])) {
      throw new Error(\`unexpected trace hooks: \${JSON.stringify(observedEvents)}\`);
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

test("trace hook tolerates runtimes without fetch", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-trace-no-fetch-"));
  fs.writeFileSync(path.join(tempDir, "app.mjs"), `
    import fs from "node:fs";
    globalThis.fetch = undefined;
    await import(${JSON.stringify(`${pathToFileURL(tracePath).href}?no-fetch`)});
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
    await import(${JSON.stringify(`${pathToFileURL(tracePath).href}?no-request`)});
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
  assert.equal(fs.existsSync(evidencePath), false);
});
