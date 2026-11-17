/// <reference types="node" />
/** Pure presentation / identity helpers for the seal probes (no rule logic). */
import type { GameEngineState } from '../../src/game/engine';

export function summarize(s: GameEngineState) {
  return {
    phase: s.phase,
    currentPlayer: s.currentPlayer,
    cat: `${s.catPosition.r},${s.catPosition.c}`,
    mouse: `${s.mousePosition.r},${s.mousePosition.c}`,
    catMovesLeft: s.catMovesLeft,
    mouseMovesLeft: s.mouseMovesLeft,
    mouseHasButter: s.mouseHasButter,
    mouseSkillActive: s.mouseSkillActive,
    butterPositions: s.butterPositions.map((p) => `${p.r},${p.c}`),
    pendingButterSpawns: (s.pendingButterSpawns ?? []).map((p) => `${p.r},${p.c}:${p.blockedMaterializations}`),
    pendingButterPlacementDebt: s.pendingButterPlacementDebt ?? 0,
    trapPosition: s.trapPosition ? `${s.trapPosition.r},${s.trapPosition.c}` : null,
    catTrapsRemaining: s.catTrapsRemaining,
    blockedTunnels: s.blockedTunnels.map((p) => `${p.r},${p.c}`),
  };
}

export function renderBoard(s: GameEngineState): string[] {
  const lines: string[] = [];
  for (let r = 0; r < s.board.length; r++) {
    let line = '';
    for (let c = 0; c < s.board[r].length; c++) {
      const cell = s.board[r][c];
      let ch = '.';
      if (cell.type === 'box') ch = 'X';
      else if (cell.type === 'pile') ch = 'P';
      else if (cell.type === 'tunnel') ch = 'T';
      else if (cell.type === 'mouse_hole') ch = 'H';
      else if (cell.type === 'void') ch = 'V';
      else if (cell.type === 'wall') ch = 'W';
      if (s.catPosition.r === r && s.catPosition.c === c) ch = 'C';
      if (s.mousePosition.r === r && s.mousePosition.c === c) ch = 'M';
      if (s.butterPositions.some((p) => p.r === r && p.c === c)) ch = 'b';
      if ((s.pendingButterSpawns ?? []).some((p) => p.r === r && p.c === c)) ch = 'g';
      if (s.trapPosition && s.trapPosition.r === r && s.trapPosition.c === c) ch = 't';
      line += ch;
    }
    lines.push(`${String(r).padStart(2)} ${line}`);
  }
  return lines;
}

export function canonicalJson(value: unknown): string {
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') {
      const src = v as Record<string, unknown>;
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(src).sort()) out[k] = walk(src[k]);
      return out;
    }
    return v;
  };
  return JSON.stringify(walk(value));
}