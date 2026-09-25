import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ApiResolvedRequest, ApiTransportResult } from '@proma/shared'
import { createApiRequestDraft } from '@proma/shared'
import { ApiWorkbenchService } from './api-workbench-service'
import { ApiWorkbenchStore } from './api-workbench-store'

const context = { workspaceId: 'workspace', sessionId: 'session', source: 'manual' as const }
const completed: ApiTransportResult = {
  state: 'completed', hops: [],
  body: { rawBytes: 2, decodedBytes: 2, contentType: 'text/plain', encoding: 'utf-8', preview: 'ok', previewTruncated: false, complete: true, decoded: true },
}

/**
 * 建一个含非 UTF-8 字节的临时文件，并返回服务与记录到的待发请求。
 * 根目录先按 realpath 固定：macOS 的 `/var` 指向 `/private/var`，否则审批路径断言会漂移。
 */
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'api-multipart-')))
  const sent: ApiResolvedRequest[] = []
  const binary = Buffer.from([0x2d, 0x2d, 0x00, 0xff, 0xfe, 0x80, 0x0a])
  const filePath = join(root, 'upload.bin')
  writeFileSync(filePath, binary)
  const service = new ApiWorkbenchService({
    store: new ApiWorkbenchStore(root),
    transport: async (request) => { sent.push(request); return completed },
  })
  return { root, service, sent, binary, filePath, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

describe('multipart 附件链路', () => {
  test('Given 已登记文件 When 准备并发送 Then 待发正文带真实字节而记录只留摘要', async () => {
    const f = fixture()
    try {
      const [picked] = f.service.registerPickedFiles('workspace', [f.filePath])
      const request = {
        ...createApiRequestDraft(), url: 'https://example.test/upload', method: 'POST' as const,
        body: {
          kind: 'multipart' as const, text: '',
          fields: [{ id: 'field_1', name: 'note', value: 'hello 中文', enabled: true }],
          files: [{ id: 'part_1', name: 'file', fileName: picked!.fileName, sizeBytes: picked!.sizeBytes, contentType: picked!.contentType, ref: picked!.ref }],
        },
      }

      const preview = await f.service.prepare(context, { request })

      /** 预览里只有摘要与结构：准备阶段不读字节，因此没有 attachments 也没有 base64 正文。 */
      expect(preview.request.body).toContain('Content-Disposition: form-data; name="file"')
      expect(preview.request.body).toContain('<文件内容未留存：upload.bin（7 字节）>')
      expect(preview.request.bodyBase64).toBeUndefined()
      expect(preview.request.attachments).toBeUndefined()
      expect(preview.request.headers.some((item) => item.name === 'Content-Type' && item.value.startsWith('multipart/form-data; boundary='))).toBe(true)

      const run = await f.service.send(context, preview.preparedId)

      /** 传输层拿到的是可还原的真实字节。 */
      const outgoing = f.sent[0]!
      const decoded = Buffer.from(outgoing.bodyBase64 ?? '', 'base64')
      expect(decoded.includes(f.binary)).toBe(true)
      expect(decoded.toString('utf8')).toContain('hello 中文')
      /** 附件摘要是派发时才产生的：文件名、大小与 sha256 都在这里补齐。 */
      expect(run.request.attachments).toEqual([{ field: 'file', fileName: 'upload.bin', sizeBytes: 7, sha256: expect.stringMatching(/^[0-9a-f]{64}$/) }])
      /** 记录与回执里都查不到文件字节或 base64。 */
      expect(run.request.bodyBase64).toBeUndefined()
      expect(run.request.attachments?.[0]?.fileName).toBe('upload.bin')
      expect(JSON.stringify(run)).not.toContain((outgoing.bodyBase64 ?? 'xxx').slice(0, 24))
    } finally { f.cleanup() }
  })

  test('Given 准备后文件被换掉 When 发送 Then 拒绝派发且不出网', async () => {
    const f = fixture()
    try {
      const [picked] = f.service.registerPickedFiles('workspace', [f.filePath])
      const request = {
        ...createApiRequestDraft(), url: 'https://example.test/upload', method: 'POST' as const,
        body: { kind: 'multipart' as const, text: '', fields: [], files: [{ id: 'part_1', name: 'file', fileName: picked!.fileName, sizeBytes: picked!.sizeBytes, ref: picked!.ref }] },
      }
      const preview = await f.service.prepare(context, { request })

      /** 批准/准备之后文件被改写：inode 或时间戳复核必须拒绝，避免「批准的是 A、发出的是 B」。 */
      writeFileSync(f.filePath, Buffer.from([0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09]))

      await expect(f.service.send(context, preview.preparedId)).rejects.toThrow('API_WORKBENCH_FILE_CHANGED')
      expect(f.sent).toHaveLength(0)
    } finally { f.cleanup() }
  })

  test('Given Agent 声明的文件 When 登记并发送 Then 路径只进审批行、请求定义只留引用', async () => {
    const f = fixture()
    try {
      const registration = f.service.registerAgentFiles('workspace', [{ id: 'part_1', name: 'file', path: f.filePath }])

      /** 审批行带 realpath 与大小，请求定义里的文件部分只有引用。 */
      expect(registration.approvals).toEqual([{ field: 'file', path: f.filePath, sizeBytes: f.binary.length }])
      expect(JSON.stringify(registration.parts)).not.toContain(f.root)
      expect(registration.parts[0]?.fileName).toBe('upload.bin')
      expect(f.service.releaseFiles('workspace', [registration.parts[0]!.ref])).toBe(1)
      expect(() => f.service.getCatalog('workspace')).not.toThrow()
    } finally { f.cleanup() }
  })

  test('Given 声明里夹带目录 When 整批登记 Then 全部作废且不占槽位', async () => {
    const f = fixture()
    try {
      const service = new ApiWorkbenchService({ store: new ApiWorkbenchStore(f.root), transport: async () => completed })
      const directory = join(f.root, 'folder')
      mkdirSync(directory)

      expect(() => service.registerAgentFiles('workspace', [
        { id: 'part_1', name: 'file', path: f.filePath },
        { id: 'part_2', name: 'file2', path: directory },
      ])).toThrow('API_WORKBENCH_FILE_INVALID_TYPE')
      /** 第一条已经登记过，但整批失败必须回滚：重新登记同一条仍然成功。 */
      expect(service.registerAgentFiles('workspace', [{ id: 'part_1', name: 'file', path: f.filePath }]).approvals).toHaveLength(1)
    } finally { f.cleanup() }
  })

  test('Given 引用已失效或文件被删除 When 准备 Then fail closed 且不发出请求', async () => {
    const f = fixture()
    try {
      const [picked] = f.service.registerPickedFiles('workspace', [f.filePath])
      const request = {
        ...createApiRequestDraft(), url: 'https://example.test/upload', method: 'POST' as const,
        body: { kind: 'multipart' as const, text: '', fields: [], files: [{ id: 'part_1', name: 'file', fileName: picked!.fileName, sizeBytes: picked!.sizeBytes, ref: picked!.ref }] },
      }

      /** 引用被清空（等价于应用重启）后不能再发送。 */
      expect(f.service.clearFiles('workspace')).toBe(1)
      await expect(f.service.prepare(context, { request })).rejects.toThrow('API_WORKBENCH_FILE_REF_NOT_FOUND')
      expect(f.sent).toHaveLength(0)
    } finally { f.cleanup() }
  })

  test('Given multipart 没有任何字段或文件 When 准备 Then 明确拒绝', async () => {
    const f = fixture()
    try {
      const request = {
        ...createApiRequestDraft(), url: 'https://example.test/upload', method: 'POST' as const,
        body: { kind: 'multipart' as const, text: '', fields: [], files: [] },
      }

      await expect(f.service.prepare(context, { request })).rejects.toThrow('API_WORKBENCH_MULTIPART_EMPTY')
    } finally { f.cleanup() }
  })
})
