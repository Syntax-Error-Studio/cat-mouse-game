import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'vitest';

import { createInitialState, createEngineRuleSet } from '../../src/game/engine';
import { DEFAULT_CONFIG, validateGameConfig, type GameConfig } from '../../src/game/config';
import { CellType, PieceType } from '../../src/game/types';
import { createSearchContext, searchBestAction } from '../../src/game/ai/expectiminimax';
import { countReversals, planFullTurnCompleteness } from '../../src/game/ai/planQuality';
import { simulateSearchAction } from '../../src/game/ai/simulator';
import type { SearchAction } from '../../src/game/ai/searchTypes';

/**
 * PPC-P1-QUALITY-01 — observation-only witness.
 *
 * Runs identically BEFORE and AFTER the accounting fix: it never asserts which
 * plan wins, only that the primary-search invariants hold. The selected plan is
 * recorded so the two runs can be diffed as BASELINE_ vs POSTFIX_.
 *
 * The leaf is a diagnostic constant (`0` for no-trap endings, `-1` once a trap
 * is left on the board). It exists ONLY to make equal-primary branches tie so
 * the secondary comparator is the sole decision maker. It is not a strength
 * experiment and says nothing about H1.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(HERE, '..', '_raw');

function save(name: string, payload: unknown): void {
  mkdirSync(OUT, { recursive: true });
  writeFileSync(resolve(OUT, `${name}.json`), JSON.stringify(payload, null, 2));
}

/** Vertical dead-end corridor: column 2 open, mouse sealed in a 3x3 pocket. */
function verticalRoot(moves: number, size = 7) {
  const terrain = Array.from({ length: size }, () => Array(size).fill(CellType.Wall));
  for (let r = 0; r < size; r++) terrain[r][2] = CellType.Empty;
  for (let r = size - 3; r < size; r++) for (let c = size - 3; c < size; c++) terrain[r][c] = CellType.Empty;
  terrain[size - 2][size - 1] = CellType.MouseHole;
  return buildRoot(terrain, moves, size, { r: 1, c: 2 });
}

/** Horizontal dead-end corridor: row 2 open. Same shape rotated 90 degrees. */
function horizontalRoot(moves: number, size = 7) {
  const terrain = Array.from({ length: size }, () => Array(size).fill(CellType.Wall));
  for (let c = 0; c < size; c++) terrain[2][c] = CellType.Empty;
  for (let r = size - 3; r < size; r++) for (let c = size - 3; c < size; c++) terrain[r][c] = CellType.Empty;
  terrain[size - 2][size - 1] = CellType.MouseHole;
  return buildRoot(terrain, moves, size, { r: 2, c: 1 });
}

function buildRoot(terrain: CellType[][], moves: number, size: number, catStart: { r: number; c: number }) {
  const config: GameConfig = {
    ...DEFAULT_CONFIG,
    boardSize: size,
    mouseHole: { r: size - 2, c: size - 1, size: 1 },
    catStart,
    mouseStart: { r: size - 2, c: size - 2 },
    catBaseMoves: moves,
    boxCount: 0,
    pileCount: 0,
    butterCount: 0,
    boxPositions: [],
    pilePositions: [],
    butterPositions: [],
    customTerrain: terrain,
    tunnelCorners: [],
    difficulty: 'hard',
  };
  const validation = validateGameConfig(config);
  assert.equal(validation.ok, true, `config rejected: ${JSON.stringify(validation)}`);
  return { ...createInitialState(config), currentPlayer: PieceType.Cat };
}

function label(plan: SearchAction[]): string {
  return plan.map((a) => (a.type === 'catStep' ? a.direction!.key.replace('Arrow', '')[0] : 'T')).join('');
}

function step(key: string): SearchAction {
  const table: Record<string, { dr: number; dc: number; label: string }> = {
    ArrowUp: { dr: -1, dc: 0, label: '↑' },
    ArrowDown: { dr: 1, dc: 0, label: '↓' },
    ArrowLeft: { dr: 0, dc: -1, label: '←' },
    ArrowRight: { dr: 0, dc: 1, label: '→' },
  };
  return { type: 'catStep', direction: { key, ...table[key] } };
}

/**
 * A straight line of `n` copies of one direction, replayed through the real
 * rule adapter. Used as the reference "zero-reversal" alternative: it is only
 * reported when every step is actually effective.
 */
function straightLine(root: ReturnType<typeof verticalRoot>, key: string, n: number, rules: ReturnType<typeof createEngineRuleSet>) {
  const plan = Array.from({ length: n }, () => step(key));
  let cur = root;
  let allEffective = true;
  for (const a of plan) {
    const t = simulateSearchAction(cur, a, rules);
    if (t.kind !== 'deterministic') { allEffective = false; break; }
    if (t.state.catPosition.r === cur.catPosition.r && t.state.catPosition.c === cur.catPosition.c) allEffective = false;
    cur = t.state;
  }
  return { plan, allEffective, endMovesLeft: cur.catMovesLeft, endPlayer: cur.currentPlayer, endCat: cur.catPosition };
}

interface CaseSpec { id: string; axis: 'vertical' | 'horizontal'; moves: number; straightKey: string }

const CASES: CaseSpec[] = [
  { id: 'V-M2', axis: 'vertical', moves: 2, straightKey: 'ArrowDown' },
  { id: 'V-M3', axis: 'vertical', moves: 3, straightKey: 'ArrowDown' },
  { id: 'V-M4', axis: 'vertical', moves: 4, straightKey: 'ArrowDown' },
  { id: 'H-M2', axis: 'horizontal', moves: 2, straightKey: 'ArrowRight' },
  { id: 'H-M3', axis: 'horizontal', moves: 3, straightKey: 'ArrowRight' },
  { id: 'H-M4', axis: 'horizontal', moves: 4, straightKey: 'ArrowRight' },
];

test('PPC-P1-QUALITY-01 reversal-boundary witness (observation only)', () => {
  const rules = createEngineRuleSet();
  const cases: Record<string, unknown> = {};

  for (const spec of CASES) {
    const root = spec.axis === 'vertical' ? verticalRoot(spec.moves) : horizontalRoot(spec.moves);
    const ctx = createSearchContext(rules, 200_000, true, false, false, 0, false);
    ctx.capturePlan = true;
    // Diagnostic leaf: every no-trap ending is exactly 0, a leftover trap is -1.
    ctx.leafEvaluator = (s) => (s.trapPosition === null ? 0 : -1);

    const got = searchBestAction(root, 1, ctx);
    const alternative = straightLine(root, spec.straightKey, spec.moves, rules);

    const chosen = got.catTurnPlan ?? [];
    const chosenVerdict = planFullTurnCompleteness(root, chosen, rules);
    const altVerdict = alternative.allEffective
      ? planFullTurnCompleteness(root, alternative.plan, rules)
      : null;

    cases[spec.id] = {
      axis: spec.axis,
      catMovesLeftAtRoot: root.catMovesLeft,
      catBaseMoves: root.config.catBaseMoves,
      catTrapsRemaining: root.catTrapsRemaining,
      primary: {
        completed: got.completed,
        value: got.value,
        mate: got.mate,
        nodes: got.diagnostics.nodes,
        ttSize: ctx.tt?.size,
      },
      chosenPlan: label(chosen),
      chosenActions: chosen.map((a) => (a.type === 'catStep' ? a.direction!.key : 'catPlaceTrap')),
      chosenReversals: countReversals(chosen),
      chosenVerdict,
      referenceStraightLine: label(alternative.plan),
      referenceEffective: alternative.allEffective,
      referenceReversals: countReversals(alternative.plan),
      referenceVerdict: altVerdict,
      referenceEndMovesLeft: alternative.endMovesLeft,
      referenceEndPlayer: alternative.endPlayer,
      picksFewerReversals:
        alternative.allEffective && altVerdict !== null
          ? countReversals(chosen) <= countReversals(alternative.plan)
          : null,
    };

    // Primary-search invariants that must hold in BOTH runs.
    assert.equal(got.completed, true, `${spec.id}: search must complete`);
  }

  save('reversal_witness', {
    round: 'PPC-P1-QUALITY-01',
    kind: 'observation-only counterexample table',
    scope: 'diagnostic leaf isolates the secondary comparator; no strength claim',
    leafEvaluator: 's => s.trapPosition === null ? 0 : -1',
    cases,
  });

  console.log('PPC-P1-QUALITY-01 witness written:', resolve(OUT, 'reversal_witness.json'));
});
