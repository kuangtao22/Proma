import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'
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

/** 参数名为 id、但语义上表示 Agent session 的既有通道。 */
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

function getCallName(call: ts.CallExpression): string {
  return call.expression.getText()
}

function containsSessionId(type: ts.Type, checker: ts.TypeChecker, seen = new Set<ts.Type>()): boolean {
  if (seen.has(type)) return false
  seen.add(type)
  if (type.isUnionOrIntersection()) {
    return type.types.some((member) => containsSessionId(member, checker, seen))
  }
  if (checker.getPropertyOfType(type, 'sessionId')) return true
  return false
}

function collectCalls(node: ts.Node): ts.CallExpression[] {
  const calls: ts.CallExpression[] = []
  const visit = (candidate: ts.Node): void => {
    if (ts.isCallExpression(candidate)) calls.push(candidate)
    ts.forEachChild(candidate, visit)
  }
  visit(node)
  return calls.sort((left, right) => left.getStart() - right.getStart())
}

function loadAgentHandlers(): { checker: ts.TypeChecker; handlers: RegisteredHandler[] } {
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
  return { checker, handlers }
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

  test('Given 普通 AGENT handler 接收 sessionId When 检查结构 Then guard 先于业务调用', () => {
    const { checker, handlers } = loadAgentHandlers()
    const sessionHandlers = handlers.filter((handler) => handlerReceivesSessionId(handler, checker))
    expect(sessionHandlers.length).toBeGreaterThan(25)

    for (const { channel, handler } of sessionHandlers) {
      const calls = collectCalls(handler.body)
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

  test('Given requestId 响应与 pending 快照入口 When 检查结构 Then owner 校验先于消费且快照过滤不可见 owner', () => {
    const { handlers } = loadAgentHandlers()
    for (const channel of OWNER_RESPONSE_CHANNELS) {
      const registered = handlers.find((handler) => handler.channel === channel)
      expect(registered, `${channel} 未注册`).toBeDefined()
      const calls = collectCalls(registered!.handler.body).map(getCallName)
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
      const calls = collectCalls(registered!.handler.body).map(getCallName)
      expect(calls).toContain('getUserVisiblePendingRequests')
    }
  })
})
