/**
 * LAN Bridge — WS Server 主入口
 *
 * 在 Electron 主进程中内嵌 WebSocket Server，
 * 作为新的 BridgeRegistration 接入统一生命周期管理。
 */

import { createServer, type IncomingMessage, type Server } from 'node:http'
import { readFileSync, existsSync } from 'node:fs'
import { join, extname, normalize } from 'node:path'
import { networkInterfaces } from 'node:os'
import { app } from 'electron'
import { WebSocketServer, type WebSocket } from 'ws'
import { getLanBridgeConfig, updateLanBridgeConfig } from './lan-bridge-config'
import {
  getCurrentPin,
  getLanBridgeAuthService,
  initAuth,
  refreshPin,
  removeLegacyPinFile,
} from './lan-bridge-auth'
import type { PairingTicket } from './lan-bridge-auth'
import type { LanBridgeDevice } from './lan-bridge-device-store'
import { getConfigDir } from '../config-paths'
import { LanBridgeSessionManager } from './lan-bridge-session'
import { dispatch } from './lan-bridge-router'
import type { LanBridgeConfig, LanBridgeRuntimeState } from '@proma/shared'
import {
  isLanBridgeWebSocketClientIp,
  isRfc1918Ipv4,
  LAN_BRIDGE_IPC_CHANNELS,
  selectRfc1918Ipv4,
} from '@proma/shared'

import {
  createLanBridgeConnectedPayload,
  registerLanBridgeHandlers,
} from './lan-bridge-handlers'
import { lanBridgePromaAdapter } from './lan-bridge-proma-adapter'
import { startSubscription, stopSubscription } from './lan-bridge-subscription'
import type { AgentEventBus } from '../agent-event-bus'
import { createLanBridgeRecoveryController } from './lan-bridge-recovery'
import { createLanBridgeMessageHandler } from './lan-bridge-message-handler'
import { executeLanBridgeDeviceRevocation } from './lan-bridge-device-revocation'

// ===== 单例状态 =====

let httpServer: Server | null = null
let eventBus: AgentEventBus | null = null
let wss: WebSocketServer | null = null
let sessionManager: LanBridgeSessionManager | null = null
let status: LanBridgeRuntimeState['status'] = 'stopped'
let errorMessage: string | undefined

/** 组合根首次加载时固定的生产认证服务，Bridge restart 继续复用。 */
const lanBridgeAuthService = getLanBridgeAuthService()

registerLanBridgeHandlers({
  authService: lanBridgeAuthService,
  promaAdapter: lanBridgePromaAdapter,
  getSessionManager: () => sessionManager,
})

const recoveryController = createLanBridgeRecoveryController({
  isEnabled: () => getLanBridgeConfig().enabled,
  getStatus: () => status,
  getActiveEventBus: () => eventBus,
  stop: stopLanBridge,
  start: startLanBridge,
})

// ===== 公开 API =====

/** 启动 LAN Bridge WS Server */
export async function startLanBridge(bus?: AgentEventBus): Promise<void> {
  recoveryController.rememberEventBus(bus)
  const config = getLanBridgeConfig()
  if (status === 'running') return

  status = 'starting'
  errorMessage = undefined

  try {
    initAuth()
    removeLegacyPinFile(getConfigDir())

    sessionManager = new LanBridgeSessionManager(config.maxConnections)
    const handleMessage = createLanBridgeMessageHandler({
      sessionManager,
      now: Date.now,
      dispatch,
    })

    // 静态文件根目录:
    // 开发环境: apps/mobile/dist/（相对于 dist/main.cjs 上两级）
    // 打包环境: Resources/mobile-dist/（extraResources，通过 process.resourcesPath 定位）
    const mobileDistDir = app.isPackaged
      ? join(process.resourcesPath, 'mobile-dist')
      : join(__dirname, '..', '..', 'mobile', 'dist')
    const mimeTypes: Record<string, string> = {
      '.html': 'text/html; charset=utf-8', '.js': 'application/javascript',
      '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json',
      '.png': 'image/png', '.ico': 'image/x-icon',
    }

    httpServer = createServer((req: IncomingMessage, res: any) => {
      const url = req.url === '/' ? '/index.html' : (req.url ?? '/index.html')
      const filePath = join(mobileDistDir, url)

      // 防止路径遍历：确保解析后的路径在 mobileDistDir 内
      const safePath = normalize(filePath)
      if (!safePath.startsWith(mobileDistDir)) {
        res.writeHead(403, { 'Content-Type': 'text/plain' })
        res.end('Forbidden')
        return
      }

      if (existsSync(safePath)) {
        const ext = extname(safePath)
        const content = readFileSync(safePath)
        res.writeHead(200, { 'Content-Type': mimeTypes[ext] ?? 'application/octet-stream' })
        res.end(content)
      } else {
        // SPA fallback: 所有未知路径返回 index.html
        const indexHtml = join(mobileDistDir, 'index.html')
        if (existsSync(indexHtml)) {
          const html = readFileSync(indexHtml)
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
          res.end(html)
        } else {
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ service: 'proma-lan-bridge', status: 'ok' }))
        }
      }
    })

    wss = new WebSocketServer({ noServer: true })

    httpServer.on('upgrade', (req: IncomingMessage, socket: any, head: Buffer) => {
      if (req.url === '/ws') {
        const ip = extractIp(req)
        if (!isLanBridgeWebSocketClientIp(ip)) {
          socket.destroy()
          return
        }
        wss!.handleUpgrade(req, socket, head, (ws: WebSocket) => {
          wss!.emit('connection', ws, req)
        })
      } else {
        socket.destroy()
      }
    })

    wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
      const ip = extractIp(req)
      const client = sessionManager!.addClient(ws, ip)
      if (!client) return

      // 发送连接确认
      sessionManager!.send(client, {
        type: 'connected',
        data: createLanBridgeConnectedPayload(app.getVersion()),
      })

      ws.on('message', (raw: Buffer) => {
        handleMessage(client!, raw)
      })

      ws.on('close', () => {
        sessionManager?.removeClient(client!.id)
      })

      ws.on('error', () => {
        sessionManager?.removeClient(client!.id)
      })
    })

    await new Promise<void>((resolve, reject) => {
      httpServer!.listen(config.port, '0.0.0.0', () => {
        console.log(`[LAN Bridge] WS Server 已启动，端口: ${config.port}`)
        resolve()
      })
      httpServer!.on('error', reject)
    })

    sessionManager.startHeartbeat()

    // 启动 EventBus 订阅
    if (bus) {
      eventBus = bus
      startSubscription(bus)
    }

    status = 'running'
    notifyStatusChanged()
  } catch (err) {
    status = 'error'
    errorMessage = err instanceof Error ? err.message : String(err)
    console.error('[LAN Bridge] 启动失败:', errorMessage)
    cleanup()
    throw err
  }
}

/** 停止 LAN Bridge */
export function stopLanBridge(): void {
  if (status === 'stopped') return
  cleanup()
  status = 'stopped'
  errorMessage = undefined
  notifyStatusChanged()
  console.log('[LAN Bridge] 已停止')
}

/** 获取运行时状态 */
export function getLanBridgeStatus(): LanBridgeRuntimeState {
  const config = getLanBridgeConfig()
  return {
    status,
    pin: getCurrentPin(),
    port: config.port,
    localIp: getLocalIp(),
    connectedClients: sessionManager?.getClientInfos() ?? [],
    errorMessage,
  }
}

/** 刷新 PIN 码 */
export function refreshLanBridgePin(): string {
  return refreshPin()
}

/** 为 Task 7 二维码入口创建生产认证服务的一次性票据。 */
export function createLanBridgePairingTicket(now = Date.now()): PairingTicket {
  return lanBridgeAuthService.createPairingTicket(now)
}

/** 列出生产认证服务固定仓库中的设备。 */
export function listLanBridgeDevices(includeRevoked = false): LanBridgeDevice[] {
  return lanBridgeAuthService.listDevices(includeRevoked)
}

/**
 * 原子撤销设备，持久化成功后才断开该设备现有连接。
 *
 * @param deviceId 待撤销设备唯一标识
 * @param now 当前时间戳
 * @returns 撤销后的设备；不存在时返回 undefined
 */
export function revokeLanBridgeDevice(deviceId: string, now = Date.now()): LanBridgeDevice | undefined {
  return executeLanBridgeDeviceRevocation({
    revokeDevice: () => lanBridgeAuthService.revokeDevice(deviceId, now),
    disconnectDevice: () => sessionManager?.disconnectDevice(deviceId),
    notifyStatusChanged,
  })
}

/** 获取配置 */
export function getConfig(): LanBridgeConfig {
  return getLanBridgeConfig()
}

/** 更新配置（如果服务正在运行且端口变更，需要重启） */
export function updateConfig(updates: Partial<LanBridgeConfig>): LanBridgeConfig {
  const current = getLanBridgeConfig()
  const needsRestart = status === 'running' && updates.port !== undefined && updates.port !== current.port

  const updated = updateLanBridgeConfig(updates)

  if (needsRestart) {
    const restartEventBus = eventBus
    stopLanBridge()
    startLanBridge(restartEventBus ?? undefined).catch(console.error)
  }

  return updated
}

// ===== BridgeRegistration 接口 =====

/** 使用根组合点注入的 EventBus 创建 LAN Bridge 生命周期注册。 */
export function createLanBridgeRegistration(agentEventBus: AgentEventBus) {
  return {
    name: 'LAN Bridge',
    shouldAutoStart: () => getLanBridgeConfig().enabled,
    needsRecovery: recoveryController.needsRecovery,
    start: () => startLanBridge(agentEventBus),
    stop: stopLanBridge,
    recover: recoveryController.recover,
  }
}

/** 从 HTTP 请求中提取真实客户端 IP。仅当连接来自本地回环时才信任代理头。 */
function extractIp(req: IncomingMessage): string {
  const socketIp = req.socket.remoteAddress?.replace('::ffff:', '') ?? 'unknown'
  // 仅信任来自 localhost 的反向代理转发的 X-Forwarded-For
  if (socketIp === '127.0.0.1' || socketIp === '::1') {
    const xForwarded = req.headers['x-forwarded-for']
    if (typeof xForwarded === 'string') {
      const clientIp = xForwarded.split(',')[0]!.trim()
      if (clientIp) return clientIp
    }
  }
  return socketIp
}

function getLocalIp(): string {
  const interfaces = networkInterfaces()
  const candidates: string[] = []
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name] ?? []) {
      if (iface.family === 'IPv4' && !iface.internal) {
        candidates.push(iface.address)
      }
    }
  }
  // 优先返回 192.168.x.x（家庭/办公 WiFi），其次 10.x / 172.16-31.x
  const wifi = candidates.find(ip => ip.startsWith('192.168.') && isRfc1918Ipv4(ip))
  if (wifi) return wifi
  const rfc1918 = selectRfc1918Ipv4(candidates)
  if (rfc1918) return rfc1918
  return '127.0.0.1'
}

function cleanup(): void {
  stopSubscription()
  eventBus = null
  sessionManager?.closeAll()
  sessionManager = null

  wss?.close()
  wss = null

  if (httpServer) {
    httpServer.close()
    httpServer = null
  }
}

function notifyStatusChanged(): void {
  // 通过 IPC 推送状态变更给渲染进程
  try {
    const { BrowserWindow } = require('electron')
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send(LAN_BRIDGE_IPC_CHANNELS.STATUS_CHANGED, getLanBridgeStatus())
    }
  } catch {
    // 忽略
  }
}

// 导出 sessionManager 供 subscription 模块使用
export function getSessionManager(): LanBridgeSessionManager | null {
  return sessionManager
}
