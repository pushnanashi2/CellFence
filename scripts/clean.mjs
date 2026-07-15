import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const packagesDir = path.join(root, "packages");

for (const packageName of fs.readdirSync(packagesDir).sort()) {
  const packagePath = path.join(packagesDir, packageName);
  if (!fs.statSync(packagePath).isDirectory()) continue;
  fs.rmSync(path.join(packagePath, "dist"), { recursive: true, force: true });
}

for (const generatedDir of ["coverage", "reports", "tmp"]) {
  fs.rmSync(path.join(root, generatedDir), { recursive: true, force: true });
}
