/// <reference types="node" />
/**
 * PPC-P1-QUALITY-01 — 24 human roots, old vs new plan, plus a bounded
 * extraction-cost diagnostic.
 *
 * The frozen P1-ID protocol is reused verbatim (fixed depth 1, 10 000 nodes, no
 * deadline, explicit `evaluateCorrectedHoleForCat`, TT + alpha-beta + ordering,
 * plan capture on). The baseline artifact is the same frozen file P1-PLAN-01
 * reproduced 24/24, so any difference below is caused by THIS round only.
 *
 * Unlike P1-PLAN-01 this probe does NOT require the plan string to be equal:
 * the whole point of the round is that the plan may change. What it does require:
 *   - key / completed / value / mate / action / ttSize are identical;
 *   - a changed plan has NO MORE immediate reversals than the old one;
 *   - every plan, old and new, still certifies as a complete cat turn.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import type { GameEngineState } from '../../src/game/engine';
import { createEngineRuleSet } from '../../src/game/engine';
import { restoreHardRoot } from '../../src/game/ai/hardHistory';
import { buildCatTurnPlan, createSearchContext, searchBestAction } from '../../src/game/ai/expectiminimax';
import { countReversals, extractBestCatTurnPlan, planFullTurnCompleteness } from '../../src/game/ai/planQuality';
import { evaluateCorrectedHoleForCat } from '../../src/game/ai/correctedHoleLeaf';
import { stateKey } from '../../src/game/ai/transposition';
import type { SearchAction } from '../../src/game/ai/searchTypes';
import { DIRECTIONS } from '../../src/game/types';

const ROOTS = resolve('src/game/ai/__tests__/fixtures/ppcId01-human-roots.json');
const BASELINE = resolve('src/game/ai/__tests__/fixtures/ppcId01-baseline-d1.json');
const ROOT_SHA = '1a59787adb6669e1cf287d019313dadf4636a4310eed7b3de5236f4778e0db09';
const OUT = resolve(process.env.PPC_QUALITY_PARITY_OUT ?? 'PPC-P1-QUALITY-01/PARITY_RESULTS.json');

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

/** Turn a recorded label list back into real actions so it can be scored. */
function actionsOf(labels: string[]): SearchAction[] {
  return labels.map((ch) => {
    if (ch === 'T') return { type: 'catPlaceTrap' } as SearchAction;
    const key = `Arrow${ch === 'U' ? 'Up' : ch === 'D' ? 'Down' : ch === 'L' ? 'Left' : 'Right'}`;
    const direction = DIRECTIONS.find((d) => d.key === key);
    if (!direction) throw new Error(`unknown plan label ${ch}`);
    return { type: 'catStep', direction } as SearchAction;
  });
}

describe('PPC-P1-QUALITY-01 parity', () => {
  it('keeps all primary fields and never worsens the reversal count on the 24 human roots', () => {
    const raw = readFileSync(ROOTS);
    expect(createHash('sha256').update(raw).digest('hex')).toBe(ROOT_SHA);
    const roots = JSON.parse(raw.toString('utf8')) as RootRecord[];
    const baseline = JSON.parse(readFileSync(BASELINE, 'utf8')) as { records: D1Record[] };
    const byId = new Map(baseline.records.map((r) => [r.id, r]));
    expect(roots.length).toBe(24);

    const rows: unknown[] = [];
    const perf: unknown[] = [];
    const problems: string[] = [];
    const planChanges: string[] = [];

    for (const rec of roots) {
      const state = restoreHardRoot(rec.state as never);
      const ctx = createSearchContext(rules, 10000, true, true, true, 0, false);
      // MOUSE-01 铁律: never assume the leaf evaluator; assert the injection.
      expect(typeof evaluateCorrectedHoleForCat).toBe('function');
      ctx.leafEvaluator = evaluateCorrectedHoleForCat;
      ctx.capturePlan = true;

      const t0 = performance.now();
      const res = searchBestAction(state, 1, ctx);
      const searchMs = performance.now() - t0;

      const t1 = performance.now();
      const walk = buildCatTurnPlan(state, ctx);
      const walkMs = performance.now() - t1;
      const t2 = performance.now();
      const dp = extractBestCatTurnPlan(state, rules, ctx.equalPrimaryGraph ?? new Map(), ctx.planBranches);
      const dpMs = performance.now() - t2;

      const base = byId.get(rec.id)!;
      const produced = {
        key: stateKey(state),
        completed: res.completed,
        value: res.value,
        mate: res.mate,
        action: label(res.action as never),
        plan: res.catTurnPlan.map((a) => label(a as never)),
        ttSize: ctx.tt.size,
      };

      const fields: (keyof D1Record)[] = ['key', 'completed', 'value', 'mate', 'action', 'ttSize'];
      const primaryMismatches: string[] = [];
      for (const f of fields) {
        if (JSON.stringify(produced[f]) !== JSON.stringify(base[f])) {
          primaryMismatches.push(`${String(f)}: ${JSON.stringify(base[f])} -> ${JSON.stringify(produced[f])}`);
        }
      }
      if (primaryMismatches.length > 0) problems.push(`${rec.id}: ${primaryMismatches.join(' | ')}`);

      const planChanged = JSON.stringify(produced.plan) !== JSON.stringify(base.plan);
      if (planChanged) planChanges.push(rec.id);

      const oldPlan = actionsOf(base.plan);
      const newPlan = res.catTurnPlan;
      const oldRev = countReversals(oldPlan);
      const newRev = countReversals(newPlan);
      const verdict = planFullTurnCompleteness(state, newPlan, rules);
      const oldVerdict = planFullTurnCompleteness(state, oldPlan, rules);

      // A plan that changed must not be worse, and must still be a legal full turn.
      if (planChanged && newRev > oldRev) {
        problems.push(`${rec.id}: plan changed and got MORE reversals (${oldRev} -> ${newRev})`);
      }
      if (!['COMPLETE_TURN_BOUNDARY', 'COMPLETE_CHANCE_BOUNDARY', 'GAME_ENDED', 'NO_LEGAL_ACTIONS'].includes(verdict.kind)) {
        problems.push(`${rec.id}: new plan is not complete (${verdict.kind})`);
      }

      rows.push({
        id: rec.id,
        primaryMatch: primaryMismatches.length === 0,
        primaryMismatches,
        planChanged,
        baselinePlan: base.plan.join(''),
        newPlan: produced.plan.join(''),
        baselineReversals: oldRev,
        newReversals: newRev,
        baselineVerdict: oldVerdict.kind,
        newVerdict: verdict.kind,
        value: produced.value,
        baselineValue: base.value,
        mate: produced.mate,
        completed: produced.completed,
        ttSize: produced.ttSize,
        baselineTtSize: base.ttSize,
        walkLength: walk.length,
        dpLength: dp.length,
      });
      perf.push({
        id: rec.id,
        catMovesLeft: state.catMovesLeft,
        searchMs: Number(searchMs.toFixed(3)),
        walkMs: Number(walkMs.toFixed(3)),
        dpMs: Number(dpMs.toFixed(3)),
      });
    }

    const ms = (vals: number[]) => {
      const s = [...vals].sort((a, b) => a - b);
      return { min: +s[0]!.toFixed(3), p50: +s[Math.floor(s.length / 2)]!.toFixed(3), max: +s[s.length - 1]!.toFixed(3) };
    };
    const summary = {
      roots: roots.length,
      primaryAllMatch: problems.filter((p) => !p.includes('plan changed')).length === 0,
      planChanges,
      problems,
      reversals: {
        baselineTotal: (rows as { baselineReversals: number }[]).reduce((a, r) => a + r.baselineReversals, 0),
        newTotal: (rows as { newReversals: number }[]).reduce((a, r) => a + r.newReversals, 0),
      },
      costMs_DIAGNOSTIC_ONLY: {
        search: ms(perf.map((r) => (r as { searchMs: number }).searchMs)),
        extractionWalk: ms(perf.map((r) => (r as { walkMs: number }).walkMs)),
        extractionDp: ms(perf.map((r) => (r as { dpMs: number }).dpMs)),
        note: 'single pass, no repetitions, not a formal benchmark',
      },
    };

    writeFileSync(OUT, JSON.stringify({
      protocol: 'frozen P1-ID fixed-D1 (10k nodes, no deadline, evaluateCorrectedHoleForCat, TT+AB+ordering, capturePlan)',
      baselineArtifact: 'src/game/ai/__tests__/fixtures/ppcId01-baseline-d1.json',
      planEqualityRequired: false,
      summary,
      rows,
    }, null, 2), 'utf-8');

    for (const p of problems) console.log('PROBLEM', p);
    console.log('PPC_QUALITY_PARITY', JSON.stringify(summary));
    expect(problems, 'no primary drift, no worse plan, no incomplete plan').toEqual([]);
  });
});
