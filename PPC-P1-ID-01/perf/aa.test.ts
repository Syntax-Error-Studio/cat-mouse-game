/// <reference types="node" />
/**
 * A/A calibration: two byte-identical copies of the BASELINE source tree.
 * Must be run (and pass) before the A/B phase; see PREREGISTRATION_DRAFT
 * `timing.aa_validity_rule`.
 */
import { it } from 'vitest';
import { repFromEnv, runRepetition } from './measure';
import { makeArm } from './adapt';
import * as engineA from './.arms/arm-base/game/engine';
import * as histA from './.arms/arm-base/game/ai/hardHistory';
import * as searchA from './.arms/arm-base/game/ai/expectiminimax';
import * as leafA from './.arms/arm-base/game/ai/correctedHoleLeaf';
import * as engineB from './.arms/arm-base2/game/engine';
import * as histB from './.arms/arm-base2/game/ai/hardHistory';
import * as searchB from './.arms/arm-base2/game/ai/expectiminimax';
import * as leafB from './.arms/arm-base2/game/ai/correctedHoleLeaf';

it('A/A repetition', () => {
  const rep = repFromEnv();
  runRepetition(makeArm('BASE', engineA, histA, searchA, leafA), makeArm('BASE2', engineB, histB, searchB, leafB), rep);
}, 600_000);
