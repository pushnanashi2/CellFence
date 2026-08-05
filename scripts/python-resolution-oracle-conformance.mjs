import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { resolvePythonImport } from "../packages/engine/dist/module-resolution.js";
import { pythonSourceRoots } from "../packages/engine/dist/python-roots.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scriptPath = path.resolve(fileURLToPath(import.meta.url));
const defaultOutPath = path.join(repoRoot, "reports", "python-resolution-oracle-conformance.json");
const defaultPythonExecutable = process.platform === "win32" ? "python" : "python3";
const statusNames = ["conformant", "divergent", "not_comparable", "oracle_error"];

const importlibOracleProgram = String.raw`
import importlib
import importlib.util
import json
import sys

request = json.loads(sys.stdin.read())
sys.path[:] = request["search_paths"] + [
    entry for entry in sys.path if entry not in request["search_paths"]
]
importlib.invalidate_caches()

try:
    name = importlib.util.resolve_name(request["specifier"], request["package"])
    try:
        spec = importlib.util.find_spec(name)
    except ModuleNotFoundError as error:
        if error.name == name or name.startswith(error.name + "."):
            spec = None
        else:
            raise
    if spec is None:
        response = {"state": "unresolved", "target_path": None}
    elif spec.origin is None:
        response = {"state": "not_comparable", "reason": "importlib resolved a namespace package without a source-file origin"}
    elif spec.origin in {"built-in", "frozen"}:
        response = {"state": "not_comparable", "reason": "importlib resolved a " + spec.origin + " module"}
    else:
        response = {"state": "resolved", "target_path": spec.origin}
except Exception as error:
    response = {"state": "error", "error": type(error).__name__ + ": " + str(error)}

print(json.dumps(response, sort_keys=True))
`;

export const pythonResolutionOracleCases = Object.freeze([
  {
    id: "src-layout-module",
    fixtureFamily: "src-layout",
    sourceFile: "src/oracle_consumer.py",
    specifier: "oracle_src_target",
    oracleSearchPaths: ["src"],
    files: {
      "src/oracle_consumer.py": "import oracle_src_target\n",
      "src/oracle_src_target.py": "VALUE = 'src-module'\n",
    },
  },
  {
    id: "src-layout-package",
    fixtureFamily: "src-layout",
    sourceFile: "src/oracle_consumer.py",
    specifier: "oracle_src_package",
    oracleSearchPaths: ["src"],
    files: {
      "src/oracle_consumer.py": "import oracle_src_package\n",
      "src/oracle_src_package/__init__.py": "VALUE = 'src-package'\n",
    },
  },
  {
    id: "flat-layout-module",
    fixtureFamily: "flat-layout",
    sourceFile: "oracle_consumer.py",
    specifier: "oracle_flat_target",
    oracleSearchPaths: [""],
    files: {
      "oracle_consumer.py": "import oracle_flat_target\n",
      "oracle_flat_target.py": "VALUE = 'flat-module'\n",
    },
  },
  {
    id: "relative-sibling",
    fixtureFamily: "relative-import",
    sourceFile: "src/oracle_relative/nested/consumer.py",
    specifier: ".helper",
    oraclePackage: "oracle_relative.nested",
    oracleSearchPaths: ["src"],
    files: {
      "src/oracle_relative/__init__.py": "",
      "src/oracle_relative/nested/__init__.py": "",
      "src/oracle_relative/nested/consumer.py": "from .helper import VALUE\n",
      "src/oracle_relative/nested/helper.py": "VALUE = 'relative-sibling'\n",
    },
  },
  {
    id: "relative-parent",
    fixtureFamily: "relative-import",
    sourceFile: "src/oracle_relative/nested/consumer.py",
    specifier: "..shared",
    oraclePackage: "oracle_relative.nested",
    oracleSearchPaths: ["src"],
    files: {
      "src/oracle_relative/__init__.py": "",
      "src/oracle_relative/shared.py": "VALUE = 'relative-parent'\n",
      "src/oracle_relative/nested/__init__.py": "",
      "src/oracle_relative/nested/consumer.py": "from ..shared import VALUE\n",
    },
  },
  {
    id: "pyproject-package-dir",
    fixtureFamily: "pyproject",
    sourceFile: "lib/oracle_pyproject_app/consumer.py",
    specifier: "oracle_pyproject_target.feature",
    oracleSearchPaths: ["lib"],
    files: {
      "pyproject.toml": [
        "[tool.setuptools]",
        "package-dir = {\"\" = \"lib\"}",
        "",
        "[tool.setuptools.packages.find]",
        "where = [\"lib\"]",
      ],
      "lib/oracle_pyproject_app/__init__.py": "",
      "lib/oracle_pyproject_app/consumer.py": "from oracle_pyproject_target import feature\n",
      "lib/oracle_pyproject_target/__init__.py": "",
      "lib/oracle_pyproject_target/feature.py": "VALUE = 'pyproject'\n",
    },
  },
  {
    id: "setup-cfg-package-dir",
    fixtureFamily: "setup.cfg",
    sourceFile: "python/oracle_setup_app/consumer.py",
    specifier: "oracle_setup_target.feature",
    oracleSearchPaths: ["python"],
    files: {
      "setup.cfg": [
        "[options]",
        "package_dir =",
        "    = python",
        "packages = find:",
        "",
        "[options.packages.find]",
        "where = python",
      ],
      "python/oracle_setup_app/__init__.py": "",
      "python/oracle_setup_app/consumer.py": "from oracle_setup_target import feature\n",
      "python/oracle_setup_target/__init__.py": "",
      "python/oracle_setup_target/feature.py": "VALUE = 'setup-cfg'\n",
    },
  },
  {
    id: "unresolved-src-import",
    fixtureFamily: "src-layout",
    sourceFile: "src/oracle_consumer.py",
    specifier: "oracle_intentionally_missing",
    oracleSearchPaths: ["src"],
    files: {
      "src/oracle_consumer.py": "import oracle_intentionally_missing\n",
    },
  },
  {
    id: "standard-library-out-of-scope",
    fixtureFamily: "external-module",
    sourceFile: "src/oracle_consumer.py",
    specifier: "json",
    oracleSearchPaths: ["src"],
    comparable: false,
    notComparableReason: "the harness compares fixture-local modules only, not interpreter or environment modules",
    files: {
      "src/oracle_consumer.py": "import json\n",
    },
  },
]);

function usage() {
  console.error("Usage: node scripts/python-resolution-oracle-conformance.mjs [--out reports/python-resolution-oracle-conformance.json] [--python python3] [--fixture-parent DIR] [--keep-fixtures]");
}

function requiredValue(argv, index, argument) {
  const next = argv[index + 1];
  if (!next || next.startsWith("--")) throw new Error(`${argument} requires a value`);
  return next;
}

function inlineValue(argument, prefix) {
  const value = argument.slice(prefix.length);
  if (!value) throw new Error(`${prefix.slice(0, -1)} requires a value`);
  return value;
}

export function parsePythonResolutionOracleArgs(argv) {
  const options = {
    outPath: defaultOutPath,
    pythonExecutable: defaultPythonExecutable,
    fixtureParent: os.tmpdir(),
    keepFixtures: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--out") {
      options.outPath = path.resolve(requiredValue(argv, index, argument));
      index += 1;
    } else if (argument.startsWith("--out=")) {
      options.outPath = path.resolve(inlineValue(argument, "--out="));
    } else if (argument === "--python") {
      options.pythonExecutable = requiredValue(argv, index, argument);
      index += 1;
    } else if (argument.startsWith("--python=")) {
      options.pythonExecutable = inlineValue(argument, "--python=");
    } else if (argument === "--fixture-parent") {
      options.fixtureParent = path.resolve(requiredValue(argv, index, argument));
      index += 1;
    } else if (argument.startsWith("--fixture-parent=")) {
      options.fixtureParent = path.resolve(inlineValue(argument, "--fixture-parent="));
    } else if (argument === "--keep-fixtures") {
      options.keepFixtures = true;
    } else if (argument === "--help" || argument === "-h") {
      return { help: true };
    } else {
      throw new Error(`unknown argument: ${argument}`);
    }
  }
  return options;
}

function pathInside(rootDir, relativePath) {
  const targetPath = path.resolve(rootDir, relativePath);
  const relative = path.relative(rootDir, targetPath);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`fixture path escapes its root: ${relativePath}`);
  }
  return targetPath;
}

function writeFixtureFile(filePath, contents) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const text = Array.isArray(contents) ? contents.join("\n") : String(contents);
  fs.writeFileSync(filePath, text.endsWith("\n") || text.length === 0 ? text : `${text}\n`);
}

export function renderPythonResolutionFixture(rootDir, fixtureCase) {
  for (const [relativePath, contents] of Object.entries(fixtureCase.files)) {
    writeFixtureFile(pathInside(rootDir, relativePath), contents);
  }
}

function normalizeTarget(rootDir, targetPath) {
  if (!targetPath) return null;
  const absolute = path.isAbsolute(targetPath) ? path.resolve(targetPath) : path.resolve(rootDir, targetPath);
  const relative = path.relative(rootDir, absolute);
  if (relative === "" || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    return absolute.replaceAll("\\", "/");
  }
  return relative.replaceAll("\\", "/");
}

function validateCases(fixtureCases) {
  if (!Array.isArray(fixtureCases) || fixtureCases.length === 0) {
    throw new Error("python resolution fixture cases must be a non-empty array");
  }
  const ids = new Set();
  for (const fixtureCase of fixtureCases) {
    if (!fixtureCase || typeof fixtureCase !== "object") throw new Error("python resolution fixture cases must be objects");
    for (const property of ["id", "fixtureFamily", "sourceFile", "specifier"]) {
      if (typeof fixtureCase[property] !== "string" || fixtureCase[property].length === 0) {
        throw new Error(`python resolution fixture case requires ${property}`);
      }
    }
    if (ids.has(fixtureCase.id)) throw new Error(`duplicate python resolution fixture id: ${fixtureCase.id}`);
    ids.add(fixtureCase.id);
    if (!fixtureCase.files || typeof fixtureCase.files !== "object" || Array.isArray(fixtureCase.files)) {
      throw new Error(`python resolution fixture ${fixtureCase.id} requires files`);
    }
    if (!Object.prototype.hasOwnProperty.call(fixtureCase.files, fixtureCase.sourceFile)) {
      throw new Error(`python resolution fixture ${fixtureCase.id} does not contain its sourceFile`);
    }
    if (!Array.isArray(fixtureCase.oracleSearchPaths)) {
      throw new Error(`python resolution fixture ${fixtureCase.id} requires oracleSearchPaths`);
    }
    if (fixtureCase.specifier.startsWith(".") && !fixtureCase.oraclePackage) {
      throw new Error(`relative python resolution fixture ${fixtureCase.id} requires oraclePackage`);
    }
  }
}

export function resolveWithCellFence({ rootDir, fixtureCase, specifier }) {
  const sourceRoots = pythonSourceRoots({ rootDir, manifest: { cells: [] } });
  const targetPath = resolvePythonImport(rootDir, fixtureCase.sourceFile, specifier, sourceRoots);
  return { targetPath: normalizeTarget(rootDir, targetPath), sourceRoots };
}

export function resolveWithPythonImportlib({ rootDir, fixtureCase, specifier, pythonExecutable = defaultPythonExecutable }) {
  const searchPaths = fixtureCase.oracleSearchPaths.map((sourceRoot) => pathInside(rootDir, sourceRoot));
  const result = spawnSync(
    pythonExecutable,
    ["-I", "-S", "-B", "-c", importlibOracleProgram],
    {
      cwd: rootDir,
      encoding: "utf8",
      input: JSON.stringify({
        package: fixtureCase.oraclePackage || "",
        search_paths: searchPaths,
        specifier,
      }),
      maxBuffer: 1024 * 1024,
      timeout: 10_000,
    },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`importlib oracle exited ${result.status}: ${(result.stderr || result.stdout).trim()}`);
  }
  let response;
  try {
    response = JSON.parse(result.stdout);
  } catch {
    throw new Error(`importlib oracle returned invalid JSON: ${result.stdout.trim()}`);
  }
  if (response.state === "error") throw new Error(response.error || "importlib oracle failed");
  if (response.state === "not_comparable") {
    return { comparable: false, reason: response.reason || "importlib result has no comparable source path" };
  }
  if (response.state === "unresolved") return { comparable: true, targetPath: null };
  if (response.state !== "resolved" || typeof response.target_path !== "string") {
    throw new Error(`importlib oracle returned an unknown state: ${JSON.stringify(response)}`);
  }
  const targetPath = normalizeTarget(rootDir, response.target_path);
  if (path.isAbsolute(targetPath)) {
    return { comparable: false, reason: "importlib resolved a module outside the local fixture" };
  }
  return { comparable: true, targetPath };
}

function emptyStatusCounts() {
  return Object.fromEntries(statusNames.map((status) => [status, 0]));
}

function summarize(caseResults) {
  const statuses = emptyStatusCounts();
  const families = {};
  for (const result of caseResults) {
    statuses[result.status] += 1;
    if (!families[result.fixtureFamily]) families[result.fixtureFamily] = emptyStatusCounts();
    families[result.fixtureFamily][result.status] += 1;
  }
  return {
    total: caseResults.length,
    statuses,
    byFixtureFamily: Object.fromEntries(Object.entries(families).sort(([left], [right]) => left.localeCompare(right))),
  };
}

function fixtureDirectoryName(index, id) {
  const safeId = id.replace(/[^a-zA-Z0-9._-]/g, "-");
  return `${String(index + 1).padStart(2, "0")}-${safeId}`;
}

export function runPythonResolutionOracleConformance(options = {}, dependencies = {}) {
  const fixtureCases = options.cases || pythonResolutionOracleCases;
  validateCases(fixtureCases);
  const fixtureParent = path.resolve(options.fixtureParent || os.tmpdir());
  fs.mkdirSync(fixtureParent, { recursive: true });
  const fixtureRoot = fs.mkdtempSync(path.join(fixtureParent, "cellfence-python-resolution-oracle-"));
  const pythonExecutable = options.pythonExecutable || defaultPythonExecutable;
  const cellfenceResolver = dependencies.cellfenceResolver || resolveWithCellFence;
  const oracleResolver = dependencies.oracleResolver || ((input) => resolveWithPythonImportlib({
    ...input,
    pythonExecutable,
  }));
  const caseResults = [];

  try {
    for (const [index, fixtureCase] of fixtureCases.entries()) {
      const rootDir = path.join(fixtureRoot, fixtureDirectoryName(index, fixtureCase.id));
      fs.mkdirSync(rootDir, { recursive: true });
      renderPythonResolutionFixture(rootDir, fixtureCase);
      const resultBase = {
        id: fixtureCase.id,
        fixtureFamily: fixtureCase.fixtureFamily,
        specifier: fixtureCase.specifier,
      };
      if (fixtureCase.comparable === false) {
        caseResults.push({
          ...resultBase,
          status: "not_comparable",
          reason: fixtureCase.notComparableReason || "fixture is outside the local import-resolution comparison scope",
        });
        continue;
      }

      const cellfence = cellfenceResolver({ rootDir, fixtureCase, specifier: fixtureCase.specifier });
      const cellfenceTargetPath = normalizeTarget(rootDir, cellfence?.targetPath);
      let oracle;
      try {
        oracle = oracleResolver({ rootDir, fixtureCase, specifier: fixtureCase.specifier });
      } catch (error) {
        caseResults.push({
          ...resultBase,
          status: "oracle_error",
          cellfenceTargetPath,
          cellfenceSourceRoots: cellfence?.sourceRoots || [],
          error: error instanceof Error ? error.message : String(error),
        });
        continue;
      }
      if (oracle?.comparable === false) {
        caseResults.push({
          ...resultBase,
          status: "not_comparable",
          cellfenceTargetPath,
          cellfenceSourceRoots: cellfence?.sourceRoots || [],
          reason: oracle.reason || "importlib result is not comparable",
        });
        continue;
      }
      const oracleTargetPath = normalizeTarget(rootDir, oracle?.targetPath);
      caseResults.push({
        ...resultBase,
        status: cellfenceTargetPath === oracleTargetPath ? "conformant" : "divergent",
        cellfenceTargetPath,
        oracleTargetPath,
        cellfenceSourceRoots: cellfence?.sourceRoots || [],
      });
    }
  } finally {
    if (!options.keepFixtures) fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }

  const report = {
    schemaVersion: "cellfence.python-resolution-oracle-conformance.v1",
    generatedAt: (dependencies.now || (() => new Date()))().toISOString(),
    oracle: dependencies.oracleName || `python-importlib (${pythonExecutable})`,
    fixtureSet: "embedded-local-v1",
    cases: caseResults,
    summary: summarize(caseResults),
  };
  const failed = caseResults.some((result) => result.status === "divergent" || result.status === "oracle_error");
  return { report, exitCode: failed ? 1 : 0, fixtureRoot: options.keepFixtures ? fixtureRoot : undefined };
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

export function main(argv = process.argv.slice(2)) {
  try {
    const options = parsePythonResolutionOracleArgs(argv);
    if (options.help) {
      usage();
      return 0;
    }
    const result = runPythonResolutionOracleConformance(options);
    writeJson(options.outPath, result.report);
    console.log(JSON.stringify(result.report.summary, null, 2));
    if (result.fixtureRoot) console.log(`fixtures: ${result.fixtureRoot}`);
    return result.exitCode;
  } catch (error) {
    usage();
    console.error(error instanceof Error ? error.message : String(error));
    return 2;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  process.exitCode = main();
}
