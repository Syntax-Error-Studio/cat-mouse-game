// ============================================================
// 危险区域辅助 — the opt-in switch, and where its picture comes from.
//
// Two jobs kept deliberately apart:
//   * the switch is pure presentation state (localStorage, no engine meaning,
//     shared by every mounted board through one store);
//   * the region itself comes from game/threat/catThreatMap, which answers on
//     the REAL GameEngineState. So single / local-dual / online all show the
//     same answer, and the UI never grows its own distance heuristic.
// ============================================================

import { useDeferredValue, useMemo, useSyncExternalStore } from 'react';
import { GamePhase } from '../game/types';
import { getCatThreatMap } from '../game/threat/catThreatMap';
import type { CatThreatMap, ThreatInputState } from '../game/threat/catThreatMap';

const STORE_KEY = 'catmouse.dangerAssist';

const listeners = new Set<() => void>();

function readStored(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return window.localStorage.getItem(STORE_KEY) === '1';
  } catch {
    return false; // 隐私模式：本次会话内依然可开关，只是不留到下一局
  }
}

let enabled = readStored();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** Off by default: the aid is opt-in, and every screen shares this one value. */
export function useDangerAssistEnabled(): boolean {
  return useSyncExternalStore(subscribe, () => enabled, () => false);
}

export function setDangerAssistEnabled(next: boolean): void {
  if (enabled === next) return;
  enabled = next;
  try {
    window.localStorage.setItem(STORE_KEY, next ? '1' : '0');
  } catch {
    // storage refused; the in-memory value still drives this session
  }
  for (const listener of listeners) listener();
}

export function toggleDangerAssist(): void {
  setDangerAssistEnabled(!enabled);
}

/**
 * The danger region for the state the caller holds, or `null` when the aid is
 * off or the game is over.
 *
 * Memoised on state identity: the engine is pure and returns a fresh object for
 * every accepted action, so this runs once per action — not once per render.
 *
 * The region is READ off a deferred copy of that state on purpose. It is a
 * derived picture, while the piece position is the player's own feedback: the
 * render that moves a stone must not wait on a breadth-first search, and may
 * therefore show last frame's region for one frame. Online play makes the gap
 * real — there the state changes the instant input is predicted, hundreds of
 * milliseconds before the server agrees.
 */
export function useCatThreatMap(state: ThreatInputState | null): CatThreatMap | null {
  const on = useDangerAssistEnabled();
  const settled = useDeferredValue(state);
  return useMemo(() => {
    if (!on || !settled) return null;
    if (settled.phase === GamePhase.CatWins || settled.phase === GamePhase.MouseWins) return null;
    return getCatThreatMap(settled);
  }, [on, settled]);
}
