/// <reference types="node" />
/**
 * PPC-HV19 — ghost-butter gift risk screening (RESEARCH ONLY).
 *
 * Pre-registered before any screening result is observed:
 *   GAME2 T4  : LLLL (production), DUDU, RUDD
 *   GAME4 T8  : production plan + one representative candidate selected from
 *               the sorted complete-cat-turn census (screen-blind, deterministic)
 *   GAME4 T7  : production plan (complexity / UNKNOWN control)
 *   reverse    : GAME1 T1, GAME2 T7, GAME3 T8 (immediate capture),
 *                GAME5 T12 (immediate capture)
 *
 * P2 = layer 1 (SUSPECTED_RISK / NOT_DETECTED), P3 = layer 2 certification with
 * formal announcement weights. No production module is modified and the
 * screener is never wired into the Hard AI.
 */
import { createHash } from 'node:crypto';
import { expect, test } from 'vitest';
import { createEngineRuleSet } from '../../engine';
import type { GameEngineState } from '../../engine';
import { GamePhase, PieceType } from '../../types';
import { stateKey } from '../transposition';
import { simulateSearchAction } from '../simulator';
import type { SearchAction } from '../searchTypes';
import {
  GAMES,
  LOG_SHA256,
  logSha,
  logText,
  parseTurnBlocks,
  restoreTurn,
  rootOf,
  applyCatPlan,
  planText,
  catStep,
  mouseStep,
} from './hv19Roots';
import type { GameName } from './hv19Roots';
import {
  makeScreenBudget,
  screenHandoff,
  certifyCandidate,
  aggregateCertificates,
  enumCatTurns,
  mouseWinWithin,
} from './hv19GhostGiftScreen';
import type { CertifyResult, GiftSuspect, Layer1Result, WinVerdict } from './hv19GhostGiftScreen';

const rules = createEngineRuleSet();
const rc = (p: { r: number; c: number }): string => `${p.r},${p.c}`;

const DUDU: SearchAction[] = [catStep('Down'), catStep('Up'), catStep('Down'), catStep('Up')];
const RUDD: SearchAction[] = [catStep('Right'), catStep('Up'), catStep('Down'), catStep('Down')];

interface FrozenCase {
  id: string;
  game: GameName;
  turn: number;
  plan: SearchAction[];
  note: string;
}

let CASE_CACHE: FrozenCase[] | null = null;

/**
 * Build the pre-registered set. The only computed member is the T8
 * representative candidate: the first label of the SORTED complete-cat-turn
 * census that differs from the production plan. Sorting makes it independent
 * of traversal order and it never looks at a screening result.
 */
function frozenCases(): FrozenCase[] {
  if (CASE_CACHE) return CASE_CACHE;
  const t4 = rootOf('GAME2', 4);
  if (planText(t4.plan) !== 'LLLL') throw new Error(`GAME2 T4 production plan changed: ${planText(t4.plan)}`);
  const t7 = rootOf('GAME4', 7);
  const t8 = rootOf('GAME4', 8);
  const census = enumCatTurns(t8.state, makeScreenBudget(180_000, 6_000_000), rules);
  if (!census.complete) throw new Error(`T8 root census incomplete: ${census.overflow}`);
  const labels = [...new Set(census.plans.map((p) => p.label))].sort();
  const prodLabel = planText(t8.plan);
  const repLabel = labels.find((l) => l !== prodLabel) ?? labels[0];
  const rep = census.plans.find((p) => p.label === repLabel);
  if (!rep) throw new Error('T8 representative candidate missing');
  CASE_CACHE = [
    { id: 'T4-LLLL', game: 'GAME2', turn: 4, plan: t4.plan, note: 'GAME2 T4 production plan' },
    { id: 'T4-DUDU', game: 'GAME2', turn: 4, plan: DUDU, note: 'GAME2 T4 h=2 survivable counter-candidate' },
    { id: 'T4-RUDD', game: 'GAME2', turn: 4, plan: RUDD, note: 'GAME2 T4 h=2 survivable counter-candidate' },
    { id: 'T8-PROD', game: 'GAME4', turn: 8, plan: t8.plan, note: 'GAME4 T8 production plan' },
    { id: `T8-CENSUS-${repLabel}`, game: 'GAME4', turn: 8, plan: rep.actions, note: 'GAME4 T8 representative candidate (sorted root census)' },
    { id: 'T7-PROD', game: 'GAME4', turn: 7, plan: t7.plan, note: 'GAME4 T7 complexity / UNKNOWN control' },
    { id: 'CTRL-G1T1', game: 'GAME1', turn: 1, plan: rootOf('GAME1', 1).plan, note: 'reverse control' },
    { id: 'CTRL-G2T7', game: 'GAME2', turn: 7, plan: rootOf('GAME2', 7).plan, note: 'reverse control' },
    { id: 'CTRL-G3T8', game: 'GAME3', turn: 8, plan: rootOf('GAME3', 8).plan, note: 'immediate cat capture' },
    { id: 'CTRL-G5T12', game: 'GAME5', turn: 12, plan: rootOf('GAME5', 12).plan, note: 'immediate cat capture' },
  ];
  return CASE_CACHE;
}

interface AppliedCase {
  root: ReturnType<typeof rootOf>;
  applied: ReturnType<typeof applyCatPlan>;
}

function applyCase(c: FrozenCase): AppliedCase {
  const root = rootOf(c.game, c.turn);
  return { root, applied: applyCatPlan(root.state, c.plan, rules) };
}

interface ScreenRow {
  c: FrozenCase;
  applied: ReturnType<typeof applyCatPlan>;
  handoffs: GameEngineState[];
  results: Layer1Result[];
  suspects: GiftSuspect[];
  elapsedMs: number;
}

function screenCase(c: FrozenCase, wallMs: number, maxSimCalls: number): ScreenRow {
  const { applied } = applyCase(c);
  const handoffs = applied.handoffs.map((h) => h.state);
  const results: Layer1Result[] = [];
  const suspects: GiftSuspect[] = [];
  const t0 = performance.now();
  for (const h of handoffs) {
    const b = makeScreenBudget(wallMs, maxSimCalls);
    const r = screenHandoff(h, rules, b);
    results.push(r);
    suspects.push(...r.suspects);
  }
  return { c, applied, handoffs, results, suspects, elapsedMs: performance.now() - t0 };
}

// ===========================================================================
// HV19-0. baseline: logs, roots, state keys
// ===========================================================================
test('HV19-0 baseline logs and all 45 roots verify', () => {
  let total = 0;
  const rows: string[] = [];
  for (const game of GAMES) {
    expect(logSha(game), `${game} SHA256`).toBe(LOG_SHA256[game]);
    const blocks = parseTurnBlocks(logText(game));
    for (const b of blocks) {
      const r = restoreTurn(game, b);
      expect(stateKey(r.state), `${game} T${b.turn} snapshot -> STATE_KEY`).toBe(r.loggedKey);
      total++;
    }
    rows.push(`${game} turns=${blocks.length}`);
  }
  // eslint-disable-next-line no-console
  console.log(`\nHV19-0 baseline: ${rows.join(' ')} roots=${total}`);
  expect(total).toBe(45);
}, 120_000);

// ===========================================================================
// HV19-1. frozen pre-registration
// ===========================================================================
test('HV19-1 pre-registered root/plan set is complete, legal and frozen', () => {
  const rows: string[] = [];
  for (const c of frozenCases()) {
    const { root, applied } = applyCase(c);
    expect(applied.ok, `${c.id} is a complete legal cat turn`).toBe(true);
    const planSha = createHash('sha256').update(planText(c.plan)).digest('hex').slice(0, 16);
    const h = applied.handoffs[0]?.state;
    rows.push(
      `${c.id} ${c.game} T${c.turn} plan=${planText(c.plan)} sha=${planSha}`
      + ` rootKey=${root.loggedKey.slice(0, 12)} handoffs=${applied.handoffs.length} chance=${applied.chance}`
      + (h ? ` phase=${h.phase} player=${h.currentPlayer} mouse=${rc(h.mousePosition)} cat=${rc(h.catPosition)}`
        + ` carry=${h.mouseHasButter} moves=${h.mouseMovesLeft} ghosts=${h.pendingButterSpawns?.length ?? 0}` : '')
      + ` # ${c.note}`,
    );
  }
  // eslint-disable-next-line no-console
  console.log(`\nHV19-1 frozen set (${rows.length} cases)\n  ${rows.join('\n  ')}`);

  const byId = new Map(frozenCases().map((c) => [c.id, c]));
  const t4 = applyCase(byId.get('T4-LLLL')!);
  expect(t4.applied.handoffs[0].state.mouseHasButter, 'T4 LLLL handoff is not carrying').toBe(false);
  const t8 = applyCase(byId.get('T8-PROD')!);
  expect(t8.applied.handoffs[0].state.mouseHasButter, 'T8 handoff is already carrying').toBe(true);
  const t7 = applyCase(byId.get('T7-PROD')!);
  expect(t7.applied.handoffs[0].state.mouseHasButter, 'T7 handoff is already carrying').toBe(true);
  for (const id of ['CTRL-G3T8', 'CTRL-G5T12']) {
    const a = applyCase(byId.get(id)!);
    expect(a.applied.handoffs[0].state.phase, `${id} is an immediate cat capture`).toBe(GamePhase.CatWins);
  }
});

// ===========================================================================
// HV19-2. layer 1 across the frozen set (generous budget)
// ===========================================================================
let SCREEN_CACHE: ScreenRow[] | null = null;
function screens(): ScreenRow[] {
  if (!SCREEN_CACHE) SCREEN_CACHE = frozenCases().map((c) => screenCase(c, 5_000, 4_000_000));
  return SCREEN_CACHE;
}

test('HV19-2 layer 1: suspects on T4 LLLL only, no counter-candidate alarm', () => {
  const rows: ScreenRow[] = screens();
  const lines = rows.map((r) => {
    const l = r.results[0];
    return `${r.c.id} ${l.label} complete=${l.complete} carry=${l.alreadyCarrying}`
      + ` suspects=[${r.suspects.map((s) => `${rc(s.ghostCell)}:${s.source}:1/${s.announcementN}`).join(' ')}]`
      + ` t=${r.elapsedMs.toFixed(1)}ms note=${l.note}`;
  });
  // eslint-disable-next-line no-console
  console.log(`\nHV19-2 layer 1\n  ${lines.join('\n  ')}`);

  const byId = new Map(rows.map((r) => [r.c.id, r]));
  const t4 = byId.get('T4-LLLL')!;
  expect(t4.results[0].label, 'T4 LLLL is suspected').toBe('SUSPECTED_RISK');
  expect(t4.results[0].complete, 'T4 LLLL scan completes').toBe(true);
  expect(t4.suspects.some((s) => rc(s.ghostCell) === '6,6'), '(6,6) is a suspect').toBe(true);

  for (const id of ['T4-DUDU', 'T4-RUDD']) {
    const r = byId.get(id)!;
    expect(r.results[0].label, `${id} must not be suspected`).toBe('NOT_DETECTED');
    expect(r.results[0].complete, `${id} scan completes`).toBe(true);
    expect(r.suspects.some((s) => rc(s.ghostCell) === '6,6'), `${id} has no (6,6) suspect`).toBe(false);
  }

  for (const r of rows) {
    if (r.c.game !== 'GAME4' || (r.c.turn !== 7 && r.c.turn !== 8)) continue;
    expect(r.results[0].alreadyCarrying, `${r.c.id} handoff is already carrying`).toBe(true);
    expect(r.results[0].label, `${r.c.id} is outside ghost-gift scope`).toBe('NOT_DETECTED');
  }

  for (const id of ['CTRL-G3T8', 'CTRL-G5T12']) {
    const r = byId.get(id)!;
    expect(r.results[0].label, `${id} does not deny the cat capture`).toBe('NOT_DETECTED');
    expect(r.results[0].note, `${id} terminal note`).toBe('terminal:cat_wins');
  }

  for (const id of ['CTRL-G1T1', 'CTRL-G2T7']) {
    const r = byId.get(id)!;
    expect(r.results[0].complete, `${id} scan completes`).toBe(true);
    expect(r.results[0].label, `${id} has no ghost gift`).toBe('NOT_DETECTED');
  }
}, 180_000);

// ===========================================================================
// HV19-3. layer 2 certification on T4 LLLL + probability certificate
// ===========================================================================
let CERT_CACHE: { row: ScreenRow; certified: { cand: GiftSuspect; res: CertifyResult }[] } | null = null;
function certifiedT4(): { row: ScreenRow; certified: { cand: GiftSuspect; res: CertifyResult }[] } {
  if (CERT_CACHE) return CERT_CACHE;
  const row = screens().find((r) => r.c.id === 'T4-LLLL')!;
  const certified = row.suspects.map((cand) => ({
    cand,
    res: certifyCandidate(row.handoffs[0], cand, rules, makeScreenBudget(90_000, 30_000_000)),
  }));
  CERT_CACHE = { row, certified };
  return CERT_CACHE;
}

test('HV19-3 layer 2: T4 LLLL certificates are PROVEN with formal weights', () => {
  const { row, certified } = certifiedT4();
  const lines = certified.map(({ cand, res }) =>
    `${rc(cand.ghostCell)} ${res.status} reason=${res.reason} w=1/${cand.announcementN}`
    + ` route=${res.route} catPlans=${res.catPlans} catOutcomes=${res.catOutcomes}`
    + ` catWins=${res.catWins} winChecks=${res.distinctWinChecks} t=${res.elapsedMs.toFixed(1)}ms`);
  // eslint-disable-next-line no-console
  console.log(`\nHV19-3 layer 2 T4 LLLL\n  ${lines.join('\n  ')}`);

  const proven = certified.filter((x) => x.res.status === 'PROVEN');
  expect(proven.length, 'at least one certified gift cell').toBeGreaterThan(0);
  expect(proven.some((x) => rc(x.cand.ghostCell) === '6,6'), '(6,6) is certified').toBe(true);
  for (const x of certified) {
    expect(x.res.status, `${rc(x.cand.ghostCell)} is never UNKNOWN after a complete run`).not.toBe('UNKNOWN');
    expect(['PROVEN', 'REFUTED']).toContain(x.res.status);
  }
  // Every non-certified suspect must be refuted by a concrete cat response.
  for (const x of certified) {
    if (x.res.status === 'REFUTED') {
      expect(x.res.reason.length).toBeGreaterThan(0);
    }
  }

  const certs = aggregateCertificates(certified);
  const top = certs[0];
  expect(top, 'a probability certificate exists').toBeTruthy();
  expect(top.weightSum, 'lower bound >= 2/30 (HV18R)').toBeGreaterThanOrEqual(2 / 30 - 1e-12);
  expect(top.weightSum, 'never probability 1').toBeLessThan(1 - 1e-12);
  expect(top.cells.length, 'certified cell count matches the weight sum').toBeGreaterThan(1);
  // eslint-disable-next-line no-console
  console.log(
    `\nHV19-3 certificate pickup=${top.pickupKey} N=${top.announcementN}`
    + ` cells=[${top.cells.map(rc).join(' ')}] weightSum=${top.weightSum.toFixed(6)} (=${top.cells.length}/${top.announcementN})`,
  );
  // The mouse's own pickup choice means the plan-level bound is the MAX pickup,
  // never the sum over different pickups.
  for (const c of certs.slice(1)) expect(c.weightSum).toBeLessThanOrEqual(top.weightSum + 1e-12);
  // Sanity: the handoff really is a mouse-to-move non-carrying position.
  expect(row.handoffs[0].currentPlayer).toBe(PieceType.Mouse);
  expect(row.handoffs[0].mouseHasButter).toBe(false);
}, 300_000);

// ===========================================================================
// HV19-4. independent witness replay + every boundary outcome wins
// ===========================================================================
test('HV19-4 independent replay of the (6,6) witness and boundary', () => {
  const { row, certified } = certifiedT4();
  const w66 = certified.find((x) => x.cand.source === 'PICKUP' && rc(x.cand.ghostCell) === '6,6');
  expect(w66, '(6,6) PICKUP certificate').toBeTruthy();
  expect(w66!.res.status).toBe('PROVEN');

  let s = row.handoffs[0];
  const prefixLen = w66!.cand.prefix.length;
  for (let i = 0; i < w66!.res.routeActions.length; i++) {
    const a = w66!.res.routeActions[i];
    const tr = simulateSearchAction(s, a, rules);
    if (i === prefixLen) {
      // The pickup itself is the formal announcement CHANCE node: select the
      // outcome that announces the ghost on the certified cell.
      expect(tr.kind, 'pickup is a chance node').toBe('chance');
      if (tr.kind !== 'chance') throw new Error('unexpected deterministic pickup');
      const target = tr.outcomes.filter((o) => {
        const before = new Set((s.pendingButterSpawns ?? []).map((p) => `${p.r},${p.c}`));
        return (o.state.pendingButterSpawns ?? []).some((p) => !before.has(`${p.r},${p.c}`) && p.r === 6 && p.c === 6);
      });
      expect(target.length, 'exactly one (6,6) announcement outcome').toBe(1);
      s = target[0].state;
      continue;
    }
    expect(tr.kind, 'independent replay is deterministic').toBe('deterministic');
    if (tr.kind !== 'deterministic') throw new Error('unexpected chance during replay');
    s = tr.state;
  }
  expect(s.currentPlayer, 'the witness ends the mouse turn').toBe(PieceType.Cat);
  expect(rc(s.mousePosition), 'the mouse ends on the ghost cell').toBe('6,6');
  expect((s.pendingButterSpawns ?? []).some((p) => p.r === 6 && p.c === 6), 'ghost pending at hand-off').toBe(true);
  expect(s.mouseHasButter, 'the skill consumed the carried butter before the gift').toBe(false);

  // Enumerate every legal cat turn and every formal boundary outcome from here.
  const ct = enumCatTurns(s, makeScreenBudget(120_000, 20_000_000), rules);
  expect(ct.complete, 'cat enumeration completes').toBe(true);
  expect(ct.plans.length).toBeGreaterThan(0);
  const memo = new Map<string, WinVerdict>();
  const winBudget = makeScreenBudget(120_000, 20_000_000);
  let outcomes = 0;
  for (const p of ct.plans) {
    for (const o of p.outcomes) {
      expect(o.phase, 'no cat turn captures the mouse at the gift cell').not.toBe(GamePhase.CatWins);
      outcomes++;
      if (o.phase === GamePhase.MouseWins) continue;
      expect(o.currentPlayer, 'boundary hands the mouse its turn').toBe(PieceType.Mouse);
      expect(o.mouseHasButter, 'the boundary auto-picks the ghost').toBe(true);
      expect(o.mouseMovesLeft, 'carrying move budget').toBe(s.config.mouseCarryingMoves);
      expect(mouseWinWithin(o, winBudget, rules, memo), 'mouse wins in its next turn').toBe('yes');
    }
  }
  // eslint-disable-next-line no-console
  console.log(`\nHV19-4 independent witness: route=${w66!.res.route} catPlans=${ct.plans.length} outcomes=${outcomes} => every outcome is a mouse win`);
}, 300_000);

// ===========================================================================
// HV19-5. counter-candidates and cat captures are not falsely certified
// ===========================================================================
test('HV19-5 DUDU/RUDD forced candidate and cat captures are refuted, not certified', () => {
  const rows = screens();
  const dudu = rows.find((r) => r.c.id === 'T4-DUDU')!;
  const rudd = rows.find((r) => r.c.id === 'T4-RUDD')!;
  const t4 = rows.find((r) => r.c.id === 'T4-LLLL')!;

  // The exact known gift cell, forced onto each counter-plan hand-off. It is a
  // test oracle, NOT a detection rule: the screener itself never knows this cell.
  const forced: string[] = [];
  for (const row of [dudu, rudd]) {
    const pickup = simulateSearchAction(row.handoffs[0], mouseStep('Right'), rules);
    expect(pickup.kind, `${row.c.id} Right picks butter`).toBe('chance');
    if (pickup.kind !== 'chance') throw new Error('no pickup');
    const N = pickup.outcomes.length;
    const has66 = pickup.outcomes.some((o) => {
      const add = o.state.pendingButterSpawns ?? [];
      return add.some((p) => p.r === 6 && p.c === 6);
    });
    const cand: GiftSuspect = {
      source: 'PICKUP',
      ghostCell: { r: 6, c: 6 },
      weight: 1 / N,
      announcementN: N,
      prefix: [],
      pickup: mouseStep('Right'),
      suffix: [],
      catReachable: false,
    };
    const res = certifyCandidate(row.handoffs[0], cand, rules, makeScreenBudget(60_000, 20_000_000));
    expect(res.status, `${row.c.id} (6,6) is never PROVEN`).not.toBe('PROVEN');
    forced.push(`${row.c.id} N=${N} (6,6)-in-support=${has66} -> ${res.status}:${res.reason}`);
  }
  // eslint-disable-next-line no-console
  console.log(`\nHV19-5 forced counter-candidates\n  ${forced.join('\n  ')}`);

  // The same forced cell on LLLL IS certifiable — the difference is the real
  // cat position, not the geometry.
  const pickup = simulateSearchAction(t4.handoffs[0], mouseStep('Right'), rules);
  if (pickup.kind !== 'chance') throw new Error('T4 pickup is not chance');
  const llll: GiftSuspect = {
    source: 'PICKUP', ghostCell: { r: 6, c: 6 }, weight: 1 / pickup.outcomes.length,
    announcementN: pickup.outcomes.length, prefix: [], pickup: mouseStep('Right'),
    suffix: [], catReachable: false,
  };
  const ok = certifyCandidate(t4.handoffs[0], llll, rules, makeScreenBudget(90_000, 30_000_000));
  expect(ok.status, 'LLLL (6,6) is PROVEN').toBe('PROVEN');

  // Immediate cat captures stay captures: the screener never denies them.
  for (const id of ['CTRL-G3T8', 'CTRL-G5T12']) {
    const r = rows.find((x) => x.c.id === id)!;
    expect(r.results[0].label).toBe('NOT_DETECTED');
    expect(r.results[0].note).toBe('terminal:cat_wins');
    expect(r.suspects.length).toBe(0);
  }
}, 300_000);

// ===========================================================================
// HV19-6. UNKNOWN / INCOMPLETE is never promoted
// ===========================================================================
test('HV19-6 truncated scans and budgets are UNKNOWN/NOT_DETECTED, never PROVEN', () => {
  const row = screens().find((r) => r.c.id === 'T4-LLLL')!;
  const tinyL1 = screenHandoff(row.handoffs[0], rules, makeScreenBudget(1_000, 1));
  expect(tinyL1.complete, 'tiny budget cannot complete the scan').toBe(false);
  expect(tinyL1.label, 'incomplete scan is not a risk label').toBe('NOT_DETECTED');
  expect(tinyL1.note.startsWith('scan-incomplete'), `note=${tinyL1.note}`).toBe(true);

  const cand: GiftSuspect = {
    source: 'PICKUP', ghostCell: { r: 6, c: 6 }, weight: 1 / 30,
    announcementN: 30, prefix: [], pickup: mouseStep('Right'), suffix: [], catReachable: false,
  };
  const tinyL2 = certifyCandidate(row.handoffs[0], cand, rules, makeScreenBudget(1_000, 1));
  expect(tinyL2.status, 'a truncated certificate is UNKNOWN').toBe('UNKNOWN');
  expect(tinyL2.status, 'UNKNOWN is never PROVEN').not.toBe('PROVEN');

  // A refutation is a legitimate negative, not an UNKNOWN promotion.
  const wrongCell: GiftSuspect = { ...cand, ghostCell: { r: 1, c: 1 } };
  const wrong = certifyCandidate(row.handoffs[0], wrongCell, rules, makeScreenBudget(30_000, 10_000_000));
  expect(wrong.status, 'a non-announced cell is REFUTED').toBe('REFUTED');
}, 120_000);
