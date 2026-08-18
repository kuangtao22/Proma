import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'

/** fork 兼容检查使用的稳定检查项顺序。 */
export const FORK_COMPAT_CHECK_IDS = [
  'bridge-composition',
  'ipc-composition',
  'preload-composition',
  'protocol-capabilities',
  'adapter-boundary',
  'mobile-build',
  'mobile-resource',
  'lan-ipc-contract',
] as const

/** 仓库源码读取边界，生产环境和内存测试共用。 */
export interface RepositoryReader {
  /** 返回相对仓库根的 UTF-8 文件内容；文件不存在时返回 undefined。 */
  read: (path: string) => string | undefined
  /** 返回指定目录下的全部相对文件路径。 */
  list: (directory: string) => string[]
}

/** 单项兼容检查结果。 */
export interface ForkCompatCheckResult {
  id: string
  label: string
  passed: boolean
  files: string[]
  hint: string
  details: string[]
}

/** CLI 可注入输出边界，测试时不污染终端。 */
export interface ForkCompatCliOutput {
  /** 写入普通检查结果。 */
  log: (message: string) => void
  /** 写入失败原因和修复提示。 */
  error: (message: string) => void
}

/** LAN Bridge 必须保留的十个请求/响应 IPC 命令。 */
const LAN_IPC_COMMAND_KEYS = [
  'GET_CONFIG',
  'UPDATE_CONFIG',
  'GET_STATUS',
  'START',
  'STOP',
  'GET_PIN',
  'REFRESH_PIN',
  'GET_PAIRING_QR',
  'LIST_DEVICES',
  'REVOKE_DEVICE',
] as const

/** Task 7 以后 renderer 必须继续可用的十个 LAN Bridge 命令方法。 */
const LAN_PRELOAD_METHODS = [
  'getLanBridgeConfig',
  'updateLanBridgeConfig',
  'getLanBridgeStatus',
  'startLanBridge',
  'stopLanBridge',
  'getLanBridgePin',
  'refreshLanBridgePin',
  'getLanBridgePairingQr',
  'listLanBridgeDevices',
  'revokeLanBridgeDevice',
] as const

/** Adapter 组合根负责隔离的官方运行时模块。 */
const OFFICIAL_RUNTIME_MODULES = [
  'conversation-manager',
  'agent-session-manager',
  'agent-workspace-manager',
  'agent-service',
  'settings-service',
  'channel-manager',
  'chat-service',
] as const

/** WebSocket 客户端实际支持的稳定能力，不包含仅桌面设备管理能力。 */
const REQUIRED_WS_CAPABILITIES = [
  'pin-pairing',
  'pairing-ticket',
  'streaming',
  'connection-recovery',
] as const

/** checker 依赖的固定文件路径。 */
const PATHS = {
  main: 'apps/electron/src/main/index.ts',
  bridge: 'apps/electron/src/main/lib/lan-bridge/lan-bridge.ts',
  rootIpc: 'apps/electron/src/main/ipc.ts',
  lanIpc: 'apps/electron/src/main/lib/lan-bridge/lan-bridge-ipc.ts',
  rootPreload: 'apps/electron/src/preload/index.ts',
  lanPreload: 'apps/electron/src/preload/lan-bridge-preload.ts',
  sharedProtocol: 'packages/shared/src/types/lan-bridge.ts',
  handlers: 'apps/electron/src/main/lib/lan-bridge/lan-bridge-handlers.ts',
  adapterRoot: 'apps/electron/src/main/lib/lan-bridge/lan-bridge-proma-adapter.ts',
  adapterCore: 'apps/electron/src/main/lib/lan-bridge/lan-bridge-proma-adapter-core.ts',
  electronPackage: 'apps/electron/package.json',
  mobilePackage: 'apps/mobile/package.json',
  electronBuilder: 'apps/electron/electron-builder.yml',
} as const

/** 创建一个成功或失败格式一致的检查结果。 */
function createResult(
  id: string,
  label: string,
  files: string[],
  hint: string,
  details: string[],
): ForkCompatCheckResult {
  return { id, label, passed: details.length === 0, files, hint, details }
}

/** 读取必需文件，并把缺失路径追加到当前检查的诊断列表。 */
function readRequired(reader: RepositoryReader, path: string, details: string[]): string {
  /** 当前相对路径对应的文件内容。 */
  const content = reader.read(path)
  if (content === undefined) {
    details.push(`缺少必需文件：${path}`)
    return ''
  }
  return content
}

/** 返回正则在源码中的匹配次数，避免依赖完整代码行格式。 */
function countMatches(content: string, pattern: RegExp): number {
  /** 强制全局匹配的正则副本，避免调用方 lastIndex 污染。 */
  const flags = pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`
  return content.match(new RegExp(pattern.source, flags))?.length ?? 0
}

/** 从 `const NAME = [...]` 中提取字符串字面量。 */
function extractStringArray(content: string, name: string): string[] | undefined {
  /** 目标常量数组的源码主体。 */
  const arrayBody = content.match(new RegExp(`\\b${name}\\s*=\\s*\\[([\\s\\S]*?)\\]\\s*as\\s+const`))?.[1]
  if (arrayBody === undefined) return undefined

  /** 数组中的字符串值。 */
  const values: string[] = []
  for (const match of arrayBody.matchAll(/['"]([^'"]+)['"]/g)) values.push(match[1]!)
  return values
}

/** 检查主进程 Bridge 注册与统一启动组合点。 */
function checkBridgeComposition(reader: RepositoryReader): ForkCompatCheckResult {
  /** 当前检查的失败原因。 */
  const details: string[] = []
  /** 主进程组合根源码。 */
  const main = readRequired(reader, PATHS.main, details)
  /** LAN Bridge 生命周期注册源码。 */
  const bridge = readRequired(reader, PATHS.bridge, details)

  if (!/from\s+['"]\.\/lib\/lan-bridge\/lan-bridge['"]/.test(main)) details.push('主进程未导入 lanBridgeRegistration')
  if (countMatches(main, /registerBridge\s*\(\s*lanBridgeRegistration\s*\)/) !== 1) details.push('主进程必须且只能注册一次 lanBridgeRegistration')
  if (!/startAllBridges\s*\(/.test(main)) details.push('主进程未通过 startAllBridges 启动统一 Bridge 生命周期')
  if (!/export\s+const\s+lanBridgeRegistration\s*=/.test(bridge)) details.push('LAN Bridge 未导出 lanBridgeRegistration')
  if (!/start\s*:\s*\([^)]*\)\s*=>[\s\S]*?startLanBridge\s*\(\s*agentEventBus\s*\)/.test(bridge)) details.push('lanBridgeRegistration.start 未把 agentEventBus 交给 startLanBridge')

  return createResult(
    'bridge-composition',
    'Bridge 生命周期组合点',
    [PATHS.main, PATHS.bridge],
    '在主进程组合根保留唯一 registerBridge(lanBridgeRegistration)，并由 registration.start 调用 startLanBridge(agentEventBus)。',
    details,
  )
}

/** 检查根 IPC 仅组合一次独立 LAN registrar。 */
function checkIpcComposition(reader: RepositoryReader): ForkCompatCheckResult {
  /** 当前检查的失败原因。 */
  const details: string[] = []
  /** 根 IPC 源码。 */
  const rootIpc = readRequired(reader, PATHS.rootIpc, details)
  /** 独立 LAN IPC registrar 源码。 */
  const lanIpc = readRequired(reader, PATHS.lanIpc, details)

  if (!/from\s+['"]\.\/lib\/lan-bridge\/lan-bridge-ipc['"]/.test(rootIpc)) details.push('根 IPC 未从独立模块导入 registerLanBridgeIpcHandlers')
  if (countMatches(rootIpc, /registerLanBridgeIpcHandlers\s*\(\s*ipcMain\s*\)/) !== 1) details.push('根 IPC 必须且只能组合一次 registerLanBridgeIpcHandlers(ipcMain)')
  if (!/export\s+interface\s+LanBridgeIpcRegistrar\b/.test(lanIpc)) details.push('独立 LAN IPC 模块缺少可注入 LanBridgeIpcRegistrar')
  if (!/export\s+function\s+registerLanBridgeIpcHandlers\b/.test(lanIpc)) details.push('独立 LAN IPC 模块缺少 registerLanBridgeIpcHandlers 导出')

  return createResult(
    'ipc-composition',
    'LAN IPC 独立注册边界',
    [PATHS.rootIpc, PATHS.lanIpc],
    '把 LAN handler 保持在 lan-bridge-ipc.ts，并在根 registerIpcHandlers 中唯一调用 registrar。',
    details,
  )
}

/** 检查根 preload 只通过一次 spread 组合独立 LAN API。 */
function checkPreloadComposition(reader: RepositoryReader): ForkCompatCheckResult {
  /** 当前检查的失败原因。 */
  const details: string[] = []
  /** 根 preload 源码。 */
  const rootPreload = readRequired(reader, PATHS.rootPreload, details)
  /** 独立 LAN preload 源码。 */
  const lanPreload = readRequired(reader, PATHS.lanPreload, details)

  if (!/from\s+['"]\.\/lan-bridge-preload['"]/.test(rootPreload)) details.push('根 preload 未导入独立 LAN preload factory')
  if (!/interface\s+ElectronAPI\s+extends\s+LanBridgePreloadApi\b/.test(rootPreload)) details.push('ElectronAPI 未继承 LanBridgePreloadApi')
  if (countMatches(rootPreload, /\.\.\.\s*createLanBridgePreloadApi\s*\(\s*ipcRenderer\s*\)/) !== 1) details.push('根 preload 必须且只能 spread 一次 createLanBridgePreloadApi(ipcRenderer)')
  if (/LAN_BRIDGE_IPC_CHANNELS\s*\./.test(rootPreload)) details.push('根 preload 出现 LAN 通道直连，必须留在独立 factory 内')
  if (!/export\s+function\s+createLanBridgePreloadApi\b/.test(lanPreload)) details.push('独立 LAN preload 缺少 createLanBridgePreloadApi 导出')

  return createResult(
    'preload-composition',
    'Preload 唯一组合点',
    [PATHS.rootPreload, PATHS.lanPreload],
    '根 preload 仅继承 LanBridgePreloadApi 并 spread 一次 factory；通道调用留在 lan-bridge-preload.ts。',
    details,
  )
}

/** 检查共享协议版本、能力集合及建连 payload 使用关系。 */
function checkProtocolCapabilities(reader: RepositoryReader): ForkCompatCheckResult {
  /** 当前检查的失败原因。 */
  const details: string[] = []
  /** 共享 LAN 协议源码。 */
  const shared = readRequired(reader, PATHS.sharedProtocol, details)
  /** LAN handler 源码。 */
  const handlers = readRequired(reader, PATHS.handlers, details)
  /** 完整服务端能力列表。 */
  const capabilities = extractStringArray(shared, 'LAN_BRIDGE_CAPABILITIES')
  /** WebSocket 可协商能力列表。 */
  const wsCapabilities = extractStringArray(shared, 'LAN_BRIDGE_WS_CAPABILITIES')

  if (!/LAN_BRIDGE_PROTOCOL_VERSION\s*=\s*[1-9]\d*/.test(shared)) details.push('共享协议缺少正整数 LAN_BRIDGE_PROTOCOL_VERSION')
  if (!capabilities) details.push('无法解析 LAN_BRIDGE_CAPABILITIES')
  if (!wsCapabilities) details.push('无法解析 LAN_BRIDGE_WS_CAPABILITIES')
  if (capabilities && !capabilities.includes('device-revocation')) details.push('完整能力列表缺少桌面设备撤销能力 device-revocation')
  if (wsCapabilities) {
    /** WS 能力中缺失的稳定能力。 */
    const missing = REQUIRED_WS_CAPABILITIES.filter((capability) => !wsCapabilities.includes(capability))
    if (missing.length > 0) details.push(`WS capabilities 缺少：${missing.join(', ')}`)
    if (wsCapabilities.includes('device-revocation')) details.push('WS capabilities 虚假包含仅桌面可用的 device-revocation')
    if (new Set(wsCapabilities).size !== wsCapabilities.length) details.push('WS capabilities 存在重复值')
    if (capabilities && wsCapabilities.some((capability) => !capabilities.includes(capability))) details.push('WS capabilities 包含未在完整能力列表声明的值')
  }
  if (!/protocolVersion\s*:\s*LAN_BRIDGE_PROTOCOL_VERSION/.test(handlers)) details.push('建连 payload 未使用共享协议版本常量')
  if (!/capabilities\s*:\s*\[\s*\.\.\.\s*LAN_BRIDGE_WS_CAPABILITIES\s*\]/.test(handlers)) details.push('建连 payload 未使用共享 WS capabilities')

  return createResult(
    'protocol-capabilities',
    'LAN 协议版本与 WS 能力',
    [PATHS.sharedProtocol, PATHS.handlers],
    '保留共享协议版本与独立 WS 能力列表；建连 payload 必须引用两者，且不得向移动端声明 device-revocation。',
    details,
  )
}

/** 检查官方业务服务静态导入只存在于 Adapter 组合根。 */
function checkAdapterBoundary(reader: RepositoryReader): ForkCompatCheckResult {
  /** 当前检查的失败原因。 */
  const details: string[] = []
  /** Adapter 生产组合根源码。 */
  const adapterRoot = readRequired(reader, PATHS.adapterRoot, details)
  /** 不依赖官方服务的纯 Adapter 核心源码。 */
  const adapterCore = readRequired(reader, PATHS.adapterCore, details)
  /** LAN Bridge 生产源码路径。 */
  const productionFiles = reader.list('apps/electron/src/main/lib/lan-bridge')
    .filter((path) => path.endsWith('.ts') && !path.endsWith('.test.ts') && path !== PATHS.adapterRoot)

  for (const moduleName of OFFICIAL_RUNTIME_MODULES) {
    if (!new RegExp(`from\\s+['"]\\.\\.\\/${moduleName}['"]`).test(adapterRoot)) details.push(`Adapter 组合根缺少官方模块导入：${moduleName}`)
  }
  if (!/createLanBridgePromaAdapter\s*\(/.test(adapterRoot)) details.push('Adapter 组合根未创建 lanBridgePromaAdapter')

  /** 禁止越过 Adapter 边界的官方模块静态导入。 */
  const forbiddenImport = new RegExp(`from\\s+['"]\\.\\.\\/(?:${OFFICIAL_RUNTIME_MODULES.join('|')})['"]`)
  for (const path of productionFiles) {
    /** 当前 LAN Bridge 生产文件源码。 */
    const content = readRequired(reader, path, details)
    if (forbiddenImport.test(content)) details.push(`官方运行时静态导入越过 Adapter 边界：${path}`)
  }
  if (forbiddenImport.test(adapterCore)) details.push('纯 Adapter core 直接导入了官方运行时服务')

  return createResult(
    'adapter-boundary',
    'Proma Adapter 官方运行时边界',
    [PATHS.adapterRoot, PATHS.adapterCore, PATHS.handlers],
    '仅在 lan-bridge-proma-adapter.ts 绑定官方 conversation/agent/settings/channel/chat 服务；handlers 和 core 只依赖 Adapter 接口。',
    details,
  )
}

/** 检查 Electron 打包准备流程始终先构建移动端。 */
function checkMobileBuild(reader: RepositoryReader): ForkCompatCheckResult {
  /** 当前检查的失败原因。 */
  const details: string[] = []
  /** Electron workspace package.json 原文。 */
  const electronPackageContent = readRequired(reader, PATHS.electronPackage, details)
  /** Mobile workspace package.json 原文。 */
  const mobilePackageContent = readRequired(reader, PATHS.mobilePackage, details)

  try {
    /** Electron package scripts。 */
    const electronPackage = JSON.parse(electronPackageContent) as { scripts?: Record<string, string> }
    /** 移动端 package scripts。 */
    const mobilePackage = JSON.parse(mobilePackageContent) as { name?: string; scripts?: Record<string, string> }
    /** Electron 的移动构建命令。 */
    const buildMobile = electronPackage.scripts?.['build:mobile'] ?? ''
    /** Electron 的打包准备命令。 */
    const packagePrepare = electronPackage.scripts?.['package:prepare'] ?? ''

    if (!/bun\s+run\s+--filter=['"]@proma\/mobile['"]\s+build/.test(buildMobile)) details.push('build:mobile 未调用 @proma/mobile workspace build')
    if (!/bun\s+run\s+build:mobile\b/.test(packagePrepare)) details.push('package:prepare 未包含移动端构建')
    if (!/bun\s+run\s+build\b/.test(packagePrepare) || !/bun\s+run\s+sync:runtime-deps\b/.test(packagePrepare)) details.push('package:prepare 未保留 Electron build 或 runtime 依赖同步')
    if (mobilePackage.name !== '@proma/mobile' || !mobilePackage.scripts?.build) details.push('apps/mobile 未保留可执行 build script')
  } catch (error) {
    details.push(`package.json 解析失败：${error instanceof Error ? error.message : String(error)}`)
  }

  return createResult(
    'mobile-build',
    '移动端构建与打包准备',
    [PATHS.electronPackage, PATHS.mobilePackage],
    '保留 Electron build:mobile workspace 命令，并让 package:prepare 同时执行 Electron build、mobile build 和 runtime 同步。',
    details,
  )
}

/** 检查 electron-builder 继续携带移动端静态资源。 */
function checkMobileResource(reader: RepositoryReader): ForkCompatCheckResult {
  /** 当前检查的失败原因。 */
  const details: string[] = []
  /** electron-builder 配置源码。 */
  const builder = readRequired(reader, PATHS.electronBuilder, details)
  /** mobile dist extraResource 条目。 */
  const resourceBlock = builder.match(/-\s*from\s*:\s*['"]?\.\.\/\.\.\/apps\/mobile\/dist['"]?([\s\S]*?)(?=\n\s*-\s*from\s*:|\n\S|$)/)?.[0]

  if (!resourceBlock) details.push('extraResources 缺少 ../../apps/mobile/dist 来源')
  else if (!/\bto\s*:\s*['"]?mobile-dist['"]?/.test(resourceBlock)) details.push('移动端资源未映射到 mobile-dist')

  return createResult(
    'mobile-resource',
    'Electron 包内 mobile-dist 资源',
    [PATHS.electronBuilder],
    '在 electron-builder.yml 的 extraResources 中把 ../../apps/mobile/dist 映射到 mobile-dist。',
    details,
  )
}

/** 检查十个 LAN IPC 命令及对应 preload 方法没有回退。 */
function checkLanIpcContract(reader: RepositoryReader): ForkCompatCheckResult {
  /** 当前检查的失败原因。 */
  const details: string[] = []
  /** 共享通道常量源码。 */
  const shared = readRequired(reader, PATHS.sharedProtocol, details)
  /** 独立 LAN IPC registrar 源码。 */
  const lanIpc = readRequired(reader, PATHS.lanIpc, details)
  /** 独立 LAN preload 源码。 */
  const lanPreload = readRequired(reader, PATHS.lanPreload, details)

  for (const key of LAN_IPC_COMMAND_KEYS) {
    if (countMatches(shared, new RegExp(`\\b${key}\\s*:`)) !== 1) details.push(`共享通道常量缺少或重复：${key}`)
    if (countMatches(lanIpc, new RegExp(`ipc\\.handle\\s*\\(\\s*LAN_BRIDGE_IPC_CHANNELS\\.${key}\\b`)) !== 1) details.push(`LAN IPC registrar 缺少或重复 handler：${key}`)
    if (countMatches(lanPreload, new RegExp(`LAN_BRIDGE_IPC_CHANNELS\\.${key}\\b`)) !== 1) details.push(`LAN preload 缺少或重复通道调用：${key}`)
  }
  for (const method of LAN_PRELOAD_METHODS) {
    if (countMatches(lanPreload, new RegExp(`\\b${method}\\s*:`)) < 2) details.push(`LAN preload 接口或实现缺少方法：${method}`)
  }

  return createResult(
    'lan-ipc-contract',
    '十个 LAN IPC 命令与设备管理 API',
    [PATHS.sharedProtocol, PATHS.lanIpc, PATHS.lanPreload],
    '共享常量、主进程 registrar 和 preload factory 必须同步保留十个命令；配对二维码、设备列表和撤销方法不可回退。',
    details,
  )
}

/** 创建供单元测试注入的内存仓库 reader。 */
export function createMemoryRepositoryReader(files: Readonly<Record<string, string>>): RepositoryReader {
  return {
    read: (path) => files[path],
    list: (directory) => Object.keys(files).filter((path) => path.startsWith(`${directory}/`)),
  }
}

/** 创建只读本地文件系统 reader，不会写入或修改仓库。 */
export function createFileSystemRepositoryReader(repositoryRoot: string): RepositoryReader {
  /** 递归列出指定目录下的文件。 */
  const listFiles = (absoluteDirectory: string): string[] => {
    if (!existsSync(absoluteDirectory)) return []
    /** 当前目录及其子目录中的文件绝对路径。 */
    const files: string[] = []
    for (const entry of readdirSync(absoluteDirectory, { withFileTypes: true })) {
      /** 当前目录项的绝对路径。 */
      const absolutePath = join(absoluteDirectory, entry.name)
      if (entry.isDirectory()) files.push(...listFiles(absolutePath))
      else if (entry.isFile()) files.push(absolutePath)
    }
    return files
  }

  return {
    read: (path) => {
      /** 当前仓库相对路径对应的绝对路径。 */
      const absolutePath = resolve(repositoryRoot, path)
      return existsSync(absolutePath) ? readFileSync(absolutePath, 'utf8') : undefined
    },
    list: (directory) => listFiles(resolve(repositoryRoot, directory))
      .map((path) => relative(repositoryRoot, path).replaceAll('\\', '/')),
  }
}

/** 执行全部 fork 稳定接缝检查。 */
export function checkForkCompatibility(reader: RepositoryReader): ForkCompatCheckResult[] {
  return [
    checkBridgeComposition(reader),
    checkIpcComposition(reader),
    checkPreloadComposition(reader),
    checkProtocolCapabilities(reader),
    checkAdapterBoundary(reader),
    checkMobileBuild(reader),
    checkMobileResource(reader),
    checkLanIpcContract(reader),
  ]
}

/** 执行 CLI 检查并返回应设置的退出码。 */
export function runForkCompatCli(reader: RepositoryReader, output: ForkCompatCliOutput): number {
  /** 当前工作区的全部兼容检查结果。 */
  const results = checkForkCompatibility(reader)

  for (const result of results) {
    output.log(`${result.passed ? '[PASS]' : '[FAIL]'} ${result.label}`)
    output.log(`  文件：${result.files.join(', ')}`)
    if (!result.passed) {
      for (const detail of result.details) output.error(`  原因：${detail}`)
      output.error(`  修复：${result.hint}`)
    }
  }

  /** 失败检查项数量。 */
  const failureCount = results.filter((result) => !result.passed).length
  if (failureCount > 0) {
    output.error(`\n上游兼容检查失败：${failureCount}/${results.length} 项未通过。`)
    return 1
  }

  output.log(`\n上游兼容检查通过：${results.length}/${results.length} 项。`)
  return 0
}

/** CLI 入口：逐项输出结果，并在任一失败时设置非零退出码。 */
function main(): void {
  /** 从脚本目录向上解析出的 monorepo 根目录。 */
  const repositoryRoot = resolve(import.meta.dir, '../../..')
  process.exitCode = runForkCompatCli(createFileSystemRepositoryReader(repositoryRoot), console)
}

if (import.meta.main) main()
