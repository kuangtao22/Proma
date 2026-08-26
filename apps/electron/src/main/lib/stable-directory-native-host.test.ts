import { describe, expect, test } from 'bun:test'
import { execFileSync, spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { PassThrough } from 'node:stream'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'

import {
  createStableDirectoryNativeHost,
  runStableDirectoryNative,
  type StableDirectoryNativeHostDependencies,
} from './stable-directory-native-host'

interface FakeHelperOptions {
  canonicalPath?: string
  emitEntryBeforeAuthorization?: boolean
  oversizedOutput?: boolean
  autoOpen?: boolean
  completeOnAllow?: boolean
  intentContent?: string
  writeOutcome?: {
    commitVisible: boolean
    durabilityUncertain: boolean
    error?: string
  }
}

/** 创建严格等待 ALLOW/DENY 的假 helper，用于验证主进程两阶段授权协议。 */
function createFakeHelper(options: FakeHelperOptions = {}): {
  child: ChildProcessWithoutNullStreams
  decisions: string[]
  enumerated: () => boolean
  terminated: () => boolean
  emitOpened: () => void
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
    if (decision === 'ALLOW' || decision.startsWith('ALLOW\t')) {
      didEnumerate = true
      if (options.completeOnAllow === false) return
      if (options.oversizedOutput) {
        stdout.write(`${'x'.repeat(2048)}\n`)
        return
      }
      if (options.writeOutcome) {
        stdout.write(`${JSON.stringify({ type: 'write-result', ...options.writeOutcome })}\n`)
        stdout.write(`${JSON.stringify({ type: 'done', entryCount: 0 })}\n`)
        processEvents.emit('exit', 0, null)
        return
      }
      const entry = options.intentContent === undefined
        ? { type: 'entry', rootIndex: 0, name: 'file.txt', path: '/stable/file.txt', isDirectory: false, size: 4 }
        : {
            type: 'entry',
            rootIndex: 0,
            name: 'agent-node-test.json',
            path: '',
            isDirectory: false,
            size: Buffer.byteLength(options.intentContent),
            content: options.intentContent,
          }
      stdout.write(`${JSON.stringify(entry)}\n`)
      stdout.write(`${JSON.stringify({ type: 'done', entryCount: 1 })}\n`)
      processEvents.emit('exit', 0, null)
    } else if (decision === 'DENY') {
      processEvents.emit('exit', 3, null)
    }
  })

  /** 主动发送 OPENED，便于测试排队和超时。 */
  const emitOpened = (): void => {
    stdout.write(`${JSON.stringify({
      type: 'opened',
      protocol: 1,
      roots: [{ requestedPath: '/requested', canonicalPath: options.canonicalPath ?? '/stable', isDirectory: true, volume: '1', fileId: '2' }],
    })}\n`)
    if (options.emitEntryBeforeAuthorization) {
      didEnumerate = true
      stdout.write(`${JSON.stringify({ type: 'entry', rootIndex: 0, name: 'secret.txt', path: '/stable/secret.txt', isDirectory: false, size: 6 })}\n`)
    }
  }
  if (options.autoOpen !== false) queueMicrotask(emitOpened)

  return { child, decisions, enumerated: () => didEnumerate, terminated: () => killed, emitOpened }
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

/** 把 Windows drive 路径转换为 localhost 管理共享路径；非 drive 路径返回 null。 */
function toLocalhostAdminShare(path: string): string | null {
  const driveMatch = /^([A-Za-z]):\\(.*)$/.exec(path)
  return driveMatch ? `\\\\localhost\\${driveMatch[1]}$\\${driveMatch[2]}` : null
}

/** 当前 Windows 临时目录是否可通过 localhost 管理共享访问。 */
const windowsAdminShareAvailable = (() => {
  if (process.platform !== 'win32') return false
  const uncTempDir = toLocalhostAdminShare(tmpdir())
  return uncTempDir !== null && existsSync(uncTempDir)
})()

describe('stable directory native host', () => {
  test('Given active=1 且 queue=1 When 第三个请求进入 Then 立即拒绝并在前项完成后依次启动', async () => {
    const host = createStableDirectoryNativeHost({ maxActiveHelpers: 1, maxQueuedRequests: 1, maxRootsPerRequest: 32 })
    const first = createFakeHelper({ autoOpen: false })
    const second = createFakeHelper()
    const fourth = createFakeHelper()
    const helpers = [first, second, fourth]
    let spawnCount = 0
    const dependencies: StableDirectoryNativeHostDependencies = {
      helperPath: () => '/fake/stable-directory-helper',
      helperExists: () => true,
      spawnProcess: () => helpers[spawnCount++]!.child,
      startupTimeoutMs: 500,
      totalTimeoutMs: 1_000,
    }

    const firstPromise = host.run({ mode: 'list', roots: ['/requested'] }, () => true, dependencies)
    const secondPromise = host.run({ mode: 'list', roots: ['/requested'] }, () => true, dependencies)
    await expect(host.run({ mode: 'list', roots: ['/requested'] }, () => true, dependencies))
      .rejects.toThrow('稳定目录请求队列已满')
    expect(spawnCount).toBe(1)

    first.emitOpened()
    await firstPromise
    await secondPromise
    await host.run({ mode: 'list', roots: ['/requested'] }, () => true, dependencies)
    expect(spawnCount).toBe(3)
  })

  test('Given roots 超过单请求上限 When 提交请求 Then spawn 为零', async () => {
    const host = createStableDirectoryNativeHost({ maxActiveHelpers: 1, maxQueuedRequests: 1, maxRootsPerRequest: 2 })
    let spawnCount = 0

    await expect(host.run(
      { mode: 'scan', roots: ['/a', '/b', '/c'] },
      () => true,
      { helperPath: () => '/fake', helperExists: () => true, spawnProcess: () => { spawnCount += 1; throw new Error('不应启动') } },
    )).rejects.toThrow('稳定目录 roots 超过上限')
    expect(spawnCount).toBe(0)
  })

  test('Given active helper 启动超时 When 队列中有请求 Then kill 后释放槽位并启动下一项', async () => {
    const host = createStableDirectoryNativeHost({ maxActiveHelpers: 1, maxQueuedRequests: 1, maxRootsPerRequest: 32 })
    const timedOut = createFakeHelper({ autoOpen: false })
    const next = createFakeHelper()
    const helpers = [timedOut, next]
    let spawnCount = 0
    const dependencies: StableDirectoryNativeHostDependencies = {
      helperPath: () => '/fake', helperExists: () => true,
      spawnProcess: () => helpers[spawnCount++]!.child,
      startupTimeoutMs: 10, totalTimeoutMs: 200,
    }

    const firstPromise = host.run({ mode: 'list', roots: ['/requested'] }, () => true, dependencies)
    const nextPromise = host.run({ mode: 'list', roots: ['/requested'] }, () => true, dependencies)
    await expect(firstPromise).rejects.toThrow('稳定目录 helper 启动超时')
    await nextPromise
    expect(timedOut.terminated()).toBe(true)
    expect(spawnCount).toBe(2)
  })

  test('Given active helper 总超时 When 队列中有请求 Then close 后释放槽位并启动下一项', async () => {
    const host = createStableDirectoryNativeHost({ maxActiveHelpers: 1, maxQueuedRequests: 1, maxRootsPerRequest: 32 })
    const timedOut = createFakeHelper({ completeOnAllow: false })
    const next = createFakeHelper()
    const helpers = [timedOut, next]
    let spawnCount = 0
    const dependencies: StableDirectoryNativeHostDependencies = {
      helperPath: () => '/fake', helperExists: () => true,
      spawnProcess: () => helpers[spawnCount++]!.child,
      startupTimeoutMs: 100, totalTimeoutMs: 20,
    }

    const firstPromise = host.run({ mode: 'list', roots: ['/requested'] }, () => true, dependencies)
    const nextPromise = host.run({ mode: 'list', roots: ['/requested'] }, () => true, { ...dependencies, totalTimeoutMs: 200 })
    await expect(firstPromise).rejects.toThrow('稳定目录 helper 执行超时')
    await nextPromise
    expect(timedOut.terminated()).toBe(true)
    expect(spawnCount).toBe(2)
  })

  test('Given active 请求被取消或授权抛错 When 队列中有请求 Then 幂等释放且后续可执行', async () => {
    for (const failure of ['abort', 'authorize'] as const) {
      const host = createStableDirectoryNativeHost({ maxActiveHelpers: 1, maxQueuedRequests: 1, maxRootsPerRequest: 32 })
      const failed = createFakeHelper({ autoOpen: failure === 'abort' ? false : true })
      const next = createFakeHelper()
      const helpers = [failed, next]
      let spawnCount = 0
      const controller = new AbortController()
      const dependencies: StableDirectoryNativeHostDependencies = {
        helperPath: () => '/fake', helperExists: () => true,
        spawnProcess: () => helpers[spawnCount++]!.child,
        startupTimeoutMs: 100, totalTimeoutMs: 500,
      }
      const failedPromise = host.run(
        { mode: 'list', roots: ['/requested'], signal: controller.signal },
        () => { if (failure === 'authorize') throw new Error('授权异常'); return true },
        dependencies,
      )
      const nextPromise = host.run({ mode: 'list', roots: ['/requested'] }, () => true, dependencies)
      if (failure === 'abort') controller.abort()

      await expect(failedPromise).rejects.toThrow(failure === 'abort' ? '稳定目录请求已取消' : '目录授权失败')
      await nextPromise
      expect(failed.terminated()).toBe(true)
      expect(spawnCount).toBe(2)
    }
  })

  test('Given 排队请求取消或超时 When 尚未获得槽位 Then spawn 为零且不阻塞后续请求', async () => {
    const host = createStableDirectoryNativeHost({ maxActiveHelpers: 1, maxQueuedRequests: 1, maxRootsPerRequest: 32 })
    const active = createFakeHelper({ autoOpen: false })
    let spawnCount = 0
    const controller = new AbortController()
    const dependencies: StableDirectoryNativeHostDependencies = {
      helperPath: () => '/fake', helperExists: () => true,
      spawnProcess: () => { spawnCount += 1; return active.child },
      startupTimeoutMs: 500, totalTimeoutMs: 500,
    }
    const activePromise = host.run({ mode: 'list', roots: ['/requested'] }, () => true, dependencies)
    const queuedPromise = host.run(
      { mode: 'list', roots: ['/queued'], signal: controller.signal }, () => true, dependencies,
    )
    controller.abort()
    await expect(queuedPromise).rejects.toThrow('稳定目录请求已取消')
    expect(spawnCount).toBe(1)
    active.emitOpened()
    await activePromise

    const timeoutActive = createFakeHelper({ autoOpen: false })
    const timeoutDependencies = { ...dependencies, spawnProcess: () => { spawnCount += 1; return timeoutActive.child } }
    const heldPromise = host.run({ mode: 'list', roots: ['/held'] }, () => true, timeoutDependencies)
    await expect(host.run(
      { mode: 'list', roots: ['/queued-timeout'] }, () => true, { ...timeoutDependencies, totalTimeoutMs: 10 },
    )).rejects.toThrow('稳定目录请求排队超时')
    timeoutActive.emitOpened()
    await heldPromise
  })

  test('Given spawn 同步抛错 When 下一请求等待 Then 释放槽位并正常启动', async () => {
    const host = createStableDirectoryNativeHost({ maxActiveHelpers: 1, maxQueuedRequests: 1, maxRootsPerRequest: 32 })
    const next = createFakeHelper()
    let spawnCount = 0
    const dependencies: StableDirectoryNativeHostDependencies = {
      helperPath: () => '/fake', helperExists: () => true,
      spawnProcess: () => {
        spawnCount += 1
        if (spawnCount === 1) throw new Error('spawn failed')
        return next.child
      },
    }
    const failedPromise = host.run({ mode: 'list', roots: ['/requested'] }, () => true, dependencies)
    const nextPromise = host.run({ mode: 'list', roots: ['/requested'] }, () => true, dependencies)
    await expect(failedPromise).rejects.toThrow('稳定目录 helper 启动失败')
    await nextPromise
    expect(spawnCount).toBe(2)
  })

  test('Given 真实 Node spawn 异步报错 When 两个请求排队 Then 当前请求拒绝且槽位只释放一次', async () => {
    const host = createStableDirectoryNativeHost({ maxActiveHelpers: 1, maxQueuedRequests: 2, maxRootsPerRequest: 32 })
    const held = createFakeHelper({ autoOpen: false })
    const next = createFakeHelper()
    const queuedHelpers = [held, next]
    let queuedSpawnCount = 0
    const queuedDependencies: StableDirectoryNativeHostDependencies = {
      helperPath: () => '/fake/stable-directory-helper',
      helperExists: () => true,
      spawnProcess: () => queuedHelpers[queuedSpawnCount++]!.child,
      startupTimeoutMs: 500,
      totalTimeoutMs: 1_000,
    }
    const missingHelperPath = join(tmpdir(), `proma-missing-stable-helper-${process.pid}-${Date.now()}`)
    const failedPromise = host.run(
      { mode: 'list', roots: ['/requested'] },
      () => true,
      {
        helperPath: () => missingHelperPath,
        helperExists: () => true,
        spawnProcess: (path, args) => spawn(path, args, { stdio: ['pipe', 'pipe', 'pipe'] }),
        startupTimeoutMs: 500,
        totalTimeoutMs: 1_000,
      },
    )
    const heldPromise = host.run({ mode: 'list', roots: ['/held'] }, () => true, queuedDependencies)
    const nextPromise = host.run({ mode: 'list', roots: ['/next'] }, () => true, queuedDependencies)

    await expect(failedPromise).rejects.toThrow('稳定目录 helper 进程错误')
    expect(queuedSpawnCount).toBe(1)
    held.emitOpened()
    await heldPromise
    await nextPromise
    expect(queuedSpawnCount).toBe(2)
  })

  test('Given DENY、协议错误或输出溢出 When 下一请求等待 Then 每条失败路径都释放槽位', async () => {
    const scenarios = [
      { name: 'deny', fake: () => createFakeHelper({ canonicalPath: '/replacement' }), error: '目录授权被拒绝' },
      { name: 'protocol', fake: () => createFakeHelper({ emitEntryBeforeAuthorization: true }), error: 'helper 在授权前输出目录条目' },
      { name: 'overflow', fake: () => createFakeHelper({ oversizedOutput: true }), error: 'helper 输出超过预算' },
    ]
    for (const scenario of scenarios) {
      const host = createStableDirectoryNativeHost({ maxActiveHelpers: 1, maxQueuedRequests: 1, maxRootsPerRequest: 32 })
      const failed = scenario.fake()
      const next = createFakeHelper()
      const helpers = [failed, next]
      let spawnCount = 0
      const dependencies: StableDirectoryNativeHostDependencies = {
        helperPath: () => '/fake', helperExists: () => true,
        spawnProcess: () => helpers[spawnCount++]!.child,
        startupTimeoutMs: 100, totalTimeoutMs: 500,
      }
      const failedPromise = host.run(
        { mode: 'list', roots: ['/requested'], maxOutputBytes: scenario.name === 'overflow' ? 1_024 : undefined },
        (roots) => scenario.name !== 'deny' || roots[0]?.canonicalPath === '/stable',
        dependencies,
      )
      const nextPromise = host.run({ mode: 'list', roots: ['/requested'] }, () => true, dependencies)

      await expect(failedPromise).rejects.toThrow(scenario.error)
      await nextPromise
      expect(failed.terminated()).toBe(true)
      expect(spawnCount).toBe(2)
    }
  })

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

  test('Given Canvas intent scan When helper 相对读取正文 Then host 只返回内存内容且无可重开路径', async () => {
    const fake = createFakeHelper({ intentContent: '{"state":"prepared"}' })

    const result = await runStableDirectoryNative(
      {
        mode: 'canvas-intent-scan',
        roots: ['/requested'],
        childName: 'transactions',
        maxEntries: 512,
      },
      () => true,
      createDependencies(fake),
    )

    expect(result.entries).toEqual([{
      rootIndex: 0,
      name: 'agent-node-test.json',
      path: '',
      isDirectory: false,
      size: 20,
      content: '{"state":"prepared"}',
    }])
  })

  test('Given helper 报告 rename 后目录持久性未确认 When host 消费协议 Then 保留可见提交结果而非提前退出', async () => {
    const fake = createFakeHelper({
      writeOutcome: {
        commitVisible: true,
        durabilityUncertain: true,
        error: 'cannot persist canvas transactions directory',
      },
    })

    const result = await runStableDirectoryNative({
      mode: 'canvas-intent-write',
      roots: ['/requested'],
      childName: 'transactions',
      fileName: 'agent-node-11111111-1111-4111-8111-111111111111.json',
      content: '{"state":"committed"}',
    }, () => true, createDependencies(fake))

    expect(result.writeOutcome).toEqual({
      commitVisible: true,
      durabilityUncertain: true,
      error: 'cannot persist canvas transactions directory',
    })
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

  test.skipIf(process.platform !== 'darwin')('Given Canvas 根在 OPENED 后被外部 symlink 置换 When helper 相对写 intent Then replacement 零写入', async () => {
    const appDir = resolve(import.meta.dir, '../../..')
    const buildScript = resolve(appDir, 'scripts/build-stable-directory-native.ts')
    const helperPath = resolve(appDir, 'resources/stable-directory/stable-directory-helper')
    execFileSync(process.execPath, [buildScript], { stdio: 'pipe' })
    const root = mkdtempSync(join(tmpdir(), 'proma-native-intent-race-'))
    const canvasRoot = join(root, 'canvas')
    const movedCanvasRoot = join(root, 'canvas-original')
    const replacement = join(root, 'replacement')
    mkdirSync(canvasRoot)
    mkdirSync(replacement)

    try {
      await runStableDirectoryNative(
        {
          mode: 'canvas-intent-write',
          roots: [canvasRoot],
          childName: 'transactions',
          fileName: 'agent-node-11111111-1111-4111-8111-111111111111.json',
          content: '{"state":"prepared"}',
        },
        () => {
          renameSync(canvasRoot, movedCanvasRoot)
          symlinkSync(replacement, canvasRoot, 'dir')
          return true
        },
        { helperPath: () => helperPath },
      )

      expect(readdirSync(replacement)).toEqual([])
      expect(existsSync(join(replacement, 'transactions'))).toBe(false)
      expect(readFileSync(join(
        movedCanvasRoot,
        'transactions',
        'agent-node-11111111-1111-4111-8111-111111111111.json',
      ), 'utf8')).toBe('{"state":"prepared"}')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test.skipIf(process.platform !== 'darwin')('Given 512 个合法 intent 与目录杂项 When 覆盖或新增 Then 覆盖成功、第 513 个拒绝且后续扫描仍成功', async () => {
    const appDir = resolve(import.meta.dir, '../../..')
    const helperPath = resolve(appDir, 'resources/stable-directory/stable-directory-helper')
    execFileSync(process.execPath, [resolve(appDir, 'scripts/build-stable-directory-native.ts')], { stdio: 'pipe' })
    const root = mkdtempSync(join(tmpdir(), 'proma-native-intent-capacity-'))
    const canvasRoot = join(root, 'canvas')
    const transactions = join(canvasRoot, 'transactions')
    mkdirSync(transactions, { recursive: true })
    /** 固定 UUID v4 形态，覆盖完整 512 容量。 */
    const intentNames = Array.from({ length: 512 }, (_, index) => (
      `agent-node-00000000-0000-4000-8000-${index.toString(16).padStart(12, '0')}.json`
    ))
    for (const name of intentNames) writeFileSync(join(transactions, name), '{}', 'utf8')
    writeFileSync(join(transactions, 'agent-node-not-a-uuid.json'), '{}', 'utf8')
    mkdirSync(join(transactions, 'agent-node-00000000-0000-4000-8000-ffffffffffff.json'))

    try {
      const write = (fileName: string) => runStableDirectoryNative({
        mode: 'canvas-intent-write', roots: [canvasRoot], childName: 'transactions',
        fileName, content: '{"state":"committed"}', maxEntries: 512,
      }, () => true, { helperPath: () => helperPath })

      await expect(write(intentNames[0]!)).resolves.toHaveProperty(
        'writeOutcome.commitVisible', true,
      )
      await expect(write('agent-node-00000000-0000-4000-8000-000000000200.json'))
        .resolves.toHaveProperty('writeOutcome', {
          commitVisible: false,
          durabilityUncertain: false,
          error: 'canvas intent entry limit exceeded',
        })

      const scanned = await runStableDirectoryNative({
        mode: 'canvas-intent-scan', roots: [canvasRoot], childName: 'transactions',
        maxEntries: 512, maxOutputBytes: 40 * 1024 * 1024,
      }, () => true, { helperPath: () => helperPath })
      expect(scanned.entries).toHaveLength(512)
      expect(scanned.entries.every((entry) => !entry.isDirectory)).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test.skipIf(process.platform !== 'darwin')('Given 511 个合法 intent When 两个真实 helper 并发新增 Then 只提交一个且最终保持 512', async () => {
    const appDir = resolve(import.meta.dir, '../../..')
    const helperPath = resolve(appDir, 'resources/stable-directory/stable-directory-helper')
    execFileSync(process.execPath, [resolve(appDir, 'scripts/build-stable-directory-native.ts')], { stdio: 'pipe' })
    const root = mkdtempSync(join(tmpdir(), 'proma-native-intent-concurrency-'))

    try {
      for (let round = 0; round < 6; round += 1) {
        const canvasRoot = join(root, `canvas-${round}`)
        const transactions = join(canvasRoot, 'transactions')
        mkdirSync(transactions, { recursive: true })
        /** 每轮固定预置 511 个合法 UUID intent，放大容量检查与 rename 之间的竞争窗口。 */
        for (let index = 0; index < 511; index += 1) {
          const name = `agent-node-00000000-0000-4000-8000-${index.toString(16).padStart(12, '0')}.json`
          writeFileSync(join(transactions, name), '{}', 'utf8')
        }
        const write = (suffix: string) => runStableDirectoryNative({
          mode: 'canvas-intent-write', roots: [canvasRoot], childName: 'transactions',
          fileName: `agent-node-ffffffff-ffff-4fff-8fff-${suffix}.json`,
          content: '{"state":"committed"}', maxEntries: 512,
        }, () => true, { helperPath: () => helperPath })

        const outcomes = await Promise.all([
          write(`${round.toString(16).padStart(2, '0')}0000000001`),
          write(`${round.toString(16).padStart(2, '0')}0000000002`),
        ])
        const visible = outcomes.filter((result) => result.writeOutcome?.commitVisible)
        const rejected = outcomes.filter((result) => !result.writeOutcome?.commitVisible)
        expect(visible).toHaveLength(1)
        expect(rejected).toHaveLength(1)
        expect(rejected[0]?.writeOutcome).toEqual({
          commitVisible: false,
          durabilityUncertain: false,
          error: 'canvas intent entry limit exceeded',
        })
        expect(readdirSync(transactions).filter((name) => /^agent-node-.*\.json$/.test(name))).toHaveLength(512)
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test.skipIf(process.platform !== 'darwin')('Given intent 锁文件是 symlink When helper 写入 Then fail closed 且目标不可见', async () => {
    const appDir = resolve(import.meta.dir, '../../..')
    const helperPath = resolve(appDir, 'resources/stable-directory/stable-directory-helper')
    execFileSync(process.execPath, [resolve(appDir, 'scripts/build-stable-directory-native.ts')], { stdio: 'pipe' })
    const root = mkdtempSync(join(tmpdir(), 'proma-native-intent-lock-symlink-'))
    const canvasRoot = join(root, 'canvas')
    const transactions = join(canvasRoot, 'transactions')
    const targetName = 'agent-node-ffffffff-ffff-4fff-8fff-ffffffffffff.json'
    mkdirSync(transactions, { recursive: true })
    writeFileSync(join(root, 'outside-lock'), 'outside', 'utf8')
    symlinkSync(join(root, 'outside-lock'), join(transactions, '.canvas-intent.lock'))

    try {
      const result = await runStableDirectoryNative({
        mode: 'canvas-intent-write', roots: [canvasRoot], childName: 'transactions',
        fileName: targetName, content: '{"state":"committed"}', maxEntries: 512,
      }, () => true, { helperPath: () => helperPath })

      expect(result.writeOutcome).toEqual({
        commitVisible: false,
        durabilityUncertain: false,
        error: 'canvas intent lock is unsafe',
      })
      expect(existsSync(join(transactions, targetName))).toBe(false)
      expect(readFileSync(join(root, 'outside-lock'), 'utf8')).toBe('outside')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test.skipIf(process.platform !== 'win32')('Given Windows intent 锁位是 junction When helper 写入 Then 拒绝 reparse 且目标不可见', async () => {
    const appDir = resolve(import.meta.dir, '../../..')
    const helperPath = resolve(appDir, 'resources/stable-directory/stable-directory-helper.exe')
    execFileSync(process.execPath, [resolve(appDir, 'scripts/build-stable-directory-native.ts')], { stdio: 'pipe' })
    const root = mkdtempSync(join(tmpdir(), 'proma-win-intent-lock-reparse-'))
    const canvasRoot = join(root, 'canvas')
    const transactions = join(canvasRoot, 'transactions')
    const replacement = join(root, 'replacement')
    const targetName = 'agent-node-ffffffff-ffff-4fff-8fff-dddddddddddd.json'
    mkdirSync(transactions, { recursive: true })
    mkdirSync(replacement)
    symlinkSync(replacement, join(transactions, '.canvas-intent.lock'), 'junction')

    try {
      const result = await runStableDirectoryNative({
        mode: 'canvas-intent-write', roots: [canvasRoot], childName: 'transactions',
        fileName: targetName, content: '{"state":"committed"}', maxEntries: 512,
      }, () => true, { helperPath: () => helperPath })

      expect(result.writeOutcome).toEqual({
        commitVisible: false,
        durabilityUncertain: false,
        error: 'canvas intent lock is unsafe',
      })
      expect(existsSync(join(transactions, targetName))).toBe(false)
      expect(readdirSync(replacement)).toEqual([])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test.skipIf(process.platform !== 'darwin')('Given 外部进程持有 intent 锁 When helper 超时退出 Then 释放等待资源且后续写入成功', async () => {
    const appDir = resolve(import.meta.dir, '../../..')
    const helperPath = resolve(appDir, 'resources/stable-directory/stable-directory-helper')
    execFileSync(process.execPath, [resolve(appDir, 'scripts/build-stable-directory-native.ts')], { stdio: 'pipe' })
    const root = mkdtempSync(join(tmpdir(), 'proma-native-intent-lock-timeout-'))
    const canvasRoot = join(root, 'canvas')
    const transactions = join(canvasRoot, 'transactions')
    const holderSource = join(root, 'lock-holder.cc')
    const holderPath = join(root, 'lock-holder')
    const lockPath = join(transactions, '.canvas-intent.lock')
    mkdirSync(transactions, { recursive: true })
    writeFileSync(holderSource, [
      '#include <fcntl.h>',
      '#include <stdio.h>',
      '#include <sys/file.h>',
      '#include <sys/stat.h>',
      '#include <unistd.h>',
      'int main(int argc, char** argv) {',
      '  if (argc != 2) return 2;',
      '  const int fd = open(argv[1], O_RDWR | O_CREAT | O_NOFOLLOW | O_CLOEXEC, 0600);',
      '  struct stat state {};',
      '  if (fd < 0 || fstat(fd, &state) != 0 || !S_ISREG(state.st_mode) || flock(fd, LOCK_EX) != 0) return 3;',
      '  puts("LOCKED"); fflush(stdout);',
      '  pause();',
      '  return 0;',
      '}',
    ].join('\n'), 'utf8')
    execFileSync('xcrun', ['clang++', '-std=c++17', holderSource, '-o', holderPath])
    const holder = spawn(holderPath, [lockPath], { stdio: ['ignore', 'pipe', 'pipe'] })

    try {
      await new Promise<void>((resolvePromise, rejectPromise) => {
        const timer = setTimeout(() => rejectPromise(new Error('锁持有进程启动超时')), 2_000)
        holder.stdout.on('data', (chunk: Buffer) => {
          if (!chunk.toString('utf8').includes('LOCKED')) return
          clearTimeout(timer)
          resolvePromise()
        })
        holder.once('exit', (code) => {
          clearTimeout(timer)
          rejectPromise(new Error(`锁持有进程意外退出: ${code}`))
        })
      })
      const request = {
        mode: 'canvas-intent-write' as const,
        roots: [canvasRoot], childName: 'transactions',
        fileName: 'agent-node-ffffffff-ffff-4fff-8fff-eeeeeeeeeeee.json',
        content: '{"state":"committed"}', maxEntries: 512,
      }

      await expect(runStableDirectoryNative(request, () => true, {
        helperPath: () => helperPath,
        startupTimeoutMs: 1_000,
        totalTimeoutMs: 1_000,
      })).rejects.toThrow('稳定目录 helper 执行超时')
      const holderExited = new Promise<void>((resolvePromise) => holder.once('exit', () => resolvePromise()))
      holder.kill('SIGTERM')
      await holderExited
      await expect(runStableDirectoryNative(request, () => true, {
        helperPath: () => helperPath,
        totalTimeoutMs: 5_000,
      })).resolves.toHaveProperty('writeOutcome.commitVisible', true)
    } finally {
      if (!holder.killed) holder.kill('SIGTERM')
      rmSync(root, { recursive: true, force: true })
    }
  })

  test.skipIf(process.platform !== 'darwin')('Given Canvas intent 位于已打开根 When 根路径在授权后被替换 Then helper 只返回原 inode 内存正文', async () => {
    const appDir = resolve(import.meta.dir, '../../..')
    const helperPath = resolve(appDir, 'resources/stable-directory/stable-directory-helper')
    execFileSync(process.execPath, [resolve(appDir, 'scripts/build-stable-directory-native.ts')], { stdio: 'pipe' })
    const root = mkdtempSync(join(tmpdir(), 'proma-native-intent-scan-race-'))
    const canvasRoot = join(root, 'canvas')
    const movedCanvasRoot = join(root, 'canvas-original')
    const replacement = join(root, 'replacement')
    const intentName = 'agent-node-11111111-1111-4111-8111-111111111111.json'
    mkdirSync(join(canvasRoot, 'transactions'), { recursive: true })
    mkdirSync(replacement)
    writeFileSync(join(canvasRoot, 'transactions', intentName), '{"state":"prepared"}')

    try {
      const result = await runStableDirectoryNative(
        {
          mode: 'canvas-intent-scan',
          roots: [canvasRoot],
          childName: 'transactions',
          maxEntries: 512,
        },
        () => {
          renameSync(canvasRoot, movedCanvasRoot)
          symlinkSync(replacement, canvasRoot, 'dir')
          return true
        },
        { helperPath: () => helperPath },
      )

      expect(result.entries).toEqual([{
        rootIndex: 0,
        name: intentName,
        path: '',
        isDirectory: false,
        size: 20,
        content: '{"state":"prepared"}',
      }])
      expect(readdirSync(replacement)).toEqual([])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test.skipIf(process.platform !== 'win32')('Given Windows drive 长路径 When helper 打开并枚举 Then canonical 用普通 drive 展示且内部仍可访问', async () => {
    const appDir = resolve(import.meta.dir, '../../..')
    const helperPath = resolve(appDir, 'resources/stable-directory/stable-directory-helper.exe')
    execFileSync(process.execPath, [resolve(appDir, 'scripts/build-stable-directory-native.ts')], { stdio: 'pipe' })
    const root = mkdtempSync(join(tmpdir(), 'proma-win-long-path-'))
    let longRoot = root
    try {
      while (longRoot.length < 280) longRoot = join(longRoot, 'segment-0123456789abcdef')
      mkdirSync(longRoot, { recursive: true })
      writeFileSync(join(longRoot, 'long.txt'), 'long')
      const result = await runStableDirectoryNative(
        { mode: 'list', roots: [longRoot] }, () => true, { helperPath: () => helperPath },
      )
      expect(result.roots[0]?.canonicalPath).not.toStartWith('\\\\?\\')
      expect(result.entries.map((entry) => entry.name)).toContain('long.txt')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test.skipIf(process.platform !== 'win32')('Given Windows 目录打开后被 junction 替换 When 无法相对根 HANDLE 重开子项 Then fail closed 为空且不跟随 replacement', async () => {
    const appDir = resolve(import.meta.dir, '../../..')
    const helperPath = resolve(appDir, 'resources/stable-directory/stable-directory-helper.exe')
    execFileSync(process.execPath, [resolve(appDir, 'scripts/build-stable-directory-native.ts')], { stdio: 'pipe' })
    const root = mkdtempSync(join(tmpdir(), 'proma-win-directory-race-'))
    const authorized = join(root, 'authorized')
    const moved = join(root, 'authorized-old')
    const replacement = join(root, 'replacement')
    mkdirSync(authorized)
    mkdirSync(replacement)
    writeFileSync(join(authorized, 'allowed.txt'), 'allowed')
    writeFileSync(join(replacement, 'secret.txt'), 'secret')
    try {
      const result = await runStableDirectoryNative(
        { mode: 'scan', roots: [authorized] },
        () => {
          renameSync(authorized, moved)
          symlinkSync(replacement, authorized, 'junction')
          return true
        },
        { helperPath: () => helperPath },
      )
      /** Windows 当前按 canonical path 重开子项；竞态发生后拒绝整项，不能读取 replacement。 */
      const entryNames = result.entries.map((entry) => entry.name)
      expect(entryNames).toEqual([])
      expect(entryNames).not.toContain('secret.txt')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test.skipIf(process.platform !== 'win32' || !windowsAdminShareAvailable)('Given Windows localhost 管理共享可用 When 使用 UNC root Then canonical 保留 UNC 展示形式', async () => {
    const appDir = resolve(import.meta.dir, '../../..')
    const helperPath = resolve(appDir, 'resources/stable-directory/stable-directory-helper.exe')
    execFileSync(process.execPath, [resolve(appDir, 'scripts/build-stable-directory-native.ts')], { stdio: 'pipe' })
    const root = mkdtempSync(join(tmpdir(), 'proma-win-unc-'))
    try {
      const uncRoot = toLocalhostAdminShare(root)
      if (!uncRoot) throw new Error('Windows 临时目录不是 drive 绝对路径')
      writeFileSync(join(root, 'unc.txt'), 'unc')
      const result = await runStableDirectoryNative(
        { mode: 'list', roots: [uncRoot] }, () => true, { helperPath: () => helperPath },
      )
      expect(result.roots[0]?.canonicalPath).toStartWith('\\\\')
      expect(result.roots[0]?.canonicalPath).not.toStartWith('\\\\?\\UNC\\')
      expect(result.entries.map((entry) => entry.name)).toContain('unc.txt')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
