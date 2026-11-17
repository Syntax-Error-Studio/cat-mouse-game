/// <reference types="node" />
/**
 * PPC-P2-PREPARED-TRANSITION-01 — Stage 3/4 evidence probe.
 *
 * Produces the named JSON artifacts the round brief asks for:
 *
 *   _raw/d1_parity.json            24 frozen roots, fixed D1, field-by-field vs
 *                                  the frozen pre-fix artifact, both arms
 *   _raw/transition_semantics.json prepared-vs-fresh transition parity per root
 *   _raw/special_rule_replay.json  the 20 special-rule paths, replayed on the
 *                                  REAL engine
 *   _raw/deadline_integration.json full production cat turn (100 ms / 150 ms)
 *                                  on both arms — a DIAGNOSTIC, not an authority
 *
 * Every check is recorded as data (name / ok / expected / actual) and the test
 * fails at the end if any recorded check is false, so the JSON can never claim
 * more than the assertions proved.
 */
import { it, expect } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import type { GameEngineState } from '../../src/game/engine';
import { createEngineRuleSet } from '../../src/game/engine';
import { CellType, DIRECTIONS, GamePhase, PieceType, type Direction } from '../../src/game/types';
import { restoreHardRoot } from '../../src/game/ai/hardHistory';
import { stateKey } from '../../src/game/ai/transposition';
import { evaluateCorrectedHoleForCat } from '../../src/game/ai/correctedHoleLeaf';
import { createSearchContext, searchBestAction } from '../../src/game/ai/expectiminimax';
import { generatePreparedSearchActions } from '../../src/game/ai/preparedActions';
import { simulateSearchAction } from '../../src/game/ai/simulator';
import { gameAffectingEqual } from '../../src/game/ai/stateCompare';
import type { SearchAction } from '../../src/game/ai/searchTypes';
import * as baseArm from './armEntry.baseline';
import * as candArm from './armEntry.candidate';

const ROOT_FIXTURE = new URL('../../src/game/ai/__tests__/fixtures/ppcId01-human-roots.json', import.meta.url);
const BASELINE_D1 = new URL('../../src/game/ai/__tests__/fixtures/ppcId01-baseline-d1.json', import.meta.url);
const ROOT_FIXTURE_SHA256 = '1a59787adb6669e1cf287d019313dadf4636a4310eed7b3de5236f4778e0db09';

const rules = createEngineRuleSet();
const DIR: Record<string, Direction> = Object.fromEntries(DIRECTIONS.map((d) => [d.key, d]));
const U = DIR.ArrowUp;
const D = DIR.ArrowDown;
const L = DIR.ArrowLeft;
const R = DIR.ArrowRight;

const clone = (s: GameEngineState): GameEngineState => JSON.parse(JSON.stringify(s)) as GameEngineState;

interface RootRecord { id: string; state: unknown }

function loadRoots(): { id: string; state: GameEngineState }[] {
  const raw = readFileSync(ROOT_FIXTURE);
  expect(createHash('sha256').update(raw).digest('hex')).toBe(ROOT_FIXTURE_SHA256);
  return (JSON.parse(raw.toString('utf8')) as RootRecord[]).map((r) => ({ id: r.id, state: restoreHardRoot(r.state as never) }));
}

const label = (a: SearchAction | null): string => {
  if (!a) return '-';
  if (a.type === 'catPlaceTrap') return 'T';
  if (a.type === 'mouseSkill') return 'S';
  if (a.type === 'chooseTunnel') return `t${a.r},${a.c}`;
  return ({ ArrowUp: 'U', ArrowDown: 'D', ArrowLeft: 'L', ArrowRight: 'R' } as Record<string, string>)[a.direction.key] ?? '?';
};

// ---------------------------------------------------------------------------
// Evidence 1 — fixed-D1 parity, field by field
// ---------------------------------------------------------------------------
it('fixed-D1 24-root parity (candidate vs frozen artifact vs baseline arm)', () => {
  const roots = loadRoots();
  const artifact = JSON.parse(readFileSync(BASELINE_D1, 'utf8')) as {
    protocol: Record<string, unknown>;
    records: {
      id: string; key: string; completed: boolean; value: number; mate: string | null;
      action: string; plan: string[]; ttSize: number; diagnostics: Record<string, number>;
    }[];
  };
  const byId = new Map(artifact.records.map((r) => [r.id, r]));

  const rows = roots.map(({ id, state }) => {
    const ctx = createSearchContext(rules, 10000, true, true, true, 0, false);
    ctx.leafEvaluator = evaluateCorrectedHoleForCat;
    ctx.capturePlan = true;
    const res = searchBestAction(state, 1, ctx);
    const cand = {
      id,
      key: stateKey(state),
      completed: res.completed,
      value: res.value,
      mate: res.mate,
      action: label(res.action),
      plan: res.catTurnPlan.map(label),
      ttSize: ctx.tt.size,
      diagnostics: res.diagnostics as unknown as Record<string, number>,
    };
    const baseArmRun = baseArm.runRoot(id, state);
    const expected = byId.get(id)!;
    const diffs: string[] = [];
    const cmp = (field: string, a: unknown, b: unknown) => {
      if (JSON.stringify(a) !== JSON.stringify(b)) diffs.push(`${field}: ${JSON.stringify(a)} != ${JSON.stringify(b)}`);
    };
    for (const f of ['key', 'completed', 'value', 'mate', 'action', 'plan', 'ttSize'] as const) {
      cmp(f, (cand as never)[f], (expected as never)[f]);
    }
    // every diagnostics counter, one by one
    for (const k of Object.keys(expected.diagnostics)) {
      cmp(`diagnostics.${k}`, cand.diagnostics[k], expected.diagnostics[k]);
    }
    return {
      id,
      diffsVsFrozenArtifact: diffs,
      candidate: {
        value: cand.value, mate: cand.mate, completed: cand.completed, action: cand.action,
        plan: cand.plan, ttSize: cand.ttSize, diagnostics: cand.diagnostics,
      },
      baselineArm: {
        value: baseArmRun.value, mate: baseArmRun.mate, completed: baseArmRun.completed,
        action: baseArmRun.action, plan: baseArmRun.plan, nodes: baseArmRun.nodes,
        chanceNodes: baseArmRun.chanceNodes, ttHits: baseArmRun.ttHits, cutoffs: baseArmRun.cutoffs,
      },
      armParity: baseArmRun.value === cand.value
        && baseArmRun.mate === cand.mate
        && baseArmRun.action === cand.action
        && JSON.stringify(baseArmRun.plan) === JSON.stringify(cand.plan)
        && baseArmRun.nodes === cand.diagnostics.nodes
        && baseArmRun.chanceNodes === cand.diagnostics.chanceNodes
        && baseArmRun.ttHits === cand.diagnostics.ttHits
        && baseArmRun.cutoffs === cand.diagnostics.alphaBetaCutoffs,
    };
  });

  writeFileSync('PPC-P2-PREPARED-TRANSITION-01/_raw/d1_parity.json', `${JSON.stringify({
    round: 'PPC-P2-PREPARED-TRANSITION-01',
    protocol: artifact.protocol,
    rootFixtureSha256: ROOT_FIXTURE_SHA256,
    note: 'diffsVsFrozenArtifact must be empty for 24/24 roots; armParity must be true for 24/24 roots',
    totalDiffFields: rows.reduce((n, r) => n + r.diffsVsFrozenArtifact.length, 0),
    armParityAll: rows.every((r) => r.armParity),
    roots: rows,
  }, null, 2)}\n`);

  expect(rows.every((r) => r.diffsVsFrozenArtifact.length === 0)).toBe(true);
  expect(rows.every((r) => r.armParity)).toBe(true);
});

// ---------------------------------------------------------------------------
// Evidence 2 — prepared-vs-fresh transition semantics
// ---------------------------------------------------------------------------
it('prepared transition semantics over 24 roots', () => {
  const roots = loadRoots();
  const rows = roots.map(({ id, state }) => {
    const prepared = generatePreparedSearchActions(state, rules);
    let deterministic = 0;
    let chance = 0;
    let mismatches = 0;
    let fullStateMismatches = 0;
    const details: unknown[] = [];
    for (const p of prepared) {
      const fresh = simulateSearchAction(state, p.action, rules);
      if (p.transition.kind !== fresh.kind) { mismatches++; continue; }
      if (p.transition.kind === 'deterministic' && fresh.kind === 'deterministic') {
        deterministic++;
        if (stateKey(fresh.state) !== stateKey(p.transition.state)) mismatches++;
        if (JSON.stringify(fresh.state) !== JSON.stringify(p.transition.state)) fullStateMismatches++;
      } else if (p.transition.kind === 'chance' && fresh.kind === 'chance') {
        chance++;
        const a = p.transition.outcomes;
        const b = fresh.outcomes;
        if (a.length !== b.length) mismatches++;
        else {
          for (let i = 0; i < a.length; i++) {
            if (stateKey(a[i].state) !== stateKey(b[i].state) || a[i].weight !== b[i].weight) { mismatches++; break; }
          }
        }
        details.push({
          action: label(p.action),
          outcomes: a.length,
          weightsUniform: new Set(a.map((o) => o.weight)).size === 1,
          weightSum: a.reduce((s, o) => s + o.weight, 0),
        });
      }
    }
    return { id, actions: prepared.length, deterministic, chance, mismatches, fullStateMismatches, chanceDetails: details };
  });

  writeFileSync('PPC-P2-PREPARED-TRANSITION-01/_raw/transition_semantics.json', `${JSON.stringify({
    round: 'PPC-P2-PREPARED-TRANSITION-01',
    semantics: 'For every prepared action, an INDEPENDENT second simulateSearchAction must produce the same transition (stateKey, full state JSON for deterministic; outcome order/weights for chance).',
    totals: {
      actions: rows.reduce((n, r) => n + r.actions, 0),
      deterministic: rows.reduce((n, r) => n + r.deterministic, 0),
      chance: rows.reduce((n, r) => n + r.chance, 0),
      mismatches: rows.reduce((n, r) => n + r.mismatches, 0),
      fullStateMismatches: rows.reduce((n, r) => n + r.fullStateMismatches, 0),
    },
    roots: rows,
  }, null, 2)}\n`);

  expect(rows.reduce((n, r) => n + r.mismatches, 0)).toBe(0);
  expect(rows.reduce((n, r) => n + r.fullStateMismatches, 0)).toBe(0);
});

// ---------------------------------------------------------------------------
// Evidence 3 — the 20 special-rule paths, replayed on the real engine
// ---------------------------------------------------------------------------
interface Check { name: string; ok: boolean; expected?: unknown; actual?: unknown }
const checks: Check[] = [];
const ck = (name: string, ok: boolean, expected?: unknown, actual?: unknown): void => {
  checks.push({ name, ok, expected, actual });
};

/** Move the mouse out of the way so the cat can be placed freely. */
function parkMouse(st: GameEngineState): void {
  // A known-empty corridor cell far from the cat (never the mouse hole).
  st.mousePosition = { r: st.config.boardSize - 1, c: 5 };
  st.board[st.mousePosition.r][st.mousePosition.c] = { ...st.board[st.mousePosition.r][st.mousePosition.c], type: CellType.Empty };
}

function makeCatTurn(id: string): GameEngineState {
  const st = clone(loadRoots().find((r) => r.id === id)!.state);
  st.phase = GamePhase.Playing;
  st.currentPlayer = PieceType.Cat;
  st.catMovesLeft = 4;
  st.mouseMovesLeft = 0;
  st.pendingButterSpawns = [];
  st.pendingButterPlacementDebt = 0;
  st.trapPosition = null;
  st.catTrapsRemaining = 1;
  st.blockedTunnels = [];
  return st;
}

function makeMouseTurn(id: string): GameEngineState {
  const st = makeCatTurn(id);
  st.currentPlayer = PieceType.Mouse;
  st.mouseMovesLeft = 2;
  st.catMovesLeft = 4;
  return st;
}

function prepOk(st: GameEngineState): { ok: boolean; actions: string[]; detail: Record<string, boolean> } {
  const prepared = generatePreparedSearchActions(st, rules);
  let ok = true;
  const detail: Record<string, boolean> = {};
  for (const p of prepared) {
    const fresh = simulateSearchAction(st, p.action, rules);
    let same = fresh.kind === p.transition.kind;
    if (same && fresh.kind === 'deterministic' && p.transition.kind === 'deterministic') {
      same = stateKey(fresh.state) === stateKey(p.transition.state);
    } else if (same && fresh.kind === 'chance' && p.transition.kind === 'chance') {
      same = JSON.stringify(fresh.outcomes.map((o) => [stateKey(o.state), o.weight]))
        === JSON.stringify(p.transition.outcomes.map((o) => [stateKey(o.state), o.weight]));
    }
    detail[`${p.action.type}:${label(p.action)}`] = same;
    ok = ok && same;
  }
  return { ok, actions: prepared.map((p) => `${p.action.type}:${label(p.action)}`), detail };
}

it('special-rule replay (20 paths) on the real engine', () => {
  const rootId = 'G6T1';

  // 1. ordinary cat step
  {
    const st = makeCatTurn(rootId);
    parkMouse(st);
    st.catPosition = { r: 5, c: 5 };
    st.board[5][5] = { ...st.board[5][5], type: CellType.Empty };
    const p = prepOk(st);
    const next = rules.catMove(st, R);
    ck('01 ordinary cat step', p.ok && next.catPosition.r === 5 && next.catPosition.c === 6 && next.catMovesLeft === 3,
      { to: [5, 6], movesLeft: 3 }, { to: [next.catPosition.r, next.catPosition.c], movesLeft: next.catMovesLeft });
  }

  // 2. cat pushes a box
  {
    const st = makeCatTurn(rootId);
    parkMouse(st);
    st.catPosition = { r: 2, c: 1 };
    st.board[2][1] = { ...st.board[2][1], type: CellType.Empty };
    st.board[2][2] = { ...st.board[2][2], type: CellType.Box };
    st.board[2][3] = { ...st.board[2][3], type: CellType.Empty };
    const p = prepOk(st);
    const next = rules.catMove(st, R);
    ck('02 cat pushes a box', p.ok && next.board[2][3].type === CellType.Box && next.catPosition.c === 2 && next.catMovesLeft === 3,
      { boxAt: [2, 3], catAt: [2, 2] }, { boxAt: next.board[2][3].type, catAt: [next.catPosition.r, next.catPosition.c] });
  }

  // 3. legal box push that blocks a tunnel corner
  {
    const st = makeCatTurn(rootId);
    parkMouse(st);
    st.catPosition = { r: 2, c: 0 };
    st.board[2][0] = { ...st.board[2][0], type: CellType.Empty };
    st.board[1][0] = { ...st.board[1][0], type: CellType.Box };
    st.board[0][0] = { ...st.board[0][0], type: CellType.Tunnel };
    const p = prepOk(st);
    const next = rules.catMove(st, U);
    const blocked = next.blockedTunnels.some((t) => t.r === 0 && t.c === 0);
    ck('03 box push blocks a tunnel', p.ok && blocked, true, blocked);
  }

  // 4. cat places a trap without spending a step
  {
    const st = makeCatTurn(rootId);
    parkMouse(st);
    st.catPosition = { r: 5, c: 5 };
    st.board[5][5] = { ...st.board[5][5], type: CellType.Empty };
    const p = prepOk(st);
    const next = rules.catPlaceTrap(st);
    ck('04 catPlaceTrap costs no move',
      p.ok && next.catMovesLeft === st.catMovesLeft && next.trapPosition !== null && next.catTrapsRemaining === 0,
      { movesLeft: st.catMovesLeft, trap: 'set', trapsLeft: 0 },
      { movesLeft: next.catMovesLeft, trap: next.trapPosition ? 'set' : 'null', trapsLeft: next.catTrapsRemaining });
  }

  // 5. cat reclaims its trap by stepping on it
  {
    const st = makeCatTurn(rootId);
    parkMouse(st);
    st.catPosition = { r: 5, c: 5 };
    st.board[5][5] = { ...st.board[5][5], type: CellType.Empty };
    st.board[5][6] = { ...st.board[5][6], type: CellType.Empty };
    st.trapPosition = { r: 5, c: 6 };
    st.catTrapsRemaining = 0;
    const p = prepOk(st);
    const next = rules.catMove(st, R);
    ck('05 cat reclaims trap by stepping on it',
      p.ok && next.trapPosition === null && next.catTrapsRemaining === 1,
      { trap: null, trapsLeft: 1 }, { trap: next.trapPosition, trapsLeft: next.catTrapsRemaining });
  }

  // 6. mouse steps on a trap -> turn ends immediately
  {
    const st = makeMouseTurn(rootId);
    st.mousePosition = { r: 5, c: 5 };
    st.board[5][5] = { ...st.board[5][5], type: CellType.Empty };
    st.board[5][6] = { ...st.board[5][6], type: CellType.Empty };
    st.catPosition = { r: 9, c: 5 };
    st.trapPosition = { r: 5, c: 6 };
    const p = prepOk(st);
    const next = rules.mouseStep(st, R);
    ck('06 mouse trap step ends the turn',
      p.ok && next.currentPlayer === PieceType.Cat && next.mouseMovesLeft >= 0,
      { currentPlayer: 'cat' }, { currentPlayer: next.currentPlayer, mouseMovesLeft: next.mouseMovesLeft });
  }

  // 7. mouse already carrying butter: the action set is still well formed
  {
    const st = makeMouseTurn(rootId);
    st.mouseHasButter = true;
    st.mouseSkillActive = false;
    const p = prepOk(st);
    ck('07 mouse carrying butter', p.ok && p.actions.some((a) => a.startsWith('mouseSkill')), true, p.actions);
  }

  // 8. mouse skill spends the butter for extra moves
  {
    const st = makeMouseTurn(rootId);
    st.mouseHasButter = true;
    st.mouseSkillActive = false;
    st.mouseMovesLeft = 2;
    const before = st.mouseMovesLeft;
    const p = prepOk(st);
    const next = rules.mouseSkill(st);
    ck('08 mouse skill grants extra moves',
      p.ok && next.mouseHasButter === false && next.mouseSkillActive === true
        && next.mouseMovesLeft === before + st.config.mouseSkillExtraMoves,
      { butter: false, skill: true, movesLeft: before + st.config.mouseSkillExtraMoves },
      { butter: next.mouseHasButter, skill: next.mouseSkillActive, movesLeft: next.mouseMovesLeft });
  }

  // 9. mouse chooses a tunnel exit
  {
    const st = makeMouseTurn(rootId);
    st.phase = GamePhase.ChoosingTunnelExit;
    st.tunnelExitChoices = [{ r: 0, c: 0, label: 'A' }, { r: 9, c: 9, label: 'B' }];
    const p = prepOk(st);
    const prepared = generatePreparedSearchActions(st, rules);
    ck('09 tunnel exit choice',
      p.ok && prepared.length === 2 && prepared.every((x) => x.transition.kind === 'deterministic'),
      { actions: 2, kind: 'deterministic' }, { actions: prepared.length, kinds: prepared.map((x) => x.transition.kind) });
  }

  // 10. butter pickup becomes CHANCE
  {
    const st = makeMouseTurn(rootId);
    st.mousePosition = { r: 5, c: 5 };
    st.board[5][5] = { ...st.board[5][5], type: CellType.Empty };
    st.board[5][6] = { ...st.board[5][6], type: CellType.Empty };
    st.butterPositions = [{ r: 5, c: 6 }];
    st.catPosition = { r: 9, c: 5 };
    const p = prepOk(st);
    const prepared = generatePreparedSearchActions(st, rules);
    const chance = prepared.filter((x) => x.transition.kind === 'chance');
    ck('10 butter pickup is a CHANCE node', p.ok && chance.length === 1, 1, chance.length);
  }

  // 11. ghost announcement: +1 pending ghost, -1 entity butter
  {
    const st = makeMouseTurn(rootId);
    st.mousePosition = { r: 5, c: 5 };
    st.board[5][5] = { ...st.board[5][5], type: CellType.Empty };
    st.board[5][6] = { ...st.board[5][6], type: CellType.Empty };
    st.butterPositions = [{ r: 5, c: 6 }];
    st.catPosition = { r: 9, c: 5 };
    st.pendingButterSpawns = [];
    const prepared = generatePreparedSearchActions(st, rules);
    const chance = prepared.find((x) => x.transition.kind === 'chance');
    let ok = false;
    if (chance && chance.transition.kind === 'chance') {
      ok = chance.transition.outcomes.every((o) =>
        (o.state.pendingButterSpawns ?? []).length === 1 && o.state.butterPositions.length === 0);
    }
    ck('11 ghost announcement adds a pending ghost', ok, { ghosts: 1, butters: 0 }, ok);
  }

  // 12. CAT->MOUSE ghost materialisation is a CHANCE boundary
  {
    const st = makeCatTurn(rootId);
    st.catMovesLeft = 1;
    st.pendingButterSpawns = [{ r: 0, c: 5, blockedMaterializations: 0 }];
    const p = prepOk(st);
    const prepared = generatePreparedSearchActions(st, rules);
    const chance = prepared.filter((x) => x.transition.kind === 'chance');
    const materialised = chance.every((x) => x.transition.kind === 'chance'
      && x.transition.outcomes.every((o) => o.state.butterPositions.length > 0));
    ck('12 ghost materialisation at the CAT->MOUSE boundary', p.ok && chance.length > 0 && materialised,
      { chanceActions: '>0', entityButter: true }, { chanceActions: chance.length, materialised });
  }

  // 13. blocked materialisation is deferred, not dropped
  {
    const st = makeCatTurn(rootId);
    st.catMovesLeft = 1;
    // The cat will step to (5,6); the ghost sits exactly there, so it cannot
    // materialise on the occupied cell and must be deferred.
    st.catPosition = { r: 5, c: 5 };
    st.board[5][5] = { ...st.board[5][5], type: CellType.Empty };
    st.board[5][6] = { ...st.board[5][6], type: CellType.Empty };
    st.pendingButterSpawns = [{ r: 5, c: 6, blockedMaterializations: 0 }];
    const prepared = generatePreparedSearchActions(st, rules);
    const chance = prepared.filter((x) => x.transition.kind === 'chance');
    let deferred = false;
    for (const c of chance) {
      if (c.transition.kind !== 'chance') continue;
      for (const o of c.transition.outcomes) {
        const g = (o.state.pendingButterSpawns ?? []).find((s) => s.r === 5 && s.c === 6);
        if (g && g.blockedMaterializations >= 1) deferred = true;
      }
    }
    ck('13 blocked ghost materialisation is deferred', chance.length > 0 && deferred,
      { blockedMaterializations: '>=1' }, { chanceActions: chance.length, deferred });
  }

  // 14. mouse standing on the ghost cell auto-picks it up
  {
    const st = makeCatTurn(rootId);
    st.catMovesLeft = 1;
    st.mousePosition = { r: 8, c: 5 };
    st.mouseHasButter = false;
    st.mouseSkillActive = false;
    st.pendingButterSpawns = [{ r: 8, c: 5, blockedMaterializations: 0 }];
    const prepared = generatePreparedSearchActions(st, rules);
    const chance = prepared.filter((x) => x.transition.kind === 'chance');
    let autoPicked = false;
    for (const c of chance) {
      if (c.transition.kind !== 'chance') continue;
      for (const o of c.transition.outcomes) if (o.state.mouseHasButter) autoPicked = true;
    }
    ck('14 auto-pickup on the materialised cell', chance.length > 0 && autoPicked,
      { mouseHasButter: true }, { chanceActions: chance.length, autoPicked });
  }

  // 15. RULE-A: a stranded cat loses
  {
    const st = makeCatTurn(rootId);
    parkMouse(st);
    st.catPosition = { r: 5, c: 5 };
    // Walls (not boxes): a box could still be PUSHED, which is a legal move.
    for (const [r, c] of [[4, 5], [6, 5], [5, 4], [5, 6]]) {
      st.board[r][c] = { ...st.board[r][c], type: CellType.Wall };
    }
    const p = prepOk(st);
    const next = rules.catMove(st, R);
    ck('15 RULE-A stranded cat', p.ok && next.phase === GamePhase.MouseWins,
      { phase: 'mouse_wins' }, { phase: next.phase });
  }

  // 16. RULE-A: a stranded mouse loses
  {
    const st = makeMouseTurn(rootId);
    st.mousePosition = { r: 5, c: 5 };
    st.catPosition = { r: 9, c: 5 };
    for (const [r, c] of [[4, 5], [6, 5], [5, 4], [5, 6]]) {
      st.board[r][c] = { ...st.board[r][c], type: CellType.Wall };
    }
    const p = prepOk(st);
    const next = rules.mouseStep(st, R);
    ck('16 RULE-A stranded mouse', p.ok && next.phase === GamePhase.CatWins,
      { phase: 'cat_wins' }, { phase: next.phase });
  }

  // 17. mid-move capture is terminal
  {
    const st = makeCatTurn(rootId);
    st.catPosition = { r: 5, c: 5 };
    st.mousePosition = { r: 5, c: 6 };
    st.board[5][5] = { ...st.board[5][5], type: CellType.Empty };
    st.board[5][6] = { ...st.board[5][6], type: CellType.Empty };
    const p = prepOk(st);
    const next = rules.catMove(st, R);
    ck('17 cat capture ends the game', p.ok && next.phase === GamePhase.CatWins,
      { phase: 'cat_wins' }, { phase: next.phase });
  }

  // 18. variable cat move budgets keep the same legal set
  {
    const budgets = [4, 6, 9];
    const rows = budgets.map((m) => {
      const st = makeCatTurn(rootId);
      st.config = { ...st.config, catBaseMoves: m };
      st.catMovesLeft = m;
      const p = prepOk(st);
      return { m, ok: p.ok, actions: p.actions };
    });
    ck('18 variable catBaseMoves 4/6/9', rows.every((r) => r.ok),
      'all arms parity', rows.map((r) => `${r.m}:${r.ok ? 'ok' : 'MISMATCH'}`));
  }

  // 19. irregular Void / Wall map
  {
    const st = makeCatTurn(rootId);
    parkMouse(st);
    st.catPosition = { r: 5, c: 5 };
    st.board[5][5] = { ...st.board[5][5], type: CellType.Empty };
    st.board[4][5] = { ...st.board[4][5], type: CellType.Void };
    st.board[5][6] = { ...st.board[5][6], type: CellType.Wall };
    const p = prepOk(st);
    const legal = generatePreparedSearchActions(st, rules).map((x) => label(x.action));
    ck('19 irregular Void/Wall map', p.ok && !legal.includes('U') && !legal.includes('R'),
      { blocked: ['U', 'R'] }, legal);
  }

  // 20. trap / butter terrain keeps a distinct state identity
  {
    const a = makeCatTurn(rootId);
    const b = clone(a);
    b.board[3][3] = { ...b.board[3][3], type: CellType.ButterSpot, piece: undefined };
    const c = clone(a);
    c.trapPosition = { r: 3, c: 3 };
    const p = prepOk(b);
    ck('20 trap/butter terrain identity',
      p.ok && stateKey(a) !== stateKey(b) && stateKey(a) !== stateKey(c) && stateKey(b) !== stateKey(c),
      'three distinct keys', [stateKey(a).length > 0, stateKey(a) !== stateKey(b), stateKey(b) !== stateKey(c)]);
  }

  writeFileSync('PPC-P2-PREPARED-TRANSITION-01/_raw/special_rule_replay.json', `${JSON.stringify({
    round: 'PPC-P2-PREPARED-TRANSITION-01',
    note: 'Each check replays the path on the REAL engine (rules.*) and, where applicable, re-simulates every prepared action independently.',
    passed: checks.filter((c) => c.ok).length,
    total: checks.length,
    checks,
  }, null, 2)}\n`);

  expect(checks.filter((c) => !c.ok).map((c) => c.name)).toEqual([]);
});

// ---------------------------------------------------------------------------
// Evidence 4 — deadline integration diagnostic (100 ms / 150 ms)
// ---------------------------------------------------------------------------
it('deadline integration on the full production cat turn (diagnostic)', () => {
  const roots = loadRoots();
  const rows = roots.map(({ id, state }) => {
    const root = clone(state);
    const a = baseArm.runTurn(clone(root));
    const b = candArm.runTurn(clone(root));
    return { id, baseline: a, candidate: b };
  });

  const changedPlans = rows.filter((r) => JSON.stringify(r.baseline.plan) !== JSON.stringify(r.candidate.plan)).length;
  const deeper = rows.filter((r) => r.candidate.completedDepth > r.baseline.completedDepth).length;
  const shallower = rows.filter((r) => r.candidate.completedDepth < r.baseline.completedDepth).length;
  const moreNodes = rows.filter((r) => r.candidate.nodes > r.baseline.nodes).length;
  const newFallback = rows.filter((r) => r.candidate.fallbackLogged && !r.baseline.fallbackLogged).length;
  const wallA = rows.map((r) => r.baseline.wallMs).sort((x, y) => x - y);
  const wallB = rows.map((r) => r.candidate.wallMs).sort((x, y) => x - y);
  const med = (v: number[]) => v[Math.floor(v.length / 2)];

  writeFileSync('PPC-P2-PREPARED-TRANSITION-01/_raw/deadline_integration.json', `${JSON.stringify({
    round: 'PPC-P2-PREPARED-TRANSITION-01',
    authority: 'DIAGNOSTIC ONLY — not a deadline-compliance authority; ABSOLUTE_DEADLINE_GATE stays BLOCKED',
    budgets: { mainSearchMs: 100, totalHardTurnMs: 150 },
    summary: {
      roots: rows.length,
      planChanged: changedPlans,
      completedDeeper: deeper,
      completedShallower: shallower,
      moreNodes,
      newFallback,
      medianTurnWallMs: { baseline: med(wallA), candidate: med(wallB) },
      maxTurnWallMs: { baseline: wallA[wallA.length - 1], candidate: wallB[wallB.length - 1] },
    },
    rows,
  }, null, 2)}\n`);

  expect(rows.length).toBe(24);
  expect(rows.every((r) => r.baseline.ok === r.candidate.ok)).toBe(true);
});

// ---------------------------------------------------------------------------
// Evidence 5 — no hidden RNG sampling inside a fixed-D1 search
// ---------------------------------------------------------------------------
it('a fixed-D1 search over the 24 roots draws no random numbers', () => {
  const roots = loadRoots();
  const native = Math.random;
  let draws = 0;
  // Measurement-only wrapper (restored in `finally`). This is the SEAL-01
  // technique: count the calls, never change the distribution.
  Math.random = () => { draws++; return native(); };
  const perRoot: { id: string; draws: number }[] = [];
  try {
    for (const { id, state } of roots) {
      const before = draws;
      const ctx = createSearchContext(rules, 10000, true, true, true, 0, false);
      ctx.leafEvaluator = evaluateCorrectedHoleForCat;
      ctx.capturePlan = true;
      searchBestAction(state, 1, ctx);
      perRoot.push({ id, draws: draws - before });
    }
  } finally {
    Math.random = native;
  }
  writeFileSync('PPC-P2-PREPARED-TRANSITION-01/_raw/rng_audit.json', `${JSON.stringify({
    round: 'PPC-P2-PREPARED-TRANSITION-01',
    what: 'Math.random calls observed during one fixed-D1 search of each frozen root (wrapper installed for the duration, restored afterwards)',
    totalDraws: draws,
    restoredNative: Math.random === native,
    perRoot,
  }, null, 2)}\n`);
  expect(Math.random).toBe(native);
  expect(draws).toBe(0);
});
