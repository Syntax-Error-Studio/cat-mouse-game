/**
 * PPC-P1-OPENING-STACK-01 — pre-fix baseline witness (READ ONLY).
 *
 * Establishes, on the REAL source, the four reference points the round brief
 * asks for:
 *   A. catBaseMoves=4      → normal opening, no exception
 *   B. catBaseMoves=1000   → normal opening, no exception
 *   C. catBaseMoves=100000 → config validates, but the fairness DFS blows the
 *                            JS call stack
 *   D. catBaseMoves=6004799503160661 → rejected at the config layer (the
 *                            numeric-safety contract from CHECKPOINT-01)
 *
 * It never asserts a pass/fail policy: it only records what the code does, so
 * the same file can be re-run after the fix and compared byte-for-byte.
 */
import { it } from 'vitest';
import { writeFileSync } from 'node:fs';
import { DEFAULT_CONFIG, validateGameConfig } from '../../src/game/config';
import { createInitialState } from '../../src/game/engine';
import { createGameState } from '../../src/game/newGame';
import { certifyOpening } from '../../src/game/openingFairness';

interface Row {
  catBaseMoves: number;
  validateOk: boolean;
  validateIssues: string[];
  createInitialState: string;
  certifyOpening: string;
  certifyVerdict?: string;
  certifyReason?: string;
  exploredNodes?: number;
  createGameState: string;
  createGameStateStatus?: string;
  errorName?: string;
  errorMessage?: string;
  topFrames?: string[];
  ms?: number;
}

function describeError(e: unknown): { name: string; message: string; frames: string[] } {
  const err = e as Error;
  const raw = String(err?.stack ?? e);
  const lines = raw.split('\n').slice(0, 6).map((l) => l.trim());
  return { name: String(err?.name ?? 'unknown'), message: String(err?.message ?? e), frames: lines };
}

const CASES = [4, 1000, 100000, 6004799503160661];
const PHASE = process.env.WITNESS_PHASE ?? 'pre';

it('baseline: opening fairness stack behaviour across the legal budget domain', () => {
  const rows: Row[] = [];
  for (const m of CASES) {
    const cfg = { ...DEFAULT_CONFIG, catBaseMoves: m };
    const v = validateGameConfig(cfg);
    const row: Row = {
      catBaseMoves: m,
      validateOk: v.ok,
      validateIssues: v.issues.map((i) => `${i.kind}:${i.message}`),
      createInitialState: 'not attempted',
      certifyOpening: 'not attempted',
      createGameState: 'not attempted',
    };
    const t0 = Date.now();
    try {
      const st = createInitialState(cfg);
      row.createInitialState = `ok catMovesLeft=${st.catMovesLeft} mouseMovesLeft=${st.mouseMovesLeft}`;
      try {
        const cert = certifyOpening(st);
        row.certifyOpening = 'ok';
        row.certifyVerdict = cert.verdict;
        row.certifyReason = cert.reason ?? null as unknown as string;
        row.exploredNodes = cert.exploredNodes;
      } catch (e) {
        const d = describeError(e);
        row.certifyOpening = `THROW ${d.name}: ${d.message}`;
        row.errorName = d.name;
        row.errorMessage = d.message;
        row.topFrames = d.frames;
      }
    } catch (e) {
      const d = describeError(e);
      row.createInitialState = `THROW ${d.name}: ${d.message}`;
      row.errorName = d.name;
      row.errorMessage = d.message;
      row.topFrames = d.frames;
    }
    try {
      const res = createGameState(cfg);
      row.createGameState = res.state ? 'ok(state)' : 'ok(state:null)';
      row.createGameStateStatus = res.status.kind + (res.status.kind === 'unverified' ? `:${res.status.reason}` : '');
    } catch (e) {
      const d = describeError(e);
      row.createGameState = `THROW ${d.name}: ${d.message}`;
      if (!row.errorName) {
        row.errorName = d.name;
        row.errorMessage = d.message;
        row.topFrames = d.frames;
      }
    }
    row.ms = Date.now() - t0;
    rows.push(row);
    console.log(
      `catBaseMoves=${m} validate=${row.validateOk} createInitialState=${row.createInitialState.slice(0, 40)}`
      + ` certify=${row.certifyOpening.slice(0, 60)} createGameState=${row.createGameState.slice(0, 60)}`
      + ` (${row.ms}ms)`,
    );
    if (row.topFrames) console.log('  frames: ' + row.topFrames.join(' | '));
  }
  writeFileSync(
    new URL(`../_raw/baseline_witness_${PHASE}.json`, import.meta.url),
    JSON.stringify({
      capturedAt: new Date().toISOString(),
      phase: PHASE,
      nodeVersion: process.version,
      heapUsedMB: Math.round(process.memoryUsage().heapUsed / 1048576),
      cases: rows,
    }, null, 2) + '\n',
  );
}, 600_000);
