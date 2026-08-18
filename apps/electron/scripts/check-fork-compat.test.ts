import { describe, expect, test } from 'bun:test'
import {
  FORK_COMPAT_CHECK_IDS,
  checkForkCompatibility,
  createMemoryRepositoryReader,
  runForkCompatCli,
} from './check-fork-compat'

/** checker 测试使用的最小完整仓库文件集合。 */
const validFiles: Record<string, string> = {
  'apps/electron/src/main/index.ts': `
    import { registerBridge, startAllBridges } from './lib/bridge-registry'
    import { lanBridgeRegistration } from './lib/lan-bridge/lan-bridge'
    registerBridge(lanBridgeRegistration)
    await startAllBridges()
  `,
  'apps/electron/src/main/lib/lan-bridge/lan-bridge.ts': `
    export const lanBridgeRegistration = {
      name: 'LAN Bridge',
      shouldAutoStart: () => getConfig().enabled,
      start: () => {
        const { agentEventBus } = require('../agent-service')
        return startLanBridge(agentEventBus)
      },
      stop: stopLanBridge,
    }
  `,
  'apps/electron/src/main/ipc.ts': `
    import { registerLanBridgeIpcHandlers } from './lib/lan-bridge/lan-bridge-ipc'
    export function registerIpcHandlers(): void {
      registerLanBridgeIpcHandlers(ipcMain)
    }
  `,
  'apps/electron/src/main/lib/lan-bridge/lan-bridge-ipc.ts': `
    import { LAN_BRIDGE_IPC_CHANNELS } from '@proma/shared'
    export interface LanBridgeIpcRegistrar { handle: (channel: string, handler: Function) => void }
    export function registerLanBridgeIpcHandlers(ipc: LanBridgeIpcRegistrar): void {
      ipc.handle(LAN_BRIDGE_IPC_CHANNELS.GET_CONFIG, async () => getConfig())
      ipc.handle(LAN_BRIDGE_IPC_CHANNELS.UPDATE_CONFIG, async () => updateConfig())
      ipc.handle(LAN_BRIDGE_IPC_CHANNELS.GET_STATUS, async () => getStatus())
      ipc.handle(LAN_BRIDGE_IPC_CHANNELS.START, async () => start())
      ipc.handle(LAN_BRIDGE_IPC_CHANNELS.STOP, async () => stop())
      ipc.handle(LAN_BRIDGE_IPC_CHANNELS.GET_PIN, async () => getPin())
      ipc.handle(LAN_BRIDGE_IPC_CHANNELS.REFRESH_PIN, async () => refreshPin())
      ipc.handle(LAN_BRIDGE_IPC_CHANNELS.GET_PAIRING_QR, async () => getPairingQr())
      ipc.handle(LAN_BRIDGE_IPC_CHANNELS.LIST_DEVICES, async () => listDevices())
      ipc.handle(LAN_BRIDGE_IPC_CHANNELS.REVOKE_DEVICE, async () => revokeDevice())
    }
  `,
  'apps/electron/src/preload/index.ts': `
    import { createLanBridgePreloadApi } from './lan-bridge-preload'
    import type { LanBridgePreloadApi } from './lan-bridge-preload'
    export interface ElectronAPI extends LanBridgePreloadApi {}
    const electronAPI: ElectronAPI = { ...createLanBridgePreloadApi(ipcRenderer) }
    contextBridge.exposeInMainWorld('electronAPI', electronAPI)
  `,
  'apps/electron/src/preload/lan-bridge-preload.ts': `
    import { LAN_BRIDGE_IPC_CHANNELS } from '@proma/shared'
    export interface LanBridgePreloadApi {
      getLanBridgeConfig: Function
      updateLanBridgeConfig: Function
      getLanBridgeStatus: Function
      startLanBridge: Function
      stopLanBridge: Function
      getLanBridgePin: Function
      refreshLanBridgePin: Function
      getLanBridgePairingQr: Function
      listLanBridgeDevices: Function
      revokeLanBridgeDevice: Function
      onLanBridgeStatusChanged: Function
    }
    export function createLanBridgePreloadApi(ipc: object): LanBridgePreloadApi {
      return {
        getLanBridgeConfig: () => ipc.invoke(LAN_BRIDGE_IPC_CHANNELS.GET_CONFIG),
        updateLanBridgeConfig: () => ipc.invoke(LAN_BRIDGE_IPC_CHANNELS.UPDATE_CONFIG),
        getLanBridgeStatus: () => ipc.invoke(LAN_BRIDGE_IPC_CHANNELS.GET_STATUS),
        startLanBridge: () => ipc.invoke(LAN_BRIDGE_IPC_CHANNELS.START),
        stopLanBridge: () => ipc.invoke(LAN_BRIDGE_IPC_CHANNELS.STOP),
        getLanBridgePin: () => ipc.invoke(LAN_BRIDGE_IPC_CHANNELS.GET_PIN),
        refreshLanBridgePin: () => ipc.invoke(LAN_BRIDGE_IPC_CHANNELS.REFRESH_PIN),
        getLanBridgePairingQr: () => ipc.invoke(LAN_BRIDGE_IPC_CHANNELS.GET_PAIRING_QR),
        listLanBridgeDevices: () => ipc.invoke(LAN_BRIDGE_IPC_CHANNELS.LIST_DEVICES),
        revokeLanBridgeDevice: () => ipc.invoke(LAN_BRIDGE_IPC_CHANNELS.REVOKE_DEVICE),
        onLanBridgeStatusChanged: () => ipc.on(LAN_BRIDGE_IPC_CHANNELS.STATUS_CHANGED),
      }
    }
  `,
  'packages/shared/src/types/lan-bridge.ts': `
    export const LAN_BRIDGE_PROTOCOL_VERSION = 2
    export const LAN_BRIDGE_CAPABILITIES = [
      'pin-pairing', 'pairing-ticket', 'device-revocation', 'streaming', 'connection-recovery',
    ] as const
    export const LAN_BRIDGE_WS_CAPABILITIES = [
      'pin-pairing', 'pairing-ticket', 'streaming', 'connection-recovery',
    ] as const satisfies readonly LanBridgeCapability[]
    export const LAN_BRIDGE_IPC_CHANNELS = {
      GET_CONFIG: 'lan-bridge:get-config',
      UPDATE_CONFIG: 'lan-bridge:update-config',
      GET_STATUS: 'lan-bridge:get-status',
      START: 'lan-bridge:start',
      STOP: 'lan-bridge:stop',
      GET_PIN: 'lan-bridge:get-pin',
      REFRESH_PIN: 'lan-bridge:refresh-pin',
      GET_PAIRING_QR: 'lan-bridge:get-pairing-qr',
      LIST_DEVICES: 'lan-bridge:list-devices',
      REVOKE_DEVICE: 'lan-bridge:revoke-device',
      STATUS_CHANGED: 'lan-bridge:status-changed',
    } as const
  `,
  'apps/electron/src/main/lib/lan-bridge/lan-bridge-handlers.ts': `
    import { LAN_BRIDGE_PROTOCOL_VERSION, LAN_BRIDGE_WS_CAPABILITIES } from '@proma/shared'
    import type { LanBridgePromaAdapter } from './lan-bridge-proma-adapter-core'
    export function createLanBridgeConnectedPayload() {
      return { protocolVersion: LAN_BRIDGE_PROTOCOL_VERSION, capabilities: [...LAN_BRIDGE_WS_CAPABILITIES] }
    }
  `,
  'apps/electron/src/main/lib/lan-bridge/lan-bridge-message-handler.ts': `
    import type { ClientConnection } from './lan-bridge-types'
    export function createLanBridgeMessageHandler() {}
  `,
  'apps/electron/src/main/lib/lan-bridge/lan-bridge-proma-adapter.ts': `
    import { listConversations } from '../conversation-manager'
    import { listAgentSessions } from '../agent-session-manager'
    import { listAgentWorkspaces } from '../agent-workspace-manager'
    import { runAgentHeadless } from '../agent-service'
    import { getSettings } from '../settings-service'
    import { listChannels } from '../channel-manager'
    import { sendMessage } from '../chat-service'
    import { createLanBridgePromaAdapter } from './lan-bridge-proma-adapter-core'
    export const lanBridgePromaAdapter = createLanBridgePromaAdapter({})
  `,
  'apps/electron/src/main/lib/lan-bridge/lan-bridge-proma-adapter-core.ts': `
    export interface LanBridgePromaAdapter {}
    export function createLanBridgePromaAdapter() { return {} }
  `,
  'apps/electron/package.json': JSON.stringify({
    scripts: {
      'build:mobile': "bun run --filter='@proma/mobile' build",
      'package:prepare': 'bun run build && bun run build:mobile && bun run sync:runtime-deps',
    },
  }),
  'apps/mobile/package.json': JSON.stringify({ name: '@proma/mobile', scripts: { build: 'vite build' } }),
  'apps/electron/electron-builder.yml': `
    extraResources:
      - from: ../../apps/mobile/dist
        to: mobile-dist
        filter:
          - "**/*"
  `,
}

/** 执行内存 fixture 并返回全部兼容检查结果。 */
function runFixture(files: Record<string, string>) {
  return checkForkCompatibility(createMemoryRepositoryReader(files))
}

/** 返回指定检查项，缺失时让测试立即给出明确错误。 */
function getCheck(files: Record<string, string>, id: string) {
  const result = runFixture(files).find((item) => item.id === id)
  expect(result).toBeDefined()
  return result!
}

describe('fork 上游兼容检查器', () => {
  test('Given 全部稳定接缝存在 When 执行检查 Then 所有检查成功', () => {
    /** 完整 fixture 的检查结果。 */
    const results = runFixture(validFiles)

    expect(results.map((item) => item.id)).toEqual(FORK_COMPAT_CHECK_IDS)
    expect(results.every((item) => item.passed)).toBe(true)
  })

  /** 每个用例移除一种稳定接缝，锁定失败项及可执行修复提示。 */
  const missingSeamCases: Array<{
    name: string
    id: string
    path: string
    mutate: (content: string) => string
  }> = [
    {
      name: 'Bridge 注册与启动组合点',
      id: 'bridge-composition',
      path: 'apps/electron/src/main/index.ts',
      mutate: (content) => content.replace('registerBridge(lanBridgeRegistration)', ''),
    },
    {
      name: '独立 LAN IPC registrar',
      id: 'ipc-composition',
      path: 'apps/electron/src/main/ipc.ts',
      mutate: (content) => content.replace('registerLanBridgeIpcHandlers(ipcMain)', ''),
    },
    {
      name: '根 preload 唯一组合点',
      id: 'preload-composition',
      path: 'apps/electron/src/preload/index.ts',
      mutate: (content) => content.replace('...createLanBridgePreloadApi(ipcRenderer)', ''),
    },
    {
      name: '协议版本和 WS capabilities',
      id: 'protocol-capabilities',
      path: 'packages/shared/src/types/lan-bridge.ts',
      mutate: (content) => content.replace(
        "export const LAN_BRIDGE_WS_CAPABILITIES = [\n      'pin-pairing', 'pairing-ticket', 'streaming',",
        "export const LAN_BRIDGE_WS_CAPABILITIES = [\n      'pin-pairing', 'pairing-ticket', 'streaming', 'device-revocation',",
      ),
    },
    {
      name: 'Proma Adapter 官方运行时边界',
      id: 'adapter-boundary',
      path: 'apps/electron/src/main/lib/lan-bridge/lan-bridge-handlers.ts',
      mutate: (content) => `${content}\nimport { getSettings } from '../settings-service'`,
    },
    {
      name: '移动端 build 与 package prepare',
      id: 'mobile-build',
      path: 'apps/electron/package.json',
      mutate: (content) => content.replace('bun run build:mobile && ', ''),
    },
    {
      name: 'mobile-dist 打包资源',
      id: 'mobile-resource',
      path: 'apps/electron/electron-builder.yml',
      mutate: (content) => content.replace('to: mobile-dist', 'to: ignored-mobile'),
    },
    {
      name: '十个 LAN IPC 命令和设备管理方法',
      id: 'lan-ipc-contract',
      path: 'apps/electron/src/preload/lan-bridge-preload.ts',
      mutate: (content) => content.replace('revokeLanBridgeDevice: Function', 'removedDeviceMethod: Function'),
    },
  ]

  for (const seam of missingSeamCases) {
    test(`Given 缺少${seam.name} When 执行检查 Then 返回精确失败`, () => {
      /** 为当前用例复制并破坏单一接缝。 */
      const files = { ...validFiles, [seam.path]: seam.mutate(validFiles[seam.path]!) }
      /** 当前接缝对应的检查结果。 */
      const result = getCheck(files, seam.id)

      expect(result.passed).toBe(false)
      expect(result.files).toContain(seam.path)
      expect(result.hint.length).toBeGreaterThan(10)
      expect(result.details.length).toBeGreaterThan(0)
    })
  }

  test('Given 必需文件不存在 When 执行检查 Then 明确报告文件路径', () => {
    /** 模拟上游合并删除独立 IPC registrar。 */
    const files = { ...validFiles }
    delete files['apps/electron/src/main/lib/lan-bridge/lan-bridge-ipc.ts']

    /** IPC 接缝检查结果。 */
    const result = getCheck(files, 'ipc-composition')
    expect(result.passed).toBe(false)
    expect(result.details.join('\n')).toContain('apps/electron/src/main/lib/lan-bridge/lan-bridge-ipc.ts')
  })

  test('Given 任一接缝失败 When 运行 CLI Then 输出修复信息并返回非零退出码', () => {
    /** 模拟被上游合并删除的 Bridge 注册调用。 */
    const files = {
      ...validFiles,
      'apps/electron/src/main/index.ts': validFiles['apps/electron/src/main/index.ts']!
        .replace('registerBridge(lanBridgeRegistration)', ''),
    }
    /** 捕获 CLI 标准输出和错误输出。 */
    const lines: string[] = []
    /** CLI 执行后的进程退出码。 */
    const exitCode = runForkCompatCli(createMemoryRepositoryReader(files), {
      log: (message) => lines.push(message),
      error: (message) => lines.push(message),
    })

    expect(exitCode).toBe(1)
    expect(lines.join('\n')).toContain('[FAIL] Bridge 生命周期组合点')
    expect(lines.join('\n')).toContain('apps/electron/src/main/index.ts')
    expect(lines.join('\n')).toContain('修复：')
  })
})
