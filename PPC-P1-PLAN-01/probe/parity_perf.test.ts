/// <reference types="node" />
/**
 * PPC-P1-PLAN-01 — default-map parity (PLAN-7/PLAN-8) and a bounded extraction
 * cost diagnostic (PLAN-12). Diagnostic only: the numbers here are labelled
 * DIAGNOSTIC_ONLY and are not a performance gate.
 *
 * Protocol is the frozen P1-ID one (`ppcId01-baseline-d1.json`): fixed depth 1,
 * 10 000 node budget, no deadline, explicit `evaluateCorrectedHoleForCat`,
 * TT + alpha-beta + move ordering on, plan capture on. Comparing against that
 * frozen artifact is what makes "the default map did not move" a measurement
 * rather than an opinion.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import type { GameEngineState } from '../../src/game/engine';
import { restoreHardRoot } from '../../src/game/ai/hardHistory';
import {
  buildCatTurnPlan, createSearchContext, searchBestAction,
} from '../../src/game/ai/expectiminimax';
import { extractBestCatTurnPlan } from '../../src/game/ai/planQuality';
import { evaluateCorrectedHoleForCat } from '../../src/game/ai/correctedHoleLeaf';
import { stateKey } from '../../src/game/ai/transposition';
import { createEngineRuleSet } from '../../src/game/engine';

const ROOTS = resolve('src/game/ai/__tests__/fixtures/ppcId01-human-roots.json');
const BASELINE = resolve('src/game/ai/__tests__/fixtures/ppcId01-baseline-d1.json');
const ROOT_SHA = '1a59787adb6669e1cf287d019313dadf4636a4310eed7b3de5236f4778e0db09';
const PARITY_OUT = resolve(process.env.PPC_PARITY_OUT ?? 'PPC-P1-PLAN-01/PARITY_RESULTS.json');
const PERF_OUT = resolve(process.env.PPC_PERF_OUT ?? 'PPC-P1-PLAN-01/PERFORMANCE_RESULTS.json');

interface RootRecord { id: string; state: unknown }
interface D1Record {
  id: string; key: string; completed: boolean; value: number; mate: string | null;
  action: string; plan: string[]; ttSize: number;
}

const rules = createEngineRuleSet();

function label(a: { type: string; direction?: { key: string } } | null): string {
  if (a === null) return 'none';
  if (a.type === 'catPlaceTrap') return 'T';
  if (a.type === 'catStep') return a.direction!.key.slice(5)[0]!;
  return '?';
}

describe('PPC-P1-PLAN-01 parity + cost', () => {
  it('reproduces the frozen 24-root D1 baseline and measures extraction cost', () => {
    const raw = readFileSync(ROOTS);
    expect(createHash('sha256').update(raw).digest('hex')).toBe(ROOT_SHA);
    const roots = JSON.parse(raw.toString('utf8')) as RootRecord[];
    const baseline = JSON.parse(readFileSync(BASELINE, 'utf8')) as { records: D1Record[] };
    const byId = new Map(baseline.records.map((r) => [r.id, r]));
    expect(roots.length).toBe(24);

    const parity: unknown[] = [];
    const perf: unknown[] = [];
    let allMatch = true;

    for (const rec of roots) {
      const state = restoreHardRoot(rec.state as never);
      const t0 = performance.now();
      const ctx = createSearchContext(rules, 10000, true, true, true, 0, false);
      // MOUSE-01 铁律: an unset leafEvaluator silently falls back to
      // `defaultLeafEval`, so the injection is asserted, not assumed.
      expect(typeof evaluateCorrectedHoleForCat).toBe('function');
      ctx.leafEvaluator = evaluateCorrectedHoleForCat;
      ctx.capturePlan = true;
      const res = searchBestAction(state, 1, ctx);
      const searchMs = performance.now() - t0;

      // Extraction measured separately from the search it consumes.
      const t1 = performance.now();
      const walk = buildCatTurnPlan(state, ctx);
      const walkMs = performance.now() - t1;
      const t2 = performance.now();
      const dp = extractBestCatTurnPlan(state, rules, ctx.equalPrimaryGraph ?? new Map(), ctx.planBranches);
      const dpMs = performance.now() - t2;

      const base = byId.get(rec.id)!;
      const produced = {
        id: rec.id,
        key: stateKey(state),
        completed: res.completed,
        value: res.value,
        mate: res.mate,
        action: label(res.action as never),
        plan: res.catTurnPlan.map((a) => label(a as never)),
        ttSize: ctx.tt.size,
      };
      const fields: (keyof D1Record)[] = ['key', 'completed', 'value', 'mate', 'action', 'ttSize'];
      const mismatches: string[] = [];
      for (const f of fields) {
        if (JSON.stringify(produced[f]) !== JSON.stringify(base[f])) {
          mismatches.push(`${String(f)}: ${JSON.stringify(base[f])} -> ${JSON.stringify(produced[f])}`);
        }
      }
      if (JSON.stringify(produced.plan) !== JSON.stringify(base.plan)) {
        mismatches.push(`plan: ${JSON.stringify(base.plan)} -> ${JSON.stringify(produced.plan)}`);
      }
      if (mismatches.length > 0) allMatch = false;

      parity.push({
        id: rec.id,
        matches: mismatches.length === 0,
        mismatches,
        plan: produced.plan,
        baselinePlan: base.plan,
        value: produced.value,
        baselineValue: base.value,
        ttSize: produced.ttSize,
        baselineTtSize: base.ttSize,
      });
      perf.push({
        id: rec.id,
        catMovesLeft: state.catMovesLeft,
        searchMs: Number(searchMs.toFixed(3)),
        walkMs: Number(walkMs.toFixed(3)),
        dpMs: Number(dpMs.toFixed(3)),
        walkLen: walk.length,
        dpLen: dp.length,
        // What the pre-fix default would have produced for the same walk:
        cappedLen: Math.min(walk.length, 8),
      });
    }

    const ms = (vals: number[]): { min: number; p50: number; max: number } => {
      const s = [...vals].sort((a, b) => a - b);
      return {
        min: Number(s[0]!.toFixed(3)),
        p50: Number(s[Math.floor(s.length / 2)]!.toFixed(3)),
        max: Number(s[s.length - 1]!.toFixed(3)),
      };
    };
    const walkMs = (perf as { walkMs: number }[]).map((r) => r.walkMs);
    const dpMs = (perf as { dpMs: number }[]).map((r) => r.dpMs);
    const searchMs = (perf as { searchMs: number }[]).map((r) => r.searchMs);
    const summary = {
      roots: roots.length,
      parityAllMatch: allMatch,
      mismatched: (parity as { id: string; matches: boolean }[]).filter((r) => !r.matches).map((r) => r.id),
      planLengths: {
        maxPlanLen: Math.max(...(perf as { dpLen: number }[]).map((r) => r.dpLen)),
        maxWalkLen: Math.max(...(perf as { walkLen: number }[]).map((r) => r.walkLen)),
      },
      costMs_DIAGNOSTIC_ONLY: {
        search: ms(searchMs),
        extractionWalk: ms(walkMs),
        extractionDp: ms(dpMs),
        note: 'single pass, no repetitions, not a formal benchmark; search dominates extraction by ~3 orders of magnitude',
      },
    };

    writeFileSync(PARITY_OUT, JSON.stringify({
      protocol: 'frozen P1-ID fixed-D1 (10k nodes, no deadline, evaluateCorrectedHoleForCat, TT+AB+ordering, capturePlan)',
      baselineArtifact: 'src/game/ai/__tests__/fixtures/ppcId01-baseline-d1.json',
      summary,
      rows: parity,
    }, null, 2), 'utf-8');
    writeFileSync(PERF_OUT, JSON.stringify({
      label: 'DIAGNOSTIC_ONLY',
      protocol: 'single pass over the 24 human roots, fixed D1, same process',
      summary,
      rows: perf,
    }, null, 2), 'utf-8');

    for (const r of parity as { id: string; matches: boolean; mismatches: string[] }[]) {
      if (!r.matches) console.log('MISMATCH', r.id, r.mismatches.join(' | '));
    }
    console.log('PPC_PLAN_PARITY', JSON.stringify(summary));
    expect(allMatch).toBe(true);
  });
});
