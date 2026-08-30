import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createWorkspaceOperationGuard } from './workspace-operation-guard'

describe('Agent 工作区迁移准入', () => {
  test('Given 会话权威项目正在迁移 When 发送与重试消息 Then 完成固定拒绝且不进入任何运行副作用', () => {
    /** 记录锁检查、回调与模拟运行副作用的顺序。 */
    const calls: string[] = []
    /** 注入迁移锁状态的守卫实例。 */
    const guard = createWorkspaceOperationGuard({
      getWorkspaceIdBySessionId: () => undefined,
      getWorkspaceIdBySlug: () => undefined,
      getWorkspaceOperationBlockReason: (workspaceId) => {
        calls.push(`lock:${workspaceId}`)
        return workspaceId === 'workspace-authoritative' ? '项目正在迁移，请等待完成后重试' : undefined
      },
    })
    /** 通过生产准入执行器提交完整后续副作用 closure。 */
    const result = guard.runAdmittedAgentRun({
      sessionWorkspaceId: 'workspace-authoritative',
      requestedWorkspaceId: 'workspace-renderer-other',
      onError: (error) => calls.push(`error:${error}`),
      onComplete: () => calls.push('complete'),
    }, () => {
      calls.push('active')
      calls.push('remove-retry-error')
      calls.push('persist-user-message')
      calls.push('adapter')
      return 'started'
    })

    expect(result).toBeUndefined()
    expect(calls).toEqual([
      'lock:workspace-authoritative',
      'error:项目正在迁移，请等待完成后重试',
      'complete',
    ])
  })

  test('Given 会话未记录项目 When 请求项目未锁定 When 准入 Then 使用请求项目且正常放行', () => {
    /** 记录实际被查询的工作区 ID。 */
    const checkedWorkspaceIds: string[] = []
    /** 无锁守卫实例。 */
    const guard = createWorkspaceOperationGuard({
      getWorkspaceIdBySessionId: () => undefined,
      getWorkspaceIdBySlug: () => undefined,
      getWorkspaceOperationBlockReason: (workspaceId) => {
        checkedWorkspaceIds.push(workspaceId)
        return undefined
      },
    })

    expect(guard.admitAgentRun({
      sessionWorkspaceId: undefined,
      requestedWorkspaceId: 'workspace-requested',
      onError: () => undefined,
      onComplete: () => undefined,
    })).toEqual({ admitted: true, workspaceId: 'workspace-requested' })
    expect(checkedWorkspaceIds).toEqual(['workspace-requested'])
  })
})

describe('Agent sendMessage 准入顺序合同', () => {
  test('Given Canvas 工具使用扩展 allowlist When 普通 Agent 检查权限 Then 不替换原有工具策略', () => {
    const source = readFileSync(join(import.meta.dir, 'agent-orchestrator.ts'), 'utf8')
    expect(source).toContain("extensions.allowedToolNamesMode === 'extend'")
    expect(source).toContain('denyToolOutsideRunAllowlist(toolName, extensions.allowedToolNames)')
  })

  test('Given 已解析 Canvas 引用 When 持久化普通发送和 queue-now Then JSONL 写真实快照且原始文本不改写', () => {
    const source = readFileSync(join(import.meta.dir, 'agent-orchestrator.ts'), 'utf8')
    const persistStart = source.indexOf('  private persistUserMessage(')
    const persistEnd = source.indexOf('\n  }', persistStart) + 4
    const persistBody = source.slice(persistStart, persistEnd)
    const queueStart = source.indexOf('  async queueMessage(')
    const queueEnd = source.indexOf('\n  }\n}', queueStart)
    const queueBody = source.slice(queueStart, queueEnd)

    expect(persistBody).toContain('canvasNodeReferences?: CanvasNodeReference[]')
    expect(persistBody).toContain("...(canvasNodeReferences?.length ? { _canvasNodeReferences: canvasNodeReferences } : {})")
    expect(queueBody).toContain('canvasNodeReferences?: CanvasNodeReference[]')
    expect(queueBody).toContain("...(canvasNodeReferences?.length ? { _canvasNodeReferences: canvasNodeReferences } : {})")
    expect(queueBody).toContain("text: rawText ?? text")
  })

  test('Given 单次运行注入可信生图路由 When 构建 Pi 工具 Then 仅经运行扩展传入内置工具上下文', () => {
    const source = readFileSync(join(import.meta.dir, 'agent-orchestrator.ts'), 'utf8')
    const sendStart = source.indexOf('  async sendMessage(')
    const sendEnd = source.indexOf('\n  /**\n   * 中止指定会话', sendStart)
    const body = source.slice(sendStart, sendEnd)

    expect(body).toContain('extensions: AgentRunExtensions = {}')
    expect(body).toContain('trustedImageRoute: extensions.trustedImageRoute')
    expect(body).toContain('resolveTrustedImageRoute: extensions.resolveTrustedImageRoute')
    expect(body).toContain('captureDesignImageCall: extensions.captureDesignImageCall')
    expect(body).toContain('createRunToolCallLimiter(extensions.toolCallLimits)')
    expect(body).toContain('consumeRunToolCallLimit(toolName)')
    expect(body).toContain('extensions.beforeToolCall?.(toolName, input)')
    expect(body).toContain('extensions.systemPromptAppend')
    expect(body).toContain('systemPromptAppend')
    expect(body.indexOf('extensions.beforeToolCall?.(toolName, input)'))
      .toBeGreaterThan(body.indexOf('consumeRunToolCallLimit(toolName)'))
  })

  test('Given sendMessage 实现 When 检查迁移拒绝分支 Then 它早于 active、retry 删除、消息落盘和首次 await', () => {
    /** 读取实际 orchestrator 源码以约束不可注入的副作用顺序。 */
    const source = readFileSync(join(import.meta.dir, 'agent-orchestrator.ts'), 'utf8')
    /** 仅截取 sendMessage 函数体，避免其它方法同名 token 干扰。 */
    const sendStart = source.indexOf('  async sendMessage(')
    const sendEnd = source.indexOf('\n  /**\n   * 中止指定会话', sendStart)
    const body = source.slice(sendStart, sendEnd)
    /** 去除注释，避免文字中的 await 或副作用名称干扰顺序判断。 */
    const executableBody = body
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '')
    /** 迁移准入调用位置。 */
    const admissionIndex = executableBody.indexOf('workspaceOperationGuard.runAdmittedAgentRun(')
    /** 同步 active 槽注册位置。 */
    const activeIndex = executableBody.indexOf('this.activeSessions.set(sessionId, runGeneration)')
    /** 重试错误删除副作用位置。 */
    const retryDeleteIndex = executableBody.indexOf('removeSDKErrorMessage(sessionId, retryOfErrorUuid)')
    /** 用户消息持久化副作用位置。 */
    const persistIndex = executableBody.indexOf('persistInitialUserMessage()')
    /** sendMessage 函数体内当前最早的实际异步让出位置。 */
    const firstAwaitIndex = executableBody.indexOf('await ')

    expect(admissionIndex).toBeGreaterThan(-1)
    expect(activeIndex).toBeGreaterThan(admissionIndex)
    expect(retryDeleteIndex).toBeGreaterThan(activeIndex)
    expect(persistIndex).toBeGreaterThan(activeIndex)
    expect(firstAwaitIndex).toBeGreaterThan(activeIndex)
  })

  test('Given MCP preflight 支持降级 When 检查 generation checkpoint Then checkpoint 位于降级 catch 之后且 adapter 之前', () => {
    /** 读取真实 orchestrator 源码约束停止信号不会被 MCP 降级 catch 吞掉。 */
    const source = readFileSync(join(import.meta.dir, 'agent-orchestrator.ts'), 'utf8')
    /** MCP preflight 局部区域。 */
    const sendMessageStart = source.indexOf('  async sendMessage(')
    const start = source.indexOf('if (Object.keys(mcpServers).length > 0)', sendMessageStart)
    const end = source.indexOf('// 11. 构建动态上下文', start)
    const body = source.slice(start, end)
    /** MCP 调用、catch 和 catch 后 checkpoint 的位置。 */
    const callIndex = body.indexOf('await buildPiMcpTools(mcpServers)')
    const catchIndex = body.indexOf('} catch (error)')
    const checkpointIndex = body.lastIndexOf('checkpoint()')

    expect(callIndex).toBeGreaterThan(-1)
    expect(catchIndex).toBeGreaterThan(callIndex)
    expect(checkpointIndex).toBeGreaterThan(catchIndex)
  })

  test('Given 旧 generation 停止且新 generation 已占槽 When 检查 adapter 启动边界 Then checkpoint 位于业务 catch 外', () => {
    /** 读取真实编排源码，避免停止 sentinel 被 query 的普通错误处理吞掉。 */
    const source = readFileSync(join(import.meta.dir, 'agent-orchestrator.ts'), 'utf8')
    /** 截取 adapter 重试循环到异步迭代器创建的结构。 */
    const loopStart = source.indexOf('for (let attempt = 1; attempt <= MAX_QUERY_ATTEMPTS; attempt++)')
    const adapterStart = source.indexOf('const queryIterable = this.adapter.query(queryOptions, queryToken)', loopStart)
    const attemptPrefix = source.slice(loopStart, adapterStart)
    /** 每次 attempt 的业务异常捕获边界。 */
    const businessTryIndex = attemptPrefix.lastIndexOf('try {')
    /** adapter 启动前的 generation 检查点。 */
    const checkpointIndex = attemptPrefix.lastIndexOf('checkpoint()')

    expect(loopStart).toBeGreaterThan(-1)
    expect(adapterStart).toBeGreaterThan(loopStart)
    expect(checkpointIndex).toBeGreaterThan(-1)
    expect(checkpointIndex).toBeLessThan(businessTryIndex)
  })

  test('Given generation1 已停止且 generation2 已占槽 When 旧 adapter 完成或拒绝 Then 仅按 generation 所有权处理', () => {
    /** 读取真实编排源码，精确约束 adapter 终态的两个 ABA 判断。 */
    const source = readFileSync(join(import.meta.dir, 'agent-orchestrator.ts'), 'utf8')
    /** 截取 Plan suggestion 条件。 */
    const planStart = source.indexOf('// Plan 模式：Agent 完成规划后注入')
    const planEnd = source.indexOf('// 发送完成信号', planStart)
    const planBlock = source.slice(planStart, planEnd)
    /** 截取 adapter reject 后的首个停止分支。 */
    const catchStart = source.indexOf('} catch (error) {', planEnd)
    const catchEnd = source.indexOf('const rawErrorMessage = errorMessageOf(error)', catchStart)
    const catchBlock = source.slice(catchStart, catchEnd)

    expect(planBlock).toContain('this.activeSessions.get(sessionId) === runGeneration')
    expect(planBlock).not.toContain('this.activeSessions.has(sessionId)')
    expect(catchBlock).toContain('this.activeSessions.get(sessionId) !== runGeneration')
    expect(catchBlock).not.toContain('this.activeSessions.has(sessionId)')

    /** 模拟 generation1 stop 后同 session 已被 generation2 占用的 ABA 状态。 */
    const activeGenerations = new Map([['session-1', 2]])
    /** 当前正在收尾的旧运行代际。 */
    const oldRunGeneration = 1
    expect(activeGenerations.get('session-1') === oldRunGeneration).toBe(false)
    expect(activeGenerations.get('session-1') !== oldRunGeneration).toBe(true)
  })

  test('Given generation1 stop 后 generation2 已创建审批 When 旧 finally 执行 Then 不清理 generation2 pending', () => {
    /** 读取真实编排源码，约束 stop 与旧 run finally 的 session pending 所有权。 */
    const source = readFileSync(join(import.meta.dir, 'agent-orchestrator.ts'), 'utf8')
    /** 截取 sendMessage 最外层 finally。 */
    const finallyStart = source.indexOf('} finally {', source.indexOf('const recoveryFailure'))
    const finallyEnd = source.indexOf('\n    })', finallyStart)
    const finallyBlock = source.slice(finallyStart, finallyEnd)
    /** 截取 stop 方法。 */
    const stopStart = source.indexOf('  stop(sessionId: string, stopBeforeRun = false): void {')
    const stopEnd = source.indexOf('\n  /** 检查指定会话是否正在处理中 */', stopStart)
    const stopBlock = source.slice(stopStart, stopEnd)

    expect(finallyBlock).toContain('activeGenerationAtCleanup')
    expect(finallyBlock).toContain('activeGenerationAtCleanup === undefined || activeGenerationAtCleanup === runGeneration')
    expect(finallyBlock).toContain('if (canClearRunPending) {')
    expect(stopBlock).toContain('permissionService.clearSessionPending(sessionId)')
    expect(stopBlock).toContain('exitPlanService.clearSessionPending(sessionId)')
    expect(stopBlock.indexOf('permissionService.clearSessionPending(sessionId)'))
      .toBeLessThan(stopBlock.indexOf('this.adapter.abort(sessionId)'))
    expect(stopBlock.indexOf('exitPlanService.clearSessionPending(sessionId)'))
      .toBeLessThan(stopBlock.indexOf('this.adapter.abort(sessionId)'))

    /** 模拟旧 finally 看到 generation2、空槽和仍持有 generation1 的三种状态。 */
    const canClearPending = (activeGeneration: number | undefined, runGeneration: number): boolean => (
      activeGeneration === undefined || activeGeneration === runGeneration
    )
    expect(canClearPending(2, 1)).toBe(false)
    expect(canClearPending(undefined, 1)).toBe(true)
    expect(canClearPending(1, 1)).toBe(true)
  })

  test('Given 多代际停止与迟到收尾 When 检查生产接入 Then 独立消费 marker 且仅 latest generation 写 meta', () => {
    /** 读取真实编排源码，约束 generation 状态不退化为 session 单值或 active 判定。 */
    const source = readFileSync(join(import.meta.dir, 'agent-orchestrator.ts'), 'utf8')
    /** sendMessage 函数体。 */
    const sendStart = source.indexOf('  async sendMessage(')
    const sendEnd = source.indexOf('\n  /**\n   * 中止指定会话', sendStart)
    const sendBody = source.slice(sendStart, sendEnd)
    /** stopAll 函数体。 */
    const stopAllStart = source.indexOf('  stopAll(): void {')
    const stopAllEnd = source.indexOf('\n  // ===== 队列消息管理 =====', stopAllStart)
    const stopAllBody = source.slice(stopAllStart, stopAllEnd)

    expect(source).toContain('private stoppedBySessions = new Map<string, Set<number>>()')
    expect(source).toContain('private latestRunGenerations = new Map<string, number>()')
    expect(sendBody).toContain('this.latestRunGenerations.set(sessionId, runGeneration)')
    expect(sendBody.match(/isLatestRunGeneration\(this\.latestRunGenerations, sessionId, runGeneration\)/g)?.length ?? 0)
      .toBeGreaterThanOrEqual(2)
    expect(source).toContain('markStoppedGeneration(this.stoppedBySessions, sessionId, runGeneration)')
    expect(source).toContain('consumeStoppedGeneration(this.stoppedBySessions, sessionId, runGeneration)')
    expect(stopAllBody).toContain('this.stoppedBySessions.clear()')
    expect(stopAllBody).toContain('this.latestRunGenerations.clear()')
  })

  test('Given 异步 preflight 在 stop 后 reject When 检查 lifecycle 接入 Then 按 generation marker 判断 stopped', () => {
    /** 读取真实编排源码，防止用 active 缺失冒充用户停止。 */
    const source = readFileSync(join(import.meta.dir, 'agent-orchestrator.ts'), 'utf8')
    /** 截取 lifecycle 依赖对象。 */
    const lifecycleStart = source.indexOf('await runAgentLifecycle({')
    const lifecycleEnd = source.indexOf('}, async (checkpoint) => {', lifecycleStart)
    const lifecycleDependencies = source.slice(lifecycleStart, lifecycleEnd)

    expect(source).toContain('hasStoppedGeneration')
    expect(lifecycleDependencies).toContain(
      'isStopped: () => hasStoppedGeneration(this.stoppedBySessions, sessionId, runGeneration)',
    )
    expect(lifecycleDependencies).not.toContain('isStopped: () => !')
  })

  test('Given 外部 terminal callback 可能抛错 When 检查 sendMessage Then 终端通知全部走 safe notifier 且启动回调直传', () => {
    /** 读取真实编排源码，防止 terminal callback 异常重新进入业务 catch。 */
    const source = readFileSync(join(import.meta.dir, 'agent-orchestrator.ts'), 'utf8')
    /** 仅截取 sendMessage 函数体。 */
    const sendStart = source.indexOf('  async sendMessage(')
    const sendEnd = source.indexOf('\n  /**\n   * 中止指定会话', sendStart)
    const sendBody = source.slice(sendStart, sendEnd)

    expect(sendBody).toContain('createAgentRunTerminalNotifier')
    expect(sendBody).toContain('onError: terminalNotifier.onError')
    expect(sendBody).toContain('onComplete: completeBeforeRun')
    expect(sendBody).not.toMatch(/callbacks\.on(?:Error|Complete)\(/)
    expect(sendBody).toContain('callbacks.onRunStarted?.({ startedAt: streamStartedAt })')
  })

  test('Given stop 后旧 adapter 尚未退出 When 检查生产接入 Then 独立跟踪 in-flight 并阻止旧代际副作用', () => {
    /** 读取真实编排源码，约束迁移准入与前台 active 状态分离。 */
    const source = readFileSync(join(import.meta.dir, 'agent-orchestrator.ts'), 'utf8')
    /** sendMessage 函数体。 */
    const sendStart = source.indexOf('  async sendMessage(')
    const sendEnd = source.indexOf('\n  /**\n   * 中止指定会话', sendStart)
    const sendBody = source.slice(sendStart, sendEnd)
    /** stop 函数体。 */
    const stopStart = source.indexOf('  stop(sessionId: string, stopBeforeRun = false): void {')
    const stopEnd = source.indexOf('\n  /** 检查指定会话是否正在处理中 */', stopStart)
    const stopBody = source.slice(stopStart, stopEnd)

    expect(source).toContain('private inFlightRunGenerations = new Map<string, Set<number>>()')
    expect(sendBody).toContain('markInFlightGeneration(this.inFlightRunGenerations, sessionId, runGeneration)')
    expect(sendBody).toContain('releaseInFlightGeneration(')
    expect(sendBody).toContain('if (!isLatestRunGeneration(this.latestRunGenerations, sessionId, runGeneration))')
    expect(stopBody).not.toContain('this.inFlightRunGenerations.delete(sessionId)')
    expect(source).toContain('return hasInFlightGeneration(this.inFlightRunGenerations, sessionId)')
  })

  test('Given 工具审批等待期间启动新代际 When 旧审批返回 Then 再次校验 latest 并拒绝迟到工具', () => {
    /** 读取真实编排源码，约束异步审批返回后的第二道代际检查。 */
    const source = readFileSync(join(import.meta.dir, 'agent-orchestrator.ts'), 'utf8')
    /** 截取 canUseTool 权限函数。 */
    const start = source.indexOf('const canUseTool = async')
    const end = source.indexOf('// 13. 构建 Adapter 查询选项', start)
    const body = source.slice(start, end)
    /** stale tool 检查在初始入口与三个异步审批返回后都应执行。 */
    const staleChecks = body.match(/denyStaleToolRun\(\)/g)?.length ?? 0

    expect(body).toContain('await handleExitPlanMode(')
    expect(body).toContain('await askUserService.handleAskUserQuestion(')
    expect(body).toContain('await permissionService.requestSingleApproval(')
    expect(staleChecks).toBeGreaterThanOrEqual(4)
  })

  test('Given bypass Canvas 运行工具 When 进入权限边界 Then 守卫后逐次审批且普通 Canvas 工具不审批', () => {
    const source = readFileSync(join(import.meta.dir, 'agent-orchestrator.ts'), 'utf8')
    const start = source.indexOf('const canUseTool = async')
    const end = source.indexOf('// 13. 构建 Adapter 查询选项', start)
    const body = source.slice(start, end)
    const guardIndex = body.indexOf('extensions.beforeToolCall?.(toolName, input)')
    const approvalIndex = body.indexOf('extensions.singleApprovalToolNames?.includes(toolName)')
    const bypassIndex = body.indexOf("case 'bypassPermissions':")

    expect(approvalIndex).toBeGreaterThan(guardIndex)
    expect(approvalIndex).toBeLessThan(bypassIndex)
    expect(body.slice(approvalIndex, bypassIndex)).toContain('await permissionService.requestSingleApproval(')
    expect(body.slice(approvalIndex, bypassIndex)).toContain('return denyStaleToolRun() ?? result')
    expect(body.slice(approvalIndex, bypassIndex)).toContain("currentMode === 'plan'")
  })

  test('Given 单次审批等待期间权限模式变化 When 审批返回 Then 三条路径统一先查 stale 再 fresh-read mode', () => {
    /** 读取真实 canUseTool，约束所有单次审批工具共享同一安全收口。 */
    const source = readFileSync(join(import.meta.dir, 'agent-orchestrator.ts'), 'utf8')
    /** 截取 canUseTool 权限函数，避免其它模块调用干扰计数。 */
    const start = source.indexOf('const canUseTool = async')
    const end = source.indexOf('// 13. 构建 Adapter 查询选项', start)
    const body = source.slice(start, end)
    /** Canvas、BrowserUpload 与规划删除都必须调用通用收口一次。 */
    const revalidationCalls = body.match(/revalidateSingleApprovalResult\(/g)?.length ?? 0

    expect(revalidationCalls).toBe(3)
    expect(body).not.toContain('return permissionService.requestSingleApproval(sessionId, toolName, input, options')
  })

  test('Given 会话或同项目会话仍在 draining When 请求 rewind Then 以 in-flight 状态保持阻断', () => {
    /** 读取真实编排源码，约束 rewind 不把 stop 后的 draining 误判为空闲。 */
    const source = readFileSync(join(import.meta.dir, 'agent-orchestrator.ts'), 'utf8')
    /** rewind 与同项目冲突检查之间的源码。 */
    const start = source.indexOf('  private hasOtherActiveSessionForLocalProjectRoot(')
    const end = source.indexOf('  /** 中止所有活跃的 Agent 会话', start)
    const body = source.slice(start, end)

    expect(body).toContain('for (const activeSessionId of this.inFlightRunGenerations.keys())')
    expect(body).toContain('if (this.isInFlight(sessionId))')
  })

  test('Given generation1 自动标题请求迟到 When generation2 已启动 Then 不更新标题或发送标题事件', () => {
    /** 读取真实编排源码，约束独立标题请求也遵守代际所有权。 */
    const source = readFileSync(join(import.meta.dir, 'agent-orchestrator.ts'), 'utf8')
    /** 自动标题方法与 sendMessage 内调用点。 */
    const methodStart = source.indexOf('  private async autoGenerateTitle(')
    const methodEnd = source.indexOf('\n  /**\n   * Session-not-found', methodStart)
    const methodBody = source.slice(methodStart, methodEnd)
    const sendStart = source.indexOf('  async sendMessage(')
    const sendEnd = source.indexOf('\n  /**\n   * 中止指定会话', sendStart)
    const sendBody = source.slice(sendStart, sendEnd)

    expect(sendBody).toContain('isLatestRunGeneration(this.latestRunGenerations, sessionId, runGeneration),')
    expect(methodBody.match(/if \(!isCurrent\(\)\) return/g)?.length ?? 0).toBeGreaterThanOrEqual(2)
  })

  test('Given Agent 使用自定义兼容渠道 When 生成自动标题 Then 复用 Pi 模型路由且失败统一本地兜底', () => {
    /** 读取真实编排源码，防止标题请求退回与 Agent 不一致的 Chat Provider Adapter。 */
    const source = readFileSync(join(import.meta.dir, 'agent-orchestrator.ts'), 'utf8')
    /** 截取公开标题生成方法，避免其它消息请求路径影响断言。 */
    const methodStart = source.indexOf('  async generateTitle(')
    const methodEnd = source.indexOf('\n  /**\n   * 流完成后自动生成标题', methodStart)
    const methodBody = source.slice(methodStart, methodEnd)

    expect(methodBody).toContain('generatePiTitle({')
    expect(methodBody).not.toContain('getAdapter(')
    expect(methodBody).not.toContain('fetchTitle(')
    expect(methodBody).toContain('return fallbackTitle')
  })

  test('Given 标题请求与 iterator cleanup 仍未完成 When 检查生产接入 Then generation 引用与 cleanup await 覆盖全部退出分支', () => {
    /** 读取真实编排源码，约束后台标题与 adapter cleanup 都属于 generation 生命周期。 */
    const source = readFileSync(join(import.meta.dir, 'agent-orchestrator.ts'), 'utf8')
    /** sendMessage 函数体。 */
    const sendStart = source.indexOf('  async sendMessage(')
    const sendEnd = source.indexOf('\n  /**\n   * 中止指定会话', sendStart)
    const sendBody = source.slice(sendStart, sendEnd)

    expect(source).toContain('private retainedGenerationTasks = new Map<string, Set<number>>()')
    expect(sendBody).toContain('retainGenerationTask(this.retainedGenerationTasks, sessionId, runGeneration)')
    expect(sendBody).toContain('.finally(() => {')
    expect(sendBody).toContain('releaseGenerationTask(')
    expect(sendBody.match(/await closeAgentQueryIterator\(/g)?.length ?? 0).toBe(2)
    expect(sendBody).toContain('await this.adapter.forceCloseQuery(queryToken)')
  })

  test('Given 标题仍可能写入数据根 When 检查迁移查询 Then 数据写活跃与 UI 运行态保持独立', () => {
    /** 读取真实编排源码，约束迁移查询覆盖前台运行和 retained 标题任务。 */
    const source = readFileSync(join(import.meta.dir, 'agent-orchestrator.ts'), 'utf8')
    /** UI 活跃查询函数体。 */
    const activeStart = source.indexOf('  hasActiveSessions(): boolean {')
    const activeEnd = source.indexOf('\n  /**', activeStart + 1)
    const activeBody = source.slice(activeStart, activeEnd)
    /** 数据写活跃查询函数体。 */
    const writesStart = source.indexOf('  hasGenerationOwnedWrites(): boolean {')
    const writesEnd = source.indexOf('\n  /**', writesStart + 1)
    const writesBody = source.slice(writesStart, writesEnd)
    /** 按工作区查询函数体。 */
    const workspaceStart = source.indexOf('  hasGenerationOwnedWritesForWorkspace(workspaceId: string): boolean {')
    const workspaceEnd = source.indexOf('\n  /**', workspaceStart + 1)
    const workspaceBody = source.slice(workspaceStart, workspaceEnd)

    expect(activeBody).toContain('this.inFlightRunGenerations.size > 0')
    expect(activeBody).not.toContain('retainedGenerationTasks')
    expect(writesBody).toContain('hasGenerationOwnedWrites(')
    expect(workspaceBody).toContain('this.retainedGenerationTasks.keys()')
    expect(workspaceBody).toContain('getAgentSessionMeta(sessionId)?.workspaceId === workspaceId')
  })

  test('Given adapter 强制关闭合同 When 检查两种 Pi runtime Then 都提供可等待且并发复用的关闭 Promise', () => {
    /** 共享 provider 合同。 */
    const providerSource = readFileSync(join(import.meta.dir, '../../../../../packages/shared/src/types/agent-provider.ts'), 'utf8')
    /** in-process Pi adapter 实现。 */
    const inProcessSource = readFileSync(join(import.meta.dir, 'adapters/pi-agent-adapter.ts'), 'utf8')
    /** utility Pi adapter 实现。 */
    const utilitySource = readFileSync(join(import.meta.dir, 'adapters/pi-utility-adapter.ts'), 'utf8')

    expect(providerSource).toContain('query(input: AgentQueryInput, queryToken: string): AsyncIterable<SDKMessage>')
    expect(providerSource).toContain('forceCloseQuery(queryToken: string): Promise<void>')
    expect(inProcessSource).toContain('active.forceClosePromise ??=')
    expect(inProcessSource).toContain('await active.closed')
    expect(utilitySource).toContain('if (pending.forceClosePromise) return pending.forceClosePromise')
    expect(utilitySource).toContain('pending.queue.end()')
    expect(utilitySource).toContain('runtimeStopPromise?: Promise<void>')
    expect(utilitySource).toContain('await this.stopRuntime(pending)')
  })
})
