import crypto from "node:crypto";

export type WorkflowControlKind =
  | "action_reference"
  | "credential_or_secret"
  | "failure_enforcement"
  | "permission"
  | "repository_write_or_publish"
  | "workflow_trigger";

export type WorkflowControlReference = {
  kind: WorkflowControlKind;
  semanticPath: string;
  value: string;
  confidence: "reference_text_scan";
};

export type WorkflowControlDelta = {
  kind: WorkflowControlKind;
  semanticPath: string;
  before: string | null;
  after: string | null;
};

const SECRET_RE = /\b(secrets\.[A-Za-z0-9_]+|GITHUB_TOKEN)\b/g;
const PUBLISH_RE = /\b(git\s+push|npm\s+publish|pnpm\s+publish|yarn\s+publish|docker\s+push|gh\s+release|semantic-release|changeset\s+publish)\b/i;
const SUPPRESSED_COMMAND_RE = /(?<command>[^#\n;&|][^#\n|]*?)\s*\|\|\s*(?:true|:|exit\s+0)\b/gi;
const SET_PLUS_E_RE = /\bset\s+\+e\b/i;

function shortHash(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex").slice(0, 12);
}

function slug(value: string): string {
  const clean = value.trim().replace(/[^A-Za-z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "");
  return (clean || "control").slice(0, 96);
}

function actionWithoutRef(value: string): string {
  return value.split("@", 1)[0] || value;
}

function normalizeShellCommand(value: string): string {
  return value.trim().replace(/;+$/g, "").trim().replace(/\s+/g, " ");
}

function stripShellComment(line: string): string {
  let quote: string | undefined;
  let escaped = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === "\\") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (character === quote) quote = undefined;
      continue;
    }
    if (character === "'" || character === "\"") {
      quote = character;
      continue;
    }
    if (character === "#") return line.slice(0, index);
  }
  return line;
}

function normalizedSuppressedCommands(text: string): string[] {
  const commands: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const stripped = stripShellComment(line).trim();
    if (!stripped) continue;
    for (const match of stripped.matchAll(SUPPRESSED_COMMAND_RE)) {
      const command = normalizeShellCommand(match.groups?.command || "");
      if (command) commands.push(command);
    }
  }
  return commands;
}

function pushUnique(items: WorkflowControlReference[], item: WorkflowControlReference): void {
  if (items.some((existing) => existing.kind === item.kind && existing.semanticPath === item.semanticPath && existing.value === item.value)) return;
  items.push(item);
}

function collectWorkflowTriggers(items: WorkflowControlReference[], text: string): void {
  const lines = text.split(/\r?\n/);
  let inOn = false;
  for (const line of lines) {
    if (/^\S/.test(line) && !line.startsWith("on:")) inOn = false;
    const inlineOn = line.match(/^on:\s*(.*?)\s*$/);
    if (inlineOn) {
      inOn = true;
      const value = inlineOn[1].trim();
      if (value && value !== "{}") {
        for (const event of value.replace(/[[\]'",]/g, " ").split(/\s+/).filter(Boolean)) {
          pushUnique(items, { kind: "workflow_trigger", semanticPath: `on.${event}`, value: "present", confidence: "reference_text_scan" });
        }
      }
      continue;
    }
    if (!inOn) continue;
    const event = line.match(/^\s{2}([A-Za-z0-9_-]+):/);
    if (event) {
      pushUnique(items, { kind: "workflow_trigger", semanticPath: `on.${event[1]}`, value: "present", confidence: "reference_text_scan" });
    }
  }
}

function collectPermissions(items: WorkflowControlReference[], text: string): void {
  const lines = text.split(/\r?\n/);
  let inPermissions = false;
  for (const line of lines) {
    if (/^\S/.test(line) && !line.startsWith("permissions:")) inPermissions = false;
    if (/^permissions:\s*$/.test(line)) {
      inPermissions = true;
      continue;
    }
    if (!inPermissions) continue;
    const permission = line.match(/^\s{2}([A-Za-z0-9_-]+):\s*(\S+)/);
    if (!permission) continue;
    pushUnique(items, {
      kind: "permission",
      semanticPath: `permissions.${permission[1]}`,
      value: permission[2],
      confidence: "reference_text_scan",
    });
  }
}

function collectActionReferences(items: WorkflowControlReference[], text: string): void {
  const counts = new Map<string, number>();
  for (const match of text.matchAll(/^\s*-\s+uses:\s*([^\s#]+)/gm)) {
    const action = match[1];
    const key = slug(actionWithoutRef(action));
    const occurrence = counts.get(key) || 0;
    counts.set(key, occurrence + 1);
    const suffix = occurrence === 0 ? "" : `:${occurrence}`;
    pushUnique(items, {
      kind: "action_reference",
      semanticPath: `steps.uses-${key}${suffix}.uses`,
      value: action,
      confidence: "reference_text_scan",
    });
  }
}

function collectTextControls(items: WorkflowControlReference[], text: string): void {
  for (const secret of new Set([...text.matchAll(SECRET_RE)].map((match) => match[1]))) {
    pushUnique(items, {
      kind: "credential_or_secret",
      semanticPath: `workflow.secret.${secret}`,
      value: secret,
      confidence: "reference_text_scan",
    });
  }

  const publishLines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => PUBLISH_RE.test(line));
  if (publishLines.length > 0) {
    const value = publishLines.join("\n");
    pushUnique(items, {
      kind: "repository_write_or_publish",
      semanticPath: `workflow.publish.${shortHash(value)}`,
      value,
      confidence: "reference_text_scan",
    });
  }

  const suppressedCounts = new Map<string, number>();
  for (const command of normalizedSuppressedCommands(text)) {
    const key = shortHash(command);
    const occurrence = suppressedCounts.get(key) || 0;
    suppressedCounts.set(key, occurrence + 1);
    const suffix = occurrence === 0 ? "" : `:${occurrence}`;
    pushUnique(items, {
      kind: "failure_enforcement",
      semanticPath: `workflow.suppressed-command.${key}${suffix}`,
      value: command,
      confidence: "reference_text_scan",
    });
  }

  if (SET_PLUS_E_RE.test(text)) {
    const normalized = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).join("\n");
    pushUnique(items, {
      kind: "failure_enforcement",
      semanticPath: `workflow.errexit-disabled.${shortHash(normalized)}`,
      value: normalized,
      confidence: "reference_text_scan",
    });
  }
}

export function snapshotWorkflowControls(text: string): WorkflowControlReference[] {
  if (!text.trim()) return [];
  const items: WorkflowControlReference[] = [];
  collectWorkflowTriggers(items, text);
  collectPermissions(items, text);
  collectActionReferences(items, text);
  collectTextControls(items, text);
  return items.sort((left, right) => `${left.kind}:${left.semanticPath}:${left.value}`.localeCompare(`${right.kind}:${right.semanticPath}:${right.value}`));
}

export function diffWorkflowControls(beforeText: string, afterText: string): WorkflowControlDelta[] {
  const before = new Map(snapshotWorkflowControls(beforeText).map((item) => [`${item.kind}:${item.semanticPath}`, item]));
  const after = new Map(snapshotWorkflowControls(afterText).map((item) => [`${item.kind}:${item.semanticPath}`, item]));
  const deltas: WorkflowControlDelta[] = [];
  for (const key of new Set([...before.keys(), ...after.keys()])) {
    const beforeItem = before.get(key);
    const afterItem = after.get(key);
    const beforeValue = beforeItem?.value ?? null;
    const afterValue = afterItem?.value ?? null;
    if (beforeValue === afterValue) continue;
    const item = afterItem ?? beforeItem;
    if (!item) continue;
    deltas.push({
      kind: item.kind,
      semanticPath: item.semanticPath,
      before: beforeValue,
      after: afterValue,
    });
  }
  return deltas.sort((left, right) => `${left.kind}:${left.semanticPath}`.localeCompare(`${right.kind}:${right.semanticPath}`));
}
