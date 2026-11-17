/// <reference types="node" />
/**
 * PPC-CAT-STRATEGY-01 — shared tactical-forensics harness (RESEARCH ONLY).
 *
 * Nothing in this file is production code and nothing in `src/` is modified.
 * Every transition is produced by the REAL rule system:
 *   - `generatePreparedSearchActions` (the P2 candidate+transition source)
 *     which in turn calls `simulateSearchAction` → `createEngineRuleSet()`
 *     → engine.catMove / mouseStepDeterministic / mouseSkill / catPlaceTrap /
 *       chooseTunnelExit / endTurn / ghost-boundary enumeration.
 *
 * Quantifier contract implemented here (see REPORT §7):
 *   - `forced`   pass: MOUSE strategy vs (CAT strategy × CHANCE)
 *                      mouse = OR (max), cat = AND (min), chance = AND (min).
 *                      value === MOUSE_WIN  ⇒  MOUSE_FORCED_WIN_WITHIN_H.
 *   - `possible` pass: exists a path (∃ cat, ∃ mouse, ∃ chance)
 *                      every node = OR (max).
 *                      value === MOUSE_WIN  ⇒  MOUSE_WIN_WITNESS only.
 *
 * Horizon: `H` counts COMPLETE MOUSE TURNS. The node index `idx` increments on
 * every action-right change; the root is the cat turn (idx 0). A cat node that
 * would be reached with `idx >= 2*H` is OUTSIDE the horizon and is scored
 * SURVIVE (it is not a mouse win inside H).
 */
import { createEngineRuleSet } from '../../src/game/engine';
import { generatePreparedSearchActions } from '../../src/game/ai/preparedActions';
import { stateKey } from '../../src/game/ai/transposition';
import { applyNoMoveLoss } from '../../src/game/rules/mobility';
import { GamePhase, PieceType } from '../../src/game/types';
import type { GameEngineState } from '../../src/game/engine';
import type { SearchAction } from '../../src/game/ai/searchTypes';

export const rules = createEngineRuleSet();

/** Horizon values. UNRESOLVED (-1) only appears when a node cap fires. */
export const MOUSE_WIN = 2;
export const SURVIVE = 1;
export const CAT_WIN = 0;
export const UNRESOLVED = -1;

export type Verdict = typeof MOUSE_WIN | typeof SURVIVE | typeof CAT_WIN | typeof UNRESOLVED;

const DIR_LABEL: Record<string, string> = {
  ArrowUp: 'U', ArrowDown: 'D', ArrowLeft: 'L', ArrowRight: 'R',
};

export function label(a: SearchAction | null | undefined): string {
  if (!a) return '-';
  switch (a.type) {
    case 'catPlaceTrap': return 'T';
    case 'mouseSkill': return 'S';
    case 'chooseTunnel': return `t${a.r},${a.c}`;
    default: return DIR_LABEL[a.direction.key] ?? '?';
  }
}

/** Strip the trace decoration (`c:`/`m:` prefix, `~chance#N` suffix, `*` marker). */
export function parseLabel(raw: string): string {
  return raw.replace(/^[cm]:/, '').replace(/~chance#\d+$/, '').replace(/\*$/, '');
}

export interface ChanceRecord {
  key: string;
  kind: 'butter_pickup_announce' | 'ghost_boundary';
  actor: string;
  candidates: number;
  outcomes: number;
  weightSum: number;
  weightEach: number | null;
  positions: string[];
  note?: string;
}

export interface Stats {
  nodes: number;
  transitions: number;
  chanceNodes: number;
  chanceOutcomes: number;
  memoHits: number;
  cutoffs: number;
  prunes: number;
  truncated: boolean;
  maxIdx: number;
  elapsedMs: number;
}

export interface Ctx {
  H: number;
  pass: 'forced' | 'possible';
  cap: number;
  memo: Map<string, number>;
  stats: Stats;
  audit: Map<string, ChanceRecord> | null;
}

export function makeCtx(H: number, pass: 'forced' | 'possible', cap = 3_000_000, audit = false): Ctx {
  return {
    H, pass, cap,
    memo: new Map(),
    stats: {
      nodes: 0, transitions: 0, chanceNodes: 0, chanceOutcomes: 0,
      memoHits: 0, cutoffs: 0, prunes: 0, truncated: false, maxIdx: 0, elapsedMs: 0,
    },
    audit: audit ? new Map() : null,
  };
}

function combine(nodeKind: 'cat' | 'mouse' | 'chance', vs: number[], pass: 'forced' | 'possible'): number {
  const anyUnresolved = vs.some((v) => v === UNRESOLVED);
  // min/max ignore nothing: UNRESOLVED is -1, so `min` would swallow it.
  // Handle explicitly: a truncated subtree poisons the answer only when it
  // could change the extreme of the NON-truncated values.
  const real = vs.filter((v) => v !== UNRESOLVED);
  const useMin = nodeKind === 'chance' ? pass === 'forced' : nodeKind === 'cat';
  if (real.length === 0) return UNRESOLVED;
  const extreme = useMin ? Math.min(...real) : Math.max(...real);
  if (!anyUnresolved) return extreme;
  // Truncated siblings can only tighten an extreme we already cannot beat.
  if (useMin) return extreme === CAT_WIN ? extreme : UNRESOLVED;
  return extreme === MOUSE_WIN ? extreme : UNRESOLVED;
}

/**
 * SOUND optimism bound used as a prune: a mouse win requires entering a mouse
 * hole WHILE CARRYING butter, which needs at least Manhattan(mouse, nearest
 * hole) steps. Budget = current moves + every later mouse turn's maximum
 * (6 = 3 carrying + 3 skill bonus).
 *
 * Only applied when `mouseHasButter` is true: a non-carrying mouse could still
 * pick butter up, so the bound would not be valid there. Returning false simply
 * disables the prune (fail-open to full search).
 */
function cannotReachHoleInHorizon(s: GameEngineState, idx: number, H: number): boolean {
  if (!s.mouseHasButter) return false;
  let best = Number.POSITIVE_INFINITY;
  const h = s.config.mouseHole;
  for (let r = h.r; r < h.r + h.size; r++) {
    for (let c = h.c; c < h.c + h.size; c++) {
      const d = Math.abs(r - s.mousePosition.r) + Math.abs(c - s.mousePosition.c);
      if (d < best) best = d;
    }
  }
  const laterMouseTurns = Math.max(0, (2 * H - idx - 1) / 2);
  const budget = s.mouseMovesLeft + 6 * laterMouseTurns;
  return best > budget;
}

/** Core minimax over the REAL transition function, memoized on canonical stateKey. */
export function valueAt(state: GameEngineState, idx: number, ctx: Ctx): number {
  const s = applyNoMoveLoss(state);
  if (s.phase === GamePhase.MouseWins) return MOUSE_WIN;
  if (s.phase === GamePhase.CatWins) return CAT_WIN;
  if (s.currentPlayer === PieceType.Cat && idx >= 2 * ctx.H) return SURVIVE;

  const key = `${ctx.pass}|${idx}|${stateKey(s)}`;
  const memo = ctx.memo.get(key);
  if (memo !== undefined) {
    ctx.stats.memoHits++;
    return memo;
  }
  ctx.stats.nodes++;
  if (ctx.stats.nodes > ctx.cap) {
    ctx.stats.truncated = true;
    return UNRESOLVED;
  }
  if (idx > ctx.stats.maxIdx) ctx.stats.maxIdx = idx;

  const prepared = generatePreparedSearchActions(s, rules);
  if (prepared.length === 0) {
    // A Playing node whose actor has moves but no legal action is already
    // settled by applyNoMoveLoss, so this is a harness-level inconsistency.
    throw new Error(`no legal action at a live node: phase=${s.phase} player=${s.currentPlayer} ` +
      `catMoves=${s.catMovesLeft} mouseMoves=${s.mouseMovesLeft}`);
  }

  const isCat = s.currentPlayer === PieceType.Cat;

  // SOUND PRUNE (§11 RESEARCH_BOUND): no mouse win can occur inside the
  // horizon, so the node is scored SURVIVE. Never turns a win into a non-win.
  if (!isCat && cannotReachHoleInHorizon(s, idx, ctx.H)) {
    ctx.memo.set(key, SURVIVE);
    ctx.stats.prunes++;
    return SURVIVE;
  }

  const perAction: number[] = [];
  const cutAt = isCat ? CAT_WIN : MOUSE_WIN;
  let cut = false;

  for (const p of prepared) {
    ctx.stats.transitions++;
    const tr = p.transition;
    if (tr.kind === 'deterministic') {
      const childIdx = tr.state.currentPlayer !== s.currentPlayer ? idx + 1 : idx;
      perAction.push(valueAt(tr.state, childIdx, ctx));
    } else {
      ctx.stats.chanceNodes++;
      ctx.stats.chanceOutcomes += tr.outcomes.length;
      const childIdx = tr.outcomes[0].state.currentPlayer !== s.currentPlayer ? idx + 1 : idx;
      const vs: number[] = [];
      // Exact for min/max: once the extreme is reached, extra siblings cannot
      // change it. (forced chance = min, possible chance = max)
      const chanceCut = ctx.pass === 'forced' ? CAT_WIN : MOUSE_WIN;
      for (const o of tr.outcomes) {
        const v = valueAt(o.state, childIdx, ctx);
        vs.push(v);
        if (v === chanceCut) break;
      }

      if (ctx.audit) {
        const kind: ChanceRecord['kind'] = p.action.type === 'mouseStep'
          ? 'butter_pickup_announce'
          : 'ghost_boundary';
        const akey = `${kind}|${stateKey(s)}|${label(p.action)}`;
        if (!ctx.audit.has(akey) && ctx.audit.size < 4000) {
          const weights = tr.outcomes.map((o) => o.weight);
          const sum = weights.reduce((x, y) => x + y, 0);
          const each = weights.length > 0 && weights.every((w) => w === weights[0]) ? weights[0] : null;
          ctx.audit.set(akey, {
            key: stateKey(s).slice(0, 40),
            kind,
            actor: String(s.currentPlayer),
            candidates: tr.outcomes.length,
            outcomes: tr.outcomes.length,
            weightSum: sum,
            weightEach: each,
            positions: tr.outcomes.map((o) => {
              const ghosts = (o.state.pendingButterSpawns ?? []).map((g) => `${g.r},${g.c}`);
              const butters = o.state.butterPositions.map((b) => `${b.r},${b.c}`);
              return `ghosts[${ghosts.join(';')}] butters[${butters.join(';')}]`;
            }),
          });
        }
      }
      perAction.push(combine('chance', vs, ctx.pass));
    }
    if (perAction[perAction.length - 1] === cutAt) { cut = true; break; }
  }

  const nodeKind: 'cat' | 'mouse' = isCat ? 'cat' : 'mouse';
  const v = combine(nodeKind, perAction, ctx.pass);
  ctx.memo.set(key, v);
  if (cut) ctx.stats.cutoffs++;
  return v;
}

/** Follow the memoized optimal line; returns a concrete action path. */
export function tracePath(state: GameEngineState, idx: number, ctx: Ctx, maxLen = 64): string[] {
  const out: string[] = [];
  let s = applyNoMoveLoss(state);
  let i = idx;
  for (let step = 0; step < maxLen; step++) {
    if (s.phase !== GamePhase.Playing) { out.push(`END:${s.phase}`); break; }
    if (s.currentPlayer === PieceType.Cat && i >= 2 * ctx.H) { out.push('HORIZON'); break; }
    const prepared = generatePreparedSearchActions(s, rules);
    const useMin = s.currentPlayer === PieceType.Cat;
    let bestVal = useMin ? Number.POSITIVE_INFINITY : Number.NEGATIVE_INFINITY;
    let best: { action: SearchAction; state: GameEngineState; chanceNote?: string } | null = null;
    for (const p of prepared) {
      const tr = p.transition;
      let v: number;
      let childState: GameEngineState;
      let note: string | undefined;
      if (tr.kind === 'deterministic') {
        const cIdx = tr.state.currentPlayer !== s.currentPlayer ? i + 1 : i;
        v = valueAt(tr.state, cIdx, ctx);
        childState = tr.state;
      } else {
        const cIdx = tr.outcomes[0].state.currentPlayer !== s.currentPlayer ? i + 1 : i;
        const vs = tr.outcomes.map((o) => valueAt(o.state, cIdx, ctx));
        const pickMin = ctx.pass === 'forced';
        const target = pickMin ? Math.min(...vs) : Math.max(...vs);
        const at = vs.indexOf(target);
        v = combine('chance', vs, ctx.pass);
        childState = tr.outcomes[at].state;
        note = `[chance ${at + 1}/${tr.outcomes.length}]`;
      }
      const better = useMin ? v < bestVal : v > bestVal;
      if (better) { bestVal = v; best = { action: p.action, state: childState, chanceNote: note }; }
    }
    if (!best) { out.push('NO_ACTION'); break; }
    out.push(`${s.currentPlayer === PieceType.Cat ? 'c' : 'm'}:${label(best.action)}${best.chanceNote ?? ''}`);
    const childIdx = best.state.currentPlayer !== s.currentPlayer ? i + 1 : i;
    s = best.state;
    i = childIdx;
  }
  return out;
}

export interface RootEval {
  value: number;
  perAction: { action: string; value: number; path: string[] }[];
  stats: Stats;
  audit: ChanceRecord[];
}

/**
 * Evaluate one root: every legal FIRST cat action gets its own subgame value
 * under the selected pass, so the per-action table answers
 * "if the cat opens with X, can the mouse still force a win inside H?".
 */
export function evaluateRoot(root: GameEngineState, H: number, pass: 'forced' | 'possible',
  opts: { cap?: number; audit?: boolean; paths?: boolean } = {}): RootEval {
  const t0 = performance.now();
  const ctx = makeCtx(H, pass, opts.cap ?? 3_000_000, opts.audit ?? false);
  const prepared = generatePreparedSearchActions(applyNoMoveLoss(root), rules);
  const perAction: { action: string; value: number; path: string[] }[] = [];
  const values: number[] = [];
  for (const p of prepared) {
    const tr = p.transition;
    let v: number;
    if (tr.kind === 'deterministic') {
      const cIdx = tr.state.currentPlayer !== root.currentPlayer ? 1 : 0;
      v = valueAt(tr.state, cIdx, ctx);
    } else {
      const cIdx = tr.outcomes[0].state.currentPlayer !== root.currentPlayer ? 1 : 0;
      const vs = tr.outcomes.map((o) => valueAt(o.state, cIdx, ctx));
      v = combine('chance', vs, ctx.pass);
    }
    values.push(v);
    perAction.push({
      action: label(p.action),
      value: v,
      path: opts.paths ? tracePath(tr.kind === 'deterministic' ? tr.state : tr.outcomes[0].state,
        tr.kind === 'deterministic'
          ? (tr.state.currentPlayer !== root.currentPlayer ? 1 : 0)
          : (tr.outcomes[0].state.currentPlayer !== root.currentPlayer ? 1 : 0), ctx) : [],
    });
  }
  const value = combine('cat', values, ctx.pass);
  ctx.stats.elapsedMs = performance.now() - t0;
  return {
    value,
    perAction,
    stats: ctx.stats,
    audit: ctx.audit ? [...ctx.audit.values()] : [],
  };
}

/** Apply a labeled plan (U/D/L/R/T/S/tR,C) through the real rules; returns the
 *  per-step states so a witness can be replayed and asserted step by step. */
export function replay(root: GameEngineState, plan: string[]): { states: GameEngineState[]; ok: boolean; failedAt?: string } {
  const states: GameEngineState[] = [];
  let s = applyNoMoveLoss(root);
  for (const raw of plan) {
    const lbl = parseLabel(raw);
    const wantPlayer = raw.startsWith('c:') ? PieceType.Cat : raw.startsWith('m:') ? PieceType.Mouse : null;
    if (wantPlayer && s.currentPlayer !== wantPlayer && s.phase === GamePhase.Playing) {
      return { states, ok: false, failedAt: `${raw} (player mismatch: now ${s.currentPlayer})` };
    }
    if (s.phase !== GamePhase.Playing) return { states, ok: false, failedAt: `${lbl} (phase ${s.phase})` };
    const prepared = generatePreparedSearchActions(s, rules);
    const hit = prepared.find((p) => label(p.action) === lbl);
    if (!hit) return { states, ok: false, failedAt: `${lbl} (not legal at ${stateKey(s).slice(0, 24)})` };
    const tr = hit.transition;
    if (tr.kind === 'chance') return { states, ok: false, failedAt: `${lbl} (chance node — needs a branch)` };
    s = tr.state;
    states.push(s);
  }
  return { states, ok: true };
}

/** Legal action labels at a state (deterministic view; chance actions marked). */
export function legalLabels(state: GameEngineState): string[] {
  return generatePreparedSearchActions(applyNoMoveLoss(state), rules)
    .map((p) => label(p.action) + (p.transition.kind === 'chance' ? '*' : ''));
}

/** Board renderer used in every report so positions are human-checkable. */
export function renderBoard(s: GameEngineState): string[] {
  const lines: string[] = [];
  for (let r = 0; r < s.board.length; r++) {
    let line = '';
    for (let c = 0; c < s.board[r].length; c++) {
      const cell = s.board[r][c];
      let ch = '.';
      if (cell.type === 'box') ch = 'X';
      else if (cell.type === 'pile') ch = 'P';
      else if (cell.type === 'tunnel') ch = 'T';
      else if (cell.type === 'mouse_hole') ch = 'H';
      else if (cell.type === 'void') ch = 'V';
      else if (cell.type === 'wall') ch = 'W';
      if (s.catPosition.r === r && s.catPosition.c === c) ch = 'C';
      if (s.mousePosition.r === r && s.mousePosition.c === c) ch = 'M';
      if (s.butterPositions.some((p) => p.r === r && p.c === c)) ch = 'b';
      if ((s.pendingButterSpawns ?? []).some((p) => p.r === r && p.c === c)) ch = 'g';
      if (s.trapPosition && s.trapPosition.r === r && s.trapPosition.c === c) ch = 't';
      line += ch;
    }
    lines.push(`${String(r).padStart(2)} ${line}`);
  }
  lines.push('   ' + Array.from({ length: s.board.length }, (_, i) => i % 10).join(''));
  return lines;
}

/** Compact, audit-friendly summary of the fields that matter for a tactical root. */
export function summarize(s: GameEngineState) {
  return {
    phase: s.phase,
    currentPlayer: s.currentPlayer,
    cat: `${s.catPosition.r},${s.catPosition.c}`,
    mouse: `${s.mousePosition.r},${s.mousePosition.c}`,
    catMovesLeft: s.catMovesLeft,
    mouseMovesLeft: s.mouseMovesLeft,
    mouseHasButter: s.mouseHasButter,
    mouseSkillActive: s.mouseSkillActive,
    butterPositions: s.butterPositions.map((p) => `${p.r},${p.c}`),
    pendingButterSpawns: (s.pendingButterSpawns ?? []).map((p) => `${p.r},${p.c}:${p.blockedMaterializations}`),
    pendingButterPlacementDebt: s.pendingButterPlacementDebt ?? 0,
    trapPosition: s.trapPosition ? `${s.trapPosition.r},${s.trapPosition.c}` : null,
    catTrapsRemaining: s.catTrapsRemaining,
    blockedTunnels: s.blockedTunnels.map((p) => `${p.r},${p.c}`),
  };
}

/** Recursively key-sorted JSON. The frozen fixture's `canonicalSnapshotSha256`
 *  is sha256 over exactly this form (verified on all 24 roots). */
export function canonicalJson(value: unknown): string {
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') {
      const src = v as Record<string, unknown>;
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(src).sort()) out[k] = walk(src[k]);
      return out;
    }
    return v;
  };
  return JSON.stringify(walk(value));
}

export { stateKey };

// ============================================================================
// ONE-SIDED (POLICY) PROOFS
//
// §7 defines the two extreme classes as STRATEGY-EXISTENCE statements:
//   MOUSE_FORCED_WIN_WITHIN_H  ⇔  ∃ mouse strategy σ  ∀ cat, ∀ chance → MouseWins
//   CAT_SURVIVAL_CERTIFIED     ⇔  ∃ cat strategy τ    ∀ mouse, ∀ chance → ¬MouseWins
//
// Both are therefore PROVABLE by fixing one explicit strategy and exhaustively
// checking the opposing players' branches — no minimax over the mouse's own
// 10^4-sized action tree is needed for the ∀-side of the OTHER player.
// These verifiers are sound one-sided proofs: a success is a proof, a failure
// is only "this strategy does not work" (never "the strategy does not exist"),
// and the failure path is returned as a counterexample.
// ============================================================================

export type Policy = (s: GameEngineState) => SearchAction | null;

export interface VerifyResult {
  ok: boolean;
  verdict: 'PROVEN' | 'FAILED' | 'UNRESOLVED';
  leaves: number;
  branches: number;
  maxDepth: number;
  elapsedMs: number;
  counterexample: string[] | null;
  reason: string | null;
  policyFailures: number;
}

function holeCells(s: GameEngineState): { r: number; c: number }[] {
  const h = s.config.mouseHole;
  const out: { r: number; c: number }[] = [];
  for (let r = h.r; r < h.r + h.size; r++) for (let c = h.c; c < h.c + h.size; c++) out.push({ r, c });
  return out;
}

/** BFS distance field for the MOUSE (policy heuristic only; tunnels ignored). */
export function mouseDistMap(s: GameEngineState): Map<string, number> {
  const n = s.config.boardSize;
  const dist = new Map<string, number>();
  const hc = holeCells(s);
  const q: { r: number; c: number; d: number }[] = [];
  for (const h of hc) { dist.set(`${h.r},${h.c}`, 0); q.push({ r: h.r, c: h.c, d: 0 }); }
  const passable = (r: number, c: number) => {
    if (r < 0 || c < 0 || r >= n || c >= n) return false;
    const t = s.board[r][c].type;
    if (t === 'box' || t === 'pile' || t === 'wall' || t === 'void' || t === 'tunnel') return false;
    if (s.catPosition.r === r && s.catPosition.c === c) return false;
    if (s.trapPosition && s.trapPosition.r === r && s.trapPosition.c === c) return false;
    return true;
  };
  for (let i = 0; i < q.length; i++) {
    const cur = q[i];
    for (const d of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
      const nr = cur.r + d[0], nc = cur.c + d[1];
      if (!passable(nr, nc)) continue;
      const k = `${nr},${nc}`;
      if (dist.has(k)) continue;
      dist.set(k, cur.d + 1);
      q.push({ r: nr, c: nc, d: cur.d + 1 });
    }
  }
  return dist;
}

/** BFS distance field for the CAT (boxes are enterable only when pushable). */
export function catDistMap(s: GameEngineState, target: { r: number; c: number }): Map<string, number> {
  const n = s.config.boardSize;
  const dist = new Map<string, number>();
  if (target.r < 0 || target.c < 0 || target.r >= n || target.c >= n) return dist;
  const q: { r: number; c: number; d: number }[] = [{ r: target.r, c: target.c, d: 0 }];
  dist.set(`${target.r},${target.c}`, 0);
  const enterable = (r: number, c: number) => {
    if (r < 0 || c < 0 || r >= n || c >= n) return false;
    const t = s.board[r][c].type;
    if (t === 'pile' || t === 'wall' || t === 'void') return false;
    if (t === 'mouse_hole') return false;
    if (s.butterPositions.some((b) => b.r === r && b.c === c)) return false;
    return true; // empty / trap / box(push target) / mouse cell
  };
  for (let i = 0; i < q.length; i++) {
    const cur = q[i];
    for (const d of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
      const nr = cur.r + d[0], nc = cur.c + d[1];
      if (!enterable(nr, nc)) continue;
      const k = `${nr},${nc}`;
      if (dist.has(k)) continue;
      dist.set(k, cur.d + 1);
      q.push({ r: nr, c: nc, d: cur.d + 1 });
    }
  }
  return dist;
}

const DIR_ORDER = ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'] as const;

const DIRS: { lbl: string; dr: number; dc: number }[] = [
  { lbl: 'U', dr: -1, dc: 0 },
  { lbl: 'D', dr: 1, dc: 0 },
  { lbl: 'L', dr: 0, dc: -1 },
  { lbl: 'R', dr: 0, dc: 1 },
];

/** σ_hole — documented mouse policy: burn the butter only when the hole is out
 *  of reach this turn, then walk the shortest (tunnel-free) path to the hole.
 *  When NOT carrying, walk to the nearest entity butter first. */
export const policyMouseHole: Policy = (s) => {
  const legal = generatePreparedSearchActions(s, rules);
  const byLabel = new Map<string, SearchAction>();
  for (const p of legal) byLabel.set(label(p.action), p.action);

  if (s.mouseHasButter && !s.mouseSkillActive && s.mouseMovesLeft > 0) {
    const dm = mouseDistMap(s);
    const d = dm.get(`${s.mousePosition.r},${s.mousePosition.c}`);
    if (d === undefined || d > s.mouseMovesLeft) {
      const sk = byLabel.get('S');
      if (sk) return sk;
    }
  }

  // Target selection: hole when carrying, nearest entity butter otherwise.
  let targets: { r: number; c: number }[] = s.mouseHasButter ? holeCells(s) : s.butterPositions;
  if (targets.length === 0) targets = holeCells(s);

  let best: SearchAction | null = null;
  let bestKey = Number.POSITIVE_INFINITY;
  for (const dir of DIRS) {
    const act = byLabel.get(dir.lbl);
    if (!act) continue;
    const nr = s.mousePosition.r + dir.dr;
    const nc = s.mousePosition.c + dir.dc;
    let m = Number.POSITIVE_INFINITY;
    for (const t of targets) m = Math.min(m, Math.abs(t.r - nr) + Math.abs(t.c - nc));
    if (m < bestKey) { bestKey = m; best = act; }
  }
  return best;
};

/** τ_target — documented cat policy: one action per state, chosen to minimise
 *  the BFS distance from the resulting cat cell to `target` (deterministic
 *  U/D/L/R tie-break). Never places a trap. */
export function policyCatTarget(target: { r: number; c: number }): Policy {
  return (s) => {
    const legal = generatePreparedSearchActions(s, rules);
    if (legal.length === 0) return null;
    const dm = catDistMap(s, target);
    let best: SearchAction | null = null;
    let bestScore = Number.POSITIVE_INFINITY;
    for (const p of legal) {
      if (p.action.type !== 'catStep') continue;
      const tr = p.transition;
      if (tr.kind !== 'deterministic') continue;
      const pos = tr.state.catPosition;
      const d = dm.get(`${pos.r},${pos.c}`) ?? Number.POSITIVE_INFINITY;
      if (d < bestScore) { bestScore = d; best = p.action; }
    }
    if (best) return best;
    // No step improves: fall back to the first legal step (still a legal move).
    return legal.find((p) => p.action.type === 'catStep')?.action ?? legal[0].action;
  };
}

/**
 * τ_intercept — documented cat policy, REACTIVE (the fixed-target policy above
 * walks off the gate it just occupied, because every step strictly increases
 * its distance to the target).
 *
 * Gate-race rule: take the mouse's own shortest carry-aware route to the hole
 * (BFS over the mouse grid, the cat's CURRENT cell excluded), then for every
 * legal cat step score
 *      min over route cells p of ( catDist(catAfter, p) − mouseDist(p) )
 * i.e. "how many moves late would the cat be at the earliest gate it can still
 * contest". The step with the smallest slack wins; ties break U/D/L/R. A step
 * that arrives before the mouse yields a negative slack (a real cut-off).
 */
export function policyCatIntercept(): Policy {
  return (s) => {
    const legal = generatePreparedSearchActions(s, rules);
    if (legal.length === 0) return null;

    // 1. A capture (or a RULE-A stranding of the mouse) is always correct for a
    //    SURVIVAL policy — never skip it for a positional idea.
    for (const p of legal) {
      if (p.transition.kind === 'deterministic' && p.transition.state.phase === 'cat_wins') {
        return p.action;
      }
    }

    const dm = mouseDistMap(s);                       // mouse route distances
    const dc = catDistMap(s, s.catPosition);          // cat distances from here

    // Gate = the route cell the cat is LEAST late for (smallest slack).
    let gate: { r: number; c: number } | null = null;
    let gateSlack = Number.POSITIVE_INFINITY;
    for (const [k, md] of dm) {
      if (md > 14) continue;
      const [r, c] = k.split(',').map(Number);
      const cd = dc.get(k);
      if (cd === undefined) continue;
      const slack = cd - md;
      if (slack < gateSlack) { gateSlack = slack; gate = { r, c }; }
    }
    if (!gate) {
      return legal.find((p) => p.action.type === 'catStep')?.action ?? legal[0].action;
    }

    const dg = catDistMap(s, gate);                   // distance to the gate
    let best: SearchAction | null = null;
    let bestScore = Number.POSITIVE_INFINITY;
    let bestOnRoute = -1;
    for (const p of legal) {
      if (p.action.type !== 'catStep') continue;
      const tr = p.transition;
      if (tr.kind !== 'deterministic') continue;
      const pos = tr.state.catPosition;
      const key = `${pos.r},${pos.c}`;
      const score = dg.get(key) ?? Number.POSITIVE_INFINITY;
      // Tie-break: prefer a cell that is ON the mouse's own route, so the cat
      // oscillates across the chokepoint instead of walking away from it.
      const onRoute = dm.has(key) ? 1 : 0;
      if (score < bestScore || (score === bestScore && onRoute > bestOnRoute)) {
        bestScore = score; bestOnRoute = onRoute; best = p.action;
      }
    }
    if (best) return best;
    return legal.find((p) => p.action.type === 'catStep')?.action ?? legal[0].action;
  };
}

/** ∃σ ∀cat ∀chance → MouseWins within H. */
export function verifyMousePolicy(root: GameEngineState, policy: Policy, H: number,
  cap = 4_000_000, startIdx = 1): VerifyResult {
  const t0 = performance.now();
  let leaves = 0, branches = 0, maxDepth = 0, policyFailures = 0;
  let counterexample: string[] | null = null;
  let reason: string | null = null;
  let exhausted = false;
  // The policy is a pure function of the state, and the same mouse state is
  // reached through many different cat orderings — cache it (the BFS inside
  // costs far more than a stateKey).
  const polCache = new Map<string, SearchAction | null>();
  const pol = (s: GameEngineState): SearchAction | null => {
    const k = stateKey(s);
    if (polCache.has(k)) return polCache.get(k)!;
    const a = policy(s);
    polCache.set(k, a);
    return a;
  };

  const walk = (state: GameEngineState, idx: number, path: string[]): boolean => {
    if (exhausted) return false;
    leaves++;
    if (leaves > cap) { exhausted = true; reason = 'NODE_CAP'; return false; }
    if (path.length > maxDepth) maxDepth = path.length;
    const s = applyNoMoveLoss(state);
    if (s.phase === GamePhase.MouseWins) return true;
    if (s.phase === GamePhase.CatWins) {
      if (!counterexample) { counterexample = [...path, 'END:cat_wins']; reason = 'CAT_WINS'; }
      return false;
    }
    if (s.currentPlayer === PieceType.Cat && idx >= 2 * H) {
      if (!counterexample) { counterexample = [...path, 'HORIZON']; reason = 'HORIZON_REACHED'; }
      return false;
    }
    const isCat = s.currentPlayer === PieceType.Cat;
    if (isCat) {
      branches++;
      const prepared = generatePreparedSearchActions(s, rules);
      for (const p of prepared) {
        const tr = p.transition;
        if (tr.kind === 'chance') {
          // The last cat step can END the turn into a ghost-butter boundary,
          // which is a CHANCE node. Every positive-probability outcome is a
          // branch that the mouse strategy must survive.
          const ci = tr.outcomes[0].state.currentPlayer !== s.currentPlayer ? idx + 1 : idx;
          for (let i = 0; i < tr.outcomes.length; i++) {
            if (!walk(tr.outcomes[i].state, ci, [...path, `c:${label(p.action)}~chance#${i + 1}`])) return false;
          }
          continue;
        }
        const ci = tr.state.currentPlayer !== s.currentPlayer ? idx + 1 : idx;
        if (!walk(tr.state, ci, [...path, `c:${label(p.action)}`])) return false;
      }
      return true;
    }

    const act = pol(s);
    if (!act) {
      policyFailures++;
      if (!counterexample) { counterexample = [...path, 'POLICY_NULL']; reason = 'POLICY_NULL'; }
      return false;
    }
    const hit = generatePreparedSearchActions(s, rules).find((p) => label(p.action) === label(act));
    if (!hit) {
      policyFailures++;
      if (!counterexample) { counterexample = [...path, `POLICY_ILLEGAL:${label(act)}`]; reason = 'POLICY_ILLEGAL'; }
      return false;
    }
    const tr = hit.transition;
    if (tr.kind === 'chance') {
      const ci = tr.outcomes[0].state.currentPlayer !== s.currentPlayer ? idx + 1 : idx;
      for (let i = 0; i < tr.outcomes.length; i++) {
        if (!walk(tr.outcomes[i].state, ci, [...path, `m:${label(act)}~chance#${i + 1}`])) return false;
      }
      return true;
    }
    const ci = tr.state.currentPlayer !== s.currentPlayer ? idx + 1 : idx;
    return walk(tr.state, ci, [...path, `m:${label(act)}`]);
  };

  const ok = walk(root, startIdx, []);
  const verdict: VerifyResult['verdict'] = exhausted ? 'UNRESOLVED' : ok ? 'PROVEN' : 'FAILED';
  return { ok, verdict, leaves, branches, maxDepth, elapsedMs: performance.now() - t0,
    counterexample, reason, policyFailures };
}

/** Apply a fixed action PREFIX through the real rules, branching on every
 *  CHANCE node the prefix crosses (a cat turn can end at a ghost boundary).
 *  Returns the resulting states plus the horizon index each one sits at, so the
 *  caller can verify a tail policy from exactly that point. Deliberately
 *  stateless — unlike a scripted closure it cannot be corrupted by DFS
 *  backtracking inside the verifier. */
export function applyPrefixBranches(root: GameEngineState, prefix: string[],
  startIdx = 0): { states: GameEngineState[]; idx: number[]; ok: boolean; failedAt?: string } {
  let frontier: { state: GameEngineState; idx: number }[] = [{ state: applyNoMoveLoss(root), idx: startIdx }];
  for (const want of prefix) {
    const next: { state: GameEngineState; idx: number }[] = [];
    for (const f of frontier) {
      const s = f.state;
      if (s.phase !== GamePhase.Playing) return { states: [], idx: [], ok: false, failedAt: `${want} (phase ${s.phase})` };
      // Accept the `legalLabels` decoration: a trailing '*' only marks "this
      // transition is a CHANCE node", it is not part of the action identity.
      const bare = want.replace(/\*$/, '');
      const hit = generatePreparedSearchActions(s, rules).find((p) => label(p.action) === bare);
      if (!hit) return { states: [], idx: [], ok: false, failedAt: `${want} (illegal at ${stateKey(s).slice(0, 30)})` };
      const tr = hit.transition;
      if (tr.kind === 'chance') {
        const ci = tr.outcomes[0].state.currentPlayer !== s.currentPlayer ? f.idx + 1 : f.idx;
        for (const o of tr.outcomes) next.push({ state: applyNoMoveLoss(o.state), idx: ci });
      } else {
        const ci = tr.state.currentPlayer !== s.currentPlayer ? f.idx + 1 : f.idx;
        next.push({ state: applyNoMoveLoss(tr.state), idx: ci });
      }
    }
    frontier = next;
  }
  return { states: frontier.map((f) => f.state), idx: frontier.map((f) => f.idx), ok: true };
}

/** ∃τ ∀mouse ∀chance → no MouseWins within H. */
export function verifyCatPolicy(root: GameEngineState, policy: Policy, H: number,
  cap = 12_000_000, startIdx = 0): VerifyResult {
  const t0 = performance.now();
  let leaves = 0, branches = 0, maxDepth = 0, policyFailures = 0, pruned = 0;
  let counterexample: string[] | null = null;
  let reason: string | null = null;
  let exhausted = false;

  // "No mouse win in the remaining horizon" is a pure predicate of (state, idx),
  // so a TRUE result may be reused freely; a FALSE result aborts the run anyway.
  const okMemo = new Set<string>();
  const prepCache = new Map<string, ReturnType<typeof generatePreparedSearchActions>>();
  const polCache = new Map<string, SearchAction | null>();

  const prep = (st: GameEngineState, k: string) => {
    let v = prepCache.get(k);
    if (!v) {
      v = generatePreparedSearchActions(st, rules);
      prepCache.set(k, v);
    }
    return v;
  };
  const pol = (st: GameEngineState, k: string): SearchAction | null => {
    if (polCache.has(k)) return polCache.get(k)!;
    const a = policy(st);
    polCache.set(k, a);
    return a;
  };

  const walk = (state: GameEngineState, idx: number, path: string[]): boolean => {
    if (exhausted) return false;
    leaves++;
    if (leaves > cap) { exhausted = true; reason = reason ?? 'NODE_CAP'; return false; }
    if (path.length > maxDepth) maxDepth = path.length;
    const s = applyNoMoveLoss(state);
    if (s.phase === GamePhase.MouseWins) {
      if (!counterexample) { counterexample = [...path, 'END:mouse_wins']; reason = 'MOUSE_WINS'; }
      return false;
    }
    if (s.phase === GamePhase.CatWins) return true;
    if (s.currentPlayer === PieceType.Cat && idx >= 2 * H) return true; // survived horizon
    const isCat = s.currentPlayer === PieceType.Cat;

    if (!isCat && cannotReachHoleInHorizon(s, idx, H)) { pruned++; return true; }

    const key = `${idx}|${stateKey(s)}`;
    if (!isCat) {
      if (okMemo.has(key)) return true;
    }

    if (isCat) {
      const act = pol(s, key);
      if (!act) { policyFailures++; reason = 'POLICY_NULL'; return false; }
      const hit = prep(s, key).find((p) => label(p.action) === label(act));
      if (!hit) { policyFailures++; reason = `POLICY_ILLEGAL:${label(act)}`; return false; }
      const tr = hit.transition;
      if (tr.kind === 'chance') {
        const ci = tr.outcomes[0].state.currentPlayer !== s.currentPlayer ? idx + 1 : idx;
        for (let i = 0; i < tr.outcomes.length; i++) {
          if (!walk(tr.outcomes[i].state, ci, [...path, `c:${label(act)}~chance#${i + 1}`])) return false;
        }
        return true;
      }
      const ci = tr.state.currentPlayer !== s.currentPlayer ? idx + 1 : idx;
      return walk(tr.state, ci, [...path, `c:${label(act)}`]);
    }

    // mouse node: ALL legal actions (this IS the ∀mouse quantifier)
    branches++;
    for (const p of prep(s, key)) {
      const tr = p.transition;
      if (tr.kind === 'chance') {
        const ci = tr.outcomes[0].state.currentPlayer !== s.currentPlayer ? idx + 1 : idx;
        for (let i = 0; i < tr.outcomes.length; i++) {
          if (!walk(tr.outcomes[i].state, ci, [...path, `m:${label(p.action)}~chance#${i + 1}`])) return false;
        }
      } else {
        const ci = tr.state.currentPlayer !== s.currentPlayer ? idx + 1 : idx;
        if (!walk(tr.state, ci, [...path, `m:${label(p.action)}`])) return false;
      }
    }
    okMemo.add(key);
    return true;
  };

  const ok = walk(root, startIdx, []);
  const verdict: VerifyResult['verdict'] = exhausted ? 'UNRESOLVED' : ok ? 'PROVEN' : 'FAILED';
  return { ok, verdict, leaves, branches, maxDepth, elapsedMs: performance.now() - t0,
    counterexample, reason, policyFailures };
}


// ============================================================================
// EXACT BOOLEAN QUANTIFIER SEARCH (the authoritative MOUSE_FORCED_WIN decision)
//
//   mouseForcesWin(s) = ∃ mouse action · [ ∀ chance outcome · ∀ cat action ...
//                                       ... ] → MouseWins within H
//
// Node rules:  mouse ⇒ OR (break on true)
//              cat   ⇒ AND (break on false)
//              chance⇒ AND (break on false)   [all positive-probability outcomes]
//
// Boolean polarity is what makes this affordable: a CAT node stops at the FIRST
// move that denies the mouse, which is the common case, whereas the 3-valued
// lattice had to keep going to distinguish CAT_WIN from SURVIVE. The result is
// EXACT for "can the mouse force a win inside H", which is the only question the
// classification needs. `false` ⇒ CAT_SURVIVAL_CERTIFIED_WITHIN_H (the cat has
// a strategy that denies the mouse at every branch, and the search just found
// it by refutation).
// ============================================================================

export interface ForcedResult {
  value: boolean | null;          // null = UNRESOLVED (node cap)
  stats: Stats;
}

export type WinSide = 'mouse' | 'cat';

/**
 * Generic exact boolean quantifier for "SIDE can force a win inside H".
 *
 *   side='mouse'  ⇒  ∃σ_m ∀σ_c ∀chance  → MouseWins    (§7.2)
 *   side='cat'    ⇒  ∃σ_c ∀σ_m ∀chance  → CatWins      (§7.4)
 *
 * Node polarity flips with the side; CHANCE is ALWAYS AND because "forced"
 * quantifies over every positive-probability outcome regardless of the side.
 * Depth cut: a cat node at idx >= 2H is outside the window, so neither side can
 * win there — return false for both sides (CAT_FORCED_WIN_WITHIN_H is thereby
 * scoped to the same window as the mouse question).
 */
export function forcesWinWithin(root: GameEngineState, H: number, startIdx: number,
  cap: number, side: WinSide): ForcedResult {
  const t0 = performance.now();
  const memo = new Map<string, boolean>();
  // NOTE (memory): do NOT cache prepared actions here. Every visited node
  // computes them exactly once (memo hits return before this point), so a cache
  // buys nothing while pinning every transition's child state alive — that is
  // what blew the 4 GB heap on root G2T7 at ~500k nodes.
  const stats: Stats = {
    nodes: 0, transitions: 0, chanceNodes: 0, chanceOutcomes: 0, memoHits: 0,
    cutoffs: 0, prunes: 0, truncated: false, maxIdx: 0, elapsedMs: 0,
  };
  const wantMouse = side === 'mouse';

  const walk = (state: GameEngineState, idx: number): boolean | null => {
    if (stats.truncated) return null;
    const s = applyNoMoveLoss(state);
    if (s.phase === GamePhase.MouseWins) return true;
    if (s.phase === GamePhase.CatWins) return false;
    if (s.currentPlayer === PieceType.Cat && idx >= 2 * H) return false; // horizon
    if (wantMouse && s.currentPlayer === PieceType.Mouse && cannotReachHoleInHorizon(s, idx, H)) {
      stats.prunes++;
      return false;
    }

    const key = `${idx}|${stateKey(s)}`;
    const hit = memo.get(key);
    if (hit !== undefined) { stats.memoHits++; return hit; }

    stats.nodes++;
    if (stats.nodes > cap) { stats.truncated = true; return null; }
    if (idx > stats.maxIdx) stats.maxIdx = idx;

    const prepared = generatePreparedSearchActions(s, rules);
    if (prepared.length === 0) throw new Error(`no legal action at live node ${key.slice(0, 40)}`);

    const isCat = s.currentPlayer === PieceType.Cat;
    // OR when the mover IS the side we are proving for, AND otherwise.
    const isOr = isCat === (side === 'cat');
    const acc = !isOr;                      // AND identity = true, OR identity = false
    let result: boolean | null = acc;
    let sawNull = false;
    let decided = false;

    for (const p of prepared) {
      stats.transitions++;
      const tr = p.transition;
      let childOutcome: boolean | null;
      if (tr.kind === 'deterministic') {
        const ci = tr.state.currentPlayer !== s.currentPlayer ? idx + 1 : idx;
        childOutcome = walk(tr.state, ci);
      } else {
        stats.chanceNodes++;
        stats.chanceOutcomes += tr.outcomes.length;
        const ci = tr.outcomes[0].state.currentPlayer !== s.currentPlayer ? idx + 1 : idx;
        let all = true;
        for (const o of tr.outcomes) {
          const v = walk(o.state, ci);
          if (v === null) { all = false; sawNull = true; break; }
          if (v === false) { all = false; break; }   // CHANCE is always AND
        }
        childOutcome = all;
      }
      if (childOutcome === null) { sawNull = true; continue; }

      if (isOr) {
        // One winning move proves the side CAN force a win here.
        if (childOutcome === true) { result = true; stats.cutoffs++; decided = true; break; }
        result = false;
      } else {
        // One denying move proves the side cannot force a win here.
        if (childOutcome === false) { result = false; stats.cutoffs++; decided = true; break; }
        result = true;
      }
    }

    // A truncated sibling can only leave the answer open (a cut is definitive).
    if (sawNull && !decided) { return null; }
    memo.set(key, result as boolean);
    return result;
  };

  const value = walk(root, startIdx);
  stats.elapsedMs = performance.now() - t0;
  return { value, stats };
}

/** §7.2 — ∃ mouse strategy such that ∀ cat play, ∀ chance → MouseWins within H. */
export function mouseForcesWin(root: GameEngineState, H: number, startIdx: number,
  cap = 8_000_000): ForcedResult {
  return forcesWinWithin(root, H, startIdx, cap, 'mouse');
}

/** §7.4 — ∃ cat strategy such that ∀ mouse play, ∀ chance → CatWins within H. */
export function catForcesWin(root: GameEngineState, H: number, startIdx: number,
  cap = 8_000_000): ForcedResult {
  return forcesWinWithin(root, H, startIdx, cap, 'cat');
}

/**
 * Trace one concrete CAT DEFENSE line from an already-solved root: at every cat
 * node take the child whose value is `false` (the move that denies the mouse);
 * at every mouse node follow the first legal action (the mouse is the ∀-side, so
 * any of its lines must be denied). Returns the labels along that line.
 */
export function traceCatDefense(root: GameEngineState, H: number, startIdx: number,
  cap = 8_000_000): string[] {
  void cap;
  const memo = new Map<string, boolean>();
  const walk = (state: GameEngineState, idx: number): boolean => {
    const s = applyNoMoveLoss(state);
    if (s.phase === GamePhase.MouseWins) return true;
    if (s.phase === GamePhase.CatWins) return false;
    if (s.currentPlayer === PieceType.Cat && idx >= 2 * H) return false;
    if (s.currentPlayer === PieceType.Mouse && cannotReachHoleInHorizon(s, idx, H)) return false;
    const key = `${idx}|${stateKey(s)}`;
    const hit = memo.get(key);
    if (hit !== undefined) return hit;
    const prepared = generatePreparedSearchActions(s, rules);
    const isCat = s.currentPlayer === PieceType.Cat;
    let acc = isCat;
    for (const p of prepared) {
      const tr = p.transition;
      let av: boolean;
      if (tr.kind === 'deterministic') {
        av = walk(tr.state, tr.state.currentPlayer !== s.currentPlayer ? idx + 1 : idx);
      } else {
        const ci = tr.outcomes[0].state.currentPlayer !== s.currentPlayer ? idx + 1 : idx;
        av = true;
        for (const o of tr.outcomes) { if (!walk(o.state, ci)) { av = false; break; } }
      }
      if (isCat) { if (!av) { acc = false; break; } acc = true; }
      else { if (av) { acc = true; break; } acc = false; }
    }
    memo.set(key, acc);
    return acc;
  };

  const out: string[] = [];
  let s = applyNoMoveLoss(root);
  let i = startIdx;
  for (let step = 0; step < 80; step++) {
    if (s.phase !== GamePhase.Playing) { out.push(`END:${s.phase}`); break; }
    if (s.currentPlayer === PieceType.Cat && i >= 2 * H) { out.push('HORIZON'); break; }
    const prepared = generatePreparedSearchActions(s, rules);
    const isCat = s.currentPlayer === PieceType.Cat;
    let chosen: { lbl: string; state: GameEngineState } | null = null;
    for (const p of prepared) {
      const tr = p.transition;
      if (tr.kind === 'chance') {
        const ci = tr.outcomes[0].state.currentPlayer !== s.currentPlayer ? i + 1 : i;
        const allDeny = tr.outcomes.every((o) => walk(o.state, ci) === false);
        const anyWin = tr.outcomes.some((o) => walk(o.state, ci) === true);
        if (isCat ? allDeny : (chosen === null && !anyWin)) {
          chosen = { lbl: `c:${label(p.action)}~chance#1`, state: tr.outcomes[0].state };
          break;
        }
        continue;
      }
      const ci = tr.state.currentPlayer !== s.currentPlayer ? i + 1 : i;
      const v = walk(tr.state, ci);
      if (isCat) {
        if (v === false) { chosen = { lbl: `c:${label(p.action)}`, state: tr.state }; break; }
      } else if (chosen === null && v === false) {
        chosen = { lbl: `m:${label(p.action)}`, state: tr.state };
      }
    }
    if (!chosen) { out.push('STOP'); break; }
    out.push(chosen.lbl);
    const nextIdx = chosen.state.currentPlayer !== s.currentPlayer ? i + 1 : i;
    s = chosen.state;
    i = nextIdx;
  }
  return out;
}

/**
 * Branch-aware replay: applies a mixed cat/mouse label plan through the REAL
 * rules, choosing an explicit CHANCE outcome index at every chance node and
 * recording what was chosen. Used for the mouse-escape witness, which is
 * "∃ cat line × ∃ chance branch × ∃ mouse line → MouseWins".
 */
export function replayBranch(root: GameEngineState, plan: string[], pick = 0): {
  states: GameEngineState[]; log: string[]; ok: boolean; failedAt?: string; finalPhase: string;
  /** Complete legal action set at every replayed decision point (TACT-4 evidence). */
  legalSets: string[][];
  /** Horizon index *after* each replayed step. */
  idxAfter: number[];
} {
  const states: GameEngineState[] = [];
  const log: string[] = [];
  const legalSets: string[][] = [];
  const idxAfter: number[] = [];
  let s = applyNoMoveLoss(root);
  let i = 0;
  for (const raw of plan) {
    const want = parseLabel(raw);
    const wantPlayer = raw.startsWith('c:') ? PieceType.Cat : raw.startsWith('m:') ? PieceType.Mouse : null;
    if (wantPlayer && s.currentPlayer !== wantPlayer && s.phase === GamePhase.Playing) {
      return { states, log, ok: false, failedAt: `${raw} (player mismatch: now ${s.currentPlayer})`, finalPhase: s.phase, legalSets, idxAfter };
    }
    if (s.phase !== GamePhase.Playing) return { states, log, ok: false, failedAt: `${want} (phase ${s.phase})`, finalPhase: s.phase, legalSets, idxAfter };
    const prepared = generatePreparedSearchActions(s, rules);
    legalSets.push(prepared.map((p) => label(p.action)));
    const hit = prepared.find((p) => label(p.action) === want);
    if (!hit) return { states, log, ok: false, failedAt: `${want} (illegal: legal=${prepared.map((p) => label(p.action)).join(',')})`, finalPhase: s.phase, legalSets, idxAfter };
    const tr = hit.transition;
    if (tr.kind === 'chance') {
      const idx = Math.min(pick, tr.outcomes.length - 1);
      const o = tr.outcomes[idx];
      const ghosts = (o.state.pendingButterSpawns ?? []).map((g) => `${g.r},${g.c}`).join(';') || '-';
      log.push(`CHANCE ${want}: ${tr.outcomes.length} outcomes, picked #${idx + 1} weight=${o.weight.toFixed(6)} ghosts=[${ghosts}]`);
      i = o.state.currentPlayer !== s.currentPlayer ? i + 1 : i;
      s = applyNoMoveLoss(o.state);
    } else {
      i = tr.state.currentPlayer !== s.currentPlayer ? i + 1 : i;
      s = applyNoMoveLoss(tr.state);
    }
    states.push(s);
    idxAfter.push(i);
  }
  return { states, log, ok: true, finalPhase: s.phase, legalSets, idxAfter };
}
