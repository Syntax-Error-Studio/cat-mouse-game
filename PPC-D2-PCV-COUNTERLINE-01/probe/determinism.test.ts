/// <reference types="node" />
/**
 * G5 — fresh-process determinism repetition for the D2 search itself.
 * Re-runs the identical fixed-depth D2 search and compares the deterministic
 * projection with the value frozen in CANDIDATE_FREEZE.json.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  runD2Search, extractCandidates, determinismProjection, writeJson,
  sha256, OUT,
} from './d2_lib';

describe('G5 search determinism', () => {
  it('G1T9/E1 second fresh run', () => {
    const freeze = JSON.parse(readFileSync(`${OUT}/CANDIDATE_FREEZE.json`, 'utf8')) as {
      determinismProjectionSha256: string;
    };
    const { root, ctx, run, prepared } = runD2Search();
    const extraction = extractCandidates(root, ctx, prepared, run.rootValues);
    const projection = determinismProjection({ run, extraction });
    const sha = sha256(projection);

    writeJson(`${OUT}/logs/d2_search_rep2.json`, {
      run,
      extraction: {
        legalRootActions: extraction.legalRootActions,
        extracted: extraction.extracted,
        rejected: extraction.rejected,
        rejectionByClass: extraction.rejectionByClass,
        plans: extraction.candidates.map((c) => [c.legalIndex, c.rootAction, c.planString, c.replayStatus]),
      },
      projectionSha256: sha,
      freezeProjectionSha256: freeze.determinismProjectionSha256,
      match: sha === freeze.determinismProjectionSha256,
    });

    console.log('--- SEARCH REP2 ---');
    console.log('nodes     =', run.nodes, 'leaf =', run.leafNodes, 'chance =', run.chanceNodes);
    console.log('value     =', run.value, 'completed =', run.completed);
    console.log('rootValues=', JSON.stringify(run.rootValues.map((r) => [r.action, r.value, r.mate])));
    console.log('extracted =', extraction.extracted, '/', extraction.legalRootActions);
    console.log('projectionMatch =', sha === freeze.determinismProjectionSha256);
    console.log('--- END ---');

    expect(sha).toBe(freeze.determinismProjectionSha256);
  });
});
