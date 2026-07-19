import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const defaultWorkDir = path.join(repoRoot, "tmp", "mutation-injection-study");
const defaultOutPath = path.join(repoRoot, "reports", "mutation-injection-study.json");
const cellfenceCli = path.join(repoRoot, "packages", "cli", "dist", "index.js");
const commandTimeoutMs = 120_000;

function usage() {
  console.error(`Usage: node scripts/mutation-injection-study.mjs [--workdir tmp/mutation] [--out reports/mutation-injection-study.json] [--template id] [--dry-run] [--list-templates]

Creates reviewed synthetic repositories, injects known CellFence policy
violations, runs the packaged CLI, and reports whether expected rules fire. This
is recall evidence for controlled mutations, not public-OSS precision evidence.`);
}

function readArgs(argv) {
  const parsed = {
    workDir: defaultWorkDir,
    outPath: defaultOutPath,
    templates: [],
    dryRun: false,
    listTemplates: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--workdir") {
      parsed.workDir = path.resolve(argv[index + 1] || "");
      index += 1;
    } else if (argument.startsWith("--workdir=")) {
      parsed.workDir = path.resolve(argument.slice("--workdir=".length));
    } else if (argument === "--out") {
      parsed.outPath = path.resolve(argv[index + 1] || "");
      index += 1;
    } else if (argument.startsWith("--out=")) {
      parsed.outPath = path.resolve(argument.slice("--out=".length));
    } else if (argument === "--template") {
      parsed.templates.push(...String(argv[index + 1] || "").split(",").filter(Boolean));
      index += 1;
    } else if (argument.startsWith("--template=")) {
      parsed.templates.push(...argument.slice("--template=".length).split(",").filter(Boolean));
    } else if (argument === "--dry-run") {
      parsed.dryRun = true;
    } else if (argument === "--list-templates") {
      parsed.listTemplates = true;
    } else if (argument === "--help" || argument === "-h") {
      usage();
      process.exit(0);
    } else {
      throw new Error(`unknown argument: ${argument}`);
    }
  }
  return parsed;
}

function writeFile(filePath, lines) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${Array.isArray(lines) ? lines.join("\n") : lines}\n`);
}

function writeJson(filePath, value) {
  writeFile(filePath, JSON.stringify(value, null, 2));
}

function hashText(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

function hashFile(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function slugId(value) {
  return String(value).replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64) || "mutation";
}

function isPathWithin(baseDir, candidatePath, allowBase = false) {
  const relative = path.relative(path.resolve(baseDir), path.resolve(candidatePath));
  if (relative === "") return allowBase;
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function resolveInside(baseDir, relativePath, label, options = {}) {
  if (typeof relativePath !== "string" || relativePath.length === 0 || path.isAbsolute(relativePath)) {
    throw new Error(`${label} must be a non-empty relative path`);
  }
  const resolved = path.resolve(baseDir, relativePath);
  if (!isPathWithin(baseDir, resolved, options.allowBase === true)) {
    throw new Error(`${label} escapes its root: ${relativePath}`);
  }
  return resolved;
}

function subjectDir(workDir, templateId) {
  return resolveInside(workDir, `${slugId(templateId)}-${hashText(templateId).slice(0, 12)}`, "template id");
}

function baseManifest(patch = {}) {
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
        "CELLFENCE_PUBLIC_SYMBOL_MISMATCH",
        "CELLFENCE_UNDECLARED_RESOURCE_ACCESS",
      ],
    },
    cells: [
      {
        id: "core",
        ownedPaths: ["src/core/**"],
        publicEntry: "src/core/public.ts",
        publicSymbols: ["core"],
        consumes: [],
        producesArtifacts: [],
      },
      {
        id: "app",
        ownedPaths: ["src/app/**"],
        publicEntry: "src/app/public.ts",
        publicSymbols: ["app"],
        consumes: [{ cell: "core" }],
        producesArtifacts: [],
      },
    ],
    ...patch,
  };
}

function writeBaseProject(rootDir, manifest = baseManifest()) {
  writeFile(path.join(rootDir, "src/core/public.ts"), "export const core = true;");
  writeFile(path.join(rootDir, "src/core/internal.ts"), "export const hidden = true;");
  writeFile(path.join(rootDir, "src/app/public.ts"), [
    "import { core } from '../core/public';",
    "export const app = core;",
  ]);
  writeJson(path.join(rootDir, "cellfence.manifest.json"), manifest);
}

function baselineFor(cells) {
  return {
    schemaVersion: "cellfence.baseline.v1",
    generatedAt: "2026-01-01T00:00:00.000Z",
    cells,
  };
}

const mutationTemplates = [
  {
    id: "private-import",
    category: "imports",
    description: "consumer imports a producer private implementation file",
    expectedRuleIds: ["CELLFENCE_PRIVATE_IMPORT"],
    prepare(rootDir) {
      writeBaseProject(rootDir);
      writeFile(path.join(rootDir, "src/app/public.ts"), [
        "import { hidden } from '../core/internal';",
        "export const app = hidden;",
      ]);
    },
  },
  {
    id: "undeclared-consumer",
    category: "imports",
    description: "consumer imports a public entry without declaring the producer dependency",
    expectedRuleIds: ["CELLFENCE_UNDECLARED_CONSUMER"],
    prepare(rootDir) {
      const manifest = baseManifest({
        cells: [
          baseManifest().cells[0],
          { ...baseManifest().cells[1], consumes: [] },
        ],
      });
      writeBaseProject(rootDir, manifest);
    },
  },
  {
    id: "unowned-source",
    category: "ownership",
    description: "new governed source is outside every owned path",
    expectedRuleIds: ["CELLFENCE_UNOWNED_SOURCE"],
    prepare(rootDir) {
      writeBaseProject(rootDir);
      writeFile(path.join(rootDir, "src/orphan/util.ts"), "export const orphan = true;");
    },
  },
  {
    id: "public-symbol-drift",
    category: "public-surface",
    description: "public entry exports a symbol absent from manifest publicSymbols",
    expectedRuleIds: ["CELLFENCE_PUBLIC_SYMBOL_MISMATCH"],
    prepare(rootDir) {
      writeBaseProject(rootDir);
      writeFile(path.join(rootDir, "src/app/public.ts"), [
        "import { core } from '../core/public';",
        "export const app = core;",
        "export const extra = true;",
      ]);
    },
  },
  {
    id: "undeclared-file-resource",
    category: "resources",
    description: "source reads an undeclared static file resource",
    expectedRuleIds: ["CELLFENCE_UNDECLARED_RESOURCE_ACCESS"],
    prepare(rootDir) {
      writeBaseProject(rootDir);
      writeFile(path.join(rootDir, "src/app/public.ts"), [
        "import * as fs from 'node:fs';",
        "export function app(): string {",
        "  return fs.readFileSync('data/input.json');",
        "}",
      ]);
    },
  },
  {
    id: "computed-dynamic-import",
    category: "imports",
    description: "source uses a computed dynamic import that cannot be resolved statically",
    expectedRuleIds: ["CELLFENCE_UNSUPPORTED_DYNAMIC_IMPORT"],
    prepare(rootDir) {
      writeBaseProject(rootDir);
      writeFile(path.join(rootDir, "src/app/public.ts"), [
        "export async function app(specifier: string): Promise<unknown> {",
        "  return import(specifier);",
        "}",
      ]);
    },
  },
  {
    id: "ratchet-public-symbol-growth",
    category: "ratchet",
    description: "manifest and code add a public symbol outside the accepted baseline",
    expectedRuleIds: [
      "CELLFENCE_RATCHET_PUBLIC_SYMBOL_GROWTH",
      "CELLFENCE_RATCHET_PUBLIC_SYMBOL_SET_CHANGE",
    ],
    checkKind: "baseline",
    prepare(rootDir) {
      const manifest = baseManifest({
        cells: [
          baseManifest().cells[0],
          { ...baseManifest().cells[1], publicSymbols: ["app", "extra"] },
        ],
      });
      writeBaseProject(rootDir, manifest);
      writeFile(path.join(rootDir, "src/app/public.ts"), [
        "import { core } from '../core/public';",
        "export const app = core;",
        "export const extra = true;",
      ]);
      writeJson(path.join(rootDir, "cellfence.baseline.json"), baselineFor({
        core: {
          ownedPathPatterns: 1,
          publicSymbols: 1,
          publicSurfaceLines: 2,
          crossCellDependencies: 0,
          ownedPathSet: ["src/core/**"],
          publicEntryPath: "src/core/public.ts",
          publicSymbolSet: ["core"],
          dependencyEdges: [],
          artifactContracts: [],
          resourceAccesses: [],
        },
        app: {
          ownedPathPatterns: 1,
          publicSymbols: 1,
          publicSurfaceLines: 4,
          crossCellDependencies: 1,
          ownedPathSet: ["src/app/**"],
          publicEntryPath: "src/app/public.ts",
          publicSymbolSet: ["app"],
          dependencyEdges: ["app->core"],
          artifactContracts: [],
          resourceAccesses: [],
        },
      }));
    },
  },
];

function selectedTemplates(templateIds) {
  if (templateIds.length === 0 || templateIds.includes("all")) return mutationTemplates;
  const byId = new Map(mutationTemplates.map((template) => [template.id, template]));
  return templateIds.map((id) => {
    const template = byId.get(id);
    if (!template) throw new Error(`unknown mutation template: ${id}`);
    return template;
  });
}

function run(command, args, options) {
  const startedAt = performance.now();
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      LC_ALL: "C",
      TZ: "UTC",
    },
    timeout: commandTimeoutMs,
    maxBuffer: 100 * 1024 * 1024,
  });
  const errorCode = result.error && typeof result.error === "object" && "code" in result.error
    ? String(result.error.code)
    : undefined;
  return {
    command: [command, ...args].join(" "),
    status: result.status ?? (errorCode === "ETIMEDOUT" ? 124 : 1),
    stdout: result.stdout || "",
    stderr: result.stderr || "",
    error: result.error ? String(result.error.message || result.error) : undefined,
    errorCode,
    timeoutMs: commandTimeoutMs,
    durationMs: Math.round(performance.now() - startedAt),
  };
}

function writeCommandLogs(logDir, name, result) {
  fs.mkdirSync(logDir, { recursive: true });
  fs.writeFileSync(path.join(logDir, `${name}.stdout.log`), result.stdout);
  fs.writeFileSync(path.join(logDir, `${name}.stderr.log`), result.stderr);
}

function summarizeFindings(findings) {
  const counts = {};
  for (const finding of findings) counts[finding.ruleId] = (counts[finding.ruleId] || 0) + 1;
  return Object.fromEntries(Object.entries(counts).sort((left, right) => left[0].localeCompare(right[0])));
}

function parseCheckOutput(result) {
  try {
    return JSON.parse(result.stdout);
  } catch {
    return undefined;
  }
}

function runTemplate(template, options) {
  const rootDir = subjectDir(options.workDir, template.id);

  if (options.dryRun) {
    return {
      id: template.id,
      category: template.category,
      description: template.description,
      status: "planned",
      expectedRuleIds: template.expectedRuleIds,
      detectedRuleIds: [],
      matchedRuleIds: [],
      missingRuleIds: template.expectedRuleIds,
      unexpectedRuleIds: [],
      subjectDir: rootDir,
    };
  }

  const logDir = path.join(rootDir, "logs");
  fs.rmSync(rootDir, { recursive: true, force: true });
  fs.mkdirSync(rootDir, { recursive: true });

  template.prepare(rootDir);
  fs.mkdirSync(logDir, { recursive: true });
  const manifestSha256 = hashFile(path.join(rootDir, "cellfence.manifest.json"));
  const args = template.checkKind === "baseline"
    ? [
      cellfenceCli,
      "baseline",
      "check",
      "--manifest",
      "cellfence.manifest.json",
      "--baseline",
      "cellfence.baseline.json",
      "--json",
      "--audit-log",
      "logs/check.audit.jsonl",
      "--summary-json",
      "logs/check.summary.json",
    ]
    : [
      cellfenceCli,
      "check",
      "--manifest",
      "cellfence.manifest.json",
      "--json",
      "--audit-log",
      "logs/check.audit.jsonl",
      "--summary-json",
      "logs/check.summary.json",
    ];
  const result = run(process.execPath, args, { cwd: rootDir });
  writeCommandLogs(logDir, "check", result);

  const parsed = parseCheckOutput(result);
  const findings = Array.isArray(parsed?.findings) ? parsed.findings : [];
  const detectedRuleIds = [...new Set(findings.map((finding) => finding.ruleId).filter(Boolean))].sort();
  const matchedRuleIds = template.expectedRuleIds.filter((ruleId) => detectedRuleIds.includes(ruleId)).sort();
  const missingRuleIds = template.expectedRuleIds.filter((ruleId) => !detectedRuleIds.includes(ruleId)).sort();
  const expectedSet = new Set(template.expectedRuleIds);
  const unexpectedRuleIds = detectedRuleIds.filter((ruleId) => !expectedSet.has(ruleId)).sort();
  const status = missingRuleIds.length === 0
    ? "detected_expected_rules"
    : result.status === 2 || !parsed
      ? "harness_failed"
      : "missed_expected_rules";

  return {
    id: template.id,
    category: template.category,
    description: template.description,
    status,
    expectedRuleIds: template.expectedRuleIds,
    detectedRuleIds,
    matchedRuleIds,
    missingRuleIds,
    unexpectedRuleIds,
    manifestSha256,
    subjectDir: rootDir,
    check: {
      exitCode: result.status,
      durationMs: result.durationMs,
      findingsByRule: summarizeFindings(findings),
      stdoutSha256: hashText(result.stdout),
      stderrSha256: hashText(result.stderr),
      auditLog: fs.existsSync(path.join(logDir, "check.audit.jsonl")) ? "logs/check.audit.jsonl" : null,
      summaryJson: fs.existsSync(path.join(logDir, "check.summary.json")) ? "logs/check.summary.json" : null,
    },
  };
}

function createSummary(results) {
  const executed = results.filter((result) => result.status !== "planned");
  const detected = executed.filter((result) => result.missingRuleIds.length === 0);
  const missed = executed.filter((result) => result.missingRuleIds.length > 0);
  const byRule = {};
  for (const result of executed) {
    for (const ruleId of result.expectedRuleIds) {
      const entry = byRule[ruleId] || { expected: 0, detected: 0, missed: 0 };
      entry.expected += 1;
      if (result.matchedRuleIds.includes(ruleId)) entry.detected += 1;
      else entry.missed += 1;
      byRule[ruleId] = entry;
    }
  }
  return {
    total: results.length,
    planned: results.length - executed.length,
    executed: executed.length,
    detected: detected.length,
    missed: missed.length,
    recall: executed.length === 0 ? null : detected.length / executed.length,
    byRule: Object.fromEntries(Object.entries(byRule).sort((left, right) => left[0].localeCompare(right[0]))),
  };
}

function createReport(options) {
  const templates = selectedTemplates(options.templates);
  const results = templates.map((template) => runTemplate(template, options));
  const summary = createSummary(results);
  const evidenceSetSha256 = hashText(stableStringify({
    summary,
    mutations: results.map((result) => ({
      id: result.id,
      status: result.status,
      expectedRuleIds: result.expectedRuleIds,
      detectedRuleIds: result.detectedRuleIds,
      missingRuleIds: result.missingRuleIds,
      manifestSha256: result.manifestSha256 || null,
      stdoutSha256: result.check?.stdoutSha256 || null,
      stderrSha256: result.check?.stderrSha256 || null,
    })),
  }));
  return {
    schemaVersion: "cellfence.mutation-injection-study.v1",
    generatedAt: new Date().toISOString(),
    claimBoundary: "controlled synthetic mutation recall evidence; not public OSS precision or recall",
    workDir: options.workDir,
    dryRun: options.dryRun,
    evidenceSetSha256,
    summary,
    mutations: results,
  };
}

function main() {
  const options = readArgs(process.argv.slice(2));
  if (options.listTemplates) {
    for (const template of mutationTemplates) console.log(`${template.id}\t${template.category}\t${template.description}`);
    return 0;
  }
  const report = createReport(options);
  writeJson(options.outPath, report);
  console.log(`wrote ${options.outPath}`);
  console.log(`mutation templates: ${report.summary.detected}/${report.summary.executed} detected`);
  if (report.summary.missed > 0) return 1;
  return 0;
}

try {
  process.exitCode = main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 2;
}
