import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";

import {
  readPathAliases,
  resolveNearestPathAliasTarget,
  resolvePackageExportTarget,
  resolvePackageImportsTarget,
  resolvePathAliasTarget,
  resolveRelativeImport,
} from "../packages/engine/dist/module-resolution.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scriptPath = path.resolve(fileURLToPath(import.meta.url));
const defaultLedgerPath = path.join(repoRoot, "tests", "conformance", "resolution", "resolution-cases.json");
const defaultOutPath = path.join(repoRoot, "reports", "resolution-oracle-conformance.json");
const comparableFamilies = new Set([
  "relative-runtime-extension",
  "tsconfig-paths",
  "nearest-tsconfig-paths",
  "package-imports",
  "package-name",
  "package-subpath",
  "unresolved-relative",
]);

function usage() {
  console.error("Usage: node scripts/resolution-oracle-conformance.mjs [--ledger tests/conformance/resolution/resolution-cases.json] [--out reports/resolution-oracle-conformance.json] [--keep-fixtures]");
}

export function parseResolutionOracleArgs(argv) {
  const options = { ledgerPath: defaultLedgerPath, outPath: defaultOutPath, keepFixtures: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const value = () => {
      const next = argv[index + 1];
      if (!next || next.startsWith("--")) throw new Error(`${argument} requires a value`);
      index += 1;
      return next;
    };
    if (argument === "--ledger") options.ledgerPath = path.resolve(value());
    else if (argument.startsWith("--ledger=")) options.ledgerPath = path.resolve(argument.slice(9));
    else if (argument === "--out") options.outPath = path.resolve(value());
    else if (argument.startsWith("--out=")) options.outPath = path.resolve(argument.slice(6));
    else if (argument === "--keep-fixtures") options.keepFixtures = true;
    else if (argument === "--help" || argument === "-h") return { help: true };
    else throw new Error(`unknown argument: ${argument}`);
  }
  return options;
}

function writeFile(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const text = Array.isArray(value) ? value.join("\n") : String(value);
  fs.writeFileSync(filePath, text.endsWith("\n") ? text : `${text}\n`);
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function defaultFiles(rootDir, language) {
  if (language === "python") {
    writeFile(path.join(rootDir, "src/producer/public.py"), ["__all__ = ['exposed']", "exposed = True"]);
    writeFile(path.join(rootDir, "src/producer/internal.py"), "secret = True");
    writeFile(path.join(rootDir, "src/consumer/public.py"), "consumerValue = True");
    return;
  }
  writeFile(path.join(rootDir, "src/producer/public.ts"), "export const exposed = true;");
  writeFile(path.join(rootDir, "src/producer/internal.ts"), "export const secret = true;");
  writeFile(path.join(rootDir, "src/consumer/public.ts"), "export const consumerValue = true;");
}

export function renderResolutionCase(rootDir, conformanceCase) {
  const language = conformanceCase.language || "typescript";
  defaultFiles(rootDir, language);
  writeFile(path.join(rootDir, conformanceCase.sourceFile), conformanceCase.source);
  for (const [relativePath, contents] of Object.entries(conformanceCase.extraFiles || {})) {
    writeFile(path.join(rootDir, relativePath), contents);
  }
  for (const [relativePath, contents] of Object.entries(conformanceCase.tsconfigs || {})) {
    writeJson(path.join(rootDir, relativePath), contents);
  }
  if (conformanceCase.rootPackageJson) writeJson(path.join(rootDir, "package.json"), conformanceCase.rootPackageJson);
  if (conformanceCase.producerPackageJson) {
    const packageRoot = path.join(rootDir, "src", "producer");
    writeJson(path.join(packageRoot, "package.json"), conformanceCase.producerPackageJson);
    if (conformanceCase.producerPackageName) {
      const packageParts = conformanceCase.producerPackageName.split("/");
      const packageLink = path.join(rootDir, "node_modules", ...packageParts);
      fs.mkdirSync(path.dirname(packageLink), { recursive: true });
      fs.symlinkSync(packageRoot, packageLink, process.platform === "win32" ? "junction" : "dir");
    }
  }
}

function specifierForCase(conformanceCase) {
  if (conformanceCase.expected?.specifier) return conformanceCase.expected.specifier;
  const source = Array.isArray(conformanceCase.source) ? conformanceCase.source.join("\n") : String(conformanceCase.source || "");
  const match = source.match(/\bfrom\s+["']([^"']+)["']|\bimport\s*["']([^"']+)["']|\brequire\s*\(\s*["']([^"']+)["']/);
  return match?.[1] || match?.[2] || match?.[3] || null;
}

function normalizeTarget(rootDir, targetPath) {
  if (!targetPath) return null;
  const absoluteRoot = fs.existsSync(rootDir) ? fs.realpathSync(rootDir) : path.resolve(rootDir);
  const unresolved = path.isAbsolute(targetPath) ? targetPath : path.resolve(absoluteRoot, targetPath);
  const absolute = fs.existsSync(unresolved) ? fs.realpathSync(unresolved) : unresolved;
  const relative = path.relative(absoluteRoot, absolute);
  if (relative === "" || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    return absolute.replaceAll("\\", "/");
  }
  return relative.replaceAll("\\", "/");
}

export function resolveWithCellFence({ rootDir, conformanceCase, specifier }) {
  if (!comparableFamilies.has(conformanceCase.resolverFamily)) {
    return { comparable: false, reason: `resolver family ${conformanceCase.resolverFamily} has no equivalent TypeScript oracle setup` };
  }
  let targetPath;
  if (["relative-runtime-extension", "unresolved-relative"].includes(conformanceCase.resolverFamily)) {
    targetPath = resolveRelativeImport(rootDir, conformanceCase.sourceFile, specifier);
  } else if (["tsconfig-paths", "nearest-tsconfig-paths"].includes(conformanceCase.resolverFamily)) {
    targetPath = resolveNearestPathAliasTarget(rootDir, conformanceCase.sourceFile, specifier)
      || resolvePathAliasTarget({ rootDir, pathAliases: readPathAliases(rootDir) }, specifier);
  } else if (conformanceCase.resolverFamily === "package-imports") {
    targetPath = resolvePackageImportsTarget(rootDir, conformanceCase.sourceFile, specifier, "import");
  } else if (["package-name", "package-subpath"].includes(conformanceCase.resolverFamily)) {
    targetPath = resolvePackageExportTarget(
      rootDir,
      "src/producer",
      conformanceCase.producerPackageName,
      specifier,
      "import",
    ).targetPath;
  }
  return { comparable: true, targetPath: normalizeTarget(rootDir, targetPath) };
}

function nearestTsconfig(rootDir, importerPath) {
  let directory = path.dirname(path.resolve(rootDir, importerPath));
  const absoluteRoot = path.resolve(rootDir);
  while (directory === absoluteRoot || directory.startsWith(`${absoluteRoot}${path.sep}`)) {
    const candidate = path.join(directory, "tsconfig.json");
    if (fs.existsSync(candidate)) return candidate;
    if (directory === absoluteRoot) break;
    directory = path.dirname(directory);
  }
  return null;
}

export function resolveWithTypescript({ rootDir, conformanceCase, specifier }) {
  const importerPath = path.resolve(rootDir, conformanceCase.sourceFile);
  let compilerOptions = {
    allowJs: true,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    resolveJsonModule: true,
  };
  const configPath = nearestTsconfig(rootDir, conformanceCase.sourceFile);
  if (configPath) {
    const config = ts.readConfigFile(configPath, ts.sys.readFile);
    if (config.error) throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, "\n"));
    const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, path.dirname(configPath));
    if (parsed.errors.length > 0) {
      throw new Error(ts.flattenDiagnosticMessageText(parsed.errors[0].messageText, "\n"));
    }
    compilerOptions = { ...compilerOptions, ...parsed.options };
  }
  const resolution = ts.resolveModuleName(specifier, importerPath, compilerOptions, ts.sys).resolvedModule;
  return { available: true, targetPath: normalizeTarget(rootDir, resolution?.resolvedFileName) };
}

function summarize(cases) {
  const statuses = {};
  const families = {};
  for (const result of cases) {
    statuses[result.status] = (statuses[result.status] || 0) + 1;
    if (!families[result.resolverFamily]) families[result.resolverFamily] = {};
    families[result.resolverFamily][result.status] = (families[result.resolverFamily][result.status] || 0) + 1;
  }
  return {
    total: cases.length,
    statuses: Object.fromEntries(Object.entries(statuses).sort()),
    byResolverFamily: Object.fromEntries(Object.entries(families).sort()),
  };
}

export function runResolutionOracleConformance(options, dependencies = {}) {
  const ledger = options.ledger || JSON.parse(fs.readFileSync(options.ledgerPath, "utf8"));
  if (ledger.schemaVersion !== "cellfence.resolution-conformance.v1" || !Array.isArray(ledger.cases)) {
    throw new Error("resolution ledger must use cellfence.resolution-conformance.v1");
  }
  const oracleResolver = dependencies.oracleResolver || resolveWithTypescript;
  const cellfenceResolver = dependencies.cellfenceResolver || resolveWithCellFence;
  const fixtureParent = options.fixtureParent || os.tmpdir();
  const caseResults = [];
  for (const conformanceCase of ledger.cases) {
    const rootDir = fs.mkdtempSync(path.join(fixtureParent, `cellfence-resolution-oracle-${conformanceCase.id}-`));
    try {
      renderResolutionCase(rootDir, conformanceCase);
      const specifier = specifierForCase(conformanceCase);
      if (!specifier) {
        caseResults.push({
          id: conformanceCase.id,
          resolverFamily: conformanceCase.resolverFamily,
          status: "not_comparable",
          reason: "case does not expose a static module specifier",
        });
        continue;
      }
      const cellfence = cellfenceResolver({ rootDir, conformanceCase, specifier });
      if (cellfence.comparable === false) {
        caseResults.push({
          id: conformanceCase.id,
          resolverFamily: conformanceCase.resolverFamily,
          specifier,
          status: "not_comparable",
          reason: cellfence.reason,
        });
        continue;
      }
      let oracle;
      try {
        oracle = oracleResolver({ rootDir, conformanceCase, specifier });
      } catch (error) {
        caseResults.push({
          id: conformanceCase.id,
          resolverFamily: conformanceCase.resolverFamily,
          specifier,
          status: "oracle_error",
          cellfenceTargetPath: cellfence.targetPath,
          error: error instanceof Error ? error.message : String(error),
        });
        continue;
      }
      if (oracle?.available === false) {
        caseResults.push({
          id: conformanceCase.id,
          resolverFamily: conformanceCase.resolverFamily,
          specifier,
          status: "unavailable",
          cellfenceTargetPath: cellfence.targetPath,
          reason: oracle.reason || "external resolution oracle is unavailable",
        });
        continue;
      }
      const oracleTargetPath = normalizeTarget(rootDir, oracle?.targetPath);
      caseResults.push({
        id: conformanceCase.id,
        resolverFamily: conformanceCase.resolverFamily,
        specifier,
        status: cellfence.targetPath === oracleTargetPath ? "conformant" : "divergent",
        cellfenceTargetPath: cellfence.targetPath,
        oracleTargetPath,
      });
    } finally {
      if (!options.keepFixtures) fs.rmSync(rootDir, { recursive: true, force: true });
    }
  }
  const report = {
    schemaVersion: "cellfence.resolution-oracle-conformance.v1",
    generatedAt: new Date().toISOString(),
    oracle: dependencies.oracleName || `typescript@${ts.version}`,
    ledgerSchemaVersion: ledger.schemaVersion,
    cases: caseResults,
    summary: summarize(caseResults),
  };
  const failing = caseResults.some((result) => ["divergent", "oracle_error"].includes(result.status));
  return { report, exitCode: failing ? 1 : 0 };
}

export function main(argv = process.argv.slice(2)) {
  try {
    const options = parseResolutionOracleArgs(argv);
    if (options.help) {
      usage();
      return 0;
    }
    const result = runResolutionOracleConformance(options);
    writeJson(options.outPath, result.report);
    console.log(JSON.stringify(result.report.summary, null, 2));
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
