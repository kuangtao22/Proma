import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

mock.module('electron', () => ({
  net: {
    fetch: async (url: string) => new Response(url, { status: 200 }),
  },
}))

const {
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
    expect(await response.text()).toContain('preview.webp')
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
})
