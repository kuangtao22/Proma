import { describe, expect, test } from 'bun:test'
import {
  DESIGN_DOCUMENT_VERSION,
  DESIGN_IPC_CHANNELS,
  createEmptyDesignDocument,
} from './design'

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
    expect(new Set(Object.values(DESIGN_IPC_CHANNELS)).size).toBe(
      Object.keys(DESIGN_IPC_CHANNELS).length,
    )
    expect(DESIGN_IPC_CHANNELS.LOAD).toBe('design:load')
    expect(DESIGN_IPC_CHANNELS.CHANGED).toBe('design:changed')
  })
})
