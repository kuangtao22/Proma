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
    import { agentEventBus } from './lib/agent-service'
    import { createLanBridgeRegistration } from './lib/lan-bridge/lan-bridge'
    registerBridge(createLanBridgeRegistration(agentEventBus))
    await startAllBridges()
  `,
  'apps/electron/src/main/lib/lan-bridge/lan-bridge.ts': `
    import type { AgentEventBus } from '../agent-event-bus'
    export function createLanBridgeRegistration(agentEventBus: AgentEventBus) {
      return {
        name: 'LAN Bridge',
        shouldAutoStart: () => getConfig().enabled,
        start: () => startLanBridge(agentEventBus),
        stop: stopLanBridge,
      }
    }
  `,
  'apps/electron/src/main/ipc.ts': `
    import { agentEventBus } from './lib/agent-service'
    import { createLanBridgeIpcDependencies, registerLanBridgeIpcHandlers } from './lib/lan-bridge/lan-bridge-ipc'
    export function registerIpcHandlers(): void {
      registerLanBridgeIpcHandlers(ipcMain, createLanBridgeIpcDependencies(agentEventBus))
    }
  `,
  'apps/electron/src/main/lib/lan-bridge/lan-bridge-ipc.ts': `
    import { LAN_BRIDGE_IPC_CHANNELS } from '@proma/shared'
    import type { AgentEventBus } from '../agent-event-bus'
    export interface LanBridgeIpcRegistrar { handle: (channel: string, handler: Function) => void }
    export function createLanBridgeIpcDependencies(agentEventBus: AgentEventBus) {
      return { start: () => startLanBridge(agentEventBus) }
    }
    export function registerLanBridgeIpcHandlers(ipc: LanBridgeIpcRegistrar, dependencies: object): void {
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
    const lanBridgePreloadApi = createLanBridgePreloadApi(ipcRenderer)
    const electronAPI: ElectronAPI = { ...lanBridgePreloadApi }
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
  '.github/workflows/upstream-compat.yml': `
name: Upstream Compatibility
on: [workflow_dispatch]
jobs:
  verify:
    steps:
      - uses: oven-sh/setup-bun@v2
        with:
          bun-version: latest
      - name: Select latest official release tag
        run: |
          git tag --list 'upstream/v*' > "$RUNNER_TEMP/tags.txt"
          grep -E '^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$' "$RUNNER_TEMP/tags.txt"
          sort -V "$RUNNER_TEMP/tags.txt"
      - name: Merge upstream tag without committing
        run: git merge --no-commit --no-ff "$UPSTREAM_TAG_REF"
      - name: Check fork compatibility seams
        run: bun run --filter='@proma/electron' check:fork-compat
      - name: Abort merge and remove temporary branch
        if: always()
        run: |
          cleanup_failed=0
          git merge --abort || cleanup_failed=1
          git switch --detach "$BASE_SHA" || cleanup_failed=1
          git branch --delete --force "$TEMP_BRANCH" || cleanup_failed=1
          exit "$cleanup_failed"
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
      mutate: (content) => content.replace('registerBridge(createLanBridgeRegistration(agentEventBus))', ''),
    },
    {
      name: '独立 LAN IPC registrar',
      id: 'ipc-composition',
      path: 'apps/electron/src/main/ipc.ts',
      mutate: (content) => content.replace(
        'registerLanBridgeIpcHandlers(ipcMain, createLanBridgeIpcDependencies(agentEventBus))',
        '',
      ),
    },
    {
      name: '根 preload 唯一组合点',
      id: 'preload-composition',
      path: 'apps/electron/src/preload/index.ts',
      mutate: (content) => content.replace('...lanBridgePreloadApi', ''),
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
    {
      name: '上游兼容 workflow 结构',
      id: 'workflow-definition',
      path: '.github/workflows/upstream-compat.yml',
      mutate: (content) => content.replace('bun-version: latest', 'bun-version: 1.3.14'),
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
        .replace('registerBridge(createLanBridgeRegistration(agentEventBus))', ''),
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

  test('Given 官方服务仅作为 type-only import When 检查 Adapter 边界 Then 不判定运行时越界', () => {
    /** type-only import 不会生成运行时依赖。 */
    const files = {
      ...validFiles,
      'apps/electron/src/main/lib/lan-bridge/type-only.ts': `
        import type { AgentEventBus } from '../agent-service'
        export type { AgentSession } from '../agent-session-manager'
      `,
    }

    expect(getCheck(files, 'adapter-boundary').passed).toBe(true)
  })

  /** Bridge registration 的 start 仅允许真实绑定注入 EventBus 的函数形式。 */
  const validBridgeStartCases: Array<{ name: string; source: string }> = [
    {
      name: 'arrow property',
      source: `
        export function createLanBridgeRegistration(agentEventBus: AgentEventBus) {
          return { start: () => startLanBridge(agentEventBus) }
        }
      `,
    },
    {
      name: 'object method',
      source: `
        export function createLanBridgeRegistration(agentEventBus: AgentEventBus) {
          return { start() { return startLanBridge(agentEventBus) } }
        }
      `,
    },
    {
      name: 'shorthand property',
      source: `
        export function createLanBridgeRegistration(agentEventBus: AgentEventBus) {
          const start = () => startLanBridge(agentEventBus)
          return { start }
        }
      `,
    },
  ]

  for (const bridgeCase of validBridgeStartCases) {
    test(`Given ${bridgeCase.name} start 绑定注入 EventBus When 检查 Bridge Then 通过`, () => {
      /** 使用当前合法 start 表达形式替换 LAN Bridge factory。 */
      const files = {
        ...validFiles,
        'apps/electron/src/main/lib/lan-bridge/lan-bridge.ts': bridgeCase.source,
      }

      expect(getCheck(files, 'bridge-composition').passed).toBe(true)
    })
  }

  /** 无关位置或错误参数中的同名调用不能证明 start 行为正确。 */
  const invalidBridgeStartCases: Array<{ name: string; source: string }> = [
    {
      name: '调用藏在无关属性',
      source: `
        export function createLanBridgeRegistration(agentEventBus: AgentEventBus) {
          return {
            start: () => undefined,
            inspect: () => startLanBridge(agentEventBus),
          }
        }
      `,
    },
    {
      name: '调用藏在不可达函数',
      source: `
        export function createLanBridgeRegistration(agentEventBus: AgentEventBus) {
          function deadStart() { return startLanBridge(agentEventBus) }
          return { start: () => undefined }
        }
      `,
    },
    {
      name: 'start 使用错误参数',
      source: `
        export function createLanBridgeRegistration(agentEventBus: AgentEventBus) {
          return { start: () => startLanBridge(otherEventBus) }
        }
      `,
    },
  ]

  for (const bridgeCase of invalidBridgeStartCases) {
    test(`Given ${bridgeCase.name} When 检查 Bridge Then 明确失败`, () => {
      /** 使用不能证明 start 正确绑定的 factory 源码。 */
      const files = {
        ...validFiles,
        'apps/electron/src/main/lib/lan-bridge/lan-bridge.ts': bridgeCase.source,
      }

      expect(getCheck(files, 'bridge-composition').passed).toBe(false)
    })
  }

  /** 所有形式都应被 TypeScript AST 识别为官方服务运行时依赖。 */
  const runtimeBoundaryCases: Array<{ name: string; source: string }> = [
    { name: 'require', source: `const service = require('../agent-service')` },
    { name: 'dynamic import', source: `const service = import('../settings-service')` },
    { name: 'runtime re-export', source: `export { getSettings } from '../settings-service'` },
    { name: 'export star', source: `export * from '../chat-service'` },
  ]

  for (const boundaryCase of runtimeBoundaryCases) {
    test(`Given LAN 模块通过 ${boundaryCase.name} 访问官方服务 When 检查边界 Then 明确失败`, () => {
      /** 将当前运行时依赖形式放入 LAN 生产模块。 */
      const files = {
        ...validFiles,
        'apps/electron/src/main/lib/lan-bridge/runtime-leak.ts': boundaryCase.source,
      }

      /** Adapter 边界检查结果。 */
      const result = getCheck(files, 'adapter-boundary')
      expect(result.passed).toBe(false)
      expect(result.details.join('\n')).toContain('runtime-leak.ts')
    })
  }

  test('Given LAN 模块经本地 helper 传递依赖官方服务 When 检查边界 Then 报告 helper', () => {
    /** LAN 入口及其目录外本地 helper。 */
    const files = {
      ...validFiles,
      'apps/electron/src/main/lib/lan-bridge/transitive.ts': `import '../lan-runtime-helper'`,
      'apps/electron/src/main/lib/lan-runtime-helper.ts': `export * from './agent-service'`,
    }

    /** 传递依赖检查结果。 */
    const result = getCheck(files, 'adapter-boundary')
    expect(result.passed).toBe(false)
    expect(result.details.join('\n')).toContain('lan-runtime-helper.ts')
  })

  test('Given IPC 注册调用只存在于注释和死函数 When 检查组合点 Then 明确失败', () => {
    /** 不会执行的伪注册源码。 */
    const files = {
      ...validFiles,
      'apps/electron/src/main/ipc.ts': `
        import { registerLanBridgeIpcHandlers } from './lib/lan-bridge/lan-bridge-ipc'
        // registerLanBridgeIpcHandlers(ipcMain, dependencies)
        function deadRegistration() { registerLanBridgeIpcHandlers(ipcMain, dependencies) }
        export function registerIpcHandlers(): void {}
      `,
    }

    expect(getCheck(files, 'ipc-composition').passed).toBe(false)
  })

  test('Given registerIpcHandlers 真实重复注册 LAN registrar When 检查组合点 Then 明确失败', () => {
    /** 根注册函数重复执行相同 registrar。 */
    const files = {
      ...validFiles,
      'apps/electron/src/main/ipc.ts': validFiles['apps/electron/src/main/ipc.ts']!
        .replace(
          'registerLanBridgeIpcHandlers(ipcMain, createLanBridgeIpcDependencies(agentEventBus))',
          `registerLanBridgeIpcHandlers(ipcMain, createLanBridgeIpcDependencies(agentEventBus))
           registerLanBridgeIpcHandlers(ipcMain, createLanBridgeIpcDependencies(agentEventBus))`,
        ),
    }

    expect(getCheck(files, 'ipc-composition').passed).toBe(false)
  })

  test('Given 根 preload 仅在注释中出现 spread When 检查组合点 Then 明确失败', () => {
    /** 没有真实对象 spread 的 preload 源码。 */
    const files = {
      ...validFiles,
      'apps/electron/src/preload/index.ts': `
        import { createLanBridgePreloadApi } from './lan-bridge-preload'
        import type { LanBridgePreloadApi } from './lan-bridge-preload'
        export interface ElectronAPI extends LanBridgePreloadApi {}
        const lanBridgePreloadApi = createLanBridgePreloadApi(ipcRenderer)
        // const electronAPI = { ...lanBridgePreloadApi }
        const electronAPI: ElectronAPI = {}
        contextBridge.exposeInMainWorld('electronAPI', electronAPI)
      `,
    }

    expect(getCheck(files, 'preload-composition').passed).toBe(false)
  })

  test('Given LAN spread 只在死对象或在 electronAPI 重复 When 检查组合点 Then 均失败', () => {
    /** LAN spread 不在实际暴露对象上的源码。 */
    const deadSpreadFiles = {
      ...validFiles,
      'apps/electron/src/preload/index.ts': validFiles['apps/electron/src/preload/index.ts']!
        .replace(
          'const electronAPI: ElectronAPI = { ...lanBridgePreloadApi }',
          'const deadApi = { ...lanBridgePreloadApi }\nconst electronAPI: ElectronAPI = {}',
        ),
    }
    /** 实际暴露对象重复 spread 的源码。 */
    const duplicateSpreadFiles = {
      ...validFiles,
      'apps/electron/src/preload/index.ts': validFiles['apps/electron/src/preload/index.ts']!
        .replace('...lanBridgePreloadApi', '...lanBridgePreloadApi, ...lanBridgePreloadApi'),
    }

    expect(getCheck(deadSpreadFiles, 'preload-composition').passed).toBe(false)
    expect(getCheck(duplicateSpreadFiles, 'preload-composition').passed).toBe(false)
  })

  test('Given package prepare 用 echo 伪装命令 When 检查移动构建 Then 明确失败', () => {
    /** shell 只打印命令文本，不实际构建。 */
    const files = {
      ...validFiles,
      'apps/electron/package.json': JSON.stringify({
        scripts: {
          'build:mobile': "bun run --filter='@proma/mobile' build",
          'package:prepare': 'echo "bun run build && bun run build:mobile && bun run sync:runtime-deps"',
        },
      }),
    }

    expect(getCheck(files, 'mobile-build').passed).toBe(false)
  })

  test('Given package prepare 顺序错误 When 检查移动构建 Then 明确失败', () => {
    /** 三个真实命令存在但顺序违反打包契约。 */
    const files = {
      ...validFiles,
      'apps/electron/package.json': JSON.stringify({
        scripts: {
          'build:mobile': "bun run --filter='@proma/mobile' build",
          'package:prepare': 'bun run build:mobile && bun run build && bun run sync:runtime-deps',
        },
      }),
    }

    expect(getCheck(files, 'mobile-build').passed).toBe(false)
  })

  test('Given build:mobile filter 未加引号 When 检查移动构建 Then 与引号形式等价通过', () => {
    /** 使用 shell 合法的无引号 workspace filter。 */
    const files = {
      ...validFiles,
      'apps/electron/package.json': JSON.stringify({
        scripts: {
          'build:mobile': 'bun run --filter=@proma/mobile build',
          'package:prepare': 'bun run build && bun run build:mobile && bun run sync:runtime-deps',
        },
      }),
    }

    expect(getCheck(files, 'mobile-build').passed).toBe(true)
  })

  /** 两个打包脚本都必须拒绝无法保证执行目标命令的 shell 结构。 */
  const unsafeShellCases: Array<{ name: string; buildMobile: string; packagePrepare: string }> = [
    {
      name: 'build:mobile 用 echo 伪装',
      buildMobile: `echo "bun run --filter='@proma/mobile' build"`,
      packagePrepare: 'bun run build && bun run build:mobile && bun run sync:runtime-deps',
    },
    {
      name: 'build:mobile 前置 false',
      buildMobile: `false && bun run --filter='@proma/mobile' build`,
      packagePrepare: 'bun run build && bun run build:mobile && bun run sync:runtime-deps',
    },
    {
      name: 'build:mobile 使用变量伪装',
      buildMobile: 'bun run --filter=$MOBILE_WORKSPACE build',
      packagePrepare: 'bun run build && bun run build:mobile && bun run sync:runtime-deps',
    },
    {
      name: 'package:prepare 前置 false',
      buildMobile: 'bun run --filter=@proma/mobile build',
      packagePrepare: 'false && bun run build && bun run build:mobile && bun run sync:runtime-deps',
    },
    {
      name: 'package:prepare 使用 true 或短路',
      buildMobile: 'bun run --filter=@proma/mobile build',
      packagePrepare: 'true || bun run build && bun run build:mobile && bun run sync:runtime-deps',
    },
    {
      name: 'package:prepare 使用子 shell',
      buildMobile: 'bun run --filter=@proma/mobile build',
      packagePrepare: '(bun run build && bun run build:mobile) && bun run sync:runtime-deps',
    },
    {
      name: 'package:prepare 仅在引号文本出现命令',
      buildMobile: 'bun run --filter=@proma/mobile build',
      packagePrepare: 'echo "bun run build && bun run build:mobile && bun run sync:runtime-deps"',
    },
  ]

  for (const shellCase of unsafeShellCases) {
    test(`Given ${shellCase.name} When 检查移动构建 Then 明确失败`, () => {
      /** 注入当前不安全 shell 脚本组合。 */
      const files = {
        ...validFiles,
        'apps/electron/package.json': JSON.stringify({
          scripts: {
            'build:mobile': shellCase.buildMobile,
            'package:prepare': shellCase.packagePrepare,
          },
        }),
      }

      expect(getCheck(files, 'mobile-build').passed).toBe(false)
    })
  }

  test('Given mobile resource 位于 ignoredResources When 检查 builder 配置 Then 明确失败', () => {
    /** 结构相似但不属于顶层 extraResources 的 YAML。 */
    const files = {
      ...validFiles,
      'apps/electron/electron-builder.yml': `
ignoredResources:
  - from: ../../apps/mobile/dist
    to: mobile-dist
    filter:
      - "**/*"
      `,
    }

    expect(getCheck(files, 'mobile-resource').passed).toBe(false)
  })

  test('Given workflow 吞错或清理静默成功 When 检查定义 Then 明确失败', () => {
    /** 同时破坏 tag pipeline 与 cleanup 聚合。 */
    const files = {
      ...validFiles,
      '.github/workflows/upstream-compat.yml': validFiles['.github/workflows/upstream-compat.yml']!
        .replace('git tag --list', 'git tag --list || true #')
        .replace('exit "$cleanup_failed"', 'exit 0'),
    }

    expect(getCheck(files, 'workflow-definition').passed).toBe(false)
  })
})
