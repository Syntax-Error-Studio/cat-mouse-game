/// <reference types="node" />
/**
 * PPC-P1-PLAN-01 — pre-fix / post-fix witness probe (diagnostic only).
 *
 * This file does NOT assert the fixed behaviour: it records, with the real
 * engine, the real search context and the real extractors, exactly what the
 * current source does. It is run twice:
 *
 *   pre-fix  → PPC-P1-PLAN-01/BASELINE_TRUNCATION_WITNESS.json (frozen)
 *   post-fix → PPC-P1-PLAN-01/POSTFIX_PLAN_WITNESS.json
 *
 * so the "before" file can never be re-derived from the "after" source.
 *
 * Usage:
 *   PPC_PLAN_WITNESS_OUT=<abs path> npx vitest run \
 *     --config PPC-P1-PLAN-01/probe/vitest.config.mts
 */
import { describe, expect, it } from 'vitest';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { GameEngineState } from '../../src/game/engine';
import { GamePhase, PieceType } from '../../src/game/types';
import {
  buildCatTurnPlan, createSearchContext, searchBestAction,
} from '../../src/game/ai/expectiminimax';
import {
  buildCandidate,
  buildPlanForFirstAction,
  extractBestCatTurnPlan,
  planFullTurnCompleteness,
} from '../../src/game/ai/planQuality';
import type { EqualPrimaryGraph } from '../../src/game/ai/planQuality';
import type { SearchAction } from '../../src/game/ai/searchTypes';
import { evaluateForCat } from '../../src/game/ai/evaluation';
import { stateKey } from '../../src/game/ai/transposition';
import {
  catTurnRoot, chainCtx, labelOf, legalCatActions, parsePlan, replayPlan, rules, TUNNELS,
} from '../../src/game/ai/__tests__/planActionBoundFixtures';

const OUT = resolve(
  process.env.PPC_PLAN_WITNESS_OUT
    ?? 'PPC-P1-PLAN-01/BASELINE_TRUNCATION_WITNESS.json',
);

/** Piles everywhere except the corridor `col` in rows `r0..r1`, the hole and the tunnels. */
function corridorWalls(col: number, r0: number, r1: number): { r: number; c: number }[] {
  const hole = { r: 7, c: 8, size: 2 };
  const inHole = (r: number, c: number): boolean =>
    r >= hole.r && r < hole.r + hole.size && c >= hole.c && c < hole.c + hole.size;
  const isTunnel = (r: number, c: number): boolean => TUNNELS.some((t) => t.r === r && t.c === c);
  const out: { r: number; c: number }[] = [];
  for (let r = 0; r < 10; r++) {
    for (let c = 0; c < 10; c++) {
      if (c === col && r >= r0 && r <= r1) continue;
      if (inHole(r, c) || isTunnel(r, c)) continue;
      out.push({ r, c });
    }
  }
  return out;
}

function summarizeVerdict(root: GameEngineState, plan: SearchAction[]) {
  const v = planFullTurnCompleteness(root, plan, rules);
  return { kind: v.kind, catMovesLeft: v.catMovesLeft, reason: v.reason };
}

function catLineOpen(st: GameEngineState): boolean {
  return st.phase === GamePhase.Playing && st.currentPlayer === PieceType.Cat && st.catMovesLeft > 0;
}

/**
 * Extend the plan with real legal actions until the turn ends, so the witness
 * can state "a legal line of N actions existed" without hand-writing moves.
 */
function extendToTurnEnd(root: GameEngineState, start: SearchAction[]): SearchAction[] {
  const plan = start.slice();
  let cur = replayPlan(root, plan).end;
  const guard = new Set<string>();
  while (catLineOpen(cur)) {
    const k = stateKey(cur);
    if (guard.has(k)) break;
    guard.add(k);
    const legal = legalCatActions(cur).filter((a) => a.type === 'catStep');
    if (legal.length === 0) break;
    const step = replayPlan(cur, [legal[0]]);
    if (!step.ok || step.states.length === 0) break;
    plan.push(legal[0]);
    cur = step.end;
  }
  return plan;
}

/** A production-shaped fixed-depth D1 search with an explicit, inspectable ctx. */
function searchedContext(root: GameEngineState) {
  const ctx = createSearchContext(rules, 400_000, true, true, true, 0);
  ctx.leafEvaluator = evaluateForCat;
  ctx.capturePlan = true;
  const result = searchBestAction(root, 1, ctx);
  return { ctx, result };
}

describe('PPC-P1-PLAN-01 witness', () => {
  it('records the truncation facts of the current source', () => {
    const out: Record<string, unknown> = {
      generatedAt: new Date().toISOString(),
      note: 'Diagnostic witness. Written by PPC-P1-PLAN-01/probe/witness.test.ts from the CURRENT source tree.',
      legacyFixedCap: 8,
      cases: {},
    };
    const cases = out.cases as Record<string, unknown>;

    // ---------------- PLAN-1: nine cat moves (end-to-end search) -------------
    const corridorRoot = catTurnRoot({
      cat: { r: 1, c: 3 },
      mouse: { r: 8, c: 8 },
      catBaseMoves: 9,
      traps: 1,
      walls: corridorWalls(3, 1, 6),
    });
    const p1 = searchedContext(corridorRoot);
    {
      const plan = p1.result.catTurnPlan;
      const extended = extendToTurnEnd(corridorRoot, plan);
      const rep = replayPlan(corridorRoot, extended);
      cases['PLAN-1'] = {
        board: '10x10, piles everywhere except column 3 rows 1..6, the 2x2 hole and the 4 tunnels; mouse inside the hole',
        catBaseMoves: 9,
        catMovesLeftAtRoot: corridorRoot.catMovesLeft,
        catTrapsRemaining: corridorRoot.catTrapsRemaining,
        legalActionsAtRoot: legalCatActions(corridorRoot).length,
        search: {
          value: p1.result.value,
          mate: p1.result.mate,
          completed: p1.result.completed,
          nodes: p1.ctx.diagnostics.nodes,
          bestAction: p1.result.action === null
            ? null
            : p1.result.action.type === 'catPlaceTrap'
              ? 'T'
              : p1.result.action.direction!.key,
        },
        returnedPlan: {
          length: plan.length,
          label: labelOf(plan),
          verdict: summarizeVerdict(corridorRoot, plan),
        },
        // Same extractor, same ctx, only the cap lifted: this isolates the cap
        // from every other reason a plan can be short.
        uncappedReference: (() => {
          const p = buildCatTurnPlan(corridorRoot, p1.ctx, 1_000);
          return { length: p.length, label: labelOf(p), verdict: summarizeVerdict(corridorRoot, p) };
        })(),
        legalFullLine: {
          length: extended.length,
          label: labelOf(extended),
          replayOk: rep.ok,
          allEffective: rep.steps.every((s) => s.effective),
          endActor: String(rep.end.currentPlayer),
          endCatMovesLeft: rep.end.catMovesLeft,
          verdict: summarizeVerdict(corridorRoot, extended),
        },
      };
    }

    // -------- PLAN-3: every extraction entry point over the SAME real ctx ----
    {
      const { ctx, result } = p1;
      const branches = ctx.planBranches;
      const graph: EqualPrimaryGraph = ctx.equalPrimaryGraph ?? new Map();
      const first = result.catTurnPlan[0] ?? (result.action as SearchAction | null);
      const graphRootKey = [...graph.keys()].find((k) => k.startsWith(stateKey(corridorRoot)));
      const graphRoot = graphRootKey ? graph.get(graphRootKey) : undefined;

      const entry = (plan: SearchAction[] | null) => (plan === null
        ? null
        : { length: plan.length, label: labelOf(plan), verdict: summarizeVerdict(corridorRoot, plan) });

      const viaBuild = buildCatTurnPlan(corridorRoot, ctx);
      const viaFirst = first === null ? null : buildPlanForFirstAction(corridorRoot, first, ctx);
      const viaDp = extractBestCatTurnPlan(corridorRoot, rules, graph, branches);
      const viaWalk = extractBestCatTurnPlan(corridorRoot, rules, new Map() as EqualPrimaryGraph, branches);
      const cand = first === null ? null : buildCandidate(corridorRoot, first, ctx, 0);

      cases['PLAN-3'] = {
        note: 'value/mate/bestAction come from the search; the plan length comes from post-search extraction. Same real ctx for every extractor.',
        value: result.value,
        mate: result.mate,
        bestAction: result.action === null
          ? null
          : result.action.type === 'catPlaceTrap'
            ? 'T'
            : result.action.direction!.key,
        completed: result.completed,
        equalPrimaryGraphNodes: graph.size,
        equalPrimaryGraphRootActions: graphRoot
          ? graphRoot.equalActions.map((a) => (a.type === 'catPlaceTrap' ? 'T' : a.direction!.key))
          : null,
        planBranchesEntries: branches.size,
        entryPoints: {
          buildCatTurnPlan: entry(viaBuild),
          buildPlanForFirstAction: entry(viaFirst),
          extractBestCatTurnPlan_dp: entry(viaDp),
          extractBestCatTurnPlan_fallbackWalk: entry(viaWalk),
          buildCandidate: entry(cand === null ? null : cand.plan),
          buildCatTurnPlan_uncapped: entry(buildCatTurnPlan(corridorRoot, ctx, 1_000)),
          extractBestCatTurnPlan_fallbackWalk_uncapped: entry(
            extractBestCatTurnPlan(corridorRoot, rules, new Map() as EqualPrimaryGraph, branches, 1_000),
          ),
          extractBestCatTurnPlan_dp_uncapped: entry(
            extractBestCatTurnPlan(corridorRoot, rules, graph, branches, 1_000),
          ),
        },
      };
    }

    // ---------------- PLAN-2: six moves, nine actions ------------------------
    {
      const root = catTurnRoot({
        cat: { r: 3, c: 3 },
        mouse: { r: 8, c: 8 },
        catBaseMoves: 6,
        traps: 1,
      });
      const plan = parsePlan('TUDTUDTDD');
      const rep = replayPlan(root, plan);
      const chain = chainCtx(root, plan);
      const ctx = chain.ctx;

      const built = buildCatTurnPlan(root, ctx);
      const byFirst = buildPlanForFirstAction(root, plan[0], ctx);
      const walk = extractBestCatTurnPlan(root, rules, new Map() as EqualPrimaryGraph, ctx.planBranches);
      const cand = buildCandidate(root, plan[0], ctx, 0);

      cases['PLAN-2'] = {
        board: '10x10 open board (no boxes/piles/butter), mouse inside the hole',
        catBaseMoves: 6,
        catMovesLeftAtRoot: root.catMovesLeft,
        intendedPlan: 'TUDTUDTDD',
        replay: {
          ok: rep.ok,
          steps: rep.steps.map((s) => ({
            i: s.index,
            action: s.action.type === 'catPlaceTrap' ? 'T' : s.action.direction!.key.slice(5)[0],
            effective: s.effective,
            catMovesLeft: s.catMovesLeft,
            catTrapsRemaining: s.catTrapsRemaining,
            trap: s.trap,
            cat: s.cat,
            actor: s.actor,
          })),
          movements: rep.steps.filter((s) => s.action.type === 'catStep').length,
          placements: rep.steps.filter((s) => s.action.type === 'catPlaceTrap').length,
          endCatMovesLeft: rep.end.catMovesLeft,
          endActor: String(rep.end.currentPlayer),
          verdict: summarizeVerdict(root, plan),
        },
        chainedBranches: chain.chained,
        entryPoints: {
          buildCatTurnPlan: { length: built.length, label: labelOf(built) },
          buildPlanForFirstAction: { length: byFirst.length, label: labelOf(byFirst) },
          extractBestCatTurnPlan_fallbackWalk: { length: walk.length, label: labelOf(walk) },
          buildCandidate: cand === null ? null : { length: cand.plan.length, label: labelOf(cand.plan) },
        },
        uncappedReference: (() => {
          const p = buildCatTurnPlan(root, ctx, 1_000);
          return { length: p.length, label: labelOf(p) };
        })(),
        truncatedPrefixVerdict: summarizeVerdict(root, plan.slice(0, 8)),
        fullPlanVerdict: summarizeVerdict(root, plan),
      };
    }

    writeFileSync(OUT, JSON.stringify(out, null, 2), 'utf-8');
    expect(Object.keys(cases).length).toBe(3);
  });
});
