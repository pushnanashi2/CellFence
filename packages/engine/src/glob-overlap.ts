import { normalizePath } from "./file-index.js";

type GlobTransition =
  | { kind: "epsilon"; to: number }
  | { kind: "any"; to: number }
  | { kind: "non-slash"; to: number }
  | { kind: "literal"; to: number; value: string };

type GlobAutomaton = {
  accept: number;
  transitions: GlobTransition[][];
};

function patternAutomaton(pattern: string): GlobAutomaton {
  const normalized = normalizePath(pattern);
  const transitions: GlobTransition[][] = [[]];
  let state = 0;
  const nextState = (): number => {
    transitions.push([]);
    return transitions.length - 1;
  };
  for (let index = 0; index < normalized.length; index += 1) {
    const character = normalized[index];
    const nextCharacter = normalized[index + 1];
    if (character === "*" && nextCharacter === "*") {
      const next = nextState();
      transitions[state].push({ kind: "epsilon", to: next });
      transitions[state].push({ kind: "any", to: state });
      state = next;
      index += 1;
    } else if (character === "*") {
      const next = nextState();
      transitions[state].push({ kind: "epsilon", to: next });
      transitions[state].push({ kind: "non-slash", to: state });
      state = next;
    } else {
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
    const current = stack.pop();
    if (current === undefined) continue;
    for (const transition of automaton.transitions[current] || []) {
      if (transition.kind !== "epsilon" || closure.has(transition.to)) continue;
      closure.add(transition.to);
      stack.push(transition.to);
    }
  }
  return closure;
}

function transitionLabelsIntersect(left: GlobTransition, right: GlobTransition): boolean {
  if (left.kind === "epsilon" || right.kind === "epsilon") return false;
  if (left.kind === "any" || right.kind === "any") return true;
  if (left.kind === "non-slash" && right.kind === "non-slash") return true;
  if (left.kind === "non-slash" && right.kind === "literal") return right.value !== "/";
  if (right.kind === "non-slash" && left.kind === "literal") return left.value !== "/";
  return left.kind === "literal" && right.kind === "literal" && left.value === right.value;
}

function patternAutomataIntersect(leftPattern: string, rightPattern: string): boolean {
  const left = patternAutomaton(leftPattern);
  const right = patternAutomaton(rightPattern);
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
    for (const leftTransition of left.transitions[leftState] || []) {
      if (leftTransition.kind === "epsilon") continue;
      for (const rightTransition of right.transitions[rightState] || []) {
        if (!transitionLabelsIntersect(leftTransition, rightTransition)) continue;
        enqueueClosures(leftTransition.to, rightTransition.to);
      }
    }
  }
  return false;
}

export function pathPatternsOverlap(leftPattern: string, rightPattern: string): boolean {
  if (patternAutomataIntersect(leftPattern, rightPattern)) return true;
  const left = normalizePath(leftPattern);
  const right = normalizePath(rightPattern);
  const leftHasWildcard = left.includes("*");
  const rightHasWildcard = right.includes("*");
  return !leftHasWildcard && !rightHasWildcard && (left.startsWith(`${right}/`) || right.startsWith(`${left}/`));
}

export function ownedPathPatternsOverlap(leftPattern: string, rightPattern: string): boolean {
  return patternAutomataIntersect(leftPattern, rightPattern);
}
