#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

function usage() {
  console.error(`Usage:
  node scripts/precision-bind-worklists.mjs --protocol protocol.json --worklist reports/corpus/id-worklist [--worklist ...] --out protocol.bound.json
  node scripts/precision-bind-worklists.mjs --protocol protocol.json --worklist reports/corpus/id-worklist [--worklist ...] --in-place

Computes each sealed precision-label worklist artifactSetSha256 from its
SHA256SUMS file and writes claim.worklistArtifactSetSha256s into the protocol.
Use this after worklist generation; worklists bind the claim filters and bundle
pre-label digest, so adding these hashes afterward does not invalidate sealed
assignment packages.`);
}

function parseArgs(argv) {
  const parsed = {
    protocolPath: "",
    worklistDirs: [],
    outPath: "",
    inPlace: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--protocol") {
      parsed.protocolPath = path.resolve(requireValue(argv, index, "--protocol"));
      index += 1;
    } else if (argument.startsWith("--protocol=")) {
      parsed.protocolPath = path.resolve(requireInlineValue(argument, "--protocol=", "--protocol"));
    } else if (argument === "--worklist") {
      parsed.worklistDirs.push(path.resolve(requireValue(argv, index, "--worklist")));
      index += 1;
    } else if (argument.startsWith("--worklist=")) {
      parsed.worklistDirs.push(path.resolve(requireInlineValue(argument, "--worklist=", "--worklist")));
    } else if (argument === "--out") {
      parsed.outPath = path.resolve(requireValue(argv, index, "--out"));
      index += 1;
    } else if (argument.startsWith("--out=")) {
      parsed.outPath = path.resolve(requireInlineValue(argument, "--out=", "--out"));
    } else if (argument === "--in-place") {
      parsed.inPlace = true;
    } else if (argument === "--help" || argument === "-h") {
      usage();
      process.exit(0);
    } else {
      throw new Error(`unknown argument: ${argument}`);
    }
  }
  if (!parsed.protocolPath) throw new Error("--protocol is required");
  if (parsed.worklistDirs.length === 0) throw new Error("at least one --worklist is required");
  if (parsed.inPlace && parsed.outPath) throw new Error("--in-place and --out are mutually exclusive");
  if (!parsed.inPlace && !parsed.outPath) throw new Error("--out or --in-place is required");
  return parsed;
}

function requireValue(argv, index, optionName) {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${optionName} requires a value`);
  return value;
}

function requireInlineValue(argument, prefix, optionName) {
  const value = argument.slice(prefix.length);
  if (!value) throw new Error(`${optionName} requires a value`);
  return value;
}

function hashFile(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function worklistDigest(worklistDir) {
  const sumsPath = path.join(worklistDir, "SHA256SUMS");
  if (!fs.existsSync(sumsPath)) throw new Error(`worklist SHA256SUMS is missing: ${worklistDir}`);
  return hashFile(sumsPath);
}

function bindWorklists(protocol, digests) {
  const next = structuredClone(protocol);
  next.claim = next.claim && typeof next.claim === "object" && !Array.isArray(next.claim) ? next.claim : {};
  next.claim.worklistArtifactSetSha256s = digests;
  delete next.claim.worklistArtifactSetSha256;
  delete next.worklistArtifactSetSha256;
  delete next.worklistArtifactSetSha256s;
  if (next.labelingPlan && typeof next.labelingPlan === "object" && !Array.isArray(next.labelingPlan)) {
    delete next.labelingPlan.worklistArtifactSetSha256;
    delete next.labelingPlan.worklistArtifactSetSha256s;
  }
  return next;
}

export function run(options) {
  const protocol = readJson(options.protocolPath);
  const digests = options.worklistDirs.map(worklistDigest);
  const output = bindWorklists(protocol, digests);
  const outPath = options.inPlace ? options.protocolPath : options.outPath;
  writeJson(outPath, output);
  return {
    protocolPath: options.protocolPath,
    outPath,
    worklistArtifactSetSha256s: digests,
  };
}

function main() {
  try {
    const result = run(parseArgs(process.argv.slice(2)));
    console.log(JSON.stringify(result, null, 2));
    return 0;
  } catch (error) {
    usage();
    console.error(error instanceof Error ? error.message : String(error));
    return 2;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exitCode = main();
}
