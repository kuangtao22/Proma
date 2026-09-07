import { describe, expect, test } from 'bun:test'
import {
  SERVER_OPS_TRANSFER_CHUNK_LIMIT_BYTES,
  SERVER_OPS_TRANSFER_FILE_LIMIT_BYTES,
  parseServerOpsTransferCancelInput,
  parseServerOpsLocalFileSelection,
  parseServerOpsTransferDownloadSelectionInput,
  parseServerOpsTransferUploadSelectionInput,
  parseServerOpsTransferReleaseSelectionInput,
  parseServerOpsTransferSnapshot,
  parseServerOpsTransferStartInput,
} from './server-ops-transfers'

describe('服务器运维文件传输合同', () => {
  test('只接受 opaque lease 与远程路径，不允许 Renderer 夹带本地路径', () => {
    expect(parseServerOpsTransferStartInput({ direction: 'upload', hostId: 'host-1', remotePath: '/srv/a.bin', leaseId: 'lease-1' })).toEqual({
      direction: 'upload', hostId: 'host-1', remotePath: '/srv/a.bin', leaseId: 'lease-1',
    })
    expect(() => parseServerOpsTransferStartInput({ direction: 'upload', hostId: 'host-1', remotePath: '/srv/a.bin', leaseId: 'lease-1', localPath: '/tmp/a.bin' })).toThrow('SERVER_OPS_TRANSFER_INPUT_INVALID')
    expect(() => parseServerOpsTransferStartInput({ direction: 'download', hostId: 'host-1', remotePath: 'relative', leaseId: 'lease-1' })).toThrow()
  })

  test('公开快照限制 1 GiB，且错误只能是稳定码', () => {
    expect(SERVER_OPS_TRANSFER_FILE_LIMIT_BYTES).toBe(1_073_741_824)
    expect(SERVER_OPS_TRANSFER_CHUNK_LIMIT_BYTES).toBe(65_536)
    const snapshot = parseServerOpsTransferSnapshot({
      transferId: 'transfer-1', hostId: 'host-1', direction: 'download', fileName: '报告.bin', remotePath: '/srv/report.bin',
      status: 'running', transferredBytes: 65_536, totalBytes: SERVER_OPS_TRANSFER_FILE_LIMIT_BYTES, createdAt: 1, updatedAt: 2,
    })
    expect(snapshot.fileName).toBe('报告.bin')
    expect(() => parseServerOpsTransferSnapshot({ ...snapshot, totalBytes: SERVER_OPS_TRANSFER_FILE_LIMIT_BYTES + 1 })).toThrow()
    expect(() => parseServerOpsTransferSnapshot({ ...snapshot, status: 'failed', errorCode: '/Users/me/secret.bin' })).toThrow()
  })

  test('取消输入精确匹配 transfer 与 host', () => {
    expect(parseServerOpsTransferCancelInput({ hostId: 'host-1', transferId: 'transfer-1' })).toEqual({ hostId: 'host-1', transferId: 'transfer-1' })
    expect(() => parseServerOpsTransferCancelInput({ hostId: 'host-1', transferId: 'transfer-1', ownerKey: 'leak' })).toThrow()
  })

  test('系统选择合同只公开 host、文件名和 opaque lease', () => {
    expect(parseServerOpsTransferUploadSelectionInput({ hostId: 'host-1' })).toEqual({ hostId: 'host-1' })
    expect(parseServerOpsTransferDownloadSelectionInput({ hostId: 'host-1', fileName: '报告.bin' })).toEqual({ hostId: 'host-1', fileName: '报告.bin' })
    expect(parseServerOpsLocalFileSelection({ leaseId: 'lease-1', fileName: '报告.bin', size: 3 })).toEqual({ leaseId: 'lease-1', fileName: '报告.bin', size: 3 })
    expect(parseServerOpsLocalFileSelection(null)).toBeNull()
    expect(() => parseServerOpsLocalFileSelection({ leaseId: 'lease-1', fileName: '报告.bin', size: 3, path: '/tmp/report' })).toThrow()
    expect(parseServerOpsTransferReleaseSelectionInput({ leaseId: 'lease-1' })).toEqual({ leaseId: 'lease-1' })
  })
})
