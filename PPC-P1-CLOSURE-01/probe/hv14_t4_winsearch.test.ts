/// <reference types="node" />
/**
 * PPC-P1-CLOSURE-01 / P3-B — is the GAME3 T4 depth-1 "cat mate in one turn"
 * (value 999996 = MATE_SCORE - 4) a REAL win?
 *
 * READ-ONLY. Two independent enumerations of every cat action sequence of
 * length 1..4 from the restored root:
 *
 *   ARM-REAL : the REAL engine RuleSet (`createEngineRuleSet().catMove`) plus the
 *              real turn boundary (`endTurn`) plus the shared pure kernel
 *              `applyNoMoveLoss` — i.e. what the shipped game would do.
 *   ARM-SIM  : the AI's own transition (`simulateSearchAction`), i.e. what the
 *              search believes happens.
 *
 * A cat win in ARM-REAL is a real win. A cat win in ARM-SIM but not in ARM-REAL
 * is a simulator/engine divergence — a hard, minimal counterexample.
 *
 * Emits PPC-P1-CLOSURE-01/_raw/hv14_t4_winsearch.json.
 */
import { test } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { createEngineRuleSet, endTurn } from '../../src/game/engine';
import type { GameEngineState } from '../../src/game/engine';
import { DIRECTIONS, GamePhase, PieceType } from '../../src/game/types';
import { restoreHardRoot, type HardRootSnapshot } from '../../src/game/ai/hardHistory';
import { applyNoMoveLoss } from '../../src/game/rules/mobility';
import { simulateSearchAction } from '../../src/game/ai/simulator';
import { generateLegalSearchActions } from '../../src/game/ai/legalActions';
import { stateKey } from '../../src/game/ai/transposition';
import type { SearchAction } from '../../src/game/ai/searchTypes';

const OUT = new URL('../_raw/hv14_t4_winsearch.json', import.meta.url);
const LOG = new URL('../../ai-training/human-logs/PPC-HV14/GAME3_H1.txt', import.meta.url);
const rules = createEngineRuleSet();
const nm = (a: SearchAction): string =>
  a.type === 'catStep' ? a.direction!.key!.replace('Arrow', '') : a.type === 'catPlaceTrap' ? 'T' : a.type;

function rootState(turn: number): GameEngineState {
  const lines = readFileSync(LOG, 'utf8').split(/\r?\n/);
  const starts: number[] = [];
  lines.forEach((l, i) => {
    if (/^Turn #\d+$/.test(l.trim())) starts.push(i);
  });
  const idx = starts.findIndex((s) => Number(/^Turn #(\d+)$/.exec(lines[s].trim())![1]) === turn);
  const block = lines.slice(starts[idx], idx + 1 < starts.length ? starts[idx + 1] : lines.length);
  const snapLine = block.find((l) => l.startsWith('SNAPSHOT_JSON='))!;
  return restoreHardRoot(JSON.parse(snapLine.slice('SNAPSHOT_JSON='.length)) as HardRootSnapshot);
}

/** REAL engine step + real turn boundary. */
function realStep(s: GameEngineState, a: SearchAction): GameEngineState | null {
  if (a.type === 'catPlaceTrap') {
    if (s.trapPosition !== null || s.catTrapsRemaining <= 0) return null;
    const next = rules.catPlaceTrap(s);
    return stateKey(next) === stateKey(s) ? null : next;
  }
  if (a.type !== 'catStep') return null;
  const next = rules.catMove(s, a.direction!);
  if (stateKey(next) === stateKey(s)) return null;
  const settled = applyNoMoveLoss(next);
  if (settled !== next) return settled;                       // terminal straight away
  if (settled.phase !== GamePhase.Playing) return settled;
  if (settled.currentPlayer === PieceType.Cat && settled.catMovesLeft <= 0) {
    const handed = endTurn(settled);                          // CAT -> MOUSE
    const after = applyNoMoveLoss(handed);
    return after;                                             // may already be MouseWins
  }
  return settled;
}

test('P3-B GAME3 T4 — real-engine vs AI-simulator 4-step kill search', () => {
  const root = rootState(4);
  const out: Record<string, unknown> = {
    rootKey: stateKey(root),
    rootCatMovesLeft: root.catMovesLeft,
    rootMouseMovesLeft: root.mouseMovesLeft,
    rootPlayer: root.currentPlayer,
    rootStranded: applyNoMoveLoss(root) !== root,
    maxSeqLen: 4,
    realWins: [] as unknown[],
    simWins: [] as unknown[],
    divergences: [] as unknown[],
    realExplored: 0,
    simExplored: 0,
    loggedPlanReplay: null as unknown,
  };
  const realWins = out.realWins as unknown[];
  const simWins = out.simWins as unknown[];
  const divergences = out.divergences as unknown[];

  const walk = (
    s: GameEngineState,
    seq: SearchAction[],
    depth: number,
    arm: 'real' | 'sim',
  ): void => {
    if (depth === 0) return;
    const acts = generateLegalSearchActions(s, rules).filter(
      (a) => a.type === 'catStep' || a.type === 'catPlaceTrap',
    );
    for (const a of acts) {
      let next: GameEngineState | null = null;
      if (arm === 'real') {
        next = realStep(s, a);
      } else {
        const tr = simulateSearchAction(s, a, rules);
        if (tr.kind !== 'deterministic') continue;
        const after = applyNoMoveLoss(tr.state);
        next = after;
      }
      if (next === null) continue;
      if (arm === 'real') out.realExplored = (out.realExplored as number) + 1;
      else out.simExplored = (out.simExplored as number) + 1;

      if (next.phase === GamePhase.CatWins) {
        const bucket = arm === 'real' ? realWins : simWins;
        bucket.push({
          seq: [...seq, a].map(nm),
          len: seq.length + 1,
          catEnd: next.catPosition,
          mouseEnd: next.mousePosition,
          catMovesLeft: next.catMovesLeft,
          mouseMovesLeft: next.mouseMovesLeft,
          endKey: stateKey(next),
        });
        continue;
      }
      if (next.phase === GamePhase.MouseWins) continue;
      // Keep walking the cat's own turn only.
      if (next.currentPlayer === PieceType.Cat && next.catMovesLeft > 0) {
        walk(next, [...seq, a], depth - 1, arm);
      }
    }
  };

  walk(root, [], 4, 'real');
  walk(root, [], 4, 'sim');

  // ---- where exactly do the two arms disagree, step by step? -------------
  const firstStepActs = generateLegalSearchActions(root, rules).filter(
    (a) => a.type === 'catStep' || a.type === 'catPlaceTrap',
  );
  for (const a of firstStepActs) {
    const real = realStep(root, a);
    const tr = simulateSearchAction(root, a, rules);
    const sim = tr.kind === 'deterministic' ? applyNoMoveLoss(tr.state) : null;
    if (real && sim) {
      divergences.push({
        step: nm(a),
        realKey: stateKey(real),
        simKey: stateKey(sim),
        equal: stateKey(real) === stateKey(sim),
        realPhase: real.phase,
        simPhase: sim.phase,
        realPlayer: real.currentPlayer,
        simPlayer: sim.currentPlayer,
        realCatMovesLeft: real.catMovesLeft,
        simCatMovesLeft: sim.catMovesLeft,
        realMouseMovesLeft: real.mouseMovesLeft,
        simMouseMovesLeft: sim.mouseMovesLeft,
      });
    }
  }

  // ---- replay the LOGGED production plan (Down,Right,Right,Right) --------
  const logged: SearchAction[] = ['Down', 'Right', 'Right', 'Right'].map((d) => ({
    type: 'catStep' as const,
    direction: DIRECTIONS.find((x) => x.key === `Arrow${d}`)!,
  }));
  let cur: GameEngineState = root;
  const trail: unknown[] = [];
  for (const a of logged) {
    const next = realStep(cur, a);
    if (next === null) {
      trail.push({ step: nm(a), result: 'ILLEGAL', at: `${cur.catPosition.r},${cur.catPosition.c}` });
      break;
    }
    cur = next;
    trail.push({
      step: nm(a),
      cat: `${cur.catPosition.r},${cur.catPosition.c}`,
      mouse: `${cur.mousePosition.r},${cur.mousePosition.c}`,
      phase: cur.phase,
      player: cur.currentPlayer,
      catMovesLeft: cur.catMovesLeft,
      mouseMovesLeft: cur.mouseMovesLeft,
    });
  }
  out.loggedPlanReplay = { plan: logged.map(nm), trail, endedInCatWin: cur.phase === GamePhase.CatWins };

  writeFileSync(OUT, JSON.stringify(out, null, 2), 'utf8');
  console.log(
    `P3-B realExplored=${out.realExplored} realWins=${realWins.length} `
      + `simExplored=${out.simExplored} simWins=${simWins.length}`,
  );
  console.log(`realWins sample: ${JSON.stringify(realWins.slice(0, 5))}`);
  console.log(`simWins sample : ${JSON.stringify(simWins.slice(0, 5))}`);
  console.log(`first-step divergences: ${JSON.stringify(divergences)}`);
  console.log(`logged plan replay: ${JSON.stringify(trail)}`);
}, 300_000);
