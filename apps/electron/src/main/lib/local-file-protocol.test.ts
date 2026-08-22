import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

mock.module('electron', () => ({
  net: {
    fetch: async (url: string) => new Response(url, { status: 200 }),
  },
}))

const {
  createPromaFileProtocolRegistry,
  handlePromaFileRequest,
  registerPromaDirectoryPath,
  revokePromaPathUrl,
} = await import('./local-file-protocol')

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
})
