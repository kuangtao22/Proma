import { describe, expect, test } from 'bun:test'
import {
  CANVAS_SESSION_TITLE_MAX_LENGTH,
  DESIGN_DOCUMENT_VERSION,
  DESIGN_IPC_CHANNELS,
  IMAGE_GENERATION_MODEL_ID_MAX_LENGTH,
  IMAGE_GENERATION_MODEL_NAME_MAX_LENGTH,
  createEmptyDesignDocument,
} from './design'
import type {
  CanvasSessionChangeEvent,
  CanvasSessionMeta,
  CreateCanvasSessionInput,
  DeleteCanvasSessionInput,
  CreateDesignJobInput,
  CreateDesignJobTarget,
  DesignAsset,
  DesignContextEntry,
  DesignImageModelSelection,
  ImageGenerationChannelOption,
  ImageGenerationModelCatalogResult,
  ImageGenerationModelProfile,
  ImageGenerationModelSnapshot,
  ListCanvasSessionsInput,
  SaveImageGenerationModelProfilesInput,
  ImportDesignAssetsInput,
  DesignJobRecord,
  DesignJobTarget,
  DesignTaskDetails,
  SaveDesignMutationsInput,
  UpdateCanvasSessionInput,
  UpdateDesignImageModelSelectionInput,
} from './design'

/** 编译期锁定素材公开字段，字段缺失或改名会直接导致类型检查失败。 */
const assetContract = {
  id: 'asset-1',
  filename: 'demo.png',
  relativePath: 'assets/demo.png',
  thumbnailRelativePath: 'thumbnails/demo.webp',
  mediaType: 'image/png',
  width: 100,
  height: 80,
  byteSize: 1024,
  sha256: 'abc',
  createdAt: 100,
} satisfies DesignAsset

/** 编译期锁定任务与保存输入的关键字段。 */
const jobContract = {
  id: 'job-1',
  creativeTaskId: 'creative-1',
  attemptNumber: 1,
  projectId: 'project-1',
  target: {
    kind: 'design-canvas',
    nodeId: 'node-1',
    position: { x: 10, y: 20 },
  },
  action: 'generate',
  status: 'queued',
  prompt: '生成图片',
  originalRequest: '生成图片',
  contextMode: 'none',
  traceState: 'pending',
  executionSessionCleanupState: 'pending',
  createdAt: 100,
  updatedAt: 100,
} satisfies DesignJobRecord

/** 编译期锁定新任务必须显式携带生图模型 profile。 */
const createJobContract = {
  projectId: 'project-1',
  action: 'generate',
  prompt: '生成图片',
  contextMode: 'auto',
  imageModelProfileId: 'profile-flash',
  target: { kind: 'design-canvas', position: { x: 10, y: 20 } },
} satisfies CreateDesignJobInput

/** 编译期锁定创建阶段的 Canvas 图片目标不提前包含旧 Design 布局位置。 */
const createCanvasImageTargetContract = {
  kind: 'canvas-image',
  canvasId: 'canvas-1',
  nodeId: 'image-1',
  imageModuleId: 'module-1',
} satisfies CreateDesignJobTarget

/** 编译期锁定持久化 Canvas 图片目标不要求旧 Design 节点位置。 */
const canvasImageTargetContract = {
  kind: 'canvas-image',
  canvasId: 'canvas-1',
  nodeId: 'image-1',
  imageModuleId: 'module-1',
} satisfies DesignJobTarget

/** 编译期锁定创作上下文只保存可移植引用，不暴露来源绝对路径。 */
const contextEntryContract = {
  id: 'context-brand',
  projectId: 'project-1',
  category: 'brand',
  kind: 'document',
  title: '品牌视觉规范',
  relativePath: 'documents/context-brand.md',
  tags: ['首页'],
  source: 'user',
  updatedAt: 10,
} satisfies DesignContextEntry

/** 编译期锁定任务 journal 可固化的生图模型快照。 */
const imageModelSnapshotContract = {
  profileId: 'profile-flash',
  name: '快速模型',
  executor: 'nano-banana',
  modelId: 'gemini-2.5-flash-image',
} satisfies ImageGenerationModelSnapshot

/** 编译期锁定渠道引用型 GPT Image 2 profile 与任务快照。 */
const openAIImageModelProfileContract = {
  id: 'profile-gpt-image-2',
  name: 'GPT Image 2',
  executor: 'openai-images',
  channelId: 'channel-openai-images',
  modelId: 'gpt-image-2',
  enabled: true,
  createdAt: 100,
  updatedAt: 100,
} satisfies ImageGenerationModelProfile

/** 编译期锁定 GPT Image 2 快照只保存渠道引用，不保存连接与凭据。 */
const openAIImageModelSnapshotContract = {
  profileId: openAIImageModelProfileContract.id,
  name: openAIImageModelProfileContract.name,
  executor: openAIImageModelProfileContract.executor,
  channelId: openAIImageModelProfileContract.channelId,
  modelId: openAIImageModelProfileContract.modelId,
} satisfies ImageGenerationModelSnapshot

/** 编译期锁定 Renderer 只能读取清洗后的渠道与启用模型。 */
const imageGenerationChannelContract = {
  channelId: 'channel-openai-images',
  name: 'GPT Image 服务',
  available: true,
  models: [{ id: 'gpt-image-2', name: 'GPT Image 2' }],
} satisfies ImageGenerationChannelOption

/** 编译期锁定模型目录与保存输入的公开形状。 */
const imageModelCatalogContract = {
  profiles: [{
    id: 'profile-flash',
    name: '快速模型',
    executor: 'nano-banana',
    modelId: 'gemini-2.5-flash-image',
    enabled: true,
    createdAt: 100,
    updatedAt: 100,
  }],
  channelOptions: [],
  inheritedFromLegacyConfig: false,
  credentialsConfigured: true,
} satisfies ImageGenerationModelCatalogResult

/** 编译期锁定 profile 保存输入。 */
const saveImageModelProfilesContract = {
  profiles: imageModelCatalogContract.profiles,
} satisfies SaveImageGenerationModelProfilesInput

/** 编译期锁定项目级可用模型、当前选择与失效选择。 */
const imageModelSelectionContract = {
  projectId: 'project-1',
  options: [{ ...imageModelSnapshotContract, available: true }],
  selectedProfileId: 'profile-flash',
  invalidSelectedProfileId: 'profile-disabled',
} satisfies DesignImageModelSelection

/** 编译期锁定项目级模型选择更新输入。 */
const updateImageModelSelectionContract = {
  projectId: 'project-1',
  imageModelProfileId: 'profile-flash',
} satisfies UpdateDesignImageModelSelectionInput

/** 编译期锁定 revision 保存契约。 */
const saveContract = {
  projectId: 'project-1',
  expectedRevision: 0,
  mutations: [],
} satisfies SaveDesignMutationsInput

/** 编译期锁定原子导入的 revision 与布局输入。 */
const importContract = {
  projectId: 'project-1',
  expectedRevision: 0,
  viewportCenter: { x: 100, y: 200 },
} satisfies ImportDesignAssetsInput

describe('Design 共享契约', () => {
  test('Given 一个项目 When 创建空画布 Then 使用稳定项目 ID、版本和初始视口', () => {
    const document = createEmptyDesignDocument('project-1', 100)

    expect(document).toEqual({
      schemaVersion: DESIGN_DOCUMENT_VERSION,
      projectId: 'project-1',
      revision: 0,
      viewport: { x: 0, y: 0, zoom: 1 },
      nodes: [],
      assets: [],
      groups: [],
      annotations: [],
      createdAt: 100,
      updatedAt: 100,
    })
  })

  test('Given Design IPC When 枚举通道 Then 不复用 Agent 或文件预览通道', () => {
    /** 全部 Design IPC 通道值。 */
    const channels = Object.values(DESIGN_IPC_CHANNELS)
    expect(new Set(channels).size).toBe(
      Object.keys(DESIGN_IPC_CHANNELS).length,
    )
    expect(channels.every((channel) => channel.startsWith('design:'))).toBe(true)
    expect(DESIGN_IPC_CHANNELS.LOAD).toBe('design:load')
    expect(DESIGN_IPC_CHANNELS.LIST_IMAGE_MODEL_PROFILES).toBe('design:list-image-model-profiles')
    expect(DESIGN_IPC_CHANNELS.SAVE_IMAGE_MODEL_PROFILES).toBe('design:save-image-model-profiles')
    expect(DESIGN_IPC_CHANNELS.GET_IMAGE_MODEL_SELECTION).toBe('design:get-image-model-selection')
    expect(DESIGN_IPC_CHANNELS.SET_IMAGE_MODEL_SELECTION).toBe('design:set-image-model-selection')
    expect(DESIGN_IPC_CHANNELS.IMAGE_MODEL_PROFILES_CHANGED).toBe('design:image-model-profiles-changed')
    expect(DESIGN_IPC_CHANNELS.IMAGE_MODEL_SELECTION_CHANGED).toBe('design:image-model-selection-changed')
    expect(DESIGN_IPC_CHANNELS.GET_TASK_DETAILS).toBe('design:get-task-details')
    expect(DESIGN_IPC_CHANNELS.GET_TASK_TRACE).toBe('design:get-task-trace')
    expect(DESIGN_IPC_CHANNELS.LIST_CONTEXT).toBe('design:list-context')
    expect(DESIGN_IPC_CHANNELS.UPSERT_CONTEXT_DOCUMENT).toBe('design:upsert-context-document')
    expect(DESIGN_IPC_CHANNELS.IMPORT_CONTEXT_DOCUMENT).toBe('design:import-context-document')
    expect(DESIGN_IPC_CHANNELS.UPDATE_CONTEXT).toBe('design:update-context')
    expect(DESIGN_IPC_CHANNELS.REGISTER_CONTEXT_ASSET).toBe('design:register-context-asset')
    expect(DESIGN_IPC_CHANNELS.DELETE_CONTEXT).toBe('design:delete-context')
    expect(DESIGN_IPC_CHANNELS.CHANGED).toBe('design:changed')
  })

  test('Given Canvas 会话合同 When 构造公开值 Then 身份与通道保持稳定', () => {
    /** 固定时间用于验证公开元数据不依赖运行环境。 */
    const now = 100
    /** Canvas 顶层会话样例，不携带 Agent runtime 字段。 */
    const session: CanvasSessionMeta = {
      id: 'canvas-1',
      projectId: 'project-1',
      title: 'App 页面设计',
      archived: false,
      createdAt: now,
      updatedAt: now,
    }
    /** 四层 IPC 使用的结构化请求样例。 */
    const listInput: ListCanvasSessionsInput = { projectId: 'project-1', archived: false }
    /** 新建请求只接受项目与可选标题。 */
    const createInput: CreateCanvasSessionInput = { projectId: 'project-1', title: 'App 页面设计' }
    /** 更新请求只允许标题和归档状态。 */
    const updateInput: UpdateCanvasSessionInput = {
      projectId: 'project-1',
      canvasId: 'canvas-1',
      title: 'App 页面视觉',
      archived: true,
    }
    /** 删除请求只携带项目与 Canvas 双重身份。 */
    const deleteInput: DeleteCanvasSessionInput = {
      projectId: 'project-1',
      canvasId: 'canvas-1',
    }
    /** 成功提交后的公开变化事件。 */
    const event: CanvasSessionChangeEvent = {
      projectId: 'project-1',
      canvasId: 'canvas-1',
      cause: 'updated',
    }

    expect(session).toEqual({
      id: 'canvas-1',
      projectId: 'project-1',
      title: 'App 页面设计',
      archived: false,
      createdAt: now,
      updatedAt: now,
    })
    expect([listInput, createInput, updateInput, deleteInput, event]).toHaveLength(5)
    expect(CANVAS_SESSION_TITLE_MAX_LENGTH).toBe(120)
    expect(DESIGN_IPC_CHANNELS.LIST_CANVAS_SESSIONS).toBe('design:list-canvas-sessions')
    expect(DESIGN_IPC_CHANNELS.CREATE_CANVAS_SESSION).toBe('design:create-canvas-session')
    expect(DESIGN_IPC_CHANNELS.UPDATE_CANVAS_SESSION).toBe('design:update-canvas-session')
    expect(DESIGN_IPC_CHANNELS.DELETE_CANVAS_SESSION).toBe('design:delete-canvas-session')
    expect(DESIGN_IPC_CHANNELS.CANVAS_SESSION_CHANGED).toBe('design:canvas-session-changed')
  })

  test('Given Design 上下文条目 When 序列化 Then 只包含稳定 ID、相对路径或 assetId', () => {
    /** 公开序列化结果不得泄露用户选择文件的来源绝对路径。 */
    const encoded = JSON.stringify(contextEntryContract)

    expect(contextEntryContract.relativePath.startsWith('/')).toBe(false)
    expect('absolutePath' in contextEntryContract).toBe(false)
    expect(encoded).not.toContain('/Users/')
  })

  test('Given Design 首次尝试 When 构造公开记录 Then 创作任务与执行尝试拥有独立身份', () => {
    expect(jobContract.creativeTaskId).not.toBe(jobContract.id)
    expect(jobContract.attemptNumber).toBe(1)
  })

  test('Given Canvas Job target When 读取类型 Then 不要求旧画布 position', () => {
    expect(createCanvasImageTargetContract).toEqual(canvasImageTargetContract)
    expect('position' in canvasImageTargetContract).toBe(false)
  })

  test('Given 任务详情契约 When 序列化 Then 不包含内部会话或凭据字段', () => {
    /** Renderer 可读取的轻量任务详情。 */
    const details = {
      creativeTaskId: 'creative-1',
      currentJobId: 'job-1',
      attempts: [],
      traceState: 'ready',
    } satisfies DesignTaskDetails
    /** 用公开序列化结果验证敏感字段不会进入契约。 */
    const encoded = JSON.stringify(details)

    expect(encoded).not.toContain('apiKey')
    expect(encoded).not.toContain('Authorization')
    expect(encoded).not.toContain('sessionId')
  })

  test('Given 固定公开类型 When 编译契约 Then 保留素材、任务和 revision 输入字段', () => {
    expect(assetContract.id).toBe('asset-1')
    expect(jobContract.status).toBe('queued')
    expect(jobContract).not.toHaveProperty('imageModelSnapshot')
    expect(createJobContract.imageModelProfileId).toBe('profile-flash')
    expect(createJobContract.contextMode).toBe('auto')
    expect(imageModelSnapshotContract.executor).toBe('nano-banana')
    expect(openAIImageModelSnapshotContract.executor).toBe('openai-images')
    expect(imageGenerationChannelContract.models).toEqual([
      { id: 'gpt-image-2', name: 'GPT Image 2' },
    ])
    expect(JSON.stringify(imageGenerationChannelContract)).not.toContain('apiKey')
    expect(JSON.stringify(imageGenerationChannelContract)).not.toContain('baseUrl')
    expect(saveImageModelProfilesContract.profiles).toHaveLength(1)
    expect(imageModelSelectionContract.options[0]?.available).toBe(true)
    expect(updateImageModelSelectionContract.imageModelProfileId).toBe('profile-flash')
    expect(saveContract.expectedRevision).toBe(0)
    expect(importContract.viewportCenter).toEqual({ x: 100, y: 200 })
  })

  test('Given 生图模型展示字段 When 读取共享限制 Then 名称和模型 ID 使用独立保守上限', () => {
    expect(IMAGE_GENERATION_MODEL_NAME_MAX_LENGTH).toBe(128)
    expect(IMAGE_GENERATION_MODEL_ID_MAX_LENGTH).toBe(256)
  })
})
