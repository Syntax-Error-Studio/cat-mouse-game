/// <reference types="node" />
/**
 * PPC-HV20 — Sidecar real decision-contribution audit (READ-ONLY research test).
 *
 * Reads the five frozen PPC-HV14 Hard logs, classifies every cat turn, and:
 *   1. re-derives the eligibility gate with the production `shouldRunSidecar`,
 *   2. replays EVERY logged executed plan through the real engine and compares
 *      the endpoint with the logged EXEC state key,
 *   3. re-runs the sidecar on the two `no_clean_candidate` roots with a generous
 *      wall (the log does not persist the witness) to recover the bounded
 *      rejection certificate,
 *   4. asserts that no turn changed the first action or the full plan.
 *
 * No production module is modified. No large benchmark, no T7 enumeration,
 * no self-play. The only compute is 45 small replays plus two bounded sidecars
 * (each already capped by FIXED_PATHS/CPU_PX/FIXED_EXACT in production code).
 */
import { expect, test } from 'vitest';
import { createEngineRuleSet } from '../../engine';
import { GamePhase, PieceType } from '../../types';
import { stateKey } from '../transposition';
import { shouldRunSidecar, runRefutationSidecar } from '../boundedPlanRefutation';
import { makeFiniteDeadline } from '../deadlineContext';
import type { SearchAction } from '../searchTypes';
import {
  GAMES, LOG_SHA256, logSha, logText, parseTurnBlocks,
  restoreTurn, parsePlanLine, applyCatPlan, planText,
} from './hv19Roots';
import type { GameName } from './hv19Roots';

const rules = createEngineRuleSet();
const STARTED = 'refutationTriggered=true';

/** HV14 sidecar lines are indented; hv19Roots.field() is prefix-exact. */
function tfield(lines: string[], prefix: string): string {
  const l = lines.find((x) => x.trim().startsWith(prefix));
  return l ? l.trim().slice(prefix.length).trim() : '';
}

interface TurnRow {
  game: GameName;
  turn: number;
  difficulty: string;
  phase: string;
  player: string;
  cDepth: number;
  mainMs: number;
  plan: SearchAction[];
  planLabel: string;
  baselineLabel: string;
  finalLabel: string;
  mate: 'cat' | 'mouse' | null;
  eligible: boolean;
  started: boolean;
  candidates: number;
  baselineStatus: string | null;
  statuses: string[];
  overrideEligible: boolean;
  overrideUsed: boolean;
  source: string;
  cpuMs: number;
  wallMs: number;
  abort: string;
  execKey: string;
}

function parseStatuses(line: string): string[] {
  const m = /candidateStatuses=\[([^\]]*)\]/.exec(line);
  if (!m) return [];
  return m[1].split(',').map((s) => s.trim()).filter(Boolean);
}

function readTurns(): TurnRow[] {
  const rows: TurnRow[] = [];
  for (const game of GAMES) {
    for (const block of parseTurnBlocks(logText(game))) {
      const joined = block.lines.join('\n');
      const snap = JSON.parse(tfield(block.lines, 'SNAPSHOT_JSON='));
      const search = /SEARCH: cDepth=(\d+) aDepth=(\d+) nodes=(\d+) elapsedMs=([\d.]+)/.exec(joined);
      const root = /ROOT_VALUE=([-\d.]+) mate=(\w+)/.exec(joined);
      const refLine = block.lines.find((l) => l.trim().startsWith('REFUTATION:'));
      const ctrl = tfield(block.lines, 'overrideEligible=');
      const cost = /refutationCpuMs=([\d.]+) refutationWallMs=([\d.]+)/.exec(joined);
      const tail = tfield(block.lines, 'fallbackUsed=');
      const exec = /EXEC: endState=(\S+) matched=(\w+)/.exec(joined);
      if (!search || !root || !refLine || !cost || !tail || !exec) {
        throw new Error(`HV20 unparsed block ${game} T${block.turn}`);
      }
      const mate = root[2] === 'null' ? null : (root[2] as 'cat' | 'mouse');
      const plan = parsePlanLine(tfield(block.lines, 'PLAN:'));
      const eligible = shouldRunSidecar({
        difficulty: String(snap.config.difficulty),
        phase: snap.phase as GamePhase,
        currentPlayer: snap.currentPlayer as PieceType,
        baselinePlanLegal: Number(search[1]) >= 1 && plan.length > 0,
        baselineCompleted: Number(search[1]) >= 1,
        baselineMate: mate,
        enabled: true,
      });
      rows.push({
        game, turn: block.turn,
        difficulty: String(snap.config.difficulty),
        phase: snap.phase,
        player: snap.currentPlayer,
        cDepth: Number(search[1]),
        mainMs: Number(search[4]),
        plan,
        planLabel: planText(plan),
        baselineLabel: tfield(block.lines, 'BASELINE_PLAN=').replace(/[\[\]]/g, ''),
        finalLabel: tfield(block.lines, 'FINAL_PLAN=').replace(/[\[\]]/g, ''),
        mate,
        eligible,
        started: new RegExp(STARTED).test(refLine),
        candidates: Number(/candidateCount=(\d+)/.exec(refLine)?.[1] ?? 0),
        baselineStatus: /baselineProbeStatus=(\w+)/.exec(joined)?.[1] ?? null,
        statuses: parseStatuses(joined),
        overrideEligible: /overrideEligible=(\w+)/.exec(ctrl)?.[1] === 'true',
        overrideUsed: /overrideUsed=(\w+)/.exec(ctrl)?.[1] === 'true',
        source: /selectedPlanSource=(\w+)/.exec(ctrl)?.[1] ?? 'baseline',
        cpuMs: Number(cost[1]),
        wallMs: Number(cost[2]),
        abort: /sidecarAbortReason=(\w+)/.exec(tail)?.[1] ?? 'none',
        execKey: exec[1],
      });
    }
  }
  return rows;
}

const ROWS = readTurns();
const completed = ROWS.filter((r) => r.started && r.abort !== 'deadline');
const aborted = ROWS.filter((r) => r.abort === 'deadline');
const noClean = ROWS.filter((r) => r.abort === 'no_clean_candidate');
const notRefuted = ROWS.filter((r) => r.abort === 'baseline_not_refuted');
const mateBypass = ROWS.filter((r) => !r.started);

test('HV20-0 census: 45 turns, eligibility, sidecar outcomes', () => {
  for (const game of GAMES) expect(logSha(game), `${game} sha`).toBe(LOG_SHA256[game]);
  expect(ROWS.length).toBe(45);
  expect(ROWS.filter((r) => r.eligible).length).toBe(41);
  expect(ROWS.filter((r) => r.started).length).toBe(41);
  expect(ROWS.filter((r) => r.eligible).every((r) => r.started)).toBe(true);
  expect(mateBypass.length).toBe(4);
  expect(mateBypass.every((r) => r.mate !== null && !r.eligible)).toBe(true);
  expect(completed.length).toBe(29);
  expect(notRefuted.length).toBe(27);
  expect(noClean.length).toBe(2);
  expect(aborted.length).toBe(12);
  expect(aborted.every((r) => r.candidates === 6 && r.statuses.length === 0 && r.cpuMs === 0)).toBe(true);
  expect(ROWS.filter((r) => r.overrideUsed).length).toBe(0);
  expect(ROWS.filter((r) => r.source !== 'baseline').length).toBe(0);
  expect(ROWS.filter((r) => r.baselineLabel !== r.finalLabel).length).toBe(0);
  expect(ROWS.filter((r) => r.mainMs <= 100 || r.mainMs >= 110).length).toBe(0);

  const statusTotal = { R: 0, N: 0, C: 0, I: 0 };
  for (const r of ROWS) for (const s of r.statuses) {
    if (s === 'PLAN_REFUTED') statusTotal.R++;
    else if (s === 'NO_REFUTATION_FOUND') statusTotal.N++;
    else if (s === 'CHANCE_MIXED') statusTotal.C++;
    else statusTotal.I++;
  }
  // 41 started x 6 candidates = 246 selections, 72 of which belong to the
  // 12 selection-phase aborts that never produced a status.
  expect(statusTotal).toEqual({ R: 14, N: 141, C: 19, I: 0 });

  const rows = ROWS.map((r) => `${r.game}T${r.turn} d=${r.cDepth} main=${r.mainMs}`
    + ` elig=${r.eligible ? 1 : 0} start=${r.started ? 1 : 0} n=${r.candidates}`
    + ` base=${r.baselineStatus ?? '-'} st=${r.statuses.length ? r.statuses.map((s) => s[0]).join('') : '-'}`
    + ` override=${r.overrideUsed ? 1 : 0} abort=${r.abort} cpu=${r.cpuMs} wall=${r.wallMs}`
    + ` resid=${(150 - r.mainMs - r.wallMs).toFixed(1)} plan=${r.planLabel}`);
  // eslint-disable-next-line no-console
  console.log(`\nHV20-0 45-turn census\n  ${rows.join('\n  ')}`);
}, 120_000);

test('HV20-1 every logged executed plan replays legally to the logged EXEC endpoint', () => {
  const mismatches: string[] = [];
  for (const r of ROWS) {
    const block = parseTurnBlocks(logText(r.game)).find((b) => b.turn === r.turn)!;
    const restored = restoreTurn(r.game, block);
    const applied = applyCatPlan(restored.state, r.plan, rules);
    if (!applied.ok || stateKey(applied.end) !== r.execKey) {
      mismatches.push(`${r.game}T${r.turn} ok=${applied.ok} reason=${applied.reason}`
        + ` end=${stateKey(applied.end).slice(0, 24)} exec=${r.execKey.slice(0, 24)}`);
    }
  }
  // eslint-disable-next-line no-console
  console.log(`\nHV20-1 replay: 45 executed plans, mismatches=${mismatches.length}`
    + (mismatches.length ? `\n  ${mismatches.join('\n  ')}` : ''));
  expect(mismatches).toEqual([]);
}, 120_000);

test('HV20-2 two no_clean_candidate roots reproduce a bounded rejection certificate', () => {
  const out: string[] = [];
  for (const r of noClean) {
    const block = parseTurnBlocks(logText(r.game)).find((b) => b.turn === r.turn)!;
    const restored = restoreTurn(r.game, block);
    const search = /ROOT_VALUE=([-\d.]+) mate=/.exec(block.lines.join('\n'))!;
    const deadline = makeFiniteDeadline(performance.now() + 60_000);
    const res = runRefutationSidecar(restored.state, r.plan, Number(search[1]), {
      rules, deadline, enabled: true,
    });
    const d = res.diagnostics;
    out.push(`${r.game}T${r.turn} base=${d.baselineProbeStatus}`
      + ` statuses=[${d.candidateStatuses.join(',')}]`
      + ` overrideUsed=${d.overrideUsed} source=${d.selectedPlanSource}`
      + ` abort=${d.sidecarAbortReason} candidates=${d.candidateCount}`
      + ` witness=[${d.baselineRefutationWitness.join('')}]`
      + ` cpu=${d.refutationCpuMs} wall=${d.refutationWallMs}`);
    expect(d.baselineProbeStatus).toBe('PLAN_REFUTED');
    expect(d.candidateStatuses.filter((s) => s === 'PLAN_REFUTED').length).toBe(d.candidateCount);
    expect(d.overrideUsed).toBe(false);
    expect(d.selectedPlanSource).toBe('baseline');
    expect(d.baselineRefutationWitness.length).toBeGreaterThan(0);
    expect(JSON.stringify(res.plan)).toBe(JSON.stringify(r.plan));
  }
  // eslint-disable-next-line no-console
  console.log(`\nHV20-2 recovered rejection certificates (generous wall, probe caps unchanged)\n  ${out.join('\n  ')}`);
}, 180_000);

test('HV20-3 sidecar never changed the first action or the plan in HV14', () => {
  for (const r of ROWS) {
    expect(r.baselineLabel, `${r.game}T${r.turn}`).toBe(r.finalLabel);
  }
  // The five PLAN lines that start with a trap omit the production label's
  // leading 'P' (a label-convention artifact); the executed action list is
  // still the logged FINAL_PLAN, verified by HV20-1's endpoint replay.
  const trapFirst = ROWS.filter((r) => r.plan[0]?.type === 'catPlaceTrap');
  expect(trapFirst.length).toBe(4);
  // eslint-disable-next-line no-console
  console.log(`\nHV20-3 no plan/first-action change; trap-first plans=${trapFirst.map((r) => `${r.game}T${r.turn}`).join(',')}`);
}, 60_000);
