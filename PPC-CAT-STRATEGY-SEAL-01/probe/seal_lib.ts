/// <reference types="node" />
/**
 * PPC-CAT-STRATEGY-SEAL-01 — corrected quantifier kernel (RESEARCH ONLY).
 *
 * This file does NOT modify any production source. It re-implements the
 * tactical quantifier search on top of the SAME real transition source used by
 * PPC-CAT-STRATEGY-01 (`generatePreparedSearchActions` + `createEngineRuleSet`),
 * but fixes the soundness defects found in the Phase-2 audit:
 *
 *   F1  survival was derived as `!mouseForcesWin()`. The refutation tree of
 *       `mouseForcesWin` quantifies CHANCE existentially (∃ outcome denies the
 *       win), so its negation is `∃cat ∀mouse ∃chance ¬Win`, NOT the required
 *       `∃cat ∀mouse ∀chance ¬Win`. Here survival is a SEPARATE search with
 *       CHANCE = AND in the success direction (`catSurvive`).
 *   F2  `catForcesWin` hard-coded MouseWins→true / CatWins→false regardless of
 *       side, so it computed "cat can force a MOUSE win". Terminals now follow
 *       the mode.
 *   F3  the `cannotReachHoleInHorizon` prune ignored the RULE-A cat-stranding
 *       MouseWins path (mobility.ts: cat with no legal spatial move ⇒ MouseWins).
 *   F4  the same prune budgeted 6 steps per later mouse turn, but a turn that
 *       starts NON-carrying has mouseBaseMoves=4 and can pick butter then skill
 *       (+3) ⇒ up to 7 spatial steps. 6 is not a safe upper bound.
 *
 * F3/F4 only ever turned a real mouse win into "no win", i.e. they could only
 * fabricate SURVIVAL (false) results, never a mouse-forced-win (true). The
 * corrected searches below therefore DISABLE that prune entirely. The mouse
 * forced-win TRUE certificates remain sound either way.
 *
 * The solver is generic over a GameAdapter so the exact same combinator is
 * exercised on (a) minimal synthetic counterexample trees (tests A–F) and
 * (b) the real rule system (G6T2 / G6T3 / 24 roots).
 */
import { createEngineRuleSet } from '../../src/game/engine';
import { generatePreparedSearchActions } from '../../src/game/ai/preparedActions';
import { stateKey } from '../../src/game/ai/transposition';
import { applyNoMoveLoss } from '../../src/game/rules/mobility';
import { GamePhase, PieceType } from '../../src/game/types';
import type { GameEngineState } from '../../src/game/engine';

export const rules = createEngineRuleSet();

export type Mode = 'mouseForce' | 'catSurvive' | 'catForce';

export interface Outcome<S> { state: S; weight: number }
export interface Transition<S> { label: string; outcomes: Outcome<S>[] }

export interface GameAdapter<S> {
  settle(s: S): S;
  player(s: S): 'cat' | 'mouse';
  terminal(s: S): 'mouse' | 'cat' | null;
  transitions(s: S): Transition<S>[];
  key(s: S): string;
}

export interface SolveStats {
  nodes: number; transitions: number; chanceNodes: number; chanceOutcomes: number;
  memoHits: number; cutoffs: number; truncated: boolean; maxIdx: number; elapsedMs: number;
}

export interface SolveResult {
  value: boolean | null;                 // null = UNRESOLVED (node cap)
  policy: Map<string, string>;           // `${idx}|${key}` → chosen action label (∃-side)
  stats: SolveStats;
}

/**
 * Exact boolean AND-OR quantifier. CHANCE is ALWAYS AND (every positive-probability
 * outcome). The existential side's nodes are OR; the universal side's nodes are AND.
 *
 *   mode=mouseForce : ∃mouse ∀cat ∀chance → MouseWins   (cat=AND, mouse=OR)
 *   mode=catSurvive : ∃cat ∀mouse ∀chance → ¬MouseWins  (cat=OR,  mouse=AND)
 *   mode=catForce   : ∃cat ∀mouse ∀chance → CatWins     (cat=OR,  mouse=AND)
 *
 * Horizon: a CAT node at idx >= 2*H is outside the window. Terminal verdicts are
 * checked BEFORE the horizon cut (a mouse win on the last mouse step counts).
 */
export function solve<S>(
  game: GameAdapter<S>, root: S, H: number, startIdx: number, cap: number, mode: Mode,
): SolveResult {
  const t0 = performance.now();
  const memo = new Map<string, boolean>();
  const policy = new Map<string, string>();
  const stats: SolveStats = {
    nodes: 0, transitions: 0, chanceNodes: 0, chanceOutcomes: 0,
    memoHits: 0, cutoffs: 0, truncated: false, maxIdx: 0, elapsedMs: 0,
  };

  // Terminal / horizon truth value for the success predicate of this mode.
  const terminalMouse = mode === 'mouseForce';            // MouseWins is success only for mouseForce
  const terminalCat = mode !== 'mouseForce';              // CatWins is success for cat modes
  const horizonVal = mode === 'catSurvive';               // surviving the horizon is success only for catSurvive
  const existential: 'cat' | 'mouse' = mode === 'mouseForce' ? 'mouse' : 'cat';

  const walk = (state: S, idx: number): boolean | null => {
    if (stats.truncated) return null;
    const s = game.settle(state);
    const term = game.terminal(s);
    if (term === 'mouse') return terminalMouse;
    if (term === 'cat') return terminalCat;
    const player = game.player(s);
    if (player === 'cat' && idx >= 2 * H) return horizonVal;

    const key = `${idx}|${game.key(s)}`;
    const hit = memo.get(key);
    if (hit !== undefined) { stats.memoHits++; return hit; }

    stats.nodes++;
    if (stats.nodes > cap) { stats.truncated = true; return null; }
    if (idx > stats.maxIdx) stats.maxIdx = idx;

    const trs = game.transitions(s);
    if (trs.length === 0) {
      throw new Error(`no legal action at live node ${key.slice(0, 48)} (mode=${mode})`);
    }
    const isOr = player === existential;
    let result: boolean | null = isOr ? false : true;   // OR identity=false, AND identity=true
    let sawNull = false;
    let decided = false;
    let chosen: string | null = null;

    for (const tr of trs) {
      stats.transitions++;
      // All outcomes of one action share the resulting player, so idx increments once.
      const childPlayer = game.player(game.settle(tr.outcomes[0].state));
      const ci = childPlayer !== player ? idx + 1 : idx;
      let childVal: boolean | null;
      if (tr.outcomes.length === 1 && tr.outcomes[0].weight === 1) {
        childVal = walk(tr.outcomes[0].state, ci);
      } else {
        stats.chanceNodes++;
        stats.chanceOutcomes += tr.outcomes.length;
        let all = true;                                  // CHANCE = AND
        for (const o of tr.outcomes) {
          if (o.weight <= 0) continue;                   // only positive-probability outcomes
          const v = walk(o.state, ci);
          if (v === null) { all = false; sawNull = true; break; }
          if (v === false) { all = false; break; }
        }
        childVal = all;
      }
      if (childVal === null) { sawNull = true; continue; }
      if (isOr) {
        if (childVal === true) { result = true; chosen = tr.label; stats.cutoffs++; decided = true; break; }
        result = false;
      } else {
        if (childVal === false) { result = false; stats.cutoffs++; decided = true; break; }
        result = true;
      }
    }

    if (sawNull && !decided) return null;
    const val = result as boolean;
    memo.set(key, val);
    if (isOr && val === true && chosen !== null) policy.set(key, chosen);
    return val;
  };

  const value = walk(root, startIdx);
  stats.elapsedMs = performance.now() - t0;
  return { value, policy, stats };
}

// ---------------------------------------------------------------------------
// Real-rule adapter
// ---------------------------------------------------------------------------

const DIR_LABEL: Record<string, string> = {
  ArrowUp: 'U', ArrowDown: 'D', ArrowLeft: 'L', ArrowRight: 'R',
};
export function label(a: { type: string; direction?: { key: string }; r?: number; c?: number }): string {
  switch (a.type) {
    case 'catPlaceTrap': return 'T';
    case 'mouseSkill': return 'S';
    case 'chooseTunnel': return `t${a.r},${a.c}`;
    default: return DIR_LABEL[a.direction?.key ?? ''] ?? '?';
  }
}

export const realGame: GameAdapter<GameEngineState> = {
  settle: (s) => applyNoMoveLoss(s),
  player: (s) => (s.currentPlayer === PieceType.Cat ? 'cat' : 'mouse'),
  terminal: (s) => {
    if (s.phase === GamePhase.MouseWins) return 'mouse';
    if (s.phase === GamePhase.CatWins) return 'cat';
    return null;
  },
  transitions: (s) => generatePreparedSearchActions(s, rules).map((p) => {
    const tr = p.transition;
    if (tr.kind === 'deterministic') {
      return { label: label(p.action), outcomes: [{ state: tr.state, weight: 1 }] };
    }
    return { label: label(p.action), outcomes: tr.outcomes.map((o) => ({ state: o.state, weight: o.weight })) };
  }),
  key: (s) => stateKey(s),
};

export function mouseForcesWinSeal(root: GameEngineState, H: number, startIdx: number, cap: number): SolveResult {
  return solve(realGame, root, H, startIdx, cap, 'mouseForce');
}
export function catSurvivesSeal(root: GameEngineState, H: number, startIdx: number, cap: number): SolveResult {
  return solve(realGame, root, H, startIdx, cap, 'catSurvive');
}
export function catForcesWinSeal(root: GameEngineState, H: number, startIdx: number, cap: number): SolveResult {
  return solve(realGame, root, H, startIdx, cap, 'catForce');
}

// ---------------------------------------------------------------------------
// INDEPENDENT certificate verifiers (real rules).
//
// These do NOT call `solve` and share no boolean combinator with the prover.
// They re-enumerate EVERY legal opponent action and EVERY positive-probability
// CHANCE outcome from scratch, following the extracted policy at the
// existential side's nodes. A missing policy entry is a hard failure (the
// certificate is incomplete). No prune is used.
// ---------------------------------------------------------------------------

export interface CertVerifyResult {
  ok: boolean;
  verdict: 'PROVEN' | 'FAILED' | 'UNRESOLVED';
  leaves: number; branches: number; chanceNodes: number; maxDepth: number; elapsedMs: number;
  counterexample: string[] | null; reason: string | null; policyMisses: number;
}

function realTransitions(s: GameEngineState) {
  return generatePreparedSearchActions(s, rules).map((p) => {
    const tr = p.transition;
    const outcomes = tr.kind === 'deterministic'
      ? [{ state: tr.state, weight: 1 }]
      : tr.outcomes.map((o) => ({ state: o.state, weight: o.weight }));
    return { label: label(p.action), outcomes };
  });
}

/** Verify a CAT survival certificate: ∃τ ∀mouse ∀chance → ¬MouseWins within H. */
export function verifyCatCertificate(
  root: GameEngineState, policy: Map<string, string>, H: number, startIdx: number, cap: number,
): CertVerifyResult {
  const t0 = performance.now();
  let leaves = 0, branches = 0, chanceNodes = 0, maxDepth = 0, policyMisses = 0;
  let counterexample: string[] | null = null;
  let reason: string | null = null;
  let exhausted = false;
  const okMemo = new Set<string>();

  const walk = (state: GameEngineState, idx: number, path: string[]): boolean => {
    if (exhausted) return false;
    leaves++;
    if (leaves > cap) { exhausted = true; reason = reason ?? 'NODE_CAP'; return false; }
    if (path.length > maxDepth) maxDepth = path.length;
    const s = applyNoMoveLoss(state);
    if (s.phase === GamePhase.MouseWins) {
      if (!counterexample) { counterexample = [...path, 'END:mouse_wins']; reason = 'MOUSE_WINS'; }
      return false;
    }
    if (s.phase === GamePhase.CatWins) return true;
    const isCat = s.currentPlayer === PieceType.Cat;
    if (isCat && idx >= 2 * H) return true;              // survived the window
    const key = `${idx}|${stateKey(s)}`;

    if (isCat) {
      const want = policy.get(key);
      if (want === undefined) {
        policyMisses++;
        if (!counterexample) { counterexample = [...path, `POLICY_MISSING:${key.slice(0, 24)}`]; reason = 'POLICY_MISSING'; }
        return false;
      }
      const trs = realTransitions(s);
      const hit = trs.find((t) => t.label === want);
      if (!hit) {
        policyMisses++;
        if (!counterexample) { counterexample = [...path, `POLICY_ILLEGAL:${want}`]; reason = 'POLICY_ILLEGAL'; }
        return false;
      }
      if (hit.outcomes.length > 1 || hit.outcomes[0].weight !== 1) chanceNodes++;
      const cp = applyNoMoveLoss(hit.outcomes[0].state).currentPlayer;
      const ci = cp !== s.currentPlayer ? idx + 1 : idx;
      for (let i = 0; i < hit.outcomes.length; i++) {
        const o = hit.outcomes[i];
        if (o.weight <= 0) continue;
        if (!walk(o.state, ci, [...path, `c:${want}~chance#${i + 1}`])) return false;
      }
      return true;
    }

    // mouse node: ALL legal actions (∀mouse), ALL chance outcomes (∀chance)
    if (okMemo.has(key)) return true;
    branches++;
    const trs = realTransitions(s);
    for (const t of trs) {
      if (t.outcomes.length > 1 || t.outcomes[0].weight !== 1) chanceNodes++;
      const cp = applyNoMoveLoss(t.outcomes[0].state).currentPlayer;
      const ci = cp !== s.currentPlayer ? idx + 1 : idx;
      for (let i = 0; i < t.outcomes.length; i++) {
        const o = t.outcomes[i];
        if (o.weight <= 0) continue;
        if (!walk(o.state, ci, [...path, `m:${t.label}~chance#${i + 1}`])) return false;
      }
    }
    okMemo.add(key);
    return true;
  };

  const ok = walk(root, startIdx, []);
  const verdict = exhausted ? 'UNRESOLVED' : ok ? 'PROVEN' : 'FAILED';
  return { ok, verdict, leaves, branches, chanceNodes, maxDepth, elapsedMs: performance.now() - t0,
    counterexample, reason, policyMisses };
}

/** Verify a MOUSE forced-win certificate: ∃σ ∀cat ∀chance → MouseWins within H. */
export function verifyMouseCertificate(
  root: GameEngineState, policy: Map<string, string>, H: number, startIdx: number, cap: number,
): CertVerifyResult {
  const t0 = performance.now();
  let leaves = 0, branches = 0, chanceNodes = 0, maxDepth = 0, policyMisses = 0;
  let counterexample: string[] | null = null;
  let reason: string | null = null;
  let exhausted = false;

  const walk = (state: GameEngineState, idx: number, path: string[]): boolean => {
    if (exhausted) return false;
    leaves++;
    if (leaves > cap) { exhausted = true; reason = reason ?? 'NODE_CAP'; return false; }
    if (path.length > maxDepth) maxDepth = path.length;
    const s = applyNoMoveLoss(state);
    if (s.phase === GamePhase.MouseWins) return true;
    if (s.phase === GamePhase.CatWins) {
      if (!counterexample) { counterexample = [...path, 'END:cat_wins']; reason = 'CAT_WINS'; }
      return false;
    }
    const isCat = s.currentPlayer === PieceType.Cat;
    if (isCat && idx >= 2 * H) {
      if (!counterexample) { counterexample = [...path, 'HORIZON']; reason = 'HORIZON_REACHED'; }
      return false;
    }
    const key = `${idx}|${stateKey(s)}`;

    if (!isCat) {
      const want = policy.get(key);
      if (want === undefined) {
        policyMisses++;
        if (!counterexample) { counterexample = [...path, `POLICY_MISSING:${key.slice(0, 24)}`]; reason = 'POLICY_MISSING'; }
        return false;
      }
      const trs = realTransitions(s);
      const hit = trs.find((t) => t.label === want);
      if (!hit) {
        policyMisses++;
        if (!counterexample) { counterexample = [...path, `POLICY_ILLEGAL:${want}`]; reason = 'POLICY_ILLEGAL'; }
        return false;
      }
      if (hit.outcomes.length > 1 || hit.outcomes[0].weight !== 1) chanceNodes++;
      const cp = applyNoMoveLoss(hit.outcomes[0].state).currentPlayer;
      const ci = cp !== s.currentPlayer ? idx + 1 : idx;
      for (let i = 0; i < hit.outcomes.length; i++) {
        const o = hit.outcomes[i];
        if (o.weight <= 0) continue;
        if (!walk(o.state, ci, [...path, `m:${want}~chance#${i + 1}`])) return false;
      }
      return true;
    }

    // cat node: ALL legal actions (∀cat), ALL chance outcomes (∀chance)
    branches++;
    const trs = realTransitions(s);
    for (const t of trs) {
      if (t.outcomes.length > 1 || t.outcomes[0].weight !== 1) chanceNodes++;
      const cp = applyNoMoveLoss(t.outcomes[0].state).currentPlayer;
      const ci = cp !== s.currentPlayer ? idx + 1 : idx;
      for (let i = 0; i < t.outcomes.length; i++) {
        const o = t.outcomes[i];
        if (o.weight <= 0) continue;
        if (!walk(o.state, ci, [...path, `c:${t.label}~chance#${i + 1}`])) return false;
      }
    }
    return true;
  };

  const ok = walk(root, startIdx, []);
  const verdict = exhausted ? 'UNRESOLVED' : ok ? 'PROVEN' : 'FAILED';
  return { ok, verdict, leaves, branches, chanceNodes, maxDepth, elapsedMs: performance.now() - t0,
    counterexample, reason, policyMisses };
}

// ---------------------------------------------------------------------------
// Five-class scheme (the corrected contract).
// ---------------------------------------------------------------------------

export type SealClass =
  | 'MOUSE_FORCED_WIN_WITHIN_H0'
  | 'MOUSE_FORCED_WIN_WITHIN_H1'
  | 'CAT_FORCED_WIN_WITHIN_H1'
  | 'CAT_SURVIVAL_CERTIFIED_WITHIN_H1'
  | 'CHANCE_DEPENDENT_OUTCOME'
  | 'UNRESOLVED';

/**
 * h0/h1 = mouseForcesWin at H0/H1; survive/catForce = catSurvive/catForce at H1.
 * Any null (cap) ⇒ UNRESOLVED. CAT_FORCED_WIN implies survival, so it is checked
 * before the survival label. If the mouse cannot force a win AND the cat cannot
 * certify survival against ALL chance, the position is CHANCE_DEPENDENT.
 */
export function classifySeal(
  h0: boolean | null, h1: boolean | null, survive: boolean | null, catForce: boolean | null,
): SealClass {
  if (h0 === null || h1 === null || survive === null || catForce === null) return 'UNRESOLVED';
  if (h1 && survive) throw new Error('contradiction: mouse forces win AND cat certifies survival in H1');
  if (h0) return 'MOUSE_FORCED_WIN_WITHIN_H0';
  if (h1) return 'MOUSE_FORCED_WIN_WITHIN_H1';
  if (catForce) return 'CAT_FORCED_WIN_WITHIN_H1';
  if (survive) return 'CAT_SURVIVAL_CERTIFIED_WITHIN_H1';
  return 'CHANCE_DEPENDENT_OUTCOME';
}

// ---------------------------------------------------------------------------
// Sound prefix application (real transitions, NO prune). Mirrors the previous
// round's applyPrefixBranches semantics: apply a sequence of action labels,
// fan out every positive-probability CHANCE outcome, track the turn idx.
// ---------------------------------------------------------------------------

export function legalLabels(s: GameEngineState): string[] {
  return generatePreparedSearchActions(applyNoMoveLoss(s), rules)
    .map((p) => label(p.action) + (p.transition.kind === 'chance' ? '*' : ''));
}

export interface PrefixResult {
  states: GameEngineState[]; idx: number[]; ok: boolean; failedAt?: string;
}

export function applyPrefix(root: GameEngineState, prefix: string[], startIdx = 0): PrefixResult {
  let frontier: { state: GameEngineState; idx: number }[] = [{ state: applyNoMoveLoss(root), idx: startIdx }];
  for (const want of prefix) {
    const next: { state: GameEngineState; idx: number }[] = [];
    for (const f of frontier) {
      const s = f.state;
      if (s.phase !== GamePhase.Playing) return { states: [], idx: [], ok: false, failedAt: `${want} (phase ${s.phase})` };
      const bare = want.replace(/\*$/, '');
      const hit = generatePreparedSearchActions(s, rules).find((p) => label(p.action) === bare);
      if (!hit) return { states: [], idx: [], ok: false, failedAt: `${want} (illegal)` };
      const tr = hit.transition;
      if (tr.kind === 'chance') {
        const ci = tr.outcomes[0].state.currentPlayer !== s.currentPlayer ? f.idx + 1 : f.idx;
        for (const o of tr.outcomes) next.push({ state: applyNoMoveLoss(o.state), idx: ci });
      } else {
        const ci = tr.state.currentPlayer !== s.currentPlayer ? f.idx + 1 : f.idx;
        next.push({ state: applyNoMoveLoss(tr.state), idx: ci });
      }
    }
    frontier = next;
  }
  return { states: frontier.map((f) => f.state), idx: frontier.map((f) => f.idx), ok: true };
}

/** AND over every positive-probability boundary outcome of a prefix. */
export function prefixVerdict(
  root: GameEngineState, prefix: string[], H: number, startIdx: number, cap: number,
  fn: (s: GameEngineState, H: number, idx: number, cap: number) => SolveResult,
): { ok: boolean; value: boolean | null; branches: number; perBranch: (boolean | null)[]; stats: SolveStats[] } {
  const pre = applyPrefix(root, prefix, startIdx);
  if (!pre.ok || pre.states.length === 0) {
    return { ok: false, value: null, branches: 0, perBranch: [], stats: [] };
  }
  const perBranch: (boolean | null)[] = [];
  const stats: SolveStats[] = [];
  let anyNull = false, allTrue = true;
  for (let i = 0; i < pre.states.length; i++) {
    const r = fn(pre.states[i], H, pre.idx[i], cap);
    perBranch.push(r.value); stats.push(r.stats);
    if (r.value === null) anyNull = true;
    if (r.value !== true) allTrue = false;
  }
  const value = anyNull ? null : allTrue;
  return { ok: true, value, branches: pre.states.length, perBranch, stats };
}

export { stateKey, applyNoMoveLoss };
export { summarize, renderBoard, canonicalJson } from './seal_util';