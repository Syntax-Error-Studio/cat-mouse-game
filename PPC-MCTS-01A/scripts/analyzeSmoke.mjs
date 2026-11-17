/**
 * PPC-MCTS-01A — read-only analysis of the frozen 72-call smoke.
 *
 * Input is never modified: PPC-MCTS-01/out/smoke-final.jsonl (repetition 1).
 * Outputs only PPC-MCTS-01A/{ROOT_VISIT_ANALYSIS,PLAN_COVERAGE_ANALYSIS}.json.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';

const repoRoot = process.cwd();
const smokeRel = 'PPC-MCTS-01/out/smoke-final.jsonl';
const smokeAbs = path.join(repoRoot, smokeRel);
const bytes = fs.readFileSync(smokeAbs);
const smokeSha256 = crypto.createHash('sha256').update(bytes).digest('hex');
const records = bytes.toString('utf8').trim().split(/\r?\n/).map(JSON.parse);
const dataDir = path.join(repoRoot, 'PPC-MCTS-01A');
fs.mkdirSync(dataDir, { recursive: true });

const byAlgo = (a) => records.filter((r) => r.algorithm === a);
const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);
const sum = (a) => a.reduce((s, x) => s + x, 0);
const quantile = (a, p) => {
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)];
};
const entropy = (visits) => {
  const total = visits.reduce((s, x) => s + x, 0);
  if (total <= 0) return 0;
  let h = 0;
  for (const v of visits) {
    if (v <= 0) continue;
    const p = v / total;
    h -= p * Math.log(p);
  }
  return h;
};
const pearson = (xs, ys) => {
  const n = xs.length;
  const mx = mean(xs), my = mean(ys);
  let num = 0, dx = 0, dy = 0;
  for (let i = 0; i < n; i++) {
    num += (xs[i] - mx) * (ys[i] - my);
    dx += (xs[i] - mx) ** 2;
    dy += (ys[i] - my) ** 2;
  }
  return dx > 0 && dy > 0 ? num / Math.sqrt(dx * dy) : 0;
};

function actionKeyFromRecord(r) {
  const a = r.rootActionJson;
  if (!a) return null;
  if (a.type === 'catStep') return `C${String(a.direction.key).replace('Arrow', '')}`;
  if (a.type === 'catPlaceTrap') return 'T';
  if (a.type === 'mouseStep') return `M${String(a.direction.key).replace('Arrow', '')}`;
  if (a.type === 'mouseSkill') return 'S';
  if (a.type === 'chooseTunnel') return `X${a.r},${a.c}`;
  return null;
}

function rootVisitRecord(r) {
  const stats = r.rootActions ?? [];
  const visits = stats.map((x) => x.visits ?? 0);
  const total = sum(visits);
  const k = stats.length;
  const h = entropy(visits);
  const hNorm = k > 1 ? h / Math.log(k) : 0;
  const sorted = [...visits].sort((a, b) => b - a);
  const maxVisits = sorted[0] ?? 0;
  const topCount = visits.filter((v) => v === maxVisits).length;
  const chosenKey = actionKeyFromRecord(r);
  const chosenStat = stats.find((x) => x.action === chosenKey);
  const chosenVisits = chosenStat ? chosenStat.visits : null;
  const chosenRank = chosenVisits == null ? null : 1 + visits.filter((v) => v > chosenVisits).length;
  const chanceEdges = stats.filter((x) => x.transitionKind === 'chance');
  const chanceVisits = sum(chanceEdges.map((x) => x.visits ?? 0));
  const maxQ = stats.length ? Math.max(...stats.map((x) => x.meanReward ?? -Infinity)) : null;
  const chosenQ = chosenStat ? chosenStat.meanReward : null;
  const chosenRankByMeanReward = chosenQ == null
    ? null
    : 1 + stats.filter((x) => (x.meanReward ?? -Infinity) > chosenQ + 1e-12).length;
  const secondVisits = sorted[1] ?? 0;
  return {
    rootId: r.rootId,
    rootStateKey: r.rootStateKey,
    simulations: r.simulations,
    rootVisits: r.rootVisits,
    visitSum: total,
    visitSumMatchesRootVisits: total === r.rootVisits,
    legalRootActions: k,
    visitedRootActions: visits.filter((v) => v > 0).length,
    actions: stats.map((x) => ({
      action: x.action,
      visits: x.visits,
      meanReward: x.meanReward,
      transitionKind: x.transitionKind,
      share: total > 0 ? (x.visits ?? 0) / total : 0,
      top: x.visits === maxVisits && maxVisits > 0,
    })),
    topVisits: maxVisits,
    topTieCount: maxVisits > 0 ? topCount : 0,
    topShare: total > 0 ? maxVisits / total : 0,
    entropyNats: h,
    entropyNormalized: hNorm,
    effectiveActions: h > 0 ? Math.exp(h) : (total > 0 ? 1 : 0),
    chosenAction: r.rootAction,
    chosenActionKey: chosenKey,
    chosenVisits,
    chosenRank,
    chosenIsTopVisited: chosenVisits != null && maxVisits > 0 && chosenVisits === maxVisits,
    topSecondVisitGap: maxVisits - secondVisits,
    topSecondVisitMargin: total > 0 ? (maxVisits - secondVisits) / total : 0,
    chosenRankByMeanReward,
    chosenQ,
    bestQ: maxQ,
    chosenQGapFromBest: chosenQ == null || maxQ == null ? null : maxQ - chosenQ,
    chanceSamples: r.chanceSamples,
    chancePerSim: r.simulations > 0 ? r.chanceSamples / r.simulations : 0,
    chanceRootEdges: chanceEdges.length,
    chanceRootVisits: chanceVisits,
    chanceRootVisitShare: total > 0 ? chanceVisits / total : 0,
    chosenEdgeIsChance: chosenStat ? chosenStat.transitionKind === 'chance' : null,
    planTreeLength: r.planTreeLength,
    planExtensionSteps: r.planExtensionSteps,
    planExtended: r.planExtended,
    planLength: r.planLength,
    planActionCost: r.planActionCost,
    replayOk: r.replayOk,
    replayFullTurnConsumed: r.replayFullTurnConsumed,
  };
}

const algoSections = {};
for (const algo of ['UCT-H', 'UCT-R']) {
  const recs = byAlgo(algo);
  const rows = recs.map(rootVisitRecord);
  const normH = rows.map((r) => r.entropyNormalized);
  const topShare = rows.map((r) => r.topShare);
  const chancePerSim = rows.map((r) => r.chancePerSim);
  const k = rows.map((r) => r.legalRootActions);
  const sortedChance = [...rows].sort((a, b) => a.chancePerSim - b.chancePerSim);
  const half = Math.floor(sortedChance.length / 2);
  const low = sortedChance.slice(0, half);
  const high = sortedChance.slice(sortedChance.length - half);
  algoSections[algo] = {
    n: rows.length,
    roots: rows,
    aggregate: {
      meanLegalRootActions: mean(k),
      meanVisitedRootActions: mean(rows.map((r) => r.visitedRootActions)),
      meanRootVisits: mean(rows.map((r) => r.rootVisits)),
      meanTopShare: mean(topShare),
      maxTopShare: Math.max(...topShare),
      minTopShare: Math.min(...topShare),
      meanEntropyNats: mean(rows.map((r) => r.entropyNats)),
      meanEntropyNormalized: mean(normH),
      minEntropyNormalized: Math.min(...normH),
      maxEntropyNormalized: Math.max(...normH),
      meanEffectiveActions: mean(rows.map((r) => r.effectiveActions)),
      chosenIsTopVisited: rows.filter((r) => r.chosenIsTopVisited).length,
      chosenRankDistribution: rows.reduce((m, r) => { const k2 = String(r.chosenRank); m[k2] = (m[k2] ?? 0) + 1; return m; }, {}),
      chosenRankByMeanRewardDistribution: rows.reduce((m, r) => { const k2 = String(r.chosenRankByMeanReward); m[k2] = (m[k2] ?? 0) + 1; return m; }, {}),
      chosenIsBestMeanReward: rows.filter((r) => r.chosenRankByMeanReward === 1).length,
      meanTopSecondVisitGap: mean(rows.map((r) => r.topSecondVisitGap)),
      meanTopSecondVisitMargin: mean(rows.map((r) => r.topSecondVisitMargin)),
      tiedTopVisitRoots: rows.filter((r) => r.topSecondVisitGap === 0).length,
      meanChosenQGapFromBest: mean(rows.map((r) => r.chosenQGapFromBest).filter((x) => x != null)),
      maxChosenQGapFromBest: Math.max(...rows.map((r) => r.chosenQGapFromBest).filter((x) => x != null)),
      rootsWithChanceRootEdge: rows.filter((r) => r.chanceRootEdges > 0).length,
      meanChanceSamples: mean(rows.map((r) => r.chanceSamples)),
      meanChancePerSim: mean(chancePerSim),
      visitSumMismatch: rows.filter((r) => !r.visitSumMatchesRootVisits).length,
      chanceSplit: {
        medianChancePerSim: quantile(chancePerSim, 50),
        lowHalfMeanNormalizedEntropy: mean(low.map((r) => r.entropyNormalized)),
        highHalfMeanNormalizedEntropy: mean(high.map((r) => r.entropyNormalized)),
        lowHalfMeanTopShare: mean(low.map((r) => r.topShare)),
        highHalfMeanTopShare: mean(high.map((r) => r.topShare)),
        lowHalfMeanVisitedActions: mean(low.map((r) => r.visitedRootActions)),
        highHalfMeanVisitedActions: mean(high.map((r) => r.visitedRootActions)),
      },
      correlations: {
        chancePerSim_vs_normalizedEntropy: pearson(chancePerSim, normH),
        chancePerSim_vs_topShare: pearson(chancePerSim, topShare),
        chancePerSim_vs_visitedActions: pearson(chancePerSim, rows.map((r) => r.visitedRootActions)),
        legalActions_vs_normalizedEntropy: pearson(k, normH),
      },
    },
  };
}

const rootVisitAnalysis = {
  meta: {
    round: 'PPC-MCTS-01A',
    generatedAt: new Date().toISOString(),
    source: smokeRel,
    sourceSha256: smokeSha256,
    records: records.length,
    repetition: 1,
    caveat: '24 roots x 1 repetition is diagnostic only. Entropy/associations are descriptive, not formal search-quality or strength evidence. CHANCE influence is correlational; the smoke does not persist per-outcome node counts.',
  },
  algorithms: algoSections,
};

fs.writeFileSync(path.join(dataDir, 'ROOT_VISIT_ANALYSIS.json'), `${JSON.stringify(rootVisitAnalysis, null, 2)}\n`);

// ---------------------------------------------------------------------------
// Plan coverage
// ---------------------------------------------------------------------------
function planSection(algo) {
  const recs = byAlgo(algo);
  const rows = recs.map((r) => {
    const treeActions = r.planTreeLength;
    const extActions = r.planExtensionSteps;
    const planLength = r.planLength;
    return {
      rootId: r.rootId,
      plan: r.plan,
      planLength,
      planActionCost: r.planActionCost,
      planNonEmpty: r.planNonEmpty,
      treePlanLength: treeActions,
      extensionSteps: extActions,
      planExtended: r.planExtended,
      treeShareOfActions: planLength > 0 && treeActions != null ? treeActions / planLength : null,
      extensionShareOfActions: planLength > 0 && extActions != null ? extActions / planLength : null,
      treeCoversCost: r.planActionCost > 0 && treeActions != null ? treeActions / r.planActionCost : null,
      replayOk: r.replayOk,
      replayFullTurnConsumed: r.replayFullTurnConsumed,
      replayEndedTurn: r.replayEndedTurn,
      replayTerminal: r.replayTerminal,
      replaySteps: r.replaySteps.length,
      searchCompleted: r.searchCompleted,
      completedDepth: r.completedDepth,
      deadlineFired: r.deadlineFired,
      budgetFired: r.budgetFired,
      searchMs: r.searchMs,
      planMs: r.planMs,
      totalMs: r.totalMs,
      withinFullTurnBudget: r.withinFullTurnBudget,
    };
  });
  const trees = rows.map((r) => r.treePlanLength).filter((x) => x != null);
  const exts = rows.map((r) => r.extensionSteps).filter((x) => x != null);
  const lens = rows.map((r) => r.planLength);
  return {
    algorithm: algo,
    n: rows.length,
    rows,
    aggregate: {
      meanTreePlanLength: mean(trees),
      treePlanLengthDistribution: trees.reduce((m, v) => { m[v] = (m[v] ?? 0) + 1; return m; }, {}),
      meanExtensionSteps: mean(exts),
      extensionDistribution: exts.reduce((m, v) => { m[v] = (m[v] ?? 0) + 1; return m; }, {}),
      planExtendedCount: rows.filter((r) => r.planExtended).length,
      meanPlanLength: mean(lens),
      meanPlanActionCost: mean(rows.map((r) => r.planActionCost)),
      meanTreeShareOfActions: mean(rows.map((r) => r.treeShareOfActions).filter((x) => x != null)),
      meanExtensionShareOfActions: mean(rows.map((r) => r.extensionShareOfActions).filter((x) => x != null)),
      replayOk: rows.filter((r) => r.replayOk).length,
      fullTurnConsumed: rows.filter((r) => r.replayFullTurnConsumed).length,
      withinFullTurnBudget: rows.filter((r) => r.withinFullTurnBudget).length,
      searchCompleted: rows.filter((r) => r.searchCompleted === true).length,
      completedDepthDistribution: rows.reduce((m, r) => { const k = String(r.completedDepth); m[k] = (m[k] ?? 0) + 1; return m; }, {}),
      totalMsP50: quantile(rows.map((r) => r.totalMs), 50),
      totalMsP95: quantile(rows.map((r) => r.totalMs), 95),
      totalMsP99: quantile(rows.map((r) => r.totalMs), 99),
      totalMsMax: Math.max(...rows.map((r) => r.totalMs)),
    },
  };
}

const planCoverage = {
  meta: {
    round: 'PPC-MCTS-01A',
    generatedAt: new Date().toISOString(),
    source: smokeRel,
    sourceSha256: smokeSha256,
    repetition: 1,
    caveat: 'treePlanLength is the principal-line prefix that existed in the tree; extensionSteps are rollout-policy completions and are NOT tree evidence. planMs in the smoke includes plan extraction plus real-engine replay, not evaluator cost alone.',
  },
  algorithms: {
    'UCT-H': planSection('UCT-H'),
    'UCT-R': planSection('UCT-R'),
    RACE: planSection('RACE'),
  },
};

fs.writeFileSync(path.join(dataDir, 'PLAN_COVERAGE_ANALYSIS.json'), `${JSON.stringify(planCoverage, null, 2)}\n`);

console.log('ROOT_VISIT UCT-H', JSON.stringify(algoSections['UCT-H'].aggregate, null, 1));
console.log('ROOT_VISIT UCT-R', JSON.stringify(algoSections['UCT-R'].aggregate, null, 1));
console.log('PLAN UCT-H', JSON.stringify(planCoverage.algorithms['UCT-H'].aggregate, null, 1));
console.log('PLAN UCT-R', JSON.stringify(planCoverage.algorithms['UCT-R'].aggregate, null, 1));
console.log(`smokeSha256=${smokeSha256}`);
