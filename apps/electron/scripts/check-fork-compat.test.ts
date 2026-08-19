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
  workflow_dispatch: {}
  schedule:
    - cron: '17 3 * * 1'
permissions:
  contents: read
concurrency:
  group: upstream-compat-\${{ github.ref }}
  cancel-in-progress: true
jobs:
  upstream-compat:
    name: Verify latest upstream release
    runs-on: ubuntu-latest
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
        shell: bash
        run: |
          set -euo pipefail
          git remote add upstream https://github.com/ErlichLiu/Proma.git
          git fetch --force upstream '+refs/tags/*:refs/tags/upstream/*'
          readonly TEMP_BRANCH="compat/upstream-$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT"
          readonly BASE_SHA="$(git rev-parse HEAD)"
          readonly RAW_TAGS_FILE="$RUNNER_TEMP/upstream-tags.txt"
          readonly NAMESPACED_RELEASE_TAGS_FILE="$RUNNER_TEMP/upstream-namespaced-release-tags.txt"
          readonly RELEASE_TAGS_FILE="$RUNNER_TEMP/upstream-release-tags.txt"
          readonly SORTED_TAGS_FILE="$RUNNER_TEMP/upstream-release-tags.sorted.txt"
          git tag --list 'upstream/v*' > "$RAW_TAGS_FILE"
          grep -E '^upstream/v(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)$' "$RAW_TAGS_FILE" > "$NAMESPACED_RELEASE_TAGS_FILE"
          sed 's#^upstream/##' "$NAMESPACED_RELEASE_TAGS_FILE" > "$RELEASE_TAGS_FILE"
          sort -V "$RELEASE_TAGS_FILE" > "$SORTED_TAGS_FILE"
          readonly LATEST_TAG="$(tail -n 1 "$SORTED_TAGS_FILE")"
          test -n "$LATEST_TAG"
          readonly UPSTREAM_TAG_REF="refs/tags/upstream/$LATEST_TAG"
          readonly UPSTREAM_SHA="$(git rev-parse "\${UPSTREAM_TAG_REF}^{commit}")"
          echo "base_sha=$BASE_SHA" >> "$GITHUB_OUTPUT"
          echo "tag=$LATEST_TAG" >> "$GITHUB_OUTPUT"
          echo "tag_ref=$UPSTREAM_TAG_REF" >> "$GITHUB_OUTPUT"
          echo "upstream_sha=$UPSTREAM_SHA" >> "$GITHUB_OUTPUT"
          echo "temp_branch=$TEMP_BRANCH" >> "$GITHUB_OUTPUT"
      - name: Merge upstream tag without committing
        shell: bash
        env:
          BASE_SHA: \${{ steps.upstream.outputs.base_sha }}
          TEMP_BRANCH: \${{ steps.upstream.outputs.temp_branch }}
          UPSTREAM_TAG: \${{ steps.upstream.outputs.tag }}
          UPSTREAM_TAG_REF: \${{ steps.upstream.outputs.tag_ref }}
        run: |
          set -euo pipefail
          git switch --create "$TEMP_BRANCH" "$BASE_SHA"
          git merge --no-commit --no-ff "$UPSTREAM_TAG_REF"
          echo "base=$BASE_SHA"
          echo "head=$(git rev-parse HEAD)"
          echo "upstream_tag=$UPSTREAM_TAG"
          git status --short
          git diff --cached --stat
      - name: Verify upstream merge state
        env:
          UPSTREAM_TAG_REF: \${{ steps.upstream.outputs.tag_ref }}
        run: bun run apps/electron/scripts/verify-upstream-merge.ts
      - name: Install dependencies from merged tree
        run: bun install --frozen-lockfile
      - name: Check fork compatibility seams
        run: bun run --filter='@proma/electron' check:fork-compat
      - name: Run LAN and mobile targeted tests
        run: bun test apps/electron/scripts/check-fork-compat.test.ts apps/electron/scripts/verify-upstream-merge.test.ts apps/electron/src/main/lib/config-paths.test.ts apps/electron/src/main/lib/lan-bridge apps/electron/src/preload/lan-bridge-preload.test.ts apps/mobile/src/lib
      - name: Build mobile app
        run: bun run --filter='@proma/mobile' build
      - name: Typecheck all workspaces
        run: bun run typecheck
      - name: Build Electron app
        run: bun run electron:build
      - name: Abort merge and remove temporary branch
        if: always()
        shell: bash
        env:
          BASE_SHA: \${{ steps.upstream.outputs.base_sha }}
          TEMP_BRANCH: \${{ steps.upstream.outputs.temp_branch }}
        run: |
          set -u
          cleanup_failed=0

          run_cleanup() {
            local label="$1"
            shift
            echo "cleanup: $label"
            if "$@"; then
              echo "cleanup passed: $label"
            else
              echo "cleanup failed: $label" >&2
              cleanup_failed=1
            fi
          }

          if git rev-parse --verify --quiet MERGE_HEAD >/dev/null; then
            run_cleanup 'abort merge' git merge --abort
          else
            echo 'cleanup skipped: no merge in progress'
          fi

          if [[ -n "\${BASE_SHA:-}" ]]; then
            run_cleanup 'switch to base' git switch --detach "$BASE_SHA"
          else
            echo 'cleanup skipped: base SHA unavailable'
          fi

          if [[ -n "\${TEMP_BRANCH:-}" ]] && git show-ref --verify --quiet "refs/heads/$TEMP_BRANCH"; then
            run_cleanup 'delete temporary branch' git branch --delete --force "$TEMP_BRANCH"
          else
            echo 'cleanup skipped: temporary branch unavailable'
          fi

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
      'pin-pairing', 'pairing-ticket', 'device-revocation', 'trusted-device-credentials', 'streaming', 'connection-recovery',
    ] as const
    export const LAN_BRIDGE_WS_CAPABILITIES = [
      'pin-pairing', 'pairing-ticket', 'trusted-device-credentials', 'streaming', 'connection-recovery',
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
      dev: 'bun run build:mobile && bun run scripts/dev-kill.ts --vite && concurrently -k',
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
  'apps/electron/scripts/verify-upstream-merge.ts': 'export function verifyUpstreamMerge() {}',
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
        "'pairing-ticket', 'trusted-device-credentials', 'streaming'",
        "'pairing-ticket', 'streaming'",
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

  /** 三个组合根都必须从目标模块的真实 named import 获取运行时 binding。 */
  const forgedImportCases = [
    {
      name: 'Bridge factory',
      id: 'bridge-composition',
      path: 'apps/electron/src/main/index.ts',
      importLine: "import { createLanBridgeRegistration } from './lib/lan-bridge/lan-bridge'",
      replacement: `import './lib/lan-bridge/lan-bridge'
        const createLanBridgeRegistration = (eventBus: object) => ({ eventBus })`,
    },
    {
      name: 'IPC registrar 与 dependencies factory',
      id: 'ipc-composition',
      path: 'apps/electron/src/main/ipc.ts',
      importLine: "import { createLanBridgeIpcDependencies, registerLanBridgeIpcHandlers } from './lib/lan-bridge/lan-bridge-ipc'",
      replacement: `import './lib/lan-bridge/lan-bridge-ipc'
        const createLanBridgeIpcDependencies = (eventBus: object) => ({ eventBus })
        const registerLanBridgeIpcHandlers = (_ipc: object, _dependencies: object): void => {}`,
    },
    {
      name: 'preload factory',
      id: 'preload-composition',
      path: 'apps/electron/src/preload/index.ts',
      importLine: "import { createLanBridgePreloadApi } from './lan-bridge-preload'",
      replacement: `import './lan-bridge-preload'
        const createLanBridgePreloadApi = (_ipc: object) => ({})`,
    },
  ]

  for (const importCase of forgedImportCases) {
    test(`Given ${importCase.name} 仅 side-effect import 且本地伪造同名函数 When 检查组合点 Then 明确失败`, () => {
      /** 删除真实 named import，并保留模块副作用导入与同名本地伪造。 */
      const files = {
        ...validFiles,
        [importCase.path]: validFiles[importCase.path]!.replace(importCase.importLine, importCase.replacement),
      }

      expect(getCheck(files, importCase.id).passed).toBe(false)
    })
  }

  test('Given 三个组合根使用 named import alias When 检查组合点 Then 全部通过', () => {
    /** 使用合法 alias，并同步把组合调用改为对应 local binding。 */
    const files = {
      ...validFiles,
      'apps/electron/src/main/index.ts': validFiles['apps/electron/src/main/index.ts']!
        .replace(
          'import { createLanBridgeRegistration }',
          'import { createLanBridgeRegistration as createLanRegistration }',
        )
        .replace('createLanBridgeRegistration(agentEventBus)', 'createLanRegistration(agentEventBus)'),
      'apps/electron/src/main/ipc.ts': validFiles['apps/electron/src/main/ipc.ts']!
        .replace(
          'import { createLanBridgeIpcDependencies, registerLanBridgeIpcHandlers }',
          'import { createLanBridgeIpcDependencies as createLanDependencies, registerLanBridgeIpcHandlers as registerLanHandlers }',
        )
        .replace(
          'registerLanBridgeIpcHandlers(ipcMain, createLanBridgeIpcDependencies(agentEventBus))',
          'registerLanHandlers(ipcMain, createLanDependencies(agentEventBus))',
        ),
      'apps/electron/src/preload/index.ts': validFiles['apps/electron/src/preload/index.ts']!
        .replace(
          'import { createLanBridgePreloadApi }',
          'import { createLanBridgePreloadApi as createLanApi }',
        )
        .replace('createLanBridgePreloadApi(ipcRenderer)', 'createLanApi(ipcRenderer)'),
    }

    expect(getCheck(files, 'bridge-composition').passed).toBe(true)
    expect(getCheck(files, 'ipc-composition').passed).toBe(true)
    expect(getCheck(files, 'preload-composition').passed).toBe(true)
  })

  test('Given IPC 函数内本地同名 shadow 覆盖真实 imports When 检查组合点 Then 明确失败', () => {
    /** shadow 仍保留真实 import 文本，但实际调用绑定到函数内局部声明。 */
    const files = {
      ...validFiles,
      'apps/electron/src/main/ipc.ts': validFiles['apps/electron/src/main/ipc.ts']!
        .replace(
          'export function registerIpcHandlers(): void {',
          `export function registerIpcHandlers(): void {
            const registerLanBridgeIpcHandlers = (_ipc: object, _dependencies: object): void => {}
            const createLanBridgeIpcDependencies = (eventBus: object) => ({ eventBus })`,
        ),
    }

    expect(getCheck(files, 'ipc-composition').passed).toBe(false)
  })

  /** Bridge registry 与 EventBus 组合依赖也必须来自各自目标模块的真实 named import。 */
  const forgedBridgeDependencyCases = [
    {
      name: 'registerBridge',
      importLine: "import { registerBridge, startAllBridges } from './lib/bridge-registry'",
      replacement: `import { startAllBridges } from './lib/bridge-registry'
        const registerBridge = (_registration: object): void => {}`,
    },
    {
      name: 'startAllBridges',
      importLine: "import { registerBridge, startAllBridges } from './lib/bridge-registry'",
      replacement: `import { registerBridge } from './lib/bridge-registry'
        const startAllBridges = (): void => {}`,
    },
    {
      name: 'agentEventBus',
      importLine: "import { agentEventBus } from './lib/agent-service'",
      replacement: `import './lib/agent-service'
        const agentEventBus = { emit: (): void => {} }`,
    },
  ]

  for (const dependencyCase of forgedBridgeDependencyCases) {
    test(`Given Bridge 组合点用本地 ${dependencyCase.name} 替换真实 import When 检查来源 Then 明确失败`, () => {
      /** 删除当前关键依赖的 named import，并保留能通过文本检查的本地伪造。 */
      const files = {
        ...validFiles,
        'apps/electron/src/main/index.ts': validFiles['apps/electron/src/main/index.ts']!
          .replace(dependencyCase.importLine, dependencyCase.replacement),
      }

      expect(getCheck(files, 'bridge-composition').passed).toBe(false)
    })
  }

  test('Given Bridge 三个关键依赖均使用 named import alias When 检查来源 Then 通过', () => {
    /** alias 后的调用都应绑定对应 import specifier local symbol。 */
    const files = {
      ...validFiles,
      'apps/electron/src/main/index.ts': validFiles['apps/electron/src/main/index.ts']!
        .replace(
          'import { registerBridge, startAllBridges }',
          'import { registerBridge as registerLifecycleBridge, startAllBridges as startLifecycleBridges }',
        )
        .replace('import { agentEventBus }', 'import { agentEventBus as mainAgentEventBus }')
        .replace('registerBridge(createLanBridgeRegistration(agentEventBus))', 'registerLifecycleBridge(createLanBridgeRegistration(mainAgentEventBus))')
        .replace('startAllBridges()', 'startLifecycleBridges()'),
    }

    expect(getCheck(files, 'bridge-composition').passed).toBe(true)
  })

  test('Given bootstrap 内局部 startAllBridges shadow 覆盖真实 import When 检查来源 Then 明确失败', () => {
    /** import 仍存在，但 bootstrap 实际调用绑定到函数内局部声明。 */
    const files = {
      ...validFiles,
      'apps/electron/src/main/index.ts': validFiles['apps/electron/src/main/index.ts']!
        .replace(
          'async function bootstrap(): Promise<void> {',
          `async function bootstrap(): Promise<void> {
            const startAllBridges = (): void => {}`,
        ),
    }

    expect(getCheck(files, 'bridge-composition').passed).toBe(false)
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

  /** factory 首个顶层终止语句之后的 registration object 不可达。 */
  const terminatedFactoryCases = [
    { name: 'return undefined 前置', statement: 'return undefined' },
    { name: 'throw 前置', statement: "throw new Error('stopped')" },
  ]

  for (const factoryCase of terminatedFactoryCases) {
    test(`Given factory ${factoryCase.name} When 检查 Bridge registration Then 明确失败`, () => {
      /** 在合法对象 return 前插入无条件终止。 */
      const files = {
        ...validFiles,
        'apps/electron/src/main/lib/lan-bridge/lan-bridge.ts': validFiles['apps/electron/src/main/lib/lan-bridge/lan-bridge.ts']!
          .replace('      return {', `      ${factoryCase.statement}\n      return {`),
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

  /** registrar 终止后出现的 handler 不得计为可达合同。 */
  const terminatedRegistrarCases = [
    { name: 'return 前置', statement: 'return' },
    { name: 'throw 前置', statement: "throw new Error('stopped')" },
  ]

  for (const registrarCase of terminatedRegistrarCases) {
    test(`Given registrar ${registrarCase.name} When 检查 LAN IPC 合同 Then 明确失败`, () => {
      /** 在第一个 handler 前插入无条件终止语句。 */
      const files = {
        ...validFiles,
        'apps/electron/src/main/lib/lan-bridge/lan-bridge-ipc.ts': validFiles['apps/electron/src/main/lib/lan-bridge/lan-bridge-ipc.ts']!
          .replace(
            '      ipc.handle(LAN_BRIDGE_IPC_CHANNELS.GET_CONFIG',
            `      ${registrarCase.statement}\n      ipc.handle(LAN_BRIDGE_IPC_CHANNELS.GET_CONFIG`,
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
          dev: 'bun run build:mobile && bun run scripts/dev-kill.ts --vite && concurrently -k',
          'build:mobile': 'bun run --filter=@proma/mobile build',
          'package:prepare': 'bun run build && bun run build:mobile && bun run sync:runtime-deps',
        },
      }),
    }

    expect(getCheck(files, 'mobile-build').passed).toBe(true)
  })

  test('Given 开发启动跳过移动端构建 When 检查移动构建 Then 明确失败', () => {
    /** 保留打包构建合同，只移除开发启动前的移动端构建。 */
    const electronPackage = JSON.parse(validFiles['apps/electron/package.json']!) as {
      scripts: Record<string, string>
    }
    electronPackage.scripts.dev = 'bun run scripts/dev-kill.ts --vite && concurrently -k'
    const files = {
      ...validFiles,
      'apps/electron/package.json': JSON.stringify(electronPackage),
    }

    /** 开发态旧 dist 会与新服务端协议失配，必须由兼容检查提前阻断。 */
    const result = getCheck(files, 'mobile-build')
    expect(result.passed).toBe(false)
    expect(result.details.join('\n')).toContain('dev')
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
      name: '顶层权限包含额外 write',
      mutate: (source) => source.replace('  contents: read\n', '  contents: read\n  pull-requests: write\n'),
    },
    {
      name: 'job 覆盖为 write 权限',
      mutate: (source) => source.replace(
        '    timeout-minutes: 60\n',
        '    timeout-minutes: 60\n    permissions:\n      contents: write\n',
      ),
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

  /** workflow 递归 schema 必须拒绝每一层未批准的 key、元素与嵌套值。 */
  const invalidWorkflowSchemaCases: Array<{ name: string; mutate: (source: string) => string }> = [
    {
      name: '根 defaults 注入吞错 shell',
      mutate: (source) => source.replace(
        'jobs:',
        'defaults:\n  run:\n    shell: bash {0} || true\njobs:',
      ),
    },
    {
      name: '额外 push step',
      mutate: (source) => source.replace(
        '      - name: Abort merge and remove temporary branch',
        '      - name: Push merged result\n        run: git push origin HEAD\n      - name: Abort merge and remove temporary branch',
      ),
    },
    {
      name: 'checkout with 增加 ref',
      mutate: (source) => source.replace(
        '          fetch-tags: true',
        '          fetch-tags: true\n          ref: refs/heads/main',
      ),
    },
    {
      name: 'merge env 增加额外变量',
      mutate: (source) => source.replace(
        '          UPSTREAM_TAG_REF: \${{ steps.upstream.outputs.tag_ref }}',
        '          UPSTREAM_TAG_REF: \${{ steps.upstream.outputs.tag_ref }}\n          EXTRA_INPUT: untrusted',
      ),
    },
    {
      name: '重复 Build mobile step',
      mutate: (source) => source.replace(
        '      - name: Typecheck all workspaces',
        '      - name: Build mobile app\n        run: bun run --filter=\'@proma/mobile\' build\n      - name: Typecheck all workspaces',
      ),
    },
    {
      name: '根节点增加未知 key',
      mutate: (source) => source.replace(
        'permissions:',
        'unexpected-root: true\npermissions:',
      ),
    },
    {
      name: 'on 增加 push 触发器',
      mutate: (source) => source.replace(
        '  schedule:',
        '  push:\n  schedule:',
      ),
    },
    {
      name: 'workflow_dispatch 用字符串伪装空 map',
      mutate: (source) => source.replace(
        '  workflow_dispatch: {}\n',
        '  workflow_dispatch: disabled\n',
      ),
    },
    {
      name: 'permissions 增加 actions read',
      mutate: (source) => source.replace(
        '  contents: read',
        '  contents: read\n  actions: read',
      ),
    },
    {
      name: 'concurrency 增加未知 key',
      mutate: (source) => source.replace(
        '  cancel-in-progress: true',
        '  cancel-in-progress: true\n  unexpected: true',
      ),
    },
  ]

  for (const schemaCase of invalidWorkflowSchemaCases) {
    test(`Given ${schemaCase.name} When 递归校验 workflow schema Then 明确失败`, () => {
      /** 仅扩张一个 schema 节点，保留其余批准结构。 */
      const workflow = schemaCase.mutate(validWorkflow)
      const files = { ...validFiles, '.github/workflows/upstream-compat.yml': workflow }

      expect(workflow).not.toBe(validWorkflow)
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

  test('Given strict candidate 命令只存在于注释 When 检查 workflow Then 明确失败', () => {
    /** 注释掉严格 semver 分支，保留相同文本。 */
    const files = {
      ...validFiles,
      '.github/workflows/upstream-compat.yml': validWorkflow.replace(
        "grep -E '^upstream/v(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)$'",
        "# grep -E '^upstream/v(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)$'",
      ),
    }

    expect(getCheck(files, 'workflow-definition').passed).toBe(false)
  })

  test('Given tag_ref 输出只存在于注释 When 检查 workflow Then 明确失败', () => {
    /** 注释掉 GitHub output 写入，保留相同文本。 */
    const files = {
      ...validFiles,
      '.github/workflows/upstream-compat.yml': validWorkflow.replace(
        'echo "tag_ref=$UPSTREAM_TAG_REF" >> "$GITHUB_OUTPUT"',
        '# echo "tag_ref=$UPSTREAM_TAG_REF" >> "$GITHUB_OUTPUT"',
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

  /** 关键 step 出现 shell 控制结构时一律保守拒绝，不依赖缩进。 */
  const workflowControlStructureCases = [
    {
      name: '无缩进 if false',
      target: "git fetch --force upstream '+refs/tags/*:refs/tags/upstream/*'",
      replacement: "if false; then\n          echo hidden\n          fi\n          git fetch --force upstream '+refs/tags/*:refs/tags/upstream/*'",
    },
    {
      name: '单行 if false',
      target: 'git merge --no-commit --no-ff "$UPSTREAM_TAG_REF"',
      replacement: 'if false; then echo hidden; fi\n          git merge --no-commit --no-ff "$UPSTREAM_TAG_REF"',
    },
    {
      name: '提前 exit 0',
      target: 'git merge --no-commit --no-ff "$UPSTREAM_TAG_REF"',
      replacement: 'exit 0\n          git merge --no-commit --no-ff "$UPSTREAM_TAG_REF"',
    },
  ]

  for (const controlCase of workflowControlStructureCases) {
    test(`Given ${controlCase.name} When 检查关键 workflow step Then 明确失败`, () => {
      /** 注入不依赖缩进的控制结构。 */
      const workflow = validWorkflow.replace(controlCase.target, controlCase.replacement)
      const files = { ...validFiles, '.github/workflows/upstream-compat.yml': workflow }

      expect(workflow).not.toBe(validWorkflow)
      expect(getCheck(files, 'workflow-definition').passed).toBe(false)
    })
  }

  /** merge step 必须是完整有序闭集，任何换序、破坏状态或重复合并都必须拒绝。 */
  const invalidMergeContractCases = [
    {
      name: 'switch 与 merge 交换顺序',
      mutate: (workflow: string) => workflow.replace(
        '          git switch --create "$TEMP_BRANCH" "$BASE_SHA"\n          git merge --no-commit --no-ff "$UPSTREAM_TAG_REF"',
        '          git merge --no-commit --no-ff "$UPSTREAM_TAG_REF"\n          git switch --create "$TEMP_BRANCH" "$BASE_SHA"',
      ),
    },
    {
      name: 'merge 后追加 abort',
      mutate: (workflow: string) => workflow.replace(
        '          git merge --no-commit --no-ff "$UPSTREAM_TAG_REF"',
        '          git merge --no-commit --no-ff "$UPSTREAM_TAG_REF"\n          git merge --abort',
      ),
    },
    {
      name: 'merge 后追加 reset',
      mutate: (workflow: string) => workflow.replace(
        '          git merge --no-commit --no-ff "$UPSTREAM_TAG_REF"',
        '          git merge --no-commit --no-ff "$UPSTREAM_TAG_REF"\n          git reset --hard HEAD',
      ),
    },
    {
      name: '重复执行 merge',
      mutate: (workflow: string) => workflow.replace(
        '          git merge --no-commit --no-ff "$UPSTREAM_TAG_REF"',
        '          git merge --no-commit --no-ff "$UPSTREAM_TAG_REF"\n          git merge --no-commit --no-ff "$UPSTREAM_TAG_REF"',
      ),
    },
  ]

  for (const mergeCase of invalidMergeContractCases) {
    test(`Given ${mergeCase.name} When 检查 merge 闭集合同 Then 明确失败`, () => {
      /** 仅破坏 merge step 的命令集合或顺序。 */
      const workflow = mergeCase.mutate(validWorkflow)
      const files = { ...validFiles, '.github/workflows/upstream-compat.yml': workflow }

      expect(workflow).not.toBe(validWorkflow)
      expect(getCheck(files, 'workflow-definition').passed).toBe(false)
    })
  }

  /** cleanup 是完整有序闭集，wrapper、别名和普通额外命令都不能扩张执行面。 */
  const invalidCleanupContractCases = [
    { name: 'bash -c wrapper', command: `bash -c 'git push origin HEAD'` },
    { name: 'sh -c wrapper', command: `sh -c 'git push origin HEAD'` },
    { name: 'command wrapper', command: 'command git push origin HEAD' },
    { name: 'env wrapper', command: 'env UNSAFE=1 git push origin HEAD' },
    { name: 'alias wrapper', command: `alias publish_now='git push origin HEAD'` },
    { name: 'function wrapper', command: 'publish_now() { command git push origin HEAD; }' },
    { name: '普通 extra echo', command: `echo 'unexpected cleanup command'` },
  ]

  for (const cleanupCase of invalidCleanupContractCases) {
    test(`Given cleanup 注入 ${cleanupCase.name} When 检查有序闭集 Then 明确失败`, () => {
      /** 在状态聚合初始化后插入一条未批准执行语句。 */
      const workflow = validWorkflow.replace(
        '          cleanup_failed=0',
        `          cleanup_failed=0\n          ${cleanupCase.command}`,
      )
      const files = { ...validFiles, '.github/workflows/upstream-compat.yml': workflow }

      expect(workflow).not.toBe(validWorkflow)
      expect(getCheck(files, 'workflow-definition').passed).toBe(false)
    })
  }

  /** cleanup step 只能包含当前执行合同需要的键，禁止覆写失败与工作目录语义。 */
  const invalidCleanupStepKeyCases = [
    { name: 'continue-on-error true', line: '        continue-on-error: true' },
    { name: 'continue-on-error false', line: '        continue-on-error: false' },
    { name: 'timeout override', line: '        timeout-minutes: 5' },
    { name: 'working-directory', line: '        working-directory: apps/electron' },
  ]

  for (const keyCase of invalidCleanupStepKeyCases) {
    test(`Given cleanup step 增加 ${keyCase.name} When 检查允许键闭集 Then 明确失败`, () => {
      /** 在 always 条件后注入不属于 cleanup 合同的 step 字段。 */
      const workflow = validWorkflow.replace(
        '        if: always()',
        `        if: always()\n${keyCase.line}`,
      )
      const files = { ...validFiles, '.github/workflows/upstream-compat.yml': workflow }

      expect(workflow).not.toBe(validWorkflow)
      expect(getCheck(files, 'workflow-definition').passed).toBe(false)
    })
  }

  /** job 顶层只能保留当前验证任务实际需要的字段，禁止改变执行条件或容错语义。 */
  const invalidWorkflowJobKeyCases = [
    { name: 'if false', yaml: '    if: false' },
    { name: 'continue-on-error true', yaml: '    continue-on-error: true' },
    { name: 'continue-on-error false', yaml: '    continue-on-error: false' },
    { name: 'strategy matrix', yaml: '    strategy:\n      matrix:\n        bun: [latest]' },
  ]

  for (const keyCase of invalidWorkflowJobKeyCases) {
    test(`Given verify job 增加 ${keyCase.name} When 检查允许键闭集 Then 明确失败`, () => {
      /** 在 timeout 后注入未批准的 job 控制字段。 */
      const workflow = validWorkflow.replace(
        '    timeout-minutes: 60',
        `    timeout-minutes: 60\n${keyCase.yaml}`,
      )
      const files = { ...validFiles, '.github/workflows/upstream-compat.yml': workflow }

      expect(workflow).not.toBe(validWorkflow)
      expect(getCheck(files, 'workflow-definition').passed).toBe(false)
    })
  }

  test('Given workflow 增加第二个 job When 检查唯一 job 合同 Then 明确失败', () => {
    /** 附加无副作用 job，证明唯一性检查不依赖禁用命令或 action allowlist。 */
    const workflow = validWorkflow.replace(
      'jobs:\n  upstream-compat:',
      'jobs:\n  passive-extra-job:\n    runs-on: ubuntu-latest\n    steps: []\n  upstream-compat:',
    )
    const files = { ...validFiles, '.github/workflows/upstream-compat.yml': workflow }

    expect(workflow).not.toBe(validWorkflow)
    expect(getCheck(files, 'workflow-definition').passed).toBe(false)
  })

  /** 三个核心验证 run step 均不得通过 if 或 continue-on-error 绕过失败传播。 */
  const guardedRunStepNames = [
    'Check fork compatibility seams',
    'Run LAN and mobile targeted tests',
    'Typecheck all workspaces',
  ]
  const invalidRunStepControlCases = [
    { name: 'if false', yaml: '        if: false' },
    { name: 'continue-on-error true', yaml: '        continue-on-error: true' },
    { name: 'continue-on-error false', yaml: '        continue-on-error: false' },
  ]

  for (const stepName of guardedRunStepNames) {
    for (const keyCase of invalidRunStepControlCases) {
      test(`Given ${stepName} 增加 ${keyCase.name} When 检查 step 允许键闭集 Then 明确失败`, () => {
        /** 在命令前注入字段，不改变既有 run 文本。 */
        const workflow = validWorkflow.replace(
          `      - name: ${stepName}`,
          `      - name: ${stepName}\n${keyCase.yaml}`,
        )
        const files = { ...validFiles, '.github/workflows/upstream-compat.yml': workflow }

        expect(workflow).not.toBe(validWorkflow)
        expect(getCheck(files, 'workflow-definition').passed).toBe(false)
      })
    }
  }

  /** uses step 也不能通过条件字段跳过 checkout 或 Bun 安装。 */
  for (const stepName of ['Checkout fork with full history', 'Install Bun']) {
    test(`Given ${stepName} 增加 if false When 检查 action step 允许键闭集 Then 明确失败`, () => {
      /** action 本身保持不变，仅注入未批准控制字段。 */
      const workflow = validWorkflow.replace(
        `      - name: ${stepName}`,
        `      - name: ${stepName}\n        if: false`,
      )
      const files = { ...validFiles, '.github/workflows/upstream-compat.yml': workflow }

      expect(workflow).not.toBe(validWorkflow)
      expect(getCheck(files, 'workflow-definition').passed).toBe(false)
    })
  }

  test('Given 普通 run step 增加 working-directory When 检查允许键闭集 Then 明确失败', () => {
    /** 未批准的工作目录会改变命令解析边界，即使命令文本未变化也必须拒绝。 */
    const workflow = validWorkflow.replace(
      '      - name: Build mobile app',
      '      - name: Build mobile app\n        working-directory: apps/mobile',
    )
    const files = { ...validFiles, '.github/workflows/upstream-compat.yml': workflow }

    expect(workflow).not.toBe(validWorkflow)
    expect(getCheck(files, 'workflow-definition').passed).toBe(false)
  })

  /** targeted tests 必须真实执行 checker 与 helper 测试文件。 */
  test('Given targeted tests 包含配置路径防线 When 检查 workflow Then 允许执行', () => {
    /** 基准工作流必须直接携带底层 JSONL 路径边界测试。 */
    const workflow = validWorkflow
    const files = { ...validFiles, '.github/workflows/upstream-compat.yml': workflow }

    expect(workflow).toContain('apps/electron/src/main/lib/config-paths.test.ts')
    expect(getCheck(files, 'workflow-definition').passed).toBe(true)
  })

  const invalidTargetedTestCases = [
    {
      name: '缺少 helper test',
      target: ' apps/electron/scripts/verify-upstream-merge.test.ts',
      replacement: '',
    },
    {
      name: 'echo helper test',
      target: 'apps/electron/scripts/verify-upstream-merge.test.ts',
      replacement: 'apps/electron/src/main/lib/lan-bridge && echo apps/electron/scripts/verify-upstream-merge.test.ts',
    },
    {
      name: 'helper test 路径错误',
      target: 'apps/electron/scripts/verify-upstream-merge.test.ts',
      replacement: 'apps/electron/scripts/verify-upstream-merge.spec.ts',
    },
    {
      name: '缺少 checker test',
      target: 'apps/electron/scripts/check-fork-compat.test.ts ',
      replacement: '',
    },
    {
      name: '缺少配置路径防线 test',
      target: ' apps/electron/src/main/lib/config-paths.test.ts',
      replacement: '',
    },
  ]

  for (const targetedCase of invalidTargetedTestCases) {
    test(`Given targeted tests ${targetedCase.name} When 检查 workflow Then 明确失败`, () => {
      /** 破坏自测文件参数或用 echo 文本伪装。 */
      const workflow = validWorkflow.replace(targetedCase.target, targetedCase.replacement)
      const files = { ...validFiles, '.github/workflows/upstream-compat.yml': workflow }

      expect(workflow).not.toBe(validWorkflow)
      expect(getCheck(files, 'workflow-definition').passed).toBe(false)
    })
  }

  /** 反斜杠续行必须先折叠，否则短路操作符可把下一物理行的关键命令变成不可达。 */
  const continuedShortCircuitCases = [
    { name: 'false && LF', prefix: 'false && \\', newline: '\n' },
    { name: 'true || LF', prefix: 'true || \\', newline: '\n' },
    { name: 'false && CRLF', prefix: 'false && \\', newline: '\r\n' },
  ]

  for (const shortCircuitCase of continuedShortCircuitCases) {
    test(`Given ${shortCircuitCase.name} 通过续行包裹 fetch When 检查 workflow Then 明确失败`, () => {
      /** 把关键命令拼接到短路表达式的同一逻辑行。 */
      const workflow = validWorkflow.replace(
        "git fetch --force upstream '+refs/tags/*:refs/tags/upstream/*'",
        `${shortCircuitCase.prefix}${shortCircuitCase.newline}          git fetch --force upstream '+refs/tags/*:refs/tags/upstream/*'`,
      )
      const files = { ...validFiles, '.github/workflows/upstream-compat.yml': workflow }

      expect(workflow).not.toBe(validWorkflow)
      expect(getCheck(files, 'workflow-definition').passed).toBe(false)
    })
  }

  test('Given tag_ref 输出移动到变量赋值前 When 检查线性合同 Then 明确失败', () => {
    /** 文本仍全部存在，但输出发生在可信 tag ref 定义之前。 */
    const workflow = validWorkflow
      .replace('          echo "tag_ref=$UPSTREAM_TAG_REF" >> "$GITHUB_OUTPUT"\n', '')
      .replace(
        '          readonly UPSTREAM_TAG_REF="refs/tags/upstream/$LATEST_TAG"\n',
        '          echo "tag_ref=$UPSTREAM_TAG_REF" >> "$GITHUB_OUTPUT"\n          readonly UPSTREAM_TAG_REF="refs/tags/upstream/$LATEST_TAG"\n',
      )
    const files = { ...validFiles, '.github/workflows/upstream-compat.yml': workflow }

    expect(workflow).not.toBe(validWorkflow)
    expect(getCheck(files, 'workflow-definition').passed).toBe(false)
  })

  /** upstream remote 只能按合同添加一次，禁止后续改写或追加其他来源。 */
  const invalidRemoteCases = [
    'git remote set-url upstream https://attacker.invalid/Proma.git',
    'git remote add upstream https://attacker.invalid/Proma.git',
    'git remote add mirror https://attacker.invalid/Proma.git',
  ]

  for (const remoteCommand of invalidRemoteCases) {
    test(`Given select step 追加 ${remoteCommand} When 检查 remote 闭集 Then 明确失败`, () => {
      /** 在合法 add 之后注入额外远端写操作。 */
      const workflow = validWorkflow.replace(
        '          git remote add upstream https://github.com/ErlichLiu/Proma.git',
        `          git remote add upstream https://github.com/ErlichLiu/Proma.git\n          ${remoteCommand}`,
      )
      const files = { ...validFiles, '.github/workflows/upstream-compat.yml': workflow }

      expect(workflow).not.toBe(validWorkflow)
      expect(getCheck(files, 'workflow-definition').passed).toBe(false)
    })
  }

  test('Given merge helper 步骤缺失 When 检查 workflow Then 明确失败', () => {
    /** 删除 merge 状态验证步骤但保留其它验证命令。 */
    const workflow = validWorkflow.replace(
      `      - name: Verify upstream merge state
        env:
          UPSTREAM_TAG_REF: \${{ steps.upstream.outputs.tag_ref }}
        run: bun run apps/electron/scripts/verify-upstream-merge.ts
`,
      '',
    )
    const files = { ...validFiles, '.github/workflows/upstream-compat.yml': workflow }

    expect(workflow).not.toBe(validWorkflow)
    expect(getCheck(files, 'workflow-definition').passed).toBe(false)
  })

  test('Given merge helper 位于 merge 前 When 检查步骤顺序 Then 明确失败', () => {
    /** 把 helper step 移到 merge 操作之前。 */
    const helperStep = `      - name: Verify upstream merge state
        env:
          UPSTREAM_TAG_REF: \${{ steps.upstream.outputs.tag_ref }}
        run: bun run apps/electron/scripts/verify-upstream-merge.ts
`
    const workflow = validWorkflow
      .replace(helperStep, '')
      .replace('      - name: Merge upstream tag without committing', `${helperStep}      - name: Merge upstream tag without committing`)
    const files = { ...validFiles, '.github/workflows/upstream-compat.yml': workflow }

    expect(workflow).not.toBe(validWorkflow)
    expect(getCheck(files, 'workflow-definition').passed).toBe(false)
  })

  test('Given merge helper 位于兼容检查后 When 检查步骤顺序 Then 明确失败', () => {
    /** 把 helper step 移到 fork checker 之后，破坏先验证 merge 状态的顺序。 */
    const helperStep = `      - name: Verify upstream merge state
        env:
          UPSTREAM_TAG_REF: \${{ steps.upstream.outputs.tag_ref }}
        run: bun run apps/electron/scripts/verify-upstream-merge.ts
`
    const workflow = validWorkflow
      .replace(helperStep, '')
      .replace(
        "      - name: Run LAN and mobile targeted tests",
        `${helperStep}      - name: Run LAN and mobile targeted tests`,
      )
    const files = { ...validFiles, '.github/workflows/upstream-compat.yml': workflow }

    expect(workflow).not.toBe(validWorkflow)
    expect(getCheck(files, 'workflow-definition').passed).toBe(false)
  })

  test('Given merge helper 源文件缺失 When 检查 workflow Then 明确报告路径', () => {
    /** 删除 helper 文件，checker 必须把它纳入必需文件清单。 */
    const files = { ...validFiles }
    delete files['apps/electron/scripts/verify-upstream-merge.ts']
    const result = getCheck(files, 'workflow-definition')

    expect(result.passed).toBe(false)
    expect(result.details.join('\n')).toContain('apps/electron/scripts/verify-upstream-merge.ts')
  })

  /** tag_ref 与 merge 必须沿已验证 LATEST_TAG 的固定 namespaced 数据流。 */
  const invalidTagFlowCases = [
    {
      name: 'tag_ref 使用未验证变量',
      target: 'refs/tags/upstream/$LATEST_TAG',
      replacement: 'refs/tags/upstream/$UNTRUSTED_TAG',
    },
    {
      name: 'tag_ref 使用硬编码错误 tag',
      target: 'refs/tags/upstream/$LATEST_TAG',
      replacement: 'refs/tags/upstream/v0.0.1',
    },
    {
      name: 'merge 使用未验证变量',
      target: 'git merge --no-commit --no-ff "$UPSTREAM_TAG_REF"',
      replacement: 'git merge --no-commit --no-ff "$UNTRUSTED_TAG"',
    },
    {
      name: 'helper 使用硬编码错误 tag',
      target: 'UPSTREAM_TAG_REF: \${{ steps.upstream.outputs.tag_ref }}',
      replacement: 'UPSTREAM_TAG_REF: refs/tags/upstream/v0.0.1',
    },
    {
      name: 'fetch 未写入 upstream namespace',
      target: '+refs/tags/*:refs/tags/upstream/*',
      replacement: '+refs/tags/*:refs/tags/*',
    },
  ]

  for (const tagCase of invalidTagFlowCases) {
    test(`Given ${tagCase.name} When 检查 tag 数据流 Then 明确失败`, () => {
      /** 破坏 namespaced tag 的单一可信来源。 */
      const workflow = validWorkflow.replace(tagCase.target, tagCase.replacement)
      const files = { ...validFiles, '.github/workflows/upstream-compat.yml': workflow }

      expect(workflow).not.toBe(validWorkflow)
      expect(getCheck(files, 'workflow-definition').passed).toBe(false)
    })
  }

  /** uses 只能来自当前验证任务所需的精确 allowlist。 */
  const forbiddenWorkflowActions = [
    'softprops/action-gh-release@v2',
    'peter-evans/create-pull-request@v7',
  ]

  for (const action of forbiddenWorkflowActions) {
    test(`Given workflow 使用 ${action} When 检查 action allowlist Then 明确失败`, () => {
      /** 在 cleanup 前加入未批准 action。 */
      const unsafeStep = `      - name: Unsafe action\n        uses: ${action}\n`
      const workflow = validWorkflow.replace(
        '      - name: Abort merge and remove temporary branch',
        `${unsafeStep}      - name: Abort merge and remove temporary branch`,
      )
      const files = { ...validFiles, '.github/workflows/upstream-compat.yml': workflow }

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

  test('Given tag ref 跳过只读 ref 变量 When 检查线性合同 Then 明确失败', () => {
    /** 直接输出虽可运行，但破坏严格有序的单一数据流合同。 */
    const workflow = validWorkflow
      .replace('          readonly UPSTREAM_TAG_REF="refs/tags/upstream/$LATEST_TAG"\n', '')
      .replace(
        'echo "tag_ref=$UPSTREAM_TAG_REF" >> "$GITHUB_OUTPUT"',
        'echo "tag_ref=refs/tags/upstream/$LATEST_TAG" >> "$GITHUB_OUTPUT"',
      )
    /** 直接输出 tag ref 的仓库 fixture。 */
    const files = {
      ...validFiles,
      '.github/workflows/upstream-compat.yml': workflow,
    }

    expect(workflow).not.toBe(validWorkflow)
    expect(getCheck(files, 'workflow-definition').passed).toBe(false)
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
      target: 'run: bun test apps/electron/scripts/check-fork-compat.test.ts apps/electron/scripts/verify-upstream-merge.test.ts apps/electron/src/main/lib/config-paths.test.ts apps/electron/src/main/lib/lan-bridge apps/electron/src/preload/lan-bridge-preload.test.ts apps/mobile/src/lib',
      replacement: 'run: echo "bun test apps/electron/scripts/check-fork-compat.test.ts apps/electron/scripts/verify-upstream-merge.test.ts apps/electron/src/main/lib/config-paths.test.ts apps/electron/src/main/lib/lan-bridge apps/electron/src/preload/lan-bridge-preload.test.ts apps/mobile/src/lib"',
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
