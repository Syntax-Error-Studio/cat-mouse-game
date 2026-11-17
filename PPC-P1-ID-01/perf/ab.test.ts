/// <reference types="node" />
/**
 * A/B phase: A = baseline (`cell.type[0]`), B = P1-ID candidate (injective
 * terrain code). Same fixed-work protocol, same roots, same warmup/order rules.
 */
import { it } from 'vitest';
import { repFromEnv, runRepetition } from './measure';
import { makeArm } from './adapt';
import * as engineA from './.arms/arm-base/game/engine';
import * as histA from './.arms/arm-base/game/ai/hardHistory';
import * as searchA from './.arms/arm-base/game/ai/expectiminimax';
import * as leafA from './.arms/arm-base/game/ai/correctedHoleLeaf';
import * as engineB from './.arms/arm-cand/game/engine';
import * as histB from './.arms/arm-cand/game/ai/hardHistory';
import * as searchB from './.arms/arm-cand/game/ai/expectiminimax';
import * as leafB from './.arms/arm-cand/game/ai/correctedHoleLeaf';

it('A/B repetition', () => {
  const rep = repFromEnv();
  runRepetition(makeArm('BASE', engineA, histA, searchA, leafA), makeArm('CAND', engineB, histB, searchB, leafB), rep);
}, 600_000);
