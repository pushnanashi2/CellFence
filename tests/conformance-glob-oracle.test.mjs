import assert from "node:assert/strict";
import test from "node:test";

import { minimatch } from "minimatch";

import { matchesPattern } from "../packages/engine/dist/file-index.js";
import { pathPatternsOverlap } from "../packages/engine/dist/glob-overlap.js";

// External-oracle conformance: CellFence's path matcher must agree with minimatch
// (the de-facto glob reference) for every pattern built from the supported dialect
// (`*` and standalone `**`). Divergences are either bugs or must be added to
// DOCUMENTED_DIVERGENCES with a docs/manifest.md reference, so the dialect stays
// an executable specification instead of an implementation accident.

// key: `${pattern}\u0000${path}` -> { ours, oracle, reason }
const DOCUMENTED_DIVERGENCES = new Map();

const oracle = (relativePath, pattern) => minimatch(relativePath, pattern, { dot: true });

function* tokenCombinations(tokens, maxLength) {
  for (const token of tokens) yield [token];
  if (maxLength <= 1) return;
  for (const rest of tokenCombinations(tokens, maxLength - 1)) {
    for (const token of tokens) yield [token, ...rest];
  }
}

const pathSegments = ["src", "core", "a", "deep", "a.ts", "x.test.ts", "b.py", "README.md"];
const patternTokens = ["src", "core", "*", "**", "*.ts", "**.ts", "a", "deep"];
const unsupportedSyntax = /[?{}[\]!()+@]/;

const corpusPaths = [...tokenCombinations(pathSegments, 3)].map((parts) => parts.join("/"));
const corpusPatterns = [...tokenCombinations(patternTokens, 3)]
  .map((parts) => parts.join("/"))
  .filter((pattern) => !unsupportedSyntax.test(pattern));

test("path matcher agrees with the minimatch oracle across the exhaustive dialect corpus", () => {
  const divergences = [];
  for (const pattern of corpusPatterns) {
    for (const relativePath of corpusPaths) {
      const ours = matchesPattern(relativePath, pattern);
      const truth = oracle(relativePath, pattern);
      if (ours === truth) continue;
      const documented = DOCUMENTED_DIVERGENCES.get(`${pattern}\u0000${relativePath}`);
      if (documented && documented.ours === ours && documented.oracle === truth) continue;
      if (divergences.length < 10) divergences.push({ pattern, path: relativePath, ours, oracle: truth });
    }
  }
  assert.deepEqual(divergences, [], "path matcher diverged from the minimatch oracle");
});

// Deterministic seeded fuzzing widens the corpus beyond hand-picked tokens.
function mulberry32(seed) {
  return function next() {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test("path matcher agrees with the minimatch oracle across seeded random inputs", () => {
  const random = mulberry32(0x5eed);
  const pick = (values) => values[Math.floor(random() * values.length)];
  const fuzzPatternTokens = ["a", "b", "src", "core", "*", "**", "*.ts", "a*", "**b", "x.y"];
  const fuzzPathTokens = ["a", "b", "src", "core", "a.ts", "x.y", "ab", "deep"];
  const generate = (tokens, maxSegments) =>
    Array.from({ length: 1 + Math.floor(random() * maxSegments) }, () => pick(tokens)).join("/");
  for (let iteration = 0; iteration < 100_000; iteration += 1) {
    const pattern = generate(fuzzPatternTokens, 4);
    const relativePath = generate(fuzzPathTokens, 5);
    const ours = matchesPattern(relativePath, pattern);
    const truth = oracle(relativePath, pattern);
    assert.equal(
      ours,
      truth,
      `path matcher diverged from oracle: pattern=${pattern} path=${relativePath} ours=${ours} oracle=${truth}`,
    );
  }
});

// One-sided (metamorphic) oracle for the overlap automaton: no complete external
// oracle exists for glob intersection, but any concrete path matched by both
// patterns is a witness, so pathPatternsOverlap must return true for it.
test("overlap automaton accepts every concrete witness produced by the matcher", () => {
  const random = mulberry32(0x0ffe);
  const pick = (values) => values[Math.floor(random() * values.length)];
  const patternTokensForOverlap = ["a", "b", "src", "*", "**", "*.ts", "core"];
  const generatePattern = () =>
    Array.from({ length: 1 + Math.floor(random() * 3) }, () => pick(patternTokensForOverlap)).join("/");
  const witnessSegments = ["a", "b", "src", "core", "a.ts", "x", "deep"];
  const generatePath = () =>
    Array.from({ length: 1 + Math.floor(random() * 4) }, () => pick(witnessSegments)).join("/");
  for (let iteration = 0; iteration < 20_000; iteration += 1) {
    const left = generatePattern();
    const right = generatePattern();
    const witness = generatePath();
    if (!matchesPattern(witness, left) || !matchesPattern(witness, right)) continue;
    assert.equal(
      pathPatternsOverlap(left, right),
      true,
      `overlap automaton rejected a concrete witness: left=${left} right=${right} witness=${witness}`,
    );
  }
});
