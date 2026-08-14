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


// B-04 review fix: the previous `patternCoveredByOwnedPaths`
// only used a literal-prefix heuristic, which produced
// false-positive containment (e.g. "src/api/v1*" reported
// as covered by "src/api/**" even though "src/api/v1" is
// not a member of L("src/api/**")). The 0.4.x fix replaces
// the heuristic with a formal language-containment check:
// build two DFAs from the NFA, walk the product automaton,
// and report false the first time a state is reached where
// the inner DFA is in an accept state and the outer DFA is
// not.
//
// The DFA stores only REAL transitions (those that come
// from the NFA->DFA subset construction). The trap state
// is added explicitly with self-loops on the real alphabet
// so it is reachable and distinguishable. When the product
// BFS encounters an inner transition whose key is missing
// in the outer at the current state, the BFS falls back to
// the most general class that subsumes the inner key
// (priority: literal > non-slash (when the literal is not
// "/") > any). This preserves the DFA's "most specific
// match wins" semantics without polluting the DFA with
// trap transitions that would shadow the broader classes.

export function pathPatternSubset(innerPattern: string, outerPattern: string): boolean {
  const innerDfa = buildDfa(patternAutomaton(innerPattern));
  const outerDfa = buildDfa(patternAutomaton(outerPattern));
  type Pair = { inner: number; outer: number };
  const start: Pair = { inner: innerDfa.start, outer: outerDfa.start };
  const keyOf = (pair: Pair): string => `${pair.inner}|${pair.outer}`;
  const seen = new Set<string>([keyOf(start)]);
  const queue: Pair[] = [start];
  const enqueue = (next: Pair): void => {
    const pairKey = keyOf(next);
    if (seen.has(pairKey)) return;
    seen.add(pairKey);
    queue.push(next);
  };
  while (queue.length > 0) {
    const current = queue.shift() as Pair;
    const innerAccept = innerDfa.acceptSet.has(current.inner);
    const outerAccept = outerDfa.acceptSet.has(current.outer);
    if (innerAccept && !outerAccept) return false;
    if (current.outer === outerDfa.trap) {
      // The outer is already in the trap: any input keeps
      // it there, so the product state is always
      // (innerNext, trap). This drives the inner DFA
      // forward and lets us detect a counter-example
      // exactly when the inner reaches accept.
      for (const [, innerNext] of innerDfa.transitions[current.inner].entries()) {
        enqueue({ inner: innerNext, outer: outerDfa.trap });
      }
      continue;
    }
    const outerTransitions = outerDfa.transitions[current.outer];
    for (const [innerKey, innerNext] of innerDfa.transitions[current.inner].entries()) {
      const outerNext = resolveOuterTransition(outerTransitions, innerKey, outerDfa.trap);
      enqueue({ inner: innerNext, outer: outerNext });
    }
  }
  return true;
}

function resolveOuterTransition(
  outerTransitions: Map<string, number>,
  innerKey: string,
  trap: number,
): number {
  // Priority: literal match > non-slash (when the input is
  // not "/") > any. A literal "/" can only be matched by a
  // literal "/" or an `any`; `non-slash` rejects "/".
  if (outerTransitions.has(innerKey)) {
    return outerTransitions.get(innerKey) as number;
  }
  if (innerKey === ANY_KEY) {
    return trap;
  }
  if (innerKey === NON_SLASH_KEY) {
    return outerTransitions.has(ANY_KEY) ? (outerTransitions.get(ANY_KEY) as number) : trap;
  }
  if (innerKey === "/") {
    return outerTransitions.has(ANY_KEY) ? (outerTransitions.get(ANY_KEY) as number) : trap;
  }
  if (outerTransitions.has(NON_SLASH_KEY)) {
    return outerTransitions.get(NON_SLASH_KEY) as number;
  }
  if (outerTransitions.has(ANY_KEY)) {
    return outerTransitions.get(ANY_KEY) as number;
  }
  return trap;
}

type CompleteDfa = {
  acceptSet: Set<number>;
  start: number;
  /**
   * Index of the trap (dead) state. The trap has self-
   * loops on every real key, so the product BFS can use
   * it as a "reject" sink.
   */
  trap: number;
  // transitions[state] maps a character class to a target
  // state. Only REAL transitions are stored; the trap
  // state has self-loops on every real key, but no other
  // state is completed. This way the product BFS can
  // detect "outer has no transition for this key" and
  // fall back to the most general class that subsumes it
  // (literal > non-slash > any).
  transitions: Array<Map<string, number>>;
};

const ANY_KEY = "\u0000__cellfence_any__";
const NON_SLASH_KEY = "\u0000__cellfence_non_slash__";

function buildDfa(automaton: GlobAutomaton): CompleteDfa {
  // Subset-construct the DFA from the NFA, then add a
  // single explicit trap state with self-loops on every
  // real key. The trap is the only state whose
  // transitions are added by the completion step; the
  // other states keep their NFA-derived transitions so
  // the product BFS can query the real alphabet.
  const raw = nfaToDfa(automaton);
  const acceptSet = new Set<number>();
  for (let i = 0; i < raw.states.length; i += 1) {
    if (raw.states[i].has(automaton.accept)) acceptSet.add(i);
  }
  const trap = raw.states.length;
  const transitions: Array<Map<string, number>> = raw.transitions.map((t) => new Map(t));
  const allKeys = new Set<string>();
  for (const t of transitions) {
    for (const key of t.keys()) allKeys.add(key);
  }
  transitions.push(new Map());
  for (const key of allKeys) {
    transitions[trap].set(key, trap);
  }
  return {
    acceptSet,
    start: raw.start,
    trap,
    transitions,
  };
}

type DfaState = Set<number>;

type Dfa = {
  accept: number;
  states: DfaState[];
  transitions: Array<Map<string, number>>;
  start: number;
};

function nfaToDfa(automaton: GlobAutomaton): Dfa {
  const startClosure = epsilonClosure(automaton, 0);
  const stateIndex = new Map<string, number>();
  const stateList: DfaState[] = [];
  const transitions: Array<Map<string, number>> = [];
  const queue: DfaState[] = [startClosure];
  const addState = (state: DfaState): number => {
    const key = dfaStateKey(state);
    const existing = stateIndex.get(key);
    if (existing !== undefined) return existing;
    const index = stateList.length;
    stateIndex.set(key, index);
    stateList.push(state);
    transitions.push(new Map());
    return index;
  };
  addState(startClosure);
  const processed = new Set<string>();
  while (queue.length > 0) {
    const current = queue.shift() as DfaState;
    const currentKey = dfaStateKey(current);
    if (processed.has(currentKey)) continue;
    processed.add(currentKey);
    const currentIndex = stateIndex.get(currentKey) as number;
    const literalTargets = new Map<string, Set<number>>();
    const anyTargets = new Set<number>();
    const nonSlashTargets = new Set<number>();
    for (const nfaState of current) {
      for (const transition of automaton.transitions[nfaState]) {
        if (transition.kind === "epsilon") continue;
        const targetClosure = epsilonClosure(automaton, transition.to);
        if (transition.kind === "any") {
          for (const t of targetClosure) anyTargets.add(t);
        } else if (transition.kind === "non-slash") {
          for (const t of targetClosure) nonSlashTargets.add(t);
        } else {
          const existing = literalTargets.get(transition.value) ?? new Set<number>();
          for (const t of targetClosure) existing.add(t);
          literalTargets.set(transition.value, existing);
        }
      }
    }
    const wireTransition = (key: string, targets: Set<number>): void => {
      if (targets.size === 0) return;
      const next = addState(targets);
      if (transitions[currentIndex].get(key) !== next) {
        transitions[currentIndex].set(key, next);
      }
    };
    wireTransition(ANY_KEY, anyTargets);
    wireTransition(NON_SLASH_KEY, nonSlashTargets);
    for (const [value, targets] of literalTargets) {
      wireTransition(value, targets);
    }
    for (const nextIndex of transitions[currentIndex].values()) {
      const nextState = stateList[nextIndex];
      // B-04 review fix: enqueue the next state if it has
      // not been processed yet. addState registers it in
      // stateIndex immediately, so the previous
      // `!stateIndex.has(...)` check never matched and the
      // BFS only processed the start state.
      if (!processed.has(dfaStateKey(nextState))) queue.push(nextState);
    }
  }
  const acceptIndex = stateList.findIndex((state) => state.has(automaton.accept));
  return {
    accept: acceptIndex,
    states: stateList,
    transitions,
    start: 0,
  };
}

function dfaStateKey(state: DfaState): string {
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
