/// <reference types="node" />
/**
 * G3-b — isolated rule-mechanism tests on the REAL RuleSet.
 *
 * The brief asks for isolated checks of each mechanism the two-turn quantifier
 * depends on. These are NOT new proofs: every case drives the production
 * engine (mouseStepDeterministic / mouseSkill / catPlaceTrap / endTurn /
 * resolveGhostBoundaryCore / enumerateGhost*Outcomes) and asserts the exact
 * rule text in GAMEPLAY.md. No rule is modified to fit the shadow algorithm.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { restoreHardRoot } from '../../src/game/ai/hardHistory';
import {
  catPlaceTrap,
  enumerateButterSpawnsForState,
  enumerateGhostAnnouncementOutcomes,
  enumerateGhostBoundaryOutcomes,
  mouseSkill,
  mouseStepDeterministic,
  resolveGhostBoundaryCore,
} from '../../src/game/engine';
import { DIRECTIONS } from '../../src/game/types';
import type { GameEngineState } from '../../src/game/engine';

const FIXTURE = 'src/game/ai/__tests__/fixtures/ppcId01-human-roots.json';
const LOG = 'PPC-TWO-TURN-ORACLE-SEAL-AND-COST-01/logs';
const records = JSON.parse(readFileSync(FIXTURE).toString('utf8')) as { id: string; state: unknown }[];
const base = restoreHardRoot(records.find((r) => r.id === 'G6T2')!.state as never);

const [UP, DOWN, LEFT, RIGHT] = DIRECTIONS;
type Pt = { r: number; c: number };

const clone = (s: GameEngineState): GameEngineState => JSON.parse(JSON.stringify(s)) as GameEngineState;

/** Start from the real G6T2 terrain with a clean tactical slate (no invented mechanics). */
function fresh(): GameEngineState {
  const s = clone(base);
  s.board = s.board.map((row) => row.map((cell) => ({ ...cell, piece: undefined })));
  s.board[3][3].piece = 'cat';
  s.board[1][6].piece = 'mouse';
  s.phase = 'playing';
  s.currentPlayer = 'mouse';
  s.catPosition = { r: 3, c: 3 };
  s.mousePosition = { r: 1, c: 6 };
  s.catMovesLeft = 0;
  s.mouseMovesLeft = 4;
  s.mouseHasButter = false;
  s.mouseSkillActive = false;
  s.butterPositions = [];
  s.pendingButterSpawns = [];
  s.pendingButterPlacementDebt = 0;
  s.trapPosition = null;
  s.catTrapsRemaining = 1;
  s.blockedTunnels = [];
  s.tunnelExitChoices = [];
  return s;
}

function putMouse(s: GameEngineState, to: Pt) {
  if (s.mousePosition) s.board[s.mousePosition.r][s.mousePosition.c].piece = undefined;
  s.mousePosition = { ...to };
  s.board[to.r][to.c].piece = 'mouse';
}

function putCat(s: GameEngineState, to: Pt) {
  if (s.catPosition) s.board[s.catPosition.r][s.catPosition.c].piece = undefined;
  s.catPosition = { ...to };
  s.board[to.r][to.c].piece = 'cat';
}

const samePos = (a: Pt, b: Pt) => a.r === b.r && a.c === b.c;

describe('G3-b isolated rule mechanisms (real RuleSet)', () => {
  const cases: Record<string, unknown> = {};

  it('butter pickup: carrying flips on, butter leaves the board, exactly one move is spent', () => {
    const s = fresh();
    s.butterPositions = [{ r: 1, c: 7 }];
    const out = mouseStepDeterministic(s, RIGHT);
    expect(out.mouseHasButter).toBe(true);
    expect(out.butterPositions).toEqual([]);
    expect(samePos(out.mousePosition, { r: 1, c: 7 })).toBe(true);
    expect(out.mouseMovesLeft).toBe(3);
    cases.butterPickup = {
      hasButterAfter: out.mouseHasButter,
      butterLeft: out.butterPositions.length,
      movesSpent: 4 - out.mouseMovesLeft,
      catMovesLeftUnchanged: out.catMovesLeft,
    };
  });

  it('butter consume (skill): +mouseSkillExtraMoves moves, butter removed, tunnel unlocked', () => {
    const s = fresh();
    s.mouseHasButter = true;
    s.mouseMovesLeft = 2;
    const out = mouseSkill(s);
    expect(out.mouseHasButter).toBe(false);
    expect(out.mouseSkillActive).toBe(true);
    expect(out.mouseMovesLeft).toBe(2 + s.config.mouseSkillExtraMoves);
    expect(s.config.mouseSkillExtraMoves).toBe(3);
    cases.butterConsumeSkill = {
      movesBefore: 2,
      movesAfter: out.mouseMovesLeft,
      extra: s.config.mouseSkillExtraMoves,
      skillActive: out.mouseSkillActive,
    };
  });

  it('carrying butter cannot enter a tunnel', () => {
    const s = fresh();
    putMouse(s, { r: 1, c: 0 });
    s.mouseHasButter = true;
    const out = mouseStepDeterministic(s, UP);
    expect(samePos(out.mousePosition, { r: 1, c: 0 })).toBe(true);
    expect(out.mouseMovesLeft).toBe(4);
    expect(out.mouseHasButter).toBe(true);
    expect(out.phase).toBe('playing');
    cases.tunnelWithButter = { moved: false, movesUnchanged: out.mouseMovesLeft };
  });

  it('after consuming butter (skill state) the tunnel IS enterable', () => {
    const s = fresh();
    putMouse(s, { r: 1, c: 0 });
    s.mouseSkillActive = true;
    const out = mouseStepDeterministic(s, UP);
    expect(out.phase).toBe('choosing_tunnel_exit');
    expect(out.tunnelExitChoices.length).toBeGreaterThan(0);
    cases.tunnelInSkillState = {
      phase: out.phase,
      exits: out.tunnelExitChoices.length,
    };
  });

  it('mouse in skill state entering the hole WITHOUT butter does not win', () => {
    const s = fresh();
    putMouse(s, { r: 7, c: 7 });
    s.mouseSkillActive = true;
    s.mouseMovesLeft = 3;
    const out = mouseStepDeterministic(s, RIGHT);
    expect(samePos(out.mousePosition, { r: 7, c: 8 })).toBe(true);
    expect(out.phase).toBe('playing');
    expect(out.phase).not.toBe('mouse_wins');
    expect(out.mouseMovesLeft).toBe(2);
    cases.holeWithoutButter = { phase: out.phase, movesLeft: out.mouseMovesLeft };
  });

  it('cat trap placement costs ZERO moves (GAMEPLAY §4.3)', () => {
    const s = fresh();
    s.currentPlayer = 'cat';
    s.catMovesLeft = 3;
    s.trapPosition = null;
    s.catTrapsRemaining = 1;
    const out = catPlaceTrap(s);
    expect(out.catMovesLeft).toBe(3);
    expect(out.trapPosition).toEqual({ r: 3, c: 3 });
    expect(out.catTrapsRemaining).toBe(0);
    expect(out.phase).toBe('playing');
    cases.catPlaceTrap = {
      movesBefore: 3,
      movesAfter: out.catMovesLeft,
      trapAt: out.trapPosition,
      trapsRemaining: out.catTrapsRemaining,
    };
  });

  it('normal handoff: mouse spending its last move hands off to a cat with a fresh budget', () => {
    const s = fresh();
    s.mouseMovesLeft = 1;
    const out = mouseStepDeterministic(s, LEFT);
    expect(out.currentPlayer).toBe('cat');
    expect(out.catMovesLeft).toBe(s.config.catBaseMoves);
    expect(out.mouseSkillActive).toBe(false);
    expect(out.phase).toBe('playing');
    cases.normalHandoff = {
      nextPlayer: out.currentPlayer,
      catMoves: out.catMovesLeft,
      mouseSkillReset: !out.mouseSkillActive,
    };
  });

  it('ghost announcement: at least one uniform outcome, one pending ghost each; no candidate → debt +1', () => {
    const s = fresh();
    const outcomes = enumerateGhostAnnouncementOutcomes(s);
    expect(outcomes.length).toBeGreaterThan(0);
    const sum = outcomes.reduce((a, o) => a + o.weight, 0);
    expect(Math.abs(sum - 1)).toBeLessThan(1e-12);
    for (const o of outcomes) expect(o.state.pendingButterSpawns.length).toBe(1);

    const s2 = fresh();
    s2.butterPositions = enumerateButterSpawnsForState(s2);
    const none = enumerateGhostAnnouncementOutcomes(s2);
    expect(none.length).toBe(1);
    expect(none[0].weight).toBe(1);
    expect(none[0].state.pendingButterPlacementDebt).toBe(1);
    cases.ghostAnnouncement = {
      outcomes: outcomes.length,
      uniformWeight: outcomes[0].weight,
      pendingEach: outcomes[0].state.pendingButterSpawns.length,
      noCandidate: { outcomes: none.length, debt: none[0].state.pendingButterPlacementDebt },
    };
  });

  it('ghost boundary: materialize, delay once when blocked, reroll on the second block', () => {
    const s = fresh();
    s.currentPlayer = 'cat';
    s.pendingButterSpawns = [{ r: 1, c: 7, blockedMaterializations: 0 }];
    const mat = resolveGhostBoundaryCore(s);
    expect(mat.state.butterPositions).toEqual([{ r: 1, c: 7 }]);
    expect(mat.state.pendingButterSpawns).toEqual([]);
    expect(mat.ghostPlacements).toBe(0);
    expect(mat.state.currentPlayer).toBe('mouse');

    const d1 = fresh();
    d1.currentPlayer = 'cat';
    d1.pendingButterSpawns = [{ r: 2, c: 4, blockedMaterializations: 0 }]; // a box cell
    const delay = resolveGhostBoundaryCore(d1);
    expect(delay.state.butterPositions).toEqual([]);
    expect(delay.state.pendingButterSpawns).toEqual([{ r: 2, c: 4, blockedMaterializations: 1 }]);
    expect(delay.ghostPlacements).toBe(0);

    const d2 = fresh();
    d2.currentPlayer = 'cat';
    d2.pendingButterSpawns = [{ r: 2, c: 4, blockedMaterializations: 1 }];
    const reroll = resolveGhostBoundaryCore(d2);
    expect(reroll.ghostPlacements).toBe(1);
    expect(reroll.state.pendingButterSpawns).toEqual([]);
    const boundary = enumerateGhostBoundaryOutcomes(d2);
    expect(boundary.length).toBeGreaterThan(0);
    expect(Math.abs(boundary.reduce((a, o) => a + o.weight, 0) - 1)).toBeLessThan(1e-12);

    cases.ghostBoundary = {
      materialize: { butter: mat.state.butterPositions, pending: mat.state.pendingButterSpawns.length },
      blockedOnce: delay.state.pendingButterSpawns,
      rerollPlacements: reroll.ghostPlacements,
      rerollBoundaryOutcomes: boundary.length,
    };
  });

  it('pending placement debt is preserved one-for-one when no candidate is legal', () => {
    const s = fresh();
    s.currentPlayer = 'cat';
    s.pendingButterPlacementDebt = 1;
    s.butterPositions = enumerateButterSpawnsForState(s);
    const outcomes = enumerateGhostBoundaryOutcomes(s);
    expect(outcomes.length).toBe(1);
    expect(outcomes[0].weight).toBe(1);
    expect(outcomes[0].state.pendingButterPlacementDebt).toBe(1);
    cases.pendingDebt = {
      outcomes: outcomes.length,
      debt: outcomes[0].state.pendingButterPlacementDebt,
    };
  });

  it('writes the isolation log', () => {
    mkdirSync(LOG, { recursive: true });
    writeFileSync(`${LOG}/g3_rule_isolation.json`, JSON.stringify({
      round: 'PPC-TWO-TURN-ORACLE-SEAL-AND-COST-01',
      instrument: 'real RuleSet: mouseStepDeterministic / mouseSkill / catPlaceTrap / resolveGhostBoundaryCore / enumerateGhost*Outcomes',
      terrain: 'real G6T2 map from ppcId01-human-roots.json; only piece/butter/trap placements are set by the test',
      cases,
      notObservable: {
        zeroWeightChanceOutcome:
          'No zero-weight outcome was produced or reached (40k-state scan: zeroWeightOutcomesSeen=0); the kernel still filters weight<=0 by source.',
        mixedVerdictChanceOutcomes:
          'No reachable CHANCE node was observed whose positive-probability outcomes disagree in verdict; the AND coverage is instead demonstrated by rejecting a one-branch certificate (QUANTIFIER_COUNTEREXAMPLES.json).',
      },
    }, null, 2));
    expect(Object.keys(cases).length).toBeGreaterThanOrEqual(9);
  });
});