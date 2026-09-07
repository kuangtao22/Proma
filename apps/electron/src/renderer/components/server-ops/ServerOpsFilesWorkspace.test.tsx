import { describe, expect, test } from 'bun:test'
import type { ServerOpsTransferSnapshot } from '@proma/shared'
import { mergeServerOpsTransferSnapshots } from './ServerOpsFilesWorkspace'

describe('文件传输事件投影', () => {
  test('Given 完成事件先于启动回复 When 两者同毫秒 Then 保留已完成状态', () => {
    const completed: ServerOpsTransferSnapshot = { transferId: 'transfer-1', hostId: 'host-1', direction: 'upload', fileName: 'test.txt', remotePath: '/test.txt', status: 'succeeded', totalBytes: 10, transferredBytes: 10, createdAt: 1, updatedAt: 2 }
    expect(mergeServerOpsTransferSnapshots([completed], [{ ...completed, status: 'running', transferredBytes: 0 }])).toEqual([completed])
    expect(mergeServerOpsTransferSnapshots([{ ...completed, status: 'running', transferredBytes: 0 }], [completed])).toEqual([completed])
  })
})
