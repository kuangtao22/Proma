import { readdirSync, readFileSync } from 'node:fs'
import { join, posix, relative, resolve, sep } from 'node:path'
import * as ts from 'typescript'

/** 扫描器固定检查的主进程源码目录。 */
const MAIN_SOURCE_DIRECTORY = 'apps/electron/src/main'

/** 唯一允许构造固定默认根的权威边界。 */
const DATA_ROOT_AUTHORITY_FILES = new Set([
  'apps/electron/src/main/lib/data-root-locator.ts',
  'apps/electron/src/main/lib/data-root-marker.ts',
])

/** CLI 可注入输出边界，测试时不污染终端。 */
export interface DataRootContractCliOutput {
  /** 输出成功状态。 */
  log: (message: string) => void
  /** 输出违规文件或扫描错误。 */
  error: (message: string) => void
}

/** 单文件中可确认来源的 Node 路径与 home API 绑定。 */
interface RuntimePathBindings {
  /** 从 node:path 导入的 join/resolve 本地名称。 */
  pathBuilders: Set<string>
  /** node:path namespace 本地名称。 */
  pathNamespaces: Set<string>
  /** 从 node:os 导入的 homedir 本地名称。 */
  homeFunctions: Set<string>
  /** node:os namespace 本地名称。 */
  osNamespaces: Set<string>
  /** 从 node:fs 导入的运行时文件 API 本地名称。 */
  fsFunctions: Set<string>
  /** node:fs namespace 本地名称。 */
  fsNamespaces: Set<string>
}

/** 把平台相对路径统一转换成稳定 POSIX 格式。 */
function toPosixPath(path: string): string {
  return path.split(sep).join(posix.sep)
}

/** 判断文件是否为不会进入生产运行时的测试源码。 */
function isTestSource(path: string): boolean {
  return path.endsWith('.test.ts') || path.endsWith('.test.tsx')
}

/** 递归枚举目录内的 TypeScript 源码；任何读取失败都携带路径向上抛出。 */
function listTypeScriptFiles(directory: string): string[] {
  try {
    /** 当前目录按名称排序后的实体，保证跨文件系统结果稳定。 */
    const entries = readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name))
    /** 当前目录及其子目录的 TypeScript 文件。 */
    const files: string[] = []
    for (const entry of entries) {
      /** 当前实体的绝对路径。 */
      const absolutePath = join(directory, entry.name)
      if (entry.isDirectory()) files.push(...listTypeScriptFiles(absolutePath))
      else if (entry.isSymbolicLink()) throw new Error(`拒绝扫描符号链接：${absolutePath}`)
      else if (entry.isFile() && /\.tsx?$/.test(entry.name)) files.push(absolutePath)
    }
    return files
  } catch (error) {
    throw new Error(`无法读取数据根合同目录 ${directory}：${error instanceof Error ? error.message : String(error)}`)
  }
}

/** 读取单个源码文件，失败时保留具体文件路径。 */
function readSourceFile(path: string): string {
  try {
    return readFileSync(path, 'utf8')
  } catch (error) {
    throw new Error(`无法读取数据根合同文件 ${path}：${error instanceof Error ? error.message : String(error)}`)
  }
}

/** 收集 Node 内置模块的真实 import 本地名称，支持 named alias 与 namespace。 */
function collectRuntimePathBindings(sourceFile: ts.SourceFile): RuntimePathBindings {
  /** 当前文件全部已确认来源的运行时绑定。 */
  const bindings: RuntimePathBindings = {
    pathBuilders: new Set(),
    pathNamespaces: new Set(),
    homeFunctions: new Set(),
    osNamespaces: new Set(),
    fsFunctions: new Set(),
    fsNamespaces: new Set(),
  }

  for (const statement of sourceFile.statements) {
    if (
      !ts.isImportDeclaration(statement)
      || statement.importClause?.isTypeOnly
      || !ts.isStringLiteralLike(statement.moduleSpecifier)
    ) continue
    /** 归一化 node: 前缀后的内置模块名。 */
    const moduleName = statement.moduleSpecifier.text.replace(/^node:/, '')
    /** 当前 import 的命名或 namespace 绑定。 */
    const namedBindings = statement.importClause?.namedBindings
    if (!namedBindings) continue
    if (ts.isNamespaceImport(namedBindings)) {
      if (moduleName === 'path') bindings.pathNamespaces.add(namedBindings.name.text)
      if (moduleName === 'os') bindings.osNamespaces.add(namedBindings.name.text)
      if (moduleName === 'fs') bindings.fsNamespaces.add(namedBindings.name.text)
      continue
    }
    for (const element of namedBindings.elements) {
      if (element.isTypeOnly) continue
      /** import alias 前的真实导出名称。 */
      const importedName = element.propertyName?.text ?? element.name.text
      /** 当前文件实际使用的本地名称。 */
      const localName = element.name.text
      if (moduleName === 'path' && (importedName === 'join' || importedName === 'resolve')) {
        bindings.pathBuilders.add(localName)
      }
      if (moduleName === 'os' && importedName === 'homedir') bindings.homeFunctions.add(localName)
      if (moduleName === 'fs') bindings.fsFunctions.add(localName)
    }
  }
  return bindings
}

/** 判断表达式是否为已确认来源的 homedir() 调用。 */
function isHomeDirectoryCall(expression: ts.Expression, bindings: RuntimePathBindings): boolean {
  if (!ts.isCallExpression(expression)) return false
  if (ts.isIdentifier(expression.expression)) return bindings.homeFunctions.has(expression.expression.text)
  return ts.isPropertyAccessExpression(expression.expression)
    && expression.expression.name.text === 'homedir'
    && ts.isIdentifier(expression.expression.expression)
    && bindings.osNamespaces.has(expression.expression.expression.text)
}

/** 判断调用是否为已确认来源的 join/resolve。 */
function isPathBuilderCall(node: ts.CallExpression, bindings: RuntimePathBindings): boolean {
  if (ts.isIdentifier(node.expression)) return bindings.pathBuilders.has(node.expression.text)
  return ts.isPropertyAccessExpression(node.expression)
    && (node.expression.name.text === 'join' || node.expression.name.text === 'resolve')
    && ts.isIdentifier(node.expression.expression)
    && bindings.pathNamespaces.has(node.expression.expression.text)
}

/** 判断调用是否为已确认来源的文件系统 API。 */
function isFileSystemCall(node: ts.CallExpression, bindings: RuntimePathBindings): boolean {
  if (ts.isIdentifier(node.expression)) return bindings.fsFunctions.has(node.expression.text)
  return ts.isPropertyAccessExpression(node.expression)
    && ts.isIdentifier(node.expression.expression)
    && bindings.fsNamespaces.has(node.expression.expression.text)
}

/** 判断文本是否包含精确 `.proma` 路径段，排除 locator、临时文件和相似前缀。 */
function containsDataRootSegment(text: string): boolean {
  return /(?:^|[~\\/])\.proma(?:$|[\\/])/.test(text)
}

/** 判断表达式子树是否包含精确数据根路径段。 */
function expressionContainsDataRootSegment(expression: ts.Expression): boolean {
  if (ts.isStringLiteralLike(expression) || ts.isNoSubstitutionTemplateLiteral(expression)) {
    return containsDataRootSegment(expression.text)
  }
  if (ts.isTemplateExpression(expression)) {
    return containsDataRootSegment(expression.head.text)
      || expression.templateSpans.some((span) => containsDataRootSegment(span.literal.text))
  }
  if (ts.isBinaryExpression(expression)) {
    return expressionContainsDataRootSegment(expression.left)
      || expressionContainsDataRootSegment(expression.right)
  }
  return false
}

/** 判断表达式子树是否包含已确认来源的 home 目录调用。 */
function expressionContainsHomeDirectory(expression: ts.Expression, bindings: RuntimePathBindings): boolean {
  if (isHomeDirectoryCall(expression, bindings)) return true
  if (ts.isTemplateExpression(expression)) {
    return expression.templateSpans.some((span) => expressionContainsHomeDirectory(span.expression, bindings))
  }
  if (ts.isBinaryExpression(expression)) {
    return expressionContainsHomeDirectory(expression.left, bindings)
      || expressionContainsHomeDirectory(expression.right, bindings)
  }
  return false
}

/** 判断变量名是否明确表达运行时路径职责，避免把普通说明字符串当成路径。 */
function isPathLikeVariableName(name: ts.BindingName): boolean {
  return ts.isIdentifier(name) && /(?:path|root|dir|directory|config)/i.test(name.text)
}

/** 判断当前源码 AST 是否直接构造或消费固定数据根路径。 */
function sourceHasHardcodedDataRoot(path: string, content: string): boolean {
  /** 当前源码 AST，字符串和注释由语法结构区分。 */
  const sourceFile = ts.createSourceFile(path, content, ts.ScriptTarget.Latest, true, path.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
  /** 当前文件中来自 Node 内置模块的可信运行时绑定。 */
  const bindings = collectRuntimePathBindings(sourceFile)
  /** 首次命中后停止继续遍历。 */
  let found = false

  /** 递归检查路径 API、模板、字符串拼接和明确路径变量。 */
  const visit = (node: ts.Node): void => {
    if (found) return
    if (ts.isCallExpression(node)) {
      if (
        isPathBuilderCall(node, bindings)
        && node.arguments.some(expressionContainsDataRootSegment)
      ) found = true
      else if (
        isFileSystemCall(node, bindings)
        && node.arguments.some(expressionContainsDataRootSegment)
      ) found = true
    } else if (
      (ts.isTemplateExpression(node) || ts.isBinaryExpression(node))
      && expressionContainsDataRootSegment(node)
      && (
        expressionContainsHomeDirectory(node, bindings)
      )
    ) found = true
    else if (
      ts.isVariableDeclaration(node)
      && node.initializer
      && isPathLikeVariableName(node.name)
      && expressionContainsDataRootSegment(node.initializer)
    ) found = true
    if (!found) ts.forEachChild(node, visit)
  }

  visit(sourceFile)
  return found
}

/**
 * 扫描主进程业务源码中绕过 locator 的固定数据根构造。
 *
 * @param rootDir 仓库根绝对或相对路径。
 * @returns 去重、稳定排序的 POSIX 仓库相对违规文件。
 */
export function findHardcodedDataRoots(rootDir: string): string[] {
  /** 归一化仓库根，确保输出相对路径稳定。 */
  const repositoryRoot = resolve(rootDir)
  /** 主进程扫描目录。 */
  const sourceRoot = join(repositoryRoot, MAIN_SOURCE_DIRECTORY)
  /** 使用集合让同文件多次违规只报告一次。 */
  const violations = new Set<string>()

  for (const absolutePath of listTypeScriptFiles(sourceRoot)) {
    /** 当前源码相对仓库根的 POSIX 路径。 */
    const relativePath = toPosixPath(relative(repositoryRoot, absolutePath))
    if (isTestSource(relativePath) || DATA_ROOT_AUTHORITY_FILES.has(relativePath)) continue
    if (sourceHasHardcodedDataRoot(relativePath, readSourceFile(absolutePath))) violations.add(relativePath)
  }
  return [...violations].sort((left, right) => left.localeCompare(right))
}

/** 执行数据根合同 CLI，并把扫描失败和违规统一转换为非零退出码。 */
export function runDataRootContractCli(
  rootDir: string,
  output: DataRootContractCliOutput = console,
): number {
  try {
    /** 当前仓库扫描出的全部违规文件。 */
    const violations = findHardcodedDataRoots(rootDir)
    if (violations.length === 0) {
      output.log('数据根合同检查通过')
      return 0
    }
    output.error('发现绕过 config-paths/DataRootLocator 的数据根路径构造：')
    for (const path of violations) output.error(`- ${path}`)
    return 1
  } catch (error) {
    output.error(error instanceof Error ? error.message : String(error))
    return 1
  }
}

if (import.meta.main) {
  /** scripts 目录向上三级为仓库根，不依赖调用方 cwd。 */
  const repositoryRoot = resolve(import.meta.dir, '../../..')
  process.exitCode = runDataRootContractCli(repositoryRoot)
}
