/** 使用实际 main/preload/renderer 验证空配置启动和再次启动；只使用临时业务目录。 */
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawn } = require('node:child_process')
/** 子进程专用的临时 home 位置；不覆盖用户环境的 HOME/USERPROFILE。 */
const fixtureRootVariable = 'PROMA_FIRST_STARTUP_SMOKE_ROOT'
/** 当前工作树已构建的完整 Electron 应用目录。 */
const applicationRoot = path.resolve(__dirname, '..')

/** 启动独立 Electron 并等待其正常退出；输入可执行路径、临时 home，返回完成 Promise。 */
async function runClient(executable, fixtureRoot) {
  await new Promise((resolve, reject) => {
    /** 仅本次验收拥有的客户端进程。 */
    const child = spawn(executable, [__filename], {
      cwd: applicationRoot,
      env: { ...process.env, [fixtureRootVariable]: fixtureRoot },
      stdio: ['ignore', 'pipe', 'inherit'],
    })
    /** 子进程必须明确完成 IPC 断言，正常退出本身不代表启动验收成功。 */
    let clientVerified = false
    /** 保留跨 stdout chunk 的短尾，避免验收标记分片造成误判。 */
    let outputTail = ''
    child.stdout.on('data', (chunk) => {
      /** 合并上一片尾部后检测完整成功标记，并保留原始日志。 */
      const text = outputTail + chunk.toString()
      clientVerified ||= text.includes('[first startup smoke] client IPC PASS')
      outputTail = text.slice(-80)
      process.stdout.write(chunk)
    })
    /** 父进程兜底超时，避免失败验收永久挂起。 */
    const timeout = setTimeout(() => child.kill('SIGKILL'), 45_000)
    child.once('error', (error) => { clearTimeout(timeout); reject(error) })
    child.once('close', (code, signal) => {
      clearTimeout(timeout)
      if (code === 0 && clientVerified) resolve()
      else reject(new Error(`客户端启动回归失败：code=${code}, signal=${signal}, verified=${clientVerified}`))
    })
  })
}

/** Bun 父入口：创建空配置，连续运行两次实际客户端，再清理临时目录。 */
async function runSmoke() {
  /** 真实二进制路径保证 macOS helper 从 Electron.app 中解析。 */
  const executable = fs.realpathSync(process.env.PROMA_UPSTREAM_SMOKE_ELECTRON || require('electron'))
  /** 本次回归独占的临时 home；其内不预建 server-ops。 */
  const fixtureRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'proma-first-startup-')))
  try {
    fs.mkdirSync(path.join(fixtureRoot, '.proma'))
    // 关闭 LAN 监听，避免与用户当前实例争抢端口；这是临时夹具文件。
    fs.writeFileSync(path.join(fixtureRoot, '.proma', 'lan-bridge.json'), '{"enabled":false}')
    assert.equal(fs.existsSync(path.join(fixtureRoot, '.proma', 'server-ops')), false)
    await runClient(executable, fixtureRoot)
    /** 第一次启动后形成的固定目录身份。 */
    const directoryIdentity = fs.statSync(path.join(fixtureRoot, '.proma', 'server-ops')).ino
    /** 合成的既有配置文件；再次启动必须保持其原文。 */
    const existingConfigPath = path.join(fixtureRoot, '.proma', 'server-ops', 'hosts.json')
    /** 合法空列表保留可辨识空白，重新序列化或重建文件会使原文断言失败。 */
    const existingConfig = '\n[ ]\n'
    fs.writeFileSync(existingConfigPath, existingConfig)
    await runClient(executable, fixtureRoot)
    assert.equal(fs.statSync(path.join(fixtureRoot, '.proma', 'server-ops')).ino, directoryIdentity)
    assert.equal(fs.readFileSync(existingConfigPath, 'utf8'), existingConfig)
    console.log('[first startup smoke] PASS: Given 全新配置/既有目录 When 启动实际客户端 Then IPC 可用且既有配置保持原文')
  } finally {
    fs.rmSync(fixtureRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
}

/** Electron 子入口：先隔离 home，再加载生产主进程；验证实际 preload 的 IPC 调用。 */
function runElectronClient() {
  /** 子进程接收的临时业务根。 */
  const fixtureRoot = process.env[fixtureRootVariable]
  assert.ok(fixtureRoot, '缺少首次启动回归的临时根')
  os.homedir = () => fixtureRoot
  require('node:module').syncBuiltinESMExports()
  /** 只在隔离 Electron 进程中引用原生应用能力。 */
  const { app, BrowserWindow, dialog, globalShortcut, safeStorage, session } = require('electron')
  /** Electron 内部数据同样放进临时根。 */
  const appData = path.join(fixtureRoot, 'app-data')
  fs.mkdirSync(appData, { recursive: true })
  app.setPath('home', fixtureRoot)
  app.setPath('appData', appData)
  app.setPath('userData', path.join(appData, 'startup-smoke'))
  process.env.PROMA_DEV_INSTANCE = `first-startup-smoke-${process.pid}`
  // 验收窗口不抢用户焦点，也不占用全局快捷键。
  BrowserWindow.prototype.show = function () {}
  globalShortcut.register = () => false
  // 无凭据夹具不应访问系统钥匙串，也不允许原生错误弹窗阻塞回归。
  safeStorage.isEncryptionAvailable = () => false
  dialog.showErrorBox = (title, content) => finish(new Error(`${title}: ${content}`))
  if (app.dock) app.dock.show = async () => {}
  /** 原生导航方法只对开发入口以外的 URL 保留原样。 */
  const nativeLoadURL = BrowserWindow.prototype.loadURL
  BrowserWindow.prototype.loadURL = function (url, options) {
    if (url.startsWith('http://127.0.0.1:5174')) {
      return this.loadFile(path.join(applicationRoot, 'dist', 'renderer', 'index.html'), {
        query: Object.fromEntries(new URL(url).searchParams),
      })
    }
    return nativeLoadURL.call(this, url, options)
  }
  /** 当前验收是否已经收敛，防止多窗口或重复事件重复退出。 */
  let finished = false
  /** 启动/renderer 无响应时有界失败。 */
  const timeout = setTimeout(() => finish(new Error('等待完整客户端及 IPC 超时')), 30_000)
  /** 成功正常退出；失败保留日志并返回非零码。 */
  function finish(error) {
    if (finished) return
    finished = true
    clearTimeout(timeout)
    if (error) {
      console.error('[first startup smoke] FAIL', error)
      app.exit(1)
    } else {
      console.log('[first startup smoke] client IPC PASS')
      app.quit()
    }
  }
  /** 捕获生产 bootstrap 的致命失败，不能把降级页当成功。 */
  const nativeConsoleError = console.error
  console.error = (...args) => {
    nativeConsoleError(...args)
    if (String(args[0]).includes('bootstrap 致命错误')) {
      finish(new Error('生产 bootstrap 进入降级模式'))
    }
  }
  app.whenReady().then(() => {
    // renderer 的网络请求全部禁用；本回归无需外部服务或模型。
    session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
      callback({ cancel: /^(https?|wss?):/.test(details.url) })
    })
  })
  app.on('browser-window-created', (_event, window) => {
    window.webContents.on('did-finish-load', async () => {
      if (finished || !window.webContents.getURL().endsWith('/renderer/index.html')) return
      try {
        /** 跨真实 preload/IPC 读取两组业务列表，不使用 mock handler。 */
        const result = await window.webContents.executeJavaScript(`Promise.all([
          window.electronAPI.listServerOpsHosts(),
          window.electronAPI.listAgentSessions(),
        ])`)
        assert.deepEqual(result, [[], []])
        assert.equal(fs.lstatSync(path.join(fixtureRoot, '.proma', 'server-ops')).isDirectory(), true)
        finish()
      } catch (error) { finish(error) }
    })
  })
  require(path.join(applicationRoot, 'dist', 'main.cjs'))
}

if (process.versions.electron) runElectronClient()
else runSmoke().catch((error) => { console.error('[first startup smoke] FAIL', error); process.exitCode = 1 })
