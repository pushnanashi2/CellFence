import { execFileSync } from "node:child_process";
import fs from "node:fs";

export type PythonImportReference = {
  specifier: string;
  line: number;
};

export type PythonInspection = {
  imports: PythonImportReference[];
  publicSymbols: string[];
  surfaceParts: string[];
};

type CachedPythonInspection = {
  mtimeMs: number;
  size: number;
  result: PythonInspection;
};

const inspectionCache = new Map<string, CachedPythonInspection>();

const PYTHON_INSPECTOR = String.raw`
import ast
import json
import sys
import tokenize

file_path = sys.argv[1]

with tokenize.open(file_path) as handle:
    source = handle.read()

tree = ast.parse(source, filename=file_path)

def node_line(node):
    return int(getattr(node, "lineno", 1) or 1)

def is_public(name):
    return bool(name) and not name.startswith("_")

def unparse(node):
    if node is None:
        return ""
    try:
        return ast.unparse(node)
    except Exception:
        return ""

def literal_string_collection(node):
    if not isinstance(node, (ast.List, ast.Tuple, ast.Set)):
        return None
    values = []
    for item in node.elts:
        if isinstance(item, ast.Constant) and isinstance(item.value, str):
            values.append(item.value)
        else:
            return None
    return values

def assignment_names(target):
    if isinstance(target, ast.Name):
        return [target.id]
    if isinstance(target, (ast.Tuple, ast.List)):
        names = []
        for item in target.elts:
            names.extend(assignment_names(item))
        return names
    return []

def alias_public_name(alias):
    if alias.name == "*":
        return None
    if alias.asname:
        return alias.asname
    return alias.name.split(".")[0]

def function_signature(args):
    positional_defaults = [None] * (len(args.posonlyargs) + len(args.args) - len(args.defaults)) + list(args.defaults)
    pieces = []
    for arg, default in zip(args.posonlyargs, positional_defaults[:len(args.posonlyargs)]):
        pieces.append(arg.arg + (("=" + unparse(default)) if default is not None else ""))
    if args.posonlyargs:
        pieces.append("/")
    offset = len(args.posonlyargs)
    for arg, default in zip(args.args, positional_defaults[offset:]):
        pieces.append(arg.arg + (("=" + unparse(default)) if default is not None else ""))
    if args.vararg is not None:
        pieces.append("*" + args.vararg.arg)
    elif args.kwonlyargs:
        pieces.append("*")
    for arg, default in zip(args.kwonlyargs, args.kw_defaults):
        pieces.append(arg.arg + (("=" + unparse(default)) if default is not None else ""))
    if args.kwarg is not None:
        pieces.append("**" + args.kwarg.arg)
    return ",".join(pieces)

imports = []
explicit_all = None
top_level_public = set()
surface_parts = []

for node in tree.body:
    if isinstance(node, ast.Import):
        for alias in node.names:
            imports.append({"specifier": alias.name, "line": node_line(node)})
            public_name = alias_public_name(alias)
            if is_public(public_name):
                top_level_public.add(public_name)
                surface_parts.append("py:import:" + public_name)
    elif isinstance(node, ast.ImportFrom):
        module = "." * int(node.level or 0) + (node.module or "")
        if node.module is None:
            for alias in node.names:
                if alias.name == "*":
                    continue
                imports.append({"specifier": module + alias.name, "line": node_line(node)})
        else:
            imports.append({"specifier": module, "line": node_line(node)})
        for alias in node.names:
            public_name = alias_public_name(alias)
            if is_public(public_name):
                top_level_public.add(public_name)
                surface_parts.append("py:import:" + public_name)
    elif isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
        if is_public(node.name):
            top_level_public.add(node.name)
            surface_parts.append("py:function:" + node.name + "(" + function_signature(node.args) + ")")
    elif isinstance(node, ast.ClassDef):
        if is_public(node.name):
            top_level_public.add(node.name)
            bases = ",".join([unparse(base) for base in node.bases])
            top_level_public.add(node.name)
            surface_parts.append("py:class:" + node.name + "(" + bases + ")")
    elif isinstance(node, ast.Assign):
        names = []
        for target in node.targets:
            names.extend(assignment_names(target))
        if "__all__" in names:
            explicit_all = literal_string_collection(node.value)
        for name in names:
            if name != "__all__" and is_public(name):
                top_level_public.add(name)
                surface_parts.append("py:variable:" + name + ":")
    elif isinstance(node, ast.AnnAssign):
        names = assignment_names(node.target)
        if "__all__" in names:
            explicit_all = literal_string_collection(node.value)
        for name in names:
            if name != "__all__" and is_public(name):
                top_level_public.add(name)
                surface_parts.append("py:variable:" + name + ":" + unparse(node.annotation))

if explicit_all is not None:
    public_symbols = sorted(set(explicit_all))
    surface_parts = ["py:__all__:" + ",".join(public_symbols)]
else:
    public_symbols = sorted(top_level_public)
    surface_parts = sorted(set(surface_parts))

print(json.dumps({
    "imports": imports,
    "publicSymbols": public_symbols,
    "surfaceParts": surface_parts,
}, separators=(",", ":")))
`;

export function inspectPythonSource(filePath: string): PythonInspection {
  const stat = fs.statSync(filePath);
  const cached = inspectionCache.get(filePath);
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached.result;

  try {
    const output = execFileSync("python3", ["-I", "-B", "-c", PYTHON_INSPECTOR, filePath], {
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const result = JSON.parse(output) as PythonInspection;
    inspectionCache.set(filePath, { mtimeMs: stat.mtimeMs, size: stat.size, result });
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Python source analysis failed for ${filePath}: ${message}`, { cause: error });
  }
}
