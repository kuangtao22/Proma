import { describe, expect, test } from 'bun:test'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { ServerOpsTrustCandidate, ServerOpsTrustSnapshot } from '@proma/shared'
import {
  createServerOpsTrustController,
  getServerOpsTrustErrorMessage,
  ServerOpsTrustDialogView,
} from './ServerOpsTrustDialog'

interface Deferred<T> {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (reason: unknown) => void
}

/** 创建可控 Promise，用于验证信任请求的迟到结果。 */
function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((nextResolve, nextReject) => { resolve = nextResolve; reject = nextReject })
  return { promise, resolve, reject }
}

/** 创建信任管理测试使用的公开快照。 */
function createSnapshot(hostId = 'host-1'): ServerOpsTrustSnapshot {
  return {
    hostId,
    name: hostId === 'host-1' ? '生产 API' : '灾备 API',
    address: hostId === 'host-1' ? '10.0.0.8' : '10.0.0.9',
    port: 22,
    trustedKey: { algorithm: 'ssh-ed25519', fingerprint: 'SHA256:trusted' },
    observedKey: { algorithm: 'ssh-ed25519', fingerprint: 'SHA256:observed' },
    affectedHosts: [{ id: hostId, name: hostId === 'host-1' ? '生产 API' : '灾备 API' }],
  }
}

/** 从快照创建五分钟内有效的替换候选。 */
function createCandidate(snapshot = createSnapshot()): ServerOpsTrustCandidate {
  return { ...snapshot, candidateId: `candidate-${snapshot.hostId}`, action: 'replace', expiresAt: Date.now() + 300_000 }
}

describe('服务器信任管理', () => {
  test('Given 真实信任快照 When 渲染 Then 展示 endpoint、两类指纹、受影响主机和可用动作', () => {
    const html = renderToStaticMarkup(
      <ServerOpsTrustDialogView
        status="ready"
        snapshot={createSnapshot()}
        candidate={null}
        confirmationName=""
        error={null}
        warning={null}
        onRefresh={() => undefined}
        onPrepare={() => undefined}
        onConfirmationNameChange={() => undefined}
        onCommit={() => undefined}
        onCancelCandidate={() => undefined}
      />,
    )

    expect(html).toContain('10.0.0.8:22')
    expect(html).toContain('SHA256:trusted')
    expect(html).toContain('SHA256:observed')
    expect(html).toContain('生产 API')
    expect(html).toContain('替换为新指纹')
    expect(html).toContain('撤销信任')
    expect(html).toContain('data-server-ops-trust-layout="responsive"')
  })

  test('Given 缺少新观测或已有信任 When 渲染 Then 只禁用不满足前置条件的动作', () => {
    const withoutObserved = renderToStaticMarkup(
      <ServerOpsTrustDialogView
        status="ready" snapshot={{ ...createSnapshot(), observedKey: null }} candidate={null}
        confirmationName="" error={null} warning={null} onRefresh={() => undefined}
        onPrepare={() => undefined} onConfirmationNameChange={() => undefined}
        onCommit={() => undefined} onCancelCandidate={() => undefined}
      />,
    )
    const withoutTrust = renderToStaticMarkup(
      <ServerOpsTrustDialogView
        status="ready" snapshot={{ ...createSnapshot(), trustedKey: null }} candidate={null}
        confirmationName="" error={null} warning={null} onRefresh={() => undefined}
        onPrepare={() => undefined} onConfirmationNameChange={() => undefined}
        onCommit={() => undefined} onCancelCandidate={() => undefined}
      />,
    )
    expect(withoutObserved).toContain('data-trust-action="replace" disabled=""')
    expect(withoutObserved).not.toContain('data-trust-action="revoke" disabled=""')
    expect(withoutTrust).toContain('data-trust-action="replace" disabled=""')
    expect(withoutTrust).toContain('data-trust-action="revoke" disabled=""')
  })

  test('Given 已准备候选 When 确认名不精确 Then 提交保持禁用且候选可取消', () => {
    const html = renderToStaticMarkup(
      <ServerOpsTrustDialogView
        status="ready" snapshot={createSnapshot()} candidate={createCandidate()}
        confirmationName="生产 api" error={null} warning={null} onRefresh={() => undefined}
        onPrepare={() => undefined} onConfirmationNameChange={() => undefined}
        onCommit={() => undefined} onCancelCandidate={() => undefined}
      />,
    )
    expect(html).toContain('请输入服务器显示名“生产 API”')
    expect(html).toContain('data-server-ops-trust-commit="true" disabled=""')
    expect(html).toContain('取消本次变更')
  })

  test('Given 主机切换且旧 get/prepare/commit 迟到 When 返回 Then 取消精确候选且不污染新主机', async () => {
    const getA = createDeferred<ServerOpsTrustSnapshot>()
    const getB = createDeferred<ServerOpsTrustSnapshot>()
    const prepareA = createDeferred<ServerOpsTrustCandidate>()
    const commitA = createDeferred<{ hostId: string; action: 'replace'; affectedHostIds: string[] }>()
    const projections: Array<{ hostId: string | null; status: string; candidate: ServerOpsTrustCandidate | null }> = []
    const cancels: Array<{ hostId: string; candidateId: string }> = []
    const controller = createServerOpsTrustController({
      get: ({ hostId }) => hostId === 'host-1' ? getA.promise : getB.promise,
      prepare: () => prepareA.promise,
      commit: () => commitA.promise,
      cancel: async (input) => { cancels.push(input) },
      publish: (projection) => { projections.push(projection) },
    })
    controller.activate()
    void controller.select('host-1')
    getA.resolve(createSnapshot())
    await getA.promise
    void controller.prepare('replace')
    prepareA.resolve(createCandidate())
    await prepareA.promise
    await Promise.resolve()
    void controller.commit('生产 API')
    void controller.select('host-2')
    expect(projections.at(-1)).toMatchObject({ hostId: 'host-2', snapshot: null, candidate: null })
    expect(cancels).toEqual([{ hostId: 'host-1', candidateId: 'candidate-host-1' }])
    getB.resolve(createSnapshot('host-2'))
    await getB.promise
    commitA.resolve({ hostId: 'host-1', action: 'replace', affectedHostIds: ['host-1'] })
    await commitA.promise
    await Promise.resolve()
    expect(projections.at(-1)).toMatchObject({ hostId: 'host-2', status: 'ready', candidate: null })
  })

  test('Given 信任操作失败 When 映射错误 Then 只展示稳定错误码对应文案', () => {
    expect(getServerOpsTrustErrorMessage(new Error('SERVER_OPS_ACCESS_DENIED: secret'))).toBe('当前窗口无权管理服务器信任')
    expect(getServerOpsTrustErrorMessage(new Error('SERVER_OPS_OTHER_INSTANCE_ACTIVE'))).toBe('请先关闭其他 Proma 实例，再变更服务器信任')
    expect(getServerOpsTrustErrorMessage(new Error('SERVER_OPS_CONFIG_BUSY'))).toBe('服务器配置正忙，请稍后重试')
    expect(getServerOpsTrustErrorMessage(new Error('SERVER_OPS_TRUST_BUSY'))).toBe('服务器信任操作正忙，请稍后重试')
    expect(getServerOpsTrustErrorMessage(new Error('SERVER_OPS_TRUST_CANDIDATE_EXPIRED'))).toBe('本次确认已过期，请重新准备')
    expect(getServerOpsTrustErrorMessage(new Error('SERVER_OPS_TRUST_CONFLICT'))).toBe('服务器状态已变化，请刷新后重试')
    expect(getServerOpsTrustErrorMessage(new Error('SERVER_OPS_TRUST_NAME_MISMATCH'))).toBe('服务器名称不匹配')
    expect(getServerOpsTrustErrorMessage(new Error('SERVER_OPS_AUDIT_WRITE_FAILED'))).toBe('开始审计写入失败，信任未修改')
    expect(getServerOpsTrustErrorMessage(new Error('SERVER_OPS_TRUST_GUARD_RELEASE_FAILED'))).toBe('信任已更新，但本地实例保护释放失败，请重启应用后继续')
    expect(getServerOpsTrustErrorMessage(new Error('SERVER_OPS_CONFIG_OUTCOME_UNKNOWN'))).toBe('信任变更结果未知，请不要重复提交，并刷新核对')
    expect(getServerOpsTrustErrorMessage(new Error('password=secret'))).toBe('服务器信任操作失败')
  })

  test('Given 信任提交成功但刷新失败 When 用户再次点击提交 Then 不重放已完成操作', async () => {
    let reads = 0
    let commits = 0
    const projections: Array<{ candidate: ServerOpsTrustCandidate | null; warning: string | null }> = []
    const controller = createServerOpsTrustController({
      get: async () => { if (++reads > 1) throw new Error('read failed'); return createSnapshot() },
      prepare: async () => createCandidate(),
      commit: async () => { commits++; return { hostId: 'host-1', action: 'replace', affectedHostIds: ['host-1'], warning: 'SERVER_OPS_AUDIT_WRITE_FAILED' } },
      cancel: async () => undefined,
      publish: (value) => { projections.push(value) },
    })
    controller.activate()
    await controller.select('host-1')
    await controller.prepare('replace')
    await controller.commit('生产 API')
    expect(projections.at(-1)?.candidate).toBeNull()
    expect(projections.at(-1)?.warning).toBe('信任已更新，但结果审计记录写入失败')
    await controller.commit('生产 API')
    expect(commits).toBe(1)
    controller.dispose()
  })
})
