/**
 * PPC-SEARCH-01 — mechanism diagnosis (not a gate; explains the numbers).
 *
 * Question: arm B explores ~22x more nodes on G1T10 (547 -> 12,225) and ~39x
 * more CHANCE nodes (57 -> 2,248) at the SAME depth. Three candidate causes:
 *   (i)   PVS costs a second pass per candidate (bound: 2x, cannot explain 22x)
 *   (ii)  the TT only stores `bound === 'exact'` entries, and a scout subtree
 *         returns bounds all the way down -> nothing under a scout is cached,
 *         so the documented state repetition has to be re-expanded
 *   (iii) chance subtrees are paid twice and the chance outcome fan-out is large
 *
 * Every run here carries a HARD node cap. A capped run is reported as capped and
 * is NEVER used for a value comparison — only for the node-count mechanism
 * question, where "both arms hit the same ceiling" is the relevant datum.
 */
import { appendFileSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { corpus, controls, runFixed, writeOut } from './pvs_lib.mts';

const OUT = 'PPC-SEARCH-01/out';
const CAP = 400_000;

function log(file: string, obj: unknown): void {
  appendFileSync(`${OUT}/${file}`, JSON.stringify(obj) + '\n');
}

describe('PPC-SEARCH-01 mechanism diagnosis', () => {
  it('D1: TT ON vs TT OFF per arm, small roots only (bounded by a hard cap)', () => {
    writeFileSync(`${OUT}/diag1_tt_on_off.jsonl`, '');
    // G1T10 is the anomaly (547 nodes with TT). The big roots (G1T3, G4T3) are
    // excluded here on purpose: their TT-OFF search does not terminate inside
    // any affordable envelope, and that non-termination is itself the datum.
    for (const id of ['G1T10', 'G1T1', 'G4T2', 'G1T2']) {
      const root = corpus().find((c) => c.id === id)!.root;
      for (const d of [1, 2]) {
        const cell: Record<string, unknown> = { id, d, cap: CAP };
        for (const arm of ['A', 'B'] as const) {
          const on = runFixed(arm, root, d, { useTT: true, maxNodes: CAP });
          const off = runFixed(arm, root, d, { useTT: false, maxNodes: CAP });
          (cell as Record<string, unknown>)[arm] = {
            ttOn: { nodes: on.nodes, capped: on.budgetCutoffs > 0, chance: on.chanceNodes, exactHits: on.ttExactHits, stores: on.ttStores, cutoffs: on.cutoffs, ms: on.wallMs },
            ttOff: { nodes: off.nodes, capped: off.budgetCutoffs > 0, chance: off.chanceNodes, exactHits: off.ttExactHits, stores: off.ttStores, cutoffs: off.cutoffs, ms: off.wallMs },
            valueSameWhenUncapped: on.budgetCutoffs === 0 && off.budgetCutoffs === 0 ? on.value === off.value && on.bestAction === off.bestAction : null,
          };
        }
        log('diag1_tt_on_off.jsonl', cell);
      }
    }
    expect(true).toBe(true);
  }, 1_800_000);

  it('D2: PVS internal counters (scouts / re-searches / skips) per root', () => {
    writeFileSync(`${OUT}/diag2_pvs_counters.jsonl`, '');
    for (const id of ['G1T10', 'G1T1', 'G1T9', 'G4T2', 'G1T5']) {
      const root = corpus().find((c) => c.id === id)!.root;
      for (const d of [1, 2]) {
        const b = runFixed('B', root, d, { maxNodes: CAP });
        const c = runFixed('C', root, d, { maxNodes: CAP });
        log('diag2_pvs_counters.jsonl', {
          id,
          d,
          B: { nodes: b.nodes, chance: b.chanceNodes, ms: b.wallMs, pvs: b.pvs, exactHits: b.ttExactHits, stores: b.ttStores },
          C: { nodes: c.nodes, chance: c.chanceNodes, ms: c.wallMs, pvs: c.pvs, exactHits: c.ttExactHits, stores: c.ttStores },
        });
      }
    }
    expect(true).toBe(true);
  }, 1_800_000);

  it('D3: chance share on the already-measured roots (reuse-free, capped)', () => {
    writeFileSync(`${OUT}/diag3_chance_share.jsonl`, '');
    for (const id of ['G1T10', 'G1T1', 'G1T9', 'G4T2']) {
      const root = corpus().find((c) => c.id === id)!.root;
      const r = runFixed('A', root, 2, { maxNodes: CAP });
      log('diag3_chance_share.jsonl', {
        id,
        nodes: r.nodes,
        chanceNodes: r.chanceNodes,
        leafNodes: r.leafNodes,
        terminalNodes: r.terminalNodes,
        fullWindowChanceSearches: r.fullWindowChanceSearches,
        cutoffs: r.cutoffs,
        firstMoveCutoffs: r.firstMoveCutoffs,
        orderedNodes: r.orderedNodes,
        exactHits: r.ttExactHits,
        stores: r.ttStores,
        chanceNodeSharePct: +((100 * r.chanceNodes) / Math.max(1, r.nodes)).toFixed(2),
      });
    }
    expect(true).toBe(true);
  }, 1_800_000);

  it('D4: ghost control (CHANCE fan-out is a property of the enumerator)', () => {
    const c = controls().find((x) => x.id === 'C_GHOST')!;
    const rows: unknown[] = [];
    for (const arm of ['A', 'B'] as const) {
      for (const d of [1, 2]) {
        const r = runFixed(arm, c.state, d, { maxNodes: 200_000 });
        rows.push({ arm, d, nodes: r.nodes, capped: r.budgetCutoffs > 0, chance: r.chanceNodes, ms: r.wallMs, completed: r.completed });
      }
    }
    writeOut(OUT, 'diag4_ghost_control.json', { rows });
    expect(rows.length).toBe(4);
  }, 1_800_000);
});
