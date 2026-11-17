/// <reference types="node" />
/**
 * PPC-P2-PREPARED-TRANSITION-01 — one fresh-process measurement of the frozen
 * D1 protocol over the 24 human roots.
 *
 * Environment:
 *   ARM    = baseline | candidate          (which source tree to import)
 *   ROLE   = A | B                         (label only)
 *   REP    = repetition index
 *   SWEEPS = how many times the 24-root sweep is repeated INSIDE this process
 *            (measurement-window amplification; the workload per sweep is the
 *            frozen D1 protocol and is identical for both arms)
 *
 * The process is expected to be launched once, run its sweeps, write one JSON
 * file and exit — the driver never runs two of these concurrently.
 */
import { it } from 'vitest';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';

const ARM = process.env.ARM ?? 'candidate';
const ROLE = process.env.ROLE ?? 'A';
const REP = Number(process.env.REP ?? '0');
const SWEEPS = Math.max(1, Number(process.env.SWEEPS ?? '5'));
const OUT_DIR = 'PPC-P2-PREPARED-TRANSITION-01/_raw/bench';
const RUN = process.env.RUN ?? 'run';
const OUT = `${OUT_DIR}/${RUN}_${ROLE.toLowerCase()}_${String(REP).padStart(2, '0')}_${ARM}.json`;

const ROOT_FIXTURE = new URL('../../src/game/ai/__tests__/fixtures/ppcId01-human-roots.json', import.meta.url);
const ROOT_FIXTURE_SHA256 = '1a59787adb6669e1cf287d019313dadf4636a4310eed7b3de5236f4778e0db09';

interface RootRecord { id: string; state: unknown; canonicalSnapshotSha256: string }
type ArmRootResult = ReturnType<typeof import('./armEntry.candidate').runRoot>;

it(`D1 arm sweep (${ARM})`, async () => {
  const mod = ARM === 'baseline'
    ? await import('./armEntry.baseline')
    : await import('./armEntry.candidate');

  const raw = readFileSync(ROOT_FIXTURE);
  const sha = createHash('sha256').update(raw).digest('hex');
  if (sha !== ROOT_FIXTURE_SHA256) throw new Error(`root fixture sha mismatch: ${sha}`);
  const records = JSON.parse(raw.toString('utf8')) as RootRecord[];

  // Restore once; the search provably does not mutate its input (asserted in the
  // candidate suite), so the same objects can be reused across sweeps.
  const roots = records.map((r) => ({ id: r.id, state: mod.restore(r.state) }));

  const sweepTotalMs: number[] = [];
  const perRootMs: number[][] = roots.map(() => []);
  let snapshot: ArmRootResult[] = [];

  for (let s = 0; s < SWEEPS; s++) {
    let total = 0;
    const row: ArmRootResult[] = [];
    for (let i = 0; i < roots.length; i++) {
      const r = mod.runRoot(roots[i].id, roots[i].state);
      perRootMs[i].push(r.ms);
      total += r.ms;
      row.push(r);
    }
    sweepTotalMs.push(total);
    if (s === 0) snapshot = row;
  }

  const sorted = [...sweepTotalMs].sort((a, b) => a - b);
  const medianSweepMs = sorted[Math.floor(sorted.length / 2)];
  const mem = process.memoryUsage();

  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(OUT, `${JSON.stringify({
    run: RUN,
    arm: ARM,
    role: ROLE,
    rep: REP,
    sweeps: SWEEPS,
    rootFixtureSha256: sha,
    protocol: { depthTurns: 1, maxNodes: 10000, tt: true, alphaBeta: true, moveOrdering: true, capturePlan: true, leaf: 'evaluateCorrectedHoleForCat', deadline: null },
    sweepTotalMs,
    medianSweepMs,
    minSweepMs: sorted[0],
    maxSweepMs: sorted[sorted.length - 1],
    process: {
      node: process.version,
      rssBytes: mem.rss,
      heapUsedBytes: mem.heapUsed,
      maxRssKb: process.resourceUsage().maxRSS,
      uptimeSec: process.uptime(),
    },
    roots: snapshot.map((r, i) => ({ ...r, msBySweep: perRootMs[i] })),
  }, null, 2)}\n`);

  // eslint-disable-next-line no-console
  console.log(`[${ROLE} rep=${REP} arm=${ARM}] medianSweep=${medianSweepMs.toFixed(2)}ms sweeps=${sweepTotalMs.map((m) => m.toFixed(1)).join(',')}`);
});
