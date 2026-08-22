import { describe, expect, test } from 'bun:test'
import {
  DESIGN_DOCUMENT_VERSION,
  DESIGN_IPC_CHANNELS,
  createEmptyDesignDocument,
} from './design'
import type {
  DesignAsset,
  ImportDesignAssetsInput,
  DesignJobRecord,
  SaveDesignMutationsInput,
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
  projectId: 'project-1',
  action: 'generate',
  status: 'queued',
  prompt: '生成图片',
  createdAt: 100,
  updatedAt: 100,
} satisfies DesignJobRecord

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
    expect(DESIGN_IPC_CHANNELS.CHANGED).toBe('design:changed')
  })

  test('Given 固定公开类型 When 编译契约 Then 保留素材、任务和 revision 输入字段', () => {
    expect(assetContract.id).toBe('asset-1')
    expect(jobContract.status).toBe('queued')
    expect(saveContract.expectedRevision).toBe(0)
    expect(importContract.viewportCenter).toEqual({ x: 100, y: 200 })
  })
})
