/**
 * Hard AI turn deadline — the DUAL-PATH wall-clock contract.
 *
 * WHY THIS EXISTS
 * The bounded plan-refutation sidecar runs AFTER the main search has already spent
 * its `timeBudgetMs`, under a total-turn budget (`totalTurnBudgetMs`) that is a
 * wall-clock contract. It is built from several synchronous children — full-turn
 * enumeration, interception geometry, per-candidate probes, witness and override
 * replays — and at HEAD each of them only enforced its OWN local limit (`maxPaths`,
 * `maxCpuMs`, `maxExact`) while the turn deadline was handed around as a *relative*
 * number that every layer re-derived its own window from. Six candidates x 20 ms of
 * internal budget could therefore still be spent after the wall had passed: the plan
 * arrived ~150 ms late in the best case and hundreds of milliseconds late in the
 * worst, and the caller had no way to tell the two apart.
 *
 * THE CONTRACT
 * One absolute instant — `plannerCallStart` + `totalTurnBudgetMs` — is computed ONCE
 * at planner entry and threaded BY REFERENCE through every child, so no layer opens a
 * second clock and no layer re-derives a window. A local limit that fires first still
 * behaves exactly as before: the deadline is an ADDITIONAL stop condition, never a
 * replacement for an existing cap.
 *
 * WHY THERE ARE TWO PATHS AND NOT ONE BIG NUMBER
 * "No deadline" expressed as `deadlineAtMs = Infinity` is not the absence of a clock:
 * every `expired()` still reads `performance.now()` and throws the result away. That
 * instrumentation is not free and it is not neutral — the legacy probe's own local
 * `FIXED_CPU_MS` budget is cut on the SAME clock, so a caller that only wanted to
 * "disable the total deadline" also shifted where the pre-existing 20 ms budget
 * happens to cut, i.e. it perturbed the very behaviour it was supposed to leave
 * untouched. So the two modes are different TYPES here, not two values of one field:
 *
 *   NO_DEADLINE       — total-deadline instrumentation does not exist. There is no
 *                       `expired()`/`remainingMs()`/`now()` to call, so the question
 *                       "did the wall pass?" cannot even be written for this shape.
 *                       The legacy enumeration, interception and bounded probe
 *                       semantics run with exactly their own local limits.
 *   FINITE_ABSOLUTE   — the only shape that carries a clock. Everything that checks
 *                       the total deadline is narrowed to it first.
 *
 * `finiteDeadline()` resolves a context to `FiniteDeadline | null` ONCE, and every
 * check site is `dl !== null && dl.expired()`, so a NO_DEADLINE turn performs zero
 * total-deadline clock reads by construction rather than by a convention that the next
 * caller can break.
 *
 * THE ABORT RECORD
 * `SidecarControl` carries the resolved gate plus the one fact callers need: did the
 * sidecar finish? Anything that stops on the deadline must abandon the whole sidecar
 * transactionally and fall back to the pre-sidecar baseline plan, so an unfinished run
 * never commits a partial rejection, witness or override. `markAbort` is
 * first-writer-wins, so `abortPhase` names the FIRST region that actually broke the
 * contract — which is what makes the remaining uninterruptible regions visible
 * instead of guessed at.
 *
 * This module imports nothing from the project, so any AI module can use it without
 * adding an edge to the module graph. It is browser-safe: no node: specifiers.
 */

/** Which of the two paths this context is on. */
export type DeadlineKind = 'NO_DEADLINE' | 'FINITE_ABSOLUTE';

/** Where the shared deadline was observed to have passed. `none` = never. */
export type DeadlineAbortPhase =
  | 'none'
  | 'sidecar_entry'
  | 'selection_enumeration'
  | 'selection_interception'
  | 'selection_sorts'
  | 'probe_root_danger'
  | 'probe_expansion'
  | 'probe_exact_check'
  | 'probe_loop'
  | 'witness_replay'
  | 'override_selection'
  | 'cat_replay'
  | 'guard_entry'
  | 'guard_rescue_probe';

/** Total-deadline instrumentation OFF: no clock, no comparison, no `expired()` to ask. */
export interface NoDeadline {
  readonly kind: 'NO_DEADLINE';
  /** `+Infinity`, recorded for diagnostics only. Nothing on this path ever compares
   *  it against a clock — that comparison is what this split exists to remove. */
  readonly deadlineAtMs: number;
  readonly clockOrigin: 'performance.now';
}

/** Total-deadline instrumentation ON: one absolute instant in one clock origin. */
export interface FiniteDeadline {
  readonly kind: 'FINITE_ABSOLUTE';
  readonly deadlineAtMs: number;
  readonly clockOrigin: 'performance.now';
  /** Instrumentation counter: clock reads performed FOR TOTAL-DEADLINE CHECKING.
   *  A legacy local budget (`maxCpuMs`) reads its own clock and is NOT counted
   *  here — keeping those two apart is the whole reason for the split. */
  totalDeadlineClockReads: number;
  /** Reads the clock and counts it: this is the total-deadline instrumentation. */
  now(): number;
  remainingMs(): number;
  expired(): boolean;
}

export type DeadlineContext = NoDeadline | FiniteDeadline;

const defaultClock = (): number =>
  (typeof performance !== 'undefined' ? performance.now() : 0);

/**
 * The only way to open a total-deadline window.
 * @param deadlineAtMs absolute instant in `now`'s time-base — never a duration, and
 *                     never `Infinity`: an unlimited turn is {@link NO_DEADLINE}, so a
 *                     caller cannot ask for "off" and "instrumented" at once.
 * @param now          clock injection; defaults to `performance.now` like the rest of
 *                     the AI layer, so a test clock and the production clock are the
 *                     same clock.
 */
export function makeFiniteDeadline(deadlineAtMs: number, now?: () => number): FiniteDeadline {
  if (!Number.isFinite(deadlineAtMs)) {
    throw new Error(`makeFiniteDeadline: ${deadlineAtMs} is not a finite instant — pass NO_DEADLINE for an unlimited turn`);
  }
  const clock = now ?? defaultClock;
  const d: FiniteDeadline = {
    kind: 'FINITE_ABSOLUTE',
    deadlineAtMs,
    clockOrigin: 'performance.now',
    totalDeadlineClockReads: 0,
    now: () => { d.totalDeadlineClockReads++; return clock(); },
    remainingMs: () => { d.totalDeadlineClockReads++; return deadlineAtMs - clock(); },
    expired: () => { d.totalDeadlineClockReads++; return clock() >= deadlineAtMs; },
  };
  return d;
}

/** The "no total deadline" instance: instrumentation absent, not a distant wall. */
export const NO_DEADLINE: NoDeadline = {
  kind: 'NO_DEADLINE',
  deadlineAtMs: Number.POSITIVE_INFINITY,
  clockOrigin: 'performance.now',
};

/**
 * THE branch point. Resolved once per function, outside every loop: `null` means
 * there is no clock to read, so `dl !== null && dl.expired()` short-circuits without
 * touching `performance.now()`. Absent and NO_DEADLINE are the same answer here —
 * both mean "instrumentation off" — but a production-facing caller must still name
 * the mode explicitly, because a defaulted parameter is how an unbounded turn ends up
 * looking like a turn that has a deadline it never misses.
 */
export function finiteDeadline(d: DeadlineContext | null | undefined): FiniteDeadline | null {
  return d !== null && d !== undefined && d.kind === 'FINITE_ABSOLUTE' ? d : null;
}

/** The transactional abort record threaded alongside one {@link DeadlineContext}. */
export interface SidecarControl {
  /** What the caller asked for, verbatim: `kind` is the report's evidence that this
   *  turn ran the finite path or the legacy path. */
  readonly deadline: DeadlineContext;
  /** Resolved ONCE from `deadline`. `null` = total-deadline instrumentation off. */
  readonly finite: FiniteDeadline | null;
  /** TRUE = the sidecar did not complete; the caller must commit nothing. */
  deadlineAbort: boolean;
  /** First region that observed the abort (`none` while nothing aborted). */
  abortPhase: DeadlineAbortPhase;
  /** When expiry was FIRST observed; with `deadlineAtMs` this is the detection
   *  latency, which is bounded only by how often a region samples the clock. */
  deadlineObservedAtMs: number;
  /** Candidates the selector had actually built when it completed. 0 on abort: an
   *  incomplete candidate set is never reported as an empty (i.e. exhausted) one. */
  candidateCount: number;
  /** Must stay 0. Counted at commit time, not assumed by construction. */
  partialCommitCount: number;
}

export function makeControl(deadline: DeadlineContext): SidecarControl {
  return {
    deadline,
    finite: finiteDeadline(deadline),
    deadlineAbort: false,
    abortPhase: 'none',
    deadlineObservedAtMs: 0,
    candidateCount: 0,
    partialCommitCount: 0,
  };
}

/** Total-deadline clock reads this transaction performed. A method-free read: asking
 *  the question must not itself cost a read. 0 is the NO_DEADLINE contract, not a
 *  measurement of luck. */
export function totalDeadlineClockReads(ctl: SidecarControl | undefined): number {
  return ctl?.finite?.totalDeadlineClockReads ?? 0;
}

/** Record an abort. First writer wins, so `abortPhase` names the FIRST
 *  uninterruptible region rather than the last one to notice. */
export function markAbort(ctl: SidecarControl | undefined, phase: DeadlineAbortPhase): void {
  if (!ctl || ctl.deadlineAbort) return;
  // Only a finite context can break a wall-clock contract. Reaching this with the
  // instrumentation off means the caller gated on one object and resolved on another,
  // which is a caller bug, not a no-op: fail loud rather than record an abort that
  // cannot exist. (Unreachable from any gated site, so it cannot fire in a game.)
  if (ctl.finite === null) {
    throw new Error(`markAbort('${phase}') on a NO_DEADLINE transaction — the gate and the context disagree`);
  }
  ctl.deadlineAbort = true;
  ctl.abortPhase = phase;
  ctl.deadlineObservedAtMs = ctl.finite.now();
}
