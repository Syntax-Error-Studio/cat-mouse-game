import { describe, expect, it } from 'vitest';
import { GamePhase } from '../../types';
import { enumerateCatTurnExact, h1Turn, handOffToMouse, replayCatPlan, rc } from './hv5ForcedLineAuditor';
import {
  T4_LOG_SHA256,
  analysePlan,
  comparePlans,
  defenceClassOf,
  enumerateMouseTurn,
  isCatLossClaim,
  isCausalOneTurnBlock,
  isTerminalCatWin,
  refutationScopeOf,
  runCatPlan,
  t4LogSha256,
  type ResponseDefence,
} from './hv12MouseResponses';
import { LIGHT_CAUSAL_CAPS, causalScan, semanticCounts, withCausal } from './hv13DefenceSemantics';

const wide = {
  scout: { nodeCap: 20_000, maxEndStates: 96, maxTargetsPerEnd: 6, maxCatMoveCalls: 12_000, maxHoldProofs: 1 },
  catNodeCap: 20_000,
  mouseNodeCap: 20_000,
  maxDefenceCandidates: 4,
  maxResponses: 120,
};

const A_TOKENS = ['U', 'U', 'U', 'R'];
const B_TOKENS = ['R', 'R', 'R', 'R'];
const LLRR = ['L', 'L', 'R', 'R'];
const LLLL = ['L', 'L', 'L', 'L'];

interface Built {
  a: ReturnType<typeof analysePlan>;
  b: ReturnType<typeof analysePlan>;
  aEnds: Map<string, ReturnType<typeof enumerateMouseTurn>['ends'][number]>;
  bEnds: Map<string, ReturnType<typeof enumerateMouseTurn>['ends'][number]>;
}

let built: Built | null = null;
const build = (): Built => {
  if (built) return built;
  const runA = runCatPlan(A_TOKENS);
  const runB = runCatPlan(B_TOKENS);
  const a = analysePlan('A', A_TOKENS, { caps: wide, maxResponses: 120, mouseNodeCap: 120_000 });
  const b = analysePlan('B', B_TOKENS, { caps: wide, maxResponses: 120, mouseNodeCap: 120_000 });
  const aEnds = new Map(enumerateMouseTurn(runA.mouseStart, { nodeCap: 120_000 }).ends.map((e) => [e.key, e]));
  const bEnds = new Map(enumerateMouseTurn(runB.mouseStart, { nodeCap: 120_000 }).ends.map((e) => [e.key, e]));
  built = { a, b, aEnds, bEnds };
  return built;
};

const pick = (r: ReturnType<typeof analysePlan>, actions: string[]): ResponseDefence => {
  const x = r.responses.find((y) => y.actions.join('/') === actions.join('/'));
  if (!x) throw new Error(`response [${actions.join('')}] is not a legal complete response`);
  return x;
};

let t6Scan: { ends: number; losses: number; firstPlan: string; firstWin: string[]; truncated: boolean } | null = null;
const scanT6 = () => {
  if (t6Scan) return t6Scan;
  const t6 = h1Turn(6);
  const turn = enumerateCatTurnExact([{ state: t6.state, plan: [] }], 20_000);
  let losses = 0;
  let firstPlan = '';
  let firstWin: string[] = [];
  for (const e of turn.ends) {
    const mt = enumerateMouseTurn(handOffToMouse(e.state, true), { nodeCap: 20_000 });
    const win = mt.ends.find((x) => x.terminal === 'MOUSE_WINS');
    if (win) {
      losses++;
      if (firstPlan === '') { firstPlan = e.plan.join(''); firstWin = win.actions; }
    }
  }
  t6Scan = { ends: turn.ends.length, losses, firstPlan, firstWin, truncated: turn.truncated };
  return t6Scan;
};

describe('HV13 §1 classification semantics — no witness is not a loss, no local witness is causal', () => {
  it('H13-A0: provenance and the two plans are still the real T4 ones', () => {
    expect(t4LogSha256()).toBe(T4_LOG_SHA256);
    const a = runCatPlan(A_TOKENS);
    const b = runCatPlan(B_TOKENS);
    console.log(`H13-A0 A=[${a.applied.join('')}]@${rc(a.end.catPosition)} illegal=${a.illegalAt ?? '-'} | B=[${b.applied.join('')}]@${rc(b.end.catPosition)} illegal=${b.illegalAt ?? '-'}`);
    expect(a.illegalAt).toBeNull();
    expect(b.illegalAt).toBeNull();
    expect(rc(a.end.catPosition)).toBe('2,2');
    expect(rc(b.end.catPosition)).toBe('5,5');
  });

  it('H13-A1: NO_IMMEDIATE_DEFENCE_FOUND is local safety, never a cat loss', () => {
    const { a, b } = build();
    const x = pick(a, LLRR);
    console.log(`H13-A1 A LLRR result=${x.result} class=${defenceClassOf(x)} scope=${refutationScopeOf(x)} nextChecked=${x.nextMouseChecked} nextWin=${x.nextMouseWinSteps ?? '-'} baseline=${x.baselineMouseWinSteps ?? '-'}`);
    expect(x.result).toBe('NO_IMMEDIATE_DEFENCE_FOUND');
    expect(x.nextMouseChecked).toBe(true);
    expect(x.nextMouseWinSteps).toBeNull();
    expect(defenceClassOf(x)).toBe('NO_MOUSE_WIN_NEXT_TURN');
    expect(refutationScopeOf(x)).toBe('NONE');
    expect(isCatLossClaim(x)).toBe(false);

    const cmp = comparePlans(a, b, LLRR);
    console.log(`H13-A1 compare bWorse=${cmp.bWorse.length} captureLoss=${cmp.captureLoss.length} aWorse=${cmp.aWorse.length} heldOnlyA=${cmp.heldOnlyA.length} heldOnlyB=${cmp.heldOnlyB.length} undecided=${cmp.undecided.length} verdict=${cmp.verdict}`);
    expect(cmp.bWorse).toHaveLength(0);
    expect(cmp.aWorse).toHaveLength(0);
    expect(cmp.human.a).not.toBeNull();
    expect(isCatLossClaim(cmp.human.a!)).toBe(false);
  });

  it('H13-A2: a single refuted plan is SPECIFIC; ALL needs the complete all-plan scan (real T6 state)', () => {
    const { a } = build();
    const base = pick(a, LLRR);
    const scan = scanT6();
    console.log(`H13-A2 T6 cat ends=${scan.ends} truncated=${scan.truncated} plans with a one-turn mouse win=${scan.losses} first=[${scan.firstPlan}] -> ${scan.firstWin.join('')}`);
    expect(scan.truncated).toBe(false);
    expect(scan.ends).toBeGreaterThan(30);
    expect(scan.losses).toBe(scan.ends);
    const single: ResponseDefence = {
      ...base,
      result: 'PROVEN_LOCAL_BYPASS',
      immediateCapture: null,
      witness: null,
      terminalMouseWin: false,
      allPlansRefuted: false,
      nextMouseChecked: true,
      nextMouseWinSteps: scan.firstWin.length,
    };
    console.log(`H13-A2 one plan checked -> scope=${refutationScopeOf(single)} | all ${scan.losses}/${scan.ends} checked -> scope=${refutationScopeOf({ ...single, allPlansRefuted: true })}`);
    expect(refutationScopeOf(single)).toBe('SPECIFIC_CAT_PLAN');
    expect(refutationScopeOf({ ...single, allPlansRefuted: true })).toBe('ALL_LEGAL_CAT_PLANS');
  });
});

describe('HV13 §2 the three minimal real-state counterexamples', () => {
  it('H13-B1 Counterexample A: LLRR was already one-turn safe before any cat action', () => {
    const { a, aEnds } = build();
    const x = pick(a, LLRR);
    const end = aEnds.get(x.key)!;
    const ev = causalScan(end, x.catPlanAfterDefence, LIGHT_CAUSAL_CAPS);
    const y = withCausal(x, ev);
    console.log(`H13-B1 A LLRR baselineWin=${x.baselineMouseWinSteps ?? 'none'} chosen=[${x.catPlanAfterDefence}] holds=${ev.chosenPlanHolds} checked=${ev.plansChecked} alt=${ev.alternativeWinPlan ? `${ev.alternativeWinPlan.plan}@${ev.alternativeWinPlan.cell}` : 'none'} complete=${ev.complete} -> class=${defenceClassOf(y)}`);
    expect(x.baselineMouseWinSteps).toBeNull();
    expect(ev.chosenPlanHolds).toBe(true);
    expect(ev.alternativeWinPlan).toBeNull();
    expect(ev.complete).toBe(true);
    expect(defenceClassOf(y)).toBe('NO_MOUSE_WIN_NEXT_TURN');
    expect(isCausalOneTurnBlock(y)).toBe(false);
  });

  it('H13-B2 Counterexample B: the corpus has no mixed one-turn plan set; the quantifier is enforced on the real all-lose state', () => {
    const { a } = build();
    const x = pick(a, LLRR);
    const scan = scanT6();
    // No logged cat-turn start (T1..T6) and none of the 4 HV-2 roots mixes a losing
    // and a holding plan; T5 two plies out splits sharply at distance 4 -> all hold,
    // distance 3 -> all lose. So the mandatory mixed premise is absent from the real
    // corpus and the guard is proven on T6, where every legal plan really loses.
    console.log(`H13-B2 mixed real state found=NO; T6 all-lose ${scan.losses}/${scan.ends} used to test the quantifier`);
    expect(scan.losses).toBe(scan.ends);
    const onePlan = { ...x, result: 'PROVEN_LOCAL_BYPASS' as const, immediateCapture: null, witness: null, terminalMouseWin: false, allPlansRefuted: false, nextMouseWinSteps: scan.firstWin.length };
    expect(refutationScopeOf(onePlan)).toBe('SPECIFIC_CAT_PLAN');
    expect(refutationScopeOf({ ...onePlan, allPlansRefuted: true })).toBe('ALL_LEGAL_CAT_PLANS');
  });

  it('H13-B3 Counterexample C: 1 of 73 cat positions checked — the witness stands, coverage does not', () => {
    const { b, bEnds } = build();
    const x = pick(b, LLRR);
    const ev = causalScan(bEnds.get(x.key)!, x.catPlanAfterDefence, LIGHT_CAUSAL_CAPS);
    console.log(`H13-B3 B LLRR witness=[${x.witness?.catPlan}]@${x.witness?.cell} candidates=${x.candidatesChecked}/${x.candidatesTotal} causalChecked=${ev.plansChecked}/${x.candidatesTotal} alt=${ev.alternativeWinPlan ? 'yes' : 'none'} class=${defenceClassOf(withCausal(x, ev))} scope=${refutationScopeOf(x)}`);
    expect(x.witness).not.toBeNull();
    expect(x.candidatesChecked).toBeGreaterThan(0);
    expect(x.candidatesChecked).toBeLessThan(x.candidatesTotal);
    expect(refutationScopeOf(x)).toBe('NONE');
    expect(ev.complete).toBe(true);
    expect(ev.plansChecked).toBe(x.candidatesTotal);
    expect(ev.alternativeWinPlan).toBeNull();
    // The positive witness stands; no universal coverage is claimed from a 1-of-73 probe.
    expect(defenceClassOf(withCausal(x, ev))).toBe('NO_MOUSE_WIN_NEXT_TURN');
  });
});

describe('HV13 §3 the two representative responses', () => {
  it('H13-C1 LLRR: no legal cat plan allows a one-turn mouse win on either side — NOT_PROVEN, LONGER_HORIZON_REQUIRED', () => {
    const { a, b, aEnds, bEnds } = build();
    const xa = pick(a, LLRR);
    const xb = pick(b, LLRR);
    const evA = causalScan(aEnds.get(xa.key)!, xa.catPlanAfterDefence, LIGHT_CAUSAL_CAPS);
    const evB = causalScan(bEnds.get(xb.key)!, xb.catPlanAfterDefence, LIGHT_CAUSAL_CAPS);
    console.log(`H13-C1 A chosen=[${xa.catPlanAfterDefence}] holds=${evA.chosenPlanHolds} alt=${evA.alternativeWinPlan ? evA.alternativeWinPlan.plan : 'none'} checked=${evA.plansChecked} complete=${evA.complete}`);
    console.log(`H13-C1 B chosen=[${xb.catPlanAfterDefence}] holds=${evB.chosenPlanHolds} alt=${evB.alternativeWinPlan ? evB.alternativeWinPlan.plan : 'none'} checked=${evB.plansChecked} complete=${evB.complete}`);
    console.log('H13-C1 LLRR_CAUSAL_BLOCK = NOT_PROVEN; both sides already deny a one-turn entry, so RRRU is at most longer-horizon positioning -> LONGER_HORIZON_REQUIRED');
    expect(evA.complete).toBe(true);
    expect(evB.complete).toBe(true);
    expect(evA.alternativeWinPlan).toBeNull();
    expect(evB.alternativeWinPlan).toBeNull();
    expect(isCausalOneTurnBlock(withCausal(xa, evA))).toBe(false);
    expect(isCausalOneTurnBlock(withCausal(xb, evB))).toBe(false);
  });

  it('H13-C2 LLLL: the terminal capture outranks RRRR local interception', () => {
    const { a, b, aEnds, bEnds } = build();
    const xa = pick(a, LLLL);
    const xb = pick(b, LLLL);
    const rp = replayCatPlan(aEnds.get(xa.key)!.state, ['R', 'U', 'R']);
    const evB = causalScan(bEnds.get(xb.key)!, xb.catPlanAfterDefence, LIGHT_CAUSAL_CAPS);
    console.log(`H13-C2 A capture=[${xa.immediateCapture?.plan}] replay phase=${rp.end.phase} illegal=${rp.illegalAt ?? '-'} | B capture=${xb.immediateCapture ? 'yes' : 'none'} witness=[${xb.witness?.catPlan}]@${xb.witness?.cell} candidates=${xb.candidatesChecked}/${xb.candidatesTotal} holds=${evB.chosenPlanHolds} alt=${evB.alternativeWinPlan ? 'yes' : 'none'}`);
    console.log(`H13-C2 A class=${defenceClassOf(xa)} B class=${defenceClassOf(withCausal(xb, evB))} -> LLLL_CAPTURE_PRIORITY = PRESERVED`);
    expect(xa.immediateCapture?.plan).toBe('RUR');
    expect(rp.illegalAt).toBeNull();
    expect(rp.end.phase).toBe(GamePhase.CatWins);
    expect(xb.immediateCapture).toBeNull();
    expect(xb.witness).not.toBeNull();
    expect(evB.chosenPlanHolds).toBe(true);
    expect(evB.alternativeWinPlan).toBeNull();
    expect(isTerminalCatWin(xa)).toBe(true);
    expect(isTerminalCatWin(xb)).toBe(false);
    expect(xa.candidatesTotal).toBe(0);
    expect(xb.candidatesTotal).toBeGreaterThan(0);
  });
});

describe('HV13 §4 recomputed table and the T4 research ruling', () => {
  it('H13-D1: semantic table over the reused HV-12 responses', () => {
    const { a, b, aEnds, bEnds } = build();
    const xa = pick(a, LLRR);
    const xb = pick(b, LLRR);
    const xbllll = pick(b, LLLL);
    const evA = causalScan(aEnds.get(xa.key)!, xa.catPlanAfterDefence, LIGHT_CAUSAL_CAPS);
    const evB = causalScan(bEnds.get(xb.key)!, xb.catPlanAfterDefence, LIGHT_CAUSAL_CAPS);
    const evBllll = causalScan(bEnds.get(xbllll.key)!, xbllll.catPlanAfterDefence, LIGHT_CAUSAL_CAPS);
    const aRep = { ...a, responses: a.responses.map((x) => (x.key === xa.key ? withCausal(x, evA) : x)) };
    const bRep = { ...b, responses: b.responses.map((x) => (x.key === xb.key ? withCausal(x, evB) : x.key === xbllll.key ? withCausal(x, evBllll) : x)) };
    const ca = semanticCounts(aRep);
    const cb = semanticCounts(bRep);
    console.log(`H13-D1 UUUR legalEnds=${ca.legalDistinctEnds} analysed=${ca.analysed} captures=${ca.directCaptures} noMouseWinNextTurn=${ca.noMouseWinNextTurn} witnesses=${ca.tacticalWitnesses} (surviving=${ca.survivingWitnesses} chance=${ca.chanceWitnesses} refuted=${ca.refutedWitnesses}) causal=${ca.causalBlocks} allPlanLosses=${ca.allPlansLosses} planRefutations=${ca.specificPlanRefutations} unknown=${ca.unknown} causalUnproven=${ca.causalUnproven}`);
    console.log(`H13-D1 RRRR legalEnds=${cb.legalDistinctEnds} analysed=${cb.analysed} captures=${cb.directCaptures} noMouseWinNextTurn=${cb.noMouseWinNextTurn} witnesses=${cb.tacticalWitnesses} (surviving=${cb.survivingWitnesses} chance=${cb.chanceWitnesses} refuted=${cb.refutedWitnesses}) causal=${cb.causalBlocks} allPlanLosses=${cb.allPlansLosses} planRefutations=${cb.specificPlanRefutations} unknown=${cb.unknown} causalUnproven=${cb.causalUnproven}`);
    const cmp = comparePlans(aRep, bRep, LLRR);
    console.log(`H13-D1 compare verdict=${cmp.verdict} bWorse=${cmp.bWorse.length} captureLoss=${cmp.captureLoss.length} aWorse=${cmp.aWorse.length} heldOnlyA=${cmp.heldOnlyA.length} heldOnlyB=${cmp.heldOnlyB.length} undecided=${cmp.undecided.length}`);
    console.log(`H13-D1 VERDICT ${cmp.verdict} — ${cmp.reason}`);

    expect(ca.legalDistinctEnds).toBe(a.legalComplete);
    expect(cb.legalDistinctEnds).toBe(b.legalComplete);
    expect(ca.legalDistinctEnds).toBe(37);
    expect(cb.legalDistinctEnds).toBe(38);
    expect(ca.directCaptures).toBe(7);
    expect(cb.directCaptures).toBe(2);
    expect(ca.noMouseWinNextTurn).toBe(16);
    expect(cb.noMouseWinNextTurn).toBe(18);
    expect(ca.tacticalWitnesses).toBe(22);
    expect(cb.tacticalWitnesses).toBe(36);
    expect(ca.survivingWitnesses).toBe(9);
    expect(cb.survivingWitnesses).toBe(18);
    expect(ca.chanceWitnesses).toBe(13);
    expect(cb.chanceWitnesses).toBe(18);
    expect(ca.refutedWitnesses).toBe(0);
    expect(cb.refutedWitnesses).toBe(0);
    expect(ca.causalBlocks).toBe(0);
    expect(cb.causalBlocks).toBe(0);
    expect(ca.allPlansLosses).toBe(0);
    expect(cb.allPlansLosses).toBe(0);
    expect(ca.unknown).toBe(14);
    expect(cb.unknown).toBe(18);
    expect(ca.causalUnproven).toBeGreaterThan(0);
    expect(cb.causalUnproven).toBeGreaterThan(0);
    expect(cmp.bWorse).toHaveLength(0);
    expect(cmp.captureLoss.length).toBeGreaterThan(0);
  });

  it('H13-D2: T4 research decision closes as inconclusive, capture priority preserved', () => {
    const { a, b, aEnds } = build();
    const xa = pick(a, LLRR);
    const xb = pick(b, LLRR);
    const evA = causalScan(aEnds.get(xa.key)!, xa.catPlanAfterDefence, LIGHT_CAUSAL_CAPS);
    const cmp = comparePlans(a, b, LLRR);
    const causalDefence = false; // 0 proven causal blocks in both plans
    const captureLost = cmp.captureLoss.length > 0;
    const oneRouteGlobal = refutationScopeOf(xb) === 'ALL_LEGAL_CAT_PLANS';
    console.log(`H13-D2 gate causalDefence=${causalDefence} captureLoss=${cmp.captureLoss.length} oneRouteGlobal=${oneRouteGlobal} RRRR_STRATEGY_SUPERIORITY=NOT_PROVEN capturePriority=PRESERVED timeBudgetPlan=NO reversibleContract=NO LLRR_alt=${evA.alternativeWinPlan ? 'yes' : 'none'}`);
    expect(causalDefence).toBe(false);
    expect(captureLost).toBe(true);
    expect(oneRouteGlobal).toBe(false);
    expect(cmp.verdict).not.toBe('SUPPORTED');
    console.log('H13-D2 T4_RESEARCH_DECISION = CLOSE_T4_AS_INCONCLUSIVE');
  });
});
