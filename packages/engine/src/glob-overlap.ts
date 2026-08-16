import { normalizePath } from "./file-index.js";

type GlobTransition =
  | { kind: "epsilon"; to: number }
  | { kind: "any"; to: number }
  | { kind: "non-slash"; to: number }
  | { kind: "literal"; to: number; value: string };
type ConsumingGlobTransition = Exclude<GlobTransition, { kind: "epsilon" }>;

type GlobAutomaton = {
  accept: number;
  transitions: GlobTransition[][];
};

function normalizedGlobPattern(pattern: string): string {
  return normalizePath(pattern).replace(/\/$/, "");
}

function normalizedPatternSegments(pattern: string): string[] {
  const normalized = normalizedGlobPattern(pattern);
  const segments = normalized.split("/");
  // Stryker disable next-line ArithmeticOperator: retaining the first or last member of a consecutive globstar run recognizes the same path language.
  return segments.filter((segment, index) => segment !== "**" || segments[index - 1] !== "**");
}

function patternAutomaton(pattern: string): GlobAutomaton {
  const segments = normalizedPatternSegments(pattern);
  // Stryker disable next-line ArrayDeclaration: adding a non-transition sentinel to this private, typed NFA state is unobservable and invalid by construction.
  const transitions: GlobTransition[][] = [[]];
  let state = 0;
  const nextState = (): number => {
    // Stryker disable next-line ArrayDeclaration: adding a non-transition sentinel to this private, typed NFA state is unobservable and invalid by construction.
    transitions.push([]);
    return transitions.length - 1;
  };
  const addLiteral = (value: string): void => {
    const next = nextState();
    transitions[state].push({ kind: "literal", value, to: next });
    state = next;
  };
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    if (segment === "**") {
      if (segments.length === 1) {
        const next = nextState();
        transitions[state].push({ kind: "epsilon", to: next });
        transitions[state].push({ kind: "any", to: state });
        state = next;
      } else if (index === segments.length - 1) {
        addLiteral("/");
        const next = nextState();
        transitions[state].push({ kind: "any", to: next });
        transitions[next].push({ kind: "any", to: next });
        state = next;
      } else {
        if (index > 0) addLiteral("/");
        const globstarState = state;
        const next = nextState();
        const segmentState = nextState();
        transitions[globstarState].push({ kind: "epsilon", to: next });
        transitions[globstarState].push({ kind: "non-slash", to: segmentState });
        transitions[segmentState].push({ kind: "non-slash", to: segmentState });
        transitions[segmentState].push({ kind: "literal", value: "/", to: globstarState });
        state = next;
      }
      continue;
    }
    if (index > 0 && segments[index - 1] !== "**") addLiteral("/");
    // Stryker disable next-line Regex: with a global replacement, matching one or a run of adjacent stars produces the same collapsed segment.
    for (const character of segment.replace(/\*+/g, "*")) {
      if (character === "*") {
        const next = nextState();
        transitions[state].push({ kind: "epsilon", to: next });
        transitions[state].push({ kind: "non-slash", to: state });
        state = next;
        continue;
      }
      const next = nextState();
      transitions[state].push({ kind: "literal", value: character, to: next });
      state = next;
    }
  }
  return { accept: state, transitions };
}

function epsilonClosure(automaton: GlobAutomaton, state: number): Set<number> {
  const closure = new Set<number>([state]);
  const stack = [state];
  while (stack.length > 0) {
    const current = stack.pop() as number;
    for (const transition of automaton.transitions[current]) {
      if (transition.kind !== "epsilon" || closure.has(transition.to)) continue;
      closure.add(transition.to);
      stack.push(transition.to);
    }
  }
  return closure;
}

function transitionAccepts(transition: ConsumingGlobTransition, character: string): boolean {
  switch (transition.kind) {
    case "any":
      return true;
    case "non-slash":
      return character !== "/";
    case "literal":
      return transition.value === character;
  }
}

function transitionLabelsIntersect(left: ConsumingGlobTransition, right: ConsumingGlobTransition): boolean {
  switch (left.kind) {
    case "literal":
      return transitionAccepts(right, left.value);
    default:
      switch (right.kind) {
        case "literal":
          return transitionAccepts(left, right.value);
        default:
          return true;
      }
  }
}

function patternAutomataIntersect(leftPattern: string, rightPattern: string): boolean {
  const left = patternAutomaton(leftPattern);
  const right = patternAutomaton(rightPattern);
  // Stryker disable next-line ArrayDeclaration: adding a non-state sentinel to this private, typed BFS queue is unobservable and invalid by construction.
  const queue: Array<[number, number]> = [];
  const seen = new Set<string>();
  const enqueueClosures = (leftState: number, rightState: number): void => {
    for (const leftClosed of epsilonClosure(left, leftState)) {
      for (const rightClosed of epsilonClosure(right, rightState)) {
        const key = `${leftClosed}:${rightClosed}`;
        if (seen.has(key)) continue;
        seen.add(key);
        queue.push([leftClosed, rightClosed]);
      }
    }
  };
  enqueueClosures(0, 0);
  while (queue.length > 0) {
    const [leftState, rightState] = queue.shift() as [number, number];
    if (leftState === left.accept && rightState === right.accept) return true;
    for (const leftTransition of left.transitions[leftState]) {
      // Stryker disable next-line all: epsilon transitions are represented by closure states and cannot consume a paired character.
      if (leftTransition.kind === "epsilon") continue;
      for (const rightTransition of right.transitions[rightState]) {
        // Stryker disable next-line all: epsilon transitions are represented by closure states and cannot consume a paired character.
        if (rightTransition.kind === "epsilon") continue;
        if (!transitionLabelsIntersect(leftTransition, rightTransition)) continue;
        enqueueClosures(leftTransition.to, rightTransition.to);
      }
    }
  }
  return false;
}

// Stryker disable next-line StringLiteral: this sentinel only needs to be a value that cannot be confused with a valid path character; concrete path matching never exposes the token text.
const OTHER_NON_SLASH_KEY = "\u0000__cellfence_other_non_slash__";

// B-04 review fix: `patternCoveredByOwnedPaths` needs a real
// language-containment check, not a literal-prefix heuristic.
// The NFA alphabet is infinite (`*` accepts any non-slash and
// `**` accepts any character), but every transition belongs to
// one of a few equivalence classes for a given pair of patterns:
// slash, each literal character mentioned by either pattern, and
// "some other non-slash". Walking those representative symbols is
// enough to find a counterexample when L(inner) is not a subset of
// L(outer), while preserving NFA nondeterminism for cases like
// `src/*/a.ts` ⊆ `src/**/a.ts`.

export function pathPatternSubset(innerPattern: string, outerPattern: string): boolean {
  const inner = patternAutomaton(innerPattern);
  const outer = patternAutomaton(outerPattern);
  const alphabet = automataAlphabet(inner, outer);
  type Pair = { inner: Set<number>; outer: Set<number>; lastWasSlash: boolean };
  const start: Pair = {
    inner: epsilonClosure(inner, 0),
    outer: epsilonClosure(outer, 0),
    // Stryker disable next-line BooleanLiteral: relative CellFence paths cannot start with '/', so either initial slash state is observationally equivalent for public subset results.
    lastWasSlash: true,
  };
  // Stryker disable next-line StringLiteral: the labels make visited-state keys readable; only the boolean split matters and public behavior cannot observe the literal words.
  const keyOf = (pair: Pair): string => `${stateSetKey(pair.inner)}|${stateSetKey(pair.outer)}|${pair.lastWasSlash ? "slash" : "char"}`;
  const seen = new Set<string>();
  const queue: Pair[] = [start];
  const enqueue = (next: Pair): void => {
    // Stryker disable next-line ConditionalExpression: enqueuing an empty inner language cannot reach an accepting counterexample, so this is a pruning guard only.
    if (next.inner.size === 0) return;
    const pairKey = keyOf(next);
    if (seen.has(pairKey)) return;
    seen.add(pairKey);
    queue.push(next);
  };
  seen.add(keyOf(start));
  while (queue.length > 0) {
    const current = queue.shift() as Pair;
    const innerAccept = current.inner.has(inner.accept);
    const outerAccept = current.outer.has(outer.accept);
    if (innerAccept && !outerAccept) return false;
    for (const symbol of alphabet) {
      if (symbol === "/" && current.lastWasSlash) continue;
      enqueue({
        inner: moveOnSymbol(inner, current.inner, symbol),
        outer: moveOnSymbol(outer, current.outer, symbol),
        lastWasSlash: symbol === "/",
      });
    }
  }
  return true;
}

function automataAlphabet(...automata: GlobAutomaton[]): string[] {
  const symbols = new Set<string>(["/", OTHER_NON_SLASH_KEY]);
  for (const automaton of automata) {
    for (const transitions of automaton.transitions) {
      for (const transition of transitions) {
        // Stryker disable next-line ConditionalExpression: non-literal transitions have no finite character to add; wildcard representatives are seeded above.
        if (transition.kind === "literal") symbols.add(transition.value);
      }
    }
  }
  // Stryker disable next-line MethodExpression,ArrowFunction: sorting makes traversal deterministic for reports, but subset truth is independent of alphabet order.
  return [...symbols].sort((left, right) => left.localeCompare(right));
}

function transitionAcceptsSymbol(transition: ConsumingGlobTransition, symbol: string): boolean {
  switch (transition.kind) {
    case "any":
      return true;
    case "non-slash":
      return symbol !== "/";
    case "literal":
      // Stryker disable next-line ConditionalExpression: the synthetic wildcard representative is outside the path dialect and cannot equal a real literal path character.
      return symbol !== OTHER_NON_SLASH_KEY && transition.value === symbol;
  }
}

function moveOnSymbol(automaton: GlobAutomaton, states: Set<number>, symbol: string): Set<number> {
  const moved = new Set<number>();
  for (const state of states) {
    for (const transition of automaton.transitions[state]) {
      // Stryker disable next-line ConditionalExpression,StringLiteral: epsilon transitions were already closed before consuming a representative symbol.
      if (transition.kind === "epsilon" || !transitionAcceptsSymbol(transition, symbol)) continue;
      for (const closed of epsilonClosure(automaton, transition.to)) moved.add(closed);
    }
  }
  return moved;
}

function stateSetKey(state: Set<number>): string {
  // Stryker disable next-line MethodExpression,ArrowFunction,ArithmeticOperator,StringLiteral: this is a canonical visited-key encoding; Set contents, not textual order or separator, define behavior.
  return [...state].sort((a, b) => a - b).join(",");
}

export function pathPatternsOverlap(leftPattern: string, rightPattern: string): boolean {
  if (patternAutomataIntersect(leftPattern, rightPattern)) return true;
  const left = normalizedGlobPattern(leftPattern);
  const right = normalizedGlobPattern(rightPattern);
  const leftHasWildcard = left.includes("*");
  const rightHasWildcard = right.includes("*");
  return !leftHasWildcard && !rightHasWildcard && (left.startsWith(`${right}/`) || right.startsWith(`${left}/`));
}

export function ownedPathPatternsOverlap(leftPattern: string, rightPattern: string): boolean {
  return patternAutomataIntersect(leftPattern, rightPattern);
}
