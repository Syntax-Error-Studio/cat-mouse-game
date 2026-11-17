// Does a CHEAP defence check discriminate? — the decisive question for choosing
// between architecture option A (temporal threat feature) and C (root defensive
// verification).
//
// Measured, not argued:
//   1. H0 verdict for each of the three legal cat openings. If all three are
//      "mouse cannot force a win in H0", then an H0-priced checker (the only
//      version of C that fits the time budget) has ZERO discriminating power on
//      this position, and C-as-shipped would still pick U.
//   2. The tempo quantities a temporal feature would read: mouse turns left to
//      the hole vs cat turns left to reach the mouse, both after the cat's turn.
//
// Read-only. Writes _raw/opening-tempo.json.
import { readFileSync, writeFileSync } from 'node:fs';
import { restoreHardRoot } from '../../src/game/ai/hardHistory';
import {
  mouseForcesWin, mouseDistMap, catDistMap, applyPrefixBranches, summarize,
} from './lib';

const FIXTURE = 'src/game/ai/__tests__/fixtures/ppcId01-human-roots.json';
const records = JSON.parse(readFileSync(FIXTURE, 'utf8')) as { id: string; state: unknown }[];
const root = restoreHardRoot(records.find((r) => r.id === 'G6T2')!.state as never);

const openings = ['U', 'D', 'L'];
const rows = openings.map((step) => {
  const pre = applyPrefixBranches(root, [step]);
  if (!pre.ok) throw new Error(`opening ${step} illegal: ${pre.failedAt}`);
  if (pre.states.length !== 1) throw new Error(`opening ${step} unexpectedly branched`);

  // H0 = the current cat turn + the NEXT mouse turn. This is the whole question
  // "can the mouse reach the hole before I get another move".
  const h0 = mouseForcesWin(pre.states[0], 1, pre.idx[0], 200_000);

  return {
    opening: step,
    h0MouseForcedWin: h0.value,
    h0Nodes: h0.stats.nodes,
    h0ElapsedMs: Math.round(h0.stats.elapsedMs * 1000) / 1000,
    afterFirstStep: summarize(pre.states[0]),
  };
});

// ---- tempo table for the three complete plans ------------------------------
function tempoFor(plan: string[]) {
  const pre = applyPrefixBranches(root, plan);
  if (!pre.ok) {
    // The cat plan is still legal (it is a pure cat plan); only a mouse reply
    // would fail. Reaching here means the cat plan itself is bad — report it.
    return { plan: plan.join(''), catPlanLegal: false, failedAt: pre.failedAt };
  }
  const st = pre.states[0];
  const dm = mouseDistMap(st);
  const dMouseHole = dm.get(`${st.mousePosition.r},${st.mousePosition.c}`) ?? -1;
  const dCatMouse = catDistMap(st, st.mousePosition).get(`${st.catPosition.r},${st.catPosition.c}`) ?? -1;
  const mouseBudget = st.mouseHasButter ? st.config.mouseCarryingMoves : st.config.mouseBaseMoves;
  const mouseTurnsToHole = dMouseHole < 0 ? null : Math.ceil(dMouseHole / Math.max(1, mouseBudget));
  const catTurnsToCatch = dCatMouse < 0 ? null : Math.ceil(dCatMouse / st.config.catBaseMoves);
  return {
    plan: plan.join(''),
    catPlanLegal: true,
    cat: `${st.catPosition.r},${st.catPosition.c}`,
    mouse: `${st.mousePosition.r},${st.mousePosition.c}`,
    mouseMovesLeft: st.mouseMovesLeft,
    mouseHasButter: st.mouseHasButter,
    dMouseHole,
    dCatMouse,
    mouseBudgetNextTurn: mouseBudget,
    mouseTurnsToHole,
    catTurnsToCatch,
    // The race: <= means the cat arrives no later than the mouse.
    catWinsRace: mouseTurnsToHole === null || catTurnsToCatch === null
      ? null
      : catTurnsToCatch <= mouseTurnsToHole,
  };
}

const tempo = ['UURR', 'DRRR', 'DRDR'].map((p) => tempoFor(p.split('')));

const allH0Same = rows.every((r) => r.h0MouseForcedWin === rows[0].h0MouseForcedWin);

const doc = {
  generatedAt: new Date().toISOString(),
  generatedBy: 'PPC-CAT-STRATEGY-01/probe/opening_tempo.mts',
  root: 'G6T2',
  provenance: 'REAL_HUMAN_REPLAY',
  question: 'H0 价位的防守校验（方案 C 唯一塞得进预算的形态）能否区分三种猫开局？',
  perOpeningH0: rows,
  h0Discriminates: !allH0Same,
  h0Interpretation: allH0Same
    ? '三种开局的 H0 判定完全相同 ⇒ 便宜的 H0 防守校验在本局面零区分力，'
      + '方案 C 若按 H0 计价上线，仍会选 U。'
    : 'H0 判定出现差异 ⇒ 便宜校验可区分，方案 C 可行。',
  tempoTable: tempo,
  tempoInterpretation:
    '「鼠还需几回合进洞」vs「猫还需几回合到位」这两个量能分开 UURR（猫 2 回合 vs 鼠 1 回合 ⇒ 鼠赢）'
    + '与 DRDR（猫 1 回合 vs 鼠 1 回合 ⇒ 猫抓），这就是方案 A 要提供的判据。',
};

writeFileSync('PPC-CAT-STRATEGY-01/_raw/opening-tempo.json', JSON.stringify(doc, null, 2));
console.log('H0 per opening:', rows.map((r) => `${r.opening}:${r.h0MouseForcedWin}(${r.h0Nodes}n)`).join(' '));
console.log('h0Discriminates:', allH0Same ? false : true);
for (const t of tempo) console.log(JSON.stringify(t));
