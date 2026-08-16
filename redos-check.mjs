// Quick ReDoS verification: a pathologically deep `**` chain
// must match in well under a second on a minimal CellFence matcher.
// The previous patternToRegExp implementation was O(2^n) on this input
// and would take 6+ seconds at 14 segments, which is the exact
// reproduction in the security report.
import { matchesPattern } from "./packages/engine/dist/file-index.js";

const cases = [
  { pattern: "**", path: "src/a.ts" },
  { pattern: "src/**", path: "src" },
  { pattern: "src/**", path: "src/a/b/c.ts" },
  { pattern: "src/**/a.ts", path: "src/x/y/z/a.ts" },
  { pattern: "**/".repeat(15), path: "a/b/c/d/e/f/g/h/i/j/k/l/m/n/o/p" },
];

for (const { pattern, path } of cases) {
  const t0 = Date.now();
  const result = matchesPattern(path, pattern);
  const dt = Date.now() - t0;
  console.log(`pattern=${JSON.stringify(pattern.slice(0, 40))} path=${path} match=${result} ms=${dt}`);
}

// Worst-case ReDoS stress: 14-segment pathological pattern.
const longPattern = "src/" + "**/".repeat(14) + "zzz.ts";
const longPath = "src/" + "a/".repeat(20) + "zzz.ts";
const t0 = Date.now();
matchesPattern(longPath, longPattern);
const dt = Date.now() - t0;
console.log(`\nWorst-case: pattern=${longPattern.length}ch path=${longPath.length}ch ms=${dt}`);
console.log(dt < 1000 ? "PASS: under 1s" : "FAIL: still exponential");
