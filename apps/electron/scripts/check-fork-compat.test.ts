import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  FORK_COMPAT_CHECK_IDS,
  checkForkCompatibility,
  createFileSystemRepositoryReader,
  createMemoryRepositoryReader,
  runForkCompatCli,
} from './check-fork-compat'

/** 结构完整的最小上游兼容 workflow fixture。 */
const validWorkflow = `
name: Upstream Compatibility
on:
  workflow_dispatch:
  schedule:
    - cron: '17 3 * * 1'
permissions:
  contents: read
concurrency:
  group: upstream-compat-\${{ github.ref }}
  cancel-in-progress: true
jobs:
  verify-upstream-merge:
    timeout-minutes: 60
    steps:
      - name: Checkout fork with full history
        uses: actions/checkout@v4
        with:
          fetch-depth: 0
          fetch-tags: true
      - name: Install Bun
        uses: oven-sh/setup-bun@v2
        with:
          bun-version: latest
      - name: Select latest official release tag
        id: upstream
        run: |
          readonly UPSTREAM_URL='https://github.com/ErlichLiu/Proma.git'
          readonly RAW_TAGS_FILE="$RUNNER_TEMP/upstream-tags.txt"
          readonly RELEASE_TAGS_FILE="$RUNNER_TEMP/release-tags.txt"
          readonly SORTED_TAGS_FILE="$RUNNER_TEMP/release-tags.sorted.txt"
          git remote add upstream "$UPSTREAM_URL"
          git fetch --force upstream '+refs/tags/*:refs/tags/upstream/*'
          git tag --list 'upstream/v*' > "$RAW_TAGS_FILE"
          while IFS= read -r tag; do
            if [[ "$tag" =~ ^v(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)$ ]]; then
              printf '%s\\n' "$tag" >> "$RELEASE_TAGS_FILE"
            fi
          done < "$RAW_TAGS_FILE"
          sort -V "$RELEASE_TAGS_FILE" > "$SORTED_TAGS_FILE"
          readonly LATEST_TAG="$(tail -n 1 "$SORTED_TAGS_FILE")"
          echo "tag_ref=refs/tags/upstream/$LATEST_TAG" >> "$GITHUB_OUTPUT"
      - name: Merge upstream tag without committing
        run: |
          git switch --create "$TEMP_BRANCH" "$BASE_SHA"
          git merge --no-commit --no-ff "$UPSTREAM_TAG_REF"
      - name: Install dependencies from merged tree
        run: bun install --frozen-lockfile
      - name: Check fork compatibility seams
        run: bun run --filter='@proma/electron' check:fork-compat
      - name: Run LAN and mobile targeted tests
        run: bun test apps/electron/src/main/lib/lan-bridge apps/electron/src/preload/lan-bridge-preload.test.ts apps/mobile/src/lib
      - name: Build mobile app
        run: bun run --filter='@proma/mobile' build
      - name: Typecheck all workspaces
        run: bun run typecheck
      - name: Build Electron app
        run: bun run electron:build
      - name: Abort merge and remove temporary branch
        if: always()
        run: |
          cleanup_failed=0
          run_cleanup 'abort merge' git merge --abort
          run_cleanup 'switch to base' git switch --detach "$BASE_SHA"
          run_cleanup 'delete temporary branch' git branch --delete --force "$TEMP_BRANCH"
          exit "$cleanup_failed"
`

/** checker 测试使用的最小完整仓库文件集合。 */
const validFiles: Record<string, string> = {
  'apps/electron/src/main/index.ts': `
    import { registerBridge, startAllBridges } from './lib/bridge-registry'
    import { agentEventBus } from './lib/agent-service'
    import { createLanBridgeRegistration } from './lib/lan-bridge/lan-bridge'
    registerBridge(createLanBridgeRegistration(agentEventBus))
    app.whenReady().then(bootstrap).catch(handleBootstrapFailure)
    async function bootstrap(): Promise<void> {
      await safeAwait('startAllBridges', () => startAllBridges())
    }
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
  '.github/workflows/upstream-compat.yml': validWorkflow,
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
      mutate: (content) => content.replace(
        'revokeLanBridgeDevice: () => ipc.invoke(LAN_BRIDGE_IPC_CHANNELS.REVOKE_DEVICE),',
        'removedDeviceMethod: () => ipc.invoke(LAN_BRIDGE_IPC_CHANNELS.REVOKE_DEVICE),',
      ),
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

  test('Given type-only import/export 带模块后缀 When 检查 Adapter 边界 Then 仍允许', () => {
    /** 带扩展名的纯类型依赖不会生成运行时加载。 */
    const files = {
      ...validFiles,
      'apps/electron/src/main/lib/lan-bridge/type-only-extension.ts': `
        import type { AgentEventBus } from '../agent-service.js'
        export type { AgentSession } from '../agent-session-manager.ts'
      `,
    }

    expect(getCheck(files, 'adapter-boundary').passed).toBe(true)
  })

  /** 官方运行时模块的常见扩展名和加载语法必须统一命中。 */
  const suffixedRuntimeBoundaryCases: Array<{ name: string; source: string }> = [
    { name: 'static import .js', source: `import { runAgent } from '../agent-service.js'` },
    { name: 'runtime export .ts', source: `export { getSettings } from '../settings-service.ts'` },
    { name: 'dynamic import .mjs', source: `const channel = import('../channel-manager.mjs')` },
    { name: 'require .cjs', source: `const chat = require('../chat-service.cjs')` },
    { name: 'empty named import', source: `import {} from '../agent-service.js'` },
  ]

  for (const boundaryCase of suffixedRuntimeBoundaryCases) {
    test(`Given ${boundaryCase.name} 引用官方服务 When 检查 Adapter 边界 Then 明确失败`, () => {
      /** 将当前运行时加载形式放入 LAN 生产模块。 */
      const files = {
        ...validFiles,
        'apps/electron/src/main/lib/lan-bridge/suffixed-runtime-leak.ts': boundaryCase.source,
      }

      expect(getCheck(files, 'adapter-boundary').passed).toBe(false)
    })
  }

  /** 非字面量加载无法静态证明目标，LAN 生产代码必须保守拒绝。 */
  const nonLiteralRuntimeCases: Array<{ name: string; source: string }> = [
    { name: 'require identifier', source: `const target = '../agent-service'; require(target)` },
    { name: 'require concatenation', source: `require('../' + 'agent-service')` },
    { name: 'dynamic import identifier', source: `const target = '../chat-service'; import(target)` },
    { name: 'dynamic import concatenation', source: `import('../' + 'chat-service')` },
  ]

  for (const boundaryCase of nonLiteralRuntimeCases) {
    test(`Given ${boundaryCase.name} When 检查 Adapter 边界 Then 保守失败并提示改用字面量`, () => {
      /** 将无法静态解析的加载形式放入 LAN 生产模块。 */
      const files = {
        ...validFiles,
        'apps/electron/src/main/lib/lan-bridge/non-literal-runtime.ts': boundaryCase.source,
      }
      /** Adapter 边界检查结果。 */
      const result = getCheck(files, 'adapter-boundary')

      expect(result.passed).toBe(false)
      expect(result.details.join('\n')).toContain('非字面量')
      expect(result.details.join('\n')).toContain('静态字符串')
    })
  }

  test('Given 正确 LAN 注册之外追加 duplicateBus 注册 When 检查 Bridge Then 明确失败', () => {
    /** 第二次注册使用不同变量名，仍必须计入总数。 */
    const files = {
      ...validFiles,
      'apps/electron/src/main/index.ts': `${validFiles['apps/electron/src/main/index.ts']!}
        registerBridge(createLanBridgeRegistration(duplicateBus))
      `,
    }

    expect(getCheck(files, 'bridge-composition').passed).toBe(false)
  })

  /** LAN registration 必须是 Program 顶层可执行表达式。 */
  const unreachableRegistrationCases: Array<{ name: string; registration: string }> = [
    {
      name: '唯一注册位于未调用函数',
      registration: 'function registerLater() { registerBridge(createLanBridgeRegistration(agentEventBus)) }',
    },
    {
      name: '唯一注册位于 false 条件',
      registration: 'if (false) { registerBridge(createLanBridgeRegistration(agentEventBus)) }',
    },
    {
      name: '唯一注册位于 return 后',
      registration: 'function registerLater() { return; registerBridge(createLanBridgeRegistration(agentEventBus)) }',
    },
  ]

  for (const registrationCase of unreachableRegistrationCases) {
    test(`Given ${registrationCase.name} When 检查 Bridge 注册 Then 明确失败`, () => {
      /** 用不可达注册替换唯一顶层注册。 */
      const files = {
        ...validFiles,
        'apps/electron/src/main/index.ts': validFiles['apps/electron/src/main/index.ts']!
          .replace('registerBridge(createLanBridgeRegistration(agentEventBus))', registrationCase.registration),
      }

      expect(getCheck(files, 'bridge-composition').passed).toBe(false)
    })
  }

  /** bootstrap 必须精确挂在 Electron app.whenReady() 上。 */
  const invalidBootstrapReceivers: Array<{ name: string; source: string }> = [
    { name: 'Promise.reject.then', source: 'Promise.reject().then(bootstrap).catch(handleBootstrapFailure)' },
    { name: '其他对象 whenReady', source: 'otherApp.whenReady().then(bootstrap).catch(handleBootstrapFailure)' },
  ]

  for (const bootstrapCase of invalidBootstrapReceivers) {
    test(`Given ${bootstrapCase.name} When 检查 bootstrap 挂接 Then 明确失败`, () => {
      /** 替换当前 app.whenReady() 调用链的接收者。 */
      const files = {
        ...validFiles,
        'apps/electron/src/main/index.ts': validFiles['apps/electron/src/main/index.ts']!
          .replace('app.whenReady().then(bootstrap).catch(handleBootstrapFailure)', bootstrapCase.source),
      }

      expect(getCheck(files, 'bridge-composition').passed).toBe(false)
    })
  }

  /** startAllBridges 只有在可达 bootstrap 顶层路径中才有效。 */
  const unreachableBootstrapCases: Array<{ name: string; source: string }> = [
    {
      name: '调用只在死函数',
      source: `
        registerBridge(createLanBridgeRegistration(agentEventBus))
        app.whenReady().then(bootstrap)
        async function bootstrap(): Promise<void> {}
        function deadStart() { startAllBridges() }
      `,
    },
    {
      name: '调用位于 return 后',
      source: `
        registerBridge(createLanBridgeRegistration(agentEventBus))
        app.whenReady().then(bootstrap)
        async function bootstrap(): Promise<void> {
          return
          await startAllBridges()
        }
      `,
    },
    {
      name: '调用只在 false 条件分支',
      source: `
        registerBridge(createLanBridgeRegistration(agentEventBus))
        app.whenReady().then(bootstrap)
        async function bootstrap(): Promise<void> {
          if (false) await startAllBridges()
        }
      `,
    },
  ]

  for (const bootstrapCase of unreachableBootstrapCases) {
    test(`Given ${bootstrapCase.name} When 检查 Bridge 启动 Then 明确失败`, () => {
      /** 使用当前不可达启动源码替换主进程组合根。 */
      const files = {
        ...validFiles,
        'apps/electron/src/main/index.ts': bootstrapCase.source,
      }

      expect(getCheck(files, 'bridge-composition').passed).toBe(false)
    })
  }

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
    {
      name: 'block direct call',
      source: `
        export function createLanBridgeRegistration(agentEventBus: AgentEventBus) {
          return { start: () => { startLanBridge(agentEventBus) } }
        }
      `,
    },
    {
      name: 'block return call',
      source: `
        export function createLanBridgeRegistration(agentEventBus: AgentEventBus) {
          return { start: () => { return startLanBridge(agentEventBus) } }
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
    {
      name: '调用位于 return 后',
      source: `
        export function createLanBridgeRegistration(agentEventBus: AgentEventBus) {
          return {
            start: () => {
              return Promise.resolve()
              startLanBridge(agentEventBus)
            },
          }
        }
      `,
    },
    {
      name: '调用位于 throw 后',
      source: `
        export function createLanBridgeRegistration(agentEventBus: AgentEventBus) {
          return {
            start: () => {
              throw new Error('stop')
              startLanBridge(agentEventBus)
            },
          }
        }
      `,
    },
    {
      name: '调用仅存在于永不执行条件分支',
      source: `
        export function createLanBridgeRegistration(agentEventBus: AgentEventBus) {
          return { start: () => { if (false) startLanBridge(agentEventBus) } }
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

  /** registrar 的十个 handler 必须是导出函数体中的直接调用。 */
  const disguisedHandlerCases: Array<{ name: string; replacement: string }> = [
    {
      name: 'START handler 只剩注释',
      replacement: '// ipc.handle(LAN_BRIDGE_IPC_CHANNELS.START, async () => start())',
    },
    {
      name: 'START handler 只在死函数',
      replacement: 'function deadStart() { ipc.handle(LAN_BRIDGE_IPC_CHANNELS.START, async () => start()) }',
    },
  ]

  for (const handlerCase of disguisedHandlerCases) {
    test(`Given ${handlerCase.name} When 检查 LAN IPC 合同 Then 明确失败`, () => {
      /** 替换 registrar 内唯一真实 START handler。 */
      const files = {
        ...validFiles,
        'apps/electron/src/main/lib/lan-bridge/lan-bridge-ipc.ts': validFiles['apps/electron/src/main/lib/lan-bridge/lan-bridge-ipc.ts']!
          .replace(
            'ipc.handle(LAN_BRIDGE_IPC_CHANNELS.START, async () => start())',
            handlerCase.replacement,
          ),
      }

      expect(getCheck(files, 'lan-ipc-contract').passed).toBe(false)
    })
  }

  test('Given registrar handler 使用错误通道或重复注册 When 检查合同 Then 均失败', () => {
    /** START 方法错误绑定 STOP 通道。 */
    const wrongChannelFiles = {
      ...validFiles,
      'apps/electron/src/main/lib/lan-bridge/lan-bridge-ipc.ts': validFiles['apps/electron/src/main/lib/lan-bridge/lan-bridge-ipc.ts']!
        .replace('LAN_BRIDGE_IPC_CHANNELS.START, async () => start()', 'LAN_BRIDGE_IPC_CHANNELS.STOP, async () => start()'),
    }
    /** START 通道在 registrar 中注册两次。 */
    const duplicateHandlerFiles = {
      ...validFiles,
      'apps/electron/src/main/lib/lan-bridge/lan-bridge-ipc.ts': validFiles['apps/electron/src/main/lib/lan-bridge/lan-bridge-ipc.ts']!
        .replace(
          'ipc.handle(LAN_BRIDGE_IPC_CHANNELS.START, async () => start())',
          `ipc.handle(LAN_BRIDGE_IPC_CHANNELS.START, async () => start())
      ipc.handle(LAN_BRIDGE_IPC_CHANNELS.START, async () => start())`,
        ),
    }

    expect(getCheck(wrongChannelFiles, 'lan-ipc-contract').passed).toBe(false)
    expect(getCheck(duplicateHandlerFiles, 'lan-ipc-contract').passed).toBe(false)
  })

  /** preload 方法必须来自 factory 返回对象并真实 invoke 对应通道。 */
  const disguisedPreloadCases: Array<{ name: string; replacement: string }> = [
    {
      name: 'start 方法只剩注释',
      replacement: '// startLanBridge: () => ipc.invoke(LAN_BRIDGE_IPC_CHANNELS.START),',
    },
    {
      name: 'start 方法只在死对象',
      replacement: 'dead: { startLanBridge: () => ipc.invoke(LAN_BRIDGE_IPC_CHANNELS.START) },',
    },
  ]

  for (const preloadCase of disguisedPreloadCases) {
    test(`Given preload ${preloadCase.name} When 检查 LAN IPC 合同 Then 明确失败`, () => {
      /** 替换 factory 返回对象内唯一真实 start 方法。 */
      const files = {
        ...validFiles,
        'apps/electron/src/preload/lan-bridge-preload.ts': validFiles['apps/electron/src/preload/lan-bridge-preload.ts']!
          .replace(
            'startLanBridge: () => ipc.invoke(LAN_BRIDGE_IPC_CHANNELS.START),',
            preloadCase.replacement,
          ),
      }

      expect(getCheck(files, 'lan-ipc-contract').passed).toBe(false)
    })
  }

  test('Given preload start 方法调用错误通道 When 检查 LAN IPC 合同 Then 明确失败', () => {
    /** start 方法错误调用 STOP 通道。 */
    const files = {
      ...validFiles,
      'apps/electron/src/preload/lan-bridge-preload.ts': validFiles['apps/electron/src/preload/lan-bridge-preload.ts']!
        .replace('LAN_BRIDGE_IPC_CHANNELS.START),', 'LAN_BRIDGE_IPC_CHANNELS.STOP),'),
    }

    expect(getCheck(files, 'lan-ipc-contract').passed).toBe(false)
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

  /** electron-builder 目标资源必须来自顶层数组中的完整 map。 */
  const invalidBuilderYamlCases: Array<{ name: string; source: string }> = [
    {
      name: 'extraResources 是 map',
      source: `
extraResources:
  from: ../../apps/mobile/dist
  to: mobile-dist
  filter: ["**/*"]
      `,
    },
    {
      name: '目标 entry 是 scalar',
      source: `
extraResources:
  - ../../apps/mobile/dist
      `,
    },
    {
      name: 'filter 为 null 且 ignoredResources 有伪列表',
      source: `
extraResources:
  - from: ../../apps/mobile/dist
    to: mobile-dist
    filter: null
ignoredResources:
  - from: ../../apps/mobile/dist
    to: mobile-dist
    filter: ["**/*"]
      `,
    },
    {
      name: '资源只存在于 mac 错层',
      source: `
mac:
  extraResources:
    - from: ../../apps/mobile/dist
      to: mobile-dist
      filter: ["**/*"]
      `,
    },
    {
      name: '使用相似键 extraResource',
      source: `
extraResource:
  - from: ../../apps/mobile/dist
    to: mobile-dist
    filter: ["**/*"]
      `,
    },
    {
      name: '目标 entry 后包含损坏 YAML',
      source: `
extraResources:
  - from: ../../apps/mobile/dist
    to: mobile-dist
    filter:
      - "**/*"
broken: [
      `,
    },
  ]

  for (const builderCase of invalidBuilderYamlCases) {
    test(`Given ${builderCase.name} When 检查 Builder YAML Then 明确失败`, () => {
      /** 使用当前结构无效或类型错误的 builder YAML。 */
      const files = {
        ...validFiles,
        'apps/electron/electron-builder.yml': builderCase.source,
      }

      expect(getCheck(files, 'mobile-resource').passed).toBe(false)
    })
  }

  /** workflow 的触发、安全与执行资源约束必须结构化存在。 */
  const invalidWorkflowStructureCases: Array<{ name: string; mutate: (source: string) => string }> = [
    {
      name: '缺少手动触发',
      mutate: (source) => source.replace('workflow_dispatch:', 'repository_dispatch:'),
    },
    {
      name: '缺少每周触发',
      mutate: (source) => source.replace("  schedule:\n    - cron: '17 3 * * 1'\n", ''),
    },
    {
      name: '缺少只读权限',
      mutate: (source) => source.replace('permissions:\n  contents: read\n', ''),
    },
    {
      name: '缺少并发取消',
      mutate: (source) => source.replace('  cancel-in-progress: true', '  cancel-in-progress: false'),
    },
    {
      name: '缺少超时',
      mutate: (source) => source.replace('    timeout-minutes: 60\n', ''),
    },
    {
      name: 'checkout 非完整历史',
      mutate: (source) => source.replace('          fetch-depth: 0', '          fetch-depth: 1'),
    },
    {
      name: 'checkout 不拉取 tags',
      mutate: (source) => source.replace('          fetch-tags: true', '          fetch-tags: false'),
    },
    {
      name: 'install 未冻结 lockfile',
      mutate: (source) => source.replace('bun install --frozen-lockfile', 'bun install'),
    },
    {
      name: '验证步骤顺序错误',
      mutate: (source) => source
        .replace('      - name: Build mobile app', '      - name: TEMP mobile')
        .replace('      - name: Typecheck all workspaces', '      - name: Build mobile app')
        .replace('      - name: TEMP mobile', '      - name: Typecheck all workspaces'),
    },
  ]

  for (const workflowCase of invalidWorkflowStructureCases) {
    test(`Given ${workflowCase.name} When 检查 workflow Then 明确失败`, () => {
      /** 破坏单项 workflow 结构契约。 */
      const files = {
        ...validFiles,
        '.github/workflows/upstream-compat.yml': workflowCase.mutate(validWorkflow),
      }

      expect(getCheck(files, 'workflow-definition').passed).toBe(false)
    })
  }

  test('Given upstream URL 指向错误仓库 When 检查 workflow Then 明确失败', () => {
    /** 只替换官方上游 URL，保留其余 tag 流程。 */
    const files = {
      ...validFiles,
      '.github/workflows/upstream-compat.yml': validWorkflow.replace(
        'https://github.com/ErlichLiu/Proma.git',
        'https://github.com/example/Proma.git',
      ),
    }

    expect(getCheck(files, 'workflow-definition').passed).toBe(false)
  })

  test('Given tag 排序后使用 head 选择最小版本 When 检查 workflow Then 明确失败', () => {
    /** 把最大 tag 选择改为排序结果首行。 */
    const files = {
      ...validFiles,
      '.github/workflows/upstream-compat.yml': validWorkflow.replace(
        'tail -n 1 "$SORTED_TAGS_FILE"',
        'head -n 1 "$SORTED_TAGS_FILE"',
      ),
    }

    expect(getCheck(files, 'workflow-definition').passed).toBe(false)
  })

  test('Given strict candidate 正则只存在于注释 When 检查 workflow Then 明确失败', () => {
    /** 注释掉严格 semver 分支，保留相同文本。 */
    const files = {
      ...validFiles,
      '.github/workflows/upstream-compat.yml': validWorkflow.replace(
        'if [[ "$tag" =~ ^v(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)$ ]]; then',
        '# if [[ "$tag" =~ ^v(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)$ ]]; then',
      ),
    }

    expect(getCheck(files, 'workflow-definition').passed).toBe(false)
  })

  test('Given tag_ref 输出只存在于注释 When 检查 workflow Then 明确失败', () => {
    /** 注释掉 GitHub output 写入，保留相同文本。 */
    const files = {
      ...validFiles,
      '.github/workflows/upstream-compat.yml': validWorkflow.replace(
        'echo "tag_ref=refs/tags/upstream/$LATEST_TAG" >> "$GITHUB_OUTPUT"',
        '# echo "tag_ref=refs/tags/upstream/$LATEST_TAG" >> "$GITHUB_OUTPUT"',
      ),
    }

    expect(getCheck(files, 'workflow-definition').passed).toBe(false)
  })

  /** 关键命令不能藏在不可证明执行的 false 控制流中。 */
  const unreachableWorkflowCommandCases: Array<{ name: string; target: string; replacement: string }> = [
    {
      name: 'fetch',
      target: "git fetch --force upstream '+refs/tags/*:refs/tags/upstream/*'",
      replacement: "if false; then\n            git fetch --force upstream '+refs/tags/*:refs/tags/upstream/*'\n          fi",
    },
    {
      name: 'tag list',
      target: "git tag --list 'upstream/v*' > \"$RAW_TAGS_FILE\"",
      replacement: "if false; then\n            git tag --list 'upstream/v*' > \"$RAW_TAGS_FILE\"\n          fi",
    },
    {
      name: 'merge',
      target: 'git merge --no-commit --no-ff "$UPSTREAM_TAG_REF"',
      replacement: 'if false; then\n            git merge --no-commit --no-ff "$UPSTREAM_TAG_REF"\n          fi',
    },
    {
      name: 'checker',
      target: "run: bun run --filter='@proma/electron' check:fork-compat",
      replacement: "run: |\n          if false; then\n            bun run --filter='@proma/electron' check:fork-compat\n          fi",
    },
  ]

  for (const commandCase of unreachableWorkflowCommandCases) {
    test(`Given ${commandCase.name} 命令位于 if false When 检查 workflow Then 明确失败`, () => {
      /** 将当前关键命令包进不可达控制流。 */
      const workflow = validWorkflow.replace(commandCase.target, commandCase.replacement)
      const files = { ...validFiles, '.github/workflows/upstream-compat.yml': workflow }

      expect(workflow).not.toBe(validWorkflow)
      expect(getCheck(files, 'workflow-definition').passed).toBe(false)
    })
  }

  /** 任意额外 step 都不得执行发布、PR 或 push 副作用。 */
  const forbiddenWorkflowCommands = [
    'git push origin HEAD',
    'gh pr create --fill',
    'gh release create v9.9.9',
    'bun run publish',
  ]

  for (const command of forbiddenWorkflowCommands) {
    test(`Given workflow 额外执行 ${command} When 检查定义 Then 明确失败`, () => {
      /** 在清理前插入不属于兼容检查职责的副作用 step。 */
      const unsafeStep = `      - name: Unsafe side effect\n        run: ${command}\n`
      const workflow = validWorkflow.replace(
        '      - name: Abort merge and remove temporary branch',
        `${unsafeStep}      - name: Abort merge and remove temporary branch`,
      )
      const files = { ...validFiles, '.github/workflows/upstream-compat.yml': workflow }

      expect(getCheck(files, 'workflow-definition').passed).toBe(false)
    })
  }

  test('Given tag ref 先写入受控变量 When 检查 workflow Then 接受真实输出命令', () => {
    /** 模拟真实 workflow 先构造 namespaced tag ref 再写入输出。 */
    const workflow = validWorkflow.replace(
      'echo "tag_ref=refs/tags/upstream/$LATEST_TAG" >> "$GITHUB_OUTPUT"',
      'readonly UPSTREAM_TAG_REF="refs/tags/upstream/$LATEST_TAG"\n          echo "tag_ref=$UPSTREAM_TAG_REF" >> "$GITHUB_OUTPUT"',
    )
    /** 使用变量输出 tag ref 的仓库 fixture。 */
    const files = {
      ...validFiles,
      '.github/workflows/upstream-compat.yml': workflow,
    }

    expect(workflow).not.toBe(validWorkflow)
    expect(getCheck(files, 'workflow-definition').passed).toBe(true)
  })

  /** 每个关键 run 被 echo 替换时都不能被文本内容伪装。 */
  const echoedWorkflowRunCases: Array<{ name: string; target: string; replacement: string }> = [
    {
      name: 'upstream fetch',
      target: "git fetch --force upstream '+refs/tags/*:refs/tags/upstream/*'",
      replacement: `echo "git fetch --force upstream '+refs/tags/*:refs/tags/upstream/*'"`,
    },
    {
      name: 'tag list',
      target: "git tag --list 'upstream/v*'",
      replacement: `echo "git tag --list 'upstream/v*'"`,
    },
    {
      name: 'merge',
      target: 'git merge --no-commit --no-ff "$UPSTREAM_TAG_REF"',
      replacement: 'echo \'git merge --no-commit --no-ff "$UPSTREAM_TAG_REF"\'',
    },
    {
      name: 'frozen install',
      target: 'run: bun install --frozen-lockfile',
      replacement: 'run: echo "bun install --frozen-lockfile"',
    },
    {
      name: 'checker',
      target: "run: bun run --filter='@proma/electron' check:fork-compat",
      replacement: `run: echo "bun run --filter='@proma/electron' check:fork-compat"`,
    },
    {
      name: 'targeted tests',
      target: 'run: bun test apps/electron/src/main/lib/lan-bridge apps/electron/src/preload/lan-bridge-preload.test.ts apps/mobile/src/lib',
      replacement: 'run: echo "bun test apps/electron/src/main/lib/lan-bridge apps/electron/src/preload/lan-bridge-preload.test.ts apps/mobile/src/lib"',
    },
    {
      name: 'mobile build',
      target: "run: bun run --filter='@proma/mobile' build",
      replacement: `run: echo "bun run --filter='@proma/mobile' build"`,
    },
    {
      name: 'root typecheck',
      target: 'run: bun run typecheck',
      replacement: 'run: echo "bun run typecheck"',
    },
    {
      name: 'electron build',
      target: 'run: bun run electron:build',
      replacement: 'run: echo "bun run electron:build"',
    },
    {
      name: 'cleanup abort',
      target: "run_cleanup 'abort merge' git merge --abort",
      replacement: `echo "run_cleanup 'abort merge' git merge --abort"`,
    },
  ]

  for (const workflowCase of echoedWorkflowRunCases) {
    test(`Given ${workflowCase.name} run 被 echo 替换 When 检查 workflow Then 明确失败`, () => {
      /** 只替换当前关键命令，保留相同文本作为 echo 参数。 */
      const workflow = validWorkflow.replace(workflowCase.target, workflowCase.replacement)
      const files = { ...validFiles, '.github/workflows/upstream-compat.yml': workflow }

      expect(workflow).not.toBe(validWorkflow)
      expect(getCheck(files, 'workflow-definition').passed).toBe(false)
    })
  }

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

  test('Given filesystem reader 收到绝对路径、父目录或 symlink When 读取 Then 不越出仓库根', () => {
    /** 隔离的临时父目录、仓库根与外部目录。 */
    const temporaryRoot = mkdtempSync(join(tmpdir(), 'proma-fork-reader-'))
    const repositoryRoot = join(temporaryRoot, 'repository')
    const outsideDirectory = join(temporaryRoot, 'outside')
    mkdirSync(repositoryRoot)
    mkdirSync(outsideDirectory)
    writeFileSync(join(repositoryRoot, 'inside.txt'), 'inside', 'utf8')
    writeFileSync(join(temporaryRoot, 'outside.txt'), 'outside-parent', 'utf8')
    writeFileSync(join(outsideDirectory, 'secret.txt'), 'outside-directory', 'utf8')
    symlinkSync('/etc/hosts', join(repositoryRoot, 'hosts-link'))
    symlinkSync(outsideDirectory, join(repositoryRoot, 'outside-link'))

    try {
      /** 受测的真实文件系统 reader。 */
      const reader = createFileSystemRepositoryReader(repositoryRoot)

      expect(reader.read('inside.txt')).toBe('inside')
      expect(reader.read('/etc/hosts') === undefined).toBe(true)
      expect(reader.read('../outside.txt') === undefined).toBe(true)
      expect(reader.read('hosts-link') === undefined).toBe(true)
      expect(reader.list('../outside')).toEqual([])
      expect(reader.list('outside-link')).toEqual([])
    } finally {
      rmSync(temporaryRoot, { recursive: true, force: true })
    }
  })
})
