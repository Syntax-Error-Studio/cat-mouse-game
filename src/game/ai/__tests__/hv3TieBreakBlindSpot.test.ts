/**
 * PPC-HV-3 P1 — 次级选择为什么看不见「回收陷阱再放一次」这种回头路。
 *
 * 这不是真人根节点：GAME 4 的原始导出还没进入本 Agent 可访问的工作区，所以这里
 * 不重建局面、不冒充真人快照（重建根节点需要完整棋盘，而缺棋盘的任何结论都是编的）。
 * 这里只量一件事，而且它只需要用户日志里已经写出来的动作串：
 *   Hard 在根节点出现 `exact` 同分时，负责挑计划的是 planQuality 的「反转计数」，
 *   而 `isImmediateReversal` 要求相邻两个动作都是 catStep —— 夹在中间的 catPlaceTrap
 *   会让链条断开，于是「走回去 / 放陷阱 / 再走回来」这种回头路计 0 次反转。
 * 动作串取自日志 Turn #5 的 `PLAN=` 字段与同一日志里的对照组，纯函数，无状态、无搜索。
 */
import { describe, it, expect } from 'vitest';
import { DIRECTIONS } from '../../types';
import { isImmediateReversal, countReversals } from '../planQuality';
import type { SearchAction } from '../searchTypes';

const step = (key: string): SearchAction => ({
  type: 'catStep',
  direction: DIRECTIONS.find(d => d.key === key)!,
});
const trap = (): SearchAction => ({ type: 'catPlaceTrap' });
const tok = (a: SearchAction) => (a.type === 'catStep' ? a.direction.key.replace('Arrow', '') : 'Trap');

/** 日志 Turn #5：cat (2,2)→(1,2)→(1,1)[收回陷阱]→(0,1)[放陷阱]→(1,1)。 */
const LOGGED_T5: SearchAction[] = [step('ArrowUp'), step('ArrowLeft'), step('ArrowUp'), trap(), step('ArrowDown')];

describe('HV-3 P1 — 同分次级选择的可见范围', () => {
  it('日志 Turn #5 的计划：反转计数为 0，回头路对次级评分完全不可见', () => {
    const pairs = LOGGED_T5.slice(1).map((b, i) => `${tok(LOGGED_T5[i])}→${tok(b)}=${isImmediateReversal(LOGGED_T5[i], b)}`);
    expect(pairs.join(' ')).toBe('Up→Left=false Left→Up=false Up→Trap=false Trap→Down=false');
    expect(countReversals(LOGGED_T5)).toBe(0);
  });

  it('同一条四步回头路，不夹陷阱计 1 次，夹上 catPlaceTrap 就计 0 次', () => {
    // 完全相同的走法 (2,2)→(1,2)→(1,1)→(0,1)→(1,1)，只是最后一步前面没有放陷阱。
    const sameWalkNoTrap: SearchAction[] = [step('ArrowUp'), step('ArrowLeft'), step('ArrowUp'), step('ArrowDown')];
    expect(countReversals(sameWalkNoTrap)).toBe(1);
    expect(countReversals(LOGGED_T5)).toBe(0);
    // 最小版本：Up / Down 互为反转，中间插一步免费的 catPlaceTrap 就能把代价洗成 0。
    expect(countReversals([step('ArrowUp'), trap(), step('ArrowDown')])).toBe(0);
  });

  it('整回合只走 2 步时，「原地来回」与「直线推进」的差别只由这一条决定', () => {
    expect(countReversals([step('ArrowUp'), step('ArrowDown')])).toBe(1);
    expect(countReversals([step('ArrowUp'), step('ArrowLeft')])).toBe(0);
  });

  it('边界配对的 (根动作, 子计划首步) 也不会计进父节点：链条从根节点就断了', () => {
    // isImmediateReversal 只看相邻的一对；跨「回合根」的那一对由 DP 的另一侧负责。
    const rootAction = step('ArrowLeft');
    const childFirst = step('ArrowRight');
    expect(isImmediateReversal(rootAction, childFirst)).toBe(true);
    // 但把它写成两段子计划各自计数，这一对谁都不拥有。
    expect(countReversals([rootAction]) + countReversals([childFirst])).toBe(0);
  });
});
