import { describe, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { PassThrough } from 'node:stream'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'

import {
  runStableDirectoryNative,
  type StableDirectoryNativeHostDependencies,
} from './stable-directory-native-host'

interface FakeHelperOptions {
  canonicalPath?: string
  emitEntryBeforeAuthorization?: boolean
  oversizedOutput?: boolean
}

/** 创建严格等待 ALLOW/DENY 的假 helper，用于验证主进程两阶段授权协议。 */
function createFakeHelper(options: FakeHelperOptions = {}): {
  child: ChildProcessWithoutNullStreams
  decisions: string[]
  enumerated: () => boolean
  terminated: () => boolean
} {
  const processEvents = new EventEmitter()
  const stdin = new PassThrough()
  const stdout = new PassThrough()
  const stderr = new PassThrough()
  const decisions: string[] = []
  let didEnumerate = false
  let killed = false
  const child = Object.assign(processEvents, {
    stdin,
    stdout,
    stderr,
    kill: () => { killed = true; processEvents.emit('exit', null, 'SIGTERM'); return true },
  }) as unknown as ChildProcessWithoutNullStreams
  Object.defineProperty(child, 'killed', { get: () => killed })

  stdin.setEncoding('utf8')
  stdin.on('data', (chunk: string) => {
    const decision = chunk.trim()
    decisions.push(decision)
    if (decision === 'ALLOW') {
      didEnumerate = true
      if (options.oversizedOutput) {
        stdout.write(`${'x'.repeat(2048)}\n`)
        return
      }
      stdout.write(`${JSON.stringify({ type: 'entry', rootIndex: 0, name: 'file.txt', path: '/stable/file.txt', isDirectory: false, size: 4 })}\n`)
      stdout.write(`${JSON.stringify({ type: 'done', entryCount: 1 })}\n`)
      processEvents.emit('exit', 0, null)
    } else if (decision === 'DENY') {
      processEvents.emit('exit', 3, null)
    }
  })

  queueMicrotask(() => {
    stdout.write(`${JSON.stringify({
      type: 'opened',
      protocol: 1,
      roots: [{ requestedPath: '/requested', canonicalPath: options.canonicalPath ?? '/stable', isDirectory: true, volume: '1', fileId: '2' }],
    })}\n`)
    if (options.emitEntryBeforeAuthorization) {
      didEnumerate = true
      stdout.write(`${JSON.stringify({ type: 'entry', rootIndex: 0, name: 'secret.txt', path: '/stable/secret.txt', isDirectory: false, size: 6 })}\n`)
    }
  })

  return { child, decisions, enumerated: () => didEnumerate, terminated: () => killed }
}

/** 创建只注入假进程的 host 依赖。 */
function createDependencies(fake: ReturnType<typeof createFakeHelper>): StableDirectoryNativeHostDependencies {
  return {
    helperPath: () => '/fake/stable-directory-helper',
    helperExists: () => true,
    spawnProcess: () => fake.child,
    startupTimeoutMs: 500,
    totalTimeoutMs: 1_000,
  }
}

describe('stable directory native host', () => {
  test('Given canonical root 未授权 When helper 报告 OPENED Then 发送 DENY 且零枚举', async () => {
    const fake = createFakeHelper({ canonicalPath: '/replacement' })

    await expect(runStableDirectoryNative({ mode: 'list', roots: ['/requested'] },
      (roots) => roots.every((root) => root.canonicalPath === '/stable'),
      createDependencies(fake))).rejects.toThrow('目录授权被拒绝')

    expect(fake.decisions).toEqual(['DENY'])
    expect(fake.enumerated()).toBe(false)
  })

  test('Given canonical root 已授权 When 发送 ALLOW Then 返回稳定对象中的条目', async () => {
    const fake = createFakeHelper()

    const result = await runStableDirectoryNative(
      { mode: 'scan', roots: ['/requested'], maxDepth: 10, maxEntries: 100 },
      () => true,
      createDependencies(fake),
    )

    expect(fake.decisions).toEqual(['ALLOW'])
    expect(result.entries).toEqual([
      { rootIndex: 0, name: 'file.txt', path: '/stable/file.txt', isDirectory: false, size: 4 },
    ])
  })

  test('Given helper 在授权前发送 entry When host 消费协议 Then 终止并拒绝结果', async () => {
    const fake = createFakeHelper({ emitEntryBeforeAuthorization: true })

    await expect(runStableDirectoryNative({ mode: 'list', roots: ['/requested'] },
      async () => { await Promise.resolve(); return true },
      createDependencies(fake))).rejects.toThrow('helper 在授权前输出目录条目')
  })

  test('Given helper 输出超过预算 When host 消费 stdout Then 终止进程', async () => {
    const fake = createFakeHelper({ oversizedOutput: true })

    await expect(runStableDirectoryNative({ mode: 'list', roots: ['/requested'], maxOutputBytes: 1024 },
      () => true,
      createDependencies(fake))).rejects.toThrow('helper 输出超过预算')
    expect(fake.terminated()).toBe(true)
  })

  test.skipIf(process.platform !== 'darwin')('Given 已打开目录授权后祖先被替换 When 真实 helper 枚举 Then 只返回原稳定对象', async () => {
    const appDir = resolve(import.meta.dir, '../../..')
    const buildScript = resolve(appDir, 'scripts/build-stable-directory-native.ts')
    const helperPath = resolve(appDir, 'resources/stable-directory/stable-directory-helper')
    execFileSync(process.execPath, [buildScript], { stdio: 'pipe' })
    const root = mkdtempSync(join(tmpdir(), 'proma-native-directory-race-'))
    const authorized = join(root, 'authorized')
    const moved = join(root, 'authorized-old')
    const replacement = join(root, 'replacement')
    mkdirSync(authorized)
    mkdirSync(replacement)
    writeFileSync(join(authorized, 'allowed.txt'), 'allowed')
    writeFileSync(join(replacement, 'secret.txt'), 'secret')
    const canonicalAuthorized = realpathSync(authorized)

    try {
      const result = await runStableDirectoryNative(
        { mode: 'scan', roots: [authorized], maxDepth: 10, maxEntries: 100 },
        (roots) => {
          expect(roots[0]?.canonicalPath).toBe(canonicalAuthorized)
          renameSync(authorized, moved)
          symlinkSync(replacement, authorized)
          return true
        },
        { helperPath: () => helperPath },
      )

      expect(result.entries.map((entry) => entry.name)).toEqual(['allowed.txt'])
      expect(result.entries.map((entry) => entry.name)).not.toContain('secret.txt')
      expect(readFileSync(join(authorized, 'secret.txt'), 'utf8')).toBe('secret')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
