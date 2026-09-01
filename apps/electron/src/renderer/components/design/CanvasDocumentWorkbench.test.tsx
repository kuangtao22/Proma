import { describe, expect, test } from 'bun:test'
import { createEmptyCanvasDocument } from '@proma/shared'
import * as React from 'react'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { CanvasPublicOperationError } from '@/lib/design-adapter'
import {
  CanvasDocumentWorkbench,
  acceptPendingCanvasDocumentArtifact,
  commitCanvasDocumentDraft,
  createCanvasDocumentRequestController,
  createCanvasDocumentAdoptInput,
  getCanvasDocumentActionError,
  getCanvasDocumentRefreshFailureState,
  isCanvasDocumentDraftDirty,
  receiveCanvasDocumentArtifact,
  shouldClearCanvasDocumentConflict,
  type CanvasDocumentEditorState,
  useCanvasDocumentArtifactRequest,
} from './CanvasDocumentWorkbench'

interface Deferred<T> {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (reason: unknown) => void
}

/** 创建可控 Promise，用于精确验证正文与版本请求的完成顺序。 */
function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve
    reject = nextReject
  })
  return { promise, resolve, reject }
}

interface MinimalEventTarget {
  addEventListener: () => void
  removeEventListener: () => void
}

/** 创建仅运行 Hook 且不产生 DOM 子节点的最小 React 宿主。 */
function createHookRoot(): {
  render: (node: React.ReactElement) => void
  unmount: () => void
  restore: () => void
} {
  const eventTarget: MinimalEventTarget = { addEventListener: () => undefined, removeEventListener: () => undefined }
  class FakeHtmlIFrameElement {}
  const fakeWindow = { ...eventTarget, event: undefined, HTMLIFrameElement: FakeHtmlIFrameElement }
  const fakeDocument = {
    ...eventTarget,
    nodeType: 9,
    defaultView: fakeWindow,
    activeElement: null,
    body: null,
    documentElement: { namespaceURI: 'http://www.w3.org/1999/xhtml' },
  }
  const container = {
    ...eventTarget,
    nodeType: 1,
    tagName: 'DIV',
    namespaceURI: 'http://www.w3.org/1999/xhtml',
    ownerDocument: fakeDocument,
  }
  const globals = globalThis as unknown as { window?: unknown; document?: unknown; IS_REACT_ACT_ENVIRONMENT?: boolean }
  const previousWindow = globals.window
  const previousDocument = globals.document
  const previousActEnvironment = globals.IS_REACT_ACT_ENVIRONMENT
  globals.window = fakeWindow
  globals.document = fakeDocument
  globals.IS_REACT_ACT_ENVIRONMENT = true
  const root = createRoot(container as unknown as Element)
  return {
    render: (node) => { root.render(node) },
    unmount: () => { root.unmount() },
    restore: () => {
      globals.window = previousWindow
      globals.document = previousDocument
      globals.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment
    },
  }
}

interface ArtifactRequestProbeProps {
  targetKey: string
  load: () => Promise<string>
  onSuccess: (value: string) => void
}

/** 通过真实 Effect 验证正文请求在 StrictMode 与目标切换下的生命周期。 */
function ArtifactRequestProbe(props: ArtifactRequestProbeProps): null {
  const [, setLoadedValue] = React.useState<string | null>(null)
  useCanvasDocumentArtifactRequest({
    targetKey: props.targetKey,
    retryGeneration: 0,
    load: props.load,
    onSuccess: (value) => {
      setLoadedValue(value)
      props.onSuccess(value)
    },
    onFailure: () => undefined,
  })
  return null
}

/** 文档测试使用的稳定节点身份。 */
const node = {
  id: 'doc-1', kind: 'document' as const, title: '需求说明', position: { x: 0, y: 0 },
  documentId: 'content-1', contentRevision: 2,
}

/** 创建指定 revision 的文档正文快照。 */
function createArtifact(revision: number, content: string) {
  return {
    target: {
      projectId: 'project-1', canvasId: 'canvas-1', nodeId: node.id,
      kind: 'document' as const, contentId: node.documentId, contentRevision: revision,
    },
    revision: {
      kind: 'document' as const, contentId: node.documentId, revision,
      parentRevision: revision > 0 ? revision - 1 : null,
      contentHash: `${revision}`.repeat(64).slice(0, 64),
      createdBy: { type: 'user' as const }, createdAt: revision,
    },
    content,
  }
}

describe('Canvas 文档工作台', () => {
  test('Given 保存冲突后重试成功 When 远端正文实际接管 Then 解除只读与保存禁用状态', () => {
    const baseline = createArtifact(2, '# 本地基线')
    const remote = createArtifact(3, '# 远端新版')
    const accepted = receiveCanvasDocumentArtifact({
      artifact: baseline,
      draft: '# 本地基线',
      pendingArtifact: null,
    }, remote)
    let conflict = true
    let error: string | null = '文档已在其他窗口更新'
    if (shouldClearCanvasDocumentConflict(baseline, accepted.artifact)) {
      conflict = false
      error = null
    }

    expect(accepted.artifact).toBe(remote)
    expect(conflict).toBe(false)
    expect(error).toBeNull()
    expect(!conflict && isCanvasDocumentDraftDirty(accepted.artifact?.content ?? '', '# 可继续编辑')).toBe(true)
  })

  test('Given dirty 保存冲突 When 重试只得到 pending 远端版本 Then 不提前解除冲突', () => {
    const baseline = createArtifact(2, '# 本地基线')
    const pending = receiveCanvasDocumentArtifact({
      artifact: baseline,
      draft: '# 本地草稿',
      pendingArtifact: null,
    }, createArtifact(3, '# 远端新版'))

    expect(pending.artifact).toBe(baseline)
    expect(pending.pendingArtifact?.target.contentRevision).toBe(3)
    expect(shouldClearCanvasDocumentConflict(baseline, pending.artifact)).toBe(false)
  })

  test('Given dirty 基线刷新失败 When 重试失败后再次成功 Then 草稿和旧 CAS revision 全程不变', async () => {
    const baseline = createArtifact(2, '# 本地基线')
    const originalState: CanvasDocumentEditorState = {
      artifact: baseline,
      draft: '# 本地草稿',
      pendingArtifact: null,
    }
    let editorState = originalState
    let refreshState = getCanvasDocumentRefreshFailureState(true, '刷新失败')
    const controller = createCanvasDocumentRequestController()

    const firstFailure = createDeferred<ReturnType<typeof createArtifact>>()
    const firstLoad = controller.run('revision-3', firstFailure.promise,
      (artifact) => { editorState = receiveCanvasDocumentArtifact(editorState, artifact) },
      () => { refreshState = getCanvasDocumentRefreshFailureState(true, '刷新失败') },
    )
    firstFailure.reject(new Error('offline'))
    await firstLoad
    expect(editorState).toBe(originalState)
    expect(refreshState).toEqual({ phase: 'ready', blockingError: null, refreshError: '刷新失败' })

    const retryFailure = createDeferred<ReturnType<typeof createArtifact>>()
    const retryFailedLoad = controller.run('revision-3', retryFailure.promise,
      (artifact) => { editorState = receiveCanvasDocumentArtifact(editorState, artifact) },
      () => { refreshState = getCanvasDocumentRefreshFailureState(true, '刷新失败') },
    )
    retryFailure.reject(new Error('still offline'))
    await retryFailedLoad
    expect(editorState).toBe(originalState)

    const retrySuccess = createDeferred<ReturnType<typeof createArtifact>>()
    const retrySucceededLoad = controller.run('revision-3', retrySuccess.promise,
      (artifact) => { editorState = receiveCanvasDocumentArtifact(editorState, artifact) },
    )
    retrySuccess.resolve(createArtifact(3, '# 远端新版'))
    await retrySucceededLoad
    expect(editorState).toEqual({
      artifact: baseline,
      draft: '# 本地草稿',
      pendingArtifact: createArtifact(3, '# 远端新版'),
    })

    let expectedContentRevision: number | undefined
    await commitCanvasDocumentDraft({
      node: { ...node, contentRevision: editorState.artifact?.target.contentRevision ?? -1 },
      target: { projectId: 'project-1', canvasId: 'canvas-1' },
      canvasRevision: 9,
      content: editorState.draft,
      operationId: '33333333-3333-4333-8333-333333333333',
      update: async (input) => {
        expectedContentRevision = input.expectedContentRevision
        return { snapshot: { document: createEmptyCanvasDocument('project-1', 'canvas-1', 1), writable: true, nodeIssues: [] }, artifact: baseline }
      },
    })
    expect(expectedContentRevision).toBe(2)
  })

  test('Given 本地草稿 dirty When 外部正文 revision 前进 Then 保留旧基线和草稿并暂存远端版本', () => {
    const baseline = createArtifact(2, '# 本地基线')
    const remote = createArtifact(3, '# 远端新版')
    const current: CanvasDocumentEditorState = {
      artifact: baseline,
      draft: '# 本地草稿',
      pendingArtifact: null,
    }

    const next = receiveCanvasDocumentArtifact(current, remote)

    expect(next).toEqual({ artifact: baseline, draft: '# 本地草稿', pendingArtifact: remote })
    expect(next.artifact?.target.contentRevision).toBe(2)
  })

  test('Given 已暂存远端版本 When 显式加载新版本 Then 接管远端基线并清除 dirty', () => {
    const remote = createArtifact(3, '# 远端新版')
    const next = acceptPendingCanvasDocumentArtifact({
      artifact: createArtifact(2, '# 本地基线'),
      draft: '# 本地草稿',
      pendingArtifact: remote,
    })

    expect(next).toEqual({ artifact: remote, draft: '# 远端新版', pendingArtifact: null })
    expect(isCanvasDocumentDraftDirty(next.artifact?.content ?? '', next.draft)).toBe(false)
  })

  test('Given 当前正文非 dirty When 外部正文 revision 前进 Then 自动接管远端正文', () => {
    const remote = createArtifact(3, '# 远端新版')
    const next = receiveCanvasDocumentArtifact({
      artifact: createArtifact(2, '# 本地基线'),
      draft: '# 本地基线',
      pendingArtifact: null,
    }, remote)

    expect(next).toEqual({ artifact: remote, draft: '# 远端新版', pendingArtifact: null })
  })

  test('Given 两个远端 revision 请求乱序 When 旧响应迟到 Then 不覆盖最新 pending 版本', async () => {
    const oldRequest = createDeferred<ReturnType<typeof createArtifact>>()
    const nextRequest = createDeferred<ReturnType<typeof createArtifact>>()
    const controller = createCanvasDocumentRequestController()
    let state: CanvasDocumentEditorState = {
      artifact: createArtifact(2, '# 本地基线'),
      draft: '# 本地草稿',
      pendingArtifact: null,
    }
    const receive = (artifact: ReturnType<typeof createArtifact>): void => {
      state = receiveCanvasDocumentArtifact(state, artifact)
    }

    const oldLoad = controller.run('revision-3', oldRequest.promise, receive)
    const nextLoad = controller.run('revision-4', nextRequest.promise, receive)
    nextRequest.resolve(createArtifact(4, '# 远端第四版'))
    await nextLoad
    oldRequest.resolve(createArtifact(3, '# 迟到第三版'))
    await oldLoad

    expect(state.pendingArtifact?.target.contentRevision).toBe(4)
    expect(state.draft).toBe('# 本地草稿')
  })

  test('Given StrictMode 重放正文 Effect When 第二代请求完成 Then 正文仍能成功接管且不会无限重载', async () => {
    const requests: Array<Deferred<string>> = []
    const accepted: string[] = []
    const host = createHookRoot()
    try {
      await act(async () => {
        host.render(
          <React.StrictMode>
            <ArtifactRequestProbe
              targetKey="doc-a"
              load={() => {
                const request = createDeferred<string>()
                requests.push(request)
                return request.promise
              }}
              onSuccess={(value) => accepted.push(value)}
            />
          </React.StrictMode>,
        )
      })
      expect(requests).toHaveLength(2)

      await act(async () => {
        requests[1]?.resolve('正文完成')
        await requests[1]?.promise
      })
      expect(accepted).toEqual(['正文完成'])
      expect(requests).toHaveLength(2)
    } finally {
      act(() => { host.unmount() })
      host.restore()
    }
  })

  test('Given 正文目标切换 When 旧请求在切换后返回 Then 旧响应被丢弃且新响应正常接管', async () => {
    const oldRequest = createDeferred<string>()
    const nextRequest = createDeferred<string>()
    const accepted: string[] = []
    const host = createHookRoot()
    try {
      await act(async () => {
        host.render(<ArtifactRequestProbe targetKey="doc-a" load={() => oldRequest.promise} onSuccess={(value) => accepted.push(value)} />)
      })
      await act(async () => {
        host.render(<ArtifactRequestProbe targetKey="doc-b" load={() => nextRequest.promise} onSuccess={(value) => accepted.push(value)} />)
      })
      await act(async () => {
        oldRequest.resolve('旧正文')
        nextRequest.resolve('新正文')
        await Promise.all([oldRequest.promise, nextRequest.promise])
      })

      expect(accepted).toEqual(['新正文'])
    } finally {
      act(() => { host.unmount() })
      host.restore()
    }
  })

  test('Given 正文与版本并行加载 When 正文先返回 Then 版本请求仍可独立完成', async () => {
    const artifactRequest = createDeferred<string>()
    const revisionsRequest = createDeferred<string[]>()
    const artifactController = createCanvasDocumentRequestController()
    const revisionsController = createCanvasDocumentRequestController()
    const accepted: string[] = []

    const artifactLoad = artifactController.run('doc-a', artifactRequest.promise, (value) => accepted.push(value))
    const revisionsLoad = revisionsController.run('doc-a', revisionsRequest.promise, (value) => accepted.push(...value))
    artifactRequest.resolve('正文')
    await artifactLoad
    expect(accepted).toEqual(['正文'])

    revisionsRequest.resolve(['v2', 'v1'])
    await revisionsLoad
    expect(accepted).toEqual(['正文', 'v2', 'v1'])
  })

  test('Given 文档目标已切换 When 旧目标响应迟到 Then 只接管新目标响应', async () => {
    const oldRequest = createDeferred<string>()
    const nextRequest = createDeferred<string>()
    const controller = createCanvasDocumentRequestController()
    const accepted: string[] = []

    const oldLoad = controller.run('doc-a', oldRequest.promise, (value) => accepted.push(value))
    const nextLoad = controller.run('doc-b', nextRequest.promise, (value) => accepted.push(value))
    nextRequest.resolve('新正文')
    await nextLoad
    oldRequest.resolve('旧正文')
    await oldLoad

    expect(accepted).toEqual(['新正文'])
  })

  test('Given 文档详情已编辑 When 保存 Then 使用当前 Canvas 与正文 revision 并返回权威快照', async () => {
    const document = createEmptyCanvasDocument('project-1', 'canvas-1', 1)
    document.revision = 5
    document.nodes = [{ ...node, contentRevision: 3 }]
    const result = {
      snapshot: { document, writable: true as const, nodeIssues: [] },
      artifact: {
        target: {
          projectId: 'project-1', canvasId: 'canvas-1', nodeId: node.id,
          kind: 'document' as const, contentId: node.documentId, contentRevision: 3,
        },
        revision: {
          kind: 'document' as const, contentId: node.documentId, revision: 3, parentRevision: 2,
          contentHash: 'a'.repeat(64), createdBy: { type: 'user' as const }, createdAt: 2,
        },
        content: '# 第二版',
      },
    }
    const requests: unknown[] = []

    const saved = await commitCanvasDocumentDraft({
      node,
      target: { projectId: 'project-1', canvasId: 'canvas-1' },
      canvasRevision: 4,
      content: '# 第二版',
      operationId: '11111111-1111-4111-8111-111111111111',
      update: async (input) => { requests.push(input); return result },
    })

    expect(requests).toEqual([{
      projectId: 'project-1', canvasId: 'canvas-1', nodeId: 'doc-1',
      kind: 'document', contentId: 'content-1',
      operationId: '11111111-1111-4111-8111-111111111111',
      expectedCanvasRevision: 4, expectedContentRevision: 2, content: '# 第二版',
    }])
    expect(saved).toBe(result)
    expect(isCanvasDocumentDraftDirty('# 初稿', '# 第二版')).toBe(true)
    expect(isCanvasDocumentDraftDirty('# 第二版', '# 第二版')).toBe(false)
  })

  test('Given 选择历史修订 When 采用 Then 绑定当前双重 revision 与目标 revision', () => {
    expect(createCanvasDocumentAdoptInput({
      node,
      target: { projectId: 'project-1', canvasId: 'canvas-1' },
      canvasRevision: 6,
      revision: 1,
      operationId: '22222222-2222-4222-8222-222222222222',
    })).toEqual({
      projectId: 'project-1', canvasId: 'canvas-1', nodeId: 'doc-1',
      kind: 'document', contentId: 'content-1',
      operationId: '22222222-2222-4222-8222-222222222222',
      expectedCanvasRevision: 6, expectedContentRevision: 2, revision: 1,
    })
  })

  test('Given 文档首次打开或只读 When 首帧渲染 Then 展示加载态并保留只读语义', () => {
    const adapter = {
      loadCanvasTextArtifact: async () => { throw new Error('not reached in SSR') },
      updateCanvasTextArtifact: async () => { throw new Error('not reached in SSR') },
      listCanvasArtifactRevisions: async () => [],
      adoptCanvasArtifactRevision: async () => { throw new Error('not reached in SSR') },
      exportCanvasArtifact: async () => undefined,
    }
    const html = renderToStaticMarkup(
      <CanvasDocumentWorkbench
        node={node}
        target={{ projectId: 'project-1', canvasId: 'canvas-1' }}
        canvasRevision={4}
        adapter={adapter}
        writable={false}
        onDirtyChange={() => undefined}
        onSnapshotChange={() => undefined}
      />,
    )

    expect(html).toContain('aria-label="文档工作台内容"')
    expect(html).toContain('正在加载文档')
    expect(html).toContain('data-workspace-writable="false"')
  })

  test('Given 保存发生 revision 冲突 When 识别错误 Then 使用稳定冲突状态', () => {
    const error = new CanvasPublicOperationError('CANVAS_ARTIFACT_REVISION_CONFLICT', '内容已更新')
    expect(getCanvasDocumentActionError(error, '保存失败')).toEqual({
      message: '文档已在其他窗口更新，请重新加载后继续。',
      conflict: true,
    })
  })
})
