/// <reference types="node" />
/**
 * PPC-P1-CLOSURE-01 / P3-A — FLT-HV14-4 root GAME3 T4 value divergence probe.
 *
 * READ-ONLY. Answers one question with measurements, not inference:
 *   the logged production root value for GAME3 T4 is -1052.9473 (mate=null,
 *   cDepth=2, deadlineFired=true), while FLT-HV14-4's fixed-depth rerun of the
 *   SAME restored root at the SAME depth reports 999996 (= MATE_SCORE - 4,
 *   i.e. a claimed cat mate). Which one is the engine's answer, and why do the
 *   two entry points disagree?
 *
 * Emits one JSON document to PPC-P1-CLOSURE-01/_raw/hv14_t4_probe.json.
 */
import { test } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createEngineRuleSet } from '../../src/game/engine';
import type { GameEngineState } from '../../src/game/engine';
import { GamePhase, PieceType, DIRECTIONS } from '../../src/game/types';
import { restoreHardRoot, type HardRootSnapshot } from '../../src/game/ai/hardHistory';
import {
  createSearchContext,
  searchResult,
  searchBestAction,
  searchBestActionIterative,
} from '../../src/game/ai/expectiminimax';
import { evaluateCorrectedHoleForCat } from '../../src/game/ai/correctedHoleLeaf';
import { stateKey } from '../../src/game/ai/transposition';
import { simulateSearchAction } from '../../src/game/ai/simulator';
import { generateLegalSearchActions } from '../../src/game/ai/legalActions';
import { applyNoMoveLoss } from '../../src/game/rules/mobility';
import type { SearchAction } from '../../src/game/ai/searchTypes';

const OUT = new URL('../_raw/hv14_t4_probe.json', import.meta.url);
const LOG = new URL('../../ai-training/human-logs/PPC-HV14/GAME3_H1.txt', import.meta.url);
const rules = createEngineRuleSet();

const actionText = (a: SearchAction): string =>
  a.type === 'catStep' ? a.direction!.key : a.type === 'catPlaceTrap' ? 'T' : a.type;

function parseTurn(turn: number): {
  state: GameEngineState;
  loggedKey: string;
  completedDepth: number;
  rootValue: number;
  rootMate: string;
  plan: string;
  block: string[];
} {
  const text = readFileSync(LOG, 'utf8');
  const lines = text.split(/\r?\n/);
  const starts: number[] = [];
  lines.forEach((l, i) => {
    if (/^Turn #\d+$/.test(l.trim())) starts.push(i);
  });
  const idx = starts.findIndex((s) => Number(/^Turn #(\d+)$/.exec(lines[s].trim())![1]) === turn);
  const block = lines.slice(starts[idx], idx + 1 < starts.length ? starts[idx + 1] : lines.length);
  const field = (p: string): string => block.find((l) => l.startsWith(p))?.slice(p.length).trim() ?? '';
  const snap = JSON.parse(field('SNAPSHOT_JSON=')) as HardRootSnapshot;
  const dm = /^cDepth=(\d+) aDepth=(\d+)/.exec(field('SEARCH:'))!;
  const rv = /^(-?[\d.e+]+) mate=(\w+)$/.exec(field('ROOT_VALUE='))!;
  return {
    state: restoreHardRoot(snap),
    loggedKey: field('STATE_KEY='),
    completedDepth: Number(dm[1]),
    rootValue: Number(rv[1]),
    rootMate: rv[2],
    plan: field('PLAN:'),
    block,
  };
}

function fingerprint(s: GameEngineState): Record<string, unknown> {
  return {
    phase: s.phase,
    currentPlayer: s.currentPlayer,
    catPosition: s.catPosition,
    mousePosition: s.mousePosition,
    catMovesLeft: s.catMovesLeft,
    mouseMovesLeft: s.mouseMovesLeft,
    trapPosition: s.trapPosition,
    catTrapsRemaining: s.catTrapsRemaining,
    mouseHasButter: s.mouseHasButter,
    mouseSkillActive: s.mouseSkillActive,
    butterPositions: s.butterPositions,
    pendingButterSpawns: (s as unknown as { pendingButterSpawns?: unknown }).pendingButterSpawns,
    pendingButterPlacementDebt: (s as unknown as { pendingButterPlacementDebt?: unknown })
      .pendingButterPlacementDebt,
    blockedTunnels: s.blockedTunnels,
    tunnelExitChoices: s.tunnelExitChoices,
    noMoveLossAtRoot: applyNoMoveLoss(s) !== s,
  };
}

test('P3-A GAME3 T4 — identity, depth sweep, entry-point comparison', () => {
  const t = parseTurn(4);
  const out: Record<string, unknown> = {
    log: 'ai-training/human-logs/PPC-HV14/GAME3_H1.txt',
    logSha256: createHash('sha256').update(readFileSync(LOG)).digest('hex'),
    turn: 4,
    logged: {
      stateKey: t.loggedKey,
      completedDepth: t.completedDepth,
      rootValue: t.rootValue,
      rootMate: t.rootMate,
      plan: t.plan,
      searchLine: t.block.find((l) => l.startsWith('SEARCH:')) ?? '',
      deadlineLine: t.block.find((l) => l.startsWith('DEADLINE:')) ?? '',
      rootActionsLine: t.block
        .slice(t.block.findIndex((l) => l.trim() === 'ROOT_ACTIONS:'))
        .filter((l) => /^\s+(Arrow|catPlaceTrap)/.test(l))
        .map((l) => l.trim()),
    },
    identity: {
      restoredStateKey: stateKey(t.state),
      matchesLogged: stateKey(t.state) === t.loggedKey,
    },
    fingerprint: fingerprint(t.state),
    depthSweep: [] as unknown[],
    iterativeSweep: [] as unknown[],
    capturePlanEffect: [] as unknown[],
    rootActionScores: [] as unknown[],
  };

  const mkCtx = () => {
    const ctx = createSearchContext(rules, 500_000, true, true, true, 0, false);
    ctx.leafEvaluator = evaluateCorrectedHoleForCat;
    return ctx;
  };

  // ---- fixed-depth sweep, two entry points, identical context -------------
  for (const d of [1, 2, 3, 4]) {
    const r = searchResult(t.state, d, mkCtx());
    (out.depthSweep as unknown[]).push({
      api: 'searchResult',
      depthTurns: d,
      value: r.value,
      mate: r.mate,
      completed: r.completed,
      bound: r.bound,
    });
    const ctx = mkCtx();
    const b = searchBestAction(t.state, d, ctx);
    (out.depthSweep as unknown[]).push({
      api: 'searchBestAction',
      depthTurns: d,
      value: b.value,
      mate: b.mate,
      completed: b.completed,
      bestAction: b.action ? actionText(b.action) : null,
      nodes: ctx.diagnostics.nodes,
      terminalNodes: ctx.diagnostics.terminalNodes,
      leafNodes: ctx.diagnostics.leafNodes,
      maxDepthReached: ctx.diagnostics.maxDepthReached,
      rootValues: ctx.rootValues.map((a) => ({
        a: actionText(a.action),
        v: a.value,
        mate: a.mate,
        bound: a.bound,
      })),
    });
  }

  // ---- iterative sweep (production entry point), no deadline --------------
  for (const d of [1, 2, 3]) {
    const r = searchBestActionIterative(t.state, {
      rules,
      maxDepthTurns: d,
      maxNodes: 500_000,
      useTT: true,
      useAlphaBeta: true,
      useMoveOrdering: true,
      useThreatOrdering: false,
      maxThreatExtensions: 0,
      leafEvaluator: evaluateCorrectedHoleForCat,
      deadlineMs: undefined,
    });
    (out.iterativeSweep as unknown[]).push({
      maxDepthTurns: d,
      value: r.value,
      mate: r.mate,
      completed: r.completed,
      completedDepth: r.completedDepth,
      attemptedDepth: r.attemptedDepth,
      bestAction: r.bestAction ? actionText(r.bestAction) : null,
      nodes: r.diagnostics.nodes,
      iterations: r.iterations.map((i) => ({
        depth: i.depth,
        completed: i.completed,
        value: i.value,
        mate: i.mate,
        nodes: i.nodes,
      })),
    });
  }

  // ---- does capturePlan change the value? --------------------------------
  for (const capture of [false, true]) {
    for (const d of [1, 2]) {
      const ctx = mkCtx();
      ctx.capturePlan = capture;
      const r = searchResult(t.state, d, ctx);
      (out.capturePlanEffect as unknown[]).push({
        capturePlan: capture,
        depthTurns: d,
        value: r.value,
        mate: r.mate,
        nodes: ctx.diagnostics.nodes,
      });
    }
  }

  // ---- per-root-action child inspection: can the cat really win? ---------
  const legal = generateLegalSearchActions(t.state, rules);
  for (const a of legal) {
    const tr = simulateSearchAction(t.state, a, rules);
    const row: Record<string, unknown> = {
      action: actionText(a),
      kind: tr.kind,
    };
    if (tr.kind === 'deterministic') {
      const s1 = tr.state;
      row.afterPhase = s1.phase;
      row.afterPlayer = s1.currentPlayer;
      row.afterCatMovesLeft = s1.catMovesLeft;
      row.strandedImmediately = applyNoMoveLoss(s1) !== s1;
      // one cat turn of greedy steps: is the mouse stranded after the turn?
      row.mouseLegalAtHandoff = s1.currentPlayer === PieceType.Mouse
        ? generateLegalSearchActions(s1, rules).length
        : null;
    }
    (out.rootActionScores as unknown[]).push(row);
  }

  writeFileSync(OUT, JSON.stringify(out, null, 2), 'utf8');
  console.log(JSON.stringify(out, null, 2));
}, 300_000);
