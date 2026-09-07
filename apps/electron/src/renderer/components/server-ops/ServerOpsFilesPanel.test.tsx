import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { createServerOpsFilePreviewGuard, ServerOpsFilesPanel } from './ServerOpsFilesPanel'
import type { ServerOpsFilesPreload } from '../../../preload/server-ops-files-preload'

describe('服务器运维文件面板', () => {
  test('连接后提供路径、搜索、新建目录和受控预览区域', () => {
    const api = createApi()
    const html = renderToStaticMarkup(<ServerOpsFilesPanel api={api} hostId="host-1" hostLabel="生产机" hostDescription="deploy@example:22" active connected />)
    expect(html).toContain('aria-label="远程目录路径"')
    expect(html).toContain('aria-label="搜索已加载文件"')
    expect(html).toContain('新建目录')
    expect(html).toContain('上传')
    expect(html).toContain('aria-label="文件预览"')
    expect(html).not.toContain('ownerKey')
  })

  test('断开连接时不暴露文件动作', () => {
    const html = renderToStaticMarkup(<ServerOpsFilesPanel api={createApi()} hostId="host-1" hostLabel="生产机" active connected={false} />)
    expect(html).toContain('连接服务器后浏览远程文件')
    expect(html).not.toContain('新建目录')
  })

  test('连续选择文件时只接纳最后一次预览结果，导航会失效在途预览', async () => {
    const guard = createServerOpsFilePreviewGuard()
    const accepted: string[] = []
    const first = guard.begin()
    const second = guard.begin()
    await Promise.resolve().then(() => { if (guard.accepts(second)) accepted.push('B') })
    await Promise.resolve().then(() => { if (guard.accepts(first)) accepted.push('A') })
    expect(accepted).toEqual(['B'])
    const navigating = guard.begin()
    guard.invalidate()
    expect(guard.accepts(navigating)).toBe(false)
  })
})

function createApi(): ServerOpsFilesPreload {
  return {
    listServerOpsFiles: async (input) => ({ hostId: input.hostId, path: input.path, entries: [] }),
    previewServerOpsFile: async () => { throw new Error('unused') },
    prepareServerOpsFileMutation: async () => { throw new Error('unused') },
    commitServerOpsFileMutation: async () => { throw new Error('unused') },
    cancelServerOpsFileMutation: async () => undefined,
    closeServerOpsFilesOwner: async () => undefined,
  }
}
