/**
 * PPC-P1-PLAN-01 — the ONE legal upper bound on a cat-turn plan's action count.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * Every plan extractor used to cap its output at a hard-coded `maxLength = 8`.
 * A cat turn is bounded by its MOVE budget, not by a constant: `catPlaceTrap`
 * costs no move, so a legal plan can carry more actions than `catBaseMoves`.
 * With the default `catBaseMoves = 4` the old cap never bound; from
 * `catBaseMoves = 6` on it silently truncated real plans (see
 * `PPC-P1-PLAN-01/BASELINE_TRUNCATION_WITNESS.json`).
 *
 * Because the cap exists in five different functions, patching them with five
 * different numbers would just move the same defect elsewhere. Instead there is
 * exactly ONE derivation, and every extractor defaults to it.
 *
 * THE BOUND (proof in `PPC-P1-PLAN-01/PLAN_ACTION_BOUND_PROOF.md`)
 * ---------------------------------------------------------------
 * Let M = the root state's remaining cat move budget (`catMovesLeft`).
 * M is a NON-NEGATIVE SAFE INTEGER — that is the domain of the proof, and of the
 * game (`hasCertifiableCatMoveBudget`). A state outside that domain has no bound:
 * every extractor that would consume this number fails closed instead (see
 * `PPC-P1-CLOSURE-FIX-01/INPUT_DOMAIN_DECISION.md`).
 *
 * PPC-P1-CHECKPOINT-01: the domain has a second half. `B(M)` is 1.5·M, so a safe
 * `M` can still yield a bound that is not a safe integer. The extraction
 * capacity must therefore be exactly representable too — see
 * `MAX_CERTIFIABLE_CAT_MOVE_BUDGET` below.
 *
 *   1. A `catStep` always consumes exactly one move. `catMove` either rejects
 *      the step (returns the state unchanged — the legal-action filter drops it,
 *      see `legalActions.isEffective`) or returns `catMovesLeft - 1` on both its
 *      normal and its box-push branch. So a turn can hold at most M steps.
 *   2. `catPlaceTrap` consumes NO move, but it requires `trapPosition === null`
 *      and leaves the trap on the board. Two placements therefore cannot be
 *      adjacent in the plan: between them the trap must be collected, and the
 *      only way to collect is to STEP onto the trap cell (`catMove`'s
 *      `steppedOnTrap` branch).
 *   3. After a placement the cat occupies the trap cell, so re-entering it costs
 *      at least two steps (leave, come back). Hence at most `1 + floor(M/2)`
 *      placements.
 *
 *   ⇒ actions ≤ M + 1 + floor(M/2),   with M = 0 giving 1 (a lone placement).
 *
 * For M = 1..9 that is 2, 4, 5, 7, 8, 10, 11, 13, 14 — strictly above
 * `catBaseMoves`, and equal to 7 at the production default of 4 moves, which is
 * why the old constant of 8 never truncated a default-map turn.
 *
 * Two edge cases are covered by the proof rather than by a fudge factor:
 *   - a state whose cat has no legal spatial move is settled by RULE-A before
 *     any action applies, and that settling action ends the turn, so it can
 *     only ever be the plan's last action (a one-action plan);
 *   - the bound is derived from the ROOT of the extraction, so a turn that is
 *     resumed mid-way (fewer moves left) gets a smaller, still-tight bound.
 *
 * TERMINATION is NOT the cap's job: the state space of one cat turn is finite
 * because `stateKey` includes `catMovesLeft`, `catTrapsRemaining` and
 * `trapPosition`, all three of which move monotonically during a turn. The
 * extractors' existing `stateKey` path guards are what make them terminate; the
 * cap below is a proven non-binding slack on top of that, which is exactly what
 * makes the DP memo sound (see `planQuality.extractDp`).
 */
import type { GameEngineState } from '../engine';

/**
 * The largest cat move budget for which this bound is still an EXACTLY
 * representable integer.
 *
 * `M` being a safe integer does not make `B(M)` one: `B` is one and a half times
 * `M`. The break point is exact and derived, not chosen —
 *
 *   M = 6004799503160660 (even) ⇒ B = 3/2·M + 1 = 9007199254740991 = MAX_SAFE_INTEGER
 *   M = 6004799503160661 (odd)  ⇒ B = 9007199254740992 = 2^53          — unsafe
 *
 * and two steps further the float sum is not even the value the proof promises
 * (M = 6004799503160663 has exact B = 9007199254740995, which rounds up to
 * 9007199254740996). Solving `M + 1 + floor(M/2) <= MAX_SAFE_INTEGER` for the
 * even branch gives `M = (MAX_SAFE_INTEGER − 1)/3 · 2`, which is that constant.
 *
 * A cap at any smaller number would be a gameplay rule invented by an
 * implementation detail, so none is applied: everything up to the last
 * representable bound stays legal and behaves exactly as before.
 */
export const MAX_CERTIFIABLE_CAT_MOVE_BUDGET = ((Number.MAX_SAFE_INTEGER - 1) / 3) * 2;

/**
 * Why `raw` cannot serve as a cat move budget, or `null` if it can.
 *
 * Kept separate from the boolean so the two failure families report themselves
 * accurately: "not a non-negative safe integer" is a different defect from
 * "a safe integer whose derived plan bound is not representable".
 */
export function catMoveBudgetRejectionReason(raw: number): string | null {
  if (!Number.isSafeInteger(raw) || raw < 0) {
    return `catMovesLeft=${String(raw)} is not a non-negative safe integer`;
  }
  if (raw > MAX_CERTIFIABLE_CAT_MOVE_BUDGET) {
    return `catMovesLeft=${String(raw)} exceeds the largest budget `
      + `${MAX_CERTIFIABLE_CAT_MOVE_BUDGET} whose plan bound is still an exact integer`;
  }
  return null;
}

/**
 * PPC-P1-CLOSURE-FIX-01 — is `catMovesLeft` a value a cat turn can be certified
 * against?
 *
 * A cat move is a discrete, unit-cost action: the budget is a COUNT of remaining
 * steps, so only a non-negative safe integer can describe a turn. Every other
 * value is a corrupted state, and each one is broken in its own way:
 *   - `2.5`  — `catMove` allows a third step (2.5 → 1.5 → 0.5 → −0.5) while a
 *              floored bound only budgets for two, so plan length and move count
 *              disagree;
 *   - `NaN`  — `NaN <= 0` is false, so the turn NEVER hands off and the residual
 *              check `catMovesLeft > 0` is also false: a truncated one-action
 *              plan can be certified COMPLETE;
 *   - `±Infinity` — an unbounded turn;
 *   - negative — a turn that already ended but is still labelled Playing.
 *
 * PPC-P1-CHECKPOINT-01 adds the REPRESENTABILITY half: the budget must also be
 * small enough that `maxCatTurnPlanActions` returns an exact safe integer (see
 * `MAX_CERTIFIABLE_CAT_MOVE_BUDGET`). An unsafe bound is not a "very large cap",
 * it is a cap whose numeric identity has been lost, and every extractor feeds it
 * into a recursion capacity.
 *
 * `catMovesLeft === 0` is NOT invalid: it is the legitimate turn-boundary value
 * (the budget is simply spent). It only yields a zero-move bound.
 */
export function hasCertifiableCatMoveBudget(state: GameEngineState): boolean {
  return catMoveBudgetRejectionReason(state.catMovesLeft) === null;
}

/**
 * The root's remaining cat move budget, normalised.
 *
 * A non-certifiable budget (`hasCertifiableCatMoveBudget === false`) answers
 * "how many moves may be spent" with 0 — never with a floored guess. Flooring
 * would silently turn `2.5` into a plausible 2-move budget, which is exactly the
 * misfiling this contract forbids; the extractors that consume this value fail
 * closed instead of certifying a plan built on it.
 */
export function catTurnMoveBudget(state: GameEngineState): number {
  return hasCertifiableCatMoveBudget(state) ? state.catMovesLeft : 0;
}

/**
 * The maximum number of cat actions a legal plan rooted at `state` can contain:
 * `M` steps + at most `1 + floor(M/2)` zero-cost trap placements.
 *
 * Used as the default `maxLength` of EVERY plan extractor. Never pass a
 * constant instead: a constant is what this round removed.
 */
export function maxCatTurnPlanActions(state: GameEngineState): number {
  const moves = catTurnMoveBudget(state);
  return moves + 1 + Math.floor(moves / 2);
}
