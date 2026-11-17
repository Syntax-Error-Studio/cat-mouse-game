/// <reference types="node" />
/** Isolated `stateKey` cost attribution across encoder variants. */
import { it } from 'vitest';
import { readFileSync } from 'node:fs';
import { stateKey as baseKey } from './.arms/arm-base/game/ai/transposition';
import { stateKey as candKey } from './.arms/arm-v1/game/ai/transposition';
import { stateKey as cand2Key } from './.arms/arm-cand/game/ai/transposition';
import { restoreHardRoot } from './.arms/arm-base/game/ai/hardHistory';

const roots = JSON.parse(readFileSync(new URL('../../src/game/ai/__tests__/fixtures/ppcId01-human-roots.json', import.meta.url), 'utf8'));
const ARMS = { base: baseKey, ownprop: candKey, switch: cand2Key } as const;

it('stateKey microbenchmark', () => {
  const states = roots.slice(0, 8).map((r: { state: unknown }) => restoreHardRoot(r.state));
  const N = 20000;
  const rows: string[] = [];
  // round-robin the three arms so drift affects all equally
  for (let round = 0; round < 6; round++) {
    for (const name of Object.keys(ARMS) as (keyof typeof ARMS)[]) {
      const fn = ARMS[name];
      for (let i = 0; i < 2000; i++) fn(states[i % states.length]);
      const t0 = performance.now();
      for (let i = 0; i < N; i++) fn(states[i % states.length]);
      const ms = performance.now() - t0;
      rows.push(`round=${round} ${name} ${((ms * 1000) / N).toFixed(3)}us/call`);
    }
  }
  console.log('PPC_MICRO ' + JSON.stringify(rows));
}, 900_000);
