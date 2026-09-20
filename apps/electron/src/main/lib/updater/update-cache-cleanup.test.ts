import { afterEach, describe, expect, test } from 'bun:test'
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  MAC_DIFFERENTIAL_CACHE_TTL_MS,
  bindUpdateCacheCleanupHealthEvents,
  createUpdateCacheCleanup,
  createUpdateCacheCleanupStartupGate,
  shouldDeferUpdateCacheCleanup,
} from './update-cache-cleanup'

/** 每个用例创建的隔离临时目录，结束后统一回收。 */
const tempDirectories: string[] = []
/** 测试用静默日志，避免预期失败分支污染测试输出。 */
const silentLogger: Pick<Console, 'info' | 'warn'> = {
  info: () => {},
  warn: () => {},
}

/** 创建只位于系统临时目录内的 updater 缓存夹具。 */
function createFixture(platform: NodeJS.Platform = 'win32') {
  /** 单个用例独占的临时根目录。 */
  const root = mkdtempSync(join(tmpdir(), 'proma-updater-cache-'))
  tempDirectories.push(root)
  /** 模拟 electron-updater 使用的系统缓存根。 */
  const baseCacheDirectory = join(root, 'cache-root')
  /** 模拟应用 updater 的直接缓存目录。 */
  const cacheDirectory = join(baseCacheDirectory, 'com.proma.app-updater')
  /** 模拟共享的待安装目录。 */
  const pendingDirectory = join(cacheDirectory, 'pending')
  /** 模拟已经完成下载的安装文件。 */
  const downloadedFile = join(pendingDirectory, 'Proma-0.19.53-bone.11.exe')
  /** Proma 自主管理的缓存状态文件。 */
  const stateFilePath = join(root, 'user-data', 'updater-cache-state.json')

  mkdirSync(pendingDirectory, { recursive: true })
  writeFileSync(downloadedFile, 'installer')

  return {
    baseCacheDirectory,
    cacheDirectory,
    downloadedFile,
    pendingDirectory,
    platform,
    stateFilePath,
    log: silentLogger,
  }
}

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true })
  }
})

describe('更新安装包缓存清理', () => {
  test('Given 有更新正在下载 When 健康清理到期 Then 延后共享 pending 清理', () => {
    expect(shouldDeferUpdateCacheCleanup(true, false)).toBe(true)
    expect(shouldDeferUpdateCacheCleanup(false, true)).toBe(true)
    expect(shouldDeferUpdateCacheCleanup(false, false)).toBe(false)
  })

  test('Given 尚未运行目标 Bone 版本 When 启动 Then 保留安装包和状态', () => {
    /** 未安装版本场景使用的缓存夹具。 */
    const fixture = createFixture()
    /** 被测缓存清理器。 */
    const cleanup = createUpdateCacheCleanup(fixture)
    expect(cleanup.recordDownloadedUpdate('0.19.53-bone.11', fixture.downloadedFile)).toBe(true)

    /** 旧 Bone 版本执行清理的结果。 */
    const result = cleanup.cleanupForRunningVersion('0.19.53-bone.10')

    expect(result).toEqual({ status: 'retained', deletedCount: 0 })
    expect(existsSync(fixture.downloadedFile)).toBe(true)
    expect(existsSync(fixture.stateFilePath)).toBe(true)
  })

  test('Given 目标 Bone 版本已稳定运行 When 清理 Then 删除 pending 和状态', () => {
    /** 已安装版本场景使用的缓存夹具。 */
    const fixture = createFixture()
    /** 被测缓存清理器。 */
    const cleanup = createUpdateCacheCleanup(fixture)
    cleanup.recordDownloadedUpdate('0.19.53-bone.10', fixture.downloadedFile)
    writeFileSync(join(fixture.pendingDirectory, 'update-info.json'), '{}')

    /** 更高 Bone 版本执行清理的结果。 */
    const result = cleanup.cleanupForRunningVersion('0.19.53-bone.11')

    expect(result).toEqual({ status: 'cleaned', deletedCount: 2 })
    expect(existsSync(fixture.pendingDirectory)).toBe(false)
    expect(existsSync(fixture.stateFilePath)).toBe(false)
  })

  test('Given updater 已移除受控 pending When 目标版本启动 Then 只消除旧状态', () => {
    /** pending 已被外部更新器移除的缓存夹具。 */
    const fixture = createFixture()
    /** 被测缓存清理器。 */
    const cleanup = createUpdateCacheCleanup(fixture)
    cleanup.recordDownloadedUpdate('0.19.53-bone.11', fixture.downloadedFile)
    rmSync(fixture.pendingDirectory, { recursive: true })

    /** 缺失 pending 的状态收敛结果。 */
    const result = cleanup.cleanupForRunningVersion('0.19.53-bone.11')

    expect(result).toEqual({ status: 'cleaned', deletedCount: 0 })
    expect(existsSync(fixture.stateFilePath)).toBe(false)
  })

  test('Given pending 被替换为悬空软链接 When 目标版本启动 Then 视为不安全并保留状态', () => {
    /** 悬空 pending 链接场景使用的缓存夹具。 */
    const fixture = createFixture()
    /** 被测缓存清理器。 */
    const cleanup = createUpdateCacheCleanup(fixture)
    cleanup.recordDownloadedUpdate('0.19.53-bone.11', fixture.downloadedFile)
    rmSync(fixture.pendingDirectory, { recursive: true })
    symlinkSync(join(dirname(fixture.baseCacheDirectory), 'missing-pending-target'), fixture.pendingDirectory)

    /** 悬空链接不得命中 absent 的清理结果。 */
    const result = cleanup.cleanupForRunningVersion('0.19.53-bone.11')

    expect(result).toEqual({ status: 'skipped-unsafe', deletedCount: 0 })
    expect(lstatSync(fixture.pendingDirectory).isSymbolicLink()).toBe(true)
    expect(existsSync(fixture.stateFilePath)).toBe(true)
  })

  test('Given pending lstat 返回非 ENOENT When 目标版本启动 Then 报告失败并保留状态', () => {
    /** lstat 故障场景使用的缓存夹具。 */
    const fixture = createFixture()
    /** 首次记录状态使用的正常清理器。 */
    const recorder = createUpdateCacheCleanup(fixture)
    recorder.recordDownloadedUpdate('0.19.53-bone.11', fixture.downloadedFile)
    /** 模拟权限拒绝的系统错误。 */
    const accessError = Object.assign(new Error('permission denied'), { code: 'EACCES' })
    /** cleanup 阶段注入严格 lstat 故障的清理器。 */
    const cleanup = createUpdateCacheCleanup({
      ...fixture,
      lstat: (path) => {
        if (path === fixture.pendingDirectory) throw accessError
        return lstatSync(path)
      },
    })

    /** 非缺失错误必须保留重试状态。 */
    const result = cleanup.cleanupForRunningVersion('0.19.53-bone.11')

    expect(result).toEqual({ status: 'failed', deletedCount: 0 })
    expect(existsSync(fixture.downloadedFile)).toBe(true)
    expect(existsSync(fixture.stateFilePath)).toBe(true)
  })

  test('Given 下载文件不在直接 pending 子目录 When 记录 Then 拒绝路径逃逸', () => {
    /** 路径逃逸场景使用的缓存夹具。 */
    const fixture = createFixture()
    /** 缓存根外的安装文件。 */
    const outsideFile = join(dirname(fixture.baseCacheDirectory), 'outside-installer.exe')
    writeFileSync(outsideFile, 'installer')
    /** 被测缓存清理器。 */
    const cleanup = createUpdateCacheCleanup(fixture)

    expect(cleanup.recordDownloadedUpdate('0.19.53-bone.11', outsideFile)).toBe(false)
    expect(existsSync(fixture.stateFilePath)).toBe(false)
    expect(readFileSync(outsideFile, 'utf8')).toBe('installer')
  })

  test('Given 下载路径经过软链接目录 When 记录 Then 不创建删除状态', () => {
    /** 软链接路径场景使用的缓存夹具。 */
    const fixture = createFixture()
    /** 缓存根外的真实目录。 */
    const outsideCacheDirectory = join(dirname(fixture.baseCacheDirectory), 'outside-cache')
    /** 缓存根内指向外部的链接目录。 */
    const linkedCacheDirectory = join(fixture.baseCacheDirectory, 'linked-cache')
    /** 外部真实 pending 目录。 */
    const linkedPendingDirectory = join(outsideCacheDirectory, 'pending')
    /** 外部真实安装文件。 */
    const linkedInstaller = join(linkedPendingDirectory, 'Proma.exe')
    mkdirSync(linkedPendingDirectory, { recursive: true })
    writeFileSync(linkedInstaller, 'installer')
    symlinkSync(outsideCacheDirectory, linkedCacheDirectory)
    /** 被测缓存清理器。 */
    const cleanup = createUpdateCacheCleanup(fixture)

    expect(cleanup.recordDownloadedUpdate(
      '0.19.53-bone.11',
      join(linkedCacheDirectory, 'pending', 'Proma.exe'),
    )).toBe(false)
    expect(existsSync(fixture.stateFilePath)).toBe(false)
    expect(readFileSync(linkedInstaller, 'utf8')).toBe('installer')
  })

  test('Given 状态文件是软链接 When 记录 Then 不覆盖链接目标或安装包', () => {
    /** 状态软链接场景使用的缓存夹具。 */
    const fixture = createFixture()
    /** 状态文件父目录。 */
    const stateDirectory = dirname(fixture.stateFilePath)
    /** 链接指向的外部文件。 */
    const outsideStateFile = join(dirname(stateDirectory), 'outside-state.json')
    mkdirSync(stateDirectory, { recursive: true })
    writeFileSync(outsideStateFile, 'outside-must-stay')
    symlinkSync(outsideStateFile, fixture.stateFilePath)
    /** 被测缓存清理器。 */
    const cleanup = createUpdateCacheCleanup(fixture)

    expect(cleanup.recordDownloadedUpdate('0.19.53-bone.11', fixture.downloadedFile)).toBe(false)
    expect(lstatSync(fixture.stateFilePath).isSymbolicLink()).toBe(true)
    expect(readFileSync(outsideStateFile, 'utf8')).toBe('outside-must-stay')
    expect(existsSync(fixture.downloadedFile)).toBe(true)
  })

  test('Given pending 含目录 When 清理 Then 预检失败且不部分删除', () => {
    /** 不安全条目场景使用的缓存夹具。 */
    const fixture = createFixture()
    /** 被测缓存清理器。 */
    const cleanup = createUpdateCacheCleanup(fixture)
    cleanup.recordDownloadedUpdate('0.19.53-bone.11', fixture.downloadedFile)
    /** pending 内不属于 updater 普通文件合同的目录。 */
    const unexpectedDirectory = join(fixture.pendingDirectory, 'unexpected')
    mkdirSync(unexpectedDirectory)
    writeFileSync(join(unexpectedDirectory, 'keep'), 'keep')

    /** 不安全目录触发的清理结果。 */
    const result = cleanup.cleanupForRunningVersion('0.19.53-bone.11')

    expect(result).toEqual({ status: 'skipped-unsafe', deletedCount: 0 })
    expect(existsSync(fixture.downloadedFile)).toBe(true)
    expect(existsSync(fixture.stateFilePath)).toBe(true)
  })

  test('Given 删除被文件系统拒绝 When 清理 Then 保留状态供下次启动重试', () => {
    /** 删除失败场景使用的缓存夹具。 */
    const fixture = createFixture()
    /** 被测缓存清理器。 */
    const cleanup = createUpdateCacheCleanup(fixture)
    cleanup.recordDownloadedUpdate('0.19.53-bone.11', fixture.downloadedFile)
    chmodSync(fixture.pendingDirectory, 0o500)

    /** 只读 pending 目录触发的清理结果。 */
    const result = cleanup.cleanupForRunningVersion('0.19.53-bone.11')

    chmodSync(fixture.pendingDirectory, 0o700)
    expect(result.status).toBe('failed')
    expect(existsSync(fixture.stateFilePath)).toBe(true)
    expect(existsSync(fixture.downloadedFile)).toBe(true)
  })

  test('Given macOS 差分基线过期且有下一版安装包 When 清理 Then 只回收差分文件', () => {
    /** macOS 差分缓存场景使用的夹具。 */
    const fixture = createFixture('darwin')
    /** 可推进的测试时间。 */
    let now = 1_000
    /** 被测缓存清理器。 */
    const cleanup = createUpdateCacheCleanup({ ...fixture, now: () => now })
    cleanup.recordDownloadedUpdate('0.19.53-bone.10', fixture.downloadedFile)
    writeFileSync(join(fixture.cacheDirectory, 'update.zip'), 'differential-base')
    writeFileSync(join(fixture.cacheDirectory, 'current.blockmap'), 'blockmap')
    writeFileSync(join(fixture.cacheDirectory, 'unrelated-file'), 'keep')

    cleanup.cleanupForRunningVersion('0.19.53-bone.10')
    mkdirSync(fixture.pendingDirectory)
    /** 下一 Bone 版本的待安装包。 */
    const nextInstaller = join(fixture.pendingDirectory, 'Proma-0.19.53-bone.11.zip')
    writeFileSync(nextInstaller, 'next-installer')
    cleanup.recordDownloadedUpdate('0.19.53-bone.11', nextInstaller)

    now += MAC_DIFFERENTIAL_CACHE_TTL_MS
    /** 旧版启动时执行的差分缓存到期清理结果。 */
    const result = cleanup.cleanupForRunningVersion('0.19.53-bone.10')

    expect(result).toEqual({ status: 'cleaned', deletedCount: 2 })
    expect(existsSync(join(fixture.cacheDirectory, 'update.zip'))).toBe(false)
    expect(existsSync(join(fixture.cacheDirectory, 'current.blockmap'))).toBe(false)
    expect(readFileSync(join(fixture.cacheDirectory, 'unrelated-file'), 'utf8')).toBe('keep')
    expect(existsSync(nextInstaller)).toBe(true)
    expect(existsSync(fixture.stateFilePath)).toBe(true)
  })
})

describe('更新缓存启动稳定门禁', () => {
  test('Given 窗口卡死 When 陈旧稳定计时回调随后执行 Then 不清理并解绑健康监听', () => {
    /** 捕获的稳定门禁回调。 */
    let scheduledCallback: (() => void) | undefined
    /** 捕获的窗口卡死监听器。 */
    let unresponsiveListener: (() => void) | undefined
    /** 三类健康监听的解绑次数。 */
    let unsubscribeCount = 0
    /** 实际执行清理的次数。 */
    let cleanupCount = 0
    /** 被测启动门禁。 */
    const gate = createUpdateCacheCleanupStartupGate({
      cleanup: () => {
        cleanupCount += 1
        return { status: 'cleaned', deletedCount: 1 }
      },
      shouldDefer: () => false,
      log: silentLogger,
      setTimeoutFn: (callback) => {
        scheduledCallback = callback
        return 1 as unknown as ReturnType<typeof setTimeout>
      },
      clearTimeoutFn: () => {},
    })
    /** 被测健康事件绑定。 */
    const binding = bindUpdateCacheCleanupHealthEvents({
      gate,
      addWindowUnresponsiveListener: (listener) => {
        unresponsiveListener = listener
        return () => { unsubscribeCount += 1 }
      },
      addDidFailLoadListener: () => () => { unsubscribeCount += 1 },
      addRenderProcessGoneListener: () => () => { unsubscribeCount += 1 },
    })

    gate.schedule()
    unresponsiveListener?.()
    scheduledCallback?.()
    binding.dispose()
    binding.dispose()

    expect(cleanupCount).toBe(0)
    expect(unsubscribeCount).toBe(3)
  })

  test('Given 主窗口显示后保持稳定 When 延迟到期 Then 只执行一次清理', () => {
    /** 捕获的延迟回调。 */
    let scheduledCallback: (() => void) | undefined
    /** 实际执行清理的次数。 */
    let cleanupCount = 0
    /** 被测启动门禁。 */
    const gate = createUpdateCacheCleanupStartupGate({
      cleanup: () => {
        cleanupCount += 1
        return { status: 'cleaned', deletedCount: 1 }
      },
      shouldDefer: () => false,
      log: silentLogger,
      setTimeoutFn: (callback, delayMs) => {
        expect(delayMs).toBe(15_000)
        scheduledCallback = callback
        return 1 as unknown as ReturnType<typeof setTimeout>
      },
      clearTimeoutFn: () => {},
    })

    gate.schedule()
    expect(cleanupCount).toBe(0)
    scheduledCallback?.()
    scheduledCallback?.()

    expect(cleanupCount).toBe(1)
  })

  test('Given renderer 健康检查失败 When 延迟到期 Then 取消缓存清理', () => {
    /** 捕获的延迟回调。 */
    let scheduledCallback: (() => void) | undefined
    /** 定时器取消次数。 */
    let cancelCount = 0
    /** 实际执行清理的次数。 */
    let cleanupCount = 0
    /** 被测启动门禁。 */
    const gate = createUpdateCacheCleanupStartupGate({
      cleanup: () => {
        cleanupCount += 1
        return { status: 'cleaned', deletedCount: 1 }
      },
      shouldDefer: () => false,
      log: silentLogger,
      setTimeoutFn: (callback) => {
        scheduledCallback = callback
        return 1 as unknown as ReturnType<typeof setTimeout>
      },
      clearTimeoutFn: () => { cancelCount += 1 },
    })

    gate.schedule()
    gate.markRendererFailed()
    scheduledCallback?.()

    expect(cancelCount).toBe(1)
    expect(cleanupCount).toBe(0)
  })

  test('Given 清理到期时仍在下载 When 门禁触发 Then 不清理共享目录', () => {
    /** 捕获的延迟回调。 */
    let scheduledCallback: (() => void) | undefined
    /** 实际执行清理的次数。 */
    let cleanupCount = 0
    /** 被测启动门禁。 */
    const gate = createUpdateCacheCleanupStartupGate({
      cleanup: () => {
        cleanupCount += 1
        return { status: 'cleaned', deletedCount: 1 }
      },
      shouldDefer: () => true,
      log: silentLogger,
      setTimeoutFn: (callback) => {
        scheduledCallback = callback
        return 1 as unknown as ReturnType<typeof setTimeout>
      },
      clearTimeoutFn: () => {},
    })

    gate.schedule()
    scheduledCallback?.()

    expect(cleanupCount).toBe(0)
  })

  test('Given 首次清理失败 When 重试仍失败 Then 有界重试并保留下次启动机会', () => {
    /** 顺序捕获首次与重试回调。 */
    const scheduledCallbacks: Array<() => void> = []
    /** 所有调度延迟。 */
    const scheduledDelays: number[] = []
    /** 实际执行清理的次数。 */
    let cleanupCount = 0
    /** 被测启动门禁。 */
    const gate = createUpdateCacheCleanupStartupGate({
      cleanup: () => {
        cleanupCount += 1
        return { status: 'failed', deletedCount: 0 }
      },
      shouldDefer: () => false,
      log: silentLogger,
      setTimeoutFn: (callback, delayMs) => {
        scheduledCallbacks.push(callback)
        scheduledDelays.push(delayMs)
        return scheduledCallbacks.length as unknown as ReturnType<typeof setTimeout>
      },
      clearTimeoutFn: () => {},
    })

    gate.schedule()
    scheduledCallbacks[0]?.()
    scheduledCallbacks[1]?.()
    scheduledCallbacks[2]?.()

    expect(cleanupCount).toBe(3)
    expect(scheduledDelays).toEqual([15_000, 1_000, 1_000])
  })
})
