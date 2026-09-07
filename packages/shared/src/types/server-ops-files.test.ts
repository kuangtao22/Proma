import { describe, expect, test } from 'bun:test'
import {
  parseServerOpsFileListInput,
  parseServerOpsFileListResult,
  parseServerOpsFileMutationInput,
  parseServerOpsFilePreviewResult,
  parseServerOpsFileTransferChunk,
} from './server-ops-files'

describe('Server Ops 文件公开合同', () => {
  test('严格重建目录、预览和编辑事实', () => {
    expect(parseServerOpsFileListInput({ hostId: 'host-1', path: '/etc', cursor: 'cursor-1' })).toEqual({
      hostId: 'host-1', path: '/etc', cursor: 'cursor-1',
    })
    expect(parseServerOpsFileListResult({
      hostId: 'host-1', path: '/etc', entries: [{ name: 'hosts', path: '/etc/hosts', kind: 'file', size: 128, mtime: 10, mode: 0o100644 }],
      cursor: 'cursor-2',
    })).toEqual({
      hostId: 'host-1', path: '/etc', entries: [{ name: 'hosts', path: '/etc/hosts', kind: 'file', size: 128, mtime: 10, mode: 0o100644 }],
      cursor: 'cursor-2',
    })
    expect(parseServerOpsFilePreviewResult({
      hostId: 'host-1', path: '/etc/hosts', kind: 'text', content: '127.0.0.1\n', bytesRead: 10,
      hash: 'sha256:abc', stat: { size: 10, mtime: 20, mode: 0o100644 },
      editToken: { path: '/etc/hosts', size: 10, mtime: 20, mode: 0o100644, hash: 'sha256:abc' },
    })).toMatchObject({ kind: 'text', hash: 'sha256:abc' })
  })

  test('拒绝未知字段、NUL 路径、越界页面和伪造编辑事实', () => {
    expect(() => parseServerOpsFileListInput({ hostId: 'host-1', path: 'relative' })).toThrow('SERVER_OPS_FILES_INPUT_INVALID')
    expect(() => parseServerOpsFileListInput({ hostId: 'host-1', path: '/tmp/evil\0name' })).toThrow('SERVER_OPS_FILES_INPUT_INVALID')
    expect(() => parseServerOpsFileListResult({ hostId: 'host-1', path: '/', entries: Array.from({ length: 201 }, (_, index) => ({ name: `${index}`, path: `/${index}`, kind: 'file', size: 0, mtime: 0, mode: 0 })) })).toThrow('SERVER_OPS_FILES_INPUT_INVALID')
    expect(() => parseServerOpsFilePreviewResult({ hostId: 'host-1', path: '/a', kind: 'text', content: 'a', bytesRead: 1, hash: 'sha256:x', stat: { size: 1, mtime: 1, mode: 1 }, editToken: { path: '/other', size: 1, mtime: 1, mode: 1, hash: 'sha256:x' } })).toThrow('SERVER_OPS_FILES_INPUT_INVALID')
    expect(() => parseServerOpsFileTransferChunk({ handleId: 'handle-1', data: new Uint8Array(65_537), position: 0 })).toThrow('SERVER_OPS_FILES_INPUT_INVALID')
  })

  test('变更意图仅允许有限动作且不接受递归或本地路径', () => {
    expect(parseServerOpsFileMutationInput({ hostId: 'host-1', action: 'mkdir', path: '/srv/app' })).toEqual({ hostId: 'host-1', action: 'mkdir', path: '/srv/app' })
    expect(parseServerOpsFileMutationInput({ hostId: 'host-1', action: 'delete', path: '/srv/old', targetKind: 'directory' })).toEqual({ hostId: 'host-1', action: 'delete', path: '/srv/old', targetKind: 'directory' })
    expect(() => parseServerOpsFileMutationInput({ hostId: 'host-1', action: 'delete', path: '/srv', targetKind: 'directory', recursive: true })).toThrow('SERVER_OPS_FILES_INPUT_INVALID')
    expect(() => parseServerOpsFileMutationInput({ hostId: 'host-1', action: 'save-as', path: '/srv/a', content: 'x', localPath: '/tmp/a' })).toThrow('SERVER_OPS_FILES_INPUT_INVALID')
    expect(() => parseServerOpsFileMutationInput({ hostId: 'host-1', action: 'mkdir', path: '/srv/a', content: 'ignored' })).toThrow('SERVER_OPS_FILES_INPUT_INVALID')
    expect(() => parseServerOpsFileMutationInput({ hostId: 'host-1', action: 'save-as', path: '/srv/a', content: 'x', editToken: { path: '/srv/a', size: 1, mtime: 1, mode: 1, hash: 'sha256:x' } })).toThrow('SERVER_OPS_FILES_INPUT_INVALID')
  })
})
