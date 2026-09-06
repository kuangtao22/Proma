import { describe, expect, test } from 'bun:test'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type {
  ServerOpsServiceAction,
  ServerOpsServiceActionResult,
  ServerOpsServiceDetailResult,
  ServerOpsServiceListResult,
  ServerOpsServiceSummary,
} from '@proma/shared'
import {
  createServerOpsServicesController,
  ServerOpsServicesPanelView,
} from './ServerOpsServicesPanel'
import type { ServerOpsServicesProjection } from './ServerOpsServicesPanel'

interface Deferred<T> {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (reason: unknown) => void
}

/** 创建可控 Promise，用于验证服务详情与动作的竞态。 */
function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve
    reject = nextReject
  })
  return { promise, resolve, reject }
}

/** 等待控制器完成当前 Promise 链。 */
async function flushPromises(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

/** 创建服务摘要测试数据。 */
function createService(unitId: string, activeState: string, enabled = true): ServerOpsServiceSummary {
  return {
    unitId,
    description: `${unitId} description`,
    loadState: 'loaded',
    activeState,
    subState: activeState === 'active' ? 'running' : activeState,
    enabled,
  }
}

/** 创建服务列表响应。 */
function createListResult(
  hostId = 'host-1',
  services: ServerOpsServiceSummary[] = [createService('nginx.service', 'active')],
): ServerOpsServiceListResult {
  return { hostId, capability: 'available', services, warnings: [] }
}

/** 创建服务详情响应。 */
function createDetailResult(hostId: string, service: ServerOpsServiceSummary): ServerOpsServiceDetailResult {
  return {
    hostId,
    capability: 'available',
    service,
    statusLines: [`${service.unitId} status`],
    recentLogLines: [`${service.unitId} log`],
    warnings: [],
  }
}

/** 创建服务控制器测试环境。 */
function createControllerHarness() {
  /** 列表读取入参。 */
  const listCalls: Array<{ hostId: string }> = []
  /** 详情读取入参。 */
  const detailCalls: Array<{ hostId: string; unitId: string }> = []
  /** 服务动作入参。 */
  const actionCalls: Array<{ sessionId: string; hostId: string; unitId: string; action: ServerOpsServiceAction }> = []
  /** 控制器投影历史。 */
  const projections: ServerOpsServicesProjection[] = []
  /** 用户可见提示历史。 */
  const notices: Array<{ kind: 'success' | 'warning' | 'error'; message: string }> = []
  /** 默认列表读取实现。 */
  let listServices = async (input: { hostId: string }): Promise<ServerOpsServiceListResult> => {
    listCalls.push(input)
    return createListResult(input.hostId)
  }
  /** 默认详情读取实现。 */
  let getDetail = async (input: { hostId: string; unitId: string }): Promise<ServerOpsServiceDetailResult> => {
    detailCalls.push(input)
    return createDetailResult(input.hostId, createService(input.unitId, 'active'))
  }
  /** 默认动作实现。 */
  let runAction = async (input: { sessionId: string; hostId: string; unitId: string; action: ServerOpsServiceAction }): Promise<ServerOpsServiceActionResult> => {
    actionCalls.push(input)
    return { hostId: input.hostId, unitId: input.unitId, action: input.action, warnings: [] }
  }
  const controller = createServerOpsServicesController({
    listServices: (input) => listServices(input),
    getDetail: (input) => getDetail(input),
    runAction: (input) => runAction(input),
    publish: (projection) => { projections.push(projection) },
    notify: (kind, message) => { notices.push({ kind, message }) },
  })
  controller.activate()
  return {
    actionCalls,
    controller,
    detailCalls,
    listCalls,
    notices,
    projections,
    setGetDetail: (implementation: typeof getDetail) => { getDetail = implementation },
    setListServices: (implementation: typeof listServices) => { listServices = implementation },
    setRunAction: (implementation: typeof runAction) => { runAction = implementation },
  }
}

describe('服务器运维 systemd 服务面板', () => {
  test('Given 服务列表 When 搜索并筛选失败 Then 只显示匹配服务', () => {
    const html = renderToStaticMarkup(
      <ServerOpsServicesPanelView
        status="ready"
        connected
        capability="available"
        services={[
          createService('nginx.service', 'active'),
          createService('redis.service', 'failed'),
          createService('redis-exporter.service', 'active'),
        ]}
        query="redis"
        filter="failed"
        selectedUnitId={null}
        detailStatus="idle"
        detail={null}
        error={null}
        detailError={null}
        pendingAction={null}
        executingUnitId={null}
        actionAvailable
        onQueryChange={() => undefined}
        onFilterChange={() => undefined}
        onRefresh={() => undefined}
        onSelectService={() => undefined}
        onRequestAction={() => undefined}
        onCancelAction={() => undefined}
        onConfirmAction={() => undefined}
      />,
    )

    expect(html).toContain('redis.service')
    expect(html).not.toContain('nginx.service')
    expect(html).not.toContain('redis-exporter.service')
    expect(html).toContain('<table')
    expect(html).toContain('aria-label="筛选服务状态"')
    expect(html).toContain('aria-label="查看 redis.service 服务详情"')
    expect(html).not.toContain('<tr tabindex=')
  })

  test('Given 服务详情 When Pane 宽度变化 Then 使用原生容器查询在窄 Pane 堆叠且宽 Pane 双列', async () => {
    const html = renderToStaticMarkup(
      <ServerOpsServicesPanelView
        status="ready"
        connected
        capability="available"
        services={[createService('nginx.service', 'active')]}
        query=""
        filter="all"
        selectedUnitId="nginx.service"
        detailStatus="ready"
        detail={createDetailResult('host-1', createService('nginx.service', 'active'))}
        error={null}
        detailError={null}
        pendingAction={null}
        executingUnitId={null}
        actionAvailable
        onQueryChange={() => undefined}
        onFilterChange={() => undefined}
        onRefresh={() => undefined}
        onSelectService={() => undefined}
        onRequestAction={() => undefined}
        onCancelAction={() => undefined}
        onConfirmAction={() => undefined}
      />,
    )

    /** 运维工作区的真实容器查询样式。 */
    const styles = await Bun.file(new URL('../../styles/globals.css', import.meta.url)).text()
    expect(html).toContain('data-server-ops-service-detail-grid="true"')
    expect(html).not.toContain('lg:grid-cols-2')
    expect(styles).toContain('@container (min-width: 700px)')
    expect(styles).toContain('[data-server-ops-service-detail-grid]')
  })

  test('Given 用户点击重启 When 尚未确认 Then 不调用 IPC', async () => {
    const harness = createControllerHarness()
    await harness.controller.select({ sessionId: 'session-1', hostId: 'host-1', active: true, connected: true })
    await harness.controller.selectService('nginx.service')

    harness.controller.requestAction('nginx.service', 'restart')

    expect(harness.actionCalls).toEqual([])
    expect(harness.projections.at(-1)?.pendingAction).toEqual({ unitId: 'nginx.service', action: 'restart' })
    const html = renderToStaticMarkup(
      <ServerOpsServicesPanelView
        {...harness.projections.at(-1)!}
        hostLabel="生产 API"
        hostDescription="deploy@10.0.0.8:22"
        query=""
        filter="all"
        actionAvailable
        onQueryChange={() => undefined}
        onFilterChange={() => undefined}
        onRefresh={() => undefined}
        onSelectService={() => undefined}
        onRequestAction={() => undefined}
        onCancelAction={() => undefined}
        onConfirmAction={() => undefined}
      />,
    )
    expect(html).toContain('服务器：生产 API')
    expect(html).toContain('服务：nginx.service')
    expect(html).toContain('动作：重启')
    expect(html).toContain('deploy@10.0.0.8:22')
    expect(html).not.toContain('connection-secret')
  })

  test('Given 动作确认 When 连续重复确认 Then 只调用一次并权威回读详情与列表', async () => {
    const harness = createControllerHarness()
    const action = createDeferred<ServerOpsServiceActionResult>()
    harness.setRunAction((input) => {
      harness.actionCalls.push(input)
      return action.promise
    })
    await harness.controller.select({ sessionId: 'session-1', hostId: 'host-1', active: true, connected: true })
    await harness.controller.selectService('nginx.service')
    harness.controller.requestAction('nginx.service', 'restart')

    const firstConfirm = harness.controller.confirmAction()
    const duplicateConfirm = harness.controller.confirmAction()
    expect(harness.actionCalls).toEqual([{
      sessionId: 'session-1', hostId: 'host-1', unitId: 'nginx.service', action: 'restart',
    }])
    expect(harness.projections.at(-1)?.executingUnitId).toBe('nginx.service')

    action.resolve({
      hostId: 'host-1',
      unitId: 'nginx.service',
      action: 'restart',
      service: createService('nginx.service', 'active'),
      warnings: [],
    })
    await Promise.all([firstConfirm, duplicateConfirm])

    expect(harness.actionCalls).toHaveLength(1)
    expect(harness.listCalls).toHaveLength(2)
    expect(harness.detailCalls).toEqual([
      { hostId: 'host-1', unitId: 'nginx.service' },
      { hostId: 'host-1', unitId: 'nginx.service' },
    ])
    expect(harness.notices).toContainEqual({ kind: 'success', message: '服务重启操作已完成，状态已重新读取' })
  })

  test('Given 旧详情迟到 When 已切换服务 Then 旧结果不能覆盖当前详情', async () => {
    const harness = createControllerHarness()
    const nginxDetail = createDeferred<ServerOpsServiceDetailResult>()
    const redisDetail = createDeferred<ServerOpsServiceDetailResult>()
    harness.setListServices(async (input) => {
      harness.listCalls.push(input)
      return createListResult(input.hostId, [
        createService('nginx.service', 'active'),
        createService('redis.service', 'failed'),
      ])
    })
    harness.setGetDetail((input) => {
      harness.detailCalls.push(input)
      return input.unitId === 'nginx.service' ? nginxDetail.promise : redisDetail.promise
    })
    await harness.controller.select({ sessionId: 'session-1', hostId: 'host-1', active: true, connected: true })
    const oldRead = harness.controller.selectService('nginx.service')
    const currentRead = harness.controller.selectService('redis.service')

    nginxDetail.resolve(createDetailResult('host-1', createService('nginx.service', 'active')))
    await oldRead
    await flushPromises()
    redisDetail.resolve(createDetailResult('host-1', createService('redis.service', 'failed')))
    await currentRead

    expect(harness.projections.at(-1)?.selectedUnitId).toBe('redis.service')
    expect(harness.projections.at(-1)?.detail?.service?.unitId).toBe('redis.service')
  })

  test('Given 主机、连接或可见性失效 When 旧详情返回 Then 清空选择且拒绝旧结果', async () => {
    for (const nextContext of [
      { sessionId: 'session-1', hostId: 'host-2', active: true, connected: true },
      { sessionId: 'session-1', hostId: 'host-1', active: true, connected: false },
      { sessionId: 'session-1', hostId: 'host-1', active: false, connected: true },
    ]) {
      const harness = createControllerHarness()
      const detail = createDeferred<ServerOpsServiceDetailResult>()
      harness.setGetDetail((input) => {
        harness.detailCalls.push(input)
        return detail.promise
      })
      await harness.controller.select({ sessionId: 'session-1', hostId: 'host-1', active: true, connected: true })
      const oldRead = harness.controller.selectService('nginx.service')
      void harness.controller.select(nextContext)
      detail.resolve(createDetailResult('host-1', createService('nginx.service', 'active')))
      await oldRead
      expect(harness.projections.at(-1)?.selectedUnitId).toBeNull()
      expect(harness.projections.at(-1)?.detail).toBeNull()
    }
  })

  test('Given 动作返回 unknown 或失败 When 执行结束 Then 都重新读取列表与详情', async () => {
    for (const outcome of ['unknown', 'failure'] as const) {
      const harness = createControllerHarness()
      harness.setRunAction(async (input) => {
        harness.actionCalls.push(input)
        if (outcome === 'unknown') throw new Error('SERVER_OPS_SERVICE_ACTION_UNKNOWN')
        throw new Error('ssh secret bottom error')
      })
      await harness.controller.select({ sessionId: 'session-1', hostId: 'host-1', active: true, connected: true })
      await harness.controller.selectService('nginx.service')
      harness.controller.requestAction('nginx.service', 'stop')

      await harness.controller.confirmAction()

      expect(harness.listCalls).toHaveLength(2)
      expect(harness.detailCalls).toHaveLength(2)
      expect(harness.notices.some((notice) => notice.message.includes('ssh secret bottom error'))).toBe(false)
      expect(harness.notices.some((notice) => notice.kind === (outcome === 'failure' ? 'error' : 'warning'))).toBe(true)
      if (outcome === 'unknown') {
        expect(harness.notices).toContainEqual({
          kind: 'warning', message: '服务操作结果不确定，正在重新读取状态',
        })
      }
    }
  })

  test('Given Electron 包装 UNKNOWN When 动作拒绝 Then 显示结果不确定 warning 且不宣称失败', async () => {
    const harness = createControllerHarness()
    harness.setRunAction(async (input) => {
      harness.actionCalls.push(input)
      throw new Error("Error invoking remote method 'server-ops:run-service-action': Error: SERVER_OPS_SERVICE_ACTION_UNKNOWN")
    })
    await harness.controller.select({ sessionId: 'session-1', hostId: 'host-1', active: true, connected: true })
    await harness.controller.selectService('nginx.service')
    harness.controller.requestAction('nginx.service', 'restart')

    await harness.controller.confirmAction()

    expect(harness.notices).toContainEqual({
      kind: 'warning', message: '服务操作结果不确定，正在重新读取状态',
    })
    expect(harness.notices.some((notice) => notice.message.includes('失败'))).toBe(false)
  })

  test('Given Electron 包装 IN_PROGRESS When 动作拒绝 Then 显示专用安全文案', async () => {
    const harness = createControllerHarness()
    harness.setRunAction(async (input) => {
      harness.actionCalls.push(input)
      throw new Error("Error invoking remote method 'server-ops:run-service-action': Error: SERVER_OPS_SERVICE_ACTION_IN_PROGRESS")
    })
    await harness.controller.select({ sessionId: 'session-1', hostId: 'host-1', active: true, connected: true })
    await harness.controller.selectService('nginx.service')
    harness.controller.requestAction('nginx.service', 'restart')

    await harness.controller.confirmAction()

    expect(harness.notices).toContainEqual({
      kind: 'error', message: '该服务已有操作正在执行，请等待完成后重试',
    })
  })

  test('Given 包装码带敏感尾随内容或仅是文本片段 When 动作拒绝 Then 固定降级且不泄漏', async () => {
    const unsafeMessages = [
      "Error invoking remote method 'server-ops:run-service-action': Error: SERVER_OPS_SERVICE_ACTION_UNKNOWN /Users/secret/key",
      "Error invoking remote method 'server-ops:run-service-action': Error: SERVER_OPS_SERVICE_ACTION_IN_PROGRESS connection-very-secret",
      "Error invoking remote method 'server-ops:run-service-action': Error: SERVER_OPS_SERVICE_ACTION_UNKNOWN\n    at private-stack",
      "Error invoking remote method 'other:method': Error: SERVER_OPS_SERVICE_ACTION_UNKNOWN",
      'prefix SERVER_OPS_SERVICE_ACTION_UNKNOWN suffix',
    ]
    for (const unsafeMessage of unsafeMessages) {
      const harness = createControllerHarness()
      harness.setRunAction(async (input) => {
        harness.actionCalls.push(input)
        throw new Error(unsafeMessage)
      })
      await harness.controller.select({ sessionId: 'session-1', hostId: 'host-1', active: true, connected: true })
      await harness.controller.selectService('nginx.service')
      harness.controller.requestAction('nginx.service', 'restart')

      await harness.controller.confirmAction()

      expect(harness.notices).toContainEqual({ kind: 'error', message: '服务操作失败，状态已重新读取' })
      const publicOutput = JSON.stringify({ notices: harness.notices, projections: harness.projections })
      const html = renderToStaticMarkup(
        <ServerOpsServicesPanelView
          {...harness.projections.at(-1)!}
          connected
          query=""
          filter="all"
          actionAvailable
          onQueryChange={() => undefined}
          onFilterChange={() => undefined}
          onRefresh={() => undefined}
          onSelectService={() => undefined}
          onRequestAction={() => undefined}
          onCancelAction={() => undefined}
          onConfirmAction={() => undefined}
        />,
      )
      for (const sensitive of ['/Users/secret', 'connection-very-secret', 'private-stack', 'other:method']) {
        expect(publicOutput).not.toContain(sensitive)
        expect(html).not.toContain(sensitive)
      }
      expect(harness.notices).not.toContainEqual({
        kind: 'warning', message: '服务操作结果不确定，正在重新读取状态',
      })
    }
  })

  test('Given 审计开始失败 When 动作未执行 Then 显示中文原因且不泄漏错误码', async () => {
    const harness = createControllerHarness()
    harness.setRunAction(async (input) => {
      harness.actionCalls.push(input)
      throw new Error("Error invoking remote method 'server-ops:run-service-action': Error: SERVER_OPS_AUDIT_WRITE_FAILED")
    })
    await harness.controller.select({ sessionId: 'session-1', hostId: 'host-1', active: true, connected: true })
    await harness.controller.selectService('nginx.service')
    harness.controller.requestAction('nginx.service', 'restart')

    await harness.controller.confirmAction()

    expect(harness.notices).toContainEqual({ kind: 'error', message: '操作审计记录写入失败，服务动作未执行' })
    expect(JSON.stringify(harness.notices)).not.toContain('SERVER_OPS_AUDIT_WRITE_FAILED')
  })

  test('Given 动作返回稳定 output 或权限错误 When Electron 包装拒绝 Then 显示对应中文恢复文案', async () => {
    const cases = [
      ['SERVER_OPS_SYSTEMD_OUTPUT_INVALID', '服务器返回的 systemd 状态无效，请刷新后重试'],
      ['SERVER_OPS_SYSTEMD_PERMISSION_DENIED', '当前账号无权执行此服务操作'],
    ] as const
    for (const [code, expectedMessage] of cases) {
      const harness = createControllerHarness()
      harness.setRunAction(async (input) => {
        harness.actionCalls.push(input)
        throw new Error(`Error invoking remote method 'server-ops:run-service-action': Error: ${code}`)
      })
      await harness.controller.select({ sessionId: 'session-1', hostId: 'host-1', active: true, connected: true })
      await harness.controller.selectService('nginx.service')
      harness.controller.requestAction('nginx.service', 'restart')

      await harness.controller.confirmAction()

      expect(harness.notices).toContainEqual({ kind: 'error', message: expectedMessage })
      expect(JSON.stringify(harness.notices)).not.toContain(code)
    }
  })

  test('Given 动作或详情返回 warning When 发布提示 Then 只显示中文恢复建议', async () => {
    const harness = createControllerHarness()
    harness.setRunAction(async (input) => {
      harness.actionCalls.push(input)
      return {
        hostId: input.hostId,
        unitId: input.unitId,
        action: input.action,
        service: createService(input.unitId, 'active'),
        warnings: ['SERVER_OPS_AUDIT_RESULT_WRITE_FAILED'],
      }
    })
    let detailReads = 0
    harness.setGetDetail(async (input) => {
      harness.detailCalls.push(input)
      detailReads += 1
      return {
        ...createDetailResult(input.hostId, createService(input.unitId, 'active')),
        warnings: detailReads === 1
          ? ['SERVER_OPS_SYSTEMD_OUTPUT_INVALID', 'secret warning /Users/private']
          : [],
      }
    })
    await harness.controller.select({ sessionId: 'session-1', hostId: 'host-1', active: true, connected: true })
    await harness.controller.selectService('nginx.service')
    harness.controller.requestAction('nginx.service', 'restart')

    await harness.controller.confirmAction()

    expect(harness.notices).toContainEqual({ kind: 'warning', message: '服务状态回读不完整，请刷新后确认' })
    expect(harness.notices).toContainEqual({ kind: 'warning', message: '服务返回了未识别的警告，请刷新后确认' })
    expect(harness.notices).toContainEqual({ kind: 'warning', message: '服务操作已完成，但审计结果保存失败，请检查本地存储' })
    const notices = JSON.stringify(harness.notices)
    expect(notices).not.toContain('SERVER_OPS_')
    expect(notices).not.toContain('/Users/private')
  })

  test('Given 动作在途切换服务 When 成功、失败或 unknown 结束 Then 刷新列表并回读当前选择详情', async () => {
    for (const outcome of ['success', 'failure', 'unknown'] as const) {
      const harness = createControllerHarness()
      const action = createDeferred<ServerOpsServiceActionResult>()
      harness.setListServices(async (input) => {
        harness.listCalls.push(input)
        return createListResult(input.hostId, [
          createService('nginx.service', 'active'),
          createService('redis.service', 'failed'),
        ])
      })
      harness.setRunAction((input) => {
        harness.actionCalls.push(input)
        return action.promise
      })
      await harness.controller.select({ sessionId: 'session-1', hostId: 'host-1', active: true, connected: true })
      await harness.controller.selectService('nginx.service')
      harness.controller.requestAction('nginx.service', 'restart')
      const actionRequest = harness.controller.confirmAction()

      await harness.controller.selectService('redis.service')
      if (outcome === 'failure') action.reject(new Error('remote secret failure'))
      else action.resolve({
        hostId: 'host-1',
        unitId: 'nginx.service',
        action: 'restart',
        ...(outcome === 'success' ? { service: createService('nginx.service', 'active') } : {}),
        warnings: outcome === 'unknown' ? ['SERVICE_ACTION_STATUS_UNKNOWN'] : [],
      })
      await actionRequest

      expect(harness.listCalls).toHaveLength(2)
      expect(harness.detailCalls).toEqual([
        { hostId: 'host-1', unitId: 'nginx.service' },
        { hostId: 'host-1', unitId: 'redis.service' },
        { hostId: 'host-1', unitId: 'redis.service' },
      ])
      expect(harness.projections.at(-1)?.selectedUnitId).toBe('redis.service')
      expect(harness.projections.at(-1)?.detail?.service?.unitId).toBe('redis.service')
    }
  })

  test('Given 任一服务动作正在执行 When 查看其他服务 Then 所有动作按钮保持禁用', () => {
    const html = renderToStaticMarkup(
      <ServerOpsServicesPanelView
        status="ready"
        capability="available"
        services={[
          createService('nginx.service', 'active'),
          createService('redis.service', 'failed'),
        ]}
        query=""
        filter="all"
        selectedUnitId="redis.service"
        detailStatus="ready"
        detail={createDetailResult('host-1', createService('redis.service', 'failed'))}
        error={null}
        detailError={null}
        pendingAction={null}
        executingUnitId="nginx.service"
        actionAvailable
        onQueryChange={() => undefined}
        onFilterChange={() => undefined}
        onRefresh={() => undefined}
        onSelectService={() => undefined}
        onRequestAction={() => undefined}
        onCancelAction={() => undefined}
        onConfirmAction={() => undefined}
      />,
    )

    expect(html.match(/disabled=""/g)).toHaveLength(5)
    for (const label of ['启动', '停止', '重启', '启用', '禁用']) {
      expect(html).toContain(`aria-label="${label} redis.service"`)
    }
  })

  test('Given 列表初始请求在途 When 连续刷新 Then 只执行当前请求并最多补读一次', async () => {
    const harness = createControllerHarness()
    const first = createDeferred<ServerOpsServiceListResult>()
    const queued = createDeferred<ServerOpsServiceListResult>()
    let calls = 0
    harness.setListServices((input) => {
      harness.listCalls.push(input)
      calls += 1
      return calls === 1 ? first.promise : queued.promise
    })
    const initial = harness.controller.select({ sessionId: 'session-1', hostId: 'host-1', active: true, connected: true })
    void harness.controller.refresh()
    void harness.controller.refresh()
    expect(harness.listCalls).toHaveLength(1)

    first.resolve(createListResult())
    await initial
    await flushPromises()
    expect(harness.listCalls).toHaveLength(2)
    queued.resolve(createListResult())
    await flushPromises()
    expect(harness.listCalls).toHaveLength(2)
  })

  test('Given 详情请求在途 When 重复并切换 unit Then 旧请求结束后只补读最新选择', async () => {
    const harness = createControllerHarness()
    const nginx = createDeferred<ServerOpsServiceDetailResult>()
    const redis = createDeferred<ServerOpsServiceDetailResult>()
    harness.setListServices(async (input) => {
      harness.listCalls.push(input)
      return createListResult(input.hostId, [
        createService('nginx.service', 'active'),
        createService('redis.service', 'failed'),
      ])
    })
    harness.setGetDetail((input) => {
      harness.detailCalls.push(input)
      return input.unitId === 'nginx.service' ? nginx.promise : redis.promise
    })
    await harness.controller.select({ sessionId: 'session-1', hostId: 'host-1', active: true, connected: true })
    const oldRead = harness.controller.selectService('nginx.service')
    void harness.controller.selectService('nginx.service')
    void harness.controller.selectService('redis.service')
    void harness.controller.selectService('redis.service')
    expect(harness.detailCalls).toEqual([{ hostId: 'host-1', unitId: 'nginx.service' }])

    nginx.resolve(createDetailResult('host-1', createService('nginx.service', 'active')))
    await oldRead
    await flushPromises()
    expect(harness.detailCalls).toEqual([
      { hostId: 'host-1', unitId: 'nginx.service' },
      { hostId: 'host-1', unitId: 'redis.service' },
    ])
    redis.resolve(createDetailResult('host-1', createService('redis.service', 'failed')))
    await flushPromises()
    expect(harness.projections.at(-1)?.detail?.service?.unitId).toBe('redis.service')
  })

  test('Given 断线上下文 When 选择服务页 Then 显示未连接且零 IPC', async () => {
    const harness = createControllerHarness()
    await harness.controller.select({ sessionId: 'session-1', hostId: 'host-1', active: true, connected: false })
    expect(harness.listCalls).toEqual([])
    expect(harness.detailCalls).toEqual([])
    const html = renderToStaticMarkup(
      <ServerOpsServicesPanelView
        {...harness.projections.at(-1)!}
        connected={false}
        query=""
        filter="all"
        actionAvailable={false}
        onQueryChange={() => undefined}
        onFilterChange={() => undefined}
        onRefresh={() => undefined}
        onSelectService={() => undefined}
        onRequestAction={() => undefined}
        onCancelAction={() => undefined}
        onConfirmAction={() => undefined}
      />,
    )
    expect(html).toContain('尚未建立 SSH 连接')
    expect(html).not.toContain('正在读取服务列表...')
  })

  test('Given 详情返回 unsupported 或 permission-denied When 查看服务 Then 显式提示且拒绝动作', async () => {
    for (const capability of ['unsupported', 'permission-denied'] as const) {
      const harness = createControllerHarness()
      harness.setGetDetail(async (input) => {
        harness.detailCalls.push(input)
        return { hostId: input.hostId, capability, statusLines: [], recentLogLines: [], warnings: [] }
      })
      await harness.controller.select({ sessionId: 'session-1', hostId: 'host-1', active: true, connected: true })
      await harness.controller.selectService('nginx.service')
      harness.controller.requestAction('nginx.service', 'restart')
      expect(harness.projections.at(-1)?.pendingAction).toBeNull()
      const html = renderToStaticMarkup(
        <ServerOpsServicesPanelView
          {...harness.projections.at(-1)!}
          connected
          query=""
          filter="all"
          actionAvailable
          onQueryChange={() => undefined}
          onFilterChange={() => undefined}
          onRefresh={() => undefined}
          onSelectService={() => undefined}
          onRequestAction={() => undefined}
          onCancelAction={() => undefined}
          onConfirmAction={() => undefined}
        />,
      )
      expect(html).toContain(capability === 'unsupported'
        ? '当前服务不支持 systemd 操作'
        : '当前账号无权读取此服务详情')
      expect(html.match(/disabled=""/g)).toHaveLength(5)
      expect(html).not.toContain('没有状态输出')
    }
  })

  test('Given 动作在途 When inactive、session 切换或 StrictMode 重放 Then flight 保持且不能重复动作', async () => {
    for (const transition of ['inactive', 'session', 'strict-mode'] as const) {
      const harness = createControllerHarness()
      const action = createDeferred<ServerOpsServiceActionResult>()
      harness.setRunAction((input) => {
        harness.actionCalls.push(input)
        return action.promise
      })
      await harness.controller.select({ sessionId: 'session-1', hostId: 'host-1', active: true, connected: true })
      await harness.controller.selectService('nginx.service')
      harness.controller.requestAction('nginx.service', 'restart')
      const request = harness.controller.confirmAction()
      const callsBeforeTransition = harness.listCalls.length + harness.detailCalls.length

      if (transition === 'strict-mode') {
        harness.controller.dispose()
        harness.controller.activate()
      } else if (transition === 'session') {
        await harness.controller.select({ sessionId: 'session-2', hostId: 'host-1', active: true, connected: true })
      } else {
        await harness.controller.select({ sessionId: 'session-1', hostId: 'host-1', active: false, connected: true })
        expect(harness.listCalls.length + harness.detailCalls.length).toBe(callsBeforeTransition)
      }
      await harness.controller.select({
        sessionId: transition === 'session' ? 'session-2' : 'session-1',
        hostId: 'host-1',
        active: true,
        connected: true,
      })
      await harness.controller.selectService('nginx.service')
      harness.controller.requestAction('nginx.service', 'stop')
      void harness.controller.confirmAction()

      expect(harness.actionCalls).toHaveLength(1)
      expect(harness.projections.at(-1)?.executingUnitId).toBe('nginx.service')
      action.resolve({
        hostId: 'host-1', unitId: 'nginx.service', action: 'restart',
        service: createService('nginx.service', 'active'), warnings: [],
      })
      await request
    }
  })

  test('Given unsupported、permission、empty、loading 与 error When 渲染 Then 状态互相独立且未知错误不泄漏', () => {
    const common = {
      services: [],
      query: '',
      filter: 'all' as const,
      selectedUnitId: null,
      detailStatus: 'idle' as const,
      detail: null,
      detailError: null,
      pendingAction: null,
      executingUnitId: null,
      actionAvailable: true,
      onQueryChange: () => undefined,
      onFilterChange: () => undefined,
      onRefresh: () => undefined,
      onSelectService: () => undefined,
      onRequestAction: () => undefined,
      onCancelAction: () => undefined,
      onConfirmAction: () => undefined,
    }
    const cases = [
      { status: 'ready' as const, capability: 'unsupported' as const, error: null, expected: '当前服务器不支持 systemd' },
      { status: 'ready' as const, capability: 'permission-denied' as const, error: null, expected: '当前账号无权读取 systemd 服务' },
      { status: 'ready' as const, capability: 'available' as const, error: null, expected: '没有可显示的服务' },
      { status: 'loading' as const, capability: null, error: null, expected: '正在读取服务列表...' },
      { status: 'error' as const, capability: null, error: '服务器服务暂时不可用，请稍后重试', expected: '服务列表读取失败' },
    ]

    for (const item of cases) {
      const html = renderToStaticMarkup(<ServerOpsServicesPanelView {...common} {...item} />)
      expect(html).toContain(item.expected)
      expect(html).not.toContain('ssh secret bottom error')
    }
  })

  test('Given 控制器已卸载 When 在途请求返回 Then 不再发布投影', async () => {
    const harness = createControllerHarness()
    const list = createDeferred<ServerOpsServiceListResult>()
    harness.setListServices((input) => {
      harness.listCalls.push(input)
      return list.promise
    })
    const request = harness.controller.select({ sessionId: 'session-1', hostId: 'host-1', active: true, connected: true })
    harness.controller.dispose()
    const count = harness.projections.length
    list.resolve(createListResult())
    await request
    await flushPromises()
    expect(harness.projections).toHaveLength(count)
  })
})
