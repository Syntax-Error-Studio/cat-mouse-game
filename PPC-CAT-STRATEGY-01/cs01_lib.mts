/**
 * PPC-CAT-STRATEGY-01 — shared probe kernels (read-only).
 *
 * Everything here is a MEASURING instrument for the production rules. It calls
 * the real transitions (`simulateSearchAction` → engine `catMove` /
 * `mouseStepDeterministic` / `mouseSkill` / `chooseTunnelExit` / `endTurn`) and
 * never re-implements a game rule.
 */
import type { GameEngineState } from '../src/game/engine';
import type { RuleSet, SearchAction } from '../src/game/ai/searchTypes';
import { generateLegalSearchActions } from '../src/game/ai/legalActions';
import { simulateSearchAction } from '../src/game/ai/simulator';
import { stateKey } from '../src/game/ai/transposition';
import { GamePhase, PieceType } from '../src/game/types';
import { CellType, DIRECTIONS } from '../src/game/types';
import type { GameConfig } from '../src/game/config';

export type RC = { r: number; c: number };

/** Build a fully explicit state (no board generation, no Math.random). */
export function mkState(opts: {
  config: GameConfig;
  boxes?: RC[];
  piles?: RC[];
  dirts?: RC[]; // wall cells
  voids?: RC[];
  butters?: RC[];
  cat: RC;
  mouse: RC;
  catMovesLeft?: number;
  mouseMovesLeft?: number;
  mouseHasButter?: boolean;
  mouseSkillActive?: boolean;
  trap?: RC | null;
  trapsRemaining?: number;
  blockedTunnels?: RC[];
  pendingGhosts?: { r: number; c: number; blockedMaterializations: number }[];
  placementDebt?: number;
  currentPlayer?: 'cat' | 'mouse';
}): GameEngineState {
  const S = opts.config.boardSize;
  const board: any[][] = [];
  for (let r = 0; r < S; r++) {
    const row: any[] = [];
    for (let c = 0; c < S; c++) row.push({ type: CellType.Empty, hasButter: false });
    board.push(row);
  }
  const hole = opts.config.mouseHole;
  for (let dr = 0; dr < hole.size; dr++)
    for (let dc = 0; dc < hole.size; dc++)
      board[hole.r + dr][hole.c + dc] = { type: CellType.MouseHole, hasButter: false };

  const corners = opts.config.tunnelCorners && opts.config.tunnelCorners.length > 0
    ? opts.config.tunnelCorners
    : [
      { r: 0, c: 0 }, { r: 0, c: S - 1 }, { r: S - 1, c: 0 }, { r: S - 1, c: S - 1 },
    ];
  for (const t of corners) board[t.r][t.c] = { type: CellType.Tunnel, hasButter: false };
  for (const b of opts.boxes ?? []) board[b.r][b.c] = { type: CellType.Box, hasButter: false };
  for (const p of opts.piles ?? []) board[p.r][p.c] = { type: CellType.Pile, hasButter: false };
  for (const w of opts.dirts ?? []) board[w.r][w.c] = { type: CellType.Wall, hasButter: false };
  for (const v of opts.voids ?? []) board[v.r][v.c] = { type: CellType.Void, hasButter: false };

  board[opts.cat.r][opts.cat.c] = { ...board[opts.cat.r][opts.cat.c], piece: PieceType.Cat };
  board[opts.mouse.r][opts.mouse.c] = { ...board[opts.mouse.r][opts.mouse.c], piece: PieceType.Mouse };
  // NOTE: a placed trap is represented ONLY by `trapPosition` — `catPlaceTrap`
  // never rewrites the cell terrain, so we mirror that exactly.

  const carrying = opts.mouseHasButter ?? false;
  return {
    board,
    config: opts.config,
    gameMode: 'single',
    phase: GamePhase.Playing,
    currentPlayer: opts.currentPlayer === 'mouse' ? PieceType.Mouse : PieceType.Cat,
    catPosition: opts.cat,
    mousePosition: opts.mouse,
    catMovesLeft: opts.catMovesLeft ?? opts.config.catBaseMoves,
    mouseMovesLeft: opts.mouseMovesLeft ?? 0,
    butterPositions: opts.butters ?? [],
    mouseHasButter: carrying,
    mouseSkillActive: opts.mouseSkillActive ?? false,
    pendingButterSpawns: opts.pendingGhosts ?? [],
    pendingButterPlacementDebt: opts.placementDebt ?? 0,
    trapPosition: opts.trap ?? null,
    catTrapsRemaining: opts.trapsRemaining ?? 0,
    blockedTunnels: opts.blockedTunnels ?? [],
    message: '',
    tunnelExitChoices: [],
    catActionLog: [],
    gameEventLog: [],
    lastHardSearch: null,
    hardSearchHistory: [],
    hardProgressGuardMemory: null,
  };
}

export function holeCells(s: GameEngineState): RC[] {
  const out: RC[] = [];
  const { r, c, size } = s.config.mouseHole;
  for (let dr = 0; dr < size; dr++) for (let dc = 0; dc < size; dc++) out.push({ r: r + dr, c: c + dc });
  return out;
}

export function distToHole(s: GameEngineState, p: RC): number {
  return Math.min(...holeCells(s).map((h) => Math.abs(h.r - p.r) + Math.abs(h.c - p.c)));
}

export const manhattan = (a: RC, b: RC): number => Math.abs(a.r - b.r) + Math.abs(a.c - b.c);

export function planLabel(plan: SearchAction[]): string {
  return plan.map((a) => (a.type === 'catPlaceTrap' ? 'T'
    : a.type === 'catStep' ? a.direction!.key.slice(5)[0]
      : a.type === 'mouseSkill' ? 'S'
        : a.type === 'chooseTunnel' ? `X${a.r}${a.c}`
          : a.type === 'mouseStep' ? (a.direction!.key.slice(5)[0]).toLowerCase()
            : '?')).join('');
}

// ---------------------------------------------------------------------------
// One-mouse-turn win oracle (bounded, honest about its own incompleteness)
// ---------------------------------------------------------------------------
export interface WinCheck {
  win: boolean;
  witness: SearchAction[] | null;
  states: number;
  capped: boolean;
}

/**
 * Exhaustively decides "can the MOUSE (who is to move) reach MouseWins inside
 * its own turn?" over the REAL transitions. Stops at the first terminal win or
 * at the first Cat→Mouse boundary (turn over). Bounded by `cap` expanded
 * states; a capped run reports `capped=true` and its `win=false` MUST NOT be
 * read as a proof.
 */
export function mouseWinInOneTurn(root: GameEngineState, rules: RuleSet, cap = 200_000): WinCheck {
  if (root.phase === GamePhase.MouseWins) return { win: true, witness: [], states: 0, capped: false };
  if (root.phase !== GamePhase.Playing || root.currentPlayer !== PieceType.Mouse) {
    return { win: false, witness: null, states: 0, capped: false };
  }
  const queue: { state: GameEngineState; witness: SearchAction[] }[] = [{ state: root, witness: [] }];
  const seen = new Set<string>();
  let states = 0;
  let head = 0;
  while (head < queue.length) {
    if (states >= cap) return { win: false, witness: null, states, capped: true };
    const cur = queue[head++];
    const k = stateKey(cur.state);
    if (seen.has(k)) continue;
    seen.add(k);
    states++;
    for (const action of generateLegalSearchActions(cur.state, rules)) {
      const tr = simulateSearchAction(cur.state, action, rules);
      const outs = tr.kind === 'chance' ? tr.outcomes.map((o) => o.state) : [tr.state];
      for (const next of outs) {
        if (next.phase === GamePhase.MouseWins) {
          return { win: true, witness: [...cur.witness, action], states, capped: false };
        }
        if (next.phase !== GamePhase.Playing) continue;
        if (next.currentPlayer !== PieceType.Mouse) continue; // turn ended, no win
        queue.push({ state: next, witness: [...cur.witness, action] });
      }
    }
  }
  return { win: false, witness: null, states, capped: false };
}

// ---------------------------------------------------------------------------
// Distinct cat full turns (one real cat turn → mouse-to-move boundary states)
// ---------------------------------------------------------------------------
export interface CatTurnBoundary {
  plan: SearchAction[];
  state: GameEngineState;
}

/**
 * Enumerate the DISTINCT boundary states reachable by one full cat turn.
 * Deduped by `stateKey` (we only need the reachable set, not path counts).
 * Returns an explicit `capped` flag when the node budget was hit.
 */
export function enumerateCatTurnBoundaries(
  root: GameEngineState,
  rules: RuleSet,
  cap = 40_000,
): { boundaries: CatTurnBoundary[]; expanded: number; capped: boolean; terminals: number } {
  const out: CatTurnBoundary[] = [];
  const seenBoundary = new Set<string>();
  const queue: { state: GameEngineState; plan: SearchAction[] }[] = [{ state: root, plan: [] }];
  const seen = new Set<string>();
  let expanded = 0;
  let terminals = 0;
  let head = 0;
  while (head < queue.length) {
    if (expanded >= cap) return { boundaries: out, expanded, capped: true, terminals };
    const cur = queue[head++];
    if (cur.state.phase !== GamePhase.Playing) continue;
    if (cur.state.currentPlayer !== PieceType.Cat) continue;
    const k = stateKey(cur.state);
    if (seen.has(k)) continue;
    seen.add(k);
    expanded++;
    const actions = generateLegalSearchActions(cur.state, rules);
    if (actions.length === 0) continue;
    for (const action of actions) {
      const tr = simulateSearchAction(cur.state, action, rules);
      const outs = tr.kind === 'chance' ? tr.outcomes.map((o) => o.state) : [tr.state];
      for (const next of outs) {
        if (next.phase === GamePhase.CatWins || next.phase === GamePhase.MouseWins) { terminals++; continue; }
        if (next.phase !== GamePhase.Playing) continue;
        if (next.currentPlayer !== PieceType.Cat) {
          const bk = stateKey(next);
          if (!seenBoundary.has(bk)) {
            seenBoundary.add(bk);
            out.push({ plan: [...cur.plan, action], state: next });
          }
          continue;
        }
        queue.push({ state: next, plan: [...cur.plan, action] });
      }
    }
  }
  return { boundaries: out, expanded, capped: false, terminals };
}

/**
 * Apply one cat full-turn plan with the REAL transitions; return EVERY resulting
 * boundary state. A single cat step is deterministic, but the LAST step crosses
 * the CAT→MOUSE ghost boundary, which the simulator reports as a CHANCE node
 * (usually with exactly one deterministic outcome, since a materializing ghost
 * needs no new random position).
 */
export function playCatPlan(
  root: GameEngineState,
  plan: SearchAction[],
  rules: RuleSet,
): { states: GameEngineState[]; ok: boolean; why: string; chanceBranches: number } {
  let frontier: GameEngineState[] = [root];
  let chanceBranches = 0;
  for (const a of plan) {
    const next: GameEngineState[] = [];
    for (const s of frontier) {
      if (s.phase !== GamePhase.Playing || s.currentPlayer !== PieceType.Cat) continue;
      const tr = simulateSearchAction(s, a, rules);
      if (tr.kind === 'chance') {
        chanceBranches = Math.max(chanceBranches, tr.outcomes.length);
        for (const o of tr.outcomes) next.push(o.state);
        continue;
      }
      if (stateKey(tr.state) === stateKey(s) && a.type !== 'catPlaceTrap') {
        return { states: [], ok: false, why: `illegal/no-op ${a.type}`, chanceBranches };
      }
      next.push(tr.state);
    }
    if (next.length === 0) return { states: [], ok: false, why: 'no successor', chanceBranches };
    frontier = next;
  }
  // finish the turn if the cat still has moves left
  let guard = 0;
  while (guard++ < 8 && frontier.some((s) => s.phase === GamePhase.Playing
    && s.currentPlayer === PieceType.Cat && s.catMovesLeft > 0)) {
    const next: GameEngineState[] = [];
    for (const s of frontier) {
      if (!(s.phase === GamePhase.Playing && s.currentPlayer === PieceType.Cat && s.catMovesLeft > 0)) {
        next.push(s);
        continue;
      }
      let progressed = false;
      for (const d of DIRECTIONS) {
        const tr = simulateSearchAction(s, { type: 'catStep', direction: d }, rules);
        if (tr.kind === 'chance') {
          chanceBranches = Math.max(chanceBranches, tr.outcomes.length);
          for (const o of tr.outcomes) next.push(o.state);
          progressed = true;
          break;
        }
        if (stateKey(tr.state) !== stateKey(s)) { next.push(tr.state); progressed = true; break; }
      }
      if (!progressed) next.push(s);
    }
    frontier = next;
  }
  return { states: frontier, ok: true, why: '', chanceBranches };
}

/** Shallow deep-equality of the two states' evaluation breakdowns. */
export function evalJson(s: GameEngineState): string {
  return JSON.stringify(s);
}
