import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type {
  CanvasWebviewDevicePreset,
  CanvasWebviewPreviewSnapshot,
  CanvasWebviewPreviewTarget,
} from '@proma/shared'

/** WebView 预览截图的固定设备视口。 */
export interface CanvasWebviewViewport {
  width: number
  height: number
}

/** 单次离屏渲染需要的完整安全输入。 */
export interface CanvasWebviewPreviewRenderInput {
  target: CanvasWebviewPreviewTarget
  html: string
  viewport: CanvasWebviewViewport
}

/** 预览服务的可替换 I/O 与 Electron 渲染边界。 */
export interface CanvasWebviewPreviewServiceDependencies {
  resolveCachePath?: (target: CanvasWebviewPreviewTarget) => string
  readCache?: (cachePath: string) => Promise<Buffer | null>
  writeCacheAtomic?: (cachePath: string, content: Buffer) => Promise<void>
  render: (input: CanvasWebviewPreviewRenderInput) => Promise<Buffer>
  registerPreview: (cachePath: string, content: Buffer) => string
  revokePreview?: (previewUrl: string) => void
}

/** WebView 静态预览服务的公开能力。 */
export interface CanvasWebviewPreviewService {
  load: (
    target: CanvasWebviewPreviewTarget,
    html: string,
  ) => Promise<CanvasWebviewPreviewSnapshot>
  dispose: () => void
}

/** 根据设备预设返回截图视口。 */
export function resolveCanvasWebviewViewport(
  devicePreset: CanvasWebviewDevicePreset,
): CanvasWebviewViewport {
  return devicePreset === 'mobile'
    ? { width: 390, height: 844 }
    : { width: 1440, height: 900 }
}

/** 使用完整节点身份生成不含用户明文的稳定缓存键。 */
function createPreviewCacheKey(target: CanvasWebviewPreviewTarget): string {
  return createHash('sha256').update(JSON.stringify(target)).digest('hex')
}

/** 默认按普通文件读取缓存，缺失时返回 null。 */
async function readPreviewCache(cachePath: string): Promise<Buffer | null> {
  try {
    return await readFile(cachePath)
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

/** 通过同目录临时文件原子替换 WebP 缓存。 */
async function writePreviewCacheAtomic(cachePath: string, content: Buffer): Promise<void> {
  await mkdir(dirname(cachePath), { recursive: true, mode: 0o700 })
  /** 随机临时名避免并发进程写入同一 staging 文件。 */
  const temporaryPath = `${cachePath}.${randomUUID()}.tmp`
  try {
    await writeFile(temporaryPath, content, { mode: 0o600, flag: 'wx' })
    await rename(temporaryPath, cachePath)
  } finally {
    try { await unlink(temporaryPath) } catch { /* rename 成功或文件未创建时无需处理。 */ }
  }
}

/**
 * 创建带在途合并、内存命中和全局串行截图的预览服务。
 * @param dependencies 缓存、渲染与受控 URL 注册依赖。
 * @returns 可按完整目标加载静态预览并统一释放 URL 的服务。
 */
export function createCanvasWebviewPreviewService(
  dependencies: CanvasWebviewPreviewServiceDependencies,
): CanvasWebviewPreviewService {
  /** 已完成目标的内存快照，避免重复注册受控 URL。 */
  const snapshots = new Map<string, CanvasWebviewPreviewSnapshot>()
  /** 相同目标共享同一个 Promise，避免可见区重挂重复截图。 */
  const inFlight = new Map<string, Promise<CanvasWebviewPreviewSnapshot>>()
  /** 所有实际渲染依次链接到同一队尾，峰值离屏窗口任务固定为一。 */
  let renderQueue: Promise<void> = Promise.resolve()

  /** 把单次渲染排入串行队列，并在失败后继续放行后续任务。 */
  const enqueueRender = <T>(run: () => Promise<T>): Promise<T> => {
    const result = renderQueue.then(run, run)
    renderQueue = result.then(() => undefined, () => undefined)
    return result
  }

  /** 为目标创建或读取缓存并返回公开快照。 */
  const load = (
    target: CanvasWebviewPreviewTarget,
    html: string,
  ): Promise<CanvasWebviewPreviewSnapshot> => {
    const cacheKey = createPreviewCacheKey(target)
    const completed = snapshots.get(cacheKey)
    if (completed) return Promise.resolve(completed)
    const pending = inFlight.get(cacheKey)
    if (pending) return pending
    const cachePath = dependencies.resolveCachePath?.(target) ?? `${cacheKey}.webp`
    const viewport = resolveCanvasWebviewViewport(target.devicePreset)
    const request = (async (): Promise<CanvasWebviewPreviewSnapshot> => {
      const cached = await (dependencies.readCache ?? readPreviewCache)(cachePath)
      const content = cached ?? await enqueueRender(() => dependencies.render({
        target: { ...target },
        html,
        viewport,
      }))
      if (!cached) {
        await (dependencies.writeCacheAtomic ?? writePreviewCacheAtomic)(cachePath, content)
      }
      const snapshot: CanvasWebviewPreviewSnapshot = {
        target: { ...target },
        previewUrl: dependencies.registerPreview(cachePath, content),
        width: viewport.width,
        height: viewport.height,
      }
      snapshots.set(cacheKey, snapshot)
      return snapshot
    })().finally(() => {
      inFlight.delete(cacheKey)
    })
    inFlight.set(cacheKey, request)
    return request
  }

  return {
    load,
    dispose: () => {
      for (const snapshot of snapshots.values()) {
        dependencies.revokePreview?.(snapshot.previewUrl)
      }
      snapshots.clear()
      inFlight.clear()
    },
  }
}

/** Canvas WebView 页面前置的离线 CSP，保留本地交互但阻断网络和导航。 */
const CANVAS_WEBVIEW_PREVIEW_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline' blob:",
  "style-src 'unsafe-inline'",
  'img-src data: blob:',
  'font-src data:',
  'media-src data: blob:',
  "connect-src 'none'",
  "frame-src 'none'",
  "child-src 'none'",
  "object-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
  "navigate-to 'none'",
].join('; ')

/** 在任何 Agent HTML 字节前注入 CSP，供离屏窗口安全加载。 */
export function createSandboxedCanvasWebviewPreviewHtml(html: string): string {
  const meta = `<meta http-equiv="Content-Security-Policy" content="${CANVAS_WEBVIEW_PREVIEW_CSP}">`
  return `<!doctype html>${meta}${html}`
}

/** 生产 Electron 离屏渲染器的窄窗口能力。 */
export interface CanvasWebviewOffscreenRenderer {
  render: (input: CanvasWebviewPreviewRenderInput) => Promise<Buffer>
  dispose: () => void
}

/** 创建单 BrowserWindow 的 Electron 离屏 WebP 渲染器。 */
export async function createElectronCanvasWebviewOffscreenRenderer(): Promise<CanvasWebviewOffscreenRenderer> {
  const [{ BrowserWindow, session }, { default: sharp }] = await Promise.all([
    import('electron'),
    import('sharp'),
  ])
  /** 独立内存 partition 避免继承主窗口 Cookie、缓存与网络权限。 */
  const previewSession = session.fromPartition('canvas-webview-preview')
  previewSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
  previewSession.webRequest.onBeforeRequest((details, callback) => {
    let protocol = ''
    try { protocol = new URL(details.url).protocol } catch { callback({ cancel: true }); return }
    callback({ cancel: protocol !== 'data:' && protocol !== 'about:' && protocol !== 'blob:' })
  })
  /** 全局唯一窗口由服务串行队列复用。 */
  const window = new BrowserWindow({
    width: 1440,
    height: 900,
    show: false,
    skipTaskbar: true,
    webPreferences: {
      partition: 'canvas-webview-preview',
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      offscreen: true,
    },
  })
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', (event) => event.preventDefault())
  window.webContents.on('will-frame-navigate', (event) => {
    if (event.url !== 'about:blank' && !event.url.startsWith('data:')) event.preventDefault()
  })

  return {
    render: async ({ html, viewport }) => {
      window.setSize(viewport.width, viewport.height)
      const safeHtml = createSandboxedCanvasWebviewPreviewHtml(html)
      await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(safeHtml)}`)
      await new Promise<void>((resolve) => setTimeout(resolve, 80))
      const image = await window.webContents.capturePage({
        x: 0, y: 0, width: viewport.width, height: viewport.height,
      })
      return sharp(image.toPNG()).webp({ quality: 82 }).toBuffer()
    },
    dispose: () => {
      if (!window.isDestroyed()) window.destroy()
    },
  }
}

/** 为生产缓存目录构造只包含哈希的安全 WebP 路径。 */
export function resolveCanvasWebviewPreviewCachePath(
  thumbnailsDir: string,
  target: CanvasWebviewPreviewTarget,
): string {
  return join(thumbnailsDir, `webview-${createPreviewCacheKey(target)}.webp`)
}
