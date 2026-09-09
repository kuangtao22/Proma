import { describe, expect, test } from 'bun:test'
import {
  parseAttachCanvasMediaImportedAssetsInput,
  parseAdoptCanvasMediaCandidateInput,
  parseCanvasMediaCandidate,
  parseCanvasMediaModuleChangedEvent,
  parseCanvasMediaModuleConfig,
  parseCanvasMediaTarget,
  parseControlCanvasMediaRunInput,
  parseExportCanvasMediaOutputInput,
  parseReleaseCanvasMediaPreviewInput,
  parseRunCanvasMediaModuleInput,
  parseSaveCanvasMediaModuleInput,
} from './canvas-media'
import {
  createCanvasBoundEdge,
  parseCanvasWorkspaceSnapshot,
  parseCreateCanvasContentNodeInput,
} from './canvas'

/** 创建固定视频预设、类型化输入和有序多输出的配置样例。 */
function createConfig() {
  return {
    schemaVersion: 1 as const,
    contentId: 'media-1',
    mediaKind: 'video' as const,
    revision: 3,
    createdAt: 10,
    updatedAt: 20,
    profile: { profileId: 'video-profile', profileRevision: 4 },
    inputs: [
      { key: 'prompt', kind: 'text' as const, source: { type: 'literal' as const, value: '海边日落' } },
      { key: 'source', kind: 'image' as const, source: { type: 'literal' as const, value: {
        assetId: 'asset-1', revision: 1, hash: 'a'.repeat(64), mediaKind: 'image' as const,
      } } },
    ],
    outputs: [
      { key: 'video', mediaKind: 'video' as const, role: 'primary' as const, order: 0 },
      { key: 'poster', mediaKind: 'image' as const, role: 'preview' as const, order: 1 },
    ],
    adoptedOutputs: [],
  }
}

describe('Canvas 通用媒体合同', () => {
  test('Given 默认首选来源 When 配置往返解析 Then 保留来源且拒绝未知模式', () => {
    const output = { ...createConfig().outputs[0]!, candidateId: 'candidate-1', runId: 'run-1',
      asset: { assetId: 'video-1', revision: 1, hash: 'a'.repeat(64), mediaKind: 'video' }, selectionOrigin: 'initial' }
    expect(parseCanvasMediaModuleConfig({ ...createConfig(), adoptedOutputs: [output] }).adoptedOutputs[0])
      .toMatchObject({ selectionOrigin: 'initial' })
    expect(() => parseCanvasMediaModuleConfig({ ...createConfig(), adoptedOutputs: [{ ...output, selectionOrigin: 'accepted' }] }))
      .toThrow('CANVAS_MEDIA_OUTPUT_INVALID')
  })

  test('Given 固定预设和多输出配置 When 解析 Then 保留 key、类型、角色与顺序并深拷贝资产', () => {
    const raw = createConfig()
    const parsed = parseCanvasMediaModuleConfig(raw)
    expect(parsed.profile).toEqual({ profileId: 'video-profile', profileRevision: 4 })
    expect(parsed.outputs).toEqual([
      { key: 'video', mediaKind: 'video', role: 'primary', order: 0 },
      { key: 'poster', mediaKind: 'image', role: 'preview', order: 1 },
    ])
    const sourceValue = raw.inputs[1]?.source.value
    if (typeof sourceValue === 'object') sourceValue.assetId = 'changed'
    expect(parsed.inputs[1]).toMatchObject({ source: { type: 'literal', value: { assetId: 'asset-1' } } })
  })

  test('Given 输入类型不匹配或输出顺序有洞 When 解析 Then fail closed', () => {
    const wrongInput = {
      ...createConfig(),
      inputs: [
        { key: 'prompt', kind: 'text', source: { type: 'literal', value: '海边日落' } },
        { key: 'source', kind: 'video', source: { type: 'literal', value: {
          assetId: 'asset-1', revision: 1, hash: 'a'.repeat(64), mediaKind: 'image',
        } } },
      ],
    }
    expect(() => parseCanvasMediaModuleConfig(wrongInput)).toThrow('CANVAS_MEDIA_INPUT_INVALID')

    const wrongOrder = createConfig()
    wrongOrder.outputs[1]!.order = 2
    expect(() => parseCanvasMediaModuleConfig(wrongOrder)).toThrow('CANVAS_MEDIA_OUTPUT_INVALID')
  })

  test('Given 不同角色输出未声明 bundle When 保存配置 Then 保持可独立采用', () => {
    const parsed = parseCanvasMediaModuleConfig(createConfig())
    expect(parsed.outputs.map((output) => ({ key: output.key, bundle: output.bundle }))).toEqual([
      { key: 'video', bundle: undefined },
      { key: 'poster', bundle: undefined },
    ])
    expect(parsed.adoptedOutputs).toEqual([])
  })

  test('Given audio/video 目标 When 解析 Then 保留媒体模块完整身份且拒绝旧 image 混入', () => {
    expect(parseCanvasMediaTarget({
      projectId: 'project-1', canvasId: 'canvas-1', nodeId: 'node-1',
      mediaModuleId: 'media-1', mediaKind: 'audio',
    })).toEqual({
      projectId: 'project-1', canvasId: 'canvas-1', nodeId: 'node-1',
      mediaModuleId: 'media-1', mediaKind: 'audio',
    })
    expect(() => parseCanvasMediaTarget({
      projectId: 'project-1', canvasId: 'canvas-1', nodeId: 'node-1',
      mediaModuleId: 'media-1', mediaKind: 'image',
    })).toThrow('CANVAS_MEDIA_TARGET_INVALID')
  })

  test('Given 运行与按 key 采用命令 When 解析 Then 固定 operation、配置 revision 和选择集合', () => {
    const target = {
      projectId: 'project-1', canvasId: 'canvas-1', nodeId: 'node-1',
      mediaModuleId: 'media-1', mediaKind: 'video' as const,
    }
    expect(parseRunCanvasMediaModuleInput({
      ...target, expectedConfigRevision: 3, operationId: 'operation:1',
    }).operationId).toBe('operation:1')
    expect(parseAdoptCanvasMediaCandidateInput({
      ...target, expectedConfigRevision: 3, candidateId: 'candidate-1', selectedKeys: ['audio'],
    }).selectedKeys).toEqual(['audio'])
    expect(() => parseAdoptCanvasMediaCandidateInput({
      ...target, expectedConfigRevision: 3, candidateId: 'candidate-1', selectedKeys: ['audio', 'audio'],
    })).toThrow('CANVAS_MEDIA_ADOPT_INPUT_INVALID')
  })

  test('Given 本地导入候选与回填命令 When 严格解析 Then 保留来源会话且拒绝重复输出 key', () => {
    const target = {
      projectId: 'project-1', canvasId: 'canvas-1', nodeId: 'node-1',
      mediaModuleId: 'media-1', mediaKind: 'video' as const,
    }
    const asset = { assetId: 'asset-video', revision: 1, hash: 'a'.repeat(64), mediaKind: 'video' as const }
    expect(parseCanvasMediaCandidate({
      id: 'candidate:local-1', operationId: 'local-import-1', runId: 'local-1', sourceConfigRevision: 3,
      source: { kind: 'local-import', operationId: 'local-import-1', sourceSessionId: 'session-1' },
      outputs: [{ key: 'video', mediaKind: 'video', role: 'primary', order: 0, asset }], createdAt: 10,
    })).toMatchObject({ source: { kind: 'local-import', sourceSessionId: 'session-1' } })
    expect(parseAttachCanvasMediaImportedAssetsInput({
      ...target, expectedConfigRevision: 3, operationId: 'local-import-1', outputs: [{ key: 'video', asset }],
    }).outputs).toEqual([{ key: 'video', asset }])
    expect(() => parseAttachCanvasMediaImportedAssetsInput({
      ...target, expectedConfigRevision: 3, operationId: 'local-import-1',
      outputs: [{ key: 'video', asset }, { key: 'video', asset }],
    })).toThrow('CANVAS_MEDIA_LOCAL_IMPORT_INPUT_INVALID')
  })

  test('Given Canvas 输出绑定 When 解析配置 Then 保留精确节点与固定输出 key', () => {
    const raw = {
      ...createConfig(),
      inputs: [{
        key: 'prompt', kind: 'text',
        source: { type: 'canvas-output', nodeId: 'agent-1', outputKey: 'agent.text' },
      }],
    }
    expect(parseCanvasMediaModuleConfig(raw).inputs[0]).toEqual({
      key: 'prompt', kind: 'text',
      source: { type: 'canvas-output', nodeId: 'agent-1', outputKey: 'agent.text' },
    })
  })

  test('Given Renderer 媒体命令 When 严格解析 Then 拒绝未知字段并保留完整目标', () => {
    const target = {
      projectId: 'project-1', canvasId: 'canvas-1', nodeId: 'node-1',
      mediaModuleId: 'media-1', mediaKind: 'video' as const,
    }
    expect(parseSaveCanvasMediaModuleInput({
      ...target, expectedConfigRevision: 3, profile: createConfig().profile,
      inputs: createConfig().inputs, outputs: createConfig().outputs,
    }).inputs).toHaveLength(2)
    expect(parseControlCanvasMediaRunInput({ ...target, runId: 'run-1' }).runId).toBe('run-1')
    expect(parseExportCanvasMediaOutputInput({
      ...target, candidateId: 'candidate-1', outputKey: 'video', outputOrder: 0,
    }).outputKey).toBe('video')
    expect(parseReleaseCanvasMediaPreviewInput({ ...target, mediaLeaseId: 'lease-1' }).mediaLeaseId).toBe('lease-1')
    expect(parseCanvasMediaModuleChangedEvent({ target, revision: 4 })).toEqual({ target, revision: 4 })
    expect(() => parseControlCanvasMediaRunInput({ ...target, runId: 'run-1', extra: true })).toThrow(
      'CANVAS_MEDIA_CONTROL_INPUT_INVALID',
    )
  })

  test('Given 未发布的项目 WorkflowDraft When 保存完整 typed 合同 Then 允许 profile 为空且继续严格校验输出', () => {
    const target = {
      projectId: 'project-1', canvasId: 'canvas-1', nodeId: 'node-1',
      mediaModuleId: 'media-1', mediaKind: 'video' as const,
    }
    const parsed = parseSaveCanvasMediaModuleInput({
      ...target,
      expectedConfigRevision: 0,
      profile: null,
      inputs: [{ key: 'prompt', kind: 'text', source: { type: 'literal', value: '海边日落' } }],
      outputs: [{ key: 'video', mediaKind: 'video', role: 'primary', order: 0 }],
    })

    expect(parsed).toMatchObject({
      profile: null,
      inputs: [{ key: 'prompt', kind: 'text' }],
      outputs: [{ key: 'video', mediaKind: 'video', role: 'primary', order: 0 }],
    })
    expect(() => parseSaveCanvasMediaModuleInput({
      ...target,
      expectedConfigRevision: 0,
      profile: null,
      inputs: [{ key: 'prompt', kind: 'text', source: { type: 'literal', value: '海边日落' } }],
      outputs: [],
    })).toThrow('CANVAS_MEDIA_SAVE_INPUT_INVALID')
  })

  test('Given 工作流输出缺少角色和顺序 When 保存草稿 Then 返回可定位且不含原始值的字段诊断', () => {
    const target = {
      projectId: 'project-1', canvasId: 'canvas-1', nodeId: 'node-1',
      mediaModuleId: 'media-1', mediaKind: 'video' as const,
    }
    expect(() => parseSaveCanvasMediaModuleInput({
      ...target,
      expectedConfigRevision: 0,
      profile: null,
      inputs: [],
      outputs: [{ key: '92.video', mediaKind: 'video' }],
    })).toThrow('CANVAS_MEDIA_SAVE_INPUT_INVALID: outputs[0] 缺少 role、order')
  })

  test('Given 工作流已绑定但输出合同为空 When 保存草稿 Then 明确要求至少一项输出', () => {
    expect(() => parseSaveCanvasMediaModuleInput({
      projectId: 'project-1', canvasId: 'canvas-1', nodeId: 'node-1',
      mediaModuleId: 'media-1', mediaKind: 'video', expectedConfigRevision: 0,
      profile: null,
      workflow: { workflowId: 'workflow-1', workflowRevision: 1, connectionId: 'gpu-main' },
      inputs: [],
      outputs: [],
    })).toThrow('CANVAS_MEDIA_SAVE_INPUT_INVALID: outputs 至少需要 1 项')
  })

  test('Given 输出 key 重复、顺序不连续或主输出无效 When 保存草稿 Then 返回对应合同诊断', () => {
    const base = {
      projectId: 'project-1', canvasId: 'canvas-1', nodeId: 'node-1',
      mediaModuleId: 'media-1', mediaKind: 'video' as const, expectedConfigRevision: 0,
      profile: null,
      inputs: [],
    }
    expect(() => parseSaveCanvasMediaModuleInput({
      ...base,
      outputs: [
        { key: 'video', mediaKind: 'video', role: 'primary', order: 0 },
        { key: 'video', mediaKind: 'image', role: 'preview', order: 1 },
      ],
    })).toThrow('CANVAS_MEDIA_SAVE_INPUT_INVALID: outputs[1].key 与前项重复')
    expect(() => parseSaveCanvasMediaModuleInput({
      ...base,
      outputs: [
        { key: 'video', mediaKind: 'video', role: 'primary', order: 0 },
        { key: 'poster', mediaKind: 'image', role: 'preview', order: 2 },
      ],
    })).toThrow('CANVAS_MEDIA_SAVE_INPUT_INVALID: outputs[1].order 必须为 1')
    expect(() => parseSaveCanvasMediaModuleInput({
      ...base,
      outputs: [{ key: 'video', mediaKind: 'video', role: 'preview', order: 0 }],
    })).toThrow('CANVAS_MEDIA_SAVE_INPUT_INVALID: outputs 必须且只能有 1 项 primary')
    expect(() => parseSaveCanvasMediaModuleInput({
      ...base,
      outputs: [{ key: 'audio', mediaKind: 'audio', role: 'primary', order: 0 }],
    })).toThrow('CANVAS_MEDIA_SAVE_INPUT_INVALID: primary 输出的 mediaKind 必须为 video')
  })

  test('Given 输入字段错误 When 保存草稿 Then 返回可操作原因且完整空输入草稿仍可保存', () => {
    const base = {
      projectId: 'project-1', canvasId: 'canvas-1', nodeId: 'node-1',
      mediaModuleId: 'media-1', mediaKind: 'video' as const, expectedConfigRevision: 0,
      profile: null,
      outputs: [{ key: 'video', mediaKind: 'video' as const, role: 'primary' as const, order: 0 }],
    }
    expect(() => parseSaveCanvasMediaModuleInput({
      ...base,
      inputs: [{ key: 'prompt', kind: 'text' }],
    })).toThrow('CANVAS_MEDIA_SAVE_INPUT_INVALID: inputs[0] 缺少 source')
    expect(parseSaveCanvasMediaModuleInput({ ...base, inputs: [] }).inputs).toEqual([])
  })

  test('Given 公共工作流版本和连接 When 保存配置 Then 固定引用且拒绝与旧 profile 混用', () => {
    const workflow = { workflowId: 'public-video', workflowRevision: 3, connectionId: 'gpu-main' }
    const parsed = parseCanvasMediaModuleConfig({
      ...createConfig(),
      profile: null,
      workflow,
    })
    expect(parsed.workflow).toEqual(workflow)

    expect(() => parseCanvasMediaModuleConfig({ ...createConfig(), workflow })).toThrow(
      'CANVAS_MEDIA_SOURCE_CONFLICT',
    )
  })

  test('Given 旧 profile 配置没有 workflow 字段 When 解析 Then 保持兼容且不补写字段', () => {
    const parsed = parseCanvasMediaModuleConfig(createConfig())
    expect(Object.hasOwn(parsed, 'workflow')).toBeFalse()
  })

  test('Given 待配置错误存在或显式清除 When 解析媒体配置与保存命令 Then 严格保留安全诊断', () => {
    const preparation = {
      code: 'UI_SUBGRAPH_INPUT_MISMATCH',
      message: '节点 105 的输入 image 与工作流定义不一致。',
    }
    expect(parseCanvasMediaModuleConfig({ ...createConfig(), preparation }).preparation).toEqual(preparation)
    expect(parseSaveCanvasMediaModuleInput({
      projectId: 'project-1', canvasId: 'canvas-1', nodeId: 'node-1',
      mediaModuleId: 'media-1', mediaKind: 'video',
      expectedConfigRevision: 0,
      profile: null,
      preparation: null,
      inputs: [{ key: 'prompt', kind: 'text', source: { type: 'literal', value: '海边日落' } }],
      outputs: [{ key: 'video', mediaKind: 'video', role: 'primary', order: 0 }],
    }).preparation).toBeNull()
  })

  test('Given 待配置错误越界 When 严格解析 Then 拒绝未知字段与不安全内容', () => {
    const invalidIssues = [
      { code: 'lowercase', message: '错误' },
      { code: `A${'B'.repeat(96)}`, message: '错误' },
      { code: 'WORKFLOW_INVALID', message: '' },
      { code: 'WORKFLOW_INVALID', message: '错'.repeat(2_049) },
      { code: 'WORKFLOW_INVALID', message: '错误', secret: 'token' },
    ]
    for (const preparation of invalidIssues) {
      expect(() => parseCanvasMediaModuleConfig({ ...createConfig(), preparation })).toThrow(
        'CANVAS_MEDIA_PREPARATION_INVALID',
      )
    }
  })

  test('Given audio/video 节点 When 解析工作区与创建命令 Then 只接受 mediaModuleId 图引用', () => {
    const snapshot = parseCanvasWorkspaceSnapshot({
      document: {
        schemaVersion: 4, projectId: 'project-1', canvasId: 'canvas-1', revision: 1,
        viewport: { x: 0, y: 0, zoom: 1 },
        nodes: [
          { id: 'audio-1', kind: 'audio', title: '音轨', position: { x: 0, y: 0 }, mediaModuleId: 'media-a' },
          { id: 'video-1', kind: 'video', title: '视频', position: { x: 300, y: 0 }, mediaModuleId: 'media-v' },
        ],
        edges: [], createdAt: 1, updatedAt: 1,
      },
      writable: true,
      nodeIssues: [],
    })
    expect(snapshot.document.nodes.map((node) => node.kind)).toEqual(['audio', 'video'])
    expect(parseCreateCanvasContentNodeInput({
      projectId: 'project-1', canvasId: 'canvas-1',
      operationId: '123e4567-e89b-42d3-a456-426614174000', nodeId: 'audio-1',
      kind: 'audio', contentId: 'media-a', title: '音轨', position: { x: 0, y: 0 }, expectedRevision: 1,
    }).kind).toBe('audio')
  })

  test('Given 音频来源连接视频节点 When 建立执行边 Then 使用 audio.reference 而非视频完成端口', () => {
    expect(createCanvasBoundEdge(
      { id: 'audio-1', kind: 'audio' },
      { id: 'video-1', kind: 'video' },
      { id: 'edge-1', sourceNodeId: 'audio-1', targetNodeId: 'video-1', relation: 'depends-on' },
    )).toMatchObject({ sourcePort: 'audio.asset', targetPort: 'audio.reference' })
  })
})
