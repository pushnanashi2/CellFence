import fs from "node:fs";
import path from "node:path";

import { inferManifest } from "@cellfence/engine";

type InferredManifest = ReturnType<typeof inferManifest>;
type InitPreset = "python-service" | "polyglot-monorepo";

const MANIFEST_SCHEMA_VERSION: InferredManifest["schemaVersion"] = "cellfence.manifest.v1";
const INIT_PRESETS = new Set<InitPreset>(["python-service", "polyglot-monorepo"]);
const INIT_REQUIRED_RULES = [
  "CELLFENCE_OWNERSHIP_OVERLAP",
  "CELLFENCE_UNOWNED_SOURCE",
  "CELLFENCE_UNOWNED_IMPORT_TARGET",
  "CELLFENCE_PUBLIC_ENTRY_OUTSIDE_OWNERSHIP",
  "CELLFENCE_ARTIFACT_OUTSIDE_OWNERSHIP",
  "CELLFENCE_SYMLINK_TARGET_OUTSIDE_OWNERSHIP",
  "CELLFENCE_PRIVATE_IMPORT",
  "CELLFENCE_UNSUPPORTED_DYNAMIC_IMPORT",
  "CELLFENCE_UNSUPPORTED_DYNAMIC_REQUIRE",
  "CELLFENCE_UNSUPPORTED_TYPESCRIPT_SYNTAX",
  "CELLFENCE_UNSUPPORTED_PYTHON_SYNTAX",
  "CELLFENCE_REQUIRED_RULE_DISABLED",
  "CELLFENCE_WAIVER_INVALID",
];

function writeStarterFile(rootDir: string, relativePath: string, contents: string): void {
  const absolutePath = path.join(rootDir, relativePath);
  if (fs.existsSync(absolutePath)) return;
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  fs.writeFileSync(absolutePath, contents);
}

function starterGovernance(include: string[]): InferredManifest["governance"] {
  return {
    requireOwnership: true,
    include,
    exclude: [],
    requiredRules: INIT_REQUIRED_RULES,
  };
}

function pythonServicePreset(rootDir: string): InferredManifest {
  writeStarterFile(rootDir, "src/domain/public.py", [
    "def calculate_total(items):",
    "    return sum(items)",
    "",
  ].join("\n"));
  writeStarterFile(rootDir, "src/infra/public.py", [
    "class Database:",
    "    def save_order(self, total):",
    "        return {\"total\": total}",
    "",
  ].join("\n"));
  writeStarterFile(rootDir, "src/api/public.py", [
    "def create_app():",
    "    return \"cellfence-python-service\"",
    "",
  ].join("\n"));
  writeStarterFile(rootDir, "src/api/routes.py", [
    "from src.domain.public import calculate_total",
    "from src.infra.public import Database",
    "",
    "def handle_checkout(items):",
    "    total = calculate_total(items)",
    "    return Database().save_order(total)",
    "",
  ].join("\n"));
  return {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    governance: starterGovernance(["src/**"]),
    cells: [
      {
        id: "api",
        ownedPaths: ["src/api/**"],
        publicEntry: "src/api/public.py",
        publicSymbols: ["create_app"],
        consumes: [{ cell: "domain" }, { cell: "infra" }],
        producesArtifacts: [],
      },
      {
        id: "domain",
        ownedPaths: ["src/domain/**"],
        publicEntry: "src/domain/public.py",
        publicSymbols: ["calculate_total"],
        consumes: [],
        producesArtifacts: [],
      },
      {
        id: "infra",
        ownedPaths: ["src/infra/**"],
        publicEntry: "src/infra/public.py",
        publicSymbols: ["Database"],
        consumes: [],
        producesArtifacts: [],
      },
    ],
  };
}

function polyglotMonorepoPreset(rootDir: string): InferredManifest {
  writeStarterFile(rootDir, "package.json", `${JSON.stringify({ private: true, workspaces: ["packages/*"] }, null, 2)}\n`);
  writeStarterFile(rootDir, "packages/shared/src/public.ts", [
    "export function formatMoney(cents: number): string {",
    "  return `$${(cents / 100).toFixed(2)}`;",
    "}",
    "",
  ].join("\n"));
  writeStarterFile(rootDir, "packages/web/src/public.ts", [
    "import { formatMoney } from \"../../shared/src/public\";",
    "",
    "export function renderPrice(cents: number): string {",
    "  return formatMoney(cents);",
    "}",
    "",
  ].join("\n"));
  writeStarterFile(rootDir, "services/api/src/public.py", [
    "def quote_total(cents):",
    "    return cents",
    "",
  ].join("\n"));
  return {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    governance: starterGovernance(["packages/**", "services/**"]),
    cells: [
      {
        id: "api",
        ownedPaths: ["services/api/src/**"],
        publicEntry: "services/api/src/public.py",
        publicSymbols: ["quote_total"],
        consumes: [],
        producesArtifacts: [],
      },
      {
        id: "shared",
        ownedPaths: ["packages/shared/src/**"],
        publicEntry: "packages/shared/src/public.ts",
        publicSymbols: ["formatMoney"],
        consumes: [],
        producesArtifacts: [],
      },
      {
        id: "web",
        ownedPaths: ["packages/web/src/**"],
        publicEntry: "packages/web/src/public.ts",
        publicSymbols: ["renderPrice"],
        consumes: [{ cell: "shared" }],
        producesArtifacts: [],
      },
    ],
  };
}

export function manifestFromPreset(rootDir: string, preset: string | undefined): InferredManifest | undefined {
  if (!preset) return undefined;
  if (!INIT_PRESETS.has(preset as InitPreset)) {
    throw new Error(`unknown CellFence init preset: ${preset}`);
  }
  return preset === "python-service" ? pythonServicePreset(rootDir) : polyglotMonorepoPreset(rootDir);
}
