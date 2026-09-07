import * as React from 'react'
import { AlertTriangle, Fingerprint, LoaderCircle, RefreshCw, ShieldX } from 'lucide-react'
import type {
  ServerOpsTrustAction,
  ServerOpsTrustCandidate,
  ServerOpsTrustResult,
  ServerOpsTrustSnapshot,
} from '@proma/shared'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

/** 信任弹窗当前可公开展示的状态。 */
export interface ServerOpsTrustProjection {
  hostId: string | null
  status: 'idle' | 'loading' | 'ready' | 'error'
  snapshot: ServerOpsTrustSnapshot | null
  candidate: ServerOpsTrustCandidate | null
  error: string | null
  warning: string | null
}

/** 信任控制器依赖的最小 IPC 合同。 */
interface ServerOpsTrustControllerOptions {
  get: (input: { hostId: string }) => Promise<ServerOpsTrustSnapshot>
  prepare: (input: { hostId: string; action: ServerOpsTrustAction }) => Promise<ServerOpsTrustCandidate>
  commit: (input: { hostId: string; candidateId: string; confirmationName: string }) => Promise<ServerOpsTrustResult>
  cancel: (input: { hostId: string; candidateId: string }) => Promise<void>
  publish: (projection: ServerOpsTrustProjection) => void
  onCommitted?: (result: ServerOpsTrustResult) => void
}

/** 信任控制器公开动作，所有异步动作共享身份与代次门禁。 */
export interface ServerOpsTrustController {
  activate: () => void
  dispose: () => void
  select: (hostId: string | null) => Promise<void>
  refresh: () => Promise<void>
  prepare: (action: ServerOpsTrustAction) => Promise<void>
  commit: (confirmationName: string) => Promise<void>
  cancelCandidate: () => Promise<void>
}

/** 允许 Renderer 展示的稳定信任错误文案。 */
const SERVER_OPS_TRUST_ERROR_MESSAGES: Readonly<Record<string, string>> = {
  SERVER_OPS_ACCESS_DENIED: '当前窗口无权管理服务器信任',
  SERVER_OPS_OTHER_INSTANCE_ACTIVE: '请先关闭其他 Proma 实例，再变更服务器信任',
  SERVER_OPS_CONFIG_BUSY: '服务器配置正忙，请稍后重试',
  SERVER_OPS_TRUST_BUSY: '服务器信任操作正忙，请稍后重试',
  SERVER_OPS_TRUST_CANDIDATE_EXPIRED: '本次确认已过期，请重新准备',
  SERVER_OPS_TRUST_CANDIDATE_UNAVAILABLE: '当前服务器没有可执行的信任变更',
  SERVER_OPS_TRUST_CONFLICT: '服务器状态已变化，请刷新后重试',
  SERVER_OPS_TRUST_NAME_MISMATCH: '服务器名称不匹配',
  SERVER_OPS_AUDIT_WRITE_FAILED: '开始审计写入失败，信任未修改',
  SERVER_OPS_TRUST_DURABILITY_UNCONFIRMED: '信任已更新，但持久化确认失败',
  SERVER_OPS_TRUST_GUARD_RELEASE_FAILED: '信任已更新，但本地实例保护释放失败，请重启应用后继续',
  SERVER_OPS_TRUST_RESULT_UNKNOWN: '信任变更结果未知，请刷新核对',
  SERVER_OPS_CONFIG_OUTCOME_UNKNOWN: '信任变更结果未知，请不要重复提交，并刷新核对',
  SERVER_OPS_HOST_NOT_FOUND: '服务器已不存在，请刷新列表',
}

/** 从异常中只提取白名单错误码，避免把底层异常或秘密带入界面。 */
export function getServerOpsTrustErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : ''
  const code = Object.keys(SERVER_OPS_TRUST_ERROR_MESSAGES).find((candidate) => message.includes(candidate))
  return code ? SERVER_OPS_TRUST_ERROR_MESSAGES[code]! : '服务器信任操作失败'
}

/** 创建可抵御关闭、切主机和请求迟到的信任管理控制器。 */
export function createServerOpsTrustController(options: ServerOpsTrustControllerOptions): ServerOpsTrustController {
  let active = false
  let hostId: string | null = null
  let revision = 0
  let projection: ServerOpsTrustProjection = {
    hostId: null, status: 'idle', snapshot: null, candidate: null, error: null, warning: null,
  }

  /** 仅在当前 owner 活跃时发布不可变投影。 */
  const publish = (next: ServerOpsTrustProjection): void => {
    projection = next
    if (active) options.publish(next)
  }
  /** 判断异步结果是否仍属于当前主机和请求代次。 */
  const isCurrent = (expectedHostId: string, expectedRevision: number): boolean => (
    active && hostId === expectedHostId && revision === expectedRevision
  )
  /** 取消精确候选；取消失败不暴露底层异常，也不阻塞关闭或切换。 */
  const cancelExact = (candidate: ServerOpsTrustCandidate | null): void => {
    if (!candidate) return
    void options.cancel({ hostId: candidate.hostId, candidateId: candidate.candidateId }).catch(() => undefined)
  }
  /** fresh-read 当前主机，并让错误保留上次公开快照以便用户重试。 */
  const load = async (expectedHostId: string): Promise<void> => {
    const operationRevision = ++revision
    publish({ ...projection, hostId: expectedHostId, status: 'loading',
      snapshot: projection.snapshot?.hostId === expectedHostId ? projection.snapshot : null,
      candidate: null, error: null, warning: null })
    try {
      const snapshot = await options.get({ hostId: expectedHostId })
      if (!isCurrent(expectedHostId, operationRevision)) return
      publish({ hostId: expectedHostId, status: 'ready', snapshot, candidate: null, error: null, warning: null })
    } catch (error) {
      if (!isCurrent(expectedHostId, operationRevision)) return
      publish({ ...projection, status: 'error', error: getServerOpsTrustErrorMessage(error) })
    }
  }

  return {
    activate: () => {
      if (active) return
      active = true
      revision += 1
    },
    dispose: () => {
      active = false
      revision += 1
      cancelExact(projection.candidate)
      hostId = null
      projection = { hostId: null, status: 'idle', snapshot: null, candidate: null, error: null, warning: null }
    },
    select: async (nextHostId) => {
      cancelExact(projection.candidate)
      revision += 1
      hostId = nextHostId
      if (!nextHostId) {
        publish({ hostId: null, status: 'idle', snapshot: null, candidate: null, error: null, warning: null })
        return
      }
      await load(nextHostId)
    },
    refresh: async () => {
      if (!active || !hostId) return
      cancelExact(projection.candidate)
      await load(hostId)
    },
    prepare: async (action) => {
      if (!active || !hostId || !projection.snapshot || projection.status === 'loading') return
      const expectedHostId = hostId
      const operationRevision = ++revision
      cancelExact(projection.candidate)
      publish({ ...projection, status: 'loading', candidate: null, error: null, warning: null })
      try {
        const candidate = await options.prepare({ hostId: expectedHostId, action })
        if (!isCurrent(expectedHostId, operationRevision)) {
          cancelExact(candidate)
          return
        }
        publish({ ...projection, status: 'ready', snapshot: candidate, candidate, error: null })
      } catch (error) {
        if (!isCurrent(expectedHostId, operationRevision)) return
        publish({ ...projection, status: 'error', error: getServerOpsTrustErrorMessage(error) })
      }
    },
    commit: async (confirmationName) => {
      if (!active || !hostId || !projection.candidate || projection.status === 'loading') return
      const candidate = projection.candidate
      const expectedHostId = hostId
      const operationRevision = ++revision
      publish({ ...projection, status: 'loading', error: null, warning: null })
      try {
        const result = await options.commit({ hostId: expectedHostId, candidateId: candidate.candidateId, confirmationName })
        if (!isCurrent(expectedHostId, operationRevision)) return
        /** 提交成功立即清除候选；后续展示刷新失败也不能恢复提交入口。 */
        const warning = result.warning === 'SERVER_OPS_AUDIT_WRITE_FAILED'
          ? '信任已更新，但结果审计记录写入失败'
          : result.warning ? getServerOpsTrustErrorMessage(new Error(result.warning)) : null
        publish({ ...projection, candidate: null, snapshot: null, warning })
        options.onCommitted?.(result)
        const snapshot = await options.get({ hostId: expectedHostId })
        if (!isCurrent(expectedHostId, operationRevision)) return
        publish({
          hostId: expectedHostId,
          status: 'ready',
          snapshot,
          candidate: null,
          error: null,
          warning,
        })
      } catch (error) {
        if (!isCurrent(expectedHostId, operationRevision)) return
        cancelExact(projection.candidate)
        publish({ ...projection, candidate: null, status: 'error', error: getServerOpsTrustErrorMessage(error) })
      }
    },
    cancelCandidate: async () => {
      if (!active || !hostId || !projection.candidate) return
      const candidate = projection.candidate
      const expectedHostId = hostId
      const operationRevision = ++revision
      publish({ ...projection, status: 'loading', error: null, warning: null })
      try {
        await options.cancel({ hostId: candidate.hostId, candidateId: candidate.candidateId })
        if (!isCurrent(expectedHostId, operationRevision)) return
        publish({ ...projection, status: 'ready', candidate: null, error: null })
      } catch (error) {
        if (!isCurrent(expectedHostId, operationRevision)) return
        publish({ ...projection, status: 'error', error: getServerOpsTrustErrorMessage(error) })
      }
    },
  }
}

/** 指纹字段显示公开算法与 SHA256 指纹。 */
function ServerOpsTrustKey({ label, value, dangerous = false }: {
  label: string
  value: ServerOpsTrustSnapshot['trustedKey']
  dangerous?: boolean
}): React.ReactElement {
  return (
    <div className="min-w-0 py-2">
      <div className="mb-1 text-[11px] text-muted-foreground">{label}</div>
      {value ? (
        <div className={dangerous ? 'text-destructive' : 'text-foreground'}>
          <div className="text-[11px]">{value.algorithm}</div>
          <div className="break-all font-mono text-xs">{value.fingerprint}</div>
        </div>
      ) : <div className="text-xs text-muted-foreground">无</div>}
    </div>
  )
}

/** 可独立验证的信任管理弹窗正文。 */
export function ServerOpsTrustDialogView({
  status,
  snapshot,
  candidate,
  confirmationName,
  error,
  warning,
  onRefresh,
  onPrepare,
  onConfirmationNameChange,
  onCommit,
  onCancelCandidate,
}: {
  status: ServerOpsTrustProjection['status']
  snapshot: ServerOpsTrustSnapshot | null
  candidate: ServerOpsTrustCandidate | null
  confirmationName: string
  error: string | null
  warning: string | null
  onRefresh: () => void
  onPrepare: (action: ServerOpsTrustAction) => void
  onConfirmationNameChange: (name: string) => void
  onCommit: () => void
  onCancelCandidate: () => void
}): React.ReactElement {
  const loading = status === 'loading'
  const canReplace = Boolean(snapshot?.trustedKey && snapshot.observedKey
    && (snapshot.trustedKey.algorithm !== snapshot.observedKey.algorithm
      || snapshot.trustedKey.fingerprint !== snapshot.observedKey.fingerprint))
  const canRevoke = Boolean(snapshot?.trustedKey)
  const confirmed = Boolean(candidate && confirmationName === candidate.name)

  return (
    <div className="grid min-w-0 gap-4" data-server-ops-trust-layout="responsive">
      {(error || warning) && (
        <div className="flex items-start gap-2 border-y border-border py-2 text-xs" role="alert">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-destructive" aria-hidden="true" />
          <span className="min-w-0 flex-1 break-words">{error ?? warning}</span>
          <Button type="button" variant="ghost" size="icon-sm" aria-label="刷新服务器信任" disabled={loading} onClick={onRefresh}>
            <RefreshCw className="size-3.5" aria-hidden="true" />
          </Button>
        </div>
      )}
      {!snapshot ? (
        <div className="flex min-h-40 items-center justify-center gap-2 text-xs text-muted-foreground" role="status">
          {loading ? <><LoaderCircle className="size-3.5 animate-spin" aria-hidden="true" />正在读取服务器信任...</> : '没有可显示的信任信息'}
        </div>
      ) : (
        <>
          <div className="min-w-0 border-y border-border py-3">
            <div className="text-xs font-medium">{snapshot.name}</div>
            <div className="mt-1 break-all font-mono text-[11px] text-muted-foreground">{snapshot.address}:{snapshot.port}</div>
          </div>
          <div className="grid min-w-0 grid-cols-1 divide-y divide-border sm:grid-cols-2 sm:divide-x sm:divide-y-0">
            <ServerOpsTrustKey label="已信任指纹" value={snapshot.trustedKey} />
            <div className="sm:pl-4"><ServerOpsTrustKey label="新观测指纹" value={snapshot.observedKey} dangerous={Boolean(snapshot.observedKey)} /></div>
          </div>
          <div className="min-w-0">
            <div className="mb-1.5 text-[11px] text-muted-foreground">同一 endpoint 受影响服务器</div>
            <div className="flex flex-wrap gap-1.5">
              {snapshot.affectedHosts.map((host) => <span key={host.id} className="rounded-sm border border-border px-2 py-1 text-[11px]">{host.name}</span>)}
            </div>
          </div>
          {candidate ? (
            <div className="grid gap-3 border-t border-border pt-4">
              <div className="text-xs leading-5">
                {candidate.action === 'replace' ? '替换指纹' : '撤销信任'}会断开同 endpoint 的连接并撤销其 Agent 权限。提交后不会自动连接。
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="server-ops-trust-confirmation" className="text-xs">请输入服务器显示名“{candidate.name}”</Label>
                <Input
                  id="server-ops-trust-confirmation"
                  autoFocus
                  autoComplete="off"
                  value={confirmationName}
                  disabled={loading}
                  onChange={(event) => onConfirmationNameChange(event.target.value)}
                />
              </div>
              <DialogFooter className="gap-2 sm:space-x-0">
                <Button type="button" variant="outline" disabled={loading} onClick={onCancelCandidate}>取消本次变更</Button>
                <Button
                  type="button"
                  variant="destructive"
                  data-server-ops-trust-commit="true"
                  disabled={loading || !confirmed}
                  onClick={onCommit}
                >
                  {loading ? <LoaderCircle className="size-3.5 animate-spin" aria-hidden="true" /> : null}
                  确认{candidate.action === 'replace' ? '替换' : '撤销'}
                </Button>
              </DialogFooter>
            </div>
          ) : (
            <div className="flex flex-col gap-2 border-t border-border pt-4 sm:flex-row sm:justify-end">
              <Button type="button" variant="outline" data-trust-action="replace" disabled={loading || !canReplace} onClick={() => onPrepare('replace')}>
                <Fingerprint className="size-3.5" aria-hidden="true" />替换为新指纹
              </Button>
              <Button type="button" variant="destructive" data-trust-action="revoke" disabled={loading || !canRevoke} onClick={() => onPrepare('revoke')}>
                <ShieldX className="size-3.5" aria-hidden="true" />撤销信任
              </Button>
            </div>
          )}
        </>
      )}
    </div>
  )
}

/** 服务器信任管理弹窗，打开时才读取权威快照。 */
export function ServerOpsTrustDialog({ open, hostId, onOpenChange, onCommitted }: {
  open: boolean
  hostId: string | null
  onOpenChange: (open: boolean) => void
  onCommitted?: (result: ServerOpsTrustResult) => void
}): React.ReactElement {
  const [projection, setProjection] = React.useState<ServerOpsTrustProjection>({
    hostId: null, status: 'idle', snapshot: null, candidate: null, error: null, warning: null,
  })
  const [confirmationName, setConfirmationName] = React.useState('')
  /** 提交通知始终使用当前父视图回调，避免捕获首次打开时的页签状态。 */
  const committedRef = React.useRef(onCommitted)
  committedRef.current = onCommitted
  const [controller] = React.useState(() => createServerOpsTrustController({
    get: (input) => window.electronAPI.getServerOpsTrust(input),
    prepare: (input) => window.electronAPI.prepareServerOpsTrust(input),
    commit: (input) => window.electronAPI.commitServerOpsTrust(input),
    cancel: (input) => window.electronAPI.cancelServerOpsTrust(input),
    publish: setProjection,
    onCommitted: (result) => committedRef.current?.(result),
  }))

  React.useEffect(() => {
    controller.activate()
    return () => controller.dispose()
  }, [controller])

  React.useEffect(() => {
    setConfirmationName('')
    void controller.select(open ? hostId : null)
  }, [controller, hostId, open])

  /** 关闭前先撤销精确候选，主进程不会保留过期确认。 */
  const handleOpenChange = (nextOpen: boolean): void => {
    if (!nextOpen) void controller.select(null)
    onOpenChange(nextOpen)
  }

  /** render 首帧就隐藏上一主机投影，不等待 effect 处理选中身份。 */
  const visibleProjection: ServerOpsTrustProjection = open && projection.hostId === hostId ? projection : {
    hostId, status: open ? 'loading' : 'idle', snapshot: null, candidate: null, error: null, warning: null,
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-h-[min(90vh,42rem)] w-[calc(100vw-1rem)] max-w-xl overflow-y-auto rounded-md p-4 sm:p-5">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-base"><Fingerprint className="size-4" aria-hidden="true" />管理服务器信任</DialogTitle>
          <DialogDescription className="text-xs">核对 SSH 主机身份，并显式替换或撤销本地信任。</DialogDescription>
        </DialogHeader>
        <ServerOpsTrustDialogView
          {...visibleProjection}
          confirmationName={confirmationName}
          onRefresh={() => { setConfirmationName(''); void controller.refresh() }}
          onPrepare={(action) => { setConfirmationName(''); void controller.prepare(action) }}
          onConfirmationNameChange={setConfirmationName}
          onCommit={() => { void controller.commit(confirmationName) }}
          onCancelCandidate={() => { setConfirmationName(''); void controller.cancelCandidate() }}
        />
      </DialogContent>
    </Dialog>
  )
}
