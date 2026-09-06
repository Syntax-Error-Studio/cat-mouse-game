import type { GameEngineState } from '../engine';

/**
 * Canonical key for a set of {r,c} points. Order-independent (sorted), so the
 * same set written in a different array order yields the same string. Used by
 * the transposition-table key for butterPositions / blockedTunnels /
 * tunnelExitChoices, where array order is not semantically meaningful.
 */
export function pointSetKey(
  points: { r: number; c: number }[] | undefined,
): string {
  if (!points || points.length === 0) return '';
  return points
    .map((p) => `${p.r},${p.c}`)
    .sort()
    .join('|');
}

/** True iff two {r,c} arrays describe the same set (order-independent). */
export function pointSetsEqual(
  a: { r: number; c: number }[] | undefined,
  b: { r: number; c: number }[] | undefined,
): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  if (a.length !== b.length) return false;
  const setA = new Set(a.map((p) => `${p.r},${p.c}`));
  for (const p of b) {
    if (!setA.has(`${p.r},${p.c}`)) return false;
  }
  return true;
}

/**
 * G0.4F-2A — canonical key for the pending ghost-butter list. Order-independent
 * (sorted by "r,c"), and includes each ghost's blockedMaterializations, so two
 * states with the same set of ghosts (with the same block counts) written in a
 * different array order produce the same string, while a different block count
 * changes the key.
 */
export function pendingSpawnsKey(
  spawns: { r: number; c: number; blockedMaterializations: number }[] | undefined,
): string {
  if (!spawns || spawns.length === 0) return '';
  return spawns
    .map((p) => `${p.r},${p.c}:${p.blockedMaterializations}`)
    .sort()
    .join('|');
}

/** True iff two pending-ghost lists describe the same multiset (order-independent). */
export function pendingSpawnsEqual(
  a: { r: number; c: number; blockedMaterializations: number }[] | undefined,
  b: { r: number; c: number; blockedMaterializations: number }[] | undefined,
): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  if (a.length !== b.length) return false;
  const key = (p: { r: number; c: number; blockedMaterializations: number }) => `${p.r},${p.c}:${p.blockedMaterializations}`;
  const setA = new Set(a.map(key));
  for (const p of b) {
    if (!setA.has(key(p))) return false;
  }
  return true;
}

/** Deep structural equality for the board grid (fixed-size 2D array). */
function boardsEqual(
  a: GameEngineState['board'],
  b: GameEngineState['board'],
): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let r = 0; r < a.length; r++) {
    const ra = a[r];
    const rb = b[r];
    if (ra.length !== rb.length) return false;
    for (let c = 0; c < ra.length; c++) {
      const ca = ra[c];
      const cb = rb[c];
      if (ca.type !== cb.type) return false;
      if (ca.piece !== cb.piece) return false;
      if (ca.hasButter !== cb.hasButter) return false;
    }
  }
  return true;
}

/**
 * True iff two states are equal on every GAME-AFFECTING field.
 *
 * This is the single definition of "what matters" for search equivalence.
 * It EXPLICITLY EXCLUDES `message`, `catActionLog`, and `gameEventLog`
 * (debug-only strings). It is used by:
 *   - the equivalence tests (prove the simulator == the real engine), and
 *   - no-op detection in the search (an action that changes nothing is illegal).
 */
export function gameAffectingEqual(
  a: GameEngineState,
  b: GameEngineState,
): boolean {
  if (a === b) return true;
  if (!boardsEqual(a.board, b.board)) return false;
  if (
    a.gameMode !== b.gameMode ||
    a.phase !== b.phase ||
    a.currentPlayer !== b.currentPlayer ||
    a.catPosition.r !== b.catPosition.r ||
    a.catPosition.c !== b.catPosition.c ||
    a.mousePosition.r !== b.mousePosition.r ||
    a.mousePosition.c !== b.mousePosition.c ||
    a.catMovesLeft !== b.catMovesLeft ||
    a.mouseMovesLeft !== b.mouseMovesLeft ||
    a.mouseHasButter !== b.mouseHasButter ||
    a.mouseSkillActive !== b.mouseSkillActive ||
    (a.pendingButterPlacementDebt ?? 0) !== (b.pendingButterPlacementDebt ?? 0) ||
    a.catTrapsRemaining !== b.catTrapsRemaining ||
    a.trapPosition?.r !== b.trapPosition?.r ||
    a.trapPosition?.c !== b.trapPosition?.c
  ) {
    return false;
  }
  if (!pointSetsEqual(a.butterPositions, b.butterPositions)) return false;
  if (!pendingSpawnsEqual(a.pendingButterSpawns, b.pendingButterSpawns)) return false;
  if (!pointSetsEqual(a.blockedTunnels, b.blockedTunnels)) return false;
  if (!pointSetsEqual(a.tunnelExitChoices, b.tunnelExitChoices)) return false;
  return true;
}
