import crypto from "node:crypto";

export const defaultBlockingSeverities = ["error"];
export const exclusionRuleFields = new Set([
  "findingId",
  "subjectId",
  "repository",
  "ruleId",
  "severity",
  "filePath",
  "cellId",
  "producerCellId",
]);

export function protocolClaim(protocol) {
  return protocol?.claim && typeof protocol.claim === "object" ? protocol.claim : protocol;
}

export function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
  }
  return value;
}

export function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

export function hashCanonicalJson(value) {
  return crypto.createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function rejectUnknownKeys(issues, value, allowedKeys, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const allowed = new Set(allowedKeys);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) issues.push(`${label} has unexpected field ${key}`);
  }
}

export function normalizeExclusionRules(rawRules, issues, options = {}) {
  const labelPrefix = options.label || "protocol.exclusionRules";
  if (rawRules === undefined) return [];
  if (!Array.isArray(rawRules)) {
    issues.push(`${labelPrefix} must be an array when present`);
    return [];
  }
  const rules = [];
  for (const [index, rule] of rawRules.entries()) {
    const label = `${labelPrefix}[${index}]`;
    if (!rule || typeof rule !== "object" || Array.isArray(rule)) {
      issues.push(`${label} must be an object with field and equals or pattern; descriptive strings are not applied`);
      continue;
    }
    rejectUnknownKeys(issues, rule, ["field", "equals", "pattern", "reason"], label);
    if (typeof rule.field !== "string" || !exclusionRuleFields.has(rule.field)) {
      issues.push(`${label}.field must be one of ${[...exclusionRuleFields].sort().join(", ")}`);
      continue;
    }
    const hasEquals = Object.hasOwn(rule, "equals");
    const hasPattern = Object.hasOwn(rule, "pattern");
    if (hasEquals === hasPattern) {
      issues.push(`${label} must declare exactly one of equals or pattern`);
      continue;
    }
    if (hasEquals && typeof rule.equals !== "string") {
      issues.push(`${label}.equals must be a string`);
      continue;
    }
    if (hasPattern && typeof rule.pattern !== "string") {
      issues.push(`${label}.pattern must be a string`);
      continue;
    }
    if (Object.hasOwn(rule, "reason") && typeof rule.reason !== "string") {
      issues.push(`${label}.reason must be a string when present`);
      continue;
    }
    rules.push({
      field: rule.field,
      equals: hasEquals ? rule.equals : undefined,
      pattern: hasPattern ? rule.pattern : undefined,
      reason: rule.reason || null,
    });
  }
  return rules;
}

export function globPatternToRegExp(pattern) {
  let source = "^";
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index];
    if (character === "*") {
      if (pattern[index + 1] === "*") {
        source += ".*";
        index += 1;
      } else {
        source += "[^/]*";
      }
    } else if (character === "?") {
      source += "[^/]";
    } else {
      source += character.replace(/[\\^$+?.()|[\]{}]/g, "\\$&");
    }
  }
  source += "$";
  return new RegExp(source);
}

export function findingMatchesExclusionRule(finding, exclusionRules = []) {
  for (const rule of exclusionRules) {
    const value = String(finding?.[rule.field] ?? "");
    if (rule.equals !== undefined && value === rule.equals) return true;
    if (rule.pattern !== undefined && globPatternToRegExp(rule.pattern).test(value)) return true;
  }
  return false;
}

export function protocolFilterSha256(filters) {
  return hashCanonicalJson({
    includedRules: filters.includedRules || [],
    blockingSeverities: filters.blockingSeverities || defaultBlockingSeverities,
    exclusionRules: filters.exclusionRules || [],
  });
}
