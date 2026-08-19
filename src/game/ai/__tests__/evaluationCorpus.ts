import type { GameEngineState } from '../../engine';
import { createInitialState } from '../../engine';
import type { GameConfig } from '../../config';
import { GamePhase, PieceType, CellType } from '../../types';
import type { EvaluationBreakdown } from '../evaluation';

// ============================================================
// Phase E0 — Benchmark Corpus
// ------------------------------------------------------------
// A fixed set of hand-built positions used to (a) assert RULE
// invariants, (b) record STRATEGIC relative relationships for
// later weight tuning (E1), and (c) OBSERVE scores without
// pass/fail. Corpus states are static — they never simulate
// future random butter regeneration.
//
// Each case: { name, state, tags, expectations[] }.
//   - rule       : assert(b, state) MUST hold (hard).
//   - strategic  : recorded relative relationship (betterThan /
//                  worseThan by case name) used for tuning, NOT a
//                  hard gate in E0.
//   - observation: free-form note; score is recorded only.
// ============================================================

export type RC = { r: number; c: number };
export type Expectation =
  | { type: 'rule'; description: string; assert: (b: EvaluationBreakdown, state: GameEngineState) => boolean }
  | {
      type: 'strategic';
      description: string;
      /** hard = near-uncontroversial strategic relation (E1 gate);
       *  soft = plausible but comparable to other factors (reported only). */
      confidence?: 'hard' | 'soft';
      betterThan?: string[];
      worseThan?: string[];
    }
  | { type: 'observation'; description: string };

export interface CorpusCase {
  name: string;
  state: GameEngineState;
  tags: string[];
  expectations: Expectation[];
}

// --- mirrored helpers (identical semantics to expectiminimax.test.ts) ---

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
      { r: 0, c: 0 },
      { r: 0, c: 9 },
      { r: 9, c: 0 },
      { r: 9, c: 9 },
    ],
    ...overrides,
  };
}

function setPieces(
  state: GameEngineState,
  mouse: RC,
  cat?: RC,
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

function wallOff(state: GameEngineState, open: RC[]): GameEngineState {
  const openSet = new Set(open.map((p) => `${p.r},${p.c}`));
  const board = state.board.map((row, r) =>
    row.map((cell, c) => {
      const special = cell.type === CellType.MouseHole || cell.type === CellType.Tunnel;
      if (special) return cell;
      if (openSet.has(`${r},${c}`)) return { ...cell, type: CellType.Empty };
      return { ...cell, type: CellType.Wall, piece: undefined, hasButter: false };
    }),
  );
  return { ...state, board };
}

const ALL_OPEN: RC[] = [];
for (let r = 1; r <= 8; r++) for (let c = 1; c <= 8; c++) ALL_OPEN.push({ r, c });

/** Build a Playing-state from pieces + an open region + optional patch. */
function base(opts: {
  cat: RC;
  mouse: RC;
  open?: RC[];
  overrides?: Partial<GameConfig>;
  patch?: (s: GameEngineState) => GameEngineState;
}): GameEngineState {
  let s = createInitialState(cleanConfig(opts.overrides));
  s = setPieces(s, opts.mouse, opts.cat);
  if (opts.open) s = wallOff(s, opts.open);
  s = {
    ...s,
    currentPlayer: PieceType.Cat,
    catMovesLeft: 4,
    mouseMovesLeft: 4,
    phase: GamePhase.Playing,
    mouseHasButter: false,
    mouseSkillActive: false,
    trapPosition: null,
    catTrapsRemaining: 1,
    blockedTunnels: [],
  };
  if (opts.patch) s = opts.patch(s);
  return s;
}

function blockTunnel(s: GameEngineState, rc: RC): GameEngineState {
  const board = s.board.map((row) => row.map((cell) => ({ ...cell })));
  board[rc.r][rc.c] = { ...board[rc.r][rc.c], type: CellType.Box, piece: undefined };
  return {
    ...s,
    board,
    blockedTunnels: [...s.blockedTunnels, { r: rc.r, c: rc.c }],
  };
}

// ---------------------------------------------------------------------------
// Cases
// ---------------------------------------------------------------------------

export const EVALUATION_CORPUS: CorpusCase[] = [
  // --- Capture pressure ---
  {
    name: 'capture_cat_close',
    state: base({ cat: { r: 1, c: 2 }, mouse: { r: 1, c: 1 }, open: ALL_OPEN }),
    tags: ['capture', 'cat-favorable'],
    expectations: [
      { type: 'rule', description: 'cat→mouse distance is 1', assert: (b) => b.features.catMouseDistance === 1 },
      { type: 'strategic', confidence: 'hard', description: 'cat closer to mouse is better for cat', betterThan: ['capture_cat_far'] },
    ],
  },
  {
    name: 'capture_cat_far',
    state: base({ cat: { r: 4, c: 4 }, mouse: { r: 1, c: 1 }, open: ALL_OPEN }),
    tags: ['capture', 'mouse-favorable'],
    expectations: [
      { type: 'rule', description: 'cat→mouse distance is large', assert: (b) => (b.features.catMouseDistance ?? 99) >= 5 },
      { type: 'strategic', description: 'cat far from mouse is worse for cat', worseThan: ['capture_cat_close'] },
    ],
  },

  // --- Mouse carrying butter: near vs far from hole ---
  {
    name: 'butter_carry_near_hole',
    state: base({
      cat: { r: 8, c: 7 },
      mouse: { r: 7, c: 7 },
      open: [{ r: 7, c: 7 }, { r: 8, c: 7 }, { r: 7, c: 8 }, { r: 8, c: 8 }, { r: 6, c: 7 }, { r: 7, c: 6 }, { r: 8, c: 6 }, { r: 6, c: 8 }],
      patch: (s) => ({ ...s, mouseHasButter: true }),
    }),
    tags: ['butter', 'carry', 'cat-unfavorable'],
    expectations: [
      { type: 'rule', description: 'mouse has butter', assert: (b) => b.features.mouseHasButter === true },
      { type: 'rule', description: 'goal distance to hole is 1 while carrying', assert: (b) => b.features.mouseGoalDistance === 1 },
      { type: 'strategic', confidence: 'hard', description: 'carrying butter near hole is worse for cat', worseThan: ['butter_carry_far_hole'] },
    ],
  },
  {
    name: 'butter_carry_far_hole',
    state: base({
      cat: { r: 2, c: 1 },
      mouse: { r: 1, c: 1 },
      open: ALL_OPEN,
      patch: (s) => ({ ...s, mouseHasButter: true }),
    }),
    tags: ['butter', 'carry'],
    expectations: [
      { type: 'rule', description: 'goal distance is large while carrying', assert: (b) => (b.features.mouseGoalDistance ?? 0) >= 8 },
      { type: 'strategic', description: 'carrying butter far from hole is better for cat', betterThan: ['butter_carry_near_hole'] },
    ],
  },
  {
    name: 'butter_not_carry_same',
    state: base({
      cat: { r: 8, c: 7 },
      mouse: { r: 7, c: 7 },
      open: [{ r: 7, c: 7 }, { r: 8, c: 7 }, { r: 7, c: 8 }, { r: 8, c: 8 }, { r: 6, c: 7 }, { r: 7, c: 6 }, { r: 8, c: 6 }, { r: 6, c: 8 }],
    }),
    tags: ['butter', 'no-carry'],
    expectations: [
      { type: 'rule', description: 'no butter → goal distance is null (not a win yet)', assert: (b) => b.features.mouseGoalDistance === null },
      { type: 'strategic', confidence: 'hard', description: 'not carrying butter is better for cat than carrying near hole', betterThan: ['butter_carry_near_hole'] },
    ],
  },

  // --- Butter race: mouse without butter, near vs far from butter ---
  {
    name: 'race_mouse_near_butter',
    state: base({
      cat: { r: 1, c: 1 },
      mouse: { r: 4, c: 4 },
      open: ALL_OPEN,
      patch: (s) => ({ ...s, butterPositions: [{ r: 4, c: 5 }] }),
    }),
    tags: ['butter-race', 'mouse-favorable'],
    expectations: [
      { type: 'rule', description: 'mouse→butter distance is 1', assert: (b) => b.features.mouseButterDistance === 1 },
      { type: 'strategic', confidence: 'soft', description: 'mouse near butter is worse for cat', worseThan: ['race_mouse_far_butter'] },
    ],
  },
  {
    name: 'race_mouse_far_butter',
    state: base({
      cat: { r: 1, c: 1 },
      mouse: { r: 4, c: 4 },
      open: ALL_OPEN,
      patch: (s) => ({ ...s, butterPositions: [{ r: 8, c: 8 }] }),
    }),
    tags: ['butter-race'],
    expectations: [
      { type: 'rule', description: 'mouse→butter distance is large', assert: (b) => (b.features.mouseButterDistance ?? 0) >= 8 },
      { type: 'strategic', confidence: 'soft', description: 'mouse far from butter is better for cat', betterThan: ['race_mouse_near_butter'] },
    ],
  },

  // --- Tunnel ---
  {
    name: 'tunnel_open',
    state: base({
      cat: { r: 4, c: 4 },
      mouse: { r: 3, c: 3 },
      // Orthogonally-connected pocket + corridor to corner (0,0), so the open
      // tunnel is genuinely REACHABLE. Identical geometry to tunnel_blocked
      // except the corner blocking.
      open: [
        { r: 3, c: 3 }, { r: 3, c: 4 }, { r: 2, c: 4 }, { r: 4, c: 4 },
        { r: 2, c: 3 }, { r: 2, c: 2 }, { r: 2, c: 1 },
        { r: 1, c: 1 }, { r: 0, c: 1 }, { r: 0, c: 0 },
      ],
    }),
    tags: ['tunnel', 'open'],
    expectations: [
      { type: 'rule', description: 'at least one open tunnel', assert: (b) => b.features.openTunnelCount > 0 },
      { type: 'rule', description: 'mouse can use an open tunnel (no butter)', assert: (b) => b.features.mouseTunnelAllowed === true },
      { type: 'rule', description: 'the open tunnel is actually reachable', assert: (b) => b.features.mouseCanReachTunnel === true },
      { type: 'strategic', confidence: 'hard', description: 'mouse having a REACHABLE escape tunnel is worse for cat', worseThan: ['tunnel_blocked'] },
    ],
  },
  {
    name: 'tunnel_blocked',
    state: base({
      cat: { r: 4, c: 4 },
      mouse: { r: 3, c: 3 },
      open: [
        { r: 3, c: 3 }, { r: 3, c: 4 }, { r: 2, c: 4 }, { r: 4, c: 4 },
        { r: 2, c: 3 }, { r: 2, c: 2 }, { r: 2, c: 1 },
        { r: 1, c: 1 }, { r: 0, c: 1 }, { r: 0, c: 0 },
      ],
      patch: (s) => blockTunnel(blockTunnel(blockTunnel(blockTunnel(s, { r: 0, c: 0 }), { r: 0, c: 9 }), { r: 9, c: 0 }), { r: 9, c: 9 }),
    }),
    tags: ['tunnel', 'blocked'],
    expectations: [
      { type: 'rule', description: 'no open tunnel', assert: (b) => b.features.openTunnelCount === 0 },
      { type: 'rule', description: 'mouse cannot reach a blocked tunnel', assert: (b) => b.features.mouseCanReachTunnel === false },
      { type: 'rule', description: 'no reachable tunnel access distance', assert: (b) => b.features.mouseTunnelAccessDistance === null },
      { type: 'strategic', confidence: 'hard', description: 'blocked tunnel is better for cat', betterThan: ['tunnel_open'] },
    ],
  },
  {
    name: 'tunnel_carry_butter_forbidden',
    state: base({
      cat: { r: 2, c: 5 },
      mouse: { r: 1, c: 1 },
      open: [{ r: 1, c: 1 }, { r: 0, c: 1 }, { r: 1, c: 0 }, { r: 0, c: 0 }, { r: 2, c: 5 }, { r: 1, c: 5 }],
      patch: (s) => ({ ...s, mouseHasButter: true }),
    }),
    tags: ['tunnel', 'carry-butter'],
    expectations: [
      { type: 'rule', description: 'tunnels are open', assert: (b) => b.features.openTunnelCount > 0 },
      { type: 'rule', description: 'carrying butter forbids tunnel use', assert: (b) => b.features.mouseTunnelAllowed === false },
      { type: 'rule', description: 'mouse still flagged as carrying', assert: (b) => b.features.mouseHasButter === true },
    ],
  },
  {
    name: 'tunnel_skill_active',
    state: base({
      cat: { r: 2, c: 5 },
      mouse: { r: 1, c: 1 },
      open: [{ r: 1, c: 1 }, { r: 0, c: 1 }, { r: 1, c: 0 }, { r: 0, c: 0 }, { r: 2, c: 5 }, { r: 1, c: 5 }],
      patch: (s) => ({ ...s, mouseHasButter: false, mouseSkillActive: true }),
    }),
    tags: ['tunnel', 'skill'],
    expectations: [
      { type: 'rule', description: 'skill active re-enables tunnel', assert: (b) => b.features.mouseTunnelAllowed === true },
      { type: 'rule', description: 'skill flagged active', assert: (b) => b.features.mouseSkillActive === true },
    ],
  },

  // --- Trap ---
  {
    name: 'trap_near_mouse',
    state: base({
      cat: { r: 3, c: 3 },
      mouse: { r: 1, c: 1 },
      open: ALL_OPEN,
      patch: (s) => ({ ...s, trapPosition: { r: 1, c: 2 }, catTrapsRemaining: 0 }),
    }),
    tags: ['trap', 'placed'],
    expectations: [
      { type: 'rule', description: 'trap is active on the board', assert: (b) => b.features.trapActive === true },
      { type: 'rule', description: 'trap is 1 step from the mouse', assert: (b) => b.features.mouseTrapDistance === 1 },
      { type: 'rule', description: 'cat has no trap inventory left', assert: (b) => b.features.catHasTrapAvailable === false },
      { type: 'strategic', confidence: 'hard', description: 'trap near mouse is better for cat', betterThan: ['trap_far_mouse'] },
    ],
  },
  {
    name: 'trap_far_mouse',
    state: base({
      cat: { r: 3, c: 3 },
      mouse: { r: 1, c: 1 },
      open: ALL_OPEN,
      patch: (s) => ({ ...s, trapPosition: { r: 8, c: 8 }, catTrapsRemaining: 0 }),
    }),
    tags: ['trap', 'placed'],
    expectations: [
      { type: 'rule', description: 'trap is active', assert: (b) => b.features.trapActive === true },
      { type: 'rule', description: 'trap is far from the mouse', assert: (b) => (b.features.mouseTrapDistance ?? 0) > 3 },
      { type: 'strategic', confidence: 'soft', description: 'trap far from mouse is worse for cat', worseThan: ['trap_near_mouse'] },
    ],
  },
  {
    name: 'trap_cat_has_inventory',
    state: base({
      cat: { r: 3, c: 3 },
      mouse: { r: 1, c: 1 },
      open: ALL_OPEN,
      patch: (s) => ({ ...s, trapPosition: null, catTrapsRemaining: 1 }),
    }),
    tags: ['trap', 'inventory'],
    expectations: [
      { type: 'rule', description: 'cat has a trap available', assert: (b) => b.features.catHasTrapAvailable === true },
      { type: 'rule', description: 'no trap currently placed', assert: (b) => b.features.trapActive === false },
    ],
  },
  {
    name: 'trap_cat_no_inventory',
    state: base({
      cat: { r: 3, c: 3 },
      mouse: { r: 1, c: 1 },
      open: ALL_OPEN,
      patch: (s) => ({ ...s, trapPosition: null, catTrapsRemaining: 0 }),
    }),
    tags: ['trap', 'inventory'],
    expectations: [
      { type: 'rule', description: 'cat has no trap available', assert: (b) => b.features.catHasTrapAvailable === false },
    ],
  },

  // --- Box / tunnel block ---
  {
    name: 'box_tunnel_blocked',
    state: base({
      cat: { r: 3, c: 3 },
      mouse: { r: 1, c: 1 },
      open: ALL_OPEN,
      patch: (s) => blockTunnel(s, { r: 0, c: 0 }),
    }),
    tags: ['box', 'tunnel-block'],
    expectations: [
      { type: 'rule', description: 'at least one tunnel blocked', assert: (b) => b.features.blockedTunnelCount >= 1 },
    ],
  },
  {
    name: 'box_unblocked',
    state: base({
      cat: { r: 3, c: 3 },
      mouse: { r: 1, c: 1 },
      open: ALL_OPEN,
    }),
    tags: ['box', 'tunnel-open'],
    expectations: [
      { type: 'rule', description: 'no tunnel blocked', assert: (b) => b.features.blockedTunnelCount === 0 },
    ],
  },

  // --- Mobility / confinement ---
  {
    name: 'mouse_open_space',
    state: base({ cat: { r: 4, c: 4 }, mouse: { r: 2, c: 2 }, open: ALL_OPEN }),
    tags: ['mobility', 'open'],
    expectations: [
      { type: 'rule', description: 'mouse has a large reachable area', assert: (b) => b.features.mouseReachableArea > 10 },
    ],
  },
  {
    name: 'mouse_confined',
    state: base({
      cat: { r: 2, c: 4 },
      mouse: { r: 2, c: 2 },
      open: [{ r: 2, c: 2 }, { r: 2, c: 3 }, { r: 2, c: 4 }],
    }),
    tags: ['mobility', 'confined'],
    expectations: [
      { type: 'rule', description: 'mouse has a tiny reachable area', assert: (b) => b.features.mouseReachableArea < 6 },
      { type: 'strategic', confidence: 'hard', description: 'a confined mouse is better for cat', betterThan: ['mouse_open_space'] },
    ],
  },

  // --- Tempo ---
  {
    name: 'tempo_cat_turn',
    state: base({ cat: { r: 4, c: 4 }, mouse: { r: 2, c: 2 }, open: ALL_OPEN }),
    tags: ['tempo', 'cat'],
    expectations: [
      { type: 'observation', description: 'positional baseline is turn-agnostic; E1 should add tempo weighting' },
    ],
  },
  {
    name: 'tempo_mouse_turn',
    state: { ...base({ cat: { r: 4, c: 4 }, mouse: { r: 2, c: 2 }, open: ALL_OPEN }), currentPlayer: PieceType.Mouse },
    tags: ['tempo', 'mouse'],
    expectations: [
      { type: 'observation', description: 'same position, mouse to move; score equals cat-turn baseline (turn-agnostic)' },
    ],
  },

  // --- CHANCE-related ---
  {
    name: 'chance_butter_pickup',
    state: base({
      cat: { r: 3, c: 3 },
      mouse: { r: 7, c: 7 },
      open: ALL_OPEN,
      patch: (s) => ({ ...s, butterPositions: [{ r: 7, c: 7 }] }),
    }),
    tags: ['chance', 'butter'],
    expectations: [
      { type: 'rule', description: 'mouse standing on butter → distance 0 (pre-pickup)', assert: (b) => b.features.mouseButterDistance === 0 },
    ],
  },
  {
    name: 'chance_no_butter_left',
    state: base({
      cat: { r: 3, c: 3 },
      mouse: { r: 2, c: 2 },
      open: ALL_OPEN,
      patch: (s) => ({ ...s, butterPositions: [] }),
    }),
    tags: ['chance', 'no-butter'],
    expectations: [
      { type: 'rule', description: 'no butter on board → distance null', assert: (b) => b.features.mouseButterDistance === null },
    ],
  },

  // =========================================================================
  // E1 — Tunnel access: reachable vs unreachable (identical geometry apart
  // from the tunnel state, so the tunnel contribution is isolated).
  // =========================================================================
  {
    name: 'tunnel_sealed_unreachable',
    state: base({
      cat: { r: 4, c: 4 },
      mouse: { r: 2, c: 2 },
      open: [{ r: 2, c: 2 }, { r: 2, c: 3 }, { r: 2, c: 4 }, { r: 4, c: 4 }],
    }),
    tags: ['tunnel', 'unreachable'],
    expectations: [
      { type: 'rule', description: 'mouse is sealed away from every open tunnel', assert: (b) => b.features.mouseCanReachTunnel === false },
      { type: 'rule', description: 'access distance is null when unreachable', assert: (b) => b.features.mouseTunnelAccessDistance === null },
      { type: 'rule', description: 'no reachable open tunnel counted', assert: (b) => b.features.reachableOpenTunnelCount === 0 },
      { type: 'strategic', confidence: 'hard', description: 'an unreachable tunnel is NOT an escape and must not hurt the cat', betterThan: ['tunnel_reachable'] },
    ],
  },
  {
    name: 'tunnel_reachable',
    state: base({
      cat: { r: 4, c: 4 },
      mouse: { r: 2, c: 2 },
      // Same pocket as tunnel_sealed_unreachable PLUS an orthogonal corridor
      // to corner (0,0), so the open tunnel is genuinely reachable.
      open: [
        { r: 2, c: 2 }, { r: 2, c: 3 }, { r: 2, c: 4 }, { r: 4, c: 4 },
        { r: 2, c: 1 }, { r: 1, c: 1 }, { r: 0, c: 1 }, { r: 0, c: 0 },
      ],
    }),
    tags: ['tunnel', 'reachable'],
    expectations: [
      { type: 'rule', description: 'mouse can reach an open tunnel', assert: (b) => b.features.mouseCanReachTunnel === true },
      { type: 'rule', description: 'access distance is finite', assert: (b) => b.features.mouseTunnelAccessDistance !== null && b.features.mouseTunnelAccessDistance > 0 },
      { type: 'strategic', confidence: 'hard', description: 'a REACHABLE tunnel is worse for the cat than an unreachable one', worseThan: ['tunnel_sealed_unreachable'] },
    ],
  },

  // =========================================================================
  // E1 — Two-stage mouse win route (butter -> hole, carrying mode).
  // =========================================================================
  {
    name: 'route_butter_near_hole',
    state: base({
      cat: { r: 1, c: 1 },
      mouse: { r: 4, c: 4 },
      open: ALL_OPEN,
      patch: (s) => ({ ...s, butterPositions: [{ r: 4, c: 5 }] }),
    }),
    tags: ['two-stage', 'win-route'],
    expectations: [
      { type: 'rule', description: 'win route = mouse→butter + butter→hole (carrying)', assert: (b) => b.features.mouseWinRouteDistance !== null && b.features.mouseWinRouteDistance <= 8 },
      { type: 'strategic', confidence: 'hard', description: 'butter near the hole shortens the win route → worse for cat', worseThan: ['route_butter_far_hole'] },
    ],
  },
  {
    name: 'route_butter_far_hole',
    state: base({
      cat: { r: 1, c: 1 },
      mouse: { r: 4, c: 4 },
      open: ALL_OPEN,
      patch: (s) => ({ ...s, butterPositions: [{ r: 2, c: 8 }] }),
    }),
    tags: ['two-stage', 'win-route'],
    expectations: [
      { type: 'rule', description: 'win route is longer for the far butter', assert: (b) => (b.features.mouseWinRouteDistance ?? 0) > 8 },
      { type: 'strategic', confidence: 'hard', description: 'butter far from the hole lengthens the win route → better for cat', betterThan: ['route_butter_near_hole'] },
    ],
  },
  {
    name: 'route_two_butter_choice',
    state: base({
      cat: { r: 1, c: 1 },
      mouse: { r: 4, c: 4 },
      open: ALL_OPEN,
      patch: (s) => ({ ...s, butterPositions: [{ r: 4, c: 5 }, { r: 8, c: 8 }] }),
    }),
    tags: ['two-stage', 'two-butter'],
    expectations: [
      { type: 'rule', description: 'win route picks the SHORTER of the two butters', assert: (b) => b.features.mouseWinRouteDistance !== null && b.features.mouseWinRouteDistance <= 8 },
    ],
  },
  {
    name: 'route_blocked_butter',
    state: base({
      cat: { r: 4, c: 4 },
      mouse: { r: 2, c: 2 },
      open: [{ r: 2, c: 2 }, { r: 2, c: 3 }, { r: 2, c: 4 }, { r: 3, c: 2 }, { r: 3, c: 3 }, { r: 3, c: 4 }, { r: 4, c: 4 }],
      patch: (s) => ({ ...s, butterPositions: [{ r: 8, c: 8 }] }),
    }),
    tags: ['two-stage', 'blocked'],
    expectations: [
      { type: 'rule', description: 'unreachable butter → no legal win route (null)', assert: (b) => b.features.mouseWinRouteDistance === null },
    ],
  },

  // =========================================================================
  // E1 — Hole gate control.
  // =========================================================================
  {
    name: 'gate_cat_controls',
    state: base({
      cat: { r: 6, c: 8 },
      mouse: { r: 1, c: 1 },
      open: ALL_OPEN,
    }),
    tags: ['hole-gate', 'cat-favorable'],
    expectations: [
      { type: 'rule', description: 'cat is strictly closer to the gates', assert: (b) => (b.features.holeControlMargin ?? 99) < 0 },
      { type: 'strategic', confidence: 'soft', description: 'cat controlling the gates earlier is better for cat (positions differ, so confounded by capture/tunnel factors)', betterThan: ['gate_mouse_controls'] },
    ],
  },
  {
    name: 'gate_mouse_controls',
    state: base({
      cat: { r: 1, c: 1 },
      mouse: { r: 7, c: 6 },
      open: ALL_OPEN,
    }),
    tags: ['hole-gate', 'mouse-favorable'],
    expectations: [
      { type: 'rule', description: 'mouse is strictly closer to the gates', assert: (b) => (b.features.holeControlMargin ?? -99) > 0 },
      { type: 'strategic', confidence: 'soft', description: 'mouse reaching the gates first is worse for cat (positions differ, so confounded by capture/tunnel factors)', worseThan: ['gate_cat_controls'] },
    ],
  },

  // =========================================================================
  // E1 — Voronoi: open vs confined.
  // =========================================================================
  {
    name: 'voronoi_confined_mouse',
    state: base({
      cat: { r: 5, c: 5 },
      mouse: { r: 2, c: 2 },
      open: [{ r: 2, c: 2 }, { r: 2, c: 3 }, { r: 2, c: 4 }, { r: 5, c: 5 }, { r: 5, c: 6 }, { r: 6, c: 5 }, { r: 6, c: 6 }],
    }),
    tags: ['voronoi', 'confined'],
    expectations: [
      { type: 'rule', description: 'cat controls a larger area than the mouse', assert: (b) => b.features.catControlledArea > b.features.mouseControlledArea },
      { type: 'rule', description: 'balance favours the cat', assert: (b) => b.features.voronoiBalance > 0 },
    ],
  },
  {
    name: 'voronoi_open_even',
    state: base({
      cat: { r: 5, c: 5 },
      mouse: { r: 2, c: 2 },
      open: ALL_OPEN,
    }),
    tags: ['voronoi', 'open'],
    expectations: [
      { type: 'strategic', confidence: 'soft', description: 'an open board with a centred cat is not obviously worse than a confined mouse', betterThan: ['voronoi_confined_mouse'] },
    ],
  },

  // =========================================================================
  // E1 — Tempo: same geometry, different current player / moves left.
  // =========================================================================
  {
    name: 'tempo_cat_more_moves',
    state: base({
      cat: { r: 4, c: 4 },
      mouse: { r: 2, c: 2 },
      open: ALL_OPEN,
      patch: (s) => ({ ...s, catMovesLeft: 4, mouseMovesLeft: 1 }),
    }),
    tags: ['tempo', 'cat'],
    expectations: [
      { type: 'strategic', confidence: 'soft', description: 'cat acting with more moves left than the mouse is slightly better', betterThan: ['tempo_mouse_more_moves'] },
    ],
  },
  {
    name: 'tempo_mouse_more_moves',
    state: base({
      cat: { r: 4, c: 4 },
      mouse: { r: 2, c: 2 },
      open: ALL_OPEN,
      patch: (s) => ({ ...s, currentPlayer: PieceType.Mouse, catMovesLeft: 1, mouseMovesLeft: 4 }),
    }),
    tags: ['tempo', 'mouse'],
    expectations: [
      { type: 'strategic', confidence: 'soft', description: 'mouse acting with more moves is slightly worse for the cat', worseThan: ['tempo_cat_more_moves'] },
    ],
  },

  // =========================================================================
  // E1 — Trap: reachable vs isolated (mouse-side reachability).
  // =========================================================================
  {
    name: 'trap_reachable',
    state: base({
      cat: { r: 3, c: 3 },
      mouse: { r: 1, c: 1 },
      open: [{ r: 1, c: 1 }, { r: 1, c: 2 }, { r: 3, c: 3 }],
      patch: (s) => ({ ...s, trapPosition: { r: 1, c: 2 }, catTrapsRemaining: 0 }),
    }),
    tags: ['trap', 'reachable'],
    expectations: [
      { type: 'rule', description: 'trap lies inside the mouse region', assert: (b) => b.features.mouseTrapDistance === 1 },
      { type: 'strategic', confidence: 'soft', description: 'a reachable trap is better for the cat than an isolated one (pocket vs corridor geometry confounds capture pressure)', betterThan: ['trap_isolated'] },
    ],
  },
  {
    name: 'trap_isolated',
    state: base({
      cat: { r: 3, c: 3 },
      mouse: { r: 1, c: 1 },
      open: [{ r: 1, c: 1 }, { r: 2, c: 1 }, { r: 3, c: 1 }, { r: 3, c: 2 }, { r: 3, c: 3 }],
      patch: (s) => ({ ...s, trapPosition: { r: 8, c: 8 }, catTrapsRemaining: 0 }),
    }),
    tags: ['trap', 'isolated'],
    expectations: [
      { type: 'rule', description: 'trap outside the mouse region → distance null', assert: (b) => b.features.mouseTrapDistance === null },
      { type: 'strategic', confidence: 'soft', description: 'an isolated trap is worse for the cat than a reachable one (pocket vs corridor geometry confounds capture pressure)', worseThan: ['trap_reachable'] },
    ],
  },
];
