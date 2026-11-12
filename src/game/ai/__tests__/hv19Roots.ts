/// <reference types="node" />
/**
 * PPC-HV19 — frozen root / plan restoration for the ghost-gift screening study.
 *
 * Test-support module only. It restores the five PPC-HV14 Hard logs exactly as
 * the HV18/HV18R instruments do (printed SNAPSHOT_JSON + STATE_KEY), parses the
 * production plan per turn, and exposes the pre-registered plan set used by
 * HV19. No production source is imported for writing, no AI module is changed.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { GameEngineState } from '../../engine';
import { GamePhase, PieceType } from '../../types';
import { DIRECTIONS } from '../../types';
import { restoreHardRoot, type HardRootSnapshot } from '../hardHistory';
import { simulateSearchAction } from '../simulator';
import type { RuleSet, SearchAction } from '../searchTypes';

export const LOG_DIR = new URL('../../../../ai-training/human-logs/PPC-HV14/', import.meta.url);
export const GAMES = ['GAME1', 'GAME2', 'GAME3', 'GAME4', 'GAME5'] as const;
export type GameName = (typeof GAMES)[number];

export const LOG_SHA256: Record<GameName, string> = {
  GAME1: '2ac38df46877bdc17cc05f4a241e7e23811a43d8029f42db3a075d22f851f2e3',
  GAME2: '12cdbb6a6d1930e78b656d53d6675fe2db930d825e646c8b40dce0c4b11954c4',
  GAME3: 'a7598bf6403bf441f9624dc1fa9738aca820d6434d389a9507e2fdbf6af543d7',
  GAME4: '752b033310c773b5a2b0a7c153b09f5b7b467c4c3bc822e631f51aed15882b21',
  GAME5: 'f84d877ac4d3dedabda46b1774107f4533827c9e05e28d33b3dfc313909fe4b2',
};

export function logText(game: GameName): string {
  return readFileSync(new URL(`${game}_H1.txt`, LOG_DIR), 'utf8');
}

export function logSha(game: GameName): string {
  return createHash('sha256').update(readFileSync(new URL(`${game}_H1.txt`, LOG_DIR))).digest('hex');
}

export function parseTurnBlocks(text: string): { turn: number; lines: string[] }[] {
  const lines = text.split(/\r?\n/);
  const starts: number[] = [];
  lines.forEach((l, i) => {
    if (/^Turn #\d+$/.test(l.trim())) starts.push(i);
  });
  return starts.map((s, k) => ({
    turn: Number(/^Turn #(\d+)$/.exec(lines[s].trim())![1]),
    lines: lines.slice(s + 1, k + 1 < starts.length ? starts[k + 1] : lines.length),
  }));
}

export function field(lines: string[], prefix: string): string {
  return lines.find((l) => l.startsWith(prefix))?.slice(prefix.length).trim() ?? '';
}

export function parsePlanLine(line: string): SearchAction[] {
  const text = line.replace(/^PLAN:\s*/, '').trim();
  if (!text) return [];
  return text.split('→').map((part) => {
    const p = part.trim();
    if (p === 'catPlaceTrap') return { type: 'catPlaceTrap' } as SearchAction;
    const m = /^catStep Arrow(Up|Down|Left|Right)$/.exec(p);
    if (!m) throw new Error(`unparsed plan token: ${p}`);
    return { type: 'catStep', direction: DIRECTIONS.find((d) => d.key === `Arrow${m[1]}`)! } as SearchAction;
  });
}

/** The log prints the plan as one action per line under `PLAN:`. */
export function parsePlanBlock(lines: string[]): SearchAction[] {
  const start = lines.findIndex((l) => l.trim() === 'PLAN:');
  if (start < 0) return [];
  const out: SearchAction[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    const t = lines[i].trim();
    if (!t) continue;
    if (t === 'catPlaceTrap') { out.push({ type: 'catPlaceTrap' }); continue; }
    const m = /^catStep Arrow(Up|Down|Left|Right)$/.exec(t);
    if (m) {
      out.push({ type: 'catStep', direction: DIRECTIONS.find((d) => d.key === `Arrow${m[1]}`)! } as SearchAction);
      continue;
    }
    break; // next section
  }
  return out;
}

export interface Root {
  game: GameName;
  turn: number;
  state: GameEngineState;
  plan: SearchAction[];
  loggedKey: string;
  lines: string[];
}

export function restoreTurn(game: GameName, block: { turn: number; lines: string[] }): Root {
  const snap = JSON.parse(field(block.lines, 'SNAPSHOT_JSON=')) as HardRootSnapshot;
  return {
    game,
    turn: block.turn,
    state: restoreHardRoot(snap),
    plan: parsePlanLine(field(block.lines, 'PLAN:')).length > 0
      ? parsePlanLine(field(block.lines, 'PLAN:'))
      : parsePlanBlock(block.lines),
    loggedKey: field(block.lines, 'STATE_KEY='),
    lines: block.lines,
  };
}

export function rootOf(game: GameName, turn: number): Root {
  const block = parseTurnBlocks(logText(game)).find((b) => b.turn === turn);
  if (!block) throw new Error(`HV19 missing ${game} T${turn}`);
  return restoreTurn(game, block);
}

export function catStep(key: 'Up' | 'Down' | 'Left' | 'Right'): SearchAction {
  return { type: 'catStep', direction: DIRECTIONS.find((d) => d.key === `Arrow${key}`)! } as SearchAction;
}

export function mouseStep(key: 'Up' | 'Down' | 'Left' | 'Right'): SearchAction {
  return { type: 'mouseStep', direction: DIRECTIONS.find((d) => d.key === `Arrow${key}`)! } as SearchAction;
}

export const MOUSE_SKILL: SearchAction = { type: 'mouseSkill' };

export function actionLabel(a: SearchAction): string {
  switch (a.type) {
    case 'catStep':
    case 'mouseStep':
      return a.direction!.key.replace('Arrow', '').slice(0, 1);
    case 'catPlaceTrap':
      return 'T';
    case 'mouseSkill':
      return 'K';
    case 'chooseTunnel':
      return `X${a.r},${a.c}`;
  }
}

export function planText(plan: SearchAction[]): string {
  return plan.map(actionLabel).join('');
}

export interface BoundaryState {
  state: GameEngineState;
  weight: number;
}

export interface PlanApplication {
  ok: boolean;
  reason: string;
  steps: number;
  /** Raw cat end state after the final primitive (EXEC-comparable). */
  end: GameEngineState;
  /** Post-boundary hand-off state(s) with formal chance weights. */
  handoffs: BoundaryState[];
  /** Number of formal chance outcomes at the boundary (0 = deterministic). */
  chance: number;
}

/**
 * Apply a complete cat plan: raw primitives for the EXEC-comparable endpoint,
 * then the simulator's boundary transition (honest CHANCE node) for the
 * mouse-to-move hand-off. Mirrors the HV18 instrument, keeping weights.
 */
export function applyCatPlan(root: GameEngineState, plan: SearchAction[], rules: RuleSet): PlanApplication {
  let cur = root;
  let end = root;
  let steps = 0;
  let ok = true;
  let reason = 'full-turn';
  let handoffs: BoundaryState[] = [];
  let chance = 0;

  for (let i = 0; i < plan.length; i++) {
    const a = plan[i];
    const raw = a.type === 'catPlaceTrap'
      ? rules.catPlaceTrap(cur)
      : a.type === 'catStep'
        ? rules.catMove(cur, a.direction!)
        : null;
    if (!raw) { ok = false; reason = `illegal-step-${i + 1}`; break; }
    steps++;
    if (i === plan.length - 1) {
      end = raw;
      const before = cur;
      const res = simulateSearchAction(before, a, rules);
      if (res.kind === 'chance') {
        chance = res.outcomes.length;
        handoffs = res.outcomes.map((o) => ({ state: o.state, weight: o.weight }));
      } else {
        handoffs = [{ state: res.state, weight: 1 }];
      }
      break;
    }
    if (raw.phase !== GamePhase.Playing || raw.currentPlayer !== PieceType.Cat || raw.catMovesLeft <= 0) {
      ok = false;
      reason = `cat-turn-ended-at-step-${i + 1}`;
      end = raw;
      break;
    }
    cur = raw;
  }

  if (ok) {
    const boundary = end.phase !== GamePhase.Playing
      || end.currentPlayer !== PieceType.Cat
      || end.catMovesLeft <= 0;
    if (steps !== plan.length || !boundary) { ok = false; reason = 'cat-still-has-moves'; }
  }
  if (!ok) handoffs = [{ state: end, weight: 1 }];
  return { ok, reason, steps, end, handoffs, chance };
}

// ===========================================================================
// Production timing evidence (read-only): how much of the 150 ms turn is left
// after the main search and after the bounded sidecar.
// ===========================================================================

export interface ProductionTiming {
  turns: number;
  mainMs: number[];
  sidecarMs: number[];
  /** 150 − main search wall (time the sidecar could start with). */
  entrySlackMs: number[];
  /** 150 − main search wall − sidecar wall (residual after the sidecar). */
  residualMs: number[];
  sidecarAborts: number;
  deadlineReason: number;
  baselineNotRefuted: number;
}

export function productionTiming(): ProductionTiming {
  const mainMs: number[] = [];
  const sidecarMs: number[] = [];
  const entrySlackMs: number[] = [];
  const residualMs: number[] = [];
  let sidecarAborts = 0;
  let deadlineReason = 0;
  let baselineNotRefuted = 0;
  let turns = 0;

  // The per-turn records live under `[HARD_SEARCH_HISTORY]`, one `Turn #N`
  // block each (the `[HARD_SEARCH]` marker only precedes the trailing live
  // dump, which duplicates the last recorded turn).
  for (const game of GAMES) {
    for (const block of parseTurnBlocks(logText(game))) {
      const join = block.lines.join('\n');
      const deadline = /DEADLINE: .*?elapsedMs=([-\d.]+)/.exec(join);
      const main = deadline ? Number(deadline[1]) : NaN;
      if (!Number.isFinite(main)) continue;
      turns++;
      mainMs.push(main);
      entrySlackMs.push(150 - main);
      const ref = /refutationWallMs=([-\d.]+)/.exec(join);
      const refWall = ref ? Number(ref[1]) : 0;
      sidecarMs.push(refWall);
      residualMs.push(150 - main - refWall);
      const reason = /sidecarAbortReason=(\S+)/.exec(join)?.[1] ?? '';
      if (reason === 'deadline') { deadlineReason++; sidecarAborts++; }
      else if (reason === 'baseline_not_refuted') baselineNotRefuted++;
    }
  }
  return {
    turns, mainMs, sidecarMs, entrySlackMs, residualMs,
    sidecarAborts, deadlineReason, baselineNotRefuted,
  };
}

export function quantile(xs: number[], q: number): number {
  if (xs.length === 0) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const idx = Math.min(s.length - 1, Math.max(0, Math.ceil(q * s.length) - 1));
  return s[idx];
}
