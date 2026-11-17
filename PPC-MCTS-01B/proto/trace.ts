/**
 * PPC-MCTS-01B-HARNESS-REPAIR — read-only, RNG-neutral simulation trace.
 *
 * Contract (task §3.3):
 *   1. the trace must NOT consume random numbers;
 *   2. the trace must NOT change the existing RNG order;
 *   3. the trace must NOT mutate state objects;
 *   4. no instrumentation may be added to production code — this module lives
 *      entirely inside the isolated 01B prototype;
 *   5. deterministic canonical serialisation + SHA256;
 *   6. one digest per COMPLETE simulation;
 *   7. on a mismatch the first difference keeps its full event list;
 *   8. comparing only the root action or the final plan is not acceptable.
 *
 * How (1) and (2) are guaranteed structurally, not by inspection:
 *   - the collector only READS values that the search already computed. It
 *     calls no RNG. Every recorded number is either a state key, an action
 *     label, a reward, or the (n, value) pair of a draw that ALREADY happened.
 *   - `countingTraceRng` wraps a finished `Rng`. Its `next()` delegates to
 *     `base.next()` and its `int(n)` delegates to `base.int(n)`. mulberry32's
 *     own `int` calls its own private `next`, so wrapping produces exactly ONE
 *     record per public draw and never an extra state advance.
 *
 * How (3) is guaranteed: every field written into an event is a primitive.
 * `stateKey(state)` is a pure string projection; `encValue` only stringifies.
 *
 * How (6) and (7) work without unbounded memory: the event stream of a
 * simulation is fed into an incremental SHA256, so a 200-simulation call keeps
 * 200 digests (64 hex chars each) and nothing else. Event bodies are retained
 * only for the single simulation selected by `captureSimulation`. Because a
 * call is fully deterministic (fixed seed, fixed workload), the body of a
 * mismatching simulation can be recovered later by re-running that one arm with
 * `captureSimulation = i`.
 */
import { createHash } from 'node:crypto';
import type { Hash } from 'node:crypto';
import type { Rng } from '../../PPC-MCTS-01/proto/seededRng';

// ---------------------------------------------------------------------------
// canonical encoding
// ---------------------------------------------------------------------------

/**
 * Number → shortest round-trip decimal string, with the three values that
 * `String()` would fold together kept distinct (`-0`, `NaN`, `±Infinity`).
 * `num(a) === num(b)` therefore implies `Object.is(a, b)` for every finite
 * double, which is what the parity claim needs.
 */
export function num(x: number): string {
  if (Number.isNaN(x)) return 'NaN';
  if (x === Infinity) return 'Inf';
  if (x === -Infinity) return '-Inf';
  if (Object.is(x, -0)) return '-0';
  return String(x);
}

export type Encodable = string | number | boolean | null | undefined | readonly Encodable[];

/** Canonical, order-preserving, locale-independent encoding of one field. */
export function encValue(v: Encodable): string {
  if (v === null) return 'null';
  if (v === undefined) return 'undefined';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'string') return JSON.stringify(v);
  if (typeof v === 'number') return num(v);
  return `[${v.map(encValue).join(',')}]`;
}

// ---------------------------------------------------------------------------
// event stream
// ---------------------------------------------------------------------------

/**
 * Event kinds. The list is closed on purpose: `SIMULATION_TRACE_SCHEMA.md`
 * documents exactly these, and the collector rejects anything else so a typo
 * cannot silently pass parity.
 */
export const TRACE_EVENT_KINDS = [
  'sim.begin',
  'rng.draw',
  'tree.visit',
  'tree.expand',
  'tree.edge',
  'tree.chanceLayer',
  'tree.chancePick',
  'tree.cycle',
  'rollout.step',
  'rollout.guidance',
  'rollout.pick',
  'rollout.chance',
  'rollout.next',
  'rollout.empty',
  'rollout.stop',
  'rollout.leaf',
  'sim.end',
  // plan-phase events (outside the 200-simulation envelope)
  'plan.visit',
  'plan.edge',
  'plan.guidance',
  'plan.pick',
  'plan.extension',
  'plan.stop',
] as const;

export type TraceEventKind = typeof TRACE_EVENT_KINDS[number];

const PLAN_PHASE: ReadonlySet<string> = new Set(
  TRACE_EVENT_KINDS.filter((k) => k.startsWith('plan.')),
);

// ---------------------------------------------------------------------------
// per-simulation summary
// ---------------------------------------------------------------------------

export interface SimTraceSummary {
  /** 0-based index of the completed simulation. */
  index: number;
  completed: boolean;
  /** Backpropagated reward (cat perspective, normalised). */
  reward: number;
  /** Leaf value the rollout ended on. */
  leafValue: number;
  terminal: boolean;
  pathLength: number;
  rolloutSteps: number;
  chanceSamples: number;
  policyDraws: number;
  chanceDraws: number;
  maxHandoffs: number;
  /** SHA256 of this simulation's canonical event stream. */
  digest: string;
  /** Retained only when this simulation was selected for capture. */
  events: string[] | null;
}

// ---------------------------------------------------------------------------
// collector
// ---------------------------------------------------------------------------

export interface TraceCollectorOptions {
  /**
   * Retain the full event body of exactly one simulation (for "first
   * difference keeps its complete detail", §3.3.7). `null` = retain none.
   */
  captureSimulation?: number | null;
  /** Also retain the plan-phase event body. Off by default (it is ~10 lines). */
  capturePlan?: boolean;
}

export class TraceCollector {
  readonly sims: SimTraceSummary[] = [];
  private readonly captureSimulation: number | null;
  private readonly capturePlan: boolean;

  private simHash: Hash | null = null;
  private simIndex = -1;
  private simBuffer: string[] | null = null;

  private planHash: Hash | null = null;
  private planBuffer: string[] | null = null;

  constructor(opts: TraceCollectorOptions = {}) {
    this.captureSimulation = opts.captureSimulation ?? null;
    this.capturePlan = opts.capturePlan ?? false;
  }

  // ---------------------------------------------------------- simulation
  simulationBegin(index: number, rootStateKey: string): void {
    this.simHash = createHash('sha256');
    this.simIndex = index;
    this.simBuffer = this.captureSimulation === index ? [] : null;
    this.record('sim.begin', index, rootStateKey);
  }

  simulationEnd(summary: Omit<SimTraceSummary, 'digest' | 'events'>): void {
    this.record(
      'sim.end',
      summary.index, summary.completed, summary.reward, summary.leafValue,
      summary.terminal, summary.pathLength, summary.rolloutSteps,
      summary.chanceSamples, summary.policyDraws, summary.chanceDraws,
      summary.maxHandoffs,
    );
    const digest = this.simHash!.digest('hex');
    this.sims.push({ ...summary, digest, events: this.simBuffer });
    this.simHash = null;
    this.simBuffer = null;
  }

  // ---------------------------------------------------------------- plan
  planBegin(): void {
    this.planHash = createHash('sha256');
    this.planBuffer = this.capturePlan ? [] : null;
  }

  planEnd(): string {
    const digest = this.planHash!.digest('hex');
    this.planHash = null;
    this.planBuffer = null;
    return digest;
  }

  // -------------------------------------------------------------- record
  /**
   * Append one canonical event. No-op outside an active phase, so the same
   * call sites can stay unconditional. Values are primitives only.
   */
  record(kind: TraceEventKind, ...fields: Encodable[]): void {
    const plan = PLAN_PHASE.has(kind);
    const hash = plan ? this.planHash : this.simHash;
    if (hash === null) return;
    let line = `[${JSON.stringify(kind)}`;
    for (let i = 0; i < fields.length; i++) line += `,${encValue(fields[i])}`;
    line += ']';
    hash.update(line);
    hash.update('\n');
    const buf = plan ? this.planBuffer : this.simBuffer;
    if (buf !== null) buf.push(line);
  }

  /** Digest of the retained event stream of one simulation (capture only). */
  capturedEvents(index: number): string[] | null {
    const s = this.sims[index];
    return s ? s.events : null;
  }
}

// ---------------------------------------------------------------------------
// RNG instrumentation (read-only tap)
// ---------------------------------------------------------------------------

export type RngStream = 'chance' | 'policy';

export interface CountingTraceRng {
  rng: Rng;
  /** Total public draws so far (`next()` + `int()`). */
  draws: () => number;
}

/**
 * Wrap a live `Rng` with a recording tap.
 *
 * Exactly one record per PUBLIC draw:
 *   `next()`  → ('rng', stream, 'next', -1, value)
 *   `int(n)`  → ('rng', stream, 'int', n, value)
 *
 * mulberry32's `int` calls its own closure-local `next`, so `base.int(n)`
 * advances the underlying state once and is recorded once.
 */
export function countingTraceRng(
  base: Rng,
  trace: TraceCollector,
  stream: RngStream,
): CountingTraceRng {
  let draws = 0;
  const rng: Rng = {
    next(): number {
      const v = base.next();
      trace.record('rng.draw', stream, 'next', -1, v, draws);
      draws++;
      return v;
    },
    int(n: number): number {
      const v = base.int(n);
      trace.record('rng.draw', stream, 'int', n, v, draws);
      draws++;
      return v;
    },
  };
  return { rng, draws: () => draws };
}

// ---------------------------------------------------------------------------
// canonical digest of an arbitrary JSON-ish value (used for tree fingerprints)
// ---------------------------------------------------------------------------

export function sha256Canonical(value: unknown): string {
  const parts: string[] = [];
  const walk = (v: unknown): void => {
    if (v === null || v === undefined) { parts.push(encValue(v as Encodable)); return; }
    if (typeof v === 'number' || typeof v === 'string' || typeof v === 'boolean') {
      parts.push(encValue(v)); return;
    }
    if (Array.isArray(v)) { parts.push('['); for (const x of v) walk(x); parts.push(']'); return; }
    const o = v as Record<string, unknown>;
    parts.push('{');
    for (const k of Object.keys(o).sort()) { parts.push(JSON.stringify(k)); walk(o[k]); }
    parts.push('}');
  };
  walk(value);
  return createHash('sha256').update(parts.join('\u0001')).digest('hex');
}
