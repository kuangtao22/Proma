import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

/** 测试创建的隔离目录，结束后统一清理。 */
const temporaryDirectories: string[] = []
/** 全部原生测试复用的一次构建产物目录。 */
let nativeAddonOutputRoot = ''
/** 当前平台一次构建后的 addon 路径。 */
let nativeAddonPath = ''

beforeAll(() => {
  nativeAddonOutputRoot = mkdtempSync(join(tmpdir(), 'proma-server-ops-lock-addon-'))
  nativeAddonPath = join(nativeAddonOutputRoot, 'server-ops-config-lock.node')
  execFileSync('bun', ['run', resolve(import.meta.dir, '../../../../scripts/build-server-ops-config-lock.ts')], {
    env: { ...process.env, SERVER_OPS_CONFIG_LOCK_OUTPUT: nativeAddonPath },
    stdio: 'pipe',
  })
})

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

afterAll(() => {
  if (nativeAddonOutputRoot) rmSync(nativeAddonOutputRoot, { recursive: true, force: true })
})

/** 创建符合生产目录名约束的 Server Ops 配置目录。 */
function createServerOpsDirectory(): string {
  const root = mkdtempSync(join(tmpdir(), 'proma-server-ops-lock-'))
  temporaryDirectories.push(root)
  const directory = join(root, 'server-ops')
  mkdirSync(directory)
  return directory
}

/** 返回 beforeAll 在临时目录构建的当前平台 N-API addon。 */
function getNativeAddonPath(): string {
  return nativeAddonPath
}

/** 等待子进程确认已持锁，失败时保留 stderr 便于诊断。 */
async function waitForReady(child: ReturnType<typeof spawn>): Promise<void> {
  await new Promise<void>((resolveReady, rejectReady) => {
    let stderr = ''
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (chunk: string) => { stderr += chunk })
    child.stdout?.setEncoding('utf8')
    child.stdout?.once('data', (chunk: string) => {
      if (chunk.trim() === 'READY') resolveReady()
      else rejectReady(new Error(`持锁子进程返回异常: ${chunk}`))
    })
    child.once('exit', (code) => rejectReady(new Error(`持锁子进程提前退出 ${code}: ${stderr}`)))
  })
}

/** 收集一次短命子进程的完整 stdout，并要求正常退出。 */
async function collectChildOutput(child: ReturnType<typeof spawn>): Promise<string> {
  return await new Promise<string>((resolveOutput, rejectOutput) => {
    let stdout = ''
    let stderr = ''
    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => { stdout += chunk })
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (chunk: string) => { stderr += chunk })
    child.once('error', rejectOutput)
    child.once('exit', (code) => {
      if (code === 0) resolveOutput(stdout)
      else rejectOutput(new Error(`配置写子进程退出 ${code}: ${stderr}`))
    })
  })
}

describe('server-ops config native lock', () => {
  test('Given 同一配置目录已被另一进程持有 When 尝试同步加锁 Then 立即返回 BUSY 且不删除共享锁文件', () => {
    const addonPath = getNativeAddonPath()
    const directory = createServerOpsDirectory()
    const require = createRequire(import.meta.url)
    const addon = require(addonPath) as {
      tryAcquire: (path: string) => { status: 'acquired'; handle: object } | { status: 'busy' }
      verify: (handle: object, path: string) => void
      release: (handle: object) => void
    }
    const first = addon.tryAcquire(directory)
    expect(first.status).toBe('acquired')
    if (first.status !== 'acquired') throw new Error('首个锁未取得')

    const contender = spawnSync('node', ['-e', `
      const addon = require(${JSON.stringify(addonPath)});
      process.stdout.write(JSON.stringify(addon.tryAcquire(${JSON.stringify(directory)})));
    `], { encoding: 'utf8', timeout: 2_000 })

    expect(contender.status).toBe(0)
    expect(JSON.parse(contender.stdout)).toEqual({ status: 'busy' })
    addon.release(first.handle)
    expect(existsSync(join(directory, '.server-ops-config.lock'))).toBe(true)
  })

  test('Given 同进程独立打开同一锁 When 第一次仍持有 Then 第二次 BUSY 且释放后可重新取得', () => {
    const addonPath = getNativeAddonPath()
    const directory = createServerOpsDirectory()
    const require = createRequire(import.meta.url)
    const addon = require(addonPath) as {
      tryAcquire: (path: string) => { status: 'acquired'; handle: object } | { status: 'busy' }
      release: (handle: object) => void
    }
    const first = addon.tryAcquire(directory)
    if (first.status !== 'acquired') throw new Error('首个锁未取得')

    expect(addon.tryAcquire(directory)).toEqual({ status: 'busy' })
    addon.release(first.handle)
    const afterRelease = addon.tryAcquire(directory)
    expect(afterRelease.status).toBe('acquired')
    if (afterRelease.status === 'acquired') addon.release(afterRelease.handle)
  })

  test('Given 持锁进程被强制终止 When 下一进程尝试加锁 Then OS 自动释放并允许继续', async () => {
    const addonPath = getNativeAddonPath()
    const directory = createServerOpsDirectory()
    const holder = spawn('node', ['-e', `
      const addon = require(${JSON.stringify(addonPath)});
      const result = addon.tryAcquire(${JSON.stringify(directory)});
      if (result.status !== 'acquired') process.exit(2);
      process.stdout.write('READY\\n');
      setInterval(() => {}, 1000);
    `], { stdio: ['ignore', 'pipe', 'pipe'] })
    await waitForReady(holder)
    holder.kill('SIGKILL')
    await new Promise<void>((resolveExit) => holder.once('exit', () => resolveExit()))

    const next = spawnSync('node', ['-e', `
      const addon = require(${JSON.stringify(addonPath)});
      const result = addon.tryAcquire(${JSON.stringify(directory)});
      process.stdout.write(result.status);
      if (result.status === 'acquired') addon.release(result.handle);
    `], { encoding: 'utf8', timeout: 2_000 })

    expect(next.status).toBe(0)
    expect(next.stdout).toBe('acquired')
  })

  test.skipIf(process.platform === 'win32')('Given 持锁目录或锁叶被持久替换 When 验证路径身份 Then fail closed', () => {
    const addonPath = getNativeAddonPath()
    const require = createRequire(import.meta.url)
    const addon = require(addonPath) as {
      tryAcquire: (path: string) => { status: 'acquired'; handle: object } | { status: 'busy' }
      verify: (handle: object, path: string) => void
      release: (handle: object) => void
    }

    const replacedDirectory = createServerOpsDirectory()
    const directoryLock = addon.tryAcquire(replacedDirectory)
    if (directoryLock.status !== 'acquired') throw new Error('目录替换测试未取得锁')
    renameSync(replacedDirectory, `${replacedDirectory}-old`)
    mkdirSync(replacedDirectory)
    expect(() => addon.verify(directoryLock.handle, replacedDirectory)).toThrow('身份已变化')
    addon.release(directoryLock.handle)

    const replacedLeafDirectory = createServerOpsDirectory()
    const leafLock = addon.tryAcquire(replacedLeafDirectory)
    if (leafLock.status !== 'acquired') throw new Error('锁叶替换测试未取得锁')
    renameSync(join(replacedLeafDirectory, '.server-ops-config.lock'), join(replacedLeafDirectory, '.server-ops-config.lock.old'))
    writeFileSync(join(replacedLeafDirectory, '.server-ops-config.lock'), '', { mode: 0o600 })
    expect(() => addon.verify(leafLock.handle, replacedLeafDirectory)).toThrow('身份已变化')
    addon.release(leafLock.handle)
  })

  test.skipIf(process.platform === 'win32')('Given 固定锁文件是符号链接 When 尝试加锁 Then 返回能力错误且不跟随目标', () => {
    const addonPath = getNativeAddonPath()
    const directory = createServerOpsDirectory()
    const target = join(directory, 'unrelated')
    symlinkSync(target, join(directory, '.server-ops-config.lock'))
    const script = `
      const addon = require(${JSON.stringify(addonPath)});
      try { addon.tryAcquire(${JSON.stringify(directory)}); process.exit(9); }
      catch (error) { process.stdout.write(String(error.code) + ':' + error.message); }
    `

    const result = spawnSync('node', ['-e', script], { encoding: 'utf8', timeout: 2_000 })

    expect(result.status).toBe(0)
    expect(result.stdout).toContain('SERVER_OPS_CONFIG_LOCK_UNAVAILABLE')
    expect(existsSync(target)).toBe(false)
  })

  test('Given 任意普通目录 When 尝试作为锁根 Then 固定目录合同拒绝该路径', () => {
    const addonPath = getNativeAddonPath()
    const root = mkdtempSync(join(tmpdir(), 'proma-invalid-lock-root-'))
    temporaryDirectories.push(root)
    const result = spawnSync('node', ['-e', `
      const addon = require(${JSON.stringify(addonPath)});
      try { addon.tryAcquire(${JSON.stringify(root)}); process.exit(9); }
      catch (error) { process.stdout.write(String(error.code) + ':' + error.message); }
    `], { encoding: 'utf8', timeout: 2_000 })

    expect(result.status).toBe(0)
    expect(result.stdout).toContain('SERVER_OPS_CONFIG_LOCK_INVALID_DIRECTORY')
  })

  test('Given addon 源码 When 检查三平台锁合同 Then 使用非阻塞系统锁且不包含超时删除或轮询', () => {
    const source = readFileSync(
      resolve(import.meta.dir, '../../../../native/server-ops-config-lock/server-ops-config-lock-addon.cc'),
      'utf8',
    )

    expect(source).toContain('LOCK_EX | LOCK_NB')
    expect(source).toContain('LockFileEx')
    expect(source).toContain('LOCKFILE_FAIL_IMMEDIATELY')
    expect(source).toContain('if (!UnlockFileEx')
    expect(source).toContain('&& !CloseHandle')
    expect(source).toContain('flock(handle->file, LOCK_UN) != 0')
    expect(source).toContain('close(handle->file) != 0')
    expect(source).toContain('ReleaseLock(handle, nullptr)')
    expect(source).not.toContain('sleep(')
    expect(source).not.toContain('unlinkat(')
    expect(source).not.toContain('DeleteFile')
  })

  test('Given Windows CI 未初始化 cl PATH When 检查构建脚本 Then 可通过 Visual Studio 开发者环境回退编译', () => {
    const source = readFileSync(
      resolve(import.meta.dir, '../../../../scripts/build-server-ops-config-lock.ts'),
      'utf8',
    )

    expect(source).toContain('vswhere.exe')
    expect(source).toContain('VsDevCmd.bat')
    expect(source).toContain("execFileSync('cmd.exe'")
  })
})

describe('Server Ops config transaction', () => {
  test('Given 两个真实子进程同时读改写 When 竞争同一配置 Then 一个提交且另一个明确 BUSY', async () => {
    const directory = createServerOpsDirectory()
    const filePath = join(directory, 'audit.json')
    writeFileSync(filePath, JSON.stringify({ count: 0 }), 'utf8')
    const transactionModuleUrl = new URL('./server-ops-config-transaction.ts', import.meta.url).href
    const safeFileModuleUrl = new URL('../safe-file.ts', import.meta.url).href
    const holderScript = `
      const { createServerOpsConfigTransaction } = await import(${JSON.stringify(transactionModuleUrl)});
      const { readJsonFileSafe, writeJsonFileAtomic } = await import(${JSON.stringify(safeFileModuleUrl)});
      const { readFileSync: readInput } = require('node:fs');
      const native = require(${JSON.stringify(getNativeAddonPath())});
      const transaction = createServerOpsConfigTransaction(${JSON.stringify(directory)}, { loadNativeAddon: () => native });
      transaction(() => {
        process.stdout.write('READY\\n');
        if (readInput(0, 'utf8').trim() !== 'GO') throw new Error('missing GO');
        const current = readJsonFileSafe(${JSON.stringify(filePath)}, {
          validate: value => Boolean(value && typeof value === 'object' && Number.isSafeInteger(value.count)),
        });
        writeJsonFileAtomic(${JSON.stringify(filePath)}, { count: current.count + 1 });
      });
      process.stdout.write('COMMITTED');
    `
    const contenderScript = `
      const { createServerOpsConfigTransaction } = await import(${JSON.stringify(transactionModuleUrl)});
      const native = require(${JSON.stringify(getNativeAddonPath())});
      const transaction = createServerOpsConfigTransaction(${JSON.stringify(directory)}, { loadNativeAddon: () => native });
      try {
        transaction(() => { throw new Error('busy contender callback must not run'); });
        process.stdout.write('UNEXPECTED');
      } catch (error) {
        if (error && error.code === 'SERVER_OPS_CONFIG_BUSY') process.stdout.write('BUSY');
        else throw error;
      }
    `
    const holder = spawn('bun', ['-e', holderScript], { stdio: ['pipe', 'pipe', 'pipe'] })
    await waitForReady(holder)
    const contender = spawn('bun', ['-e', contenderScript], { stdio: ['ignore', 'pipe', 'pipe'] })
    const contenderOutput = await collectChildOutput(contender)
    holder.stdin?.end('GO')
    const holderOutput = await collectChildOutput(holder)

    expect(contenderOutput).toBe('BUSY')
    expect(holderOutput).toBe('COMMITTED')
    expect(JSON.parse(readFileSync(filePath, 'utf8'))).toEqual({ count: 1 })
  })

  test('Given 同一目录嵌套同步事务 When 执行内部写入 Then 只取得并释放一次原生锁', async () => {
    const module = await import('./server-ops-config-transaction').catch(() => null)
    expect(module).not.toBeNull()
    if (!module) return
    const directory = createServerOpsDirectory()
    let acquired = 0
    let released = 0
    const native = {
      tryAcquire: () => {
        acquired += 1
        return { status: 'acquired' as const, handle: {} }
      },
      verify: () => undefined,
      release: () => { released += 1 },
    }
    const transaction = module.createServerOpsConfigTransaction(directory, {
      loadNativeAddon: () => native,
    })

    const result = transaction(() => transaction(() => 'committed'))

    expect(result).toBe('committed')
    expect(acquired).toBe(1)
    expect(released).toBe(1)
  })

  test('Given 原生锁正在被其它进程持有 When 开始事务 Then 返回 BUSY 且不执行回调', async () => {
    const module = await import('./server-ops-config-transaction').catch(() => null)
    expect(module).not.toBeNull()
    if (!module) return
    const directory = createServerOpsDirectory()
    let callbackCalled = false
    const transaction = module.createServerOpsConfigTransaction(directory, {
      loadNativeAddon: () => ({
        tryAcquire: () => ({ status: 'busy' as const }),
        verify: () => undefined,
        release: () => { throw new Error('busy 结果不应释放空句柄') },
      }),
    })

    expect(() => transaction(() => { callbackCalled = true }))
      .toThrow('SERVER_OPS_CONFIG_BUSY')
    expect(callbackCalled).toBe(false)
  })

  test('Given 事务回调抛错 When 离开事务 Then finally 释放原生锁并保留原错误', async () => {
    const module = await import('./server-ops-config-transaction').catch(() => null)
    expect(module).not.toBeNull()
    if (!module) return
    const directory = createServerOpsDirectory()
    let released = 0
    const transaction = module.createServerOpsConfigTransaction(directory, {
      loadNativeAddon: () => ({
        tryAcquire: () => ({ status: 'acquired' as const, handle: {} }),
        verify: () => undefined,
        release: () => { released += 1 },
      }),
    })

    expect(() => transaction(() => { throw new Error('write failed') })).toThrow('write failed')
    expect(released).toBe(1)
  })

  test('Given 回调返回 Promise When 执行同步事务 Then 明确拒绝跨异步边界持锁', async () => {
    const module = await import('./server-ops-config-transaction').catch(() => null)
    expect(module).not.toBeNull()
    if (!module) return
    const directory = createServerOpsDirectory()
    let released = 0
    const transaction = module.createServerOpsConfigTransaction(directory, {
      loadNativeAddon: () => ({
        tryAcquire: () => ({ status: 'acquired' as const, handle: {} }),
        verify: () => undefined,
        release: () => { released += 1 },
      }),
    })

    expect(() => transaction(() => Promise.resolve('late')))
      .toThrow('SERVER_OPS_CONFIG_ASYNC_CALLBACK')
    expect(released).toBe(1)
  })

  test('Given 原生 async function When 开始事务 Then 在执行回调前拒绝', async () => {
    const module = await import('./server-ops-config-transaction').catch(() => null)
    expect(module).not.toBeNull()
    if (!module) return
    const directory = createServerOpsDirectory()
    let callbackCalled = false
    let acquired = 0
    const transaction = module.createServerOpsConfigTransaction(directory, {
      loadNativeAddon: () => ({
        tryAcquire: () => { acquired += 1; return { status: 'acquired' as const, handle: {} } },
        verify: () => undefined,
        release: () => undefined,
      }),
    })

    const callback = async (): Promise<void> => { callbackCalled = true }
    expect(() => transaction(callback)).toThrow('SERVER_OPS_CONFIG_ASYNC_CALLBACK')
    expect(callbackCalled).toBe(false)
    expect(acquired).toBe(0)
  })

  test('Given 回调已完成写入 When 回调后身份复核失败 Then 返回结果未知且禁止盲目重试', async () => {
    const module = await import('./server-ops-config-transaction').catch(() => null)
    expect(module).not.toBeNull()
    if (!module) return
    const directory = createServerOpsDirectory()
    let committed = false
    let verifyCalls = 0
    const transaction = module.createServerOpsConfigTransaction(directory, {
      loadNativeAddon: () => ({
        tryAcquire: () => ({ status: 'acquired' as const, handle: {} }),
        verify: () => { if (++verifyCalls === 2) throw new Error('identity changed') },
        release: () => undefined,
      }),
    })

    expect(() => transaction(() => { committed = true })).toThrow('SERVER_OPS_CONFIG_OUTCOME_UNKNOWN')
    expect(committed).toBe(true)
  })

  test('Given 嵌套回调已完成写入 When 内层回调后身份复核失败 Then 外层保留结果未知', async () => {
    const module = await import('./server-ops-config-transaction').catch(() => null)
    expect(module).not.toBeNull()
    if (!module) return
    const directory = createServerOpsDirectory()
    let committed = false
    let verifyCalls = 0
    const transaction = module.createServerOpsConfigTransaction(directory, {
      loadNativeAddon: () => ({
        tryAcquire: () => ({ status: 'acquired' as const, handle: {} }),
        verify: () => { if (++verifyCalls === 3) throw new Error('nested identity changed') },
        release: () => undefined,
      }),
    })

    expect(() => transaction(() => transaction(() => { committed = true })))
      .toThrow('SERVER_OPS_CONFIG_OUTCOME_UNKNOWN')
    expect(committed).toBe(true)
  })

  test('Given 回调成功 When 配置锁释放失败 Then 返回结果未知', async () => {
    const module = await import('./server-ops-config-transaction').catch(() => null)
    expect(module).not.toBeNull()
    if (!module) return
    const directory = createServerOpsDirectory()
    const transaction = module.createServerOpsConfigTransaction(directory, {
      loadNativeAddon: () => ({
        tryAcquire: () => ({ status: 'acquired' as const, handle: {} }),
        verify: () => undefined,
        release: () => { throw new Error('release failed') },
      }),
    })

    expect(() => transaction(() => 'committed')).toThrow('SERVER_OPS_CONFIG_OUTCOME_UNKNOWN')
  })

  test('Given 回调原始失败且释放失败 When 离开事务 Then 保留原异常并附带释放诊断', async () => {
    const module = await import('./server-ops-config-transaction').catch(() => null)
    expect(module).not.toBeNull()
    if (!module) return
    const directory = createServerOpsDirectory()
    const original = new Error('write failed')
    const transaction = module.createServerOpsConfigTransaction(directory, {
      loadNativeAddon: () => ({
        tryAcquire: () => ({ status: 'acquired' as const, handle: {} }),
        verify: () => undefined,
        release: () => { throw new Error('release failed') },
      }),
    })

    try {
      transaction(() => { throw original })
      throw new Error('事务应抛出原始错误')
    } catch (error) {
      expect(error).toBe(original)
      expect((error as Error & { cause?: Error }).cause?.message).toContain('SERVER_OPS_CONFIG_LOCK_UNAVAILABLE')
    }
  })

  test('Given 固定 Server Ops 配置目录 When 解析文件路径 Then 只允许四个协作文件', async () => {
    const module = await import('./server-ops-config-transaction').catch(() => null)
    expect(module).not.toBeNull()
    if (!module) return
    const directory = createServerOpsDirectory()
    const canonicalDirectory = realpathSync(directory)

    expect(module.resolveServerOpsConfigFilePath(directory, 'hosts.json')).toBe(join(canonicalDirectory, 'hosts.json'))
    expect(module.resolveServerOpsConfigFilePath(directory, 'credentials.json')).toBe(join(canonicalDirectory, 'credentials.json'))
    expect(module.resolveServerOpsConfigFilePath(directory, 'known-hosts.json')).toBe(join(canonicalDirectory, 'known-hosts.json'))
    expect(module.resolveServerOpsConfigFilePath(directory, 'audit.json')).toBe(join(canonicalDirectory, 'audit.json'))
    expect(() => module.resolveServerOpsConfigFilePath(directory, '../settings.json' as 'hosts.json'))
      .toThrow('SERVER_OPS_CONFIG_FILE_UNSUPPORTED')
  })

  test('Given 源码直跑、开发 bundle 与打包态 When 解析默认 addon Then 分别命中工作树、dist 和 resourcesPath', async () => {
    const module = await import('./server-ops-config-transaction').catch(() => null)
    expect(module).not.toBeNull()
    if (!module) return
    const fileName = join('server-ops-config-lock', 'server-ops-config-lock.node')

    expect(module.resolveServerOpsConfigLockAddonPath({
      isPackaged: false,
      moduleDirectory: import.meta.dir,
      resourcesPath: '/unused',
    })).toBe(resolve(import.meta.dir, '../../../../resources', fileName))
    expect(module.resolveServerOpsConfigLockAddonPath({
      isPackaged: false,
      moduleDirectory: '/repo/apps/electron/dist',
      resourcesPath: '/unused',
    })).toBe(join('/repo/apps/electron/dist/resources', fileName))
    expect(module.resolveServerOpsConfigLockAddonPath({
      isPackaged: true,
      moduleDirectory: '/Applications/Proma.app/Contents/Resources/app.asar/dist',
      resourcesPath: '/Applications/Proma.app/Contents/Resources',
    })).toBe(join('/Applications/Proma.app/Contents/Resources', fileName))
  })
})
