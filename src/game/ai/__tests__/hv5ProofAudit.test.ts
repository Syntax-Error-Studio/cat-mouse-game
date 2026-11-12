/// <reference types="node" />
/**
 * PPC-HV-5 §3 — P0 audit of the HV-4 forced-loss prover.
 *
 * Everything here is forensics: real engine steps, one root at a time, no search,
 * no chance oracle, no benchmark. Each test names the proposition it decides and
 * prints the numbers the report quotes.
 */
import { expect, test } from 'vitest';
import { setWorldEntropySource } from '../../engine';
import { GamePhase } from '../../types';
import type { GameEngineState } from '../../engine';
import {
  auditMouseLine,
  boardText,
  candidateMouseLines,
  enumerateCatTurnExact,
  handOffToMouse,
  h1Turn,
  hv4LegacyProbeMouseLine,
  rc,
  replayCatPlan,
  withCatAt,
  type AuditResult,
} from './hv5ForcedLineAuditor';

/** The mouse line HV-4 proved at Turn #5: (1,8) carrying → (7,8), 6 steps, 2 turns. */
const T5_LINE = ['2,8', '3,8', '4,8', '5,8', '6,8', '7,8'];

const summary = (r: AuditResult): string =>
  `${r.outcome} turns=${r.catTurns} nodes=${r.nodes} branches=${r.branches}`
  + ` wins=${r.wins} broken=${r.broken} continued=${r.continued} captures=${r.captures}`
  + ` witness=[${r.witnessPlan ? r.witnessPlan.join('') : '-'}] :: ${r.detail}`;

/** Run `fn` with the world's randomness pinned, so verdicts are reproducible. */
function withEntropy<T>(draw: () => number, fn: () => T): T {
  setWorldEntropySource(draw);
  try { return fn(); } finally { setWorldEntropySource(null); }
}

/** The cat's turn-1 end cells, with and without ghost materialisation. */
function reachableCatEnds(root: GameEngineState, maximizeCatPower: boolean): string[] {
  const turn = enumerateCatTurnExact([{ state: root, plan: [] }], 60_000);
  const cells = new Set<string>();
  for (const e of turn.ends) cells.add(rc(handOffToMouse(e.state, maximizeCatPower).catPosition));
  return [...cells].sort();
}

test('HV5-A1. a position where one cat plan stops the line is NOT reported as forced', () => {
  // Same board, same mouse line, cat parked at (6,9): plan UUUL ends on the line
  // cell (3,8) while plan UUUU does nothing — ∃ plan stops the line, ∃ plan allows
  // it, so the ∀ is false and a sound prover must refuse to call the root lost.
  const t5 = h1Turn(5);
  const root = withCatAt(t5.state, 6, 9);
  const lineCells = new Set(T5_LINE);

  const audited = withEntropy(() => 0, () =>
    auditMouseLine(root, T5_LINE, { nodeCap: 60_000, maximizeCatPower: true }));
  const legacy = withEntropy(() => 0, () => hv4LegacyProbeMouseLine(root, T5_LINE, 200_000));

  // eslint-disable-next-line no-console
  console.log(
    `\nHV5-A1 counterexample root (T5 board, cat moved to ${rc(root.catPosition)}):\n${boardText(root)}`
    + `\n  line       : ${T5_LINE.join(' → ')}`
    + `\n  AUDITED    : ${summary(audited)}`
    + `\n  HV-4 LEGACY: ${legacy.outcome} :: ${legacy.refutation} (nodes=${legacy.nodes})`,
  );

  expect(audited.outcome, 'a blockable line must not be called forced').toBe('NOT_FORCED');
  expect(audited.witnessPlan, 'the prover must hand over the plan that blocks it').not.toBeNull();

  // The witness has to be a plan the engine accepts, not prose.
  const replay = withEntropy(() => 0, () => replayCatPlan(root, audited.witnessPlan!));
  expect(replay.illegalAt, `witness plan ${audited.witnessPlan!.join('')} is legal step by step`).toBeNull();
  expect(replay.applied.length, 'the witness is a real cat plan').toBeGreaterThan(0);
  const standsOnLine = lineCells.has(rc(replay.end.catPosition));
  const captured = replay.end.phase === GamePhase.CatWins;
  expect(standsOnLine || captured, `the witness must actually interfere (end=${rc(replay.end.catPosition)} phase=${replay.end.phase})`).toBe(true);
  expect(legacy.outcome, 'HV-4 must not call this position forced either').not.toBe('FORCED_WIN');
});

test('HV5-A2. the real T5 root: ∀ over every cat plan, both provers, exact trap rules', () => {
  const t5 = h1Turn(5);
  const auditedSuppressed = withEntropy(() => 0, () =>
    auditMouseLine(t5.state, T5_LINE, { nodeCap: 200_000, maximizeCatPower: true }));
  const auditedRealGhosts = withEntropy(() => 0, () =>
    auditMouseLine(t5.state, T5_LINE, { nodeCap: 200_000, maximizeCatPower: false }));
  const legacy = withEntropy(() => 0, () => hv4LegacyProbeMouseLine(t5.state, T5_LINE, 200_000));

  // eslint-disable-next-line no-console
  console.log(
    `\nHV5-A2 real T5 root (cat ${rc(t5.state.catPosition)} mouse ${rc(t5.state.mousePosition)}`
    + ` carrying=${t5.state.mouseHasButter} trap=${t5.state.trapPosition ? rc(t5.state.trapPosition) : 'none'} remain=${t5.state.catTrapsRemaining})`
    + `\n  AUDITED  (no ghost ever materialises = strongest cat): ${summary(auditedSuppressed)}`
    + `\n  AUDITED  (real ghost rules)                         : ${summary(auditedRealGhosts)}`
    + `\n  HV-4 LEGACY (union occupancy, free trap placement)  : ${legacy.outcome} :: "${legacy.refutation}" nodes=${legacy.nodes} frontier=${legacy.frontier}`,
  );

  expect(auditedSuppressed.outcome, 'the audited ∀ prover still calls T5 lost').toBe('FORCED_WIN');
  expect(auditedRealGhosts.outcome, 'and so does it under the real ghost rules').toBe('FORCED_WIN');
  expect(legacy.outcome, 'HV-4’s conclusion is reproduced').toBe('FORCED_WIN');
  expect(auditedSuppressed.broken, 'no branch may act as a witness').toBe(0);
  expect(auditedSuppressed.captures, 'no cat plan captures the mouse').toBe(0);
  expect(auditedSuppressed.wins, 'every branch of the last cat turn lets the mouse win').toBeGreaterThan(0);
  expect(auditedSuppressed.branches, 'the ∀ is over more than one cat plan').toBeGreaterThan(1);
  expect(auditedSuppressed.truncated ?? false, 'the result object carries no truncation').toBe(false);
});

test('HV5-A3. truncation: HV-4 has no guard, so the verdict is a function of the cap', () => {
  const t5 = h1Turn(5);
  const caps = [1, 2, 3, 5, 8, 12, 20, 30, 45, 58, 60, 120, 240, 200_000];
  const sweep = caps.map((cap) => {
    const legacy = withEntropy(() => 0, () => hv4LegacyProbeMouseLine(t5.state, T5_LINE, cap));
    const audited = withEntropy(() => 0, () =>
      auditMouseLine(t5.state, T5_LINE, { nodeCap: cap, maximizeCatPower: true }));
    const turn = withEntropy(() => 0, () => enumerateCatTurnExact([{ state: t5.state, plan: [] }], cap));
    return `  cap=${String(cap).padStart(6)}  legacy=${legacy.outcome.padEnd(12)}(${legacy.nodes} nodes)  audited=${audited.outcome.padEnd(23)} turn1=${turn.ends.length} ends/${turn.nodes} nodes truncated=${turn.truncated}`;
  });

  const legacyVerdicts = caps.map((cap) => withEntropy(() => 0, () => hv4LegacyProbeMouseLine(t5.state, T5_LINE, cap).outcome));
  const firstForcedCap = caps[legacyVerdicts.indexOf('FORCED_WIN')];
  const turnAtFirstForced = withEntropy(() => 0, () => enumerateCatTurnExact([{ state: t5.state, plan: [] }], firstForcedCap));

  // eslint-disable-next-line no-console
  console.log(
    `\nHV5-A3 enumeration-cap sweep on the real T5 root (a full cat turn needs 58 nodes / 29 end states)`
    + `\n${sweep.join('\n')}`
    + `\n  first cap at which HV-4 says FORCED_WIN = ${firstForcedCap} (its own turn-1 enumeration there is truncated=${turnAtFirstForced.truncated})`
    + `\n  budgets are not the same object: HV-4's cap is per cat turn, the audited nodeCap is a global tree budget.`,
  );

  const legacyTiny = withEntropy(() => 0, () => hv4LegacyProbeMouseLine(t5.state, T5_LINE, 1));
  const legacyAt5 = withEntropy(() => 0, () => hv4LegacyProbeMouseLine(t5.state, T5_LINE, 5));
  const auditedAt5 = withEntropy(() => 0, () =>
    auditMouseLine(t5.state, T5_LINE, { nodeCap: 5, maximizeCatPower: true }));

  expect(legacyTiny.outcome, 'defect 1: a 1-node budget still returns a definitive verdict, with no warning').toBe('LINE_REFUTED');
  expect(legacyTiny.nodes, 'and it did so after enumerating a single state').toBeLessThanOrEqual(4);
  expect(legacyAt5.outcome, 'defect 2: FORCED_WIN is reachable from a truncated tree').toBe('FORCED_WIN');
  expect(turnAtFirstForced.truncated, 'the turn behind that verdict is demonstrably incomplete (1 of 29 end states)').toBe(true);
  expect(turnAtFirstForced.ends.length, 'and exactly one end state was enumerated').toBe(1);
  expect(auditedAt5.outcome, 'the audited prover refuses to conclude from the same budget').toBe('ENUMERATION_INCOMPLETE');
  expect(caps[legacyVerdicts.lastIndexOf('FORCED_WIN')], 'once funded, HV-4 and the audit agree on the verdict').toBe(200_000);
});

test('HV5-A4. chance coverage: the ghost world cannot rescue the cat at T5', () => {
  const t5 = h1Turn(5);
  const draws = [0, 0.25, 0.5, 0.75, 0.999];
  const rows: string[] = [];
  const outcomes: string[] = [];
  const suppressed = withEntropy(() => 0, () =>
    auditMouseLine(t5.state, T5_LINE, { nodeCap: 200_000, maximizeCatPower: true }));
  const reachSuppressed = withEntropy(() => 0, () => reachableCatEnds(t5.state, true));
  for (const p of draws) {
    const r = withEntropy(() => p, () =>
      auditMouseLine(t5.state, T5_LINE, { nodeCap: 200_000, maximizeCatPower: false }));
    outcomes.push(r.outcome);
    rows.push(`  entropy=${p} → ${r.outcome} nodes=${r.nodes} branches=${r.branches} wins=${r.wins}`);
  }
  const reachPinned = withEntropy(() => 0, () => reachableCatEnds(t5.state, false));
  const missing = reachPinned.filter((c) => !reachSuppressed.includes(c));

  // eslint-disable-next-line no-console
  console.log(
    `\nHV5-A4 ghost-butter sensitivity at T5 (pending ghost ${JSON.stringify(t5.state.pendingButterSpawns.map(rc))}, butter ${JSON.stringify(t5.state.butterPositions.map(rc))})`
    + `\n${rows.join('\n')}`
    + `\n  maximizeCatPower (no ghost may ever materialise) → ${suppressed.outcome} nodes=${suppressed.nodes}`
    + `\n  cat turn-1 end cells: suppressed=${reachSuppressed.length} pinned=${reachPinned.length} cells the suppressed world cannot also reach = ${JSON.stringify(missing)}`,
  );

  expect(outcomes, 'every pinned chance world gives the same verdict').toEqual(
    draws.map(() => 'FORCED_WIN'));
  expect(suppressed.outcome, 'the strongest cat (no ghost blocking anything) also loses').toBe('FORCED_WIN');
  expect(missing, 'the suppressed world dominates: it reaches everywhere a ghosted world does').toEqual([]);
});

test('HV5-A5. Turn #4: does HV-4’s refutation survive exact trap rules?', () => {
  const t4 = h1Turn(4);
  const lines = withEntropy(() => 0, () => candidateMouseLines(t4.state, 12, 8));
  const rows: string[] = [];
  const verdicts: { line: number; legacy: string; audited: AuditResult }[] = [];
  for (const line of lines) {
    const legacy = withEntropy(() => 0, () => hv4LegacyProbeMouseLine(t4.state, line, 200_000));
    const audited = withEntropy(() => 0, () =>
      auditMouseLine(t4.state, line, { nodeCap: 120_000, maximizeCatPower: true }));
    verdicts.push({ line: line.length, legacy: legacy.outcome, audited });
    rows.push(
      `  line(${line.length} steps) ${line.join('→')}`
      + `\n     LEGACY  : ${legacy.outcome} :: "${legacy.refutation}" nodes=${legacy.nodes}`
      + `\n     AUDITED : ${summary(audited)}`,
    );
  }
  // eslint-disable-next-line no-console
  console.log(
    `\nHV5-A5 Turn #4 root cat=${rc(t4.state.catPosition)} mouse=${rc(t4.state.mousePosition)}`
    + ` carrying=${t4.state.mouseHasButter} butter=${JSON.stringify(t4.state.butterPositions.map(rc))}`
    + ` trap=${rc(t4.state.trapPosition!)} remain=${t4.state.catTrapsRemaining}`
    + `\n  ${lines.length} candidate mouse lines\n${rows.join('\n')}`
    + `\n  T4_VERDICTS = ${JSON.stringify(verdicts.map((v) => `${v.line}:${v.legacy}/${v.audited.outcome}`))}`,
  );
  expect(lines.length, 'the mouse has candidate lines at T4').toBeGreaterThan(0);
});

test('HV5-A6. determinism: the same audits run twice give identical verdicts', () => {
  const t5 = h1Turn(5);
  const run = (): string[] => [
    summary(auditMouseLine(t5.state, T5_LINE, { nodeCap: 200_000, maximizeCatPower: true })),
    summary(auditMouseLine(t5.state, T5_LINE, { nodeCap: 200_000, maximizeCatPower: false })),
  ];
  const a = withEntropy(() => 0, run);
  const b = withEntropy(() => 0, run);
  // eslint-disable-next-line no-console
  console.log(`\nHV5-A6 repeatable verdicts: ${a.map((s) => s.split(' turns')[0]).join(' | ')}\n  identical=${JSON.stringify(a) === JSON.stringify(b)}`);
  expect(b).toEqual(a);
});
