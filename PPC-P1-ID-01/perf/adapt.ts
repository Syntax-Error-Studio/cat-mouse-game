/** Adapter from one isolated source tree to the measurement `Arm` interface. */
import type { Arm } from './measure';

interface EngineModule {
  createEngineRuleSet(): unknown;
}
interface HistoryModule {
  restoreHardRoot(snap: unknown): unknown;
}
interface SearchModule {
  createSearchContext(
    rules: unknown,
    maxNodes: number,
    useTT: boolean,
    useAlphaBeta: boolean,
    useMoveOrdering: boolean,
    maxThreatExtensions: number,
    useThreatOrdering: boolean,
  ): Record<string, unknown>;
  searchBestAction(state: unknown, depthTurns: number, ctx: unknown): {
    value: number;
    mate: string | null;
    action: unknown;
    completed: boolean;
  };
}
interface LeafModule {
  evaluateCorrectedHoleForCat(state: unknown): number;
}

const STEP_PREFIX = 'Arrow';

export function makeArm(
  name: string,
  engine: EngineModule,
  history: HistoryModule,
  search: SearchModule,
  leaf: LeafModule,
): Arm {
  const rules = engine.createEngineRuleSet();
  return {
    name,
    rules,
    restoreRoot: (snap) => history.restoreHardRoot(snap),
    createContext: (r) => {
      // Frozen fixed-work protocol: depth 1, maxNodes 10000, no deadline,
      // explicit corrected-H1 leaf, TT/alpha-beta/ordering ON.
      const ctx = search.createSearchContext(r, 10000, true, true, true, 0, false);
      ctx.leafEvaluator = leaf.evaluateCorrectedHoleForCat;
      ctx.capturePlan = true;
      return ctx;
    },
    search: (s, d, c) => search.searchBestAction(s, d, c),
    label: (a) => {
      if (a === null || a === undefined) return 'NULL';
      const act = a as { type: string; direction?: { key: string } };
      if (act.type === 'catStep') return act.direction!.key.startsWith(STEP_PREFIX) ? act.direction!.key.slice(5)[0] : act.type;
      if (act.type === 'catPlaceTrap') return 'T';
      return act.type;
    },
  };
}
