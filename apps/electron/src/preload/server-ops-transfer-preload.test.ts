import { describe, expect, test } from 'bun:test'
import { createServerOpsTransferPreload } from './server-ops-transfer-preload'

describe('服务器运维传输 preload', () => {
  test('启动与列表执行严格双向解析且不传内部 owner', async () => {
    const calls: Array<{ channel: string; input: unknown }> = []
    const preload = createServerOpsTransferPreload(async (channel, input) => {
      calls.push({ channel, input })
      return channel.endsWith('list') ? [] : {
        transferId: 'transfer-1', hostId: 'host-1', direction: 'upload', fileName: 'a.bin', remotePath: '/srv/a.bin',
        status: 'queued', transferredBytes: 0, totalBytes: 1, createdAt: 1, updatedAt: 1,
      }
    })
    await expect(preload.startServerOpsTransfer({ direction: 'upload', hostId: 'host-1', remotePath: '/srv/a.bin', leaseId: 'lease-1' })).resolves.toMatchObject({ transferId: 'transfer-1' })
    await expect(preload.listServerOpsTransfers({ hostId: 'host-1' })).resolves.toEqual([])
    expect(JSON.stringify(calls)).not.toContain('owner')
    await expect(preload.startServerOpsTransfer({ direction: 'upload', hostId: 'host-1', remotePath: '/srv/a.bin', leaseId: 'lease-1', localPath: '/tmp/a' } as never)).rejects.toThrow()
  })

  test('取消和关闭 owner 只接受 undefined 返回', async () => {
    const valid = createServerOpsTransferPreload(async () => undefined)
    await expect(valid.cancelServerOpsTransfer({ hostId: 'host-1', transferId: 'transfer-1' })).resolves.toBeUndefined()
    await expect(valid.releaseServerOpsFileSelection({ leaseId: 'lease-1' })).resolves.toBeUndefined()
    await expect(valid.closeServerOpsTransferOwner({})).resolves.toBeUndefined()
    const invalid = createServerOpsTransferPreload(async () => ({ ok: true }))
    await expect(invalid.closeServerOpsTransferOwner({})).rejects.toThrow('SERVER_OPS_TRANSFER_RESULT_INVALID')
  })

  test('选择器与进度事件执行严格解析', async () => {
    let eventListener: ((value: unknown) => void) | undefined
    const preload = createServerOpsTransferPreload(
      async (channel) => channel.endsWith('select-upload') ? { leaseId: 'lease-1', fileName: 'a.bin', size: 1 } : null,
      (_channel, listener) => { eventListener = listener; return () => { eventListener = undefined } },
    )
    await expect(preload.selectServerOpsUploadFile({ hostId: 'host-1' })).resolves.toEqual({ leaseId: 'lease-1', fileName: 'a.bin', size: 1 })
    await expect(preload.selectServerOpsDownloadFile({ hostId: 'host-1', fileName: 'a.bin' })).resolves.toBeNull()
    const received: string[] = []
    const dispose = preload.onServerOpsTransferProgress((snapshot) => received.push(snapshot.transferId))
    eventListener?.({ transferId: 'transfer-1', hostId: 'host-1', direction: 'upload', fileName: 'a.bin', remotePath: '/srv/a.bin', status: 'running', transferredBytes: 0, totalBytes: 1, createdAt: 1, updatedAt: 1 })
    expect(received).toEqual(['transfer-1'])
    expect(() => eventListener?.({ path: '/tmp/leak' })).toThrow()
    dispose()
  })
})
