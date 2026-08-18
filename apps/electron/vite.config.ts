import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'path'
import pkg from './package.json' with { type: 'json' }

export default defineConfig({
  plugins: [react()],
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  root: resolve(__dirname, 'src/renderer'),
  base: './',
  build: {
    outDir: resolve(__dirname, 'dist/renderer'),
    emptyOutDir: true,
  },
  resolve: {
    alias: {
      '@/types': resolve(__dirname, 'src/types'),
      '@': resolve(__dirname, 'src/renderer'),
    },
  },
  server: {
    // macOS 上 Chromium 可能把 localhost 解析为 IPv4，而 Vite 只绑定 ::1。
    // 与 Electron 开发窗口统一使用明确的 IPv4 回环地址。
    host: '127.0.0.1',
    port: 5174,
    strictPort: true, // 确保使用指定端口，如被占用则报错
    open: false,
  },
})
