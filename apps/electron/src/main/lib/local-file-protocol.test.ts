import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { fstatSync, mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  createPromaFileProtocolRegistry,
  handlePromaFileRequest,
  registerPromaDirectoryPath,
  revokePromaPathUrl,
} from './local-file-protocol'

describe('proma-file 目录授权', () => {
  /** 授权目录的隔离根。 */
  let root: string
  /** 授权目录外的隔离根。 */
  let outsideRoot: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'proma-local-file-root-'))
    outsideRoot = mkdtempSync(join(tmpdir(), 'proma-local-file-outside-'))
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
    rmSync(outsideRoot, { recursive: true, force: true })
  })

  test('Given 已注册目录 When 读取目录内文件 Then 返回成功响应', async () => {
    const filePath = join(root, 'preview.webp')
    writeFileSync(filePath, 'preview', 'utf8')
    const baseUrl = registerPromaDirectoryPath(root)

    const response = await handlePromaFileRequest(new Request(`${baseUrl}/preview.webp`))

    expect(response.status).toBe(200)
    expect(await response.text()).toBe('preview')
  })

  test('Given 单段 Range When 读取媒体 Then 从稳定 fd 流式返回 206 与精确区间', async () => {
    writeFileSync(join(root, 'preview.webp'), '0123456789', 'utf8')
    const registry = createPromaFileProtocolRegistry({ now: () => 0 })
    const baseUrl = registry.registerDirectoryPath(root)

    const response = await registry.handleRequest(new Request(`${baseUrl}/preview.webp`, {
      headers: { Range: 'bytes=2-5' },
    }))

    expect(response.status).toBe(206)
    expect(response.headers.get('content-range')).toBe('bytes 2-5/10')
    expect(response.headers.get('content-length')).toBe('4')
    expect(response.headers.get('accept-ranges')).toBe('bytes')
    expect(await response.text()).toBe('2345')
  })

  test('Given 已授权 Buffer 注册为单文件 token When 原路径被替换 Then 协议始终返回授权内容', async () => {
    const filePath = join(root, 'preview.webp')
    const replacementPath = join(outsideRoot, 'replacement.webp')
    writeFileSync(filePath, 'authorized-content', 'utf8')
    writeFileSync(replacementPath, 'replacement-content', 'utf8')
    const registry = createPromaFileProtocolRegistry({ now: () => 0 })
    const authorizedContent = Buffer.from('authorized-content')
    const fileUrl = registry.registerAuthorizedFile(filePath, authorizedContent)
    renameSync(replacementPath, filePath)

    const response = await registry.handleRequest(new Request(fileUrl))

    expect(response.status).toBe(200)
    expect(await response.text()).toBe('authorized-content')
    registry.revokePathUrl(fileUrl)
    registry.revokePathUrl(fileUrl)
    expect((await registry.handleRequest(new Request(fileUrl))).status).toBe(404)
  })

  test('Given 已授权 Buffer 超过总预算 When 注册新 token Then LRU 淘汰且单项超限明确拒绝', async () => {
    let currentTime = 0
    const registry = createPromaFileProtocolRegistry({
      now: () => currentTime,
      maxAuthorizedBufferBytes: 20,
    })
    const firstUrl = registry.registerAuthorizedFile(join(root, 'first.webp'), Buffer.alloc(10))
    currentTime = 1
    const secondUrl = registry.registerAuthorizedFile(join(root, 'second.webp'), Buffer.alloc(15))

    expect((await registry.handleRequest(new Request(firstUrl))).status).toBe(404)
    expect((await registry.handleRequest(new Request(secondUrl))).status).toBe(200)
    expect(() => registry.registerAuthorizedFile(join(root, 'oversized.webp'), Buffer.alloc(21)))
      .toThrow('本地文件授权内容超过内存预算')
  })

  test('Given Buffer 响应达到并发字节预算 When 再发起响应 Then 拒绝且取消后释放预算', async () => {
    const registry = createPromaFileProtocolRegistry({
      now: () => 0,
      maxActiveResponseBytes: 100 * 1024 * 1024,
    })
    const firstUrl = registry.registerAuthorizedFile(join(root, 'first.bin'), Buffer.alloc(100 * 1024 * 1024, 1))
    const secondUrl = registry.registerAuthorizedFile(join(root, 'second.bin'), Buffer.alloc(1, 2))

    const firstResponse = await registry.handleRequest(new Request(firstUrl))
    expect(firstResponse.status).toBe(200)
    expect((await registry.handleRequest(new Request(secondUrl))).status).toBe(429)

    await firstResponse.body!.cancel()
    expect((await registry.handleRequest(new Request(secondUrl))).status).toBe(200)
  })

  test('Given Buffer Range 与 HEAD When 计算并发预算 Then Range 按区间计费且 HEAD 不占预算', async () => {
    const registry = createPromaFileProtocolRegistry({ now: () => 0, maxActiveResponseBytes: 4 })
    const fileUrl = registry.registerAuthorizedFile(join(root, 'preview.bin'), Buffer.from('0123456789'))

    const head = await registry.handleRequest(new Request(fileUrl, { method: 'HEAD' }))
    const range = await registry.handleRequest(new Request(fileUrl, { headers: { Range: 'bytes=2-5' } }))

    expect(head.status).toBe(200)
    expect(head.body).toBeNull()
    expect(range.status).toBe(206)
    expect(await range.text()).toBe('2345')
  })

  test('Given Buffer token 在流式响应中被释放 When 继续消费 Then 在途响应保持有效', async () => {
    const registry = createPromaFileProtocolRegistry({ now: () => 0 })
    const fileUrl = registry.registerAuthorizedFile(join(root, 'preview.bin'), Buffer.alloc(256 * 1024, 7))
    const response = await registry.handleRequest(new Request(fileUrl))
    const reader = response.body!.getReader()

    const firstChunk = await reader.read()
    expect(firstChunk.done).toBe(false)
    registry.revokePathUrl(fileUrl)
    let receivedBytes = firstChunk.value?.byteLength ?? 0
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      receivedBytes += chunk.value.byteLength
    }

    expect(receivedBytes).toBe(256 * 1024)
    expect((await registry.handleRequest(new Request(fileUrl))).status).toBe(404)
  })

  test('Given Range 起点越过文件末尾 When 读取媒体 Then 返回 416 与完整大小', async () => {
    writeFileSync(join(root, 'preview.webp'), 'preview', 'utf8')
    const registry = createPromaFileProtocolRegistry({ now: () => 0 })
    const baseUrl = registry.registerDirectoryPath(root)

    const response = await registry.handleRequest(new Request(`${baseUrl}/preview.webp`, {
      headers: { Range: 'bytes=99-' },
    }))

    expect(response.status).toBe(416)
    expect(response.headers.get('content-range')).toBe('bytes */7')
    expect(await response.text()).toBe('')
  })

  test('Given HEAD 请求 When 读取媒体 Then 只返回完整响应头并立即关闭 fd', async () => {
    writeFileSync(join(root, 'preview.webp'), 'preview', 'utf8')
    /** 捕获协议稳定打开的 descriptor，验证 HEAD 不把句柄留给空 body。 */
    let openedDescriptor: number | undefined
    const registry = createPromaFileProtocolRegistry({
      now: () => 0,
      onDescriptorOpened: (descriptor) => { openedDescriptor = descriptor },
    })
    const baseUrl = registry.registerDirectoryPath(root)

    const response = await registry.handleRequest(new Request(`${baseUrl}/preview.webp`, { method: 'HEAD' }))

    expect(response.status).toBe(200)
    expect(response.headers.get('content-length')).toBe('7')
    expect(response.body).toBeNull()
    expect(() => fstatSync(openedDescriptor!)).toThrow()
  })

  test('Given 流式响应尚未读完 When 取消 body Then 立即关闭稳定 fd', async () => {
    writeFileSync(join(root, 'large.webp'), Buffer.alloc(1024 * 1024, 1))
    /** 捕获稳定 fd，取消后 EBADF 证明没有句柄泄漏。 */
    let openedDescriptor: number | undefined
    const registry = createPromaFileProtocolRegistry({
      now: () => 0,
      onDescriptorOpened: (descriptor) => { openedDescriptor = descriptor },
    })
    const baseUrl = registry.registerDirectoryPath(root)
    const response = await registry.handleRequest(new Request(`${baseUrl}/large.webp`))
    const reader = response.body!.getReader()

    expect(() => fstatSync(openedDescriptor!)).not.toThrow()
    const firstChunk = await reader.read()
    expect(firstChunk.done).toBe(false)
    await reader.cancel()

    expect(() => fstatSync(openedDescriptor!)).toThrow()
  })

  test('Given 已释放目录授权 When 再次读取 Then 返回 404', async () => {
    writeFileSync(join(root, 'preview.webp'), 'preview', 'utf8')
    const baseUrl = registerPromaDirectoryPath(root)

    revokePromaPathUrl(baseUrl)
    const response = await handlePromaFileRequest(new Request(`${baseUrl}/preview.webp`))

    expect(response.status).toBe(404)
  })

  test('Given 路径包含上级目录 When 读取 Then 不允许逃逸授权目录', async () => {
    writeFileSync(join(outsideRoot, 'secret.txt'), 'secret', 'utf8')
    const baseUrl = registerPromaDirectoryPath(root)
    const response = await handlePromaFileRequest(
      new Request(`${baseUrl}/..%2F${encodeURIComponent(join(outsideRoot, 'secret.txt'))}`),
    )

    expect([403, 404]).toContain(response.status)
  })

  test('Given 目录内符号链接指向外部 When 读取 Then 返回 403', async () => {
    const outsidePath = join(outsideRoot, 'secret.txt')
    writeFileSync(outsidePath, 'secret', 'utf8')
    symlinkSync(outsidePath, join(root, 'linked.txt'))
    const baseUrl = registerPromaDirectoryPath(root)

    const response = await handlePromaFileRequest(new Request(`${baseUrl}/linked.txt`))

    expect(response.status).toBe(403)
  })

  test('Given URL 包含非法百分号编码 When 读取 Then 返回受控错误而不抛异常', async () => {
    const baseUrl = registerPromaDirectoryPath(root)

    const response = await handlePromaFileRequest(new Request(`${baseUrl}/invalid%path`))

    expect(response.status).toBe(400)
  })

  test('Given token 已闲置超过 TTL When 请求 Then 立即删除并返回 404', async () => {
    /** 可精确推进的协议时钟，不修改全局 Date。 */
    let currentTime = 0
    const registry = createPromaFileProtocolRegistry({
      now: () => currentTime,
    })
    writeFileSync(join(root, 'preview.webp'), 'preview', 'utf8')
    const baseUrl = registry.registerDirectoryPath(root)
    currentTime = 60 * 60 * 1000 + 1

    const expired = await registry.handleRequest(new Request(`${baseUrl}/preview.webp`))
    const deleted = await registry.handleRequest(new Request(`${baseUrl}/preview.webp`))

    expect(expired.status).toBe(404)
    expect(deleted.status).toBe(404)
  })

  test('Given token 持续访问 When 其他目录注册触发清理 Then 按最后访问时间保持有效', async () => {
    /** 可精确推进的协议时钟，不修改全局 Date。 */
    let currentTime = 0
    const registry = createPromaFileProtocolRegistry({
      now: () => currentTime,
    })
    writeFileSync(join(root, 'preview.webp'), 'preview', 'utf8')
    const baseUrl = registry.registerDirectoryPath(root)
    currentTime = 30 * 60 * 1000
    expect((await registry.handleRequest(new Request(`${baseUrl}/preview.webp`))).status).toBe(200)

    currentTime = 75 * 60 * 1000
    registry.registerDirectoryPath(outsideRoot)
    const response = await registry.handleRequest(new Request(`${baseUrl}/preview.webp`))

    expect(response.status).toBe(200)
  })

  test('Given realpath 后叶子被替换为根外 symlink When 打开 Then 拒绝越界读取', async () => {
    const previewPath = join(root, 'preview.webp')
    const outsidePath = join(outsideRoot, 'secret.webp')
    writeFileSync(previewPath, 'preview', 'utf8')
    writeFileSync(outsidePath, 'secret', 'utf8')
    /** 在包含关系校验与稳定打开之间模拟攻击者替换叶子。 */
    let replaced = false
    const registry = createPromaFileProtocolRegistry({
      now: () => 0,
      afterResolveBeforeOpen: () => {
        if (replaced) return
        replaced = true
        rmSync(previewPath)
        symlinkSync(outsidePath, previewPath)
      },
    })
    const baseUrl = registry.registerDirectoryPath(root)

    const response = await registry.handleRequest(new Request(`${baseUrl}/preview.webp`))

    expect(response.status).toBe(403)
    expect(await response.text()).not.toContain('secret')
  })

  test('Given realpath 后祖先目录被替换为根外 symlink When 打开 Then 拒绝越界读取', async () => {
    const nestedRoot = join(root, 'nested')
    const movedNestedRoot = join(root, 'moved-nested')
    mkdirSync(nestedRoot)
    writeFileSync(join(nestedRoot, 'preview.webp'), 'preview', 'utf8')
    writeFileSync(join(outsideRoot, 'preview.webp'), 'secret', 'utf8')
    /** 在 realpath 后把原祖先移走，并将原路径替换为指向根外的链接。 */
    let replaced = false
    const registry = createPromaFileProtocolRegistry({
      now: () => 0,
      afterResolveBeforeOpen: () => {
        if (replaced) return
        replaced = true
        renameSync(nestedRoot, movedNestedRoot)
        symlinkSync(outsideRoot, nestedRoot)
      },
    })
    const baseUrl = registry.registerDirectoryPath(root)

    const response = await registry.handleRequest(new Request(`${baseUrl}/nested/preview.webp`))

    expect(response.status).toBe(403)
    expect(await response.text()).not.toContain('secret')
  })

  test('Given Design token 被 pin When 超过 TTL 和容量清理 Then 直到 release 前持续有效', async () => {
    /** pinned token 不因时间或普通 token 容量淘汰失效。 */
    let currentTime = 0
    const registry = createPromaFileProtocolRegistry({ now: () => currentTime })
    writeFileSync(join(root, 'preview.webp'), 'preview', 'utf8')
    const baseUrl = registry.registerDirectoryPath(root)
    registry.retainPathUrl(baseUrl)
    currentTime = 2 * 60 * 60 * 1000
    for (let index = 0; index < 500; index += 1) registry.registerFilePath(join(root, 'preview.webp'))

    expect((await registry.handleRequest(new Request(`${baseUrl}/preview.webp`))).status).toBe(200)
    registry.revokePathUrl(baseUrl)
    expect((await registry.handleRequest(new Request(`${baseUrl}/preview.webp`))).status).toBe(404)
  })

  test('Given 已有 500 个普通 token When 再注册一个 Then 严格淘汰最久未访问 token', async () => {
    const registry = createPromaFileProtocolRegistry({ now: () => 0 })
    writeFileSync(join(root, 'preview.webp'), 'preview', 'utf8')
    /** 第一个 token 应在第 501 次注册前被容量淘汰。 */
    const firstUrl = registry.registerFilePath(join(root, 'preview.webp'))
    for (let index = 1; index <= 500; index += 1) registry.registerFilePath(join(root, 'preview.webp'))

    expect((await registry.handleRequest(new Request(firstUrl))).status).toBe(404)
  })

  test('Given 已有 499 个 retained token When 原子注册两个目录 Then 全部失败且不遗留半个 token', async () => {
    const registry = createPromaFileProtocolRegistry({ now: () => 0 })
    writeFileSync(join(root, 'preview.webp'), 'preview', 'utf8')
    writeFileSync(join(outsideRoot, 'thumbnail.webp'), 'thumbnail', 'utf8')
    const registerRetained = registry.registerRetainedDirectoryPaths
    const retainedUrls: string[] = []
    for (let index = 0; index < 499; index += 1) {
      retainedUrls.push(registerRetained([root])[0]!)
    }

    expect(() => registerRetained([root, outsideRoot])).toThrow('本地文件授权数量已达上限')
    registry.revokePathUrl(retainedUrls[0]!)
    const [assetUrl, thumbnailUrl] = registerRetained([root, outsideRoot])

    expect((await registry.handleRequest(new Request(`${assetUrl}/preview.webp`))).status).toBe(200)
    expect((await registry.handleRequest(new Request(`${thumbnailUrl}/thumbnail.webp`))).status).toBe(200)
    expect(registry.retainPathUrl('proma-file://missing-token')).toBe(false)
  })
})
