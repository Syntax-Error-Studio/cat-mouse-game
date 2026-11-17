/// <reference types="node" />
/**
 * Smoke probe: one fixed-depth D2 search on G1T9/E1 with the strict config.
 * Prints node counts, timing and root-value alignment so we know the cost
 * BEFORE committing to full candidate extraction.
 */
import { describe, it } from 'vitest';
import { runD2Search, OUT, writeJson } from './d2_lib';

describe('D2 smoke', () => {
  it('G1T9/E1 fixed depth 2', () => {
    const t0 = performance.now();
    const { run, root } = runD2Search();
    const wall = Number((performance.now() - t0).toFixed(1));

    console.log('--- D2 SMOKE ---');
    console.log('rootStateKey      =', run.rootStateKey);
    console.log('legalRootActions  =', run.legalRootActionCount);
    console.log('rootValuesLength  =', run.rootValuesLength);
    console.log('rootOrderAligned  =', run.rootOrderAligned);
    console.log('completed         =', run.completed);
    console.log('value             =', run.value, 'mate =', run.mate);
    console.log('nodes             =', run.nodes);
    console.log('leafNodes         =', run.leafNodes);
    console.log('chanceNodes       =', run.chanceNodes);
    console.log('searchMs          =', run.elapsedMs, 'wallMs =', wall);
    console.log('planBranchEntries =', run.planBranchEntries);
    console.log('diagnostics       =', JSON.stringify(run.diagnostics));
    console.log('gates             =', JSON.stringify(run.gates));
    console.log('rootValues        =', JSON.stringify(run.rootValues));
    console.log('catMovesLeft      =', root.catMovesLeft, 'mouseMovesLeft =', root.mouseMovesLeft);
    console.log('--- END ---');

    writeJson(`${OUT}/logs/d2_smoke.json`, { run, wallMs: wall });
  });
});
