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
 *   - star matches zero or more characters within a single segment
 *   - double-star matches anything when it stands alone; matches zero or
 *          more whole path segments when it is not the last segment
 *          (so double-star/src matches src, just like the old
 *          (?:[^/]+/)* regex form); matches one or more whole path
 *          segments when it is the last segment (so src/** does not
 *          match src, matching the old /[\s\S]+ regex form)
 *   - all other characters are matched literally (with backslash and slash
 *          still treated as path separators)
 *
 * The match runs in O(p * s) time, where p is the number of pattern
 * segments and s is the number of path segments, with no regex engine
 * backtracking.
 *
 * This module is duplicated across packages/engine, packages/plugin-agent-budget,
 * and packages/plugin-blast-radius. The TypeScript project reference setup
 * does not allow a child package to import source files from a sibling
 * package when the child has its own rootDir: "src" constraint, so the
 * modules are kept in lock-step. A future refactor could move this into
 * a shared packages/glob workspace.
 */
import path from "node:path";

const MATCHER_CACHE = new Map<string, (pathSegments: string[]) => boolean>();

type SegmentMatcher = (pathSegment: string) => boolean;

const SEGMENT_MATCHER_CACHE = new Map<string, SegmentMatcher>();

function compileSegmentMatcher(segment: string): SegmentMatcher {
  const cached = SEGMENT_MATCHER_CACHE.get(segment);
  if (cached) return cached;
  const matcher: SegmentMatcher = segment.includes("*")
    ? (pathSegment) => {
        const M = segment.length;
        const N = pathSegment.length;
        const dp = new Uint8Array((M + 1) * (N + 1));
        const at = (i: number, j: number) => dp[i * (N + 1) + j];
        const set = (i: number, j: number) => {
          dp[i * (N + 1) + j] = 1;
        };
        set(0, 0);
        for (let i = 1; i <= M; i += 1) {
          if (segment[i - 1] === "*") {
            for (let j = 0; j <= N; j += 1) {
              if (at(i - 1, j) === 1 || (j > 0 && at(i, j - 1) === 1)) set(i, j);
            }
          } else {
            for (let j = 1; j <= N; j += 1) {
              if (at(i - 1, j - 1) === 1 && segment[i - 1] === pathSegment[j - 1]) set(i, j);
            }
          }
        }
        return at(M, N) === 1;
      }
    : (pathSegment) => pathSegment === segment;
  SEGMENT_MATCHER_CACHE.set(segment, matcher);
  return matcher;
}

function collapseAdjacentGlobstars(segments: string[]): string[] {
  return segments.filter((segment, index) => segment !== "**" || segments[index - 1] !== "**");
}

function normalizeGlobPattern(pattern: string): string {
  const slashPattern = pattern.split("\\").join("/").split(path.sep).join("/");
  const normalized = path.posix.normalize(slashPattern);
  return (normalized === "." ? "" : normalized).replace(/\/+$/, "");
}

function buildMatcher(normalizedPattern: string): (pathSegments: string[]) => boolean {
  const normalized = normalizedPattern;
  const collapsed = collapseAdjacentGlobstars(normalized.split("/"));
  if (collapsed.length === 0) return () => true;

  const compiled = collapsed.map((segment) => ({
    raw: segment,
    matcher: segment === "**" ? null : compileSegmentMatcher(segment),
  }));

  if (compiled.length === 1 && compiled[0].raw === "**") {
    return () => true;
  }

  // When ** appears anywhere except the last position, it matches zero
  // or more whole path segments (so **/src matches src just like the
  // old (?:[^/]+/)* regex form). When ** is the last pattern segment
  // it requires at least one trailing path segment (so src/** does
  // not match src, matching the old /[\s\S]+ form).
  const lastCompiled = compiled[compiled.length - 1];
  const trailingGlobstar = lastCompiled?.raw === "**";

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
        if (i === M && trailingGlobstar) {
          // Trailing ** consumes one or more whole path segments
          // (so src/** does not match src). The transition
          // dp[i][j] = dp[i][j-1] || dp[i-1][j-1] mirrors the
          // (?:[\s\S]+/?) form: the previous pattern segment must
          // have matched at j-1, then ** may keep consuming more.
          for (let j = 1; j <= N; j += 1) {
            if (at(i, j - 1) === 1 || at(i - 1, j - 1) === 1) set(i, j);
          }
        } else {
          // Non-trailing ** consumes zero or more whole path segments
          // (so **/src matches src). The first transition lets **
          // consume nothing; the inner loop then expands the match
          // to consume one or more segments afterwards.
          if (at(i - 1, 0) === 1) set(i, 0);
          for (let j = 1; j <= N; j += 1) {
            if (at(i, j - 1) === 1 || at(i - 1, j) === 1) set(i, j);
          }
        }
      } else {
        for (let j = 1; j <= N; j += 1) {
          if (at(i - 1, j - 1) === 1 && seg.matcher!(pathSegments[j - 1])) {
            set(i, j);
          }
        }
      }
    }
    return at(M, N) === 1;
  };
}

function compilePattern(pattern: string): (pathSegments: string[]) => boolean {
  const normalizedPattern = normalizeGlobPattern(pattern);
  const cached = MATCHER_CACHE.get(normalizedPattern);
  if (cached) return cached;
  const matcher = buildMatcher(normalizedPattern);
  MATCHER_CACHE.set(normalizedPattern, matcher);
  return matcher;
}

export function matchesGlobPattern(relativePath: string, pattern: string): boolean {
  // Normalise both backslashes and the platform separator so Windows
  // style paths ("src\\core\\a.ts") and POSIX style paths match the
  // same set of patterns.
  const normalizedPath = normalizeGlobPattern(relativePath);
  return compilePattern(pattern)(normalizedPath.split("/"));
}

export function clearGlobMatcherCache(): void {
  MATCHER_CACHE.clear();
  SEGMENT_MATCHER_CACHE.clear();
}
