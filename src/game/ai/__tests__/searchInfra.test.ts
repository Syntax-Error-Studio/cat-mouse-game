import { describe, it, expect } from 'vitest';
import {
  createInitialState,
  mouseMove,
  mouseStepDeterministic,
  catMove,
  mouseSkill,
  catPlaceTrap,
  endTurn,
} from '../../engine';
import { chooseTunnelExit as ruleChooseTunnel } from '../../rules/tunnels';
import { DEFAULT_CONFIG } from '../../config';
import { DIRECTIONS, GamePhase, PieceType, CellType } from '../../types';
import type { GameEngineState } from '../../engine';
import type { Direction } from '../../types';
import type { RuleSet, SearchAction, SearchTransitionResult } from '../searchTypes';
import { simulateSearchAction } from '../simulator';
import { generateLegalSearchActions } from '../legalActions';
import { stateKey } from '../transposition';
import { gameAffectingEqual } from '../stateCompare';
import { evaluateForCat, HEURISTIC_LIMIT } from '../evaluation';
import { defaultRuleSet } from '../searchRules';

// ---------------------------------------------------------------- helpers
function dir(key: string): Direction {
  const d = DIRECTIONS.find((x) => x.key === key);
  if (!d) throw new Error(`no direction ${key}`);
  return d;
}
function dirFromDelta(dr: number, dc: number): Direction {
  const d = DIRECTIONS.find((x) => x.dr === dr && x.dc === dc);
  if (!d) throw new Error(`no direction ${dr},${dc}`);
  return d;
}
function setCell(s: GameEngineState, r: number, c: number, type: CellType, piece?: PieceType, hasButter = false) {
  s.board[r][c] = { ...s.board[r][c], type, piece: piece ?? undefined, hasButter };
}
function clearCell(s: GameEngineState, r: number, c: number) {
  setCell(s, r, c, CellType.Empty, undefined, false);
}
function baseState(): GameEngineState {
  const s = createInitialState(DEFAULT_CONFIG);
  s.butterPositions = [];
  s.trapPosition = null;
  s.mouseHasButter = false;
  s.mouseSkillActive = false;
  return s;
}
function tunnelCornerCells(s: GameEngineState): { r: number; c: number }[] {
  const out: { r: number; c: number }[] = [];
  for (let r = 0; r < s.board.length; r++) {
    for (let c = 0; c < s.board[r].length; c++) {
      if (s.board[r][c].type === CellType.Tunnel) out.push({ r, c });
    }
  }
  return out;
}
function resultState(res: SearchTransitionResult): GameEngineState {
  return res.kind === 'chance' ? res.outcomes[0].state : res.state;
}

describe('B2.5 search infrastructure', () => {
  describe('RuleSet wiring (simulator uses the REAL engine)', () => {
    it('binds the exact engine transition functions', () => {
      expect(defaultRuleSet.mouseStep).toBe(mouseStepDeterministic);
      expect(defaultRuleSet.catMove).toBe(catMove);
      expect(defaultRuleSet.mouseSkill).toBe(mouseSkill);
      expect(defaultRuleSet.catPlaceTrap).toBe(catPlaceTrap);
      expect(defaultRuleSet.chooseTunnelExit).toBe(ruleChooseTunnel);
      expect(defaultRuleSet.endTurn).toBe(endTurn);
      // enumerateButterSpawns is adapted to the (state) => Point[] contract
      const enumState = createInitialState(DEFAULT_CONFIG);
      expect(Array.isArray(defaultRuleSet.enumerateButterSpawns(enumState))).toBe(true);
    });

    it('endTurn is bound for FORCED turn hand-off, NOT exposed as a SearchAction', () => {
      const s = createInitialState(DEFAULT_CONFIG);
      const acts = generateLegalSearchActions(s, defaultRuleSet);
      expect(acts.some((a: SearchAction) => (a.type as string) === 'endTurn')).toBe(false);
    });
  });

  describe('Math.random is never monkey-patched', () => {
    it('preserves the global Math.random identity after a butter-pickup chance transition', () => {
      const before = Math.random;
      const s = baseState();
      s.mousePosition = { r: 5, c: 5 }; clearCell(s, 5, 5); setCell(s, 5, 5, CellType.Empty, PieceType.Mouse);
      clearCell(s, 5, 6); setCell(s, 5, 6, CellType.Empty, undefined, true);
      s.butterPositions = [{ r: 5, c: 6 }];
      s.currentPlayer = PieceType.Mouse; s.phase = GamePhase.Playing; s.mouseMovesLeft = 4;
      simulateSearchAction(s, { type: 'mouseStep', direction: dir('ArrowRight') }, defaultRuleSet);
      expect(Math.random).toBe(before);
    });
  });

  describe('chance interface (butter regeneration is honest, not a hidden draw)', () => {
    it('mouseStep onto a butter yields a chance node with one outcome per legal spawn', () => {
      const s = baseState();
      s.mousePosition = { r: 5, c: 5 }; clearCell(s, 5, 5); setCell(s, 5, 5, CellType.Empty, PieceType.Mouse);
      clearCell(s, 5, 6); setCell(s, 5, 6, CellType.Empty, undefined, true);
      s.butterPositions = [{ r: 5, c: 6 }];
      s.currentPlayer = PieceType.Mouse; s.phase = GamePhase.Playing; s.mouseMovesLeft = 4;

      const sim = simulateSearchAction(s, { type: 'mouseStep', direction: dir('ArrowRight') }, defaultRuleSet);
      expect(sim.kind).toBe('chance');
      if (sim.kind !== 'chance') return;

      const postPickup = mouseStepDeterministic(s, dir('ArrowRight')); // deterministic core, no spawn
      const cands = defaultRuleSet.enumerateButterSpawns(postPickup);
      expect(sim.outcomes).toHaveLength(cands.length);
      expect(sim.outcomes.length).toBeGreaterThan(0);

      const weightSum = sim.outcomes.reduce((a, o) => a + o.weight, 0);
      expect(weightSum).toBeCloseTo(1, 10);
      for (const o of sim.outcomes) {
        expect(o.state.mouseHasButter).toBe(true);
        expect(o.state.butterPositions).toHaveLength(s.butterPositions.length); // -1 picked +1 spawned
        // each outcome's butter set == postPickup set + exactly one of the candidates
        const plus1 = cands.some((cand) =>
          gameAffectingEqual(
            { ...o.state, butterPositions: o.state.butterPositions.filter((b) => !(b.r === cand.r && b.c === cand.c)) },
            { ...o.state, butterPositions: postPickup.butterPositions },
          ),
        );
        expect(plus1).toBe(true);
      }

      // The real game (one random draw) is one of the enumerated outcomes.
      const real = mouseMove(s, dir('ArrowRight'));
      expect(sim.outcomes.some((o) => gameAffectingEqual(o.state, real))).toBe(true);
    });

    it('mouseStep into an empty cell yields a deterministic result', () => {
      const s = baseState();
      s.mousePosition = { r: 5, c: 5 }; clearCell(s, 5, 5); setCell(s, 5, 5, CellType.Empty, PieceType.Mouse);
      clearCell(s, 5, 6);
      s.currentPlayer = PieceType.Mouse; s.phase = GamePhase.Playing; s.mouseMovesLeft = 4;
      const sim = simulateSearchAction(s, { type: 'mouseStep', direction: dir('ArrowRight') }, defaultRuleSet);
      expect(sim.kind).toBe('deterministic');
    });
  });

  // ---------------------------------------------------- equivalence matrix
  // Every scenario: Search Simulator result == Real engine result, comparing
  // only game-affecting fields (message / catActionLog / gameEventLog excluded).
  describe('Real Engine vs Search Simulator equivalence', () => {
    it('普通鼠移动 (normal mouse move)', () => {
      const s = baseState();
      s.mousePosition = { r: 5, c: 5 }; clearCell(s, 5, 5); setCell(s, 5, 5, CellType.Empty, PieceType.Mouse);
      clearCell(s, 5, 6);
      s.currentPlayer = PieceType.Mouse; s.phase = GamePhase.Playing; s.mouseMovesLeft = 4;
      const real = mouseMove(s, dir('ArrowRight'));
      const sim = simulateSearchAction(s, { type: 'mouseStep', direction: dir('ArrowRight') }, defaultRuleSet);
      expect(gameAffectingEqual(real, resultState(sim))).toBe(true);
    });

    it('鼠技能 (mouse skill)', () => {
      const s = baseState();
      s.mousePosition = { r: 5, c: 5 }; clearCell(s, 5, 5); setCell(s, 5, 5, CellType.Empty, PieceType.Mouse);
      s.mouseHasButter = true; s.mouseSkillActive = false;
      s.currentPlayer = PieceType.Mouse; s.phase = GamePhase.Playing; s.mouseMovesLeft = 4;
      const real = mouseSkill(s);
      const sim = simulateSearchAction(s, { type: 'mouseSkill' }, defaultRuleSet);
      expect(gameAffectingEqual(real, resultState(sim))).toBe(true);
    });

    it('鼠踩陷阱 (mouse steps on trap -> turn flips to cat)', () => {
      const s = baseState();
      s.mousePosition = { r: 5, c: 5 }; clearCell(s, 5, 5); setCell(s, 5, 5, CellType.Empty, PieceType.Mouse);
      clearCell(s, 5, 6); s.trapPosition = { r: 5, c: 6 };
      s.currentPlayer = PieceType.Mouse; s.phase = GamePhase.Playing; s.mouseMovesLeft = 4;
      const real = mouseMove(s, dir('ArrowRight'));
      const sim = simulateSearchAction(s, { type: 'mouseStep', direction: dir('ArrowRight') }, defaultRuleSet);
      expect(gameAffectingEqual(real, resultState(sim))).toBe(true);
      expect(resultState(sim).currentPlayer).toBe(PieceType.Cat);
      expect(resultState(sim).trapPosition).toBeNull();
    });

    it('携黄油进洞 (carry butter into hole -> mouse wins)', () => {
      const s = baseState();
      s.config = { ...s.config, mouseHole: { r: 5, c: 6, size: 1 } };
      s.mousePosition = { r: 5, c: 5 }; clearCell(s, 5, 5); setCell(s, 5, 5, CellType.Empty, PieceType.Mouse);
      clearCell(s, 5, 6); setCell(s, 5, 6, CellType.MouseHole);
      s.mouseHasButter = true;
      s.currentPlayer = PieceType.Mouse; s.phase = GamePhase.Playing; s.mouseMovesLeft = 4;
      const real = mouseMove(s, dir('ArrowRight'));
      const sim = simulateSearchAction(s, { type: 'mouseStep', direction: dir('ArrowRight') }, defaultRuleSet);
      expect(gameAffectingEqual(real, resultState(sim))).toBe(true);
      expect(resultState(sim).phase).toBe(GamePhase.MouseWins);
    });

    it('猫普通移动 (cat normal move, no forced endTurn while moves remain)', () => {
      const s = baseState();
      s.catPosition = { r: 5, c: 5 }; clearCell(s, 5, 5); setCell(s, 5, 5, CellType.Empty, PieceType.Cat);
      clearCell(s, 6, 5);
      s.currentPlayer = PieceType.Cat; s.phase = GamePhase.Playing; s.catMovesLeft = 4;
      const real = catMove(s, dir('ArrowDown'));
      const sim = simulateSearchAction(s, { type: 'catStep', direction: dir('ArrowDown') }, defaultRuleSet);
      expect(gameAffectingEqual(real, resultState(sim))).toBe(true);
      expect(resultState(sim).currentPlayer).toBe(PieceType.Cat);
    });

    it('猫抓鼠 (cat catches mouse -> cat wins)', () => {
      const s = baseState();
      s.catPosition = { r: 5, c: 5 }; clearCell(s, 5, 5); setCell(s, 5, 5, CellType.Empty, PieceType.Cat);
      clearCell(s, 5, 6); setCell(s, 5, 6, CellType.Empty, PieceType.Mouse); s.mousePosition = { r: 5, c: 6 };
      s.currentPlayer = PieceType.Cat; s.phase = GamePhase.Playing; s.catMovesLeft = 4;
      const real = catMove(s, dir('ArrowRight'));
      const sim = simulateSearchAction(s, { type: 'catStep', direction: dir('ArrowRight') }, defaultRuleSet);
      expect(gameAffectingEqual(real, resultState(sim))).toBe(true);
      expect(resultState(sim).phase).toBe(GamePhase.CatWins);
    });

    it('猫推箱 (cat pushes box)', () => {
      const s = baseState();
      s.catPosition = { r: 5, c: 5 }; clearCell(s, 5, 5); setCell(s, 5, 5, CellType.Empty, PieceType.Cat);
      clearCell(s, 5, 6); setCell(s, 5, 6, CellType.Box);
      clearCell(s, 5, 7);
      s.currentPlayer = PieceType.Cat; s.phase = GamePhase.Playing; s.catMovesLeft = 4;
      const real = catMove(s, dir('ArrowRight'));
      const sim = simulateSearchAction(s, { type: 'catStep', direction: dir('ArrowRight') }, defaultRuleSet);
      expect(gameAffectingEqual(real, resultState(sim))).toBe(true);
      expect(resultState(sim).board[5][7].type).toBe(CellType.Box);
    });

    it('推箱封通道 (cat pushes box onto a tunnel corner -> tunnel blocked)', () => {
      const s = baseState();
      const corners = tunnelCornerCells(s);
      const E = corners[0];
      const bx = E.r, by = E.c + 1; // cell just inside from corner
      const cx = E.r, cy = E.c + 2;
      clearCell(s, bx, by); setCell(s, bx, by, CellType.Box);
      clearCell(s, cx, cy); setCell(s, cx, cy, CellType.Empty, PieceType.Cat); s.catPosition = { r: cx, c: cy };
      s.currentPlayer = PieceType.Cat; s.phase = GamePhase.Playing; s.catMovesLeft = 4;
      const left = dirFromDelta(0, -1);
      const real = catMove(s, left);
      const sim = simulateSearchAction(s, { type: 'catStep', direction: left }, defaultRuleSet);
      expect(gameAffectingEqual(real, resultState(sim))).toBe(true);
      expect(resultState(sim).blockedTunnels.some((t) => t.r === E.r && t.c === E.c)).toBe(true);
    });

    it('猫放陷阱 (cat places trap)', () => {
      const s = baseState();
      s.catPosition = { r: 5, c: 5 }; clearCell(s, 5, 5); setCell(s, 5, 5, CellType.Empty, PieceType.Cat);
      s.currentPlayer = PieceType.Cat; s.phase = GamePhase.Playing; s.catMovesLeft = 4;
      s.trapPosition = null; s.catTrapsRemaining = 1;
      const real = catPlaceTrap(s);
      const sim = simulateSearchAction(s, { type: 'catPlaceTrap' }, defaultRuleSet);
      expect(gameAffectingEqual(real, resultState(sim))).toBe(true);
      expect(resultState(sim).trapPosition).toEqual({ r: 5, c: 5 });
    });

    it('猫回收陷阱 (cat steps onto its own trap -> retrieves it)', () => {
      const s = baseState();
      s.catPosition = { r: 5, c: 5 }; clearCell(s, 5, 5); setCell(s, 5, 5, CellType.Empty, PieceType.Cat);
      clearCell(s, 5, 6); s.trapPosition = { r: 5, c: 6 };
      s.currentPlayer = PieceType.Cat; s.phase = GamePhase.Playing; s.catMovesLeft = 4; s.catTrapsRemaining = 0;
      const real = catMove(s, dir('ArrowRight'));
      const sim = simulateSearchAction(s, { type: 'catStep', direction: dir('ArrowRight') }, defaultRuleSet);
      expect(gameAffectingEqual(real, resultState(sim))).toBe(true);
      expect(resultState(sim).trapPosition).toBeNull();
      expect(resultState(sim).catTrapsRemaining).toBe(1);
    });

    it('单出口 tunnel (single exit -> shared kernel teleport + forced endTurn)', () => {
      const s = baseState();
      const corners = tunnelCornerCells(s);
      const E = corners[0];
      const others = corners.slice(1);
      s.blockedTunnels = others.map((o) => ({ r: o.r, c: o.c })); // block all other exits
      const nbr = E.r + 1 < s.board.length ? { r: E.r + 1, c: E.c } : { r: E.r, c: E.c + 1 };
      clearCell(s, nbr.r, nbr.c); setCell(s, nbr.r, nbr.c, CellType.Empty, PieceType.Mouse);
      s.mousePosition = { r: nbr.r, c: nbr.c };
      s.currentPlayer = PieceType.Mouse; s.phase = GamePhase.Playing; s.mouseMovesLeft = 4;
      s.mouseHasButter = false; s.butterPositions = []; s.trapPosition = null;
      const act = dirFromDelta(E.r - nbr.r, E.c - nbr.c);

      const real = mouseMove(s, act); // real game auto-resolves single exit via the shared kernel
      const simChoosing = simulateSearchAction(s, { type: 'mouseStep', direction: act }, defaultRuleSet);
      const choosing = resultState(simChoosing);
      const stay = choosing.tunnelExitChoices[0];
      const sim = simulateSearchAction(choosing, { type: 'chooseTunnel', r: stay.r, c: stay.c }, defaultRuleSet);
      expect(gameAffectingEqual(real, resultState(sim))).toBe(true);
      expect(resultState(sim).currentPlayer).toBe(PieceType.Cat);
    });

    it('多出口 tunnel + choose exit (multi-exit -> chooseTunnel + forced endTurn)', () => {
      const s = baseState();
      const corners = tunnelCornerCells(s);
      const E = corners[0];
      const others = corners.slice(1);
      s.blockedTunnels = others.slice(0, 2).map((o) => ({ r: o.r, c: o.c })); // leave one reachable
      const nbr = E.r + 1 < s.board.length ? { r: E.r + 1, c: E.c } : { r: E.r, c: E.c + 1 };
      clearCell(s, nbr.r, nbr.c); setCell(s, nbr.r, nbr.c, CellType.Empty, PieceType.Mouse);
      s.mousePosition = { r: nbr.r, c: nbr.c };
      s.currentPlayer = PieceType.Mouse; s.phase = GamePhase.Playing; s.mouseMovesLeft = 4;
      s.mouseHasButter = false; s.butterPositions = []; s.trapPosition = null;
      const act = dirFromDelta(E.r - nbr.r, E.c - nbr.c);

      const realChoosing = mouseMove(s, act); // -> ChoosingTunnelExit
      const simChoosing = simulateSearchAction(s, { type: 'mouseStep', direction: act }, defaultRuleSet);
      expect(gameAffectingEqual(realChoosing, resultState(simChoosing))).toBe(true);
      expect(resultState(simChoosing).phase).toBe(GamePhase.ChoosingTunnelExit);

      for (const choice of resultState(simChoosing).tunnelExitChoices) {
        const realExit = endTurn(ruleChooseTunnel(resultState(simChoosing), choice.r, choice.c));
        const simExit = simulateSearchAction(
          resultState(simChoosing), { type: 'chooseTunnel', r: choice.r, c: choice.c }, defaultRuleSet,
        );
        expect(gameAffectingEqual(realExit, resultState(simExit))).toBe(true);
      }
    });

    it('回合自然切换 (cat exhausts moves -> simulator forces endTurn)', () => {
      const s = baseState();
      s.catPosition = { r: 5, c: 5 }; clearCell(s, 5, 5); setCell(s, 5, 5, CellType.Empty, PieceType.Cat);
      clearCell(s, 6, 5);
      s.currentPlayer = PieceType.Cat; s.phase = GamePhase.Playing; s.catMovesLeft = 1; // last move
      const real = endTurn(catMove(s, dir('ArrowDown')));
      const sim = simulateSearchAction(s, { type: 'catStep', direction: dir('ArrowDown') }, defaultRuleSet);
      expect(gameAffectingEqual(real, resultState(sim))).toBe(true);
      expect(resultState(sim).currentPlayer).toBe(PieceType.Mouse);
    });
  });

  describe('stateKey canonicalization', () => {
    const s = createInitialState(DEFAULT_CONFIG);
    const k = stateKey(s);

    it('is stable for the same state', () => {
      expect(stateKey(s)).toBe(k);
    });
    it('ignores message', () => {
      expect(stateKey({ ...s, message: 'totally different' })).toBe(k);
    });
    it('ignores catActionLog / gameEventLog', () => {
      const l = {
        ...s,
        catActionLog: [...s.catActionLog, 'x'],
        gameEventLog: [...s.gameEventLog, 'y'],
      };
      expect(stateKey(l)).toBe(k);
    });
    it('differs on a game-affecting field (mousePosition)', () => {
      const p = { ...s, mousePosition: { r: (s.mousePosition.r + 1) % s.config.boardSize, c: s.mousePosition.c } };
      expect(stateKey(p)).not.toBe(k);
    });
    it('is order-independent for butterPositions', () => {
      const bp = { ...s, butterPositions: [...s.butterPositions].reverse() };
      expect(stateKey(bp)).toBe(k);
    });
    it('is order-independent for tunnelExitChoices', () => {
      const te = { ...s, tunnelExitChoices: [{ r: 9, c: 9, label: 'a' }, { r: 0, c: 0, label: 'b' }] };
      const teRev = { ...s, tunnelExitChoices: [{ r: 0, c: 0, label: 'b' }, { r: 9, c: 9, label: 'a' }] };
      expect(stateKey(te)).toBe(stateKey(teRev));
    });
    it('includes a config signature so identical boards under different configs do not collide', () => {
      const k2 = stateKey({ ...s, config: { ...s.config, catBaseMoves: s.config.catBaseMoves + 1 } });
      expect(k2).not.toBe(k);
    });
  });

  describe('generateLegalSearchActions', () => {
    const s = createInitialState(DEFAULT_CONFIG);

    it('never emits an endTurn action', () => {
      const variants: GameEngineState[] = [
        s,
        { ...s, currentPlayer: PieceType.Cat, catMovesLeft: 4 },
        { ...s, currentPlayer: PieceType.Cat, catMovesLeft: 0 },
        { ...s, phase: GamePhase.ChoosingTunnelExit, tunnelExitChoices: [{ r: 9, c: 9, label: 'a' }, { r: 0, c: 0, label: 'b' }] },
        { ...s, phase: GamePhase.CatWins },
      ];
      for (const v of variants) {
        const acts = generateLegalSearchActions(v, defaultRuleSet);
        expect(acts.some((a) => (a.type as string) === 'endTurn')).toBe(false);
      }
    });

    it('produces only effective (non-no-op) actions at a mouse node', () => {
      const acts = generateLegalSearchActions(s, defaultRuleSet);
      expect(acts.length).toBeGreaterThan(0);
      for (const a of acts) {
        const res = simulateSearchAction(s, a, defaultRuleSet);
        if (res.kind === 'deterministic') {
          expect(gameAffectingEqual(s, res.state)).toBe(false);
        }
      }
    });

    it('emits catStep (no endTurn) while the cat still has moves', () => {
      const catState: GameEngineState = { ...s, currentPlayer: PieceType.Cat, catMovesLeft: 4, phase: GamePhase.Playing };
      const acts = generateLegalSearchActions(catState, defaultRuleSet);
      expect(acts.some((a) => (a.type as string) === 'endTurn')).toBe(false);
      expect(acts.some((a) => a.type === 'catStep')).toBe(true);
    });

    it('after the cat spends its last move, the simulator forces the turn hand-off to the mouse', () => {
      const catState: GameEngineState = { ...s, currentPlayer: PieceType.Cat, catMovesLeft: 1, phase: GamePhase.Playing };
      const acts = generateLegalSearchActions(catState, defaultRuleSet);
      expect(acts.some((a) => a.type === 'catStep')).toBe(true);
      const step = acts.find((a) => a.type === 'catStep')!;
      const res = simulateSearchAction(catState, step, defaultRuleSet);
      expect(resultState(res).currentPlayer).toBe(PieceType.Mouse);
    });

    it('at ChoosingTunnelExit emits only chooseTunnel actions', () => {
      const choosing: GameEngineState = {
        ...s, phase: GamePhase.ChoosingTunnelExit,
        tunnelExitChoices: [{ r: 9, c: 9, label: '↘' }, { r: 9, c: 0, label: '↗' }],
      };
      const acts = generateLegalSearchActions(choosing, defaultRuleSet);
      expect(acts.every((a) => a.type === 'chooseTunnel')).toBe(true);
      expect(acts).toHaveLength(2);
    });

    it('returns no actions at a terminal phase', () => {
      expect(generateLegalSearchActions({ ...s, phase: GamePhase.CatWins }, defaultRuleSet)).toHaveLength(0);
    });
  });

  describe('simulator is engine-free (dependency injection)', () => {
    it('calls only the injected RuleSet, not the real engine', () => {
      const s = createInitialState(DEFAULT_CONFIG);
      const calls: string[] = [];
      const mockRules: RuleSet = {
        mouseStep: (st) => { calls.push('mouseStep'); return st; },
        catMove: (st) => { calls.push('catMove'); return st; },
        mouseSkill: (st) => { calls.push('mouseSkill'); return st; },
        catPlaceTrap: (st) => { calls.push('catPlaceTrap'); return st; },
        chooseTunnelExit: (st) => { calls.push('chooseTunnelExit'); return st; },
        enumerateButterSpawns: () => [],
        endTurn: (st) => { calls.push('endTurn'); return st; },
      };
      simulateSearchAction(s, { type: 'catStep', direction: DIRECTIONS[0] }, mockRules);
      expect(calls).toContain('catMove');
    });
  });

  describe('evaluateForCat (E0 foundation)', () => {
    it('returns a finite heuristic within HEURISTIC_LIMIT for a non-terminal state', () => {
      const s = createInitialState(DEFAULT_CONFIG);
      const v = evaluateForCat(s);
      expect(Number.isFinite(v)).toBe(true);
      expect(Math.abs(v)).toBeLessThanOrEqual(HEURISTIC_LIMIT);
    });
    it('is deterministic (pure) across identical states', () => {
      const s = createInitialState(DEFAULT_CONFIG);
      expect(evaluateForCat(s)).toBe(evaluateForCat(structuredClone(s)));
    });
  });
});
