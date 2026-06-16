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
import { initAuth, refreshPin, getCurrentPin } from './lan-bridge-auth'
import { LanBridgeSessionManager } from './lan-bridge-session'
import { dispatch } from './lan-bridge-router'
import type { ClientConnection } from './lan-bridge-types'
import type { LanBridgeConfig, LanBridgeRequest, LanBridgeRuntimeState } from '@proma/shared'
import { LAN_BRIDGE_IPC_CHANNELS } from '@proma/shared'

import './lan-bridge-handlers'
import { startSubscription, stopSubscription } from './lan-bridge-subscription'
import type { AgentEventBus } from '../agent-event-bus'

// ===== 单例状态 =====

let httpServer: Server | null = null
let eventBus: AgentEventBus | null = null
let wss: WebSocketServer | null = null
let sessionManager: LanBridgeSessionManager | null = null
let status: LanBridgeRuntimeState['status'] = 'stopped'
let errorMessage: string | undefined

// ===== 公开 API =====

/** 启动 LAN Bridge WS Server */
export async function startLanBridge(bus?: AgentEventBus): Promise<void> {
  const config = getLanBridgeConfig()
  if (status === 'running') return

  status = 'starting'
  errorMessage = undefined

  try {
    initAuth()

    sessionManager = new LanBridgeSessionManager(config.maxConnections)

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
        let content = readFileSync(safePath)
        // 注入当前 PIN 码到 HTML 页面，手机端免手动输入
        if (ext === '.html') {
          content = Buffer.from(content.toString('utf-8').replace('"__PROMO_PIN__"', JSON.stringify(getCurrentPin())))
        }
        res.writeHead(200, { 'Content-Type': mimeTypes[ext] ?? 'application/octet-stream' })
        res.end(content)
      } else {
        // SPA fallback: 所有未知路径返回 index.html
        const indexHtml = join(mobileDistDir, 'index.html')
        if (existsSync(indexHtml)) {
          const html = readFileSync(indexHtml).toString('utf-8').replace('"__PROMO_PIN__"', JSON.stringify(getCurrentPin()))
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
        if (!isPrivateIp(ip)) {
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
      sessionManager!.send(client, { type: 'connected', data: { message: 'Proma LAN Bridge' } })

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
    stopLanBridge()
    startLanBridge().catch(console.error)
  }

  return updated
}

// ===== BridgeRegistration 接口 =====

export const lanBridgeRegistration = {
  name: 'LAN Bridge',
  shouldAutoStart: () => getLanBridgeConfig().enabled,
  start: () => {
    // 动态导入避免循环依赖
    const { agentEventBus } = require('../agent-service') as { agentEventBus: import('../agent-event-bus').AgentEventBus }
    return startLanBridge(agentEventBus)
  },
  stop: stopLanBridge,
}

// ===== 内部工具 =====

function handleMessage(client: ClientConnection, raw: Buffer): void {
  client.lastActivity = Date.now()
  client.alive = true

  if (!sessionManager!.checkRateLimit(client)) {
    sessionManager!.send(client, {
      type: 'error',
      ok: false,
      error: 'Rate limited',
      errorCode: 'RATE_LIMITED',
    })
    return
  }

  let parsed: LanBridgeRequest
  try {
    parsed = JSON.parse(raw.toString('utf-8'))
  } catch {
    sessionManager!.send(client, {
      type: 'error',
      ok: false,
      error: 'Invalid JSON',
      errorCode: 'VALIDATION_ERROR',
    })
    return
  }

  if (!parsed.type) return

  // 心跳 pong 响应
  if (parsed.type === 'pong') {
    return
  }

  dispatch(client, parsed.type, parsed.data ?? {}, parsed.id)
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
  const wifi = candidates.find(ip => ip.startsWith('192.168.'))
  if (wifi) return wifi
  const rfc1918 = candidates.find(ip => isPrivateIp(ip))
  if (rfc1918) return rfc1918
  return candidates[0] ?? '127.0.0.1'
}

/** 检查 IP 是否为 RFC 1918 私有地址或 localhost */
function isPrivateIp(ip: string): boolean {
  if (ip === '::1' || ip === '127.0.0.1' || ip === 'localhost') return true
  // 10.0.0.0/8
  if (ip.startsWith('10.')) return true
  // 172.16.0.0/12
  if (ip.startsWith('172.')) {
    const second = parseInt(ip.split('.')[1] ?? '0', 10)
    if (second >= 16 && second <= 31) return true
  }
  // 192.168.0.0/16
  if (ip.startsWith('192.168.')) return true
  return false
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
