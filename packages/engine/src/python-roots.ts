import fs from "node:fs";
import path from "node:path";

import { literalPrefix, normalizePath } from "./file-index.js";
import type { AnalysisContext } from "./types.js";

function parentPrefix(relativePath: string): string {
  const normalized = normalizePath(relativePath);
  const parent = path.dirname(normalized);
  return parent === "." ? "" : parent;
}

function addPythonRoot(roots: Set<string>, root: string | undefined): void {
  if (!root) return;
  const normalized = normalizePath(root).replace(/\/+$/, "");
  if (normalized === "." || normalized === "") roots.add("");
  else roots.add(normalized);
}

function pythonSourceRootsFromPyproject(rootDir: string): string[] {
  const pyprojectPath = path.join(rootDir, "pyproject.toml");
  if (!fs.existsSync(pyprojectPath)) return [];
  const text = fs.readFileSync(pyprojectPath, "utf8");
  const roots = new Set<string>();
  for (const match of text.matchAll(/(?:package-dir|package_dir)\s*=\s*\{[^}]*["']{0,1}["']{0,1}\s*=\s*["']([^"']+)["'][^}]*\}/g)) {
    addPythonRoot(roots, match[1]);
  }
  let section = "";
  for (const line of text.split(/\r?\n/)) {
    const sectionMatch = line.match(/^\s*\[([^\]]+)\]\s*$/);
    if (sectionMatch) {
      section = sectionMatch[1].trim();
      continue;
    }
    if (section === "tool.setuptools.package-dir") {
      const match = line.match(/^\s*["']?\s*["']?\s*=\s*["']([^"']+)["']/);
      if (match) addPythonRoot(roots, match[1]);
    }
  }
  for (const match of text.matchAll(/\bwhere\s*=\s*\[([^\]]+)\]/g)) {
    for (const rootMatch of match[1].matchAll(/["']([^"']+)["']/g)) addPythonRoot(roots, rootMatch[1]);
  }
  for (const match of text.matchAll(/\bfrom\s*=\s*["']([^"']+)["']/g)) {
    addPythonRoot(roots, match[1]);
  }
  return [...roots];
}

function pythonSourceRootsFromSetupCfg(rootDir: string): string[] {
  const setupCfgPath = path.join(rootDir, "setup.cfg");
  if (!fs.existsSync(setupCfgPath)) return [];
  const text = fs.readFileSync(setupCfgPath, "utf8");
  const roots = new Set<string>();
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    if (!/^\s*package_dir\s*=\s*$/.test(lines[index])) continue;
    for (let blockIndex = index + 1; blockIndex < lines.length; blockIndex += 1) {
      const line = lines[blockIndex];
      if (line.trim().length === 0) continue;
      if (/^\S/.test(line)) break;
      const match = line.match(/^\s*=\s*([^\s#]+)\s*$/);
      if (match) addPythonRoot(roots, match[1]);
    }
  }
  return [...roots];
}

function pythonSourceRootsFromSetupPy(rootDir: string): string[] {
  const setupPyPath = path.join(rootDir, "setup.py");
  if (!fs.existsSync(setupPyPath)) return [];
  const text = fs.readFileSync(setupPyPath, "utf8");
  const roots = new Set<string>();
  for (const match of text.matchAll(/\bpackage_dir\s*=\s*\{[\s\S]{0,1000}?["']\s*["']\s*:\s*["']([^"']+)["']/g)) {
    addPythonRoot(roots, match[1]);
  }
  for (const match of text.matchAll(/\bfind(?:_namespace)?_packages\s*\(\s*["']([^"']+)["']/g)) {
    addPythonRoot(roots, match[1]);
  }
  for (const match of text.matchAll(/\bfind(?:_namespace)?_packages\s*\([\s\S]{0,500}?\bwhere\s*=\s*["']([^"']+)["']/g)) {
    addPythonRoot(roots, match[1]);
  }
  return [...roots];
}

export function pythonSourceRoots(context: AnalysisContext): string[] {
  const roots = new Set<string>(["", "src"]);
  for (const root of pythonSourceRootsFromPyproject(context.rootDir)) addPythonRoot(roots, root);
  for (const root of pythonSourceRootsFromSetupCfg(context.rootDir)) addPythonRoot(roots, root);
  for (const root of pythonSourceRootsFromSetupPy(context.rootDir)) addPythonRoot(roots, root);
  for (const cell of context.manifest.cells) {
    if (path.extname(cell.publicEntry) === ".py") {
      const parent = parentPrefix(cell.publicEntry);
      const packageRoot = parentPrefix(parent);
      roots.add(packageRoot);
    }
    for (const pattern of cell.ownedPaths) {
      const prefix = literalPrefix(pattern);
      if (!prefix) continue;
      roots.add(parentPrefix(prefix));
    }
  }
  return [...roots].sort((left, right) => left.localeCompare(right));
}
