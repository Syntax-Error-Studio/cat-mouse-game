/**
 * PPC-CAT-STRATEGY-01 — P0/P1/P3 real-log forensics (PART 1 of the probe).
 *
 * READ-ONLY with respect to the product: imports production + frozen research
 * modules, mutates nothing. Every number written to out/ is measured here.
 *
 * Source of truth = the four 2026-09-03 REAL human logs already frozen under
 * ai-training/f2b19a/ (H1 + M3-lite, all four games ended in mouse_wins).
 * They contain one authoritative SNAPSHOT_JSON per CAT turn, so we can measure
 * trap lifetime, ghost-butter timing and tunnel jumps without replaying.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

import { parseFourGames, type F19Game, type F19Turn } from '../ai-training/f2b19a/f2b19a_lib.mts';
import { restoreHardRoot } from '../src/game/ai/hardHistory';
import type { GameEngineState } from '../src/game/engine';
import { evaluateForCatDetailed } from '../src/game/ai/evaluation';
import { PieceType } from '../src/game/types';

const REPO = process.cwd();
if (!fs.existsSync(path.join(REPO, 'src', 'game', 'engine.ts'))) {
  throw new Error(`probe must run from the repository root, got cwd=${REPO}`);
}
const OUT = path.join(REPO, 'PPC-CAT-STRATEGY-01', 'out');
fs.mkdirSync(OUT, { recursive: true });

const write = (name: string, obj: unknown) => {
  fs.writeFileSync(path.join(OUT, name), JSON.stringify(obj, null, 2), 'utf8');
};

function holeCells(s: GameEngineState): { r: number; c: number }[] {
  const out: { r: number; c: number }[] = [];
  const { r, c, size } = s.config.mouseHole;
  for (let dr = 0; dr < size; dr++) for (let dc = 0; dc < size; dc++) out.push({ r: r + dr, c: c + dc });
  return out;
}
function distToHole(s: GameEngineState, p: { r: number; c: number }): number {
  return Math.min(...holeCells(s).map((h) => Math.abs(h.r - p.r) + Math.abs(h.c - p.c)));
}
const manhattan = (a: { r: number; c: number }, b: { r: number; c: number }) =>
  Math.abs(a.r - b.r) + Math.abs(a.c - b.c);

function rootOf(t: F19Turn): GameEngineState {
  return restoreHardRoot(JSON.parse(t.snapshotJson));
}

describe('CS01-P0 real human logs', () => {
  const games = parseFourGames();

  it('enumerates the frozen real games and their per-turn trap/ghost facts', () => {
    expect(games.length).toBe(4);
    const report: any = { source: 'ai-training/f2b19a/log_game{A,B,C,D}.txt', games: [] };

    for (const g of games) {
      const turns = g.turns;
      // first cat turn whose root already carries a placed trap
      const firstTrapIdx = turns.findIndex((t) => t.trap !== null);
      const firstTrapTurn = firstTrapIdx >= 0 ? turns[firstTrapIdx].turn : null;
      const trapAtStart = firstTrapIdx >= 0
        ? (turns[firstTrapIdx].trap!.r === 1 && turns[firstTrapIdx].trap!.c === 1)
        : null;

      // A trap that never moves and never disappears is a trap the mouse never
      // stepped on and the cat never reclaimed: it was spent for nothing.
      const trapTrace = turns.map((t) => (t.trap ? `${t.trap.r},${t.trap.c}` : '-'));
      const distinctTrapCells = [...new Set(trapTrace.filter((x) => x !== '-'))];

      const perTurn = turns.map((t) => {
        const s = rootOf(t);
        const ghosts = s.pendingButterSpawns ?? [];
        const ghostInfo = ghosts.map((gh) => ({
          pos: `${gh.r},${gh.c}`,
          distToHole: distToHole(s, gh),
          blocked: gh.blockedMaterializations,
        }));
        const feat = evaluateForCatDetailed(s);
        return {
          turn: t.turn,
          cat: `${t.cat.r},${t.cat.c}`,
          mouse: `${t.mouse.r},${t.mouse.c}`,
          mouseManhattanToHole: distToHole(s, t.mouse),
          butter: t.butter,
          skill: t.skill,
          mouseMoves: t.mouseMoves,
          catMoves: t.catMoves,
          trap: t.trap ? `${t.trap.r},${t.trap.c}` : null,
          trapRemain: t.trapRemain,
          ghosts: ghostInfo,
          placementDebt: s.pendingButterPlacementDebt ?? 0,
          blockedTunnels: (s.blockedTunnels ?? []).map((b) => `${b.r},${b.c}`),
          entityButterDistToHole: (s.butterPositions ?? []).map((b) => distToHole(s, b)),
          planLabel: t.planLabel,
          cDepth: t.search.cDepth,
          nodes: t.search.nodes,
          elapsedMs: t.search.elapsedMs,
          // H1 sees GHOST butter at all?
          h1MouseButterDistance: feat.features.mouseButterDistance,
          h1MouseWinRouteDistance: feat.features.mouseWinRouteDistance,
          h1TrapControl: feat.contributions.trapControl,
          h1TunnelControl: feat.contributions.tunnelControl,
          h1Total: feat.total,
          // does the plan spend a trap?
          planHasTrap: t.planLabel.includes('T'),
        };
      });

      // Tunnel jump detection: the mouse can never travel more than its own
      // move budget in Manhattan steps within one mouse turn unless it
      // teleported through a tunnel corner.
      const jumps: any[] = [];
      for (let i = 1; i < turns.length; i++) {
        const prev = rootOf(turns[i - 1]);
        const cur = rootOf(turns[i]);
        const d = manhattan(prev.mousePosition, cur.mousePosition);
        const budget = prev.mouseHasButter ? prev.config.mouseCarryingMoves : prev.config.mouseBaseMoves;
        const cornerStart = prev.board[prev.mousePosition.r][prev.mousePosition.c].type === 'tunnel'
          || cur.board[cur.mousePosition.r][cur.mousePosition.c].type === 'tunnel';
        if (d > budget + 1) {
          jumps.push({
            fromTurn: turns[i - 1].turn, toTurn: turns[i].turn,
            prevMouse: prev.mousePosition, curMouse: cur.mousePosition,
            manhattan: d, mouseBudgetPlusCat: budget, atTunnelCorner: cornerStart,
            teleportImplied: d > budget,
          });
        }
      }

      report.games.push({
        file: path.basename(g.file), gameNo: g.gameNo, result: g.result, hardLeaf: g.hardLeaf,
        turns: turns.length,
        firstTrapTurn, trapAtCatStart: trapAtStart,
        distinctTrapCells, trapTrace,
        trapsRemainingAtEnd: turns[turns.length - 1].trapRemain,
        finalPhase: g.finalState.phase,
        jumps,
        perTurn,
      });
    }

    // Every real game ended with the mouse winning: this is the real baseline.
    expect(report.games.every((g: any) => g.finalPhase === 'mouse_wins')).toBe(true);
    write('cs01_real_log_forensics.json', report);
  });

  it('quantifies the trap resource lifetime across the four games', () => {
    const rows: any[] = [];
    for (const g of games) {
      const turns = g.turns;
      const firstIdx = turns.findIndex((t) => t.trap !== null);
      const cells = [...new Set(turns.map((t) => (t.trap ? `${t.trap.r},${t.trap.c}` : '-')).filter((x) => x !== '-'))];
      // How many cat turns elapsed between the cat's first placement and the
      // mouse win (i.e. how long the spent trap sat on the board unused).
      rows.push({
        game: g.gameNo,
        turns: turns.length,
        firstTrapTurn: firstIdx >= 0 ? turns[firstIdx].turn : null,
        firstTrapCell: firstIdx >= 0 ? `${turns[firstIdx].trap!.r},${turns[firstIdx].trap!.c}` : null,
        distinctTrapCells: cells,
        turnsWithTrapOnBoard: turns.filter((t) => t.trap !== null).length,
        turnsWithTrapRemaining: turns.filter((t) => t.trapRemain > 0).length,
        planTurnsContainsT: turns.filter((t) => t.planLabel.includes('T')).map((t) => t.turn),
        blocksByPush: turns.some((t) => (rootOf(t).blockedTunnels ?? []).length > 0),
        ghostTurns: turns.filter((t) => (rootOf(t).pendingButterSpawns ?? []).length > 0)
          .map((t) => ({ turn: t.turn, miceCarries: t.butter, ghosts: (rootOf(t).pendingButterSpawns ?? []).length })),
      });
    }
    write('cs01_real_trap_lifetime.json', { rows });
    expect(rows.length).toBe(4);
  });
});
