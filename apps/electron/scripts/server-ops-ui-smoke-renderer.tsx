import '@fontsource-variable/inter/index.css'
import * as React from 'react'
import { createRoot } from 'react-dom/client'
import type {
  ServerOpsDockerActionCandidate,
  ServerOpsDockerContainerDetail,
  ServerOpsDockerResourcesResult,
  ServerOpsFileCandidate,
  ServerOpsFileEntry,
  ServerOpsFileMutationInput,
  ServerOpsHost,
  ServerOpsTransferSnapshot,
} from '@proma/shared'
import type { ServerOpsFilesPreload } from '../src/preload/server-ops-files-preload'
import type { ServerOpsTransferPreload } from '../src/preload/server-ops-transfer-preload'
import { ServerOpsDockerPanel } from '../src/renderer/components/server-ops/ServerOpsDockerPanel'
import type { ServerOpsDockerPanelApi } from '../src/renderer/components/server-ops/ServerOpsDockerPanel'
import { ServerOpsFilesWorkspace } from '../src/renderer/components/server-ops/ServerOpsFilesWorkspace'
import { ServerOpsWorkspaceView } from '../src/renderer/components/server-ops/ServerOpsWorkspace'
import { useServerOpsTransferLeave } from '../src/renderer/components/server-ops/useServerOpsTransferLeave'
import { Button } from '../src/renderer/components/ui/button'
import '../src/renderer/styles/globals.css'

type SmokeView = 'workspace' | 'files' | 'docker' | 'leave'

/** smoke 使用的固定公开主机资产，不包含凭据。 */
const fixtureHost: ServerOpsHost = {
  id: 'host-ui-smoke',
  name: '生产 API',
  address: '10.20.30.40',
  port: 22,
  username: 'deploy',
  authMethod: 'ssh-agent',
  tags: ['production', 'api'],
  createdAt: 1,
  updatedAt: 1,
}

/** smoke 使用的完整 Docker 容器身份。 */
const fixtureContainerId = 'a'.repeat(64)

/** 返回文件列表中的固定公开条目。 */
function createFileEntries(path: string): ServerOpsFileEntry[] {
  if (path === '/var/log') {
    return [{ name: 'api.log', path: '/var/log/api.log', kind: 'file', size: 18_420, mtime: 1_788_729_600, mode: 0o100640 }]
  }
  return [
    { name: 'var-log', path: '/var/log', kind: 'directory', size: 0, mtime: 1_788_729_600, mode: 0o040755 },
    { name: 'app.conf', path: '/app.conf', kind: 'file', size: 82, mtime: 1_788_729_600, mode: 0o100640 },
    { name: 'current-release', path: '/current-release', kind: 'symlink', size: 14, mtime: 1_788_729_600, mode: 0o120777 },
  ]
}

/** 将任意文件操作转换为仅供 UI 确认流程使用的公开候选。 */
function createFileCandidate(input: ServerOpsFileMutationInput): ServerOpsFileCandidate {
  return {
    candidateId: 'file-candidate-ui-smoke',
    hostId: input.hostId,
    hostName: fixtureHost.name,
    action: input.action,
    path: input.path,
    ...('destinationPath' in input ? { destinationPath: input.destinationPath } : {}),
    ...('targetKind' in input ? { targetKind: input.targetKind } : {}),
    expiresAt: Date.now() + 300_000,
  }
}

/** 文件组件注入的公开 DTO API，不访问磁盘或网络。 */
const fixtureFilesApi: ServerOpsFilesPreload = {
  listServerOpsFiles: async (input) => ({ hostId: input.hostId, path: input.path, entries: createFileEntries(input.path) }),
  previewServerOpsFile: async (input) => input.path === '/current-release'
    ? { hostId: input.hostId, path: input.path, kind: 'symlink', bytesRead: 0, target: '/releases/2026-09-07', stat: { size: 14, mtime: 1_788_729_600, mode: 0o120777 } }
    : {
        hostId: input.hostId,
        path: input.path,
        kind: 'text',
        content: 'PORT=8080\nLOG_LEVEL=info\nMESSAGE=Server Ops fixture\n',
        bytesRead: 55,
        hash: 'b'.repeat(64),
        stat: { size: 55, mtime: 1_788_729_600, mode: 0o100640 },
        editToken: { path: input.path, size: 55, mtime: 1_788_729_600, mode: 0o100640, hash: 'b'.repeat(64) },
      },
  prepareServerOpsFileMutation: async (input) => createFileCandidate(input),
  commitServerOpsFileMutation: async (input) => ({ hostId: input.hostId, action: 'save', path: '/app.conf', outcome: 'success' }),
  cancelServerOpsFileMutation: async () => undefined,
  closeServerOpsFilesOwner: async () => undefined,
}

/** 构造一次文件传输公开快照。 */
function createTransfer(direction: 'upload' | 'download', remotePath: string): ServerOpsTransferSnapshot {
  const fileName = remotePath.split('/').filter(Boolean).at(-1) ?? 'file'
  return {
    transferId: `transfer-${direction}`,
    hostId: fixtureHost.id,
    direction,
    fileName,
    remotePath,
    status: 'succeeded',
    transferredBytes: 82,
    totalBytes: 82,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }
}

/** 传输组件注入的公开 DTO API，选择器返回 null 以避免系统文件访问。 */
const fixtureTransferApi: ServerOpsTransferPreload = {
  selectServerOpsUploadFile: async () => null,
  selectServerOpsDownloadFile: async (_input) => ({ leaseId: 'download-lease-ui-smoke', fileName: 'app.conf', size: 82 }),
  releaseServerOpsFileSelection: async () => undefined,
  startServerOpsTransfer: async (input) => createTransfer(input.direction, input.remotePath),
  listServerOpsTransfers: async () => [],
  cancelServerOpsTransfer: async () => undefined,
  closeServerOpsTransferOwner: async () => undefined,
  onServerOpsTransferProgress: () => () => undefined,
}

/** leave hook smoke 持有的可控关闭 Promise。 */
let resolveTransferClose: (() => void) | null = null
/** leave hook smoke 记录的 owner 关闭次数。 */
let transferCloseCount = 0

/** 为生产 leave hook 注入公开传输 DTO，且不触碰真实 preload。 */
Object.defineProperty(window, 'electronAPI', {
  configurable: true,
  value: {
    listServerOpsTransfers: async (): Promise<ServerOpsTransferSnapshot[]> => [{
      transferId: 'leave-transfer-ui-smoke',
      hostId: fixtureHost.id,
      direction: 'upload',
      fileName: 'release.tar.gz',
      remotePath: '/releases/release.tar.gz',
      status: 'running',
      transferredBytes: 32,
      totalBytes: 128,
      createdAt: 1,
      updatedAt: 2,
    }],
    closeServerOpsTransferOwner: async (): Promise<void> => {
      transferCloseCount += 1
      await new Promise<void>((resolve) => { resolveTransferClose = resolve })
    },
    onServerOpsLogOutput: () => () => undefined,
    onServerOpsLogExit: () => () => undefined,
  },
})

/** 返回 Docker 资源页使用的公开白名单数据。 */
function createDockerResources(hostId: string): ServerOpsDockerResourcesResult {
  return {
    hostId,
    capability: 'available',
    containers: [{
      containerId: fixtureContainerId,
      names: ['api'],
      image: 'registry.example/api:2026.09',
      imageId: `sha256:${'b'.repeat(64)}`,
      state: 'running',
      status: 'Up 4 hours',
      createdAt: '2026-09-07T00:00:00Z',
      publishedPorts: ['127.0.0.1:8080->3000/tcp'],
      mountNames: ['api-data'],
    }],
    images: [{ imageId: `sha256:${'b'.repeat(64)}`, repository: 'registry.example/api', tag: '2026.09', digest: '<none>', createdAt: '2026-09-07T00:00:00Z', size: '120MB' }],
    networks: [{ networkId: 'c'.repeat(64), name: 'frontend', driver: 'bridge', scope: 'local', internal: false }],
    volumes: [{ name: 'api-data', driver: 'local', scope: 'local' }],
    warnings: [],
  }
}

/** 返回容器详情页使用的公开白名单数据。 */
function createContainerDetail(): ServerOpsDockerContainerDetail {
  return {
    containerId: fixtureContainerId,
    name: 'api',
    image: 'registry.example/api:2026.09',
    imageId: `sha256:${'b'.repeat(64)}`,
    createdAt: '2026-09-07T00:00:00Z',
    platform: 'linux/amd64',
    state: 'running',
    running: true,
    exitCode: 0,
    restartCount: 2,
    ports: [{ privatePort: 3000, protocol: 'tcp', publicPort: 8080, address: '127.0.0.1' }],
    mounts: [{ type: 'volume', name: 'api-data', destination: '/data', readOnly: false }],
  }
}

/** 将 Docker 动作转换为仅供确认弹窗展示的短期候选。 */
function createDockerCandidate(action: ServerOpsDockerActionCandidate['action']): ServerOpsDockerActionCandidate {
  return {
    candidateId: 'docker-candidate-ui-smoke',
    hostId: fixtureHost.id,
    action,
    container: createContainerDetail(),
    expiresAt: Date.now() + 300_000,
  }
}

/** Docker 组件注入的公开 DTO API，不执行远程命令。 */
const fixtureDockerApi: ServerOpsDockerPanelApi = {
  listServerOpsDockerResources: async (input) => createDockerResources(input.hostId),
  getServerOpsDockerContainerDetail: async (input) => ({ hostId: input.hostId, capability: 'available', container: createContainerDetail(), warnings: [] }),
  prepareServerOpsDockerAction: async (input) => createDockerCandidate(input.action),
  commitServerOpsDockerAction: async (input) => ({ hostId: input.hostId, containerId: fixtureContainerId, action: 'restart', container: createContainerDetail(), warnings: [] }),
  cancelServerOpsDockerAction: async () => undefined,
}

/** 从 URL 读取当前截图视图，未知值回退到工作区。 */
function readInitialView(): SmokeView {
  const view = new URLSearchParams(window.location.search).get('view')
  return view === 'files' || view === 'docker' || view === 'leave' ? view : 'workspace'
}

/** 直接驱动生产传输离开 hook 的可控交互夹具。 */
function TransferLeaveHarness(): React.ReactElement {
  const [scopeKey, setScopeKey] = React.useState('scope-a')
  const [navigationCount, setNavigationCount] = React.useState(0)
  const [renderVersion, setRenderVersion] = React.useState(0)
  const transferLeave = useServerOpsTransferLeave(scopeKey)

  /** 完成当前 owner 关闭并刷新可观察计数。 */
  const completeClose = (): void => {
    const resolve = resolveTransferClose
    resolveTransferClose = null
    resolve?.()
    setRenderVersion((current) => current + 1)
  }

  return (
    <section className="flex flex-1 flex-col items-center justify-center gap-4 p-6" data-smoke-transfer-leave data-render-version={renderVersion}>
      <div className="flex flex-wrap justify-center gap-2">
        <Button type="button" onClick={() => transferLeave.requestLeave(() => setNavigationCount((current) => current + 1))}>请求离开</Button>
        <Button type="button" variant="outline" onClick={completeClose}>完成关闭</Button>
        <Button type="button" variant="outline" onClick={() => setScopeKey((current) => current === 'scope-a' ? 'scope-b' : 'scope-a')}>切换作用域</Button>
      </div>
      <output className="font-mono text-xs" data-smoke-leave-state data-scope={scopeKey} data-close-count={transferCloseCount} data-navigation-count={navigationCount}>
        scope={scopeKey} close={transferCloseCount} navigation={navigationCount}
      </output>
      {transferLeave.dialog}
    </section>
  )
}

/** 独立 UI smoke 页面，真实组件共享同一主机公开事实。 */
function ServerOpsUiSmokeApp(): React.ReactElement {
  const [view, setView] = React.useState<SmokeView>(readInitialView)
  const [lastAction, setLastAction] = React.useState('尚未触发辅助入口')
  const theme = new URLSearchParams(window.location.search).get('theme') === 'dark' ? 'dark' : 'light'

  React.useEffect(() => {
    document.documentElement.classList.toggle('dark', theme === 'dark')
    document.documentElement.style.colorScheme = theme
    document.body.dataset.smokeReady = 'true'
  }, [theme])

  return (
    <main className="flex h-screen min-h-0 flex-col overflow-hidden bg-background text-foreground" data-server-ops-ui-smoke data-view={view}>
      <header className="flex h-11 shrink-0 items-center gap-2 border-b border-border px-3">
        <span className="mr-auto text-xs font-medium">Server Ops UI Smoke</span>
        {(['workspace', 'files', 'docker'] as const).map((target) => (
          <Button key={target} type="button" size="sm" variant={view === target ? 'secondary' : 'ghost'} data-smoke-view={target} onClick={() => setView(target)}>
            {target === 'workspace' ? '工作区' : target === 'files' ? '文件' : 'Docker'}
          </Button>
        ))}
      </header>
      <div className="flex min-h-0 flex-1 flex-col">
        {view === 'workspace' && (
          <ServerOpsWorkspaceView
            status="ready"
            hosts={[fixtureHost]}
            selectedHost={fixtureHost}
            activeSection="terminal"
            connectionState={{ hostId: fixtureHost.id, phase: 'connected', connectionId: 'connection-ui-smoke' }}
            agentAccessAvailable
            terminalContent={<div className="flex flex-1 items-center justify-center bg-black p-6 font-mono text-sm text-emerald-400">deploy@production-api:~$ systemctl status proma-api</div>}
            onOpenDrawer={() => undefined}
            onCreateHost={() => undefined}
            onEditHost={() => undefined}
            onDeleteHost={() => undefined}
            onSectionChange={() => undefined}
            onDisconnect={() => undefined}
          />
        )}
        {view === 'files' && (
          <ServerOpsFilesWorkspace
            api={fixtureFilesApi}
            transferApi={fixtureTransferApi}
            hostId={fixtureHost.id}
            hostLabel={fixtureHost.name}
            hostDescription={`${fixtureHost.username}@${fixtureHost.address}:${fixtureHost.port}`}
            active
            connected
          />
        )}
        {view === 'docker' && (
          <>
            <ServerOpsDockerPanel
              api={fixtureDockerApi}
              hostId={fixtureHost.id}
              hostLabel={fixtureHost.name}
              hostDescription={`${fixtureHost.username}@${fixtureHost.address}:${fixtureHost.port}`}
              active
              connected
              onOpenContainerLogs={() => setLastAction('已触发容器日志入口')}
              onOpenContainerConsole={() => setLastAction('已触发容器终端入口')}
            />
            <output className="shrink-0 border-t border-border px-3 py-2 text-[11px] text-muted-foreground" data-smoke-last-action>{lastAction}</output>
          </>
        )}
        {view === 'leave' && <TransferLeaveHarness />}
      </div>
    </main>
  )
}

/** 将 smoke 应用挂载到独立页面根节点。 */
const root = document.getElementById('root')
if (!root) throw new Error('SERVER_OPS_UI_SMOKE_ROOT_MISSING')
createRoot(root).render(<ServerOpsUiSmokeApp />)
