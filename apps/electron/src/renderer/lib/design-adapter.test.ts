import { describe, expect, test } from 'bun:test'
import { createEmptyDesignDocument } from '@proma/shared'
import type { SaveDesignMutationsInput } from '@proma/shared'
import { createDesignAdapter, type PartialDesignApi } from './design-adapter'

describe('Design renderer adapter', () => {
  test('Given preload 拒绝加载 When adapter 调用 Then 保留稳定错误供 UI 展示', async () => {
    const adapter = createDesignAdapter({
      loadDesignWorkspace: async () => { throw new Error('项目离线，只能查看缓存') },
    } as PartialDesignApi)
    await expect(adapter.load('project-1')).rejects.toThrow('项目离线，只能查看缓存')
  })

  test('Given 注入完整 preload API When 调用 Then adapter 不改写参数与返回值', async () => {
    const document = createEmptyDesignDocument('project-1', 10)
    const snapshot = { document, writable: true }
    /** preload 实际收到的保存参数。 */
    let receivedInput: SaveDesignMutationsInput | undefined
    const api: PartialDesignApi = {
      loadDesignWorkspace: async () => snapshot,
      saveDesignMutations: async (input) => { receivedInput = input; return document },
      releaseDesignMediaAccess: async () => undefined,
      onDesignChanged: () => () => undefined,
    }
    const adapter = createDesignAdapter(api)
    expect(await adapter.load('project-1')).toBe(snapshot)
    const input = { projectId: 'project-1', expectedRevision: 1, mutations: [] }
    expect(await adapter.save(input)).toBe(document)
    expect(receivedInput).toBe(input)
    await expect(adapter.releaseMediaAccess()).resolves.toBeUndefined()
  })
})
