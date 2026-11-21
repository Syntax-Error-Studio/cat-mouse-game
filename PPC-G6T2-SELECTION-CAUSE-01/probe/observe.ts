/**
 * PPC-G6T2-SELECTION-CAUSE-01 / G2 — observation sink for the ISOLATED copy of
 * the production search (probe/expectiminimax_observed.ts).
 *
 * OBSERVE ONLY. The hooks are module-level and inert unless `observationBegin()`
 * has been called, so the copied search's control flow and arithmetic are
 * unchanged. The parity gate (D2_INSTRUMENTATION_PARITY.json) proves the copied
 * search still reproduces the frozen D2 numbers exactly.
 */

export interface ObservedAction {
  label: string;
  type: string;
  direction: string | null;
  r: number | null;
  c: number | null;
  originalIndex: number;
  value: number;
  mate: string | null;
  bound: string;
  completed: boolean;
  cacheable: boolean;
}

export interface ObservedNode {
  key: string;
  depthTurns: number;
  ply: number;
  actions: ObservedAction[];
  choiceLabel: string | null;
  choiceOriginalIndex: number | null;
  resultValue: number | null;
  resultMate: string | null;
  resultBound: string | null;
}

const DIR_LABEL: Record<string, string> = {
  ArrowUp: 'U', ArrowDown: 'D', ArrowLeft: 'L', ArrowRight: 'R',
};

function labelOf(a: { type: string; direction?: { key?: string }; r?: number; c?: number }): string {
  switch (a.type) {
    case 'catPlaceTrap': return 'T';
    case 'mouseSkill': return 'S';
    case 'chooseTunnel': return `t${a.r},${a.c}`;
    default: return DIR_LABEL[a.direction?.key ?? ''] ?? '?';
  }
}

let active = false;
let nodes: Map<string, ObservedNode[]> = new Map();

export function observationBegin(): void {
  active = true;
  nodes = new Map();
}

export function observationEnd(): { active: false; nodeCount: number; nodes: ObservedNode[] } {
  active = false;
  const out: ObservedNode[] = [];
  for (const arr of nodes.values()) out.push(...arr);
  return { active: false, nodeCount: out.length, nodes: out };
}

export function observationSnapshot(): ObservedNode[] {
  const out: ObservedNode[] = [];
  for (const arr of nodes.values()) out.push(...arr);
  return out;
}

function nodeFor(key: string, depthTurns: number, ply: number): ObservedNode {
  let arr = nodes.get(key);
  if (!arr) { arr = []; nodes.set(key, arr); }
  let n = arr.find((x) => x.depthTurns === depthTurns && x.ply === ply);
  if (!n) {
    n = {
      key, depthTurns, ply, actions: [],
      choiceLabel: null, choiceOriginalIndex: null,
      resultValue: null, resultMate: null, resultBound: null,
    };
    arr.push(n);
  }
  return n;
}

export function observeCandidate(
  key: string, depthTurns: number, ply: number,
  action: { type: string; direction?: { key?: string }; r?: number; c?: number },
  originalIndex: number,
  candidate: { value: number; mate: string | null; bound: string; completed: boolean; cacheable: boolean },
): void {
  if (!active) return;
  const n = nodeFor(key, depthTurns, ply);
  n.actions.push({
    label: labelOf(action),
    type: action.type,
    direction: action.direction?.key ?? null,
    r: action.r ?? null,
    c: action.c ?? null,
    originalIndex,
    value: candidate.value,
    mate: candidate.mate,
    bound: candidate.bound,
    completed: candidate.completed,
    cacheable: candidate.cacheable,
  });
}

export function observeChoice(
  key: string, depthTurns: number, ply: number,
  bestAction: { type: string; direction?: { key?: string }; r?: number; c?: number } | null,
  result: { value: number; mate: string | null; bound: string },
): void {
  if (!active) return;
  const n = nodeFor(key, depthTurns, ply);
  n.choiceLabel = bestAction ? labelOf(bestAction) : null;
  if (bestAction) {
    const hit = n.actions.find((a) => a.label === n.choiceLabel && a.type === bestAction.type);
    n.choiceOriginalIndex = hit ? hit.originalIndex : null;
  }
  n.resultValue = result.value;
  n.resultMate = result.mate;
  n.resultBound = result.bound;
}