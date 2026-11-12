/// <reference types="node" />
/**
 * PPC-HV-2 §2/§3 — human-game root provenance + board reconstruction.
 *
 * These are the four roots the task book fixes for this round (GAME2 T1,
 * GAME3 T1, GAME6 T1, GAME6 T2). Every root is restored with the project's
 * existing snapshot loader (`restoreHardRoot`) and then RE-HASHED: the
 * stateKey must equal the STATE_KEY line the player's own log printed, and the
 * key fields must equal the `cat=` / `mouse=` / `butter=` / `trap=` lines.
 * No hand-made stand-in state is ever substituted (loader contract).
 */
import { expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
import type { GameEngineState } from '../../engine';
import { CellType } from '../../types';
import { restoreHardRoot, type HardRootSnapshot } from '../hardHistory';
import { stateKey } from '../transposition';

interface PinnedRoot {
  id: string;
  stateKey: string;
  snapshot: HardRootSnapshot;
  loggedCat: string;
  loggedMouse: string;
  loggedButter: string;
  loggedTrap: string;
  loggedPlan: string;
}

function loadPinned(): PinnedRoot[] {
  const raw = readFileSync(
    new URL('../../../../ai-training/human-logs/PPC-HV2/roots.json', import.meta.url),
    'utf8',
  ) as string;
  return JSON.parse(raw) as PinnedRoot[];
}

// ===========================================================================
// HV2-P1 — provenance: the snapshot re-hashes to the log's own STATE_KEY.
// ===========================================================================
test('HV2-P1. every pinned human root restores to its logged stateKey', () => {
  const roots = loadPinned();
  expect(roots.length).toBe(4);
  for (const r of roots) {
    const s = restoreHardRoot(r.snapshot);
    expect(stateKey(s), `${r.id} stateKey round-trip`).toBe(r.stateKey);
  }
});

// ===========================================================================
// HV2-P2 — key fields agree with the printed log lines.
// ===========================================================================
// The log prints coordinates parenthesised (`cat=(1,1)`); the restored state is
// compared as `r,c`, so normalise the captured line rather than the value.
const bare = (s: string): string => s.replace(/[()]/g, '');

test('HV2-P2. restored key fields match the human log lines', () => {
  for (const r of loadPinned()) {
    const s = restoreHardRoot(r.snapshot);
    expect(`${s.catPosition.r},${s.catPosition.c}`, `${r.id} cat`).toBe(bare(r.loggedCat));
    expect(`${s.mousePosition.r},${s.mousePosition.c}`, `${r.id} mouse`).toBe(bare(r.loggedMouse));
    expect(`butter=${s.mouseHasButter} skill=${s.mouseSkillActive}`, `${r.id} butter`).toBe(r.loggedButter);
    expect(
      `trap=${s.trapPosition ? `${s.trapPosition.r},${s.trapPosition.c}` : 'none'} remain=${s.catTrapsRemaining}`,
      `${r.id} trap`,
    ).toBe(bare(r.loggedTrap));
    expect(s.currentPlayer, `${r.id} to move`).toBe('cat');
    expect(s.phase, `${r.id} phase`).toBe('playing');
    expect(s.config.difficulty, `${r.id} difficulty`).toBe('hard');
    expect(s.catMovesLeft, `${r.id} cat moves`).toBe(4);
  }
});

// ===========================================================================
// HV2-P3 — reconstruction report (board, hole gate, butter, distances).
// Printed, not asserted: this is the evidence table the arms comparison uses.
// ===========================================================================
test('HV2-P3. reconstruct and report the four roots', () => {
  for (const r of loadPinned()) {
    const s = restoreHardRoot(r.snapshot) as GameEngineState;
    const hole = s.config.mouseHole;
    const gate = [
      { r: hole.r, c: hole.c - 1 },
      { r: hole.r - 1, c: hole.c },
      { r: hole.r + hole.size, c: hole.c },
      { r: hole.r, c: hole.c + hole.size },
    ];
    const md = (a: { r: number; c: number }, b: { r: number; c: number }) => Math.abs(a.r - b.r) + Math.abs(a.c - b.c);
    const rows: string[] = [];
    for (let rr = 0; rr < s.config.boardSize; rr++) {
      let line = '';
      for (let cc = 0; cc < s.config.boardSize; cc++) {
        const cell = s.board[rr][cc];
        line += cell.piece === 'cat' ? 'C'
          : cell.piece === 'mouse' ? 'M'
            : cell.type === CellType.MouseHole ? 'H'
              : cell.type === CellType.Tunnel ? 'T'
                : cell.type === CellType.Wall ? '#'
                  : cell.type === CellType.Box ? 'B'
                    : cell.type === CellType.Pile ? 'p'
                      : cell.hasButter ? 'b' : '.';
      }
      rows.push(line);
    }
    const catToGate = Math.min(...gate.map((g) => md(s.catPosition, g)));
    const mouseToGate = Math.min(...gate.map((g) => md(s.mousePosition, g)));
    console.log(
      `\n===== ${r.id}  plan=${r.loggedPlan}\n` + rows.join('\n') + '\n'
      + `hole=(${hole.r},${hole.c})x${hole.size} butter=[${s.butterPositions.map((b) => `${b.r},${b.c}`).join(' ')}]`
      + ` pendingSpawn=${s.pendingButterSpawns.length} debt=${s.pendingButterPlacementDebt}`
      + `\ncat=${s.catPosition.r},${s.catPosition.c} mouse=${s.mousePosition.r},${s.mousePosition.c}`
      + ` carrying=${s.mouseHasButter} trap=${s.trapPosition ? `${s.trapPosition.r},${s.trapPosition.c}` : 'none'}/${s.catTrapsRemaining}`
      + `\nmanhattan cat->mouse=${md(s.catPosition, s.mousePosition)}`
      + ` catGate=${catToGate} mouseGate=${mouseToGate} margin(cat-mouse)=${catToGate - mouseToGate}`,
    );
  }
  expect(loadPinned().length).toBe(4);
});
