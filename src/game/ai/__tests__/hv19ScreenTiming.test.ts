/// <reference types="node" />
/**
 * PPC-HV19 — budget feasibility measurements (RESEARCH ONLY, fresh process).
 *
 * Layer 2 is NOT wired into the Hard AI. This file only measures:
 *   - layer-1 scan cost on the T4 hand-off (5 in-process repetitions),
 *   - layer-1 inside the OBSERVED entry slack (45 ms) and a 20 ms slice,
 *   - layer-2 certificate cost per gift cell (full budget),
 *   - layer-2 inside a 50 ms slice (must be UNKNOWN),
 *   - the production timing picture parsed from the frozen HV14 logs,
 *   - process memory.
 *
 * It prints exactly one `HV19_TIMING_JSON={...}` line so a serial
 * fresh-process driver can collect fixed-count repetitions.
 */
import { expect, test } from 'vitest';
import { createEngineRuleSet } from '../../engine';
import { simulateSearchAction } from '../simulator';
import {
  rootOf,
  applyCatPlan,
  productionTiming,
  quantile,
  planText,
  mouseStep,
} from './hv19Roots';
import { makeScreenBudget, screenHandoff, certifyCandidate } from './hv19GhostGiftScreen';
import type { GiftSuspect, ScreenCounters } from './hv19GhostGiftScreen';

const rules = createEngineRuleSet();

function countersText(c: ScreenCounters): string {
  return `sim=${c.simCalls} legal=${c.legalChecks} chanceNodes=${c.chanceEnumerations}`
    + ` chanceOutcomes=${c.chanceOutcomes} mouseStates=${c.mouseStates} catStates=${c.catStates} h1=${c.h1EvalCalls}`;
}

test('HV19-7 budget feasibility (layer 1 vs layer 2 vs production slack)', () => {
  const root = rootOf('GAME2', 4);
  expect(planText(root.plan)).toBe('LLLL');
  const applied = applyCatPlan(root.state, root.plan, rules);
  expect(applied.ok).toBe(true);
  const handoff = applied.handoffs[0].state;
  expect(handoff.mouseHasButter).toBe(false);

  // --- layer 1: 5 repetitions with a generous cap -------------------------
  const l1Ms: number[] = [];
  let lastCounters: ScreenCounters | null = null;
  let l1Complete = 0;
  let l1Suspects = 0;
  for (let i = 0; i < 5; i++) {
    const b = makeScreenBudget(5_000, 4_000_000);
    const t0 = performance.now();
    const res = screenHandoff(handoff, rules, b);
    l1Ms.push(performance.now() - t0);
    if (res.complete) l1Complete++;
    if (i === 0) { l1Suspects = res.suspects.length; lastCounters = { ...res.counters }; }
  }

  // --- layer 1 inside the observed entry slack / a smaller slice ----------
  const l1At45 = (() => {
    const t0 = performance.now();
    const res = screenHandoff(handoff, rules, makeScreenBudget(45, 400_000));
    return { ms: performance.now() - t0, complete: res.complete, suspects: res.suspects.length, label: res.label };
  })();
  const l1At20 = (() => {
    const t0 = performance.now();
    const res = screenHandoff(handoff, rules, makeScreenBudget(20, 200_000));
    return { ms: performance.now() - t0, complete: res.complete, suspects: res.suspects.length, label: res.label };
  })();

  // --- layer 2 on the known gift cells ------------------------------------
  const pickup = simulateSearchAction(handoff, mouseStep('Right'), rules);
  if (pickup.kind !== 'chance') throw new Error('T4 pickup is not a chance node');
  const N = pickup.outcomes.length;
  const cells: { r: number; c: number }[] = [];
  for (const o of pickup.outcomes) {
    const g = (o.state.pendingButterSpawns ?? [])[0];
    if (g && (g.r === 6 && g.c === 6 || g.r === 7 && g.c === 5)) cells.push({ r: g.r, c: g.c });
  }
  const certRows: {
    cell: string; status: string; ms: number; reason: string;
    catPlans: number; catOutcomes: number; winChecks: number; transitions: number;
  }[] = [];
  for (const cell of cells) {
    const cand: GiftSuspect = {
      source: 'PICKUP', ghostCell: cell, weight: 1 / N, announcementN: N,
      prefix: [], pickup: mouseStep('Right'), suffix: [], catReachable: false,
    };
    const t0 = performance.now();
    const res = certifyCandidate(handoff, cand, rules, makeScreenBudget(90_000, 30_000_000));
    certRows.push({
      cell: `${cell.r},${cell.c}`, status: res.status, ms: performance.now() - t0, reason: res.reason,
      catPlans: res.catPlans, catOutcomes: res.catOutcomes, winChecks: res.distinctWinChecks,
      transitions: res.transitions,
    });
  }

  // --- layer 2 inside a 50 ms slice ---------------------------------------
  const cand66: GiftSuspect = {
    source: 'PICKUP', ghostCell: { r: 6, c: 6 }, weight: 1 / N, announcementN: N,
    prefix: [], pickup: mouseStep('Right'), suffix: [], catReachable: false,
  };
  const t50 = performance.now();
  const cert50 = certifyCandidate(handoff, cand66, rules, makeScreenBudget(50, 200_000));
  const cert50Ms = performance.now() - t50;

  // --- production timing from the frozen logs -----------------------------
  const pt = productionTiming();
  const prod = {
    turns: pt.turns,
    mainMs: { min: Math.min(...pt.mainMs), p50: quantile(pt.mainMs, 0.5), p95: quantile(pt.mainMs, 0.95), max: Math.max(...pt.mainMs) },
    entrySlackMs: { min: Math.min(...pt.entrySlackMs), p50: quantile(pt.entrySlackMs, 0.5), max: Math.max(...pt.entrySlackMs) },
    sidecarMs: { p50: quantile(pt.sidecarMs, 0.5), max: Math.max(...pt.sidecarMs) },
    residualMs: { min: Math.min(...pt.residualMs), p50: quantile(pt.residualMs, 0.5), max: Math.max(...pt.residualMs), nonPositive: pt.residualMs.filter((x) => x <= 0).length },
    sidecarAborts: pt.sidecarAborts,
    deadlineReason: pt.deadlineReason,
    baselineNotRefuted: pt.baselineNotRefuted,
  };

  const mem = process.memoryUsage();
  const ru = process.resourceUsage();
  const payload = {
    layer1: {
      reps: l1Ms.map((x) => Number(x.toFixed(3))),
      min: Number(Math.min(...l1Ms).toFixed(3)),
      p50: Number(quantile(l1Ms, 0.5).toFixed(3)),
      max: Number(Math.max(...l1Ms).toFixed(3)),
      complete: l1Complete,
      suspects: l1Suspects,
      counters: lastCounters,
      at45ms: l1At45,
      at20ms: l1At20,
    },
    layer2: { n: N, cells: certRows, at50ms: { status: cert50.status, reason: cert50.reason, ms: Number(cert50Ms.toFixed(3)) } },
    production: prod,
    memory: {
      heapUsedMB: Number((mem.heapUsed / 1048576).toFixed(1)),
      rssMB: Number((mem.rss / 1048576).toFixed(1)),
      maxRssMB: Number((ru.maxRSS / 1024).toFixed(1)),
    },
  };

  // eslint-disable-next-line no-console
  console.log(`HV19_TIMING_JSON=${JSON.stringify(payload)}`);
  // eslint-disable-next-line no-console
  console.log(
    `\nHV19-7 budget feasibility`
    + `\n  layer1 reps=${l1Ms.map((x) => x.toFixed(1)).join('/')}ms complete=${l1Complete}/5 suspects=${l1Suspects}`
    + `\n  layer1 counters: ${lastCounters ? countersText(lastCounters) : '-'}`
    + `\n  layer1 @45ms complete=${l1At45.complete} suspects=${l1At45.suspects} (${l1At45.ms.toFixed(1)}ms)`
    + `\n  layer1 @20ms complete=${l1At20.complete} suspects=${l1At20.suspects} (${l1At20.ms.toFixed(1)}ms)`
    + `\n  layer2 ${certRows.map((c) => `${c.cell}:${c.status}:${c.ms.toFixed(1)}ms(${c.catPlans}p/${c.catOutcomes}o/${c.winChecks}w)`).join(' ')}`
    + `\n  layer2 @50ms=${cert50.status}:${cert50.reason} (${cert50Ms.toFixed(1)}ms)`
    + `\n  production turns=${prod.turns} main=${prod.mainMs.min.toFixed(1)}/${prod.mainMs.p50.toFixed(1)}/${prod.mainMs.p95.toFixed(1)}/${prod.mainMs.max.toFixed(1)}`
    + ` entrySlack=${prod.entrySlackMs.min.toFixed(1)}/${prod.entrySlackMs.p50.toFixed(1)}/${prod.entrySlackMs.max.toFixed(1)}`
    + ` sidecarP50=${prod.sidecarMs.p50.toFixed(1)} residualP50=${prod.residualMs.p50.toFixed(1)} min=${prod.residualMs.min.toFixed(1)} nonPositive=${prod.residualMs.nonPositive}/${prod.turns}`
    + `\n  sidecarAborts(deadline)=${prod.sidecarAborts} baselineNotRefuted=${prod.baselineNotRefuted}`
    + `\n  memory heap=${payload.memory.heapUsedMB}MB rss=${payload.memory.rssMB}MB maxRSS=${payload.memory.maxRssMB}MB`,
  );

  expect(l1Complete).toBe(5);
  expect(l1Suspects).toBeGreaterThan(0);
  expect(l1At45.complete, 'layer 1 fits the observed entry slack').toBe(true);
  for (const c of certRows) expect(c.status, `${c.cell} certifies`).toBe('PROVEN');
  expect(cert50.status, 'layer 2 does not fit a 50 ms slice').toBe('UNKNOWN');
  expect(pt.turns).toBe(45);
  expect(pt.mainMs.every((x) => x >= 100 && x < 110)).toBe(true);
}, 300_000);
