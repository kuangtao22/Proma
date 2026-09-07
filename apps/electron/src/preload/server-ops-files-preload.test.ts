import { describe, expect, test } from 'bun:test'
import { createServerOpsFilesPreload } from './server-ops-files-preload'

describe('服务器运维文件 preload', () => {
  test('输入输出均执行严格解析且不传 owner', async () => {
    const calls: Array<{ channel: string; input: unknown }> = []
    const preload = createServerOpsFilesPreload(async (channel, input) => {
      calls.push({ channel, input })
      return { hostId: 'host-1', path: '/etc', entries: [] }
    })
    await expect(preload.listServerOpsFiles({ hostId: 'host-1', path: '/etc' })).resolves.toEqual({ hostId: 'host-1', path: '/etc', entries: [] })
    expect(JSON.stringify(calls)).not.toContain('owner')
    await expect(preload.listServerOpsFiles({ hostId: 'host-1', path: '/etc', extra: true } as never)).rejects.toThrow()
  })

  test('拒绝夹带字段的候选并要求清理返回空值', async () => {
    const invalidCandidate = createServerOpsFilesPreload(async () => ({ candidateId: 'candidate-1', hostId: 'host-1', hostName: '生产机', action: 'mkdir', path: '/srv/new', expiresAt: 1_000, ownerKey: 'leak' }))
    await expect(invalidCandidate.prepareServerOpsFileMutation({ hostId: 'host-1', action: 'mkdir', path: '/srv/new' })).rejects.toThrow()
    const invalidVoid = createServerOpsFilesPreload(async () => ({ ok: true }))
    await expect(invalidVoid.closeServerOpsFilesOwner({ hostId: 'host-1' })).rejects.toThrow('SERVER_OPS_FILES_RESULT_INVALID')
  })
})
