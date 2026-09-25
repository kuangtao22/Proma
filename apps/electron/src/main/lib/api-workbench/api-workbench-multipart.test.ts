import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
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

/** 建一个含非 UTF-8 字节的临时文件，并返回服务与记录到的待发请求。 */
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'api-multipart-'))
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

      /** 预览里只有摘要与结构，没有二进制正文。 */
      expect(preview.request.body).toContain('Content-Disposition: form-data; name="file"')
      expect(preview.request.body).toContain('<文件内容未留存：upload.bin（7 字节）>')
      expect(preview.request.bodyBase64).toBeUndefined()
      expect(preview.request.attachments).toEqual([{ field: 'file', fileName: 'upload.bin', sizeBytes: 7, sha256: expect.stringMatching(/^[0-9a-f]{64}$/) }])
      expect(preview.request.headers.some((item) => item.name === 'Content-Type' && item.value.startsWith('multipart/form-data; boundary='))).toBe(true)

      const run = await f.service.send(context, preview.preparedId)

      /** 传输层拿到的是可还原的真实字节。 */
      const outgoing = f.sent[0]!
      const decoded = Buffer.from(outgoing.bodyBase64 ?? '', 'base64')
      expect(decoded.includes(f.binary)).toBe(true)
      expect(decoded.toString('utf8')).toContain('hello 中文')
      /** 记录与回执里都查不到文件字节或 base64。 */
      expect(run.request.bodyBase64).toBeUndefined()
      expect(run.request.attachments?.[0]?.fileName).toBe('upload.bin')
      expect(JSON.stringify(run)).not.toContain((outgoing.bodyBase64 ?? 'xxx').slice(0, 24))
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
