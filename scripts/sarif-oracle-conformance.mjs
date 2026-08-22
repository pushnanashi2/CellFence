import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import AjvDraft04 from "ajv-draft-04";
import addFormats from "ajv-formats";

import {
  installCommandReason,
  runEvidenceCommand,
  summarizeCommandFailure,
} from "./evidence-harness-lib.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scriptPath = path.resolve(fileURLToPath(import.meta.url));
const cellfenceCli = path.join(repoRoot, "packages", "cli", "dist", "index.js");
const defaultOutPath = path.join(repoRoot, "reports", "sarif-oracle-conformance.json");
const officialSchemaPath = path.join(repoRoot, "tests", "fixtures", "sarif", "sarif-schema-2.1.0.json");
let officialSarifValidator;

function usage() {
  console.error(`Usage: node scripts/sarif-oracle-conformance.mjs --root repository [--manifest cellfence.manifest.json] [--oracle-command sarif-validator] [--oracle-arg "{sarif}"] [--require-external] [--timeout-ms 120000] [--sarif-out report.sarif] [--out reports/sarif-oracle-conformance.json]

Runs CellFence JSON and SARIF output over the same repository, compares their
semantic findings, then optionally invokes a pre-provisioned external SARIF
validator. The harness never installs the validator or target dependencies.`);
}

function requireValue(argv, index, optionName) {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${optionName} requires a value`);
  return value;
}

export function parseSarifOracleArgs(argv) {
  const options = {
    rootDir: "",
    manifestPath: "cellfence.manifest.json",
    oracleCommand: "",
    oracleArgs: [],
    requireExternal: false,
    timeoutMs: 120_000,
    sarifOutPath: "",
    outPath: defaultOutPath,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--root") {
      options.rootDir = path.resolve(requireValue(argv, index, "--root"));
      index += 1;
    } else if (argument.startsWith("--root=")) options.rootDir = path.resolve(argument.slice(7));
    else if (argument === "--manifest") {
      options.manifestPath = requireValue(argv, index, "--manifest");
      index += 1;
    } else if (argument.startsWith("--manifest=")) options.manifestPath = argument.slice(11);
    else if (argument === "--oracle-command") {
      options.oracleCommand = requireValue(argv, index, "--oracle-command");
      index += 1;
    } else if (argument.startsWith("--oracle-command=")) options.oracleCommand = argument.slice(17);
    else if (argument === "--oracle-arg") {
      options.oracleArgs.push(requireValue(argv, index, "--oracle-arg"));
      index += 1;
    } else if (argument.startsWith("--oracle-arg=")) options.oracleArgs.push(argument.slice(13));
    else if (argument === "--require-external") options.requireExternal = true;
    else if (argument === "--timeout-ms") {
      options.timeoutMs = Number(requireValue(argv, index, "--timeout-ms"));
      index += 1;
    } else if (argument.startsWith("--timeout-ms=")) options.timeoutMs = Number(argument.slice(13));
    else if (argument === "--sarif-out") {
      options.sarifOutPath = path.resolve(requireValue(argv, index, "--sarif-out"));
      index += 1;
    } else if (argument.startsWith("--sarif-out=")) options.sarifOutPath = path.resolve(argument.slice(12));
    else if (argument === "--out") {
      options.outPath = path.resolve(requireValue(argv, index, "--out"));
      index += 1;
    } else if (argument.startsWith("--out=")) options.outPath = path.resolve(argument.slice(6));
    else if (argument === "--help" || argument === "-h") return { help: true };
    else throw new Error(`unknown argument: ${argument}`);
  }
  if (!options.rootDir) throw new Error("--root is required");
  if (path.isAbsolute(options.manifestPath)) throw new Error("--manifest must be relative to --root");
  const resolvedManifest = path.resolve(options.rootDir, options.manifestPath);
  const manifestRelative = path.relative(options.rootDir, resolvedManifest);
  if (manifestRelative === ".." || manifestRelative.startsWith(`..${path.sep}`) || path.isAbsolute(manifestRelative)) {
    throw new Error("--manifest must stay within --root");
  }
  if (!Number.isInteger(options.timeoutMs) || options.timeoutMs < 1 || options.timeoutMs > 300_000) {
    throw new Error("--timeout-ms must be an integer from 1 to 300000");
  }
  return options;
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function findingLine(finding) {
  const line = finding.details?.line;
  return Number.isInteger(line) && line > 0 ? line : null;
}

function normalizedJsonFindings(checkResult) {
  return [...(checkResult.findings || []), ...(checkResult.warnings || [])].map((finding) => ({
    ruleId: finding.ruleId,
    level: finding.severity === "error" ? "error" : "warning",
    message: finding.message,
    filePath: finding.filePath || null,
    line: findingLine(finding),
    fingerprint: finding.fingerprint || null,
  })).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
}

function decodeSarifArtifactUri(uri) {
  try {
    return uri.split("/").map((segment) => decodeURIComponent(segment)).join("/");
  } catch {
    return uri;
  }
}

function normalizedSarifFindings(sarif) {
  const results = sarif.runs?.flatMap((run) => run.results || []) || [];
  return results.map((result) => {
    const location = result.locations?.[0]?.physicalLocation;
    const uri = location?.artifactLocation?.uri || null;
    return {
      ruleId: result.ruleId,
      level: result.level,
      message: result.message?.text,
      filePath: uri ? decodeSarifArtifactUri(uri) : null,
      line: location?.region?.startLine || null,
      fingerprint: result.partialFingerprints?.cellfence || null,
    };
  }).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
}

function officialValidator() {
  if (officialSarifValidator) return officialSarifValidator;
  const ajv = new AjvDraft04({ allErrors: true, strict: true, strictRequired: false });
  addFormats(ajv);
  officialSarifValidator = ajv.compile(JSON.parse(fs.readFileSync(officialSchemaPath, "utf8")));
  return officialSarifValidator;
}

export function validateOfficialSarifSchema(sarif) {
  const validate = officialValidator();
  const valid = validate(sarif);
  return {
    status: valid ? "conformant" : "divergent",
    schemaPath: path.relative(repoRoot, officialSchemaPath).replaceAll("\\", "/"),
    errors: valid ? [] : (validate.errors || []).map((error) => (
      `${error.instancePath || "/"} ${error.message || "failed validation"}`
    )),
  };
}

export function compareSarifToJson(checkResult, sarif) {
  const errors = [];
  const officialSchema = validateOfficialSarifSchema(sarif);
  errors.push(...officialSchema.errors.map((error) => `official schema: ${error}`));
  if (!sarif || typeof sarif !== "object") errors.push("SARIF output must be an object");
  if (sarif?.version !== "2.1.0") errors.push("SARIF version must be 2.1.0");
  if (sarif?.$schema !== "https://json.schemastore.org/sarif-2.1.0.json") {
    errors.push("SARIF $schema must identify the 2.1.0 schema");
  }
  if (!Array.isArray(sarif?.runs) || sarif.runs.length !== 1) errors.push("SARIF output must contain exactly one run");
  const run = sarif?.runs?.[0];
  if (run?.tool?.driver?.name !== "CellFence") errors.push("SARIF tool driver must be CellFence");
  if (!Array.isArray(run?.invocations) || run.invocations.length !== 1) errors.push("SARIF run must contain one invocation");
  const jsonFindings = normalizedJsonFindings(checkResult);
  const sarifFindings = normalizedSarifFindings(sarif || {});
  if (JSON.stringify(jsonFindings) !== JSON.stringify(sarifFindings)) {
    errors.push("SARIF results diverge from CellFence JSON findings");
  }
  const declaredRules = new Set((run?.tool?.driver?.rules || []).map((rule) => rule.id));
  for (const finding of sarifFindings) {
    if (!declaredRules.has(finding.ruleId)) errors.push(`SARIF result rule ${finding.ruleId} is not declared by the driver`);
  }
  return {
    status: errors.length === 0 ? "conformant" : "divergent",
    jsonFindings: jsonFindings.length,
    sarifResults: sarifFindings.length,
    officialSchema,
    errors,
  };
}

function runCellFence(rootDir, manifestPath, format, timeoutMs) {
  const formatArgs = format === "json" ? ["--json"] : ["--format", "sarif"];
  const result = runEvidenceCommand(process.execPath, [
    cellfenceCli,
    "check",
    "--root",
    rootDir,
    "--manifest",
    manifestPath,
    ...formatArgs,
  ], { cwd: rootDir, timeoutMs });
  if (result.timedOut) throw new Error(`CellFence ${format} output timed out after ${timeoutMs}ms`);
  if (![0, 1].includes(result.status)) {
    throw new Error(`CellFence ${format} output failed: ${summarizeCommandFailure(result)}`);
  }
  try {
    return { document: JSON.parse(result.stdout), exitCode: result.status, durationMs: result.durationMs };
  } catch (error) {
    throw new Error(`CellFence ${format} output is not JSON: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
}

function commandOracle(options, sarifPath) {
  if (!options.oracleCommand) {
    return { status: "unavailable", reason: "no external SARIF oracle command was configured" };
  }
  const args = options.oracleArgs.map((argument) => argument.replaceAll("{sarif}", sarifPath));
  if (!options.oracleArgs.some((argument) => argument.includes("{sarif}"))) args.push(sarifPath);
  const installReason = installCommandReason(options.oracleCommand, args);
  if (installReason) return { status: "not_comparable", reason: installReason };
  const result = runEvidenceCommand(options.oracleCommand, args, {
    cwd: repoRoot,
    timeoutMs: options.timeoutMs,
  });
  if (result.errorCode === "ENOENT") {
    return { status: "unavailable", reason: summarizeCommandFailure(result), durationMs: result.durationMs };
  }
  if (result.timedOut) {
    return { status: "timeout", reason: summarizeCommandFailure(result), durationMs: result.durationMs };
  }
  return {
    status: result.status === 0 ? "conformant" : "divergent",
    exitCode: result.status,
    durationMs: result.durationMs,
    diagnostics: (result.stderr || result.stdout).trim().slice(-4000) || null,
  };
}

export function runSarifOracleConformance(options, dependencies = {}) {
  if (!fs.existsSync(cellfenceCli)) throw new Error("CellFence CLI dist is missing; run npm run build first");
  const jsonRun = (dependencies.runCellFence || runCellFence)(options.rootDir, options.manifestPath, "json", options.timeoutMs);
  const sarifRun = (dependencies.runCellFence || runCellFence)(options.rootDir, options.manifestPath, "sarif", options.timeoutMs);
  if (jsonRun.exitCode !== sarifRun.exitCode) {
    throw new Error(`CellFence JSON exit ${jsonRun.exitCode} differs from SARIF exit ${sarifRun.exitCode}`);
  }
  const internal = compareSarifToJson(jsonRun.document, sarifRun.document);
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-sarif-oracle-"));
  const sarifPath = options.sarifOutPath || path.join(tempDir, "cellfence.sarif");
  writeJson(sarifPath, sarifRun.document);
  let external;
  try {
    external = dependencies.externalOracle
      ? dependencies.externalOracle({ sarif: sarifRun.document, sarifPath })
      : commandOracle(options, sarifPath);
    if (!external || typeof external.status !== "string") {
      external = { status: "oracle_error", error: "external SARIF oracle returned an invalid result" };
    }
  } catch (error) {
    external = { status: "oracle_error", error: error instanceof Error ? error.message : String(error) };
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
  const report = {
    schemaVersion: "cellfence.sarif-oracle-conformance.v1",
    generatedAt: new Date().toISOString(),
    subject: {
      rootDir: options.rootDir,
      manifestPath: options.manifestPath,
      exitCode: jsonRun.exitCode,
    },
    generation: {
      jsonDurationMs: jsonRun.durationMs,
      sarifDurationMs: sarifRun.durationMs,
      sarifPath: options.sarifOutPath || null,
    },
    internal,
    external,
    status: internal.status !== "conformant"
      ? "divergent"
      : external.status === "unavailable" && !options.requireExternal ? "conformant" : external.status,
  };
  const externalFailure = ["divergent", "timeout", "oracle_error"].includes(external.status)
    || (options.requireExternal && ["unavailable", "not_comparable"].includes(external.status));
  return { report, exitCode: internal.status === "conformant" && !externalFailure ? 0 : 1 };
}

export function main(argv = process.argv.slice(2)) {
  try {
    const options = parseSarifOracleArgs(argv);
    if (options.help) {
      usage();
      return 0;
    }
    const result = runSarifOracleConformance(options);
    writeJson(options.outPath, result.report);
    console.log(JSON.stringify({ status: result.report.status, internal: result.report.internal, external: result.report.external }, null, 2));
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
