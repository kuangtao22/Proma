import { describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { closeSync, constants, existsSync, fstatSync, ftruncateSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
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

/** 直接读写本地路径的非 Agent 通道，必须纳入同一文件访问边界。 */
const NON_AGENT_FILE_CHANNELS = new Set([
  'GET_GIT_REPO_STATUS',
  'GET_UNSTAGED_CHANGES',
  'GET_FILE_DIFF',
  'GET_UNTRACKED_CONTENT',
  'REVERT_FILE',
  'GET_DIFF_CONTENTS',
  'LIST_WORKTREES',
  'GET_WORKTREE_CHANGES',
  'OPEN_DETACHED_PREVIEW',
  'SYSTEM_OPEN_FILE',
  'GET_DEFAULT_APP_FOR_FILE',
  'file:resolve-and-read',
  'file:write-text',
  'file:resolve-path',
  'file:resolve-html-preview-path',
  'file:prepare-pdf-preview',
  'file:docx-to-html',
  'file:office-to-html',
  'file:read-binary-base64',
])

interface RegisteredHandler {
  channel: string
  namespace: string
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
      if (channelArg && handlerArg && (ts.isArrowFunction(handlerArg) || ts.isFunctionExpression(handlerArg))) {
        if (ts.isPropertyAccessExpression(channelArg)) {
          handlers.push({
            channel: channelArg.name.text,
            namespace: channelArg.expression.getText(source),
            handler: handlerArg,
          })
        } else if (ts.isStringLiteral(channelArg)) {
          handlers.push({ channel: channelArg.text, namespace: 'literal', handler: handlerArg })
        }
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
    const sessionHandlers = handlers.filter((handler) => (
      handler.namespace === 'AGENT_IPC_CHANNELS' && handlerReceivesSessionId(handler, checker)
    ))
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

  test('Given ipc.ts 注册全部 Renderer handler When 枚举访问矩阵 Then 非 Agent 文件入口也在业务调用前 guard', () => {
    const { handlers } = loadAgentHandlers()
    expect(handlers.length).toBeGreaterThan(180)

    for (const channel of NON_AGENT_FILE_CHANNELS) {
      const registered = handlers.find((handler) => handler.channel === channel)
      expect(registered, `${channel} 未纳入全量 ipcMain.handle 矩阵`).toBeDefined()
      const calls = collectTopLevelExecutionCalls(registered!.handler.body)
      const guardIndex = calls.findIndex((call) => getCallName(call) === 'requireVisibleFileAccess')
      expect(guardIndex, `${channel} 缺少文件访问 guard`).toBeGreaterThanOrEqual(0)
      const businessCallsBeforeGuard = calls
        .slice(0, guardIndex)
        .map(getCallName)
        .filter((name) => !PURE_VALIDATION_CALLS.has(name) && name !== 'Error' && name !== 'console.warn')
      expect(businessCallsBeforeGuard, `${channel} 在 guard 前执行了业务调用`).toEqual([])
    }
  })

  test('Given Git、独立预览与 file handler 收到内部或未知会话 When 执行真实 handler Then 业务副作用为零', async () => {
    const { handlers } = loadAgentHandlers()
    for (const channel of ['GET_FILE_DIFF', 'OPEN_DETACHED_PREVIEW', 'file:resolve-and-read']) {
      const registered = handlers.find((handler) => handler.channel === channel)
      expect(registered).toBeDefined()
      let businessCallCount = 0
      const handler = compileHandler<(...args: unknown[]) => Promise<unknown>>(registered!, {
        requireVisibleFileAccess: () => { throw new Error('Agent 会话不存在') },
        normalizeFileAccessOptions: (value: unknown) => value,
        ensurePathAllowedWithWorktree: async () => { businessCallCount += 1; return true },
        getFileDiff: () => { businessCallCount += 1; return '' },
        BrowserWindow: { fromWebContents: () => { businessCallCount += 1; return null } },
      })
      const args = channel === 'GET_FILE_DIFF'
        ? [{}, { dirPath: '/cwd', filePath: 'a.ts', sessionId: 'canvas' }]
        : channel === 'OPEN_DETACHED_PREVIEW'
          ? [{ sender: {} }, { dirPath: '/cwd', filePath: '/cwd/a.ts', sessionId: 'canvas' }]
          : [{}, '/cwd/a.ts', { sessionId: 'missing' }]
      await expect(handler(...args)).rejects.toThrow('Agent 会话不存在')
      expect(businessCallCount, `${channel} 在 guard 失败后仍执行副作用`).toBe(0)
    }
  })

  test('Given AGENT handler 使用裸 id 参数 When 检查矩阵 Then 每个 id 都必须显式归类', () => {
    const { handlers } = loadAgentHandlers()
    const bareIdChannels = handlers
      .filter(({ namespace }) => namespace === 'AGENT_IPC_CHANNELS')
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
        createRendererFileAccessSnapshot: (access: FileAccessOptions | undefined) => ({
          options: access,
          sessionsById: sessions,
        }),
        hasExplicitSessionId: (access: FileAccessOptions | undefined) => access !== undefined && Object.prototype.hasOwnProperty.call(access, 'sessionId'),
        getManagedAgentSessionPathOwner: (path: string) => ({ managed: owners.has(path), owner: owners.get(path) }),
        requireVisibleSession: (sessionId: string) => requireUserVisibleAgentSession(sessions.get(sessionId)),
        requireUserVisibleAgentSession,
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
      listAgentSessions: () => [],
      listAgentWorkspaces: () => [{ id: 'a', slug: 'alpha' }, { id: 'b', slug: 'beta' }],
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

  test('Given Git worktree 进入兜底授权分支 When 获取工作区 slug Then 复用当前 IPC 快照', () => {
    const { source } = loadAgentHandlers()
    const sourceText = source.getFullText()

    expect(sourceText).toContain('getWorkspaceSlugsForAccess(options, snapshot)')
    expect(sourceText).not.toContain('getWorkspaceSlugsForAccess(options))')
  })

  test('Given canonical 托管根包含孤儿或 workspace 不匹配 cwd When 解析 owner Then fail closed 且前缀相似路径不误判', () => {
    const { source } = loadAgentHandlers()
    const visible = { id: 'visible', title: 'A', workspaceId: 'workspace-a', createdAt: 1, updatedAt: 1 }
    const mismatch = { id: 'mismatch', title: 'B', workspaceId: 'workspace-b', createdAt: 1, updatedAt: 1 }
    const snapshot = {
      managedRoot: '/real/config/agent-workspaces',
      workspacesBySlug: new Map([['alpha', { id: 'workspace-a', slug: 'alpha' }]]),
      sessionsById: new Map([['visible', visible], ['mismatch', mismatch]]),
    }
    const canonicalPaths = new Map([
      ['/linked/config/agent-workspaces/alpha/visible/file.ts', '/real/config/agent-workspaces/alpha/visible/file.ts'],
    ])
    const resolveOwner = compileLocalFunction<(path: string, accessSnapshot: typeof snapshot) => { managed: boolean, owner?: AgentSessionMeta }>(
      source,
      'getManagedAgentSessionPathOwner',
      {
        relative: (root: string, path: string) => path.startsWith(`${root}/`) ? path.slice(root.length + 1) : '../outside',
        sep: '/',
        isAbsolute: (path: string) => path.startsWith('/'),
        canonicalizeAccessPath: (path: string) => canonicalPaths.get(path) ?? path,
        MANAGED_WORKSPACE_SHARED_ENTRIES: new Set([
          'workspace-files', 'skills', 'skills-inactive', '.claude', 'memory',
          'AGENTS.md', 'CLAUDE.md', 'mcp.json', 'config.json',
        ]),
      },
    )

    expect(resolveOwner('/linked/config/agent-workspaces/alpha/visible/file.ts', snapshot).owner?.id).toBe('visible')
    expect(resolveOwner('/real/config/agent-workspaces/alpha/workspace-files/file.ts', snapshot)).toEqual({ managed: false })
    expect(resolveOwner('/real/config/agent-workspaces/alpha/skills/example/SKILL.md', snapshot)).toEqual({ managed: false })
    expect(resolveOwner('/real/config/agent-workspaces/alpha/skills-inactive/example/SKILL.md', snapshot)).toEqual({ managed: false })
    expect(resolveOwner('/real/config/agent-workspaces/alpha/.claude/settings.json', snapshot)).toEqual({ managed: false })
    expect(resolveOwner('/real/config/agent-workspaces/alpha/memory/MEMORY.md', snapshot)).toEqual({ managed: false })
    expect(resolveOwner('/real/config/agent-workspaces/alpha/AGENTS.md', snapshot)).toEqual({ managed: false })
    expect(resolveOwner('/real/config/agent-workspaces/alpha/CLAUDE.md', snapshot)).toEqual({ managed: false })
    expect(resolveOwner('/real/config/agent-workspaces/alpha/mcp.json', snapshot)).toEqual({ managed: false })
    expect(resolveOwner('/real/config/agent-workspaces/alpha/config.json', snapshot)).toEqual({ managed: false })
    expect(resolveOwner('/real/config/agent-workspaces/alpha/orphan/file.ts', snapshot)).toEqual({ managed: true })
    expect(resolveOwner('/real/config/agent-workspaces/alpha/mismatch/file.ts', snapshot)).toEqual({ managed: true })
    expect(resolveOwner('/real/config/agent-workspaces-evil/alpha/visible/file.ts', snapshot)).toEqual({ managed: false })
  })

  test('Given Renderer 为可见会话伪造其他 workspaceId When 获取 session path Then 不拼接攻击者工作区路径', async () => {
    const { handlers } = loadAgentHandlers()
    const registered = handlers.find((handler) => handler.channel === 'GET_SESSION_PATH')
    expect(registered).toBeDefined()
    let pathCallCount = 0
    const handler = compileHandler<(event: object, workspaceId: string, sessionId: string) => Promise<string | null>>(
      registered!,
      {
        requireVisibleSession: () => ({ id: 'visible', title: 'A', workspaceId: 'workspace-a', createdAt: 1, updatedAt: 1 }),
        getAgentWorkspace: (workspaceId: string) => ({ id: workspaceId, slug: workspaceId === 'workspace-a' ? 'alpha' : 'attacker' }),
        getAgentSessionWorkspacePath: () => { pathCallCount += 1; return '/attacker/visible' },
      },
    )

    await expect(handler({}, 'workspace-b', 'visible')).resolves.toBeNull()
    expect(pathCallCount).toBe(0)
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
        createRendererFileAccessSnapshot: (access: FileAccessOptions | undefined) => ({
          options: access,
          sessionsById: sessions,
        }),
        hasExplicitSessionId: (access: FileAccessOptions | undefined) => access !== undefined && Object.prototype.hasOwnProperty.call(access, 'sessionId'),
        getManagedAgentSessionPathOwner: (path: string) => ({ managed: owners.has(path), owner: owners.get(path) }),
        requireVisibleSession: (sessionId: string) => requireUserVisibleAgentSession(sessions.get(sessionId)),
        requireUserVisibleAgentSession,
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

  test('Given 文件授权后叶子或祖先被替换 When 稳定读写删除重命名移动 Then 不消费替换后的对象', () => {
    const { source } = loadAgentHandlers()
    const root = mkdtempSync(join(tmpdir(), 'proma-renderer-file-race-'))
    try {
      const captureStablePathIdentity = compileLocalFunction<(path: string) => { dev: number, ino: number }>(source, 'captureStablePathIdentity', { lstatSync })
      const assertStablePathIdentity = compileLocalFunction<(path: string, identity: { dev: number, ino: number }) => void>(source, 'assertStablePathIdentity', { lstatSync })
      const sharedDependencies = { resolve, dirname, captureStablePathIdentity, assertStablePathIdentity, existsSync }
      const readStableFile = compileLocalFunction<(path: string, maxSize: number, hook?: () => void) => Buffer>(source, 'readStableFile', {
        ...sharedDependencies, openSync, constants, fstatSync, readFileSync, closeSync,
      })
      const writeStableTextFile = compileLocalFunction<(path: string, content: string, hook?: () => void) => void>(source, 'writeStableTextFile', {
        ...sharedDependencies, openSync, constants, fstatSync, ftruncateSync, writeFileSync, closeSync,
      })
      const removeStablePath = compileLocalFunction<(path: string, hook?: () => void) => void>(source, 'removeStablePath', {
        ...sharedDependencies, join, randomUUID, renameSync, rmSync,
      })
      const renameStablePath = compileLocalFunction<(sourcePath: string, destinationPath: string, hook?: () => void) => void>(source, 'renameStablePath', {
        ...sharedDependencies, renameSync,
      })
      const moveStablePath = compileLocalFunction<(sourcePath: string, targetDir: string, hook?: () => void) => string>(source, 'moveStablePath', {
        ...sharedDependencies,
        basename,
        join,
        movePathSafely: (sourcePath: string, targetDir: string) => {
          const destination = join(targetDir, basename(sourcePath))
          renameSync(sourcePath, destination)
          return destination
        },
      })

      const authorized = join(root, 'authorized.txt')
      const replacement = join(root, 'replacement.txt')
      writeFileSync(authorized, 'authorized')
      writeFileSync(replacement, 'replacement')
      expect(() => readStableFile(authorized, 1024, () => renameSync(replacement, authorized))).toThrow('文件身份已变化')

      const writeTarget = join(root, 'write.txt')
      const writeReplacement = join(root, 'write-replacement.txt')
      writeFileSync(writeTarget, 'original')
      writeFileSync(writeReplacement, 'do-not-touch')
      expect(() => writeStableTextFile(writeTarget, 'attacker-overwrite', () => renameSync(writeReplacement, writeTarget))).toThrow('文件身份已变化')
      expect(readFileSync(writeTarget, 'utf8')).toBe('do-not-touch')

      const deleteTarget = join(root, 'delete.txt')
      const deleteReplacement = join(root, 'delete-replacement.txt')
      writeFileSync(deleteTarget, 'original')
      writeFileSync(deleteReplacement, 'do-not-delete')
      expect(() => removeStablePath(deleteTarget, () => renameSync(deleteReplacement, deleteTarget))).toThrow('文件身份已变化')
      expect(readFileSync(deleteTarget, 'utf8')).toBe('do-not-delete')

      const renameTarget = join(root, 'rename.txt')
      const renameReplacement = join(root, 'rename-replacement.txt')
      const renamed = join(root, 'renamed.txt')
      writeFileSync(renameTarget, 'original')
      writeFileSync(renameReplacement, 'do-not-rename')
      expect(() => renameStablePath(renameTarget, renamed, () => renameSync(renameReplacement, renameTarget))).toThrow('文件身份已变化')
      expect(existsSync(renamed)).toBe(false)
      expect(readFileSync(renameTarget, 'utf8')).toBe('do-not-rename')

      const moveTarget = join(root, 'move.txt')
      const moveReplacement = join(root, 'move-replacement.txt')
      const targetDir = join(root, 'target')
      mkdirSync(targetDir)
      writeFileSync(moveTarget, 'original')
      writeFileSync(moveReplacement, 'do-not-move')
      expect(() => moveStablePath(moveTarget, targetDir, () => renameSync(moveReplacement, moveTarget))).toThrow('文件身份已变化')
      expect(existsSync(join(targetDir, 'move.txt'))).toBe(false)
      expect(readFileSync(moveTarget, 'utf8')).toBe('do-not-move')

      const ancestor = join(root, 'ancestor')
      const movedAncestor = join(root, 'ancestor-old')
      const outside = join(root, 'outside')
      mkdirSync(ancestor)
      mkdirSync(outside)
      writeFileSync(join(ancestor, 'secret.txt'), 'authorized')
      writeFileSync(join(outside, 'secret.txt'), 'outside-secret')
      expect(() => readStableFile(join(ancestor, 'secret.txt'), 1024, () => {
        renameSync(ancestor, movedAncestor)
        symlinkSync(outside, ancestor)
      })).toThrow('文件身份已变化')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
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

  test('Given pending 过滤读取会话索引故障 When 构造快照 Then 异常向上抛而非吞掉请求', () => {
    const { source } = loadAgentHandlers()
    const createVisibleSessionIdSet = compileLocalFunction<() => Set<string>>(
      source,
      'createVisibleSessionIdSet',
      {
        listAgentSessions: () => { throw new Error('会话索引读取失败') },
        isAgentSessionUserVisible: () => true,
      },
    )

    expect(() => createVisibleSessionIdSet()).toThrow('会话索引读取失败')
  })

  test('Given 默认应用查询创建授权快照失败 When 执行真实 handler Then 存储异常向上抛', async () => {
    const { handlers } = loadAgentHandlers()
    const registered = handlers.find((handler) => handler.channel === 'GET_DEFAULT_APP_FOR_FILE')
    expect(registered).toBeDefined()
    const handler = compileHandler<(event: object, filePath: string) => Promise<unknown>>(registered!, {
      requireVisibleFileAccess: () => { throw new Error('会话索引读取失败') },
    })

    await expect(handler({}, '/workspace/file.ts')).rejects.toThrow('会话索引读取失败')
  })

  test('Given 三类 pending 请求 When 执行真实快照 handler Then session 索引仅扫描一次并复用 visible ID Set', async () => {
    const { handlers } = loadAgentHandlers()
    const registered = handlers.find((handler) => handler.channel === 'GET_PENDING_REQUESTS')
    expect(registered).toBeDefined()
    let sessionScanCount = 0
    const pending = [{ sessionId: 'visible' }, { sessionId: 'canvas' }]
    const handler = compileHandler<(event: object) => Promise<{ permissions: unknown[], askUsers: unknown[], exitPlans: unknown[] }>>(
      registered!,
      {
        createVisibleSessionIdSet: () => {
          sessionScanCount += 1
          return new Set(['visible'])
        },
        getUserVisiblePendingRequests: (requests: Array<{ sessionId: string }>, visibleIds: Set<string>) => (
          requests.filter((request) => visibleIds.has(request.sessionId))
        ),
        permissionService: { getPendingRequests: () => pending },
        askUserService: { getPendingRequests: () => pending },
        exitPlanService: { getPendingRequests: () => pending },
      },
    )

    const result = await handler({})
    expect(sessionScanCount).toBe(1)
    expect(result.permissions).toEqual([{ sessionId: 'visible' }])
    expect(result.askUsers).toEqual([{ sessionId: 'visible' }])
    expect(result.exitPlans).toEqual([{ sessionId: 'visible' }])
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
