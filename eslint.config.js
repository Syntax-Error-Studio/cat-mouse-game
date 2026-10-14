import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  // 仅忽略「非正式源码」的产物/缓存/历史快照目录：ai-training/（9018 MB，含 763 个 ts/tsx，
// 其中 5 份 2.29 MB 的 hybridWeights.ts 副本）与 .r1e-head-control/（恢复用快照，366 个 ts/tsx）
// 会让 `eslint .` 去解析仓库外的历史副本并耗尽内存。src/、src/game/ai/、src/game/ai/__tests__/
// 与 scripts/ 全部保持原样覆盖，规则等级未改动。
globalIgnores([
  'dist',
  'build',
  '.vite',
  'test-results',
  'ai-training',
  'scratch',
  '.r1e-head-control',
]),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      js.configs.recommended,
      tseslint.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      globals: globals.browser,
    },
  },
])
