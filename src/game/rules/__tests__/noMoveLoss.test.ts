import { describe, expect, it } from 'vitest';
import {
  createInitialState,
  mouseMove,
  mouseSkill,
  catMove,
  catPlaceTrap,
  endTurn,
} from '../../engine';
import type { GameEngineState } from '../../engine';
import {
  CellType,
  DIRECTIONS,
  GamePhase,
  PieceType,
} from '../../types';
import type { Direction } from '../../types';
import { DEFAULT_CONFIG } from '../../config';
import type { GameConfig } from '../../config';
import { PHASE_B_CONFIG } from '../../tutorial';
import { chooseTunnelExit } from '../tunnels';
import {
  NO_MOVE_LOSS_MESSAGES,
  applyNoMoveLoss,
  catHasLegalSpatialMove,
  mouseHasLegalSpatialMove,
  noMoveLossVerdict,
} from '../mobility';
import { defaultRuleSet } from '../../ai/searchRules';
import { simulateSearchAction } from '../../ai/simulator';
import { generateLegalSearchActions } from '../../ai/legalActions';

const UP: Direction = DIRECTIONS[0];
const LEFT: Direction = DIRECTIONS[2];
const RIGHT: Direction = DIRECTIONS[3];

type Point = { r: number; c: number };
const pt = (r: number, c: number): Point => ({ r, c });

interface StateOpts {
  size?: number;
  mouse: Point;
  cat: Point;
  walls?: Point[];
  boxes?: Point[];
  butters?: Point[];
  trap?: Point | null;
  catTraps?: number;
  currentPlayer?: PieceType;
  mouseMoves?: number;
  catMoves?: number;
  mouseHasButter?: boolean;
  mouseSkillActive?: boolean;
  blockedTunnels?: Point[];
}

/**
 * Fully deterministic fixture: an open board with the default 4 tunnel
 * corners, a 1x1 mouse hole at (size-2, size-2), and only the terrain the test
 * asks for. Nothing is random.
 */
function makeState(opts: StateOpts): GameEngineState {
  const size = opts.size ?? 7;
  const config: GameConfig = {
    ...DEFAULT_CONFIG,
    boardSize: size,
    mouseHole: { r: size - 2, c: size - 2, size: 1 },
    boxCount: 0,
    pileCount: 0,
    butterCount: 0,
    mouseStart: opts.mouse,
    catStart: opts.cat,
    tunnelCorners: [
      { r: 0, c: 0, label: 'tl' },
      { r: 0, c: size - 1, label: 'tr' },
      { r: size - 1, c: 0, label: 'bl' },
      { r: size - 1, c: size - 1, label: 'br' },
    ],
  };
  const base = createInitialState(config);
  const board: GameEngineState['board'] = base.board.map((row) =>
    row.map((cell) => ({
      type: cell.type === CellType.MouseHole || cell.type === CellType.Tunnel
        ? cell.type
        : CellType.Empty,
      piece: undefined as PieceType | undefined,
      hasButter: false,
    })),
  );

  for (const p of opts.walls ?? []) board[p.r][p.c].type = CellType.Wall;
  for (const p of opts.boxes ?? []) board[p.r][p.c].type = CellType.Box;
  for (const p of opts.butters ?? []) board[p.r][p.c].hasButter = true;
  board[opts.mouse.r][opts.mouse.c].piece = PieceType.Mouse;
  board[opts.cat.r][opts.cat.c].piece = PieceType.Cat;

  return {
    ...base,
    board,
    mousePosition: opts.mouse,
    catPosition: opts.cat,
    butterPositions: (opts.butters ?? []).map((p) => ({ ...p })),
    currentPlayer: opts.currentPlayer ?? PieceType.Mouse,
    mouseMovesLeft: opts.mouseMoves ?? 4,
    catMovesLeft: opts.catMoves ?? 4,
    mouseHasButter: opts.mouseHasButter ?? false,
    mouseSkillActive: opts.mouseSkillActive ?? false,
    trapPosition: opts.trap ? { ...opts.trap } : null,
    catTrapsRemaining: opts.catTraps ?? (opts.trap ? 0 : 1),
    blockedTunnels: (opts.blockedTunnels ?? []).map((p) => ({ ...p })),
    pendingButterSpawns: [],
    pendingButterPlacementDebt: 0,
    phase: GamePhase.Playing,
    tunnelExitChoices: [],
    message: '',
    gameEventLog: [],
    catActionLog: [],
    lastHardSearch: null,
    hardSearchHistory: [],
    hardProgressGuardMemory: null,
  };
}

/** Cat at (3,3) sealed by boxes that cannot be pushed (walls right behind). */
function sealedCatOpts(): Pick<StateOpts, 'cat' | 'boxes' | 'walls'> {
  return {
    cat: pt(3, 3),
    boxes: [pt(2, 3), pt(4, 3), pt(3, 2), pt(3, 4)],
    walls: [pt(1, 3), pt(5, 3), pt(3, 1), pt(3, 5)],
  };
}

describe('RULE-A — no legal spatial move loss', () => {
  it('1. mouse boxed in by boxes loses immediately (CatWins)', () => {
    const s = makeState({
      mouse: pt(3, 3),
      cat: pt(0, 5),
      boxes: [pt(2, 3), pt(4, 3), pt(3, 2), pt(3, 4)],
    });
    expect(mouseHasLegalSpatialMove(s)).toBe(false);
    expect(noMoveLossVerdict(s)?.phase).toBe(GamePhase.CatWins);

    const next = mouseMove(s, RIGHT);
    expect(next.phase).toBe(GamePhase.CatWins);
    expect(next.message).toBe(NO_MOVE_LOSS_MESSAGES.mouseStranded);
  });

  it('2. mouse pinched by the cat + boxes loses immediately', () => {
    const s = makeState({
      mouse: pt(3, 3),
      cat: pt(2, 3),
      walls: [pt(4, 3), pt(3, 2), pt(3, 4)],
    });
    expect(mouseHasLegalSpatialMove(s)).toBe(false);
    const next = mouseMove(s, RIGHT);
    expect(next.phase).toBe(GamePhase.CatWins);
    expect(next.message).toBe(NO_MOVE_LOSS_MESSAGES.mouseStranded);
  });

  it('3. cat sealed by unpushable boxes loses immediately (MouseWins)', () => {
    const s = makeState({
      mouse: pt(0, 5),
      currentPlayer: PieceType.Cat,
      ...sealedCatOpts(),
    });
    expect(catHasLegalSpatialMove(s)).toBe(false);
    expect(noMoveLossVerdict(s)?.phase).toBe(GamePhase.MouseWins);

    const next = catMove(s, RIGHT);
    expect(next.phase).toBe(GamePhase.MouseWins);
    expect(next.message).toBe(NO_MOVE_LOSS_MESSAGES.catStranded);
  });

  it('4. cat that CAN push a box does not lose', () => {
    const s = makeState({
      mouse: pt(0, 5),
      cat: pt(3, 3),
      boxes: [pt(3, 4)],
      currentPlayer: PieceType.Cat,
    });
    expect(catHasLegalSpatialMove(s)).toBe(true);
    expect(noMoveLossVerdict(s)).toBeNull();

    const next = catMove(s, RIGHT);
    expect(next.phase).toBe(GamePhase.Playing);
    expect(next.catPosition).toEqual(pt(3, 4));
    expect(next.board[3][5].type).toBe(CellType.Box);
  });

  it('5. a trap alone cannot rescue a stranded cat (MouseWins)', () => {
    const s = makeState({
      mouse: pt(0, 5),
      currentPlayer: PieceType.Cat,
      catTraps: 1,
      ...sealedCatOpts(),
    });
    expect(catHasLegalSpatialMove(s)).toBe(false);

    const next = catPlaceTrap(s);
    expect(next.phase).toBe(GamePhase.MouseWins);
    expect(next.message).toBe(NO_MOVE_LOSS_MESSAGES.catStranded);
  });

  it('6. mouse skill that unlocks a tunnel prevents an early loss', () => {
    const s = makeState({
      mouse: pt(0, 1),
      cat: pt(5, 5),
      walls: [pt(1, 1), pt(0, 2)],
      mouseHasButter: true,
    });
    // Only spatial neighbour is the (0,0) tunnel, blocked by carried butter.
    expect(mouseHasLegalSpatialMove(s)).toBe(false);
    expect(noMoveLossVerdict(s)).toBeNull(); // skill consumes butter → tunnel opens

    const afterSkill = mouseSkill(s);
    expect(afterSkill.phase).toBe(GamePhase.Playing);
    expect(afterSkill.mouseHasButter).toBe(false);
    expect(afterSkill.mouseSkillActive).toBe(true);
    expect(mouseHasLegalSpatialMove(afterSkill)).toBe(true);

    const entered = mouseMove(afterSkill, LEFT);
    expect(entered.phase).toBe(GamePhase.ChoosingTunnelExit);
  });

  it('7. a skill that only adds moves but opens no route still loses', () => {
    const s = makeState({
      mouse: pt(3, 3),
      cat: pt(0, 5),
      walls: [pt(2, 3), pt(4, 3), pt(3, 2), pt(3, 4)],
      mouseHasButter: true,
    });
    const next = mouseSkill(s);
    expect(next.phase).toBe(GamePhase.CatWins);
    expect(next.message).toBe(NO_MOVE_LOSS_MESSAGES.mouseStranded);
  });

  it('8. capture priority: stepping onto the mouse wins as a capture', () => {
    const s = makeState({
      mouse: pt(3, 4),
      cat: pt(3, 3),
      currentPlayer: PieceType.Cat,
    });
    const next = catMove(s, RIGHT);
    expect(next.phase).toBe(GamePhase.CatWins);
    expect(next.message).toContain('抓住');
    expect(next.message).not.toContain('无路可走');
  });

  it('9. butter-into-hole priority: entering the hole with butter wins', () => {
    const s = makeState({
      mouse: pt(5, 4),
      cat: pt(0, 0),
      mouseHasButter: true,
    });
    const next = mouseMove(s, RIGHT);
    expect(next.phase).toBe(GamePhase.MouseWins);
    expect(next.message).toContain('带回鼠洞');
    expect(next.message).not.toContain('无路可走');
  });

  it('10. move budget already 0 takes the normal hand-off, never a verdict', () => {
    const mouseOut = makeState({
      mouse: pt(3, 3),
      cat: pt(0, 5),
      walls: [pt(2, 3), pt(4, 3), pt(3, 2), pt(3, 4)],
      mouseMoves: 0,
    });
    expect(applyNoMoveLoss(mouseOut)).toBe(mouseOut);
    const afterMouse = endTurn(mouseOut);
    expect(afterMouse.phase).toBe(GamePhase.Playing);
    expect(afterMouse.currentPlayer).toBe(PieceType.Cat);

    const catOut = makeState({
      mouse: pt(0, 5),
      currentPlayer: PieceType.Cat,
      catMoves: 0,
      ...sealedCatOpts(),
    });
    expect(applyNoMoveLoss(catOut)).toBe(catOut);
    const afterCat = endTurn(catOut);
    expect(afterCat.phase).toBe(GamePhase.Playing);
    expect(afterCat.currentPlayer).toBe(PieceType.Mouse);
  });

  it('11. trap step hands off normally (and a stranded incoming cat still loses)', () => {
    const open = makeState({
      mouse: pt(1, 1),
      cat: pt(5, 5),
      trap: pt(1, 2),
    });
    const trapped = mouseMove(open, RIGHT);
    expect(trapped.phase).toBe(GamePhase.Playing);
    expect(trapped.currentPlayer).toBe(PieceType.Cat);
    expect(trapped.mouseMovesLeft).toBe(0);
    expect(trapped.message).toContain('捕鼠夹');

    const sealed = makeState({
      mouse: pt(1, 1),
      trap: pt(1, 2),
      ...sealedCatOpts(),
    });
    const trappedThenSealed = mouseMove(sealed, RIGHT);
    expect(trappedThenSealed.phase).toBe(GamePhase.MouseWins);
    expect(trappedThenSealed.message).toBe(NO_MOVE_LOSS_MESSAGES.catStranded);
  });

  it('12. choosing a tunnel exit is never a no-move loss', () => {
    const s = makeState({ mouse: pt(0, 1), cat: pt(5, 5) });
    const choosing = mouseMove(s, LEFT);
    expect(choosing.phase).toBe(GamePhase.ChoosingTunnelExit);
    expect(choosing.mouseMovesLeft).toBe(0);
    expect(noMoveLossVerdict(choosing)).toBeNull();
    expect(applyNoMoveLoss(choosing)).toBe(choosing);

    const landed = chooseTunnelExit(choosing, 0, 0);
    expect(landed.phase).toBe(GamePhase.Playing);
    const ended = endTurn(landed);
    expect(ended.phase).toBe(GamePhase.Playing);
    expect(ended.currentPlayer).toBe(PieceType.Cat);
  });

  it('13. a failed/empty Hard plan with legal moves is NOT a no-move loss', () => {
    // GamePage's empty-trajectory fallback is exactly `endTurn(catState)`.
    const s = makeState({
      mouse: pt(0, 5),
      cat: pt(3, 3),
      currentPlayer: PieceType.Cat,
    });
    expect(s.lastHardSearch).toBeNull(); // no plan / failed plan
    expect(catHasLegalSpatialMove(s)).toBe(true);
    expect(noMoveLossVerdict(s)).toBeNull();

    const fallback = endTurn(s);
    expect(fallback.phase).toBe(GamePhase.Playing);
    expect(fallback.currentPlayer).toBe(PieceType.Mouse);
  });

  it('14. an illegal direction keypress does not fabricate a loss', () => {
    const cat = makeState({
      mouse: pt(0, 5),
      cat: pt(3, 3),
      walls: [pt(2, 3)],
      currentPlayer: PieceType.Cat,
    });
    const catAfter = catMove(cat, UP);
    expect(catAfter.phase).toBe(GamePhase.Playing);
    expect(catAfter.catPosition).toEqual(pt(3, 3));

    const mouse = makeState({
      mouse: pt(3, 3),
      cat: pt(0, 5),
      walls: [pt(2, 3)],
    });
    const mouseAfter = mouseMove(mouse, UP);
    expect(mouseAfter.phase).toBe(GamePhase.Playing);
    expect(mouseAfter.mousePosition).toEqual(pt(3, 3));
  });

  it('15. the real engine and the Search Simulator reach the same terminal', () => {
    const mouseStranded = makeState({
      mouse: pt(3, 3),
      cat: pt(0, 5),
      walls: [pt(2, 3), pt(4, 3), pt(3, 2), pt(3, 4)],
    });
    const engineMouse = mouseMove(mouseStranded, RIGHT);
    const simMouse = simulateSearchAction(
      mouseStranded,
      { type: 'mouseStep', direction: RIGHT },
      defaultRuleSet,
    );
    expect(simMouse.kind).toBe('deterministic');
    if (simMouse.kind === 'deterministic') {
      expect(simMouse.state.phase).toBe(engineMouse.phase);
      expect(simMouse.state.message).toBe(engineMouse.message);
    }
    expect(generateLegalSearchActions(engineMouse, defaultRuleSet)).toEqual([]);

    const catStranded = makeState({
      mouse: pt(0, 5),
      currentPlayer: PieceType.Cat,
      ...sealedCatOpts(),
    });
    const engineCat = catMove(catStranded, RIGHT);
    const simCat = simulateSearchAction(
      catStranded,
      { type: 'catStep', direction: RIGHT },
      defaultRuleSet,
    );
    expect(simCat.kind).toBe('deterministic');
    if (simCat.kind === 'deterministic') {
      expect(simCat.state.phase).toBe(engineCat.phase);
      expect(simCat.state.message).toBe(engineCat.message);
    }
  });

  it('16. custom/tutorial layouts keep their fixed butter and stay playable', () => {
    const tutorial = createInitialState(PHASE_B_CONFIG);
    // LAYOUT_B has exactly one ButterSpot at (1,2); nothing may rewrite it.
    expect(tutorial.butterPositions).toEqual([{ r: 1, c: 2 }]);
    expect(tutorial.phase).toBe(GamePhase.Playing);
    expect(mouseHasLegalSpatialMove(tutorial)).toBe(true);

    const explicit: GameConfig = {
      ...DEFAULT_CONFIG,
      boxCount: 0,
      pileCount: 0,
      butterCount: 1,
      butterPositions: [{ r: 3, c: 4 }],
    };
    const explicitState = createInitialState(explicit);
    expect(explicitState.butterPositions).toEqual([{ r: 3, c: 4 }]);
    expect(explicitState.phase).toBe(GamePhase.Playing);
  });
});
