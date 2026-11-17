/// <reference types="node" />
/**
 * PPC-P1-CLOSURE-01 / P4-A — is the measured +5% on the T1E-B exhaustive search
 * attributable to P1-ID's hardened `stateKey`?
 *
 * READ-ONLY, diagnostic only (not a benchmark authority). Times `stateKey` from
 * the CURRENT tree and from the frozen HEAD arm on the same state object shape,
 * same process, alternating blocks to cancel drift.
 *
 * Emits PPC-P1-CLOSURE-01/_raw/statekey_micro.json.
 */
import { test } from 'vitest';
import { writeFileSync, readFileSync } from 'node:fs';
import { stateKey as keyNow } from '../../src/game/ai/transposition';
import { stateKey as keyHead } from '../arm-head/src/game/ai/transposition';
import { restoreHardRoot, type HardRootSnapshot } from '../../src/game/ai/hardHistory';
import type { GameEngineState } from '../../src/game/engine';

const OUT = new URL('../_raw/statekey_micro.json', import.meta.url);
const LOG = new URL('../../ai-training/human-logs/PPC-HV14/GAME2_H1.txt', import.meta.url);

function rootState(turn: number): GameEngineState {
  const lines = readFileSync(LOG, 'utf8').split(/\r?\n/);
  const starts: number[] = [];
  lines.forEach((l, i) => {
    if (/^Turn #\d+$/.test(l.trim())) starts.push(i);
  });
  const idx = starts.findIndex((s) => Number(/^Turn #(\d+)$/.exec(lines[s].trim())![1]) === turn);
  const block = lines.slice(starts[idx], idx + 1 < starts.length ? starts[idx + 1] : lines.length);
  return restoreHardRoot(
    JSON.parse(block.find((l) => l.startsWith('SNAPSHOT_JSON='))!.slice('SNAPSHOT_JSON='.length)) as HardRootSnapshot,
  );
}

/** Total wall time of `n` calls, discarding the first 20% as warm-up. */
function timeIt(fn: (s: GameEngineState) => string, s: GameEngineState, n: number): number {
  const warm = Math.floor(n * 0.2);
  for (let i = 0; i < warm; i++) fn(s);
  const t0 = performance.now();
  let sink = 0;
  for (let i = 0; i < n - warm; i++) sink += fn(s).length;
  const dt = performance.now() - t0;
  if (sink < 0) throw new Error('unreachable');
  return dt / (n - warm);
}

test('P4-A stateKey micro-cost, current vs HEAD arm', () => {
  const s = rootState(4);
  const N = 60_000;
  const median = (xs: number[]): number => xs.slice().sort((a, b) => a - b)[Math.floor(xs.length / 2)];

  const nowRuns: number[] = [];
  const headRuns: number[] = [];
  // Alternate blocks so CPU drift cannot favour one arm.
  for (let round = 0; round < 5; round++) {
    nowRuns.push(timeIt(keyNow, s, N));
    headRuns.push(timeIt(keyHead, s, N));
  }

  // The two keys must still be semantically interchangeable on this state.
  const out = {
    state: 'GAME2 T4 root (PPC-HV14 log)',
    callsPerSample: N,
    samples: 5,
    current: {
      medianUsPerCall: median(nowRuns) * 1000,
      samplesUs: nowRuns.map((x) => x * 1000),
      keyLength: keyNow(s).length,
    },
    head: {
      medianUsPerCall: median(headRuns) * 1000,
      samplesUs: headRuns.map((x) => x * 1000),
      keyLength: keyHead(s).length,
    },
    ratioCurrentOverHead: median(nowRuns) / median(headRuns),
    notes: [
      'DIAGNOSTIC ONLY — not a formal benchmark; no repetition floor, no CI.',
      'The two key strings are not expected to be identical (P1-ID deliberately widened the identity encoding).',
    ],
  };
  writeFileSync(OUT, JSON.stringify(out, null, 2), 'utf8');
  console.log(JSON.stringify(out, null, 2));
}, 300_000);
