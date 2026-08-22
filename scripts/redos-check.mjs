import { matchesPattern } from "../packages/engine/dist/file-index.js";

const MAX_CASE_MS = 1_000;

const cases = [
  { name: "globstar root", pattern: "**", path: "src/a.ts", expected: true },
  { name: "globstar requires separator", pattern: "src/**", path: "src", expected: false },
  { name: "globstar nested", pattern: "src/**", path: "src/a/b/c.ts", expected: true },
  { name: "globstar nested suffix", pattern: "src/**/a.ts", path: "src/x/y/z/a.ts", expected: true },
  {
    name: "pathological match",
    pattern: `src/${"**/".repeat(14)}zzz.ts`,
    path: `src/${"a/".repeat(20)}zzz.ts`,
    expected: true,
  },
  {
    name: "pathological non-match",
    pattern: `src/${"**/".repeat(14)}zzz.ts`,
    path: `src/${"a/".repeat(20)}nope.ts`,
    expected: false,
  },
];

let failures = 0;

for (const { name, pattern, path, expected } of cases) {
  const startedAt = Date.now();
  const actual = matchesPattern(path, pattern);
  const elapsedMs = Date.now() - startedAt;
  console.log(`${name}: match=${actual} expected=${expected} ms=${elapsedMs}`);
  if (actual !== expected) {
    console.error(`FAIL ${name}: expected ${expected} for pattern=${JSON.stringify(pattern)} path=${JSON.stringify(path)}`);
    failures += 1;
  }
  if (elapsedMs > MAX_CASE_MS) {
    console.error(`FAIL ${name}: took ${elapsedMs}ms, limit is ${MAX_CASE_MS}ms`);
    failures += 1;
  }
}

if (failures > 0) process.exitCode = 1;
