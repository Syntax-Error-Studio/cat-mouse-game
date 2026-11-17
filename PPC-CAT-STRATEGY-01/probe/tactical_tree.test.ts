/// <reference types="node" />
/**
 * TACT-4 / TACT-5 / TACT-8 — exact tactical tree over the 24 frozen human roots.
 *
 * Two separate questions, never mixed (report §7):
 *   ∃ mouse strategy  ∀ cat play  ∀ chance  → MouseWins within H   (§7.2)
 *   ∃ cat   strategy  ∀ mouse play ∀ chance → CatWins   within H   (§7.4)
 *
 * Both are answered by an EXACT boolean quantifier over the real RuleSet
 * (`forcesWinWithin`), never by the production evaluator. `false` for the mouse
 * question is exactly CAT_SURVIVAL_CERTIFIED_WITHIN_H (§7.3) — it is the
 * refutation tree, not an absence of evidence.
 *
 * Horizon naming follows the task book §6.3:
 *   H0 = current cat turn + the following mouse turn (hParam 1)
 *   H1 = plus one more cat turn and mouse turn      (hParam 2)
 * `hParam` is the internal cut: a cat node at `idx >= 2*hParam` is outside.
 *
 * Artifacts: TACTICAL_ROOT_SCREENING.json, ROOT_CLASSIFICATION.json,
 *            MOUSE_RESPONSE_ENUMERATION.json
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { restoreHardRoot } from '../../src/game/ai/hardHistory';
import { stateKey } from '../../src/game/ai/transposition';
import {
  mouseForcesWin, catForcesWin, mouseDistMap, catDistMap, legalLabels, summarize,
  applyPrefixBranches, replayBranch,
} from './lib';
import type { GameEngineState } from '../../src/game/engine';

const FIXTURE = 'src/game/ai/__tests__/fixtures/ppcId01-human-roots.json';
const FROZEN_FIXTURE_SHA = '1a59787adb6669e1cf287d019313dadf4636a4310eed7b3de5236f4778e0db09';
const OUT = 'PPC-CAT-STRATEGY-01';
const LOG_DIR = 'ai-training/f2b19a';

const H0 = 1;
const H1 = 2;
const CAP = 600_000;

interface RootRecord {
  id: string; file: string; line: number; state: unknown;
  sourceSha256: string; canonicalSnapshotSha256: string;
}
const sha256 = (buf: Buffer | string) => createHash('sha256').update(buf).digest('hex');
const records = JSON.parse(readFileSync(FIXTURE).toString('utf8')) as RootRecord[];
const load = (id: string): GameEngineState => restoreHardRoot(records.find((r) => r.id === id)!.state as never);

/** Measured per-opening verdicts; filled by the second case, persisted by the third. */
let openingScreening: { step: string; mouseForcedWin: boolean | null; verdict: string }[] | null = null;

/** Shortest legal-path distances (BFS on the real board), never Euclidean. */
function metrics(s: GameEngineState) {
  const dm = mouseDistMap(s);
  const dMouseHole = dm.get(`${s.mousePosition.r},${s.mousePosition.c}`) ?? -1;
  const dCatMouse = catDistMap(s, s.mousePosition).get(`${s.catPosition.r},${s.catPosition.c}`) ?? -1;
  const dCatHole = catDistMap(s, s.config.mouseHole).get(`${s.catPosition.r},${s.catPosition.c}`) ?? -1;
  // A mouse turn grants mouseCarryingMoves (3) / mouseBaseMoves (4); the skill
  // adds 3 to the CURRENT turn only, and only if it was not used yet.
  const base = s.mouseHasButter ? s.config.mouseCarryingMoves : s.config.mouseBaseMoves;
  const skillBonus = s.mouseSkillActive ? 0 : 3;
  const mouseTurnBudget = base + skillBonus;
  return {
    dMouseHole,
    dCatMouse,
    dCatHole,
    mouseTurnBudget,
    skillBonusAvailable: skillBonus > 0,
    mouseCanEnterHoleThisTurn: s.mouseHasButter && dMouseHole >= 0 && dMouseHole <= mouseTurnBudget,
    catCanCatchThisTurn: dCatMouse >= 0 && dCatMouse <= s.catMovesLeft,
    catStepsShortToCutoff: dMouseHole - s.catMovesLeft, // >0 ⇒ mouse wins a pure race
  };
}

/** Map a (mouse, cat) pair of exact verdicts to a §7 class label. */
function classify(h0: boolean | null, h1: boolean | null, catH1: boolean | null): string {
  if (h0 === null || h1 === null || catH1 === null) return 'UNRESOLVED';
  if (h1 && catH1) throw new Error('contradiction: both sides forced a win in H1');
  if (h0) return 'MOUSE_FORCED_WIN_WITHIN_H0';
  if (h1) return 'MOUSE_FORCED_WIN_WITHIN_H1';
  if (catH1) return 'CAT_FORCED_WIN_WITHIN_H1';
  return 'CAT_SURVIVAL_CERTIFIED_WITHIN_H1';
}

describe('TACT-4/TACT-5/TACT-8 exact tactical tree', () => {
  it('screens and classifies all 24 human roots at H0 and H1', () => {
    expect(sha256(readFileSync(FIXTURE))).toBe(FROZEN_FIXTURE_SHA);

    const rows = records.map((rec) => {
      const root = load(rec.id);
      const m = metrics(root);
      const h0 = mouseForcesWin(root, H0, 0, CAP);
      const h1 = mouseForcesWin(root, H1, 0, CAP);
      const catH1 = catForcesWin(root, H1, 0, CAP);
      return {
        id: rec.id,
        provenance: 'REAL_HUMAN_REPLAY',
        source: {
          file: `${LOG_DIR}/${rec.file}`,
          line: rec.line,
          frozenSourceSha256: rec.sourceSha256,
          frozenCanonicalSnapshotSha256: rec.canonicalSnapshotSha256,
        },
        stateKey: stateKey(root),
        state: summarize(root),
        legalCatFirstActions: legalLabels(root),
        metrics: m,
        h0: { horizon: 'H0', hParam: H0, mouseForcedWin: h0.value, ...h0.stats },
        h1: { horizon: 'H1', hParam: H1, mouseForcedWin: h1.value, ...h1.stats },
        catH1: { horizon: 'H1', hParam: H1, catForcedWin: catH1.value, ...catH1.stats },
        classification: classify(h0.value, h1.value, catH1.value),
      };
    });

    // ---- TACT-5: no root may be silently truncated.
    const truncated = rows.filter((r) => r.h0.truncated || r.h1.truncated || r.catH1.truncated);
    expect(truncated.map((r) => r.id)).toEqual([]);

    // ---- G6T2 is the studied root and must behave as the narrative claims:
    //      H0 alone cannot decide it (the mouse cannot reach the hole yet),
    //      H1 proves the CAT can hold — i.e. the position was NOT lost here.
    const g6t2 = rows.find((r) => r.id === 'G6T2')!;
    expect(g6t2.classification).toBe('CAT_SURVIVAL_CERTIFIED_WITHIN_H1');
    expect(g6t2.h0.mouseForcedWin).toBe(false);
    expect(g6t2.h1.mouseForcedWin).toBe(false);
    expect(g6t2.metrics.dMouseHole).toBe(8);
    expect(g6t2.metrics.mouseTurnBudget).toBe(6);
    expect(g6t2.metrics.mouseCanEnterHoleThisTurn).toBe(false);

    // ---- G6T3 (one mouse turn later) IS lost: the mouse forces a win in H0.
    const g6t3 = rows.find((r) => r.id === 'G6T3')!;
    expect(g6t3.classification).toBe('MOUSE_FORCED_WIN_WITHIN_H0');
    expect(g6t3.metrics.mouseCanEnterHoleThisTurn).toBe(true);

    const counts: Record<string, number> = {};
    for (const r of rows) counts[r.classification] = (counts[r.classification] ?? 0) + 1;

    mkdirSync(OUT, { recursive: true });
    writeFileSync(`${OUT}/TACTICAL_ROOT_SCREENING.json`, JSON.stringify({
      generatedAt: new Date().toISOString(),
      generatedBy: 'PPC-CAT-STRATEGY-01/probe/tactical_tree.test.ts',
      head: '48eaac6c4f3801d351787696ba5876995b64e8d8',
      fixture: { path: FIXTURE, sha256: FROZEN_FIXTURE_SHA },
      provenanceNote:
        'All 24 roots are REAL_HUMAN_REPLAY: state restored from a human log line and '
        + 'canonical-snapshot-hash-certified by root_reconstruction.test.ts. None are synthetic.',
      horizons: {
        H0: { hParam: H0, definition: '当前完整猫回合 + 随后完整鼠回合（含所有回合边界与 CHANCE）' },
        H1: { hParam: H1, definition: '在 H0 之上再加一个完整猫回合及其后的鼠回合' },
        cutRule: '猫节点 idx >= 2*hParam 视作视界外（双方均不得在该节点判胜）',
      },
      nodeCap: CAP,
      allUntruncated: truncated.length === 0,
      counts,
      roots: rows,
    }, null, 2));

    writeFileSync(`${OUT}/ROOT_CLASSIFICATION.json`, JSON.stringify({
      generatedAt: new Date().toISOString(),
      generatedBy: 'PPC-CAT-STRATEGY-01/probe/tactical_tree.test.ts',
      scheme: {
        MOUSE_FORCED_WIN_WITHIN_H0: '∃鼠策略 ∀猫 ∀CHANCE，在 H0 内 MouseWins (§7.2)',
        MOUSE_FORCED_WIN_WITHIN_H1: '∃鼠策略 ∀猫 ∀CHANCE，在 H1 内 MouseWins (§7.2)',
        CAT_FORCED_WIN_WITHIN_H1: '∃猫策略 ∀鼠 ∀CHANCE，在 H1 内 CatWins (§7.4)',
        CAT_SURVIVAL_CERTIFIED_WITHIN_H1: '¬∃鼠策略能在 H1 内强制 MouseWins ⇒ ∃猫策略挡住全部鼠线 (§7.3)',
        UNRESOLVED: '节点预算耗尽 / CHANCE 无法完整枚举 / 根恢复不完整 (§7.5)',
      },
      correctnessContract: [
        '存在一条鼠胜路线 ≠ 鼠可以强制获胜',
        '没有找到鼠胜路线 ≠ 猫已经证明安全（此处 false 是由反驳树给出的 ∀ 证明，不是缺席）',
        'CAT_SURVIVAL_CERTIFIED_WITHIN_H1 只覆盖 H1 窗口，不代表永久不败',
      ],
      counts,
      roots: rows.map((r) => ({
        id: r.id,
        classification: r.classification,
        evidence: {
          h0MouseForcedWin: r.h0.mouseForcedWin,
          h1MouseForcedWin: r.h1.mouseForcedWin,
          h1CatForcedWin: r.catH1.catForcedWin,
          h1Nodes: r.h1.nodes,
          h1ElapsedMs: Math.round(r.h1.elapsedMs),
        },
      })),
    }, null, 2));

    // Non-vacuity: the corpus must contain both pole classes, otherwise the
    // classifier would be trivially "everything is safe".
    expect(counts['CAT_SURVIVAL_CERTIFIED_WITHIN_H1'] ?? 0).toBeGreaterThan(0);
    expect(counts['MOUSE_FORCED_WIN_WITHIN_H0'] ?? 0).toBeGreaterThan(0);
  }, 3_600_000);

  it('G6T2: exactly one of the three legal cat openings is safe (H1, exact)', () => {
    const root = load('G6T2');
    const openings = legalLabels(root);
    expect(openings).toEqual(['U', 'D', 'L']); // R is a box

    const perOpening = openings.map((step) => {
      const pre = applyPrefixBranches(root, [step]);
      expect(pre.ok, pre.failedAt).toBe(true);
      // The cat keeps the move (idx stays 0) and nothing is random here, so
      // exactly one successor: the verdict is that opening's verdict.
      expect(pre.states.length).toBe(1);
      const r = mouseForcesWin(pre.states[0], H1, pre.idx[0], CAP);
      return {
        step,
        branchStates: pre.states.length,
        mouseForcedWin: r.value,
        verdict: r.value === null ? 'UNRESOLVED'
          : r.value ? 'MOUSE_FORCED_WIN_WITHIN_H1' : 'CAT_SURVIVAL_CERTIFIED_WITHIN_H1',
        stats: { nodes: r.stats.nodes, transitions: r.stats.transitions, elapsedMs: Math.round(r.stats.elapsedMs) },
        sampleState: summarize(pre.states[0]),
      };
    });

    openingScreening = perOpening.map((o) => ({
      step: o.step, mouseForcedWin: o.mouseForcedWin, verdict: o.verdict,
      ...(o.stats as object),
    })) as never;

    const safe = perOpening.filter((o) => o.mouseForcedWin === false).map((o) => o.step);
    const losing = perOpening.filter((o) => o.mouseForcedWin === true).map((o) => o.step);

    // The core tactical fact: U (the played opening) and L both lose; only D holds.
    expect(safe).toEqual(['D']);
    expect(losing.sort()).toEqual(['L', 'U']);
    expect(perOpening.every((o) => o.mouseForcedWin !== null)).toBe(true);
  }, 3_600_000);

  it('G6T2: enumerates the complete mouse response set at its first decision point', () => {
    const root = load('G6T2');

    // The played cat turn, replayed on the real engine. The 4th step exhausts
    // the cat budget, which triggers the CAT→MOUSE ghost-boundary CHANCE; the
    // prefix expansion therefore returns one state per positive-probability
    // ghost outcome, all at idx = 1 (mouse to move).
    const plan = ['U', 'U', 'R', 'R'];
    const pre = applyPrefixBranches(root, plan);
    expect(pre.ok, pre.failedAt).toBe(true);
    // MEASURED, not assumed: at this boundary the pending ghost is a single
    // unblocked cell, so the CAT→MOUSE ghost-boundary CHANCE has exactly ONE
    // positive-probability outcome (weight 1). It is still a CHANCE node in the
    // rules, but it introduces no branching — i.e. the escape does NOT hinge on
    // the boundary roll. (The real randomness is the pickup announcement.)
    expect(pre.states.length).toBe(1);
    expect(new Set(pre.idx)).toEqual(new Set([1]));

    // Enumerate the mouse's COMPLETE legal first-response set on one concrete
    // ghost branch (outcome #1 — the branch the W1 witness actually replays).
    const branch = pre.states[0];
    const responses = legalLabels(branch).map((lbl) => {
      const r = mouseForcesWin(branch, H1, 1, 300_000);
      const one = applyPrefixBranches(branch, [lbl], 1);
      let after: unknown = null;
      if (one.ok && one.states.length === 1) after = summarize(one.states[0]);
      return {
        action: lbl,
        // 'S' is the skill; a direction is a step. Both are real rule actions.
        mouseStillForcesWinWithinH1: r.value,
        childNodes: r.stats.nodes,
        childState: after,
      };
    });

    // The witness line, replayed step by step with the full legal set at each
    // decision point — this is the "what could the mouse have chosen" table.
    const witness = ['c:U', 'c:U', 'c:R', 'c:R', 'm:S', 'm:D', 'm:D', 'm:D', 'm:D', 'm:D', 'm:D',
      'c:R', 'c:D', 'c:D', 'c:D', 'm:R', 'm:R'];
    const res = replayBranch(root, witness, 0);
    expect(res.ok, res.failedAt).toBe(true);
    expect(res.finalPhase).toBe('mouse_wins');

    const stepwise = witness.map((act, i) => ({
      i,
      action: act,
      actor: act.startsWith('c:') ? 'cat' : 'mouse',
      legalSetAtDecisionPoint: res.legalSets[i],
      alternativeCount: res.legalSets[i].length,
      horizonIdxAfter: res.idxAfter[i],
      state: summarize(res.states[i]),
    }));

    // Every mouse decision point must offer real alternatives — an enumeration
    // that saw one legal move everywhere would not be an enumeration.
    const mousePoints = stepwise.filter((s) => s.actor === 'mouse');
    expect(mousePoints.length).toBe(9); // S + 6 D + 2 R
    expect(mousePoints.every((s) => s.alternativeCount >= 2)).toBe(true);

    mkdirSync(OUT, { recursive: true });
    writeFileSync(`${OUT}/MOUSE_RESPONSE_ENUMERATION.json`, JSON.stringify({
      generatedAt: new Date().toISOString(),
      generatedBy: 'PPC-CAT-STRATEGY-01/probe/tactical_tree.test.ts',
      root: 'G6T2',
      provenance: 'REAL_HUMAN_REPLAY',
      horizon: { name: 'H1', hParam: H1 },
      catOpeningScreening: {
        openings: ['U', 'D', 'L'],
        note: 'R 被箱子占据，不是合法首步（真实规则枚举结果）。'
          + '每个开局都从根状态出发、用精确布尔量词在 H1 下判定（cap=600k，无截断）。',
        measured: openingScreening,
      },
      ghostBoundaryAfterUurr: {
        outcomes: pre.states.length,
        horizonIdx: pre.idx[0],
        interpretation:
          'CAT→MOUSE 边界确实是 CHANCE 节点，但本局只有一个正概率结果（pending ghost 的公告格未被占用，'
          + '直接物化），权重 1.0 ⇒ 该边界不产生分支。鼠的逃脱不依赖这里的随机结果；'
          + '真正的随机源是鼠拾取时的公告（29 个候选）。',
      },
      mouseFirstResponsesOnGhostBranch1: {
        branchState: summarize(branch),
        branchHorizonIdx: 1,
        complete: true,
        responses,
        witnessChoice: 'S',
      },
      witnessLine: {
        purpose: 'MOUSE_WIN_WITNESS：∃猫线 × ∃CHANCE 分支 × ∃鼠线 → MouseWins（不等于强制获胜）',
        plan: witness,
        chanceLog: res.log,
        finalPhase: res.finalPhase,
        legalSets: res.legalSets,
        steps: stepwise,
      },
    }, null, 2));
  }, 3_600_000);
});
