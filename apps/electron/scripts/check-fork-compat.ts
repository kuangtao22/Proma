import { existsSync, readFileSync, readdirSync, realpathSync } from 'node:fs'
import { isAbsolute, join, posix, relative, resolve, sep } from 'node:path'
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

/** 十个 preload 方法与请求/响应 IPC 通道的精确映射。 */
const LAN_PRELOAD_METHOD_CHANNELS = [
  ['getLanBridgeConfig', 'GET_CONFIG'],
  ['updateLanBridgeConfig', 'UPDATE_CONFIG'],
  ['getLanBridgeStatus', 'GET_STATUS'],
  ['startLanBridge', 'START'],
  ['stopLanBridge', 'STOP'],
  ['getLanBridgePin', 'GET_PIN'],
  ['refreshLanBridgePin', 'REFRESH_PIN'],
  ['getLanBridgePairingQr', 'GET_PAIRING_QR'],
  ['listLanBridgeDevices', 'LIST_DEVICES'],
  ['revokeLanBridgeDevice', 'REVOKE_DEVICE'],
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
  mergeHelper: 'apps/electron/scripts/verify-upstream-merge.ts',
} as const

/** AST 中发现的运行时模块依赖。 */
interface RuntimeModuleDependency {
  /** 模块说明符原文；非字面量加载时不存在。 */
  specifier?: string
  /** 依赖语法类别，用于失败提示。 */
  syntax: string
}

/** 保守 shell 解析器确认可顺序执行的单条命令。 */
interface ShellCommand {
  /** 去除 shell 引号后的命令及参数。 */
  argv: string[]
}

/** 单文件 TypeScript 绑定上下文，用于区分真实 import 与同名局部 shadow。 */
interface TypeScriptBindingContext {
  /** 已完成 binder 处理的源码 AST。 */
  sourceFile: ts.SourceFile
  /** 查询标识符实际声明来源的类型检查器。 */
  checker: ts.TypeChecker
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

/** 创建只绑定当前源码的 TypeScript Program，不解析外部模块或标准库。 */
function createTypeScriptBindingContext(path: string, content: string): TypeScriptBindingContext {
  /** 单文件绑定只需要语法与符号表，不需要类型库或模块解析。 */
  const options: ts.CompilerOptions = {
    module: ts.ModuleKind.ESNext,
    noLib: true,
    noResolve: true,
    target: ts.ScriptTarget.Latest,
  }
  /** 当前源码 AST 由 Program binder 复用。 */
  const sourceFile = parseTypeScript(path, content)
  /** 限制 compiler host 只能读取当前虚拟文件。 */
  const host = ts.createCompilerHost(options)
  host.fileExists = (fileName) => fileName === path
  host.getSourceFile = (fileName) => fileName === path ? sourceFile : undefined
  host.readFile = (fileName) => fileName === path ? content : undefined
  /** Program 负责为 import、局部声明和使用位置建立统一 symbol identity。 */
  const program = ts.createProgram([path], options, host)
  return { sourceFile, checker: program.getTypeChecker() }
}

/** 判断 import clause 是否会生成运行时代码。 */
function hasRuntimeImport(importClause: ts.ImportClause | undefined): boolean {
  if (!importClause) return true
  if (importClause.isTypeOnly) return false
  if (importClause.name) return true
  if (!importClause.namedBindings) return false
  if (ts.isNamespaceImport(importClause.namedBindings)) return true
  if (importClause.namedBindings.elements.length === 0) return true
  return importClause.namedBindings.elements.some((element) => !element.isTypeOnly)
}

/** 判断 export clause 是否会生成运行时代码。 */
function hasRuntimeExport(node: ts.ExportDeclaration): boolean {
  if (node.isTypeOnly) return false
  if (!node.exportClause) return true
  if (ts.isNamespaceExport(node.exportClause)) return true
  if (node.exportClause.elements.length === 0) return true
  return node.exportClause.elements.some((element) => !element.isTypeOnly)
}

/** 提取源码中真实存在的运行时模块依赖，覆盖静态、动态、require 与 re-export。 */
function collectRuntimeDependencies(path: string, content: string): RuntimeModuleDependency[] {
  /** 当前文件 AST。 */
  const sourceFile = parseTypeScript(path, content)
  /** 当前文件全部运行时依赖。 */
  const dependencies: RuntimeModuleDependency[] = []
  /** 记录字符串模块说明符。 */
  const addDependency = (specifier: ts.Expression | undefined, syntax: string, requireLiteral = false): void => {
    if (specifier && ts.isStringLiteralLike(specifier)) {
      dependencies.push({ specifier: specifier.text, syntax })
    } else if (requireLiteral) {
      dependencies.push({ syntax })
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
      if (isDynamicImport || isRequire) {
        addDependency(node.arguments[0], isDynamicImport ? 'import()' : 'require()', true)
      }
    }
    ts.forEachChild(node, visit)
  }

  visit(sourceFile)
  return dependencies
}

/** 查找带 export 修饰符的命名函数。 */
function findExportedFunction(sourceFile: ts.SourceFile, name: string): ts.FunctionDeclaration | undefined {
  return sourceFile.statements.find((statement): statement is ts.FunctionDeclaration => (
    ts.isFunctionDeclaration(statement)
    && statement.name?.text === name
    && statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) === true
  ))
}

/** 查找源码中的命名函数声明。 */
function findNamedFunction(sourceFile: ts.SourceFile, name: string): ts.FunctionDeclaration | undefined {
  return sourceFile.statements.find((statement): statement is ts.FunctionDeclaration => (
    ts.isFunctionDeclaration(statement) && statement.name?.text === name
  ))
}

/** 判断顶层 bootstrap 是否由 app.whenReady().then(bootstrap) 挂接。 */
function hasReachableBootstrapRegistration(sourceFile: ts.SourceFile): boolean {
  return sourceFile.statements.some((statement) => {
    if (!ts.isExpressionStatement(statement)) return false
    /** 精确判断 Electron app.whenReady() 调用。 */
    const isAppWhenReadyCall = (node: ts.Expression): boolean => (
      ts.isCallExpression(node)
      && node.arguments.length === 0
      && ts.isPropertyAccessExpression(node.expression)
      && node.expression.name.text === 'whenReady'
      && ts.isIdentifier(node.expression.expression)
      && node.expression.expression.text === 'app'
    )
    /** 沿当前顶层 Promise 链查找精确的 app.whenReady().then(bootstrap)。 */
    const containsBootstrapThen = (node: ts.Expression): boolean => {
      if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression)) return false
      if (
        node.expression.name.text === 'then'
        && node.arguments.length === 1
        && ts.isIdentifier(node.arguments[0])
        && node.arguments[0].text === 'bootstrap'
        && isAppWhenReadyCall(node.expression.expression)
      ) return true
      return containsBootstrapThen(node.expression.expression)
    }
    return containsBootstrapThen(statement.expression)
  })
}

/** 判断 bootstrap 顶层表达式是否调用真实 import 的统一 Bridge 启动函数。 */
function expressionStartsAllBridges(
  expression: ts.Expression,
  startBindings: ReadonlyMap<string, ts.Symbol>,
  checker: ts.TypeChecker,
): boolean {
  /** await 和括号不改变当前表达式的执行路径。 */
  const unwrapped = ts.isAwaitExpression(expression)
    ? expression.expression
    : ts.isParenthesizedExpression(expression)
      ? expression.expression
      : expression
  if (!ts.isCallExpression(unwrapped)) return false
  if (
    ts.isIdentifier(unwrapped.expression)
    && identifierUsesImportedBinding(unwrapped.expression, startBindings, checker)
  ) return true
  if (!ts.isIdentifier(unwrapped.expression) || unwrapped.expression.text !== 'safeAwait') return false
  /** safeAwait 的函数参数由该 helper 在当前 bootstrap 步骤直接执行。 */
  return unwrapped.arguments.some((argument) => (
    (ts.isArrowFunction(argument) || ts.isFunctionExpression(argument))
    && (ts.isBlock(argument.body)
      ? argument.body.statements.some((statement) => (
        ts.isReturnStatement(statement)
        && Boolean(statement.expression && expressionStartsAllBridges(statement.expression, startBindings, checker))
      ))
      : expressionStartsAllBridges(argument.body, startBindings, checker))
  ))
}

/** 按顺序确认 bootstrap 在无条件终止前直接启动 Bridge。 */
function bootstrapStartsAllBridges(
  bootstrap: ts.FunctionDeclaration | undefined,
  startBindings: ReadonlyMap<string, ts.Symbol>,
  checker: ts.TypeChecker,
): boolean {
  if (!bootstrap?.body) return false
  for (const statement of bootstrap.body.statements) {
    if (ts.isReturnStatement(statement)) {
      return Boolean(statement.expression && expressionStartsAllBridges(statement.expression, startBindings, checker))
    }
    if (ts.isThrowStatement(statement)) return false
    if (
      ts.isExpressionStatement(statement)
      && expressionStartsAllBridges(statement.expression, startBindings, checker)
    ) return true
  }
  return false
}

/** 收集目标模块真实运行时 named import 的 local binding，支持 import alias。 */
function collectImportedLocalBindings(
  context: TypeScriptBindingContext,
  modulePath: string,
  exportedName: string,
): Map<string, ts.Symbol> {
  /** local 名称到 import specifier symbol 的精确映射。 */
  const bindings = new Map<string, ts.Symbol>()
  for (const statement of context.sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteralLike(statement.moduleSpecifier)) continue
    if (
      statement.moduleSpecifier.text !== modulePath
      || statement.importClause?.isTypeOnly
      || !statement.importClause?.namedBindings
    ) continue
    if (!ts.isNamedImports(statement.importClause.namedBindings)) continue
    for (const element of statement.importClause.namedBindings.elements) {
      if (element.isTypeOnly || (element.propertyName?.text ?? element.name.text) !== exportedName) continue
      /** binder 为 import specifier local 名建立的唯一 symbol。 */
      const symbol = context.checker.getSymbolAtLocation(element.name)
      if (symbol) bindings.set(element.name.text, symbol)
    }
  }
  return bindings
}

/** 判断使用位置是否实际绑定到目标 named import，而不是同名局部声明。 */
function identifierUsesImportedBinding(
  identifier: ts.Identifier,
  bindings: ReadonlyMap<string, ts.Symbol>,
  checker: ts.TypeChecker,
): boolean {
  /** local 名只用于快速定位，最终以 symbol identity 判定 provenance。 */
  const importedSymbol = bindings.get(identifier.text)
  return Boolean(importedSymbol && checker.getSymbolAtLocation(identifier) === importedSymbol)
}

/** 判断调用是否为 LAN registration factory 的 registerBridge 组合。 */
function isLanBridgeRegistrationCall(
  node: ts.Node,
  registerBridgeBindings: ReadonlyMap<string, ts.Symbol>,
  factoryBindings: ReadonlyMap<string, ts.Symbol>,
  eventBusBindings: ReadonlyMap<string, ts.Symbol>,
  checker: ts.TypeChecker,
  requireAgentEventBus: boolean,
): node is ts.CallExpression {
  if (
    !ts.isCallExpression(node)
    || !ts.isIdentifier(node.expression)
    || !identifierUsesImportedBinding(node.expression, registerBridgeBindings, checker)
  ) {
    return false
  }
  /** registerBridge 的首个实参必须是 LAN registration factory 调用。 */
  const registration = node.arguments[0]
  if (
    !ts.isCallExpression(registration)
    || !ts.isIdentifier(registration.expression)
    || !identifierUsesImportedBinding(registration.expression, factoryBindings, checker)
  ) return false
  if (!requireAgentEventBus) return true
  return ts.isIdentifier(registration.arguments[0])
    && identifierUsesImportedBinding(registration.arguments[0], eventBusBindings, checker)
}

/** 统计全部 LAN registerBridge 语法调用，包括不可达位置，用于拒绝隐藏重复注册。 */
function countLanBridgeRegistrations(
  sourceFile: ts.SourceFile,
  registerBridgeBindings: ReadonlyMap<string, ts.Symbol>,
  factoryBindings: ReadonlyMap<string, ts.Symbol>,
  eventBusBindings: ReadonlyMap<string, ts.Symbol>,
  checker: ts.TypeChecker,
): number {
  /** 当前累计注册次数。 */
  let count = 0
  /** 递归扫描全部真实调用节点，注释和字符串不会进入 AST。 */
  const visit = (node: ts.Node): void => {
    if (isLanBridgeRegistrationCall(
      node,
      registerBridgeBindings,
      factoryBindings,
      eventBusBindings,
      checker,
      false,
    )) count += 1
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return count
}

/** 统计 Program 顶层直接执行且注入 agentEventBus 的 LAN 注册。 */
function countTopLevelLanBridgeRegistrations(
  sourceFile: ts.SourceFile,
  registerBridgeBindings: ReadonlyMap<string, ts.Symbol>,
  factoryBindings: ReadonlyMap<string, ts.Symbol>,
  eventBusBindings: ReadonlyMap<string, ts.Symbol>,
  checker: ts.TypeChecker,
): number {
  return sourceFile.statements.filter((statement) => (
    ts.isExpressionStatement(statement)
    && isLanBridgeRegistrationCall(
      statement.expression,
      registerBridgeBindings,
      factoryBindings,
      eventBusBindings,
      checker,
      true,
    )
  )).length
}

/** 判断表达式是否直接调用 startLanBridge，并传入 factory 注入参数。 */
function isInjectedStartCall(expression: ts.Expression, injectedName: string): boolean {
  /** await 和括号不改变被调用表达式的语义。 */
  const unwrapped = ts.isAwaitExpression(expression)
    ? expression.expression
    : ts.isParenthesizedExpression(expression)
      ? expression.expression
      : expression
  return Boolean(
    ts.isCallExpression(unwrapped)
    && ts.isIdentifier(unwrapped.expression)
    && unwrapped.expression.text === 'startLanBridge'
    && ts.isIdentifier(unwrapped.arguments[0])
    && unwrapped.arguments[0].text === injectedName,
  )
}

/** 判断 start 函数自身是否在直接表达式或直接语句中启动 LAN Bridge。 */
function functionDirectlyStartsLanBridge(
  functionLike: ts.ArrowFunction | ts.FunctionExpression | ts.MethodDeclaration | ts.FunctionDeclaration,
  injectedName: string,
): boolean {
  if (!ts.isBlock(functionLike.body)) return isInjectedStartCall(functionLike.body, injectedName)
  for (const statement of functionLike.body.statements) {
    if (ts.isReturnStatement(statement) && statement.expression) {
      return isInjectedStartCall(statement.expression, injectedName)
    }
    if (ts.isReturnStatement(statement) || ts.isThrowStatement(statement)) return false
    if (ts.isExpressionStatement(statement) && isInjectedStartCall(statement.expression, injectedName)) return true
  }
  return false
}

/** 解析 factory 直接返回对象上的 start 函数，支持属性、方法和局部 shorthand。 */
function returnedObjectStartUsesInjectedBus(
  factory: ts.FunctionDeclaration,
  injectedName: string,
): boolean {
  if (!factory.body) return false
  /** factory 首个可达顶层 return 必须直接返回 registration 对象。 */
  let returnedObject: ts.ObjectLiteralExpression | undefined
  for (const statement of factory.body.statements) {
    if (ts.isThrowStatement(statement)) return false
    if (!ts.isReturnStatement(statement)) continue
    if (!statement.expression) return false
    /** 去除不改变返回值语义的 TypeScript 包装。 */
    const returned = unwrapTypeScriptExpression(statement.expression)
    if (!ts.isObjectLiteralExpression(returned)) return false
    returnedObject = returned
    break
  }
  if (!returnedObject) return false

  /** registration 对象上的 start 属性或方法。 */
  const startMember = returnedObject.properties.find((property) => property.name?.getText() === 'start')
  if (!startMember) return false
  if (ts.isMethodDeclaration(startMember)) {
    return functionDirectlyStartsLanBridge(startMember, injectedName)
  }

  /** 属性 initializer 或 shorthand 名称引用的局部函数。 */
  let startValue: ts.Expression | ts.FunctionDeclaration | undefined
  if (ts.isPropertyAssignment(startMember)) {
    startValue = startMember.initializer
  } else if (ts.isShorthandPropertyAssignment(startMember)) {
    /** 与 shorthand 同名的 factory 顶层变量或函数声明。 */
    const localName = startMember.name.text
    for (const statement of factory.body.statements) {
      if (ts.isVariableStatement(statement)) {
        const declaration = statement.declarationList.declarations.find((candidate) => (
          ts.isIdentifier(candidate.name) && candidate.name.text === localName
        ))
        if (declaration?.initializer) startValue = declaration.initializer
      } else if (ts.isFunctionDeclaration(statement) && statement.name?.text === localName) {
        startValue = statement
      }
    }
  }

  if (startValue && (ts.isArrowFunction(startValue) || ts.isFunctionExpression(startValue) || ts.isFunctionDeclaration(startValue))) {
    return functionDirectlyStartsLanBridge(startValue, injectedName)
  }
  return false
}

/** 解析仅允许顶层 `&&` 串联的命令链，并按 shell 规则移除普通引号。 */
function parseConjunctiveShellCommands(script: string): ShellCommand[] | undefined {
  /** shell 在解析操作符前会移除反斜杠换行。 */
  const normalizedScript = normalizeShellContinuations(script)
  /** 已完成解析的命令。 */
  const commands: ShellCommand[] = []
  /** 当前命令的参数列表。 */
  let argv: string[] = []
  /** 当前正在构造的参数。 */
  let token = ''
  /** 空引号也应产生一个参数。 */
  let tokenStarted = false
  /** 当前单引号或双引号状态。 */
  let quote: "'" | '"' | undefined

  /** 将当前参数提交到 argv。 */
  const pushToken = (): void => {
    if (!tokenStarted) return
    argv.push(token)
    token = ''
    tokenStarted = false
  }
  /** 将当前 argv 提交为命令。 */
  const pushCommand = (): boolean => {
    pushToken()
    if (argv.length === 0) return false
    commands.push({ argv })
    argv = []
    return true
  }

  for (let index = 0; index < normalizedScript.length; index += 1) {
    /** 当前 shell 字符。 */
    const character = normalizedScript[index]!
    if (quote) {
      if (character === quote) quote = undefined
      else {
        if (character === '$' || character === '`' || character === '\\') return undefined
        token += character
      }
      tokenStarted = true
      continue
    }

    if (character === "'" || character === '"') {
      quote = character
      tokenStarted = true
    } else if (/\s/.test(character)) {
      pushToken()
    } else if (character === '&' && normalizedScript[index + 1] === '&') {
      if (!pushCommand()) return undefined
      index += 1
    } else if (';&|`#$()<>\\'.includes(character)) {
      return undefined
    } else {
      token += character
      tokenStarted = true
    }
  }

  if (quote || !pushCommand()) return undefined
  return commands
}

/** 按 shell 词法规则折叠 LF/CRLF 反斜杠续行，防止物理行绕过控制流判断。 */
function normalizeShellContinuations(script: string): string {
  return script.replace(/\\(?:\r\n|\n)[\t ]*/g, ' ')
}

/** 返回去除空行和整行注释后的逻辑 shell 行。 */
function getLogicalShellLines(step: Record<string, unknown> | undefined): string[] {
  /** 当前 step 的 shell 脚本文本。 */
  const run = getStepRun(step)
  if (!run) return []
  return normalizeShellContinuations(run)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'))
}

/** 判断逻辑 shell 行与完整有序合同逐项一致，不允许插入额外命令。 */
function stepMatchesLinearContract(
  step: Record<string, unknown> | undefined,
  contract: readonly RegExp[],
): boolean {
  /** 当前 step 归一化后的全部有效逻辑行。 */
  const lines = getLogicalShellLines(step)
  return lines.length === contract.length
    && lines.every((line, index) => contract[index]!.test(line))
}

/** 判断逻辑 shell 行与精确文本合同逐项一致，适用于固定控制流脚本。 */
function stepMatchesExactContract(
  step: Record<string, unknown> | undefined,
  contract: readonly string[],
): boolean {
  /** 当前 step 去除空行和纯注释后的全部可执行逻辑行。 */
  const lines = getLogicalShellLines(step)
  return lines.length === contract.length
    && lines.every((line, index) => line === contract[index])
}

/** 判断解析后的命令参数与期望完全一致。 */
function commandEquals(command: ShellCommand | undefined, expectedArgv: readonly string[]): boolean {
  return Boolean(
    command
    && command.argv.length === expectedArgv.length
    && command.argv.every((argument, index) => argument === expectedArgv[index]),
  )
}

/** 判断未知 YAML 节点是否为普通对象映射。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 判断 YAML map 的顶层键与执行合同完全一致，既不缺失也不扩张。 */
function hasExactKeys(
  value: Record<string, unknown> | undefined,
  expectedKeys: ReadonlySet<string>,
): boolean {
  if (!value) return false
  /** 当前 map 的全部顶层字段。 */
  const actualKeys = Object.keys(value)
  return actualKeys.length === expectedKeys.size && actualKeys.every((key) => expectedKeys.has(key))
}

/** 使用 Bun 内置解析器读取 YAML 映射，并把语法/根类型错误写入诊断。 */
function parseYamlRecord(content: string, label: string, details: string[]): Record<string, unknown> | undefined {
  try {
    /** Bun YAML 解析后的未知根节点。 */
    const parsed: unknown = Bun.YAML.parse(content)
    if (!isRecord(parsed)) {
      details.push(`${label} 根节点必须是 YAML map`)
      return undefined
    }
    return parsed
  } catch (error) {
    details.push(`${label} YAML 解析失败：${error instanceof Error ? error.message : String(error)}`)
    return undefined
  }
}

/** 返回 workflow step 的字符串 run 内容。 */
function getStepRun(step: Record<string, unknown> | undefined): string | undefined {
  return step && typeof step.run === 'string' ? step.run : undefined
}

/** 判断 step 只执行一条给定 argv 的安全命令。 */
function stepRunsExactCommand(step: Record<string, unknown> | undefined, expectedArgv: readonly string[]): boolean {
  /** 当前 step 的 shell 脚本文本。 */
  const run = getStepRun(step)
  if (!run) return false
  /** 只接受无短路、变量或子 shell 的单命令脚本。 */
  const commands = parseConjunctiveShellCommands(run)
  return commands?.length === 1 && commandEquals(commands[0], expectedArgv)
}

/** 判断复杂 shell step 中存在行首真实命令，echo/引号文本不会命中。 */
function stepHasDirectCommand(step: Record<string, unknown> | undefined, pattern: RegExp): boolean {
  return getLogicalShellLines(step).some((line) => pattern.test(line))
}

/** 递归收集结构化 workflow 中全部 run 脚本，不局限于约定 job 或 step 名称。 */
function collectWorkflowRunScripts(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(collectWorkflowRunScripts)
  if (!isRecord(value)) return []
  /** 当前 YAML map 及其后代中的全部 run 文本。 */
  const scripts: string[] = []
  for (const [key, child] of Object.entries(value)) {
    if (key === 'run' && typeof child === 'string') scripts.push(child)
    else scripts.push(...collectWorkflowRunScripts(child))
  }
  return scripts
}

/** 递归收集结构化 workflow 中全部 uses 引用。 */
function collectWorkflowUses(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(collectWorkflowUses)
  if (!isRecord(value)) return []
  /** 当前 YAML map 及其后代中的全部 uses 字符串。 */
  const uses: string[] = []
  for (const [key, child] of Object.entries(value)) {
    if (key === 'uses' && typeof child === 'string') uses.push(child)
    else uses.push(...collectWorkflowUses(child))
  }
  return uses
}

/** 判断关键 shell step 是否含无法静态证明可达性的控制结构。 */
function hasShellControlStructure(step: Record<string, unknown> | undefined): boolean {
  /** 当前 step 的 shell 脚本文本。 */
  const run = getStepRun(step)
  if (!run) return false
  /** 命令起点或连接符后的控制关键字，以及 POSIX 函数声明。 */
  const controlKeyword = /(?:^|[;&|]\s*)(?:if|then|elif|else|fi|for|while|until|select|do|done|case|esac|function|exit|return|break|continue)\b/
  const functionDeclaration = /^[A-Za-z_][A-Za-z0-9_]*\s*\(\)\s*\{/
  return normalizeShellContinuations(run).split(/\r?\n/).some((line) => {
    /** 注释行不参与 shell 结构判断。 */
    const trimmed = line.trim()
    return trimmed.length > 0
      && !trimmed.startsWith('#')
      && (controlKeyword.test(trimmed) || functionDeclaration.test(trimmed))
  })
}

/** 判断 shell 脚本是否包含兼容检查职责之外的发布或远端写副作用。 */
function hasForbiddenWorkflowCommand(run: string): boolean {
  /** 仅匹配行首或 shell 连接符后的真实命令位置，避免把 echo 文本误判为执行。 */
  const forbiddenCommand = /(?:^|(?:&&|\|\||;)\s*)(?:if\s+)?(?:git\s+push\b|gh\s+(?:pr|release)\b|(?:bun|npm|pnpm|yarn)\s+(?:run\s+)?(?:release|publish)\b|cargo\s+publish\b|twine\s+upload\b|docker\s+push\b|electron-builder\b[^\n]*\s--publish\b)/
  return normalizeShellContinuations(run).split(/\r?\n/).some((line) => forbiddenCommand.test(line.trim()))
}

/** 检查主进程 Bridge 注册与统一启动组合点。 */
function checkBridgeComposition(reader: RepositoryReader): ForkCompatCheckResult {
  /** 当前检查的失败原因。 */
  const details: string[] = []
  /** 主进程组合根源码。 */
  const main = readRequired(reader, PATHS.main, details)
  /** LAN Bridge 生命周期注册源码。 */
  const bridge = readRequired(reader, PATHS.bridge, details)
  /** 主进程绑定上下文和 LAN Bridge AST。 */
  const mainContext = createTypeScriptBindingContext(PATHS.main, main)
  const mainSource = mainContext.sourceFile
  const bridgeSource = parseTypeScript(PATHS.bridge, bridge)
  /** Bridge registry、LAN factory 与官方 EventBus 的真实 import bindings。 */
  const registerBridgeBindings = collectImportedLocalBindings(
    mainContext,
    './lib/bridge-registry',
    'registerBridge',
  )
  const startAllBridgesBindings = collectImportedLocalBindings(
    mainContext,
    './lib/bridge-registry',
    'startAllBridges',
  )
  const factoryBindings = collectImportedLocalBindings(
    mainContext,
    './lib/lan-bridge/lan-bridge',
    'createLanBridgeRegistration',
  )
  const eventBusBindings = collectImportedLocalBindings(
    mainContext,
    './lib/agent-service',
    'agentEventBus',
  )
  /** 只统计真实 registry 与 LAN factory 组合的注册调用。 */
  const registrationCount = countLanBridgeRegistrations(
    mainSource,
    registerBridgeBindings,
    factoryBindings,
    eventBusBindings,
    mainContext.checker,
  )
  /** Program 顶层实际执行且绑定 agentEventBus 的注册次数。 */
  const topLevelRegistrationCount = countTopLevelLanBridgeRegistrations(
    mainSource,
    registerBridgeBindings,
    factoryBindings,
    eventBusBindings,
    mainContext.checker,
  )
  /** 顶层挂接且顺序可达的 bootstrap。 */
  const bootstrap = findNamedFunction(mainSource, 'bootstrap')
  const hasReachableStart = hasReachableBootstrapRegistration(mainSource)
    && bootstrapStartsAllBridges(bootstrap, startAllBridgesBindings, mainContext.checker)
  /** 导出的显式注入 factory。 */
  const registrationFactory = findExportedFunction(bridgeSource, 'createLanBridgeRegistration')
  /** factory 首个参数是必须由 start 消费的注入 EventBus。 */
  const injectedParameter = registrationFactory?.parameters[0]?.name
  const injectedName = injectedParameter && ts.isIdentifier(injectedParameter) ? injectedParameter.text : undefined
  /** 返回对象的 start 函数是否直接消费注入参数。 */
  const startUsesInjectedBus = Boolean(
    registrationFactory
    && injectedName
    && returnedObjectStartUsesInjectedBus(registrationFactory, injectedName),
  )

  if (registrationCount !== 1 || topLevelRegistrationCount !== 1) {
    details.push('主进程必须且只能在 Program 顶层注册一次 createLanBridgeRegistration(agentEventBus)')
  }
  if (!hasReachableStart) details.push('主进程 bootstrap 可达顶层路径未启动统一 Bridge 生命周期')
  if (!registrationFactory) details.push('LAN Bridge 未导出 createLanBridgeRegistration')
  if (!startUsesInjectedBus) details.push('LAN registration 返回对象的 start 未直接把注入 EventBus 交给 startLanBridge')

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
  /** 根 IPC binding context 与导出的注册函数。 */
  const rootContext = createTypeScriptBindingContext(PATHS.rootIpc, rootIpc)
  const rootSource = rootContext.sourceFile
  const registerFunction = findExportedFunction(rootSource, 'registerIpcHandlers')
  /** registrar 与 dependencies factory 必须来自目标模块的真实 named import。 */
  const registrarBindings = collectImportedLocalBindings(
    rootContext,
    './lib/lan-bridge/lan-bridge-ipc',
    'registerLanBridgeIpcHandlers',
  )
  const dependencyFactoryBindings = collectImportedLocalBindings(
    rootContext,
    './lib/lan-bridge/lan-bridge-ipc',
    'createLanBridgeIpcDependencies',
  )
  /** registerIpcHandlers 函数体中的直接且来源可信的 LAN registrar 调用。 */
  let directCalls = 0
  /** 根 IPC 中满足显式 EventBus 注入形状的调用数量。 */
  let injectedCalls = 0
  if (registerFunction?.body) {
    for (const statement of registerFunction.body.statements) {
      if (!ts.isExpressionStatement(statement) || !ts.isCallExpression(statement.expression)) continue
      if (
        !ts.isIdentifier(statement.expression.expression)
        || !identifierUsesImportedBinding(
          statement.expression.expression,
          registrarBindings,
          rootContext.checker,
        )
      ) continue
      directCalls += 1
      /** registrar 第二参数必须由根组合点绑定 agentEventBus。 */
      const dependencies = statement.expression.arguments[1]
      if (
        ts.isCallExpression(dependencies)
        && ts.isIdentifier(dependencies.expression)
        && identifierUsesImportedBinding(
          dependencies.expression,
          dependencyFactoryBindings,
          rootContext.checker,
        )
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
  /** 根 preload binding context。 */
  const context = createTypeScriptBindingContext(PATHS.rootPreload, rootPreload)
  const sourceFile = context.sourceFile
  /** preload factory 必须来自目标模块的真实 named import。 */
  const factoryBindings = collectImportedLocalBindings(
    context,
    './lan-bridge-preload',
    'createLanBridgePreloadApi',
  )
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
  /** factory 结果变量自身的 symbol，spread 必须绑定同一声明。 */
  const lanApiSymbol = lanApi && ts.isIdentifier(lanApi.name)
    ? context.checker.getSymbolAtLocation(lanApi.name)
    : undefined
  /** 最终 electronAPI 对象中的 LAN spread 数量。 */
  const spreadCount = electronApi?.initializer && ts.isObjectLiteralExpression(electronApi.initializer)
    ? electronApi.initializer.properties.filter((property) => (
      ts.isSpreadAssignment(property)
      && ts.isIdentifier(property.expression)
      && Boolean(lanApiSymbol && context.checker.getSymbolAtLocation(property.expression) === lanApiSymbol)
    )).length
    : 0
  /** 独立 factory 的真实调用形状。 */
  const hasFactoryInitializer = Boolean(
    lanApi?.initializer
    && ts.isCallExpression(lanApi.initializer)
    && ts.isIdentifier(lanApi.initializer.expression)
    && identifierUsesImportedBinding(lanApi.initializer.expression, factoryBindings, context.checker)
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
  const getOfficialModule = (specifier: string): string | undefined => {
    /** 去除运行时模块常见 JS/TS 扩展名后的规范说明符。 */
    const normalizedSpecifier = specifier.replace(/\.(?:[cm]?[jt]sx?)$/, '')
    return OFFICIAL_RUNTIME_MODULES.find((moduleName) => (
      normalizedSpecifier === `../${moduleName}`
      || normalizedSpecifier === `./${moduleName}`
      || normalizedSpecifier.endsWith(`/${moduleName}`)
    ))
  }
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
      .map((dependency) => dependency.specifier ? getOfficialModule(dependency.specifier) : undefined)
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
      if (dependency.specifier === undefined) {
        details.push(`LAN 生产模块使用非字面量 ${dependency.syntax}：${path}；请改用可静态检查的静态字符串`)
        continue
      }
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
  if (collectRuntimeDependencies(PATHS.adapterCore, adapterCore).some((dependency) => (
    dependency.specifier !== undefined && getOfficialModule(dependency.specifier) !== undefined
  ))) {
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
    /** 两个脚本都通过同一个保守 shell 解析器得到顶层命令链。 */
    const buildMobileCommands = parseConjunctiveShellCommands(buildMobile)
    const packagePrepareCommands = parseConjunctiveShellCommands(packagePrepare)
    /** build:mobile 唯一允许的真实 workspace 构建命令。 */
    const hasValidMobileBuild = buildMobileCommands?.length === 1
      && commandEquals(buildMobileCommands[0], ['bun', 'run', '--filter=@proma/mobile', 'build'])
    /** package:prepare 必须无额外前置命令地执行固定三步。 */
    const hasValidPackagePrepare = packagePrepareCommands?.length === 3
      && commandEquals(packagePrepareCommands[0], ['bun', 'run', 'build'])
      && commandEquals(packagePrepareCommands[1], ['bun', 'run', 'build:mobile'])
      && commandEquals(packagePrepareCommands[2], ['bun', 'run', 'sync:runtime-deps'])

    if (!hasValidMobileBuild) details.push('build:mobile 必须直接执行 @proma/mobile workspace build')
    if (!hasValidPackagePrepare) details.push('package:prepare 必须按 Electron build、mobile build、runtime 同步顺序直接执行')
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
  /** 结构化 builder YAML 根映射。 */
  const document = parseYamlRecord(builder, 'electron-builder', details)
  /** 顶层 extraResources 原始节点。 */
  const resources = document?.extraResources
  if (!Array.isArray(resources)) {
    details.push('electron-builder 顶层 extraResources 必须是数组')
  } else {
    /** from/to 精确匹配且自身为 map 的移动端资源项。 */
    const mobileResource = resources.find((entry) => (
      isRecord(entry)
      && entry.from === '../../apps/mobile/dist'
      && entry.to === 'mobile-dist'
    ))
    if (!isRecord(mobileResource)) {
      details.push('顶层 extraResources 缺少 mobile dist 到 mobile-dist 的精确 map')
    } else if (!Array.isArray(mobileResource.filter) || !mobileResource.filter.every((item) => typeof item === 'string')) {
      details.push('mobile-dist 资源项 filter 必须是字符串数组')
    } else if (!mobileResource.filter.includes('**/*')) {
      details.push('mobile-dist 资源项缺少 **/* filter')
    }
  }

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
  /** merge 状态 helper 必须随兼容检查保留。 */
  readRequired(reader, PATHS.mergeHelper, details)
  /** 结构化 workflow YAML 根映射。 */
  const document = parseYamlRecord(workflow, 'upstream workflow', details)
  if (document) {
    /** workflow 触发器映射。 */
    const triggers = isRecord(document.on) ? document.on : undefined
    if (!triggers || !Object.hasOwn(triggers, 'workflow_dispatch')) details.push('workflow 缺少 workflow_dispatch 手动触发')
    /** 每周 schedule 的 cron 条目。 */
    const schedules = triggers?.schedule
    const hasWeeklySchedule = Array.isArray(schedules) && schedules.some((schedule) => (
      isRecord(schedule)
      && typeof schedule.cron === 'string'
      && /^\S+\s+\S+\s+\*\s+\*\s+(?:1|MON)$/i.test(schedule.cron.trim())
    ))
    if (!hasWeeklySchedule) details.push('workflow 缺少每周 schedule 触发')

    /** 最小只读权限与并发去重配置。 */
    const permissions = isRecord(document.permissions) ? document.permissions : undefined
    if (!permissions || permissions.contents !== 'read' || Object.keys(permissions).length !== 1) {
      details.push('workflow permissions 必须且只能包含 contents: read')
    }
    const concurrency = isRecord(document.concurrency) ? document.concurrency : undefined
    if (
      typeof concurrency?.group !== 'string'
      || !concurrency.group.includes('github.ref')
      || concurrency['cancel-in-progress'] !== true
    ) details.push('workflow concurrency 必须按 github.ref 分组并取消旧任务')

    /** 唯一上游验证 job。 */
    const jobs = isRecord(document.jobs) ? document.jobs : undefined
    const job = jobs && isRecord(jobs['verify-upstream-merge']) ? jobs['verify-upstream-merge'] : undefined
    /** 验证 job 只能保留当前工作流实际使用的四个字段。 */
    const jobAllowedKeys = new Set(['name', 'runs-on', 'timeout-minutes', 'steps'])
    if (!jobs || Object.keys(jobs).length !== 1 || !job) details.push('workflow 必须且只能包含 verify-upstream-merge job')
    if (job && !hasExactKeys(job, jobAllowedKeys)) details.push('verify-upstream-merge job 顶层字段必须符合固定闭集')
    if (typeof job?.['timeout-minutes'] !== 'number' || job['timeout-minutes'] <= 0) {
      details.push('上游验证 job 缺少正数 timeout-minutes')
    }
    /** 结构化 step 列表。 */
    const steps = Array.isArray(job?.steps) ? job.steps.filter(isRecord) : []
    const findStep = (name: string): Record<string, unknown> | undefined => steps.find((step) => step.name === name)
    const stepIndex = (name: string): number => steps.findIndex((step) => step.name === name)
    /** action step 的固定顶层字段。 */
    const actionStepAllowedKeys = new Set(['name', 'uses', 'with'])
    /** tag 选择 step 的固定顶层字段。 */
    const selectTagStepAllowedKeys = new Set(['name', 'id', 'shell', 'run'])
    /** merge step 的固定顶层字段。 */
    const mergeStepAllowedKeys = new Set(['name', 'shell', 'env', 'run'])
    /** merge 状态 helper step 的固定顶层字段。 */
    const verifyMergeStepAllowedKeys = new Set(['name', 'env', 'run'])
    /** 无额外执行配置的普通 run step 固定顶层字段。 */
    const simpleRunStepAllowedKeys = new Set(['name', 'run'])
    /** cleanup 是唯一允许 always 条件的 run step。 */
    const cleanupStepAllowedKeys = new Set(['name', 'if', 'shell', 'env', 'run'])

    /** checkout 与 Bun 安装 action 配置。 */
    const checkout = findStep('Checkout fork with full history')
    const checkoutWith = checkout && isRecord(checkout.with) ? checkout.with : undefined
    if (
      !hasExactKeys(checkout, actionStepAllowedKeys)
      || checkout?.uses !== 'actions/checkout@v4'
      || checkoutWith?.['fetch-depth'] !== 0
      || checkoutWith?.['fetch-tags'] !== true
    ) {
      details.push('checkout 必须使用 v4、fetch-depth 0 并拉取 tags')
    }
    const setupBun = findStep('Install Bun')
    const setupBunWith = setupBun && isRecord(setupBun.with) ? setupBun.with : undefined
    if (
      !hasExactKeys(setupBun, actionStepAllowedKeys)
      || setupBun?.uses !== 'oven-sh/setup-bun@v2'
      || setupBunWith?.['bun-version'] !== 'latest'
    ) {
      details.push('Bun 安装步骤必须使用 setup-bun@v2 latest')
    }
    /** 所有 action 引用必须来自当前验证任务的精确 allowlist。 */
    const allowedActions = new Set(['actions/checkout@v4', 'oven-sh/setup-bun@v2'])
    if (collectWorkflowUses(document).some((action) => !allowedActions.has(action))) {
      details.push('workflow uses 包含未批准 action')
    }

    /** 上游 tag 选择必须符合完整线性合同，顺序与命令集合都不可扩张。 */
    const selectTag = findStep('Select latest official release tag')
    /** 变量只能在定义后引用，remote 也只能执行一次精确 add。 */
    const selectTagContract = [
      /^set -euo pipefail$/,
      /^git remote add upstream https:\/\/github\.com\/ErlichLiu\/Proma\.git$/,
      /^git fetch --force upstream ['"]\+refs\/tags\/\*:refs\/tags\/upstream\/\*['"]$/,
      /^readonly TEMP_BRANCH=["']compat\/upstream-\$\{?GITHUB_RUN_ID\}?-\$\{?GITHUB_RUN_ATTEMPT\}?["']$/,
      /^readonly BASE_SHA=["']\$\(git rev-parse HEAD\)["']$/,
      /^readonly RAW_TAGS_FILE=["']\$RUNNER_TEMP\/upstream-tags\.txt["']$/,
      /^readonly NAMESPACED_RELEASE_TAGS_FILE=["']\$RUNNER_TEMP\/upstream-namespaced-release-tags\.txt["']$/,
      /^readonly RELEASE_TAGS_FILE=["']\$RUNNER_TEMP\/upstream-release-tags\.txt["']$/,
      /^readonly SORTED_TAGS_FILE=["']\$RUNNER_TEMP\/upstream-release-tags\.sorted\.txt["']$/,
      /^git tag --list ['"]upstream\/v\*['"] > ["']\$RAW_TAGS_FILE["']$/,
      /^grep -E ['"]\^upstream\/v\(0\|\[1-9\]\[0-9\]\*\)\\\.\(0\|\[1-9\]\[0-9\]\*\)\\\.\(0\|\[1-9\]\[0-9\]\*\)\$['"] ["']\$RAW_TAGS_FILE["'] > ["']\$NAMESPACED_RELEASE_TAGS_FILE["']$/,
      /^sed ['"]s#\^upstream\/##["'] ["']\$NAMESPACED_RELEASE_TAGS_FILE["'] > ["']\$RELEASE_TAGS_FILE["']$/,
      /^sort -V ["']\$RELEASE_TAGS_FILE["'] > ["']\$SORTED_TAGS_FILE["']$/,
      /^readonly LATEST_TAG=["']\$\(tail -n 1 ["']\$SORTED_TAGS_FILE["']\)["']$/,
      /^test -n ["']\$LATEST_TAG["']$/,
      /^readonly UPSTREAM_TAG_REF=["']refs\/tags\/upstream\/\$LATEST_TAG["']$/,
      /^readonly UPSTREAM_SHA=["']\$\(git rev-parse ["']\$\{UPSTREAM_TAG_REF\}\^\{commit\}["']\)["']$/,
      /^echo ["']base_sha=\$BASE_SHA["'] >> ["']\$GITHUB_OUTPUT["']$/,
      /^echo ["']tag=\$LATEST_TAG["'] >> ["']\$GITHUB_OUTPUT["']$/,
      /^echo ["']tag_ref=\$UPSTREAM_TAG_REF["'] >> ["']\$GITHUB_OUTPUT["']$/,
      /^echo ["']upstream_sha=\$UPSTREAM_SHA["'] >> ["']\$GITHUB_OUTPUT["']$/,
      /^echo ["']temp_branch=\$TEMP_BRANCH["'] >> ["']\$GITHUB_OUTPUT["']$/,
    ] as const
    if (
      !hasExactKeys(selectTag, selectTagStepAllowedKeys)
      || selectTag?.id !== 'upstream'
      || hasShellControlStructure(selectTag)
      || !stepMatchesLinearContract(selectTag, selectTagContract)
    ) details.push('上游 tag 步骤必须严格按官方 remote、fetch、候选筛选、最大 tag 验证、只读 ref 与 outputs 的线性合同执行')
    const merge = findStep('Merge upstream tag without committing')
    /** merge 的 tag ref 只能来自已验证 select step 的精确 output。 */
    const mergeEnv = merge && isRecord(merge.env) ? merge.env : undefined
    /** merge 后保留待验证状态，只允许现行诊断输出，不允许插入破坏命令。 */
    const mergeContract = [
      /^set -euo pipefail$/,
      /^git switch --create ["']\$TEMP_BRANCH["'] ["']\$BASE_SHA["']$/,
      /^git merge --no-commit --no-ff ["']\$UPSTREAM_TAG_REF["']$/,
      /^echo ["']base=\$BASE_SHA["']$/,
      /^echo ["']head=\$\(git rev-parse HEAD\)["']$/,
      /^echo ["']upstream_tag=\$UPSTREAM_TAG["']$/,
      /^git status --short$/,
      /^git diff --cached --stat$/,
    ] as const
    if (
      !hasExactKeys(merge, mergeStepAllowedKeys)
      || merge?.shell !== 'bash'
      || hasShellControlStructure(merge)
      || mergeEnv?.BASE_SHA !== '${{ steps.upstream.outputs.base_sha }}'
      || mergeEnv?.TEMP_BRANCH !== '${{ steps.upstream.outputs.temp_branch }}'
      || mergeEnv?.UPSTREAM_TAG !== '${{ steps.upstream.outputs.tag }}'
      || mergeEnv?.UPSTREAM_TAG_REF !== '${{ steps.upstream.outputs.tag_ref }}'
      || !stepMatchesLinearContract(merge, mergeContract)
    ) details.push('merge 步骤必须按 switch、merge、诊断输出的有序闭集合同执行，并保留 merge 状态供 helper 验证')

    /** helper 必须紧随 merge，并使用同一个受信 tag_ref output。 */
    const verifyMerge = findStep('Verify upstream merge state')
    const verifyMergeEnv = verifyMerge && isRecord(verifyMerge.env) ? verifyMerge.env : undefined
    if (
      !hasExactKeys(verifyMerge, verifyMergeStepAllowedKeys)
      || verifyMergeEnv?.UPSTREAM_TAG_REF !== '${{ steps.upstream.outputs.tag_ref }}'
      || !stepRunsExactCommand(verifyMerge, ['bun', 'run', 'apps/electron/scripts/verify-upstream-merge.ts'])
    ) details.push('merge 状态 helper 必须使用 select step 的 tag_ref 执行只读双态验证')

    /** 简单验证步骤必须是唯一真实命令。 */
    const requiredCommands: Array<[string, readonly string[]]> = [
      ['Install dependencies from merged tree', ['bun', 'install', '--frozen-lockfile']],
      ['Check fork compatibility seams', ['bun', 'run', '--filter=@proma/electron', 'check:fork-compat']],
      ['Run LAN and mobile targeted tests', [
        'bun',
        'test',
        'apps/electron/scripts/check-fork-compat.test.ts',
        'apps/electron/scripts/verify-upstream-merge.test.ts',
        'apps/electron/src/main/lib/lan-bridge',
        'apps/electron/src/preload/lan-bridge-preload.test.ts',
        'apps/mobile/src/lib',
      ]],
      ['Build mobile app', ['bun', 'run', '--filter=@proma/mobile', 'build']],
      ['Typecheck all workspaces', ['bun', 'run', 'typecheck']],
      ['Build Electron app', ['bun', 'run', 'electron:build']],
    ]
    for (const [name, expectedArgv] of requiredCommands) {
      /** 当前约定名称对应的普通 run step。 */
      const step = findStep(name)
      if (!hasExactKeys(step, simpleRunStepAllowedKeys) || !stepRunsExactCommand(step, expectedArgv)) {
        details.push(`${name} 必须执行约定的真实命令且不得包含额外执行字段`)
      }
    }

    /** 关键步骤必须保持从合并到验证再清理的顺序。 */
    const orderedStepNames = [
      'Checkout fork with full history',
      'Install Bun',
      'Select latest official release tag',
      'Merge upstream tag without committing',
      'Verify upstream merge state',
      'Install dependencies from merged tree',
      'Check fork compatibility seams',
      'Run LAN and mobile targeted tests',
      'Build mobile app',
      'Typecheck all workspaces',
      'Build Electron app',
      'Abort merge and remove temporary branch',
    ]
    const orderedIndexes = orderedStepNames.map(stepIndex)
    if (orderedIndexes.some((index) => index < 0) || orderedIndexes.some((index, position) => position > 0 && index <= orderedIndexes[position - 1]!)) {
      details.push('workflow 关键步骤缺失或顺序错误')
    }

    /** cleanup 必须始终运行，并按生产脚本的固定控制流逐项聚合清理失败。 */
    const cleanup = findStep('Abort merge and remove temporary branch')
    /** cleanup 只能读取 select step 产生的 base 和临时分支 outputs。 */
    const cleanupEnv = cleanup && isRecord(cleanup.env) ? cleanup.env : undefined
    /** 完整闭集锁定函数、三个尝试分支、状态聚合与最终退出顺序。 */
    const cleanupContract = [
      'set -u',
      'cleanup_failed=0',
      'run_cleanup() {',
      'local label="$1"',
      'shift',
      'echo "cleanup: $label"',
      'if "$@"; then',
      'echo "cleanup passed: $label"',
      'else',
      'echo "cleanup failed: $label" >&2',
      'cleanup_failed=1',
      'fi',
      '}',
      'if git rev-parse --verify --quiet MERGE_HEAD >/dev/null; then',
      "run_cleanup 'abort merge' git merge --abort",
      'else',
      "echo 'cleanup skipped: no merge in progress'",
      'fi',
      'if [[ -n "${BASE_SHA:-}" ]]; then',
      "run_cleanup 'switch to base' git switch --detach \"$BASE_SHA\"",
      'else',
      "echo 'cleanup skipped: base SHA unavailable'",
      'fi',
      'if [[ -n "${TEMP_BRANCH:-}" ]] && git show-ref --verify --quiet "refs/heads/$TEMP_BRANCH"; then',
      "run_cleanup 'delete temporary branch' git branch --delete --force \"$TEMP_BRANCH\"",
      'else',
      "echo 'cleanup skipped: temporary branch unavailable'",
      'fi',
      'exit "$cleanup_failed"',
    ] as const
    if (
      cleanup?.if !== 'always()'
      || !hasExactKeys(cleanup, cleanupStepAllowedKeys)
      || cleanup?.shell !== 'bash'
      || cleanupEnv?.BASE_SHA !== '${{ steps.upstream.outputs.base_sha }}'
      || cleanupEnv?.TEMP_BRANCH !== '${{ steps.upstream.outputs.temp_branch }}'
      || Object.keys(cleanupEnv ?? {}).length !== 2
      || !stepMatchesExactContract(cleanup, cleanupContract)
    ) details.push('cleanup 必须按固定有序闭集尝试 abort、switch、delete，并返回聚合失败')

    /** 任何关键 run 都不能使用 || true 静默吞错。 */
    if (steps.some((step) => /\|\|\s*true\b/.test(normalizeShellContinuations(getStepRun(step) ?? '')))) {
      details.push('workflow 使用 || true 吞掉命令或 pipeline 错误')
    }
    /** 任意 job 的 run 都不能写远端、创建 PR/release 或发布制品。 */
    if (collectWorkflowRunScripts(document).some(hasForbiddenWorkflowCommand)) {
      details.push('workflow 不得执行 git push、PR、release 或 publish 副作用命令')
    }
  }

  return createResult(
    'workflow-definition',
    '上游兼容 workflow 失败传播',
    [PATHS.workflow, PATHS.mergeHelper],
    '保留 manual+weekly 触发、最小权限、完整 checkout、固定验证命令顺序与 always cleanup；关键 run 不得用 echo 伪装。',
    details,
  )
}

/** 去除不改变运行时调用形状的 TypeScript 表达式包装。 */
function unwrapTypeScriptExpression(expression: ts.Expression): ts.Expression {
  if (ts.isParenthesizedExpression(expression)) return unwrapTypeScriptExpression(expression.expression)
  if (ts.isAsExpression(expression)) return unwrapTypeScriptExpression(expression.expression)
  if (ts.isTypeAssertionExpression(expression)) return unwrapTypeScriptExpression(expression.expression)
  if (ts.isSatisfiesExpression(expression)) return unwrapTypeScriptExpression(expression.expression)
  if (ts.isNonNullExpression(expression)) return unwrapTypeScriptExpression(expression.expression)
  return expression
}

/** 返回对象属性的静态名称。 */
function getStaticPropertyName(name: ts.PropertyName): string | undefined {
  if (ts.isIdentifier(name) || ts.isStringLiteralLike(name) || ts.isNumericLiteral(name)) return name.text
  return undefined
}

/** 查找顶层命名变量声明。 */
function findTopLevelVariable(sourceFile: ts.SourceFile, name: string): ts.VariableDeclaration | undefined {
  for (const statement of sourceFile.statements) {
    if (!ts.isVariableStatement(statement)) continue
    /** 当前变量语句中的目标声明。 */
    const declaration = statement.declarationList.declarations.find((candidate) => (
      ts.isIdentifier(candidate.name) && candidate.name.text === name
    ))
    if (declaration) return declaration
  }
  return undefined
}

/** 读取函数体直接 return 的对象字面量。 */
function findDirectReturnedObject(functionDeclaration: ts.FunctionDeclaration): ts.ObjectLiteralExpression | undefined {
  if (!functionDeclaration.body) return undefined
  for (const statement of functionDeclaration.body.statements) {
    if (ts.isReturnStatement(statement) && statement.expression) {
      /** 去除 as/括号后的直接返回值。 */
      const returned = unwrapTypeScriptExpression(statement.expression)
      return ts.isObjectLiteralExpression(returned) ? returned : undefined
    }
    if (ts.isReturnStatement(statement) || ts.isThrowStatement(statement)) return undefined
  }
  return undefined
}

/** 读取属性函数直接返回的表达式，不进入嵌套控制流。 */
function getDirectFunctionResult(initializer: ts.Expression): ts.Expression | undefined {
  /** 去除属性值外围类型包装。 */
  const functionExpression = unwrapTypeScriptExpression(initializer)
  if (!ts.isArrowFunction(functionExpression) && !ts.isFunctionExpression(functionExpression)) return undefined
  if (!ts.isBlock(functionExpression.body)) return unwrapTypeScriptExpression(functionExpression.body)
  for (const statement of functionExpression.body.statements) {
    if (ts.isReturnStatement(statement) && statement.expression) {
      return unwrapTypeScriptExpression(statement.expression)
    }
    if (ts.isReturnStatement(statement) || ts.isThrowStatement(statement)) return undefined
  }
  return undefined
}

/** 判断表达式是否直接调用指定 ipc 方法与 LAN 通道。 */
function isDirectLanIpcCall(
  expression: ts.Expression,
  ipcParameterName: string,
  methodName: 'handle' | 'invoke',
  channelKey: string,
): boolean {
  /** 去除返回表达式外围类型包装后的调用。 */
  const call = unwrapTypeScriptExpression(expression)
  if (!ts.isCallExpression(call) || !ts.isPropertyAccessExpression(call.expression)) return false
  if (
    call.expression.name.text !== methodName
    || !ts.isIdentifier(call.expression.expression)
    || call.expression.expression.text !== ipcParameterName
  ) return false
  /** 首个参数必须是 LAN 通道对象的静态属性。 */
  const channel = call.arguments[0]
  return Boolean(
    channel
    && ts.isPropertyAccessExpression(channel)
    && ts.isIdentifier(channel.expression)
    && channel.expression.text === 'LAN_BRIDGE_IPC_CHANNELS'
    && channel.name.text === channelKey,
  )
}

/** 统计 registrar 函数体中直接执行的指定通道 handler。 */
function countDirectLanIpcHandlers(functionDeclaration: ts.FunctionDeclaration, channelKey: string): number {
  /** registrar 的 IPC 参数名。 */
  const ipcParameter = functionDeclaration.parameters[0]?.name
  if (!ipcParameter || !ts.isIdentifier(ipcParameter) || !functionDeclaration.body) return 0
  /** 只统计首个无条件终止语句之前的顶层 handler。 */
  let count = 0
  for (const statement of functionDeclaration.body.statements) {
    if (ts.isReturnStatement(statement) || ts.isThrowStatement(statement)) break
    if (
      ts.isExpressionStatement(statement)
      && isDirectLanIpcCall(statement.expression, ipcParameter.text, 'handle', channelKey)
    ) count += 1
  }
  return count
}

/** 判断 preload factory 返回对象的方法是否直接 invoke 对应通道。 */
function hasMappedPreloadMethod(
  returnedObject: ts.ObjectLiteralExpression | undefined,
  ipcParameterName: string | undefined,
  methodName: string,
  channelKey: string,
): boolean {
  if (!returnedObject || !ipcParameterName) return false
  /** 返回对象中同名的直接属性。 */
  const properties = returnedObject.properties.filter((property): property is ts.PropertyAssignment => (
    ts.isPropertyAssignment(property) && getStaticPropertyName(property.name) === methodName
  ))
  if (properties.length !== 1) return false
  /** 方法函数必须直接返回对应 ipc.invoke 调用。 */
  const result = getDirectFunctionResult(properties[0]!.initializer)
  return Boolean(result && isDirectLanIpcCall(result, ipcParameterName, 'invoke', channelKey))
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
  /** 三层合同源码的 AST。 */
  const sharedSource = parseTypeScript(PATHS.sharedProtocol, shared)
  const lanIpcSource = parseTypeScript(PATHS.lanIpc, lanIpc)
  const lanPreloadSource = parseTypeScript(PATHS.lanPreload, lanPreload)
  /** 共享通道对象、registrar 与 preload factory。 */
  const sharedChannels = findTopLevelVariable(sharedSource, 'LAN_BRIDGE_IPC_CHANNELS')
  const sharedChannelObject = sharedChannels?.initializer
    ? unwrapTypeScriptExpression(sharedChannels.initializer)
    : undefined
  const registrar = findExportedFunction(lanIpcSource, 'registerLanBridgeIpcHandlers')
  const preloadFactory = findExportedFunction(lanPreloadSource, 'createLanBridgePreloadApi')
  /** preload factory 的 IPC 参数名与直接返回对象。 */
  const preloadIpcParameter = preloadFactory?.parameters[0]?.name
  const preloadIpcParameterName = preloadIpcParameter && ts.isIdentifier(preloadIpcParameter)
    ? preloadIpcParameter.text
    : undefined
  const preloadApi = preloadFactory ? findDirectReturnedObject(preloadFactory) : undefined

  for (const key of LAN_IPC_COMMAND_KEYS) {
    /** 共享对象中当前通道键的真实属性数量。 */
    const sharedKeyCount = ts.isObjectLiteralExpression(sharedChannelObject)
      ? sharedChannelObject.properties.filter((property) => getStaticPropertyName(property.name) === key).length
      : 0
    if (sharedKeyCount !== 1) details.push(`共享通道常量缺少或重复：${key}`)
    if (!registrar || countDirectLanIpcHandlers(registrar, key) !== 1) {
      details.push(`LAN IPC registrar 缺少或重复直接 handler：${key}`)
    }
  }
  for (const [method, channelKey] of LAN_PRELOAD_METHOD_CHANNELS) {
    if (!hasMappedPreloadMethod(preloadApi, preloadIpcParameterName, method, channelKey)) {
      details.push(`LAN preload 方法未直接调用对应通道：${method} -> ${channelKey}`)
    }
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
  /** 仓库根真实路径，用于抵御根内 symlink 越界。 */
  const realRepositoryRoot = realpathSync(resolve(repositoryRoot))
  /** 判断绝对路径是否仍位于仓库真实根内。 */
  const isInsideRepository = (absolutePath: string): boolean => {
    /** 从仓库根到目标的相对路径。 */
    const relativePath = relative(realRepositoryRoot, absolutePath)
    return relativePath === '' || (
      relativePath !== '..'
      && !relativePath.startsWith(`..${sep}`)
      && !isAbsolute(relativePath)
    )
  }
  /** 把仓库相对路径解析为受约束的真实路径。 */
  const resolveRepositoryPath = (path: string): string | undefined => {
    if (isAbsolute(path)) return undefined
    /** 未解析 symlink 前的词法绝对路径。 */
    const lexicalPath = resolve(realRepositoryRoot, path)
    if (!isInsideRepository(lexicalPath)) return undefined
    if (!existsSync(lexicalPath)) return lexicalPath
    try {
      /** 已存在目标的真实路径。 */
      const realPath = realpathSync(lexicalPath)
      return isInsideRepository(realPath) ? realPath : undefined
    } catch {
      return undefined
    }
  }
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
      /** 经过词法与 realpath 双重约束的仓库内路径。 */
      const absolutePath = resolveRepositoryPath(path)
      if (!absolutePath || !existsSync(absolutePath)) return undefined
      try {
        return readFileSync(absolutePath, 'utf8')
      } catch {
        return undefined
      }
    },
    list: (directory) => {
      /** 经过词法与 realpath 双重约束的仓库内目录。 */
      const absoluteDirectory = resolveRepositoryPath(directory)
      if (!absoluteDirectory) return []
      return listFiles(absoluteDirectory)
        .map((path) => relative(realRepositoryRoot, path).replaceAll('\\', '/'))
    },
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
