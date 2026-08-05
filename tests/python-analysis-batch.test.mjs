import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import {
  inspectPythonSource,
  prewarmPythonInspections,
} from "../packages/engine/dist/python-analysis.js";
import {
  parsePythonInspectorBatchOutput,
  pythonInspectorProcessCount,
  recoverPythonInspectorBatch,
} from "../packages/engine/dist/python-inspector-runner.js";

function shellQuote(value) {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function availablePythonExecutable() {
  for (const command of ["python3", "python"]) {
    const result = spawnSync(command, ["-c", "import sys; print(sys.executable)"], { encoding: "utf8" });
    if (result.status === 0 && result.stdout.trim()) return result.stdout.trim();
  }
  return undefined;
}

test("Python analysis batches 1,000 files and reuses the selected interpreter", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-python-batch-"));
  try {
    const filePaths = [];
    for (let index = 0; index < 998; index += 1) {
      const filePath = path.join(rootDir, `module-${String(index).padStart(4, "0")}.py`);
      fs.writeFileSync(filePath, `VALUE_${index} = ${index}\n`);
      filePaths.push(filePath);
    }
    const syntaxErrorPath = path.join(rootDir, "syntax-error.py");
    fs.writeFileSync(syntaxErrorPath, "def broken(:\n    pass\n");
    filePaths.push(syntaxErrorPath);
    const readErrorPath = path.join(rootDir, "read-error.py");
    fs.writeFileSync(readErrorPath, Buffer.from([0xff, 0xfe, 0xfd]));
    filePaths.push(readErrorPath);

    const beforeBatch = pythonInspectorProcessCount();
    prewarmPythonInspections(filePaths);
    const batchProcesses = pythonInspectorProcessCount() - beforeBatch;
    const interpreterCandidates = process.platform === "win32" ? 3 : 2;
    assert.ok(batchProcesses >= 1 && batchProcesses <= interpreterCandidates, `expected one batch with at most ${interpreterCandidates} interpreter attempts, received ${batchProcesses}`);

    const beforeCacheReads = pythonInspectorProcessCount();
    assert.deepEqual(inspectPythonSource(filePaths[0]).publicSymbols, ["VALUE_0"]);
    assert.deepEqual(inspectPythonSource(filePaths[997]).publicSymbols, ["VALUE_997"]);
    assert.equal(inspectPythonSource(syntaxErrorPath).errors[0].kind, "syntax_error");
    assert.equal(inspectPythonSource(readErrorPath).errors[0].kind, "read_error");
    assert.equal(pythonInspectorProcessCount(), beforeCacheReads);

    fs.appendFileSync(filePaths[0], "UPDATED = True\n");
    const beforeMemoizedRun = pythonInspectorProcessCount();
    prewarmPythonInspections([filePaths[0]]);
    assert.equal(pythonInspectorProcessCount() - beforeMemoizedRun, 1);
    assert.deepEqual(inspectPythonSource(filePaths[0]).publicSymbols, ["UPDATED", "VALUE_0"]);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("Python batch protocol rejects malformed, missing, duplicate, and out-of-range responses", () => {
  assert.deepEqual(
    parsePythonInspectorBatchOutput(JSON.stringify([
      { id: 1, result: "second" },
      { id: 0, result: "first" },
    ]), 2),
    ["first", "second"],
  );
  assert.throws(() => parsePythonInspectorBatchOutput("{}", 1), /returned invalid results/);
  assert.throws(() => parsePythonInspectorBatchOutput('[{"id":0}]', 1), /missing its payload/);
  assert.throws(() => parsePythonInspectorBatchOutput('[{"id":0,"result":1},{"id":0,"result":2}]', 2), /duplicate result id/);
  assert.throws(() => parsePythonInspectorBatchOutput('[{"id":2,"result":1}]', 1), /invalid result id/);
});

test("Python batch recovery bisects aggregate failures and isolates a bad file", () => {
  const attempts = [];
  const results = recoverPythonInspectorBatch(
    ["good-a.py", "bad.py", "good-b.py", "good-c.py"],
    (paths) => {
      attempts.push([...paths]);
      if (paths.length > 2 || paths.includes("bad.py")) throw new Error(`cannot inspect ${paths.join(",")}`);
      return paths.map((filePath) => ({ filePath, ok: true }));
    },
    (error) => ({ ok: false, error: error.message }),
  );
  assert.deepEqual(results.map((result) => result.ok), [true, false, true, true]);
  assert.ok(attempts.some((paths) => paths.length === 1 && paths[0] === "bad.py"));
  assert.ok(attempts.some((paths) => paths.length === 2 && paths.includes("good-c.py")));
});

test("Python analysis handles spaced and non-ascii paths in one batch", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-python-paths-"));
  try {
    const filePaths = [path.join(rootDir, "space name.py"), path.join(rootDir, "日本語.py")];
    fs.writeFileSync(filePaths[0], "SPACE_NAME = True\n");
    fs.writeFileSync(filePaths[1], "UNICODE_NAME = True\n");
    prewarmPythonInspections(filePaths);
    assert.deepEqual(inspectPythonSource(filePaths[0]).publicSymbols, ["SPACE_NAME"]);
    assert.deepEqual(inspectPythonSource(filePaths[1]).publicSymbols, ["UNICODE_NAME"]);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("Python analysis fails closed when no interpreter is available", { skip: process.platform === "win32" }, () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-python-no-interpreter-"));
  try {
    const filePath = path.join(rootDir, "module.py");
    fs.writeFileSync(filePath, "PUBLIC = True\n");
    const emptyBin = path.join(rootDir, "bin");
    fs.mkdirSync(emptyBin);
    const moduleUrl = pathToFileURL(path.resolve("packages/engine/dist/python-analysis.js")).href;
    const script = [
      `import { inspectPythonSource } from ${JSON.stringify(moduleUrl)};`,
      `console.log(JSON.stringify(inspectPythonSource(${JSON.stringify(filePath)})));`,
    ].join("\n");
    const result = spawnSync(process.execPath, ["--input-type=module", "--eval", script], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: { ...process.env, PATH: emptyBin },
    });

    assert.equal(result.status, 0, result.stderr);
    const inspection = JSON.parse(result.stdout);
    assert.deepEqual(inspection.imports, []);
    assert.deepEqual(inspection.publicSymbols, []);
    assert.deepEqual(inspection.resources, []);
    assert.equal(inspection.errors[0].kind, "inspector_error");
    assert.ok(inspection.errors[0].message.length > 0);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("repository checks report unavailable Python inspection as an error finding", { skip: process.platform === "win32" }, () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-python-fail-closed-"));
  try {
    fs.mkdirSync(path.join(rootDir, "src/app"), { recursive: true });
    fs.writeFileSync(path.join(rootDir, "src/app/public.py"), "PUBLIC = True\n");
    fs.writeFileSync(path.join(rootDir, "cellfence.manifest.json"), `${JSON.stringify({
      schemaVersion: "cellfence.manifest.v1",
      cells: [{
        id: "app",
        ownedPaths: ["src/app/**"],
        publicEntry: "src/app/public.py",
        publicSymbols: ["PUBLIC"],
        consumes: [],
        producesArtifacts: [],
      }],
    })}\n`);
    const emptyBin = path.join(rootDir, "bin");
    fs.mkdirSync(emptyBin);
    const engineUrl = pathToFileURL(path.resolve("packages/engine/dist/index.js")).href;
    const script = [
      `import { checkRepository } from ${JSON.stringify(engineUrl)};`,
      `console.log(JSON.stringify(checkRepository({ rootDir: ${JSON.stringify(rootDir)} })));`,
    ].join("\n");
    const result = spawnSync(process.execPath, ["--input-type=module", "--eval", script], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: { ...process.env, PATH: emptyBin },
    });

    assert.equal(result.status, 0, result.stderr);
    const check = JSON.parse(result.stdout);
    assert.equal(check.exitCode, 1);
    assert.ok(check.findings.some((finding) => (
      finding.ruleId === "CELLFENCE_UNSUPPORTED_PYTHON_SYNTAX"
      && finding.severity === "error"
      && finding.details.kind === "inspector_error"
    )));
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("Python analysis memoizes a fallback interpreter", { skip: process.platform === "win32" }, (t) => {
  const pythonExecutable = availablePythonExecutable();
  if (!pythonExecutable) {
    t.skip("Python interpreter is unavailable");
    return;
  }

  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-python-fallback-"));
  try {
    const firstPath = path.join(rootDir, "first.py");
    const secondPath = path.join(rootDir, "second.py");
    fs.writeFileSync(firstPath, "FIRST = True\n");
    fs.writeFileSync(secondPath, "SECOND = True\n");
    const fakeBin = path.join(rootDir, "bin");
    const processLog = path.join(rootDir, "processes.log");
    fs.mkdirSync(fakeBin);
    fs.writeFileSync(path.join(fakeBin, "python3"), [
      "#!/bin/sh",
      'printf \'%s\\n\' python3 >> "$CELLFENCE_PYTHON_PROCESS_LOG"',
      "exit 1",
      "",
    ].join("\n"), { mode: 0o700 });
    fs.writeFileSync(path.join(fakeBin, "python"), [
      "#!/bin/sh",
      'printf \'%s\\n\' python >> "$CELLFENCE_PYTHON_PROCESS_LOG"',
      `exec ${shellQuote(pythonExecutable)} "$@"`,
      "",
    ].join("\n"), { mode: 0o700 });

    const moduleUrl = pathToFileURL(path.resolve("packages/engine/dist/python-analysis.js")).href;
    const script = [
      `import { inspectPythonSource } from ${JSON.stringify(moduleUrl)};`,
      `const first = inspectPythonSource(${JSON.stringify(firstPath)});`,
      `const second = inspectPythonSource(${JSON.stringify(secondPath)});`,
      "console.log(JSON.stringify([first.publicSymbols, second.publicSymbols]));",
    ].join("\n");
    const result = spawnSync(process.execPath, ["--input-type=module", "--eval", script], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: fakeBin,
        CELLFENCE_PYTHON_PROCESS_LOG: processLog,
      },
    });

    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), [["FIRST"], ["SECOND"]]);
    assert.deepEqual(fs.readFileSync(processLog, "utf8").trim().split("\n"), ["python3", "python", "python"]);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});
