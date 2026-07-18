import { execFileSync } from "node:child_process";
import fs from "node:fs";

export type PythonImportReference = {
  specifier: string;
  candidateSpecifiers?: string[];
  line: number;
};

export type PythonInspectionWarning = {
  kind: "dynamic_import";
  message: string;
  line?: number;
};

export type PythonInspection = {
  imports: PythonImportReference[];
  publicSymbols: string[];
  surfaceParts: string[];
  resources: PythonResourceAccess[];
  errors?: PythonInspectionError[];
  warnings?: PythonInspectionWarning[];
};

export type PythonInspectionError = {
  kind: "syntax_error" | "read_error" | "inspector_error";
  message: string;
  line?: number;
  offset?: number;
};

export type PythonResourceAccess = {
  kind: "file" | "database" | "queue" | "http";
  access: "read" | "write" | "publish" | "subscribe" | "call" | "serve";
  selector: string;
  line: number;
  source: string;
  detectedBy: string;
  confidence: "high" | "medium" | "low" | "runtime";
  unresolved?: boolean;
  reason?: string;
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
import re
import sys
import tokenize

file_path = sys.argv[1]

def emit_error(kind, message, line=None, offset=None):
    print(json.dumps({
        "imports": [],
        "publicSymbols": [],
        "surfaceParts": [],
        "resources": [],
        "errors": [{
            "kind": kind,
            "message": str(message),
            "line": line,
            "offset": offset,
        }],
    }, separators=(",", ":")))
    sys.exit(0)

try:
    with tokenize.open(file_path) as handle:
        source = handle.read()
except Exception as exc:
    emit_error("read_error", f"{type(exc).__name__}: {exc}")

try:
    tree = ast.parse(source, filename=file_path)
except SyntaxError as exc:
    emit_error("syntax_error", exc.msg or str(exc), exc.lineno, exc.offset)

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

def literal_string(node):
    if isinstance(node, ast.Constant) and isinstance(node.value, str):
        return node.value
    return None

string_constants = {}
string_list_constants = {}

def static_string(node):
    value = literal_string(node)
    if value is not None:
        return value
    if isinstance(node, ast.Name):
        return string_constants.get(node.id)
    return None

def literal_string_list(node):
    if isinstance(node, ast.Name) and node.id in string_list_constants:
        return string_list_constants.get(node.id) or []
    if isinstance(node, (ast.List, ast.Tuple, ast.Set)):
        values = []
        for item in node.elts:
            value = static_string(item)
            if value is None:
                return []
            values.append(value)
        return values
    value = static_string(node)
    return [value] if value is not None else []

def dotted_name(node):
    if isinstance(node, ast.Name):
        return node.id
    if isinstance(node, ast.Attribute):
        base = dotted_name(node.value)
        return (base + "." if base else "") + node.attr
    if isinstance(node, ast.Call):
        return dotted_name(node.func)
    return None

def root_name(node):
    if isinstance(node, ast.Name):
        return node.id
    if isinstance(node, ast.Attribute):
        return root_name(node.value)
    if isinstance(node, ast.Call):
        return root_name(node.func)
    return None

def keyword_literal(call, name):
    for keyword in getattr(call, "keywords", []):
        if keyword.arg == name:
            return static_string(keyword.value)
    return None

def keyword_literal_list(call, name):
    for keyword in getattr(call, "keywords", []):
        if keyword.arg == name:
            return literal_string_list(keyword.value)
    return []

def normalize_http_path(prefix, route):
    segments = []
    for segment in [prefix or "", route or ""]:
        segment = segment.strip()
        if segment:
            segments.append(segment.strip("/"))
    normalized = "/" + "/".join([segment for segment in segments if segment])
    normalized = re.sub(r"/+", "/", normalized)
    return normalized if normalized != "" else "/"

def sql_table_accesses(text):
    accesses = []
    for match in re.finditer(r"\b(delete\s+from|from|join|into|update)\s+([A-Za-z_][A-Za-z0-9_.$\"]*)", text, re.IGNORECASE):
        verb = match.group(1).lower()
        selector = match.group(2).replace('"', "")
        accesses.append({
            "access": "write" if verb in ("into", "update", "delete from") else "read",
            "selector": selector,
        })
    return accesses

resources = []
resource_keys = set()

def emit_resource(kind, access, selector, node, source, detected_by, confidence="high", unresolved=False, reason=None):
    if selector is None or selector == "":
        return
    line = node_line(node)
    key = (kind, access, selector, line, source, detected_by, confidence, bool(unresolved), reason or "")
    if key in resource_keys:
        return
    resource_keys.add(key)
    entry = {
        "kind": kind,
        "access": access,
        "selector": selector,
        "line": line,
        "source": source,
        "detectedBy": detected_by,
        "confidence": confidence,
    }
    if unresolved:
        entry["unresolved"] = True
    if reason:
        entry["reason"] = reason
    resources.append(entry)

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
import_keys = set()
warnings = []
explicit_all = None
top_level_public = set()
surface_parts = []

def add_import(specifier, line, candidate_specifiers=None):
    candidate_specifiers = [item for item in (candidate_specifiers or []) if item and item != specifier]
    key = (specifier, tuple(candidate_specifiers), line)
    if key in import_keys:
        return
    import_keys.add(key)
    entry = {"specifier": specifier, "line": line}
    if candidate_specifiers:
        entry["candidateSpecifiers"] = candidate_specifiers
    imports.append(entry)

def add_dynamic_import_warning(node, source):
    warnings.append({
        "kind": "dynamic_import",
        "message": f"computed Python {source} cannot be resolved statically at line {node_line(node)}",
        "line": node_line(node),
    })

def from_import_candidate(module, alias_name):
    if alias_name == "*":
        return None
    if module == "":
        return alias_name
    if module.endswith("."):
        return module + alias_name
    return module + "." + alias_name

for node in tree.body:
    if isinstance(node, ast.Import):
        for alias in node.names:
            add_import(alias.name, node_line(node))
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
                add_import(module + alias.name, node_line(node))
        else:
            saw_star = False
            for alias in node.names:
                if alias.name == "*":
                    saw_star = True
                    continue
                candidate = from_import_candidate(module, alias.name)
                add_import(module, node_line(node), [candidate] if candidate else [])
            if saw_star:
                add_import(module, node_line(node))
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
        string_value = literal_string(node.value)
        if string_value is not None:
            for name in names:
                string_constants[name] = string_value
        string_list_value = literal_string_collection(node.value)
        if string_list_value is not None:
            for name in names:
                string_list_constants[name] = string_list_value
        for name in names:
            if name != "__all__" and is_public(name):
                top_level_public.add(name)
                surface_parts.append("py:variable:" + name + ":")
    elif isinstance(node, ast.AnnAssign):
        names = assignment_names(node.target)
        if "__all__" in names:
            explicit_all = literal_string_collection(node.value)
        string_value = literal_string(node.value)
        if string_value is not None:
            for name in names:
                string_constants[name] = string_value
        string_list_value = literal_string_collection(node.value)
        if string_list_value is not None:
            for name in names:
                string_list_constants[name] = string_list_value
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

fastapi_app_factories = set()
fastapi_router_factories = set()
fastapi_route_prefixes = {}
django_url_functions = set()
django_model_base_names = set()
django_model_selectors = {}
django_manager_aliases = {}
django_model_instances = {}
sqlalchemy_table_factories = set()
sqlalchemy_read_functions = set()
sqlalchemy_write_functions = set()
sqlalchemy_sql_literal_functions = set()
sqlalchemy_model_selectors = {}
sqlalchemy_table_selectors = {}
celery_factories = set()
celery_task_decorators = set()
celery_signature_functions = set()
celery_app_names = set()
celery_task_symbols = {}
importlib_module_names = set()
pkgutil_module_names = set()
builtins_module_names = set()
dynamic_import_functions = set(["__import__"])
pkgutil_resolver_functions = set()

def imported_local_name(alias):
    return alias.asname or alias.name.split(".")[0]

for node in tree.body:
    if isinstance(node, ast.Import):
        for alias in node.names:
            local_name = imported_local_name(alias)
            if alias.name == "django.urls":
                django_url_functions.update([local_name + ".path", local_name + ".re_path", local_name + ".url"])
            if alias.name == "importlib":
                importlib_module_names.add(local_name)
            if alias.name == "pkgutil":
                pkgutil_module_names.add(local_name)
            if alias.name == "builtins":
                builtins_module_names.add(local_name)
    elif isinstance(node, ast.ImportFrom):
        module = node.module or ""
        for alias in node.names:
            local_name = alias.asname or alias.name
            if module == "importlib" and alias.name == "import_module":
                dynamic_import_functions.add(local_name)
            if module == "pkgutil" and alias.name == "resolve_name":
                pkgutil_resolver_functions.add(local_name)
            if module == "builtins" and alias.name == "__import__":
                dynamic_import_functions.add(local_name)
            if module == "django.urls" and alias.name in ("path", "re_path", "url"):
                django_url_functions.add(local_name)
            if module == "django.conf.urls" and alias.name == "url":
                django_url_functions.add(local_name)
            if module in ("django.db.models", "django.db") and alias.name == "Model":
                django_model_base_names.add(local_name)
            if module == "fastapi" and alias.name == "FastAPI":
                fastapi_app_factories.add(local_name)
            if module == "fastapi" and alias.name == "APIRouter":
                fastapi_router_factories.add(local_name)
            if module == "sqlalchemy" and alias.name == "Table":
                sqlalchemy_table_factories.add(local_name)
            if module == "sqlalchemy" and alias.name in ("select",):
                sqlalchemy_read_functions.add(local_name)
            if module == "sqlalchemy" and alias.name in ("insert", "update", "delete"):
                sqlalchemy_write_functions.add(local_name)
            if module == "sqlalchemy" and alias.name == "text":
                sqlalchemy_sql_literal_functions.add(local_name)
            if module == "celery" and alias.name == "Celery":
                celery_factories.add(local_name)
            if module == "celery" and alias.name == "shared_task":
                celery_task_decorators.add(local_name)
            if module == "celery" and alias.name in ("signature", "Signature"):
                celery_signature_functions.add(local_name)

def class_string_assignment(class_node, assignment_name):
    for item in class_node.body:
        if isinstance(item, ast.Assign):
            for target in item.targets:
                if isinstance(target, ast.Name) and target.id == assignment_name:
                    value = static_string(item.value)
                    if value is not None:
                        return value
        if isinstance(item, ast.AnnAssign) and isinstance(item.target, ast.Name) and item.target.id == assignment_name:
            value = static_string(item.value)
            if value is not None:
                return value
    return None

def django_meta_db_table(class_node):
    for item in class_node.body:
        if isinstance(item, ast.ClassDef) and item.name == "Meta":
            value = class_string_assignment(item, "db_table")
            if value is not None:
                return value
    return None

def has_django_model_base(class_node):
    for base in class_node.bases:
        name = dotted_name(base) or ""
        if name in django_model_base_names or name.endswith(".Model") or name.endswith(".models.Model"):
            return True
    return False

def selector_entry(selector_map, name):
    entry = selector_map.get(name)
    if entry is None:
        return None
    return entry

def selector_from_expression(node):
    if isinstance(node, ast.Name):
        entry = selector_entry(sqlalchemy_model_selectors, node.id) or selector_entry(sqlalchemy_table_selectors, node.id)
        if entry is not None:
            return entry
    if isinstance(node, ast.Attribute):
        return selector_from_expression(node.value)
    if isinstance(node, ast.Call):
        return selector_from_expression(node.func)
    return None

def django_manager_model(node):
    if isinstance(node, ast.Name):
        return django_manager_aliases.get(node.id) or django_model_instances.get(node.id)
    if isinstance(node, ast.Attribute):
        if node.attr in ("objects", "_default_manager") and isinstance(node.value, ast.Name):
            return node.value.id
        return django_manager_model(node.value)
    if isinstance(node, ast.Call):
        return django_manager_model(node.func)
    return None

for node in ast.walk(tree):
    if isinstance(node, (ast.Assign, ast.AnnAssign)):
        value = node.value
        targets = node.targets if isinstance(node, ast.Assign) else [node.target]
        for target in targets:
            if not isinstance(target, ast.Name):
                continue
            manager_model = django_manager_model(value)
            if manager_model:
                django_manager_aliases[target.id] = manager_model
            if isinstance(value, ast.Call):
                if isinstance(value.func, ast.Name) and value.func.id in django_model_selectors:
                    django_model_instances[target.id] = value.func.id
            if isinstance(value, ast.Attribute):
                value_receiver = dotted_name(value.value)
                if value.attr == "import_module" and value_receiver in importlib_module_names:
                    dynamic_import_functions.add(target.id)
                elif value.attr == "__import__" and value_receiver in builtins_module_names:
                    dynamic_import_functions.add(target.id)
                elif value.attr == "resolve_name" and value_receiver in pkgutil_module_names:
                    pkgutil_resolver_functions.add(target.id)
            if not isinstance(value, ast.Call):
                continue
            call_name = dotted_name(value.func) or ""
            if call_name in fastapi_app_factories or call_name.endswith(".FastAPI"):
                fastapi_route_prefixes[target.id] = ""
            elif call_name in fastapi_router_factories or call_name.endswith(".APIRouter"):
                fastapi_route_prefixes[target.id] = keyword_literal(value, "prefix") or ""
            elif call_name in celery_factories or call_name.endswith(".Celery"):
                celery_app_names.add(target.id)
            elif call_name in sqlalchemy_table_factories or call_name.endswith(".Table"):
                table_name = static_string(value.args[0]) if value.args else None
                if table_name:
                    sqlalchemy_table_selectors[target.id] = {"selector": table_name, "confidence": "high"}
            if isinstance(value.func, ast.Name) and value.func.id == "getattr" and len(value.args) >= 2:
                receiver = dotted_name(value.args[0])
                attr = static_string(value.args[1])
                if attr == "import_module" and receiver in importlib_module_names:
                    dynamic_import_functions.add(target.id)
                elif attr == "__import__" and receiver in builtins_module_names:
                    dynamic_import_functions.add(target.id)
                elif attr == "resolve_name" and receiver in pkgutil_module_names:
                    pkgutil_resolver_functions.add(target.id)
            elif isinstance(value.func, ast.Attribute):
                value_receiver = dotted_name(value.func.value)
                if value.func.attr == "import_module" and value_receiver in importlib_module_names:
                    dynamic_import_functions.add(target.id)
                elif value.func.attr == "__import__" and value_receiver in builtins_module_names:
                    dynamic_import_functions.add(target.id)
                elif value.func.attr == "resolve_name" and value_receiver in pkgutil_module_names:
                    pkgutil_resolver_functions.add(target.id)
    elif isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute):
        call_name = dotted_name(node.func) or ""
        basename = call_name.split(".")[-1]
        receiver = dotted_name(node.func.value)
        if basename == "include_router" and receiver in fastapi_route_prefixes and node.args:
            router_name = dotted_name(node.args[0])
            if router_name in fastapi_route_prefixes:
                include_prefix = keyword_literal(node, "prefix") or ""
                fastapi_route_prefixes[router_name] = normalize_http_path(
                    fastapi_route_prefixes.get(receiver, ""),
                    normalize_http_path(include_prefix, fastapi_route_prefixes.get(router_name, "")),
                )
    elif isinstance(node, ast.ClassDef):
        if has_django_model_base(node):
            db_table = django_meta_db_table(node)
            django_model_selectors[node.name] = {
                "selector": db_table or "django." + node.name,
                "confidence": "high" if db_table else "medium",
            }
        tablename = class_string_assignment(node, "__tablename__")
        if tablename is not None:
            sqlalchemy_model_selectors[node.name] = {"selector": tablename, "confidence": "high"}

FASTAPI_METHODS = {
    "get": ["GET"],
    "post": ["POST"],
    "put": ["PUT"],
    "patch": ["PATCH"],
    "delete": ["DELETE"],
    "options": ["OPTIONS"],
    "head": ["HEAD"],
    "trace": ["TRACE"],
    "websocket": ["WEBSOCKET"],
}
DJANGO_READ_METHODS = set(["all", "count", "exists", "exclude", "filter", "first", "get", "last", "order_by", "prefetch_related", "raw", "select_related"])
DJANGO_WRITE_METHODS = set(["bulk_create", "bulk_update", "create", "delete", "get_or_create", "save", "update", "update_or_create"])

def dynamic_import_call_source(call):
    name = dotted_name(call.func) or ""
    if name in dynamic_import_functions:
        return "__import__" if name == "__import__" else name
    if name in pkgutil_resolver_functions:
        return "pkgutil.resolve_name"
    if isinstance(call.func, ast.Attribute):
        receiver = dotted_name(call.func.value)
        if call.func.attr == "import_module" and receiver in importlib_module_names:
            return "importlib.import_module"
        if call.func.attr == "__import__" and receiver in builtins_module_names:
            return "builtins.__import__"
        if call.func.attr == "resolve_name" and receiver in pkgutil_module_names:
            return "pkgutil.resolve_name"
    if isinstance(call.func, ast.Call):
        return dynamic_import_getattr_source(call.func)
    return None

def dynamic_import_getattr_source(call):
    name = dotted_name(call.func) or ""
    if name != "getattr" or len(call.args) < 2:
        return None
    receiver = dotted_name(call.args[0])
    attr = static_string(call.args[1])
    if attr == "import_module" and receiver in importlib_module_names:
        return "importlib.import_module"
    if attr == "__import__" and receiver in builtins_module_names:
        return "builtins.__import__"
    if attr == "resolve_name" and receiver in pkgutil_module_names:
        return "pkgutil.resolve_name"
    return None

def dynamic_import_literal(call, source):
    if not call.args:
        return None
    value = literal_string(call.args[0])
    if value is None:
        return None
    if source == "pkgutil.resolve_name":
        return value.split(":", 1)[0]
    return value

def inspect_dynamic_import_call_node(call, line_override=None):
    dynamic_source = dynamic_import_call_source(call)
    if not dynamic_source:
        return
    specifier = dynamic_import_literal(call, dynamic_source)
    if specifier:
        add_import(specifier, line_override or node_line(call))
    else:
        add_dynamic_import_warning(call, dynamic_source)

def inspect_exec_literal(call):
    name = dotted_name(call.func) or ""
    if name not in ("exec", "eval") or not call.args:
        return
    value = literal_string(call.args[0])
    if value is None:
        add_dynamic_import_warning(call, name)
        return
    if "import" not in value:
        return
    try:
        nested = ast.parse(value)
    except SyntaxError:
        add_dynamic_import_warning(call, name)
        return
    for nested_node in ast.walk(nested):
        if isinstance(nested_node, ast.Import):
            for alias in nested_node.names:
                add_import(alias.name, node_line(call))
        elif isinstance(nested_node, ast.ImportFrom):
            module = "." * int(nested_node.level or 0) + (nested_node.module or "")
            if nested_node.module is None:
                for alias in nested_node.names:
                    if alias.name != "*":
                        add_import(module + alias.name, node_line(call))
            else:
                saw_star = False
                for alias in nested_node.names:
                    if alias.name == "*":
                        saw_star = True
                        continue
                    candidate = from_import_candidate(module, alias.name)
                    add_import(module, node_line(call), [candidate] if candidate else [])
                if saw_star:
                    add_import(module, node_line(call))
        elif isinstance(nested_node, ast.Call):
            inspect_dynamic_import_call_node(nested_node, node_line(call))

def emit_fastapi_route(function_node):
    for decorator in function_node.decorator_list:
        call = decorator if isinstance(decorator, ast.Call) else None
        target = call.func if call is not None else decorator
        if not isinstance(target, ast.Attribute):
            continue
        receiver = dotted_name(target.value)
        if receiver not in fastapi_route_prefixes:
            continue
        route_path = static_string(call.args[0]) if call is not None and call.args else None
        if route_path is None and call is not None:
            route_path = keyword_literal(call, "path")
        if route_path is None:
            continue
        methods = FASTAPI_METHODS.get(target.attr)
        if target.attr in ("api_route", "route") and call is not None:
            methods = [method.upper() for method in keyword_literal_list(call, "methods")] or ["ANY"]
        if not methods:
            continue
        for method in methods:
            emit_resource(
                "http",
                "serve",
                method + " " + normalize_http_path(fastapi_route_prefixes.get(receiver, ""), route_path),
                function_node,
                target.attr,
                "fastapi-adapter",
                "high",
            )

def celery_task_name(function_node, decorator_call):
    if decorator_call is not None:
        named = keyword_literal(decorator_call, "name")
        if named:
            return named
        if decorator_call.args:
            positional = static_string(decorator_call.args[0])
            if positional:
                return positional
    return function_node.name

def celery_signature_task_name(node):
    if not isinstance(node, ast.Call):
        return None
    name = dotted_name(node.func) or ""
    if name not in celery_signature_functions and not name.endswith(".signature") and not name.endswith(".Signature"):
        return None
    if node.args:
        positional = static_string(node.args[0])
        if positional:
            return positional
    return keyword_literal(node, "task") or keyword_literal(node, "name")

def emit_celery_task(function_node):
    for decorator in function_node.decorator_list:
        call = decorator if isinstance(decorator, ast.Call) else None
        target = call.func if call is not None else decorator
        name = dotted_name(target) or ""
        root = root_name(target)
        is_bound_app_task = isinstance(target, ast.Attribute) and target.attr == "task" and root in celery_app_names
        is_shared_task = name in celery_task_decorators or name.endswith(".shared_task")
        if not is_bound_app_task and not is_shared_task:
            continue
        task_name = celery_task_name(function_node, call)
        celery_task_symbols[function_node.name] = task_name
        emit_resource("queue", "subscribe", "celery:" + task_name, function_node, name.split(".")[-1] or "task", "celery-adapter", "high" if task_name != function_node.name else "medium")

for node in ast.walk(tree):
    if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
        emit_fastapi_route(node)
        emit_celery_task(node)
        continue
    if not isinstance(node, ast.Call):
        continue

    call_name = dotted_name(node.func) or ""
    basename = call_name.split(".")[-1]

    inspect_dynamic_import_call_node(node)

    inspect_exec_literal(node)

    if basename in django_url_functions or call_name in django_url_functions:
        route = (static_string(node.args[0]) if node.args else None) or keyword_literal(node, "route")
        if route:
            selector = "ANY " + (("regex:" + route) if basename in ("re_path", "url") else normalize_http_path("", route))
            emit_resource("http", "serve", selector, node, basename, "django-adapter", "medium")

    if isinstance(node.func, ast.Attribute):
        manager_model = django_manager_model(node.func.value)
        django_entry = django_model_selectors.get(manager_model) if manager_model else None
        if django_entry is not None:
            if node.func.attr in DJANGO_READ_METHODS:
                emit_resource("database", "read", django_entry["selector"], node, node.func.attr, "django-adapter", django_entry["confidence"])
            elif node.func.attr in DJANGO_WRITE_METHODS:
                emit_resource("database", "write", django_entry["selector"], node, node.func.attr, "django-adapter", django_entry["confidence"])

        if basename == "save":
            model_name = django_manager_model(node.func.value)
            django_entry = django_model_selectors.get(model_name) if model_name else None
            if django_entry is not None:
                emit_resource("database", "write", django_entry["selector"], node, basename, "django-adapter", django_entry["confidence"])

        if basename in ("send_task",) and node.args:
            task_name = static_string(node.args[0])
            if task_name:
                emit_resource("queue", "publish", "celery:" + task_name, node, basename, "celery-adapter", "high")
        elif basename in ("delay", "apply_async"):
            signature_task = celery_signature_task_name(node.func.value)
            if signature_task:
                emit_resource("queue", "publish", "celery:" + signature_task, node, basename, "celery-adapter", "high")
            else:
                target = dotted_name(node.func.value)
                task_name = celery_task_symbols.get(target)
                if task_name:
                    emit_resource("queue", "publish", "celery:" + task_name, node, basename, "celery-adapter", "high" if task_name != target else "medium")

    if isinstance(node.func, ast.Attribute) and basename in ("get",) and node.args:
        entry = selector_from_expression(node.args[0])
        if entry is not None:
            emit_resource("database", "read", entry["selector"], node, basename, "sqlalchemy-adapter", entry["confidence"])

    if isinstance(node.func, ast.Attribute) and basename in ("insert", "update", "delete"):
        entry = selector_from_expression(node.func.value)
        if entry is not None:
            emit_resource("database", "write", entry["selector"], node, basename, "sqlalchemy-adapter", entry["confidence"])

    if basename in sqlalchemy_read_functions and node.args:
        entry = selector_from_expression(node.args[0])
        if entry is not None:
            emit_resource("database", "read", entry["selector"], node, basename, "sqlalchemy-adapter", entry["confidence"])
    if basename in sqlalchemy_write_functions and node.args:
        entry = selector_from_expression(node.args[0])
        if entry is not None:
            emit_resource("database", "write", entry["selector"], node, basename, "sqlalchemy-adapter", entry["confidence"])
    if isinstance(node.func, ast.Attribute) and basename == "query" and node.args:
        entry = selector_from_expression(node.args[0])
        if entry is not None:
            emit_resource("database", "read", entry["selector"], node, basename, "sqlalchemy-adapter", entry["confidence"])
    if isinstance(node.func, ast.Attribute) and basename in ("add", "merge") and node.args:
        entry = selector_from_expression(node.args[0])
        if entry is not None:
            emit_resource("database", "write", entry["selector"], node, basename, "sqlalchemy-adapter", entry["confidence"])
    if isinstance(node.func, ast.Attribute) and basename == "add_all" and node.args and isinstance(node.args[0], (ast.List, ast.Tuple)):
        for item in node.args[0].elts:
            entry = selector_from_expression(item)
            if entry is not None:
                emit_resource("database", "write", entry["selector"], node, basename, "sqlalchemy-adapter", entry["confidence"])
    if isinstance(node.func, ast.Attribute) and basename == "bulk_save_objects" and node.args and isinstance(node.args[0], (ast.List, ast.Tuple)):
        for item in node.args[0].elts:
            entry = selector_from_expression(item)
            if entry is not None:
                emit_resource("database", "write", entry["selector"], node, basename, "sqlalchemy-adapter", entry["confidence"])
    if isinstance(node.func, ast.Attribute) and basename in ("bulk_insert_mappings", "bulk_update_mappings") and node.args:
        entry = selector_from_expression(node.args[0])
        if entry is not None:
            emit_resource("database", "write", entry["selector"], node, basename, "sqlalchemy-adapter", entry["confidence"])

    sql_literal = None
    if basename in sqlalchemy_sql_literal_functions and node.args:
        sql_literal = static_string(node.args[0])
    elif isinstance(node.func, ast.Attribute) and basename == "execute" and node.args:
        sql_literal = static_string(node.args[0])
    elif isinstance(node.func, ast.Attribute) and basename == "exec_driver_sql" and node.args:
        sql_literal = static_string(node.args[0])
    if sql_literal:
        for sql_access in sql_table_accesses(sql_literal):
            emit_resource("database", sql_access["access"], sql_access["selector"], node, basename, "sqlalchemy-adapter", "medium")

print(json.dumps({
    "imports": imports,
    "publicSymbols": public_symbols,
    "surfaceParts": surface_parts,
    "resources": resources,
    "errors": [],
    "warnings": warnings,
}, separators=(",", ":")))
`;

export function inspectPythonSource(filePath: string): PythonInspection {
  const stat = fs.statSync(filePath);
  const cached = inspectionCache.get(filePath);
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached.result;

  let lastError: unknown;
  for (const pythonCommand of ["python3", "python"]) {
    try {
      const output = execFileSync(pythonCommand, ["-I", "-B", "-c", PYTHON_INSPECTOR, filePath], {
        encoding: "utf8",
        maxBuffer: 1024 * 1024,
        stdio: ["ignore", "pipe", "pipe"],
      });
      const result = JSON.parse(output) as PythonInspection;
      inspectionCache.set(filePath, { mtimeMs: stat.mtimeMs, size: stat.size, result });
      return result;
    } catch (error) {
      lastError = error;
    }
  }

  const message = lastError instanceof Error ? lastError.message : String(lastError);
  const result: PythonInspection = {
    imports: [],
    publicSymbols: [],
    surfaceParts: [],
    resources: [],
    errors: [{ kind: "inspector_error", message }],
  };
  inspectionCache.set(filePath, { mtimeMs: stat.mtimeMs, size: stat.size, result });
  return result;
}
