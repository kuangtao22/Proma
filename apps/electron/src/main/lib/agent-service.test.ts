import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createWorkspaceOperationGuard } from './workspace-operation-guard'

describe('Agent service 迁移准入', () => {
  test('Given 普通发送、queue-now 与 deferred 启动 When 检查主进程接线 Then 仅在实际发送边界解析引用', () => {
    const source = readFileSync(join(import.meta.dir, 'agent-service.ts'), 'utf8')
    const runStart = source.indexOf('export async function runAgent(')
    const runEnd = source.indexOf('\n/**', runStart + 1)
    const runBody = source.slice(runStart, runEnd)
    const queueStart = source.indexOf('export async function queueAgentMessage(')
    const queueEnd = source.indexOf('\n/**', queueStart + 1)
    const queueBody = source.slice(queueStart, queueEnd)
    const enqueueStart = source.indexOf('export function enqueueAgentQueuedMessage(')
    const enqueueEnd = source.indexOf('\n}', enqueueStart) + 2
    const enqueueBody = source.slice(enqueueStart, enqueueEnd)

    expect(runBody).toContain('prepareAgentRun(input, extensions)')
    expect(runBody).toContain('runPreparedAgent(prepared, webContents)')
    expect(queueBody).toContain('prepareAgentRun(input)')
    expect(queueBody).toContain('queuePreparedAgentMessage(resolved)')
    expect(enqueueBody).not.toContain('prepareAgentRun(')
  })

  test('Given 普通无引用消息 When 检查解析 helper Then 完全绕过 resolver 且不追加 prompt', () => {
    const source = readFileSync(join(import.meta.dir, 'agent-canvas-message-preparation.ts'), 'utf8')
    const helperStart = source.indexOf('export function prepareAgentCanvasMessageForSend')
    const helperEnd = source.indexOf('\n\n/**', helperStart)
    const helperBody = source.slice(helperStart, helperEnd)

    expect(helperBody).toContain('if (!input.canvasNodeReferences?.length)')
    expect(helperBody).toContain("return { input, extensions, references: undefined }")
    expect(helperBody.indexOf('if (!input.canvasNodeReferences?.length)'))
      .toBeLessThan(helperBody.indexOf('resolver.resolveForSend('))
  })

  test('Given 显式引用模式或普通新发送 When 解析 Canvas 引用 Then 只按 mode 选择 exact 或 latest', () => {
    const source = readFileSync(join(import.meta.dir, 'agent-canvas-message-preparation.ts'), 'utf8')
    const helperStart = source.indexOf('export function prepareAgentCanvasMessageForSend')
    const helperEnd = source.indexOf('\n\n/**', helperStart)
    const helperBody = source.slice(helperStart, helperEnd)

    expect(helperBody).toContain("mode: 'canvasNodeReferenceMode' in input")
    expect(helperBody).toContain("input.canvasNodeReferenceMode ?? 'latest'")
    expect(helperBody).not.toContain('retryOfErrorUuid')
  })

  test('Given Canvas 专用运行 When 检查 service 入口 Then 复用 renderer runtime 并接受单次工具扩展', () => {
    const source = readFileSync(join(import.meta.dir, 'agent-service.ts'), 'utf8')
    const start = source.indexOf('export async function runAgent(')
    const end = source.indexOf('\n/**', start + 1)
    const body = source.slice(start, end)

    expect(body).toContain('extensions: AgentRunExtensions = {}')
    expect(body).toContain('prepareAgentRun(input, extensions)')
    expect(body).toContain('runPreparedAgent(prepared, webContents)')
  })

  test('Given 数据根迁移预检 When 检查 service 导出 Then 使用 generation-owned 写查询并提供 workspace 维度能力', () => {
    /** 读取 service 源码约束迁移查询不退化为 UI 活跃状态。 */
    const source = readFileSync(join(import.meta.dir, 'agent-service.ts'), 'utf8')
    /** 读取 IPC 源码约束数据根迁移生产接线使用数据写查询。 */
    const ipcSource = readFileSync(join(import.meta.dir, '../ipc.ts'), 'utf8')

    expect(source).toContain('export function hasActiveAgentDataWrites(): boolean {')
    expect(source).toContain('return orchestrator.hasGenerationOwnedWrites()')
    expect(source).toContain('export function hasActiveAgentDataWritesForWorkspace(workspaceId: string): boolean {')
    expect(source).toContain('return orchestrator.hasGenerationOwnedWritesForWorkspace(workspaceId)')
    expect(ipcSource).toContain('hasActiveAgentDataWrites')
    expect(ipcSource).toContain('hasActiveTasks: () => hasActiveAgentDataWrites() || hasRunningAutomations()')
  })

  test('Given 会话权威工作区正在迁移 When 准备 service 运行副作用 Then 抛固定原因且不执行副作用', () => {
    /** 记录 service 在准入后才允许执行的副作用。 */
    const effects: string[] = []
    /** 锁定会话权威工作区的守卫。 */
    const guard = createWorkspaceOperationGuard({
      getWorkspaceIdBySessionId: () => undefined,
      getWorkspaceIdBySlug: () => undefined,
      getWorkspaceOperationBlockReason: (workspaceId) => (
        workspaceId === 'workspace-authoritative' ? '项目正在迁移，请等待完成后重试' : undefined
      ),
    })

    expect(() => guard.runAgentServiceEffects({
      sessionWorkspaceId: 'workspace-authoritative',
      requestedWorkspaceId: 'workspace-renderer-other',
    }, () => {
      effects.push('register-web-contents')
      effects.push('update-completed-meta')
      effects.push('graduate-automation')
      effects.push('emit')
    })).toThrow('项目正在迁移，请等待完成后重试')

    expect(effects).toEqual([])
  })

  test('Given 未锁定工作区 When 准备 service 运行副作用 Then 保持原行为执行一次', () => {
    /** 记录未锁定流程的副作用。 */
    const effects: string[] = []
    /** 无锁守卫。 */
    const guard = createWorkspaceOperationGuard({
      getWorkspaceIdBySessionId: () => undefined,
      getWorkspaceIdBySlug: () => undefined,
      getWorkspaceOperationBlockReason: () => undefined,
    })

    expect(() => guard.runAgentServiceEffects({
      sessionWorkspaceId: 'workspace-free',
      requestedWorkspaceId: 'workspace-free',
    }, () => { effects.push('effects') })).not.toThrow()
    expect(effects).toEqual(['effects'])
  })

  test('Given runAgent 实现 When 检查 service 副作用 Then 全部位于生产 guard closure 内', () => {
    /** 读取真实 agent-service 源码约束实际接入。 */
    const source = readFileSync(join(import.meta.dir, 'agent-service.ts'), 'utf8')
    /** 截取 renderer runAgent 入口。 */
    const start = source.indexOf('async function runPreparedAgent(')
    const end = source.indexOf('\n/**', start + 1)
    const body = source.slice(start, end)
    /** 生产 guard closure 起始位置。 */
    const guardIndex = body.indexOf('workspaceOperationGuard.runAgentServiceEffects(')
    /** 真正准入后的运行开始回调位置。 */
    const onRunStartedIndex = body.indexOf('onRunStarted:')

    expect(guardIndex).toBeGreaterThan(-1)
    expect(guardIndex).toBeGreaterThan(onRunStartedIndex)
    for (const sideEffect of ['registerWebContents(', 'updateAgentSessionMeta(', 'eventBus.emit(']) {
      /** 当前 service 副作用的位置。 */
      const effectIndex = body.indexOf(sideEffect)
      expect(effectIndex).toBeGreaterThan(guardIndex)
    }
  })

  test('Given headless 与 queued 入口 When 检查源码 Then headless 延后注册且 queued 在注册和入队前守卫', () => {
    /** 读取真实 agent-service 源码审计其它 Agent 入口。 */
    const source = readFileSync(join(import.meta.dir, 'agent-service.ts'), 'utf8')
    /** 截取 headless 新运行入口。 */
    const headlessStart = source.indexOf('export async function runAgentHeadless(')
    const headlessEnd = source.indexOf('\n/**', headlessStart + 1)
    const headlessBody = source.slice(headlessStart, headlessEnd)
    /** 截取队列写入口。 */
    const queueStart = source.indexOf('export function enqueueAgentQueuedMessage(')
    const queueEnd = source.indexOf('\n}', queueStart) + 2
    const queueBody = source.slice(queueStart, queueEnd)

    expect(headlessBody.indexOf('registerWebContents(')).toBeGreaterThan(headlessBody.indexOf('onRunStarted:'))
    expect(queueBody.indexOf('workspaceOperationGuard.runSessionWrite(')).toBeGreaterThan(-1)
    expect(queueBody.indexOf('registerWebContents(')).toBeGreaterThan(queueBody.indexOf('workspaceOperationGuard.runSessionWrite('))
    expect(queueBody.indexOf('agentQueueCoordinator.enqueue(')).toBeGreaterThan(queueBody.indexOf('workspaceOperationGuard.runSessionWrite('))
  })

  test('Given service 正常完成或 catch When 检查终态路径 Then renderer 与 headless 都隔离外部通知后推进内部收尾', () => {
    /** 读取真实 agent-service 源码约束四条终态路径。 */
    const source = readFileSync(join(import.meta.dir, 'agent-service.ts'), 'utf8')
    /** 终态 effect 安全边界的生产调用次数。 */
    const boundaryCalls = source.match(/runAgentServiceTerminalEffects\(/g)?.length ?? 0

    expect(source).toContain("from './agent-run-lifecycle'")
    expect(boundaryCalls).toBeGreaterThanOrEqual(4)
    expect(source).toContain("name: 'queue-cleanup'")
    expect(source).toContain("name: 'external-on-complete'")
    expect(source).toContain("name: 'renderer-complete'")
  })

  test('Given Canvas run 在准入早期抛错 When runAgent 发布 completion Then 仍附带主进程权威轻量 metadata', () => {
    /** 读取真实 service，锁定外层 catch 不能发布无归属 completion。 */
    const source = readFileSync(join(import.meta.dir, 'agent-service.ts'), 'utf8')
    /** 只检查 renderer runAgent，避免 headless 合同干扰。 */
    const start = source.indexOf('async function runPreparedAgent(')
    const end = source.indexOf('\n/**', start + 1)
    const body = source.slice(start, end)
    /** 外层 catch 是 Orchestrator 准入或发送早期异常的 completion 生产路径。 */
    const catchStart = body.indexOf("console.error('[Agent 服务] runAgent 未处理异常:'")
    const catchBody = body.slice(catchStart)

    expect(catchStart).toBeGreaterThan(-1)
    expect(catchBody).toContain('sendAuthoritativeAgentStreamComplete(webContents, input, getAgentSessionMeta')
  })

  test('Given renderer run 真正开始 When 发布 run_started Then 统一携带主进程权威轻量 metadata', () => {
    /** 读取真实 service，锁定启动事件不能继续只发送 startedAt。 */
    const source = readFileSync(join(import.meta.dir, 'agent-service.ts'), 'utf8')
    /** 只检查 renderer runAgent 的启动 producer。 */
    const start = source.indexOf('async function runPreparedAgent(')
    const end = source.indexOf('\n/**', start + 1)
    const body = source.slice(start, end)

    expect(body).toContain('buildAuthoritativeAgentRunStartedEvent(input.sessionId, startedAt, getAgentSessionMeta)')
    expect(body).not.toContain("event: { type: 'run_started', startedAt }")
  })

  test('Given renderer 与 headless 的成功或异常完成 When 检查所有 producer Then 统一经权威 session builder', () => {
    /** 读取真实 service，防止任一 completion producer 再手工遗漏 metadata。 */
    const source = readFileSync(join(import.meta.dir, 'agent-service.ts'), 'utf8')
    /** 四条 producer：renderer success/catch 与 headless success/catch。 */
    const authoritativeCalls = source.match(/sendAuthoritativeAgentStreamComplete\(/g)?.length ?? 0

    expect(authoritativeCalls).toBe(4)
    expect(source).not.toContain('sendAgentStreamComplete(')
    expect(source).not.toContain('session: getSessionMetaForRenderer(')
  })

  test('Given renderer 与 headless 的流式错误 When 检查所有 producer Then 统一携带权威安全 metadata', () => {
    const source = readFileSync(join(import.meta.dir, 'agent-service.ts'), 'utf8')
    const builderCalls = source.match(/buildAuthoritativeAgentStreamErrorPayload\(/g)?.length ?? 0

    expect(builderCalls).toBe(4)
    expect(source).not.toMatch(/send\(AGENT_IPC_CHANNELS\.STREAM_ERROR,\s*\{\s*sessionId:/)
  })
})
