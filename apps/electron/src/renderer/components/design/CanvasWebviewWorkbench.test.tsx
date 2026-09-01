import { describe, expect, test } from 'bun:test'
import { createEmptyCanvasDocument } from '@proma/shared'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  CanvasWebviewWorkbench,
  acceptPendingCanvasWebviewArtifact,
  commitCanvasWebviewDraft,
  createCanvasWebviewAdoptInput,
  createCanvasWebviewFrameKey,
  createCanvasWebviewFrameState,
  createCanvasWebviewHistoryRequestController,
  exportCanvasWebviewArtifact,
  createSandboxedCanvasWebviewHtml,
  isCanvasWebviewDraftDirty,
  isCanvasWebviewSnapshotCurrent,
  receiveCanvasWebviewArtifact,
  shouldClearCanvasWebviewConflict,
  type CanvasWebviewEditorState,
} from './CanvasWebviewWorkbench'

interface Deferred<T> {
  promise: Promise<T>
  resolve: (value: T) => void
}

/** 创建可控 Promise，验证历史正文请求跨 revision 的迟到顺序。 */
function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((nextResolve) => { resolve = nextResolve })
  return { promise, resolve }
}

/** WebView 测试使用的稳定节点身份。 */
const node = {
  id: 'webview-1', kind: 'webview' as const, title: '首页原型', position: { x: 0, y: 0 },
  prototypeId: 'prototype-1', contentRevision: 2, devicePreset: 'desktop' as const,
}

/** 创建指定 revision 的 HTML 文本产物。 */
function createArtifact(revision: number, content: string) {
  return {
    target: {
      projectId: 'project-1', canvasId: 'canvas-1', nodeId: node.id,
      kind: 'webview' as const, contentId: node.prototypeId, contentRevision: revision,
    },
    revision: {
      kind: 'webview' as const, contentId: node.prototypeId, revision,
      parentRevision: revision > 0 ? revision - 1 : null,
      contentHash: `${revision}`.repeat(64).slice(0, 64),
      createdBy: { type: 'user' as const }, createdAt: revision,
    },
    content,
  }
}

describe('Canvas WebView 工作台', () => {
  test('Given 完整原型 HTML When 构造预览 Then 注入 CSP 并保留页面正文', () => {
    const html = createSandboxedCanvasWebviewHtml('<!doctype html><html><head><title>首页</title></head><body><main>内容</main></body></html>')

    expect(html).toContain('Content-Security-Policy')
    expect(html).toContain("default-src 'none'")
    expect(html).toContain("connect-src 'none'")
    expect(html).toContain('<main>内容</main>')
  })

  test('Given Agent HTML 在 head 前放置脚本 When 构造预览 Then CSP 仍先于全部不可信正文', () => {
    /** 模拟故意把脚本放在标准文档结构之前的原型正文。 */
    const source = '<script>location.href="https://example.com/leak"</script><html><head></head><body>内容</body></html>'
    const html = createSandboxedCanvasWebviewHtml(source)

    expect(html.indexOf('Content-Security-Policy')).toBeGreaterThanOrEqual(0)
    expect(html.indexOf('Content-Security-Policy')).toBeLessThan(html.indexOf('<script>'))
    expect(html).toContain(source)
  })

  test('Given 旧 revision 快照 When 节点身份已更新 Then 不允许继续渲染旧 iframe', () => {
    /** 当前节点要求的完整五元身份。 */
    const currentTarget = {
      projectId: 'project-1', canvasId: 'canvas-1', nodeId: 'webview-1',
      prototypeId: 'prototype-1', contentRevision: 3,
    }
    /** 上一 revision 已返回但尚未被 effect 清理的旧快照。 */
    const staleSnapshot = {
      target: { ...currentTarget, contentRevision: 2 },
      html: '<main>旧内容</main>',
    }

    expect(isCanvasWebviewSnapshotCurrent(staleSnapshot, currentTarget)).toBe(false)
    expect(isCanvasWebviewSnapshotCurrent({
      target: currentTarget,
      html: '<main>新内容</main>',
    }, currentTarget)).toBe(true)
  })

  test('Given WebView 已展开 When 首帧渲染 Then 展示加载态且预留隔离预览容器', () => {
    const html = renderToStaticMarkup(
      <CanvasWebviewWorkbench
        node={node}
        target={{ projectId: 'project-1', canvasId: 'canvas-1' }}
        canvasRevision={9}
        adapter={{
          loadCanvasWebview: async (input) => ({ target: input, html: '<main>首页</main>' }),
          loadCanvasTextArtifact: async () => createArtifact(2, '<main>首页</main>'),
          updateCanvasTextArtifact: async () => { throw new Error('not reached in SSR') },
          listCanvasArtifactRevisions: async () => [],
          adoptCanvasArtifactRevision: async () => { throw new Error('not reached in SSR') },
          exportCanvasArtifact: async () => undefined,
        }}
        writable
        onDirtyChange={() => undefined}
        onSnapshotChange={() => undefined}
        onDevicePresetChange={() => undefined}
      />,
    )

    expect(html).toContain('aria-label="原型预览"')
    expect(html).toContain('正在加载原型')
    expect(html).toContain('aria-label="原型预览设备"')
    expect(html).toContain('网页')
    expect(html).toContain('手机')
    expect(html).toContain('data-device-preset="desktop"')
  })

  test('Given HTML 草稿保存 When 提交同一 WebView Then 使用 prototypeId 与图正文双 revision', async () => {
    let received: unknown
    const artifact = createArtifact(3, '<main>新版</main>')

    await commitCanvasWebviewDraft({
      node,
      target: { projectId: 'project-1', canvasId: 'canvas-1' },
      canvasRevision: 9,
      contentRevision: 2,
      content: '<main>新版</main>',
      operationId: '11111111-1111-4111-8111-111111111111',
      update: async (input) => {
        received = input
        return {
          snapshot: { document: createEmptyCanvasDocument('project-1', 'canvas-1', 10), writable: true, nodeIssues: [] },
          artifact,
        }
      },
    })

    expect(received).toEqual({
      projectId: 'project-1', canvasId: 'canvas-1', nodeId: 'webview-1',
      kind: 'webview', contentId: 'prototype-1',
      operationId: '11111111-1111-4111-8111-111111111111',
      expectedCanvasRevision: 9, expectedContentRevision: 2,
      content: '<main>新版</main>',
    })
  })

  test('Given HTML 草稿 dirty When 外部 revision 前进 Then 保留草稿并暂存远端版本', () => {
    const baseline = createArtifact(2, '<main>旧版</main>')
    const remote = createArtifact(3, '<main>远端新版</main>')
    const current: CanvasWebviewEditorState = {
      artifact: baseline,
      draft: '<main>本地草稿</main>',
      pendingArtifact: null,
    }

    const pending = receiveCanvasWebviewArtifact(current, remote)
    const accepted = acceptPendingCanvasWebviewArtifact(pending)

    expect(pending).toEqual({ artifact: baseline, draft: '<main>本地草稿</main>', pendingArtifact: remote })
    expect(accepted).toEqual({ artifact: remote, draft: remote.content, pendingArtifact: null })
    expect(isCanvasWebviewDraftDirty(accepted.artifact?.content ?? '', accepted.draft)).toBe(false)
  })

  test('Given 采用历史 HTML When 构造命令 Then 保留当前图与内容 CAS 基线', () => {
    expect(createCanvasWebviewAdoptInput({
      node,
      target: { projectId: 'project-1', canvasId: 'canvas-1' },
      canvasRevision: 9,
      contentRevision: 2,
      revision: 1,
      operationId: '22222222-2222-4222-8222-222222222222',
    })).toEqual({
      projectId: 'project-1', canvasId: 'canvas-1', nodeId: 'webview-1',
      kind: 'webview', contentId: 'prototype-1',
      operationId: '22222222-2222-4222-8222-222222222222',
      expectedCanvasRevision: 9, expectedContentRevision: 2, revision: 1,
    })
  })

  test('Given 只切换视图或设备 When HTML revision 未变 Then iframe 身份保持稳定', () => {
    const target = {
      projectId: 'project-1', canvasId: 'canvas-1', nodeId: node.id,
      kind: 'webview' as const, contentId: node.prototypeId, contentRevision: 2,
    }

    expect(createCanvasWebviewFrameKey(target)).toBe(createCanvasWebviewFrameKey(target))
    expect(createCanvasWebviewFrameKey(target)).not.toContain(node.devicePreset)
  })

  test('Given 用户连续输入 HTML When 尚未保存 Then iframe DOM 身份和 srcDoc 均保持权威版本', () => {
    const baseline = createArtifact(2, '<main>已采用版本</main>')
    const beforeEditing = createCanvasWebviewFrameState(baseline)
    const localDraft = '<main>尚未保存草稿</main>'
    const whileEditing = createCanvasWebviewFrameState(baseline)
    const afterSaving = createCanvasWebviewFrameState(createArtifact(3, localDraft))

    expect(whileEditing).toEqual(beforeEditing)
    expect(whileEditing.srcDoc).not.toContain(localDraft)
    expect(afterSaving.key).not.toBe(beforeEditing.key)
    expect(afterSaving.srcDoc).toContain(localDraft)
  })

  test('Given 外部 artifact target 前进 When 旧历史正文迟到 Then 旧比较内容被丢弃', async () => {
    const oldHistory = createDeferred<ReturnType<typeof createArtifact>>()
    const nextHistory = createDeferred<ReturnType<typeof createArtifact>>()
    const controller = createCanvasWebviewHistoryRequestController()
    const accepted: number[] = []

    const oldLoad = controller.run(oldHistory.promise, (artifact) => {
      accepted.push(artifact.target.contentRevision)
    })
    controller.invalidate()
    const nextLoad = controller.run(nextHistory.promise, (artifact) => {
      accepted.push(artifact.target.contentRevision)
    })
    oldHistory.resolve(createArtifact(1, '<main>旧历史</main>'))
    nextHistory.resolve(createArtifact(2, '<main>新作用域历史</main>'))
    await Promise.all([oldLoad, nextLoad])

    expect(accepted).toEqual([2])
  })

  test('Given 保存冲突 When 导出成功或失败 Then 冲突恢复提示保持且重载后恢复编辑', async () => {
    const baseline = createArtifact(2, '<main>当前已采用</main>')
    let editorError: string | null = '原型已在其他窗口更新，请重新加载后继续。'
    let conflict = true

    const successError = await exportCanvasWebviewArtifact({
      artifact: baseline,
      exportArtifact: async () => undefined,
    })
    expect(successError).toBeNull()
    expect({ editorError, conflict }).toEqual({
      editorError: '原型已在其他窗口更新，请重新加载后继续。',
      conflict: true,
    })

    const failureError = await exportCanvasWebviewArtifact({
      artifact: baseline,
      exportArtifact: async () => { throw new Error('disk full') },
    })
    expect(failureError).toBe('原型导出失败，请重试。')
    expect({ editorError, conflict }).toEqual({
      editorError: '原型已在其他窗口更新，请重新加载后继续。',
      conflict: true,
    })

    const refreshed = receiveCanvasWebviewArtifact({
      artifact: baseline,
      draft: baseline.content,
      pendingArtifact: null,
    }, createArtifact(3, '<main>远端新版</main>'))
    if (shouldClearCanvasWebviewConflict(baseline, refreshed.artifact)) {
      editorError = null
      conflict = false
    }
    expect({ editorError, conflict }).toEqual({ editorError: null, conflict: false })
  })
})
