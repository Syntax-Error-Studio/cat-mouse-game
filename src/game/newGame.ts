/**
 * RULE-B — the ONE opening factory for every formal game entry point.
 *
 * `createInitialState` stays the raw state constructor (it is also the
 * certifier's own candidate builder). Auto layouts must pass through
 * `generateFairOpening` here, so a new game can never silently reach an
 * unverified butter layout. Explicit layouts (editor / custom terrain / fixed
 * butter positions / tutorial) are returned untouched, as before.
 *
 * A failed auto opening has NO operable state: the result carries only the
 * failure reason, and the caller must show the failure screen and offer a
 * regenerate action. An unverified layout is never presented as a match.
 */
import type { GameEngineState } from './engine';
import { createInitialState } from './engine';
import type { GameConfig } from './config';
import { validateCustomMapConfig, validateGameConfig } from './config';
import type { GenerationOptions } from './openingFairness';
import { generateFairOpening, isExplicitLayout } from './openingFairness';

export type OpeningUnverifiedReason =
  | 'EXPLICIT_LAYOUT'
  | 'UNSUPPORTED_CONFIG'
  | 'INVALID_CONFIG'
  | 'NO_CERTIFIED_OPENING'
  | 'UNDER_GENERATED'
  | 'NO_LEGAL_OPENING';

/**
 * Discriminated result: `state` exists ONLY for openings that may be played
 * (certified or explicit). A formal auto opening that failed certification
 * fails closed — there is no state to hand to the board.
 */
export type NewGameOpening =
  | { status: { kind: 'certified' }; state: GameEngineState }
  | { status: { kind: 'explicit' }; state: GameEngineState }
  | {
      status: { kind: 'unverified'; reason: OpeningUnverifiedReason; detail?: string };
      state: null;
    };

/** Actionable guidance for failures raised by the generator (not validation). */
const OPENING_FAILURE_DETAIL: Partial<Record<OpeningUnverifiedReason, string>> = {
  UNSUPPORTED_CONFIG: '请把棋盘大小调整到 5～20 之间。',
  UNDER_GENERATED: '棋盘太小：黄油必须距离鼠洞至少 5 格、距离猫鼠至少 3 格。'
    + '请增大棋盘或减少黄油数量。',
  NO_LEGAL_OPENING: '生成的初始局面中有一方无合法行动，请调整箱子数量或棋盘大小后重试。',
  NO_CERTIFIED_OPENING: '已尝试多次随机开局，均无法在限定预算内证明公平；请重新生成或调整棋盘/黄油数量。',
};

/**
 * Build the opening for a formal match. Deterministic for fixed RNG/caps.
 * `opts` is a test/injection seam only; production passes no options.
 *
 * The config is validated BEFORE any state is constructed (explicit layouts
 * included), so an out-of-bounds hole/start/tunnel/box can never crash the
 * board and is never silently moved: it is rejected with actionable reasons.
 */
export function createGameState(config: GameConfig, opts: GenerationOptions = {}): NewGameOpening {
  // 编辑器「试玩」只承诺一件事：这份编辑结果必须能被安全地解析成棋盘。
  // 它是自由创作工具的产物，不参与正式对局的开局契约（认证尺寸 / 标准布局 /
  // 猫鼠不同格等），因此换用结构校验；正式对局与教程不带该标记，仍走
  // `validateGameConfig`，其语义逐字不变。
  const validation = config.customMapPlaytest
    ? validateCustomMapConfig(config)
    : validateGameConfig(config);
  if (!validation.ok) {
    // Out-of-range board size keeps its historical UNSUPPORTED_CONFIG reason;
    // malformed coordinates get the new, more specific INVALID_CONFIG.
    const reason: OpeningUnverifiedReason =
      validation.issues.every((i) => i.kind === 'unsupported')
        ? 'UNSUPPORTED_CONFIG'
        : 'INVALID_CONFIG';
    const detail = validation.issues.map((i) => i.message).join('\n');
    console.warn(`[opening] config rejected (${reason}): ${detail}`);
    return { state: null, status: { kind: 'unverified', reason, detail } };
  }
  if (isExplicitLayout(config)) {
    return { state: createInitialState(config), status: { kind: 'explicit' } };
  }
  const res = generateFairOpening(config, opts);
  if (res.ok) return { state: res.state, status: { kind: 'certified' } };
  console.warn(`[opening] fairness generation failed: ${res.reason} (formal match blocked)`);
  return {
    state: null,
    status: {
      kind: 'unverified',
      reason: res.reason,
      detail: OPENING_FAILURE_DETAIL[res.reason],
    },
  };
}
