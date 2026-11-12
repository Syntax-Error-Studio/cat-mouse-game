/// <reference types="node" />
/**
 * PPC-HV18 — real-game avoidable-loss forensics (light, read-only production).
 *
 * Roots: GAME4 T7/T8 (mouse-win game), GAME2 T4 (D1/D2 disagreement).
 * Reverse controls: GAME1 T1 (pickup unavoidable), GAME2 T7 (H1 plateau),
 * GAME3 T8 / GAME5 T12 (immediate legal cat capture).
 *
 * Every root is restored from the printed SNAPSHOT_JSON and re-hashed against
 * the printed STATE_KEY. Production 100 ms decisions are read from the log as
 * witnesses (the wall-clock deadline is not bit-reproducible). Completed
 * no-deadline searches are reproduced separately with an explicit node cap and
 * must report `completed` before any value is used as exact evidence.
 *
 * The bounded tactical analysis enumerates complete legal cat turns, complete
 * legal mouse turns and ALL formal chance outcomes (no sampling), under hard
 * node/state caps. A capped run is INCOMPLETE and is never promoted to proof.
 *
 * No production source is edited. No self-play, no large oracle, no training.
 */
import { expect, test } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createEngineRuleSet } from '../../engine';
import type { GameEngineState } from '../../engine';
import { CellType, DIRECTIONS, GamePhase, PieceType } from '../../types';
import { restoreHardRoot, type HardRootSnapshot } from '../hardHistory';
import { createSearchContext, searchBestAction } from '../expectiminimax';
import { generateLegalSearchActions } from '../legalActions';
import { evaluateCorrectedHoleForCat } from '../correctedHoleLeaf';
import { dirKey, extractBestCatTurnPlan } from '../planQuality';
import { simulateSearchAction } from '../simulator';
import { stateKey } from '../transposition';
import type { SearchAction } from '../searchTypes';

const LOG_DIR = new URL('../../../../ai-training/human-logs/PPC-HV14/', import.meta.url);
const GAMES = ['GAME1', 'GAME2', 'GAME3', 'GAME4', 'GAME5'] as const;
const LOG_SHA256: Record<(typeof GAMES)[number], string> = {
  GAME1: '2ac38df46877bdc17cc05f4a241e7e23811a43d8029f42db3a075d22f851f2e3',
  GAME2: '12cdbb6a6d1930e78b656d53d6675fe2db930d825e646c8b40dce0c4b11954c4',
  GAME3: 'a7598bf6403bf441f9624dc1fa9738aca820d6434d389a9507e2fdbf6af543d7',
  GAME4: '752b033310c773b5a2b0a7c153b09f5b7b467c4c3bc822e631f51aed15882b21',
  GAME5: 'f84d877ac4d3dedabda46b1774107f4533827c9e05e28d33b3dfc313909fe4b2',
};

const rules = createEngineRuleSet();
const rc = (p: { r: number; c: number }): string => `${p.r},${p.c}`;
const token = (a: SearchAction): string =>
  a.type === 'catPlaceTrap' ? 'T' : a.type === 'catStep' ? a.direction!.key.replace('Arrow', '').slice(0, 1) : '?';
const planText = (p: SearchAction[]): string => p.map(token).join('');

function logText(game: (typeof GAMES)[number]): string {
  return readFileSync(new URL(`${game}_H1.txt`, LOG_DIR), 'utf8');
}

function parseTurnBlocks(text: string): { turn: number; lines: string[] }[] {
  const lines = text.split(/\r?\n/);
  const starts: number[] = [];
  lines.forEach((l, i) => {
    if (/^Turn #\d+$/.test(l.trim())) starts.push(i);
  });
  return starts.map((s, k) => ({
    turn: Number(/^Turn #(\d+)$/.exec(lines[s].trim())![1]),
    lines: lines.slice(s + 1, k + 1 < starts.length ? starts[k + 1] : lines.length),
  }));
}

function field(lines: string[], prefix: string): string {
  return lines.find((l) => l.startsWith(prefix))?.slice(prefix.length).trim() ?? '';
}

function parsePlan(line: string): SearchAction[] {
  const text = line.replace(/^PLAN:\s*/, '').trim();
  if (!text) return [];
  return text.split('→').map((part) => {
    const p = part.trim();
    if (p === 'catPlaceTrap') return { type: 'catPlaceTrap' } as SearchAction;
    const m = /^catStep Arrow(Up|Down|Left|Right)$/.exec(p);
    if (!m) throw new Error(`unparsed plan token: ${p}`);
    return { type: 'catStep', direction: DIRECTIONS.find((d) => d.key === `Arrow${m[1]}`)! } as SearchAction;
  });
}

interface Root {
  game: (typeof GAMES)[number];
  turn: number;
  state: GameEngineState;
  loggedKey: string;
  lines: string[];
  plan: SearchAction[];
  execKey: string;
  loggedDepth: number | null;
  loggedBest: string;
  loggedValue: number | null;
  rootActions: { key: string; value: number; mate: string | null; bound: string }[];
}

function restoreTurn(game: (typeof GAMES)[number], block: { turn: number; lines: string[] }): Root {
  const snap = JSON.parse(field(block.lines, 'SNAPSHOT_JSON=')) as HardRootSnapshot;
  const state = restoreHardRoot(snap);
  const searchLine = block.lines.find((l) => l.startsWith('SEARCH:')) ?? '';
  const depthMatch = /cDepth=(\d+)/.exec(searchLine);
  const rootActions: Root['rootActions'] = [];
  let inRootActions = false;
  for (const l of block.lines) {
    if (l.startsWith('ROOT_ACTIONS:')) { inRootActions = true; continue; }
    if (!inRootActions) continue;
    const m = /^\s*Arrow(Up|Down|Left|Right): value=([-\d.eE+]+), mate=(\S+), bound=(\S+)$/.exec(l);
    if (!m) { if (rootActions.length > 0) inRootActions = false; continue; }
    rootActions.push({ key: `Arrow${m[1]}`, value: Number(m[2]), mate: m[3] === 'null' ? null : m[3], bound: m[4] });
  }
  return {
    game,
    turn: block.turn,
    state,
    loggedKey: field(block.lines, 'STATE_KEY='),
    lines: block.lines,
    plan: parsePlan(field(block.lines, 'PLAN:')),
    execKey: field(block.lines, 'EXEC:').replace(/^endState=/, '').split(/\s+/)[0],
    loggedDepth: depthMatch ? Number(depthMatch[1]) : null,
    loggedBest: /BEST_ACTION=(\S+)/.exec(block.lines.join('\n'))?.[1] ?? '-',
    loggedValue: (() => {
      const m = /ROOT_VALUE=([-\d.eE+]+)/.exec(block.lines.join('\n'));
      return m ? Number(m[1]) : null;
    })(),
    rootActions,
  };
}

function rootOf(game: (typeof GAMES)[number], turn: number): Root {
  const block = parseTurnBlocks(logText(game)).find((b) => b.turn === turn);
  if (!block) throw new Error(`HV18 missing ${game} T${turn}`);
  return restoreTurn(game, block);
}

// --- state facts -----------------------------------------------------------

interface PlanOutcome {
  path: SearchAction[];
  end: GameEngineState;
  chance: number;
  steps: number;
  witnesses: string[];
  ok: boolean;
  reason: string;
}

function boxCells(s: GameEngineState): Set<string> {
  const out = new Set<string>();
  for (let r = 0; r < s.config.boardSize; r++) {
    for (let c = 0; c < s.config.boardSize; c++) {
      if (s.board[r][c].type === 'box') out.add(`${r},${c}`);
    }
  }
  return out;
}

function setDiff<T>(a: Set<T>, b: Set<T>): T[] {
  return [...a].filter((x) => !b.has(x)).sort();
}

/**
 * Apply a full cat plan: raw cat primitives for the EXEC-comparable endpoint,
 * then the simulator's boundary transition for the hand-off state.
 *
 * The production log snapshots EXEC immediately AFTER the final cat action and
 * BEFORE the cat->mouse hand-off (HV14-3 proved this), so `end` here is the raw
 * primitive chain. `chanceStates` is the post-boundary continuation: every
 * enumerated ghost outcome (or the single deterministic hand-off state).
 */
function applyCatPlan(root: GameEngineState, plan: SearchAction[]): PlanOutcome & { chanceStates: GameEngineState[] } {
  let cur = root;
  let execEnd = root;
  let steps = 0;
  const witnesses: string[] = [];
  let chance = 0;
  let chanceStates: GameEngineState[] = [];
  let ok = true;
  let reason = 'full-turn';
  for (let i = 0; i < plan.length; i++) {
    const a = plan[i];
    const before = cur;
    const boxesBefore = boxCells(before);
    const raw = a.type === 'catPlaceTrap'
      ? rules.catPlaceTrap(before)
      : a.type === 'catStep'
        ? rules.catMove(before, a.direction!)
        : null;
    if (!raw) { ok = false; reason = `illegal-step-${i + 1}`; break; }
    steps++;
    const boxesAfter = boxCells(raw);
    const added = setDiff(boxesAfter, boxesBefore);
    const removed = setDiff(boxesBefore, boxesAfter);
    for (const to of added) {
      witnesses.push(`#${i + 1} ${token(a)} PUSH ${removed.join('/') || '?'}->${to}`);
    }
    if (raw.trapPosition && !before.trapPosition) witnesses.push(`#${i + 1} ${token(a)} TRAP@${rc(raw.trapPosition)}`);
    if (!raw.trapPosition && before.trapPosition && raw.catPosition.r === before.trapPosition.r && raw.catPosition.c === before.trapPosition.c) {
      witnesses.push(`#${i + 1} ${token(a)} TRAP-PICKUP`);
    }
    if (raw.blockedTunnels.length !== before.blockedTunnels.length) {
      witnesses.push(`#${i + 1} ${token(a)} BLOCKED+${raw.blockedTunnels.length - before.blockedTunnels.length}`);
    }
    if (i === plan.length - 1) {
      execEnd = raw;
      const res = simulateSearchAction(before, a, rules);
      if (res.kind === 'chance') {
        chance = res.outcomes.length;
        chanceStates = res.outcomes.map((o) => o.state);
        witnesses.push(`#${i + 1} ${token(a)} CHANCE x${chance}`);
      } else {
        chanceStates = [res.state];
      }
      break;
    }
    if (raw.phase !== GamePhase.Playing || raw.currentPlayer !== PieceType.Cat || raw.catMovesLeft <= 0) {
      ok = false;
      reason = `cat-turn-ended-at-step-${i + 1}`;
      execEnd = raw;
      break;
    }
    cur = raw;
  }
  const boundary = execEnd.phase !== GamePhase.Playing
    || execEnd.currentPlayer !== PieceType.Cat
    || execEnd.catMovesLeft <= 0;
  if (ok && (steps !== plan.length || !boundary)) { ok = false; reason = 'cat-still-has-moves'; }
  if (ok && chance > 0) reason = 'chance-boundary';
  return { path: plan, end: execEnd, chance, chanceStates, steps, witnesses, ok, reason };
}

function terminalName(s: GameEngineState): string {
  return s.phase === GamePhase.CatWins ? 'CatWins' : s.phase === GamePhase.MouseWins ? 'MouseWins' : s.phase;
}

function endpointText(root: GameEngineState, plan: SearchAction[]): string {
  const p = applyCatPlan(root, plan);
  return `ok=${p.ok} end=${rc(p.end.catPosition)} cm=${p.end.catMovesLeft}`
    + ` phase=${terminalName(p.end)} chance=${p.chance} steps=${p.steps} reason=${p.reason}`;
}

// --- completed no-deadline search (certified alternative candidates) -------

const SEARCH_NODE_CAP = 500_000;

interface Certified {
  depth: number;
  best: string;
  plan: SearchAction[];
  value: number;
  mate: string | null;
  completed: boolean;
  nodes: number;
  chanceNodes: number;
  terminalNodes: number;
  rootValues: { key: string; value: number; bound: string; mate: string | null }[];
  elapsedMs: number;
}

function runCertified(root: GameEngineState, depth: number): Certified {
  const ctx = createSearchContext(rules, SEARCH_NODE_CAP, true, true, true, 0, false);
  ctx.leafEvaluator = evaluateCorrectedHoleForCat;
  ctx.capturePlan = true;
  const t0 = Date.now();
  const res = searchBestAction(root, depth, ctx);
  const elapsedMs = Date.now() - t0;
  const plan = res.catTurnPlan.length > 0
    ? res.catTurnPlan
    : extractBestCatTurnPlan(root, rules, ctx.equalPrimaryGraph ?? new Map(), ctx.planBranches);
  return {
    depth,
    best: res.action ? dirKey(res.action) : '-',
    plan,
    value: res.value,
    mate: res.mate,
    completed: res.completed,
    nodes: ctx.diagnostics.nodes,
    chanceNodes: ctx.diagnostics.chanceNodes,
    terminalNodes: ctx.diagnostics.terminalNodes,
    rootValues: ctx.rootValues.map((v) => ({ key: dirKey(v.action), value: v.value, bound: v.bound, mate: v.mate })),
    elapsedMs,
  };
}

// ===========================================================================
// HV18-1. byte identity + every printed root re-hashes (45 roots)
// ===========================================================================
test('HV18-1 five logs + all 45 roots verify', () => {
  const rows: string[] = [];
  let total = 0;
  for (const game of GAMES) {
    const bytes = readFileSync(new URL(`${game}_H1.txt`, LOG_DIR));
    const sha = createHash('sha256').update(bytes).digest('hex');
    expect(sha, `${game} SHA256`).toBe(LOG_SHA256[game]);
    const blocks = parseTurnBlocks(logText(game));
    for (const b of blocks) {
      const r = restoreTurn(game, b);
      expect(stateKey(r.state), `${game} T${b.turn} snapshot -> STATE_KEY`).toBe(r.loggedKey);
      total++;
    }
    rows.push(`${game} bytes=${bytes.length} sha256=${sha.slice(0, 12)} turns=${blocks.length}`);
  }
  // eslint-disable-next-line no-console
  console.log(`\nHV18-1\n  ${rows.join('\n  ')}\n  roots verified=${total}`);
  expect(total).toBe(45);
});

// ===========================================================================
// HV18-2. production 100 ms witness + completed no-deadline searches
// ===========================================================================
interface TargetRoot {
  game: (typeof GAMES)[number];
  turn: number;
  label: string;
}
const TARGETS: TargetRoot[] = [
  { game: 'GAME4', turn: 7, label: 'GAME4-T7' },
  { game: 'GAME4', turn: 8, label: 'GAME4-T8' },
  { game: 'GAME2', turn: 4, label: 'GAME2-T4' },
];

test('HV18-2 production witness and certified alternatives', () => {
  const rows: string[] = [];
  for (const target of TARGETS) {
    const r = rootOf(target.game, target.turn);
    const prod = applyCatPlan(r.state, r.plan);
    const cert2 = runCertified(r.state, 2);
    // D3 only where it completes under the explicit 500k-node cap. GAME4-T7
    // exhausts the cap (288,901 chance nodes) -> INCOMPLETE, never a proof.
    const cert3 = target.label === 'GAME4-T8' ? runCertified(r.state, 3) : null;
    rows.push(
      `${target.label} root cat=${rc(r.state.catPosition)} mouse=${rc(r.state.mousePosition)}`
      + ` carry=${r.state.mouseHasButter} trap=${r.state.trapPosition ? rc(r.state.trapPosition) : 'none'}`
      + ` ghosts=${r.state.pendingButterSpawns.length} debt=${r.state.pendingButterPlacementDebt ?? 0}`
      + `\n  production cDepth=${r.loggedDepth} aDepth=2 best=${r.loggedBest} v=${r.loggedValue} plan=${planText(r.plan)}`
      + ` root=[${r.rootActions.map((a) => `${a.key}:${a.value}/${a.bound}`).join(' ')}]`
      + `\n    replay ok=${prod.ok} reason=${prod.reason} steps=${prod.steps} end=${rc(prod.end.catPosition)}`
      + ` cm=${prod.end.catMovesLeft} phase=${terminalName(prod.end)} chance=${prod.chance}`
      + ` witnesses=[${prod.witnesses.join(' | ') || '-'}]`
      + `\n  D2 completed=${cert2.completed} nodes=${cert2.nodes} chance=${cert2.chanceNodes} term=${cert2.terminalNodes}`
      + ` best=${cert2.best} plan=${planText(cert2.plan)} v=${cert2.value} mate=${cert2.mate ?? 'null'}`
      + ` [${cert2.rootValues.map((a) => `${a.key}:${a.value}/${a.bound}`).join(' ')}]`
      + `\n    D2 endpoint ${endpointText(r.state, cert2.plan)}`
      + (cert3
        ? `\n  D3 completed=${cert3.completed} nodes=${cert3.nodes} chance=${cert3.chanceNodes} best=${cert3.best} plan=${planText(cert3.plan)} v=${cert3.value} mate=${cert3.mate ?? 'null'}`
          + `\n    D3 endpoint ${endpointText(r.state, cert3.plan)}`
        : ''),
    );
  }
  // eslint-disable-next-line no-console
  console.log(`\nHV18-2 production witness and completed alternatives\n  ${rows.join('\n  ')}`);
  // The production plan must replay legally to a complete cat-turn boundary.
  for (const target of TARGETS) {
    const r = rootOf(target.game, target.turn);
    const prod = applyCatPlan(r.state, r.plan);
    expect(prod.ok, `${target.label} production plan is a complete legal cat turn`).toBe(true);
    expect(stateKey(prod.end), `${target.label} replay end == EXEC`).toBe(r.execKey);
  }
}, 600_000);

// ===========================================================================
// HV18-3. bounded full-turn enumerators (cat + mouse, all chance outcomes)
// ===========================================================================
interface CapCounter {
  transitions: number;
  maxTransitions: number;
  overflow: boolean;
}
function counter(max: number): CapCounter {
  return { transitions: 0, maxTransitions: max, overflow: false };
}
function tick(c: CapCounter): boolean {
  c.transitions++;
  if (c.transitions > c.maxTransitions) {
    c.overflow = true;
    return false;
  }
  return true;
}

interface TurnSet {
  /** Unique end states after a complete turn (deduped by stateKey). */
  ends: GameEngineState[];
  /** First action (cat) or full route (mouse) witnesses, one per end. */
  paths: Map<string, string>;
  terminals: number;
  chanceLeaves: number;
  complete: boolean;
  transitions: number;
}

const CAT_TURN_CAP = 200_000;
const MOUSE_TURN_CAP = 300_000;
const MAX_CAT_ACTIONS = 12;
const MAX_MOUSE_ACTIONS = 9;

/** All complete legal CAT turns; CHANCE boundary outcomes are turn ends. */
function enumerateCatTurns(start: GameEngineState, cap = CAT_TURN_CAP): TurnSet {
  const c = counter(cap);
  const ends = new Map<string, GameEngineState>();
  const paths = new Map<string, string>();
  let terminals = 0;
  let chanceLeaves = 0;
  const walk = (s: GameEngineState, prefix: SearchAction[]): void => {
    if (c.overflow) return;
    const atBoundary = s.phase !== GamePhase.Playing
      || s.currentPlayer !== PieceType.Cat
      || s.catMovesLeft <= 0;
    if (atBoundary) {
      const k = stateKey(s);
      if (!ends.has(k)) {
        ends.set(k, s);
        paths.set(k, planText(prefix));
        if (s.phase === GamePhase.CatWins || s.phase === GamePhase.MouseWins) terminals++;
      }
      return;
    }
    if (prefix.length >= MAX_CAT_ACTIONS) return;
    const actions = generateLegalSearchActions(s, rules)
      .filter((a) => a.type === 'catStep' || a.type === 'catPlaceTrap');
    if (actions.length === 0) {
      const k = stateKey(s);
      if (!ends.has(k)) { ends.set(k, s); paths.set(k, planText(prefix)); }
      return;
    }
    for (const a of actions) {
      if (!tick(c)) return;
      const res = simulateSearchAction(s, a, rules);
      if (res.kind === 'chance') {
        chanceLeaves++;
        for (const o of res.outcomes) {
          const k = stateKey(o.state);
          if (!ends.has(k)) {
            ends.set(k, o.state);
            paths.set(k, planText([...prefix, a]));
            if (o.state.phase === GamePhase.CatWins || o.state.phase === GamePhase.MouseWins) terminals++;
          }
        }
        continue;
      }
      walk(res.state, [...prefix, a]);
    }
  };
  walk(start, []);
  return { ends: [...ends.values()], paths, terminals, chanceLeaves, complete: !c.overflow, transitions: c.transitions };
}

/** All complete legal MOUSE turns (incl. skill, tunnel exits, ALL chance outcomes). */
function enumerateMouseTurns(start: GameEngineState, cap = MOUSE_TURN_CAP): TurnSet {
  const c = counter(cap);
  const ends = new Map<string, GameEngineState>();
  const paths = new Map<string, string>();
  let terminals = 0;
  let chanceLeaves = 0;
  const walk = (s: GameEngineState, prefix: string[], depth: number): void => {
    if (c.overflow) return;
    if (s.phase === GamePhase.CatWins || s.phase === GamePhase.MouseWins) {
      const k = stateKey(s);
      if (!ends.has(k)) { ends.set(k, s); paths.set(k, prefix.join('')); terminals++; }
      return;
    }
    if (s.phase === GamePhase.ChoosingTunnelExit) {
      for (const choice of s.tunnelExitChoices) {
        if (!tick(c)) return;
        const res = simulateSearchAction(s, { type: 'chooseTunnel', r: choice.r, c: choice.c }, rules);
        if (res.kind === 'chance') {
          chanceLeaves++;
          for (const o of res.outcomes) {
            const k = stateKey(o.state);
            if (!ends.has(k)) { ends.set(k, o.state); paths.set(k, [...prefix, `X(${choice.r},${choice.c})`].join('')); }
          }
          continue;
        }
        const ns = res.state;
        if (ns.currentPlayer === PieceType.Mouse && ns.mouseMovesLeft > 0 && ns.phase === GamePhase.Playing) {
          walk(ns, [...prefix, `X(${choice.r},${choice.c})`], depth + 1);
        } else {
          const k = stateKey(ns);
          if (!ends.has(k)) { ends.set(k, ns); paths.set(k, [...prefix, `X(${choice.r},${choice.c})`].join('')); }
        }
      }
      return;
    }
    if (s.currentPlayer !== PieceType.Mouse || s.mouseMovesLeft <= 0) {
      const k = stateKey(s);
      if (!ends.has(k)) { ends.set(k, s); paths.set(k, prefix.join('')); }
      return;
    }
    if (depth >= MAX_MOUSE_ACTIONS) return;
    const actions = generateLegalSearchActions(s, rules)
      .filter((a) => a.type === 'mouseStep' || a.type === 'mouseSkill');
    if (actions.length === 0) {
      const k = stateKey(s);
      if (!ends.has(k)) { ends.set(k, s); paths.set(k, prefix.join('')); }
      return;
    }
    for (const a of actions) {
      if (!tick(c)) return;
      const res = simulateSearchAction(s, a, rules);
      const label = a.type === 'mouseSkill' ? 'K' : a.direction!.key.replace('Arrow', '').slice(0, 1);
      if (res.kind === 'chance') {
        chanceLeaves++;
        for (const o of res.outcomes) {
          const ns = o.state;
          if (ns.phase === GamePhase.Playing && ns.currentPlayer === PieceType.Mouse && ns.mouseMovesLeft > 0) {
            walk(ns, [...prefix, label], depth + 1);
          } else {
            const k = stateKey(ns);
            if (!ends.has(k)) { ends.set(k, ns); paths.set(k, [...prefix, label].join('')); }
          }
        }
        continue;
      }
      const ns = res.state;
      if (ns.phase === GamePhase.Playing && ns.currentPlayer === PieceType.Mouse && ns.mouseMovesLeft > 0) {
        walk(ns, [...prefix, label], depth + 1);
      } else {
        const k = stateKey(ns);
        if (!ends.has(k)) { ends.set(k, ns); paths.set(k, [...prefix, label].join('')); }
      }
    }
  };
  walk(start, [], 0);
  return { ends: [...ends.values()], paths, terminals, chanceLeaves, complete: !c.overflow, transitions: c.transitions };
}

/** Mouse-to-move state after the cat's turn boundary (cat budget spent). */
function mouseToMove(s: GameEngineState): GameEngineState {
  return {
    ...s,
    currentPlayer: PieceType.Mouse,
    mouseMovesLeft: s.mouseHasButter ? s.config.mouseCarryingMoves : s.config.mouseBaseMoves,
    catMovesLeft: 0,
  };
}

test('HV18-3 full-turn enumeration cost', () => {
  const rows: string[] = [];
  for (const target of TARGETS) {
    const r = rootOf(target.game, target.turn);
    const cat = enumerateCatTurns(r.state);
    // The mouse's turn starts after a cat turn; use the production plan's
    // handoff state when it is deterministic, else the first chance outcome.
    const prod = applyCatPlan(r.state, r.plan);
    const handoff = prod.chance > 0 ? prod.chanceStates[0] : prod.end;
    const m = enumerateMouseTurns(mouseToMove(handoff));
    rows.push(
      `${target.label} CAT turns: ends=${cat.ends.length} terminals=${cat.terminals} chanceLeaves=${cat.chanceLeaves}`
      + ` transitions=${cat.transitions} complete=${cat.complete}`
      + `\n  MOUSE turns: ends=${m.ends.length} terminals=${m.terminals} chanceLeaves=${m.chanceLeaves}`
      + ` transitions=${m.transitions} complete=${m.complete}`,
    );
  }
  // eslint-disable-next-line no-console
  console.log(`\nHV18-3 enumeration cost\n  ${rows.join('\n  ')}`);
  expect(rows.length).toBe(3);
}, 600_000);

// ===========================================================================
// HV18-4. bounded alternation solver — SURE-WIN semantics, no sampling
// ===========================================================================
//
// catSurvives(s_cat, h): exists a complete legal cat turn P such that for
//   EVERY official chance outcome of P, then EVERY complete legal mouse-turn
//   reply and every one of ITS chance outcomes, the cat still survives the
//   remaining h-1 cat+mouse pairs.
// mouseSafe(s_mouse, h): for every complete legal mouse turn (all chance
//   outcomes), the mouse does not win, and the recursion holds.
//
// A `yes` proves ONLY "the cat can guarantee not losing inside h pairs". It
// never means the cat wins. Any cap hit yields INCOMPLETE and aborts the whole
// query: partial exploration is never promoted to a result.

interface BudgetB {
  transitions: number;
  maxTransitions: number;
  deadline: number;
  overflow: string | null;
}
function makeBudgetB(wallMs: number, maxTransitions: number): BudgetB {
  return { transitions: 0, maxTransitions, deadline: Date.now() + wallMs, overflow: null };
}
function spendBudget(b: BudgetB, n = 1): boolean {
  b.transitions += n;
  if (b.transitions > b.maxTransitions) {
    b.overflow ??= `TRANSITION_CAP_${b.maxTransitions}`;
    return false;
  }
  if ((b.transitions & 8191) < n && Date.now() > b.deadline) {
    b.overflow ??= 'WALL_CLOCK_CAP';
    return false;
  }
  return true;
}

const CAT_TURN_CAP_B = 300_000;
const MOUSE_TURN_CAP_B = 300_000;
const MAX_CAT_ACTIONS_B = 12;
const MAX_MOUSE_ACTIONS_B = 9;

interface CatPlanTurn {
  actions: SearchAction[];
  label: string;
  first: string;
  /** Post-boundary states for THIS action sequence (all chance outcomes). */
  outcomes: GameEngineState[];
}
interface CatTurnSetB {
  plans: CatPlanTurn[];
  ends: GameEngineState[];
  terminals: number;
  chanceLeaves: number;
  chanceOutcomes: number;
  transitions: number;
  complete: boolean;
  overflow: string | null;
}

function dedupeStates(list: GameEngineState[]): GameEngineState[] {
  const seen = new Set<string>();
  const out: GameEngineState[] = [];
  for (const s of list) {
    const k = stateKey(s);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(s);
  }
  return out;
}

function enumCatPlanTurns(start: GameEngineState, b: BudgetB): CatTurnSetB {
  let n = 0;
  let overflow: string | null = null;
  const plans = new Map<string, CatPlanTurn>();
  let chanceLeaves = 0;
  let chanceOutcomes = 0;
  const add = (actions: SearchAction[], outcomes: GameEngineState[]): void => {
    if (actions.length === 0) return;
    const label = planText(actions);
    if (plans.has(label)) return;
    plans.set(label, {
      actions,
      label,
      first: actions[0].type === 'catStep' ? actions[0].direction!.key : actions[0].type,
      outcomes: dedupeStates(outcomes),
    });
  };
  const walk = (s: GameEngineState, prefix: SearchAction[]): void => {
    if (overflow || b.overflow) return;
    const atBoundary = s.phase !== GamePhase.Playing || s.currentPlayer !== PieceType.Cat || s.catMovesLeft <= 0;
    if (atBoundary) { add(prefix, [s]); return; }
    if (prefix.length >= MAX_CAT_ACTIONS_B) { add(prefix, [s]); return; }
    const actions = generateLegalSearchActions(s, rules).filter((a) => a.type === 'catStep' || a.type === 'catPlaceTrap');
    if (actions.length === 0) { add(prefix, [s]); return; }
    for (const a of actions) {
      n++;
      if (n > CAT_TURN_CAP_B) { overflow = `CAT_TURN_CAP_${CAT_TURN_CAP_B}`; return; }
      if (!spendBudget(b)) return;
      const res = simulateSearchAction(s, a, rules);
      if (res.kind === 'chance') {
        chanceLeaves++;
        chanceOutcomes += res.outcomes.length;
        add([...prefix, a], res.outcomes.map((o) => o.state));
        continue;
      }
      walk(res.state, [...prefix, a]);
    }
  };
  walk(start, []);
  const list = [...plans.values()];
  const ends = dedupeStates(list.flatMap((p) => p.outcomes));
  let terminals = 0;
  for (const e of ends) if (e.phase === GamePhase.CatWins || e.phase === GamePhase.MouseWins) terminals++;
  return { plans: list, ends, terminals, chanceLeaves, chanceOutcomes, transitions: n, complete: overflow === null, overflow };
}

interface MouseTurnSetB {
  ends: GameEngineState[];
  labels: Map<string, string>;
  terminals: number;
  chanceLeaves: number;
  chanceOutcomes: number;
  transitions: number;
  complete: boolean;
  overflow: string | null;
}

function enumMouseTurnsB(start: GameEngineState, b: BudgetB): MouseTurnSetB {
  let n = 0;
  let overflow: string | null = null;
  const ends = new Map<string, GameEngineState>();
  const labels = new Map<string, string>();
  let chanceLeaves = 0;
  let chanceOutcomes = 0;
  const addEnd = (s: GameEngineState, label: string): void => {
    const k = stateKey(s);
    if (!ends.has(k)) { ends.set(k, s); labels.set(k, label); }
  };
  const walk = (s: GameEngineState, prefix: string[], depth: number): void => {
    if (overflow || b.overflow) return;
    if (s.phase === GamePhase.CatWins || s.phase === GamePhase.MouseWins) { addEnd(s, prefix.join('')); return; }
    if (s.phase === GamePhase.ChoosingTunnelExit) {
      for (const choice of s.tunnelExitChoices) {
        n++;
        if (n > MOUSE_TURN_CAP_B) { overflow = `MOUSE_TURN_CAP_${MOUSE_TURN_CAP_B}`; return; }
        if (!spendBudget(b)) return;
        const res = simulateSearchAction(s, { type: 'chooseTunnel', r: choice.r, c: choice.c }, rules);
        const lbl = [...prefix, `X(${choice.r},${choice.c})`];
        if (res.kind === 'chance') {
          chanceLeaves++;
          chanceOutcomes += res.outcomes.length;
          for (const o of res.outcomes) addEnd(o.state, lbl.join(''));
          continue;
        }
        const ns = res.state;
        if (ns.phase === GamePhase.Playing && ns.currentPlayer === PieceType.Mouse && ns.mouseMovesLeft > 0) walk(ns, lbl, depth + 1);
        else addEnd(ns, lbl.join(''));
      }
      return;
    }
    if (s.currentPlayer !== PieceType.Mouse || s.mouseMovesLeft <= 0) { addEnd(s, prefix.join('')); return; }
    if (depth >= MAX_MOUSE_ACTIONS_B) { addEnd(s, prefix.join('')); return; }
    const actions = generateLegalSearchActions(s, rules).filter((a) => a.type === 'mouseStep' || a.type === 'mouseSkill');
    if (actions.length === 0) { addEnd(s, prefix.join('')); return; }
    for (const a of actions) {
      n++;
      if (n > MOUSE_TURN_CAP_B) { overflow = `MOUSE_TURN_CAP_${MOUSE_TURN_CAP_B}`; return; }
      if (!spendBudget(b)) return;
      const res = simulateSearchAction(s, a, rules);
      const label = a.type === 'mouseSkill' ? 'K' : a.direction!.key.replace('Arrow', '').slice(0, 1);
      if (res.kind === 'chance') {
        chanceLeaves++;
        chanceOutcomes += res.outcomes.length;
        for (const o of res.outcomes) {
          const ns = o.state;
          if (ns.phase === GamePhase.Playing && ns.currentPlayer === PieceType.Mouse && ns.mouseMovesLeft > 0) walk(ns, [...prefix, label], depth + 1);
          else addEnd(ns, [...prefix, label].join(''));
        }
        continue;
      }
      const ns = res.state;
      if (ns.phase === GamePhase.Playing && ns.currentPlayer === PieceType.Mouse && ns.mouseMovesLeft > 0) walk(ns, [...prefix, label], depth + 1);
      else addEnd(ns, [...prefix, label].join(''));
    }
  };
  walk(start, [], 0);
  let terminals = 0;
  for (const e of ends.values()) if (e.phase === GamePhase.CatWins || e.phase === GamePhase.MouseWins) terminals++;
  return { ends: [...ends.values()], labels, terminals, chanceLeaves, chanceOutcomes, transitions: n, complete: overflow === null, overflow };
}

/**
 * Exact immediate-win oracle for ONE mouse turn.
 *
 * The cat is static inside a mouse turn, so a same-turn mouse win is a pure
 * reachability question on the static board: standing on a hole while carrying
 * butter. Skill is free and adds 3 moves but consumes the butter, so it is
 * modelled as an explicit zero-cost state edge. Tunnel entry and trap steps end
 * the turn and can never produce a same-turn win. This is the same rule set the
 * engine DFS uses (cross-checked in HV18-4).
 */
function mouseCanWinInTurn(s: GameEngineState): { win: boolean; complete: boolean } {
  if (s.phase === GamePhase.MouseWins) return { win: true, complete: true };
  if (s.phase !== GamePhase.Playing || s.currentPlayer !== PieceType.Mouse) return { win: false, complete: true };
  const N = s.config.boardSize;
  const cat = s.catPosition;
  const hole = s.config.mouseHole;
  const butter = new Set(s.butterPositions.map((p) => `${p.r},${p.c}`));
  const isHole = (r: number, c: number): boolean =>
    r >= hole.r && r < hole.r + hole.size && c >= hole.c && c < hole.c + hole.size;
  const passable = (r: number, c: number): boolean => {
    if (r < 0 || c < 0 || r >= N || c >= N) return false;
    if (r === cat.r && c === cat.c) return false;
    const t = s.board[r][c].type;
    return t !== CellType.Box && t !== CellType.Pile && t !== CellType.Wall && t !== CellType.Void;
  };
  const endsTurn = (r: number, c: number): boolean =>
    s.board[r][c].type === CellType.Tunnel || (s.trapPosition?.r === r && s.trapPosition?.c === c);
  const seen = new Set<string>();
  let frontier: [number, number, number, boolean, boolean][] = [
    [s.mousePosition.r, s.mousePosition.c, s.mouseMovesLeft, s.mouseHasButter, s.mouseSkillActive],
  ];
  seen.add(`${s.mousePosition.r},${s.mousePosition.c},${s.mouseMovesLeft},${s.mouseHasButter ? 1 : 0},${s.mouseSkillActive ? 1 : 0}`);
  while (frontier.length > 0) {
    const next: [number, number, number, boolean, boolean][] = [];
    for (const [r, c, moves, carrying, skilled] of frontier) {
      if (carrying && !skilled) {
        const k = `${r},${c},${moves + s.config.mouseSkillExtraMoves},0,1`;
        if (!seen.has(k)) { seen.add(k); next.push([r, c, moves + s.config.mouseSkillExtraMoves, false, true]); }
      }
      if (moves <= 0) continue;
      for (const d of DIRECTIONS) {
        const nr = r + d.dr;
        const nc = c + d.dc;
        if (!passable(nr, nc)) continue;
        const nowCarrying = carrying || butter.has(`${nr},${nc}`);
        if (nowCarrying && isHole(nr, nc)) return { win: true, complete: true };
        if (endsTurn(nr, nc)) continue;
        const k = `${nr},${nc},${moves - 1},${nowCarrying ? 1 : 0},${skilled ? 1 : 0}`;
        if (seen.has(k)) continue;
        seen.add(k);
        next.push([nr, nc, moves - 1, nowCarrying, skilled]);
      }
    }
    frontier = next;
  }
  return { win: false, complete: true };
}

/** Engine-exact one-mouse-turn win DFS (validation oracle for the fast BFS). */
function engineMouseCanWinInTurn(start: GameEngineState, b: BudgetB): { win: boolean; complete: boolean } {
  let win = false;
  let overflow = false;
  const seen = new Set<string>();
  const walk = (s: GameEngineState): void => {
    if (win || overflow) return;
    if (s.phase === GamePhase.MouseWins) { win = true; return; }
    if (s.phase === GamePhase.ChoosingTunnelExit) {
      if (!spendBudget(b)) { overflow = true; return; }
      for (const choice of s.tunnelExitChoices) {
        const res = simulateSearchAction(s, { type: 'chooseTunnel', r: choice.r, c: choice.c }, rules);
        if (res.kind === 'chance') for (const o of res.outcomes) walk(o.state);
        else walk(res.state);
      }
      return;
    }
    if (s.phase !== GamePhase.Playing || s.currentPlayer !== PieceType.Mouse || s.mouseMovesLeft <= 0) return;
    if (!spendBudget(b)) { overflow = true; return; }
    const k = stateKey(s);
    if (seen.has(k)) return;
    seen.add(k);
    const actions = generateLegalSearchActions(s, rules).filter((a) => a.type === 'mouseStep' || a.type === 'mouseSkill');
    for (const a of actions) {
      const res = simulateSearchAction(s, a, rules);
      if (res.kind === 'chance') for (const o of res.outcomes) walk(o.state);
      else walk(res.state);
    }
  };
  walk(start);
  return { win, complete: !overflow };
}

type Tri = 'yes' | 'no' | 'incomplete';
interface SolverResultB { tri: Tri; plan?: SearchAction[] }

interface SolverStatsB {
  catTurnEnums: number;
  mouseTurnEnums: number;
  winChecks: number;
  catPlansSeen: number;
  mouseRepliesSeen: number;
  chanceOutcomesSeen: number;
  memoCHits: number;
  memoMHits: number;
  terminalsSeen: number;
}

function makeSolverB(wallMs: number, maxTransitions: number) {
  const budget = makeBudgetB(wallMs, maxTransitions);
  const memoC = new Map<string, SolverResultB>();
  const memoM = new Map<string, Tri>();
  const catCache = new Map<string, CatTurnSetB>();
  const CAT_CACHE_MAX = 120;
  const MEMO_MAX = 150_000;
  const stats: SolverStatsB = {
    catTurnEnums: 0, mouseTurnEnums: 0, winChecks: 0, catPlansSeen: 0,
    mouseRepliesSeen: 0, chanceOutcomesSeen: 0, memoCHits: 0, memoMHits: 0, terminalsSeen: 0,
  };

  const expired = (): boolean => {
    if (budget.overflow) return true;
    if (Date.now() > budget.deadline) { budget.overflow ??= 'WALL_CLOCK_CAP'; return true; }
    return false;
  };

  const catTurns = (s: GameEngineState): CatTurnSetB => {
    const k = stateKey(s);
    const hit = catCache.get(k);
    if (hit) return hit;
    stats.catTurnEnums++;
    const t = enumCatPlanTurns(s, budget);
    stats.catPlansSeen += t.plans.length;
    stats.chanceOutcomesSeen += t.chanceOutcomes;
    stats.terminalsSeen += t.terminals;
    if (catCache.size < CAT_CACHE_MAX) catCache.set(k, t);
    return t;
  };
  const mouseTurns = (s: GameEngineState): MouseTurnSetB => {
    stats.mouseTurnEnums++;
    const t = enumMouseTurnsB(s, budget);
    stats.chanceOutcomesSeen += t.chanceOutcomes;
    stats.terminalsSeen += t.terminals;
    return t;
  };

  let catSurvives: (s: GameEngineState, h: number) => SolverResultB;
  let mouseSafe: (s: GameEngineState, h: number) => Tri;

  catSurvives = (s, h) => {
    if (expired()) return { tri: 'incomplete' };
    if (s.phase === GamePhase.CatWins) return { tri: 'yes' };
    if (s.phase !== GamePhase.Playing || s.currentPlayer !== PieceType.Cat) return { tri: 'incomplete' };
    if (h <= 0) return { tri: 'yes' };
    const key = `C|${h}|${stateKey(s)}`;
    const hit = memoC.get(key);
    if (hit) { stats.memoCHits++; return hit; }
    const ct = catTurns(s);
    if (!ct.complete) return { tri: 'incomplete' };
    for (const plan of ct.plans) {
      let ok = true;
      for (const o of plan.outcomes) {
        if (o.phase === GamePhase.CatWins) continue;
        if (o.phase !== GamePhase.Playing) { ok = false; break; }
        const m = mouseSafe(o, h);
        if (m === 'incomplete') return { tri: 'incomplete' };
        if (m === 'no') { ok = false; break; }
      }
      if (ok) {
        const r: SolverResultB = { tri: 'yes', plan: plan.actions };
        if (memoC.size < MEMO_MAX) memoC.set(key, r);
        return r;
      }
    }
    const r: SolverResultB = { tri: 'no' };
    if (memoC.size < MEMO_MAX) memoC.set(key, r);
    return r;
  };

  mouseSafe = (s, h) => {
    if (expired()) return 'incomplete';
    if (s.phase === GamePhase.MouseWins) return 'no';
    if (s.phase !== GamePhase.Playing || s.currentPlayer !== PieceType.Mouse) return 'incomplete';
    if (h <= 1) {
      const key = `M1|${stateKey(s)}`;
      const hit = memoM.get(key);
      if (hit) { stats.memoMHits++; return hit; }
      stats.winChecks++;
      const w = mouseCanWinInTurn(s);
      if (!w.complete) return 'incomplete';
      const r: Tri = w.win ? 'no' : 'yes';
      if (memoM.size < MEMO_MAX) memoM.set(key, r);
      return r;
    }
    const key = `M|${h}|${stateKey(s)}`;
    const hit = memoM.get(key);
    if (hit) { stats.memoMHits++; return hit; }
    const mt = mouseTurns(s);
    if (!mt.complete) return 'incomplete';
    let r: Tri = 'yes';
    for (const e of mt.ends) {
      stats.mouseRepliesSeen++;
      if (e.phase === GamePhase.CatWins) continue;
      if (e.phase === GamePhase.MouseWins) { r = 'no'; break; }
      if (e.phase !== GamePhase.Playing) continue;
      const sub = catSurvives(e, h - 1);
      if (sub.tri === 'incomplete') return 'incomplete';
      if (sub.tri === 'no') { r = 'no'; break; }
    }
    if (memoM.size < MEMO_MAX) memoM.set(key, r);
    return r;
  };

  return {
    budget,
    stats,
    catSurvives: (s: GameEngineState, h: number): SolverResultB => catSurvives(s, h),
    mouseSafe: (s: GameEngineState, h: number): Tri => mouseSafe(s, h),
    catTurns,
    mouseTurns,
  };
}

interface PlanCheck {
  status: 'survives' | 'refuted' | 'incomplete' | 'illegal';
  plan: SearchAction[];
  outcomeCount: number;
  refutation: string;
  reason: string;
  elapsedMs: number;
}

/** Label of the first winning mouse route inside one mouse turn. */
function firstMouseWinRoute(s: GameEngineState): string | null {
  const seen = new Set<string>();
  let found: string | null = null;
  const walk = (cur: GameEngineState, path: string[]): void => {
    if (found) return;
    if (cur.phase === GamePhase.MouseWins) { found = path.join('') || 'START'; return; }
    if (cur.phase === GamePhase.ChoosingTunnelExit) {
      for (const choice of cur.tunnelExitChoices) {
        const res = simulateSearchAction(cur, { type: 'chooseTunnel', r: choice.r, c: choice.c }, rules);
        const lbl = [...path, `X(${choice.r},${choice.c})`];
        if (res.kind === 'chance') { for (const o of res.outcomes) walk(o.state, lbl); }
        else walk(res.state, lbl);
      }
      return;
    }
    if (cur.phase !== GamePhase.Playing || cur.currentPlayer !== PieceType.Mouse || cur.mouseMovesLeft <= 0) return;
    const k = stateKey(cur);
    if (seen.has(k)) return;
    seen.add(k);
    const actions = generateLegalSearchActions(cur, rules).filter((a) => a.type === 'mouseStep' || a.type === 'mouseSkill');
    for (const a of actions) {
      const label = a.type === 'mouseSkill' ? 'K' : a.direction!.key.replace('Arrow', '').slice(0, 1);
      const res = simulateSearchAction(cur, a, rules);
      if (res.kind === 'chance') { for (const o of res.outcomes) walk(o.state, [...path, label]); }
      else walk(res.state, [...path, label]);
    }
  };
  walk(s, []);
  return found;
}

/**
 * Check ONE candidate complete cat turn over the FULL official reply space.
 * `maxReplies` is a pilot-only guard: exceeding it returns INCOMPLETE, never a
 * verdict.
 */
function checkCatPlan(
  solver: ReturnType<typeof makeSolverB>,
  root: GameEngineState,
  plan: SearchAction[],
  h: number,
  maxReplies = Infinity,
): PlanCheck {
  const t0 = Date.now();
  const applied = applyCatPlan(root, plan);
  if (!applied.ok) {
    return { status: 'illegal', plan, outcomeCount: 0, refutation: '', reason: applied.reason, elapsedMs: Date.now() - t0 };
  }
  const outcomes = applied.chanceStates;
  let replies = 0;
  for (const o of outcomes) {
    if (o.phase === GamePhase.CatWins) continue;
    if (o.phase !== GamePhase.Playing) {
      return { status: 'refuted', plan, outcomeCount: outcomes.length, refutation: `non-playing:${o.phase}`, reason: 'terminal-outcome', elapsedMs: Date.now() - t0 };
    }
    const m = solver.mouseSafe(o, h);
    if (m === 'incomplete') {
      return { status: 'incomplete', plan, outcomeCount: outcomes.length, refutation: '', reason: solver.budget.overflow ?? 'incomplete', elapsedMs: Date.now() - t0 };
    }
    if (m === 'no') {
      const ref = findRefutationLabel(solver, o, h);
      return { status: 'refuted', plan, outcomeCount: outcomes.length, refutation: ref, reason: 'mouse-reply-forces-loss', elapsedMs: Date.now() - t0 };
    }
    replies += solver.mouseTurns(o).ends.length;
    if (replies > maxReplies) {
      return { status: 'incomplete', plan, outcomeCount: outcomes.length, refutation: '', reason: `PILOT_REPLY_LIMIT_${maxReplies}`, elapsedMs: Date.now() - t0 };
    }
  }
  return { status: 'survives', plan, outcomeCount: outcomes.length, refutation: '', reason: 'all-official-outcomes-and-replies', elapsedMs: Date.now() - t0 };
}

/** Concrete refuting mouse reply for a state the solver already proved unsafe. */
function findRefutationLabel(
  solver: ReturnType<typeof makeSolverB>,
  s: GameEngineState,
  h: number,
): string {
  if (h <= 1) {
    const route = firstMouseWinRoute(s);
    return route ? `mouse-route=${route} (same-turn MouseWins at hole)` : '(unresolved immediate win)';
  }
  const mt = solver.mouseTurns(s);
  for (const e of mt.ends) {
    if (e.phase === GamePhase.MouseWins) return `mouse-route=${mt.labels.get(stateKey(e)) ?? '?'} -> MouseWins`;
    if (e.phase !== GamePhase.Playing) continue;
    const sub = solver.catSurvives(e, h - 1);
    if (sub.tri === 'incomplete') return '(incomplete)';
    if (sub.tri === 'no') {
      return `mouse-route=${mt.labels.get(stateKey(e)) ?? '?'} -> cat state ${rc(e.catPosition)}/${rc(e.mousePosition)} has no guaranteed survival at h=${h - 1}`;
    }
  }
  return '(unresolved)';
}

function solverStatsText(solver: ReturnType<typeof makeSolverB>, elapsedMs: number): string {
  const s = solver.stats;
  const mem = process.memoryUsage();
  return `stats catEnums=${s.catTurnEnums} mouseEnums=${s.mouseTurnEnums} winChecks=${s.winChecks}`
    + ` catPlans=${s.catPlansSeen} mouseReplies=${s.mouseRepliesSeen} chanceOutcomes=${s.chanceOutcomesSeen}`
    + ` memoC=${s.memoCHits} memoM=${s.memoMHits} terminals=${s.terminalsSeen}`
    + ` transitions=${solver.budget.transitions} overflow=${solver.budget.overflow ?? 'none'}`
    + ` elapsedMs=${elapsedMs} heapMB=${(mem.heapUsed / 1048576).toFixed(0)}`;
}

// ===========================================================================
// HV18-4. fast immediate-win oracle vs the engine-exact oracle
// ===========================================================================
test('HV18-4 immediate-win oracle cross-check', () => {
  const samples: { label: string; state: GameEngineState }[] = [];
  const t9 = rootOf('GAME4', 9);
  const t9Mouse = mouseToMove(t9.state);
  samples.push({ label: 'GAME4-T9 cat-root (not mouse turn)', state: t9.state });
  samples.push({ label: 'GAME4-T9 mouse-turn (6,9) carry moves=3', state: t9Mouse });
  samples.push({ label: 'GAME4-T9 mouse-turn moves=1', state: { ...t9Mouse, mouseMovesLeft: 1 } });
  samples.push({ label: 'GAME4-T9 mouse-turn moves=0', state: { ...t9Mouse, mouseMovesLeft: 0 } });
  const handoffOf = (game: (typeof GAMES)[number], turn: number): GameEngineState => {
    const r = rootOf(game, turn);
    const p = applyCatPlan(r.state, r.plan);
    return mouseToMove(p.chanceStates[0] ?? p.end);
  };
  const t8handoff = handoffOf('GAME4', 8);
  samples.push({ label: 'GAME4-T8-handoff (3,9) carry moves=3', state: t8handoff });
  const t7handoff = handoffOf('GAME4', 7);
  samples.push({ label: 'GAME4-T7-handoff (1,5) carry moves=3', state: t7handoff });
  const t4handoff = handoffOf('GAME2', 4);
  samples.push({ label: 'GAME2-T4-handoff (6,1) no-carry moves=4', state: t4handoff });
  // Skill branch: direct route cannot win with 1 move, but the free skill
  // (+3 moves, butter consumed) plus a mid-route pickup reaches the hole.
  samples.push({
    label: 'SYNTH skill+pickup win (4,9)->(7,9)',
    state: {
      ...t9Mouse,
      mousePosition: { r: 4, c: 9 },
      mouseMovesLeft: 1,
      butterPositions: [{ r: 5, c: 9 }],
      pendingButterSpawns: [],
      pendingButterPlacementDebt: 0,
    },
  });
  // Add mouse-turn end states sampled from the T8 reply space (22 ends).
  const probe = makeSolverB(60_000, 2_000_000);
  for (const e of probe.mouseTurns(t8handoff).ends.slice(0, 4)) {
    samples.push({ label: `GAME4-T8-reply@${rc(e.mousePosition)}`, state: e });
  }

  const rows: string[] = [];
  for (const sample of samples) {
    const fast = mouseCanWinInTurn(sample.state);
    const exact = engineMouseCanWinInTurn(sample.state, makeBudgetB(60_000, 2_000_000));
    expect(exact.complete, `${sample.label} engine oracle completes`).toBe(true);
    expect(fast.win, `${sample.label} fast oracle == engine oracle`).toBe(exact.win);
    rows.push(`${sample.label} mouse=${rc(sample.state.mousePosition)} carry=${sample.state.mouseHasButter} moves=${sample.state.mouseMovesLeft} win=${fast.win}`);
  }
  // eslint-disable-next-line no-console
  console.log(`\nHV18-4 oracle cross-check (${samples.length} states, all agree)\n  ${rows.join('\n  ')}`);
}, 120_000);

// ===========================================================================
// HV18-5. GAME4 T8 — is the loss already forced at the T8 cat turn?
// ===========================================================================
test('HV18-5 GAME4 T8 bounded survival (h=2)', () => {
  const r = rootOf('GAME4', 8);
  const solver = makeSolverB(240_000, 8_000_000);
  const t0 = Date.now();
  const prod = checkCatPlan(solver, r.state, r.plan, 2);
  const overall = solver.catSurvives(r.state, 2);
  const t9 = rootOf('GAME4', 9);
  const t9q = solver.catSurvives(t9.state, 1);
  const elapsed = Date.now() - t0;
  const line =
    `GAME4-T8 prod=${prod.status} plan=${planText(prod.plan)} outcomes=${prod.outcomeCount} refutation=${prod.refutation}\n`
    + `  overall catSurvives(h=2)=${overall.tri}${overall.plan ? ` witnessPlan=${planText(overall.plan)}` : ''}\n`
    + `  actual T9 catSurvives(h=1)=${t9q.tri}\n  ${solverStatsText(solver, elapsed)}`;
  // eslint-disable-next-line no-console
  console.log(`\nHV18-5 GAME4 T8 bounded survival\n  ${line}`);
  if (overall.tri === 'yes' && overall.plan) {
    const w = applyCatPlan(r.state, overall.plan);
    expect(w.ok, `HV18-5 witness plan is a complete legal cat turn`).toBe(true);
  }
}, 300_000);

// ===========================================================================
// HV18-6. GAME2 T4 — production LLLL vs certified D2 RUDD
// ===========================================================================
test('HV18-6 GAME2 T4 bounded survival (h=2)', () => {
  const r = rootOf('GAME2', 4);
  const solver = makeSolverB(240_000, 8_000_000);
  const cert2 = runCertified(r.state, 2);
  const t0 = Date.now();
  const prod = checkCatPlan(solver, r.state, r.plan, 2);
  const alt = checkCatPlan(solver, r.state, cert2.plan, 2);
  const overall = solver.catSurvives(r.state, 2);
  const elapsed = Date.now() - t0;
  // eslint-disable-next-line no-console
  console.log(
    `\nHV18-6 GAME2 T4 bounded survival\n`
    + `  prod=${prod.status} plan=${planText(prod.plan)} refutation=${prod.refutation}\n`
    + `  D2=${alt.status} plan=${planText(alt.plan)} v=${cert2.value} completed=${cert2.completed} refutation=${alt.refutation}\n`
    + `  overall catSurvives(h=2)=${overall.tri}${overall.plan ? ` witnessPlan=${planText(overall.plan)}` : ''}\n`
    + `  ${solverStatsText(solver, elapsed)}`,
  );
  expect(cert2.completed, 'GAME2 T4 D2 search completed').toBe(true);
}, 300_000);

// ===========================================================================
// HV18-7. GAME4 T7 — production URUU vs the certified Right family (h=3)
// ===========================================================================
test('HV18-7 GAME4 T7 bounded survival (h=3)', () => {
  const mode = (process.env.HV18_T7_MODE ?? 'both') as 'prod' | 'd2' | 'both' | 'all';
  const limit = Number(process.env.HV18_T7_MAX_REPLIES ?? '0');
  const maxReplies = Number.isFinite(limit) && limit > 0 ? limit : Infinity;
  const wallMs = Number(process.env.HV18_T7_WALL_MS ?? '780000');
  const r = rootOf('GAME4', 7);
  const solver = makeSolverB(wallMs, 40_000_000);
  const cert2 = runCertified(r.state, 2);
  const t0 = Date.now();
  const rows: string[] = [];
  if (mode === 'prod' || mode === 'both') {
    const prod = checkCatPlan(solver, r.state, r.plan, 3, maxReplies);
    rows.push(`prod=${prod.status} plan=${planText(prod.plan)} outcomes=${prod.outcomeCount} refutation=${prod.refutation} (${prod.elapsedMs}ms)`);
  }
  if (mode === 'd2' || mode === 'both') {
    const d2 = checkCatPlan(solver, r.state, cert2.plan, 3, maxReplies);
    rows.push(`D2=${d2.status} plan=${planText(d2.plan)} v=${cert2.value} completed=${cert2.completed} refutation=${d2.refutation} (${d2.elapsedMs}ms)`);
  }
  if (mode === 'all') {
    // Existence query over EVERY complete legal T7 cat turn. All refuted =>
    // root `no` (complete); one survivor => root `yes` with its witness plan;
    // a cap hit stops the loop and the root stays INCOMPLETE.
    const cat = solver.catTurns(r.state);
    let survives = 0;
    let refuted = 0;
    let incomplete = 0;
    for (const plan of cat.plans) {
      if (solver.budget.overflow) break;
      const chk = checkCatPlan(solver, r.state, plan.actions, 3, maxReplies);
      if (chk.status === 'survives') {
        survives++;
        rows.push(`SURVIVES plan=${planText(chk.plan)} (${chk.elapsedMs}ms)`);
        break; // witness found: no need to refute the rest
      }
      if (chk.status === 'refuted') refuted++;
      else incomplete++;
      rows.push(`plan=${planText(chk.plan)} ${chk.status} ${chk.refutation} (${chk.elapsedMs}ms)`);
    }
    rows.push(`TOTAL plans=${cat.plans.length} refuted=${refuted} survives=${survives} incomplete=${incomplete}`
      + ` root=${survives > 0 ? 'yes' : incomplete === 0 && !solver.budget.overflow ? 'no' : 'incomplete'}`);
  }
  const elapsed = Date.now() - t0;
  // eslint-disable-next-line no-console
  console.log(
    `\nHV18-7 GAME4 T7 bounded survival (mode=${mode})\n  ${rows.join('\n  ')}\n  ${solverStatsText(solver, elapsed)}`,
  );
  expect(cert2.completed, 'GAME4 T7 D2 search completed').toBe(true);
}, 2_400_000);

// ===========================================================================
// HV18-8. reverse controls — no new judgment may devalue legal cat wins
// ===========================================================================
test('HV18-8 reverse controls', () => {
  const g3 = rootOf('GAME3', 8);
  const p3 = applyCatPlan(g3.state, g3.plan);
  expect(p3.end.phase, 'GAME3 T8 production plan is an immediate cat capture').toBe(GamePhase.CatWins);
  const g5 = rootOf('GAME5', 12);
  const p5 = applyCatPlan(g5.state, g5.plan);
  expect(p5.end.phase, 'GAME5 T12 production plan is an immediate cat capture').toBe(GamePhase.CatWins);

  // The new bounded judgment must not devalue a capture that already happened:
  // an in-turn CatWins is a survival witness, never a refutation.
  const ctl = makeSolverB(60_000, 2_000_000);
  const q3 = checkCatPlan(ctl, g3.state, g3.plan, 1);
  const q5 = checkCatPlan(ctl, g5.state, g5.plan, 1);
  expect(q3.status, 'GAME3 T8 winning plan is not devalued').toBe('survives');
  expect(q5.status, 'GAME5 T12 winning plan is not devalued').toBe('survives');

  const g1 = rootOf('GAME1', 1);
  const g2 = rootOf('GAME2', 7);
  // eslint-disable-next-line no-console
  console.log(
    `\nHV18-8 reverse controls\n`
    + `  GAME3-T8 replay=${p3.ok} phase=${terminalName(p3.end)} end=${rc(p3.end.catPosition)} bounded=${q3.status}\n`
    + `  GAME5-T12 replay=${p5.ok} phase=${terminalName(p5.end)} end=${rc(p5.end.catPosition)} bounded=${q5.status}\n`
    + `  GAME1-T1 control: HV14-12 already proved 114/114 legal cat turns cannot stop the butter pickup — cited, not re-searched\n`
    + `    root cat=${rc(g1.state.catPosition)} mouse=${rc(g1.state.mousePosition)} butter=${g1.state.butterPositions.map(rc).join('|')} plan=${planText(g1.plan)}\n`
    + `  GAME2-T7 control: H1 plateau / Voronoi gap is not strength evidence — cited from HV16/HV14, not re-searched\n`
    + `    logged depth=${g2.loggedDepth} best=${g2.loggedBest} v=${g2.loggedValue}`,
  );
}, 120_000);
