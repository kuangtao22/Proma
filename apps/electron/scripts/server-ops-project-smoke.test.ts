import { afterEach, expect, test } from 'bun:test'
import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** 子进程验收允许保留的最大单路诊断字节数。 */
const MAX_DIAGNOSTIC_BYTES = 256 * 1024
/** 真实 Electron 主进程的最长验收时间。 */
const SMOKE_TIMEOUT_MS = 30_000
/** 测试创建的临时构建目录。 */
const temporaryDirectories: string[] = []
/** Linux 无显示服务时无法启动真实 Electron GUI 主进程，只跳过该不成立的运行环境。 */
const electronSmokeTest = process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY
  ? test.skip
  : test

/** 删除测试创建的临时构建产物。 */
afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

/** 从当前环境移除会把 Electron 降级为 Node CLI 的开关。 */
function createElectronEnvironment(): NodeJS.ProcessEnv {
  /** 复制当前 CI 环境，避免修改测试宿主的全局环境。 */
  const environment = { ...process.env }
  delete environment.ELECTRON_RUN_AS_NODE
  return environment
}

/** 有界收集子进程输出，避免异常刷屏拖垮测试宿主。 */
function appendDiagnostic(current: string, chunk: Buffer): string {
  if (current.length >= MAX_DIAGNOSTIC_BYTES) return current
  return (current + chunk.toString('utf8')).slice(0, MAX_DIAGNOSTIC_BYTES)
}

/** 启动真实 Electron 主进程并返回退出诊断。 */
async function runElectronSmoke(
  electronBinary: string,
  entryPath: string,
  cwd: string,
  addonPath: string,
  dataRoot: string,
): Promise<{
  code: number | null
  signal: NodeJS.Signals | null
  stdout: string
  stderr: string
  timedOut: boolean
}> {
  return await new Promise((resolve, reject) => {
    /** native 崩溃被限制在该独立 Electron 子进程。 */
    const child = spawn(electronBinary, [entryPath], {
      cwd,
      env: {
        ...createElectronEnvironment(),
        SERVER_OPS_SMOKE_ADDON_PATH: addonPath,
        SERVER_OPS_SMOKE_DATA_ROOT: dataRoot,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    /** 截断后的标准输出，包含成功检查点。 */
    let stdout = ''
    /** 截断后的标准错误，保留启动与原生加载失败原因。 */
    let stderr = ''
    /** 区分超时强制终止与程序自行退出。 */
    let timedOut = false
    /** 防止 Electron 或 addon 死锁后挂住整组测试。 */
    let timeout: ReturnType<typeof setTimeout>
    child.stdout.on('data', (chunk: Buffer) => { stdout = appendDiagnostic(stdout, chunk) })
    child.stderr.on('data', (chunk: Buffer) => { stderr = appendDiagnostic(stderr, chunk) })
    child.once('error', (error) => {
      clearTimeout(timeout)
      reject(error)
    })
    timeout = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, SMOKE_TIMEOUT_MS)
    child.once('close', (code, signal) => {
      clearTimeout(timeout)
      resolve({ code, signal, stdout, stderr, timedOut })
    })
  })
}

electronSmokeTest('Given 真实配置锁 addon When Electron 主进程连续维护中文运维项目 Then 重名失败后仍可持久化', async () => {
  /** 当前脚本目录和 Electron 包根用于定位源码及默认资源。 */
  const scriptsDirectory = dirname(fileURLToPath(import.meta.url))
  const appDirectory = dirname(scriptsDirectory)
  /** native addon 与烟雾 bundle 共用的隔离构建目录。 */
  const buildDirectory = mkdtempSync(join(tmpdir(), 'proma-server-ops-project-smoke-test-'))
  temporaryDirectories.push(buildDirectory)
  /** Electron 可直接启动的临时 CJS 入口。 */
  const outputPath = join(buildDirectory, 'server-ops-project-smoke.cjs')
  /** 当前平台临时编译的真实配置锁 addon。 */
  const addonPath = join(buildDirectory, 'server-ops-config-lock.node')
  /** Electron 项目配置与 userData 使用的父进程托管临时数据根。 */
  const dataRoot = join(buildDirectory, 'data-root')
  /** 每次测试都在临时目录构建真实 addon，避免覆盖 resources 并触发开发监听。 */
  const nativeBuild = spawnSync(process.execPath, [join(scriptsDirectory, 'build-server-ops-config-lock.ts')], {
    cwd: appDirectory,
    env: { ...process.env, SERVER_OPS_CONFIG_LOCK_OUTPUT: addonPath },
    encoding: 'utf8',
    timeout: 150_000,
  })
  /** native 构建失败时保留退出码、signal 与完整编译诊断。 */
  const nativeDiagnostics = [
    `exitCode=${String(nativeBuild.status)}`,
    `signal=${String(nativeBuild.signal)}`,
    `stdout:\n${nativeBuild.stdout}`,
    `stderr:\n${nativeBuild.stderr}`,
  ].join('\n')
  expect(nativeBuild.error, nativeDiagnostics).toBeUndefined()
  expect(nativeBuild.status, nativeDiagnostics).toBe(0)
  /** 复用应用正式构建使用的 esbuild，把 TypeScript 转成 Electron 可直接启动的 CJS。 */
  const smokeBuild = spawnSync(process.execPath, [
    'x', 'esbuild', join(scriptsDirectory, 'server-ops-project-smoke.ts'),
    '--bundle', '--platform=node', '--format=cjs', `--outfile=${outputPath}`, '--external:electron',
  ], {
    cwd: appDirectory,
    env: process.env,
    encoding: 'utf8',
    timeout: 30_000,
  })
  /** smoke bundle 构建失败时保留退出码、signal 与编译诊断。 */
  const smokeBuildDiagnostics = [
    `exitCode=${String(smokeBuild.status)}`,
    `signal=${String(smokeBuild.signal)}`,
    `stdout:\n${smokeBuild.stdout}`,
    `stderr:\n${smokeBuild.stderr}`,
  ].join('\n')
  expect(smokeBuild.error, smokeBuildDiagnostics).toBeUndefined()
  expect(smokeBuild.status, smokeBuildDiagnostics).toBe(0)
  /** 根工作区提升安装的 Electron 可执行文件。 */
  const electronBinary = createRequire(import.meta.url)('electron') as string

  /** Electron 独立进程的退出结果与有界诊断。 */
  const result = await runElectronSmoke(electronBinary, outputPath, appDirectory, addonPath, dataRoot)
  /** 断言失败时直接展示崩溃、超时或脚本异常原因。 */
  const diagnostics = [
    `exitCode=${String(result.code)}`,
    `signal=${String(result.signal)}`,
    `timedOut=${String(result.timedOut)}`,
    `stdout:\n${result.stdout}`,
    `stderr:\n${result.stderr}`,
  ].join('\n')
  expect(result.timedOut, diagnostics).toBe(false)
  expect(result.code, diagnostics).toBe(0)
  expect(result.stdout).toContain('[Server Ops project smoke] PASS')
  expect(result.stdout).toContain('重复名称拒绝后继续创建和重命名成功')
  expect(result.stdout).toContain('重新实例化读取持久状态成功')
}, 240_000)
