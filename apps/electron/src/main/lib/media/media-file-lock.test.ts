import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeJsonFileAtomic } from '../safe-file'
import { acquireMediaFileLock } from './media-file-lock'

describe('媒体跨进程所有权', () => {
  test('Given 活跃 owner When 第二个调用抢占 Then 拒绝，释放后可取得', () => {
    const directory = mkdtempSync(join(tmpdir(), 'media-lock-'))
    try {
      const path = join(directory, 'run.lock')
      const release = acquireMediaFileLock(path)
      expect(() => acquireMediaFileLock(path)).toThrow('MEDIA_FILE_BUSY')
      release()
      acquireMediaFileLock(path)()
    } finally { rmSync(directory, { recursive: true, force: true }) }
  })

  test('Given 已证实退出的进程 When 两个恢复者接管 Then 仅一个后继 owner 成功', () => {
    const directory = mkdtempSync(join(tmpdir(), 'media-lock-'))
    try {
      const path = join(directory, 'run.lock')
      writeJsonFileAtomic(path, { version: 1, pid: 987654321, token: 'dead-owner' })
      const release = acquireMediaFileLock(path)
      expect(() => acquireMediaFileLock(path)).toThrow('MEDIA_FILE_BUSY')
      release()
      acquireMediaFileLock(path)()
    } finally { rmSync(directory, { recursive: true, force: true }) }
  })
})
