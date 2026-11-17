/**
 * PPC-MCTS-01 — REAL-ENGINE plan replay.
 *
 * The search simulator is never accepted as execution proof. Every emitted cat
 * turn plan is applied, action by action, through the real engine functions
 * `catMove` / `catPlaceTrap` on a fresh snapshot of the root state. The replay
 * also enforces that the plan contains only cat actions, that every step is
 * effective, and that the walk ends inside the same cat turn (or at a terminal).
 */
import type { GameEngineState } from '../../src/game/engine';
import { catMove, catPlaceTrap } from '../../src/game/engine';
import type { SearchAction } from '../../src/game/ai/searchTypes';
import { gameAffectingEqual } from '../../src/game/ai/stateCompare';
import { GamePhase, PieceType } from '../../src/game/types';

export interface ReplayStep {
  action: SearchAction;
  label: string;
  effective: boolean;
  catMovesLeft: number;
  phase: string;
  currentPlayer: string;
}

export interface ReplayResult {
  ok: boolean;
  planLength: number;
  steps: ReplayStep[];
  rejectedAt: number;
  rejectedReason: string | null;
  endedTurn: boolean;
  terminal: boolean;
  catMovesLeft: number;
  phase: string;
  currentPlayer: string;
  fullTurnConsumed: boolean;
  finalState: GameEngineState;
}

export function actionLabel(a: SearchAction): string {
  switch (a.type) {
    case 'catStep': return `C${a.direction.key.replace('Arrow', '')}`;
    case 'catPlaceTrap': return 'T';
    case 'mouseStep': return `M${a.direction.key.replace('Arrow', '')}`;
    case 'mouseSkill': return 'S';
    case 'chooseTunnel': return `X${a.r},${a.c}`;
  }
}

export function planLabel(plan: SearchAction[]): string {
  return plan.map(actionLabel).join('');
}

export function replayPlanWithEngine(root: GameEngineState, plan: SearchAction[]): ReplayResult {
  let s = structuredClone(root);
  const steps: ReplayStep[] = [];
  const fail = (i: number, reason: string): ReplayResult => ({
    ok: false,
    planLength: plan.length,
    steps,
    rejectedAt: i,
    rejectedReason: reason,
    endedTurn: s.currentPlayer !== PieceType.Cat || s.phase !== GamePhase.Playing,
    terminal: s.phase === GamePhase.CatWins || s.phase === GamePhase.MouseWins,
    catMovesLeft: s.catMovesLeft,
    phase: String(s.phase),
    currentPlayer: String(s.currentPlayer),
    fullTurnConsumed: false,
    finalState: s,
  });

  for (let i = 0; i < plan.length; i++) {
    const action = plan[i];
    if (action.type !== 'catStep' && action.type !== 'catPlaceTrap') {
      return fail(i, `non-cat action in plan: ${actionLabel(action)}`);
    }
    if (s.phase !== GamePhase.Playing) return fail(i, `phase ${s.phase} before action`);
    if (s.currentPlayer !== PieceType.Cat) return fail(i, `actor ${s.currentPlayer} before action (turn already handed off)`);
    const before = s;
    s = action.type === 'catStep' ? catMove(s, action.direction) : catPlaceTrap(s);
    const effective = !gameAffectingEqual(before, s);
    steps.push({
      action,
      label: actionLabel(action),
      effective,
      catMovesLeft: s.catMovesLeft,
      phase: String(s.phase),
      currentPlayer: String(s.currentPlayer),
    });
    if (!effective) return fail(i, 'engine rejected action (no game-affecting change)');
  }

  const terminal = s.phase === GamePhase.CatWins || s.phase === GamePhase.MouseWins;
  const endedTurn = s.currentPlayer !== PieceType.Cat || s.phase !== GamePhase.Playing;
  const fullTurnConsumed = terminal || (s.phase === GamePhase.Playing && s.currentPlayer === PieceType.Cat && s.catMovesLeft <= 0);
  return {
    ok: true,
    planLength: plan.length,
    steps,
    rejectedAt: -1,
    rejectedReason: null,
    endedTurn,
    terminal,
    catMovesLeft: s.catMovesLeft,
    phase: String(s.phase),
    currentPlayer: String(s.currentPlayer),
    fullTurnConsumed,
    finalState: s,
  };
}
