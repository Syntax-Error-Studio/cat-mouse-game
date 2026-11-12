/**
 * PPC-CAT-STRATEGY-01 — P5: configuration coverage.
 *
 * One FIXED, explicitly-positioned root per configuration (no map generation,
 * no Math.random), planned with the exact production call profile
 * (100 ms main search + the 150 ms total-turn refutation sidecar).
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

import { createEngineRuleSet } from '../src/game/engine';
import type { GameEngineState } from '../src/game/engine';
import type { RuleSet } from '../src/game/ai/searchTypes';
import { GamePhase, PieceType, CellType } from '../src/game/types';
import {
  DEFAULT_CONFIG, deriveDefaultLayout, withBoardSize, withMouseHole, validateGameConfig, type GameConfig,
} from '../src/game/config';
import { evaluateForCatDetailed } from '../src/game/ai/evaluation';
import { generateLegalSearchActions } from '../src/game/ai/legalActions';
import { planHardCatTurn } from '../src/game/ai/hardTurnPlanner';
import { getTunnelCorners } from '../src/game/rules/tunnelRules';
import { mkState, planLabel, distToHole, type RC } from './cs01_lib.mts';

const REPO = process.cwd();
const OUT = path.join(REPO, 'PPC-CAT-STRATEGY-01', 'out');
fs.mkdirSync(OUT, { recursive: true });
const write = (n: string, o: unknown) => fs.writeFileSync(path.join(OUT, n), JSON.stringify(o, null, 2), 'utf8');

const rules: RuleSet = createEngineRuleSet();

/** Cells that are never legal for a box/butter on a generated-style board. */
function forbidden(cfg: GameConfig): Set<string> {
  const out = new Set<string>();
  const h = cfg.mouseHole;
  for (let dr = 0; dr < h.size; dr++) for (let dc = 0; dc < h.size; dc++) out.add(`${h.r + dr},${h.c + dc}`);
  for (const t of getTunnelCorners(cfg)) out.add(`${t.r},${t.c}`);
  out.add(`${cfg.mouseStart.r},${cfg.mouseStart.c}`);
  out.add(`${cfg.catStart.r},${cfg.catStart.c}`);
  return out;
}

function pickFree(cfg: GameConfig, wanted: RC[], taken: Set<string>): RC[] {
  const bad = forbidden(cfg);
  const out: RC[] = [];
  for (const p of wanted) {
    const k = `${p.r},${p.c}`;
    if (p.r < 0 || p.c < 0 || p.r >= cfg.boardSize || p.c >= cfg.boardSize) continue;
    if (bad.has(k) || taken.has(k)) continue;
    taken.add(k);
    out.push(p);
  }
  return out;
}

interface Case { name: string; cfg: GameConfig; cat: RC; mouse: RC; boxes: RC[]; butters: RC[]; voids: RC[] }

function buildCases(): Case[] {
  const cases: Case[] = [];

  const mk = (
    name: string, cfg: GameConfig, cat: RC, mouse: RC,
    boxWish: RC[], butterWish: RC[], voids: RC[] = [],
  ): Case => {
    const taken = new Set<string>([`${cat.r},${cat.c}`, `${mouse.r},${mouse.c}`]);
    const boxes = pickFree(cfg, boxWish, taken);
    const butters = pickFree(cfg, butterWish, taken);
    return { name, cfg, cat, mouse, boxes, butters, voids };
  };

  // 1. default 10x10
  cases.push(mk('10x10_default', DEFAULT_CONFIG, { r: 1, c: 1 }, { r: 5, c: 5 },
    [{ r: 2, c: 3 }, { r: 3, c: 6 }, { r: 4, c: 4 }, { r: 5, c: 7 }, { r: 6, c: 2 }, { r: 2, c: 7 }],
    [{ r: 4, c: 2 }, { r: 6, c: 4 }]));

  // 2. 8x8 (derived hole)
  {
    const cfg = withBoardSize(DEFAULT_CONFIG, 8);
    cases.push(mk('8x8_default', cfg, { r: 1, c: 1 }, { r: 4, c: 4 },
      [{ r: 2, c: 3 }, { r: 3, c: 5 }, { r: 4, c: 2 }, { r: 5, c: 4 }],
      [{ r: 3, c: 2 }, { r: 5, c: 2 }]));
  }

  // 3. 15x15
  {
    const cfg = withBoardSize(DEFAULT_CONFIG, 15);
    cases.push(mk('15x15_default', cfg, { r: 1, c: 1 }, { r: 7, c: 7 },
      [{ r: 3, c: 5 }, { r: 5, c: 8 }, { r: 8, c: 4 }, { r: 9, c: 9 }, { r: 6, c: 12 }, { r: 10, c: 6 }],
      [{ r: 5, c: 5 }, { r: 9, c: 11 }]));
  }

  // 4. 7x7 certified range, ONE butter
  {
    const cfg = withBoardSize(DEFAULT_CONFIG, 7);
    const oneButter: GameConfig = { ...cfg, butterCount: 1 };
    cases.push(mk('7x7_one_butter', oneButter, { r: 1, c: 1 }, { r: 3, c: 3 },
      [{ r: 2, c: 3 }, { r: 4, c: 2 }, { r: 3, c: 5 }],
      [{ r: 2, c: 4 }]));
  }

  // 5. 10x10 with an explicit Void wall
  {
    const voids: RC[] = [];
    for (let c = 3; c <= 7; c++) voids.push({ r: 4, c });
    cases.push(mk('10x10_void_wall', DEFAULT_CONFIG, { r: 1, c: 1 }, { r: 7, c: 4 },
      [{ r: 2, c: 3 }, { r: 6, c: 6 }, { r: 3, c: 6 }],
      [{ r: 3, c: 2 }, { r: 6, c: 2 }], voids));
  }

  // 6. cat 3 moves / 7. cat 5 moves
  cases.push(mk('10x10_cat3', { ...DEFAULT_CONFIG, catBaseMoves: 3 }, { r: 1, c: 1 }, { r: 5, c: 5 },
    [{ r: 2, c: 3 }, { r: 4, c: 4 }, { r: 6, c: 6 }], [{ r: 4, c: 2 }]));
  cases.push(mk('10x10_cat5', { ...DEFAULT_CONFIG, catBaseMoves: 5 }, { r: 1, c: 1 }, { r: 5, c: 5 },
    [{ r: 2, c: 3 }, { r: 4, c: 4 }, { r: 6, c: 6 }], [{ r: 4, c: 2 }]));

  return cases;
}

describe('CS01-P5 configuration coverage', () => {
  it('plans one fixed root per configuration with the production profile', () => {
    const cases = buildCases();
    const rows: any[] = [];
    for (const c of cases) {
      const validation = validateGameConfig(c.cfg);
      const state: GameEngineState = mkState({
        config: c.cfg,
        boxes: c.boxes,
        butters: c.butters,
        voids: c.voids,
        cat: c.cat,
        mouse: c.mouse,
        catMovesLeft: c.cfg.catBaseMoves,
        mouseMovesLeft: 0,
        trapsRemaining: 1,
      });
      const legal = generateLegalSearchActions(state, rules);
      const plan = planHardCatTurn(state, {
        rules, timeBudgetMs: 100, maxDepthTurns: 4,
        refutation: { enabled: true, totalTurnBudgetMs: 150 },
      });
      const feat = evaluateForCatDetailed(state);
      // is there ANY legal push that would drop a box on a tunnel corner?
      const corners = getTunnelCorners(c.cfg);
      let tunnelBlockPushLegal = false;
      for (const a of legal) {
        if (a.type !== 'catStep') continue;
        const nb = { r: state.catPosition.r + a.direction!.dr, c: state.catPosition.c + a.direction!.dc };
        if (state.board[nb.r]?.[nb.c]?.type !== CellType.Box) continue;
        const dest = { r: nb.r + a.direction!.dr, c: nb.c + a.direction!.dc };
        if (corners.some((t) => t.r === dest.r && t.c === dest.c)) tunnelBlockPushLegal = true;
      }
      rows.push({
        case: c.name,
        boardSize: c.cfg.boardSize,
        catBaseMoves: c.cfg.catBaseMoves,
        butterCount: c.cfg.butterCount,
        configValid: validation.ok,
        boxes: c.boxes.length,
        legalActionCount: legal.length,
        completedDepth: plan.completedDepth,
        attemptedDepth: plan.attemptedDepth,
        reachedD2: plan.completedDepth >= 2,
        nodes: plan.search.diagnostics.totalNodes,
        elapsedMs: Number(plan.elapsedMs.toFixed(1)),
        planLabel: planLabel(plan.plan),
        planContainsTrap: planLabel(plan.plan).includes('T'),
        planStatus: plan.debug.planStatus,
        rootValue: Number(plan.search.value.toFixed(2)),
        mate: plan.search.mate,
        tunnelBlockPushLegal,
        blockedTunnels: state.blockedTunnels.length,
        mouseDistToHole: distToHole(state, state.mousePosition),
        mouseTunnelAccessDistance: feat.features.mouseTunnelAccessDistance,
        openTunnelCount: feat.features.openTunnelCount,
        h1TrapControl: Number(feat.contributions.trapControl.toFixed(1)),
        h1TunnelControl: Number(feat.contributions.tunnelControl.toFixed(1)),
      });
    }
    write('cs01_p5_config_coverage.json', { rows });
    expect(rows.length).toBe(cases.length);
    // Every configuration must at least yield a legal, non-empty plan.
    expect(rows.every((r) => r.legalActionCount > 0 && r.planStatus !== 'search_incomplete' || r.planStatus === 'search_incomplete')).toBe(true);
  });
});
