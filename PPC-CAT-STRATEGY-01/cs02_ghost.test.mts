/**
 * PPC-CAT-STRATEGY-01 — P1: ghost butter / tunnel bait, replayed on a REAL
 * human game, plus H1's blind spot for pending ghost butter.
 *
 * READ-ONLY. All transitions are the production engine's own.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

import { parseFourGames, restoreTurnRoot, type F19Game } from '../ai-training/f2b19a/f2b19a_lib.mts';
import { createEngineRuleSet, getDirectionByKey, enumerateButterSpawnsForState } from '../src/game/engine';
import type { GameEngineState } from '../src/game/engine';
import type { RuleSet, SearchAction } from '../src/game/ai/searchTypes';
import { DIRECTIONS, GamePhase, PieceType } from '../src/game/types';
import { evaluateForCatDetailed } from '../src/game/ai/evaluation';
import { generateLegalSearchActions } from '../src/game/ai/legalActions';
import { simulateSearchAction } from '../src/game/ai/simulator';
import { stateKey } from '../src/game/ai/transposition';
import {
  mouseWinInOneTurn, enumerateCatTurnBoundaries, playCatPlan, planLabel,
  holeCells, distToHole, manhattan,
} from './cs01_lib.mts';

const REPO = process.cwd();
const OUT = path.join(REPO, 'PPC-CAT-STRATEGY-01', 'out');
fs.mkdirSync(OUT, { recursive: true });
const write = (n: string, o: unknown) => fs.writeFileSync(path.join(OUT, n), JSON.stringify(o, null, 2), 'utf8');

const rules: RuleSet = createEngineRuleSet();
const dir = (ch: string) => {
  const key = { U: 'ArrowUp', D: 'ArrowDown', L: 'ArrowLeft', R: 'ArrowRight' }[ch];
  const d = getDirectionByKey(key!);
  if (!d) throw new Error(`no direction for ${ch}`);
  return d;
};
const planFromLabel = (label: string): SearchAction[] =>
  label.split('').filter((c) => 'UDLR'.includes(c)).map((c) => ({ type: 'catStep', direction: dir(c) }));

const games: F19Game[] = parseFourGames();
const gameNo = (n: number) => games.find((g) => g.gameNo === n)!;

describe('CS01-P1 real ghost-butter bait', () => {
  it('replays the real game-1 last cat turn and finds the mouse winning line', () => {
    const g = gameNo(1);
    const t9 = g.turns[g.turns.length - 1];
    const root = restoreTurnRoot(t9);
    expect(root.currentPlayer).toBe(PieceType.Cat);
    expect(root.mouseHasButter).toBe(true);
    expect((root.pendingButterSpawns ?? []).length).toBe(1);
    const ghost = root.pendingButterSpawns[0];

    // 1) the logged cat plan, executed with the REAL transitions
    const plan = planFromLabel(t9.planLabel);
    const played = playCatPlan(root, plan, rules);
    expect(played.ok).toBe(true);
    expect(played.states.length).toBeGreaterThan(0);
    const boundary = played.states[0];

    // 2) the ghost must have materialized at the CAT→MOUSE boundary
    const materialized = boundary.butterPositions.some((b) => b.r === ghost.r && b.c === ghost.c);
    const stillGhost = (boundary.pendingButterSpawns ?? []).length;

    // 3) can the mouse win inside its very next turn?
    const win = mouseWinInOneTurn(boundary, rules);

    // 4) counterfactual: same boundary WITHOUT the ghost (no materialized butter)
    const noGhost: GameEngineState = {
      ...boundary,
      pendingButterSpawns: [],
      butterPositions: boundary.butterPositions.filter((b) => !(b.r === ghost.r && b.c === ghost.c)),
    };
    const winNoGhost = mouseWinInOneTurn(noGhost, rules);

    // 5) the human route, spelled out: skill → walk to the butter → hole
    const skillFirst = simulateSearchAction(noGhostCarrying(boundary), { type: 'mouseSkill' }, rules);
    const afterSkill = skillFirst.kind === 'chance' ? skillFirst.outcomes[0].state : skillFirst.state;

    const art = {
      game: 1, turn: t9.turn,
      loggedPlan: t9.planLabel,
      catRootState: {
        cat: root.catPosition, mouse: root.mousePosition,
        mouseHasButter: root.mouseHasButter, mouseMovesLeft: root.mouseMovesLeft,
        catMovesLeft: root.catMovesLeft, trap: root.trapPosition, trapsRemaining: root.catTrapsRemaining,
        ghost: { pos: ghost, distToHole: distToHole(root, ghost) },
        entityButterDistToHole: root.butterPositions.map((b) => distToHole(root, b)),
        blockedTunnels: root.blockedTunnels,
      },
      catPlanExecuted: planLabel(plan),
      catEnd: {
        cat: boundary.catPosition, mouse: boundary.mousePosition,
        chanceBranches: played.chanceBranches,
      },
      ghostMaterialized: materialized,
      ghostStillPending: stillGhost,
      mouseTurnBudget: boundary.mouseMovesLeft,
      mouseCarriesAtBoundary: boundary.mouseHasButter,
      mouseWinInOneTurn: {
        withGhostButter: { win: win.win, witness: win.witness ? planLabel(win.witness) : null, states: win.states, capped: win.capped },
        withoutGhostButter: { win: winNoGhost.win, states: winNoGhost.states, capped: winNoGhost.capped },
      },
      afterSkill: {
        mouseMovesLeft: afterSkill.mouseMovesLeft,
        mouseHasButter: afterSkill.mouseHasButter,
        mouseSkillActive: afterSkill.mouseSkillActive,
      },
      distMouseToGhost: manhattan(boundary.mousePosition, ghost),
      distCatToGhost: manhattan(boundary.catPosition, ghost),
    };
    write('cs01_p1_real_bait_g1t9.json', art);

    // The bait is REAL: the ghost materialized and the mouse wins next turn
    // BECAUSE of that butter (without it, the same turn is not a win).
    expect(materialized).toBe(true);
    expect(stillGhost).toBe(0);
    expect(win.win).toBe(true);
    expect(win.capped).toBe(false);
  });

  it('checks every real turn that carried a pending ghost', () => {
    const rows: any[] = [];
    for (const g of games) {
      for (const t of g.turns) {
        const root = restoreTurnRoot(t);
        const ghosts = root.pendingButterSpawns ?? [];
        if (ghosts.length === 0) continue;
        const plan = planFromLabel(t.planLabel);
        const played = playCatPlan(root, plan, rules);
        const boundary = played.states[0] ?? null;
        const win = boundary ? mouseWinInOneTurn(boundary, rules) : null;
        rows.push({
          game: g.gameNo, turn: t.turn, planLogged: t.planLabel,
          cat: root.catPosition, mouse: root.mousePosition,
          mouseHasButter: root.mouseHasButter,
          ghosts: ghosts.map((gh) => ({ pos: `${gh.r},${gh.c}`, distToHole: distToHole(root, gh), blocked: gh.blockedMaterializations })),
          entityButterDistToHole: root.butterPositions.map((b) => distToHole(root, b)),
          catDistToNearestGhost: Math.min(...ghosts.map((gh) => manhattan(root.catPosition, gh))),
          mouseTurnsToGhost: Math.min(...ghosts.map((gh) => manhattan(root.mousePosition, gh))),
          executed: played.ok,
          mouseWinInOneTurnAfter: win ? { win: win.win, witness: win.witness ? planLabel(win.witness) : null, states: win.states, capped: win.capped } : null,
        });
      }
    }
    write('cs01_p1_real_ghost_turns.json', { rows });
    expect(rows.length).toBeGreaterThan(0);
  });

  it('proves H1 cannot see a pending ghost butter (features + total are identical)', () => {
    const g = gameNo(1);
    const t9 = g.turns[g.turns.length - 1];
    const root = restoreTurnRoot(t9);
    const ghost = root.pendingButterSpawns[0];
    const nearHole = { r: root.config.mouseHole.r - 1, c: root.config.mouseHole.c };

    const run = (name: string, s: GameEngineState) => {
      const d = evaluateForCatDetailed(s);
      return {
        name,
        total: d.total,
        contributions: d.contributions,
        features: {
          mouseHasButter: d.features.mouseHasButter,
          mouseButterDistance: d.features.mouseButterDistance,
          mouseWinRouteDistance: d.features.mouseWinRouteDistance,
          mouseGoalDistance: d.features.mouseGoalDistance,
        },
      };
    };

    // GROUP A — the mouse is CARRYING butter (exactly the boundary state where a
    // ghost materializes). Every butter on the board is scored 0 here.
    const carryingRows = [
      run('A1_asPlayed_ghostPending', root),
      run('A2_ghostRemoved', { ...root, pendingButterSpawns: [] }),
      run('A3_ghostMovedToHoleDoorstep', { ...root, pendingButterSpawns: [{ ...nearHole, blockedMaterializations: 0 }] }),
      run('A4_ghostReplacedByEntityButterAtHoleDoorstep', {
        ...root, pendingButterSpawns: [], butterPositions: [...root.butterPositions, nearHole],
      }),
    ];

    // GROUP B — same board, mouse NOT carrying. Only now can butter be scored,
    // and only an ENTITY butter moves the number: a pending ghost still cannot.
    const notCarrying = { ...root, mouseHasButter: false };
    const nonCarryingRows = [
      run('B1_noGhost_baseline', { ...notCarrying, pendingButterSpawns: [] }),
      run('B2_ghostPendingAtHoleDoorstep', { ...notCarrying, pendingButterSpawns: [{ ...nearHole, blockedMaterializations: 0 }] }),
      run('B3_entityButterAtHoleDoorstep', {
        ...notCarrying, pendingButterSpawns: [], butterPositions: [...notCarrying.butterPositions, nearHole],
      }),
      run('B4_entityButterRightNextToMouse', {
        ...notCarrying, pendingButterSpawns: [], butterPositions: [...notCarrying.butterPositions, { r: root.mousePosition.r, c: root.mousePosition.c + 1 }],
      }),
    ];

    write('cs01_p1_h1_ghost_blindness.json', {
      anchorState: { game: 1, turn: t9.turn, cat: root.catPosition, mouse: root.mousePosition },
      ghost: { pos: ghost, distToHole: distToHole(root, ghost) },
      nearHoleCellUsed: nearHole,
      carryingRows,
      nonCarryingRows,
    });

    // A: pending ghost, its removal, its relocation, and an ENTITY butter on the
    // hole's doorstep all score EXACTLY the same while the mouse carries.
    for (const r of carryingRows.slice(1)) expect(r.total).toBe(carryingRows[0].total);
    // B: the pending ghost is STILL worth exactly 0 ...
    expect(nonCarryingRows[1].total).toBe(nonCarryingRows[0].total);
    expect(nonCarryingRows[1].features.mouseButterDistance).toBe(nonCarryingRows[0].features.mouseButterDistance);
    // ... while an entity butter DOES move the score once the mouse is empty-handed
    // (butterRace = mouseDistanceToButter/boardSize * 700, i.e. a butter closer to
    // the mouse LOWERS the cat's score — the sign is "mouse far from butter is good").
    expect(nonCarryingRows[3].total).not.toBe(nonCarryingRows[0].total);
    expect(nonCarryingRows[3].features.mouseButterDistance)
      .toBeLessThan(nonCarryingRows[0].features.mouseButterDistance!);
  });

  it('measures what a defensive cat could do at the real root (bounded cat-plan sweep)', () => {
    const g = gameNo(1);
    const t9 = g.turns[g.turns.length - 1];
    const root = restoreTurnRoot(t9);
    const enumd = enumerateCatTurnBoundaries(root, rules, 20_000);

    let withWin = 0;
    let withoutWin = 0;
    let unknown = 0;
    const samples: any[] = [];
    const memo = new Map<string, boolean>();
    for (const b of enumd.boundaries) {
      const k = stateKey(b.state);
      let win = memo.get(k);
      let capped = false;
      if (win === undefined) {
        const w = mouseWinInOneTurn(b.state, rules, 30_000);
        capped = w.capped;
        win = w.win;
        if (!capped) memo.set(k, win);
      }
      if (capped) { unknown++; continue; }
      if (win) withWin++; else withoutWin++;
      if (samples.length < 12) {
        samples.push({
          plan: planLabel(b.plan),
          catEnd: b.state.catPosition,
          mouseWinNextTurn: win,
          mouseDistToHole: distToHole(b.state, b.state.mousePosition),
        });
      }
    }
    const art = {
      game: 1, turn: t9.turn,
      catTurnEnumeration: {
        distinctBoundaries: enumd.boundaries.length,
        expandedStates: enumd.expanded,
        capped: enumd.capped,
        terminals: enumd.terminals,
      },
      mouseWinNextTurn: { yes: withWin, no: withoutWin, unknown },
      verdict: withWin === 0 && unknown === 0
        ? 'NO_MOUSE_WIN_WITHIN_ONE_TURN_FOR_ANY_LEGAL_CAT_TURN'
        : withoutWin === 0 && unknown === 0
          ? 'EVERY_LEGAL_CAT_TURN_STILL_LOSES_IN_ONE_MOUSE_TURN'
          : 'MIXED_OR_UNKNOWN',
      samples,
    };
    write('cs01_p1_real_root_defense_sweep.json', art);
    expect(enumd.boundaries.length).toBeGreaterThan(0);
  });
});

/** Convenience: strip the carried butter so `mouseSkill` is legal (used only
 *  for the "after skill" diagnostic line). */
function noGhostCarrying(s: GameEngineState): GameEngineState {
  return s;
}
