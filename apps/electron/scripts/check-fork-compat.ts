import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join, posix, relative, resolve } from 'node:path'
import * as ts from 'typescript'

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
  'workflow-definition',
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
  workflow: '.github/workflows/upstream-compat.yml',
} as const

/** AST 中发现的运行时模块依赖。 */
interface RuntimeModuleDependency {
  /** 模块说明符原文。 */
  specifier: string
  /** 依赖语法类别，用于失败提示。 */
  syntax: string
}

/** electron-builder 顶层 extraResources 的最小结构。 */
interface ExtraResourceEntry {
  from?: string
  to?: string
  filter: string[]
}

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

/** 使用仓库 TypeScript compiler API 解析 TS/TSX，注释和字符串不会成为语法节点。 */
function parseTypeScript(path: string, content: string): ts.SourceFile {
  /** 根据扩展名选择正确的 JSX 解析模式。 */
  const scriptKind = path.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  return ts.createSourceFile(path, content, ts.ScriptTarget.Latest, true, scriptKind)
}

/** 判断 import clause 是否会生成运行时代码。 */
function hasRuntimeImport(importClause: ts.ImportClause | undefined): boolean {
  if (!importClause) return true
  if (importClause.isTypeOnly) return false
  if (importClause.name) return true
  if (!importClause.namedBindings) return false
  if (ts.isNamespaceImport(importClause.namedBindings)) return true
  return importClause.namedBindings.elements.some((element) => !element.isTypeOnly)
}

/** 判断 export clause 是否会生成运行时代码。 */
function hasRuntimeExport(node: ts.ExportDeclaration): boolean {
  if (node.isTypeOnly) return false
  if (!node.exportClause) return true
  if (ts.isNamespaceExport(node.exportClause)) return true
  return node.exportClause.elements.some((element) => !element.isTypeOnly)
}

/** 提取源码中真实存在的运行时模块依赖，覆盖静态、动态、require 与 re-export。 */
function collectRuntimeDependencies(path: string, content: string): RuntimeModuleDependency[] {
  /** 当前文件 AST。 */
  const sourceFile = parseTypeScript(path, content)
  /** 当前文件全部运行时依赖。 */
  const dependencies: RuntimeModuleDependency[] = []
  /** 记录字符串模块说明符。 */
  const addDependency = (specifier: ts.Expression | undefined, syntax: string): void => {
    if (specifier && ts.isStringLiteralLike(specifier)) {
      dependencies.push({ specifier: specifier.text, syntax })
    }
  }
  /** 递归访问语法树。 */
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && hasRuntimeImport(node.importClause)) {
      addDependency(node.moduleSpecifier, 'import')
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && hasRuntimeExport(node)) {
      addDependency(node.moduleSpecifier, 'export')
    } else if (ts.isImportEqualsDeclaration(node) && !node.isTypeOnly && ts.isExternalModuleReference(node.moduleReference)) {
      addDependency(node.moduleReference.expression, 'import=')
    } else if (ts.isCallExpression(node)) {
      /** 动态 import() 或 CommonJS require() 的模块参数。 */
      const isDynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword
      const isRequire = ts.isIdentifier(node.expression) && node.expression.text === 'require'
      if (isDynamicImport || isRequire) addDependency(node.arguments[0], isDynamicImport ? 'import()' : 'require()')
    }
    ts.forEachChild(node, visit)
  }

  visit(sourceFile)
  return dependencies
}

/** 返回函数体中直接执行的指定调用，嵌套死函数不计入组合点。 */
function countDirectCalls(functionDeclaration: ts.FunctionDeclaration, functionName: string): number {
  if (!functionDeclaration.body) return 0
  return functionDeclaration.body.statements.filter((statement) => {
    if (!ts.isExpressionStatement(statement) || !ts.isCallExpression(statement.expression)) return false
    return ts.isIdentifier(statement.expression.expression) && statement.expression.expression.text === functionName
  }).length
}

/** 查找带 export 修饰符的命名函数。 */
function findExportedFunction(sourceFile: ts.SourceFile, name: string): ts.FunctionDeclaration | undefined {
  return sourceFile.statements.find((statement): statement is ts.FunctionDeclaration => (
    ts.isFunctionDeclaration(statement)
    && statement.name?.text === name
    && statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) === true
  ))
}

/** 解析只允许 `&&` 串联的保守 shell command segments。 */
function parseShellCommandSegments(script: string): string[] | undefined {
  if (/[;|`\n\r#]/.test(script) || /\$[({A-Za-z_]/.test(script) || /(^|[^&])&([^&]|$)/.test(script)) return undefined
  /** 去除首尾空白后的实际命令段。 */
  const segments = script.split(/\s*&&\s*/).map((segment) => segment.trim())
  return segments.length > 0 && segments.every(Boolean) ? segments : undefined
}

/** 去除 YAML 标量外围引号。 */
function unquoteYamlScalar(value: string): string {
  /** 当前标量去除首尾空白后的文本。 */
  const trimmed = value.trim()
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1)
  }
  return trimmed
}

/** 最小解析顶层 extraResources list，拒绝 ignoredResources 等相似嵌套。 */
function parseTopLevelExtraResources(content: string): ExtraResourceEntry[] | undefined {
  /** YAML 原始行。 */
  const lines = content.split(/\r?\n/)
  /** 顶层 extraResources 键所在行。 */
  const startIndex = lines.findIndex((line) => /^extraResources:\s*(?:#.*)?$/.test(line))
  if (startIndex < 0) return undefined

  /** 顶层 extraResources 下解析出的列表项。 */
  const entries: ExtraResourceEntry[] = []
  /** 当前正在解析的列表项。 */
  let current: ExtraResourceEntry | undefined
  /** 当前是否位于 filter 子列表。 */
  let readingFilter = false

  for (const line of lines.slice(startIndex + 1)) {
    if (!line.trim() || /^\s*#/.test(line)) continue
    if (/^\S/.test(line)) break

    /** 新 extraResources 列表项。 */
    const fromMatch = line.match(/^  -\s+from:\s*(.+?)\s*$/)
    if (fromMatch) {
      current = { from: unquoteYamlScalar(fromMatch[1]!), filter: [] }
      entries.push(current)
      readingFilter = false
      continue
    }
    if (!current) continue

    /** 当前资源目标路径。 */
    const toMatch = line.match(/^    to:\s*(.+?)\s*$/)
    if (toMatch) {
      current.to = unquoteYamlScalar(toMatch[1]!)
      readingFilter = false
      continue
    }
    if (/^    filter:\s*$/.test(line)) {
      readingFilter = true
      continue
    }
    /** filter 列表值。 */
    const filterMatch = readingFilter ? line.match(/^      -\s+(.+?)\s*$/) : undefined
    if (filterMatch) current.filter.push(unquoteYamlScalar(filterMatch[1]!))
  }
  return entries
}

/** 检查主进程 Bridge 注册与统一启动组合点。 */
function checkBridgeComposition(reader: RepositoryReader): ForkCompatCheckResult {
  /** 当前检查的失败原因。 */
  const details: string[] = []
  /** 主进程组合根源码。 */
  const main = readRequired(reader, PATHS.main, details)
  /** LAN Bridge 生命周期注册源码。 */
  const bridge = readRequired(reader, PATHS.bridge, details)
  /** 主进程和 LAN Bridge AST。 */
  const mainSource = parseTypeScript(PATHS.main, main)
  const bridgeSource = parseTypeScript(PATHS.bridge, bridge)
  /** 顶层真实 registerBridge 调用。 */
  const registrationCalls = mainSource.statements.filter((statement): statement is ts.ExpressionStatement => {
    if (!ts.isExpressionStatement(statement) || !ts.isCallExpression(statement.expression)) return false
    if (!ts.isIdentifier(statement.expression.expression) || statement.expression.expression.text !== 'registerBridge') return false
    /** registerBridge 的首个参数必须是显式 EventBus 注入 factory。 */
    const registration = statement.expression.arguments[0]
    return Boolean(
      registration
      && ts.isCallExpression(registration)
      && ts.isIdentifier(registration.expression)
      && registration.expression.text === 'createLanBridgeRegistration'
      && ts.isIdentifier(registration.arguments[0])
      && registration.arguments[0].text === 'agentEventBus',
    )
  })
  /** 统一 Bridge 启动调用数量。 */
  let startAllBridgesCalls = 0
  /** LAN registration factory 内 startLanBridge(agentEventBus) 调用数量。 */
  let injectedStartCalls = 0
  /** 统计真实调用表达式。 */
  const countCalls = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      if (node.expression.text === 'startAllBridges') startAllBridgesCalls += 1
      if (
        node.expression.text === 'startLanBridge'
        && ts.isIdentifier(node.arguments[0])
        && node.arguments[0].text === 'agentEventBus'
      ) injectedStartCalls += 1
    }
    ts.forEachChild(node, countCalls)
  }
  countCalls(mainSource)
  /** 导出的显式注入 factory。 */
  const registrationFactory = findExportedFunction(bridgeSource, 'createLanBridgeRegistration')
  if (registrationFactory) countCalls(registrationFactory)

  if (registrationCalls.length !== 1) details.push('主进程必须且只能顶层注册一次 createLanBridgeRegistration(agentEventBus)')
  if (startAllBridgesCalls < 1) details.push('主进程未通过 startAllBridges 启动统一 Bridge 生命周期')
  if (!registrationFactory) details.push('LAN Bridge 未导出 createLanBridgeRegistration')
  if (injectedStartCalls !== 1) details.push('LAN registration factory 未把注入的 agentEventBus 交给 startLanBridge')

  return createResult(
    'bridge-composition',
    'Bridge 生命周期组合点',
    [PATHS.main, PATHS.bridge],
    '在主进程组合根唯一调用 registerBridge(createLanBridgeRegistration(agentEventBus))，LAN 模块只消费注入的 EventBus。',
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
  /** 根 IPC AST 与导出的注册函数。 */
  const rootSource = parseTypeScript(PATHS.rootIpc, rootIpc)
  const registerFunction = findExportedFunction(rootSource, 'registerIpcHandlers')
  /** registerIpcHandlers 函数体中的直接 LAN registrar 调用。 */
  const directCalls = registerFunction ? countDirectCalls(registerFunction, 'registerLanBridgeIpcHandlers') : 0
  /** 根 IPC 中满足显式 EventBus 注入形状的调用数量。 */
  let injectedCalls = 0
  if (registerFunction?.body) {
    for (const statement of registerFunction.body.statements) {
      if (!ts.isExpressionStatement(statement) || !ts.isCallExpression(statement.expression)) continue
      if (!ts.isIdentifier(statement.expression.expression) || statement.expression.expression.text !== 'registerLanBridgeIpcHandlers') continue
      /** registrar 第二参数必须由根组合点绑定 agentEventBus。 */
      const dependencies = statement.expression.arguments[1]
      if (
        ts.isCallExpression(dependencies)
        && ts.isIdentifier(dependencies.expression)
        && dependencies.expression.text === 'createLanBridgeIpcDependencies'
        && ts.isIdentifier(dependencies.arguments[0])
        && dependencies.arguments[0].text === 'agentEventBus'
      ) injectedCalls += 1
    }
  }

  if (!collectRuntimeDependencies(PATHS.rootIpc, rootIpc).some((dependency) => dependency.specifier === './lib/lan-bridge/lan-bridge-ipc')) details.push('根 IPC 未从独立模块导入 LAN registrar')
  if (directCalls !== 1 || injectedCalls !== 1) details.push('registerIpcHandlers 必须直接且唯一调用 registrar，并显式注入 agentEventBus')
  if (!/export\s+interface\s+LanBridgeIpcRegistrar\b/.test(lanIpc)) details.push('独立 LAN IPC 模块缺少可注入 LanBridgeIpcRegistrar')
  if (!/export\s+function\s+registerLanBridgeIpcHandlers\b/.test(lanIpc)) details.push('独立 LAN IPC 模块缺少 registerLanBridgeIpcHandlers 导出')
  if (!/export\s+function\s+createLanBridgeIpcDependencies\b/.test(lanIpc)) details.push('独立 LAN IPC 模块缺少显式 EventBus 依赖 factory')

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
  /** 根 preload AST。 */
  const sourceFile = parseTypeScript(PATHS.rootPreload, rootPreload)
  /** 查找命名变量声明。 */
  const findVariable = (name: string): ts.VariableDeclaration | undefined => {
    for (const statement of sourceFile.statements) {
      if (!ts.isVariableStatement(statement)) continue
      /** 当前变量语句中匹配名称的声明。 */
      const declaration = statement.declarationList.declarations.find((candidate) => (
        ts.isIdentifier(candidate.name) && candidate.name.text === name
      ))
      if (declaration) return declaration
    }
    return undefined
  }
  /** factory 结果变量与最终 API 对象变量。 */
  const lanApi = findVariable('lanBridgePreloadApi')
  const electronApi = findVariable('electronAPI')
  /** 最终 electronAPI 对象中的 LAN spread 数量。 */
  const spreadCount = electronApi?.initializer && ts.isObjectLiteralExpression(electronApi.initializer)
    ? electronApi.initializer.properties.filter((property) => (
      ts.isSpreadAssignment(property)
      && ts.isIdentifier(property.expression)
      && property.expression.text === 'lanBridgePreloadApi'
    )).length
    : 0
  /** 独立 factory 的真实调用形状。 */
  const hasFactoryInitializer = Boolean(
    lanApi?.initializer
    && ts.isCallExpression(lanApi.initializer)
    && ts.isIdentifier(lanApi.initializer.expression)
    && lanApi.initializer.expression.text === 'createLanBridgePreloadApi'
    && ts.isIdentifier(lanApi.initializer.arguments[0])
    && lanApi.initializer.arguments[0].text === 'ipcRenderer',
  )

  if (!collectRuntimeDependencies(PATHS.rootPreload, rootPreload).some((dependency) => dependency.specifier === './lan-bridge-preload')) details.push('根 preload 未导入独立 LAN preload factory')
  if (!/interface\s+ElectronAPI\s+extends\s+LanBridgePreloadApi\b/.test(rootPreload)) details.push('ElectronAPI 未继承 LanBridgePreloadApi')
  if (!hasFactoryInitializer) details.push('根 preload 必须唯一创建 lanBridgePreloadApi factory 结果')
  if (spreadCount !== 1) details.push('electronAPI 对象必须且只能 spread 一次 lanBridgePreloadApi')
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
  /** 判断说明符是否指向被 Adapter 隔离的官方运行时模块。 */
  const getOfficialModule = (specifier: string): string | undefined => OFFICIAL_RUNTIME_MODULES.find((moduleName) => (
    specifier === `../${moduleName}`
    || specifier === `./${moduleName}`
    || specifier.endsWith(`/${moduleName}`)
  ))
  /** 解析相对依赖对应的仓库 TS/TSX 文件。 */
  const resolveLocalDependency = (ownerPath: string, specifier: string): string | undefined => {
    if (!specifier.startsWith('.')) return undefined
    /** 去除显式 JS/TS 扩展后的相对基础路径。 */
    const basePath = posix.normalize(posix.join(posix.dirname(ownerPath), specifier.replace(/\.(?:[cm]?[jt]sx?)$/, '')))
    /** TypeScript 本地模块可能使用的候选路径。 */
    const candidates = [`${basePath}.ts`, `${basePath}.tsx`, posix.join(basePath, 'index.ts'), posix.join(basePath, 'index.tsx')]
    return candidates.find((candidate) => reader.read(candidate) !== undefined)
  }
  /** Adapter 组合根直接绑定的官方运行时模块。 */
  const adapterRuntimeModules = new Set(
    collectRuntimeDependencies(PATHS.adapterRoot, adapterRoot)
      .map((dependency) => getOfficialModule(dependency.specifier))
      .filter((moduleName): moduleName is string => moduleName !== undefined),
  )
  for (const moduleName of OFFICIAL_RUNTIME_MODULES) {
    if (!adapterRuntimeModules.has(moduleName)) details.push(`Adapter 组合根缺少官方运行时绑定：${moduleName}`)
  }
  if (!/createLanBridgePromaAdapter\s*\(/.test(adapterRoot)) details.push('Adapter 组合根未创建 lanBridgePromaAdapter')

  /** 从全部 LAN 生产模块开始，递归扫描传递本地运行时依赖。 */
  const queue = reader.list('apps/electron/src/main/lib/lan-bridge')
    .filter((path) => /\.tsx?$/.test(path) && !path.endsWith('.test.ts') && !path.endsWith('.test.tsx'))
  /** 已扫描文件，防止循环依赖无限遍历。 */
  const visited = new Set<string>()
  while (queue.length > 0) {
    /** 当前待扫描文件。 */
    const path = queue.shift()!
    if (visited.has(path)) continue
    visited.add(path)
    /** 当前生产文件源码。 */
    const content = readRequired(reader, path, details)

    for (const dependency of collectRuntimeDependencies(path, content)) {
      /** 当前依赖命中的官方模块。 */
      const officialModule = getOfficialModule(dependency.specifier)
      if (officialModule) {
        if (path !== PATHS.adapterRoot) {
          details.push(`官方运行时依赖越过 Adapter 边界：${path} 通过 ${dependency.syntax} 引用 ${dependency.specifier}`)
        }
        continue
      }
      /** 继续追踪目录外本地 helper，官方服务边界不会被展开。 */
      const resolvedPath = resolveLocalDependency(path, dependency.specifier)
      if (resolvedPath && !visited.has(resolvedPath)) queue.push(resolvedPath)
    }
  }

  /** 纯 Adapter core 必须保持无官方运行时依赖。 */
  if (collectRuntimeDependencies(PATHS.adapterCore, adapterCore).some((dependency) => getOfficialModule(dependency.specifier))) {
    details.push('纯 Adapter core 直接依赖了官方运行时服务')
  }

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
    /** package:prepare 中可确认会实际执行的命令段。 */
    const commandSegments = parseShellCommandSegments(packagePrepare)

    if (!/bun\s+run\s+--filter=['"]@proma\/mobile['"]\s+build/.test(buildMobile)) details.push('build:mobile 未调用 @proma/mobile workspace build')
    if (!commandSegments) {
      details.push('package:prepare 包含无法安全确认的 shell 语法')
    } else {
      /** 三个必需命令在真实 shell segments 中的位置。 */
      const buildIndex = commandSegments.indexOf('bun run build')
      const mobileIndex = commandSegments.indexOf('bun run build:mobile')
      const syncIndex = commandSegments.indexOf('bun run sync:runtime-deps')
      if (buildIndex < 0 || mobileIndex < 0 || syncIndex < 0) details.push('package:prepare 缺少 Electron build、mobile build 或 runtime 同步命令')
      else if (!(buildIndex < mobileIndex && mobileIndex < syncIndex)) details.push('package:prepare 必须按 Electron build、mobile build、runtime 同步顺序执行')
    }
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
  /** 顶层 extraResources 结构化列表。 */
  const resources = parseTopLevelExtraResources(builder)
  /** from/to 精确匹配的移动端资源项。 */
  const mobileResource = resources?.find((entry) => (
    entry.from === '../../apps/mobile/dist' && entry.to === 'mobile-dist'
  ))

  if (!resources) details.push('electron-builder 顶层缺少可解析的 extraResources list')
  else if (!mobileResource) details.push('顶层 extraResources 缺少 mobile dist 到 mobile-dist 的精确映射')
  else if (!mobileResource.filter.includes('**/*')) details.push('mobile-dist 资源项缺少 **/* filter')

  return createResult(
    'mobile-resource',
    'Electron 包内 mobile-dist 资源',
    [PATHS.electronBuilder],
    '在 electron-builder.yml 的 extraResources 中把 ../../apps/mobile/dist 映射到 mobile-dist。',
    details,
  )
}

/** 检查上游兼容 workflow 的关键执行与失败传播结构。 */
function checkWorkflowDefinition(reader: RepositoryReader): ForkCompatCheckResult {
  /** 当前检查的失败原因。 */
  const details: string[] = []
  /** workflow YAML 文本。 */
  const workflow = readRequired(reader, PATHS.workflow, details)
  /** merge 和 checker 步骤的位置。 */
  const mergeIndex = workflow.indexOf('Merge upstream tag without committing')
  const checkerIndex = workflow.indexOf('Check fork compatibility seams')
  /** cleanup 步骤及其剩余文本。 */
  const cleanupIndex = workflow.indexOf('Abort merge and remove temporary branch')
  const cleanup = cleanupIndex >= 0 ? workflow.slice(cleanupIndex) : ''

  if (!/bun-version:\s*latest\b/.test(workflow)) details.push('Bun 版本未复用现有 workflow 的 latest 模式')
  if (/\|\|\s*true\b/.test(workflow)) details.push('workflow 使用 || true 吞掉命令或 pipeline 错误')
  if (!/git\s+tag\s+--list\b/.test(workflow)) details.push('tag 选择未使用 fetch 后的本地 tag 列表')
  if (!/sort\s+-V\b/.test(workflow)) details.push('tag 选择缺少 semver sort -V')
  if (!/\^v\(0\|\[1-9\]\[0-9\]\*\)/.test(workflow)) details.push('tag 选择缺少严格正式 vMAJOR.MINOR.PATCH 校验')
  if (mergeIndex < 0 || checkerIndex < 0 || mergeIndex >= checkerIndex) details.push('merge 步骤必须位于 checker 和全部验证步骤之前')
  if (!/if:\s*always\(\)/.test(cleanup)) details.push('cleanup 步骤缺少 always()')
  if (!/cleanup_failed=0/.test(cleanup) || !/git\s+merge\s+--abort/.test(cleanup) || !/git\s+switch\s+--detach/.test(cleanup) || !/git\s+branch\s+--delete\s+--force/.test(cleanup) || !/exit\s+"\$cleanup_failed"/.test(cleanup)) {
    details.push('cleanup 未聚合 abort、switch、delete 的失败并返回非零退出码')
  }

  return createResult(
    'workflow-definition',
    '上游兼容 workflow 失败传播',
    [PATHS.workflow],
    '使用 latest Bun、本地正式 tags 和 sort -V；merge 必须先于 checks，cleanup 必须逐项记录并聚合失败退出。',
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
    checkWorkflowDefinition(reader),
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
