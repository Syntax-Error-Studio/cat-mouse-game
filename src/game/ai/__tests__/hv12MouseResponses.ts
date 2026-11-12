/**
 * PPC-HV-12 — real mouse-turn responses to two legal T4 cat plans.
 *
 * WHAT THIS IS. HV-10/HV-11 preferred `RRRR` from a root scan; H1 actually played
 * `UUUR`. This module asks the question those rounds never asked: when the mouse
 * answers with a DIFFERENT legal move, does `RRRR` still defend better?
 *
 * ONLY TWO ROOTS EXIST HERE. Both are real `catMove` replays of the logged T4
 * root (h1Turn(4)), and every mouse action below is a real engine transition:
 * `mouseStepDeterministic`, `mouseSkill`, `chooseTunnelExit` + `endTurn`. Nothing
 * is sampled, nothing is invented, and no production code is imported as a
 * decision maker — the scout is used as a read-only measuring instrument.
 *
 * GHOST BUTTER, STATED ONCE. `mouseStepDeterministic` DEFERS the ghost announce,
 * so a pickup leaves `pendingButterSpawns` untouched here (no Math.random). That
 * is sound for this horizon and the reason is structural, not optimistic:
 *  - a pending ghost never blocks a mouse step, a cat step, a push, or a trap
 *    (engine.ts:1192-1200 resolveGhostBoundaryCore is the only consumer);
 *  - it materializes ONLY at a CAT→MOUSE boundary (engine.ts:1224-1231), which
 *    lies AFTER the cat's defensive turn analysed here;
 *  - every cat-side measurement below hands the position off through
 *    `handOffToMouse(end, true)` (`maximizeCatPower`), which clears pending
 *    ghosts before `scoutEndState` reads the position — the same contract HV-10
 *    and HV-11 used.
 * One case is NOT inert and is reported as `CHANCE_INCOMPLETE` instead of being
 * pinned: the mouse picks a butter and then spends it with the skill in the same
 * turn. It ends the turn NOT carrying, so at the next CAT→MOUSE boundary a ghost
 * materializes into a real butter somewhere, and that butter can shorten the
 * mouse's next return. A "no win found" verdict in that case is UNKNOWN; a
 * PROVEN win is still a win (an extra butter cannot block a mouse step).
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  endTurn,
  mouseSkill,
  mouseStepDeterministic,
  type GameEngineState,
} from '../../engine';
import { chooseTunnelExit } from '../../rules/tunnels';
import { DIRECTIONS, GamePhase, PieceType, type Direction } from '../../types';
import { createEvaluationContext } from '../evaluation';
import { stateKey } from '../transposition';
import {
  DEFAULT_CAPS,
  scoutRoot,
  type EndRow,
  type PlanRow,
  type ScoutCaps,
  type TimelyRow,
} from './hv10RootScout';
import {
  enumerateCatTurnExact,
  handOffToMouse,
  h1Turn,
  mouseTurnFrom,
  rc,
  replayCatPlan,
} from './hv5ForcedLineAuditor';

export const T4_LOG_SHA256 = '25d048b581a2d6712138ebe38c923fa39b797ab66c451552acf4edacf98f149a';
export const T4_LOG_URL = new URL(
  '../../../../ai-training/human-logs/PPC-HV4/PPC_HV3_GAME4_H1_ORIGINAL.txt',
  import.meta.url,
);

export function t4LogSha256(): string {
  return createHash('sha256').update(readFileSync(T4_LOG_URL)).digest('hex');
}

/** The real logged T4 cat root (h1Turn(4).state). */
export const t4Root = (): GameEngineState => h1Turn(4).state;

export interface CatPlanRun {
  tokens: string[];
  end: GameEngineState;
  applied: string[];
  illegalAt: string | null;
  /** Mouse-to-move start handed off by the shared `endTurn`, ghosts maximized away. */
  mouseStart: GameEngineState;
}

/** Replay a cat plan through the real `catMove` and hand off to the mouse. */
export function runCatPlan(tokens: string[]): CatPlanRun {
  const rp = replayCatPlan(t4Root(), tokens);
  return {
    tokens,
    end: rp.end,
    applied: rp.applied,
    illegalAt: rp.illegalAt,
    mouseStart: handOffToMouse(rp.end, true),
  };
}

// ---------------------------------------------------------------------------
// mouse turn: every legal action, full stateKey dedupe
// ---------------------------------------------------------------------------

export type MouseTerminal = 'MOUSE_WINS';

export interface MouseTurnEnd {
  /** Full production state key — butter, skill, trap, boxes, tunnel list included. */
  key: string;
  state: GameEngineState;
  actions: string[];
  terminal: MouseTerminal | null;
  /** No legal action remains while the budget is not spent; the kernel does not hand off. */
  stalled: boolean;
  steps: number;
  pickedButter: boolean;
  usedSkill: boolean;
  tookTunnel: boolean;
  trapped: boolean;
  /** Pickups that announce a ghost in the real game (deferred here). */
  ghostRequests: number;
  /**
   * A ghost would exist AND the mouse does not carry at the end: skill consumed
   * the butter, so the materialized butter can change the next return route.
   */
  chanceAmbiguous: boolean;
}

export interface MouseTurnEnumeration {
  ends: MouseTurnEnd[];
  nodes: number;
  expanded: number;
  duplicateEnds: number;
  truncated: boolean;
  nodeCap: number;
  /** Deepest step count reached (skill adds up to `mouseSkillExtraMoves`). */
  maxSteps: number;
  skillUses: number;
  tunnelEntries: number;
  pickups: number;
  wins: number;
  stalls: number;
}

const tokenFor = (d: Direction): string => d.key.replace('Arrow', '').slice(0, 1);
const dirByToken = (t: string): Direction | undefined => DIRECTIONS.find((d) => tokenFor(d) === t) as Direction | undefined;

interface MouseNode {
  s: GameEngineState;
  actions: string[];
  steps: number;
  picked: boolean;
  usedSkill: boolean;
  tookTunnel: boolean;
  trapped: boolean;
}

/**
 * Enumerate every COMPLETE legal mouse turn from `start` (mouse to move).
 *
 * Turn ends are: the budget reaching 0 (the kernel's own hand-off), stepping on
 * the trap (same hand-off with 0 moves left), a tunnel entry followed by a real
 * `chooseTunnelExit` choice plus `endTurn` (the choice does NOT end the turn
 * itself, tunnels.ts:16-22), or reaching the hole while carrying (`MouseWins`).
 * A state with no legal action and steps left is NOT a completed turn — the real
 * kernel never hands off — so it is recorded as `stalled` and excluded from the
 * defence table.
 */
export function enumerateMouseTurn(
  start: GameEngineState,
  opts: { nodeCap?: number } = {},
): MouseTurnEnumeration {
  const nodeCap = opts.nodeCap ?? 60_000;
  const ends: MouseTurnEnd[] = [];
  const endKeys = new Map<string, number>();
  const seen = new Set<string>();
  let nodes = 0;
  let expanded = 0;
  let truncated = false;
  let maxSteps = 0;
  let skillUses = 0;
  let tunnelEntries = 0;
  let pickups = 0;
  let wins = 0;
  let stalls = 0;

  const stack: MouseNode[] = [{ s: start, actions: [], steps: 0, picked: false, usedSkill: false, tookTunnel: false, trapped: false }];

  const pushEnd = (n: MouseNode, s: GameEngineState, extra: { terminal?: MouseTerminal | null; stalled?: boolean; tookTunnel?: boolean } = {}): void => {
    const k = stateKey(s);
    const dup = endKeys.get(k);
    if (dup !== undefined) { endKeys.set(k, dup + 1); return; }
    endKeys.set(k, 1);
    const carried = s.mouseHasButter;
    const picked = n.picked || s.butterPositions.length < start.butterPositions.length;
    const ghostRequests = Math.max(0, start.butterPositions.length - s.butterPositions.length);
    const usedSkill = n.usedSkill || s.mouseSkillActive;
    ends.push({
      key: k,
      state: s,
      actions: n.actions,
      terminal: extra.terminal ?? null,
      stalled: extra.stalled ?? false,
      steps: n.steps,
      pickedButter: picked,
      usedSkill,
      tookTunnel: extra.tookTunnel ?? n.tookTunnel,
      trapped: n.trapped,
      ghostRequests,
      chanceAmbiguous: ghostRequests > 0 && !carried,
    });
  };

  while (stack.length > 0) {
    if (nodes >= nodeCap) { truncated = true; break; }
    const n = stack.pop()!;
    const s = n.s;
    maxSteps = Math.max(maxSteps, n.steps);

    // The hole was reached while carrying: the mouse wins before any hand-off.
    if (s.phase === GamePhase.MouseWins) {
      nodes++;
      wins++;
      pushEnd(n, s, { terminal: 'MOUSE_WINS' });
      continue;
    }
    // A tunnel entry: every listed exit (including the always-present "stay")
    // is a legal choice, and the turn ends after the choice.
    if (s.phase === GamePhase.ChoosingTunnelExit) {
      nodes++;
      const choices = s.tunnelExitChoices ?? [];
      if (choices.length === 0) {
        pushEnd(n, s); // defensive: no choice means nothing to resolve
        continue;
      }
      tunnelEntries++;
      for (const ch of choices) {
        const landed = chooseTunnelExit(s, ch.r, ch.c);
        const ended = endTurn(landed);
        pushEnd(
          { ...n, actions: [...n.actions, `T:${ch.r},${ch.c}`], tookTunnel: true },
          ended,
          { tookTunnel: true },
        );
      }
      continue;
    }
    if (s.phase !== GamePhase.Playing || s.currentPlayer !== PieceType.Mouse) {
      nodes++;
      pushEnd(n, s);
      continue;
    }

    const k = stateKey(s);
    if (seen.has(k)) continue;
    seen.add(k);
    nodes++;

    if (s.mouseMovesLeft <= 0) {
      pushEnd(n, endTurn(s));
      continue;
    }

    let anyAction = false;
    for (const d of DIRECTIONS) {
      const moved = mouseStepDeterministic(s, d);
      if (moved.phase !== GamePhase.MouseWins && rc(moved.mousePosition) === rc(s.mousePosition)) continue;
      anyAction = true;
      const picked = moved.butterPositions.length < s.butterPositions.length;
      const trapped = s.trapPosition !== null
        && moved.trapPosition === null
        && rc(moved.mousePosition) === rc(s.trapPosition);
      if (picked) pickups++;
      stack.push({
        s: moved,
        actions: [...n.actions, tokenFor(d)],
        steps: n.steps + 1,
        picked: n.picked || picked,
        usedSkill: n.usedSkill,
        tookTunnel: n.tookTunnel || moved.phase === GamePhase.ChoosingTunnelExit,
        trapped: n.trapped || trapped,
      });
    }

    const skilled = mouseSkill(s);
    if (skilled !== s) {
      anyAction = true;
      skillUses++;
      stack.push({
        s: skilled,
        actions: [...n.actions, 'SKILL'],
        steps: n.steps,
        picked: n.picked,
        usedSkill: true,
        tookTunnel: n.tookTunnel,
        trapped: n.trapped,
      });
    }

    if (!anyAction) {
      expanded++;
      stalls++;
      pushEnd(n, s, { stalled: true });
    } else {
      expanded++;
    }
  }

  let duplicateEnds = 0;
  for (const count of endKeys.values()) duplicateEnds += Math.max(0, count - 1);
  return {
    ends,
    nodes,
    expanded,
    duplicateEnds,
    truncated,
    nodeCap,
    maxSteps,
    skillUses,
    tunnelEntries,
    pickups,
    wins,
    stalls,
  };
}

// ---------------------------------------------------------------------------
// one response: the cat's next legal turn
// ---------------------------------------------------------------------------

export interface CatTurnAtResponse {
  nodes: number;
  ends: { plan: string; state: GameEngineState }[];
  captures: string[];
  truncated: boolean;
}

export function catTurnAt(mouseEnd: GameEngineState, nodeCap: number): CatTurnAtResponse {
  const e = enumerateCatTurnExact([{ state: mouseEnd, plan: [] }], nodeCap);
  return {
    nodes: e.nodes,
    ends: e.ends.map((b) => ({ plan: b.plan.join(''), state: b.state })),
    captures: e.captures.map((p) => p.join('')),
    truncated: e.truncated,
  };
}

// ---------------------------------------------------------------------------
// defence verdicts
// ---------------------------------------------------------------------------

export type DefenceResult =
  | 'PROVEN_LOCAL_INTERCEPTION'
  | 'PROVEN_LOCAL_BYPASS'
  | 'NO_IMMEDIATE_DEFENCE_FOUND'
  | 'UNKNOWN';

/**
 * HV-13 semantics. The machine result above answers "what did the search see";
 * these classes answer "what is actually proven":
 *
 *  CAT_IMMEDIATE_WIN             the real engine caught the mouse inside this turn.
 *  CAUSAL_ONE_TURN_BLOCK         the chosen plan prevents a one-turn hole entry AND
 *                                another legal complete cat plan from the same start
 *                                allows one, under the same chance condition.
 *  TACTICAL_INTERCEPTION_WITNESS a replayable legal timely cell/plan exists, but the
 *                                next turn was not checked or it wins anyway; its
 *                                causal value in this horizon is not proven.
 *  NO_MOUSE_WIN_NEXT_TURN        the chosen plan was checked and its complete next
 *                                mouse turn cannot enter the hole. Local to that plan;
 *                                a witness may or may not exist.
 *  UNKNOWN                       chance, truncation, or insufficient evidence.
 */
export type DefenceClass =
  | 'CAT_IMMEDIATE_WIN'
  | 'CAUSAL_ONE_TURN_BLOCK'
  | 'TACTICAL_INTERCEPTION_WITNESS'
  | 'NO_MOUSE_WIN_NEXT_TURN'
  | 'UNKNOWN';

/**
 * Quantifier on a refutation. HV-12 only probed a bounded candidate set, so a
 * mouse win after one candidate is a refutation of THAT plan, never of all legal
 * cat plans. ALL is reserved for a terminal win inside the mouse's own turn (no cat
 * turn exists) or for `allPlansRefuted`, which only a complete all-plan scan sets.
 */
export type RefutationScope = 'NONE' | 'SPECIFIC_CAT_PLAN' | 'ALL_LEGAL_CAT_PLANS';

export interface GhostBlindKeyed {
  ghostBlindKey: string;
}

/** Key with the ghost fields neutralised — for comparing against a logged state. */
export function ghostBlindKey(s: GameEngineState): string {
  return stateKey({ ...s, pendingButterSpawns: [], pendingButterPlacementDebt: 0 });
}

export interface DefenceWitness {
  catPlan: string;
  cell: string;
  catSteps: number;
  pushes: number;
  routeOrigin: string | null;
  routeStep: number | null;
  layerWidth: number | null;
  catAtomic: number | null;
  mouseAtomic: number | null;
  margin: number | null;
  endsInCapture: boolean;
}

export interface AlternativeRoute {
  actions: string[];
  steps: number;
}

/**
 * HV-13 causal evidence. Filled only by `hv13DefenceSemantics.causalScan`, which
 * hands EVERY distinct legal cat end state of the same cat turn to the mouse and
 * enumerates the next mouse turn completely. `null` means "not tested here", never
 * "no alternative exists".
 */
export interface CausalEvidence {
  /** The chosen plan's next mouse turn was checked and has no hole entry. */
  chosenPlanHolds: boolean;
  /** Distinct legal cat end states handed to the mouse and checked. */
  plansChecked: number;
  /** A different legal cat plan after which the mouse DOES enter the hole in one turn. */
  alternativeWinPlan: { plan: string; cell: string; mouseWin: string[] } | null;
  /** Every distinct legal cat end state of this turn was checked, no cap bound. */
  complete: boolean;
  /** Both arms ran under the same PINNED chance condition (no ghost inside the claim). */
  chancePinned: boolean;
  note: string;
}

export interface ResponseDefence {
  key: string;
  actions: string[];
  mouseHasButter: boolean;
  mouseDistanceToHole: number | null;
  /** Cheapest mouse win in ONE turn with the cat frozen where the response left it. */
  baselineMouseWinSteps: number | null;
  immediateCapture: { plan: string; steps: number } | null;
  witness: DefenceWitness | null;
  catPlanAfterDefence: string | null;
  catPositionAfterDefence: string | null;
  mouseAlternativeRoute: AlternativeRoute | null;
  routeDelaySteps: number | null;
  routeDelayNote: string;
  result: DefenceResult;
  note: string;
  /** The END-STATE scan is incomplete (unscanned end states or a truncated enumeration). */
  capped: boolean;
  /** A per-end target / derivation cap bound: positive witnesses stand, negatives are bounded. */
  targetsBounded: boolean;
  /** The instrument's own status and binding reasons, verbatim. */
  scanStatus: 'COMPLETE' | 'INCOMPLETE';
  capReasons: string[];
  /** Ghost randomness sits inside the claim (skill spent a picked butter). */
  chanceAmbiguous: boolean;
  /** The mouse entered the hole inside its own turn: no cat turn exists, so all plans are refuted. */
  terminalMouseWin: boolean;
  /** The selected cat plan was handed to the mouse and its next turn was enumerated completely. */
  nextMouseChecked: boolean;
  /** Shortest hole entry in that next turn: null means checked and no entry, not unchecked. */
  nextMouseWinSteps: number | null;
  /** Contract-ranked cat end states actually bypass-checked / available. */
  candidatesChecked: number;
  candidatesTotal: number;
  /** HV-13 counterfactual over every legal cat plan; null until causalScan runs. */
  causal: CausalEvidence | null;
  /**
   * Set only by an instrument that enumerated EVERY distinct legal cat end state of
   * this turn and found a mouse win after each. HV-12's bounded candidate probe never
   * sets it, so a single checked plan stays SPECIFIC_CAT_PLAN.
   */
  allPlansRefuted: boolean;
  scanMs: number;
}

export interface DefenceCaps {
  /** Per response: HV-10 scout caps. */
  scout: ScoutCaps;
  /** Per response: cat-turn enumeration node cap for the immediate-capture question. */
  catNodeCap: number;
  /** Per candidate cat end: bound on the mouse's next-turn enumeration. */
  mouseNodeCap: number;
  /** How many contract-ranked cat end states may be bypass-checked. */
  maxDefenceCandidates: number;
  /** How many mouse ends (responses) are analysed per plan. */
  maxResponses: number;
}

export const LIGHT_DEFENCE_CAPS: DefenceCaps = {
  scout: { ...DEFAULT_CAPS },
  catNodeCap: 20_000,
  mouseNodeCap: 20_000,
  maxDefenceCandidates: 4,
  maxResponses: 48,
};

const smallestPlan = (plans: string[]): string | null => (plans.length === 0 ? null : [...plans].sort()[0]);

const stepCount = (plan: string): number => plan.length;

const timelyRank = (row: EndRow): { choke: number; timely: number; uncovered: number } => {
  const timely = row.timely.filter((t) => t.verdict === 'CAT_CAN_ARRIVE_BEFORE_MOUSE');
  return {
    choke: timely.filter((t) => t.layerWidth === 1).length,
    timely: timely.length,
    uncovered: row.uncoveredThreatRoutes.length,
  };
};

const compareRows = (a: EndRow, b: EndRow): number => {
  const ra = timelyRank(a);
  const rb = timelyRank(b);
  return rb.choke - ra.choke || ra.uncovered - rb.uncovered || rb.timely - ra.timely || a.endStateKey.localeCompare(b.endStateKey);
};

const bestTimely = (row: EndRow): TimelyRow | null => {
  const rows = row.timely.filter((t) => t.verdict === 'CAT_CAN_ARRIVE_BEFORE_MOUSE');
  if (rows.length === 0) return null;
  return [...rows].sort(
    (a, b) =>
      (a.layerWidth ?? 99) - (b.layerWidth ?? 99)
      || (a.margin ?? 99) - (b.margin ?? 99)
      || a.cell.localeCompare(b.cell),
  )[0];
};

const mouseDistanceToHole = (s: GameEngineState): number | null => {
  if (s.phase !== GamePhase.Playing) return null;
  const ctx = createEvaluationContext(s);
  const d = ctx.carryHoleMap.get(rc(s.mousePosition));
  return d === undefined ? null : d;
};

/** Cheapest mouse win in one complete turn, with its real action witness. */
function cheapestMouseWin(start: GameEngineState, nodeCap: number): { steps: number; actions: string[] } | null {
  const e = enumerateMouseTurn(start, { nodeCap });
  const wins = e.ends.filter((r) => r.terminal === 'MOUSE_WINS');
  if (wins.length === 0) return null;
  return [...wins].sort((a, b) => a.steps - b.steps || a.actions.join('').localeCompare(b.actions.join('')))[0]!;
}

/**
 * Assess one mouse response: the cat's next legal turn only.
 *
 * The cat's turn is scanned with HV-10's verified instrument (`scoutRoot`), which
 * enumerates every legal cat turn, wraps each end state through the production
 * hand-off, derives the mouse's imminent routes, and times a real `catMove`
 * witness against production's own route clock. A timely witness is not called a
 * defence on its own: the candidate cat end is then handed to the mouse and a
 * real `mouseStepDeterministic` turn is enumerated. Only when that turn cannot
 * reach the hole is the position called `PROVEN_LOCAL_INTERCEPTION`.
 *
 * `NO_IMMEDIATE_DEFENCE_FOUND` means the scan completed and found neither a
 * capture nor a timely witness — it is a statement about this turn, never about
 * the whole game.
 *
 * HV-13: the machine result is not the proof class. `defenceClassOf` separates a
 * finished capture from local next-turn safety and from a causal block, and
 * `refutationScopeOf` states the quantifier. A surviving witness here only proves
 * that THIS plan denies a one-turn entry.
 */
export function assessResponse(mouseEnd: MouseTurnEnd, caps: DefenceCaps = LIGHT_DEFENCE_CAPS): ResponseDefence {
  const t0 = performance.now();
  const base: ResponseDefence = {
    key: mouseEnd.key,
    actions: mouseEnd.actions,
    mouseHasButter: mouseEnd.state.mouseHasButter,
    mouseDistanceToHole: null,
    baselineMouseWinSteps: null,
    immediateCapture: null,
    witness: null,
    catPlanAfterDefence: null,
    catPositionAfterDefence: null,
    mouseAlternativeRoute: null,
    routeDelaySteps: null,
    routeDelayNote: '',
    result: 'UNKNOWN',
    note: '',
    capped: false,
    targetsBounded: false,
    scanStatus: 'COMPLETE',
    capReasons: [],
    chanceAmbiguous: mouseEnd.chanceAmbiguous,
    terminalMouseWin: false,
    nextMouseChecked: false,
    nextMouseWinSteps: null,
    candidatesChecked: 0,
    candidatesTotal: 0,
    causal: null,
    allPlansRefuted: false,
    scanMs: 0,
  };

  if (mouseEnd.terminal === 'MOUSE_WINS') {
    return {
      ...base,
      result: 'PROVEN_LOCAL_BYPASS',
      terminalMouseWin: true,
      note: 'terminal before any cat turn: the mouse enters the hole inside its own turn, so this response already defeats every plan',
      scanMs: performance.now() - t0,
    };
  }
  if (mouseEnd.stalled) {
    return {
      ...base,
      result: 'UNKNOWN',
      note: 'MOUSE_STALLED: no legal action with budget left; the kernel does not hand the turn over, so there is no cat turn to assess',
      scanMs: performance.now() - t0,
    };
  }
  if (mouseEnd.state.phase !== GamePhase.Playing || mouseEnd.state.currentPlayer !== PieceType.Cat) {
    return {
      ...base,
      result: 'UNKNOWN',
      note: `not a cat-turn start (phase=${mouseEnd.state.phase}, player=${mouseEnd.state.currentPlayer})`,
      scanMs: performance.now() - t0,
    };
  }

  const start = mouseEnd.state;
  const dist = mouseDistanceToHole(start);
  const scan = scoutRoot(start, caps.scout);
  const endStatesIncomplete = !scan.stats.enumerationComplete || scan.stats.notScannedEndStates > 0;
  const targetsBounded = scan.scanned.some((r) => r.targetCapReached || r.deriveCapHit);
  base.capped = endStatesIncomplete;
  base.targetsBounded = targetsBounded;
  base.scanStatus = scan.stats.scanStatus;
  base.capReasons = [...scan.stats.unscanned.reasons];
  const capture = smallestPlan(scan.plans.filter((p) => p.kind === 'capture').map((p) => p.plan));

  if (capture !== null) {
    const endState = replayCatPlan(start, capture.split('')).end;
    return {
      ...base,
      mouseDistanceToHole: dist,
      immediateCapture: { plan: capture, steps: stepCount(capture) },
      catPlanAfterDefence: capture,
      catPositionAfterDefence: rc(endState.catPosition),
      result: 'PROVEN_LOCAL_INTERCEPTION',
      note: `the cat catches the mouse inside this turn with [${capture}] after ${stepCount(capture)} step(s)`,
      scanMs: performance.now() - t0,
    };
  }

  // Distinct scanned positions, contract-ranked, with one legal plan each.
  const byKey = new Map<string, { row: EndRow; plans: PlanRow[] }>();
  for (const p of scan.plans) {
    if (!p.row.scanned) continue;
    const cur = byKey.get(p.endStateKey);
    if (cur) cur.plans.push(p);
    else byKey.set(p.endStateKey, { row: p.row, plans: [p] });
  }
  const ranked = [...byKey.values()].sort((a, b) => compareRows(a.row, b.row));
  base.candidatesTotal = ranked.length;
  if (ranked.length === 0) {
    return {
      ...base,
      mouseDistanceToHole: dist,
      result: 'UNKNOWN',
      note: 'no end state of the cat turn could be scanned; the defence question is unanswered, not answered NO',
      scanMs: performance.now() - t0,
    };
  }

  // Geometry baseline for route lengthening: the mouse's cheapest win in ONE turn
  // with the cat frozen where the response left it. A counterfactual position, not
  // a claim that the cat would pass.
  const frozen = cheapestMouseWin(mouseTurnFrom(start), caps.mouseNodeCap);

  interface Attempt {
    row: EndRow;
    plan: PlanRow;
    timely: TimelyRow;
    win: { steps: number; actions: string[] } | null;
  }
  let firstWitness: Attempt | null = null;
  let firstBypass: Attempt | null = null;
  let truncatedCandidate = false;
  let probed = 0;

  const candidates = ranked.slice(0, Math.max(1, caps.maxDefenceCandidates));
  for (const cand of candidates) {
    const timely = bestTimely(cand.row);
    if (timely === null) continue;
    probed++;
    base.candidatesChecked = probed;
    const endState = cand.plans[0]!.endState;
    const leaf = handOffToMouse(endState, true);
    const mt = enumerateMouseTurn(leaf, { nodeCap: caps.mouseNodeCap });
    if (mt.truncated) { truncatedCandidate = true; continue; }
    const wins = mt.ends.filter((r) => r.terminal === 'MOUSE_WINS');
    const win = wins.length === 0
      ? null
      : [...wins].sort((a, b) => a.steps - b.steps || a.actions.join('').localeCompare(b.actions.join('')))[0]!;
    const attempt: Attempt = { row: cand.row, plan: cand.plans[0]!, timely, win };
    if (firstWitness === null) firstWitness = attempt;
    if (win === null) {
      // A real interception that survives the mouse's next turn.
      if (mouseEnd.chanceAmbiguous) {
        return {
          ...base,
          mouseDistanceToHole: dist,
          baselineMouseWinSteps: frozen?.steps ?? null,
          witness: witnessOf(attempt),
          catPlanAfterDefence: attempt.plan.plan,
          catPositionAfterDefence: rc(endState.catPosition),
          nextMouseChecked: true,
          nextMouseWinSteps: null,
          result: 'UNKNOWN',
          note: 'CHANCE_INCOMPLETE: this response ends NOT carrying after a pickup was spent on the skill, so a ghost materializes at the next CAT→MOUSE boundary; the surviving interception is real, but "no mouse win" cannot be claimed without pinning that random butter',
              scanMs: performance.now() - t0,
        };
      }
      return {
        ...base,
        mouseDistanceToHole: dist,
        baselineMouseWinSteps: frozen?.steps ?? null,
        witness: witnessOf(attempt),
        catPlanAfterDefence: attempt.plan.plan,
        catPositionAfterDefence: rc(endState.catPosition),
        nextMouseChecked: true,
        nextMouseWinSteps: null,
        mouseAlternativeRoute: null,
        routeDelaySteps: null,
        routeDelayNote: frozen === null
          ? 'no mouse win inside one turn either before or after the cat plan'
          : `the mouse won in ${frozen.steps} step(s) against the frozen cat cell; after [${attempt.plan.plan}] it has no hole entry inside one turn`,
        result: 'PROVEN_LOCAL_INTERCEPTION',
        note: `[${attempt.plan.plan}] reaches ${timely.cell} ${timely.margin === null ? 'on a cell with no route-clock entry' : `${-timely.margin} step(s) before the mouse crosses`} (route ${timely.routeOrigin ?? 'none'}, layer ${timely.routeStep ?? '-'}, width ${timely.layerWidth ?? '-'}), and the mouse cannot enter the hole in its next turn`,
          scanMs: performance.now() - t0,
      };
    }
    if (firstBypass === null) firstBypass = attempt;
  }

  if (firstBypass !== null && !truncatedCandidate) {
    const win = firstBypass.win!;
    const delay = frozen === null ? null : win.steps - frozen.steps;
    return {
      ...base,
      mouseDistanceToHole: dist,
      baselineMouseWinSteps: frozen?.steps ?? null,
      witness: witnessOf(firstBypass),
      catPlanAfterDefence: firstBypass.plan.plan,
      catPositionAfterDefence: rc(firstBypass.plan.endState.catPosition),
      nextMouseChecked: true,
      nextMouseWinSteps: win.steps,
      mouseAlternativeRoute: { actions: win.actions, steps: win.steps },
      routeDelaySteps: delay,
      routeDelayNote: frozen === null
        ? 'the frozen baseline had no win inside one turn; the bypass exists anyway'
        : `mouse win ${win.steps} step(s) vs frozen baseline ${frozen.steps} step(s)`,
      result: 'PROVEN_LOCAL_BYPASS',
      note: `every probed defence (${probed} of ${ranked.length} scanned position(s); best witness [${firstBypass.plan.plan}] → ${firstBypass.timely.cell}) still loses the next mouse turn to [${win.actions.join('')}]`,
      scanMs: performance.now() - t0,
    };
  }

  if (endStatesIncomplete || truncatedCandidate) {
    return {
      ...base,
      mouseDistanceToHole: dist,
      baselineMouseWinSteps: frozen?.steps ?? null,
      catPlanAfterDefence: firstWitness?.plan.plan ?? null,
      catPositionAfterDefence: firstWitness ? rc(firstWitness.plan.endState.catPosition) : null,
      result: 'UNKNOWN',
      note: 'a cap bound before any interception could be witnessed; UNKNOWN, never NO',
      capped: true,
      scanMs: performance.now() - t0,
    };
  }

  // No candidate claimed a timely route interception. That is not yet "no defence":
  // hand the contract-best cat end to the mouse and ask the only question that
  // matters — can it enter the hole in ONE turn? A real win here is a real bypass.
  const top = ranked[0]!;
  const topEnd = top.plans[0]!.endState;
  const topLeaf = handOffToMouse(topEnd, true);
  const topTurn = enumerateMouseTurn(topLeaf, { nodeCap: caps.mouseNodeCap });
  if (topTurn.truncated) {
    return {
      ...base,
      mouseDistanceToHole: dist,
      baselineMouseWinSteps: frozen?.steps ?? null,
      catPlanAfterDefence: top.plans[0]!.plan,
      catPositionAfterDefence: rc(topEnd.catPosition),
      result: 'UNKNOWN',
      note: 'the mouse next-turn enumeration hit its cap on the best cat end; UNKNOWN, never NO',
      capped: true,
      scanMs: performance.now() - t0,
    };
  }
  const topWins = topTurn.ends.filter((r) => r.terminal === 'MOUSE_WINS');
  if (topWins.length > 0) {
    const win = [...topWins].sort((x, y) => x.steps - y.steps || x.actions.join('').localeCompare(y.actions.join('')))[0]!;
    return {
      ...base,
      mouseDistanceToHole: dist,
      baselineMouseWinSteps: frozen?.steps ?? null,
      catPlanAfterDefence: top.plans[0]!.plan,
      catPositionAfterDefence: rc(topEnd.catPosition),
      mouseAlternativeRoute: { actions: win.actions, steps: win.steps },
      routeDelaySteps: frozen === null ? null : win.steps - frozen.steps,
      routeDelayNote: frozen === null
        ? 'the frozen baseline had no win inside one turn; the bypass exists anyway'
        : `mouse win ${win.steps} step(s) vs frozen baseline ${frozen.steps} step(s)`,
      nextMouseChecked: true,
      nextMouseWinSteps: win.steps,
      result: 'PROVEN_LOCAL_BYPASS',
      note: `no timely route interception exists on this position and the mouse still enters the hole in its next turn with [${win.actions.join('')}] against the best scanned cat end [${top.plans[0]!.plan}]`,
      scanMs: performance.now() - t0,
    };
  }

  // A bounded target search cannot authorise a negative. HV-11 §5 marks such a
  // scan INCOMPLETE; the positive witnesses above stand, but the absence of one
  // is UNKNOWN, never NO_IMMEDIATE_DEFENCE_FOUND.
  if (scan.stats.scanStatus === 'INCOMPLETE') {
    return {
      ...base,
      mouseDistanceToHole: dist,
      baselineMouseWinSteps: frozen?.steps ?? null,
      catPlanAfterDefence: top.plans[0]!.plan,
      catPositionAfterDefence: rc(topEnd.catPosition),
      nextMouseChecked: true,
      nextMouseWinSteps: null,
      result: 'UNKNOWN',
      note: `the cat turn scanned ${scan.stats.scannedEndStates} end state(s) and found no timely interception witness, but the target search was bounded (${scan.stats.unscanned.reasons.slice(0, 3).join('; ')}); UNKNOWN, never NO`,
      scanMs: performance.now() - t0,
    };
  }

  return {
    ...base,
    mouseDistanceToHole: dist,
    baselineMouseWinSteps: frozen?.steps ?? null,
    catPlanAfterDefence: top.plans[0]!.plan,
    catPositionAfterDefence: rc(topEnd.catPosition),
    nextMouseChecked: true,
    nextMouseWinSteps: null,
    result: 'NO_IMMEDIATE_DEFENCE_FOUND',
    note: `the cat turn completed with ${scan.stats.scannedEndStates} scanned end state(s) and no timely interception witness on the mouse's imminent routes; the mouse also has no hole entry inside one turn, so this is "no targeted interception witness and no one-turn conversion", not a cat loss`,
    scanMs: performance.now() - t0,
  };
}

/**
 * HV-13: what the record actually proves, in this order.
 *
 * A capture is a finished win. A causal block needs the HV-13 counterfactual (a
 * different legal complete cat plan lets the mouse in). A checked, non-terminal
 * plan with no one-turn entry is local safety for THAT plan. A surviving tactical
 * witness without the counterfactual is only a witness. Everything else is UNKNOWN.
 *
 * In particular this never turns "no targeted witness" into a cat loss and never
 * turns a positive witness into a causal defence.
 */
export function defenceClassOf(x: ResponseDefence): DefenceClass {
  if (x.immediateCapture !== null) return 'CAT_IMMEDIATE_WIN';
  if (x.causal !== null && x.causal.chosenPlanHolds && x.causal.alternativeWinPlan !== null && x.causal.chancePinned) {
    return 'CAUSAL_ONE_TURN_BLOCK';
  }
  if (x.result === 'UNKNOWN') return 'UNKNOWN';
  if (x.nextMouseChecked && x.nextMouseWinSteps === null) return 'NO_MOUSE_WIN_NEXT_TURN';
  if (x.witness !== null) return 'TACTICAL_INTERCEPTION_WITNESS';
  return 'UNKNOWN';
}

/**
 * The quantifier on a refutation. A terminal mouse win inside its own turn is the
 * only all-plans refutation this instrument can produce: it happens before any cat
 * plan exists. A bypass after a bounded candidate set refutes exactly the plan that
 * was checked. `NO_IMMEDIATE_DEFENCE_FOUND` is not a refutation at all.
 */
export function refutationScopeOf(x: ResponseDefence): RefutationScope {
  if (x.terminalMouseWin || x.allPlansRefuted) return 'ALL_LEGAL_CAT_PLANS';
  if (x.result === 'PROVEN_LOCAL_BYPASS') return 'SPECIFIC_CAT_PLAN';
  return 'NONE';
}

/** A finished cat win inside its own turn. */
export const isTerminalCatWin = (x: ResponseDefence): boolean => defenceClassOf(x) === 'CAT_IMMEDIATE_WIN';

/** A defence whose value survives the counterfactual over all legal cat plans. */
export const isCausalOneTurnBlock = (x: ResponseDefence): boolean =>
  defenceClassOf(x) === 'CAUSAL_ONE_TURN_BLOCK';

/** Local safety only: this plan was checked and the mouse cannot win next turn. */
export const isNoMouseWinNextTurn = (x: ResponseDefence): boolean =>
  defenceClassOf(x) === 'NO_MOUSE_WIN_NEXT_TURN';

/** The ONLY shape in which a cat loss may be claimed. */
export const isCatLossClaim = (x: ResponseDefence): boolean =>
  refutationScopeOf(x) === 'ALL_LEGAL_CAT_PLANS';

const witnessOf = (a: { plan: PlanRow; timely: TimelyRow }): DefenceWitness => ({
  catPlan: a.plan.plan,
  cell: a.timely.cell,
  catSteps: a.timely.steps ?? 0,
  pushes: a.timely.pushes,
  routeOrigin: a.timely.routeOrigin,
  routeStep: a.timely.routeStep,
  layerWidth: a.timely.layerWidth,
  catAtomic: a.timely.catAtomic,
  mouseAtomic: a.timely.mouseAtomic,
  margin: a.timely.margin,
  endsInCapture: a.timely.endsInCapture,
});

// ---------------------------------------------------------------------------
// plan-level report
// ---------------------------------------------------------------------------

export interface PlanResponseReport {
  label: 'A' | 'B';
  tokens: string[];
  catEnd: string;
  catEndKey: string;
  mouseStartKey: string;
  mouseStartBudget: number;
  enumeration: MouseTurnEnumeration;
  responses: ResponseDefence[];
  /** Responses not analysed because `maxResponses` bound. */
  unanalysed: number;
  /** Legal complete responses (excluding stalled prefixes), before the analysis cap. */
  legalComplete: number;
  coverage: 'ALL_LEGAL_RESPONSES_COVERED' | 'PARTIAL_LEGAL_RESPONSES' | 'CHANCE_INCOMPLETE';
  coverageNote: string;
  scanMs: number;
}

export function analysePlan(
  label: 'A' | 'B',
  tokens: string[],
  opts: { mouseNodeCap?: number; caps?: DefenceCaps; maxResponses?: number } = {},
): PlanResponseReport {
  const t0 = performance.now();
  const caps = opts.caps ?? LIGHT_DEFENCE_CAPS;
  const run = runCatPlan(tokens);
  const en = enumerateMouseTurn(run.mouseStart, { nodeCap: opts.mouseNodeCap ?? 120_000 });
  const complete = en.ends.filter((e) => !e.stalled);
  const limit = opts.maxResponses ?? caps.maxResponses;
  const analysed = complete.slice(0, limit);
  const responses = analysed.map((e) => assessResponse(e, caps));
  const unanalysed = complete.length - analysed.length;
  const chanceAmbiguous = complete.filter((e) => e.chanceAmbiguous).length;
  const coverage: PlanResponseReport['coverage'] =
    en.truncated ? 'PARTIAL_LEGAL_RESPONSES'
      : unanalysed > 0 ? 'PARTIAL_LEGAL_RESPONSES'
        : chanceAmbiguous > 0 ? 'CHANCE_INCOMPLETE'
          : 'ALL_LEGAL_RESPONSES_COVERED';
  const coverageNote = en.truncated
    ? `mouse turn enumeration hit its ${en.nodeCap}-node cap, so the legal response set is a subset`
    : unanalysed > 0
      ? `${unanalysed} of ${complete.length} complete response(s) were not analysed (maxResponses=${limit})`
      : chanceAmbiguous > 0
        ? `${chanceAmbiguous} response(s) spend a picked butter with the skill, so a ghost materializes at the next CAT→MOUSE boundary; a no-win finding there is UNKNOWN`
        : `all ${complete.length} complete legal response(s) analysed; ghost materialization lies outside this horizon for the rest`;
  return {
    label,
    tokens,
    catEnd: rc(run.end.catPosition),
    catEndKey: stateKey(run.end),
    mouseStartKey: stateKey(run.mouseStart),
    mouseStartBudget: run.mouseStart.mouseMovesLeft,
    enumeration: en,
    responses,
    unanalysed,
    legalComplete: complete.length,
    coverage,
    coverageNote,
    scanMs: performance.now() - t0,
  };
}

export interface ResponseCounts {
  legal: number;
  analysed: number;
  immediateCapture: number;
  interception: number;
  bypass: number;
  noDefence: number;
  unknown: number;
}

export function countResponses(r: PlanResponseReport): ResponseCounts {
  const c: ResponseCounts = {
    legal: r.legalComplete,
    analysed: r.responses.length,
    immediateCapture: 0,
    interception: 0,
    bypass: 0,
    noDefence: 0,
    unknown: 0,
  };
  for (const x of r.responses) {
    if (x.result === 'PROVEN_LOCAL_INTERCEPTION') c.interception++;
    else if (x.result === 'PROVEN_LOCAL_BYPASS') c.bypass++;
    else if (x.result === 'NO_IMMEDIATE_DEFENCE_FOUND') c.noDefence++;
    else c.unknown++;
    if (x.immediateCapture !== null) c.immediateCapture++;
  }
  return c;
}

// ---------------------------------------------------------------------------
// A vs B on the SAME mouse deviation
// ---------------------------------------------------------------------------

export interface AbRow {
  actions: string;
  a: ResponseDefence;
  b: ResponseDefence;
}

export type AbVerdict = 'SUPPORTED' | 'COUNTEREXAMPLE_FOUND' | 'INCONCLUSIVE';

export interface AbComparison {
  common: AbRow[];
  onlyA: ResponseDefence[];
  onlyB: ResponseDefence[];
  /**
   * A materially holds the position (terminal capture or a proven causal one-turn
   * block) while B is a proven ALL-LEGAL-CAT-PLANS loss. This is the only decisive
   * class. HV-12's `PROVEN_LOCAL_INTERCEPTION` / `NO_IMMEDIATE_DEFENCE_FOUND` are
   * NOT members of either side of this relation.
   */
  bWorse: AbRow[];
  /** A captured the mouse and B did not: the capture-loss class P3 asks about. */
  captureLoss: AbRow[];
  /** B materially holds the position and A is a proven all-plans loss. */
  aWorse: AbRow[];
  /** A holds materially and B is neither lost nor holding. */
  heldOnlyA: AbRow[];
  /** B holds materially and A is neither lost nor holding. */
  heldOnlyB: AbRow[];
  /**
   * Neither side wins-or-causally-holds and neither side is a proven loss: local
   * safety, a tactical witness, chance, or a binding cap. No comparison exists.
   */
  undecided: AbRow[];
  /** The logged human reply, replayed through both plans (display only). */
  human: { actions: string[]; a: ResponseDefence | null; b: ResponseDefence | null };
  verdict: AbVerdict;
  reason: string;
}

/**
 * HV-13 quantifier repair. "A holds" means a finished capture or a defence proven
 * causal by the all-plans counterfactual — not a surviving witness, and never a
 * `NO_IMMEDIATE_DEFENCE_FOUND`. "Lost" means a proven ALL-LEGAL-CAT-PLANS loss,
 * which in this instrument only a terminal mouse win can establish.
 */
const held = (x: ResponseDefence): boolean => isTerminalCatWin(x) || isCausalOneTurnBlock(x);
const lost = (x: ResponseDefence): boolean => isCatLossClaim(x);

export function comparePlans(
  a: PlanResponseReport,
  b: PlanResponseReport,
  humanActions: string[],
): AbComparison {
  const aBy = new Map(a.responses.map((x) => [x.actions.join('/'), x]));
  const bBy = new Map(b.responses.map((x) => [x.actions.join('/'), x]));
  const common: AbRow[] = [];
  const onlyA: ResponseDefence[] = [];
  const onlyB: ResponseDefence[] = [];
  for (const [k, x] of aBy) {
    const y = bBy.get(k);
    if (y) common.push({ actions: k, a: x, b: y });
    else onlyA.push(x);
  }
  for (const [k, y] of bBy) if (!aBy.has(k)) onlyB.push(y);

  const bWorse = common.filter((r) => held(r.a) && lost(r.b));
  const captureLoss = common.filter((r) => r.a.immediateCapture !== null && r.b.immediateCapture === null);
  const aWorse = common.filter((r) => lost(r.a) && held(r.b));
  const heldOnlyA = common.filter((r) => held(r.a) && !held(r.b) && !lost(r.b));
  const heldOnlyB = common.filter((r) => held(r.b) && !held(r.a) && !lost(r.a));
  const undecided = common.filter((r) => !held(r.a) && !held(r.b) && !lost(r.a) && !lost(r.b));

  const humanKey = humanActions.join('/');
  const human = { actions: humanActions, a: aBy.get(humanKey) ?? null, b: bBy.get(humanKey) ?? null };

  const coverageComplete =
    a.coverage === 'ALL_LEGAL_RESPONSES_COVERED' && b.coverage === 'ALL_LEGAL_RESPONSES_COVERED';
  let verdict: AbVerdict;
  let reason: string;
  if (bWorse.length > 0) {
    verdict = 'COUNTEREXAMPLE_FOUND';
    reason = `${bWorse.length} shared mouse line(s) are won-or-causally-held by UUUR and are a proven ALL-LEGAL-CAT-PLANS loss for RRRR (${bWorse.map((r) => r.actions).slice(0, 4).join(' ')}); the mouse only has to pick one`;
  } else if (!coverageComplete || undecided.length > 0 || captureLoss.length > 0) {
    verdict = 'INCONCLUSIVE';
    const why = [
      coverageComplete ? null : `coverage is ${a.coverage} / ${b.coverage}`,
      undecided.length > 0 ? `${undecided.length} shared line(s) have neither a material cat hold nor a proven loss on either side (local safety and tactical witnesses live here)` : null,
      captureLoss.length > 0 ? `${captureLoss.length} shared line(s) keep UUUR's immediate capture but not RRRR's` : null,
      heldOnlyA.length > 0 ? `${heldOnlyA.length} line(s) are materially held only by UUUR` : null,
    ].filter((x): x is string => x !== null).join('; ');
    reason = `no shared line is a proven all-plans loss for either side, but ${why}; a count of local witnesses or of "no targeted witness" rows is not a win/loss gap, so neither a universal claim nor a clean dominance`;
  } else if (common.length === 0) {
    verdict = 'INCONCLUSIVE';
    reason = 'the two positions share no legal mouse line, so no comparison exists';
  } else {
    verdict = 'SUPPORTED';
    reason = `over the recorded scope: ${common.length} shared legal line(s), B never suffers a proven all-plans loss on a line A holds, ${aWorse.length} line(s) flip the other way, no undecided line, and no immediate capture is lost`;
  }
  return { common, onlyA, onlyB, bWorse, captureLoss, aWorse, heldOnlyA, heldOnlyB, undecided, human, verdict, reason };
}

export { dirByToken, tokenFor };
