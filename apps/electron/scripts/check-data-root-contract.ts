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

/** 单文件 TypeScript binder 上下文。 */
interface TypeScriptBindingContext {
  /** 当前文件已完成 binder 处理的 AST。 */
  sourceFile: ts.SourceFile
  /** 查询 import 与使用位置 symbol identity 的检查器。 */
  checker: ts.TypeChecker
  /** 当前文件的语法诊断，非空时扫描必须 fail closed。 */
  syntacticDiagnostics: readonly ts.Diagnostic[]
}

/** 单文件中可确认来源的 Node/Electron 路径 API 绑定。 */
interface RuntimePathBindings {
  /** 从 node:path 导入的 join/resolve symbol。 */
  pathBuilders: Set<ts.Symbol>
  /** node:path default/namespace import symbol。 */
  pathNamespaces: Set<ts.Symbol>
  /** 从 node:os 导入的 homedir symbol。 */
  homeFunctions: Set<ts.Symbol>
  /** node:os default/namespace import symbol。 */
  osNamespaces: Set<ts.Symbol>
  /** 从 node:fs 导入的函数 symbol 及真实导出名。 */
  fsFunctions: Map<ts.Symbol, string>
  /** node:fs default/namespace import symbol。 */
  fsNamespaces: Set<ts.Symbol>
  /** 从 electron 导入的 shell symbol。 */
  electronShells: Set<ts.Symbol>
  /** electron default/namespace import symbol。 */
  electronNamespaces: Set<ts.Symbol>
}

/** 使用位置前可证明的最近局部定义。 */
interface ReachingDefinition {
  /** 是否已经在当前或外层词法语句块中找到定义。 */
  found: boolean
  /** 无法线性证明唯一结果时按违规 fail closed。 */
  uncertain: boolean
  /** 最近简单 initializer 或 `=` 右值；无 initializer 时为空。 */
  value?: ts.Expression
}

/** 单个定义写入完成时的位置，用于过滤同 statement 内 sink 后事件。 */
interface DefinitionEvent extends ReachingDefinition {
  /** 写入完成的源码位置；同一线性表达式中与执行顺序一致。 */
  position: number
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

/** 创建只绑定当前虚拟源码的 TypeScript Program。 */
function createTypeScriptBindingContext(path: string, content: string): TypeScriptBindingContext {
  /** 单文件合同只需要语法、binder 与本地 symbol，不解析外部模块。 */
  const options: ts.CompilerOptions = {
    module: ts.ModuleKind.ESNext,
    noLib: true,
    noResolve: true,
    target: ts.ScriptTarget.Latest,
  }
  /** 根据扩展名选择正确 JSX 解析模式。 */
  const scriptKind = path.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  /** 当前虚拟源码 AST。 */
  const sourceFile = ts.createSourceFile(path, content, ts.ScriptTarget.Latest, true, scriptKind)
  /** 限制 compiler host 只能读取当前文件。 */
  const host = ts.createCompilerHost(options)
  host.fileExists = (fileName) => fileName === path
  host.getSourceFile = (fileName) => fileName === path ? sourceFile : undefined
  host.readFile = (fileName) => fileName === path ? content : undefined
  /** Program 提供语法诊断和统一的 symbol identity。 */
  const program = ts.createProgram([path], options, host)
  return {
    sourceFile,
    checker: program.getTypeChecker(),
    syntacticDiagnostics: program.getSyntacticDiagnostics(sourceFile),
  }
}

/** 把标识符对应的 binder symbol 加入目标集合。 */
function addIdentifierSymbol(
  identifier: ts.Identifier,
  symbols: Set<ts.Symbol>,
  checker: ts.TypeChecker,
): void {
  /** import 本地 binding 的唯一 symbol。 */
  const symbol = checker.getSymbolAtLocation(identifier)
  if (symbol) symbols.add(symbol)
}

/** 判断使用位置是否绑定到目标 import symbol，阻断同名 shadow。 */
function identifierUsesBinding(
  identifier: ts.Identifier,
  symbols: ReadonlySet<ts.Symbol>,
  checker: ts.TypeChecker,
): boolean {
  /** 当前使用位置解析出的 binder symbol。 */
  const symbol = checker.getSymbolAtLocation(identifier)
  return symbol !== undefined && symbols.has(symbol)
}

/** 收集 Node/Electron 模块的真实 import bindings，支持 default、named alias 与 namespace。 */
function collectRuntimePathBindings(context: TypeScriptBindingContext): RuntimePathBindings {
  /** 当前文件全部已确认来源的运行时绑定。 */
  const bindings: RuntimePathBindings = {
    pathBuilders: new Set(),
    pathNamespaces: new Set(),
    homeFunctions: new Set(),
    osNamespaces: new Set(),
    fsFunctions: new Map(),
    fsNamespaces: new Set(),
    electronShells: new Set(),
    electronNamespaces: new Set(),
  }

  for (const statement of context.sourceFile.statements) {
    if (
      !ts.isImportDeclaration(statement)
      || statement.importClause?.isTypeOnly
      || !ts.isStringLiteralLike(statement.moduleSpecifier)
    ) continue
    /** 归一化 node: 前缀后的内置模块名。 */
    const moduleName = statement.moduleSpecifier.text.replace(/^node:/, '')
    /** default import 与 namespace import 都代表模块对象。 */
    const defaultBinding = statement.importClause?.name
    if (defaultBinding) {
      if (moduleName === 'path') addIdentifierSymbol(defaultBinding, bindings.pathNamespaces, context.checker)
      if (moduleName === 'os') addIdentifierSymbol(defaultBinding, bindings.osNamespaces, context.checker)
      if (moduleName === 'fs' || moduleName === 'fs/promises') {
        addIdentifierSymbol(defaultBinding, bindings.fsNamespaces, context.checker)
      }
      if (moduleName === 'electron') addIdentifierSymbol(defaultBinding, bindings.electronNamespaces, context.checker)
    }
    /** 当前 import 的命名或 namespace 绑定。 */
    const namedBindings = statement.importClause?.namedBindings
    if (!namedBindings) continue
    if (ts.isNamespaceImport(namedBindings)) {
      if (moduleName === 'path') addIdentifierSymbol(namedBindings.name, bindings.pathNamespaces, context.checker)
      if (moduleName === 'os') addIdentifierSymbol(namedBindings.name, bindings.osNamespaces, context.checker)
      if (moduleName === 'fs' || moduleName === 'fs/promises') {
        addIdentifierSymbol(namedBindings.name, bindings.fsNamespaces, context.checker)
      }
      if (moduleName === 'electron') addIdentifierSymbol(namedBindings.name, bindings.electronNamespaces, context.checker)
      continue
    }
    for (const element of namedBindings.elements) {
      if (element.isTypeOnly) continue
      /** import alias 前的真实导出名称。 */
      const importedName = element.propertyName?.text ?? element.name.text
      /** 当前 named import 本地 binding 的 binder symbol。 */
      const symbol = context.checker.getSymbolAtLocation(element.name)
      if (!symbol) continue
      if (moduleName === 'path' && (importedName === 'join' || importedName === 'resolve')) {
        bindings.pathBuilders.add(symbol)
      }
      if (moduleName === 'os' && importedName === 'homedir') bindings.homeFunctions.add(symbol)
      if (moduleName === 'fs/promises') bindings.fsFunctions.set(symbol, importedName)
      else if (moduleName === 'fs' && importedName === 'promises') bindings.fsNamespaces.add(symbol)
      else if (moduleName === 'fs') bindings.fsFunctions.set(symbol, importedName)
      if (moduleName === 'electron' && importedName === 'shell') bindings.electronShells.add(symbol)
    }
  }
  return bindings
}

/** 判断表达式是否为已确认来源的 homedir() 调用。 */
function isHomeDirectoryCall(
  expression: ts.Expression,
  bindings: RuntimePathBindings,
  checker: ts.TypeChecker,
): boolean {
  if (!ts.isCallExpression(expression)) return false
  if (ts.isIdentifier(expression.expression)) {
    return identifierUsesBinding(expression.expression, bindings.homeFunctions, checker)
  }
  return ts.isPropertyAccessExpression(expression.expression)
    && expression.expression.name.text === 'homedir'
    && ts.isIdentifier(expression.expression.expression)
    && identifierUsesBinding(expression.expression.expression, bindings.osNamespaces, checker)
}

/** 判断调用是否为已确认来源的 join/resolve。 */
function isPathBuilderCall(
  node: ts.CallExpression,
  bindings: RuntimePathBindings,
  checker: ts.TypeChecker,
): boolean {
  if (ts.isIdentifier(node.expression)) return identifierUsesBinding(node.expression, bindings.pathBuilders, checker)
  return ts.isPropertyAccessExpression(node.expression)
    && (node.expression.name.text === 'join' || node.expression.name.text === 'resolve')
    && ts.isIdentifier(node.expression.expression)
    && identifierUsesBinding(node.expression.expression, bindings.pathNamespaces, checker)
}

/** 返回已确认来源的文件系统调用真实方法名。 */
function getFileSystemMethodName(
  node: ts.CallExpression,
  bindings: RuntimePathBindings,
  checker: ts.TypeChecker,
): string | undefined {
  if (ts.isIdentifier(node.expression)) {
    /** named import 使用位置的 binder symbol。 */
    const symbol = checker.getSymbolAtLocation(node.expression)
    return symbol ? bindings.fsFunctions.get(symbol) : undefined
  }
  if (
    ts.isPropertyAccessExpression(node.expression)
    && ts.isIdentifier(node.expression.expression)
    && identifierUsesBinding(node.expression.expression, bindings.fsNamespaces, checker)
  ) return node.expression.name.text
  if (
    ts.isPropertyAccessExpression(node.expression)
    && ts.isPropertyAccessExpression(node.expression.expression)
    && node.expression.expression.name.text === 'promises'
    && ts.isIdentifier(node.expression.expression.expression)
    && identifierUsesBinding(node.expression.expression.expression, bindings.fsNamespaces, checker)
  ) return node.expression.name.text
  return undefined
}

/** 判断调用是否为 electron shell.openPath 的精确 path sink。 */
function isElectronOpenPathCall(
  node: ts.CallExpression,
  bindings: RuntimePathBindings,
  checker: ts.TypeChecker,
): boolean {
  if (!ts.isPropertyAccessExpression(node.expression) || node.expression.name.text !== 'openPath') return false
  /** named import `shell.openPath()`。 */
  const receiver = node.expression.expression
  if (ts.isIdentifier(receiver)) return identifierUsesBinding(receiver, bindings.electronShells, checker)
  /** default/namespace import `electron.shell.openPath()`。 */
  return ts.isPropertyAccessExpression(receiver)
    && receiver.name.text === 'shell'
    && ts.isIdentifier(receiver.expression)
    && identifierUsesBinding(receiver.expression, bindings.electronNamespaces, checker)
}

/** 判断文本是否包含精确 `.proma` 路径段，排除 locator、临时文件和相似前缀。 */
function containsDataRootSegment(text: string): boolean {
  return /(?:^|[~\\/])\.proma(?:$|[\\/])/.test(text)
}

/** 去除不改变路径值的数据类型包装。 */
function unwrapExpression(expression: ts.Expression): ts.Expression {
  if (ts.isParenthesizedExpression(expression)) return unwrapExpression(expression.expression)
  if (ts.isAsExpression(expression)) return unwrapExpression(expression.expression)
  if (ts.isTypeAssertionExpression(expression)) return unwrapExpression(expression.expression)
  if (ts.isSatisfiesExpression(expression)) return unwrapExpression(expression.expression)
  if (ts.isNonNullExpression(expression)) return unwrapExpression(expression.expression)
  return expression
}

/** 判断节点是否建立新的函数执行边界，外部 reaching definition 不读取其内部写入。 */
function isFunctionBoundary(node: ts.Node): boolean {
  return ts.isFunctionDeclaration(node)
    || ts.isFunctionExpression(node)
    || ts.isArrowFunction(node)
    || ts.isMethodDeclaration(node)
    || ts.isConstructorDeclaration(node)
    || ts.isGetAccessorDeclaration(node)
    || ts.isSetAccessorDeclaration(node)
}

/** 判断赋值目标是否直接或通过解构写入指定 symbol。 */
function assignmentTargetUsesSymbol(
  target: ts.Expression,
  symbol: ts.Symbol,
  checker: ts.TypeChecker,
): boolean {
  if (ts.isIdentifier(target)) return checker.getSymbolAtLocation(target) === symbol
  if (ts.isParenthesizedExpression(target)) {
    return assignmentTargetUsesSymbol(target.expression, symbol, checker)
  }
  if (ts.isArrayLiteralExpression(target)) {
    return target.elements.some((element) => (
      ts.isExpression(element) && assignmentTargetUsesSymbol(element, symbol, checker)
    ))
  }
  if (ts.isObjectLiteralExpression(target)) {
    return target.properties.some((property) => {
      if (ts.isShorthandPropertyAssignment(property)) {
        return checker.getSymbolAtLocation(property.name) === symbol
      }
      if (ts.isPropertyAssignment(property)) {
        return assignmentTargetUsesSymbol(property.initializer, symbol, checker)
      }
      if (ts.isSpreadAssignment(property)) {
        return assignmentTargetUsesSymbol(property.expression, symbol, checker)
      }
      return false
    })
  }
  return false
}

/** 判断节点子树是否直接包含固定数据根字面量。 */
function nodeContainsDataRootLiteral(node: ts.Node): boolean {
  if (ts.isStringLiteralLike(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return containsDataRootSegment(node.text)
  }
  if (ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) {
    return containsDataRootSegment(node.text)
  }
  /** 子节点只检查静态字面量，不把动态未知值臆测为固定根。 */
  let found = false
  ts.forEachChild(node, (child) => {
    if (!found && nodeContainsDataRootLiteral(child)) found = true
  })
  return found
}

/** 收集节点中无法线性建模但有固定根证据的实际写入完成位置。 */
function collectHardcodedWritePositions(
  root: ts.Node,
  symbol: ts.Symbol,
  context: TypeScriptBindingContext,
): number[] {
  /** 当前节点内按源码位置排序的硬编码写入完成位置。 */
  const positions: number[] = []
  const visit = (node: ts.Node): void => {
    if (isFunctionBoundary(node)) return
    if (
      ts.isBinaryExpression(node)
      && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment
      && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment
      && assignmentTargetUsesSymbol(node.left, symbol, context.checker)
    ) {
      if (
        nodeContainsDataRootLiteral(node.right)
        || expressionContainsDataRootSegment(node.right, context, new Set([symbol]))
      ) positions.push(node.end)
    }
    ts.forEachChild(node, visit)
  }
  visit(root)
  return positions.sort((left, right) => left - right)
}

/** 去除 IIFE callee 外层不改变函数值的括号与类型包装。 */
function getImmediatelyInvokedFunction(expression: ts.Expression): ts.FunctionExpression | ts.ArrowFunction | undefined {
  /** 当前调用目标去除括号与类型包装后的表达式。 */
  const callee = unwrapExpression(expression)
  return ts.isFunctionExpression(callee) || ts.isArrowFunction(callee) ? callee : undefined
}

/** 判断表达式是否包含无法线性确定执行分支的短路或条件求值。 */
function isNonLinearExpression(expression: ts.Expression): boolean {
  if (ts.isConditionalExpression(expression)) return true
  return ts.isBinaryExpression(expression)
    && (
      expression.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken
      || expression.operatorToken.kind === ts.SyntaxKind.BarBarToken
      || expression.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken
    )
}

/** 按明确执行顺序收集表达式中对指定 symbol 的定义事件。 */
function collectExpressionDefinitionEvents(
  rawExpression: ts.Expression,
  symbol: ts.Symbol,
  context: TypeScriptBindingContext,
): DefinitionEvent[] {
  /** 去除不改变求值顺序的包装。 */
  const expression = unwrapExpression(rawExpression)
  if (isFunctionBoundary(expression)) return []
  if (isNonLinearExpression(expression)) {
    return collectHardcodedWritePositions(expression, symbol, context).map((position) => ({
      found: true,
      uncertain: true,
      position,
    }))
  }
  if (ts.isCallExpression(expression)) {
    /** 参数在函数体前求值；直接 function/arrow callee 才展开为当前执行流。 */
    const events = expression.arguments.flatMap((argument) => (
      collectExpressionDefinitionEvents(argument, symbol, context)
    ))
    const invokedFunction = getImmediatelyInvokedFunction(expression.expression)
    if (!invokedFunction) return events
    if (ts.isBlock(invokedFunction.body)) {
      events.push(...collectSequentialDefinitionEvents(invokedFunction.body.statements, symbol, context))
    } else {
      events.push(...collectExpressionDefinitionEvents(invokedFunction.body, symbol, context))
    }
    return events
  }
  if (ts.isBinaryExpression(expression)) {
    /** 赋值先求右值，再写入目标；comma 等普通二元表达式按左右顺序求值。 */
    if (
      expression.operatorToken.kind >= ts.SyntaxKind.FirstAssignment
      && expression.operatorToken.kind <= ts.SyntaxKind.LastAssignment
    ) {
      const events = collectExpressionDefinitionEvents(expression.right, symbol, context)
      if (!assignmentTargetUsesSymbol(expression.left, symbol, context.checker)) return events
      if (
        expression.operatorToken.kind === ts.SyntaxKind.EqualsToken
        && ts.isIdentifier(expression.left)
      ) {
        events.push({
          found: true,
          uncertain: false,
          value: expression.right,
          position: expression.end,
        })
      } else if (
        nodeContainsDataRootLiteral(expression.right)
        || expressionContainsDataRootSegment(expression.right, context, new Set([symbol]))
      ) {
        events.push({ found: true, uncertain: true, position: expression.end })
      }
      return events
    }
    return [
      ...collectExpressionDefinitionEvents(expression.left, symbol, context),
      ...collectExpressionDefinitionEvents(expression.right, symbol, context),
    ]
  }
  /** 普通表达式按语法子节点顺序求值，并跳过未调用的函数体。 */
  const events: DefinitionEvent[] = []
  ts.forEachChild(expression, (child) => {
    if (ts.isExpression(child)) {
      events.push(...collectExpressionDefinitionEvents(child, symbol, context))
    }
  })
  return events
}

/** 返回使用位置所在的直接语句及其顺序容器。 */
function findStatementPosition(node: ts.Node): {
  container: ts.Block | ts.SourceFile
  index: number
} | undefined {
  /** 向上找到第一个由 SourceFile 或 Block 直接持有的语句。 */
  let current: ts.Node = node
  while (current.parent) {
    const parent = current.parent
    if ((ts.isSourceFile(parent) || ts.isBlock(parent)) && ts.isStatement(current)) {
      return { container: parent, index: parent.statements.indexOf(current) }
    }
    current = parent
  }
  return undefined
}

/** 判断变量解构 binding 是否声明指定 symbol。 */
function bindingNameUsesSymbol(
  name: ts.BindingName,
  symbol: ts.Symbol,
  checker: ts.TypeChecker,
): boolean {
  if (ts.isIdentifier(name)) return checker.getSymbolAtLocation(name) === symbol
  return name.elements.some((element) => (
    !ts.isOmittedExpression(element)
    && bindingNameUsesSymbol(element.name, symbol, checker)
  ))
}

/** 在单条语句中按明确执行顺序提取指定 symbol 的定义事件。 */
function collectStatementDefinitionEvents(
  statement: ts.Statement,
  symbol: ts.Symbol,
  context: TypeScriptBindingContext,
): DefinitionEvent[] {
  if (isFunctionBoundary(statement)) return []
  if (ts.isVariableStatement(statement)) {
    /** 同一 VariableStatement 的 declarations 与 initializer 从左到右执行。 */
    const events: DefinitionEvent[] = []
    for (const declaration of statement.declarationList.declarations) {
      if (declaration.initializer) {
        events.push(...collectExpressionDefinitionEvents(declaration.initializer, symbol, context))
      }
      if (ts.isIdentifier(declaration.name) && context.checker.getSymbolAtLocation(declaration.name) === symbol) {
        events.push({
          found: true,
          uncertain: false,
          value: declaration.initializer,
          position: declaration.end,
        })
      }
      if (!ts.isIdentifier(declaration.name) && bindingNameUsesSymbol(declaration.name, symbol, context.checker)) {
        events.push({
          found: true,
          uncertain: Boolean(
            declaration.initializer
            && (
              nodeContainsDataRootLiteral(declaration.initializer)
              || expressionContainsDataRootSegment(declaration.initializer, context, new Set([symbol]))
            )
          ),
          position: declaration.end,
        })
      }
    }
    return events
  }
  if (ts.isExpressionStatement(statement)) {
    return collectExpressionDefinitionEvents(statement.expression, symbol, context)
  }
  if (ts.isBlock(statement)) {
    return collectSequentialDefinitionEvents(statement.statements, symbol, context)
  }
  return collectHardcodedWritePositions(statement, symbol, context).map((position) => ({
    found: true,
    uncertain: true,
    position,
  }))
}

/** 合并顺序语句的定义事件；终止语句后的复杂控制流由 fail-closed 用例约束。 */
function collectSequentialDefinitionEvents(
  statements: readonly ts.Statement[],
  symbol: ts.Symbol,
  context: TypeScriptBindingContext,
): DefinitionEvent[] {
  /** 条件、循环或终止语句会让前后定义不再具有单一必然执行顺序。 */
  const hasComplexControlFlow = statements.some((statement) => (
    !ts.isVariableStatement(statement)
    && !ts.isExpressionStatement(statement)
    && !ts.isBlock(statement)
    && !ts.isEmptyStatement(statement)
    && !isFunctionBoundary(statement)
  ))
  if (hasComplexControlFlow) {
    /** 复杂控制流保留每个有证据写入的位置，供当前 statement 的 sink 前过滤复用。 */
    const positions = statements.flatMap((statement) => (
      collectHardcodedWritePositions(statement, symbol, context)
    ))
    if (positions.length > 0) {
      return positions.sort((left, right) => left - right).map((position) => ({
        found: true,
        uncertain: true,
        position,
      }))
    }
  }
  return statements.flatMap((statement) => collectStatementDefinitionEvents(statement, symbol, context))
}

/** 从使用位置向外按语句顺序查找同一 symbol 的最近定义。 */
function findReachingDefinition(
  identifier: ts.Identifier,
  symbol: ts.Symbol,
  context: TypeScriptBindingContext,
): ReachingDefinition {
  /** 当前 sink identifier 的求值起点，严格排除同 statement 中更晚的写入。 */
  const usePosition = identifier.getStart(context.sourceFile)
  /** 每层从容器开头扫描到当前语句，后定义自然覆盖前定义。 */
  let queryNode: ts.Node = identifier
  while (true) {
    const position = findStatementPosition(queryNode)
    if (!position || position.index < 0) return { found: false, uncertain: false }
    let latest: ReachingDefinition = { found: false, uncertain: false }
    for (let index = 0; index < position.index; index += 1) {
      const events = collectStatementDefinitionEvents(position.container.statements[index]!, symbol, context)
      for (const definition of events) {
        if (definition.found) latest = definition
      }
    }
    /** 当前 statement 内只合并在 sink identifier 求值前已经完成的定义事件。 */
    const currentEvents = collectStatementDefinitionEvents(
      position.container.statements[position.index]!,
      symbol,
      context,
    )
    for (const definition of currentEvents) {
      if (definition.position < usePosition) latest = definition
    }
    if (latest.found) return latest
    if (ts.isSourceFile(position.container)) return latest
    queryNode = position.container
  }
}

/** 判断表达式及其按顺序可达的局部值是否包含精确数据根路径段。 */
function expressionContainsDataRootSegment(
  rawExpression: ts.Expression,
  context: TypeScriptBindingContext,
  visitedSymbols: Set<ts.Symbol> = new Set(),
): boolean {
  /** 当前去除类型包装后的表达式。 */
  const expression = unwrapExpression(rawExpression)
  if (ts.isStringLiteralLike(expression) || ts.isNoSubstitutionTemplateLiteral(expression)) {
    return containsDataRootSegment(expression.text)
  }
  if (ts.isTemplateExpression(expression)) {
    return containsDataRootSegment(expression.head.text)
      || expression.templateSpans.some((span) => (
        containsDataRootSegment(span.literal.text)
        || expressionContainsDataRootSegment(span.expression, context, visitedSymbols)
      ))
  }
  if (ts.isBinaryExpression(expression)) {
    return expressionContainsDataRootSegment(expression.left, context, visitedSymbols)
      || expressionContainsDataRootSegment(expression.right, context, visitedSymbols)
  }
  if (ts.isIdentifier(expression)) {
    /** 当前标识符解析到的局部值 symbol。 */
    const symbol = context.checker.getSymbolAtLocation(expression)
    if (!symbol || visitedSymbols.has(symbol)) return false
    /** 按使用位置查找最近顺序定义；非线性写入按违规 fail closed。 */
    const definition = findReachingDefinition(expression, symbol, context)
    if (definition.uncertain) return true
    if (!definition.found || !definition.value) return false
    visitedSymbols.add(symbol)
    return expressionContainsDataRootSegment(definition.value, context, visitedSymbols)
  }
  return false
}

/** 判断表达式子树是否包含已确认来源的 home 目录调用。 */
function expressionContainsHomeDirectory(
  expression: ts.Expression,
  bindings: RuntimePathBindings,
  checker: ts.TypeChecker,
): boolean {
  if (isHomeDirectoryCall(expression, bindings, checker)) return true
  if (ts.isTemplateExpression(expression)) {
    return expression.templateSpans.some((span) => expressionContainsHomeDirectory(span.expression, bindings, checker))
  }
  if (ts.isBinaryExpression(expression)) {
    return expressionContainsHomeDirectory(expression.left, bindings, checker)
      || expressionContainsHomeDirectory(expression.right, bindings, checker)
  }
  return false
}

/** 返回 fs 方法中代表路径的参数位置。 */
function getFileSystemPathArgumentIndexes(methodName: string): readonly number[] {
  /** 同时接收源路径与目标路径的稳定 fs API。 */
  const twoPathMethods = new Set(['copyFile', 'copyFileSync', 'cp', 'cpSync', 'link', 'linkSync', 'rename', 'renameSync', 'symlink', 'symlinkSync'])
  return twoPathMethods.has(methodName) ? [0, 1] : [0]
}

/** 把首个语法诊断转换为包含 POSIX 相对路径的位置错误。 */
function throwFirstSyntaxDiagnostic(context: TypeScriptBindingContext, path: string): void {
  /** 当前文件首个语法错误即可使扫描 fail closed。 */
  const diagnostic = context.syntacticDiagnostics[0]
  if (!diagnostic) return
  /** 诊断起点对应的一基行列。 */
  const position = context.sourceFile.getLineAndCharacterOfPosition(diagnostic.start ?? 0)
  /** TypeScript 诊断文本可能是嵌套消息链。 */
  const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')
  throw new Error(`TypeScript 语法错误：${path}:${position.line + 1}:${position.character + 1} ${message}`)
}

/** 判断当前源码 AST 是否直接构造或消费固定数据根路径。 */
function sourceHasHardcodedDataRoot(path: string, content: string): boolean {
  /** 当前源码 binder 上下文，字符串和注释由语法结构区分。 */
  const context = createTypeScriptBindingContext(path, content)
  throwFirstSyntaxDiagnostic(context, path)
  /** 当前文件中来自 Node/Electron 模块的可信运行时绑定。 */
  const bindings = collectRuntimePathBindings(context)
  /** 首次命中后停止继续遍历。 */
  let found = false

  /** 递归检查路径 API、模板、字符串拼接和明确路径变量。 */
  const visit = (node: ts.Node): void => {
    if (found) return
    if (ts.isCallExpression(node)) {
      if (
        isPathBuilderCall(node, bindings, context.checker)
        && node.arguments.some((argument) => expressionContainsDataRootSegment(argument, context))
      ) found = true
      else {
        /** fs path sink 只检查路径参数，避免把文件内容说明文本误判为路径。 */
        const fsMethodName = getFileSystemMethodName(node, bindings, context.checker)
        if (fsMethodName) {
          found = getFileSystemPathArgumentIndexes(fsMethodName).some((index) => {
            /** 当前 fs 方法约定位置上的路径参数。 */
            const argument = node.arguments[index]
            return argument !== undefined && expressionContainsDataRootSegment(argument, context)
          })
        } else if (isElectronOpenPathCall(node, bindings, context.checker)) {
          /** Electron openPath 的首个参数是唯一目标路径。 */
          const argument = node.arguments[0]
          found = argument !== undefined && expressionContainsDataRootSegment(argument, context)
        }
      }
    } else if (
      (ts.isTemplateExpression(node) || ts.isBinaryExpression(node))
      && expressionContainsDataRootSegment(node, context)
      && expressionContainsHomeDirectory(node, bindings, context.checker)
    ) found = true
    if (!found) ts.forEachChild(node, visit)
  }

  visit(context.sourceFile)
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
