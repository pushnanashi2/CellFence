/**
 * Linear-time glob matcher shared by engine and plugins.
 *
 * The previous implementation compiled each pattern to a JavaScript
 * RegExp whose `**` segment was expanded to `(?:[^/]+/)*`. That
 * expansion is O(2^n) for adversarial inputs (e.g. owned path
 * patterns stuffed with 14+ `**` segments), turning every glob check
 * into a CPU-bound denial of service. The replacement is a small
 * dynamic-programming matcher over the path segments. It recognises
 * the same dialect as the previous regex, including:
 *
 *   - `*`  matches zero or more characters within a single segment
 *   - `**` matches one or more whole path segments when it is adjacent
 *          to other segments, and matches anything when it stands alone
 *   - all other characters are matched literally (with `\\` and `/`
 *          still treated as path separators)
 *
 * The match runs in O(p * s) time, where p is the number of pattern
 * segments and s is the number of path segments, with no regex engine
 * backtracking.
 *
 * This module is duplicated across packages/engine, packages/plugin-agent-budget,
 * and packages/plugin-blast-radius. The TypeScript project reference setup
 * does not allow a child package to import source files from a sibling
 * package when the child has its own `rootDir: "src"` constraint, so the
 * modules are kept in lock-step. A future refactor could move this into
 * a shared `packages/glob` package.
 */
import path from "node:path";

const MATCHER_CACHE = new Map<string, (pathSegments: string[]) => boolean>();

function escapeRegExp(text: string): string {
  return text.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
}

function compilePatternSegmentToRegExp(segment: string): RegExp {
  const escaped = segment.split("*").map(escapeRegExp).join("[^/]*");
  return new RegExp(`^${escaped}$`);
}

const SEGMENT_REGEXP_CACHE = new Map<string, RegExp>();

function compileSegmentMatcher(segment: string): RegExp {
  const cached = SEGMENT_REGEXP_CACHE.get(segment);
  if (cached) return cached;
  const re = compilePatternSegmentToRegExp(segment);
  SEGMENT_REGEXP_CACHE.set(segment, re);
  return re;
}

function collapseAdjacentGlobstars(segments: string[]): string[] {
  return segments.filter((segment, index) => segment !== "**" || segments[index - 1] !== "**");
}

function buildMatcher(pattern: string): (pathSegments: string[]) => boolean {
  const normalized = pattern.split("\\").join("/").replace(/\/+$/, "");
  const collapsed = collapseAdjacentGlobstars(normalized.split("/"));
  if (collapsed.length === 0) return () => true;

  const compiled = collapsed.map((segment) => ({
    raw: segment,
    matcher: segment === "**" ? null : compileSegmentMatcher(segment),
  }));

  if (compiled.length === 1 && compiled[0].raw === "**") {
    return () => true;
  }

  return (pathSegments: string[]) => {
    const M = compiled.length;
    const N = pathSegments.length;
    const dp = new Uint8Array((M + 1) * (N + 1));
    const at = (i: number, j: number) => dp[i * (N + 1) + j];
    const set = (i: number, j: number) => {
      dp[i * (N + 1) + j] = 1;
    };
    set(0, 0);
    for (let i = 1; i <= M; i += 1) {
      const seg = compiled[i - 1];
      if (seg.raw === "**") {
        // ** consumes one or more whole path segments when adjacent to
        // other pattern segments. The transition `dp[i][j] = dp[i][j-1]`
        // matches the regex's `(?:[^/]+/)+` form: at least one segment.
        for (let j = 1; j <= N; j += 1) {
          if (at(i, j - 1) === 1 || at(i - 1, j) === 1) set(i, j);
        }
      } else {
        for (let j = 1; j <= N; j += 1) {
          if (at(i - 1, j - 1) === 1 && seg.matcher!.test(pathSegments[j - 1])) {
            set(i, j);
          }
        }
      }
    }
    return at(M, N) === 1;
  };
}

function compilePattern(pattern: string): (pathSegments: string[]) => boolean {
  const cached = MATCHER_CACHE.get(pattern);
  if (cached) return cached;
  const matcher = buildMatcher(pattern);
  MATCHER_CACHE.set(pattern, matcher);
  return matcher;
}

export function matchesGlobPattern(relativePath: string, pattern: string): boolean {
  const normalizedPath = relativePath.split(path.sep).join("/");
  return compilePattern(pattern)(normalizedPath.split("/"));
}

export function clearGlobMatcherCache(): void {
  MATCHER_CACHE.clear();
  SEGMENT_REGEXP_CACHE.clear();
}
