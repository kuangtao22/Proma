import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import type { AgentSessionMeta, FileAccessOptions } from '@proma/shared'
import ts from 'typescript'
import { requireUserVisibleAgentSession } from './agent-session-visibility'

/** 普通会话 handler 中允许出现在可见性 guard 之前的纯参数校验调用。 */
const PURE_VALIDATION_CALLS = new Set([
  'Array.isArray',
  'Number.isFinite',
  'Number.isSafeInteger',
  'Object.keys',
  'String',
  'isPromaPermissionMode',
  'validThinkingLevels.includes',
])

/** 参数名为 id、且语义上表示 Agent session 的既有通道。 */
const SESSION_ID_ALIAS_CHANNELS = new Set([
  'GET_SDK_MESSAGES',
  'UPDATE_TITLE',
  'UPDATE_SESSION_MODEL',
  'DELETE_SESSION',
  'TOGGLE_PIN',
  'TOGGLE_STAR',
  'CLEAR_COMPLETION_STATE',
  'TOGGLE_ARCHIVE',
])

/** 参数名为 id、但语义上表示 workspace 等非 session 身份的通道。 */
const NON_SESSION_ID_ALIAS_CHANNELS = new Set([
  'DELETE_WORKSPACE',
  'RELINK_WORKSPACE_PROJECT_ROOT',
  'RESTORE_WORKSPACE_PROJECT_ROOT',
  'SET_BUILTIN_MCP_ENABLED',
  'UPDATE_WORKSPACE',
])

/** requestId 间接指向 session，必须先查 owner 再验证的响应通道。 */
const OWNER_RESPONSE_CHANNELS = new Set([
  'PERMISSION_RESPOND',
  'ASK_USER_RESPOND',
  'EXIT_PLAN_MODE_RESPOND',
])

/** 不带 session 参数、但返回的 pending 项必须按 owner 可见性过滤。 */
const FILTERED_SNAPSHOT_CHANNELS = new Set(['GET_PENDING_REQUESTS'])

interface RegisteredHandler {
  channel: string
  handler: ts.ArrowFunction | ts.FunctionExpression
}

interface AgentHandlerIndex {
  checker: ts.TypeChecker
  handlers: RegisteredHandler[]
  source: ts.SourceFile
}

/** 缓存 TypeScript Program，避免同一测试文件重复解析整个 Electron 工程。 */
let cachedHandlerIndex: AgentHandlerIndex | undefined

function getCallName(call: ts.CallExpression): string {
  return call.expression.getText()
}

function containsSessionId(type: ts.Type, checker: ts.TypeChecker, seen = new Set<ts.Type>()): boolean {
  if (seen.has(type)) return false
  seen.add(type)
  if (type.isUnionOrIntersection()) {
    return type.types.some((member) => containsSessionId(member, checker, seen))
  }
  return checker.getPropertyOfType(type, 'sessionId') !== undefined
}

/** 收集 handler 当前执行路径上的调用，跳过回调和嵌套函数体。 */
function collectTopLevelExecutionCalls(node: ts.Node): ts.CallExpression[] {
  const calls: ts.CallExpression[] = []
  const visit = (candidate: ts.Node): void => {
    if (candidate !== node && ts.isFunctionLike(candidate)) return
    if (ts.isCallExpression(candidate)) calls.push(candidate)
    ts.forEachChild(candidate, visit)
  }
  visit(node)
  return calls.sort((left, right) => left.getStart() - right.getStart())
}

function loadAgentHandlers(): AgentHandlerIndex {
  if (cachedHandlerIndex) return cachedHandlerIndex
  const ipcPath = join(import.meta.dir, '..', 'ipc.ts')
  const configPath = ts.findConfigFile(join(import.meta.dir, '../../../..'), ts.sys.fileExists, 'tsconfig.json')
  if (!configPath) throw new Error('找不到仓库 tsconfig.json')
  const config = ts.readConfigFile(configPath, ts.sys.readFile)
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, join(configPath, '..'))
  const program = ts.createProgram([ipcPath], parsed.options)
  const checker = program.getTypeChecker()
  const source = program.getSourceFile(ipcPath)
  if (!source) throw new Error('无法解析 ipc.ts')
  const handlers: RegisteredHandler[] = []

  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node)
      && node.expression.getText(source) === 'ipcMain.handle'
      && node.arguments.length >= 2
    ) {
      const channelArg = node.arguments[0]
      const handlerArg = node.arguments[1]
      if (
        channelArg
        && ts.isPropertyAccessExpression(channelArg)
        && channelArg.expression.getText(source) === 'AGENT_IPC_CHANNELS'
        && handlerArg
        && (ts.isArrowFunction(handlerArg) || ts.isFunctionExpression(handlerArg))
      ) {
        handlers.push({ channel: channelArg.name.text, handler: handlerArg })
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  cachedHandlerIndex = { checker, handlers, source }
  return cachedHandlerIndex
}

function compileLocalFunction<T>(source: ts.SourceFile, functionName: string, dependencies: Record<string, unknown>): T {
  let initializer: ts.Expression | undefined
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === functionName) {
      initializer = node.initializer
      return
    }
    if (ts.isFunctionDeclaration(node) && node.name?.text === functionName) {
      initializer = ts.factory.createFunctionExpression(
        undefined,
        node.asteriskToken,
        node.name,
        node.typeParameters,
        node.parameters,
        node.type,
        node.body!,
      )
      return
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  if (!initializer) throw new Error(`找不到局部函数: ${functionName}`)
  const dependencyNames = Object.keys(dependencies)
  const functionSource = initializer.pos >= 0
    ? initializer.getText(source)
    : ts.createPrinter().printNode(ts.EmitHint.Expression, initializer, source)
  const executable = ts.transpileModule(`const __target = ${functionSource}`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText
  const factory = new Function(...dependencyNames, `${executable}\nreturn __target`) as (...args: unknown[]) => unknown
  return factory(...dependencyNames.map((name) => dependencies[name])) as T
}

function compileHandler<T>(registered: RegisteredHandler, dependencies: Record<string, unknown>): T {
  const dependencyNames = Object.keys(dependencies)
  const executable = ts.transpileModule(`const __target = ${registered.handler.getText()}`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText
  const factory = new Function(...dependencyNames, `${executable}\nreturn __target`) as (...args: unknown[]) => unknown
  return factory(...dependencyNames.map((name) => dependencies[name])) as T
}

function handlerReceivesSessionId(handler: RegisteredHandler, checker: ts.TypeChecker): boolean {
  if (SESSION_ID_ALIAS_CHANNELS.has(handler.channel)) return true
  return handler.handler.parameters.slice(1).some((parameter) => {
    if (/sessionId/i.test(parameter.name.getText())) return true
    return containsSessionId(checker.getTypeAtLocation(parameter), checker)
  })
}

describe('普通 Renderer Agent IPC 会话访问矩阵', () => {
  test('Given 不存在、Design、Canvas 或半归属会话 When 进入普通入口 Then 统一表现为会话不存在', () => {
    const internalSessions = [
      undefined,
      { id: 'design', title: 'Design', sourceDesignProjectId: 'p', sourceDesignJobId: 'j', createdAt: 1, updatedAt: 1 },
      { id: 'canvas', title: 'Canvas', workspaceId: 'p', sourceCanvasProjectId: 'p', sourceCanvasId: 'c', sourceCanvasNodeId: 'n', createdAt: 1, updatedAt: 1 },
      { id: 'partial', title: 'Partial', sourceCanvasProjectId: 'p', createdAt: 1, updatedAt: 1 },
    ]

    for (const candidate of internalSessions) {
      expect(() => requireUserVisibleAgentSession(candidate)).toThrow('Agent 会话不存在')
    }
    expect(requireUserVisibleAgentSession({ id: 'visible', title: '普通会话', createdAt: 1, updatedAt: 1 }).id).toBe('visible')
  })

  test('Given 普通 AGENT handler 接收 sessionId When 检查顶层执行路径 Then guard 先于业务调用', () => {
    const { checker, handlers } = loadAgentHandlers()
    const sessionHandlers = handlers.filter((handler) => handlerReceivesSessionId(handler, checker))
    expect(sessionHandlers.length).toBeGreaterThan(25)

    for (const { channel, handler } of sessionHandlers) {
      const calls = collectTopLevelExecutionCalls(handler.body)
      const guardIndex = calls.findIndex((call) => [
        'requireVisibleSession',
        'requireVisibleFileAccess',
        'assertBrowserSessionAccess',
      ].includes(getCallName(call)))
      expect(guardIndex, `${channel} 缺少普通会话可见性 guard`).toBeGreaterThanOrEqual(0)

      const callsBeforeGuard = calls
        .slice(0, guardIndex)
        .map(getCallName)
        .filter((name) => !PURE_VALIDATION_CALLS.has(name) && name !== 'Error')
      expect(callsBeforeGuard, `${channel} 在 guard 前执行了业务调用`).toEqual([])
    }
  })

  test('Given AGENT handler 使用裸 id 参数 When 检查矩阵 Then 每个 id 都必须显式归类', () => {
    const { handlers } = loadAgentHandlers()
    const bareIdChannels = handlers
      .filter(({ handler }) => handler.parameters.slice(1).some((parameter) => parameter.name.getText() === 'id'))
      .map(({ channel }) => channel)
      .sort()
    const classifiedChannels = [...SESSION_ID_ALIAS_CHANNELS, ...NON_SESSION_ID_ALIAS_CHANNELS].sort()
    expect(bareIdChannels).toEqual(classifiedChannels)
  })

  test('Given 浏览器 wrapper 收到不存在或内部会话 When 执行实际 wrapper Then Renderer 与浏览器副作用为零', async () => {
    const { source } = loadAgentHandlers()
    const sessions = new Map<string, AgentSessionMeta>([
      ['design', { id: 'design', title: 'Design', sourceDesignProjectId: 'p', sourceDesignJobId: 'j', createdAt: 1, updatedAt: 1 }],
      ['canvas', { id: 'canvas', title: 'Canvas', workspaceId: 'p', sourceCanvasProjectId: 'p', sourceCanvasId: 'c', sourceCanvasNodeId: 'n', createdAt: 1, updatedAt: 1 }],
      ['partial', { id: 'partial', title: 'Partial', sourceCanvasProjectId: 'p', createdAt: 1, updatedAt: 1 }],
    ])
    let rendererCallCount = 0
    let browserCallCount = 0
    const wrapper = compileLocalFunction<(senderId: number, sessionId: string) => Promise<void>>(source, 'assertBrowserSessionAccess', {
      requireVisibleSession: (sessionId: string) => requireUserVisibleAgentSession(sessions.get(sessionId)),
      assertMainRenderer: async () => { rendererCallCount += 1 },
      browserController: { configureSession: () => { browserCallCount += 1 } },
      resolveBrowserProfileKey: () => 'profile',
    })

    for (const sessionId of ['missing', 'design', 'canvas', 'partial']) {
      await expect(wrapper(1, sessionId)).rejects.toThrow('Agent 会话不存在')
    }
    expect(rendererCallCount).toBe(0)
    expect(browserCallCount).toBe(0)
  })

  test('Given 文件入口显式非法 session 或目标属于内部/其他会话 When 执行实际 wrapper Then 业务副作用为零', () => {
    const { source } = loadAgentHandlers()
    const sessions = new Map<string, AgentSessionMeta>([
      ['visible-a', { id: 'visible-a', title: 'A', createdAt: 1, updatedAt: 1 }],
      ['visible-b', { id: 'visible-b', title: 'B', createdAt: 1, updatedAt: 1 }],
      ['canvas', { id: 'canvas', title: 'Canvas', workspaceId: 'p', sourceCanvasProjectId: 'p', sourceCanvasId: 'c', sourceCanvasNodeId: 'n', createdAt: 1, updatedAt: 1 }],
      ['design', { id: 'design', title: 'Design', sourceDesignProjectId: 'p', sourceDesignJobId: 'j', createdAt: 1, updatedAt: 1 }],
    ])
    const owners = new Map<string, AgentSessionMeta>([
      ['/canvas-cwd', sessions.get('canvas')!],
      ['/visible-b-cwd', sessions.get('visible-b')!],
      ['/visible-a-cwd', sessions.get('visible-a')!],
    ])
    const requireVisibleFileAccess = compileLocalFunction<(access: FileAccessOptions | undefined, targetPaths: string[]) => void>(
      source,
      'requireVisibleFileAccess',
      {
        normalizeFileAccessOptions: (access: FileAccessOptions | undefined) => access,
        hasExplicitSessionId: (access: FileAccessOptions | undefined) => access !== undefined && Object.prototype.hasOwnProperty.call(access, 'sessionId'),
        getManagedAgentSessionPathOwner: (path: string) => owners.get(path),
        requireVisibleSession: (sessionId: string) => requireUserVisibleAgentSession(sessions.get(sessionId)),
      },
    )
    let businessCallCount = 0
    const runFileOperation = (access: FileAccessOptions | undefined, path: string): void => {
      requireVisibleFileAccess(access, [path])
      businessCallCount += 1
    }

    const rejectedCases: Array<[string, FileAccessOptions | undefined, string]> = [
      ['空 sessionId', { sessionId: '' }, '/workspace-file'],
      ['空白 sessionId', { sessionId: '   ' }, '/workspace-file'],
      ['未知 sessionId', { sessionId: 'missing' }, '/workspace-file'],
      ['缺失 context 访问 Canvas cwd', undefined, '/canvas-cwd'],
      ['普通会话跨 session cwd', { sessionId: 'visible-a' }, '/visible-b-cwd'],
      ['unrestricted 跨 session cwd', { sessionId: 'visible-a', unrestricted: true }, '/visible-b-cwd'],
      ['Design session context', { sessionId: 'design' }, '/workspace-file'],
    ]
    for (const [_label, access, path] of rejectedCases) {
      expect(() => runFileOperation(access, path)).toThrow('Agent 会话不存在')
    }
    expect(businessCallCount).toBe(0)

    runFileOperation(undefined, '/workspace-file')
    runFileOperation(undefined, '/tmp-file')
    runFileOperation({ sessionId: 'visible-a' }, '/visible-a-cwd')
    expect(businessCallCount).toBe(3)
  })

  test('Given 文件入口未提供 session context When 计算授权根 Then 仅保留 workspace-files 与 tmp', () => {
    const { source } = loadAgentHandlers()
    const getAuthorizedRoots = compileLocalFunction<(access?: FileAccessOptions) => string[]>(source, 'getAuthorizedRoots', {
      tmpdir: () => '/tmp',
      join,
      getConfigDir: () => '/config',
      listAgentWorkspaces: () => [{ slug: 'alpha' }, { slug: 'beta' }],
      getAgentSessionMeta: () => undefined,
      getAgentWorkspace: () => undefined,
      getProjectFilesPath: () => '',
      getWorkspaceAttachedDirectories: () => [],
      getWorkspaceAttachedFiles: () => [],
    })

    expect(getAuthorizedRoots()).toEqual([
      '/tmp/proma-preview',
      '/config/agent-workspaces/alpha/workspace-files',
      '/config/agent-workspaces/beta/workspace-files',
    ])
    expect(getAuthorizedRoots()).not.toContain('/config/agent-workspaces')
  })

  test('Given 文件 handler 收到非法 context 或 Canvas/跨会话 cwd When 执行已注册 handler Then 文件业务函数零调用', async () => {
    const { handlers, source } = loadAgentHandlers()
    const sessions = new Map<string, AgentSessionMeta>([
      ['visible-a', { id: 'visible-a', title: 'A', createdAt: 1, updatedAt: 1 }],
      ['visible-b', { id: 'visible-b', title: 'B', createdAt: 1, updatedAt: 1 }],
      ['canvas', { id: 'canvas', title: 'Canvas', workspaceId: 'p', sourceCanvasProjectId: 'p', sourceCanvasId: 'c', sourceCanvasNodeId: 'n', createdAt: 1, updatedAt: 1 }],
    ])
    const owners = new Map<string, AgentSessionMeta>([
      ['/canvas-cwd', sessions.get('canvas')!],
      ['/visible-b-cwd', sessions.get('visible-b')!],
    ])
    const requireVisibleFileAccess = compileLocalFunction<(access: FileAccessOptions | undefined, targetPaths: string[]) => void>(
      source,
      'requireVisibleFileAccess',
      {
        normalizeFileAccessOptions: (access: FileAccessOptions | undefined) => access,
        hasExplicitSessionId: (access: FileAccessOptions | undefined) => access !== undefined && Object.prototype.hasOwnProperty.call(access, 'sessionId'),
        getManagedAgentSessionPathOwner: (path: string) => owners.get(path),
        requireVisibleSession: (sessionId: string) => requireUserVisibleAgentSession(sessions.get(sessionId)),
      },
    )
    let resolveCallCount = 0
    let listCallCount = 0
    const listHandlerNode = handlers.find(({ channel }) => channel === 'LIST_DIRECTORY')
    expect(listHandlerNode).toBeDefined()
    const listHandler = compileHandler<(
      event: object,
      path: string,
      access?: FileAccessOptions,
    ) => Promise<unknown>>(listHandlerNode!, {
      requireVisibleFileAccess,
      resolve: (path: string) => { resolveCallCount += 1; return path },
      existsSync: () => true,
      normalizeFileAccessOptions: (access: FileAccessOptions | undefined) => access,
      isPathAllowed: () => true,
      listShallowDirectory: () => { listCallCount += 1; return [] },
    })

    const rejectedCases: Array<[string, FileAccessOptions | undefined]> = [
      ['/workspace-file', { sessionId: '' }],
      ['/canvas-cwd', undefined],
      ['/visible-b-cwd', { sessionId: 'visible-a' }],
      ['/visible-b-cwd', { sessionId: 'visible-a', unrestricted: true }],
    ]
    for (const [path, access] of rejectedCases) {
      await expect(listHandler({}, path, access)).rejects.toThrow('Agent 会话不存在')
    }
    expect(resolveCallCount).toBe(0)
    expect(listCallCount).toBe(0)

    await expect(listHandler({}, '/workspace-file')).resolves.toEqual([])
    await expect(listHandler({}, '/tmp-file')).resolves.toEqual([])
    expect(resolveCallCount).toBe(2)
    expect(listCallCount).toBe(2)

    const readHandlerNode = handlers.find(({ channel }) => channel === 'READ_ATTACHED_FILE')
    expect(readHandlerNode).toBeDefined()
    const readHandler = compileHandler<(
      event: object,
      path: string,
      sessionId?: string,
      workspaceSlug?: string,
    ) => Promise<string>>(readHandlerNode!, { requireVisibleFileAccess })
    await expect(readHandler({}, '/workspace-file', '')).rejects.toThrow('Agent 会话不存在')
    await expect(readHandler({}, '/canvas-cwd')).rejects.toThrow('Agent 会话不存在')
    await expect(readHandler({}, '/visible-b-cwd', 'visible-a')).rejects.toThrow('Agent 会话不存在')
    expect(resolveCallCount).toBe(2)
    expect(listCallCount).toBe(2)
  })

  test('Given requestId 响应与 pending 快照入口 When 检查顶层执行路径 Then owner 校验先于消费且快照过滤不可见 owner', () => {
    const { handlers } = loadAgentHandlers()
    for (const channel of OWNER_RESPONSE_CHANNELS) {
      const registered = handlers.find((handler) => handler.channel === channel)
      expect(registered, `${channel} 未注册`).toBeDefined()
      const calls = collectTopLevelExecutionCalls(registered!.handler.body).map(getCallName)
      const ownerIndex = calls.findIndex((name) => name.endsWith('.getPendingRequestOwner'))
      const guardIndex = calls.indexOf('requireVisibleSession')
      const respondIndex = calls.findIndex((name) => name.includes('respondTo'))
      expect(ownerIndex, `${channel} 缺少只读 owner 查询`).toBeGreaterThanOrEqual(0)
      expect(guardIndex, `${channel} 缺少 owner 可见性校验`).toBeGreaterThan(ownerIndex)
      expect(respondIndex, `${channel} 在校验前消费了请求`).toBeGreaterThan(guardIndex)
    }

    for (const channel of FILTERED_SNAPSHOT_CHANNELS) {
      const registered = handlers.find((handler) => handler.channel === channel)
      expect(registered, `${channel} 未注册`).toBeDefined()
      const calls = collectTopLevelExecutionCalls(registered!.handler.body).map(getCallName)
      expect(calls).toContain('getUserVisiblePendingRequests')
    }
  })

  test.each([
    ['PERMISSION_RESPOND', 'permissionService', 'respondToPermission'],
    ['ASK_USER_RESPOND', 'askUserService', 'respondToAskUser'],
    ['EXIT_PLAN_MODE_RESPOND', 'exitPlanService', 'respondToExitPlanMode'],
  ])('Given %s 的 owner 内部、未知或已删除 When 执行实际 handler Then owner 传入 guard 且请求不消费', async (channel, serviceName, respondName) => {
    const { handlers } = loadAgentHandlers()
    const registered = handlers.find((handler) => handler.channel === channel)
    expect(registered).toBeDefined()

    for (const ownerSessionId of ['canvas-owner', 'unknown-owner', 'deleted-owner']) {
      let guardedSessionId = ''
      let respondCallCount = 0
      const service = {
        getPendingRequestOwner: () => ownerSessionId === 'unknown-owner' ? null : ownerSessionId,
        [respondName]: () => {
          respondCallCount += 1
          return null
        },
      }
      const handler = compileHandler<(event: { sender: { send: () => void } }, response: Record<string, unknown>) => Promise<void>>(
        registered!,
        {
          [serviceName]: service,
          requireVisibleSession: (sessionId: string) => {
            guardedSessionId = sessionId
            throw new Error('Agent 会话不存在')
          },
        },
      )

      await expect(handler(
        { sender: { send: () => undefined } },
        { requestId: 'request-1', answers: {}, behavior: 'allow', alwaysAllow: false, action: 'deny' },
      )).rejects.toThrow('Agent 会话不存在')
      expect(guardedSessionId).toBe(ownerSessionId === 'unknown-owner' ? '' : ownerSessionId)
      expect(respondCallCount).toBe(0)
    }
  })
})
