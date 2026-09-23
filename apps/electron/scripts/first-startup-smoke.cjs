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

/** 启动恢复专用窗口并验证 file-conflict 场景；返回后续可检查的夹具路径。 */
async function runRecoveryClient(executable, fixtureRoot, targetRoot) {
  await new Promise((resolve, reject) => {
    const child = spawn(executable, [__filename], {
      cwd: applicationRoot,
      env: {
        ...process.env,
        [fixtureRootVariable]: fixtureRoot,
        PROMA_RECOVERY_TARGET_ROOT: targetRoot,
      },
      stdio: ['ignore', 'pipe', 'inherit'],
    })
    let clientVerified = false
    let outputTail = ''
    child.stdout.on('data', (chunk) => {
      const text = outputTail + chunk.toString()
      clientVerified ||= text.includes('[first startup smoke] recovery IPC PASS')
      outputTail = text.slice(-100)
      process.stdout.write(chunk)
    })
    const timeout = setTimeout(() => child.kill('SIGKILL'), 45_000)
    child.once('error', (error) => { clearTimeout(timeout); reject(error) })
    child.once('close', (code, signal) => {
      clearTimeout(timeout)
      if (code === 0 && clientVerified) resolve()
      else reject(new Error(`数据根恢复回归失败：code=${code}, signal=${signal}, verified=${clientVerified}`))
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
    /** 文件冲突必须进入独立恢复窗口，不能覆盖旧数据根。 */
    const conflictingRoot = path.join(fixtureRoot, '.proma', 'server-ops')
    fs.rmSync(conflictingRoot, { recursive: true, force: true })
    fs.writeFileSync(conflictingRoot, 'legacy-server-ops-file')
    const recoveryTarget = path.join(fixtureRoot, 'recovery-empty-root')
    fs.mkdirSync(recoveryTarget)
    await runRecoveryClient(executable, fixtureRoot, recoveryTarget)
    assert.equal(fs.readFileSync(conflictingRoot, 'utf8'), 'legacy-server-ops-file')
    assert.equal(fs.existsSync(path.join(recoveryTarget, 'server-ops')), true)
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
  const recoveryTargetRoot = process.env.PROMA_RECOVERY_TARGET_ROOT
  let recoverySmokeComplete = false
  process.env.PROMA_DEV_INSTANCE = `first-startup-smoke-${process.pid}`
  // 验收窗口不抢用户焦点，也不占用全局快捷键。
  BrowserWindow.prototype.show = function () {}
  globalShortcut.register = () => false
  // 无凭据夹具不应访问系统钥匙串，也不允许原生错误弹窗阻塞回归。
  safeStorage.isEncryptionAvailable = () => false
  if (recoveryTargetRoot) {
    /** recovery 场景只允许选择脚本创建的空目录，禁止访问真实文件选择器。 */
    /** 第二次系统选择模拟用户取消，第三次重新选择可用于新的确认。 */
    let recoveryPickCount = 0
    dialog.showOpenDialog = async () => {
      recoveryPickCount += 1
      return recoveryPickCount === 2
        ? { canceled: true, filePaths: [] }
        : { canceled: false, filePaths: [recoveryTargetRoot] }
    }
    const nativeQuit = app.quit.bind(app)
    app.quit = () => {
      if (!recoverySmokeComplete) return
      nativeQuit()
    }
    app.relaunch = () => {
      /** 由页面验证完成后置成功标记，避免真正再启动一个 Electron 进程。 */
      process.env.PROMA_RECOVERY_RELAUNCH_INTERCEPTED = '1'
    }
  }
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
      if (finished || !new URL(window.webContents.getURL()).pathname.endsWith('/renderer/index.html')) return
      try {
        /** 跨真实 preload/IPC 读取两组业务列表，不使用 mock handler。 */
        if (!recoveryTargetRoot) {
          const result = await window.webContents.executeJavaScript(`Promise.all([
            window.electronAPI.listServerOpsHosts(),
            window.electronAPI.listAgentSessions(),
          ])`)
          assert.deepEqual(result, [[], []])
          assert.equal(fs.lstatSync(path.join(fixtureRoot, '.proma', 'server-ops')).isDirectory(), true)
          finish()
          return
        }
        /** 等待真实 React 恢复页面渲染，不能只凭 preload IPC 可用宣称界面可用。 */
        await window.webContents.executeJavaScript(`(async () => {
          const deadline = Date.now() + 5000
          while (Date.now() < deadline) {
            if (document.body.textContent.includes('选择应用数据目录') && document.body.textContent.includes('同名文件占用')) return
            await new Promise(resolve => setTimeout(resolve, 50))
          }
          throw new Error('真实恢复界面未显示目录选择和具体原因')
        })()`)
        /** 可选输出本次隔离窗口截图，便于本地视觉验收。 */
        if (process.env.PROMA_RECOVERY_SCREENSHOT) {
          fs.writeFileSync(process.env.PROMA_RECOVERY_SCREENSHOT, (await window.webContents.capturePage()).toPNG())
        }
        const recoveryResult = await window.webContents.executeJavaScript(`(async () => {
          if (new URLSearchParams(location.search).get('mode') !== 'data-root-recovery') throw new Error('未进入恢复模式')
          if (window.electronAPI !== undefined) throw new Error('恢复窗口暴露了普通业务 API')
          const api = window.pathManagementAPI
          const keys = Object.keys(api).sort()
          const state = await api.getPathManagementState()
          if (!state.startupIssue || state.startupIssue.code !== 'not-directory') {
            throw new Error('恢复窗口未报告 file-conflict: ' + JSON.stringify(state.startupIssue))
          }
          if (keys.includes('listServerOpsHosts') || !keys.includes('recoverDataRoot')) {
            throw new Error('恢复 preload 暴露了错误的 API allowlist: ' + keys.join(','))
          }
          await api.recoverDataRoot({ action: 'recheck' })
          const afterRecheck = await api.getPathManagementState()
          if (!afterRecheck.startupIssue || afterRecheck.startupIssue.code !== 'not-directory') {
            throw new Error('recheck 错误地清除了 startupIssue')
          }
          const selection = await api.pickDataRoot()
          if (!selection || selection.kind !== 'empty') throw new Error('未获得 empty recovery selection')
          const beforeUnconfirmed = await api.getPathManagementState()
          await api.recoverDataRoot({ action: 'relocate', selectedRoot: selection.targetRoot, selectionId: selection.selectionId }).then(
            () => { throw new Error('未确认空目录却完成恢复') },
            () => undefined,
          )
          const afterUnconfirmed = await api.getPathManagementState()
          if (afterUnconfirmed.activeRoot !== beforeUnconfirmed.activeRoot || afterUnconfirmed.previousRoot !== beforeUnconfirmed.previousRoot) {
            throw new Error('未确认空目录改变了 locator')
          }
          // 系统选择器取消必须撤销旧授权，并保持原数据根。
          if (await api.pickDataRoot() !== null) throw new Error('系统取消未返回 null')
          const afterCancel = await api.getPathManagementState()
          if (afterCancel.activeRoot !== beforeUnconfirmed.activeRoot) throw new Error('取消选择改变了数据根')
          await api.recoverDataRoot({ action: 'relocate', selectedRoot: selection.targetRoot, selectionId: selection.selectionId, initializeEmpty: true }).then(
            () => { throw new Error('已取消的选择仍然可以提交') },
            () => undefined,
          )
          const panelSelection = await api.pickDataRoot()
          if (!panelSelection) throw new Error('取消后无法重新选择')
          await api.recoverDataRoot({ action: 'cancel-selection', selectionId: panelSelection.selectionId })
          await api.recoverDataRoot({ action: 'relocate', selectedRoot: panelSelection.targetRoot, selectionId: panelSelection.selectionId, initializeEmpty: true }).then(
            () => { throw new Error('面板取消后旧授权仍可提交') },
            () => undefined,
          )
          const confirmedSelection = await api.pickDataRoot()
          if (!confirmedSelection || confirmedSelection.kind !== 'empty') throw new Error('重新选择未获得空目录授权')
          await api.recoverDataRoot({ action: 'relocate', selectedRoot: confirmedSelection.targetRoot, selectionId: confirmedSelection.selectionId, initializeEmpty: true })
          const afterRecovery = await api.getPathManagementState()
          if (afterRecovery.activeRoot !== confirmedSelection.targetRoot || afterRecovery.previousRoot !== beforeUnconfirmed.activeRoot) {
            throw new Error('恢复后 activeRoot/previousRoot 不符合预期: ' + JSON.stringify(afterRecovery))
          }
          return { selection: confirmedSelection, afterRecovery }
        })()`)
        assert.equal(recoveryResult.selection.targetRoot, recoveryTargetRoot)
        assert.equal(process.env.PROMA_RECOVERY_RELAUNCH_INTERCEPTED, '1')
        recoverySmokeComplete = true
        console.log('[first startup smoke] recovery IPC PASS')
        finish()
      } catch (error) { finish(error) }
    })
  })
  require(path.join(applicationRoot, 'dist', 'main.cjs'))
}

if (process.versions.electron) runElectronClient()
else runSmoke().catch((error) => { console.error('[first startup smoke] FAIL', error); process.exitCode = 1 })
