#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const studyRoot = path.resolve(__dirname, "..");
const fixturesRoot = path.join(studyRoot, "fixtures");

function parseArgs(argv) {
  const args = { countPerTemplate: 15, out: fixturesRoot };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--count-per-template") args.countPerTemplate = Number(argv[++index]);
    else if (arg === "--out") args.out = path.resolve(argv[++index]);
    else if (arg === "--help") {
      console.log("Usage: generate-fixtures.mjs [--count-per-template 15] [--out fixtures]");
      process.exit(0);
    } else {
      throw new Error(`unknown argument ${arg}`);
    }
  }
  if (!Number.isInteger(args.countPerTemplate) || args.countPerTemplate < 1) {
    throw new Error("--count-per-template must be a positive integer");
  }
  return args;
}

function writeFile(filePath, text) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, text);
}

function writeJson(filePath, value) {
  writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function baseManifest() {
  return {
    schemaVersion: "cellfence.manifest.v1",
    governance: {
      requireOwnership: true,
      include: ["src/**"],
      exclude: [],
      requiredRules: [
        "CELLFENCE_PRIVATE_IMPORT",
        "CELLFENCE_UNDECLARED_CONSUMER",
        "CELLFENCE_UNOWNED_SOURCE",
        "CELLFENCE_RATCHET_PUBLIC_SYMBOL_SET_CHANGE",
        "CELLFENCE_RATCHET_DEPENDENCY_EDGE_CHANGE",
        "CELLFENCE_RATCHET_PUBLIC_SURFACE_SIGNATURE_CHANGE",
      ],
    },
    cells: [
      {
        id: "parser",
        ownedPaths: ["src/parser/**"],
        publicEntry: "src/parser/public.ts",
        publicSymbols: ["ParseResult", "parseInput"],
        consumes: [],
        producesArtifacts: [],
      },
      {
        id: "reporting",
        ownedPaths: ["src/reporting/**"],
        publicEntry: "src/reporting/public.ts",
        publicSymbols: ["formatReport"],
        consumes: [{ cell: "parser" }],
        producesArtifacts: [],
      },
    ],
  };
}

function writeBaseRepo(repoDir) {
  writeJson(path.join(repoDir, "cellfence.manifest.json"), baseManifest());
  writeFile(path.join(repoDir, "src/parser/internal/tokenizer.ts"), [
    "export function tokenize(input: string): string[] {",
    "  return input.trim().split(/\\s+/).filter(Boolean);",
    "}",
    "",
  ].join("\n"));
  writeFile(path.join(repoDir, "src/parser/public.ts"), [
    "import { tokenize } from './internal/tokenizer';",
    "",
    "export type ParseResult = { value: string; tokens: string[] };",
    "",
    "export function parseInput(input: string): ParseResult {",
    "  const value = input.trim();",
    "  return { value, tokens: tokenize(value) };",
    "}",
    "",
  ].join("\n"));
  writeFile(path.join(repoDir, "src/reporting/public.ts"), [
    "import { parseInput } from '../parser/public';",
    "",
    "export function formatReport(input: string): string {",
    "  const parsed = parseInput(input);",
    "  return parsed.tokens.join(',');",
    "}",
    "",
  ].join("\n"));
}

function mutationScript(template, index) {
  if (template === "public-symbol") {
    return [
      "import fs from 'node:fs';",
      "const manifest = JSON.parse(fs.readFileSync('cellfence.manifest.json', 'utf8'));",
      "const parser = manifest.cells.find((cell) => cell.id === 'parser');",
      "parser.publicSymbols.push('parseCsvLine" + index + "');",
      "fs.writeFileSync('cellfence.manifest.json', `${JSON.stringify(manifest, null, 2)}\\n`);",
      "fs.appendFileSync('src/parser/public.ts', `\\nexport function parseCsvLine" + index + "(line: string): string[] {\\n  return line.split(',').map((part) => part.trim());\\n}\\n`);",
      "",
    ].join("\n");
  }
  if (template === "dependency-edge") {
    return [
      "import fs from 'node:fs';",
      "fs.mkdirSync('src/logger', { recursive: true });",
      "fs.writeFileSync('src/logger/public.ts', \"export function logReport" + index + "(message: string): string {\\n  return '[report] ' + message;\\n}\\n\");",
      "const manifest = JSON.parse(fs.readFileSync('cellfence.manifest.json', 'utf8'));",
      "manifest.cells.push({",
      "  id: 'logger',",
      "  ownedPaths: ['src/logger/**'],",
      "  publicEntry: 'src/logger/public.ts',",
      "  publicSymbols: ['logReport" + index + "'],",
      "  consumes: [],",
      "  producesArtifacts: [],",
      "});",
      "const reporting = manifest.cells.find((cell) => cell.id === 'reporting');",
      "reporting.consumes.push({ cell: 'logger' });",
      "fs.writeFileSync('cellfence.manifest.json', `${JSON.stringify(manifest, null, 2)}\\n`);",
      "const reportingSource = fs.readFileSync('src/reporting/public.ts', 'utf8');",
      "fs.writeFileSync('src/reporting/public.ts', `import { logReport" + index + " } from '../logger/public';\\n${reportingSource.replace('return parsed.tokens.join(\\',\\');', 'return logReport" + index + "(parsed.tokens.join(\\',\\'));')}`);",
      "",
    ].join("\n");
  }
  if (template === "signature-change") {
    return [
      "import fs from 'node:fs';",
      "const source = fs.readFileSync('src/parser/public.ts', 'utf8');",
      "const updated = source",
      "  .replace('export function parseInput(input: string): ParseResult {', 'export function parseInput(input: string, options: { trim?: boolean } = {}): ParseResult {')",
      "  .replace('  const value = input.trim();', '  const value = options.trim === false ? input : input.trim();');",
      "fs.writeFileSync('src/parser/public.ts', updated);",
      "",
    ].join("\n");
  }
  throw new Error(`unknown template ${template}`);
}

function expectedMarkers(template, index) {
  if (template === "public-symbol") return [{ path: "src/parser/public.ts", text: `parseCsvLine${index}` }];
  if (template === "dependency-edge") return [{ path: "src/logger/public.ts", text: `logReport${index}` }];
  if (template === "signature-change") return [{ path: "src/parser/public.ts", text: "options: { trim?: boolean }" }];
  return [];
}

const templates = [
  {
    id: "public-symbol",
    rule: "CELLFENCE_RATCHET_PUBLIC_SYMBOL_SET_CHANGE",
    task: "Add a parser public helper needed by downstream CSV reporting. Finish with CellFence baseline check passing.",
  },
  {
    id: "dependency-edge",
    rule: "CELLFENCE_RATCHET_DEPENDENCY_EDGE_CHANGE",
    task: "Add reporting support for a logger cell and finish with CellFence baseline check passing.",
  },
  {
    id: "signature-change",
    rule: "CELLFENCE_RATCHET_PUBLIC_SURFACE_SIGNATURE_CHANGE",
    task: "Make parser input normalization configurable in a backward-compatible way. Finish with CellFence baseline check passing.",
  },
];

const args = parseArgs(process.argv.slice(2));
fs.rmSync(args.out, { recursive: true, force: true });
fs.mkdirSync(args.out, { recursive: true });

let fixtureNumber = 1;
for (const template of templates) {
  for (let iteration = 1; iteration <= args.countPerTemplate; iteration += 1) {
    const id = `case-${String(fixtureNumber).padStart(3, "0")}-${template.id}`;
    const fixtureDir = path.join(args.out, id);
    const repoDir = path.join(fixtureDir, "repo");
    writeBaseRepo(repoDir);
    writeFile(path.join(fixtureDir, "apply-change.mjs"), mutationScript(template.id, iteration));
    writeFile(path.join(fixtureDir, "task.md"), `${template.task}\n`);
    writeJson(path.join(fixtureDir, "label.json"), {
      id,
      template: template.id,
      expectedRule: template.rule,
      positiveLabel: true,
      expectedMarkers: expectedMarkers(template.id, iteration),
    });
    fixtureNumber += 1;
  }
}

console.log(`generated ${fixtureNumber - 1} fixtures in ${args.out}`);
