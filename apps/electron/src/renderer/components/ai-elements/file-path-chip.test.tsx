import { describe, expect, test } from 'bun:test'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { ResolvableFilePathChip, resolveFilePathEntry } from './file-path-chip'

/**
 * 安装只记录调用次数的 electronAPI 替身。
 *
 * 入参 `resolvedPath`：主进程返回的解析结果，null 表示文件不存在。
 * 返回值：`calls` 读取当前 IPC 次数。
 */
function installFakeElectronAPI(resolvedPath: string | null): { calls: () => number } {
  let calls = 0
  const fakeWindow = {
    electronAPI: {
      resolveAuthorizedFilePath: async (): Promise<{ resolvedPath: string } | null> => {
        calls += 1
        await Promise.resolve()
        return resolvedPath === null ? null : { resolvedPath }
      },
    },
  }
  ;(globalThis as unknown as { window: unknown }).window = fakeWindow
  return { calls: () => calls }
}

describe('ResolvableFilePathChip 解析门控', () => {
  test('Given 主进程尚未返回解析结果 When 渲染路径候选 Then 保留原始 Markdown 外观', () => {
    /** 服务端渲染不会执行 effect，等价于「解析未完成」，用于锁定不提前渲染 Chip 的合同。 */
    const html = renderToStaticMarkup(
      <ResolvableFilePathChip
        filePath="docs/报告.md"
        basePath="/tmp/project"
        fallback={<code className="fallback">docs/报告.md</code>}
      />,
    )

    expect(html).toContain('class="fallback"')
    expect(html).not.toContain('<button')
  })

  test('Given 解析未完成 When 渲染带行号的中文路径 Then 仍只输出 fallback', () => {
    const html = renderToStaticMarkup(
      <ResolvableFilePathChip
        filePath="src/入口.tsx:120"
        basePaths={['/tmp/project', '/tmp/extra']}
        fallback={<span>src/入口.tsx:120</span>}
      />,
    )

    expect(html).toContain('src/入口.tsx:120')
    expect(html).not.toContain('<button')
  })
})

describe('文件解析缓存语义', () => {
  test('Given 主进程确认文件存在 When 再次解析 Then 复用缓存不再发起 IPC', async () => {
    const api = installFakeElectronAPI('/tmp/project/existing.md')

    const first = await resolveFilePathEntry('existing.md', ['/tmp/project'], 'session-cache')
    const second = await resolveFilePathEntry('existing.md', ['/tmp/project'], 'session-cache')

    expect(first.exists).toBe(true)
    expect(second.resolvedPath).toBe('/tmp/project/existing.md')
    expect(api.calls()).toBe(1)
  })

  test('Given 文件此刻不存在 When 稍后再次解析 Then 重新校验以支持本轮新建文件升级', async () => {
    const api = installFakeElectronAPI(null)

    const first = await resolveFilePathEntry('created-later.md', ['/tmp/project'], 'session-cache')
    const second = await resolveFilePathEntry('created-later.md', ['/tmp/project'], 'session-cache')

    expect(first.exists).toBe(false)
    expect(second.exists).toBe(false)
    expect(api.calls()).toBe(2)
  })

  test('Given 同一路径并发解析 When 两个调用同时发起 Then 复用同一次在途 IPC', async () => {
    const api = installFakeElectronAPI('/tmp/project/dedup.md')

    await Promise.all([
      resolveFilePathEntry('dedup.md', ['/tmp/project'], 'session-cache'),
      resolveFilePathEntry('dedup.md', ['/tmp/project'], 'session-cache'),
    ])

    expect(api.calls()).toBe(1)
  })

  test('Given Tooltip 复查要求最新事实 When 缓存已有结果 Then 仍然重新解析', async () => {
    const api = installFakeElectronAPI('/tmp/project/refresh.md')

    await resolveFilePathEntry('refresh.md', ['/tmp/project'], 'session-cache')
    await resolveFilePathEntry('refresh.md', ['/tmp/project'], 'session-cache', { bypassCache: true })

    expect(api.calls()).toBe(2)
  })

  test('Given 不同会话解析同一相对路径 When 会话授权上下文不同 Then 缓存互不复用', async () => {
    const api = installFakeElectronAPI('/tmp/project/isolated.md')

    await resolveFilePathEntry('isolated.md', ['/tmp/project'], 'session-a')
    await resolveFilePathEntry('isolated.md', ['/tmp/project'], 'session-b')

    expect(api.calls()).toBe(2)
  })
})
