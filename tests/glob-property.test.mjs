import assert from "node:assert/strict";
import test from "node:test";

import { matchesPattern, pathOwnedByCell, patternCoveredByOwnedPaths } from "../packages/engine/dist/file-index.js";
import { pathPatternsOverlap } from "../packages/engine/dist/glob-overlap.js";

const PATH_SEGMENTS = ["src", "core", "a", "deep", "a.ts", "x.test.ts", "b.py", "README.md"];
const PATTERN_TOKENS = ["src", "core", "a", "deep", "*", "**", "*.ts", "**.ts", "***", "./src", "."];
const OWNED_PATTERN_TOKENS = ["src", "core", "a", "deep", "*", "**", "*.ts", "**.ts", "***"];
const PAIR_COUNT = 4096;

function* tokenCombinations(tokens, maxLength) {
  for (const token of tokens) yield [token];
  if (maxLength <= 1) return;
  for (const rest of tokenCombinations(tokens, maxLength - 1)) {
    for (const token of tokens) yield [token, ...rest];
  }
}

function mulberry32(seed) {
  return function next() {
    seed = (seed + 0x6d2b79f5) | 0;
    let value = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function generatePatterns(tokens, seed) {
  const random = mulberry32(seed);
  const pick = (values) => values[Math.floor(random() * values.length)];
  return Array.from({ length: PAIR_COUNT * 2 }, () =>
    Array.from({ length: 1 + Math.floor(random() * 3) }, () => pick(tokens)).join("/"));
}

function patternPairs(tokens, seed) {
  const patterns = generatePatterns(tokens, seed);
  const pairs = [];
  for (let index = 0; index < PAIR_COUNT; index += 1) {
    pairs.push([patterns[index * 2], patterns[index * 2 + 1]]);
  }
  return pairs;
}

const PATH_SPACE = [...new Set([...tokenCombinations(PATH_SEGMENTS, 3)].map((parts) => parts.join("/")))];

test("overlap is true whenever a concrete path matches both patterns", () => {
  const violations = [];
  for (const [leftPattern, rightPattern] of patternPairs(PATTERN_TOKENS, 0x0f1a)) {
    for (const relativePath of PATH_SPACE) {
      if (!matchesPattern(relativePath, leftPattern) || !matchesPattern(relativePath, rightPattern)) continue;
      if (pathPatternsOverlap(leftPattern, rightPattern)) continue;
      violations.push({ leftPattern, rightPattern, relativePath });
      break;
    }
  }
  assert.deepEqual(violations.slice(0, 10), [], `overlap false negatives: ${JSON.stringify(violations.slice(0, 10))}`);
});

test("covered owned-path subsets own every concrete witness", () => {
  const violations = [];
  for (const [candidatePattern, ownedPath] of patternPairs(OWNED_PATTERN_TOKENS, 0xc0de)) {
    if (!patternCoveredByOwnedPaths(candidatePattern, [ownedPath])) continue;
    const ownerCell = { id: "owner", ownedPaths: [ownedPath] };
    for (const relativePath of PATH_SPACE) {
      if (!matchesPattern(relativePath, candidatePattern) || pathOwnedByCell(ownerCell, relativePath)) continue;
      violations.push({ candidatePattern, ownedPath, relativePath });
      break;
    }
  }
  assert.deepEqual(violations.slice(0, 10), [], `subset false positives: ${JSON.stringify(violations.slice(0, 10))}`);
});

test("equivalent normalized patterns match the same concrete paths", () => {
  const equivalentPairs = [
    ["src/**", "./src/**"],
    ["src/**", "src//**"],
    ["src/**", "src/./**"],
  ];
  const violations = [];
  for (const [leftPattern, rightPattern] of equivalentPairs) {
    for (const relativePath of PATH_SPACE) {
      const leftMatches = matchesPattern(relativePath, leftPattern);
      const rightMatches = matchesPattern(relativePath, rightPattern);
      if (leftMatches === rightMatches) continue;
      violations.push({ leftPattern, rightPattern, relativePath, leftMatches, rightMatches });
    }
  }
  assert.deepEqual(violations, []);
});
