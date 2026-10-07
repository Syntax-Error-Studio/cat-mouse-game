/**
 * Summarizer for f01oracle2.json (F0.1 budget-fair oracle audit).
 * Read-only. Run: node f01oracle2sum.cjs [file]
 */
const fs = require('fs');
const file = process.argv[2] || 'f01oracle2.json';
const o = JSON.parse(fs.readFileSync(file, 'utf8'));

const c = o.config;
console.log(
  `oracleMaxDepth=${c.oracleMaxDepth} perActionNodes=${c.perActionNodes} ` +
  `tacticDepth=${c.tacticDepth} playerNodes=${c.playerNodes}`,
);

const pad = (s, n) => String(s == null ? '-' : s).padEnd(n);

for (const [name, s] of Object.entries(o.suites)) {
  console.log(`\n################ SUITE: ${name} ################`);
  console.log(`rules=${s.rules}`);
  console.log(
    `classA=${s.classA} classB=${s.classB} of ${s.total}   ` +
    `budget-complete rankings=${s.budgetCompleteRankings}/${s.total}`,
  );
  console.log(
    `STRICT (== oracle best set) : Def=${s.default.strict}/${s.total} E1=${s.e1.strict}/${s.total} ` +
    `MedBare=${s.mediumBare.strict}/${s.total} MedTraj=${s.mediumTrajectory.strict}/${s.total}`,
  );
  console.log(
    `SOUND errors (evaluator-independent): Def=${s.default.soundErrors} E1=${s.e1.soundErrors} ` +
    `MedBare=${s.mediumBare.soundErrors} MedTraj=${s.mediumTrajectory.soundErrors}`,
  );

  console.log(
    `\n${pad('fixture', 30)}${pad('class', 13)}${pad('cCD', 5)}${pad('rankD', 6)}${pad('bcomp', 7)}` +
    `${pad('oracleBest', 26)}${pad('Def', 20)}${pad('E1', 20)}${pad('MedBare', 20)}${pad('MedTraj', 20)}`,
  );
  for (const r of s.rows) {
    const mk = (p) => (p.key == null ? '-' : p.key) + (p.strict ? '' : '!') + (p.sound !== 'ok' ? `/${p.sound}` : '');
    console.log(
      pad(r.fixture, 30) + pad(r.oracle.class, 13) +
      pad(r.oracle.commonCompletedDepth, 5) + pad(r.oracle.rankedAtDepth, 6) +
      pad(r.oracle.rankingIsBudgetComplete ? 'Y' : 'N', 7) +
      pad(r.oracle.bestKeys.join('|'), 26) +
      pad(mk(r.default), 20) + pad(mk(r.e1), 20) +
      pad(mk(r.mediumBare), 20) + pad(mk(r.mediumTrajectory), 20),
    );
  }

  console.log('\n--- PER-ACTION DETAIL ---');
  for (const r of s.rows) {
    console.log(
      `\n[${r.fixture}] class=${r.oracle.class} commonCompletedDepth=${r.oracle.commonCompletedDepth} ` +
      `rankedAt=${r.oracle.rankedAtDepth} budgetComplete=${r.oracle.rankingIsBudgetComplete} ` +
      `firstIncomplete=${r.oracle.firstIncompleteDepth}`,
    );
    console.log(`   value=${r.oracle.value} mate=${r.oracle.mate} best=[${r.oracle.bestKeys.join(', ')}]`);
    for (const e of r.oracle.perAction) {
      console.log(
        `      ${pad(e.key, 18)} v=${String(e.value).padStart(10)} mate=${pad(e.mate, 6)} ` +
        `completed=${pad(e.completed, 6)} nodes=${String(e.nodes).padStart(7)} ` +
        `dDist=${e.distDelta == null ? 'n/a' : (e.distDelta > 0 ? '+' : '') + e.distDelta}`,
      );
    }
    console.log(
      `   MedBare : ${r.mediumBare.key ?? 'NULL'}  (${r.mediumBare.raw})   ` +
      `MedTraj : ${r.mediumTrajectory.key ?? 'NULL'} steps=${r.mediumTrajectory.steps} detail="${r.mediumTrajectory.detail}"`,
    );
    if (r.retreat) {
      console.log(`   RETREAT: holds=${r.retreat.assertionHolds} allDecreasingStrictlyWorse=${r.retreat.allDecreasingStrictlyWorse}`);
      console.log(`      best=${JSON.stringify(r.retreat.bestDeltas)}`);
      console.log(`      decreasing=${JSON.stringify(r.retreat.decreasing)}`);
    }
  }
}
