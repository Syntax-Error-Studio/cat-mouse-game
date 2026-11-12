import { describe, expect, it } from 'vitest';
import type { GameEngineState } from '../../engine';
import { GamePhase, PieceType } from '../../types';
import { stateKey } from '../transposition';
import { h1Turn, handOffToMouse, replayCatPlan } from './hv5ForcedLineAuditor';
import {
  T4_LOG_SHA256,
  analysePlan,
  catTurnAt,
  comparePlans,
  enumerateMouseTurn,
  ghostBlindKey,
  runCatPlan,
  t4LogSha256,
  t4Root,
  dirByToken,
} from './hv12MouseResponses';
import { mouseStepDeterministic } from '../../engine';

const planA = (): ReturnType<typeof runCatPlan> => runCatPlan(['U', 'U', 'U', 'R']);
const planB = (): ReturnType<typeof runCatPlan> => runCatPlan(['R', 'R', 'R', 'R']);

describe('HV12 §1 provenance — the T4 root is the logged one', () => {
  it('H12-A0: log bytes and the restored root key match the export', () => {
    expect(t4LogSha256(), 'the SHA256 the task book pins').toBe(T4_LOG_SHA256);
    const root = t4Root();
    console.log(`H12-A0 T4 root key matches log=${stateKey(root) === h1Turn(4).loggedStateKey} cat=${root.catPosition.r},${root.catPosition.c} mouse=${root.mousePosition.r},${root.mousePosition.c} catMoves=${root.catMovesLeft} butter=${root.butterPositions.length} trap=${root.trapPosition ? `${root.trapPosition.r},${root.trapPosition.c}` : 'none'} trapsLeft=${root.catTrapsRemaining} carrying=${root.mouseHasButter}`);
    expect(stateKey(root), 'the restored state is the state the H1 search saw').toBe(h1Turn(4).loggedStateKey);
    expect(root.currentPlayer).toBe(PieceType.Cat);
    expect(root.phase).toBe(GamePhase.Playing);
    expect(root.config.catBaseMoves).toBe(4);
    expect(root.config.mouseBaseMoves).toBe(4);
    expect(root.config.mouseCarryingMoves).toBe(3);
    expect(root.config.mouseSkillExtraMoves).toBe(3);
  });

  it('H12-A1: UUUR lands on (2,2) and RRRR on (5,5), each through four real catMove calls', () => {
    const a = planA();
    const b = planB();
    console.log(`H12-A1 A=[${a.applied.join('')}] at ${a.end.catPosition.r},${a.end.catPosition.c} left=${a.end.catMovesLeft} illegalAt=${a.illegalAt} | B=[${b.applied.join('')}] at ${b.end.catPosition.r},${b.end.catPosition.c} left=${b.end.catMovesLeft} illegalAt=${b.illegalAt}`);
    expect(a.illegalAt).toBeNull();
    expect(b.illegalAt).toBeNull();
    expect(a.applied).toEqual(['U', 'U', 'U', 'R']);
    expect(b.applied).toEqual(['R', 'R', 'R', 'R']);
    expect(`${a.end.catPosition.r},${a.end.catPosition.c}`).toBe('2,2');
    expect(`${b.end.catPosition.r},${b.end.catPosition.c}`).toBe('5,5');
    expect(a.end.catMovesLeft).toBe(0);
    expect(b.end.catMovesLeft).toBe(0);
    expect(a.end.phase).toBe(GamePhase.Playing);
  });

  it('H12-A2: both hand-offs are legal mouse-turn starts with the documented budget', () => {
    for (const [label, run] of [['A', planA()], ['B', planB()]] as const) {
      expect(run.mouseStart.currentPlayer).toBe(PieceType.Mouse);
      expect(run.mouseStart.phase).toBe(GamePhase.Playing);
      expect(run.mouseStart.mouseMovesLeft).toBe(4);
      expect(run.mouseStart.catMovesLeft).toBe(0);
      expect(run.mouseStart.pendingButterSpawns.length).toBe(0);
      expect(run.mouseStart.pendingButterPlacementDebt).toBe(0);
      console.log(`H12-A2 ${label} mouse start ${run.mouseStart.mousePosition.r},${run.mouseStart.mousePosition.c} moves=${run.mouseStart.mouseMovesLeft} carrying=${run.mouseStart.mouseHasButter} catMoves=${run.mouseStart.catMovesLeft} key=${stateKey(run.mouseStart).slice(0, 32)}...`);
    }
  });
});

describe('HV12 P1 — the whole legal mouse turn, measured before any cap is chosen', () => {
  it('H12-B1: both starts enumerate completely under the light node cap', () => {
    for (const [label, tokens] of [['A', ['U', 'U', 'U', 'R']], ['B', ['R', 'R', 'R', 'R']]] as const) {
      const run = runCatPlan([...tokens]);
      const t0 = performance.now();
      const en = enumerateMouseTurn(run.mouseStart, { nodeCap: 120_000 });
      const ms = performance.now() - t0;
      const complete = en.ends.filter((e) => !e.stalled);
      const carrying = complete.filter((e) => e.state.mouseHasButter).length;
      const skill = complete.filter((e) => e.usedSkill).length;
      const tunnel = complete.filter((e) => e.tookTunnel).length;
      const trapped = complete.filter((e) => e.trapped).length;
      const chance = complete.filter((e) => e.chanceAmbiguous).length;
      console.log(`H12-B1 ${label}: nodes=${en.nodes} expanded=${en.expanded} ends=${en.ends.length} complete=${complete.length} stalls=${en.stalls} dupEnds=${en.duplicateEnds} trunc=${en.truncated} maxSteps=${en.maxSteps} pickups=${en.pickups} skill=${en.skillUses} tunnelEntries=${en.tunnelEntries} wins=${en.wins} | carryingEnds=${carrying} skillEnds=${skill} tunnelEnds=${tunnel} trappedEnds=${trapped} chanceAmbiguous=${chance} | ${ms.toFixed(1)}ms`);
      expect(en.truncated, `${label}: the enumeration must complete or say so`).toBe(false);
      expect(complete.length, `${label}: at least one complete legal response`).toBeGreaterThan(0);
      // Every end is a real hand-off, a win, or a documented stall.
      for (const e of complete) {
        expect(e.state.currentPlayer === PieceType.Cat || e.state.phase === GamePhase.MouseWins).toBe(true);
      }
    }
  });

  it('H12-B2: the logged human T4 reply is one of the enumerated responses', () => {
    const a = planA();
    // The log records no direction line; the T4→T5 snapshot diff is the fact:
    // the mouse left (1,8), took the butter at (1,6), and was back at (1,8)
    // carrying after four steps. Replaying that loop proves the response legal.
    let s: GameEngineState = a.mouseStart;
    const actions = ['L', 'L', 'R', 'R'];
    const before = a.mouseStart.butterPositions.length;
    for (const t of actions) {
      const d = dirByToken(t)!;
      const next = mouseStepDeterministic(s, d);
      expect(`${next.mousePosition.r},${next.mousePosition.c}`, `step ${t} must move`).not.toBe(`${s.mousePosition.r},${s.mousePosition.c}`);
      s = next;
    }
    const t5 = h1Turn(5).state;
    console.log(`H12-B2 human loop [${actions.join('')}] ends mouse=${s.mousePosition.r},${s.mousePosition.c} carrying=${s.mouseHasButter} butter=${before}->${s.butterPositions.length} player=${s.currentPlayer} moves=${s.mouseMovesLeft}`);
    console.log(`H12-B2 vs logged T5 root: mouse=${t5.mousePosition.r},${t5.mousePosition.c} carrying=${t5.mouseHasButter} butter=${t5.butterPositions.length} pendingGhosts=${t5.pendingButterSpawns.length} ghostBlindKeyMatch=${ghostBlindKey(s) === ghostBlindKey(t5)}`);
    expect(`${s.mousePosition.r},${s.mousePosition.c}`).toBe('1,8');
    expect(s.mouseHasButter).toBe(true);
    expect(s.phase).toBe(GamePhase.Playing);
    expect(s.currentPlayer).toBe(PieceType.Cat);
    expect(ghostBlindKey(s), 'the deferred model matches the logged T5 root once the random ghost is blinded').toBe(ghostBlindKey(t5));
    expect(t5.pendingButterSpawns.length, 'the real game announced exactly the ghost the deferred model omits').toBe(1);
    // The logged reply must be a member of the enumerated set.
    const en = enumerateMouseTurn(a.mouseStart, { nodeCap: 120_000 });
    expect(en.ends.some((e) => e.key === stateKey(s)), 'the human reply is one of the enumerated legal responses').toBe(true);
  });

  it('H12-B3: branch size of the cat turn that follows every response', () => {
    for (const [label, tokens] of [['A', ['U', 'U', 'U', 'R']], ['B', ['R', 'R', 'R', 'R']]] as const) {
      const run = runCatPlan([...tokens]);
      const en = enumerateMouseTurn(run.mouseStart, { nodeCap: 120_000 });
      const complete = en.ends.filter((e) => !e.stalled);
      let minNodes = Infinity, maxNodes = 0, minEnds = Infinity, maxEnds = 0, captures = 0, truncated = 0, catMs = 0;
      for (const e of complete) {
        const t0 = performance.now();
        const c = catTurnAt(e.state, 20_000);
        catMs += performance.now() - t0;
        if (c.truncated) truncated++;
        minNodes = Math.min(minNodes, c.nodes);
        maxNodes = Math.max(maxNodes, c.nodes);
        minEnds = Math.min(minEnds, c.ends.length);
        maxEnds = Math.max(maxEnds, c.ends.length);
        if (c.captures.length > 0) captures++;
      }
      console.log(`H12-B3 ${label}: responses=${complete.length} catTurn nodes ${minNodes}..${maxNodes} ends ${minEnds}..${maxEnds} capturesOn=${captures} truncated=${truncated} totalCatMs=${catMs.toFixed(1)} avg=${(catMs / Math.max(1, complete.length)).toFixed(2)}ms`);
      expect(truncated, `${label}: no cat turn hit the 20k node cap`).toBe(0);
    }
  });

  it('H12-B4: full analysis of both plans stays within the declared light caps', () => {
    for (const [label, tokens] of [['A', ['U', 'U', 'U', 'R']], ['B', ['R', 'R', 'R', 'R']]] as const) {
      const r = analysePlan(label, [...tokens], { maxResponses: 4 });
      console.log(`H12-B4 ${label}: legal=${r.legalComplete} analysed=${r.responses.length} coverage=${r.coverage} | results ${r.responses.map((x) => `${x.actions.join('/')}:${x.result}${x.immediateCapture ? '(cap)' : ''}`).join(' ')} | total ${r.scanMs.toFixed(0)}ms`);
      expect(r.responses.length).toBeGreaterThan(0);
      expect(r.responses.every((x) => x.result.length > 0)).toBe(true);
    }
  });

  it('H12-B5: the honest scan of EVERY legal response, with caps stated', () => {
    const wide = {
      scout: { nodeCap: 20_000, maxEndStates: 96, maxTargetsPerEnd: 6, maxCatMoveCalls: 12_000, maxHoldProofs: 1 },
      catNodeCap: 20_000,
      mouseNodeCap: 20_000,
      maxDefenceCandidates: 4,
      maxResponses: 120,
    };
    for (const [label, tokens] of [['A', ['U', 'U', 'U', 'R']], ['B', ['R', 'R', 'R', 'R']]] as const) {
      const r = analysePlan(label, [...tokens], { caps: wide, maxResponses: 120, mouseNodeCap: 120_000 });
      const tally = r.responses.reduce<Record<string, number>>((m, x) => {
        m[x.result] = (m[x.result] ?? 0) + 1;
        return m;
      }, {});
      const capped = r.responses.filter((x) => x.capped).length;
      const chance = r.responses.filter((x) => x.chanceAmbiguous).length;
      const mean = r.responses.reduce((a, x) => a + x.scanMs, 0) / Math.max(1, r.responses.length);
      const max = Math.max(...r.responses.map((x) => x.scanMs));
      console.log(`H12-B5 ${label}: legal=${r.legalComplete} analysed=${r.responses.length} coverage=${r.coverage} capped=${capped} chanceAmbiguous=${chance} | ${Object.entries(tally).map(([k, v]) => `${k}=${v}`).join(' ')} | ${r.scanMs.toFixed(0)}ms total, mean ${mean.toFixed(1)}ms, max ${max.toFixed(1)}ms`);
      const samples = r.responses.filter((x) => x.result !== 'PROVEN_LOCAL_INTERCEPTION').slice(0, 6);
      for (const x of samples) console.log(`H12-B5 ${label} ${x.actions.join('/')} → ${x.result} | ${x.note.slice(0, 220)}`);
      expect(r.responses.length, `${label}: every complete response is analysed at this cap`).toBe(r.legalComplete);
      expect(r.legalComplete).toBeGreaterThan(30);
    }
  }, 180_000);

  it('H12-C1: A vs B on every shared mouse line, with the witnesses replayed', () => {
    const wide = {
      scout: { nodeCap: 20_000, maxEndStates: 96, maxTargetsPerEnd: 6, maxCatMoveCalls: 12_000, maxHoldProofs: 1 },
      catNodeCap: 20_000,
      mouseNodeCap: 20_000,
      maxDefenceCandidates: 4,
      maxResponses: 120,
    };
    const runs = {
      A: runCatPlan(['U', 'U', 'U', 'R']),
      B: runCatPlan(['R', 'R', 'R', 'R']),
    };
    const a = analysePlan('A', ['U', 'U', 'U', 'R'], { caps: wide, maxResponses: 120, mouseNodeCap: 120_000 });
    const b = analysePlan('B', ['R', 'R', 'R', 'R'], { caps: wide, maxResponses: 120, mouseNodeCap: 120_000 });
    const human = ['L', 'L', 'R', 'R'];
    const cmp = comparePlans(a, b, human);

    console.log(`H12-C1 A coverage=${a.coverage} (${a.coverageNote}) | B coverage=${b.coverage} (${b.coverageNote})`);
    console.log(`H12-C1 shared legal lines=${cmp.common.length} onlyA=${cmp.onlyA.length} onlyB=${cmp.onlyB.length} | B worse=${cmp.bWorse.length} captureLoss=${cmp.captureLoss.length} A worse=${cmp.aWorse.length} undecided=${cmp.undecided.length}`);
    console.log(`H12-C1 human reply [${human.join('')}] legal in A=${cmp.human.a !== null} in B=${cmp.human.b !== null} | A=${cmp.human.a?.result ?? 'not legal'} B=${cmp.human.b?.result ?? 'not legal'}`);
    if (cmp.human.a) console.log(`H12-C1 human line under A: ${cmp.human.a.note.slice(0, 240)}`);
    if (cmp.human.b) console.log(`H12-C1 human line under B: witness [${cmp.human.b.witness?.catPlan ?? '-'}] at ${cmp.human.b.catPositionAfterDefence} — ${cmp.human.b.note.slice(0, 200)}`);
    console.log(`H12-C1 VERDICT ${cmp.verdict} — ${cmp.reason}`);

    for (const label of ['A', 'B'] as const) {
      const rep = label === 'A' ? a : b;
      const tally: Record<string, number> = {};
      for (const x of rep.responses) tally[x.result] = (tally[x.result] ?? 0) + 1;
      const captures = rep.responses.filter((x) => x.immediateCapture !== null);
      const timely = rep.responses.filter((x) => x.result === 'PROVEN_LOCAL_INTERCEPTION' && x.immediateCapture === null);
      console.log(`H12-C1 ${label} table: legal=${rep.legalComplete} analysed=${rep.responses.length} captureResponses=${captures.length} timelyInterceptions=${timely.length} interceptionTotal=${tally.PROVEN_LOCAL_INTERCEPTION ?? 0} noDefence=${tally.NO_IMMEDIATE_DEFENCE_FOUND ?? 0} bypass=${tally.PROVEN_LOCAL_BYPASS ?? 0} unknown=${tally.UNKNOWN ?? 0} chanceAmbiguous=${rep.responses.filter((x) => x.chanceAmbiguous).length}`);
    }
    const xtab = new Map<string, number>();
    for (const r of cmp.common) {
      const k = `A=${r.a.result}/B=${r.b.result}`;
      xtab.set(k, (xtab.get(k) ?? 0) + 1);
    }
    console.log(`H12-C1 cross-tab of shared lines: ${[...xtab].map(([k, v]) => `${k}:${v}`).join(' | ')}`);
    const chanceOnlyA = cmp.common.filter((r) => r.a.chanceAmbiguous && !r.b.chanceAmbiguous).length;
    const chanceOnlyB = cmp.common.filter((r) => r.b.chanceAmbiguous && !r.a.chanceAmbiguous).length;
    const chanceBoth = cmp.common.filter((r) => r.a.chanceAmbiguous && r.b.chanceAmbiguous).length;
    console.log(`H12-C1 chance ambiguity on shared lines: onlyA=${chanceOnlyA} onlyB=${chanceOnlyB} both=${chanceBoth} neither=${cmp.common.length - chanceOnlyA - chanceOnlyB - chanceBoth}`);

    // §4: the required per-response fields, one line each. The state key is
    // truncated so the log stays readable; the full key is in the harness.
    for (const label of ['A', 'B'] as const) {
      const rep = label === 'A' ? a : b;
      for (const x of rep.responses) {
        console.log(`H12-C1 ${label} RESPONSE [${x.actions.join('/')}] key=${x.key.slice(0, 16)}… carrying=${x.mouseHasButter ? 1 : 0} dist=${x.mouseDistanceToHole} capture=${x.immediateCapture ? x.immediateCapture.plan : '-'} witness=${x.witness ? `${x.witness.catPlan}@${x.witness.cell}` : '-'} catPos=${x.catPositionAfterDefence ?? '-'} alt=${x.mouseAlternativeRoute ? x.mouseAlternativeRoute.actions.join('') : '-'} delay=${x.routeDelaySteps ?? '-'} chance=${x.chanceAmbiguous ? 1 : 0} scan=${x.scanStatus} → ${x.result}`);
      }
    }

    const byKey = new Map<string, GameEngineState>();
    for (const label of ['A', 'B'] as const) {
      const en = enumerateMouseTurn(runs[label].mouseStart, { nodeCap: 120_000 });
      for (const e of en.ends) byKey.set(`${label}:${e.key}`, e.state);
    }
    const verify = (label: 'A' | 'B', x: ReturnType<typeof analysePlan>['responses'][number]): void => {
      const start = byKey.get(`${label}:${x.key}`);
      expect(start, `${label} ${x.actions.join('/')}: the response key maps back to a real mouse end`).toBeDefined();
      if (x.immediateCapture) {
        const rp = replayCatPlan(start!, x.immediateCapture.plan.split(''));
        expect(rp.illegalAt, `${label} ${x.actions.join('/')}: capture plan [${x.immediateCapture.plan}] is legal`).toBeNull();
        expect(rp.end.phase, `${label} ${x.actions.join('/')}: capture plan ends the game`).toBe(GamePhase.CatWins);
      }
      if (x.witness) {
        const rp = replayCatPlan(start!, x.witness.catPlan.split(''));
        expect(rp.illegalAt, `${label} ${x.actions.join('/')}: witness plan [${x.witness.catPlan}] is legal`).toBeNull();
        expect(rp.applied.length, `${label} ${x.actions.join('/')}: the witness plan is the complete plan`).toBe(x.witness.catPlan.length);
        expect(`${rp.end.catPosition.r},${rp.end.catPosition.c}`, `${label} ${x.actions.join('/')}: the witness plan reaches the claimed cell`).toBe(x.catPositionAfterDefence);
        const mt = enumerateMouseTurn(handOffToMouse(rp.end, true), { nodeCap: 120_000 });
        expect(mt.ends.some((e) => e.terminal === 'MOUSE_WINS'), `${label} ${x.actions.join('/')}: no hole entry inside the next mouse turn after the witness plan`).toBe(false);
      }
      if (x.result === 'PROVEN_LOCAL_BYPASS' && x.mouseAlternativeRoute) {
        const catEnd = replayCatPlan(start!, (x.catPlanAfterDefence ?? '').split('')).end;
        const mt = enumerateMouseTurn(handOffToMouse(catEnd, true), { nodeCap: 120_000 });
        const hit = mt.ends.find((e) => e.terminal === 'MOUSE_WINS' && e.actions.join('/') === x.mouseAlternativeRoute!.actions.join('/'));
        expect(hit, `${label} ${x.actions.join('/')}: the bypass line [${x.mouseAlternativeRoute.actions.join('')}] is a real mouse win`).toBeDefined();
      }
    };

    for (const x of a.responses) verify('A', x);
    for (const x of b.responses) verify('B', x);

    for (const r of cmp.bWorse) {
      console.log(`H12-C1 B-WORSE [${r.actions}] A=${r.a.result}${r.a.immediateCapture ? `(capture ${r.a.immediateCapture.plan})` : ''} B=${r.b.result} | B note: ${r.b.note.slice(0, 200)}`);
    }
    for (const r of cmp.captureLoss.slice(0, 10)) {
      console.log(`H12-C1 CAPTURE-LOSS [${r.actions}] A captures with [${r.a.immediateCapture!.plan}] but B=${r.b.result}${r.b.immediateCapture ? `(capture ${r.b.immediateCapture.plan})` : ''} chanceA=${r.a.chanceAmbiguous} chanceB=${r.b.chanceAmbiguous}${r.b.witness ? ` B witness [${r.b.witness.catPlan}]@${r.b.witness.cell}` : ''}`);
    }
    for (const r of cmp.aWorse.slice(0, 10)) {
      console.log(`H12-C1 A-WORSE [${r.actions}] A=${r.a.result} B=${r.b.result}`);
    }
    for (const x of cmp.onlyA.slice(0, 6)) console.log(`H12-C1 ONLY-A ${x.actions.join('/')} → ${x.result} (not a shared line, so not compared)`);
    for (const x of cmp.onlyB.slice(0, 6)) console.log(`H12-C1 ONLY-B ${x.actions.join('/')} → ${x.result} (not a shared line, so not compared)`);
    const chanceUndecided = cmp.undecided.filter((r) => r.a.chanceAmbiguous || r.b.chanceAmbiguous).length;
    console.log(`H12-C1 undecided breakdown: chanceAmbiguous=${chanceUndecided} of ${cmp.undecided.length}`);
    const reasons = [...new Set([...a.responses, ...b.responses].flatMap((x) => x.capReasons))];
    console.log(`H12-C1 binding cap reasons seen: ${reasons.length === 0 ? 'none' : reasons.join(' | ')}`);

    expect(cmp.human.a, 'the logged human reply is a legal response to UUUR').not.toBeNull();
    expect(cmp.human.b, 'the logged human reply is a legal response to RRRR').not.toBeNull();
    expect(['SUPPORTED', 'COUNTEREXAMPLE_FOUND', 'INCONCLUSIVE']).toContain(cmp.verdict);
    for (const r of cmp.bWorse) {
      expect(r.a.result).toBe('PROVEN_LOCAL_INTERCEPTION');
      expect(['PROVEN_LOCAL_BYPASS', 'NO_IMMEDIATE_DEFENCE_FOUND']).toContain(r.b.result);
    }
    for (const r of cmp.captureLoss) expect(r.a.immediateCapture).not.toBeNull();
  }, 300_000);
});
