import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

type PythonCommand = {
  command: string;
  args: string[];
};

export const PYTHON_INSPECTOR_BATCH_SIZE = 1_000;

const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;
const INSPECTOR_TIMEOUT_MS = 120_000;
const PYTHON_BATCH_RUNNER = String.raw`
import contextlib
import io
import json
import sys

if hasattr(sys.stdin, "reconfigure"):
    sys.stdin.reconfigure(encoding="utf-8")
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

inspector_path = sys.argv[1]

with open(inspector_path, "r", encoding="utf-8") as handle:
    inspector_code = compile(handle.read(), inspector_path, "exec")

def inspector_error(exc):
    return {
        "imports": [],
        "publicSymbols": [],
        "surfaceParts": [],
        "resources": [],
        "errors": [{
            "kind": "inspector_error",
            "message": f"{type(exc).__name__}: {exc}",
        }],
    }

results = []
for request in json.load(sys.stdin):
    request_id = request["id"]
    file_path = request["path"]
    output = io.StringIO()
    previous_argv = sys.argv
    try:
        sys.argv = [inspector_path, file_path]
        with contextlib.redirect_stdout(output):
            try:
                exec(inspector_code, {"__file__": inspector_path, "__name__": "__main__"})
            except SystemExit as exc:
                if exc.code not in (None, 0):
                    raise RuntimeError(f"inspector exited with status {exc.code}") from exc
        results.append({"id": request_id, "result": json.loads(output.getvalue())})
    except BaseException as exc:
        results.append({"id": request_id, "result": inspector_error(exc)})
    finally:
        sys.argv = previous_argv

print(json.dumps(results, separators=(",", ":")))
`;

let batchRunnerPath: string | undefined;
let batchRunnerTempDir: string | undefined;
let memoizedPythonCommand: PythonCommand | undefined;
let memoizedPythonFailure: Error | undefined;
let memoizedRuntimeIdentity: string | undefined;
let inspectorProcessCount = 0;

function writeBatchRunner(): string {
  if (batchRunnerPath) return batchRunnerPath;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-python-runner-"));
  batchRunnerTempDir = tempDir;
  batchRunnerPath = path.join(tempDir, "run-batch.py");
  fs.writeFileSync(batchRunnerPath, PYTHON_BATCH_RUNNER, { mode: 0o600 });
  process.once("exit", () => {
    if (batchRunnerTempDir) fs.rmSync(batchRunnerTempDir, { recursive: true, force: true });
  });
  return batchRunnerPath;
}

function pythonCommands(): PythonCommand[] {
  const defaults: PythonCommand[] = process.platform === "win32"
    ? [
      { command: "py", args: ["-3"] },
      { command: "python", args: [] },
      { command: "python3", args: [] },
    ]
    : [
      { command: "python3", args: [] },
      { command: "python", args: [] },
  ];
  if (!memoizedPythonCommand) return defaults;
  const selected = memoizedPythonCommand;
  return [
    selected,
    ...defaults.filter((candidate) =>
      candidate.command !== selected.command
      || candidate.args.join("\0") !== selected.args.join("\0")
    ),
  ];
}

export function runPythonInspectorBatch<Result>(inspectorPath: string, filePaths: readonly string[]): Result[] {
  if (filePaths.length === 0) return [];
  if (filePaths.length > PYTHON_INSPECTOR_BATCH_SIZE) {
    throw new Error(`Python inspector batch exceeds ${PYTHON_INSPECTOR_BATCH_SIZE} files`);
  }
  if (memoizedPythonFailure) throw memoizedPythonFailure;

  const errors: unknown[] = [];
  const runnerPath = writeBatchRunner();
  for (const pythonCommand of pythonCommands()) {
    try {
      inspectorProcessCount += 1;
      const output = execFileSync(
        pythonCommand.command,
        [...pythonCommand.args, "-I", "-B", runnerPath, inspectorPath],
        {
          encoding: "utf8",
          input: JSON.stringify(filePaths.map((filePath, id) => ({ id, path: filePath }))),
          maxBuffer: MAX_OUTPUT_BYTES,
          stdio: ["pipe", "pipe", "pipe"],
          timeout: INSPECTOR_TIMEOUT_MS,
        },
      );
      const results = parsePythonInspectorBatchOutput<Result>(output, filePaths.length);
      memoizedPythonCommand = pythonCommand;
      return results;
    } catch (error) {
      errors.push(error);
    }
  }
  const lastError = errors.at(-1);
  const failure = lastError instanceof Error ? lastError : new Error(String(lastError));
  if (errors.length > 0 && errors.every((error) => (
    typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT"
  ))) memoizedPythonFailure = failure;
  throw failure;
}

export function recoverPythonInspectorBatch<Result>(
  filePaths: readonly string[],
  inspect: (paths: readonly string[]) => Result[],
  errorResult: (error: unknown) => Result,
): Result[] {
  if (filePaths.length === 0) return [];
  try {
    return inspect(filePaths);
  } catch (error) {
    if (filePaths.length === 1) return [errorResult(error)];
    const middle = Math.floor(filePaths.length / 2);
    return [
      ...recoverPythonInspectorBatch(filePaths.slice(0, middle), inspect, errorResult),
      ...recoverPythonInspectorBatch(filePaths.slice(middle), inspect, errorResult),
    ];
  }
}

export function pythonInspectorRuntimeIdentity(): string {
  if (memoizedRuntimeIdentity) return memoizedRuntimeIdentity;
  for (const pythonCommand of pythonCommands()) {
    try {
      const version = execFileSync(pythonCommand.command, [...pythonCommand.args, "--version"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 5_000,
      }).trim();
      memoizedPythonCommand = pythonCommand;
      memoizedRuntimeIdentity = `${pythonCommand.command}\0${pythonCommand.args.join("\0")}\0${version}`;
      return memoizedRuntimeIdentity;
    } catch {
      // Probe the next supported interpreter name.
    }
  }
  memoizedRuntimeIdentity = "unavailable";
  return memoizedRuntimeIdentity;
}

export function parsePythonInspectorBatchOutput<Result>(output: string, expectedCount: number): Result[] {
  const parsed: unknown = JSON.parse(output);
  if (!Array.isArray(parsed) || parsed.length !== expectedCount) {
    throw new Error(`Python inspector returned ${Array.isArray(parsed) ? parsed.length : "invalid"} results for ${expectedCount} files`);
  }
  const ordered: Result[] = new Array(expectedCount);
  const seen = new Set<number>();
  for (const entry of parsed) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new Error("Python inspector returned a malformed result entry");
    }
    const record = entry as Record<string, unknown>;
    const id = record.id;
    if (!Number.isInteger(id) || Number(id) < 0 || Number(id) >= expectedCount) {
      throw new Error(`Python inspector returned an invalid result id ${String(id)}`);
    }
    if (seen.has(Number(id))) throw new Error(`Python inspector returned duplicate result id ${String(id)}`);
    if (!("result" in record)) throw new Error(`Python inspector result ${String(id)} is missing its payload`);
    seen.add(Number(id));
    ordered[Number(id)] = record.result as Result;
  }
  return ordered;
}

export function pythonInspectorProcessCount(): number {
  return inspectorProcessCount;
}
