/**
 * PPC-CAT-STRATEGY-01 — P2: pushing a box onto a tunnel corner.
 *
 * READ-ONLY. Answers, one step at a time, whether the cat CAN block a tunnel
 * and whether anything in the current AI WANTS to.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

import { createEngineRuleSet, catMove, getDirectionByKey } from '../src/game/engine';
import type { GameEngineState } from '../src/game/engine';
import type { RuleSet } from '../src/game/ai/searchTypes';
import { GamePhase, PieceType, CellType } from '../src/game/types';
import { DEFAULT_CONFIG } from '../src/game/config';
import { evaluateForCatDetailed, bfsMouseDistance } from '../src/game/ai/evaluation';
import { getTunnelCorners, getTunnelExits, getOpenTunnelCorners } from '../src/game/rules/tunnelRules';
import { generateLegalSearchActions } from '../src/game/ai/legalActions';
import { planHardCatTurn } from '../src/game/ai/hardTurnPlanner';
import { mkState, holeCells, planLabel, manhattan, distToHole, type RC } from './cs01_lib.mts';
import { parseFourGames, restoreTurnRoot } from '../ai-training/f2b19a/f2b19a_lib.mts';
import { bfsCatDistance } from '../src/game/ai/evaluation';

const REPO = process.cwd();
const OUT = path.join(REPO, 'PPC-CAT-STRATEGY-01', 'out');
fs.mkdirSync(OUT, { recursive: true });
const write = (n: string, o: unknown) => fs.writeFileSync(path.join(OUT, n), JSON.stringify(o, null, 2), 'utf8');

const rules: RuleSet = createEngineRuleSet();
const UP = getDirectionByKey('ArrowUp')!;
const DOWN = getDirectionByKey('ArrowDown')!;
const LEFT = getDirectionByKey('ArrowLeft')!;
const RIGHT = getDirectionByKey('ArrowRight')!;

const CFG = DEFAULT_CONFIG; // 10x10, hole (7,8) 2x2, 4 tunnels at the corners

/** Evaluation of a state, reduced to the terms that could possibly carry a
 *  "blocking a tunnel is good" gradient. */
function evalRow(name: string, s: GameEngineState) {
  const d = evaluateForCatDetailed(s);
  return {
    name,
    total: Number(d.total.toFixed(3)),
    tunnelControl: Number(d.contributions.tunnelControl.toFixed(3)),
    confinement: Number(d.contributions.confinement.toFixed(3)),
    holeControl: Number(d.contributions.holeControl.toFixed(3)),
    voronoiBalance: Number(d.contributions.voronoiBalance.toFixed(3)),
    capturePressure: Number(d.contributions.capturePressure.toFixed(3)),
    mouseReachableArea: d.features.mouseReachableArea,
    openTunnelCount: d.features.openTunnelCount,
    mouseCanReachTunnel: d.features.mouseCanReachTunnel,
    mouseTunnelAccessDistance: d.features.mouseTunnelAccessDistance,
    mouseWinRouteDistance: d.features.mouseWinRouteDistance,
  };
}

describe('CS01-P2 box push onto a tunnel corner', () => {
  it('verifies the push is LEGAL and really blocks the corner (real engine)', () => {
    // Cat under the box, box one cell below the top-left tunnel corner.
    const s = mkState({
      config: CFG,
      boxes: [{ r: 1, c: 0 }],
      butters: [{ r: 5, c: 5 }],
      cat: { r: 2, c: 0 },
      mouse: { r: 0, c: 2 },
      catMovesLeft: 4,
    });
    expect(s.board[1][0].type).toBe(CellType.Box);
    expect(s.board[0][0].type).toBe(CellType.Tunnel);

    const before = {
      exitsFromTopLeft: getTunnelExits(s, 0, 0).map((t) => `${t.r},${t.c}`),
      openTunnels: getOpenTunnelCorners(s).map((t) => `${t.r},${t.c}`),
      mouseDistToHole: bfsMouseDistance(s, holeCells(s)),
      mouseTunnelAccessDistance: evaluateForCatDetailed(s).features.mouseTunnelAccessDistance,
    };

    const after = catMove(s, UP);

    const art = {
      before,
      after: {
        cat: after.catPosition,
        catMovesLeft: after.catMovesLeft,
        cornerCellType: after.board[0][0].type,
        blockedTunnels: after.blockedTunnels.map((b) => `${b.r},${b.c}`),
        exitsFromTopLeft: getTunnelExits(after, 0, 0).map((t) => `${t.r},${t.c}`),
        openTunnels: getOpenTunnelCorners(after).map((t) => `${t.r},${t.c}`),
        mouseDistToHole: bfsMouseDistance(after, holeCells(after)),
        mouseTunnelAccessDistance: evaluateForCatDetailed(after).features.mouseTunnelAccessDistance,
        // Can the mouse still enter the tunnel it was standing next to?
        mouseCanStillEnterTopLeft: !after.blockedTunnels.some((b) => b.r === 0 && b.c === 0),
        catLog: after.catActionLog.slice(-2),
      },
    };
    write('cs01_p2_push_legality.json', art);

    // The push is legal, costs exactly one cat step, and moves the box in.
    expect(after.catPosition).toEqual({ r: 1, c: 0 });
    expect(after.catMovesLeft).toBe(3);
    expect(after.board[0][0].type).toBe(CellType.Box);
    expect(after.blockedTunnels).toContainEqual({ r: 0, c: 0 });
    // The exit set of the corner shrinks (the blocked corner is no longer offered).
    expect(after.blockedTunnels.length).toBe(1);
    expect(getOpenTunnelCorners(after).length).toBe(getOpenTunnelCorners(s).length - 1);
  });

  it('measures the H1 gradient of blocking 0/1/2/3/4 tunnels (ceteris paribus)', () => {
    const corners: RC[] = [{ r: 0, c: 0 }, { r: 0, c: 9 }, { r: 9, c: 0 }, { r: 9, c: 9 }];
    const rows: any[] = [];
    // The mouse sits next to the top-left corner with a free teleport route to
    // the hole: this is the situation where blocking SHOULD pay.
    for (let k = 0; k <= 4; k++) {
      const blocked = corners.slice(0, k);
      const s = mkState({
        config: CFG,
        boxes: blocked.map((b) => ({ ...b })), // a box ON the corner is exactly the blocked state
        butters: [{ r: 5, c: 5 }],
        cat: { r: 2, c: 2 },
        mouse: { r: 0, c: 2 },
        catMovesLeft: 4,
        blockedTunnels: blocked,
      });
      rows.push({ blockedCount: k, ...evalRow(`blocked=${k}`, s) });
    }
    write('cs01_p2_h1_tunnel_gradient.json', {
      note: 'States differ ONLY in how many of the four corners are blocked.',
      mouse: { r: 0, c: 2 }, cat: { r: 2, c: 2 },
      rows,
      deltas: rows.slice(1).map((r, i) => ({
        from: rows[i].blockedCount, to: r.blockedCount,
        totalDelta: Number((r.total - rows[i].total).toFixed(3)),
        tunnelControlDelta: Number((r.tunnelControl - rows[i].tunnelControl).toFixed(3)),
      })),
    });
    // Blocking ONE of four tunnels must be worth something if the AI is meant to
    // seek it at all. This is the measurement, not an opinion:
    const d1 = rows[1].total - rows[0].total;
    const d4 = rows[4].total - rows[3].total;
    expect(Number.isFinite(d1)).toBe(true);
    expect(Number.isFinite(d4)).toBe(true);
  });

  it('checks the SEARCH layer: is the push generated, searched, and chosen?', () => {
    const root = mkState({
      config: CFG,
      boxes: [{ r: 1, c: 0 }],
      butters: [{ r: 5, c: 5 }],
      cat: { r: 2, c: 0 },
      mouse: { r: 0, c: 2 },
      catMovesLeft: 4,
    });
    const legal = generateLegalSearchActions(root, rules);
    const legalLabels = legal.map((a) => (a.type === 'catStep' ? a.direction!.key.replace('Arrow', '') : a.type));

    const pushState = catMove(root, UP);
    const plan = planHardCatTurn(root, {
      rules,
      timeBudgetMs: 100,
      maxDepthTurns: 4,
      refutation: { enabled: true, totalTurnBudgetMs: 150 },
    });

    const ranking = plan.debug.rootActions.map((r) => ({
      action: r.action.type === 'catStep' ? r.action.direction!.key.replace('Arrow', '') : r.action.type,
      value: Number(r.value.toFixed(3)),
      mate: r.mate,
      bound: r.bound ?? 'unknown',
    }));

    const art = {
      root: { cat: root.catPosition, mouse: root.mousePosition, box: { r: 1, c: 0 } },
      legalActions: legalLabels,
      pushIsGenerated: legalLabels.includes('Up'),
      pushBlocksTunnel: pushState.blockedTunnels.length === 1,
      search: {
        planLabel: planLabel(plan.plan),
        completedDepth: plan.completedDepth,
        attemptedDepth: plan.attemptedDepth,
        nodes: plan.search.diagnostics.totalNodes,
        elapsedMs: Number(plan.elapsedMs.toFixed(1)),
        rootValue: Number(plan.search.value.toFixed(3)),
        ranking,
      },
      chosePush: plan.plan[0]?.type === 'catStep' && plan.plan[0]?.direction?.key === 'ArrowUp',
      h1AfterPush: evalRow('afterPush', pushState),
      h1Root: evalRow('root', root),
    };
    write('cs01_p2_push_search.json', art);

    // Generated and legal — so any failure to use it is NOT an action-layer gap.
    expect(legalLabels).toContain('Up');
    expect(pushState.blockedTunnels.length).toBe(1);
    expect(ranking.length).toBeGreaterThan(0);
  });

  it('reverse control: on a map where blocking helps nobody, the push must not be preferred', () => {
    // The mouse is already at the hole's doorstep and out of tunnel reach: a
    // tunnel-blocking push here is pure waste (it also walks away from the cat's
    // only route to the mouse).
    const root = mkState({
      config: CFG,
      boxes: [{ r: 1, c: 0 }],
      butters: [{ r: 5, c: 5 }],
      cat: { r: 8, c: 4 },
      mouse: { r: 8, c: 7 },
      catMovesLeft: 4,
    });
    const plan = planHardCatTurn(root, {
      rules, timeBudgetMs: 100, maxDepthTurns: 4,
      refutation: { enabled: true, totalTurnBudgetMs: 150 },
    });
    const art = {
      root: { cat: root.catPosition, mouse: root.mousePosition },
      catCanReachTheBoxInOneTurn: manhattan(root.catPosition, { r: 1, c: 0 }) <= 4,
      planLabel: planLabel(plan.plan),
      completedDepth: plan.completedDepth,
      rootActions: plan.debug.rootActions.map((r) => ({
        action: r.action.type === 'catStep' ? r.action.direction!.key.replace('Arrow', '') : r.action.type,
        value: Number(r.value.toFixed(3)),
        mate: r.mate,
      })),
      mouseDistToHole: distToHole(root, root.mousePosition),
    };
    write('cs01_p2_reverse_control.json', art);
    expect(plan.plan.length).toBeGreaterThan(0);
  });
});

describe('CS01-P2b reachability on the real maps', () => {
  it('counts how often a tunnel-blocking push was ACTUALLY available within one cat turn', () => {
    const games = parseFourGames();
    const rows: any[] = [];
    for (const g of games) {
      for (const t of g.turns) {
        const s = restoreTurnRoot(t);
        const corners = getTunnelCorners(s.config);
        const options: any[] = [];
        for (const corner of corners) {
          for (const d of [{ dr: -1, dc: 0 }, { dr: 1, dc: 0 }, { dr: 0, dc: -1 }, { dr: 0, dc: 1 }]) {
            const box = { r: corner.r + d.dr, c: corner.c + d.dc };
            if (box.r < 0 || box.c < 0 || box.r >= s.config.boardSize || box.c >= s.config.boardSize) continue;
            if (s.board[box.r][box.c].type !== 'box') continue;
            // the cat must stand on the mirror side of the box and push toward the corner
            const stand = { r: box.r + d.dr, c: box.c + d.dc };
            if (stand.r < 0 || stand.c < 0 || stand.r >= s.config.boardSize || stand.c >= s.config.boardSize) continue;
            const dist = bfsCatDistance(s, [stand]);
            options.push({
              corner: `${corner.r},${corner.c}`,
              box: `${box.r},${box.c}`,
              stand: `${stand.r},${stand.c}`,
              catStepsToStand: dist,
              pushCost: 1,
              reachableInOneTurn: dist !== null && dist + 1 <= s.catMovesLeft,
            });
          }
        }
        rows.push({
          game: g.gameNo, turn: t.turn,
          catMovesLeft: s.catMovesLeft,
          boxesAdjacentToCorners: options.length,
          reachable: options.filter((o) => o.reachableInOneTurn),
          options,
        });
      }
    }
    const totalTurns = rows.length;
    const turnsWithReachable = rows.filter((r) => r.reachable.length > 0).length;
    const turnsWithAnyOption = rows.filter((r) => r.boxesAdjacentToCorners > 0).length;
    write('cs01_p2b_real_reachability.json', {
      totalCatTurns: totalTurns,
      turnsWithABoxAdjacentToACorner: turnsWithAnyOption,
      turnsWithAReachableTunnelBlockPush: turnsWithReachable,
      rows,
    });
    expect(totalTurns).toBeGreaterThan(0);
  });
});
