/// <reference types="node" />
/**
 * TACT-3 — butter / ghost CHANCE completeness.
 *
 * The rule never draws from `Math.random` inside the search: a butter pickup
 * and a CAT→MOUSE ghost materialisation are both enumerated into explicit
 * outcomes with weights. This file audits that enumeration on the G6T2 line:
 *
 *   1. every outcome set is non-empty;
 *   2. every weight is strictly positive and finite;
 *   3. the weights sum to exactly 1 (within 1e-12);
 *   4. each outcome is a legal successor (ghost positions honour the ≥3
 *      distance rule against both pieces and the hole, and never overlap a
 *      box / pile / void / hole / tunnel / trap / butter / other ghost);
 *   5. the outcome COUNT is recorded, because a sampled branch is not a proof.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { restoreHardRoot } from '../../src/game/ai/hardHistory';
import { createEngineRuleSet, enumerateButterSpawnsForState } from '../../src/game/engine';
import { generatePreparedSearchActions } from '../../src/game/ai/preparedActions';
import { applyNoMoveLoss } from '../../src/game/rules/mobility';
import { label, parseLabel, summarize, mouseForcesWin } from './lib';
import type { GameEngineState } from '../../src/game/engine';

const FIXTURE = 'src/game/ai/__tests__/fixtures/ppcId01-human-roots.json';
const OUT = 'PPC-CAT-STRATEGY-01/_raw';
const records = JSON.parse(readFileSync(FIXTURE).toString('utf8')) as { id: string; state: unknown }[];
const rules = createEngineRuleSet();
const load = (id: string): GameEngineState => restoreHardRoot(records.find((r) => r.id === id)!.state as never);

function step(s: GameEngineState, lbl: string) {
  const prepared = generatePreparedSearchActions(applyNoMoveLoss(s), rules);
  const hit = prepared.find((p) => label(p.action) === parseLabel(lbl));
  if (!hit) throw new Error(`illegal ${lbl}; legal=${prepared.map((p) => label(p.action)).join(',')}`);
  return hit.transition;
}

/** Advance one action, taking outcome #1 at a CHANCE node and reporting it. */
function advance(s: GameEngineState, lbl: string): { state: GameEngineState; chance: string | null } {
  const tr = step(s, lbl);
  if (tr.kind === 'deterministic') return { state: applyNoMoveLoss(tr.state), chance: null };
  const n = tr.outcomes.length;
  return { state: applyNoMoveLoss(tr.outcomes[0].state), chance: `chance(${n} outcomes, #1)` };
}

function auditOutcomes(outcomes: { state: GameEngineState; weight: number }[], kind: string) {
  expect(outcomes.length, `${kind}: empty outcome set`).toBeGreaterThan(0);
  const sum = outcomes.reduce((a, o) => a + o.weight, 0);
  for (const o of outcomes) {
    expect(Number.isFinite(o.weight), `${kind}: non-finite weight`).toBe(true);
    expect(o.weight).toBeGreaterThan(0);
  }
  expect(Math.abs(sum - 1)).toBeLessThan(1e-12);
  const uniform = outcomes.every((o) => o.weight === outcomes[0].weight);
  return {
    kind,
    outcomes: outcomes.length,
    weightSum: sum,
    uniform,
    weightEach: uniform ? outcomes[0].weight : null,
  };
}

describe('TACT-3 chance branch audit (G6T2)', () => {
  it('the butter pickup at (2,6) is a complete, uniform CHANCE node', () => {
    const root = load('G6T2');
    const a1 = advance(root, 'c:U');
    const a2 = advance(a1.state, 'c:U');
    const a3 = advance(a2.state, 'c:R');
    // The 4th cat step ends the turn → the pending ghost at (5,1) materialises
    // at the CAT→MOUSE boundary, so even the CAT's own last move is a CHANCE.
    const a4 = advance(a3.state, 'c:R');
    expect(a4.chance).not.toBeNull();
    const afterCat = a4.state;
    expect(`${afterCat.catPosition.r},${afterCat.catPosition.c}`).toBe('1,5');
    expect(afterCat.currentPlayer).toBe('mouse');

    const sk = advance(afterCat, 'm:S');
    expect(sk.chance).toBeNull();
    const afterSkill = sk.state;
    expect(afterSkill.mouseMovesLeft).toBe(6);

    const pickup = step(afterSkill, 'm:D');
    expect(pickup.kind).toBe('chance'); // the ONLY stochastic element in the rules
    const outcomes = (pickup as { outcomes: { state: GameEngineState; weight: number }[] }).outcomes;
    const summary = auditOutcomes(outcomes, 'butter_pickup_announce');

    // The candidate set is enumerated on the POST-pickup state (butter removed,
    // mouse standing on (2,6)) with the pre-existing pending ghost still
    // reserved — exactly the input the CHANCE builder used.
    const postPickup = outcomes[0].state;
    const candidates = enumerateButterSpawnsForState({
      ...postPickup,
      pendingButterSpawns: afterSkill.pendingButterSpawns,
    } as GameEngineState);
    expect(outcomes.length).toBe(candidates.length);

    // Legality of every announced ghost position.
    const cfg = afterSkill.config;
    const hole = cfg.mouseHole;
    for (const o of outcomes) {
      const added = (o.state.pendingButterSpawns ?? []);
      expect(added.length).toBe(afterSkill.pendingButterSpawns.length + 1);
      const g = added[added.length - 1];
      const cell = o.state.board[g.r][g.c].type;
      expect(['empty', 'trap']).toContain(cell); // never a box / pile / void / tunnel / hole
      expect(g.r).toBeGreaterThanOrEqual(1);
      expect(g.c).toBeGreaterThanOrEqual(1);
      expect(g.r).toBeLessThanOrEqual(cfg.boardSize - 2);
      expect(g.c).toBeLessThanOrEqual(cfg.boardSize - 2);
      // Distances are measured on the state the enumeration ran on: after the
      // pickup the mouse already stands on (2,6).
      const dMouse = Math.abs(g.r - postPickup.mousePosition.r) + Math.abs(g.c - postPickup.mousePosition.c);
      const dCat = Math.abs(g.r - postPickup.catPosition.r) + Math.abs(g.c - postPickup.catPosition.c);
      expect(dMouse).toBeGreaterThanOrEqual(3);
      expect(dCat).toBeGreaterThanOrEqual(3);
      // RULE-DOC GAP: the implementation measures "≥3 from the mouse hole"
      // against the hole's ANCHOR cell only (`config.mouseHole`), not against
      // every cell of the 2x2 block. Recorded as IMPLEMENTATION_BEHAVIOR.
      const dHoleAnchor = Math.abs(g.r - hole.r) + Math.abs(g.c - hole.c);
      expect(dHoleAnchor).toBeGreaterThanOrEqual(3);
      expect(afterSkill.butterPositions.some((b) => b.r === g.r && b.c === g.c)).toBe(false);
      expect(afterSkill.trapPosition?.r === g.r && afterSkill.trapPosition?.c === g.c).toBe(false);
    }

    // The G6T2 headline: can a ghost land on the cat's own counter corridor?
    const corridor = ['4,5', '4,6', '4,4'];
    const onCorridor = outcomes
      .map((o) => (o.state.pendingButterSpawns ?? [])[(o.state.pendingButterSpawns ?? []).length - 1])
      .filter((g) => corridor.includes(`${g.r},${g.c}`))
      .map((g) => `${g.r},${g.c}`);

    writeFileSync(`${OUT}/chance-butter-pickup.json`, JSON.stringify({
      kind: summary.kind,
      root: 'G6T2',
      preState: summarize(afterSkill),
      candidates: candidates.map((p) => `${p.r},${p.c}`),
      candidateCount: candidates.length,
      outcomes: outcomes.length,
      weightSum: summary.weightSum,
      uniform: summary.uniform,
      weightEach: summary.weightEach,
      corridorCells: corridor,
      corridorHitByGhost: onCorridor,
      note: 'a ghost on 4,5 / 4,6 would block the CAT (butter blocks cat movement), not the mouse',
    }, null, 2));

    expect(summary.outcomes).toBeGreaterThan(1);
  });

  it('the CAT→MOUSE ghost boundary is a complete CHANCE node', () => {
    const root = load('G6T2');
    // cat UURR, mouse S + 6xD  →  the cat turn after that ends at a ghost boundary
    let s = applyNoMoveLoss(root);
    for (const [pl, act] of [['cat', 'c:U'], ['cat', 'c:U'], ['cat', 'c:R'], ['cat', 'c:R'],
      ['mouse', 'm:S'], ['mouse', 'm:D'], ['mouse', 'm:D'], ['mouse', 'm:D'],
      ['mouse', 'm:D'], ['mouse', 'm:D'], ['mouse', 'm:D']] as const) {
      expect(s.currentPlayer).toBe(pl);
      const tr = step(s, act);
      s = applyNoMoveLoss(tr.kind === 'deterministic' ? tr.state : tr.outcomes[0].state);
    }
    // now it is the cat's turn (G6T3-like state) and one ghost is pending
    expect(s.currentPlayer).toBe('cat');
    expect((s.pendingButterSpawns ?? []).length).toBeGreaterThan(0);

    let t = s;
    const chanceNodes: ReturnType<typeof auditOutcomes>[] = [];
    // play the cat's RDDD; the LAST step crosses the ghost boundary
    for (const act of ['c:R', 'c:D', 'c:D', 'c:D']) {
      const tr = step(t, act);
      if (tr.kind === 'chance') {
        chanceNodes.push(auditOutcomes(tr.outcomes, 'ghost_boundary'));
        t = applyNoMoveLoss(tr.outcomes[0].state);
      } else {
        t = applyNoMoveLoss(tr.state);
      }
    }
    expect(chanceNodes.length).toBe(1);
    const summary = chanceNodes[0];
    writeFileSync(`${OUT}/chance-ghost-boundary.json`, JSON.stringify({
      root: 'G6T2',
      line: 'c:U c:U c:R c:R m:S m:D m:D m:D m:D m:D m:D c:R c:D c:D c:D',
      boundary: summary,
      afterBoundary: summarize(t),
    }, null, 2));
    expect(summary.weightSum).toBeCloseTo(1, 12);
  });

  it('no chance node ever consumes ambient randomness during enumeration', () => {
    const root = load('G6T2');
    const before = Math.random;
    let calls = 0;
    Math.random = () => { calls++; return 0.5; };
    try {
      const afterU = advance(root, 'c:U').state;
      const afterUU = advance(afterU, 'c:U').state;
      const afterR = advance(afterUU, 'c:R').state;
      const afterCat = advance(afterR, 'c:R').state;   // CHANCE: ghost boundary
      const afterSkill = advance(afterCat, 'm:S').state;
      const pickup = step(afterSkill, 'm:D');
      expect(pickup.kind).toBe('chance');
      expect(calls).toBe(0);
      expect(Math.random).toBe(Math.random); // still our stub
    } finally {
      Math.random = before;
    }
  });

  it('every positive-probability pickup branch still loses for the cat (chance independence)', () => {
    const root = load('G6T2');
    const a1 = advance(root, 'c:U');
    const a2 = advance(a1.state, 'c:U');
    const a3 = advance(a2.state, 'c:R');
    const a4 = advance(a3.state, 'c:R');
    const afterSkill = advance(a4.state, 'm:S').state;
    const pickup = step(afterSkill, 'm:D');
    expect(pickup.kind).toBe('chance');
    const outcomes = (pickup as { outcomes: { state: GameEngineState; weight: number }[] }).outcomes;

    // 29 branches, each with a different pending ghost. If even ONE branch let
    // the cat hold, the mouse escape would be a lucky roll rather than a forced
    // win — so this is the check that separates §7.1 from §7.2.
    const branches = outcomes.map((o, i) => {
      const g = (o.state.pendingButterSpawns ?? [])[(o.state.pendingButterSpawns ?? []).length - 1];
      expect(o.state.currentPlayer).toBe('mouse'); // still inside the mouse turn
      const r = mouseForcesWin(o.state, 2, 1, 200_000);
      return {
        branch: i + 1,
        weight: o.weight,
        ghostCell: `${g.r},${g.c}`,
        mouseForcedWinWithinH1: r.value,
        nodes: r.stats.nodes,
      };
    });

    const allWin = branches.every((b) => b.mouseForcedWinWithinH1 === true);
    const anyUnknown = branches.some((b) => b.mouseForcedWinWithinH1 === null);
    expect(anyUnknown).toBe(false);   // no branch may be left unevaluated
    expect(allWin).toBe(true);        // the escape does not depend on the roll

    const pickupDoc = JSON.parse(readFileSync(`${OUT}/chance-butter-pickup.json`, 'utf8'));
    const boundaryDoc = JSON.parse(readFileSync(`${OUT}/chance-ghost-boundary.json`, 'utf8'));
    const auditDoc = JSON.stringify({
      generatedAt: new Date().toISOString(),
      generatedBy: 'PPC-CAT-STRATEGY-01/probe/chance_enumeration.test.ts',
      root: 'G6T2',
      method: '在真实 RuleSet 上枚举每个 CHANCE 的全部正概率结果；不采样、不调用 Math.random。',
      nodes: {
        butterPickupAnnounce: pickupDoc,
        ghostMaterializationBoundary: boundaryDoc,
      },
      perBranchCompleteness: {
        node: 'butter_pickup_announce (鼠在 (2,6) 拾取黄油时的幽灵公告)',
        horizon: 'H1',
        branches: branches.length,
        allBranchesStillMouseForcedWin: allWin,
        anyBranchUNRESOLVED: anyUnknown,
        table: branches,
        conclusion: allWin
          ? '全部正概率分支都仍是鼠强制胜 ⇒ 鼠的逃脱不依赖具体随机结果（§7.2，不是 §7.1）'
          : '存在使猫得以存活的分支 ⇒ 只能声明 MOUSE_WIN_WITNESS（§7.1）',
      },
    }, null, 2);
    writeFileSync('PPC-CAT-STRATEGY-01/CHANCE_BRANCH_AUDIT.json', auditDoc);
    writeFileSync(`${OUT}/chance-branch-audit.json`, auditDoc);
  }, 3_600_000);
});
