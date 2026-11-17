/// <reference types="node" />
/**
 * TACT-6 — real-engine, action-by-action replay of the strongest witnesses.
 *
 * Everything here is replayed through `simulateSearchAction` on the REAL
 * RuleSet, so a replay that reaches MouseWins is a rule-level fact, not an
 * interpretation of a log line.
 *
 *   W1 (mouse escape, G6T2, cat opens UURR):
 *        c:U c:U c:R c:R  m:S m:D m:D m:D m:D m:D m:D  (cat: 4 steps, mouse: 6)
 *        c:R c:D c:D c:D  m:R m:R  → MouseWins
 *      = the historical SDDDDDD + RR line, reconstructed end to end.
 *   W2 (cat defense, G6T2, cat opens D): the safe line produced by the exact
 *      quantifier search (§7.3 witness), replayed to the horizon.
 *   W3 (control, G6T3): the position is already lost — the mouse wins in its
 *      very next turn against every cat reply, so no defense exists there.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { restoreHardRoot } from '../../src/game/ai/hardHistory';
import { replay, replayBranch, summarize, mouseForcesWin, traceCatDefense, stateKey } from './lib';
import type { GameEngineState } from '../../src/game/engine';

const FIXTURE = 'src/game/ai/__tests__/fixtures/ppcId01-human-roots.json';
const OUT = 'PPC-CAT-STRATEGY-01/_raw';
const records = JSON.parse(readFileSync(FIXTURE).toString('utf8')) as { id: string; state: unknown }[];
const load = (id: string): GameEngineState => restoreHardRoot(records.find((r) => r.id === id)!.state as never);

describe('TACT-6 witness replay', () => {
  it('W1: the mouse escape line wins on the real engine (cat UURR)', () => {
    const root = load('G6T2');
    const plan = ['c:U', 'c:U', 'c:R', 'c:R', 'm:S', 'm:D', 'm:D', 'm:D', 'm:D', 'm:D', 'm:D',
      'c:R', 'c:D', 'c:D', 'c:D', 'm:R', 'm:R'];
    const res = replayBranch(root, plan, 0);
    expect(res.ok, res.failedAt).toBe(true);
    expect(res.finalPhase).toBe('mouse_wins');

    // Spot-check the intermediate milestones the narrative claims.
    const afterCat = res.states[3];
    expect(`${afterCat.catPosition.r},${afterCat.catPosition.c}`).toBe('1,5'); // UURR
    const afterSkill = res.states[4];
    expect(afterSkill.mouseHasButter).toBe(false);
    expect(afterSkill.mouseSkillActive).toBe(true);
    expect(afterSkill.mouseMovesLeft).toBe(6); // 3 carrying + 3 skill
    const afterPickup = res.states[5];
    expect(`${afterPickup.mousePosition.r},${afterPickup.mousePosition.c}`).toBe('2,6');
    expect(afterPickup.mouseHasButter).toBe(true); // re-picked the entity butter
    const afterRun = res.states[10];
    expect(`${afterRun.mousePosition.r},${afterRun.mousePosition.c}`).toBe('7,6');
    expect(afterRun.mouseMovesLeft).toBe(0);
    expect(afterRun.currentPlayer).toBe('cat');
    const afterCat2 = res.states[14];
    expect(`${afterCat2.catPosition.r},${afterCat2.catPosition.c}`).toBe('4,6'); // RDDD
    const win = res.states[res.states.length - 1];
    expect(win.phase).toBe('mouse_wins');

    mkdirSync(OUT, { recursive: true });
    writeFileSync(`${OUT}/witness-mouse-escape.json`, JSON.stringify({
      witness: 'W1',
      root: 'G6T2',
      classification: 'MOUSE_WIN_WITNESS (∃ cat line × ∃ chance branch × ∃ mouse line)',
      plan,
      chanceLog: res.log,
      steps: res.states.map((s, i) => ({ i, action: plan[i], ...summarize(s), key: stateKey(s).slice(0, 48) })),
      finalPhase: res.finalPhase,
    }, null, 2));
  });

  it('W1b: the same mouse sequence FAILS when the cat plugs the corridor first', () => {
    const root = load('G6T2');
    // cat DRRR → (4,6), then the identical mouse attempt
    const plan = ['c:D', 'c:R', 'c:R', 'c:R', 'm:S', 'm:D', 'm:D', 'm:D', 'm:D', 'm:D', 'm:D',
      'c:R', 'c:D', 'c:D', 'c:D', 'm:R', 'm:R'];
    const res = replayBranch(root, plan, 0);
    const afterCat = res.states[3];
    expect(`${afterCat.catPosition.r},${afterCat.catPosition.c}`).toBe('4,6');
    // The cat now OCCUPIES (4,6), so the mouse's third downward step is not
    // even legal — the real engine refuses it. The identical key sequence that
    // won against UURR cannot be executed at all against DRRR.
    expect(res.ok).toBe(false);
    expect(res.failedAt).toContain('illegal');
    const blockedAt = res.states[res.states.length - 1];
    expect(`${blockedAt.mousePosition.r},${blockedAt.mousePosition.c}`).toBe('3,6');
    expect(res.finalPhase).not.toBe('mouse_wins');
  });

  it('W2: the quantifier-derived cat defense line survives the horizon (cat opens D)', () => {
    const root = load('G6T2');
    const line = traceCatDefense(root, 2, 0);
    // drop the trailing bookkeeping tokens ('HORIZON' / 'END:…' / 'STOP')
    const plan = line.filter((l) => l.startsWith('c:') || l.startsWith('m:'));
    const res = replayBranch(root, plan, 0);
    expect(res.ok, res.failedAt).toBe(true);
    expect(res.finalPhase).toBe('playing'); // neither side won inside the horizon
    mkdirSync(OUT, { recursive: true });
    writeFileSync(`${OUT}/witness-cat-defense.json`, JSON.stringify({
      witness: 'W2',
      root: 'G6T2',
      classification: 'CAT_SURVIVAL_CERTIFIED_WITHIN_H1 (∃τ ∀mouse ∀chance)',
      tracedLine: line,
      replayedPlan: plan,
      chanceLog: res.log,
      finalPhase: res.finalPhase,
    }, null, 2));
  });

  it('W3: G6T3 is already lost — the mouse wins in its next turn against every cat reply', () => {
    const g3 = load('G6T3');
    const r = mouseForcesWin(g3, 1, 0);
    expect(r.value).toBe(true);
    // and it stays true with a longer horizon
    const r2 = mouseForcesWin(g3, 2, 0);
    expect(r2.value).toBe(true);
  });

  it('sanity: replay() rejects an illegal action instead of silently skipping it', () => {
    const root = load('G6T2');
    const res = replay(root, ['c:D', 'c:R']); // (3,3)->(4,3)->(4,4) — both legal
    expect(res.ok).toBe(true);
    const bad = replay(root, ['c:U', 'c:U', 'c:U', 'c:U', 'c:U', 'c:U']);
    expect(bad.ok).toBe(false); // the cat only has 4 moves in a turn
    expect(bad.failedAt).toContain('not legal');
  });
});
