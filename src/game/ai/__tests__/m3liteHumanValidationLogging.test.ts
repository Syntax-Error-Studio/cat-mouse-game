/**
 * G0.4F-2B-1.8 — M3-lite Progress-Guard human-validation LOGGING tests (D1-D7).
 *
 * Scope: PURE debug instrumentation — the copy-log header flag, the last-turn
 * [PROGRESS_GUARD] block, the per-turn compact history lines, the snapshot
 * round-trip intactness and the debug-only sanity hint. NO AI behavior change:
 * D7 re-asserts the frozen pre-1.8 production plan (Plan P26 authority, ULDR
 * at Game5 T15 with guard OFF) and that the planner debug object still exposes
 * progressGuard with enabled=false (the 1.6 planner contract).
 *
 * The copy-text header is driven by HARD_PROGRESS_GUARD_CONFIG.enabled — the
 * same function DebugInfo.tsx uses — so "toggle ON → header ON" is verified
 * at the single source of truth (no stale UI mirror). UI wiring is asserted
 * source-level (boardPieceAlignment precedent: no component-test infra).
 */
import { describe, it, expect, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { createEngineRuleSet, createInitialState, type GameEngineState } from '../../engine';
import { Difficulty, PieceType, GamePhase } from '../../types';
import { DEFAULT_CONFIG } from '../../config';
import type { SearchAction } from '../searchTypes';
import { planHardCatTurn } from '../hardTurnPlanner';
import { evaluateCorrectedHoleForCat } from '../correctedHoleLeaf';
import { setHardLeafMode } from '../hybridLeaf';
import { HARD_PROGRESS_GUARD_CONFIG } from '../searchConfig';
import { emptyProgressGuardMemory, type HardProgressGuardMemory } from '../progressGuard';
import { captureHardRoot, restoreHardRoot, makeHardHistoryEntry, hardHistorySnapshotJson, type HardRootSnapshot } from '../hardHistory';
import {
  progressGuardHeaderLine, formatProgressGuardBlock, formatHistoryProgressGuard, progressGuardMemoryMissing,
  type ProgressGuardLogFields,
} from '../progressGuardLog';

const rules = createEngineRuleSet();
const label = (a: SearchAction): string => a.type === 'catStep' ? a.direction!.key.slice(5)[0] : a.type === 'catPlaceTrap' ? 'T' : '?';

/** Full 16-field sample guard diag (structurally == ProgressGuardDebug/Diag). */
function sampleGuard(): ProgressGuardLogFields {
  return {
    enabled: true, eligible: true, previousNoProgressLoop: true, currentNoProgressLoop: true,
    signatureMatch: true, mouseTurnObserved: true, triggered: true, previousCompletedDepth: 1,
    previousCompletedPlan: 'DDLD', originalPlan: 'ULDR', rescuePlan: 'DDLD',
    exactImmediateMouseWins: 0, rescueProbeStatus: 'NO_REFUTATION_FOUND',
    rescueApplied: true, abortReason: 'none', guardMs: 17.25,
  };
}

/** Game5 T15 root from the F2B-1.4 parsed-log SNAPSHOT authority. */
function game5Root(turn: number): GameEngineState {
  const parsed = JSON.parse(readFileSync('ai-training/f2b14/parsed_log.json', 'utf8'));
  const rec = parsed.turns.find((x: { turn: number; snapshotJson?: string }) => x.turn === turn && x.snapshotJson);
  expect(rec).toBeTruthy();
  return restoreHardRoot(JSON.parse(rec.snapshotJson));
}

/** Minimal full GameEngineState (default board) for snapshot round-trip tests. */
function canonState(): GameEngineState {
  const s = createInitialState({ ...DEFAULT_CONFIG, difficulty: Difficulty.Hard } as Parameters<typeof createInitialState>[0]);
  return {
    ...s,
    currentPlayer: PieceType.Cat,
    phase: GamePhase.Playing,
    catMovesLeft: s.config.catBaseMoves,
    mouseMovesLeft: s.config.mouseBaseMoves,
  };
}

describe('G0.4F-2B-1.8 M3-lite human-validation logging', () => {
  afterAll(() => {
    HARD_PROGRESS_GUARD_CONFIG.enabled = false;
    setHardLeafMode('baseline');
  });

  it('D1: header OFF by default — config default false and header line reads config', () => {
    expect(HARD_PROGRESS_GUARD_CONFIG.enabled).toBe(false);
    expect(progressGuardHeaderLine(HARD_PROGRESS_GUARD_CONFIG.enabled)).toBe('PROGRESS_GUARD=OFF');
    expect(progressGuardHeaderLine(false)).toBe('PROGRESS_GUARD=OFF');
  });

  it('D2: toggle ON → header ON; toggle OFF → OFF (single source of truth)', () => {
    HARD_PROGRESS_GUARD_CONFIG.enabled = true;
    expect(progressGuardHeaderLine(HARD_PROGRESS_GUARD_CONFIG.enabled)).toBe('PROGRESS_GUARD=ON');
    expect(progressGuardHeaderLine(true)).toBe('PROGRESS_GUARD=ON');
    HARD_PROGRESS_GUARD_CONFIG.enabled = false;
    expect(progressGuardHeaderLine(HARD_PROGRESS_GUARD_CONFIG.enabled)).toBe('PROGRESS_GUARD=OFF');
  });

  it('D2b (source): DebugInfo copy header + sanity are driven by the real config, not the UI mirror', () => {
    const src = readFileSync('src/components/DebugInfo.tsx', 'utf8');
    // Header line reads HARD_PROGRESS_GUARD_CONFIG.enabled directly (§2).
    expect(src).toMatch(/progressGuardHeaderLine\(HARD_PROGRESS_GUARD_CONFIG\.enabled\)/);
    // The last-turn block is fed from lastHardSearch.progressGuard (§3).
    expect(src).toMatch(/formatProgressGuardBlock\(hardSearch\?\.progressGuard\)/);
    // History compact lines are appended per turn from production.progressGuard (§4).
    expect(src).toMatch(/e\.production\.progressGuard \? formatHistoryProgressGuard/);
    // §7 sanity reads the real config + memory prop (a hint, never a state fix).
    expect(src).toMatch(/progressGuardMemoryMissing\(/);
    expect(src).toMatch(/hardProgressGuardMemory/);
  });

  it('D2c (source): GamePage passes the live memory to DebugInfo', () => {
    const src = readFileSync('src/pages/GamePage.tsx', 'utf8');
    expect(src).toMatch(/hardProgressGuardMemory=\{debugState\.hardProgressGuardMemory\}/);
  });

  it('D3: last-search [PROGRESS_GUARD] block prints all 16 fields; (none) when absent', () => {
    const pg = sampleGuard();
    const block = formatProgressGuardBlock(pg);
    expect(block).toContain('[PROGRESS_GUARD]');
    for (const k of [
      'enabled=', 'eligible=', 'previousNoProgressLoop=', 'currentNoProgressLoop=',
      'signatureMatch=', 'mouseTurnObserved=', 'triggered=', 'previousCompletedDepth=',
      'previousCompletedPlan=', 'originalPlan=', 'rescuePlan=', 'exactImmediateMouseWins=',
      'rescueProbeStatus=', 'rescueApplied=', 'abortReason=', 'guardMs=',
    ]) {
      expect(block).toContain(k);
    }
    // Values round-trip.
    expect(block).toContain('enabled=true');
    expect(block).toContain('previousCompletedDepth=1');
    expect(block).toContain('originalPlan=ULDR');
    expect(block).toContain('rescueProbeStatus=NO_REFUTATION_FOUND');
    expect(block).toContain('guardMs=17.3');
    // Absent → (none).
    expect(formatProgressGuardBlock(undefined)).toBe('[PROGRESS_GUARD]\n(none)');
    expect(formatProgressGuardBlock(null)).toBe('[PROGRESS_GUARD]\n(none)');
  });

  it('D4: history per-turn compact block uses the §4 names; empty when absent', () => {
    const pg = sampleGuard();
    const lines = formatHistoryProgressGuard(pg);
    expect(lines[0]).toBe('PROGRESS_GUARD:');
    for (const k of [
      'enabled=', 'eligible=', 'prevNoProgress=', 'currentNoProgress=', 'sigMatch=',
      'mouseObserved=', 'triggered=', 'previousDepth=', 'previousPlan=', 'original=',
      'rescue=', 'mouseWins=', 'probe=', 'applied=', 'abort=',
    ]) {
      expect(lines.some((l) => l.startsWith('  ' + k))).toBe(true);
    }
    expect(lines.some((l) => l === '  abort=none')).toBe(true);
    expect(lines.some((l) => l === '  triggered=true')).toBe(true);
    expect(formatHistoryProgressGuard(undefined)).toEqual([]);
    expect(formatHistoryProgressGuard(null)).toEqual([]);
  });

  it('D5: SNAPSHOT_JSON semantics unchanged — hardProgressGuardMemory still round-trips exactly', () => {
    const mem: HardProgressGuardMemory = {
      version: 1, previousNoProgressLoop: true,
      previousSignature: { catStart: '4,8', catEnd: '4,8', plan: 'URDL', boxHash: 'X', trap: '1,1' },
      previousPlanLabel: 'URDL', previousCatStart: '4,8', previousCatEnd: '4,8',
      mouseTurnObserved: true, previousRootKey: 'k1', previousEndKey: '4,8',
    };
    const state = { ...canonState(), hardProgressGuardMemory: mem };
    const snap = captureHardRoot(state);
    expect(snap.hardProgressGuardMemory).toEqual(mem);
    const entry = makeHardHistoryEntry(state, 1, {
      completedDepth: 2, attemptedDepth: 2, nodes: 1, elapsedMs: 1,
      rootValue: 0, mate: null, plan: [], rootValues: [],
      progressGuard: sampleGuard(),
    });
    const json = hardHistorySnapshotJson(entry);
    expect(json).toContain('"hardProgressGuardMemory"');
    const parsed = JSON.parse(json) as HardRootSnapshot;
    expect(parsed.hardProgressGuardMemory).toEqual(mem);
    expect(restoreHardRoot(parsed).hardProgressGuardMemory).toEqual(mem);
  });

  it('D6: debug export helpers never mutate config or a frozen state/diag', () => {
    const cfgBefore = HARD_PROGRESS_GUARD_CONFIG.enabled;
    const pg = sampleGuard();
    const frozenPg = Object.freeze({ ...pg });
    // Frozen diag object would throw on any write in strict mode; helpers must not touch it.
    const block = formatProgressGuardBlock(frozenPg);
    const lines = formatHistoryProgressGuard(frozenPg);
    const header = progressGuardHeaderLine(HARD_PROGRESS_GUARD_CONFIG.enabled);
    expect(block).toContain('enabled=true');
    expect(lines.length).toBeGreaterThan(0);
    expect(header).toBe('PROGRESS_GUARD=OFF');
    // Config untouched.
    expect(HARD_PROGRESS_GUARD_CONFIG.enabled).toBe(cfgBefore);
    // Diag object deep-equal (no in-place mutation).
    expect(frozenPg).toEqual(pg);
    // Sanity predicate is read-only.
    const mem = { ...emptyProgressGuardMemory() };
    expect(progressGuardMemoryMissing(true, true, null)).toBe(true);
    expect(progressGuardMemoryMissing(true, true, mem)).toBe(false);
    expect(progressGuardMemoryMissing(false, true, null)).toBe(false);
    expect(progressGuardMemoryMissing(true, false, null)).toBe(false);
  });

  it('D7: production AI plan unchanged with guard OFF (frozen pre-1.8 authority, P26 settings)', () => {
    HARD_PROGRESS_GUARD_CONFIG.enabled = false;
    setHardLeafMode('baseline_hole_corrected');
    const root = game5Root(15);
    const p = planHardCatTurn(root, {
      rules, timeBudgetMs: 600000, maxDepthTurns: 2, maxNodes: 2_000_000,
      leafEvaluator: evaluateCorrectedHoleForCat, refutation: { enabled: false },
    });
    // Frozen P26 authority: plan == ULDR, guard debug present with enabled=false.
    expect(p.plan.map(label).join('')).toBe('ULDR');
    expect(p.debug.progressGuard?.enabled).toBe(false);
    // The captured diag structurally fits the log formatter.
    const pg = p.debug.progressGuard as ProgressGuardLogFields | undefined;
    expect(pg).toBeTruthy();
    const block = formatProgressGuardBlock(pg);
    expect(block).toContain('enabled=false');
    expect(block).toContain('abortReason=disabled');
    // History passthrough (engine path) renders compact lines.
    const hist = formatHistoryProgressGuard(pg);
    expect(hist[0]).toBe('PROGRESS_GUARD:');
    expect(hist.some((l) => l === '  enabled=false')).toBe(true);
    // Guard flag ON without memory still cannot change the plan (no trigger).
    HARD_PROGRESS_GUARD_CONFIG.enabled = true;
    const pOn = planHardCatTurn(root, {
      rules, timeBudgetMs: 600000, maxDepthTurns: 2, maxNodes: 2_000_000,
      leafEvaluator: evaluateCorrectedHoleForCat, refutation: { enabled: false },
    });
    expect(pOn.plan.map(label).join('')).toBe('ULDR');
    HARD_PROGRESS_GUARD_CONFIG.enabled = false;
  });

  it('D7b (source): engine history passthrough passes planned.debug.progressGuard', () => {
    const src = readFileSync('src/game/engine.ts', 'utf8');
    expect(src).toMatch(/progressGuard:\s*planned\.debug\.progressGuard/);
    const history = readFileSync('src/game/ai/hardHistory.ts', 'utf8');
    expect(history).toMatch(/progressGuard\?: ProgressGuardDiag/);
  });
});