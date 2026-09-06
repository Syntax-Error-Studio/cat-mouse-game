/**
 * G0.4F-2B-1.8 — M3-lite Progress-Guard HUMAN-VALIDATION LOG formatting.
 *
 * PURE string helpers only (no React, no engine, no search, no config
 * mutation). They are the single source for how the Progress-Guard
 * diagnostics appear in the copied debug text:
 *   - header line      PROGRESS_GUARD=ON/OFF          (task §2)
 *   - last-turn block  [PROGRESS_GUARD]  full names   (task §3)
 *   - history per-turn PROGRESS_GUARD:   compact names (task §4)
 *   - §7 debug-only memory-missing sanity predicate
 *
 * `ProgressGuardLogFields` mirrors `ProgressGuardDebug` (hardTurnPlanner) and
 * `ProgressGuardDiag` (progressGuard) exactly (same 16 fields), so either can
 * be passed structurally. No field here feeds back into AI behavior.
 */

/** Structural mirror of ProgressGuardDebug / ProgressGuardDiag (16 fields). */
export interface ProgressGuardLogFields {
  enabled: boolean;
  eligible: boolean;
  previousNoProgressLoop: boolean;
  currentNoProgressLoop: boolean;
  signatureMatch: boolean;
  mouseTurnObserved: boolean;
  triggered: boolean;
  previousCompletedDepth: number | null;
  previousCompletedPlan: string;
  originalPlan: string;
  rescuePlan: string;
  exactImmediateMouseWins: number;
  rescueProbeStatus: string | null;
  rescueApplied: boolean;
  abortReason: string;
  guardMs: number;
}

/** §2: one-line header flag. MUST be called with HARD_PROGRESS_GUARD_CONFIG.enabled. */
export function progressGuardHeaderLine(enabled: boolean): string {
  return `PROGRESS_GUARD=${enabled ? 'ON' : 'OFF'}`;
}

/** §3: last-search block (full names) or `(none)` when absent. */
export function formatProgressGuardBlock(pg: ProgressGuardLogFields | null | undefined): string {
  if (!pg) return '[PROGRESS_GUARD]\n(none)';
  return [
    '[PROGRESS_GUARD]',
    `enabled=${pg.enabled}`,
    `eligible=${pg.eligible}`,
    `previousNoProgressLoop=${pg.previousNoProgressLoop}`,
    `currentNoProgressLoop=${pg.currentNoProgressLoop}`,
    `signatureMatch=${pg.signatureMatch}`,
    `mouseTurnObserved=${pg.mouseTurnObserved}`,
    `triggered=${pg.triggered}`,
    `previousCompletedDepth=${pg.previousCompletedDepth ?? 'null'}`,
    `previousCompletedPlan=${pg.previousCompletedPlan || '(empty)'}`,
    `originalPlan=${pg.originalPlan || '(empty)'}`,
    `rescuePlan=${pg.rescuePlan || '(empty)'}`,
    `exactImmediateMouseWins=${pg.exactImmediateMouseWins}`,
    `rescueProbeStatus=${pg.rescueProbeStatus ?? 'null'}`,
    `rescueApplied=${pg.rescueApplied}`,
    `abortReason=${pg.abortReason || 'none'}`,
    `guardMs=${typeof pg.guardMs === 'number' ? pg.guardMs.toFixed(1) : pg.guardMs}`,
  ].join('\n');
}

/** §4: per-turn HARD_SEARCH_HISTORY compact lines ([] when absent). */
export function formatHistoryProgressGuard(pg: ProgressGuardLogFields | null | undefined): string[] {
  if (!pg) return [];
  return [
    'PROGRESS_GUARD:',
    `  enabled=${pg.enabled}`,
    `  eligible=${pg.eligible}`,
    `  prevNoProgress=${pg.previousNoProgressLoop}`,
    `  currentNoProgress=${pg.currentNoProgressLoop}`,
    `  sigMatch=${pg.signatureMatch}`,
    `  mouseObserved=${pg.mouseTurnObserved}`,
    `  triggered=${pg.triggered}`,
    `  previousDepth=${pg.previousCompletedDepth ?? 'null'}`,
    `  previousPlan=${pg.previousCompletedPlan || '(empty)'}`,
    `  original=${pg.originalPlan || '(empty)'}`,
    `  rescue=${pg.rescuePlan || '(empty)'}`,
    `  mouseWins=${pg.exactImmediateMouseWins}`,
    `  probe=${pg.rescueProbeStatus ?? 'null'}`,
    `  applied=${pg.rescueApplied}`,
    `  abort=${pg.abortReason || 'none'}`,
  ];
}

/** §7: debug-only sanity — guard ON ∧ ≥1 clean Hard cat turn ∧ no memory. */
export function progressGuardMemoryMissing(enabled: boolean, hasCleanHardTurn: boolean, memory: unknown): boolean {
  return enabled && hasCleanHardTurn && memory == null;
}