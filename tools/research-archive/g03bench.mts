/**
 * G0.3B — Threat-Aware Search Depth Efficiency benchmark.
 *
 * Builds a corpus of threat + normal fixtures, runs the production search
 * profile (100ms deadline, TT+AB+Ordering ON), and outputs a before/after
 * comparison table.
 *
 * Usage:
 *   npx tsx tools/research-archive/g03bench.mts                    # full benchmark
 *   npx tsx tools/research-archive/g03bench.mts --before           # baseline only (no extension)
 *   npx tsx tools/research-archive/g03bench.mts --after            # after only (extension ON)
 */
import { createInitialState, type GameEngineState } from '../../src/game/engine';
import type { GameConfig } from '../../src/game/config';
import { GamePhase, PieceType, CellType } from '../../src/game/types';
import { searchBestActionIterative, type IterativeSearchResult } from '../../src/game/ai/expectiminimax';
import { defaultRuleSet } from '../../src/game/ai/searchRules';
import { evaluateForCat } from '../../src/game/ai/evaluation';
import { classifyGoalThreat } from '../../src/game/ai/threatClassifier';
import type { RuleSet } from '../../src/game/ai/searchTypes';
import { performance } from 'node:perf_hooks';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function cleanConfig(overrides: Partial<GameConfig> = {}): GameConfig {
  return {
    boardSize: 10,
    mouseHole: { r: 7, c: 8, size: 2 },
    boxCount: 0,
    pileCount: 0,
    butterCount: 0,
    mouseStart: { r: 1, c: 1 },
    catStart: { r: 1, c: 3 },
    mouseBaseMoves: 4,
    mouseCarryingMoves: 3,
    mouseSkillExtraMoves: 3,
    catBaseMoves: 4,
    gameMode: 'single',
    difficulty: 'hard',
    tunnelCorners: [
      { r: 0, c: 0 }, { r: 0, c: 9 }, { r: 9, c: 0 }, { r: 9, c: 9 },
    ],
    ...overrides,
  };
}

function setPieces(
  state: GameEngineState,
  mouse: { r: number; c: number },
  cat?: { r: number; c: number },
): GameEngineState {
  const board: GameEngineState['board'] = state.board.map((row) =>
    row.map((cell) => ({ ...cell, piece: undefined })),
  );
  board[mouse.r][mouse.c] = { ...board[mouse.r][mouse.c], piece: PieceType.Mouse };
  if (cat) board[cat.r][cat.c] = { ...board[cat.r][cat.c], piece: PieceType.Cat };
  const patch: Partial<GameEngineState> = { board, mousePosition: { ...mouse } };
  if (cat) patch.catPosition = { ...cat };
  return { ...state, ...patch };
}

function wallOff(state: GameEngineState, open: { r: number; c: number }[]): GameEngineState {
  const openSet = new Set(open.map((p) => `${p.r},${p.c}`));
  const board: GameEngineState['board'] = state.board.map((row, r) =>
    row.map((cell, c) => {
      if (cell.type === CellType.MouseHole || cell.type === CellType.Tunnel) return cell;
      if (openSet.has(`${r},${c}`)) return { ...cell, type: CellType.Empty };
      return { ...cell, type: CellType.Wall, piece: undefined, hasButter: false };
    }),
  );
  return { ...state, board };
}

function clearButter(state: GameEngineState): GameEngineState {
  const board = state.board.map((row) => row.map((cell) => ({ ...cell, hasButter: false })));
  return { ...state, board, butterPositions: [], mouseHasButter: false, mouseSkillActive: false };
}

function noTrapRules(): RuleSet {
  return { ...defaultRuleSet, catPlaceTrap: (st: GameEngineState) => st };
}

// ---------------------------------------------------------------------------
// Corpus
// ---------------------------------------------------------------------------

interface Fixture {
  name: string;
  category: 'threat' | 'normal';
  state: GameEngineState;
}

function buildCorpus(): Fixture[] {
  const fixtures: Fixture[] = [];

  // A. Mouse carrying butter, adjacent to hole (critical threat)
  {
    let s = createInitialState(cleanConfig());
    s = clearButter(s);
    s = setPieces(s, { r: 7, c: 7 }, { r: 5, c: 7 });
    s = wallOff(s, [{ r: 5, c: 7 }, { r: 6, c: 7 }, { r: 7, c: 7 }, { r: 5, c: 6 }, { r: 6, c: 6 }, { r: 7, c: 6 }, { r: 5, c: 5 }, { r: 6, c: 5 }, { r: 7, c: 5 }]);
    s = { ...s, currentPlayer: PieceType.Cat, catMovesLeft: 4, mouseMovesLeft: 4, phase: GamePhase.Playing, mouseHasButter: true, catTrapsRemaining: 0, trapPosition: null };
    fixtures.push({ name: 'A_critical_adjacent_hole', category: 'threat', state: s });
  }

  // B. Mouse carrying butter, ~2 turns from hole (near threat)
  {
    let s = createInitialState(cleanConfig());
    s = clearButter(s);
    s = setPieces(s, { r: 7, c: 4 }, { r: 1, c: 1 });
    s = wallOff(s, [{ r: 7, c: 4 }, { r: 7, c: 5 }, { r: 7, c: 6 }, { r: 7, c: 7 }, { r: 1, c: 1 }]);
    s = { ...s, currentPlayer: PieceType.Cat, catMovesLeft: 4, mouseMovesLeft: 4, phase: GamePhase.Playing, mouseHasButter: true, catTrapsRemaining: 0, trapPosition: null };
    fixtures.push({ name: 'B_near_2turns_from_hole', category: 'threat', state: s });
  }

  // C. Mouse carrying butter but route blocked (none)
  {
    let s = createInitialState(cleanConfig());
    s = clearButter(s);
    s = setPieces(s, { r: 7, c: 3 }, { r: 1, c: 1 });
    s = wallOff(s, [{ r: 7, c: 3 }, { r: 1, c: 1 }]);
    const b2 = s.board.map((row) => row.map((cell) => ({ ...cell })));
    b2[7][4] = { ...b2[7][4], type: CellType.Wall };
    b2[7][5] = { ...b2[7][5], type: CellType.Wall };
    b2[7][6] = { ...b2[7][6], type: CellType.Wall };
    b2[7][7] = { ...b2[7][7], type: CellType.Wall };
    s = { ...s, board: b2, currentPlayer: PieceType.Cat, catMovesLeft: 4, mouseMovesLeft: 4, phase: GamePhase.Playing, mouseHasButter: true, catTrapsRemaining: 0, trapPosition: null };
    fixtures.push({ name: 'C_blocked_route', category: 'threat', state: s });
  }

  // D. Mouse NOT carrying butter (normal)
  {
    let s = createInitialState(cleanConfig());
    s = clearButter(s);
    s = setPieces(s, { r: 1, c: 5 }, { r: 1, c: 1 });
    s = wallOff(s, [{ r: 1, c: 1 }, { r: 1, c: 2 }, { r: 1, c: 3 }, { r: 1, c: 4 }, { r: 1, c: 5 }]);
    s = { ...s, currentPlayer: PieceType.Cat, catMovesLeft: 4, mouseMovesLeft: 4, phase: GamePhase.Playing, mouseHasButter: false, catTrapsRemaining: 0, trapPosition: null };
    fixtures.push({ name: 'D_no_butter_normal', category: 'normal', state: s });
  }

  // E. Mouse approaching butter (normal, near butter)
  {
    let s = createInitialState(cleanConfig());
    s = clearButter(s);
    s = setPieces(s, { r: 5, c: 5 }, { r: 1, c: 1 });
    s = wallOff(s, [{ r: 5, c: 5 }, { r: 5, c: 6 }, { r: 1, c: 1 }, { r: 1, c: 2 }, { r: 2, c: 1 }, { r: 2, c: 2 }, { r: 3, c: 1 }, { r: 3, c: 2 }, { r: 4, c: 1 }, { r: 4, c: 2 }]);
    const board = s.board.map((row) => row.map((cell) => ({ ...cell })));
    board[5][6] = { ...board[5][6], type: CellType.Empty, hasButter: true };
    s = { ...s, board, butterPositions: [{ r: 5, c: 6 }], currentPlayer: PieceType.Cat, catMovesLeft: 4, mouseMovesLeft: 4, phase: GamePhase.Playing, mouseHasButter: false, catTrapsRemaining: 0, trapPosition: null };
    fixtures.push({ name: 'E_near_butter', category: 'normal', state: s });
  }

  // F. Cat can directly capture (normal, immediate)
  {
    let s = createInitialState(cleanConfig());
    s = clearButter(s);
    s = setPieces(s, { r: 1, c: 5 }, { r: 1, c: 4 });
    s = wallOff(s, [{ r: 1, c: 3 }, { r: 1, c: 4 }, { r: 1, c: 5 }]);
    s = { ...s, currentPlayer: PieceType.Cat, catMovesLeft: 4, mouseMovesLeft: 4, phase: GamePhase.Playing, mouseHasButter: false, catTrapsRemaining: 0, trapPosition: null };
    fixtures.push({ name: 'F_direct_capture', category: 'normal', state: s });
  }

  // G. Cat can push box to change hole route (threat with box)
  {
    let s = createInitialState(cleanConfig());
    s = clearButter(s);
    s = setPieces(s, { r: 7, c: 6 }, { r: 7, c: 3 });
    s = wallOff(s, [{ r: 7, c: 3 }, { r: 7, c: 4 }, { r: 7, c: 5 }, { r: 7, c: 6 }, { r: 7, c: 7 }]);
    // Put a box between cat and the corridor to the hole.
    const board = s.board.map((row) => row.map((cell) => ({ ...cell })));
    board[7][5] = { ...board[7][5], type: CellType.Box };
    s = { ...s, board, currentPlayer: PieceType.Cat, catMovesLeft: 4, mouseMovesLeft: 4, phase: GamePhase.Playing, mouseHasButter: true, catTrapsRemaining: 0, trapPosition: null };
    fixtures.push({ name: 'G_box_push_threat', category: 'threat', state: s });
  }

  // H. Trap on the board (threat with trap)
  {
    let s = createInitialState(cleanConfig());
    s = clearButter(s);
    s = setPieces(s, { r: 7, c: 6 }, { r: 5, c: 6 });
    s = wallOff(s, [{ r: 5, c: 6 }, { r: 6, c: 6 }, { r: 7, c: 6 }, { r: 7, c: 7 }, { r: 5, c: 5 }, { r: 6, c: 5 }, { r: 7, c: 5 }]);
    s = { ...s, currentPlayer: PieceType.Cat, catMovesLeft: 4, mouseMovesLeft: 4, phase: GamePhase.Playing, mouseHasButter: true, catTrapsRemaining: 0, trapPosition: { r: 6, c: 6 } };
    fixtures.push({ name: 'H_trap_on_board', category: 'threat', state: s });
  }

  // I. Tunnel near mouse (normal, tunnel access)
  {
    let s = createInitialState(cleanConfig());
    s = clearButter(s);
    s = setPieces(s, { r: 1, c: 1 }, { r: 5, c: 5 });
    s = wallOff(s, [{ r: 1, c: 1 }, { r: 1, c: 2 }, { r: 5, c: 5 }, { r: 5, c: 4 }, { r: 4, c: 4 }, { r: 4, c: 5 }]);
    s = { ...s, currentPlayer: PieceType.Cat, catMovesLeft: 4, mouseMovesLeft: 4, phase: GamePhase.Playing, mouseHasButter: false, catTrapsRemaining: 0, trapPosition: null };
    fixtures.push({ name: 'I_tunnel_access', category: 'normal', state: s });
  }

  // J. Forced-loss: mouse at hole entrance with butter, cat far away
  {
    let s = createInitialState(cleanConfig());
    s = clearButter(s);
    s = setPieces(s, { r: 7, c: 7 }, { r: 1, c: 1 });
    s = wallOff(s, [{ r: 1, c: 1 }, { r: 1, c: 2 }, { r: 1, c: 3 }, { r: 1, c: 4 }, { r: 2, c: 1 }, { r: 2, c: 2 }, { r: 2, c: 3 }, { r: 2, c: 4 }, { r: 7, c: 6 }, { r: 7, c: 7 }]);
    s = { ...s, currentPlayer: PieceType.Cat, catMovesLeft: 4, mouseMovesLeft: 4, phase: GamePhase.Playing, mouseHasButter: true, catTrapsRemaining: 0, trapPosition: null };
    fixtures.push({ name: 'J_forced_loss_hole', category: 'threat', state: s });
  }

  return fixtures;
}

// ---------------------------------------------------------------------------
// Profile runner
// ---------------------------------------------------------------------------

interface ProfileResult {
  name: string;
  category: string;
  threatClass: string;
  completedDepth: number;
  attemptedDepth: number;
  maxExtensionDepth: number;
  extensionsTriggered: number;
  extendedNodes: number;
  criticalLeaves: number;
  extensionAbortCount: number;
  nodes: number;
  elapsedMs: number;
  rootValue: number;
  mate: string | null;
  planLength: number;
}

function runProfile(
  fixtures: Fixture[],
  maxThreatExtensions: number,
  label: string,
): ProfileResult[] {
  const results: ProfileResult[] = [];
  for (const f of fixtures) {
    const t0 = performance.now();
    const res = searchBestActionIterative(f.state, {
      rules: noTrapRules(),
      maxDepthTurns: 4,
      maxNodes: 500_000,
      useTT: true,
      useAlphaBeta: true,
      useMoveOrdering: true,
      leafEvaluator: evaluateForCat,
      deadlineMs: t0 + 100,
      now: () => performance.now(),
      maxThreatExtensions,
    });
    const elapsed = performance.now() - t0;
    const threat = classifyGoalThreat(f.state);
    results.push({
      name: f.name,
      category: f.category,
      threatClass: threat.urgency,
      completedDepth: res.completedDepth,
      attemptedDepth: res.attemptedDepth,
      maxExtensionDepth: res.diagnostics.maxExtensionDepth,
      extensionsTriggered: res.diagnostics.extensionsTriggered,
      extendedNodes: res.diagnostics.extendedNodes,
      criticalLeaves: res.diagnostics.criticalLeaves,
      extensionAbortCount: res.diagnostics.extensionAbortCount,
      nodes: res.diagnostics.totalNodes,
      elapsedMs: elapsed,
      rootValue: res.value,
      mate: res.mate,
      planLength: res.catTurnPlan.length,
    });
  }
  return results;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main(): void {
  const mode = process.argv[2] ?? '--full';
  const corpus = buildCorpus();
  console.log(`\n=== G0.3B Threat-Aware Search Benchmark ===`);
  console.log(`Corpus: ${corpus.length} fixtures (${corpus.filter((f) => f.category === 'threat').length} threat, ${corpus.filter((f) => f.category === 'normal').length} normal)\n`);

  if (mode === '--before' || mode === '--full') {
    console.log('--- BEFORE (maxThreatExtensions=0) ---');
    const before = runProfile(corpus, 0, 'BEFORE');
    printResults(before);
    console.log('');
  }

  if (mode === '--after' || mode === '--full') {
    console.log('--- AFTER (maxThreatExtensions=2) ---');
    const after = runProfile(corpus, 2, 'AFTER');
    printResults(after);
    console.log('');
  }

  if (mode === '--full') {
    console.log('--- COMPARISON ---');
    const before = runProfile(corpus, 0, 'BEFORE');
    const after = runProfile(corpus, 2, 'AFTER');
    printComparison(before, after);
  }
}

function printResults(results: ProfileResult[]): void {
  console.log('fixture                          threat    cDepth aDepth extDepth ext  nodes    elapsed  value/mate        plan');
  console.log('─'.repeat(140));
  for (const r of results) {
    const mateStr = r.mate ? `${r.mate}` : 'null';
    console.log(
      `${r.name.padEnd(32)} ${r.threatClass.padEnd(9)} ${String(r.completedDepth).padStart(6)} ${String(r.attemptedDepth).padStart(6)} ${String(r.maxExtensionDepth).padStart(8)} ${String(r.extensionsTriggered).padStart(3)}  ${String(r.nodes).padStart(7)}  ${r.elapsedMs.toFixed(0).padStart(7)}ms ${String(r.rootValue).padStart(10)}/${mateStr.padEnd(5)} ${r.planLength}`,
    );
  }
}

function printComparison(before: ProfileResult[], after: ProfileResult[]): void {
  console.log('fixture                          | threat | old cDepth new cDepth | old extDepth new extDepth | old ext new ext | old nodes new nodes | old ms new ms | plan chg');
  console.log('─'.repeat(170));
  for (let i = 0; i < before.length; i++) {
    const b = before[i];
    const a = after[i];
    const planChg = b.planLength !== a.planLength || b.rootValue !== a.rootValue ? 'YES' : 'no';
    console.log(
      `${b.name.padEnd(32)} | ${b.threatClass.padEnd(6)} | ${String(b.completedDepth).padStart(9)} ${String(a.completedDepth).padStart(9)} | ${String(b.maxExtensionDepth).padStart(12)} ${String(a.maxExtensionDepth).padStart(12)} | ${String(b.extensionsTriggered).padStart(7)} ${String(a.extensionsTriggered).padStart(7)} | ${String(b.nodes).padStart(9)} ${String(a.nodes).padStart(9)} | ${b.elapsedMs.toFixed(0).padStart(6)} ${a.elapsedMs.toFixed(0).padStart(6)} | ${planChg}`,
    );
  }
  // Summary stats.
  const threatBefore = before.filter((r) => r.category === 'threat');
  const threatAfter = after.filter((r) => r.category === 'threat');
  const normalBefore = before.filter((r) => r.category === 'normal');
  const normalAfter = after.filter((r) => r.category === 'normal');
  console.log('\n--- Summary ---');
  console.log(`THREAT fixtures:  avg cDepth ${avg(threatBefore.map((r) => r.completedDepth))} → ${avg(threatAfter.map((r) => r.completedDepth))} | avg extDepth ${avg(threatBefore.map((r) => r.maxExtensionDepth))} → ${avg(threatAfter.map((r) => r.maxExtensionDepth))} | avg nodes ${avg(threatBefore.map((r) => r.nodes))} → ${avg(threatAfter.map((r) => r.nodes))} | avg ms ${avg(threatBefore.map((r) => r.elapsedMs))} → ${avg(threatAfter.map((r) => r.elapsedMs))}`);
  console.log(`NORMAL fixtures:  avg cDepth ${avg(normalBefore.map((r) => r.completedDepth))} → ${avg(normalAfter.map((r) => r.completedDepth))} | avg extDepth ${avg(normalBefore.map((r) => r.maxExtensionDepth))} → ${avg(normalAfter.map((r) => r.maxExtensionDepth))} | avg nodes ${avg(normalBefore.map((r) => r.nodes))} → ${avg(normalAfter.map((r) => r.nodes))} | avg ms ${avg(normalBefore.map((r) => r.elapsedMs))} → ${avg(normalAfter.map((r) => r.elapsedMs))}`);
  const extTriggerNormal = normalAfter.filter((r) => r.extensionsTriggered > 0).length;
  console.log(`Normal extension trigger rate: ${extTriggerNormal}/${normalAfter.length}`);
}

function avg(arr: number[]): string {
  if (arr.length === 0) return 'N/A';
  return (arr.reduce((a, b) => a + b, 0) / arr.length).toFixed(1);
}

main();
