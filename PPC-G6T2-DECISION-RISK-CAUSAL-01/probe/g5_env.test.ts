// G5 — measurement provenance and resource safety for the shadow instrument.
// Reads this round's artifacts (does not re-run heavy work) and records the
// environment the timings came from. Windows numbers are NOT cloud numbers and
// are NOT evidence for the 100ms production budget.
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import { ROUND, readJson, writeJson, fileSha } from './dr_lib';

const ART = `${ROUND}`;

interface Cost {
  enumerateMs: number | null;
  oneTurnMs?: number;
  staticReachMs?: number;
  twoTurnMs?: number;
  riskMs: number;
  rssBeforeMB?: number;
  rssAfterMB?: number;
  peakRssMB?: number;
  oneTurnNodes?: number;
}

interface Row {
  rootId: string;
  plan: string;
  twoTurn: { label: string; nodes: number; truncated: boolean; elapsedMs: number; witnessMs?: number };
  oneTurn: { nodes: number; truncated: boolean; forcedWinThisTurn: boolean | null } | null;
  staticReach: { reachable: boolean | null; nodes: number; truncated: boolean };
  cost: Cost;
}

function rowsFrom(file: string): Row[] {
  const j = readJson(`${ART}/${file}`);
  return (j.plans ?? j.rows) as Row[];
}

function summarize(rows: Row[]) {
  return rows.map((r) => ({
    rootId: r.rootId,
    plan: r.plan,
    twoTurnLabel: r.twoTurn.label,
    twoTurnNodes: r.twoTurn.nodes,
    twoTurnWitnessMs: r.twoTurn.witnessMs ?? 0,
    twoTurnTruncated: r.twoTurn.truncated,
    oneTurnNodes: r.oneTurn?.nodes ?? r.cost.oneTurnNodes ?? null,
    oneTurnTruncated: r.oneTurn?.truncated ?? null,
    staticReachTruncated: r.staticReach.truncated,
    staticReachReachable: r.staticReach.reachable,
    cost: r.cost,
  }));
}

describe('G5 provenance / resource log', () => {
  it('records environment, costs, caps and duplicate-process state', () => {
    const g6t2 = summarize(rowsFrom('TACTICAL_RISK_WITNESSES.json'));
    const cross = summarize(rowsFrom('CROSS_ROOT_SHADOW_RESULTS.json'));
    const all = [...g6t2, ...cross];

    const totalRiskMs = all.reduce((a, r) => a + (r.cost?.riskMs ?? 0), 0);
    const maxTwoTurnNodes = Math.max(...all.map((r) => r.twoTurnNodes));
    const peakRssMB = Math.max(...all.map((r) => r.cost?.peakRssMB ?? r.cost?.rssAfterMB ?? 0));
    const maxTwoTurnMs = Math.max(...all.map((r) => r.cost?.twoTurnMs ?? r.twoTurn.elapsedMs));

    let processes: string[] = [];
    try {
      const raw = execFileSync('powershell', ['-NoProfile', '-Command',
        "Get-Process node,vitest -ErrorAction SilentlyContinue | Select-Object Id,ProcessName,WorkingSet64 | ConvertTo-Json -Compress"],
        { encoding: 'utf8' });
      const parsed = raw.trim() ? JSON.parse(raw) : [];
      processes = (Array.isArray(parsed) ? parsed : [parsed]).map((p: { ProcessName: string; Id: number; WorkingSet64: number }) => `${p.ProcessName}#${p.Id}:${Math.round(p.WorkingSet64 / 1048576)}MB`);
    } catch { processes = ['probe-unavailable']; }

    const out = {
      round: ROUND,
      phase: 'G5_PROVENANCE_RESOURCE',
      generatedAt: new Date().toISOString(),
      environment: {
        platform: process.platform,
        arch: process.arch,
        osRelease: os.release(),
        node: process.version,
        cpu: os.cpus()[0]?.model ?? 'unknown',
        cpuCount: os.cpus().length,
        totalMemMB: Math.round(os.totalmem() / 1048576),
        freeMemMBAtStart: Math.round(os.freemem() / 1048576),
        measurementSource: 'WINDOWS_LOCAL_WORKSTATION',
        cloud: false,
        provenanceNote:
          'All timings in this round come from a local Windows workstation process. ' +
          'They are NOT cloud measurements and must never be used as proof that the ' +
          'shadow instrument fits inside the Windows 100ms production budget.',
      },
      caps: {
        twoTurn: 300_000,
        oneTurn: 50_000,
        witness: 120_000,
        staticReach: 20_000,
        source: 'probe/dr_lib.ts RISK + mouseStaticGoalReach',
      },
      totals: {
        plansEvaluated: all.length,
        g6t2Plans: g6t2.length,
        crossRootPlans: cross.length,
        totalRiskMs,
        maxTwoTurnNodes,
        maxTwoTurnMs,
        peakRssMB,
      },
      overBudgetBehavior: {
        anyTwoTurnTruncated: all.some((r) => r.twoTurnTruncated),
        anyOneTurnTruncated: all.some((r) => r.oneTurnTruncated),
        anyStaticReachTruncated: all.some((r) => r.staticReachTruncated),
        rule: 'A cap hit yields null/UNKNOWN, never a silent partial verdict; layer 1 and layer 2 report truncation explicitly.',
      },
      perPlan: all,
      processes,
      processNote: 'heavy worker concurrency = 1; every phase ran in its own fresh vitest process, strictly serial.',
      sources: {
        'probe/dr_lib.ts': fileSha(`${ROUND}/probe/dr_lib.ts`),
        'probe/g3_risk.test.ts': fileSha(`${ROUND}/probe/g3_risk.test.ts`),
        'probe/g4_cross_root.test.ts': fileSha(`${ROUND}/probe/g4_cross_root.test.ts`),
        'probe/g5_env.test.ts': fileSha(`${ROUND}/probe/g5_env.test.ts`),
        'probe/digest.mjs': fileSha(`${ROUND}/probe/digest.mjs`),
      },
    };
    writeJson(`${ROUND}/logs/g5_env.json`, out);

    expect(all.length).toBe(10); // 4 G6T2 plans + 6 control rows
    expect(out.overBudgetBehavior.anyTwoTurnTruncated).toBe(false);
    expect(peakRssMB).toBeGreaterThan(0);
    expect(processes.filter((l) => l.startsWith('vitest'))).toEqual([]);
  });
});