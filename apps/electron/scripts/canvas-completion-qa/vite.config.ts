import react from '@vitejs/plugin-react'
import autoprefixer from 'autoprefixer'
import tailwindcss from 'tailwindcss'
import { defineConfig } from 'vite'
import { resolve } from 'node:path'

/** Electron 应用根目录，用于复用生产 Renderer 的别名、Tailwind 与 PostCSS 配置。 */
const electronRoot = resolve(__dirname, '../..')
/** QA 构建产物目录由 runner 指向本次 /tmp 结果目录，不在仓库遗留生成文件。 */
const qaDist = process.env.PROMA_CANVAS_QA_DIST ?? resolve('/tmp', 'proma-canvas-completion-qa-dist')

export default defineConfig({
  root: __dirname,
  base: './',
  plugins: [react()],
  define: {
    __APP_VERSION__: JSON.stringify('canvas-completion-qa'),
  },
  css: {
    postcss: {
      plugins: [
        tailwindcss({ config: resolve(electronRoot, 'tailwind.config.js') }),
        autoprefixer(),
      ],
    },
  },
  resolve: {
    alias: {
      '@/types': resolve(electronRoot, 'src/types'),
      '@': resolve(electronRoot, 'src/renderer'),
    },
  },
  build: {
    outDir: qaDist,
    emptyOutDir: true,
  },
})
