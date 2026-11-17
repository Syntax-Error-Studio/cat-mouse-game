/// <reference types="node" />
/**
 * PPC-P1-CLOSURE-01 / P3-D — independent check of the GAME3 T4 terminal.
 *
 * P3-B used `applyNoMoveLoss` as the "cat wins" oracle — the same kernel the
 * engine uses, so on its own that is circular. This probe breaks the circle:
 * it takes the terminal state reached by the REAL engine on the line
 * Down,Down,Down,Left, then asks the REAL mouse transition
 * (`createEngineRuleSet().mouseStep`) for each of the four directions. If every
 * one is rejected, the mouse genuinely has no legal move and the cat win is a
 * consequence of the shipped movement rules, not of the loss kernel.
 *
 * Emits PPC-P1-CLOSURE-01/_raw/hv14_t4_terminal.json.
 */
import { test } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { createEngineRuleSet, endTurn } from '../../src/game/engine';
import type { GameEngineState } from '../../src/game/engine';
import { DIRECTIONS, GamePhase, PieceType, CellType } from '../../src/game/types';
import { restoreHardRoot, type HardRootSnapshot } from '../../src/game/ai/hardHistory';
import { applyNoMoveLoss } from '../../src/game/rules/mobility';
import { stateKey } from '../../src/game/ai/transposition';

const OUT = new URL('../_raw/hv14_t4_terminal.json', import.meta.url);
const LOG = new URL('../../ai-training/human-logs/PPC-HV14/GAME3_H1.txt', import.meta.url);
const rules = createEngineRuleSet();

function rootState(turn: number): GameEngineState {
  const lines = readFileSync(LOG, 'utf8').split(/\r?\n/);
  const starts: number[] = [];
  lines.forEach((l, i) => {
    if (/^Turn #\d+$/.test(l.trim())) starts.push(i);
  });
  const idx = starts.findIndex((s) => Number(/^Turn #(\d+)$/.exec(lines[s].trim())![1]) === turn);
  const block = lines.slice(starts[idx], idx + 1 < starts.length ? starts[idx + 1] : lines.length);
  return restoreHardRoot(
    JSON.parse(block.find((l) => l.startsWith('SNAPSHOT_JSON='))!.slice('SNAPSHOT_JSON='.length)) as HardRootSnapshot,
  );
}

test('P3-D GAME3 T4 — the stranded mouse really has no legal step', () => {
  const root = rootState(4);
  let cur = root;
  for (const k of ['ArrowDown', 'ArrowDown', 'ArrowDown', 'ArrowLeft']) {
    cur = applyNoMoveLoss(rules.catMove(cur, DIRECTIONS.find((d) => d.key === k)!));
  }
  const beforeHandoff = cur;
  const terminal = applyNoMoveLoss(
    beforeHandoff.currentPlayer === PieceType.Cat && beforeHandoff.catMovesLeft <= 0
      ? endTurn(beforeHandoff)
      : beforeHandoff,
  );

  // Neighbourhood of the mouse, straight off the board.
  const m = terminal.mousePosition;
  const neighbours = [
    { dr: -1, dc: 0, label: 'up' },
    { dr: 1, dc: 0, label: 'down' },
    { dr: 0, dc: -1, label: 'left' },
    { dr: 0, dc: 1, label: 'right' },
  ].map((d) => {
    const r = m.r + d.dr;
    const c = m.c + d.dc;
    const inBounds = r >= 0 && c >= 0 && r < terminal.config.boardSize && c < terminal.config.boardSize;
    const cell = inBounds ? terminal.board[r][c].type : 'out_of_bounds';
    return {
      dir: d.label,
      cell: `${r},${c}`,
      type: cell,
      isCatCell: terminal.catPosition.r === r && terminal.catPosition.c === c,
      pushable: cell === CellType.Box ? 'box (mouse cannot push)' : null,
    };
  });

  // The decisive check: try the REAL mouse transition in all four directions.
  const asMouseTurn: GameEngineState = {
    ...terminal,
    phase: GamePhase.Playing,
    currentPlayer: PieceType.Mouse,
    mouseMovesLeft: 4,
  };
  const baseKey = stateKey(asMouseTurn);
  const steps = DIRECTIONS.map((d) => {
    const next = rules.mouseStep(asMouseTurn, d);
    // The discriminator must be "did the MOUSE MOVE?", not "did the state key
    // change": on an illegal direction the engine leaves the mouse in place and
    // settles the no-move loss, which changes the phase (and therefore the key)
    // without producing a legal step.
    const moved = next.mousePosition.r !== asMouseTurn.mousePosition.r
      || next.mousePosition.c !== asMouseTurn.mousePosition.c;
    return {
      direction: d.key,
      mouseMoved: moved,
      keyChanged: stateKey(next) !== baseKey,
      nextPhase: next.phase,
      nextMouse: `${next.mousePosition.r},${next.mousePosition.c}`,
      nextCatMovesLeft: next.catMovesLeft,
    };
  });

  const out = {
    line: ['Down', 'Down', 'Down', 'Left'],
    terminalStateKey: stateKey(terminal),
    terminalPhase: terminal.phase,
    terminalPlayer: terminal.currentPlayer,
    terminalCat: terminal.catPosition,
    terminalMouse: terminal.mousePosition,
    catMovesLeft: terminal.catMovesLeft,
    mouseMovesLeft: terminal.mouseMovesLeft,
    mouseNeighbourhood: neighbours,
    realMouseStepsAccepted: steps,
    everyDirectionRejected: steps.every((s) => !s.mouseMoved),
    independentVerdict: steps.every((s) => !s.mouseMoved) ? 'MOUSE_HAS_NO_LEGAL_STEP' : 'MOUSE_CAN_MOVE',
  };
  writeFileSync(OUT, JSON.stringify(out, null, 2), 'utf8');
  console.log(JSON.stringify(out, null, 2));
}, 300_000);
