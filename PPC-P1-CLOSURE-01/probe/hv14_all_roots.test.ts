/// <reference types="node" />
/**
 * PPC-P1-CLOSURE-01 / P3-E — full 45-root reproduction table.
 *
 * FLT-HV14-4 aborts at the FIRST value mismatch, so its own log cannot tell us
 * how many of the 45 HV14 roots the current engine actually reproduces. This
 * probe repeats the same rerun (`rerunRoot`: logged completedDepth, production
 * flags, H1 leaf) over ALL 45 roots and tabulates every value/mate deviation.
 *
 * READ-ONLY. Emits PPC-P1-CLOSURE-01/_raw/hv14_all_roots.json.
 */
import { test } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { createEngineRuleSet } from '../../src/game/engine';
import type { GameEngineState } from '../../src/game/engine';
import { restoreHardRoot, type HardRootSnapshot } from '../../src/game/ai/hardHistory';
import { createSearchContext, searchResult } from '../../src/game/ai/expectiminimax';
import { evaluateCorrectedHoleForCat } from '../../src/game/ai/correctedHoleLeaf';
import { stateKey } from '../../src/game/ai/transposition';

const OUT = new URL('../_raw/hv14_all_roots.json', import.meta.url);
const DIR = new URL('../../ai-training/human-logs/PPC-HV14/', import.meta.url);
const GAMES = ['GAME1', 'GAME2', 'GAME3', 'GAME4', 'GAME5'] as const;
const rules = createEngineRuleSet();

interface Row {
  game: string;
  turn: number;
  completedDepth: number;
  keyOk: boolean;
  loggedValue: number;
  loggedMate: string;
  nowValue: number;
  nowMate: string;
  valueMatch: boolean;
  mateMatch: boolean;
  nodes: number;
}

function load(): { s: GameEngineState; key: string; depth: number; v: number; m: string; game: string; turn: number }[] {
  const out: ReturnType<typeof load> = [];
  for (const g of GAMES) {
    const text = readFileSync(new URL(`${g}_H1.txt`, DIR), 'utf8');
    const lines = text.split(/\r?\n/);
    const starts: number[] = [];
    lines.forEach((l, i) => {
      if (/^Turn #\d+$/.test(l.trim())) starts.push(i);
    });
    starts.forEach((s, k) => {
      const block = lines.slice(s, k + 1 < starts.length ? starts[k + 1] : lines.length);
      const field = (p: string): string => block.find((l) => l.startsWith(p))?.slice(p.length).trim() ?? '';
      const dm = /^cDepth=(\d+) aDepth=(\d+)/.exec(field('SEARCH:'));
      if (!dm) return;
      const rv = /^(-?[\d.e+]+) mate=(null|cat|mouse)$/.exec(field('ROOT_VALUE='));
      if (!rv) return;
      const snap = JSON.parse(field('SNAPSHOT_JSON=')) as HardRootSnapshot;
      out.push({
        s: restoreHardRoot(snap),
        key: field('STATE_KEY='),
        depth: Number(dm[1]),
        v: Number(rv[1]),
        m: rv[2],
        game: g,
        turn: Number(/^Turn #(\d+)$/.exec(block[0].trim())![1]),
      });
    });
  }
  return out;
}

test('P3-E all 45 HV14 roots — value / mate / identity reproduction', () => {
  const roots = load();
  const rows: Row[] = [];
  for (const r of roots) {
    const ctx = createSearchContext(rules, 500_000, true, true, true, 0, false);
    ctx.capturePlan = true;
    ctx.leafEvaluator = evaluateCorrectedHoleForCat;
    const res = searchResult(r.s, r.depth, ctx);
    rows.push({
      game: r.game,
      turn: r.turn,
      completedDepth: r.depth,
      keyOk: stateKey(r.s) === r.key,
      loggedValue: r.v,
      loggedMate: r.m,
      nowValue: res.value,
      nowMate: res.mate ?? 'null',
      valueMatch: res.value === r.v,
      mateMatch: (res.mate ?? 'null') === r.m,
      nodes: ctx.diagnostics.nodes,
    });
  }
  const bad = rows.filter((x) => !x.valueMatch || !x.mateMatch);
  const out = {
    roots: rows.length,
    identityOk: rows.every((x) => x.keyOk),
    valueMatches: rows.filter((x) => x.valueMatch).length,
    mateMatches: rows.filter((x) => x.mateMatch).length,
    deviations: bad.length,
    deviationRows: bad,
    rows,
  };
  writeFileSync(OUT, JSON.stringify(out, null, 2), 'utf8');
  console.log(
    `P3-E roots=${out.roots} identityOk=${out.identityOk} `
      + `valueMatches=${out.valueMatches} mateMatches=${out.mateMatches} deviations=${out.deviations}`,
  );
  for (const b of bad) {
    console.log(
      `  DEVIATION ${b.game} T${b.turn} depth=${b.completedDepth} `
        + `log=${b.loggedValue}/${b.loggedMate} now=${b.nowValue}/${b.nowMate}`,
    );
  }
}, 600_000);
