import { describe, expect, test } from 'bun:test'
import type {
  CanvasDocument,
  CanvasDocumentNode,
  CanvasTextArtifactKind,
  CanvasWebviewNode,
  CanvasWorkspaceSnapshot,
} from '@proma/shared'
import type {
  CanvasArtifactRevisionRecord,
  CanvasArtifactRevisionStore,
  CanvasArtifactRevisionSnapshot,
} from './canvas-artifact-revision-store'
import {
  createCanvasTextArtifactAdapter,
  createCanvasTextArtifactGraphWriter,
  createCanvasTextArtifactService,
  type CanvasTextArtifactGraphCommitInput,
} from './canvas-text-artifact-service'
import {
  DOCUMENT_ARTIFACT_DESCRIPTOR,
  WEBVIEW_ARTIFACT_DESCRIPTOR,
} from './canvas-artifact-registry'

/** 测试使用的固定文档节点。 */
const documentNode: CanvasDocumentNode = {
  id: 'doc-1', kind: 'document', title: '需求', position: { x: 0, y: 0 },
  documentId: 'content-1', contentRevision: 2,
}

/** 测试使用的固定 WebView 节点。 */
const webviewNode: CanvasWebviewNode = {
  id: 'web-1', kind: 'webview', title: '原型', position: { x: 320, y: 0 },
  prototypeId: 'prototype-1', contentRevision: 3, devicePreset: 'desktop',
}

/** 创建包含两类文本节点的权威图。 */
function createDocument(revision = 7): CanvasDocument {
  return {
    schemaVersion: 4,
    projectId: 'project-1',
    canvasId: 'canvas-1',
    revision,
    viewport: { x: 0, y: 0, zoom: 1 },
    nodes: [structuredClone(documentNode), structuredClone(webviewNode)],
    edges: [],
    createdAt: 1,
    updatedAt: 1,
  }
}

/** 从不可变版本记录构造正文快照。 */
function createRevisionSnapshot(
  kind: CanvasTextArtifactKind,
  contentId: string,
  revision: number,
  content: string,
): CanvasArtifactRevisionSnapshot {
  return {
    record: {
      schemaVersion: 1,
      kind,
      contentId,
      revision,
      parentRevision: revision === 0 ? null : revision - 1,
      contentHash: 'a'.repeat(64),
      createdBy: { type: 'user' },
      createdAt: revision + 1,
      state: 'committed',
    },
    content,
  }
}

/** 创建只覆盖文本产物事务的内存 fixture。 */
function createFixture(options: { failCommitOnce?: boolean } = {}) {
  /** 当前权威图，Graph Writer 提交后原地替换。 */
  let currentDocument = createDocument()
  /** 版本正文按类别、内容 ID 和 revision 精确索引。 */
  const snapshots = new Map<string, CanvasArtifactRevisionSnapshot>([
    ['document:content-1:2', createRevisionSnapshot('document', 'content-1', 2, '# 第二版')],
    ['webview:prototype-1:1', createRevisionSnapshot('webview', 'prototype-1', 1, '<main>第一版</main>')],
    ['webview:prototype-1:3', createRevisionSnapshot('webview', 'prototype-1', 3, '<main>第三版</main>')],
  ])
  /** prepare 调用记录用于证明采用旧版不会复制正文。 */
  const preparedInputs: Parameters<CanvasArtifactRevisionStore['prepare']>[1][] = []
  /** commit 调用记录用于验证图后正文提交顺序。 */
  const committedIdentities: Parameters<CanvasArtifactRevisionStore['commit']>[1][] = []
  /** reconcile 调用记录用于验证图已提交后的恢复路径。 */
  const reconciledDocuments: CanvasDocument[] = []
  /** Graph Writer 调用记录用于验证节点身份和 Agent source。 */
  const graphInputs: CanvasTextArtifactGraphCommitInput[] = []
  /** 原子导出调用记录，不触碰真实文件系统。 */
  const exports: Array<{ path: string; content: string }> = []
  /** 仅首次 commit 注入回执失败。 */
  let remainingCommitFailures = options.failCommitOnce ? 1 : 0

  /** 内存不可变版本 Store。 */
  const revisions: CanvasArtifactRevisionStore = {
    read: async (_target, identity) => {
      /** 精确身份对应的已有版本。 */
      const snapshot = snapshots.get(`${identity.kind}:${identity.contentId}:${identity.revision}`)
      if (!snapshot) throw new Error('CANVAS_ARTIFACT_REVISION_NOT_FOUND')
      return structuredClone(snapshot)
    },
    list: async (_target, identity) => [...snapshots.values()]
      .filter((snapshot) => snapshot.record.kind === identity.kind
        && snapshot.record.contentId === identity.contentId)
      .map((snapshot) => structuredClone(snapshot.record)),
    prepare: async (_target, input) => {
      preparedInputs.push(structuredClone(input))
      /** 测试中下一个 revision 固定为当前父版本加一。 */
      const snapshot = createRevisionSnapshot(
        input.kind,
        input.contentId,
        input.parentRevision + 1,
        input.content,
      )
      snapshot.record = { ...snapshot.record, createdBy: input.createdBy, state: 'prepared' }
      snapshots.set(`${input.kind}:${input.contentId}:${snapshot.record.revision}`, snapshot)
      return structuredClone(snapshot)
    },
    prepareAtRevision: async () => { throw new Error('测试不使用 prepareAtRevision') },
    commit: async (_target, identity) => {
      committedIdentities.push(structuredClone(identity))
      if (remainingCommitFailures > 0) {
        remainingCommitFailures -= 1
        throw new Error('injected commit receipt failure')
      }
      /** 精确身份对应的待提交版本。 */
      const snapshot = snapshots.get(`${identity.kind}:${identity.contentId}:${identity.revision}`)
      if (!snapshot) throw new Error('CANVAS_ARTIFACT_REVISION_NOT_FOUND')
      snapshot.record = { ...snapshot.record, state: 'committed' }
      return structuredClone(snapshot.record)
    },
    reconcile: async (_target, document) => {
      reconciledDocuments.push(structuredClone(document))
      for (const node of document.nodes) {
        if (node.kind !== 'document' && node.kind !== 'webview') continue
        /** 节点类别对应的正文 ID。 */
        const contentId = node.kind === 'document' ? node.documentId : node.prototypeId
        /** 图引用版本对应的内存正文。 */
        const snapshot = snapshots.get(`${node.kind}:${contentId}:${node.contentRevision}`)
        if (snapshot) snapshot.record = { ...snapshot.record, state: 'committed' }
      }
    },
  }

  /** 文本产物服务依赖的权威图读取。 */
  const load = (): CanvasWorkspaceSnapshot => ({
    document: structuredClone(currentDocument), writable: true, nodeIssues: [],
  })
  /** 内存 Graph Writer 只替换单节点并推进图 revision。 */
  const graph = {
    commit: async (input: CanvasTextArtifactGraphCommitInput): Promise<CanvasDocument> => {
      graphInputs.push(structuredClone(input))
      if (currentDocument.revision !== input.expectedCanvasRevision) {
        throw new Error('CANVAS_REVISION_CONFLICT')
      }
      currentDocument = {
        ...currentDocument,
        revision: currentDocument.revision + 1,
        nodes: currentDocument.nodes.map((node) => node.id === input.node.id
          ? structuredClone(input.node)
          : node),
      }
      return structuredClone(currentDocument)
    },
  }
  /** 被测文本产物服务。 */
  const service = createCanvasTextArtifactService({
    documents: { load },
    revisions,
    graph,
    writeTextFileAtomic: (path, content) => { exports.push({ path, content }) },
  })

  return {
    service,
    revisions,
    preparedInputs,
    committedIdentities,
    reconciledDocuments,
    graphInputs,
    exports,
    getDocument: () => structuredClone(currentDocument),
    setDocument: (document: CanvasDocument) => { currentDocument = structuredClone(document) },
    /** 修改指定版本状态，用于验证 prepared 恢复候选的公开边界。 */
    setRevisionState: (
      kind: CanvasTextArtifactKind,
      contentId: string,
      revision: number,
      state: CanvasArtifactRevisionRecord['state'],
    ) => {
      /** 精确身份对应的测试版本。 */
      const snapshot = snapshots.get(`${kind}:${contentId}:${revision}`)
      if (!snapshot) throw new Error('测试版本不存在')
      snapshot.record = { ...snapshot.record, state }
    },
  }
}

describe('Canvas Text Artifact Service', () => {
  test('Given 文档节点采用 revision 2 When 保存正文 Then 准备 revision 3 并只更新原节点引用', async () => {
    const fixture = createFixture()

    const result = await fixture.service.update({
      projectId: 'project-1', canvasId: 'canvas-1', nodeId: 'doc-1',
      kind: 'document', contentId: 'content-1', expectedCanvasRevision: 7,
      expectedContentRevision: 2, content: '# 第三版',
      operationId: '11111111-1111-4111-8111-111111111111', source: { type: 'user' },
    })

    expect(result.artifact.target).toMatchObject({
      nodeId: 'doc-1', contentId: 'content-1', contentRevision: 3,
    })
    expect(result.snapshot.document.nodes).toHaveLength(2)
    expect(result.snapshot.document.nodes.find((node) => node.id === 'web-1')).toEqual(webviewNode)
    expect(fixture.preparedInputs[0]?.createdBy).toEqual({ type: 'user' })
  })

  test('Given WebView 历史 revision 1 When 采用 Then 只切换 contentRevision 且不复制正文', async () => {
    const fixture = createFixture()

    const result = await fixture.service.adopt({
      projectId: 'project-1', canvasId: 'canvas-1', nodeId: 'web-1',
      kind: 'webview', contentId: 'prototype-1', expectedCanvasRevision: 7,
      expectedContentRevision: 3, revision: 1,
      operationId: '22222222-2222-4222-8222-222222222222',
    })

    expect(result.artifact.target).toMatchObject({ nodeId: 'web-1', contentRevision: 1 })
    expect(result.artifact.content).toBe('<main>第一版</main>')
    expect(fixture.preparedInputs).toHaveLength(0)
  })

  test('Given 图或正文基线过期 When 更新 Then 不创建可见新版本', async () => {
    const fixture = createFixture()
    /** 过期图 revision 的更新输入。 */
    const staleGraphInput = {
      projectId: 'project-1', canvasId: 'canvas-1', nodeId: 'doc-1',
      kind: 'document' as const, contentId: 'content-1', expectedCanvasRevision: 6,
      expectedContentRevision: 2, content: '# 过期',
      operationId: '33333333-3333-4333-8333-333333333333', source: { type: 'user' as const },
    }

    await expect(fixture.service.update(staleGraphInput))
      .rejects.toThrow('CANVAS_ARTIFACT_REVISION_CONFLICT')
    await expect(fixture.service.update({
      ...staleGraphInput,
      expectedCanvasRevision: 7,
      expectedContentRevision: 1,
    })).rejects.toThrow('CANVAS_ARTIFACT_REVISION_CONFLICT')
    expect(fixture.preparedInputs).toHaveLength(0)
  })

  test('Given 调用方身份与权威节点不匹配 When 读写或采用 Then 全部拒绝', async () => {
    const fixture = createFixture()
    /** 复用合法基线构造伪造正文身份。 */
    const forged = {
      projectId: 'project-1', canvasId: 'canvas-1', nodeId: 'doc-1',
      kind: 'document' as const, contentId: 'other-content', expectedCanvasRevision: 7,
      expectedContentRevision: 2,
    }

    await expect(fixture.service.update({
      ...forged, content: '# 伪造', operationId: '44444444-4444-4444-8444-444444444444',
      source: { type: 'user' },
    })).rejects.toThrow('CANVAS_TEXT_ARTIFACT_IDENTITY_CONFLICT')
    await expect(fixture.service.read({
      projectId: forged.projectId, canvasId: forged.canvasId, nodeId: forged.nodeId,
      kind: forged.kind, contentId: forged.contentId, contentRevision: 2,
    })).rejects.toThrow('CANVAS_TEXT_ARTIFACT_IDENTITY_CONFLICT')
    await expect(fixture.service.adopt({
      ...forged, revision: 1, operationId: '55555555-5555-4555-8555-555555555555',
    })).rejects.toThrow('CANVAS_TEXT_ARTIFACT_IDENTITY_CONFLICT')
    await expect(fixture.service.read({
      projectId: forged.projectId, canvasId: forged.canvasId, nodeId: forged.nodeId,
      kind: 'webview', contentId: 'content-1', contentRevision: 2,
    })).rejects.toThrow('CANVAS_TEXT_ARTIFACT_IDENTITY_CONFLICT')
    await expect(fixture.service.read({
      projectId: forged.projectId, canvasId: forged.canvasId, nodeId: forged.nodeId,
      kind: 'document', contentId: 'content-1', contentRevision: 1,
    })).rejects.toThrow('CANVAS_ARTIFACT_REVISION_NOT_FOUND')
  })

  test('Given 图已提交但 revision commit 回执失败 When 更新 Then 重读权威图并 reconcile', async () => {
    const fixture = createFixture({ failCommitOnce: true })

    const result = await fixture.service.update({
      projectId: 'project-1', canvasId: 'canvas-1', nodeId: 'doc-1',
      kind: 'document', contentId: 'content-1', expectedCanvasRevision: 7,
      expectedContentRevision: 2, content: '# 第三版',
      operationId: '66666666-6666-4666-8666-666666666666', source: { type: 'user' },
    })

    expect(result.snapshot.document.revision).toBe(8)
    expect(fixture.reconciledDocuments).toHaveLength(1)
    expect(fixture.reconciledDocuments[0]?.nodes.find((node) => node.id === 'doc-1'))
      .toMatchObject({ contentRevision: 3 })
  })

  test('Given Agent 更新正文 When 提交 Then 修订作者和图来源均使用可信 Agent 身份', async () => {
    const fixture = createFixture()

    await fixture.service.update({
      projectId: 'project-1', canvasId: 'canvas-1', nodeId: 'doc-1',
      kind: 'document', contentId: 'content-1', expectedCanvasRevision: 7,
      expectedContentRevision: 2, content: '# Agent 第三版',
      operationId: '77777777-7777-4777-8777-777777777777',
      source: { type: 'agent', sessionId: 'session-1', runStartedAt: 10, toolCallId: 'tool-1' },
    })

    expect(fixture.preparedInputs[0]?.createdBy).toEqual({
      type: 'agent', sessionId: 'session-1', toolCallId: 'tool-1',
    })
    expect(fixture.graphInputs[0]?.source).toEqual({
      sessionId: 'session-1', runStartedAt: 10, toolCallId: 'tool-1',
    })
  })

  test('Given 文本节点 When 读取和列举版本 Then 只返回权威身份的公开版本事实', async () => {
    const fixture = createFixture()

    const artifact = await fixture.service.read({
      projectId: 'project-1', canvasId: 'canvas-1', nodeId: 'web-1',
      kind: 'webview', contentId: 'prototype-1', contentRevision: 3,
    })
    const versions = await fixture.service.listVersions({
      projectId: 'project-1', canvasId: 'canvas-1', nodeId: 'web-1',
      kind: 'webview', contentId: 'prototype-1',
    })

    expect(artifact.content).toBe('<main>第三版</main>')
    expect(versions.map((version) => version.revision)).toEqual([1, 3])
    expect(versions[0]).not.toHaveProperty('state')
  })

  test('Given 节点当前采用 revision 3 When 版本面板读取历史 revision 1 Then 返回历史正文但旧版不能直接导出', async () => {
    const fixture = createFixture()
    /** 版本面板读取同一权威节点的已提交历史正文。 */
    const historical = await fixture.service.read({
      projectId: 'project-1', canvasId: 'canvas-1', nodeId: 'web-1',
      kind: 'webview', contentId: 'prototype-1', contentRevision: 1,
    })

    expect(historical.content).toBe('<main>第一版</main>')
    await expect(fixture.service.export({
      ...historical.target,
      targetPath: '/tmp/prototype.html',
    })).rejects.toThrow('CANVAS_ARTIFACT_REVISION_CONFLICT')
    expect(fixture.exports).toHaveLength(0)
  })

  test('Given 图引用的 revision 仍是 prepared When 读取或导出 Then 不泄漏恢复候选', async () => {
    const fixture = createFixture()
    fixture.setRevisionState('webview', 'prototype-1', 3, 'prepared')
    /** 当前图采用的 WebView 精确目标。 */
    const target = {
      projectId: 'project-1', canvasId: 'canvas-1', nodeId: 'web-1',
      kind: 'webview' as const, contentId: 'prototype-1', contentRevision: 3,
    }

    await expect(fixture.service.read(target))
      .rejects.toThrow('CANVAS_ARTIFACT_REVISION_NOT_COMMITTED')
    await expect(fixture.service.export({ ...target, targetPath: '/tmp/prototype.html' }))
      .rejects.toThrow('CANVAS_ARTIFACT_REVISION_NOT_COMMITTED')
    expect(fixture.exports).toHaveLength(0)
  })

  test('Given 文档和 WebView 导出 When 扩展名正确 Then 使用原子文本写入', async () => {
    const fixture = createFixture()

    await fixture.service.export({
      projectId: 'project-1', canvasId: 'canvas-1', nodeId: 'doc-1',
      kind: 'document', contentId: 'content-1', contentRevision: 2,
      targetPath: '/tmp/requirements.md',
    })
    await fixture.service.export({
      projectId: 'project-1', canvasId: 'canvas-1', nodeId: 'web-1',
      kind: 'webview', contentId: 'prototype-1', contentRevision: 3,
      targetPath: '/tmp/prototype.html',
    })

    expect(fixture.exports).toEqual([
      { path: '/tmp/requirements.md', content: '# 第二版' },
      { path: '/tmp/prototype.html', content: '<main>第三版</main>' },
    ])
    await expect(fixture.service.export({
      projectId: 'project-1', canvasId: 'canvas-1', nodeId: 'doc-1',
      kind: 'document', contentId: 'content-1', contentRevision: 2,
      targetPath: '/tmp/requirements.html',
    })).rejects.toThrow('CANVAS_ARTIFACT_EXPORT_PATH_INVALID')
  })

  test('Given WebView 空正文或正文超过 256 KiB When 更新 Then 在准备版本前拒绝', async () => {
    const fixture = createFixture()
    /** WebView 空正文输入。 */
    const webviewInput = {
      projectId: 'project-1', canvasId: 'canvas-1', nodeId: 'web-1',
      kind: 'webview' as const, contentId: 'prototype-1', expectedCanvasRevision: 7,
      expectedContentRevision: 3, operationId: '88888888-8888-4888-8888-888888888888',
      source: { type: 'user' as const },
    }

    await expect(fixture.service.update({ ...webviewInput, content: '   ' }))
      .rejects.toThrow('CANVAS_TEXT_ARTIFACT_CONTENT_INVALID')
    await expect(fixture.service.update({
      ...webviewInput,
      content: 'x'.repeat(256 * 1024 + 1),
    })).rejects.toThrow('CANVAS_TEXT_ARTIFACT_CONTENT_INVALID')
    expect(fixture.preparedInputs).toHaveLength(0)
  })

  test('Given document 或 webview Adapter When 输入类别漂移 Then 在调用服务前拒绝', async () => {
    const fixture = createFixture()
    /** 固定 document 类别的真实适配器。 */
    const adapter = createCanvasTextArtifactAdapter('document', fixture.service)

    expect(adapter.descriptor).toBe(DOCUMENT_ARTIFACT_DESCRIPTOR)
    await expect(adapter.read({
      projectId: 'project-1', canvasId: 'canvas-1', nodeId: 'web-1',
      kind: 'webview', contentId: 'prototype-1', contentRevision: 3,
    })).rejects.toThrow('CANVAS_TEXT_ARTIFACT_KIND_MISMATCH')
    expect(createCanvasTextArtifactAdapter('webview', fixture.service).descriptor)
      .toBe(WEBVIEW_ARTIFACT_DESCRIPTOR)
  })
})

describe('Canvas Text Artifact Graph Writer', () => {
  test('Given 用户和 Agent 来源 When 提交单节点 Then 分别走 DocumentStore 和 batch', async () => {
    /** Graph Writer 分支调用记录。 */
    const calls: string[] = []
    /** 两个分支返回的固定权威图。 */
    const document = createDocument(8)
    /** 被测 Graph Writer。 */
    const writer = createCanvasTextArtifactGraphWriter({
      documents: {
        mutate: (_target, _revision, mutations) => {
          calls.push(`user:${mutations[0]?.type}`)
          return structuredClone(document)
        },
      },
      batch: {
        execute: async (input) => {
          calls.push(`agent:${input.sourceSessionId}:${input.sourceToolCallId}`)
          return { document: structuredClone(document), operationId: 'batch-1' }
        },
      },
    })
    /** 用户分支提交输入。 */
    const userInput: CanvasTextArtifactGraphCommitInput = {
      projectId: 'project-1', canvasId: 'canvas-1', operationId: 'operation-user',
      expectedCanvasRevision: 7, node: { ...documentNode, contentRevision: 3 },
    }
    /** Agent 分支提交输入。 */
    const agentInput: CanvasTextArtifactGraphCommitInput = {
      ...userInput,
      operationId: 'operation-agent',
      source: { sessionId: 'session-1', runStartedAt: 10, toolCallId: 'tool-1' },
    }

    await writer.commit(userInput)
    await writer.commit(agentInput)

    expect(calls).toEqual(['user:upsert-nodes', 'agent:session-1:tool-1'])
  })
})
