import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
for (const packageName of ["schema", "engine", "cli", "github-action"]) {
  fs.rmSync(path.join(root, "packages", packageName, "dist"), { recursive: true, force: true });
}
