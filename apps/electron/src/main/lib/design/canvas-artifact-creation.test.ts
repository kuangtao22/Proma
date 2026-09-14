import { describe, expect, test } from 'bun:test'
import type {
  CanvasBatchOperationEnvelope,
  CanvasDocument,
  CanvasMutation,
} from '@proma/shared'
import { createEmptyCanvasDocument } from '@proma/shared'
import {
  createCanvasArtifactCreationService,
  type CanvasArtifactCreationDependencies,
} from './canvas-artifact-creation'
import { CanvasArtifactPreflightError } from './canvas-artifact-preflight'

const target = { projectId: 'project-1', canvasId: 'canvas-1' }

/** 服务测试已控制 envelope 来源，断言前从 JSON 外壳恢复为已验证 mutation。 */
function getBatchOperations(batch: CanvasBatchOperationEnvelope): CanvasMutation[] {
  return batch.operations as unknown as CanvasMutation[]
}

/** 构造可观察内容准备、批量提交与失败补偿的窄测试服务。 */
function createFixture(options: {
  conflictOnce?: boolean
  conflictAlways?: boolean
  commitBeforeError?: boolean
  batchError?: Error
  loadError?: Error
  validationError?: Error
} = {}) {
  let document: CanvasDocument = {
    ...createEmptyCanvasDocument(target.projectId, target.canvasId, 1),
    revision: 3,
    nodes: [{
      id: 'requirements-1',
      kind: 'document',
      title: '页面需求',
      position: { x: 40, y: 60 },
      documentId: 'requirements-content',
      contentRevision: 1,
    }],
  }
  const prepared: Array<{
    kind: string
    contentId: string
    content: string
    selectedModelProfileId?: string | null
    adoptedAssetId?: string
  }> = []
  const discarded: Array<{ contentId: string; rollbackId: string }> = []
  const batches: CanvasBatchOperationEnvelope[] = []
  /** 测试 fake 只实现本服务会产生的节点和连线 upsert。 */
  const applyOperations = (operations: CanvasMutation[], revision: number): CanvasDocument => {
    const nodes = [...document.nodes]
    const edges = [...document.edges]
    for (const operation of operations) {
      if (operation.type === 'upsert-nodes') nodes.push(...operation.nodes)
      if (operation.type === 'upsert-edges') edges.push(...operation.edges)
    }
    return { ...document, nodes, edges, revision }
  }
  const dependencies: CanvasArtifactCreationDependencies = {
    documents: {
      load: () => {
        if (options.loadError) throw options.loadError
        return { document: structuredClone(document), writable: true, nodeIssues: [] }
      },
      validateBatchOperations: (_target, _expectedRevision, operations) => {
        if (options.validationError) throw options.validationError
        return structuredClone(operations) as CanvasMutation[]
      },
    },
    content: {
      prepareArtifactContent: async (_target, input) => { prepared.push(structuredClone(input)) },
      discardPreparedContent: async (_target, input, rollbackId) => {
        discarded.push({ contentId: input.contentId, rollbackId })
      },
    },
    batch: {
      execute: async (input) => {
        batches.push(structuredClone(input))
        if (options.batchError) throw options.batchError
        const shouldConflict = options.conflictAlways || (options.conflictOnce && batches.length === 1)
        if (shouldConflict) {
          document = { ...document, revision: document.revision + 1 }
          throw new Error('CANVAS_REVISION_CONFLICT')
        }
        const next = applyOperations(getBatchOperations(input), input.baseRevision + 1)
        document = next
        if (options.commitBeforeError) throw new Error('CANVAS_COMMIT_RESULT_UNCERTAIN')
        return { document: structuredClone(document), operationId: `operation-${batches.length}` }
      },
    },
    resolveDefaultImageModelProfileId: () => 'profile-default',
  }
  return {
    service: createCanvasArtifactCreationService(dependencies),
    prepared,
    discarded,
    batches,
    getDocument: () => structuredClone(document),
  }
}

describe('Canvas Agent 产物原子创建服务', () => {
  test('Given 图片预览尚未加载 When 在其下方创建文档或Agent Then 避让预览最大显示高度而非空卡高度', async () => {
    /** 同时覆盖普通产物和专业 Agent 的两条创建入口。 */
    for (const kind of ['document', 'agent'] as const) {
      const fixture = createFixture()
      const image = await fixture.service.create({
        ...target, baseRevision: 3, artifactType: 'image', title: '累计关键帧', content: '',
        adoptedAssetId: 'existing-image', position: { x: 800, y: 0 },
        source: { sessionId: 'session-1', runStartedAt: 99, toolCallId: `image-${kind}` },
      })
      /** y=168 对空卡合法，却会覆盖最高 368 的图片预览。 */
      const input = { ...target, baseRevision: image.revision, title: '下游设计', position: { x: 800, y: 168 },
        source: { sessionId: 'session-1', runStartedAt: 99, toolCallId: `child-${kind}` } }
      const created = kind === 'agent'
        ? await fixture.service.createAgent(input)
        : await fixture.service.create({ ...input, artifactType: 'document', content: '# 设计' })
      const node = fixture.getDocument().nodes.find(candidate => candidate.id === created.nodeId)!
      const overlaps = node.position.x < 800 + 288 + 24 && node.position.x + 288 + 24 > 800
        && node.position.y < 368 + 24 && node.position.y + 144 + 24 > 0
      expect(overlaps).toBe(false)
    }
  })

  test('Given 已有文档 When 请求在其上方创建带预览图片 Then 按候选最大高度避让而不移动原文档', async () => {
    const fixture = createFixture()
    /** 图片底部若按空卡计算会遗漏对下方需求文档的遮挡。 */
    const result = await fixture.service.create({
      ...target, baseRevision: 3, artifactType: 'image', title: '参考图', content: '',
      position: { x: 40, y: -150 }, adoptedAssetId: 'existing-image',
      source: { sessionId: 'session-1', runStartedAt: 99, toolCallId: 'image-above-doc' },
    })
    const document = fixture.getDocument()
    const image = document.nodes.find(node => node.id === result.nodeId)!
    const overlaps = image.position.x < 40 + 288 + 24 && image.position.x + 288 + 24 > 40
      && image.position.y < 60 + 144 + 24 && image.position.y + 368 + 24 > 60
    expect(overlaps).toBe(false)
    expect(document.nodes[0]!.position).toEqual({ x: 40, y: 60 })
  })

  test('Given 创建已提交但调用方丢失回执 When 按原来源重放 Then 对账同一节点且不重复写入', async () => {
    const fixture = createFixture()
    const input = {
      ...target,
      baseRevision: 3,
      artifactType: 'document' as const,
      title: '生产说明',
      content: '# 生产说明',
      source: { sessionId: 'session-1', runStartedAt: 99, toolCallId: 'tool-lost-receipt' },
    }
    const created = await fixture.service.create(input)
    const replayed = await fixture.service.create({ ...input, baseRevision: created.revision })
    const resolved = fixture.service.resolveCreated({
      ...target, artifactType: 'document', source: input.source,
    })

    expect(replayed).toEqual({ ...created, revision: created.revision })
    expect(resolved).toMatchObject({ nodeId: created.nodeId, revision: created.revision, artifactType: 'document' })
    expect(fixture.batches).toHaveLength(1)
    expect(fixture.prepared).toHaveLength(1)
  })
  test('Given WebView 产物关联来源节点 When 创建 Then 先准备真实 HTML 并在来源右侧提交节点与连线', async () => {
    const fixture = createFixture()
    const result = await fixture.service.create({
      ...target,
      baseRevision: 3,
      artifactType: 'webview',
      title: '首页原型',
      content: '<!doctype html><html><body>首页</body></html>',
      sourceNodeId: 'requirements-1',
      relation: 'reference',
      source: { sessionId: 'session-1', runStartedAt: 99, toolCallId: 'tool-artifact-1' },
    })

    expect(fixture.prepared).toEqual([expect.objectContaining({
      kind: 'webview', content: '<!doctype html><html><body>首页</body></html>',
    })])
    const operations = fixture.batches[0] ? getBatchOperations(fixture.batches[0]) : []
    const createdNode = operations.find((operation) => operation.type === 'upsert-nodes')
    expect(createdNode).toMatchObject({
      nodes: [{
        kind: 'webview', title: '首页原型', position: { x: 352, y: 60 },
        contentRevision: 0, devicePreset: 'desktop',
      }],
    })
    expect(operations.find((operation) => operation.type === 'upsert-edges')).toMatchObject({
      edges: [{
        sourceNodeId: 'requirements-1', sourcePort: 'document.markdown',
        targetNodeId: result.nodeId, targetPort: 'context.text', relation: 'reference',
      }],
    })
    expect(result).toMatchObject({ canvasId: 'canvas-1', revision: 4, artifactType: 'webview' })
    expect(result.nodeId).toMatch(/^artifact-[0-9a-f]{64}$/)
    expect(fixture.discarded).toEqual([])
  })

  test('Given Agent 创建文档并引用需求节点 When 提交 Then 创建 document revision 0 和 reference 边', async () => {
    const fixture = createFixture()

    const result = await fixture.service.create({
      ...target,
      baseRevision: 3,
      artifactType: 'document',
      title: '产品说明',
      content: '# 产品说明',
      sourceNodeId: 'requirements-1',
      relation: 'reference',
      source: { sessionId: 'session-1', runStartedAt: 99, toolCallId: 'tool-doc-1' },
    })

    expect(result).toMatchObject({ artifactType: 'document' })
    expect(fixture.prepared).toEqual([expect.objectContaining({ kind: 'document', content: '# 产品说明' })])
    expect(getBatchOperations(fixture.batches[0]!).find((operation) => operation.type === 'upsert-nodes'))
      .toMatchObject({ nodes: [{ kind: 'document', contentRevision: 0 }] })
    expect(getBatchOperations(fixture.batches[0]!).find((operation) => operation.type === 'upsert-edges'))
      .toMatchObject({
        edges: [{
          relation: 'reference', sourcePort: 'document.markdown', targetPort: 'context.text',
        }],
      })
  })

  test('Given Agent 创建音频媒体节点 When 提交 Then 准备空媒体模块并持久化稳定 mediaModuleId', async () => {
    const fixture = createFixture()

    const result = await fixture.service.create({
      ...target,
      baseRevision: 3,
      artifactType: 'audio',
      title: '旁白',
      content: '该字段不会写入媒体模块',
      sourceNodeId: 'requirements-1',
      relation: 'depends-on',
      source: { sessionId: 'session-1', runStartedAt: 99, toolCallId: 'tool-audio-1' },
    })

    expect(result).toMatchObject({ artifactType: 'audio', revision: 4 })
    expect(fixture.prepared).toEqual([expect.objectContaining({ kind: 'audio', content: '' })])
    expect(getBatchOperations(fixture.batches[0]!).find((operation) => operation.type === 'upsert-nodes'))
      .toMatchObject({ nodes: [{ kind: 'audio', mediaModuleId: expect.stringMatching(/^artifact-content-/) }] })
  })

  test('Given 来源与 relation 仅提供一项 When 创建 Then 在准备内容前拒绝', async () => {
    const fixture = createFixture()
    /** 创建调用的公共字段。 */
    const base = {
      ...target, baseRevision: 3, artifactType: 'document' as const,
      title: '说明', content: '# 说明',
      source: { sessionId: 'session-1', runStartedAt: 99, toolCallId: 'tool-invalid-relation' },
    }

    expect(() => fixture.service.validateCreate({ ...base, sourceNodeId: 'requirements-1' }))
      .toThrow(expect.objectContaining({
        name: 'CanvasArtifactPreflightError',
        code: 'CANVAS_ARTIFACT_RELATION_REQUIRED',
        message: 'CANVAS_ARTIFACT_RELATION_REQUIRED',
      }))
    expect(() => fixture.service.validateCreate({ ...base, relation: 'association' }))
      .toThrow(expect.objectContaining({
        name: 'CanvasArtifactPreflightError',
        code: 'CANVAS_ARTIFACT_RELATION_UNEXPECTED',
        message: 'CANVAS_ARTIFACT_RELATION_UNEXPECTED',
      }))
    await expect(fixture.service.create({ ...base, relation: 'association' }))
      .rejects.toMatchObject({
        name: 'CanvasArtifactPreflightError',
        code: 'CANVAS_ARTIFACT_RELATION_UNEXPECTED',
      })
    expect(fixture.prepared).toHaveLength(0)
    expect(fixture.batches).toHaveLength(0)
  })

  test('Given batch 抛出与输入错误同名的普通异常 When 创建失败 Then 不伪装为事务前预检拒绝', async () => {
    const fixture = createFixture({ batchError: new Error('CANVAS_ARTIFACT_RELATION_UNEXPECTED') })

    const error = await fixture.service.create({
      ...target,
      baseRevision: 3,
      artifactType: 'document',
      title: '说明',
      content: '# 说明',
      source: { sessionId: 'session-1', runStartedAt: 99, toolCallId: 'tool-batch-error' },
    }).catch((cause: unknown) => cause)

    expect(error).toBeInstanceOf(Error)
    expect(error).not.toBeInstanceOf(CanvasArtifactPreflightError)
    expect(fixture.prepared).toHaveLength(1)
    expect(fixture.batches).toHaveLength(1)
  })

  test('Given 权威图读取失败 When 预检 Then 保留未知读取错误而不标记为输入拒绝', () => {
    const fixture = createFixture({ loadError: new Error('CANVAS_DOCUMENT_READ_FAILED') })

    expect(() => fixture.service.validateCreate({
      ...target,
      baseRevision: 3,
      artifactType: 'document',
      title: '说明',
      content: '# 说明',
      source: { sessionId: 'session-1', runStartedAt: 99, toolCallId: 'tool-read-error' },
    })).toThrow(expect.objectContaining({
      name: 'Error',
      message: 'CANVAS_DOCUMENT_READ_FAILED',
    }))
  })

  test('Given Agent 关系参数不配对 When 创建 Agent Then 第一次 batch 前返回确定预检拒绝', async () => {
    const fixture = createFixture()

    await expect(fixture.service.createAgent({
      ...target,
      baseRevision: 3,
      title: '执行 Agent',
      relation: 'depends-on',
      source: { sessionId: 'session-1', runStartedAt: 99, toolCallId: 'tool-agent-invalid' },
    })).rejects.toMatchObject({
      name: 'CanvasArtifactPreflightError',
      code: 'CANVAS_ARTIFACT_RELATION_UNEXPECTED',
    })
    expect(fixture.batches).toHaveLength(0)
  })

  test('Given 来源节点不存在或初始 revision 过期 When 预检 Then 保留对应稳定拒绝码', () => {
    const fixture = createFixture()
    /** 两个输入分别覆盖权威来源与权威 revision 校验。 */
    const base = {
      ...target,
      baseRevision: 3,
      artifactType: 'document' as const,
      title: '说明',
      content: '# 说明',
      source: { sessionId: 'session-1', runStartedAt: 99, toolCallId: 'tool-preflight-authority' },
    }

    expect(() => fixture.service.validateCreate({
      ...base,
      sourceNodeId: 'missing-source',
      relation: 'reference',
    })).toThrow(expect.objectContaining({
      name: 'CanvasArtifactPreflightError',
      code: 'CANVAS_ARTIFACT_SOURCE_NODE_NOT_FOUND',
    }))
    expect(() => fixture.service.validateCreate({ ...base, baseRevision: 2 }))
      .toThrow(expect.objectContaining({
        name: 'CanvasArtifactPreflightError',
        code: 'CANVAS_REVISION_CONFLICT',
      }))
  })

  test('Given 纯 mutation 预检错误带诊断详情 When 校验 Then 提取 allowlist 稳定码并保留原 cause', () => {
    const validationError = new Error('CANVAS_MUTATION_INVALID: title 超出限制')
    const fixture = createFixture({ validationError })

    const error = (() => {
      try {
        fixture.service.validateCreate({
          ...target,
          baseRevision: 3,
          artifactType: 'document',
          title: '说明',
          content: '# 说明',
          source: { sessionId: 'session-1', runStartedAt: 99, toolCallId: 'tool-detailed-preflight' },
        })
      } catch (cause) {
        return cause
      }
      return null
    })()

    expect(error).toBeInstanceOf(CanvasArtifactPreflightError)
    expect(error).toMatchObject({ code: 'CANVAS_MUTATION_INVALID' })
    expect((error as Error).cause).toBe(validationError)
  })

  test('Given Agent 明确创建手机 WebView When 提交产物 Then 节点持久化 mobile 且内容仍只准备一次', async () => {
    const fixture = createFixture()
    await fixture.service.create({
      ...target,
      baseRevision: 3,
      artifactType: 'webview',
      devicePreset: 'mobile',
      title: '手机首页原型',
      content: '<!doctype html><html><body>手机首页</body></html>',
      source: { sessionId: 'session-1', runStartedAt: 99, toolCallId: 'tool-mobile-artifact-1' },
    })

    const operations = fixture.batches[0] ? getBatchOperations(fixture.batches[0]) : []
    expect(operations[0]).toMatchObject({
      type: 'upsert-nodes',
      nodes: [{ kind: 'webview', devicePreset: 'mobile' }],
    })
    expect(fixture.prepared).toHaveLength(1)
  })

  test('Given 图片产物 When 创建 Then 使用项目默认模型初始化 prompt 且不自动运行生图', async () => {
    const fixture = createFixture()
    const result = await fixture.service.create({
      ...target,
      baseRevision: 3,
      artifactType: 'image',
      title: '首页设计稿',
      content: '安静克制的首页视觉设计',
      position: { x: 800, y: 120 },
      source: { sessionId: 'session-1', runStartedAt: 99, toolCallId: 'tool-image-1' },
    })

    expect(fixture.prepared).toEqual([expect.objectContaining({
      kind: 'image',
      content: '安静克制的首页视觉设计',
      selectedModelProfileId: 'profile-default',
    })])
    expect(fixture.batches[0]?.operations).toEqual([expect.objectContaining({
      type: 'upsert-nodes',
      nodes: [expect.objectContaining({ id: result.nodeId, kind: 'image', position: { x: 800, y: 120 } })],
    })])
  })

  test('Given 已导入素材 When 创建图片产物 Then 配置与节点从 revision 0 指向同一正式素材', async () => {
    const fixture = createFixture()
    const result = await fixture.service.create({
      ...target,
      baseRevision: 3,
      artifactType: 'image',
      title: '马小本三视图',
      content: '角色身份参考图，不直接重新生成。',
      adoptedAssetId: 'asset-imported',
      source: { sessionId: 'session-1', runStartedAt: 99, toolCallId: 'tool-import-image-1' },
    })

    expect(fixture.prepared).toEqual([expect.objectContaining({
      kind: 'image',
      adoptedAssetId: 'asset-imported',
    })])
    expect(fixture.batches[0]?.operations).toEqual([expect.objectContaining({
      type: 'upsert-nodes',
      nodes: [expect.objectContaining({
        id: result.nodeId,
        kind: 'image',
        adoptedAssetId: 'asset-imported',
      })],
    })])
  })

  test('Given 普通 Agent 需要编排节点 When 明确创建 Agent Then Host 创建独立会话节点并保持稳定身份', async () => {
    const fixture = createFixture()
    const result = await fixture.service.createAgent({
      ...target,
      baseRevision: 3,
      title: '小红书视频制作 Agent',
      sourceNodeId: 'requirements-1',
      relation: 'depends-on',
      source: { sessionId: 'session-1', runStartedAt: 99, toolCallId: 'tool-create-agent-1' },
    })

    expect(fixture.prepared).toHaveLength(0)
    const operations = getBatchOperations(fixture.batches[0]!)
    expect(operations.find((operation) => operation.type === 'upsert-nodes')).toMatchObject({
      nodes: [{
        id: result.nodeId,
        kind: 'agent',
        title: '小红书视频制作 Agent',
        agentSessionId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      }],
    })
    expect(operations.find((operation) => operation.type === 'upsert-edges')).toMatchObject({
      edges: [{
        sourceNodeId: 'requirements-1',
        targetNodeId: result.nodeId,
        relation: 'depends-on',
      }],
    })
  })

  test('Given 首次 revision 冲突 When 创建 Then 权威重读后只重试一次并保持同一节点身份', async () => {
    const fixture = createFixture({ conflictOnce: true })
    const result = await fixture.service.create({
      ...target,
      baseRevision: 3,
      artifactType: 'webview',
      title: '首页原型',
      content: '<!doctype html><html></html>',
      source: { sessionId: 'session-1', runStartedAt: 99, toolCallId: 'tool-retry-1' },
    })

    expect(fixture.batches.map((batch) => batch.baseRevision)).toEqual([3, 4])
    expect(fixture.batches.map((batch) => batch.sourceToolCallId)).toEqual([
      'tool-retry-1', 'tool-retry-1-retry',
    ])
    const nodeIds = fixture.batches.map((batch) => (
      getBatchOperations(batch)[0] as unknown as Extract<CanvasMutation, { type: 'upsert-nodes' }>
    ).nodes[0]?.id)
    expect(new Set(nodeIds)).toEqual(new Set([result.nodeId]))
    expect(fixture.discarded).toEqual([])
  })

  test('Given 两次 revision 冲突 When 创建失败 Then 清理未进入权威图的 prepared 内容', async () => {
    const fixture = createFixture({ conflictAlways: true })
    await expect(fixture.service.create({
      ...target,
      baseRevision: 3,
      artifactType: 'webview',
      title: '失败原型',
      content: '<!doctype html><html></html>',
      source: { sessionId: 'session-1', runStartedAt: 99, toolCallId: 'tool-failed-1' },
    })).rejects.toThrow('CANVAS_REVISION_CONFLICT')

    expect(fixture.batches).toHaveLength(2)
    expect(fixture.discarded).toEqual([expect.objectContaining({
      rollbackId: expect.stringMatching(/^artifact-rollback-[0-9a-f]{64}$/),
    })])
  })

  test('Given batch 已提交节点但返回不确定错误 When 对账 Then 保留权威内容并返回成功事实', async () => {
    const fixture = createFixture({ commitBeforeError: true })
    const result = await fixture.service.create({
      ...target,
      baseRevision: 3,
      artifactType: 'webview',
      title: '已提交原型',
      content: '<!doctype html><html></html>',
      source: { sessionId: 'session-1', runStartedAt: 99, toolCallId: 'tool-uncertain-1' },
    })

    expect(fixture.getDocument().nodes.some((node) => node.id === result.nodeId)).toBe(true)
    expect(fixture.discarded).toEqual([])
    expect(result.revision).toBe(4)
  })

  test('Given Agent 连续创建 14 个无来源产物 When 未提供坐标 Then Host 形成紧凑多行', async () => {
    const fixture = createFixture()
    for (let order = 0; order < 14; order += 1) {
      await fixture.service.create({
        ...target,
        baseRevision: fixture.getDocument().revision,
        artifactType: 'document',
        title: `规划 ${order + 1}`,
        content: `# 规划 ${order + 1}`,
        source: {
          sessionId: 'session-layout',
          runStartedAt: 100,
          toolCallId: `tool-layout-${order}`,
        },
      })
    }

    /** 排除测试夹具中的初始需求节点，只检查本次 Agent 连续创建结果。 */
    const created = fixture.getDocument().nodes.filter((node) => node.id !== 'requirements-1')
    expect(new Set(created.map((node) => node.position.y)).size).toBeGreaterThan(1)
    expect(Math.max(...created.map((node) => node.position.x))).toBeLessThan(1_600)
  })

  test('Given 同一来源连续创建多个兄弟产物 When 未提供坐标 Then 使用来源右侧多个不重叠槽位', async () => {
    const fixture = createFixture()
    for (let order = 0; order < 6; order += 1) {
      await fixture.service.create({
        ...target,
        baseRevision: fixture.getDocument().revision,
        artifactType: order % 2 === 0 ? 'webview' : 'document',
        title: `衍生产物 ${order + 1}`,
        content: order % 2 === 0 ? '<main>原型</main>' : '# 文档',
        sourceNodeId: 'requirements-1',
        relation: 'derives',
        source: {
          sessionId: 'session-layout',
          runStartedAt: 101,
          toolCallId: `tool-sibling-${order}`,
        },
      })
    }

    /** 同源兄弟不能继续落在同一个来源右侧坐标。 */
    const created = fixture.getDocument().nodes.filter((node) => node.id !== 'requirements-1')
    expect(new Set(created.map((node) => `${node.position.x}:${node.position.y}`)).size).toBe(6)
    expect(new Set(created.map((node) => node.position.y)).size).toBeGreaterThan(1)
  })
})
