import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = process.cwd();
const workspacePackages = [
  "packages/schema",
  "packages/engine",
  "packages/cli",
  "packages/github-action",
  "packages/trace"
];

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd || root,
    encoding: "utf8",
    stdio: options.stdio || "pipe",
    env: { ...process.env, ...options.env }
  });
  if (result.error) throw result.error;
  if ((result.status ?? 1) !== 0) {
    const output = [result.stdout, result.stderr].filter(Boolean).join("\n");
    throw new Error(`${command} ${args.join(" ")} failed\n${output}`);
  }
  return result.stdout ? result.stdout.trim() : "";
}

function packageTarball(packageDir, tarballDir) {
  const before = new Set(fs.readdirSync(tarballDir));
  const packOutput = run("npm", ["pack", "--json", "--pack-destination", tarballDir], {
    cwd: path.join(root, packageDir)
  });
  const [packInfo] = JSON.parse(packOutput);
  if (!packInfo || !Array.isArray(packInfo.files)) {
    throw new Error(`npm pack did not return file metadata for ${packageDir}`);
  }
  const packedFiles = packInfo.files.map((file) => file.path).sort();
  const forbiddenFile = packedFiles.find((filePath) => filePath.endsWith(".tsbuildinfo") || filePath.endsWith(".js.map"));
  if (forbiddenFile) {
    throw new Error(`${packageDir} package includes forbidden generated metadata file ${forbiddenFile}`);
  }
  for (const requiredFile of ["LICENSE", "README.md", "package.json", "dist/index.js", "dist/index.d.ts"]) {
    if (!packedFiles.includes(requiredFile)) {
      throw new Error(`${packageDir} package is missing ${requiredFile}`);
    }
  }
  const created = fs
    .readdirSync(tarballDir)
    .filter((entry) => entry.endsWith(".tgz") && !before.has(entry));
  if (created.length !== 1) throw new Error(`expected one tarball for ${packageDir}, found ${created.length}`);
  return path.join(tarballDir, created[0]);
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-pack-"));
try {
  const tarballDir = path.join(tempRoot, "tarballs");
  const consumerDir = path.join(tempRoot, "consumer");
  fs.mkdirSync(tarballDir, { recursive: true });
  fs.mkdirSync(consumerDir, { recursive: true });

  run("npm", ["run", "build"], { stdio: "inherit" });
  const tarballs = workspacePackages.map((packageDir) => packageTarball(packageDir, tarballDir));

  writeJson(path.join(consumerDir, "package.json"), {
    private: true,
    type: "module",
    devDependencies: {}
  });
  run("npm", ["install", "--save-dev", ...tarballs], { cwd: consumerDir, stdio: "inherit" });

  fs.mkdirSync(path.join(consumerDir, "src/core"), { recursive: true });
  fs.writeFileSync(path.join(consumerDir, "src/core/public.ts"), "export const coreValue = 'core';\n");
  writeJson(path.join(consumerDir, "cellfence.manifest.json"), {
    schemaVersion: "cellfence.manifest.v1",
    cells: [
      {
        id: "core",
        ownedPaths: ["src/core/**"],
        publicEntry: "src/core/public.ts",
        publicSymbols: ["coreValue"],
        consumes: [],
        producesArtifacts: []
      }
    ]
  });

  const binName = process.platform === "win32" ? "cellfence.cmd" : "cellfence";
  const binPath = path.join(consumerDir, "node_modules", ".bin", binName);
  run(binPath, ["check", "--manifest", "cellfence.manifest.json"], {
    cwd: consumerDir,
    stdio: "inherit"
  });

  console.log(`pack smoke passed using ${tarballs.length} local tarballs`);
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true });
}
