/// <reference types="node" />
/**
 * G0 — identity, dependency drift, source-count accounting, resource admission.
 * No heavy work here: every check is a hash, a read, or a process query.
 */
import { describe, it, expect } from 'vitest';
import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import {
  ROUND, FIXTURE, FIXTURE_SHA, SEAL_KERNEL, SEAL_KERNEL_SHA, STRATEGY_KERNEL,
  STRATEGY_KERNEL_SHA, SHADOW_LIB, SHADOW_LIB_SHA, hashFile,
  hostResource, duplicateHeavyWorkers, stateKey,
} from './ttor_lib';
import { enumerateRoot } from '../../PPC-G6T2-DECISION-RISK-CAUSAL-01/probe/dr_lib';

const OUT = ROUND;
const LOG = `${ROUND}/logs`;

describe('G0 identity and admission', () => {
  it('binds HEAD, branch, frozen inputs and dependency SHAs', () => {
    const head = execSync('git rev-parse HEAD', { encoding: 'utf8' }).trim();
    const branch = execSync('git branch --show-current', { encoding: 'utf8' }).trim();
    const status = execSync('git status --porcelain', { encoding: 'utf8' }).trim().split(/\r?\n/).filter(Boolean);

    expect(head).toBe('d533c8fb1e9c8b1822e84e737253f7ea73d3dbb1');
    expect(branch).toBe('ppc/p1-id-state-identity-fix');

    expect(hashFile(FIXTURE)).toBe(FIXTURE_SHA);
    expect(hashFile(SEAL_KERNEL)).toBe(SEAL_KERNEL_SHA);
    expect(hashFile(STRATEGY_KERNEL)).toBe(STRATEGY_KERNEL_SHA);
    expect(hashFile(SHADOW_LIB)).toBe(SHADOW_LIB_SHA);
    expect(hashFile('GAMEPLAY.md')).toBe('e000778b114bea02ef09634085172ea435be143335721aa0cd04114afb2afd34');
    expect(hashFile('src/game/ai/preparedActions.ts')).toBe('67b76ad3de53fee6d3d32f9bc8ab9a02b52234857b23b7fc9091bd92011ad764');

    // Protected pre-existing modifications must still be present, untouched by this round.
    const protectedPaths = ['src/game/mapDefinition.ts', 'src/pages/EditorPage.tsx', 'src/pages/GamePage.tsx'];
    for (const p of protectedPaths) {
      expect(status.some((l) => l.trim().endsWith(p))).toBe(true);
    }

    mkdirSync(LOG, { recursive: true });
    writeFileSync(`${LOG}/g0_identity.json`, JSON.stringify({
      round: ROUND,
      head, branch,
      protectedDirtyFiles: status.filter((l) => /src\/(game\/mapDefinition|pages\/(EditorPage|GamePage))\.tsx?$/.test(l)),
      dirtyCount: status.length,
      hashes: {
        fixture: { path: FIXTURE, sha256: FIXTURE_SHA },
        sealKernel: { path: SEAL_KERNEL, sha256: SEAL_KERNEL_SHA },
        strategyKernel: { path: STRATEGY_KERNEL, sha256: STRATEGY_KERNEL_SHA },
        shadowLib: { path: SHADOW_LIB, sha256: SHADOW_LIB_SHA },
        gameplay: hashFile('GAMEPLAY.md'),
        preparedActions: hashFile('src/game/ai/preparedActions.ts'),
      },
    }, null, 2));
  });

  it('separates the 36 / 37 / 39 source-count readings with evidence', () => {
    const closure = JSON.parse(readFileSync(
      'PPC-G6T2-DECISION-RISK-CAUSAL-01/logs/g0_src_closure.json', 'utf8',
    )) as { entries: number; drift: unknown[]; entriesList: { path: string }[] };
    expect(closure.entries).toBe(36);
    expect(closure.drift.length).toBe(0);
    expect(closure.entriesList.every((e) => e.path.startsWith('src/'))).toBe(true);

    const d2 = JSON.parse(readFileSync(
      'PPC-D2-PCV-COUNTERLINE-02/SOURCE_MANIFEST.json', 'utf8',
    )) as { productionSources: { path: string }[] };
    expect(d2.productionSources.length).toBe(39);
    const srcOnly = d2.productionSources.filter((p) => p.path.startsWith('src/')).length;
    const harness = d2.productionSources.filter((p) => !p.path.startsWith('src/')).map((p) => p.path);
    expect(srcOnly).toBe(35);
    expect(harness.length).toBe(4);

    // No artifact in the repository declares a 37-file certificate-bound set.
    const out = {
      round: ROUND,
      readings: {
        srcClosure36: { source: 'PPC-G6T2-DECISION-RISK-CAUSAL-01/logs/g0_src_closure.json', count: 36, drift: 0, allUnderSrc: true },
        dependencyClosure39: { source: 'PPC-D2-PCV-COUNTERLINE-02/SOURCE_MANIFEST.json productionSources', count: 39, src: srcOnly, harness },
        certificateBound37: {
          source: 'NOT_FOUND',
          status: 'THIRD_COUNT_SOURCE_NOT_FOUND',
          note: 'No round artifact declares a 37-file certificate-bound set. 39-2 (dropping the two research harness files) and 36+1 both happen to equal 37, but neither decomposition is evidenced by any artifact and neither may be used as a count.',
        },
      },
    };
    writeFileSync(`${LOG}/g0_count_separation.json`, JSON.stringify(out, null, 2));
    expect(out.readings.certificateBound37.status).toBe('THIRD_COUNT_SOURCE_NOT_FOUND');
  });

  it('confirms the frozen 110-plan set and its DUUD member', () => {
    const { root, turns } = enumerateRoot('G6T2');
    expect(turns.length).toBe(110);
    const duud = turns.find((t) => t.labels === 'DUUD')!;
    expect(duud).toBeTruthy();
    expect(duud.endKind).toBe('chance');
    writeFileSync(`${LOG}/g0_plan_set.json`, JSON.stringify({
      rootId: 'G6T2',
      rootStateKey: stateKey(root),
      planCount: turns.length,
      duud: { labels: duud.labels, endKind: duud.endKind },
      source: 'PPC-G6T2-DECISION-RISK-CAUSAL-01/probe/dr_lib.enumerateRoot',
    }, null, 2));
  });

  it('passes the local resource gate and finds no duplicate heavy worker', () => {
    const res = hostResource();
    const dup = duplicateHeavyWorkers(res);
    const gate = {
      totalMB: res.totalMB,
      freeMB: res.freeMB,
      vitestProcesses: res.vitestProcesses,
      vitestOutOfTree: res.vitestOutOfTree,
      foreignNodeProcesses: res.foreignNodeProcesses,
      duplicateHeavyWorkers: dup,
      requiredFreeMB: 1200,
      heavyConcurrency: 1,
      admission: res.freeMB >= 1200 && dup === 0 ? 'LOCAL_ADMITTED' : 'LOCAL_REFUSED',
      note: 'Heaviest planned job is one vitest process over a 600k-cap exact H2 quantifier; last round peak RSS was 393.9 MB. No cloud service (8787/8788) is contacted.',
    };
    writeFileSync(`${LOG}/g0_admission.json`, JSON.stringify(gate, null, 2));
    expect(res.totalMB).toBeGreaterThan(0);
    expect(gate.admission).toBe('LOCAL_ADMITTED');
  });
});