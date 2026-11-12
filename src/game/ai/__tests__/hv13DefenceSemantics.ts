import type { GameEngineState } from '../../engine';
import { GamePhase, PieceType } from '../../types';
import { stateKey } from '../transposition';
import {
  type CausalEvidence,
  type MouseTurnEnd,
  type PlanResponseReport,
  type ResponseDefence,
  defenceClassOf,
  enumerateMouseTurn,
  refutationScopeOf,
} from './hv12MouseResponses';
import { enumerateCatTurnExact, handOffToMouse, rc, replayCatPlan } from './hv5ForcedLineAuditor';

/**
 * HV-13 causal counterfactual over ONE cat turn.
 *
 * The question is existential, not universal: does some OTHER complete legal cat
 * plan from the same cat-turn start let the mouse enter the hole in its next turn,
 * while the chosen plan prevents it? Both arms are handed to the mouse through the
 * production `handOffToMouse` and enumerated with the real `mouseStepDeterministic`
 * turn, under the same chance condition.
 *
 * Completeness is recorded separately. It matters for "no alternative exists"
 * claims, not for a positive alternative witness.
 */
export interface CausalCaps {
  catNodeCap: number;
  mouseNodeCap: number;
  /** Bound on distinct cat end states handed to the mouse. */
  maxPlans: number;
}

export const LIGHT_CAUSAL_CAPS: CausalCaps = {
  catNodeCap: 20_000,
  mouseNodeCap: 20_000,
  maxPlans: 400,
};

export interface CausalPlanCheck {
  plan: string;
  cell: string;
  endKey: string;
  mouseWin: { steps: number; actions: string[] } | null;
  mouseTruncated: boolean;
}

const mouseWinAfter = (
  end: GameEngineState,
  mouseNodeCap: number,
): { win: { steps: number; actions: string[] } | null; truncated: boolean } => {
  const mt = enumerateMouseTurn(handOffToMouse(end, true), { nodeCap: mouseNodeCap });
  const wins = mt.ends.filter((e) => e.terminal === 'MOUSE_WINS');
  const win = wins.length === 0
    ? null
    : [...wins].sort((a, b) => a.steps - b.steps || a.actions.join('').localeCompare(b.actions.join('')))[0]!;
  return { win: win === null ? null : { steps: win.steps, actions: win.actions }, truncated: mt.truncated };
};

const NOTHING: CausalEvidence = {
  chosenPlanHolds: false,
  plansChecked: 0,
  alternativeWinPlan: null,
  complete: false,
  chancePinned: false,
  note: 'causal scan not applicable',
};

export function causalScan(
  mouseEnd: MouseTurnEnd,
  chosenPlan: string | null,
  caps: CausalCaps = LIGHT_CAUSAL_CAPS,
): CausalEvidence {
  const start = mouseEnd.state;
  if (mouseEnd.terminal !== null || mouseEnd.stalled) {
    return { ...NOTHING, note: 'the response is terminal or stalled: there is no cat turn to scan' };
  }
  if (start.phase !== GamePhase.Playing || start.currentPlayer !== PieceType.Cat) {
    return { ...NOTHING, note: `not a cat-turn start (phase=${start.phase}, player=${start.currentPlayer})` };
  }
  // The ghost materializes at the CAT->MOUSE boundary; both arms run with it cleared,
  // so a chance-ambiguous response shares an artificial condition, not the real one.
  const chancePinned = !mouseEnd.chanceAmbiguous;

  const turn = enumerateCatTurnExact([{ state: start, plan: [] }], caps.catNodeCap);
  const rows: CausalPlanCheck[] = [];
  let mouseTruncatedSomewhere = false;

  for (const end of turn.ends) {
    if (rows.length >= caps.maxPlans) break;
    const r = mouseWinAfter(end.state, caps.mouseNodeCap);
    mouseTruncatedSomewhere ||= r.truncated;
    rows.push({ plan: end.plan.join(''), cell: rc(end.state.catPosition), endKey: stateKey(end.state), mouseWin: r.win, mouseTruncated: r.truncated });
  }

  let chosenRow = rows.find((r) => r.plan === chosenPlan) ?? null;
  if (chosenPlan !== null && chosenRow === null) {
    const rp = replayCatPlan(start, chosenPlan.split(''));
    // A plan that ends the game is a capture, not a next-turn question.
    if (rp.illegalAt === null && rp.applied.length === chosenPlan.length && rp.end.phase === GamePhase.Playing) {
      const k = stateKey(rp.end);
      const r = mouseWinAfter(rp.end, caps.mouseNodeCap);
      mouseTruncatedSomewhere ||= r.truncated;
      chosenRow = { plan: chosenPlan, cell: rc(rp.end.catPosition), endKey: k, mouseWin: r.win, mouseTruncated: r.truncated };
    }
  }
  const chosenKey = chosenRow?.endKey ?? null;

  const alternative = rows.find((r) => r.mouseWin !== null && r.endKey !== chosenKey) ?? null;
  const chosenPlanHolds = chosenRow !== null && !chosenRow.mouseTruncated && chosenRow.mouseWin === null;

  const scannedAllPlans = rows.length === turn.ends.length;
  const complete = !turn.truncated && scannedAllPlans && !mouseTruncatedSomewhere && chosenRow !== null;
  const note = chosenRow === null
    ? `no chosen plan was supplied or it is not a complete legal plan from this start; ${turn.ends.length} end state(s) enumerated${turn.truncated ? ' (TRUNCATED)' : ''}`
    : `chosen [${chosenRow.plan}] -> ${chosenRow.cell}: ${chosenRow.mouseWin === null ? 'no one-turn mouse win' : `mouse wins in ${chosenRow.mouseWin.steps} step(s)`}; ${rows.length} of ${turn.ends.length} distinct cat end state(s) checked${turn.truncated ? ', cat enumeration TRUNCATED' : ''}; ${alternative === null ? 'no alternative plan with a one-turn win found' : `alternative [${alternative.plan}] -> ${alternative.cell} allows ${alternative.mouseWin!.actions.join('')}`}${chancePinned ? '' : '; CHANCE NOT PINNED (a ghost materializes at the next hand-off, so both arms share an artificial no-ghost condition)'}`;

  return {
    chosenPlanHolds,
    plansChecked: rows.length,
    alternativeWinPlan: alternative === null
      ? null
      : { plan: alternative.plan, cell: alternative.cell, mouseWin: alternative.mouseWin!.actions },
    complete,
    chancePinned,
    note,
  };
}

/** Attach the causal evidence without changing any of HV-12's machine results. */
export function withCausal(x: ResponseDefence, ev: CausalEvidence): ResponseDefence {
  return { ...x, causal: ev };
}

export interface SemanticCounts {
  /** Distinct complete legal mouse ends (full stateKey dedupe), as HV-12 reports them. */
  legalDistinctEnds: number;
  analysed: number;
  directCaptures: number;
  /** Checked next mouse turn with no hole entry (this includes witness rows). */
  noMouseWinNextTurn: number;
  /** Rows carrying a replayable timely interception witness (surviving, refuted, or chance-UNKNOWN). */
  tacticalWitnesses: number;
  /** Witness rows classified NO_MOUSE_WIN_NEXT_TURN (its next turn was checked, no entry). */
  survivingWitnesses: number;
  /** Witness rows kept UNKNOWN because a ghost materializes at the next hand-off. */
  chanceWitnesses: number;
  /** Witness rows whose next mouse turn does enter the hole (the witness did not hold). */
  refutedWitnesses: number;
  causalBlocks: number;
  /** A proven ALL-LEGAL-CAT-PLANS refutation (terminal win or a complete all-plan scan). */
  allPlansLosses: number;
  /** A bypass that refutes exactly the checked plan. */
  specificPlanRefutations: number;
  unknown: number;
  /** Non-capture rows where the all-plans counterfactual was never run. */
  causalUnproven: number;
}

export function semanticCounts(r: PlanResponseReport): SemanticCounts {
  const c: SemanticCounts = {
    legalDistinctEnds: r.legalComplete,
    analysed: r.responses.length,
    directCaptures: 0,
    noMouseWinNextTurn: 0,
    tacticalWitnesses: 0,
    survivingWitnesses: 0,
    chanceWitnesses: 0,
    refutedWitnesses: 0,
    causalBlocks: 0,
    allPlansLosses: 0,
    specificPlanRefutations: 0,
    unknown: 0,
    causalUnproven: 0,
  };
  for (const x of r.responses) {
    const cls = defenceClassOf(x);
    if (cls === 'CAT_IMMEDIATE_WIN') c.directCaptures++;
    else if (cls === 'CAUSAL_ONE_TURN_BLOCK') c.causalBlocks++;
    else if (cls === 'NO_MOUSE_WIN_NEXT_TURN') c.noMouseWinNextTurn++;
    else if (cls === 'UNKNOWN') c.unknown++;
    if (x.witness !== null) {
      c.tacticalWitnesses++;
      if (cls === 'NO_MOUSE_WIN_NEXT_TURN') c.survivingWitnesses++;
      if (cls === 'UNKNOWN' && x.nextMouseChecked && x.nextMouseWinSteps === null) c.chanceWitnesses++;
      if (x.nextMouseWinSteps !== null) c.refutedWitnesses++;
    }
    if (refutationScopeOf(x) === 'ALL_LEGAL_CAT_PLANS') c.allPlansLosses++;
    if (x.result === 'PROVEN_LOCAL_BYPASS' && !x.terminalMouseWin) c.specificPlanRefutations++;
    if (x.causal === null && x.immediateCapture === null && !x.terminalMouseWin) c.causalUnproven++;
  }
  return c;
}
