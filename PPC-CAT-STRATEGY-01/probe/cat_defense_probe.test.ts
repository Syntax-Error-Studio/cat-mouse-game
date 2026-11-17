/// <reference types="node" />
/**
 * TACT-5 / TACT-7 — cat defense witnesses for G6T2, and the absence of a
 * defense on the openings that actually lose.
 *
 * The ∀-side claim (CAT_SURVIVAL_CERTIFIED_WITHIN_H) is carried by the exact
 * boolean refutation tree in `tactical_tree.test.ts`, NOT by the line printed
 * here. The line is one concrete instance of the cat strategy; the coverage
 * table below is what makes "every mouse reply is still denied" checkable at
 * depth 1 of each mouse decision point.
 *
 * `*` in a legal-action label means the transition is a CHANCE node (a butter
 * pickup that announces a pending ghost); see `legalLabels` in probe/lib.ts.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { restoreHardRoot } from '../../src/game/ai/hardHistory';
import {
  mouseForcesWin, traceCatDefense, replayBranch, applyPrefixBranches,
  legalLabels, summarize,
} from './lib';
import type { GameEngineState } from '../../src/game/engine';

const FIXTURE = 'src/game/ai/__tests__/fixtures/ppcId01-human-roots.json';
const OUT = 'PPC-CAT-STRATEGY-01';
const H1 = 2;
const CAP = 300_000;
const records = JSON.parse(readFileSync(FIXTURE).toString('utf8')) as { id: string; state: unknown }[];
const load = (id: string): GameEngineState => restoreHardRoot(records.find((r) => r.id === id)!.state as never);

const isAction = (l: string) => l.startsWith('c:') || l.startsWith('m:');

describe('TACT-5/TACT-7 cat defense witnesses', () => {
  it('the H1 defense line is reachable on the real engine and survives the horizon', () => {
    const root = load('G6T2');
    const line = traceCatDefense(root, H1, 0);
    expect(line.length).toBeGreaterThan(2);
    expect(line).not.toContain('STOP');

    // The cat's first move on the safe line must be D — the other two lose.
    expect(line[0]).toBe('c:D');

    const plan = line.filter(isAction);
    const res = replayBranch(root, plan, 0);
    expect(res.ok, res.failedAt).toBe(true);
    expect(res.finalPhase).toBe('playing'); // nobody won inside the window
    // A witness that never reached the horizon would prove nothing.
    expect(Math.max(...res.idxAfter)).toBeGreaterThanOrEqual(2 * H1 - 1);

    writeFileSync(`${OUT}/CAT_DEFENSE_WITNESSES.json`, JSON.stringify({
      generatedAt: new Date().toISOString(),
      generatedBy: 'PPC-CAT-STRATEGY-01/probe/cat_defense_probe.test.ts',
      root: 'G6T2',
      provenance: 'REAL_HUMAN_REPLAY',
      classification: 'CAT_SURVIVAL_CERTIFIED_WITHIN_H1',
      quantifier: '∃τ_cat ∀σ_mouse ∀chance → ¬MouseWins',
      horizon: { name: 'H1', hParam: H1, cut: '猫节点 idx >= 4 视为视界外' },
      witnesses: [{
        id: 'W-CD-H1',
        note: '轨迹由精确量词搜索给出：每个猫节点取「能挡住」的第一着，鼠节点任取其首着（∀ 侧）。'
          + '这只是策略的一个实例；∀ 覆盖由反驳树保证。',
        tracedLine: line,
        replayedPlan: plan,
        chanceLog: res.log,
        horizonIdxAfter: res.idxAfter,
        legalSets: res.legalSets,
        steps: plan.map((a, i) => ({ i, action: a, state: summarize(res.states[i]) })),
        finalPhase: res.finalPhase,
      }],
    }, null, 2));
  }, 3_600_000);

  it('H0 already has a (shorter) defense — the window distinction is real, not cosmetic', () => {
    const root = load('G6T2');
    const line = traceCatDefense(root, 1, 0);
    expect(line).not.toContain('STOP');
    const plan = line.filter(isAction);
    const res = replayBranch(root, plan, 0);
    expect(res.ok, res.failedAt).toBe(true);
    expect(res.finalPhase).toBe('playing');
    // H0 = cat turn + mouse turn, so the H0 witness must be strictly shorter.
    expect(plan.length).toBeLessThan(
      traceCatDefense(root, H1, 0).filter(isAction).length,
    );
  }, 3_600_000);

  it('the losing openings have NO denying move at all (trace returns STOP)', () => {
    const root = load('G6T2');
    for (const step of ['U', 'L']) {
      const pre = applyPrefixBranches(root, [step]);
      expect(pre.ok, pre.failedAt).toBe(true);
      const line = traceCatDefense(pre.states[0], H1, pre.idx[0]);
      // Every cat move from here still loses ⇒ no denying child exists, so the
      // trace cannot extend past the dead node.
      expect(line, step).toEqual(['STOP']);
    }
  }, 3_600_000);

  it('reports every mouse reply along the defense line and whether it is still denied', () => {
    const root = load('G6T2');
    const line = traceCatDefense(root, H1, 0).filter(isAction);
    const res = replayBranch(root, line, 0);
    expect(res.ok, res.failedAt).toBe(true);

    const t0 = performance.now();
    const coverage: {
      step: number; mouseNode: string; replies: { action: string; mouseForcedWin: boolean | null }[];
      allDenied: boolean;
    }[] = [];

    for (let i = 0; i < line.length; i++) {
      if (!line[i].startsWith('m:')) continue;
      if (performance.now() - t0 > 240_000) break; // honest, bounded scan
      // The DECISION POINT for `line[i]` is the state BEFORE that mouse action,
      // i.e. states[i-1] (root for i === 0). Using states[i] would sample the
      // post-action node and silently skip every point where the action ended
      // the mouse turn — that under-counted the table the first time round.
      const at = i === 0 ? root : res.states[i - 1];
      const atIdx = i === 0 ? 0 : res.idxAfter[i - 1];
      expect(at.currentPlayer, `step ${i} pre-state must be the mouse`).toBe('mouse');
      const replies = legalLabels(at).map((lbl) => {
        const pre = applyPrefixBranches(at, [lbl], atIdx);
        if (!pre.ok || pre.states.length === 0) {
          return { action: lbl, mouseForcedWin: null as boolean | null };
        }
        // A CHANCE reply fans out; the mouse forces a win only if EVERY
        // positive-probability branch does, so require all of them.
        let allWin = true;
        let anyUnknown = false;
        for (const st of pre.states) {
          const r = mouseForcesWin(st, H1, pre.idx[0], CAP);
          if (r.value === null) anyUnknown = true;
          else if (r.value === false) { allWin = false; break; }
        }
        return { action: lbl, mouseForcedWin: anyUnknown && allWin ? null : allWin };
      });
      coverage.push({
        step: i,
        mouseNode: `cat=${at.catPosition.r},${at.catPosition.c} mouse=${at.mousePosition.r},${at.mousePosition.c}`,
        replies,
        allDenied: replies.every((r) => r.mouseForcedWin === false),
      });
    }

    // Every mouse decision point on the safe line must have every reply denied.
    expect(coverage.length).toBeGreaterThan(0);
    for (const c of coverage) {
      expect(c.allDenied, `step ${c.step} ${c.mouseNode}: ${JSON.stringify(c.replies)}`).toBe(true);
    }

    // Append the coverage to the artifact produced above (same file, one object).
    const path = `${OUT}/CAT_DEFENSE_WITNESSES.json`;
    const doc = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    doc.mouseReplyCoverage = {
      note: '对防守线上每个鼠决策点，枚举鼠的全部合法回应，并逐个用精确量词搜索验证「仍被挡住」。'
        + 'CHANCE 回应要求所有正概率分支都被挡住。cap=' + CAP,
      cap: CAP,
      elapsedMs: Math.round(performance.now() - t0),
      // Every mouse action on the line has exactly one decision point, so a
      // complete table has one row per `m:` label.
      mouseDecisionPointsOnLine: line.filter((l) => l.startsWith('m:')).length,
      coveredDecisionPoints: coverage.length,
      complete: coverage.length === line.filter((l) => l.startsWith('m:')).length,
      points: coverage,
    };
    mkdirSync(OUT, { recursive: true });
    writeFileSync(path, JSON.stringify(doc, null, 2));
  }, 3_600_000);

  it('DRRR (the historically named alternative) is also safe — there is more than one defense', () => {
    const root = load('G6T2');
    const pre = applyPrefixBranches(root, ['D', 'R', 'R', 'R']);
    expect(pre.ok, pre.failedAt).toBe(true);
    // Every positive-probability boundary outcome must still be safe.
    let anyWin = false;
    let anyUnknown = false;
    for (const st of pre.states) {
      const r = mouseForcesWin(st, H1, pre.idx[0], CAP);
      if (r.value === true) anyWin = true;
      if (r.value === null) anyUnknown = true;
    }
    expect(anyUnknown).toBe(false);
    expect(anyWin).toBe(false); // DRRR holds too
    const end = summarize(pre.states[0]);

    const path = `${OUT}/CAT_DEFENSE_WITNESSES.json`;
    const doc = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    doc.alternativeFullTurnWitnesses = [{
      id: 'W-CD-DRRR',
      plan: ['D', 'R', 'R', 'R'],
      boundaryOutcomes: pre.states.length,
      horizonIdx: pre.idx[0],
      mouseForcedWinOnAnyBranch: anyWin,
      verdict: 'CAT_SURVIVAL_CERTIFIED_WITHIN_H1',
      catAfter: `${end.cat}, mouse=${end.mouse}`,
      note: '历史叙述把 DRRR 当作替代安全线；本轮用精确量词验证它确实安全。'
        + '注意安全的原因不是「守住 (4,6)」，而是猫保持在与鼠可捕获的关系上，'
        + '使鼠在 6 步内无法既拿油又进洞。',
    }];
    writeFileSync(path, JSON.stringify(doc, null, 2));
  }, 3_600_000);

  it('enumerates, level by level, which cat moves keep the position safe', () => {
    const root = load('G6T2');
    const t0 = performance.now();

    /** Verdict for every legal cat move at one node (chance branches = AND). */
    const verdictsAt = (state: GameEngineState, idx: number) =>
      legalLabels(state).map((lbl) => {
        const pre = applyPrefixBranches(state, [lbl], idx);
        if (!pre.ok) return { action: lbl, safe: null as boolean | null, branches: 0 };
        let safe = true;
        let unknown = false;
        for (const st of pre.states) {
          const r = mouseForcesWin(st, H1, pre.idx[0], CAP);
          if (r.value === null) unknown = true;
          else if (r.value === true) { safe = false; break; }
        }
        return { action: lbl, safe: unknown && safe ? null : safe, branches: pre.states.length };
      });

    // Level 1: the opening step (cat still to move afterwards ⇒ idx stays 0).
    const level1 = verdictsAt(root, 0);
    const safeSteps = level1.filter((v) => v.safe === true).map((v) => v.action);
    expect(safeSteps).toEqual(['D']);

    // Level 2: continue only through the safe opening.
    const level2: { afterFirst: string; moves: ReturnType<typeof verdictsAt> }[] = [];
    for (const step of safeSteps) {
      const pre = applyPrefixBranches(root, [step], 0);
      expect(pre.states.length).toBe(1);
      level2.push({ afterFirst: step, moves: verdictsAt(pre.states[0], pre.idx[0]) });
    }
    expect(level2.length).toBe(1);
    expect(level2[0].moves.some((m) => m.safe === true)).toBe(true);

    const path = `${OUT}/CAT_DEFENSE_WITNESSES.json`;
    const doc = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    doc.catDefenseActionSets = {
      note: '逐层枚举猫的全部合法走法，并用精确量词搜索给每个走法打安全/不安全。'
        + '「安全」= ∃后续猫策略使鼠在 H1 内无法强制获胜。CHANCE 后继取 AND。',
      horizon: 'H1',
      cap: CAP,
      elapsedMs: Math.round(performance.now() - t0),
      depthReached: 2,
      depthLimited: '只展开到猫的第一回合前两步；更深层由 W-CD-H1 的防线与反驳树覆盖。',
      level1Root: level1,
      level2AfterSafeOpening: level2,
    };
    writeFileSync(path, JSON.stringify(doc, null, 2));
  }, 3_600_000);

  it('measures the tempo race: where the two pieces stand when round 2 starts', () => {
    const root = load('G6T2');
    // The SAME mouse attempt against three different cat openings. The attempt
    // is the historical one (skill + six downward steps); whether it is even
    // legal is part of the measurement.
    const mouseAttempt = ['m:S', 'm:D', 'm:D', 'm:D', 'm:D', 'm:D', 'm:D'];
    const plans = [['U', 'U', 'R', 'R'], ['D', 'R', 'R', 'R'], ['D', 'R', 'D', 'R']];

    const rows = plans.map((catPlan) => {
      const catPlanStr = catPlan.join('');
      // 1) the cat turn, on the real rules (its last step is the ghost boundary)
      const afterCat = applyPrefixBranches(root, catPlan);
      expect(afterCat.ok, afterCat.failedAt).toBe(true);
      const s0 = afterCat.states[0];
      // 2) the mouse attempt
      const attempt = replayBranch(root, [...catPlan.map((d) => `c:${d}`), ...mouseAttempt], 0);
      const last = attempt.states[attempt.states.length - 1];
      const reachedAll = attempt.ok;
      const d = Math.abs(s0.catPosition.r - last.mousePosition.r)
        + Math.abs(s0.catPosition.c - last.mousePosition.c);
      return {
        catPlan: catPlanStr,
        catEnd: `${s0.catPosition.r},${s0.catPosition.c}`,
        mouseAttemptLegal: reachedAll,
        mouseEnd: `${last.mousePosition.r},${last.mousePosition.c}`,
        mouseMovesLeft: last.mouseMovesLeft,
        catMouseDistanceAtRound2Start: d,
        // Whether the cat is the side to move once the round-1 dust settles. The
        // capture flag below is only MEANINGFUL when this is true: if the mouse
        // still holds moves, "the cat can reach it" is not a claim about the game.
        catToMoveAtRound2Start: last.currentPlayer === 'cat',
        mouseHeldMovesAtRound2Start: last.mouseMovesLeft,
        // round 2 starts with the cat's budget REFILLED (endTurn sets it back to
        // catBaseMoves); s0.catMovesLeft is 0 at the end of round 1 and must not
        // be used as the capture budget.
        catCanReachMouseInOneTurn: reachedAll && last.currentPlayer === 'cat' && d <= root.config.catBaseMoves,
        catCanReachApplies: reachedAll && last.currentPlayer === 'cat',
        blockers: reachedAll ? [] : [attempt.failedAt ?? 'unknown'],
      };
    });

    // The mechanism, quantified: UURR leaves the cat 7 steps away from the
    // mouse's resting cell (it has 4), so the mouse simply enters next turn.
    const u = rows.find((r) => r.catPlan === 'UURR')!;
    expect(u.mouseAttemptLegal).toBe(true);
    expect(u.mouseEnd).toBe('7,6');
    expect(u.catEnd).toBe('1,5');
    expect(u.catMouseDistanceAtRound2Start).toBe(7);
    expect(u.catCanReachMouseInOneTurn).toBe(false);

    // The two safe openings either block the corridor outright (DRRR) or leave
    // the cat within capture range (DRDR).
    const drrr = rows.find((r) => r.catPlan === 'DRRR')!;
    const drdr = rows.find((r) => r.catPlan === 'DRDR')!;
    expect(drrr.mouseAttemptLegal).toBe(false);   // the cat physically occupies (4,6)
    expect(drrr.catMouseDistanceAtRound2Start).toBe(1); // stuck 1 step away
    expect(drdr.mouseAttemptLegal).toBe(true);
    expect(drdr.catMouseDistanceAtRound2Start).toBeLessThanOrEqual(4);
    expect(drdr.catMouseDistanceAtRound2Start).toBe(3);
    expect(drdr.catCanReachMouseInOneTurn).toBe(true);

    // Two DIFFERENT mechanisms, pinned so the report cannot conflate them:
    //   DRRR — blockade: the mouse's turn is still running (4 moves left), it
    //          simply has no legal step onto the corridor cell the cat took.
    //   DRDR — tempo:     the mouse spends all 6 moves, the turn passes, and the
    //          cat is left 3 steps away with 4 allowed.
    expect(drrr.catToMoveAtRound2Start).toBe(false);
    expect(drrr.mouseHeldMovesAtRound2Start).toBe(4);
    expect(drrr.catCanReachApplies).toBe(false);
    expect(drdr.catToMoveAtRound2Start).toBe(true);
    expect(drdr.mouseHeldMovesAtRound2Start).toBe(0);
    expect(drdr.catCanReachApplies).toBe(true);

    const path = `${OUT}/CAT_DEFENSE_WITNESSES.json`;
    const doc = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    doc.tempoRaceTable = {
      note: '同一段鼠行动（技能 + 六个下行）对三种猫开局的实测。'
        + '决定性的量是「round2 开始时猫鼠距离」再加上「此时轮到谁走」：'
        + 'catCanReachMouseInOneTurn 只在 catCanReachApplies=true 时才有意义。'
        + 'DRRR 属封锁型（鼠回合还没走完，它是被物理挡住），DRDR 属节奏型（鼠走完 6 步，'
        + '轮到猫，距离 3 <= 4 可直接抓捕）；两种原理不同，不可混为一谈。',
      catMovesPerTurn: root.config.catBaseMoves,
      rows,
    };
    writeFileSync(path, JSON.stringify(doc, null, 2));
  }, 3_600_000);
});
