import * as React from 'react'
import type {
  AdoptCanvasTextArtifactRevisionInput,
  CanvasArtifactRevisionSummary,
  CanvasTarget,
  CanvasTextArtifactMutationResult,
  CanvasTextArtifactSnapshot,
  CanvasWebviewDevicePreset,
  CanvasWebviewNode,
  CanvasWebviewSnapshot,
  CanvasWebviewTarget,
  UpdateCanvasTextArtifactInput,
} from '@proma/shared'
import { Code2, Download, Eye, LoaderCircle, RefreshCw, Save } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Textarea } from '@/components/ui/textarea'
import { CanvasPublicOperationError } from '@/lib/design-adapter'
import { cn } from '@/lib/utils'
import { CanvasArtifactVersionPanel } from './CanvasArtifactVersionPanel'
import {
  acceptPendingCanvasDocumentArtifact,
  createCanvasDocumentRequestController,
  getCanvasDocumentRefreshFailureState,
  receiveCanvasDocumentArtifact,
  shouldClearCanvasDocumentConflict,
  useCanvasDocumentArtifactRequest,
} from './CanvasDocumentWorkbench'
import {
  CanvasWebviewDeviceSegmentedControl,
  createCanvasWebviewFrameIdentity,
} from './CanvasWebviewPreview'

/** WebView 工作台依赖预览读取和完整文本产物生命周期能力。 */
export interface CanvasWebviewWorkbenchAdapter {
  loadCanvasWebview: (input: CanvasWebviewTarget) => Promise<CanvasWebviewSnapshot>
  loadCanvasTextArtifact: (input: {
    projectId: string
    canvasId: string
    nodeId: string
    kind: 'webview'
    contentId: string
    contentRevision: number
  }) => Promise<CanvasTextArtifactSnapshot>
  updateCanvasTextArtifact: (input: UpdateCanvasTextArtifactInput) => Promise<CanvasTextArtifactMutationResult>
  listCanvasArtifactRevisions: (input: {
    projectId: string
    canvasId: string
    nodeId: string
    kind: 'webview'
    contentId: string
  }) => Promise<CanvasArtifactRevisionSummary[]>
  adoptCanvasArtifactRevision: (input: AdoptCanvasTextArtifactRevisionInput) => Promise<CanvasTextArtifactMutationResult>
  exportCanvasArtifact: (input: CanvasTextArtifactSnapshot['target']) => Promise<void>
}

/** 工作台向 Workspace 注册的窄草稿提交能力。 */
export interface CanvasWebviewDraftCommitter {
  nodeId: string
  commitDraft: () => Promise<void>
}

/** WebView 工作台的稳定公开输入。 */
export interface CanvasWebviewWorkbenchProps {
  node: CanvasWebviewNode
  target: CanvasTarget
  canvasRevision: number
  adapter: CanvasWebviewWorkbenchAdapter
  writable: boolean
  onDirtyChange: (dirty: boolean) => void
  onSnapshotChange: (result: CanvasTextArtifactMutationResult) => void
  onRegisterDraftCommitter?: (committer: CanvasWebviewDraftCommitter) => () => void
  onDevicePresetChange: (nodeId: string, devicePreset: CanvasWebviewDevicePreset) => void
}

/** 原型预览 CSP：允许本地内联交互与 data/blob 媒体，阻断网络、表单和嵌套页面。 */
const CANVAS_WEBVIEW_CSP = [
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

/** 给 Agent 生成的 HTML 注入预览 CSP。 */
export function createSandboxedCanvasWebviewHtml(html: string): string {
  /** CSP 使用双引号属性，策略中的单引号无需额外转义。 */
  const meta = `<meta http-equiv="Content-Security-Policy" content="${CANVAS_WEBVIEW_CSP}">`
  return `<!doctype html>${meta}${html}`
}

/** 判断异步返回的预览是否仍属于当前完整节点身份。 */
export function isCanvasWebviewSnapshotCurrent(
  snapshot: CanvasWebviewSnapshot,
  target: CanvasWebviewTarget,
): boolean {
  return snapshot.target.projectId === target.projectId
    && snapshot.target.canvasId === target.canvasId
    && snapshot.target.nodeId === target.nodeId
    && snapshot.target.prototypeId === target.prototypeId
    && snapshot.target.contentRevision === target.contentRevision
}

/** WebView HTML 编辑器的权威基线、草稿和待接管版本。 */
export interface CanvasWebviewEditorState {
  artifact: CanvasTextArtifactSnapshot | null
  draft: string
  pendingArtifact: CanvasTextArtifactSnapshot | null
}

/** 判断 HTML 草稿是否偏离权威正文。 */
export function isCanvasWebviewDraftDirty(baseline: string, draft: string): boolean {
  return baseline !== draft
}

/** 接收远端 HTML；dirty 时暂存，非 dirty 时自动接管。 */
export function receiveCanvasWebviewArtifact(
  current: CanvasWebviewEditorState,
  nextArtifact: CanvasTextArtifactSnapshot,
): CanvasWebviewEditorState {
  return receiveCanvasDocumentArtifact(current, nextArtifact)
}

/** 放弃本地草稿并接管待处理远端 HTML。 */
export function acceptPendingCanvasWebviewArtifact(
  current: CanvasWebviewEditorState,
): CanvasWebviewEditorState {
  return acceptPendingCanvasDocumentArtifact(current)
}

/** 只有编辑基线实际接管新 artifact 时才允许解除保存冲突。 */
export function shouldClearCanvasWebviewConflict(
  previousArtifact: CanvasTextArtifactSnapshot | null,
  nextArtifact: CanvasTextArtifactSnapshot | null,
): boolean {
  return shouldClearCanvasDocumentConflict(previousArtifact, nextArtifact)
}

/** WebView 保存命令输入。 */
export interface CommitCanvasWebviewDraftInput {
  node: CanvasWebviewNode
  target: CanvasTarget
  canvasRevision: number
  contentRevision: number
  content: string
  operationId: string
  update: CanvasWebviewWorkbenchAdapter['updateCanvasTextArtifact']
}

/** 使用图和 HTML 双重 revision 提交同一原型。 */
export function commitCanvasWebviewDraft(
  input: CommitCanvasWebviewDraftInput,
): Promise<CanvasTextArtifactMutationResult> {
  return input.update({
    projectId: input.target.projectId,
    canvasId: input.target.canvasId,
    nodeId: input.node.id,
    kind: 'webview',
    contentId: input.node.prototypeId,
    operationId: input.operationId,
    expectedCanvasRevision: input.canvasRevision,
    expectedContentRevision: input.contentRevision,
    content: input.content,
  })
}

/** 构造采用历史 HTML 所需的双重 CAS 基线。 */
export function createCanvasWebviewAdoptInput(input: {
  node: CanvasWebviewNode
  target: CanvasTarget
  canvasRevision: number
  contentRevision: number
  revision: number
  operationId: string
}): AdoptCanvasTextArtifactRevisionInput {
  return {
    projectId: input.target.projectId,
    canvasId: input.target.canvasId,
    nodeId: input.node.id,
    kind: 'webview',
    contentId: input.node.prototypeId,
    operationId: input.operationId,
    expectedCanvasRevision: input.canvasRevision,
    expectedContentRevision: input.contentRevision,
    revision: input.revision,
  }
}

/** iframe 键只绑定 HTML 内容身份，Tab 和设备变化不会重建页面。 */
export function createCanvasWebviewFrameKey(target: CanvasTextArtifactSnapshot['target']): string {
  return createCanvasWebviewFrameIdentity({
    projectId: target.projectId,
    canvasId: target.canvasId,
    nodeId: target.nodeId,
    prototypeId: target.contentId,
    contentRevision: target.contentRevision,
    devicePreset: 'desktop',
  })
}

/** iframe 的稳定身份和已采用 HTML；本地草稿不会进入可执行预览。 */
export interface CanvasWebviewFrameState {
  key: string
  srcDoc: string
}

/** 从已接管 artifact 创建 iframe 输入，保存成功前保持完全不变。 */
export function createCanvasWebviewFrameState(
  artifact: CanvasTextArtifactSnapshot,
): CanvasWebviewFrameState {
  return {
    key: createCanvasWebviewFrameKey(artifact.target),
    srcDoc: createSandboxedCanvasWebviewHtml(artifact.content),
  }
}

/** 历史正文请求控制器；完整 artifact 目标变化时可统一作废迟到响应。 */
export interface CanvasWebviewHistoryRequestController {
  run: <T>(
    request: Promise<T>,
    onSuccess: (value: T) => void,
    onFailure?: () => void,
  ) => Promise<void>
  invalidate: () => void
}

/** 创建历史正文请求代次控制器。 */
export function createCanvasWebviewHistoryRequestController(): CanvasWebviewHistoryRequestController {
  let generation = 0
  return {
    run: async <T,>(request: Promise<T>, onSuccess: (value: T) => void, onFailure?: () => void): Promise<void> => {
      const requestGeneration = ++generation
      try {
        const value = await request
        if (requestGeneration === generation) onSuccess(value)
      } catch {
        if (requestGeneration === generation) onFailure?.()
      }
    },
    invalidate: (): void => { generation += 1 },
  }
}

/** WebView 工作台视图与动作状态。 */
type CanvasWebviewWorkbenchMode = 'preview' | 'html' | 'versions'
type CanvasWebviewActionState = 'idle' | 'saving' | 'adopting' | 'exporting'

/** 收口冲突和普通操作错误，避免泄露 HTML 正文。 */
function getCanvasWebviewActionError(error: unknown, fallback: string): { message: string; conflict: boolean } {
  if (error instanceof CanvasPublicOperationError
    && error.code === 'CANVAS_ARTIFACT_REVISION_CONFLICT') {
    return { message: '原型已在其他窗口更新，请重新加载后继续。', conflict: true }
  }
  return { message: fallback, conflict: false }
}

/** 创建单次写操作的 Renderer 幂等 UUID。 */
function createCanvasWebviewOperationId(): string {
  return globalThis.crypto.randomUUID()
}

/**
 * 导出当前已采用 artifact，并把失败收口为独立提示。
 * @returns 成功返回 null；失败返回不影响编辑冲突状态的公开文案。
 */
export async function exportCanvasWebviewArtifact(input: {
  artifact: CanvasTextArtifactSnapshot
  exportArtifact: CanvasWebviewWorkbenchAdapter['exportCanvasArtifact']
}): Promise<string | null> {
  try {
    await input.exportArtifact(input.artifact.target)
    return null
  } catch {
    return '原型导出失败，请重试。'
  }
}

/** WebView 原型的预览、HTML 编辑、版本比较、采用与导出工作台。 */
export function CanvasWebviewWorkbench(props: CanvasWebviewWorkbenchProps): React.ReactElement {
  /** 编辑状态整体更新，确保 dirty 与 pending 基线一致。 */
  const [editorState, setEditorState] = React.useState<CanvasWebviewEditorState>({
    artifact: null,
    draft: '',
    pendingArtifact: null,
  })
  const { artifact, draft, pendingArtifact } = editorState
  /** 视图切换只改变隐藏状态，不卸载 iframe。 */
  const [mode, setMode] = React.useState<CanvasWebviewWorkbenchMode>('preview')
  const [phase, setPhase] = React.useState<'loading' | 'ready' | 'error'>('loading')
  const [actionState, setActionState] = React.useState<CanvasWebviewActionState>('idle')
  const [error, setError] = React.useState<string | null>(null)
  const [exportError, setExportError] = React.useState<string | null>(null)
  const [refreshError, setRefreshError] = React.useState<string | null>(null)
  const [conflict, setConflict] = React.useState(false)
  const [retryGeneration, setRetryGeneration] = React.useState(0)
  const [effectiveCanvasRevision, setEffectiveCanvasRevision] = React.useState(props.canvasRevision)
  /** 版本列表与历史正文独立按需加载。 */
  const [revisions, setRevisions] = React.useState<CanvasArtifactRevisionSummary[]>([])
  const [versionsLoading, setVersionsLoading] = React.useState(true)
  const [selectedRevision, setSelectedRevision] = React.useState<number | null>(null)
  const [selectedArtifact, setSelectedArtifact] = React.useState<CanvasTextArtifactSnapshot | null>(null)
  const [selectedContentLoading, setSelectedContentLoading] = React.useState(false)
  const [versionError, setVersionError] = React.useState<string | null>(null)
  /** 三类异步资源各自保留请求代次。 */
  const revisionsRequestController = React.useMemo(createCanvasDocumentRequestController, [])
  const historyRequestController = React.useMemo(createCanvasWebviewHistoryRequestController, [])
  const previousArtifactRef = React.useRef<CanvasTextArtifactSnapshot | null>(null)

  /** 当前 WebView 的精确文本目标。 */
  const artifactTarget = React.useMemo(() => ({
    projectId: props.target.projectId,
    canvasId: props.target.canvasId,
    nodeId: props.node.id,
    kind: 'webview' as const,
    contentId: props.node.prototypeId,
    contentRevision: props.node.contentRevision,
  }), [props.node.contentRevision, props.node.id, props.node.prototypeId, props.target.canvasId, props.target.projectId])
  const artifactTargetKey = JSON.stringify(artifactTarget)
  /** 版本列表只绑定稳定原型身份。 */
  const revisionsTarget = React.useMemo(() => ({
    projectId: artifactTarget.projectId,
    canvasId: artifactTarget.canvasId,
    nodeId: artifactTarget.nodeId,
    kind: 'webview' as const,
    contentId: artifactTarget.contentId,
  }), [artifactTarget.canvasId, artifactTarget.contentId, artifactTarget.nodeId, artifactTarget.projectId])
  const revisionsTargetKey = JSON.stringify(revisionsTarget)
  /** props 目标与已接管 artifact 任一变化都会切换历史比较作用域。 */
  const historyScopeKey = `${artifactTargetKey}\u0000${artifact ? JSON.stringify(artifact.target) : ''}`

  React.useEffect(() => { setEffectiveCanvasRevision(props.canvasRevision) }, [props.canvasRevision])
  /** dirty 不受 Tab 和设备字段变化影响。 */
  const dirty = artifact ? isCanvasWebviewDraftDirty(artifact.content, draft) : false
  /** 复用文本产物的 StrictMode 安全请求生命周期。 */
  const artifactRequest = useCanvasDocumentArtifactRequest({
    targetKey: artifactTargetKey,
    retryGeneration,
    load: () => props.adapter.loadCanvasTextArtifact(artifactTarget),
    onStart: () => {
      setRefreshError(null)
      if (!artifact) {
        setPhase('loading')
        setError(null)
        setConflict(false)
      }
    },
    onSuccess: (nextArtifact) => {
      setEditorState((current) => receiveCanvasWebviewArtifact(current, nextArtifact))
      setRefreshError(null)
      setPhase('ready')
    },
    onFailure: (caughtError) => {
      const message = getCanvasWebviewActionError(caughtError, artifact
        ? '原型新版本暂时无法加载，本地 HTML 已保留。'
        : '原型暂时无法加载，请重试。').message
      const failure = getCanvasDocumentRefreshFailureState(Boolean(artifact), message)
      setError(failure.blockingError)
      setRefreshError(failure.refreshError)
      setPhase(failure.phase)
    },
  })

  React.useEffect(() => {
    setVersionsLoading(true)
    setVersionError(null)
    void revisionsRequestController.run(
      revisionsTargetKey,
      props.adapter.listCanvasArtifactRevisions(revisionsTarget),
      (nextRevisions) => { setRevisions(nextRevisions); setVersionsLoading(false) },
      () => { setVersionError('版本列表暂时无法加载。'); setVersionsLoading(false) },
    )
    return () => { revisionsRequestController.cancel() }
  }, [props.adapter, retryGeneration, revisionsRequestController, revisionsTarget, revisionsTargetKey])

  React.useEffect(() => props.onDirtyChange(dirty), [dirty, props.onDirtyChange])
  React.useEffect(() => {
    historyRequestController.invalidate()
    setSelectedRevision(null)
    setSelectedArtifact(null)
    setSelectedContentLoading(false)
    setVersionError(null)
    return () => { historyRequestController.invalidate() }
  }, [historyRequestController, historyScopeKey])
  React.useEffect(() => {
    const previousArtifact = previousArtifactRef.current
    previousArtifactRef.current = artifact
    if (!artifact) return
    if (shouldClearCanvasWebviewConflict(previousArtifact, artifact)) {
      setError(null)
      setExportError(null)
      setConflict(false)
    }
    setSelectedRevision(artifact.target.contentRevision)
    setSelectedArtifact(artifact)
  }, [artifact])

  /** 写操作成功后直接接管返回快照，不额外 LOAD。 */
  const acceptMutationResult = React.useCallback((result: CanvasTextArtifactMutationResult): void => {
    const nextArtifact = result.artifact
    artifactRequest.acceptTargets([artifactTargetKey, JSON.stringify(nextArtifact.target)])
    setEditorState({ artifact: nextArtifact, draft: nextArtifact.content, pendingArtifact: null })
    setEffectiveCanvasRevision(result.snapshot.document.revision)
    setRevisions((current) => [nextArtifact.revision, ...current.filter((item) => item.revision !== nextArtifact.revision.revision)])
    setError(null)
    setExportError(null)
    setRefreshError(null)
    setConflict(false)
    props.onSnapshotChange(result)
  }, [artifactRequest, artifactTargetKey, props.onSnapshotChange])

  /** 保存按钮与 Workspace dirty 提交共用同一函数。 */
  const saveDraft = React.useCallback(async (): Promise<void> => {
    if (!artifact || !props.writable || !isCanvasWebviewDraftDirty(artifact.content, draft)) return
    setActionState('saving')
    setError(null)
    try {
      const result = await commitCanvasWebviewDraft({
        node: props.node,
        target: props.target,
        canvasRevision: effectiveCanvasRevision,
        contentRevision: artifact.target.contentRevision,
        content: draft,
        operationId: createCanvasWebviewOperationId(),
        update: props.adapter.updateCanvasTextArtifact,
      })
      acceptMutationResult(result)
    } catch (caughtError) {
      const actionError = getCanvasWebviewActionError(caughtError, '原型保存失败，请重试。')
      setError(actionError.message)
      setConflict(actionError.conflict)
      throw caughtError
    } finally {
      setActionState('idle')
    }
  }, [acceptMutationResult, artifact, draft, effectiveCanvasRevision, props.adapter.updateCanvasTextArtifact, props.node, props.target, props.writable])
  /** 注册始终调用最新保存函数的稳定提交器。 */
  const saveDraftRef = React.useRef(saveDraft)
  saveDraftRef.current = saveDraft
  React.useEffect(() => props.onRegisterDraftCommitter?.({
    nodeId: props.node.id,
    commitDraft: () => saveDraftRef.current(),
  }), [props.node.id, props.onRegisterDraftCommitter])

  /** 选择历史版本时才读取 HTML 正文。 */
  const selectRevision = React.useCallback((revision: number): void => {
    setSelectedRevision(revision)
    setVersionError(null)
    if (artifact && revision === artifact.target.contentRevision) {
      historyRequestController.invalidate()
      setSelectedArtifact(artifact)
      setSelectedContentLoading(false)
      return
    }
    setSelectedContentLoading(true)
    void historyRequestController.run(
      props.adapter.loadCanvasTextArtifact({ ...artifactTarget, contentRevision: revision }),
      (nextArtifact) => {
        setSelectedArtifact(nextArtifact)
        setSelectedContentLoading(false)
      },
      () => {
        setVersionError('历史版本暂时无法加载。')
        setSelectedArtifact(null)
        setSelectedContentLoading(false)
      },
    )
  }, [artifact, artifactTarget, historyRequestController, props.adapter.loadCanvasTextArtifact])

  /** 采用历史 revision 并接管权威结果。 */
  const adoptRevision = React.useCallback(async (revision: number): Promise<void> => {
    if (!artifact || !props.writable || revision === artifact.target.contentRevision) return
    setActionState('adopting')
    setError(null)
    try {
      const result = await props.adapter.adoptCanvasArtifactRevision(createCanvasWebviewAdoptInput({
        node: props.node,
        target: props.target,
        canvasRevision: effectiveCanvasRevision,
        contentRevision: artifact.target.contentRevision,
        revision,
        operationId: createCanvasWebviewOperationId(),
      }))
      acceptMutationResult(result)
    } catch (caughtError) {
      const actionError = getCanvasWebviewActionError(caughtError, '版本采用失败，请重试。')
      setError(actionError.message)
      setConflict(actionError.conflict)
    } finally {
      setActionState('idle')
    }
  }, [acceptMutationResult, artifact, effectiveCanvasRevision, props.adapter.adoptCanvasArtifactRevision, props.node, props.target, props.writable])

  /** 导出当前已采用 HTML revision。 */
  const exportArtifact = React.useCallback(async (): Promise<void> => {
    if (!artifact) return
    setActionState('exporting')
    setExportError(null)
    try {
      const nextExportError = await exportCanvasWebviewArtifact({
        artifact,
        exportArtifact: props.adapter.exportCanvasArtifact,
      })
      setExportError(nextExportError)
    } finally {
      setActionState('idle')
    }
  }, [artifact, props.adapter.exportCanvasArtifact])

  /** 重试保留现有基线与草稿。 */
  const retryLoad = React.useCallback((): void => {
    artifactRequest.clearAcceptedTargets()
    setRefreshError(null)
    setRetryGeneration((current) => current + 1)
  }, [artifactRequest])
  /** 显式放弃草稿并接管 pending HTML。 */
  const acceptPendingArtifact = React.useCallback((): void => {
    setEditorState((current) => acceptPendingCanvasWebviewArtifact(current))
    setError(null)
    setExportError(null)
    setRefreshError(null)
    setConflict(false)
  }, [])

  if (phase === 'loading') {
    return (
      <div className="flex h-full min-h-0 flex-col bg-muted/20" aria-label="原型预览">
        <div className="flex h-10 shrink-0 items-center justify-end border-b border-border bg-background px-3">
          <CanvasWebviewDeviceSegmentedControl devicePreset={props.node.devicePreset} writable={props.writable} onDevicePresetChange={(preset) => props.onDevicePresetChange(props.node.id, preset)} />
        </div>
        <div className="flex min-h-0 flex-1 items-center justify-center gap-2 text-xs text-muted-foreground" data-device-preset={props.node.devicePreset} role="status">
          <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
          <span>正在加载原型</span>
        </div>
      </div>
    )
  }
  if (phase === 'error' || !artifact) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center" aria-label="原型预览">
        <Code2 className="size-5 text-muted-foreground" aria-hidden="true" />
        <p className="max-w-80 text-xs text-destructive" role="alert">{error ?? '原型暂时无法加载。'}</p>
        <Button type="button" size="sm" variant="outline" onClick={retryLoad}><RefreshCw aria-hidden="true" />重新加载</Button>
      </div>
    )
  }

  /** 预览只执行已接管 artifact，编辑 draft 不会触发 iframe reload。 */
  const frameState = createCanvasWebviewFrameState(artifact)

  return (
    <div className="grid h-full min-h-0 grid-rows-[auto_minmax(0,1fr)] bg-background" aria-label="原型预览">
      <div className="flex min-w-0 items-center gap-2 border-b border-border px-3 py-2">
        <Tabs value={mode} onValueChange={(value) => {
          if (value === 'preview' || value === 'html' || value === 'versions') setMode(value)
        }}>
          <TabsList className="h-8">
            <TabsTrigger value="preview" className="h-7 gap-1.5 px-2.5 text-xs"><Eye aria-hidden="true" />预览</TabsTrigger>
            <TabsTrigger value="html" className="h-7 gap-1.5 px-2.5 text-xs"><Code2 aria-hidden="true" />HTML</TabsTrigger>
            <TabsTrigger value="versions" className="h-7 px-2.5 text-xs">版本</TabsTrigger>
          </TabsList>
        </Tabs>
        <span className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground">{!props.writable ? '只读' : dirty ? '有未保存更改' : `已保存 v${artifact.target.contentRevision}`}</span>
        <CanvasWebviewDeviceSegmentedControl devicePreset={props.node.devicePreset} writable={props.writable} onDevicePresetChange={(preset) => props.onDevicePresetChange(props.node.id, preset)} />
        <Button type="button" size="sm" variant="ghost" disabled={actionState !== 'idle'} onClick={() => { void exportArtifact() }}><Download aria-hidden="true" />导出</Button>
        <Button type="button" size="sm" disabled={!props.writable || !dirty || actionState !== 'idle' || conflict} onClick={() => { void saveDraft().catch(() => undefined) }}>{actionState === 'saving' ? <LoaderCircle className="animate-spin" aria-hidden="true" /> : <Save aria-hidden="true" />}保存</Button>
      </div>

      <div className="relative min-h-0">
        {(pendingArtifact || refreshError || error || exportError) && (
          <div className="absolute inset-x-3 top-3 z-20 flex flex-col gap-2">
            {pendingArtifact && <div className="flex items-center justify-between gap-3 rounded-sm border border-border bg-background px-3 py-2 text-xs shadow-sm" role="alert"><span>检测到原型新版本 v{pendingArtifact.target.contentRevision}，本地 HTML 已保留。</span><Button type="button" size="sm" variant="outline" onClick={acceptPendingArtifact}>放弃草稿并加载</Button></div>}
            {refreshError && <div className="flex items-center justify-between gap-3 rounded-sm border border-border bg-background px-3 py-2 text-xs shadow-sm" role="alert"><span>{refreshError}</span><Button type="button" size="sm" variant="outline" onClick={retryLoad}><RefreshCw aria-hidden="true" />重试刷新</Button></div>}
            {error && <div className={cn('flex items-center justify-between gap-3 rounded-sm border px-3 py-2 text-xs shadow-sm', conflict ? 'border-destructive/40 bg-destructive/10 text-destructive' : 'border-border bg-background text-destructive')} role="alert"><span>{error}</span>{conflict && <Button type="button" size="sm" variant="outline" onClick={retryLoad}><RefreshCw aria-hidden="true" />重新加载</Button>}</div>}
            {exportError && <div className="rounded-sm border border-border bg-background px-3 py-2 text-xs text-destructive shadow-sm" role="alert">{exportError}</div>}
          </div>
        )}

        <div className="absolute inset-0 flex items-center justify-center overflow-auto bg-muted/20 p-3" data-device-preset={props.node.devicePreset} hidden={mode !== 'preview'}>
          <div className={props.node.devicePreset === 'mobile' ? 'h-full max-h-[844px] w-auto max-w-full overflow-hidden rounded-[8px] border border-border bg-white shadow-sm aspect-[390/844]' : 'h-full w-full overflow-hidden bg-white'}>
            <iframe key={frameState.key} className="h-full w-full border-0 bg-white" title={`${props.node.title}预览`} sandbox="allow-scripts" srcDoc={frameState.srcDoc} />
          </div>
        </div>

        <div className="absolute inset-0 flex min-h-0 flex-col p-3" hidden={mode !== 'html'}>
          {!props.writable && <p className="mb-2 text-xs text-muted-foreground">当前项目只读，仍可查看和导出 HTML。</p>}
          {!draft && <p className="mb-2 text-xs text-muted-foreground">空原型，可以从编辑区开始输入 HTML。</p>}
          <Textarea value={draft} readOnly={!props.writable || conflict} spellCheck={false} aria-label="HTML 编辑器" className="min-h-0 flex-1 resize-none rounded-sm font-mono text-xs leading-5" onChange={(event) => setEditorState((current) => ({ ...current, draft: event.target.value }))} />
        </div>

        <div className="absolute inset-0" hidden={mode !== 'versions'}>
          <CanvasArtifactVersionPanel revisions={revisions} currentRevision={artifact.target.contentRevision} selectedRevision={selectedRevision} loading={versionsLoading} writable={props.writable && !conflict && !dirty} adopting={actionState === 'adopting'} error={versionError} currentContent={artifact.content} selectedContent={selectedArtifact?.content} selectedContentLoading={selectedContentLoading} onSelect={selectRevision} onAdopt={(revision) => { void adoptRevision(revision) }} />
        </div>
      </div>
    </div>
  )
}
