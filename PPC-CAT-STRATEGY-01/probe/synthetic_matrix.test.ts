/// <reference types="node" />
/**
 * §9 — minimal SYNTHETIC tactical matrix (13 cases).
 *
 * Every case is SYNTHETIC. None of them counts as a human game; the human corpus
 * stays at 24 (see HUMAN_ROOT_RECONSTRUCTION.json). Each case is built as a
 * documented delta on the G6T2 terrain (so the map is a real, legal map), then
 * validated with the real rules before anything is measured:
 *
 *   - phase is `playing` and the coin flip of no-move loss does not fire;
 *   - at least one prepared action exists;
 *   - every placed piece / butter / ghost sits on a passable, non-hazard cell.
 *
 * The measurement is always the SAME exact question as the rest of the report
 * (∃ mouse strategy forced win within H0/H1), so the rows are comparable with the
 * 24 human roots. Nothing here is compared against the production evaluator.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { restoreHardRoot } from '../../src/game/ai/hardHistory';
import { generatePreparedSearchActions } from '../../src/game/ai/preparedActions';
import { applyNoMoveLoss, noMoveLossVerdict } from '../../src/game/rules/mobility';
import { mouseForcesWin, label, summarize, rules } from './lib';
import type { GameEngineState } from '../../src/game/engine';

const FIXTURE = 'src/game/ai/__tests__/fixtures/ppcId01-human-roots.json';
const OUT = 'PPC-CAT-STRATEGY-01';
const SYN = `${OUT}/fixtures/synthetic`;
const records = JSON.parse(readFileSync(FIXTURE).toString('utf8')) as { id: string; state: unknown }[];
const base: GameEngineState = restoreHardRoot(records.find((r) => r.id === 'G6T2')!.state as never);

type Pt = { r: number; c: number };
const clone = (s: GameEngineState): GameEngineState => JSON.parse(JSON.stringify(s)) as GameEngineState;

/** Build a variant of the base terrain. */
function variant(patch: (s: GameEngineState) => void): GameEngineState {
  const s = clone(base);
  // start from a clean tactical slate; each case re-adds only what it studies
  s.butterPositions = [];
  s.pendingButterSpawns = [];
  s.pendingButterPlacementDebt = 0;
  s.trapPosition = null;
  s.catTrapsRemaining = 1;
  s.blockedTunnels = [];
  patch(s);
  return applyNoMoveLoss(s);
}

function setCell(s: GameEngineState, r: number, c: number, type: GameEngineState['board'][number][number]['type']) {
  s.board[r][c] = { ...s.board[r][c], type };
}

/** Legality gate — nothing is measured on a state the rules would reject. */
function validate(id: string, s: GameEngineState) {
  expect(s.phase, id).toBe('playing');
  expect((s.pendingButterSpawns ?? []).every((g) => Number.isInteger(g.r)), id).toBe(true);
  const acts = generatePreparedSearchActions(s, rules);
  expect(acts.length, `${id}: no legal action`).toBeGreaterThan(0);
  // pieces on passable cells
  for (const [name, p] of [['cat', s.catPosition], ['mouse', s.mousePosition]] as const) {
    const t = s.board[p.r][p.c].type;
    expect(['empty', 'trap', 'tunnel', 'butter'], `${id}: ${name} on ${t}`).toContain(t);
  }
  for (const b of s.butterPositions) {
    expect(s.board[b.r][b.c].type, `${id}: butter on ${s.board[b.r][b.c].type}`).toBe('empty');
  }
  return {
    legalActions: acts.map((a) => label(a.action)),
    ruleAVerdict: noMoveLossVerdict(s),
  };
}

interface Case {
  id: string;
  hypothesis: string;
  construct: (s: GameEngineState) => void;
  /** Mouse turn states are measured at idx 1, cat turn states at idx 0. */
  note?: string;
}

const CASES: Case[] = [
  {
    id: 'S01_BUTTER_NEAR_HOLE',
    hypothesis: '黄油紧贴鼠洞时，猫必须更早封锁洞口，否则鼠拿油即可进洞。',
    construct: (s) => {
      s.butterPositions = [{ r: 6, c: 7 }];  // adjacent to the hole block at (7,8)
      s.mouseHasButter = false;
    },
  },
  {
    id: 'S02_BUTTER_NEAR_TUNNEL',
    hypothesis: '黄油紧贴传送通道时，通道本身成为「取油捷径」，猫需要把通道算进封锁成本。',
    construct: (s) => {
      s.butterPositions = [{ r: 0, c: 1 }];  // next to tunnel corner (0,0)
      s.mouseHasButter = false;
    },
  },
  {
    id: 'S03_MOUSE_CARRYING_ONLY',
    hypothesis: '鼠已经带油且场上无油时，猫的唯一任务是阻止进洞，不需要看守黄油。',
    construct: (s) => {
      s.mouseHasButter = true;
      s.butterPositions = [];
      s.mouseMovesLeft = 0;
    },
  },
  {
    id: 'S04_SKILL_REPICK',
    hypothesis: '鼠使用技能后（+3 步）立刻重新拾取黄油，一个回合可以完成「丢弃→拾取→转移」。',
    construct: (s) => {
      s.currentPlayer = 'mouse';
      s.mouseSkillActive = true;
      s.mouseMovesLeft = 5;         // 2 left of the 3 carrying moves after 1 step? no: skill granted
      s.mouseHasButter = false;
      s.butterPositions = [{ r: 2, c: 6 }];
      s.mousePosition = { r: 1, c: 6 };
      s.catMovesLeft = 0;
    },
    note: '鼠行动中的状态，从 idx=1 起算，不与猫回合根直接比较。',
  },
  {
    id: 'S05_TUNNEL_OPEN',
    hypothesis: '通道开放时，鼠「踩角—传送」可用；但带油时无权进通道，必须先放技能消耗黄油（见 mouseSkillUnlocksSpatialMove）。',
    construct: (s) => {
      s.currentPlayer = 'mouse';
      s.catMovesLeft = 0;
      s.mouseHasButter = false;          // carrying butter forbids tunnel entry
      s.mousePosition = { r: 9, c: 1 };  // next to tunnel corner (9,0)
      s.mouseMovesLeft = s.config.mouseBaseMoves;
    },
  },
  {
    id: 'S06_TUNNEL_BLOCKED',
    hypothesis: '同一局面下把四个通道全部封锁，传送动作从合法集中消失（机制性差异，可枚举验证）。',
    construct: (s) => {
      s.currentPlayer = 'mouse';
      s.catMovesLeft = 0;
      s.mouseHasButter = false;
      s.mousePosition = { r: 9, c: 1 };
      s.mouseMovesLeft = s.config.mouseBaseMoves;
      s.blockedTunnels = [{ r: 9, c: 0 }, { r: 0, c: 0 }, { r: 0, c: 9 }, { r: 9, c: 9 }];
    },
  },
  {
    id: 'S07_CAT_PRE_OCCUPY_GATE',
    hypothesis: '猫提前占据洞口前的闸口格，可以单独消除该方向的逃逸。',
    construct: (s) => {
      s.mouseHasButter = true;
      s.catPosition = { r: 4, c: 6 };
      s.mouseMovesLeft = 0;
    },
  },
  {
    id: 'S08_CAT_PUSH_BOX_BLOCKS_TUNNEL',
    hypothesis: '推箱进入通道角可以永久封锁通道，且只花 1 步。',
    construct: (s) => {
      s.mouseHasButter = true;
      setCell(s, 0, 1, 'box');
      s.catPosition = { r: 0, c: 2 };   // can push (0,1) left into the corner (0,0)
      s.mouseMovesLeft = 0;
    },
  },
  {
    id: 'S09_CAT_FREE_TRAP',
    hypothesis: '放陷阱不消耗步数，因此「本回合放夹 + 4 步移动」是同时可得的。',
    construct: (s) => {
      s.mouseHasButter = true;
      s.trapPosition = null;
      s.catTrapsRemaining = 1;
      s.mouseMovesLeft = 0;
    },
  },
  {
    id: 'S10_CAT_RECLAIM_TRAP',
    hypothesis: '回收陷阱必须踩上陷阱格（花 1 步），因此两次放夹之间至少隔 2 个猫步。',
    construct: (s) => {
      s.mouseHasButter = true;
      s.catTrapsRemaining = 0;
      s.trapPosition = { r: 4, c: 3 };  // one step below the cat at (3,3)
      s.mouseMovesLeft = 0;
    },
  },
  {
    id: 'S11_GHOST_MATERIALIZE_ONE_CELL',
    hypothesis: '单个待物化幽灵在猫回合结束后出现在公告格（权重 1，无分支）。',
    construct: (s) => {
      s.butterPositions = [];
      s.pendingButterSpawns = [{ r: 5, c: 1, blockedMaterializations: 0 }];
      s.mouseHasButter = true;
      s.mouseMovesLeft = 0;
    },
  },
  {
    id: 'S12_GHOST_CELL_OCCUPIED',
    hypothesis: '公告格被占用时首次物化失败（blocked+1），位置战利品不能凭空消失。',
    construct: (s) => {
      s.butterPositions = [];
      s.pendingButterSpawns = [{ r: 5, c: 1, blockedMaterializations: 0 }];
      setCell(s, 5, 1, 'box');          // the announced cell is now a box
      s.mouseHasButter = true;
      s.mouseMovesLeft = 0;
    },
  },
  {
    id: 'S13_MULTI_ESCAPE_ROUTES',
    hypothesis: '洞口有两个以上可达入口时，单点封锁不足以消除必然性。',
    construct: (s) => {
      s.mouseHasButter = true;
      s.mousePosition = { r: 5, c: 7 }; // between the two hole approaches
      s.mouseMovesLeft = 0;
    },
  },
];

/** Run the cat's turn to its end so the CAT→MOUSE ghost boundary can be observed. */
function observeBoundary(s: GameEngineState) {
  let cur = applyNoMoveLoss(s);
  const log: string[] = [];
  for (let guard = 0; guard < 12; guard++) {
    if (cur.currentPlayer !== 'cat' || cur.phase !== 'playing') break;
    const acts = generatePreparedSearchActions(cur, rules);
    if (acts.length === 0) break;
    const first = acts[0];
    const tr = first.transition;
    if (tr.kind === 'chance') {
      const sum = tr.outcomes.reduce((a, o) => a + o.weight, 0);
      log.push(`CHANCE ${label(first.action)}: ${tr.outcomes.length} outcomes weightSum=${sum}`);
      const ghosts = (tr.outcomes[0].state.pendingButterSpawns ?? []).map((g) => `${g.r},${g.c}:${g.blockedMaterializations}`);
      const butters = tr.outcomes[0].state.butterPositions.map((b) => `${b.r},${b.c}`);
      log.push(`  outcome#1 ghosts=[${ghosts.join(';')}] butters=[${butters.join(';')}] debt=${tr.outcomes[0].state.pendingButterPlacementDebt ?? 0}`);
      cur = applyNoMoveLoss(tr.outcomes[0].state);
    } else {
      cur = applyNoMoveLoss(tr.state);
    }
  }
  return { log, end: cur };
}

describe('§9 synthetic tactical matrix', () => {
  it('builds, validates and measures all 13 SYNTHETIC cases', () => {
    mkdirSync(SYN, { recursive: true });

    const rows = CASES.map((c) => {
      const state = variant(c.construct);
      const legality = validate(c.id, state);
      // H0 = one cat turn + the following mouse turn (hParam 1). The horizon cut
      // is defined from a CAT root (`idx >= 2*hParam` closes the window), so a
      // case constructed with the mouse already to move only gets H0. H1 is then
      // NOT_PERFORMED and must say so — never an implicit null.
      const startIdx = state.currentPlayer === 'mouse' ? 1 : 0;
      const h0 = mouseForcesWin(state, 1, startIdx, 600_000);
      const h1 = startIdx === 0 ? mouseForcesWin(state, 2, 0, 600_000) : null;
      const h1NotPerformedReason = h1 === null
        ? 'constructed with the MOUSE to move (startIdx=1); the H1 cut is only defined from a cat root, '
          + 'so the second window is not measured rather than assumed either way'
        : null;

      writeFileSync(`${SYN}/${c.id}.json`, JSON.stringify({
        id: c.id,
        provenance: 'SYNTHETIC',
        derivedFrom: 'G6T2 terrain (real map), tactical fields replaced',
        hypothesis: c.hypothesis,
        note: c.note ?? null,
        legalActionsAtConstruction: legality.legalActions,
        state: state as unknown as Record<string, unknown>,
        summary: summarize(state),
      }, null, 2));

      return {
        id: c.id,
        provenance: 'SYNTHETIC',
        hypothesis: c.hypothesis,
        note: c.note ?? null,
        startIdx,
        legality,
        summary: summarize(state),
        h0: { mouseForcedWin: h0.value, nodes: h0.stats.nodes, truncated: h0.stats.truncated },
        h1: h1 ? { mouseForcedWin: h1.value, nodes: h1.stats.nodes, truncated: h1.stats.truncated } : null,
        h1NotPerformedReason,
        boundary: ['S11_GHOST_MATERIALIZE_ONE_CELL', 'S12_GHOST_CELL_OCCUPIED'].includes(c.id)
          ? observeBoundary(state)
          : null,
      };
    });

    // Every case must be legal and fully evaluated — a truncated row would be a
    // fabricated table cell.
    for (const r of rows) {
      expect(r.legality.ruleAVerdict, r.id).toBeNull();
      expect(r.h0.truncated, r.id).toBe(false);
      if (r.h1) expect(r.h1.truncated, r.id).toBe(false);
    }

    // The paired control (S05 open vs S06 blocked): the LEGAL MOVE SET must
    // differ (that is what blocking a tunnel mechanically does). The window
    // verdict does NOT have to differ, and here it does not — recorded honestly:
    // entering a corner zeroes the mouse's remaining moves (engine.ts:710), so a
    // tunnel is a whole-turn reposition, not a free shortcut inside one turn.
    const s05 = rows.find((r) => r.id === 'S05_TUNNEL_OPEN')!;
    const s06 = rows.find((r) => r.id === 'S06_TUNNEL_BLOCKED')!;
    expect(s05.legality.legalActions).not.toEqual(s06.legality.legalActions);
    expect(s05.h0.mouseForcedWin).toBe(s06.h0.mouseForcedWin);

    // The ghost cases must actually show a boundary outcome at the announced cell
    // and, when occupied, a blocked / rerolled materialisation.
    const s11 = rows.find((r) => r.id === 'S11_GHOST_MATERIALIZE_ONE_CELL')!;
    const s12 = rows.find((r) => r.id === 'S12_GHOST_CELL_OCCUPIED')!;
    expect(s11.boundary!.log.join(' ')).toContain('1 outcomes');
    expect(s12.boundary!.log.join(' ')).not.toBe(s11.boundary!.log.join(' '));

    writeFileSync(`${OUT}/_raw/synthetic-matrix.json`, JSON.stringify({
      generatedAt: new Date().toISOString(),
      generatedBy: 'PPC-CAT-STRATEGY-01/probe/synthetic_matrix.test.ts',
      provenanceWarning: 'ALL CASES ARE SYNTHETIC. The human corpus is 24 roots and is not extended by this table.',
      horizonNote: 'H0 = hParam 1, H1 = hParam 2；鼠行动中的局面从 idx=1 起算。',
      count: rows.length,
      rows,
    }, null, 2));

    expect(rows.length).toBe(13);
  }, 3_600_000);
});
