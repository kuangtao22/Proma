import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import ts from 'typescript'
import type { AgentDeferredQueueMessageInput, AgentStopResult, AgentSubmitOrEnqueueInput, AgentSubmitOrEnqueueResult } from '@proma/shared'
import { AgentStreamRouteRegistry } from './agent-stream-route-registry'
import { routeAgentSubmitOrEnqueue } from './agent-queue-routing'
import { shouldStopBeforeAgentRun } from './agent-stop-policy'

/** 受控窗口只提供生产路由实际读取的身份与存活状态。 */
interface Target { id: number; isDestroyed(): boolean }
/** 从生产服务提取的入口签名，避免为测试重复实现 submit/stop 逻辑。 */
interface ServiceEntrypoints {
  submitOrEnqueueAgentMessage(input: AgentSubmitOrEnqueueInput, target: Target): Promise<AgentSubmitOrEnqueueResult>
  enqueueAgentQueuedMessage(input: AgentDeferredQueueMessageInput, target: Target): void
  stopAgent(sessionId: string): AgentStopResult
}
/** 各个停止阶段分别控制，验证 UI 活跃槽移除后仍不能误报停止。 */
interface RunState { active?: boolean; inFlight?: boolean; starting?: boolean; dispatching?: boolean }

/** 编译实际生产函数并注入外部边界；路由、提交策略和停止策略使用真实实现。 */
function loadProductionFunctions(registry: AgentStreamRouteRegistry<Target>, state: RunState = {}): ServiceEntrypoints {
  /** 可选源码路径只用于对照旧版红灯，不会修改运行中的开发目录。 */
  const source = readFileSync(process.env.PROMA_SERVICE_REGRESSION_SOURCE ?? new URL('./agent-service.ts', import.meta.url), 'utf8')
  /** 用 TypeScript AST 取完整函数，避免手写字符串/花括号解析误取代码。 */
  const parsed = ts.createSourceFile('agent-service.ts', source, ts.ScriptTarget.Latest, true)
  /** 仅隔离这三个服务入口，避免导入整个 Electron 应用产生业务副作用。 */
  const names = new Set(['submitOrEnqueueAgentMessage', 'enqueueAgentQueuedMessage', 'stopAgent'])
  /** 实际生产函数正文，包含原有全部调用与条件。 */
  const functions = parsed.statements.filter((node) => ts.isFunctionDeclaration(node) && node.name && names.has(node.name.text))
  expect(functions).toHaveLength(names.size)
  /** CommonJS 导出对象由测试注入，兼容 Bun isolate。 */
  const compiled = ts.transpileModule(functions.map((node) => node.getText(parsed)).join('\n'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText
  /** 这些适配边界不会触碰真实媒体、队列或主进程。 */
  const dependencies = {
    prepareAgentMediaInput: (input: AgentSubmitOrEnqueueInput) => input,
    routeAgentSubmitOrEnqueue,
    orchestrator: { isActive: () => state.active ?? true, isInFlight: () => state.inFlight ?? false, stop: () => undefined },
    prepareAgentRun: (input: AgentSubmitOrEnqueueInput) => input,
    createAgentQueueNowInput: (input: AgentSubmitOrEnqueueInput) => input,
    queuePreparedAgentMessage: async () => undefined,
    workspaceOperationGuard: { runSessionWrite: (_id: string, action: () => void) => action() },
    agentQueueCoordinator: { enqueue: () => undefined, isDispatching: () => state.dispatching ?? false },
    startingAgentSessions: new Map(state.starting ? [['session-1', 100]] : []),
    shouldStopBeforeAgentRun,
    registerWebContents: (sessionId: string, target: Target) => registry.bind(sessionId, target),
    rebindWebContents: (sessionId: string, target: Target) => registry.rebind(sessionId, target),
  }
  /** 接收提取函数的类型安全入口容器。 */
  const exports: Partial<ServiceEntrypoints> = {}
  new Function('exports', ...Object.keys(dependencies), compiled)(exports, ...Object.values(dependencies))
  if (!exports.submitOrEnqueueAgentMessage || !exports.enqueueAgentQueuedMessage || !exports.stopAgent) throw new Error('生产服务入口提取失败')
  return exports as ServiceEntrypoints
}

/** 构造合法的最小提交输入，默认在本轮结束后发送。 */
function message(dispatch: 'now' | 'after_current' = 'after_current'): AgentSubmitOrEnqueueInput {
  return { sessionId: 'session-1', channelId: 'channel-1', queueMessageId: 'queued-1', userMessage: '继续', rawUserMessage: '继续', dispatch }
}

describe('Agent 服务生产入口的回执归属与停止确认', () => {
  test.each(['now', 'after_current', 'legacy'] as const)('Given 已有运行 When 生产 %s 入口追加消息 Then 终态仍到原 owner 且不能清除后续新运行', async (path) => {
    /** 使用真实路由表，两个窗口模拟 reload/重绑。 */
    const registry = new AgentStreamRouteRegistry<Target>()
    /** 启动该轮的旧窗口。 */
    const oldTarget: Target = { id: 1, isDestroyed: () => false }
    /** 追加消息时使用的新窗口。 */
    const newTarget: Target = { id: 2, isDestroyed: () => false }
    /** 原运行持有的 owner。 */
    const route = registry.bind('session-1', oldTarget)
    /** 实际生产入口使用受控外部依赖。 */
    const service = loadProductionFunctions(registry)
    if (path === 'legacy') service.enqueueAgentQueuedMessage(message(), newTarget)
    else await service.submitOrEnqueueAgentMessage(message(path), newTarget)
    expect(registry.getTargetIfOwner('session-1', route.ownerId)).toBe(newTarget)
    /** 队列接力真正创建新一轮时必须取得新的 owner。 */
    const next = registry.bind('session-1', newTarget)
    expect(registry.removeIfOwner('session-1', route.ownerId)).toBe(false)
    expect(registry.getTargetIfOwner('session-1', next.ownerId)).toBe(newTarget)
  })

  test.each([
    [{ inFlight: true }, 'stopping'],
    [{ starting: true }, 'stopping'],
    [{ dispatching: true }, 'stopping'],
    [{}, 'stopped'],
  ] as const)('Given 运行生命周期为 %j When 请求停止 Then 权威回执为 %s', (state, status) => {
    /** 活跃槽已移除也必须核对 inFlight/启动/派发阶段。 */
    const service = loadProductionFunctions(new AgentStreamRouteRegistry<Target>(), state)
    expect(service.stopAgent('session-1')).toEqual({ status })
  })
})
