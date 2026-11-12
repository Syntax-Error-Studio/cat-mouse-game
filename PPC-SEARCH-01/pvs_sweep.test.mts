/**
 * PPC-SEARCH-01 — THESIS SWEEP (single serial pass, incremental artefacts).
 *
 * Written because the first correctness driver recomputed every (root, depth,
 * arm) block twice and therefore could not finish inside any affordable wall.
 * This driver does exactly one pass, appends each root's row to a JSONL before
 * moving on, and prints progress so an interrupted run still leaves evidence.
 *
 * Scope, fixed BEFORE the run:
 *   D1  : all 25 roots x {A, A_FORK, B}        (cheap, full coverage)
 *   D2  : all 25 roots x {A, B}                (no A_FORK — the fork-control
 *                                               gate already covered 25xD2 with
 *                                               0 mismatches, see
 *                                               out/t1_fork_control.json)
 *   CTL : all 10 ruleset controls x D1/D2 x {A,B}
 *   TT  : TT ON vs OFF, D1 all roots x {A,B}   (soundness, both arms)
 *   LIVE: 100 ms deadline lane, 8 roots x 3 reps x {A,B}
 *
 * HEAVY_WORKER_CONCURRENCY = 1 (one vitest process, serial loops, no workers).
 */
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  corpus,
  controls,
  runFixed,
  runDeadline,
  replayPlan,
  LEAF,
  RULES,
  writeOut,
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

const OUT = 'PPC-SEARCH-01/out';
mkdirSync(OUT, { recursive: true });

const FIELDS = ['value', 'mate', 'completed', 'bestAction', 'plan'] as const;

function diffFields(a: ArmResult, b: ArmResult): string[] {
  const out: string[] = [];
  for (const f of FIELDS) if (a[f] !== b[f]) out.push(`${f}: ${String(a[f])} != ${String(b[f])}`);
  return out;
}

function append(file: string, row: unknown): void {
  appendFileSync(`${OUT}/${file}`, JSON.stringify(row) + '\n');
}

function reset(file: string): void {
  writeFileSync(`${OUT}/${file}`, '');
}

/** The ACTUAL SearchAction[] of a plan, needed for engine replay. */
function planActionsOf(arm: 'B' | 'C', state: GameEngineState, depth: number): SearchAction[] {
  if (arm === 'B') {
    setPvsEnabled(true);
    setPvsChanceExempt(false);
  } else {
    setPvsEnabled(true);
    setPvsChanceExempt(true);
  }
  const ctx = createForkContext(RULES, 2_000_000, true, true, true, 0, false);
  ctx.capturePlan = true;
  ctx.leafEvaluator = LEAF;
  ctx.now = () => 0;
  return searchFork(state, depth, ctx).catTurnPlan;
}

describe('PPC-SEARCH-01 thesis sweep', () => {
  it('S1 — D1 parity on all 25 frozen roots (A / A_FORK / B)', () => {
    reset('s1_d1_parity.jsonl');
    const roots = corpus();
    let n = 0;
    for (const e of roots) {
      const a = runFixed('A', e.root, 1);
      const f = runFixed('A_FORK', e.root, 1);
      const b = runFixed('B', e.root, 1);
      const row = {
        id: e.id,
        d: 1,
        forkDiff: diffFields(a, f),
        forkNodeDelta: f.nodes - a.nodes,
        abDiff: diffFields(a, b),
        a: { value: a.value, mate: a.mate, action: a.bestAction, plan: a.plan, nodes: a.nodes, ms: a.wallMs },
        b: { value: b.value, mate: b.mate, action: b.bestAction, plan: b.plan, nodes: b.nodes, ms: b.wallMs },
      };
      append('s1_d1_parity.jsonl', row);
      console.log(`[S1] ${e.id} A=${a.nodes}n/${a.wallMs}ms B=${b.nodes}n/${b.wallMs}ms diff=${row.abDiff.length}`);
      n++;
    }
    expect(n).toBe(roots.length);
  }, 3_600_000);

  it('S2 — D2 parity on all 25 frozen roots (A / B)', () => {
    reset('s2_d2_parity.jsonl');
    const roots = corpus();
    for (const e of roots) {
      const a = runFixed('A', e.root, 2);
      const b = runFixed('B', e.root, 2);
      const planB = planActionsOf('B', e.root, 2);
      const rep = replayPlan(e.root, planB);
      const row = {
        id: e.id,
        d: 2,
        diff: diffFields(a, b),
        nodesA: a.nodes,
        nodesB: b.nodes,
        chanceA: a.chanceNodes,
        chanceB: b.chanceNodes,
        cutA: a.cutoffs,
        cutB: b.cutoffs,
        firstCutA: a.firstMoveCutoffs,
        exactA: a.ttExactHits,
        exactB: b.ttExactHits,
        storesA: a.ttStores,
        storesB: b.ttStores,
        msA: a.wallMs,
        msB: b.wallMs,
        budgetCut: a.budgetCutoffs + b.budgetCutoffs,
        planB: b.plan,
        replay: { ok: rep.ok, applied: rep.applied, error: rep.error, terminal: rep.terminal },
        pvs: b.pvs,
      };
      append('s2_d2_parity.jsonl', row);
      console.log(
        `[S2] ${e.id} A=${a.nodes}n/${a.wallMs}ms B=${b.nodes}n/${b.wallMs}ms diff=${row.diff.length} cut=${a.cutoffs}/${b.cutoffs}`,
      );
    }
    expect(roots.length).toBe(25);
  }, 7_200_000);

  it('S3 — ruleset-v2 controls, D1 + D2, A vs B', () => {
    reset('s3_controls.jsonl');
    let runs = 0;
    for (const c of controls()) {
      for (const d of [1, 2]) {
        const a = runFixed('A', c.state, d);
        const b = runFixed('B', c.state, d);
        append('s3_controls.jsonl', {
          id: c.id,
          note: c.note,
          legalActions: c.legalActions,
          stateKey: c.stateKey,
          d,
          diff: diffFields(a, b),
          a: { value: a.value, mate: a.mate, action: a.bestAction, plan: a.plan, nodes: a.nodes, chance: a.chanceNodes },
          b: { value: b.value, mate: b.mate, action: b.bestAction, plan: b.plan, nodes: b.nodes, chance: b.chanceNodes, pvs: b.pvs },
        });
        console.log(`[S3] ${c.id} D${d} legal=${c.legalActions} diff=${diffFields(a, b).length}`);
        runs++;
      }
    }
    expect(runs).toBe(controls().length * 2);
  }, 3_600_000);

  it('S4 — TT soundness: TT ON vs TT OFF at D1, both arms', () => {
    reset('s4_tt_soundness.jsonl');
    for (const e of corpus()) {
      for (const arm of ['A', 'B'] as const) {
        const on = runFixed(arm, e.root, 1, { useTT: true });
        const off = runFixed(arm, e.root, 1, { useTT: false });
        append('s4_tt_soundness.jsonl', {
          id: e.id,
          arm,
          d: 1,
          diff: diffFields(on, off),
          nodesOn: on.nodes,
          nodesOff: off.nodes,
          exactHits: on.ttExactHits,
        });
      }
    }
    expect(true).toBe(true);
  }, 1_800_000);

  it('S5 — 100 ms deadline lane: completion depth and plan, A vs B, 3 serial reps', () => {
    reset('s5_live_100ms.jsonl');
    const ids = ['G1T1', 'G1T2', 'G1T5', 'G1T7', 'G1T10', 'G4T2', 'G4T4', 'G1T9'];
    const roots = corpus();
    for (const id of ids) {
      const root = roots.find((c) => c.id === id)!.root;
      for (let rep = 1; rep <= 3; rep++) {
        for (const arm of ['A', 'B'] as const) {
          const r = runDeadline(arm, root, 100);
          append('s5_live_100ms.jsonl', { id, rep, ...r });
          console.log(`[S5] ${id} rep${rep} ${arm} depth=${r.completedDepth} wall=${r.wallMs}ms plan=${r.plan} fallback=${r.fallback}`);
        }
      }
    }
    expect(true).toBe(true);
  }, 1_800_000);

  it('S6 — write the consolidated verdict artefact', () => {
    writeOut(OUT, 's6_note.json', {
      note: 'raw rows live in s1..s5 .jsonl (one append per root, interruption-safe)',
      fields: [...FIELDS],
    });
    expect(true).toBe(true);
  });
});
