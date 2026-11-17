/**
 * PPC-P1-OPENING-STACK-01 — where exactly does the recursion die? (pre-fix)
 *
 * The node cap is 20000, so the DFS *may* legitimately reach depth 20000. The
 * JS call stack cannot. This probe brackets the real threshold with
 * `certifyOpening` only (one run per budget, no generation retries) so the
 * mechanism can be stated as a number instead of a guess.
 */
import { it } from 'vitest';
import { writeFileSync } from 'node:fs';
import { DEFAULT_CONFIG } from '../../src/game/config';
import { createInitialState } from '../../src/game/engine';
import { certifyOpening } from '../../src/game/openingFairness';

const BUDGETS = [500, 1000, 1500, 2000, 2500, 3000, 4000, 6000, 20000, 100000];
const PHASE = process.env.WITNESS_PHASE ?? 'pre';

it('bracket the stack-overflow depth of the recursive fairness DFS', () => {
  const rows: Record<string, unknown>[] = [];
  for (const m of BUDGETS) {
    const cfg = { ...DEFAULT_CONFIG, catBaseMoves: m };
    const t0 = Date.now();
    let outcome: string;
    let detail: Record<string, unknown> = {};
    try {
      const st = createInitialState(cfg);
      const cert = certifyOpening(st);
      outcome = 'COMPLETED';
      detail = {
        verdict: cert.verdict,
        reason: cert.reason ?? null,
        exploredNodes: cert.exploredNodes,
        prunedNodes: cert.prunedNodes,
      };
    } catch (e) {
      const err = e as Error;
      outcome = `THROW ${err.name}`;
      detail = { message: String(err.message).slice(0, 80) };
    }
    const ms = Date.now() - t0;
    rows.push({ catBaseMoves: m, outcome, ms, ...detail });
    console.log(`M=${m} ${outcome} ${JSON.stringify(detail)} ${ms}ms`);
  }
  writeFileSync(
    new URL(`../_raw/stack_threshold_${PHASE}.json`, import.meta.url),
    JSON.stringify({ capturedAt: new Date().toISOString(), phase: PHASE, nodeVersion: process.version, rows }, null, 2) + '\n',
  );
}, 900_000);
