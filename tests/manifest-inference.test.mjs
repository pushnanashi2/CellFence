import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { checkRepository, inferManifest } from "../packages/engine/dist/index.js";

const defaultRequiredRules = [
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

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function writeText(filePath, text) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, text);
}

function writeManifest(rootDir, manifest) {
  writeJson(path.join(rootDir, "cellfence.manifest.json"), manifest);
}

test("manifest inference discovers src cells, workspace cells, public entries, aliases, and consumers", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-manifest-infer-main-"));
  try {
    writeJson(path.join(rootDir, "package.json"), { workspaces: ["packages/*"] });
    writeJson(path.join(rootDir, "tsconfig.json"), {
      compilerOptions: {
        baseUrl: ".",
        paths: {
          "@parser/*": ["src/parser/*"],
        },
      },
    });
    writeJson(path.join(rootDir, "packages/worker/package.json"), { name: "@demo/worker" });
    writeText(path.join(rootDir, "src/parser/public.ts"), "export function parse(value: string): string { return value; }\n");
    writeText(path.join(rootDir, "src/reporting/index.ts"), "import 'node:fs';\nimport { parse } from '@parser/public.js';\nexport const report = parse('ok');\n");
    writeText(path.join(rootDir, "packages/worker/src/index.ts"), "import { parse } from '../../../src/parser/public.js';\nexport const run = () => parse('job');\n");

    const manifest = inferManifest({ rootDir });
    assert.deepEqual(manifest.governance, {
      requireOwnership: true,
      include: ["packages/worker/src/**", "src/**"],
      exclude: [],
      requiredRules: defaultRequiredRules,
    });
    assert.deepEqual(manifest.cells.map((cell) => [cell.id, cell.publicEntry, cell.publicSymbols, cell.consumes]), [
      ["parser", "src/parser/public.ts", ["parse"], []],
      ["reporting", "src/reporting/index.ts", ["report"], [{ cell: "parser" }]],
      ["worker", "packages/worker/src/index.ts", ["run"], [{ cell: "parser" }]],
    ]);
    writeManifest(rootDir, manifest);
    assert.equal(checkRepository({ rootDir }).ok, true);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("manifest inference handles object workspaces, broad wildcards, duplicates, and root source fallback", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-manifest-infer-workspaces-"));
  try {
    writeJson(path.join(rootDir, "package.json"), {
      workspaces: {
        packages: ["*", "libs/core", "packages/*", "packages/dup-a", "missing", "missing/*"],
      },
    });
    writeJson(path.join(rootDir, "loose/package.json"), { name: "/" });
    writeJson(path.join(rootDir, "libs/core/package.json"), { name: "" });
    writeJson(path.join(rootDir, "packages/dup-a/package.json"), { name: "@demo/dup" });
    writeJson(path.join(rootDir, "packages/dup-b/package.json"), { name: "@demo/dup" });
    writeText(path.join(rootDir, "src/helper.ts"), "export const helper = true;\n");
    writeText(path.join(rootDir, "loose/src/index.ts"), "export const loose = true;\n");
    writeText(path.join(rootDir, "libs/core/src/custom.ts"), "export const core = true;\n");
    writeText(path.join(rootDir, "packages/dup-a/src/index.ts"), "export const first = true;\n");
    writeText(path.join(rootDir, "packages/dup-b/src/index.ts"), "export const second = true;\n");

    const manifest = inferManifest({ rootDir });
    assert.deepEqual(manifest.cells.map((cell) => [cell.id, cell.ownedPaths[0], cell.publicEntry, cell.packageName]), [
      ["cell", "loose/src/**", "loose/src/index.ts", "/"],
      ["core", "libs/core/src/**", "libs/core/src/custom.ts", undefined],
      ["dup", "packages/dup-a/src/**", "packages/dup-a/src/index.ts", undefined],
      ["dup-2", "packages/dup-b/src/**", "packages/dup-b/src/index.ts", undefined],
      ["src-root", "src/*", "src/helper.ts", undefined],
    ]);
    writeManifest(rootDir, manifest);
    assert.equal(checkRepository({ rootDir }).ok, true);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("manifest inference normalizes ids, filters workspace noise, prioritizes public entries, and ignores self imports", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-manifest-infer-priority-"));
  try {
    writeJson(path.join(rootDir, "package.json"), {
      workspaces: ["libs/*", 42, false],
    });
    writeJson(path.join(rootDir, "libs/mixed/package.json"), { name: "@Scope/FooBar--" });
    writeJson(path.join(rootDir, "libs/blank/package.json"), { name: "   " });
    writeJson(path.join(rootDir, "libs/number-name/package.json"), { name: 7 });
    writeText(path.join(rootDir, "src/helper.ts"), "export const helper = true;\n");
    writeText(path.join(rootDir, "src/public.mts"), "export const publicRoot = true;\n");
    writeText(path.join(rootDir, "libs/mixed/src/a.ts"), "export const fallbackOnly = true;\n");
    writeText(path.join(rootDir, "libs/mixed/src/index.ts"), "export const indexSymbol = true;\n");
    writeText(path.join(rootDir, "libs/mixed/src/internal.ts"), "export const internal = true;\n");
    writeText(path.join(rootDir, "libs/mixed/src/public.ts"), "import { internal } from './internal.js';\nexport const publicSymbol = internal;\nexport const alpha = true;\n");
    writeText(path.join(rootDir, "libs/blank/src/index.ts"), "import 'node:fs';\nexport const blank = true;\n");
    writeText(path.join(rootDir, "libs/number-name/src/index.ts"), "export const numbered = true;\n");

    const manifest = inferManifest({ rootDir });
    assert.deepEqual(manifest.cells.map((cell) => [cell.id, cell.publicEntry, cell.publicSymbols, cell.consumes]), [
      ["blank", "libs/blank/src/index.ts", ["blank"], []],
      ["foo-bar", "libs/mixed/src/public.ts", ["alpha", "publicSymbol"], []],
      ["number-name", "libs/number-name/src/index.ts", ["numbered"], []],
      ["src-root", "src/public.mts", ["publicRoot"], []],
    ]);
    writeManifest(rootDir, manifest);
    assert.equal(checkRepository({ rootDir }).ok, true);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("manifest inference uses package entry metadata and workspace dependency contracts", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-manifest-infer-package-metadata-"));
  try {
    writeJson(path.join(rootDir, "package.json"), { workspaces: ["packages/*"] });
    writeJson(path.join(rootDir, "packages/core/package.json"), {
      name: "@demo/core",
      exports: {
        ".": {
          import: "./dist/index.js",
          types: "./src/public.ts",
        },
      },
    });
    writeJson(path.join(rootDir, "packages/dom/package.json"), {
      name: "@demo/dom",
      source: "./src/entry.ts",
      dependencies: {
        "@demo/core": "workspace:^",
      },
    });
    writeText(path.join(rootDir, "packages/core/src/index.ts"), "export const internal = true;\n");
    writeText(path.join(rootDir, "packages/core/src/public.ts"), "export const core = true;\n");
    writeText(path.join(rootDir, "packages/dom/src/entry.ts"), "export const dom = true;\n");

    const manifest = inferManifest({ rootDir });

    assert.deepEqual(manifest.cells.map((cell) => [cell.id, cell.publicEntry, cell.packageName, cell.consumes]), [
      ["core", "packages/core/src/public.ts", "@demo/core", []],
      ["dom", "packages/dom/src/entry.ts", "@demo/dom", [{ cell: "core" }]],
    ]);
    writeManifest(rootDir, manifest);
    assert.equal(checkRepository({ rootDir }).ok, true);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("manifest inference reads pnpm workspace packages and scoped workspace roots", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-manifest-infer-pnpm-"));
  try {
    writeJson(path.join(rootDir, "package.json"), { private: true });
    writeText(path.join(rootDir, "pnpm-workspace.yaml"), [
      "packages:",
      "  - 'packages/*'",
      "  - 'packages/@scope/*'",
      "  - '!packages/ignored'",
      "",
    ].join("\n"));
    writeJson(path.join(rootDir, "packages/core/package.json"), {
      name: "@demo/core",
    });
    writeJson(path.join(rootDir, "packages/@scope/web/package.json"), {
      name: "@demo/web",
      dependencies: {
        "@demo/core": "workspace:*",
      },
    });
    writeText(path.join(rootDir, "packages/core/src/index.ts"), "export const core = true;\n");
    writeText(path.join(rootDir, "packages/@scope/web/src/index.ts"), "export const web = true;\n");

    const manifest = inferManifest({ rootDir });

    assert.deepEqual(manifest.cells.map((cell) => [cell.id, cell.ownedPaths[0], cell.packageName, cell.consumes]), [
      ["core", "packages/core/src/**", "@demo/core", []],
      ["web", "packages/@scope/web/src/**", "@demo/web", [{ cell: "core" }]],
    ]);
    writeManifest(rootDir, manifest);
    assert.equal(checkRepository({ rootDir }).ok, true);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("manifest inference uses pyproject src layouts and Python absolute imports", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-manifest-infer-python-src-"));
  try {
    writeText(path.join(rootDir, "pyproject.toml"), [
      "[project]",
      "name = \"billing-service\"",
      "",
      "[tool.setuptools.packages.find]",
      "where = [\"src\"]",
      "",
    ].join("\n"));
    writeText(path.join(rootDir, "src/billing_service/__init__.py"), "__all__ = ['charge']\nfrom .public import charge\n");
    writeText(path.join(rootDir, "src/billing_service/public.py"), "def charge(value: int) -> int:\n    return value\n");
    writeText(path.join(rootDir, "src/api/routes.py"), "from billing_service.public import charge\n\ndef route() -> int:\n    return charge(1)\n");

    const manifest = inferManifest({ rootDir });

    assert.deepEqual(manifest.governance.include, ["src/**"]);
    assert.deepEqual(manifest.cells.map((cell) => [cell.id, cell.ownedPaths, cell.publicEntry, cell.packageName, cell.consumes]), [
      ["api", ["src/api/**"], "src/api/routes.py", undefined, [{ cell: "billing-service" }]],
      ["billing-service", ["src/billing_service/**"], "src/billing_service/public.py", "billing-service", []],
    ]);
    writeManifest(rootDir, manifest);
    assert.equal(checkRepository({ rootDir }).ok, true);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("manifest inference uses setup.cfg names for flat Python packages", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-manifest-infer-python-flat-"));
  try {
    writeText(path.join(rootDir, "setup.cfg"), [
      "[metadata]",
      "name = ledger-service",
      "",
      "[options]",
      "packages = find:",
      "",
    ].join("\n"));
    writeText(path.join(rootDir, "ledger_service/__init__.py"), "__all__ = ['run']\nfrom .core import run\n");
    writeText(path.join(rootDir, "ledger_service/core.py"), "def run() -> bool:\n    return True\n");

    const manifest = inferManifest({ rootDir, scope: "production" });

    assert.deepEqual(manifest.governance.include, ["ledger_service/**"]);
    assert.deepEqual(manifest.cells.map((cell) => [cell.id, cell.ownedPaths, cell.publicEntry, cell.publicSymbols, cell.packageName]), [
      ["ledger-service", ["ledger_service/**"], "ledger_service/__init__.py", ["run"], "ledger-service"],
    ]);
    writeManifest(rootDir, manifest);
    assert.equal(checkRepository({ rootDir }).ok, true);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("manifest inference uses setup.py names without executing setup code", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-manifest-infer-python-setuppy-"));
  try {
    writeText(path.join(rootDir, "setup.py"), [
      "from setuptools import find_packages, setup",
      "NAME = 'queue-worker'",
      "setup(name=NAME, package_dir={'': 'src'}, packages=find_packages(where='src'))",
      "",
    ].join("\n"));
    writeText(path.join(rootDir, "src/queue_worker/__init__.py"), "__all__ = ['run']\nfrom .main import run\n");
    writeText(path.join(rootDir, "src/queue_worker/main.py"), "def run() -> str:\n    return 'ok'\n");
    writeText(path.join(rootDir, "src/api/routes.py"), "from queue_worker import run\n\ndef route() -> str:\n    return run()\n");

    const manifest = inferManifest({ rootDir, scope: "production" });

    assert.deepEqual(manifest.cells.map((cell) => [cell.id, cell.ownedPaths, cell.publicEntry, cell.publicSymbols, cell.packageName, cell.consumes]), [
      ["api", ["src/api/**"], "src/api/routes.py", ["route", "run"], undefined, [{ cell: "queue-worker" }]],
      ["queue-worker", ["src/queue_worker/**"], "src/queue_worker/__init__.py", ["run"], "queue-worker", []],
    ]);
    writeManifest(rootDir, manifest);
    assert.equal(checkRepository({ rootDir }).ok, true);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("manifest inference can ablate package policy hints for oracle studies", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-manifest-infer-blind-policy-"));
  try {
    writeJson(path.join(rootDir, "package.json"), { workspaces: ["packages/*"] });
    writeJson(path.join(rootDir, "packages/core/package.json"), {
      name: "@demo/core",
      exports: {
        ".": {
          types: "./src/entry.ts",
        },
      },
    });
    writeJson(path.join(rootDir, "packages/web/package.json"), {
      name: "@demo/web",
      dependencies: {
        "@demo/core": "workspace:*",
      },
    });
    writeText(path.join(rootDir, "packages/core/src/index.ts"), "export const internal = true;\n");
    writeText(path.join(rootDir, "packages/core/src/entry.ts"), "export const core = true;\n");
    writeText(path.join(rootDir, "packages/web/src/index.ts"), "export const web = true;\n");

    const hinted = inferManifest({ rootDir });
    const blind = inferManifest({ rootDir, packagePolicyHints: "ignore" });

    assert.deepEqual(hinted.cells.map((cell) => [cell.id, cell.publicEntry, cell.consumes]), [
      ["core", "packages/core/src/entry.ts", []],
      ["web", "packages/web/src/index.ts", [{ cell: "core" }]],
    ]);
    assert.deepEqual(blind.cells.map((cell) => [cell.id, cell.publicEntry, cell.consumes]), [
      ["core", "packages/core/src/index.ts", []],
      ["web", "packages/web/src/index.ts", []],
    ]);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("manifest inference discovers common app source roots without src fallback", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-manifest-infer-app-roots-"));
  try {
    writeJson(path.join(rootDir, "package.json"), {
      exports: {
        ".": "./app/page.tsx",
      },
    });
    writeText(path.join(rootDir, "app/page.tsx"), "import { Button } from '../components/button.js';\nexport const Page = Button;\n");
    writeText(path.join(rootDir, "components/button.tsx"), "export const Button = 'ok';\n");
    writeText(path.join(rootDir, "lib/client.ts"), "export const client = true;\n");

    const manifest = inferManifest({ rootDir, scope: "production" });

    assert.deepEqual(manifest.governance.include, ["app/**", "components/**", "lib/**"]);
    assert.deepEqual(manifest.cells.map((cell) => [cell.id, cell.ownedPaths, cell.publicEntry, cell.consumes]), [
      ["app", ["app/**"], "app/page.tsx", [{ cell: "components" }]],
      ["components", ["components/**"], "components/button.tsx", []],
      ["lib", ["lib/**"], "lib/client.ts", []],
    ]);
    writeManifest(rootDir, manifest);
    assert.equal(checkRepository({ rootDir }).ok, true);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("manifest inference narrows parent candidates around nested package source roots", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-manifest-infer-nested-packages-"));
  try {
    writeJson(path.join(rootDir, "package.json"), { workspaces: ["src/*"] });
    writeJson(path.join(rootDir, "src/cli/package.json"), {
      name: "@demo/cli",
      bin: {
        demo: "./bin/demo.js",
      },
    });
    writeJson(path.join(rootDir, "src/web/package.json"), { name: "@demo/web" });
    writeJson(path.join(rootDir, "packages/@scope/tool/package.json"), { name: "@scope/tool" });
    writeText(path.join(rootDir, "src/cli/src/index.ts"), "export const cli = true;\n");
    writeText(path.join(rootDir, "src/cli/bin/demo.ts"), "export const demo = true;\n");
    writeText(path.join(rootDir, "src/web/src/index.ts"), "export const web = true;\n");
    writeText(path.join(rootDir, "packages/@scope/tool/src/index.ts"), "export const tool = true;\n");

    const manifest = inferManifest({ rootDir, scope: "production" });

    assert.deepEqual(manifest.cells.map((cell) => [cell.id, cell.ownedPaths, cell.publicEntry]), [
      ["cli", ["src/cli/src/**"], "src/cli/src/index.ts"],
      ["cli-2", ["src/cli/bin/**"], "src/cli/bin/demo.ts"],
      ["tool", ["packages/@scope/tool/src/**"], "packages/@scope/tool/src/index.ts"],
      ["web", ["src/web/src/**"], "src/web/src/index.ts"],
    ]);
    writeManifest(rootDir, manifest);
    assert.equal(checkRepository({ rootDir }).ok, true);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("manifest inference production scope excludes test, generated, and asset import noise", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-manifest-infer-production-scope-"));
  try {
    writeJson(path.join(rootDir, "package.json"), {
      exports: "./src/index.ts",
    });
    writeText(path.join(rootDir, "src/index.ts"), "export const root = true;\n");
    writeText(path.join(rootDir, "src/feature/public.ts"), "export const feature = true;\n");
    writeText(path.join(rootDir, "src/feature/use.ts"), "import logo from '../assets/logo.svg';\nexport const use = logo;\n");
    writeText(path.join(rootDir, "src/feature/use.test.ts"), "const name = './fixture';\nawait import(name);\n");
    writeText(path.join(rootDir, "src/generated/client.ts"), "import { feature } from '../feature/public.js';\nexport const generated = feature;\n");
    writeText(path.join(rootDir, "src/assets/logo.svg"), "<svg></svg>\n");

    const manifest = inferManifest({ rootDir, scope: "production" });

    assert.ok(manifest.governance.exclude.includes("**/*.svg"));
    assert.ok(manifest.governance.exclude.includes("**/*.test.*"));
    assert.ok(manifest.governance.exclude.includes("**/generated/**"));
    assert.deepEqual(manifest.cells.map((cell) => [cell.id, cell.ownedPaths, cell.publicEntry, cell.consumes]), [
      ["feature", ["src/feature/**"], "src/feature/public.ts", []],
      ["src-root", ["src/*"], "src/index.ts", []],
    ]);
    writeManifest(rootDir, manifest);
    assert.equal(checkRepository({ rootDir }).ok, true);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("manifest inference keeps unsupported Python syntax as check evidence instead of failing init", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-manifest-infer-python-syntax-"));
  try {
    fs.mkdirSync(path.join(rootDir, "src/service"), { recursive: true });
    writeText(path.join(rootDir, "src/service/__init__.py"), "def get_{{ cookiecutter.name }}():\n    return True\n");

    const manifest = inferManifest({ rootDir, scope: "production" });

    assert.deepEqual(manifest.governance, {
      requireOwnership: true,
      include: ["src/**"],
      exclude: manifest.governance.exclude,
      requiredRules: defaultRequiredRules,
    });
    assert.deepEqual(manifest.cells.map((cell) => [cell.id, cell.publicEntry, cell.publicSymbols]), [
      ["service", "src/service/__init__.py", []],
    ]);
    writeManifest(rootDir, manifest);
    const result = checkRepository({ rootDir });
    assert.equal(result.exitCode, 1);
    assert.ok(result.findings.some((finding) => finding.ruleId === "CELLFENCE_UNSUPPORTED_PYTHON_SYNTAX"));
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("manifest inference falls back to the example manifest for empty or malformed repositories", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-manifest-infer-empty-"));
  const previousCwd = process.cwd();
  try {
    fs.writeFileSync(path.join(rootDir, "package.json"), "{");
    process.chdir(rootDir);
    const manifest = inferManifest();
    assert.deepEqual(manifest, {
      schemaVersion: "cellfence.manifest.v1",
      governance: {
        requireOwnership: true,
        include: ["src/**"],
        exclude: [],
        requiredRules: defaultRequiredRules,
      },
      cells: [
        {
          id: "example",
          ownedPaths: ["src/example/**"],
          publicEntry: "src/example/public.ts",
          publicSymbols: ["example"],
          consumes: [],
          producesArtifacts: [],
        },
      ],
    });
  } finally {
    process.chdir(previousCwd);
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});
