/** 用真实 Electron 主进程和配置锁 addon 验收运维项目持久化，不读取用户配置。 */
import { strict as assert } from 'node:assert'
import { existsSync, mkdirSync, mkdtempSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { app } from 'electron'
import { ServerOpsProjectStore } from '../src/main/lib/server-ops/server-ops-project-store'
import { createServerOpsConfigTransaction } from '../src/main/lib/server-ops/server-ops-config-transaction'
import type {
  ServerOpsConfigLockNativeAddon,
  ServerOpsConfigTransaction,
} from '../src/main/lib/server-ops/server-ops-config-transaction'

/** 指定打包产物或临时构建 addon 的环境变量。 */
const ADDON_PATH_ENVIRONMENT = 'SERVER_OPS_SMOKE_ADDON_PATH'
/** 指定父测试托管临时数据根的环境变量。 */
const DATA_ROOT_ENVIRONMENT = 'SERVER_OPS_SMOKE_DATA_ROOT'

/** 解析父测试托管目录；独立运行时自行创建系统临时目录。 */
function resolveDataRoot(): string {
  /** 父测试在 Electron 完全退出后统一清理的临时路径。 */
  const configuredPath = process.env[DATA_ROOT_ENVIRONMENT]?.trim()
  if (configuredPath) return isAbsolute(configuredPath) ? configuredPath : resolve(process.cwd(), configuredPath)
  return mkdtempSync(join(tmpdir(), 'proma-server-ops-project-smoke-'))
}

/** 独立临时数据根，确保 smoke 不读取或修改真实 ~/.proma。 */
const dataRoot = resolveDataRoot()
/** 运维配置根，由真实 Store 在其下写入 server-ops/projects.json。 */
const configDirectory = join(dataRoot, 'config')
/** 配置事务要求目标目录在创建事务前已存在且可解析。 */
const serverOpsDirectory = join(configDirectory, 'server-ops')
/** Electron 自身缓存目录，同样与已有应用实例隔离。 */
const electronDirectory = join(dataRoot, 'electron-user-data')
mkdirSync(configDirectory, { recursive: true })
mkdirSync(serverOpsDirectory, { recursive: true })
mkdirSync(electronDirectory, { recursive: true })
app.setPath('userData', electronDirectory)

/** 解析显式包内 addon；未指定时使用 apps/electron/resources 的开发资源。 */
function resolveAddonPath(): string {
  /** CI 或包内验收显式提供的真实 addon 路径。 */
  const configuredPath = process.env[ADDON_PATH_ENVIRONMENT]?.trim()
  if (configuredPath) return isAbsolute(configuredPath) ? configuredPath : resolve(process.cwd(), configuredPath)
  return resolve(process.cwd(), 'resources/server-ops-config-lock/server-ops-config-lock.node')
}

/** 直接加载真实 N-API addon，装载失败或 ABI 不兼容必须让 smoke 失败。 */
function loadNativeAddon(addonPath: string): ServerOpsConfigLockNativeAddon {
  assert.ok(existsSync(addonPath), `配置锁 addon 不存在：${addonPath}`)
  /** CJS bundle 使用自身文件位置创建兼容原生模块的 require。 */
  const require = createRequire(__filename)
  /** 运行时验证前的最小原生合同视图。 */
  const addon = require(addonPath) as Partial<ServerOpsConfigLockNativeAddon>
  assert.equal(typeof addon.tryAcquire, 'function', '配置锁 addon 缺少 tryAcquire')
  assert.equal(typeof addon.verify, 'function', '配置锁 addon 缺少 verify')
  assert.equal(typeof addon.release, 'function', '配置锁 addon 缺少 release')
  return addon as ServerOpsConfigLockNativeAddon
}

/** 为同一临时配置目录创建使用真实 addon 的生产事务。 */
function createRealTransaction(addon: ServerOpsConfigLockNativeAddon): ServerOpsConfigTransaction {
  return createServerOpsConfigTransaction(serverOpsDirectory, {
    loadNativeAddon: () => addon,
  })
}

/** 验证失败事务释放锁，后续写入与重新实例化读取均保持可用。 */
function runSmoke(): void {
  app.dock?.hide()
  /** 当前验收实际加载的开发资源或包内 addon。 */
  const addonPath = resolveAddonPath()
  /** 全程复用的真实原生能力；每个 Store 仍创建独立事务。 */
  const addon = loadNativeAddon(addonPath)
  /** 首个 Store 执行失败后继续写入的完整场景。 */
  const firstStore = new ServerOpsProjectStore(configDirectory, {
    transaction: createRealTransaction(addon),
  })

  /** 首个中文运维项目。 */
  const production = firstStore.create('生产运维')
  assert.equal(production.name, '生产运维')
  assert.throws(() => firstStore.create('生产运维'), /SERVER_OPS_PROJECT_NAME_TAKEN/)
  /** 重名失败后继续创建的第二个项目。 */
  const testing = firstStore.create('测试环境')
  /** 第二个项目重命名后的权威快照。 */
  const renamed = firstStore.rename(testing.id, '灾备环境')
  assert.equal(renamed.name, '灾备环境')
  assert.deepEqual(firstStore.list().map((project) => project.name), ['生产运维', '灾备环境'])
  console.log('[Server Ops project smoke] 重复名称拒绝后继续创建和重命名成功')

  /** 新 Store 和新事务重新读取磁盘权威状态，避免只验证进程内对象。 */
  const reloadedStore = new ServerOpsProjectStore(configDirectory, {
    transaction: createRealTransaction(addon),
  })
  assert.deepEqual(reloadedStore.list().map((project) => ({ id: project.id, name: project.name })), [
    { id: production.id, name: '生产运维' },
    { id: testing.id, name: '灾备环境' },
  ])
  console.log('[Server Ops project smoke] 重新实例化读取持久状态成功')
  console.log('[Server Ops project smoke] PASS')
}

/** 无论成功、异常或超时都终止独立 Electron；父测试在进程关闭后清理目录。 */
function finish(code: number): void {
  clearTimeout(timeout)
  app.exit(code)
}

/** 进程内兜底与外层测试超时共同防止 native 异常后挂住 CI。 */
const timeout = setTimeout(() => {
  console.error('[Server Ops project smoke] FAIL：执行超时')
  finish(1)
}, 20_000)

void app.whenReady().then(runSmoke).then(() => finish(0), (error: unknown) => {
  console.error('[Server Ops project smoke] FAIL', error)
  finish(1)
})
