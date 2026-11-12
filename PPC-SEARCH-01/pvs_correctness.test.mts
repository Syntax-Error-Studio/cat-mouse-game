/**
 * PPC-SEARCH-01 — correctness gates.
 *
 * Gate order matters: the fork control (PVS OFF) must be bit-identical to
 * production BEFORE any PVS number is allowed to mean anything.
 *
 * All arms are computed ONCE in `beforeAll` and every gate reads the same
 * records — this keeps the heavy work to a single serial pass
 * (HEAVY_WORKER_CONCURRENCY = 1).
 */
import { beforeAll, describe, expect, it } from 'vitest';
import {
  corpus,
  controls,
  runFixed,
  replayPlan,
  writeOut,
  RULES,
  LEAF,
  type Arm,
  type ArmResult,
} from './pvs_lib.mts';
import {
  createSearchContext as createForkContext,
  searchBestAction as searchFork,
  setPvsEnabled,
  setPvsChanceExempt,
} from './proto/expectiminimaxPvs';
import type { GameEngineState } from '../src/game/engine';
import type { SearchAction } from '../src/game/ai/searchTypes';
import { stateKey } from '../src/game/ai/transposition';

const OUT = 'PPC-SEARCH-01/out';
const ARMS: Arm[] = ['A', 'A_FORK', 'B', 'C'];
const FIELDS = ['value', 'mate', 'completed', 'bestAction', 'plan'] as const;

interface Rec {
  id: string;
  depth: number;
  results: Record<Arm, ArmResult>;
  planActions: SearchAction[];
}

const rootRecs = new Map<string, Rec>();
const ctrlRecs = new Map<string, Rec>();

function diffFields(a: ArmResult, b: ArmResult): string[] {
  const out: string[] = [];
  for (const f of FIELDS) if (a[f] !== b[f]) out.push(`${f}: ${String(a[f])} != ${String(b[f])}`);
  return out;
}

function planActionsOf(arm: Arm, state: GameEngineState, depth: number): SearchAction[] {
  setPvsEnabled(arm === 'B' || arm === 'C');
  setPvsChanceExempt(arm === 'C');
  const ctx = createForkContext(RULES, 2_000_000, true, true, true, 0, false);
  ctx.capturePlan = true;
  ctx.leafEvaluator = LEAF;
  ctx.now = () => 0;
  return searchFork(state, depth, ctx).catTurnPlan;
}

function record(map: Map<string, Rec>, id: string, state: GameEngineState, depth: number): void {
  const key = `${id}@D${depth}`;
  if (map.has(key)) return;
  const results = {} as Record<Arm, ArmResult>;
  for (const arm of ARMS) results[arm] = runFixed(arm, state, depth);
  map.set(key, { id, depth, results, planActions: planActionsOf('B', state, depth) });
}

describe('PPC-SEARCH-01 correctness', () => {
  beforeAll(() => {
    const t0 = performance.now();
    for (const e of corpus()) for (const d of [1, 2]) record(rootRecs, e.id, e.root, d);
    console.log(`[cache] roots: ${rootRecs.size} searches x ${ARMS.length} arms in ${(performance.now() - t0).toFixed(0)} ms`);
    const t1 = performance.now();
    for (const c of controls()) for (const d of [1, 2]) record(ctrlRecs, c.id, c.state, d);
    console.log(`[cache] controls: ${ctrlRecs.size} x ${ARMS.length} arms in ${(performance.now() - t1).toFixed(0)} ms`);
  }, 3_600_000);

  it('T1 fork control: PVS OFF reproduces production exactly (25 roots x D1/D2)', () => {
    const rows: unknown[] = [];
    let mismatches = 0;
    let nodeDelta = 0;
    for (const rec of rootRecs.values()) {
      const a = rec.results.A;
      const f = rec.results.A_FORK;
      const diff = diffFields(a, f);
      const nd = f.nodes - a.nodes;
      nodeDelta += Math.abs(nd);
      if (diff.length || nd !== 0) {
        mismatches++;
        rows.push({ id: rec.id, d: rec.depth, diff, nodesA: a.nodes, nodesFork: f.nodes });
      }
    }
    writeOut(OUT, 't1_fork_control.json', {
      gate: 'fork control — PVS_ENABLED=false must equal production bit-for-bit',
      searches: rootRecs.size,
      mismatches,
      absNodeDelta: nodeDelta,
      rows,
    });
    expect(mismatches).toBe(0);
    expect(nodeDelta).toBe(0);
  });

  it('T2 PVS parity (arm B): value/mate/completed/bestAction/catTurnPlan', () => {
    const rows: unknown[] = [];
    const divergences: unknown[] = [];
    let valueMismatch = 0;
    let planMismatch = 0;
    let actionMismatch = 0;
    let mateMismatch = 0;
    let completedMismatch = 0;

    for (const rec of rootRecs.values()) {
      const a = rec.results.A;
      const b = rec.results.B;
      if (a.value !== b.value) {
        valueMismatch++;
        divergences.push({ id: rec.id, d: rec.depth, kind: 'VALUE', a: a.value, b: b.value, absDiff: Math.abs(a.value - b.value) });
      }
      if (a.mate !== b.mate) {
        mateMismatch++;
        divergences.push({ id: rec.id, d: rec.depth, kind: 'MATE', a: a.mate, b: b.mate });
      }
      if (a.completed !== b.completed) {
        completedMismatch++;
        divergences.push({ id: rec.id, d: rec.depth, kind: 'COMPLETED', a: a.completed, b: b.completed });
      }
      if (a.bestAction !== b.bestAction) {
        actionMismatch++;
        divergences.push({ id: rec.id, d: rec.depth, kind: 'BEST_ACTION', a: a.bestAction, b: b.bestAction, valueEqual: a.value === b.value });
      }
      if (a.plan !== b.plan) {
        planMismatch++;
        divergences.push({ id: rec.id, d: rec.depth, kind: 'PLAN', a: a.plan, b: b.plan, valueEqual: a.value === b.value });
      }
      rows.push({
        id: rec.id,
        d: rec.depth,
        a: { value: a.value, mate: a.mate, completed: a.completed, action: a.bestAction, plan: a.plan, nodes: a.nodes, chanceNodes: a.chanceNodes, cutoffs: a.cutoffs, firstMoveCutoffs: a.firstMoveCutoffs, wallMs: a.wallMs },
        b: { value: b.value, mate: b.mate, completed: b.completed, action: b.bestAction, plan: b.plan, nodes: b.nodes, chanceNodes: b.chanceNodes, cutoffs: b.cutoffs, firstMoveCutoffs: b.firstMoveCutoffs, wallMs: b.wallMs },
        c: { value: rec.results.C.value, action: rec.results.C.bestAction, plan: rec.results.C.plan, nodes: rec.results.C.nodes, wallMs: rec.results.C.wallMs },
        pvs: b.pvs,
        pvsC: rec.results.C.pvs,
      });
    }

    writeOut(OUT, 't2_pvs_parity.json', {
      gate: 'PVS (arm B) vs production, fixed depth, frozen clock, identical config',
      searches: rows.length,
      valueMismatch,
      mateMismatch,
      completedMismatch,
      actionMismatch,
      planMismatch,
      divergences,
      rows,
    });

    expect(valueMismatch).toBe(0);
    expect(mateMismatch).toBe(0);
    expect(completedMismatch).toBe(0);
    expect(actionMismatch).toBe(0);
    expect(planMismatch).toBe(0);
  });

  it('T2b PVS parity (arm C, chance-exempt): same gates', () => {
    const bad: unknown[] = [];
    for (const rec of rootRecs.values()) {
      const diff = diffFields(rec.results.A, rec.results.C);
      if (diff.length) bad.push({ id: rec.id, d: rec.depth, diff });
    }
    writeOut(OUT, 't2b_armC_parity.json', { gate: 'arm C vs production', failures: bad.length, bad });
    expect(bad.length).toBe(0);
  });

  it('T3 TT soundness: TT on equals TT off (no bogus EXACT reuse)', () => {
    const rows: unknown[] = [];
    const bad: unknown[] = [];
    const d2Slice = new Set(['G1T1', 'G1T5', 'G1T9', 'G4T2', 'G4T4', 'G8T3', 'G8T6']);
    for (const e of corpus()) {
      for (const d of [1, 2]) {
        if (d === 2 && !d2Slice.has(e.id)) continue;
        for (const arm of ['B', 'C'] as Arm[]) {
          const on = runFixed(arm, e.root, d, { useTT: true });
          const off = runFixed(arm, e.root, d, { useTT: false });
          const diff = diffFields(on, off);
          rows.push({ id: e.id, d, arm, ttOnNodes: on.nodes, ttOffNodes: off.nodes, ttExactHits: on.ttExactHits, match: diff.length === 0 });
          if (diff.length) bad.push({ id: e.id, d, arm, diff });
        }
      }
    }
    writeOut(OUT, 't3_tt_soundness.json', { gate: 'TT ON vs TT OFF under PVS', runs: rows.length, failures: bad.length, bad, rows });
    expect(bad.length).toBe(0);
  }, 3_600_000);

  it('T4 ruleset-v2 controls: parity on trap / no-move / tunnel / ghost / pickup / push / cat-steps', () => {
    const rows: unknown[] = [];
    const bad: unknown[] = [];
    for (const c of controls()) {
      for (const d of [1, 2]) {
        const rec = ctrlRecs.get(`${c.id}@D${d}`)!;
        const a = rec.results.A;
        for (const arm of ['B', 'C'] as Arm[]) {
          const diff = diffFields(a, rec.results[arm]);
          if (diff.length) bad.push({ id: c.id, d, arm, diff });
        }
        rows.push({
          id: c.id,
          d,
          note: c.note,
          legalActions: c.legalActions,
          stateKey: c.stateKey,
          a: { value: a.value, mate: a.mate, action: a.bestAction, plan: a.plan, nodes: a.nodes, chanceNodes: a.chanceNodes },
          b: { value: rec.results.B.value, action: rec.results.B.bestAction, plan: rec.results.B.plan, nodes: rec.results.B.nodes },
          pvs: rec.results.B.pvs,
        });
      }
    }
    writeOut(OUT, 't4_controls_parity.json', { gate: 'ruleset v2 edge controls', runs: rows.length, failures: bad.length, bad, rows });
    expect(bad.length).toBe(0);
  });

  it('T5 plan replay: every PVS cat-turn plan executes through the real engine', () => {
    const rows: unknown[] = [];
    const bad: unknown[] = [];
    for (const e of corpus()) {
      for (const d of [1, 2]) {
        const rec = rootRecs.get(`${e.id}@D${d}`)!;
        const rep = replayPlan(e.root, rec.planActions);
        rows.push({ id: e.id, d, plan: rec.results.B.plan, applied: rep.applied, ok: rep.ok, endPlayer: rep.endPlayer, terminal: rep.terminal, error: rep.error });
        if (!rep.ok) bad.push({ id: e.id, d, plan: rec.results.B.plan, rep });
      }
    }
    writeOut(OUT, 't5_plan_replay.json', { gate: 'arm B plan executes through real engine transitions', runs: rows.length, failures: bad.length, bad, rows });
    expect(bad.length).toBe(0);
  });

  it('T6 CHANCE: every chance node was searched with the FULL window (all arms)', () => {
    const rows: unknown[] = [];
    let violations = 0;
    for (const rec of rootRecs.values()) {
      const per: Record<string, unknown> = {};
      for (const arm of ARMS) {
        const r = rec.results[arm];
        const ok = r.fullWindowChanceSearches === r.chanceNodes;
        if (!ok) violations++;
        per[arm] = { chance: r.chanceNodes, full: r.fullWindowChanceSearches, ok };
      }
      rows.push({ id: rec.id, d: rec.depth, per });
    }
    writeOut(OUT, 't6_chance_full_window.json', { gate: 'chanceNodes === fullWindowChanceSearches', violations, rows });
    expect(violations).toBe(0);
  });
});

void stateKey;
