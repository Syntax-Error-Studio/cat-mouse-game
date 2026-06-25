import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    // WSL2 + Windows 文件系统桥接下，chokidar 的 fsevents 不可靠
    // 改用 polling 模式避免 HMR 缓存导致的模块未找到错误
    watch: {
      usePolling: true,
      interval: 1000,
    },
  },
})
