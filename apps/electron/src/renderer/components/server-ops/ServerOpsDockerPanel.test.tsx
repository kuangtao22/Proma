import { describe, expect, test } from 'bun:test'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type {
  ServerOpsDockerAction,
  ServerOpsDockerActionCandidate,
  ServerOpsDockerActionResult,
  ServerOpsDockerContainerDetail,
  ServerOpsDockerResourcesResult,
} from '@proma/shared'
import {
  createServerOpsDockerController,
  getServerOpsDockerErrorMessage,
  ServerOpsDockerPanelView,
} from './ServerOpsDockerPanel'
import type { ServerOpsDockerProjection } from './ServerOpsDockerPanel'

interface Deferred<T> {
  promise: Promise<T>
  resolve: (value: T) => void
}

/** 创建可控 Promise，用于验证 Docker 请求竞态。 */
function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((nextResolve) => { resolve = nextResolve })
  return { promise, resolve }
}

/** Docker 测试使用的完整容器身份。 */
const CONTAINER_ID = 'a'.repeat(64)

/** 创建只含公开白名单字段的容器详情。 */
function createDetail(hostId = 'host-1'): ServerOpsDockerContainerDetail {
  void hostId
  return {
    containerId: CONTAINER_ID,
    name: 'api',
    image: 'registry.example/api:1.0',
    imageId: `sha256:${'b'.repeat(64)}`,
    createdAt: '2026-09-07T00:00:00Z',
    platform: 'linux/amd64',
    state: 'running',
    running: true,
    exitCode: 0,
    restartCount: 2,
    ports: [{ privatePort: 3000, protocol: 'tcp', publicPort: 8080, address: '127.0.0.1' }],
    mounts: [{ type: 'volume', name: 'api-data', destination: '/data', readOnly: false }],
  }
}

/** 创建覆盖四类资源的 Docker 快照。 */
function createResources(hostId = 'host-1'): ServerOpsDockerResourcesResult {
  return {
    hostId,
    capability: 'available',
    containers: [{
      containerId: CONTAINER_ID,
      names: ['api'],
      image: 'registry.example/api:1.0',
      imageId: `sha256:${'b'.repeat(64)}`,
      state: 'running',
      status: 'Up 4 hours',
      createdAt: '2026-09-07T00:00:00Z',
      publishedPorts: ['127.0.0.1:8080->3000/tcp'],
      mountNames: ['api-data'],
    }],
    images: [{ imageId: `sha256:${'b'.repeat(64)}`, repository: 'registry.example/api', tag: '1.0', digest: '<none>', createdAt: '2026-09-07T00:00:00Z', size: '120MB' }],
    networks: [{ networkId: 'c'.repeat(64), name: 'frontend', driver: 'bridge', scope: 'local', internal: false }],
    volumes: [{ name: 'api-data', driver: 'local', scope: 'local' }],
    warnings: [],
  }
}

/** 从当前容器详情创建短期动作候选。 */
function createCandidate(action: ServerOpsDockerAction = 'restart'): ServerOpsDockerActionCandidate {
  return { candidateId: 'candidate-1', hostId: 'host-1', action, container: createDetail(), expiresAt: Date.now() + 300_000 }
}

/** 创建可观察的 Docker 控制器测试环境。 */
function createHarness() {
  const projections: ServerOpsDockerProjection[] = []
  const notices: Array<{ kind: 'success' | 'warning' | 'error'; message: string }> = []
  const calls = {
    list: [] as string[],
    detail: [] as Array<{ hostId: string; containerId: string }>,
    prepare: [] as Array<{ hostId: string; containerId: string; action: ServerOpsDockerAction }>,
    commit: [] as Array<{ hostId: string; candidateId: string }>,
    cancel: [] as Array<{ hostId: string; candidateId: string }>,
  }
  let list = async ({ hostId }: { hostId: string }) => { calls.list.push(hostId); return createResources(hostId) }
  let detail = async (input: { hostId: string; containerId: string }) => { calls.detail.push(input); return { hostId: input.hostId, capability: 'available' as const, container: createDetail(input.hostId), warnings: [] } }
  let prepare = async (input: { hostId: string; containerId: string; action: ServerOpsDockerAction }) => { calls.prepare.push(input); return createCandidate(input.action) }
  let commit = async (input: { hostId: string; candidateId: string }): Promise<ServerOpsDockerActionResult> => { calls.commit.push(input); return { hostId: input.hostId, containerId: CONTAINER_ID, action: 'restart', container: createDetail(input.hostId), warnings: [] } }
  const controller = createServerOpsDockerController({
    listResources: (input) => list(input),
    getContainerDetail: (input) => detail(input),
    prepareAction: (input) => prepare(input),
    commitAction: (input) => commit(input),
    cancelAction: async (input) => { calls.cancel.push(input) },
    publish: (projection) => { projections.push(projection) },
    notify: (kind, message) => { notices.push({ kind, message }) },
  })
  controller.activate()
  return {
    controller, calls, projections, notices,
    setList: (next: typeof list) => { list = next },
    setDetail: (next: typeof detail) => { detail = next },
    setPrepare: (next: typeof prepare) => { prepare = next },
    setCommit: (next: typeof commit) => { commit = next },
  }
}

describe('Server Ops Docker 面板', () => {
  test('Given 四类资源和容器详情 When 渲染 Then tabs、列表与 inspect 白名单可见', () => {
    const html = renderToStaticMarkup(
      <ServerOpsDockerPanelView
        hostLabel="生产 API"
        hostDescription="deploy@10.0.0.8:22"
        connected
        projection={{
          hostId: 'host-1', status: 'ready', resources: createResources(), error: null,
          selectedContainerId: CONTAINER_ID, detailStatus: 'ready', detail: { hostId: 'host-1', capability: 'available', container: createDetail(), warnings: [] },
          detailError: null, candidate: null, preparingContainerId: null, committing: false,
        }}
        activeTab="containers"
        onTabChange={() => undefined}
        onRefresh={() => undefined}
        onSelectContainer={() => undefined}
        onRequestAction={() => undefined}
        onOpenContainerLogs={() => undefined}
        onOpenContainerConsole={() => undefined}
        onCancelAction={() => undefined}
        onConfirmAction={() => undefined}
      />,
    )
    expect(html).toContain('容器 1')
    expect(html).toContain('镜像 1')
    expect(html).toContain('网络 1')
    expect(html).toContain('卷 1')
    expect(html).toContain('api')
    expect(html).toContain('linux/amd64')
    expect(html).toContain('127.0.0.1:8080')
    expect(html).toContain('/data')
    expect(html).not.toContain('Env')
    expect(html).not.toContain('Entrypoint')
    expect(html).not.toContain('Mount source')
    expect(html).toContain('data-server-ops-docker-detail-grid="true"')
    expect(html).toContain('@container (min-width: 700px)')
    expect(html).toContain('aria-label="重启容器 api"')
    expect(html).toContain('aria-label="查看容器 api 日志"')
    expect(html).toContain('aria-label="打开容器 api 终端"')
  })

  test('Given 不同能力、错误与空快照 When 渲染 Then 展示明确恢复原因且没有未实现按钮', () => {
    for (const [capability, message] of [
      ['cli-missing', '未安装 Docker CLI'],
      ['daemon-unavailable', 'Docker daemon 不可用'],
      ['permission-denied', '当前账号无权访问 Docker daemon'],
    ] as const) {
      const resources = { ...createResources(), capability, containers: [], images: [], networks: [], volumes: [] }
      const html = renderToStaticMarkup(
        <ServerOpsDockerPanelView
          connected hostLabel="生产 API" projection={{ hostId: 'host-1', status: 'ready', resources, error: null,
            selectedContainerId: null, detailStatus: 'idle', detail: null, detailError: null, candidate: null,
            preparingContainerId: null, committing: false }} activeTab="containers" onTabChange={() => undefined}
          onRefresh={() => undefined} onSelectContainer={() => undefined} onRequestAction={() => undefined}
          onCancelAction={() => undefined} onConfirmAction={() => undefined}
        />,
      )
      expect(html).toContain(message)
      expect(html).not.toContain('查看日志')
      expect(html).not.toContain('打开终端')
    }
    const emptyHtml = renderToStaticMarkup(
      <ServerOpsDockerPanelView
        connected hostLabel="生产 API" projection={{ hostId: 'host-1', status: 'ready', resources: { ...createResources(), containers: [] }, error: null,
          selectedContainerId: null, detailStatus: 'idle', detail: null, detailError: null, candidate: null,
          preparingContainerId: null, committing: false }} activeTab="containers" onTabChange={() => undefined}
        onRefresh={() => undefined} onSelectContainer={() => undefined} onRequestAction={() => undefined}
        onCancelAction={() => undefined} onConfirmAction={() => undefined}
      />,
    )
    expect(emptyHtml).toContain('没有可显示的容器')
  })

  test('Given 用户请求动作 When prepare 完成 Then 只显示确认事实且尚未 commit', async () => {
    const harness = createHarness()
    await harness.controller.select({ hostId: 'host-1', active: true, connected: true })
    await harness.controller.selectContainer(CONTAINER_ID)
    await harness.controller.requestAction(CONTAINER_ID, 'restart')

    expect(harness.calls.prepare).toHaveLength(1)
    expect(harness.calls.commit).toEqual([])
    expect(harness.projections.at(-1)?.candidate).toMatchObject({ candidateId: 'candidate-1', action: 'restart' })
    const projection = harness.projections.at(-1)!
    const html = renderToStaticMarkup(
      <ServerOpsDockerPanelView hostLabel="生产 API" hostDescription="deploy@10.0.0.8:22" connected projection={projection}
        activeTab="containers" onTabChange={() => undefined} onRefresh={() => undefined} onSelectContainer={() => undefined}
        onRequestAction={() => undefined} onCancelAction={() => undefined} onConfirmAction={() => undefined} />,
    )
    expect(html).toContain('服务器：生产 API')
    expect(html).toContain('连接：deploy@10.0.0.8:22')
    expect(html).toContain('容器：api')
    expect(html).toContain(`完整 ID：${CONTAINER_ID}`)
    expect(html).toContain('动作：重启')
  })

  test('Given 候选已准备 When 取消 Then 精确 cancel 且不能再提交', async () => {
    const harness = createHarness()
    await harness.controller.select({ hostId: 'host-1', active: true, connected: true })
    await harness.controller.requestAction(CONTAINER_ID, 'stop')
    await harness.controller.cancelAction()
    await harness.controller.confirmAction()

    expect(harness.calls.cancel).toEqual([{ hostId: 'host-1', candidateId: 'candidate-1' }])
    expect(harness.calls.commit).toEqual([])
    expect(harness.projections.at(-1)?.candidate).toBeNull()
  })

  test('Given 候选已准备 When 重复确认 Then 只 commit 一次并回读资源与详情', async () => {
    const harness = createHarness()
    const result = createDeferred<ServerOpsDockerActionResult>()
    harness.setCommit((input) => { harness.calls.commit.push(input); return result.promise })
    await harness.controller.select({ hostId: 'host-1', active: true, connected: true })
    await harness.controller.selectContainer(CONTAINER_ID)
    await harness.controller.requestAction(CONTAINER_ID, 'restart')

    const first = harness.controller.confirmAction()
    const duplicate = harness.controller.confirmAction()
    expect(harness.calls.commit).toEqual([{ hostId: 'host-1', candidateId: 'candidate-1' }])
    result.resolve({ hostId: 'host-1', containerId: CONTAINER_ID, action: 'restart', container: createDetail(), warnings: [] })
    await Promise.all([first, duplicate])

    expect(harness.calls.commit).toHaveLength(1)
    expect(harness.calls.list).toEqual(['host-1', 'host-1'])
    expect(harness.calls.detail).toHaveLength(2)
    expect(harness.notices).toContainEqual({ kind: 'success', message: '容器重启操作已完成，状态已重新读取' })
  })

  test('Given 旧主机 list/detail/prepare 迟到 When 切换主机 Then 旧结果不显示且迟到候选被取消', async () => {
    const harness = createHarness()
    const oldList = createDeferred<ServerOpsDockerResourcesResult>()
    const newList = createDeferred<ServerOpsDockerResourcesResult>()
    harness.setList(({ hostId }) => { harness.calls.list.push(hostId); return hostId === 'host-1' ? oldList.promise : newList.promise })
    void harness.controller.select({ hostId: 'host-1', active: true, connected: true })
    void harness.controller.select({ hostId: 'host-2', active: true, connected: true })
    oldList.resolve(createResources('host-1'))
    newList.resolve(createResources('host-2'))
    await Promise.all([oldList.promise, newList.promise])
    await Promise.resolve()
    expect(harness.projections.at(-1)?.hostId).toBe('host-2')
    expect(harness.projections.at(-1)?.resources?.hostId).toBe('host-2')

    const prepare = createDeferred<ServerOpsDockerActionCandidate>()
    harness.setPrepare((input) => { harness.calls.prepare.push(input); return prepare.promise })
    void harness.controller.requestAction(CONTAINER_ID, 'start')
    void harness.controller.select({ hostId: 'host-3', active: true, connected: true })
    prepare.resolve({ ...createCandidate('start'), hostId: 'host-2', candidateId: 'candidate-late' })
    await prepare.promise
    await Promise.resolve()
    expect(harness.calls.cancel).toContainEqual({ hostId: 'host-2', candidateId: 'candidate-late' })
    expect(harness.projections.at(-1)?.hostId).toBe('host-3')
    expect(harness.projections.at(-1)?.candidate).toBeNull()
  })

  test('Given Docker 稳定错误码 When 映射用户文案 Then 不展示 daemon 或命令原始异常', () => {
    expect(getServerOpsDockerErrorMessage(new Error('SERVER_OPS_DOCKER_ACTION_BUSY'))).toBe('该容器已有操作正在执行，请等待完成')
    expect(getServerOpsDockerErrorMessage(new Error('SERVER_OPS_DOCKER_ACTION_CONFLICT'))).toBe('容器或连接状态已变化，请重新准备')
    expect(getServerOpsDockerErrorMessage(new Error('SERVER_OPS_DOCKER_ACTION_EXPIRED'))).toBe('本次确认已过期，请重新准备')
    expect(getServerOpsDockerErrorMessage(new Error('SERVER_OPS_DOCKER_OUTPUT_INVALID'))).toBe('Docker 返回的数据无效，请刷新后重试')
    expect(getServerOpsDockerErrorMessage(new Error('dial unix /var/run/docker.sock: permission denied secret')))
      .toBe('Docker 资源暂时不可用，请稍后重试')
  })
})
