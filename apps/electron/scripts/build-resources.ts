/** 跨平台复制开发运行所需资源；复制失败直接使构建失败，避免缺失启动页仍被当作成功。 */
import { cpSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** 按脚本位置定位应用，避免调用方工作目录影响资源路径。 */
const applicationRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
/** 源资源包含启动页、托盘图标与当前平台已生成的原生模块。 */
const sourceDirectory = resolve(applicationRoot, 'resources')
/** 与主进程 bundle 同级的开发资源目录；重复构建覆盖旧文件。 */
const outputDirectory = resolve(applicationRoot, 'dist', 'resources')

cpSync(sourceDirectory, outputDirectory, { recursive: true })
console.log('[构建资源] 已复制到 dist/resources')
