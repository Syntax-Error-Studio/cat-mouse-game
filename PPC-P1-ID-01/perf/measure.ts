/// <reference types="node" />
/**
 * PPC-P1-ID-01 — shared measurement harness for the frozen fixed-D1 timing
 * protocol (PREREGISTRATION_DRAFT.json `fixed_work` / `timing`).
 *
 * NOT a gate by itself: it only produces the per-repetition totals that the
 * external statistics step consumes. One fresh Node process per repetition,
 * both arms measured in that process with per-root alternating order, warmup
 * outside the measured span, state restore and context creation outside the
 * measured span.
 */
import { readFileSync } from 'node:fs';

export const ROOT_FIXTURE = new URL('../../src/game/ai/__tests__/fixtures/ppcId01-human-roots.json', import.meta.url);

export interface RootRecord {
  id: string;
  state: unknown;
}

export interface Arm {
  name: string;
  rules: unknown;
  restoreRoot(snap: unknown): unknown;
  createContext(rules: unknown): unknown;
  search(state: unknown, depth: number, ctx: unknown): {
    value: number;
    mate: string | null;
    action: unknown;
    completed: boolean;
  };
  label(a: unknown): string;
}

export function loadRoots(): RootRecord[] {
  return JSON.parse(readFileSync(ROOT_FIXTURE, 'utf8')) as RootRecord[];
}

/** Left-rotate by `r` (protocol: rotation by zero-based repetition index mod 24). */
export function rotate<T>(xs: T[], r: number): T[] {
  const k = ((r % xs.length) + xs.length) % xs.length;
  return [...xs.slice(k), ...xs.slice(0, k)];
}

function timeOne(arm: Arm, snap: unknown): { ms: number; sig: string } {
  const state = arm.restoreRoot(snap);
  const ctx = arm.createContext(arm.rules);
  const t0 = performance.now();
  const res = arm.search(state, 1, ctx);
  const ms = performance.now() - t0;
  return { ms, sig: `${res.value}|${res.mate}|${arm.label(res.action)}|${res.completed}` };
}

export interface RepetitionResult {
  rep: number;
  totalA: number;
  totalB: number;
  perRoot: { id: string; order: string; a: number; b: number; sigA: string; sigB: string }[];
}

export function runRepetition(a: Arm, b: Arm, rep: number, warmups = 2, emit = true): RepetitionResult {
  const roots = rotate(loadRoots(), rep);

  for (let w = 0; w < warmups; w++) {
    for (const rec of roots) {
      timeOne(a, rec.state);
      timeOne(b, rec.state);
    }
  }

  const perRoot: RepetitionResult['perRoot'] = [];
  let totalA = 0;
  let totalB = 0;
  for (let i = 0; i < roots.length; i++) {
    const rec = roots[i];
    const aFirst = (rep + i) % 2 === 0;
    let ra: { ms: number; sig: string };
    let rb: { ms: number; sig: string };
    if (aFirst) {
      ra = timeOne(a, rec.state);
      rb = timeOne(b, rec.state);
    } else {
      rb = timeOne(b, rec.state);
      ra = timeOne(a, rec.state);
    }
    totalA += ra.ms;
    totalB += rb.ms;
    perRoot.push({ id: rec.id, order: aFirst ? 'A_B' : 'B_A', a: ra.ms, b: rb.ms, sigA: ra.sig, sigB: rb.sig });
  }

  const result: RepetitionResult = { rep, totalA, totalB, perRoot };
  if (emit) console.log(`PPC_PERF ${JSON.stringify(result)}`);
  return result;
}

export function repFromEnv(): number {
  const raw = process.env.PPC_REP;
  if (raw === undefined) throw new Error('PPC_REP must be set');
  return Number(raw);
}
