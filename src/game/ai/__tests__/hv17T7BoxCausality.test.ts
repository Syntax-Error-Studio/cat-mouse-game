/// <reference types="node" />
/**
 * PPC-HV17 — GAME2 T7 box-push causality (read-only on production).
 *
 * Question: does the +31.578947 H1 advantage that UUUU earns by pushing the
 * box from (3,6) to (1,6) correspond to a verifiable strategic benefit under
 * the REAL rule kernel?
 *
 * P1 replays both principal lines (LURD / UUUU -> mouse tunnel escape -> cat
 * reply) through the production simulator, counts real box pushes, compares
 * every rule/H1-relevant GameEngineState field, and decomposes the H1 totals
 * contribution by contribution.
 * P2 measures real-kernel capabilities (mouse next-turn reach, butter/hole
 * routes, tunnel escapes, cat next-turn mobility/pushes/trap/capture) and
 * separates PROVEN rule differences from H1 signal differences.
 * P3 runs the reverse controls. No production file, weight, budget, depth,
 * rule or seed is modified.
 */
import { expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
import { createEngineRuleSet } from '../../engine';
import type { GameEngineState } from '../../engine';
import { DIRECTIONS, GamePhase, PieceType, CellType } from '../../types';
import { restoreHardRoot, type HardRootSnapshot } from '../hardHistory';
import { generateLegalSearchActions } from '../legalActions';
import { simulateSearchAction } from '../simulator';
import { stateKey } from '../transposition';
import {
  evaluateForCatDetailed,
  buildMouseDistanceMap,
  buildCatDistanceMap,
  buildCatPushDistanceMap,
  type EvaluationBreakdown,
} from '../evaluation';
import {
  correctedHoleControlValue,
  correctedHoleEvalTotal,
  evaluateCorrectedHoleForCat,
} from '../correctedHoleLeaf';
import type { SearchAction } from '../searchTypes';

const LOG = new URL('../../../../ai-training/human-logs/PPC-HV14/GAME2_H1.txt', import.meta.url);
const rules = createEngineRuleSet();
const BOARD_SIZE = 10;
const READ_LOG_TURNS = [7] as const; // control 6: only the decision root is read

// ---------------------------------------------------------------------------
// Root / action helpers
// ---------------------------------------------------------------------------
function turnSegment(turn: number): string[] {
  if (!(READ_LOG_TURNS as readonly number[]).includes(turn)) throw new Error(`HV17 refuses to read Turn #${turn}`);
  const lines = readFileSync(LOG, 'utf8').split(/\r?\n/);
  const s = lines.findIndex((l) => l.trim() === `Turn #${turn}`);
  if (s < 0) throw new Error(`T${turn} not found`);
  let e = lines.findIndex((l, i) => i > s && /^Turn #\d+$/.test(l.trim()));
  if (e < 0) e = lines.length;
  return lines.slice(s + 1, e);
}

function root(turn: number): { state: GameEngineState; key: string; plan: SearchAction[] } {
  const seg = turnSegment(turn);
  const key = seg.find((l) => l.startsWith('STATE_KEY='))!.slice('STATE_KEY='.length).trim();
  const snap = JSON.parse(seg.find((l) => l.startsWith('SNAPSHOT_JSON='))!.slice('SNAPSHOT_JSON='.length)) as HardRootSnapshot;
  const planLine = seg.find((l) => l.startsWith('PLAN:'))!.replace(/^PLAN:\s*/, '');
  const plan = planLine.split('→').map((part) => {
    const p = part.trim();
    const m = /^catStep Arrow(Up|Down|Left|Right)$/.exec(p);
    if (!m) throw new Error(`unparsed plan token: ${p}`);
    return { type: 'catStep', direction: DIRECTIONS.find((d) => d.key === `Arrow${m[1]}`)! } as SearchAction;
  });
  return { state: restoreHardRoot(snap), key, plan };
}

const dir = (key: string) => DIRECTIONS.find((d) => d.key === key)!;
const catStep = (key: string): SearchAction => ({ type: 'catStep', direction: dir(key) });
const mouseStep = (key: string): SearchAction => ({ type: 'mouseStep', direction: dir(key) });
const exitAt = (r: number, c: number): SearchAction => ({ type: 'chooseTunnel', r, c });

const LURD = [catStep('ArrowLeft'), catStep('ArrowUp'), catStep('ArrowRight'), catStep('ArrowDown')];
const UUUU = [catStep('ArrowUp'), catStep('ArrowUp'), catStep('ArrowUp'), catStep('ArrowUp')];
// The mouse reply used by HV15/HV16 (derived there by exhaustive best response,
// NOT copied from a future human move): three lefts to tunnel (0,0), exit (9,0).
const MOUSE_REPLY = [mouseStep('ArrowLeft'), mouseStep('ArrowLeft'), mouseStep('ArrowLeft'), exitAt(9, 0)];
const CAT_REPLY_LURD = [catStep('ArrowUp'), catStep('ArrowUp'), catStep('ArrowDown'), catStep('ArrowDown')];
const CAT_REPLY_UUUU = [catStep('ArrowDown'), catStep('ArrowDown'), catStep('ArrowDown'), catStep('ArrowDown')];

const actionText = (a: SearchAction): string => {
  switch (a.type) {
    case 'catStep': return a.direction!.key.replace('Arrow', '')[0];
    case 'mouseStep': return a.direction!.key.replace('Arrow', '')[0].toLowerCase();
    case 'catPlaceTrap': return 'T';
    case 'mouseSkill': return 'SK';
    case 'chooseTunnel': return `EXIT(${a.r},${a.c})`;
  }
};
const seqText = (as: SearchAction[]): string => (as.length ? as.map(actionText).join('') : '-');
const rc = (p: { r: number; c: number }): string => `${p.r},${p.c}`;

function replay(start: GameEngineState, actions: SearchAction[]): GameEngineState {
  let cur = start;
  for (const a of actions) {
    const tr = simulateSearchAction(cur, a, rules);
    if (tr.kind !== 'deterministic') {
      throw new Error(`unexpected CHANCE node at ${actionText(a)} (turn ${cur.currentPlayer})`);
    }
    cur = tr.state;
  }
  return cur;
}

// ---------------------------------------------------------------------------
// Board / push witnesses
// ---------------------------------------------------------------------------
type Pt = { r: number; c: number };
const boxKey = (p: Pt): string => `${p.r},${p.c}`;
function boxCells(s: GameEngineState): Pt[] {
  const out: Pt[] = [];
  for (let r = 0; r < s.config.boardSize; r++) {
    for (let c = 0; c < s.config.boardSize; c++) {
      if (s.board[r][c].type === CellType.Box) out.push({ r, c });
    }
  }
  return out.sort((a, b) => a.r - b.r || a.c - b.c);
}
const boxText = (s: GameEngineState): string => boxCells(s).map(rc).join('|');

interface PushRecord {
  actionIndex: number;
  from: Pt;
  to: Pt;
  catFrom: Pt;
  catTo: Pt;
  destinationWasEmpty: boolean;
  logLine: string;
}

/** Apply one cat turn while independently tracking every box displacement. */
function catTurnWithPushes(start: GameEngineState, actions: SearchAction[]): { end: GameEngineState; pushes: PushRecord[] } {
  let cur = start;
  const pushes: PushRecord[] = [];
  const logBefore = cur.catActionLog.length;
  actions.forEach((a, i) => {
    const beforeBoxes = new Map(boxCells(cur).map((p) => [boxKey(p), p]));
    const catFrom = { ...cur.catPosition };
    const tr = simulateSearchAction(cur, a, rules);
    if (tr.kind !== 'deterministic') throw new Error('chance in cat turn');
    const next = tr.state;
    const afterBoxes = new Map(boxCells(next).map((p) => [boxKey(p), p]));
    const removed = [...beforeBoxes.keys()].filter((k) => !afterBoxes.has(k));
    const added = [...afterBoxes.keys()].filter((k) => !beforeBoxes.has(k));
    expect(removed.length, `action ${i} (${actionText(a)}) moves at most one box`).toBeLessThanOrEqual(1);
    expect(removed.length, `action ${i} box add/remove symmetric`).toBe(added.length);
    if (removed.length === 1) {
      const from = beforeBoxes.get(removed[0])!;
      const to = afterBoxes.get(added[0])!;
      const d = dir((a as { direction: { key: string } }).direction.key);
      expect(to.r - from.r, `push direction row (${rc(from)}->${rc(to)})`).toBe(d.dr);
      expect(to.c - from.c, `push direction col (${rc(from)}->${rc(to)})`).toBe(d.dc);
      const dest = cur.board[to.r][to.c];
      pushes.push({
        actionIndex: i,
        from,
        to,
        catFrom,
        catTo: { ...next.catPosition },
        destinationWasEmpty: dest.type === CellType.Empty && !dest.hasButter,
        logLine: next.catActionLog[next.catActionLog.length - 1] ?? '',
      });
    }
    expect(next.catActionLog.length - logBefore, 'one log entry per cat action').toBeGreaterThanOrEqual(1);
    cur = next;
  });
  return { end: cur, pushes };
}

// ---------------------------------------------------------------------------
// H1 breakdown
// ---------------------------------------------------------------------------
const CONTRIB_KEYS = [
  'capturePressure', 'mouseGoalThreat', 'butterRace', 'confinement', 'mobility',
  'trapControl', 'tunnelControl', 'holeControl', 'voronoiBalance', 'tempo',
] as const;

function h1Parts(b: EvaluationBreakdown): number[] {
  return CONTRIB_KEYS.map((k) => b.contributions[k]);
}

// ---------------------------------------------------------------------------
// P1 — replay + push witnesses + state diff + H1 decomposition
// ---------------------------------------------------------------------------
test('HV17-P1 real replay, push count, state diff, H1 decomposition', () => {
  const r = root(7);
  expect(stateKey(r.state), 'T7 snapshot re-hashes to the logged STATE_KEY').toBe(r.key);
  expect(r.plan.map(actionText).join(''), 'logged plan is LURD').toBe('LURD');

  // --- Cat first turn (the plan under test) -------------------------------
  const l1 = catTurnWithPushes(r.state, LURD);
  const u1 = catTurnWithPushes(r.state, UUUU);
  expect(l1.pushes.length, 'LURD pushes no box').toBe(0);
  expect(u1.pushes.length, 'UUUU pushes the box exactly twice').toBe(2);
  expect(u1.pushes.map((p) => `${rc(p.from)}->${rc(p.to)}`)).toEqual(['3,6->2,6', '2,6->1,6']);
  for (const p of u1.pushes) expect(p.destinationWasEmpty, `push dest ${rc(p.to)} was empty`).toBe(true);
  expect(u1.pushes[0].logLine).toContain('推箱');
  expect(u1.pushes[1].logLine).toContain('推箱');
  expect(rc(l1.end.catPosition), 'LURD cat end').toBe('6,6');
  expect(rc(u1.end.catPosition), 'UUUU cat end').toBe('2,6');
  expect(boxText(l1.end), 'LURD board boxes unchanged').toBe(boxText(r.state));
  expect(boxText(u1.end)).toContain('1,6');
  expect(boxText(u1.end)).not.toContain('3,6');

  // --- Mouse reply (identical, real tunnel escape) ------------------------
  const lm = replay(l1.end, MOUSE_REPLY);
  const um = replay(u1.end, MOUSE_REPLY);
  expect(lm.currentPlayer).toBe(PieceType.Cat);
  expect(um.currentPlayer).toBe(PieceType.Cat);
  expect(rc(lm.mousePosition), 'mouse escape exit').toBe('9,0');
  expect(rc(um.mousePosition), 'mouse escape exit').toBe('9,0');
  expect(lm.mouseMovesLeft).toBe(0);
  expect(um.mouseMovesLeft).toBe(0);
  expect(lm.catMovesLeft, 'fresh cat budget after mouse turn').toBe(4);
  expect(um.catMovesLeft, 'fresh cat budget after mouse turn').toBe(4);

  // --- Cat reply ----------------------------------------------------------
  const l2 = catTurnWithPushes(lm, CAT_REPLY_LURD);
  const u2 = catTurnWithPushes(um, CAT_REPLY_UUUU);
  expect(l2.pushes.length, 'LURD reply pushes no box').toBe(0);
  expect(u2.pushes.length, 'UUUU reply pushes no box').toBe(0);
  const finalL = l2.end;
  const finalU = u2.end;

  expect(finalL.currentPlayer).toBe(PieceType.Mouse);
  expect(finalU.currentPlayer).toBe(PieceType.Mouse);
  expect(rc(finalL.catPosition)).toBe('6,6');
  expect(rc(finalU.catPosition)).toBe('6,6');
  expect(rc(finalL.mousePosition)).toBe('9,0');
  expect(rc(finalU.mousePosition)).toBe('9,0');

  // --- Field-by-field diff ------------------------------------------------
  const boardDiff: string[] = [];
  for (let rr = 0; rr < BOARD_SIZE; rr++) {
    for (let cc = 0; cc < BOARD_SIZE; cc++) {
      const a = finalL.board[rr][cc];
      const b = finalU.board[rr][cc];
      if (a.type !== b.type || a.hasButter !== b.hasButter) boardDiff.push(`(${rr},${cc})`);
    }
  }
  expect(boardDiff, 'final boards differ only at the moved box cells').toEqual(['(1,6)', '(3,6)']);

  const shrink = (s: GameEngineState) => ({
    config: s.config,
    gameMode: s.gameMode,
    phase: s.phase,
    currentPlayer: s.currentPlayer,
    catPosition: s.catPosition,
    mousePosition: s.mousePosition,
    catMovesLeft: s.catMovesLeft,
    mouseMovesLeft: s.mouseMovesLeft,
    butterPositions: s.butterPositions,
    mouseHasButter: s.mouseHasButter,
    mouseSkillActive: s.mouseSkillActive,
    pendingButterSpawns: s.pendingButterSpawns,
    pendingButterPlacementDebt: s.pendingButterPlacementDebt,
    trapPosition: s.trapPosition,
    catTrapsRemaining: s.catTrapsRemaining,
    blockedTunnels: s.blockedTunnels,
    tunnelExitChoices: s.tunnelExitChoices,
  });
  expect(shrink(finalU), 'every non-board rule field is identical').toEqual(shrink(finalL));
  expect(finalL.message === finalU.message, 'messages may differ (presentation only)').toBeTypeOf('boolean');

  // --- H1 decomposition ---------------------------------------------------
  const bL = evaluateForCatDetailed(finalL);
  const bU = evaluateForCatDetailed(finalU);
  const holeL = correctedHoleControlValue(bL, BOARD_SIZE);
  const holeU = correctedHoleControlValue(bU, BOARD_SIZE);
  const h1L = correctedHoleEvalTotal(bL, BOARD_SIZE);
  const h1U = correctedHoleEvalTotal(bU, BOARD_SIZE);
  expect(h1L).toBe(evaluateCorrectedHoleForCat(finalL));
  expect(h1U).toBe(evaluateCorrectedHoleForCat(finalU));
  expect(h1L).toBe(-1314.5263157894738);
  expect(h1U).toBe(-1282.9473684210527);
  expect(h1U - h1L).toBe(31.57894736842104);

  const delta = h1Parts(bU).map((v, i) => v - h1Parts(bL)[i]);
  const deltaSum = delta.reduce((a, b) => a + b, 0);
  expect(deltaSum + (holeU - holeL), 'H1 delta = raw contribution deltas + hole correction').toBeCloseTo(h1U - h1L, 12);
  const nonzero = CONTRIB_KEYS.map((k, i) => ({ k, v: delta[i] })).filter((x) => Math.abs(x.v) > 1e-12);

  // eslint-disable-next-line no-console
  console.log(
    `\nHV17-P1 T7 box causality\n`
    + `  root=${r.key}\n`
    + `  LURD pushes=${l1.pushes.length} (${seqText(LURD)}) catEnd=${rc(l1.end.catPosition)} stateKey=${stateKey(l1.end)}\n`
    + `  UUUU pushes=${u1.pushes.length} [${u1.pushes.map((p) => `${rc(p.from)}->${rc(p.to)}`).join(', ')}] catEnd=${rc(u1.end.catPosition)} stateKey=${stateKey(u1.end)}\n`
    + `  mouse reply=${seqText(MOUSE_REPLY)} -> ${rc(lm.mousePosition)} / ${rc(um.mousePosition)}\n`
    + `  final keys:\n    L=${stateKey(finalL)}\n    U=${stateKey(finalU)}\n`
    + `  final board boxes L=[${boxText(finalL)}] U=[${boxText(finalU)}] diff=[${boardDiff.join(' ')}]\n`
    + `  H1 L=${h1L} U=${h1U} delta=${h1U - h1L}\n`
    + `  raw total L=${bL.total} U=${bU.total} (delta ${bU.total - bL.total})\n`
    + `  holeControl raw L=${bL.contributions.holeControl} U=${bU.contributions.holeControl}`
    + ` corrected L=${holeL} U=${holeU} (delta ${holeU - holeL})\n`
    + `  nonzero contributions: ${nonzero.map((x) => `${x.k}=${x.v}`).join(', ') || 'none'}\n`
    + CONTRIB_KEYS.map((k, i) => `    ${k.padEnd(16)} L=${h1Parts(bL)[i].toFixed(6)} U=${h1Parts(bU)[i].toFixed(6)} d=${delta[i].toFixed(6)}`).join('\n')
    + `\n  features that differ:\n`
    + Object.entries(bL.features)
      .filter(([k, v]) => JSON.stringify(v) !== JSON.stringify((bU.features as unknown as Record<string, unknown>)[k]))
      .map(([k, v]) => `    ${k}: L=${JSON.stringify(v)} U=${JSON.stringify((bU.features as unknown as Record<string, unknown>)[k])}`)
      .join('\n'),
  );
}, 120000);

// ---------------------------------------------------------------------------
// P2 machinery — real-kernel capability measurement
// ---------------------------------------------------------------------------
const pkey = (p: Pt): string => `${p.r},${p.c}`;
const inBounds = (r: number, c: number): boolean => r >= 0 && r < BOARD_SIZE && c >= 0 && c < BOARD_SIZE;

function holeCells(s: GameEngineState): Pt[] {
  const out: Pt[] = [];
  const { r, c, size } = s.config.mouseHole;
  for (let dr = 0; dr < size; dr++) for (let dc = 0; dc < size; dc++) out.push({ r: r + dr, c: c + dc });
  return out;
}

function principalFinals(): { finalL: GameEngineState; finalU: GameEngineState; catEndL: GameEngineState; catEndU: GameEngineState } {
  const r = root(7).state;
  const catEndL = replay(r, LURD);
  const catEndU = replay(r, UUUU);
  const finalL = replay(replay(catEndL, MOUSE_REPLY), CAT_REPLY_LURD);
  const finalU = replay(replay(catEndU, MOUSE_REPLY), CAT_REPLY_UUUU);
  return { finalL, finalU, catEndL, catEndU };
}

interface CensusedLine {
  state: GameEngineState;
  actions: SearchAction[];
  weight: number;
  pushes: number;
}
interface Census {
  lines: CensusedLine[];
  chanceNodes: number;
  chanceOutcomes: number;
  truncated: boolean;
}

/** Every complete legal turn of `actor` through the production simulator. */
function enumerateFullTurns(start: GameEngineState, actor: PieceType, reverse = false, cap = 200_000): Census {
  const lines: CensusedLine[] = [];
  const chanceKeys = new Set<string>();
  let chanceOutcomes = 0;
  let truncated = false;
  const walk = (s: GameEngineState, actions: SearchAction[], weight: number, pushes: number, guard: Set<string>): void => {
    if (truncated) return;
    if (lines.length >= cap) { truncated = true; return; }
    if (s.phase === GamePhase.CatWins || s.phase === GamePhase.MouseWins) {
      lines.push({ state: s, actions, weight, pushes });
      return;
    }
    if (s.currentPlayer !== actor) {
      lines.push({ state: s, actions, weight, pushes });
      return;
    }
    let acts = generateLegalSearchActions(s, rules);
    if (reverse) acts = [...acts].reverse();
    if (acts.length === 0) {
      lines.push({ state: s, actions, weight, pushes });
      return;
    }
    const k = stateKey(s);
    if (guard.has(k)) {
      lines.push({ state: s, actions, weight, pushes });
      return;
    }
    guard.add(k);
    for (const a of acts) {
      const tr = simulateSearchAction(s, a, rules);
      if (tr.kind === 'chance') {
        chanceKeys.add(k);
        chanceOutcomes += tr.outcomes.length;
        for (const o of tr.outcomes) walk(o.state, [...actions, a], weight * o.weight, pushes, guard);
      } else {
        const beforeKeys = new Set(boxCells(s).map(pkey));
        const pushed = boxCells(tr.state).some((p) => !beforeKeys.has(pkey(p))) ? 1 : 0;
        walk(tr.state, [...actions, a], weight, pushes + pushed, guard);
      }
    }
    guard.delete(k);
  };
  walk(start, [], 1, 0, new Set<string>());
  return { lines, chanceNodes: chanceKeys.size, chanceOutcomes, truncated };
}

/** Real-simulator mouse reachability (tunnels require ENTERING a corner, as in the engine). */
function normalizeMouseState(s: GameEngineState, carrying: boolean): GameEngineState {
  const phase = s.phase === GamePhase.ChoosingTunnelExit ? GamePhase.ChoosingTunnelExit : GamePhase.Playing;
  return { ...s, currentPlayer: PieceType.Mouse, phase, mouseMovesLeft: 999, mouseHasButter: carrying, mouseSkillActive: false };
}
const mouseSig = (s: GameEngineState): string =>
  `${pkey(s.mousePosition)}|${s.phase}|${s.tunnelExitChoices.map(pkey).join(';')}`;

function realMouseDistances(base: GameEngineState, starts: Pt[], carrying: boolean): Map<string, number> {
  const dist = new Map<string, number>();
  const seen = new Set<string>();
  let frontier: GameEngineState[] = [];
  for (const st of starts) {
    const s = normalizeMouseState({ ...base, mousePosition: st, phase: GamePhase.Playing, tunnelExitChoices: [] }, carrying);
    if (!dist.has(pkey(st))) dist.set(pkey(st), 0);
    const k = mouseSig(s);
    if (!seen.has(k)) { seen.add(k); frontier.push(s); }
  }
  let d = 0;
  while (frontier.length > 0 && d < 100) {
    d++;
    const next: GameEngineState[] = [];
    for (const s of frontier) {
      const acts = generateLegalSearchActions(s, rules).filter((a) => a.type !== 'mouseSkill');
      for (const a of acts) {
        const tr = simulateSearchAction(s, a, rules);
        const outs = tr.kind === 'chance' ? tr.outcomes.map((o) => o.state) : [tr.state];
        for (const ns of outs) {
          if (!dist.has(pkey(ns.mousePosition))) dist.set(pkey(ns.mousePosition), d);
          if (ns.phase === GamePhase.CatWins || ns.phase === GamePhase.MouseWins) continue;
          const norm = normalizeMouseState(ns, carrying);
          const sig = mouseSig(norm);
          if (seen.has(sig)) continue;
          seen.add(sig);
          next.push(norm);
        }
      }
    }
    frontier = next;
  }
  return dist;
}

/** Real-simulator CAT WALK graph (pushes excluded by board inspection). */
function normalizeCatState(s: GameEngineState): GameEngineState {
  return { ...s, currentPlayer: PieceType.Cat, phase: GamePhase.Playing, catMovesLeft: 999, mouseMovesLeft: 0 };
}
function realCatWalkDistances(base: GameEngineState): Map<string, number> {
  const dist = new Map<string, number>();
  dist.set(pkey(base.catPosition), 0);
  let frontier: GameEngineState[] = [normalizeCatState(base)];
  const seen = new Set<string>([pkey(base.catPosition)]);
  let d = 0;
  while (frontier.length > 0 && d < 200) {
    d++;
    const next: GameEngineState[] = [];
    for (const s of frontier) {
      for (const a of generateLegalSearchActions(s, rules)) {
        if (a.type !== 'catStep') continue;
        const t = s.catPosition.r + a.direction!.dr;
        const u = s.catPosition.c + a.direction!.dc;
        if (!inBounds(t, u)) continue;
        if (s.board[t][u].type === CellType.Box) continue; // walk-only control
        const tr = simulateSearchAction(s, a, rules);
        if (tr.kind !== 'deterministic') continue;
        const ns = tr.state;
        const k = pkey(ns.catPosition);
        if (!dist.has(k)) dist.set(k, d);
        if (ns.phase !== GamePhase.Playing || ns.currentPlayer !== PieceType.Cat) continue;
        if (seen.has(k)) continue;
        seen.add(k);
        next.push(normalizeCatState(ns));
      }
    }
    frontier = next;
  }
  return dist;
}

/** Every mouse cell the simulator can reach inside ONE mouse turn (positions visited). */
function mouseTurnVisited(start: GameEngineState, reverse = false): Set<string> {
  const positions = new Set<string>([pkey(start.mousePosition)]);
  const seen = new Set<string>();
  const stack: GameEngineState[] = [start];
  while (stack.length > 0) {
    const s = stack.pop()!;
    if (s.phase === GamePhase.CatWins || s.phase === GamePhase.MouseWins) continue;
    if (s.currentPlayer !== PieceType.Mouse && s.phase !== GamePhase.ChoosingTunnelExit) continue;
    const k = stateKey(s);
    if (seen.has(k)) continue;
    seen.add(k);
    if (seen.size > 20_000) throw new Error('mouse turn state cap');
    let acts = generateLegalSearchActions(s, rules);
    if (reverse) acts = [...acts].reverse();
    for (const a of acts) {
      const tr = simulateSearchAction(s, a, rules);
      const outs = tr.kind === 'chance' ? tr.outcomes.map((o) => o.state) : [tr.state];
      for (const n of outs) {
        positions.add(pkey(n.mousePosition));
        if (n.phase === GamePhase.CatWins || n.phase === GamePhase.MouseWins) continue;
        if (n.currentPlayer !== PieceType.Mouse && n.phase !== GamePhase.ChoosingTunnelExit) continue;
        stack.push(n);
      }
    }
  }
  return positions;
}

/** Every cat cell the simulator can reach inside ONE cat turn (pushes included). */
function catReachWithinTurn(base: GameEngineState, reverse = false): { positions: Set<string>; states: number; truncated: boolean } {
  const positions = new Set<string>([pkey(base.catPosition)]);
  const seen = new Set<string>();
  const stack: Array<{ s: GameEngineState; depth: number }> = [{ s: base, depth: 0 }];
  let truncated = false;
  while (stack.length > 0) {
    const { s, depth } = stack.pop()!;
    if (depth >= 4) continue;
    const k = stateKey(s);
    if (seen.has(k)) continue;
    seen.add(k);
    if (seen.size > 200_000) { truncated = true; break; }
    let acts = generateLegalSearchActions(s, rules);
    if (reverse) acts = [...acts].reverse();
    for (const a of acts) {
      const tr = simulateSearchAction(s, a, rules);
      if (tr.kind !== 'deterministic') continue;
      const ns = tr.state;
      positions.add(pkey(ns.catPosition));
      if (ns.phase !== GamePhase.Playing) continue;
      stack.push({ s: ns, depth: depth + 1 });
    }
  }
  return { positions, states: seen.size, truncated };
}

// ---------------------------------------------------------------------------
// Voronoi diagnostics: H1's own kernels vs a real-simulator recomputation
// ---------------------------------------------------------------------------
type Owner = 'cat' | 'mouse' | 'contest';
function voronoiOwners(
  s: GameEngineState,
  mouseMap: Map<string, number>,
  catMap: Map<string, number>,
): Map<string, Owner> {
  const owners = new Map<string, Owner>();
  const holes = new Set(holeCells(s).map(pkey));
  for (let r = 0; r < BOARD_SIZE; r++) {
    for (let c = 0; c < BOARD_SIZE; c++) {
      const cell = s.board[r][c];
      if (cell.type === CellType.Tunnel) continue;
      if (holes.has(`${r},${c}`)) continue;
      if (cell.type === CellType.Box) continue;
      if (cell.type === CellType.Pile || cell.type === CellType.Wall) continue;
      if (cell.type === CellType.Void) continue;
      const cd = catMap.get(`${r},${c}`);
      const md = mouseMap.get(`${r},${c}`);
      if (cd === undefined && md === undefined) continue;
      if (cd !== undefined && md === undefined) owners.set(`${r},${c}`, 'cat');
      else if (md !== undefined && cd === undefined) owners.set(`${r},${c}`, 'mouse');
      else if (cd !== undefined && md !== undefined) {
        owners.set(`${r},${c}`, cd < md ? 'cat' : md < cd ? 'mouse' : 'contest');
      }
    }
  }
  return owners;
}
function ownerDiff(a: Map<string, Owner>, b: Map<string, Owner>): string[] {
  const keys = new Set([...a.keys(), ...b.keys()]);
  return [...keys].filter((k) => a.get(k) !== b.get(k)).sort();
}
function ownerCounts(m: Map<string, Owner>): { cat: number; mouse: number; contest: number; area: number } {
  let cat = 0; let mouse = 0; let contest = 0;
  for (const v of m.values()) { if (v === 'cat') cat++; else if (v === 'mouse') mouse++; else contest++; }
  return { cat, mouse, contest, area: m.size };
}

// ---------------------------------------------------------------------------
// P2 — real-rule capability comparison
// ---------------------------------------------------------------------------
test('HV17-P2 real-rule capabilities of the two final states', () => {
  const { finalL, finalU } = principalFinals();
  const bL = evaluateForCatDetailed(finalL);
  const bU = evaluateForCatDetailed(finalU);
  const holes = holeCells(finalL);

  // ---- 1. Mouse one-turn capability -------------------------------------
  const mLines = enumerateFullTurns(finalL, PieceType.Mouse);
  const uLines = enumerateFullTurns(finalU, PieceType.Mouse);
  const endPos = (c: Census) => new Set(c.lines.map((l) => pkey(l.state.mousePosition)));
  const mEnds = endPos(mLines);
  const uEnds = endPos(uLines);
  const mVisited = mouseTurnVisited(finalL);
  const uVisited = mouseTurnVisited(finalU);
  const setDiff = (a: Set<string>, b: Set<string>) => [...a].filter((x) => !b.has(x)).sort();
  const onlyL = setDiff(mEnds, uEnds);
  const onlyU = setDiff(uEnds, mEnds);
  const visitedOnlyL = setDiff(mVisited, uVisited);
  const visitedOnlyU = setDiff(uVisited, mVisited);

  // ---- 2. Mouse routes (real simulator steps) ---------------------------
  const dMouseL = realMouseDistances(finalL, [finalL.mousePosition], false);
  const dMouseU = realMouseDistances(finalU, [finalU.mousePosition], false);
  const dHoleCarryL = realMouseDistances(finalL, holes, true);
  const dHoleCarryU = realMouseDistances(finalU, holes, true);

  interface RouteRow { butter: string; d1L: number | null; d1U: number | null; d2L: number | null; d2U: number | null; routeL: number | null; routeU: number | null; }
  const routeRows: RouteRow[] = finalL.butterPositions.map((b) => {
    const dCarryL = realMouseDistances(finalL, [b], true);
    const dCarryU = realMouseDistances(finalU, [b], true);
    const d1L = dMouseL.get(pkey(b)) ?? null;
    const d1U = dMouseU.get(pkey(b)) ?? null;
    const d2L = Math.min(...holes.map((h) => dCarryL.get(pkey(h)) ?? Infinity));
    const d2U = Math.min(...holes.map((h) => dCarryU.get(pkey(h)) ?? Infinity));
    const d2Lv = Number.isFinite(d2L) ? d2L : null;
    const d2Uv = Number.isFinite(d2U) ? d2U : null;
    return {
      butter: pkey(b), d1L, d1U, d2L: d2Lv, d2U: d2Uv,
      routeL: d1L !== null && d2Lv !== null ? d1L + d2Lv : null,
      routeU: d1U !== null && d2Uv !== null ? d1U + d2Uv : null,
    };
  });
  const bestRouteL = routeRows.reduce<number | null>((m, r) => (r.routeL === null ? m : m === null ? r.routeL : Math.min(m, r.routeL)), null);
  const bestRouteU = routeRows.reduce<number | null>((m, r) => (r.routeU === null ? m : m === null ? r.routeU : Math.min(m, r.routeU)), null);

  // shortest-route cell sets (both legs, any butter)
  const routeCells = (base: GameEngineState, dMouse: Map<string, number>, dHoleCarry: Map<string, number>): Set<string> => {
    const cells = new Set<string>();
    for (const b of base.butterPositions) {
      const d1 = dMouse.get(pkey(b));
      if (d1 === undefined) continue;
      const dFrom = realMouseDistances(base, [b], false);
      const dCarry = realMouseDistances(base, [b], true);
      const d2 = Math.min(...holes.map((h) => dCarry.get(pkey(h)) ?? Infinity));
      for (let r = 0; r < BOARD_SIZE; r++) {
        for (let c = 0; c < BOARD_SIZE; c++) {
          const k = `${r},${c}`;
          if (dMouse.get(k) !== undefined && dFrom.get(k) !== undefined && dMouse.get(k)! + dFrom.get(k)! === d1) cells.add(k);
          if (Number.isFinite(d2) && dCarry.get(k) !== undefined && dHoleCarry.get(k) !== undefined
            && dCarry.get(k)! + dHoleCarry.get(k)! === d2) cells.add(k);
        }
      }
    }
    return cells;
  };

  // ---- 3. Tunnels --------------------------------------------------------
  const tunnels: Pt[] = [{ r: 0, c: 0 }, { r: 0, c: BOARD_SIZE - 1 }, { r: BOARD_SIZE - 1, c: 0 }, { r: BOARD_SIZE - 1, c: BOARD_SIZE - 1 }];
  const tunnelText = tunnels.map(pkey).join('|');
  const tunnelRow = (d: Map<string, number>) => tunnels.map((t) => `${pkey(t)}:${d.get(pkey(t)) ?? 'x'}`).join(' ');

  // ---- 4. Cat next-turn capability -------------------------------------
  const catHypo = (s: GameEngineState): GameEngineState => ({
    ...s, currentPlayer: PieceType.Cat, phase: GamePhase.Playing, catMovesLeft: s.config.catBaseMoves, mouseMovesLeft: 0,
  });
  const cLinesL = enumerateFullTurns(catHypo(finalL), PieceType.Cat);
  const cLinesU = enumerateFullTurns(catHypo(finalU), PieceType.Cat);
  const cEnds = (c: Census) => new Set(c.lines.map((l) => pkey(l.state.catPosition)));
  const cEndsL = cEnds(cLinesL);
  const cEndsU = cEnds(cLinesU);
  const catOnlyL = setDiff(cEndsL, cEndsU);
  const catOnlyU = setDiff(cEndsU, cEndsL);
  const pushLines = (c: Census) => c.lines.filter((l) => l.pushes > 0).length;
  const pushEnds = (c: Census) => new Set(c.lines.filter((l) => l.pushes > 0).map((l) => pkey(l.state.catPosition)));
  const captureLines = (c: Census) => c.lines.filter((l) => l.state.phase === GamePhase.CatWins).length;
  const cReachL = catReachWithinTurn(catHypo(finalL));
  const cReachU = catReachWithinTurn(catHypo(finalU));
  const catReachOnlyL = setDiff(cReachL.positions, cReachU.positions);
  const catReachOnlyU = setDiff(cReachU.positions, cReachL.positions);
  const capturableL = [...mEnds].filter((k) => cReachL.positions.has(k)).sort();
  const capturableU = [...uEnds].filter((k) => cReachU.positions.has(k)).sort();

  const catWalkL = realCatWalkDistances(finalL);
  const catWalkU = realCatWalkDistances(finalU);
  const catPushL = buildCatPushDistanceMap(finalL);
  const catPushU = buildCatPushDistanceMap(finalU);
  const mouseKey = pkey(finalL.mousePosition);

  // ---- 5. Voronoi diagnostics ------------------------------------------
  const h1MouseL = buildMouseDistanceMap(finalL);
  const h1MouseU = buildMouseDistanceMap(finalU);
  const h1CatL = buildCatDistanceMap(finalL);
  const h1CatU = buildCatDistanceMap(finalU);
  const realMouseMapL = realMouseDistances(finalL, [finalL.mousePosition], false);
  const realMouseMapU = realMouseDistances(finalU, [finalU.mousePosition], false);
  const realCatWalkMapL = catWalkL;
  const realCatWalkMapU = catWalkU;

  const vH1L = voronoiOwners(finalL, h1MouseL, h1CatL);
  const vH1U = voronoiOwners(finalU, h1MouseU, h1CatU);
  const vRealMouseL = voronoiOwners(finalL, realMouseMapL, h1CatL);
  const vRealMouseU = voronoiOwners(finalU, realMouseMapU, h1CatU);
  const vRealL = voronoiOwners(finalL, realMouseMapL, realCatWalkMapL);
  const vRealU = voronoiOwners(finalU, realMouseMapU, realCatWalkMapU);
  const flipsH1 = ownerDiff(vH1L, vH1U);
  const flipsRealMouse = ownerDiff(vRealMouseL, vRealMouseU);
  const flipsReal = ownerDiff(vRealL, vRealU);

  const cellInfo = (k: string): string => {
    const [r, c] = k.split(',').map(Number);
    const cell = finalL.board[r][c];
    const bt = finalL.butterPositions.some((b) => b.r === r && b.c === c) ? ' butter' : '';
    const tr = finalL.trapPosition?.r === r && finalL.trapPosition?.c === c ? ' trap' : '';
    const nearHole = holes.some((h) => Math.abs(h.r - r) + Math.abs(h.c - c) <= 1) ? ' holeAdj' : '';
    return `(${k}) type=${cell.type}${bt}${tr}${nearHole}`
      + ` h1m=${h1MouseL.get(k) ?? 'x'}/${h1MouseU.get(k) ?? 'x'}`
      + ` h1c=${h1CatL.get(k) ?? 'x'}/${h1CatU.get(k) ?? 'x'}`
      + ` realm=${realMouseMapL.get(k) ?? 'x'}/${realMouseMapU.get(k) ?? 'x'}`
      + ` realc=${realCatWalkMapL.get(k) ?? 'x'}/${realCatWalkMapU.get(k) ?? 'x'}`
      + ` pushc=${catPushL.get(k) ?? 'x'}/${catPushU.get(k) ?? 'x'}`;
  };

  const routeCellsL = routeCells(finalL, dMouseL, dHoleCarryL);
  const routeCellsU = routeCells(finalU, dMouseU, dHoleCarryU);
  const onRoute = (k: string) => `${routeCellsL.has(k) ? 'L' : ''}${routeCellsU.has(k) ? 'U' : ''}` || '-';

  // eslint-disable-next-line no-console
  console.log(
    `\nHV17-P2 real-rule capability comparison\n`
    + `  mouse one-turn: lines L=${mLines.lines.length} U=${uLines.lines.length}`
    + ` ends L=${mEnds.size} U=${uEnds.size} onlyL=[${onlyL.join(' ')}] onlyU=[${onlyU.join(' ')}]\n`
    + `  mouse one-turn visited: L=${mVisited.size} U=${uVisited.size} onlyL=[${visitedOnlyL.join(' ')}] onlyU=[${visitedOnlyU.join(' ')}]\n`
    + `  butter routes (real simulator, actions; d1=mouse->butter d2=butter->hole carrying):\n`
    + routeRows.map((r) => `    butter(${r.butter}) d1=${r.d1L}/${r.d1U} d2=${r.d2L}/${r.d2U} winRoute=${r.routeL}/${r.routeU}`).join('\n')
    + `\n    best winRoute L=${bestRouteL} U=${bestRouteU}`
    + ` H1 features butterDist=${bL.features.mouseButterDistance}/${bU.features.mouseButterDistance}`
    + ` winRoute=${bL.features.mouseWinRouteDistance}/${bU.features.mouseWinRouteDistance}\n`
    + `    route-cell set diff L-only=[${[...routeCellsL].filter((k) => !routeCellsU.has(k)).sort().join(' ')}]`
    + ` U-only=[${[...routeCellsU].filter((k) => !routeCellsL.has(k)).sort().join(' ')}]\n`
    + `  tunnels: ${tunnelText} blocked=[${finalL.blockedTunnels.map(pkey).join(' ')}]`
    + ` mouse=(${rc(finalL.mousePosition)}) entryAllowed=${!finalL.mouseHasButter}`
    + ` realDist L=${tunnelRow(dMouseL)} U=${tunnelRow(dMouseU)}`
    + ` H1dist L=${tunnelRow(h1MouseL)} U=${tunnelRow(h1MouseU)}\n`
    + `  cat one-turn (real, pushes included): lines L=${cLinesL.lines.length} U=${cLinesU.lines.length}`
    + ` ends L=${cEndsL.size} U=${cEndsU.size} onlyL=[${catOnlyL.join(' ')}] onlyU=[${catOnlyU.join(' ')}]\n`
    + `    push-lines L=${pushLines(cLinesL)} U=${pushLines(cLinesU)} push-end-cells L=${pushEnds(cLinesL).size} U=${pushEnds(cLinesU).size}`
    + ` pushEnd-onlyL=[${setDiff(pushEnds(cLinesL), pushEnds(cLinesU)).join(' ')}] pushEnd-onlyU=[${setDiff(pushEnds(cLinesU), pushEnds(cLinesL)).join(' ')}]\n`
    + `    capture-lines L=${captureLines(cLinesL)} U=${captureLines(cLinesU)}`
    + ` reach-cells L=${cReachL.positions.size} U=${cReachU.positions.size} onlyL=[${catReachOnlyL.join(' ')}] onlyU=[${catReachOnlyU.join(' ')}]\n`
    + `    cat->mouse: walk L=${catWalkL.get(mouseKey) ?? 'x'} U=${catWalkU.get(mouseKey) ?? 'x'}`
    + ` push-aware L=${catPushL.get(mouseKey) ?? 'x'} U=${catPushU.get(mouseKey) ?? 'x'}\n`
    + `    mouse end cells capturable by cat within one turn: L=${capturableL.length} [${capturableL.join(' ')}] U=${capturableU.length} [${capturableU.join(' ')}]\n`
    + `  trap=(${finalL.trapPosition ? rc(finalL.trapPosition) : 'none'}) mouseRealDist L=${dMouseL.get(pkey(finalL.trapPosition!)) ?? 'x'}`
    + ` U=${dMouseU.get(pkey(finalL.trapPosition!)) ?? 'x'} onRoute=${onRoute(pkey(finalL.trapPosition!))}\n`
    + `  outcomes: mouse-win lines L=${mLines.lines.filter((l) => l.state.phase === GamePhase.MouseWins).length}`
    + ` U=${uLines.lines.filter((l) => l.state.phase === GamePhase.MouseWins).length};`
    + ` cat-win (mouse at 9,0) L=${captureLines(cLinesL)} U=${captureLines(cLinesU)}\n`
    + `  Voronoi H1: L=${JSON.stringify(ownerCounts(vH1L))} U=${JSON.stringify(ownerCounts(vH1U))}`
    + ` flips=[${flipsH1.join(' ')}]\n`
    + `    flip cells: ${flipsH1.map(cellInfo).join(' ; ')}\n`
    + `    route membership of H1 flips: ${flipsH1.map((k) => `${k}:${onRoute(k)}`).join(' ')}\n`
    + `  Voronoi real-mouse + H1-cat: L=${JSON.stringify(ownerCounts(vRealMouseL))} U=${JSON.stringify(ownerCounts(vRealMouseU))}`
    + ` flips=[${flipsRealMouse.join(' ')}]\n`
    + `  Voronoi fully real (mouse real, cat walk real): L=${JSON.stringify(ownerCounts(vRealL))} U=${JSON.stringify(ownerCounts(vRealU))}`
    + ` flips=[${flipsReal.join(' ')}]\n`
    + `    flip cells: ${flipsReal.map(cellInfo).join(' ; ')}\n`
    + `  mouse features: mobility=${bL.features.mouseMobility}/${bU.features.mouseMobility}`
    + ` area=${bL.features.mouseReachableArea}/${bU.features.mouseReachableArea}`
    + ` catMobility=${bL.features.catMobility}/${bU.features.catMobility}`
    + ` catArea=${bL.features.catReachableArea}/${bU.features.catReachableArea}`
    + ` catMouseDist=${bL.features.catMouseDistance}/${bU.features.catMouseDistance}`
    + ` gates=${bL.features.catHoleGateDistance}/${bU.features.catHoleGateDistance},${bL.features.mouseHoleGateDistance}/${bU.features.mouseHoleGateDistance}\n`,
  );

  // Hard facts that P3/P4 lean on:
  expect(finalL.butterPositions).toEqual(finalU.butterPositions);
  expect(cReachL.truncated).toBe(false);
  expect(cReachU.truncated).toBe(false);
  expect(mLines.truncated).toBe(false);
  expect(uLines.truncated).toBe(false);
  expect(cLinesL.truncated).toBe(false);
  expect(cLinesU.truncated).toBe(false);
  expect(pushLines(cLinesL)).toBeGreaterThan(0);
  expect(flipsH1.length).toBeGreaterThan(0);
}, 180000);

// ---------------------------------------------------------------------------
// P3 — reverse controls
// ---------------------------------------------------------------------------
const symdiff = (a: Iterable<string>, b: Iterable<string>): string[] => {
  const A = new Set(a); const B = new Set(b);
  return [...new Set([...A, ...B])].filter((x) => A.has(x) !== B.has(x)).sort();
};
const catToMove = (s: GameEngineState): GameEngineState => ({
  ...s, currentPlayer: PieceType.Cat, phase: GamePhase.Playing, catMovesLeft: s.config.catBaseMoves, mouseMovesLeft: 0,
});

/** Test harness only: move the cat piece so a kernel legality probe starts from `pos`. */
function placeCat(s: GameEngineState, pos: Pt, moves = 1): GameEngineState {
  const board = s.board.map((row) => row.map((cell) => ({ ...cell, piece: undefined as typeof cell.piece })));
  board[pos.r][pos.c] = { ...board[pos.r][pos.c], piece: PieceType.Cat };
  return { ...s, board, catPosition: { ...pos }, currentPlayer: PieceType.Cat, phase: GamePhase.Playing, catMovesLeft: moves, mouseMovesLeft: 0 };
}

function mouseWalkable(s: GameEngineState): string[] {
  const out: string[] = [];
  for (let r = 0; r < BOARD_SIZE; r++) {
    for (let c = 0; c < BOARD_SIZE; c++) {
      const t = s.board[r][c].type;
      if (t === CellType.Box || t === CellType.Pile || t === CellType.Wall || t === CellType.Void) continue;
      if (s.catPosition.r === r && s.catPosition.c === c) continue;
      out.push(`${r},${c}`);
    }
  }
  return out.sort();
}
function catWalkable(s: GameEngineState): string[] {
  const holes = new Set(holeCells(s).map(pkey));
  const butters = new Set(s.butterPositions.map(pkey));
  const out: string[] = [];
  for (let r = 0; r < BOARD_SIZE; r++) {
    for (let c = 0; c < BOARD_SIZE; c++) {
      const k = `${r},${c}`;
      const t = s.board[r][c].type;
      if (t === CellType.Box || t === CellType.Pile || t === CellType.Wall || t === CellType.Void) continue;
      if (t === CellType.Tunnel) continue;
      if (holes.has(k) || butters.has(k)) continue;
      if (s.mousePosition.r === r && s.mousePosition.c === c) continue;
      out.push(k);
    }
  }
  return out.sort();
}

test('HV17-P3 reverse controls', () => {
  const { finalL, finalU } = principalFinals();
  const bL = evaluateForCatDetailed(finalL);
  const bU = evaluateForCatDetailed(finalU);

  // C1 — same coordinates, different box => different stateKey, never merged.
  expect(stateKey(finalL)).not.toBe(stateKey(finalU));
  const diffCells: string[] = [];
  for (let r = 0; r < BOARD_SIZE; r++) {
    for (let c = 0; c < BOARD_SIZE; c++) {
      const a = finalL.board[r][c]; const b = finalU.board[r][c];
      if (a.type !== b.type || a.hasButter !== b.hasButter) diffCells.push(`(${r},${c})`);
    }
  }
  expect(diffCells).toEqual(['(1,6)', '(3,6)']);

  // C2 — repeated full-state evaluation is bit-identical.
  expect(evaluateCorrectedHoleForCat(finalL)).toBe(evaluateCorrectedHoleForCat(finalL));
  expect(evaluateCorrectedHoleForCat(finalU)).toBe(evaluateCorrectedHoleForCat(finalU));
  expect(bL.contributions).toEqual(evaluateForCatDetailed(finalL).contributions);

  // C3 — reversing the enumeration order never changes the result set.
  const lineSig = (c: Census) => c.lines
    .map((l) => `${stateKey(l.state)}|${l.actions.map(actionText).join('')}|${l.pushes}`)
    .sort();
  expect(lineSig(enumerateFullTurns(finalL, PieceType.Mouse))).toEqual(lineSig(enumerateFullTurns(finalL, PieceType.Mouse, true)));
  expect(lineSig(enumerateFullTurns(catToMove(finalL), PieceType.Cat))).toEqual(lineSig(enumerateFullTurns(catToMove(finalL), PieceType.Cat, true)));
  expect([...mouseTurnVisited(finalL)].sort()).toEqual([...mouseTurnVisited(finalL, true)].sort());
  expect([...catReachWithinTurn(catToMove(finalL)).positions].sort())
    .toEqual([...catReachWithinTurn(catToMove(finalL), true).positions].sort());

  // C4 — only real impassability counts as blocked.
  const mouseMapL = realMouseDistances(finalL, [finalL.mousePosition], false);
  const mouseMapU = realMouseDistances(finalU, [finalU.mousePosition], false);
  const mouseReachDiff = symdiff(mouseMapL.keys(), mouseMapU.keys());
  expect(mouseReachDiff, 'unbounded mouse reach differs exactly at the two box cells').toEqual(['1,6', '3,6']);
  const unwalkable = mouseWalkable(finalL).filter((k) => !mouseMapL.has(k));
  const unwalkableU = mouseWalkable(finalU).filter((k) => !mouseMapU.has(k));
  expect(unwalkable, 'no walkable cell is falsely treated as blocked (L)').toEqual([]);
  expect(unwalkableU, 'no walkable cell is falsely treated as blocked (U)').toEqual([]);

  // (3,6) is genuinely passable only when the box moved away — proven by the simulator.
  const stepProbe = (base: GameEngineState, from: Pt, d: string): GameEngineState => {
    const s = { ...base, currentPlayer: PieceType.Mouse, phase: GamePhase.Playing, mousePosition: { ...from }, mouseMovesLeft: 2 };
    const tr = simulateSearchAction(s, mouseStep(d), rules);
    if (tr.kind !== 'deterministic') throw new Error('unexpected chance');
    return tr.state;
  };
  const stepL = stepProbe(finalL, { r: 3, c: 5 }, 'ArrowRight');
  const stepU = stepProbe(finalU, { r: 3, c: 5 }, 'ArrowRight');
  expect(rc(stepL.mousePosition), '(3,6) is blocked by the box in L').toBe('3,5');
  expect(rc(stepU.mousePosition), '(3,6) is passable in U').toBe('3,6');

  const catMapL = realCatWalkDistances(finalL);
  const catMapU = realCatWalkDistances(finalU);
  expect(symdiff(catMapL.keys(), catMapU.keys()), 'cat walk reach differs exactly at the two box cells').toEqual(['1,6', '3,6']);
  const catUnwalkable = catWalkable(finalL).filter((k) => !catMapL.has(k));
  const catUnwalkableU = catWalkable(finalU).filter((k) => !catMapU.has(k));
  expect(catUnwalkable, 'no cat-walkable cell is falsely blocked (L)').toEqual([]);
  expect(catUnwalkableU, 'no cat-walkable cell is falsely blocked (U)').toEqual([]);
  expect(finalL.blockedTunnels).toEqual([]);
  expect(finalU.blockedTunnels).toEqual([]);
  for (const t of [{ r: 0, c: 0 }, { r: 0, c: 9 }, { r: 9, c: 0 }, { r: 9, c: 9 }]) {
    expect(finalL.board[t.r][t.c].type, `tunnel ${t.r},${t.c} remains usable`).toBe(CellType.Tunnel);
  }

  // C5 — cat pushes follow GAMEPLAY.md §4.2 through the real kernel.
  const legal = placeCat(finalU, { r: 2, c: 6 });
  const pushUp = simulateSearchAction(legal, catStep('ArrowUp'), rules);
  expect(pushUp.kind).toBe('deterministic');
  if (pushUp.kind !== 'deterministic') throw new Error('unreachable');
  expect(rc(pushUp.state.catPosition), 'legal push: cat takes the vacated cell').toBe('1,6');
  expect(pushUp.state.board[0][6].type, 'legal push: box lands on the empty destination').toBe(CellType.Box);
  expect(pushUp.state.board[1][6].type, 'legal push: old box cell becomes empty').toBe(CellType.Empty);

  const blockedByBox = placeCat(finalU, { r: 1, c: 7 });
  const illegalPush = simulateSearchAction(blockedByBox, catStep('ArrowLeft'), rules);
  expect(illegalPush.kind).toBe('deterministic');
  if (illegalPush.kind !== 'deterministic') throw new Error('unreachable');
  expect(rc(illegalPush.state.catPosition), 'push into another box is refused').toBe('1,7');
  expect(illegalPush.state.board[1][6].type, 'box does not move on an illegal push').toBe(CellType.Box);

  const mouseOnDest = { ...placeCat(finalU, { r: 2, c: 6 }), mousePosition: { r: 0, c: 6 } };
  const pushIntoTarget = simulateSearchAction(mouseOnDest, catStep('ArrowUp'), rules);
  expect(pushIntoTarget.kind).toBe('deterministic');
  if (pushIntoTarget.kind !== 'deterministic') throw new Error('unreachable');
  expect(rc(pushIntoTarget.state.catPosition), 'push into the mouse cell is refused').toBe('2,6');

  // C6 — the human log's FUTURE moves are never read.
  expect(READ_LOG_TURNS).toEqual([7]);
  expect(() => turnSegment(8), 'Turn #8 is mechanically blocked').toThrow(/refuses to read/);
  // The mouse reply `lllEXIT(9,0)` is the HV16 exhaustive best response, not a human move.

  // C7 — H1 is not independent truth.
  const dH1 = h1Parts(bU).map((v, i) => v - h1Parts(bL)[i]);
  const nonzero = CONTRIB_KEYS.map((k, i) => ({ k, v: dH1[i] })).filter((x) => Math.abs(x.v) > 1e-12);
  expect(nonzero).toEqual([{ k: 'voronoiBalance', v: 31.578947368421055 }]);

  const mLines = enumerateFullTurns(finalL, PieceType.Mouse);
  const uLines = enumerateFullTurns(finalU, PieceType.Mouse);
  expect(new Set(mLines.lines.map((l) => pkey(l.state.mousePosition))))
    .toEqual(new Set(uLines.lines.map((l) => pkey(l.state.mousePosition))));

  const bestRoute = (s: GameEngineState): number | null => {
    const holes = holeCells(s);
    const dm = realMouseDistances(s, [s.mousePosition], false);
    let best: number | null = null;
    for (const b of s.butterPositions) {
      const d1 = dm.get(pkey(b));
      if (d1 === undefined) continue;
      const dc = realMouseDistances(s, [b], true);
      const d2 = Math.min(...holes.map((h) => dc.get(pkey(h)) ?? Infinity));
      if (!Number.isFinite(d2)) continue;
      const total = d1 + d2;
      best = best === null ? total : Math.min(best, total);
    }
    return best;
  };
  expect(bestRoute(finalL), 'best mouse win route is unchanged').toBe(14);
  expect(bestRoute(finalU), 'best mouse win route is unchanged').toBe(14);

  const cReachL = catReachWithinTurn(catToMove(finalL));
  const cReachU = catReachWithinTurn(catToMove(finalU));
  const mEndsL = new Set(mLines.lines.map((l) => pkey(l.state.mousePosition)));
  const mEndsU = new Set(uLines.lines.map((l) => pkey(l.state.mousePosition)));
  expect([...mEndsL].filter((k) => cReachL.positions.has(k))).toEqual([]);
  expect([...mEndsU].filter((k) => cReachU.positions.has(k))).toEqual([]);
  expect(cLinesPhase1(finalU)).toBe(0);

  // The +31.58 therefore lives ONLY in the H1 Voronoi signal, not in a proven outcome.
  expect(bL.contributions.voronoiBalance).toBe(-110.52631578947368);
  expect(bU.contributions.voronoiBalance - bL.contributions.voronoiBalance).toBeCloseTo(31.57894736842104, 12);

  // eslint-disable-next-line no-console
  console.log(
    `\nHV17-P3 reverse controls: all 7 PASS\n`
    + `  C1 stateKey L=${stateKey(finalL)}\n              U=${stateKey(finalU)} diff=${JSON.stringify(diffCells)}\n`
    + `  C2 H1 L=${evaluateCorrectedHoleForCat(finalL)} U=${evaluateCorrectedHoleForCat(finalU)} (repeat bit-identical)\n`
    + `  C3 mouse/cat line sets and reach sets invariant under reversed enumeration\n`
    + `  C4 mouse reach diff=${JSON.stringify(mouseReachDiff)} cat reach diff=${JSON.stringify(symdiff(catMapL.keys(), catMapU.keys()))}`
    + ` walkable-unreachable L=${unwalkable.length} U=${unwalkableU.length}; cat-unreachable L=${catUnwalkable.length} U=${catUnwalkableU.length}\n`
    + `  C5 push rules: legal push -> cat(1,6)/box(0,6); illegal box-dest and mouse-dest both no-op\n`
    + `  C6 log reader refuses Turn #8; only Turn #7 read; reply is search-derived (HV16)\n`
    + `  C7 only voronoiBalance moves: ${JSON.stringify(nonzero)}; best win route 14/14; one-turn mouse ends identical; captures 0\n`,
  );
});

/** Helper used by C7: no cat capture terminal within one turn from the cat-to-move probe. */
function cLinesPhase1(s: GameEngineState): number {
  return enumerateFullTurns(catToMove(s), PieceType.Cat).lines.filter((l) => l.state.phase === GamePhase.CatWins).length;
}
