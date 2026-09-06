/**
 * ============================================================================
 * G0.3K — Exact Turn-Boundary Search Prototype.
 *
 * FORENSIC / PROTOTYPE ONLY. NOT wired into production. Does NOT replace the
 * atomic-action search in expectiminimax.ts.
 *
 * GOAL: prove that searching at turn boundaries (one search level per real
 * player switch) yields EXACTLY the same primary search truth as the current
 * atomic-action search, while dramatically reducing node count.
 *
 * DESIGN (audit-driven):
 *   A. CHANCE nodes are preserved INSIDE the macro turn (mouse eats butter →
 *      stochastic respawn → mouse continues DECISION on the resolved outcome).
 *      The DAG is therefore a compressed within-turn DAG, NOT a flat list of
 *      boundary states: DECISION → CHANCE → DECISION structure is kept, so a
 *      chance outcome can NEVER be misread as a MIN (mouse) choice.
 *   B. mateActionCost identity: a boundary state reachable via different
 *      cumulative mate costs is NOT merged. Dedup identity is
 *      `stateKey # cumulativeCost`, matching the existing mate-distance
 *      stepping (catStep=1, mouseStep=1, catPlaceTrap=0, mouseSkill=0,
 *      chooseTunnel=0).
 *   C. repetition semantics: the atomic search's `path` is a recursion stack
 *      of game-affecting stateKeys. After a turn switch, the PREVIOUS turn's
 *      atomic states remain on the path (their recursion frames have not
 *      returned). BUT `stateKey` includes `currentPlayer`, so a state from
 *      the cat turn can NEVER be re-visited during the following mouse turn
 *      (different currentPlayer ⇒ different stateKey). Same-actor re-visits
 *      of earlier macro turns are only possible at depth ≥ 3 (cat→mouse→cat).
 *      For the d1/d2 truth gate in G0.3K this is therefore vacuously safe;
 *      G0.3J additionally measured reps=0 on all 26 roots. The DAG still
 *      carries ancestorClosure for the future d3+ repetition context.
 *   D. TERMINAL mid-turn: a terminal (cat capture / mouse reaches hole) is
 *      recorded AT THE POINT IT OCCURS and ends that path immediately — the
 *      macro turn is NOT force-completed.
 *   E. Immediate turn-ending rules (mouse trap step, tunnel exit) become
 *      genuine TURN_BOUNDARY nodes.
 *
 * The prototype exposes:
 *   1. enumerateFullTurnLegacy(root) — ORACLE: raw atomic sequence frontier.
 *   2. buildTurnDag(root) — compressed within-turn DAG.
 *   3. compareFrontiers(root) — DAG frontier vs legacy frontier equivalence.
 *   4. searchTurnBoundary(state, depthTurns, rules, opts) — turn-boundary
 *      search truth-gate (value/mate/completed), verified against the atomic
 *      search. NO alpha-beta yet (phase-1 value-only gate); chance semantics,
 *      mate-distance stepping, and terminal scores are preserved.
 *
 * Not implemented (per G0.3K scope): G0.3A/G0.3E plan-witness integration
 * (value-only phase 1), chance approximation, beam search, selective
 * deepening, heuristic pruning, AB in the DAG resolver. No evaluator changes.
 * ============================================================================
 */
import type { GameEngineState } from '../engine';
import { GamePhase, PieceType } from '../types';
import type { RuleSet, SearchAction } from './searchTypes';
import { generateLegalSearchActions } from './legalActions';
import { simulateSearchAction } from './simulator';
import { stateKey } from './transposition';
import { mateActionCost, MATE_SCORE, defaultLeafEval, type MateSide } from './expectiminimax';

// ---------------------------------------------------------------------------
// Turn DAG node types
// ---------------------------------------------------------------------------

export type TurnDagNodeType = 'DECISION' | 'CHANCE' | 'TURN_BOUNDARY' | 'TERMINAL';

/**
 * One node of the compressed within-turn DAG.
 *
 * A node is uniquely identified by `nodeKey = stateKey(state) # cumulativeCost`
 * — the game-affecting state plus the real game-time cost accumulated from the
 * macro-turn root. Set-typed fields (butterPositions, blockedTunnels, ...) are
 * canonicalized inside stateKey, so two paths reaching the same game-affecting
 * state with the same cost merge into one node (audit B).
 */
export interface TurnDagNode {
  id: number;
  type: TurnDagNodeType;
  state: GameEngineState;
  cumulativeCost: number;
  nodeKey: string; // `${stateKey(state)}\x00${cumulativeCost}`
  depth: number; // atomic-action depth from turn root
  /** sum of chance weights along the path(s) to this node. */
  probability: number;
  /** True when at least one chance outcome sits on a path to this node. */
  hasChance: boolean;
  /** Child edges. For DECISION: one per legal action (action != null, weight=1).
   *  For CHANCE: one per outcome (action=null, weight=outcome weight). */
  children: { action: SearchAction | null; weight: number; toId: number }[];
  /** Witness: one atomic-action sequence from the turn root to THIS node. */
  witness: SearchAction[];
  /** Union of stateKeys on ANY path from the turn root to this node (repetition
   *  context; audit C — conservative, unused at d1/d2). */
  ancestorClosure: Set<string>;
}

export interface TurnDag {
  rootId: number;
  nodes: Map<number, TurnDagNode>;
  nodeKeyIndex: Map<string, number>; // nodeKey -> node id (dedup)
  dagNodes: number;
  uniqueDecisionStates: number;
  uniqueChanceStates: number;
  uniqueBoundaries: number;
  terminals: number;
  /** From the legacy enumerator (same fixture): raw atomic action sequences. */
  rawAtomicPaths: number;
  /** compression = rawAtomicPaths / uniqueBoundaries (higher = better). */
  compressionRatio: number;
}

// ---------------------------------------------------------------------------
// LEGACY ORACLE — raw atomic full-turn exhaustive enumeration
// (identical algorithm to the G0.3J enumerator; no dedup, no minimax).
// ---------------------------------------------------------------------------

export interface FrontierEntry {
  type: 'TERMINAL' | 'TURN_BOUNDARY';
  state: GameEngineState;
  cumulativeCost: number;
  standardKey: string; // stateKey (game-affecting identity)
  probability: number; // product of chance weights along this ONE path
  witness: SearchAction[]; // exact atomic sequence that reached this entry
}

export interface LegacyEnumeration {
  rawAtomicPaths: number;
  terminals: FrontierEntry[];
  boundaries: FrontierEntry[];
  expandedStateKeys: Set<string>;
  /** Distinct (type, stateKey, cumulativeCost) frontier signatures. */
  frontierSignatures: Set<string>;
}

/**
 * Enumerate EVERY raw atomic action sequence of the current actor's full turn.
 * Stops at first player switch (TURN_BOUNDARY) or terminal (TERMINAL),
 * mirroring the engine's forced turn hand-off. Chance outcomes are enumerated
 * one-per-weight. Each complete sequence counts once into `rawAtomicPaths`.
 */
export function enumerateFullTurnLegacy(root: GameEngineState, rules: RuleSet): LegacyEnumeration {
  const out: LegacyEnumeration = {
    rawAtomicPaths: 0,
    terminals: [],
    boundaries: [],
    expandedStateKeys: new Set(),
    frontierSignatures: new Set(),
  };
  interface Q { state: GameEngineState; cost: number; prob: number; witness: SearchAction[]; }
  const queue: Q[] = [{ state: root, cost: 0, prob: 1, witness: [] }];
  while (queue.length > 0) {
    const cur = queue.shift()!;
    out.expandedStateKeys.add(stateKey(cur.state));
    const actions = generateLegalSearchActions(cur.state, rules);
    if (actions.length === 0) {
      // No legal actions: the atomic search evaluates this state (leaf).
      // It is not a frontier entry and not a completed sequence.
      continue;
    }
    for (const action of actions) {
      const trans = simulateSearchAction(cur.state, action, rules);
      const edgeCost = mateActionCost(action);
      const handle = (next: GameEngineState, weight: number) => {
        const switched = cur.state.currentPlayer !== next.currentPlayer;
        const terminal = next.phase === GamePhase.CatWins || next.phase === GamePhase.MouseWins;
        if (terminal) {
          const e: FrontierEntry = {
            type: 'TERMINAL', state: next, cumulativeCost: cur.cost + edgeCost,
            standardKey: stateKey(next), probability: cur.prob * weight, witness: [...cur.witness, action],
          };
          out.terminals.push(e);
          out.frontierSignatures.add(`TERMINAL\x00${e.standardKey}\x00${e.cumulativeCost}`);
          out.rawAtomicPaths++;
        } else if (switched) {
          const e: FrontierEntry = {
            type: 'TURN_BOUNDARY', state: next, cumulativeCost: cur.cost + edgeCost,
            standardKey: stateKey(next), probability: cur.prob * weight, witness: [...cur.witness, action],
          };
          out.boundaries.push(e);
          out.frontierSignatures.add(`BOUNDARY\x00${e.standardKey}\x00${e.cumulativeCost}`);
          out.rawAtomicPaths++;
        } else {
          // Same actor continues (mouse after butter pickup / skill / etc.)
          queue.push({ state: next, cost: cur.cost + edgeCost, prob: cur.prob * weight, witness: [...cur.witness, action] });
        }
      };
      if (trans.kind === 'chance') {
        for (const o of trans.outcomes) handle(o.state, o.weight);
      } else {
        handle(trans.state, 1);
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// buildTurnDag — compressed within-turn DAG
// ---------------------------------------------------------------------------

function sigOf(state: GameEngineState, cost: number): string {
  return `${stateKey(state)}\x00${cost}`;
}

/**
 * Build the compressed within-turn DAG from `state`.
 *
 * Dedup identity: `${stateKey}\x00${cumulativeCost}` (audit B). CHANCE nodes
 * are first-class (audit A). Terminals recorded where they occur (audit D).
 * Player switch → TURN_BOUNDARY (audit E). Legal-action exhaustion inside a
 * turn → the DECISION node keeps zero children; the search resolves it as a
 * leaf eval (matching the atomic search's RULE_EDGE_CASE_NO_LEGAL_ACTIONS).
 */
export function buildTurnDag(root: GameEngineState, rules: RuleSet, legacy?: LegacyEnumeration): TurnDag {
  const nodes = new Map<number, TurnDagNode>();
  const nodeKeyIndex = new Map<string, number>();
  /** incoming edges (fromId, weight) for post-hoc probability propagation. */
  const incoming: Map<number, { fromId: number; weight: number }[]> = new Map();
  let nextId = 0;

  const addNode = (
    type: TurnDagNodeType,
    state: GameEngineState,
    cost: number,
    depth: number,
    prob: number,
    hasChance: boolean,
    witness: SearchAction[],
    closure: Set<string>,
    customKey?: string,
  ): TurnDagNode => {
    // NOTE: nodeKey must uniquely identify the node. For most nodes that is
    // `stateKey#cost`; a CHANCE node is identified by
    // `stateKey#cost#actionSignature` so that two different stochastic forks
    // (different eaten-butter actions with different outcome pools) never
    // merge, AND so a CHANCE node never collides with the parent DECISION
    // node that has the SAME stateKey#cost.
    const key = customKey ?? sigOf(state, cost);
    const existing = nodeKeyIndex.get(key);
    if (existing !== undefined) {
      const n = nodes.get(existing)!;
      // Merge: union the ancestor closures so repetition stays conservative.
      // Keep the SHORTEST witness (state+cost identical, any witness valid).
      for (const a of closure) n.ancestorClosure.add(a);
      if (witness.length < n.witness.length) n.witness = witness;
      n.probability += prob; // accumulate reachability probability
      return n;
    }
    const id = nextId++;
    const node: TurnDagNode = {
      id, type, state, cumulativeCost: cost, nodeKey: key, depth,
      probability: prob, hasChance, children: [], witness, ancestorClosure: new Set(closure),
    };
    nodes.set(id, node);
    nodeKeyIndex.set(key, id);
    incoming.set(id, []);
    return node;
  };

  /** Record an incoming edge for post-hoc probability propagation. */
  const addIncoming = (toId: number, fromId: number, weight: number): void => {
    const list = incoming.get(toId);
    if (list) list.push({ fromId, weight });
  };

  const rootClosure = new Set<string>([stateKey(root)]);
  const rootNode = addNode('DECISION', root, 0, 0, 1, false, [], rootClosure);
  const dag: TurnDag = {
    rootId: rootNode.id, nodes, nodeKeyIndex,
    dagNodes: 0, uniqueDecisionStates: 0, uniqueChanceStates: 0,
    uniqueBoundaries: 0, terminals: 0, rawAtomicPaths: 0, compressionRatio: 0,
  };

  // expand one DECISION node: generate its children.
  const expandDecision = (node: TurnDagNode): void => {
    if (node.type !== 'DECISION' || node.children.length > 0) return;
    const state = node.state;
    const actions = generateLegalSearchActions(state, rules);
    if (actions.length === 0) return; // leaf-eval boundary (no children)

    for (const action of actions) {
      const trans = simulateSearchAction(state, action, rules);
      const edgeCost = mateActionCost(action);
      const cost = node.cumulativeCost + edgeCost;
      const childWitness = [...node.witness, action];

      if (trans.kind === 'chance') {
        // CHANCE node keyed by (parent state, parent cost, ACTION) — the same
        // state can trigger butter respawn via DIFFERENT mouseStep actions with
        // DIFFERENT outcome pools (the eaten butter cell differs → the legal
        // respawn set differs). Merging on (state,cost) alone would mix
        // outcome pools across actions, which is wrong. The action signature
        // keeps each stochastic fork separate.
        const chanceKey = `${sigOf(state, node.cumulativeCost)}\x00A\x00${action.type}${action.type === 'mouseStep' ? action.direction.key : ''}`;
        let chanceId = nodeKeyIndex.get(chanceKey);
        if (chanceId === undefined) {
          const c = addNode('CHANCE', state, node.cumulativeCost, node.depth, node.probability, true, node.witness, node.ancestorClosure, chanceKey);
          chanceId = c.id;
        }
        const chance = nodes.get(chanceId)!;
        node.children.push({ action, weight: 1, toId: chanceId });
        addIncoming(chanceId, node.id, 1);
        // Deduplicate outcome states within THIS action's chance pool (the
        // legacy enumerator keeps one per outcome; equal outcome states with
        // the same cost + weight-fold merge into one DAG child).
        const outcomeById = new Map<string, { next: GameEngineState; weight: number }>();
        for (const o of trans.outcomes) {
          const next = o.state;
          const switched = state.currentPlayer !== next.currentPlayer;
          const terminal = next.phase === GamePhase.CatWins || next.phase === GamePhase.MouseWins;
          const key = `${terminal ? 'T' : switched ? 'B' : 'D'}\x00${sigOf(next, cost)}`;
          const prev = outcomeById.get(key);
          if (prev) prev.weight += o.weight;
          else outcomeById.set(key, { next, weight: o.weight });
        }
        for (const { next, weight } of outcomeById.values()) {
          const switched = state.currentPlayer !== next.currentPlayer;
          const terminal = next.phase === GamePhase.CatWins || next.phase === GamePhase.MouseWins;
          const closure = new Set<string>([...node.ancestorClosure, stateKey(next)]);
          const w = [...childWitness];
          let target: TurnDagNode;
          if (terminal) {
            target = addNode('TERMINAL', next, cost, node.depth + 1, node.probability * weight, true, w, closure);
          } else if (switched) {
            target = addNode('TURN_BOUNDARY', next, cost, node.depth + 1, node.probability * weight, true, w, closure);
          } else {
            target = addNode('DECISION', next, cost, node.depth + 1, node.probability * weight, true, w, closure);
          }
          chance.children.push({ action: null, weight, toId: target.id });
          addIncoming(target.id, chance.id, weight);
        }
      } else {
        const next = trans.state;
        const switched = state.currentPlayer !== next.currentPlayer;
        const terminal = next.phase === GamePhase.CatWins || next.phase === GamePhase.MouseWins;
        const closure = new Set<string>([...node.ancestorClosure, stateKey(next)]);
        let target: TurnDagNode;
        if (terminal) {
          target = addNode('TERMINAL', next, cost, node.depth + 1, node.probability, node.hasChance, childWitness, closure);
        } else if (switched) {
          target = addNode('TURN_BOUNDARY', next, cost, node.depth + 1, node.probability, node.hasChance, childWitness, closure);
        } else {
          target = addNode('DECISION', next, cost, node.depth + 1, node.probability, node.hasChance, childWitness, closure);
        }
        node.children.push({ action, weight: 1, toId: target.id });
        addIncoming(target.id, node.id, 1);
      }
    }
  };

  // Post-hoc probability propagation: a node may be merged by multiple parent
  // paths AFTER its children were generated on first expansion. Recompute each
  // node's probability as the sum over its incoming edges of
  // parent.probability × edge.weight — the true DAG reachability probability.
  // (The atomic-search value semantics do NOT depend on this; it only makes
  // the DAG frontier's probability report match the legacy oracle.)
  // Topological order by depth is valid: nodeKey includes cumulativeCost
  // which is monotonic non-decreasing along edges, so no cycles exist
  // (a same-actor echo would need cost to decrease, impossible).
  const worklist: number[] = [rootNode.id];
  while (worklist.length > 0 && worklist.length < 1_000_000) {
    const id = worklist.shift()!;
    const node = nodes.get(id)!;
    if (node.type === 'DECISION') {
      if (node.children.length === 0) expandDecision(node); // expand exactly once when unexpanded
      for (const c of node.children) {
        const child = nodes.get(c.toId)!;
        if (child.type === 'DECISION' && child.children.length === 0) worklist.push(child.id);
        else if (child.type === 'CHANCE') {
          for (const cc of child.children) {
            const gc = nodes.get(cc.toId)!;
            if (gc.type === 'DECISION' && gc.children.length === 0) worklist.push(gc.id);
          }
        }
      }
    }
  }

  // Post-hoc probability propagation: a node may be merged by multiple parent
  // paths AFTER its children were generated on first expansion. Recompute each
  // node's probability as the sum over its incoming edges of
  // parent.probability × edge.weight — the true DAG reachability probability.
  //
  // ORDERING: 0-cost edges (mouseSkill / catPlaceTrap / chooseTunnel) create
  // dependencies BETWEEN nodes at the SAME cumulativeCost, so sorting by cost
  // is NOT a valid topological order. Use Kahn's algorithm on the incoming
  // edges instead (the DAG is acyclic: every edge strictly changes the
  // game-affecting state, and nodeKey = stateKey#cost uniquely identifies it,
  // so revisiting a node means merging, not a cycle; a cycle would need a
  // closed walk returning to the exact same (state,cost), which the recursive
  // atomic search's repetition guard also forbids).
  {
    // indegree = number of DISTINCT incoming parent nodes (a parent may push
    // several edges into the same child when chance outcomes merge; they still
    // count as one "parent"), so dedupe by fromId.
    const indeg = new Map<number, number>();
    for (const n of nodes.values()) {
      const parents = new Set((incoming.get(n.id) ?? []).map(e => e.fromId));
      indeg.set(n.id, parents.size);
    }
    const queue: number[] = [];
    for (const n of nodes.values()) if ((indeg.get(n.id) ?? 0) === 0) queue.push(n.id);
    const order: number[] = [];
    while (queue.length > 0) {
      const id = queue.shift()!;
      order.push(id);
      const n = nodes.get(id)!;
      // Dedupe children per node before decrementing (a parent may have
      // repeated edges to the same child).
      const childrenSet = new Set(n.children.map(e => e.toId));
      for (const toId of childrenSet) {
        const next = (indeg.get(toId) ?? 0) - 1;
        indeg.set(toId, next);
        if (next === 0) queue.push(toId);
      }
    }
    // If Kahn left nodes unvisited (defensive: cycle or missing edge), fall
    // back to iterating until fixpoint.
    const visited = new Set(order);
    if (visited.size < nodes.size) {
      // Defensive fixpoint: repeat propagation passes until no change.
      for (const n of nodes.values()) n.probability = 0;
      const rootN = nodes.get(rootNode.id)!;
      rootN.probability = 1;
      let changed = true;
      let guard = 0;
      while (changed && guard++ < 1000) {
        changed = false;
        for (const n of nodes.values()) {
          const sum = (incoming.get(n.id) ?? []).reduce((s, e) => {
            const p = nodes.get(e.fromId);
            return s + (p ? p.probability * e.weight : 0);
          }, 0);
          if (Math.abs(n.probability - sum) > 1e-12) { n.probability = sum; changed = true; }
        }
      }
    } else {
      // Zero all probabilities, then propagate along the topological order.
      for (const n of nodes.values()) n.probability = 0;
      const rootN = nodes.get(rootNode.id)!;
      rootN.probability = 1;
      for (const id of order) {
        const n = nodes.get(id)!;
        if (n.probability === 0) continue;
        for (const e of n.children) {
          const child = nodes.get(e.toId)!;
          child.probability += n.probability * e.weight;
        }
      }
    }
  }

  // Stats
  for (const n of nodes.values()) {
    if (n.type === 'DECISION') dag.uniqueDecisionStates++;
    else if (n.type === 'CHANCE') dag.uniqueChanceStates++;
    else if (n.type === 'TURN_BOUNDARY') dag.uniqueBoundaries++;
    else if (n.type === 'TERMINAL') dag.terminals++;
  }
  dag.dagNodes = nodes.size;
  dag.rawAtomicPaths = legacy ? legacy.rawAtomicPaths : countRawAtomic(root, rules);
  dag.compressionRatio = dag.uniqueBoundaries > 0 ? dag.rawAtomicPaths / dag.uniqueBoundaries : 0;
  return dag;
}

/** Count raw atomic sequences by running the legacy oracle. */
function countRawAtomic(root: GameEngineState, rules: RuleSet): number {
  return enumerateFullTurnLegacy(root, rules).rawAtomicPaths;
}

// ---------------------------------------------------------------------------
// Frontier equivalence
// ---------------------------------------------------------------------------

export interface FrontierComparison {
  legacy: LegacyEnumeration;
  dag: TurnDag;
  terminalSetMatch: boolean;
  boundarySetMatch: boolean;
  frontierSetMatch: boolean;
  probabilityMatch: boolean;
  legacyTotalProb: number;
  dagTotalProb: number;
  dagTerminalSigs: Set<string>;
  dagBoundarySigs: Set<string>;
}

/**
 * Compare the DAG's reachable frontier (terminals + boundaries, with
 * cumulative cost) against the legacy atomic enumerator's frontier.
 *
 * Because DAG dedup merges paths that reach the same (stateKey, cost), the
 * DAG frontier is a SET of (type, stateKey, cost); the legacy frontier is a
 * MULTISET (path-counted). The equivalence claim is: the DAG's reachable
 * frontier set EXACTLY equals the legacy's frontier set (every reachable
 * terminal/boundary with every reachable cost), and the total reachable
 * probability over full sequences is 1 in both.
 */
export function compareFrontiers(root: GameEngineState, rules: RuleSet): FrontierComparison {
  const legacy = enumerateFullTurnLegacy(root, rules);
  const dag = buildTurnDag(root, rules, legacy);

  const dagTerminalSigs = new Set<string>();
  const dagBoundarySigs = new Set<string>();
  const seen = new Set<number>();
  const walk = (id: number) => {
    if (seen.has(id)) return;
    seen.add(id);
    const n = dag.nodes.get(id)!;
    if (n.type === 'TERMINAL') {
      dagTerminalSigs.add(`TERMINAL\x00${n.nodeKey}`);
      return; // terminals are leaves
    }
    if (n.type === 'TURN_BOUNDARY') {
      dagBoundarySigs.add(`BOUNDARY\x00${n.nodeKey}`);
      return; // boundaries are leaves (recursion happens in the search)
    }
    for (const c of n.children) walk(c.toId);
  };
  walk(dag.rootId);

  let dagTotalProb = 0;
  for (const id of seen) {
    const n = dag.nodes.get(id)!;
    if (n.type === 'TERMINAL' || n.type === 'TURN_BOUNDARY') dagTotalProb += n.probability;
  }

  // Legacy set (dedupe the multiset to a set for comparison).
  const legacyTerminalSet = new Set<string>();
  for (const e of legacy.terminals) legacyTerminalSet.add(`TERMINAL\x00${e.standardKey}\x00${e.cumulativeCost}`);
  const legacyBoundarySet = new Set<string>();
  for (const e of legacy.boundaries) legacyBoundarySet.add(`BOUNDARY\x00${e.standardKey}\x00${e.cumulativeCost}`);

  const dagTerminalSet = new Set<string>();
  for (const s of dagTerminalSigs) {
    // s = "TERMINAL\x00<stateKey>\x00<cost>" — reappear in the same format.
    const inner = s.slice('TERMINAL\x00'.length);
    dagTerminalSet.add(`TERMINAL\x00${inner}`);
  }
  const dagBoundarySet = new Set<string>();
  for (const s of dagBoundarySigs) {
    const inner = s.slice('BOUNDARY\x00'.length);
    dagBoundarySet.add(`BOUNDARY\x00${inner}`);
  }

  const terminalSetMatch = setsEqual(legacyTerminalSet, dagTerminalSet);
  const boundarySetMatch = setsEqual(legacyBoundarySet, dagBoundarySet);
  const frontierSetMatch = terminalSetMatch && boundarySetMatch;

  let legacyTotalProb = 0;
  for (const e of [...legacy.terminals, ...legacy.boundaries]) legacyTotalProb += e.probability;

  return {
    legacy,
    dag,
    terminalSetMatch,
    boundarySetMatch,
    frontierSetMatch,
    probabilityMatch: Math.abs(legacyTotalProb - dagTotalProb) < 1e-9,
    legacyTotalProb,
    dagTotalProb,
    dagTerminalSigs,
    dagBoundarySigs,
  };
}

function setsEqual<T>(a: Set<T>, b: Set<T>): boolean {
  if (a.size !== b.size) return false;
  for (const x of a) if (!b.has(x)) return false;
  return true;
}

// ---------------------------------------------------------------------------
// searchTurnBoundary — turn-boundary search truth gate (phase 1, no AB)
// ---------------------------------------------------------------------------

export interface TurnBoundarySearchResult {
  value: number;
  mate: MateSide;
  completed: boolean;
  cacheable: boolean;
  bound: 'exact' | 'lower' | 'upper';
  bestAction: SearchAction | null;
  /** DAG nodes expanded across all macro turns. */
  dagNodes: number;
  /** Atomic leaf evaluations performed. */
  leafEvals: number;
  /** Number of macro turns (recursion levels) actually expanded. */
  macroTurns: number;
  /** Witness atomic sequence to the chosen boundary (plan witness). */
  witness: SearchAction[];
  /**
   * G0.3L §2 instrumentation (ADDITIVE — measurement only, no logic change).
   * `buildMs` = cumulative wall time inside buildTurnDag across all macro
   * turns. `resolveVisits` = how many DAG nodes the eager resolver actually
   * visited, so DAG_NODES_BUILT vs DAG_NODES_ACTUALLY_CONSUMED can be
   * MEASURED rather than assumed equal.
   */
  buildMs: number;
  resolveVisits: number;
  /**
   * G0.3L-v3: DISTINCT built nodes the resolver actually touched (summed over
   * macro turns). `dagNodes - distinctConsumed` is the true pre-expansion
   * waste: nodes that were built but never needed. `resolveVisits` in contrast
   * counts REPEAT visits, exposing that the eager resolver has no memo.
   */
  distinctConsumed: number;
}

/**
 * Search one macro turn boundary using the compressed within-turn DAG.
 *
 * Semantics preserved from the atomic search:
 *  - Terminal: ±MATE_SCORE, `mate` side, cacheable, completed.
 *  - Repetition: path set of stateKeys (same as atomic). For d1/d2 the
 *    currentPlayer-in-stateKey argument makes cross-turn hits impossible
 *    (audit C); macro-turn roots are added to the path.
 *  - Depth: decremented ONLY at a TURN_BOUNDARY (real player switch), by 1.
 *  - mate-distance: TERMINAL and TURN_BOUNDARY values are expressed in the
 *    CURRENT macro-root frame by stepping ± cumulativeCost (equivalent to the
 *    atomic search's per-edge `stepScore`, summed along the path).
 *  - DECISION (MAX=cat / MIN=mouse): pick best child by the lexicographic
 *    (mate, value) comparator — identical to preferResult.
 *  - CHANCE: weighted expectation over ALL outcomes (full window, no
 *    pruning), mate = 'cat' only if ALL outcomes mate for cat, etc.
 *  - No legal actions: static leaf eval, completed=true (matches the atomic
 *    search's RULE_EDGE_CASE_NO_LEGAL_ACTIONS behavior).
 *
 * Phase 1 does NOT apply alpha-beta inside the DAG (bit-identical value gate
 * first). TT is NOT used yet (fresh DAG per macro turn; d1/d2 sizes are small).
 */
export function searchTurnBoundary(
  state: GameEngineState,
  depthTurns: number,
  rules: RuleSet,
  opts: {
    leafEvaluator?: (state: GameEngineState) => number;
    maxNodes?: number;
    /** F1A-2-style wall-clock deadline (absolute ms). Sampled per node. */
    deadlineMs?: number;
    now?: () => number;
  } = {},
): TurnBoundarySearchResult {
  const maxNodes = opts.maxNodes ?? 500_000;
  const leafEval = opts.leafEvaluator ?? defaultLeafEval;
  const now = opts.now ?? (typeof performance !== 'undefined' ? () => performance.now() : () => Date.now());
  let dagNodesCount = 0;
  let leafEvalsCount = 0;
  let macroTurnsCount = 0;
  let nodeCount = 0;
  let deadlineHit = false;
  // G0.3L §2 instrumentation (additive, measurement only).
  let buildMsTotal = 0;
  let resolveVisitsTotal = 0;
  let distinctConsumedTotal = 0;

  interface DfsResult {
    value: number;
    mate: MateSide;
    completed: boolean;
    cacheable: boolean;
    bound: 'exact' | 'lower' | 'upper';
    witness: SearchAction[] | null; // witness from ROOT to the achieving node
  }

  const prefer = (a: DfsResult, b: DfsResult, maximizing: boolean): boolean => {
    const cmp = compareScores(a, b);
    if (cmp === 0) return false;
    return maximizing ? cmp > 0 : cmp < 0;
  };
  const compareScores = (a: DfsResult, b: DfsResult): number => {
    const rank = (m: MateSide) => (m === 'cat' ? 2 : m === null ? 1 : 0);
    const ra = rank(a.mate);
    const rb = rank(b.mate);
    if (ra !== rb) return ra - rb;
    return a.value - b.value;
  };

  const dfs = (rootState: GameEngineState, depth: number, path: Set<string>): DfsResult => {
    // 1. Terminal
    if (rootState.phase === GamePhase.CatWins) {
      return { value: MATE_SCORE, completed: true, cacheable: true, mate: 'cat', bound: 'exact', witness: null };
    }
    if (rootState.phase === GamePhase.MouseWins) {
      return { value: -MATE_SCORE, completed: true, cacheable: true, mate: 'mouse', bound: 'exact', witness: null };
    }

    // 2. Repetition
    const rootKey = stateKey(rootState);
    if (path.has(rootKey)) {
      return { value: leafEval(rootState), completed: true, cacheable: false, mate: null, bound: 'exact', witness: null };
    }

    // 3. Depth limit
    if (depth <= 0) {
      return { value: leafEval(rootState), completed: true, cacheable: true, mate: null, bound: 'exact', witness: null };
    }

    // 4. Node budget + deadline
    if (nodeCount >= maxNodes || (opts.deadlineMs !== undefined && nodeCount % 64 === 0 && now() >= opts.deadlineMs)) {
      if (opts.deadlineMs !== undefined && nodeCount % 64 === 0 && now() >= opts.deadlineMs) deadlineHit = true;
      return { value: leafEval(rootState), completed: false, cacheable: false, mate: null, bound: 'exact', witness: null };
    }
    nodeCount++;
    macroTurnsCount++;

    // Build the DAG for this macro turn.
    const buildT0 = now();
    const dag = buildTurnDag(rootState, rules);
    buildMsTotal += now() - buildT0;
    dagNodesCount += dag.dagNodes;
    const rootNode = dag.nodes.get(dag.rootId)!;
    const nextPath = new Set(path);
    nextPath.add(rootKey);
    // G0.3L-v3: distinct built nodes this macro turn's resolver touches.
    const touched = new Set<number>();

    // Resolve a DAG node to a DfsResult (values are in the MACRO-ROOT frame).
    const resolve = (node: TurnDagNode): DfsResult => {
      resolveVisitsTotal++;
      touched.add(node.id);
      switch (node.type) {
        case 'TERMINAL': {
          const cat = node.state.phase === GamePhase.CatWins;
          const base = cat ? MATE_SCORE : -MATE_SCORE;
          const mate: MateSide = cat ? 'cat' : 'mouse';
          // Step from the terminal (distance 0) up to the macro root by the
          // cumulative real-game cost (audit B / leg stepScore semantics).
          const v = cat ? base - node.cumulativeCost : base + node.cumulativeCost;
          return { value: v, mate, completed: true, cacheable: true, bound: 'exact', witness: node.witness };
        }
        case 'TURN_BOUNDARY': {
          // Real player switch: recurse with depth-1, in the boundary frame.
          const child = dfs(node.state, depth - 1, nextPath);
          // Re-express the child's value in the macro-root frame: the boundary
          // sits `node.cumulativeCost` game-time units below the macro root.
          let v = child.value;
          let mate = child.mate;
          if (mate === 'cat') v -= node.cumulativeCost;
          else if (mate === 'mouse') v += node.cumulativeCost;
          return {
            value: v, mate, completed: child.completed, cacheable: child.cacheable,
            bound: child.bound, witness: node.witness,
          };
        }
        case 'CHANCE': {
          // Expectation over outcomes (full window, no pruning).
          let total = 0;
          let allCompleted = true;
          let allCacheable = true;
          let allCat = true;
          let allMouse = true;
          let anyChild = false;
          for (const c of node.children) {
            anyChild = true;
            const cr = resolve(dag.nodes.get(c.toId)!);
            total += c.weight * cr.value;
            if (!cr.completed) allCompleted = false;
            if (!cr.cacheable) allCacheable = false;
            if (cr.mate !== 'cat') allCat = false;
            if (cr.mate !== 'mouse') allMouse = false;
          }
          if (!anyChild) {
            // Degenerate chance (no outcomes) — treat as leaf.
            leafEvalsCount++;
            return { value: leafEval(node.state), completed: true, cacheable: true, mate: null, bound: 'exact', witness: null };
          }
          const mate: MateSide = allCat ? 'cat' : allMouse ? 'mouse' : null;
          return { value: total, completed: allCompleted, cacheable: allCacheable, mate, bound: 'exact', witness: null };
        }
        case 'DECISION': {
          const maximizing = node.state.currentPlayer === PieceType.Cat;
          let best: DfsResult | null = null;
          let allCompleted = true;
          let allCacheable = true;
          for (const c of node.children) {
            const child = dag.nodes.get(c.toId)!;
            const cr = resolve(child);
            allCompleted = allCompleted && cr.completed;
            allCacheable = allCacheable && cr.cacheable;
            if (best === null) {
              best = { ...cr, completed: cr.completed, cacheable: cr.cacheable, witness: cr.witness ?? (child.type === 'TERMINAL' || child.type === 'TURN_BOUNDARY' ? child.witness : null) };
              continue;
            }
            if (prefer(cr, best, maximizing)) {
              best = { ...cr, completed: cr.completed, cacheable: cr.cacheable, witness: cr.witness ?? (child.type === 'TERMINAL' || child.type === 'TURN_BOUNDARY' ? child.witness : null) };
            }
          }
          if (best === null) {
            // No legal actions at this DECISION node → static leaf eval.
            leafEvalsCount++;
            return { value: leafEval(node.state), completed: true, cacheable: true, mate: null, bound: 'exact', witness: null };
          }
          // completed/cacheable aggregate over ALL children (atomic-search
          // allCompleted/allCacheable semantics), not just the best.
          best = { ...best, completed: allCompleted, cacheable: allCacheable };
          return best;
        }
      }
    };

    const rootResult = resolve(rootNode);
    distinctConsumedTotal += touched.size;
    return rootResult;
  };

  const result = dfs(state, depthTurns, new Set<string>());
  return {
    value: result.value,
    mate: result.mate,
    completed: result.completed && !deadlineHit,
    cacheable: result.cacheable,
    bound: result.bound,
    bestAction: result.witness && result.witness.length > 0 ? result.witness[0] : null,
    dagNodes: dagNodesCount,
    leafEvals: leafEvalsCount,
    macroTurns: macroTurnsCount,
    witness: result.witness ?? [],
    distinctConsumed: distinctConsumedTotal,
    buildMs: buildMsTotal,
    resolveVisits: resolveVisitsTotal,
  };
}