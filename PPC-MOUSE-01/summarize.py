"""
PPC-MOUSE-01 — regenerate every aggregate number in the report from the raw
artifacts in out/. Nothing here re-runs a search; it only reads what the test
files wrote, so a disagreement between this summary and the raw rows is a bug
in the summary.

  python PPC-MOUSE-01/summarize.py
"""
import hashlib
import json
import os

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, 'out')


def load(name):
    with open(os.path.join(OUT, name), encoding='utf-8') as f:
        return json.load(f)


def loadl(name):
    p = os.path.join(OUT, name)
    if not os.path.exists(p):
        return []
    with open(p, encoding='utf-8') as f:
        return [json.loads(line) for line in f if line.strip()]


def p1():
    d = load('p1_mouse_root_parity.json')
    return {
        'rows': [{
            'id': r['id'], 'depth': r['depth'], 'nodes': r['nodes'],
            'searchValue': r['searchValue'], 'oracleValue': r['oracleValue'],
            'searchMate': r['searchMate'], 'oracleMate': r['oracleMate'],
            'valueDiff': r['valueDiff'], 'action': r['action'],
            'completedDepth': r['completedDepth'],
        } for r in d['rows']],
        'maxAbsValueDiff': d['maxAbsValueDiff'],
        'mateMismatches': d['mateMismatches'],
        'fixtures': len({r['id'] for r in d['rows']}),
    }


def p3():
    rows = loadl('p3a_m0_100ms.jsonl')
    def agg(key):
        sel = [r for r in rows if (r['policy'], r['D']) == key]
        steps = sum(r['steps'] for r in sel)
        return {
            'runs': len(sel),
            'steps': steps,
            'fullTurnExecuted': sum(1 for r in sel if r['fullTurn']),
            'abortedOnBudget': sum(1 for r in sel if r['abort'] == 'turn_budget_exhausted'),
            'budgetAbortRate': round(sum(1 for r in sel if r['abort'] == 'turn_budget_exhausted') / max(1, len(sel)), 4),
            'meanSteps': round(steps / max(1, len(sel)), 3),
            'maxWallMs': round(max((r['wall'] for r in sel), default=0), 1),
            'meanWallMs': round(sum(r['wall'] for r in sel) / max(1, len(sel)), 1),
            'overHardWall150': sum(1 for r in sel if r['wall'] > 150),
            'rejects': sum(r['rejects'] for r in sel),
            'mismatches': sum(r['mismatches'] for r in sel),
            'randomCalls': sum(r['random'] for r in sel),
        }
    keys = sorted({(r['policy'], r['D']) for r in rows}, key=lambda x: (x[1], x[0]))
    return {
        'byCombo': {f'D{k[1]}/{k[0]}': agg(k) for k in keys},
        'rows': len(rows),
        'budgetMs': rows[0]['budget'] if rows else None,
    }


def p2():
    gen = loadl('p2a_m0_generous.jsonl')
    return {
        'runs': len(gen),
        'totalSteps': sum(r['steps'] for r in gen),
        'fullTurnExecuted': sum(1 for r in gen if r['fullTurn']),
        'rejects': sum(r['rejects'] for r in gen),
        'mismatches': sum(r['mismatches'] for r in gen),
        'randomCalls': sum(r['random'] for r in gen),
        'chanceMaskedSteps': sum(1 for r in gen for p in r['parities'] if p == 'chance_masked'),
        'exactSteps': sum(1 for r in gen for p in r['parities'] if p == 'exact'),
        'detail': [{'id': r['id'], 'steps': r['steps'], 'actions': r['actions'],
                    'end': r['end'], 'terminal': r['terminal'], 'wall': r['wall']} for r in gen],
    }


def digest():
    """Deterministic fields only — wall clock is deliberately excluded."""
    parts = []
    d = p1()
    for r in d['rows']:
        parts.append(f"p1|{r['id']}|{r['depth']}|{r['nodes']}|{r['searchValue']}|{r['searchMate']}|{r['action']}")
    for name in ('p2a_m0_generous.jsonl', 'p3a_m0_100ms.jsonl'):
        for r in loadl(name):
            parts.append(f"{name}|{r['id']}|{r['policy']}|{r['D']}|{r['steps']}|{r['actions']}|{r['depths']}|"
                         f"{r['end']}|{r['terminal']}|{r['rejects']}|{r['mismatches']}")
    li = load('p1_leaf_injection_contract.json')
    for r in li['rows']:
        parts.append(f"p1li|{r['id']}|{r['oracle']}|{r['defaultLeafValue']}|{r['injectedLeafValue']}|{r['nodesInjected']}")
    return hashlib.sha256('#'.join(parts).encode('utf-8')).hexdigest()


def main():
    summary = {
        'p1_mouse_root_parity': p1(),
        'p2_m0_generous': p2(),
        'p3_m0_100ms': p3(),
        'chance': load('p1_chance.json'),
        'tt': load('p1_tt.json'),
        'truncation': load('p1_truncation.json'),
        'mate_distance': load('p1_mate_distance.json'),
        'leaf_injection': load('p1_leaf_injection_contract.json'),
        'budget_accounting': load('p3b_budget_accounting.json'),
        'random_independence': load('p2c_random_independence.json'),
        'deterministic_digest': digest(),
    }
    p = os.path.join(OUT, 'SUMMARY.json')
    with open(p, 'w', encoding='utf-8') as f:
        json.dump(summary, f, indent=1, ensure_ascii=False)
    print('wrote', p)
    print('digest', summary['deterministic_digest'][:16])
    print('p1 fixtures', summary['p1_mouse_root_parity']['fixtures'],
          'maxAbsValueDiff', summary['p1_mouse_root_parity']['maxAbsValueDiff'])
    for k, v in summary['p3_m0_100ms']['byCombo'].items():
        print(f"  {k:22s} runs={v['runs']:2d} steps={v['steps']:3d} meanSteps={v['meanSteps']:.2f} "
              f"full={v['fullTurnExecuted']:2d} budgetAbort={v['budgetAbortRate']:.2f} "
              f"maxWall={v['maxWallMs']:.0f}ms over150={v['overHardWall150']}")


if __name__ == '__main__':
    main()
