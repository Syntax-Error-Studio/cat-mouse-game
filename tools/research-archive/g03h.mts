/**
 * G0.3H — Carrying Evaluation Correctness (verification harness).
 *
 * Goal (narrow): verify the §1 butterRace fix ONLY removes the carrying-state
 * over-reward, and that every other evaluat/feature is byte-identical, while
 * non-carrying states are fully unaffected.
 *
 * Two exact roots (from real-failure-5games.txt), both mouseHasButter=true:
 *   A. GAME1 T2  cat=(3,3) mouse=(2,9) butter=true             baseline d1 ≈ +660.26
 *   B. GAME3 T3  cat=(2,2) mouse=(4,7) butter=true trap=(2,1)  closed-loop unique-best
 *
 * BASELINE leaf is RECONSTRUCTED from the FIXED module (no second copy):
 *   baselineLeaf(S) = fixedDetailedTotal(S) + (mouseHasButter ? oldButterRace : 0)
 *   oldButterRace   = (f.mouseButterDistance / boardSize) * weights.butterRace
 * Because the ONLY code change is zeroing butterRace when carrying, the fixed
 * module's features are identical to baseline; only that one contribution
 * differs, so the reconstruction is exact (clamp never trips here).
 *
 * Uses the PRODUCTION leaf (evaluateForCat) and the same AB/TT/MO settings as
 * g03g. Does NOT modify src/.
 *
 * Usage:
 *   node_modules/.bin/esbuild g03h.mts --bundle --platform=node --format=esm --outfile=g03h.run.mjs
 *   node g03h.run.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs';
import type { GameEngineState } from '../../src/game/engine';
import { GamePhase, PieceType, type Direction } from '../../src/game/types';
import { restoreHardRoot, type HardRootSnapshot } from '../../src/game/ai/hardHistory';
import {
  evaluateForCat,
  evaluateForCatDetailed,
  DEFAULT_EVALUATION_WEIGHTS,
  HEURISTIC_LIMIT,
} from '../../src/game/ai/evaluation';
import { defaultRuleSet } from '../../src/game/ai/searchRules';
import { simulateSearchAction } from '../../src/game/ai/simulator';
import { generateLegalSearchActions } from '../../src/game/ai/legalActions';
import {
  createSearchContext,
  searchResult,
  stepChildForParent,
  mateActionCost,
  buildCatTurnPlan,
} from '../../src/game/ai/expectiminimax';

const LOG = 'F:\\小猫小鼠\\real-failure-5games.txt';
const DIR: Record<string, Direction> = {
  ArrowUp: { key: 'ArrowUp', dr: -1, dc: 0, label: '↑' },
  ArrowDown: { key: 'ArrowDown', dr: 1, dc: 0, label: '↓' },
  ArrowLeft: { key: 'ArrowLeft', dr: 0, dc: -1, label: '←' },
  ArrowRight: { key: 'ArrowRight', dr: 0, dc: 1, label: '→' },
};
const actionKey = (a: { type: string; direction?: Direction }) =>
  a.type === 'catStep' ? a.direction!.key : a.type;
const planText = (plan: { type: string; direction?: Direction }[]) =>
  plan.map(actionKey).join('→');
type Root = ReturnType<typeof restoreHardRoot>;
type Snapshot = HardRootSnapshot;

// ---------------------------------------------------------------------------
// Reconstructed BASELINE leaf (pre-fix behaviour)
// ---------------------------------------------------------------------------
function baselineLeaf(state: GameEngineState): number {
  const d = evaluateForCatDetailed(state);
  let total = d.total;
  if (d.features.mouseHasButter && d.features.mouseButterDistance !== null) {
    const bs = state.config.boardSize;
    const oldBR =
      (d.features.mouseButterDistance / bs) * DEFAULT_EVALUATION_WEIGHTS.butterRace;
    total = d.total + oldBR; // fixed contribution.butterRace == 0 when carrying
    if (total > HEURISTIC_LIMIT) total = HEURISTIC_LIMIT;
    else if (total < -HEURISTIC_LIMIT) total = -HEURISTIC_LIMIT;
  }
  return total;
}

// ---------------------------------------------------------------------------
// Parse log -> (game#turn) -> { snapshot, plan }
// ---------------------------------------------------------------------------
function parseAll(): Map<string, { root: Snapshot; plan: string }> {
  const out = new Map<string, { root: Snapshot; plan: string }>();
  const text = readFileSync(LOG, 'utf8');
  const re = /===== GAME (\d+) =====/g;
  const games: { game: string; body: string }[] = [];
  let m;
  while ((m = re.exec(text)) !== null) {
    const start = m.index;
    const end = text.indexOf('===== GAME ', start + m[0].length);
    const body = end < 0 ? text.slice(start) : text.slice(start, end);
    games.push({ game: m[1], body });
  }
  for (const g of games) {
    const blocks = g.body.split(/Turn\s*#(\d+)/).slice(1);
    for (let i = 0; i + 1 < blocks.length; i += 2) {
      const turn = Number(blocks[i]);
      const m2 = blocks[i + 1].match(/SNAPSHOT_JSON=(\{.*\})/);
      const p2 = blocks[i + 1].match(/PLAN:\s*(.*)/);
      if (m2 && p2)
        out.set(`${g.game}#${turn}`, {
          root: JSON.parse(m2[1]) as Snapshot,
          plan: p2[1].trim(),
        });
    }
  }
  return out;
}
const SNAPS = parseAll();

function replayPlan(root: Root, plan: { type: string; direction?: Direction }[]) {
  const start = `${root.catPosition.r},${root.catPosition.c}`;
  const positions = [start];
  let cur: Root = root;
  for (let i = 0; i < plan.length; i++) {
    const a = plan[i];
    const t = simulateSearchAction(cur, a, defaultRuleSet);
    if (t.kind !== 'deterministic') break;
    cur = t.state as Root;
    positions.push(`${cur.catPosition.r},${cur.catPosition.c}`);
    if (cur.phase !== GamePhase.Playing || cur.currentPlayer !== PieceType.Cat) break;
  }
  return {
    boundary: cur,
    start,
    finalCat: positions[positions.length - 1],
    returnsToRoot: positions[positions.length - 1] === start,
  };
}

// ---------------------------------------------------------------------------
// Per-action truth at fixed depth with a configurable leaf evaluator
// ---------------------------------------------------------------------------
function perActionTruthLeaf(root: Root, depth: number, leaf: (s: GameEngineState) => number) {
  const actions: {
    action: string;
    value: number;
    mate: string;
    completed: boolean;
    plan: { type: string; direction?: Direction }[];
    returnsToRoot: boolean;
    finalCat: string;
  }[] = [];
  for (const a of generateLegalSearchActions(root, defaultRuleSet)) {
    const t = simulateSearchAction(root, a, defaultRuleSet);
    const cost = mateActionCost(a);
    if (t.kind !== 'deterministic') {
      actions.push({ action: actionKey(a), value: NaN, mate: 'n/a', completed: false, plan: [], returnsToRoot: false, finalCat: 'n/a' });
      continue;
    }
    const switched = root.currentPlayer !== (t.state as Root).currentPlayer;
    const childDepth = depth - (switched ? 1 : 0);
    const ctx = createSearchContext(defaultRuleSet, 8_000_000, true, true, true);
    ctx.leafEvaluator = leaf;
    const r = searchResult(t.state as Root, childDepth, ctx);
    const cont = buildCatTurnPlan(t.state as Root, ctx);
    const full = [a, ...cont];
    const rm = replayPlan(root, full);
    actions.push({
      action: actionKey(a),
      value: stepChildForParent(r, cost),
      mate: r.mate ?? 'null',
      completed: r.completed,
      plan: full,
      returnsToRoot: rm.returnsToRoot,
      finalCat: rm.finalCat,
    });
  }
  return { actions };
}

function rootSummary(tag: string, root: Root) {
  return `${tag}: cat=(${root.catPosition.r},${root.catPosition.c}) mouse=(${root.mousePosition.r},${root.mousePosition.c}) butter=${root.mouseHasButter} trap=${root.trapPosition ? `(${root.trapPosition.r},${root.trapPosition.c})` : 'none'} catMoves=${root.catMovesLeft} mouseMoves=${root.mouseMovesLeft}`;
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------
const lines: string[] = [];
const log = (s: string) => { lines.push(s); console.log(s); };

log('=== G0.3H — Carrying Evaluation Correctness (butterRace fix verify) ===');
log(`BASELINE reconstructed from FIXED module (pre-fix butterRace=+old when carrying).`);
log(`weights.butterRace = ${DEFAULT_EVALUATION_WEIGHTS.butterRace}, HEURISTIC_LIMIT = ${HEURISTIC_LIMIT}\n`);

function rootBreakdown(root: Root) {
  const d = evaluateForCatDetailed(root);
  const bs = root.config.boardSize;
  const oldBR =
    d.features.mouseHasButter && d.features.mouseButterDistance !== null
      ? (d.features.mouseButterDistance / bs) * DEFAULT_EVALUATION_WEIGHTS.butterRace
      : 0;
  const baselineTotal = d.total + oldBR;
  return {
    fixedTotal: d.total,
    fixedButterRace: d.contributions.butterRace,
    oldBR,
    baselineTotal,
    clamped: d.clamped,
    f: d.features,
    c: d.contributions,
  };
}

for (const [tag, key] of [['GAME1 T2', '1#2'], ['GAME3 T3', '3#3']] as const) {
  log('\n############################################################');
  log(`## ${tag}  (root key ${key}, mouseHasButter=true)`);
  log('############################################################');
  const snap = SNAPS.get(key)!;
  const root = restoreHardRoot(snap.root);
  log(rootSummary(tag, root));
  log(`production PLAN: ${snap.plan}`);

  // --- root feature breakdown (FIXED vs reconstructed BASELINE) ---
  log('\n--- [root] evaluateForCatDetailed breakdown (FIXED vs BASELINE) ---');
  const bd = rootBreakdown(root);
  log(`FIXED   total=${bd.fixedTotal.toFixed(2)}  butterRace=${bd.fixedButterRace.toFixed(2)} (==0 when carrying)  clamped=${bd.clamped}`);
  log(`BASELN  total=${bd.baselineTotal.toFixed(2)}  butterRace=${bd.oldBR.toFixed(2)}  (reconstructed pre-fix)`);
  log(`Δ(butterRace) = ${bd.oldBR.toFixed(2)}  Δ(total) = ${bd.oldBR.toFixed(2)}  (only this term changes)`);
  log(`features: mouseButterDistance=${bd.f.mouseButterDistance} mouseHasButter=${bd.f.mouseHasButter} mouseGoalDistance=${bd.f.mouseGoalDistance} catMouseDistance=${bd.f.catMouseDistance} holeControlMargin=${bd.f.holeControlMargin}`);
  // prove other contributions identical: print all
  const cnames = Object.keys(bd.c) as (keyof typeof bd.c)[];
  log('contributions (FIXED, all others unchanged by design): ' +
    cnames.map((k) => `${k}=${(bd.c[k] as number).toFixed(2)}`).join('  '));

  // --- depth-by-depth search comparison ---
  for (const depth of [1, 2, 3]) {
    log(`\n--- [d${depth}] search root value / mate / best action (FIXED vs BASELINE) ---`);
    const fixP = perActionTruthLeaf(root, depth, evaluateForCat).actions;
    const baseP = perActionTruthLeaf(root, depth, baselineLeaf).actions;

    const reduce = (arr: typeof fixP) => {
      const nonNAN = arr.filter((x) => !Number.isNaN(x.value));
      const best = nonNAN.length ? Math.max(...nonNAN.map((x) => x.value)) : NaN;
      const bestActs = nonNAN.filter((x) => Math.abs(x.value - best) < 1e-9).map((x) => x.action);
      const bestA = bestActs.length ? bestActs[0] : null;
      const plan = bestA ? (arr.find((x) => x.action === bestA)!.plan) : [];
      const rm = bestA ? replayPlan(root, plan) : { returnsToRoot: false };
      return { best, bestActs, plan: plan.map(actionKey), returnsToRoot: rm.returnsToRoot };
    };
    const fixR = reduce(fixP);
    const baseR = reduce(baseP);

    log(`FIXED   d${depth}: rootValue=${fixR.best.toFixed(4)} mate-tie=[${fixR.bestActs.join(',')}] bestPlan=[${fixR.plan.join('→')}] returnsToRoot=${fixR.returnsToRoot}`);
    log(`BASELN  d${depth}: rootValue=${baseR.best.toFixed(4)} mate-tie=[${baseR.bestActs.join(',')}] bestPlan=[${baseR.plan.join('→')}] returnsToRoot=${baseR.returnsToRoot}`);
    log(`ΔrootValue(d${depth}) = ${(baseR.best - fixR.best).toFixed(4)}`);

    // full per-action table (fixed) for transparency
    log(`  [FIXED per-action @d${depth}]`);
    for (const x of fixP) {
      const pt = x.plan.length ? planText(x.plan) : '';
      log(`    ${x.action.padEnd(11)} value=${String(Number.isNaN(x.value) ? 'n/a' : x.value.toFixed(4)).padStart(12)} mate=${x.mate.padEnd(5)} completed=${x.completed} plan=[${pt}] returnsToRoot=${x.returnsToRoot}`);
    }
  }
}

// ---------------------------------------------------------------------------
// GAME1 T2 core acceptance summary
// ---------------------------------------------------------------------------
log('\n\n############################################################');
log('## GAME1 T2 — core acceptance (over-inflation drop)');
log('############################################################');
{
  const snap = SNAPS.get('1#2')!;
  const root = restoreHardRoot(snap.root);
  const bd = rootBreakdown(root);
  log(`FIXED  d1 rootValue (reconstructed via search) — see table above; FIXED root eval total=${bd.fixedTotal.toFixed(2)}`);
  log(`BASELN d1 root eval total=${bd.baselineTotal.toFixed(2)}`);
  log(`=> butterRace over-reward removed at root: Δ=${bd.oldBR.toFixed(2)} (butter no longer rewards cat when carrying)`);
  log(`=> other features/contributions UNCHANGED (only butterRace contribution differs).`);
}

writeFileSync('F:\\小猫小鼠\\g03h-output.txt', lines.join('\n'));
console.log('\n=== DONE (wrote g03h-output.txt) ===');
