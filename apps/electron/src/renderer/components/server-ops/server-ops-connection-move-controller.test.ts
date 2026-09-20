import { describe, expect, test } from 'bun:test'
import type { ServerOpsConnectionMoveInput, ServerOpsConnectionMoveResult, ServerOpsProject } from '@proma/shared'
import type { ServerOpsConnection } from './server-ops-connections'
import { createServerOpsConnectionMoveController, mergeServerOpsMovedAsset } from './server-ops-connection-move-controller'

/** 三类连接共用的项目样本。 */
const projects: ServerOpsProject[] = ['project-a', 'project-b'].map((id) => ({ id, name: id, createdAt: 1, updatedAt: 1 }))
/** 根据类别生成具备稳定身份的连接。 */
function connection(kind: ServerOpsConnection['kind'] = 'ssh'): ServerOpsConnection {
  return { id: kind === 'ssh' ? 'ssh:host-1' : 'data:source-1', kind, projectId: 'project-a', label: '示例连接', detail: '本地示例',
    ...(kind === 'ssh' ? { hostId: 'host-1' } : { sourceId: 'source-1' }) }
}
/** 创建主进程成功移动的公开回执。 */
function moved(input: ServerOpsConnectionMoveInput): ServerOpsConnectionMoveResult {
  if (input.kind === 'ssh') return { kind: 'ssh', host: { id: input.id, projectId: input.targetProjectId, name: '示例连接', address: '127.0.0.1', port: 22, username: 'fixture', authMethod: 'ssh-agent', tags: [], createdAt: 1, updatedAt: 2 } }
  return { kind: 'data', source: { id: input.id, projectId: input.targetProjectId, label: '示例连接', transport: 'direct', engine: 'mysql', address: '127.0.0.1', port: 3306, username: 'fixture', tlsMode: 'disabled', hasPassword: true, createdAt: 1, updatedAt: 2 } }
}
/** 可控的异步写入，用于模拟重复提交、关闭和迟到回执。 */
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((accept, fail) => { resolve = accept; reject = fail })
  return { promise, resolve, reject }
}
/** 模拟 IPC 与共享最新连接，不读真实配置。 */
function harness(initial = connection()) {
  let currentConnections = [initial]
  let currentProjects = [...projects]
  let move = async (input: ServerOpsConnectionMoveInput) => moved(input)
  const calls: ServerOpsConnectionMoveInput[] = []
  const receipts: ServerOpsConnectionMoveResult[] = []
  const notifications: string[] = []
  const controller = createServerOpsConnectionMoveController({
    getProjects: () => currentProjects,
    getConnections: () => currentConnections,
    move: (input) => { calls.push(input); return move(input) },
    acceptMoved: (result) => { receipts.push(result) },
    onSuccess: (name) => { notifications.push(name) },
    publish: () => undefined,
  })
  controller.activate()
  return { controller, calls, receipts, notifications,
    setProjects: (value: ServerOpsProject[]) => { currentProjects = value },
    setConnections: (value: ServerOpsConnection[]) => { currentConnections = value },
    setMove: (value: typeof move) => { move = value } }
}

describe('连接移动控制器', () => {
  test('Given 共享资产列表 When 合并移动回执 Then 保留其他资产且不复活删除项或覆盖更新归属', () => {
    /** 旧归属与不同资产。 */
    const original = { id: 'host-1', projectId: 'project-a', updatedAt: 1 }
    const other = { id: 'host-2', projectId: 'project-a', updatedAt: 1 }
    const saved = { ...original, projectId: 'project-b', updatedAt: 2 }
    expect(mergeServerOpsMovedAsset([original, other], saved, 'project-a')).toEqual([saved, other])
    expect(mergeServerOpsMovedAsset([other], saved, 'project-a')).toEqual([other])
    const newer = [{ ...original, projectId: 'project-c', updatedAt: 3 }, other]
    expect(mergeServerOpsMovedAsset(newer, saved, 'project-a')).toBe(newer)
    const returned = [{ ...original, updatedAt: 4 }, other]
    expect(mergeServerOpsMovedAsset(returned, saved, 'project-a')).toBe(returned)
    /** 历史记录允许缺少项目归属，成功回执会补齐该字段。 */
    const legacy: Array<{ id: string; projectId?: string; updatedAt: number }> = [{ id: original.id, updatedAt: 1 }]
    expect(mergeServerOpsMovedAsset(legacy, saved, 'project-a')).toEqual([saved])
  })
  test('Given 三类连接 When 移动 Then 精确提交原项目、目标项目和稳定 ID', async () => {
    for (const kind of ['ssh', 'database', 'redis'] as const) {
      const item = connection(kind)
      const h = harness(item)
      h.controller.open(item)
      h.controller.selectTarget('project-b')
      await h.controller.submit()
      expect(h.calls).toEqual([{ kind: kind === 'ssh' ? 'ssh' : 'data', id: kind === 'ssh' ? 'host-1' : 'source-1', fromProjectId: 'project-a', targetProjectId: 'project-b' }])
      expect(h.receipts).toHaveLength(1)
      expect(h.controller.getProjection().connection).toBeNull()
      expect(h.notifications).toEqual(['project-b'])
    }
  })

  test('Given 未选择、同项目或目标已删除 When 提交 Then 不发送请求', async () => {
    const h = harness()
    h.controller.open(connection())
    await h.controller.submit()
    h.controller.selectTarget('project-a')
    await h.controller.submit()
    h.controller.selectTarget('project-b')
    h.setProjects([projects[0]!])
    await h.controller.submit()
    expect(h.calls).toHaveLength(0)
    expect(h.controller.getProjection().error).toContain('目标项目')
  })

  test('Given 连接已被别的 Pane 移走或删除 When 提交旧弹窗 Then 不覆盖新归属', async () => {
    const h = harness()
    h.controller.open(connection())
    h.controller.selectTarget('project-b')
    h.setConnections([{ ...connection(), projectId: 'project-b' }])
    await h.controller.submit()
    expect(h.controller.getProjection().error).toContain('归属已变化')
    h.setConnections([])
    await h.controller.submit()
    expect(h.controller.getProjection().error).toContain('不存在')
    expect(h.calls).toHaveLength(0)
  })

  test('Given 保存中 When 重复提交、关窗或切换目标 Then 原请求独占弹窗', async () => {
    const h = harness()
    const pending = deferred<ServerOpsConnectionMoveResult>()
    h.setMove(() => pending.promise)
    h.controller.open(connection())
    h.controller.selectTarget('project-b')
    const saving = h.controller.submit()
    await h.controller.submit()
    h.controller.close()
    h.controller.open(connection('redis'))
    h.controller.selectTarget('project-a')
    expect(h.controller.getProjection()).toMatchObject({ submitting: true, connection: { kind: 'ssh' }, targetProjectId: 'project-b' })
    expect(h.calls).toHaveLength(1)
    pending.resolve(moved(h.calls[0]!))
    await saving
  })

  test('Given 写入失败 When 重试 Then 保留目标和错误后可成功', async () => {
    const h = harness()
    h.setMove(async () => { throw new Error('SERVER_OPS_CONNECTION_PROJECT_CHANGED') })
    h.controller.open(connection())
    h.controller.selectTarget('project-b')
    await h.controller.submit()
    expect(h.controller.getProjection()).toMatchObject({ submitting: false, targetProjectId: 'project-b' })
    expect(h.controller.getProjection().error).toContain('归属已变化')
    expect(h.receipts).toHaveLength(0)
    h.setMove(async (input) => moved(input))
    await h.controller.submit()
    expect(h.receipts).toHaveLength(1)
  })

  test('Given API 尚未更新 When 同步抛错 Then 显示重启提示并解除忙态', async () => {
    const h = harness()
    h.setMove(() => { throw new TypeError('moveServerOpsConnection is not a function') })
    h.controller.open(connection())
    h.controller.selectTarget('project-b')
    await h.controller.submit()
    expect(h.controller.getProjection().error).toContain('重启')
    expect(h.controller.getProjection().submitting).toBe(false)
  })

  test('Given 回执身份与请求不符 When 返回 Then 不合并其他连接', async () => {
    const h = harness()
    h.setMove(async (input) => moved({ ...input, id: 'other-host' }))
    h.controller.open(connection())
    h.controller.selectTarget('project-b')
    await h.controller.submit()
    expect(h.receipts).toHaveLength(0)
    expect(h.controller.getProjection().error).not.toBeNull()
  })

  test('Given 提交后 Pane 卸载并重新打开 When 旧回执到达 Then 同步已落盘事实但不关闭新弹窗', async () => {
    const h = harness()
    const pending = deferred<ServerOpsConnectionMoveResult>()
    h.setMove(() => pending.promise)
    h.controller.open(connection())
    h.controller.selectTarget('project-b')
    const saving = h.controller.submit()
    h.controller.dispose()
    h.controller.activate()
    h.controller.open(connection('database'))
    pending.resolve(moved(h.calls[0]!))
    await saving
    expect(h.receipts).toHaveLength(1)
    expect(h.controller.getProjection().connection?.kind).toBe('database')
    expect(h.notifications).toHaveLength(0)
  })
})
