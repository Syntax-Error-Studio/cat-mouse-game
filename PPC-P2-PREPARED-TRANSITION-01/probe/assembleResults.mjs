#!/usr/bin/env node
/**
 * PPC-P2-PREPARED-TRANSITION-01 — assemble the named deliverables.
 *
 * Each named file is the measured data plus a `_provenance` block naming the raw
 * file it came from and that file's sha256, so a reader can prove the published
 * number was not edited on the way out.
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const sha = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');

const pairs = [
  ['_raw/duplicate_witness_pre.json', 'BASELINE_DUPLICATE_SIMULATION.json', 'Pre-fix duplicate simulation witness, captured on the unmodified P1 tree.'],
  ['_raw/duplicate_witness_post.json', 'CANDIDATE_DUPLICATE_SIMULATION.json', 'Same probe after the fix (same file, PHASE=post).'],
  ['_raw/transition_semantics.json', 'TRANSITION_SEMANTIC_RESULTS.json', 'Prepared-vs-fresh transition parity over the 24 roots.'],
  ['_raw/d1_parity.json', 'FIXED_D1_PARITY_RESULTS.json', 'Fixed-D1 24-root field-by-field parity vs the frozen artifact and vs the baseline arm.'],
  ['_raw/special_rule_replay.json', 'SPECIAL_RULE_REPLAY_RESULTS.json', '20 special-rule paths replayed on the real engine.'],
  ['_raw/deadline_integration_repeat.json', 'DEADLINE_INTEGRATION_RESULTS.json', 'Full production cat turn at 100 ms / 150 ms, both arms, repeated 5x (diagnostic only; the gate is not reproducible so the variance is the deliverable).'],
  ['_raw/AA_AGGREGATE_aa.json', 'AA_CALIBRATION_RESULTS.json', '20 fresh A/A repetitions (both arms = frozen baseline).'],
  ['_raw/AB_AGGREGATE_ab.json', 'AB_PERFORMANCE_RESULTS.json', '20 fresh A/B repetitions (A = frozen baseline, B = candidate).'],
];

const root = 'PPC-P2-PREPARED-TRANSITION-01/';
for (const [raw, named, what] of pairs) {
  if (!existsSync(root + raw)) { console.log('SKIP (missing)', raw); continue; }
  const data = JSON.parse(readFileSync(root + raw, 'utf8'));
  const out = {
    _provenance: {
      round: 'PPC-P2-PREPARED-TRANSITION-01',
      rawFile: raw,
      rawSha256: sha(root + raw),
      what,
      note: 'This file is the raw measurement plus this provenance block. No value was edited.',
    },
    ...data,
  };
  writeFileSync(root + named, `${JSON.stringify(out, null, 2)}\n`);
  console.log('wrote', named, '<-', raw, sha(root + raw).slice(0, 12));
}
