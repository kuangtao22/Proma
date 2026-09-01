import * as React from 'react'
import type {
  AdoptCanvasTextArtifactRevisionInput,
  CanvasArtifactRevisionSummary,
  CanvasDocumentNode,
  CanvasTarget,
  CanvasTextArtifactMutationResult,
  CanvasTextArtifactSnapshot,
  UpdateCanvasTextArtifactInput,
} from '@proma/shared'
import { Download, FileText, LoaderCircle, RefreshCw, Save } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { LiveMarkdownEditor } from '@/components/markdown/LiveMarkdownEditor'
import { CanvasPublicOperationError } from '@/lib/design-adapter'
import { cn } from '@/lib/utils'
import { CanvasArtifactVersionPanel } from './CanvasArtifactVersionPanel'

/** 文档工作台只依赖文本产物五类 Adapter 能力。 */
export interface CanvasDocumentWorkbenchAdapter {
  loadCanvasTextArtifact: (input: {
    projectId: string
    canvasId: string
    nodeId: string
    kind: 'document'
    contentId: string
    contentRevision: number
  }) => Promise<CanvasTextArtifactSnapshot>
  updateCanvasTextArtifact: (input: UpdateCanvasTextArtifactInput) => Promise<CanvasTextArtifactMutationResult>
  listCanvasArtifactRevisions: (input: {
    projectId: string
    canvasId: string
    nodeId: string
    kind: 'document'
    contentId: string
  }) => Promise<CanvasArtifactRevisionSummary[]>
  adoptCanvasArtifactRevision: (
    input: AdoptCanvasTextArtifactRevisionInput,
  ) => Promise<CanvasTextArtifactMutationResult>
  exportCanvasArtifact: (input: CanvasTextArtifactSnapshot['target']) => Promise<void>
}

/** 工作台向 Workspace 注册的窄草稿提交能力。 */
export interface CanvasDocumentDraftCommitter {
  nodeId: string
  commitDraft: () => Promise<void>
}

/** 文档工作台稳定输入。 */
export interface CanvasDocumentWorkbenchProps {
  node: CanvasDocumentNode
  target: CanvasTarget
  canvasRevision: number
  adapter: CanvasDocumentWorkbenchAdapter
  writable: boolean
  onDirtyChange: (dirty: boolean) => void
  onSnapshotChange: (result: CanvasTextArtifactMutationResult) => void
  onRegisterDraftCommitter?: (committer: CanvasDocumentDraftCommitter) => () => void
}

/** 文档保存命令的显式输入，测试和组件共享同一 revision 合同。 */
export interface CommitCanvasDocumentDraftInput {
  node: CanvasDocumentNode
  target: CanvasTarget
  canvasRevision: number
  content: string
  operationId: string
  update: CanvasDocumentWorkbenchAdapter['updateCanvasTextArtifact']
}

/** 判断当前草稿是否偏离已加载的权威正文。 */
export function isCanvasDocumentDraftDirty(baseline: string, draft: string): boolean {
  return baseline !== draft
}

export interface CanvasDocumentEditorState {
  artifact: CanvasTextArtifactSnapshot | null
  draft: string
  pendingArtifact: CanvasTextArtifactSnapshot | null
}

/** 接收远端正文；dirty 时只暂存更新，非 dirty 时直接切换编辑基线。 */
export function receiveCanvasDocumentArtifact(
  current: CanvasDocumentEditorState,
  nextArtifact: CanvasTextArtifactSnapshot,
): CanvasDocumentEditorState {
  const dirty = current.artifact
    ? isCanvasDocumentDraftDirty(current.artifact.content, current.draft)
    : false
  if (dirty) {
    const pendingRevision = current.pendingArtifact?.target.contentRevision ?? -1
    if (pendingRevision >= nextArtifact.target.contentRevision) return current
    return { ...current, pendingArtifact: nextArtifact }
  }
  return { artifact: nextArtifact, draft: nextArtifact.content, pendingArtifact: null }
}

/** 显式放弃本地草稿并接管已暂存的远端正文。 */
export function acceptPendingCanvasDocumentArtifact(
  current: CanvasDocumentEditorState,
): CanvasDocumentEditorState {
  if (!current.pendingArtifact) return current
  return {
    artifact: current.pendingArtifact,
    draft: current.pendingArtifact.content,
    pendingArtifact: null,
  }
}

/** 仅当远端正文真正替换编辑基线时，才允许解除保存冲突。 */
export function shouldClearCanvasDocumentConflict(
  previousArtifact: CanvasTextArtifactSnapshot | null,
  nextArtifact: CanvasTextArtifactSnapshot | null,
): boolean {
  return nextArtifact !== null && previousArtifact !== nextArtifact
}

/** 使用当前图和正文双重 revision 提交文档草稿。 */
export function commitCanvasDocumentDraft(
  input: CommitCanvasDocumentDraftInput,
): Promise<CanvasTextArtifactMutationResult> {
  return input.update({
    projectId: input.target.projectId,
    canvasId: input.target.canvasId,
    nodeId: input.node.id,
    kind: 'document',
    contentId: input.node.documentId,
    operationId: input.operationId,
    expectedCanvasRevision: input.canvasRevision,
    expectedContentRevision: input.node.contentRevision,
    content: input.content,
  })
}

/** 构造采用历史修订所需的当前双重基线。 */
export function createCanvasDocumentAdoptInput(input: {
  node: CanvasDocumentNode
  target: CanvasTarget
  canvasRevision: number
  revision: number
  operationId: string
}): AdoptCanvasTextArtifactRevisionInput {
  return {
    projectId: input.target.projectId,
    canvasId: input.target.canvasId,
    nodeId: input.node.id,
    kind: 'document',
    contentId: input.node.documentId,
    operationId: input.operationId,
    expectedCanvasRevision: input.canvasRevision,
    expectedContentRevision: input.node.contentRevision,
    revision: input.revision,
  }
}

/** 文档动作错误转换后的稳定 UI 状态。 */
interface CanvasDocumentActionError {
  message: string
  conflict: boolean
}

export interface CanvasDocumentRefreshFailureState {
  phase: 'ready' | 'error'
  blockingError: string | null
  refreshError: string | null
}

/** 区分首次加载失败与已有正文的非破坏性刷新失败。 */
export function getCanvasDocumentRefreshFailureState(
  hasArtifact: boolean,
  message: string,
): CanvasDocumentRefreshFailureState {
  if (hasArtifact) {
    return { phase: 'ready', blockingError: null, refreshError: message }
  }
  return { phase: 'error', blockingError: message, refreshError: null }
}

/** 把 Adapter 错误收口为不泄露内部正文的稳定文档提示。 */
export function getCanvasDocumentActionError(
  error: unknown,
  fallback: string,
): CanvasDocumentActionError {
  if (error instanceof CanvasPublicOperationError
    && error.code === 'CANVAS_ARTIFACT_REVISION_CONFLICT') {
    return { message: '文档已在其他窗口更新，请重新加载后继续。', conflict: true }
  }
  return { message: fallback, conflict: false }
}

/** 文档工作台当前主视图。 */
type CanvasDocumentWorkbenchMode = 'edit' | 'versions'
/** 文档工作台动作状态。 */
type CanvasDocumentActionState = 'idle' | 'saving' | 'adopting' | 'exporting'

export interface CanvasDocumentRequestController {
  /** 启动请求；仅当前目标的最新请求可以提交结果。 */
  run: <T>(
    targetKey: string,
    request: Promise<T>,
    onSuccess: (value: T) => void,
    onFailure?: (error: unknown) => void,
  ) => Promise<void>
  /** 取消当前代次，阻止已离开目标的迟到响应提交状态。 */
  cancel: () => void
}

/** 创建单一资源的请求代次控制器，隔离正文、版本等并行资源的生命周期。 */
export function createCanvasDocumentRequestController(): CanvasDocumentRequestController {
  let generation = 0
  let currentTargetKey: string | null = null
  return {
    run: async <T,>(targetKey: string, request: Promise<T>, onSuccess: (value: T) => void, onFailure?: (error: unknown) => void): Promise<void> => {
      const requestGeneration = ++generation
      currentTargetKey = targetKey
      try {
        const value = await request
        if (requestGeneration !== generation || currentTargetKey !== targetKey) return
        onSuccess(value)
      } catch (error) {
        if (requestGeneration !== generation || currentTargetKey !== targetKey) return
        onFailure?.(error)
      }
    },
    cancel: (): void => {
      generation += 1
      currentTargetKey = null
    },
  }
}

export interface CanvasDocumentArtifactRequestInput<T> {
  targetKey: string
  retryGeneration: number
  load: () => Promise<T>
  onStart?: () => void
  onSuccess: (value: T) => void
  onFailure: (error: unknown) => void
}

export interface CanvasDocumentArtifactRequestHandle {
  /** 标记已由成功读取或本地 mutation 接管的目标，阻止 props 同步造成反向读取。 */
  acceptTargets: (targetKeys: readonly string[]) => void
  /** 清除接管标记，使显式重试可以重新读取当前目标。 */
  clearAcceptedTargets: () => void
}

/** 管理正文请求的 StrictMode 安全生命周期；请求开始不会提前占用目标。 */
export function useCanvasDocumentArtifactRequest<T>(
  input: CanvasDocumentArtifactRequestInput<T>,
): CanvasDocumentArtifactRequestHandle {
  const controller = React.useMemo(createCanvasDocumentRequestController, [])
  /** 仅保存成功接管目标；普通目标切换开始读取时会清空。 */
  const acceptedTargetKeysRef = React.useRef<Set<string>>(new Set())
  /** 回调使用最新 props，同时避免回调身份变化重启请求。 */
  const inputRef = React.useRef(input)
  inputRef.current = input

  React.useEffect(() => {
    if (acceptedTargetKeysRef.current.has(input.targetKey)) return
    acceptedTargetKeysRef.current.clear()
    inputRef.current.onStart?.()
    void controller.run(input.targetKey, inputRef.current.load(),
      (value) => {
        acceptedTargetKeysRef.current.clear()
        acceptedTargetKeysRef.current.add(input.targetKey)
        inputRef.current.onSuccess(value)
      },
      (error) => { inputRef.current.onFailure(error) },
    )
    return () => { controller.cancel() }
  }, [controller, input.retryGeneration, input.targetKey])

  return React.useMemo(() => ({
    acceptTargets: (targetKeys: readonly string[]): void => {
      acceptedTargetKeysRef.current = new Set(targetKeys)
    },
    clearAcceptedTargets: (): void => {
      acceptedTargetKeysRef.current.clear()
    },
  }), [])
}

/** 为单次写操作创建 Renderer 幂等 UUID。 */
function createCanvasDocumentOperationId(): string {
  return globalThis.crypto.randomUUID()
}

/** 文档节点的 Markdown 编辑、版本比较、采用和导出工作台。 */
export function CanvasDocumentWorkbench(
  props: CanvasDocumentWorkbenchProps,
): React.ReactElement {
  const [editorState, setEditorState] = React.useState<CanvasDocumentEditorState>({
    artifact: null,
    draft: '',
    pendingArtifact: null,
  })
  const { artifact, draft, pendingArtifact } = editorState
  /** 编辑器输入只更新草稿，不改变正文 CAS 基线。 */
  const setDraft = React.useCallback((nextDraft: string): void => {
    setEditorState((current) => ({ ...current, draft: nextDraft }))
  }, [])
  const [revisions, setRevisions] = React.useState<CanvasArtifactRevisionSummary[]>([])
  const [phase, setPhase] = React.useState<'loading' | 'ready' | 'error'>('loading')
  const [mode, setMode] = React.useState<CanvasDocumentWorkbenchMode>('edit')
  const [actionState, setActionState] = React.useState<CanvasDocumentActionState>('idle')
  const [error, setError] = React.useState<string | null>(null)
  const [refreshError, setRefreshError] = React.useState<string | null>(null)
  const [conflict, setConflict] = React.useState(false)
  const [retryGeneration, setRetryGeneration] = React.useState(0)
  const [effectiveCanvasRevision, setEffectiveCanvasRevision] = React.useState(props.canvasRevision)
  const [selectedRevision, setSelectedRevision] = React.useState<number | null>(null)
  const [selectedArtifact, setSelectedArtifact] = React.useState<CanvasTextArtifactSnapshot | null>(null)
  const [versionsLoading, setVersionsLoading] = React.useState(true)
  const [selectedContentLoading, setSelectedContentLoading] = React.useState(false)
  const [versionError, setVersionError] = React.useState<string | null>(null)
  /** 历史正文选择使用代次丢弃迟到结果。 */
  const selectedLoadGenerationRef = React.useRef(0)
  /** 记录上一次实际编辑基线，用于区分接管与仅暂存 pending。 */
  const previousArtifactRef = React.useRef<CanvasTextArtifactSnapshot | null>(null)
  /** 版本列表保留独立代次，避免正文完成时取消版本请求。 */
  const revisionsRequestController = React.useMemo(createCanvasDocumentRequestController, [])

  /** 当前文档精确目标，读取与导出共享同一身份。 */
  const documentTarget = React.useMemo(() => ({
    projectId: props.target.projectId,
    canvasId: props.target.canvasId,
    nodeId: props.node.id,
    kind: 'document' as const,
    contentId: props.node.documentId,
    contentRevision: props.node.contentRevision,
  }), [
    props.node.contentRevision,
    props.node.documentId,
    props.node.id,
    props.target.canvasId,
    props.target.projectId,
  ])
  /** 精确目标键只用于判定是否需要读取新的权威正文。 */
  const documentTargetKey = JSON.stringify(documentTarget)
  /** 版本列表按内容身份加载，不因当前正文 revision 更新而重复请求。 */
  const revisionsTarget = React.useMemo(() => ({
    projectId: documentTarget.projectId,
    canvasId: documentTarget.canvasId,
    nodeId: documentTarget.nodeId,
    kind: 'document' as const,
    contentId: documentTarget.contentId,
  }), [
    documentTarget.canvasId,
    documentTarget.contentId,
    documentTarget.nodeId,
    documentTarget.projectId,
  ])
  const revisionsTargetKey = JSON.stringify(revisionsTarget)

  React.useEffect(() => {
    setEffectiveCanvasRevision(props.canvasRevision)
  }, [props.canvasRevision])

  /** 草稿脏状态只比较当前已加载权威正文。 */
  const dirty = artifact ? isCanvasDocumentDraftDirty(artifact.content, draft) : false

  const artifactRequest = useCanvasDocumentArtifactRequest({
    targetKey: documentTargetKey,
    retryGeneration,
    load: () => props.adapter.loadCanvasTextArtifact(documentTarget),
    onStart: () => {
      setRefreshError(null)
      if (!artifact) {
        setPhase('loading')
        setError(null)
        setConflict(false)
      }
    },
    onSuccess: (nextArtifact) => {
      setEditorState((current) => receiveCanvasDocumentArtifact(current, nextArtifact))
      setRefreshError(null)
      setPhase('ready')
    },
    onFailure: (caughtError) => {
      const message = getCanvasDocumentActionError(caughtError, artifact
        ? '文档新版本暂时无法加载，本地内容已保留。'
        : '文档暂时无法加载，请重试。').message
      const failure = getCanvasDocumentRefreshFailureState(Boolean(artifact), message)
      setError(failure.blockingError)
      setRefreshError(failure.refreshError)
      setPhase(failure.phase)
    },
  })

  React.useEffect(() => {
    setVersionsLoading(true)
    setVersionError(null)
    void revisionsRequestController.run(revisionsTargetKey, props.adapter.listCanvasArtifactRevisions(revisionsTarget),
      (nextRevisions) => {
        setRevisions(nextRevisions)
        setVersionsLoading(false)
      },
      () => {
        setVersionError('版本列表暂时无法加载。')
        setVersionsLoading(false)
      },
    )
    return () => { revisionsRequestController.cancel() }
  }, [props.adapter, revisionsRequestController, revisionsTarget, revisionsTargetKey, retryGeneration])

  React.useEffect(() => props.onDirtyChange(dirty), [dirty, props.onDirtyChange])
  React.useEffect(() => {
    const previousArtifact = previousArtifactRef.current
    previousArtifactRef.current = artifact
    if (!artifact) return
    if (shouldClearCanvasDocumentConflict(previousArtifact, artifact)) {
      setError(null)
      setConflict(false)
    }
    setSelectedRevision(artifact.target.contentRevision)
    setSelectedArtifact(artifact)
  }, [artifact])

  /** 接管写操作返回的图与正文，不通过额外 LOAD 猜测新 revision。 */
  const acceptMutationResult = React.useCallback((result: CanvasTextArtifactMutationResult): void => {
    /** 返回 artifact 是新的编辑基线，snapshot 是 Workspace 的图基线。 */
    const nextArtifact = result.artifact
    /** 旧 prop 和即将到达的新 prop 都属于本次已接受事务，均禁止反向读取。 */
    artifactRequest.acceptTargets([documentTargetKey, JSON.stringify(nextArtifact.target)])
    setEditorState({ artifact: nextArtifact, draft: nextArtifact.content, pendingArtifact: null })
    setEffectiveCanvasRevision(result.snapshot.document.revision)
    setRevisions((current) => [
      nextArtifact.revision,
      ...current.filter((revision) => revision.revision !== nextArtifact.revision.revision),
    ])
    setError(null)
    setRefreshError(null)
    setConflict(false)
    props.onSnapshotChange(result)
  }, [artifactRequest, documentTargetKey, props.onSnapshotChange])

  /** 保存按钮和 dirty 切换确认共用唯一提交函数。 */
  const saveDraft = React.useCallback(async (): Promise<void> => {
    if (!artifact || !props.writable || !isCanvasDocumentDraftDirty(artifact.content, draft)) return
    setActionState('saving')
    setError(null)
    try {
      const result = await commitCanvasDocumentDraft({
        node: {
          ...props.node,
          contentRevision: artifact.target.contentRevision,
        },
        target: props.target,
        canvasRevision: effectiveCanvasRevision,
        content: draft,
        operationId: createCanvasDocumentOperationId(),
        update: props.adapter.updateCanvasTextArtifact,
      })
      acceptMutationResult(result)
    } catch (caughtError) {
      const actionError = getCanvasDocumentActionError(caughtError, '文档保存失败，请重试。')
      setError(actionError.message)
      setConflict(actionError.conflict)
      throw caughtError
    } finally {
      setActionState('idle')
    }
  }, [acceptMutationResult, artifact, draft, effectiveCanvasRevision, props.adapter.updateCanvasTextArtifact, props.node, props.target, props.writable])
  /** 最新提交函数通过 ref 供 Workspace 稳定注册。 */
  const saveDraftRef = React.useRef(saveDraft)
  saveDraftRef.current = saveDraft

  React.useEffect(() => props.onRegisterDraftCommitter?.({
    nodeId: props.node.id,
    commitDraft: () => saveDraftRef.current(),
  }), [props.node.id, props.onRegisterDraftCommitter])

  /** 选择历史版本时才按需读取正文，避免展开工作台批量加载全部内容。 */
  const selectRevision = React.useCallback((revision: number): void => {
    setSelectedRevision(revision)
    setVersionError(null)
    if (artifact && revision === artifact.target.contentRevision) {
      selectedLoadGenerationRef.current += 1
      setSelectedArtifact(artifact)
      setSelectedContentLoading(false)
      return
    }
    const generation = ++selectedLoadGenerationRef.current
    setSelectedContentLoading(true)
    void props.adapter.loadCanvasTextArtifact({
      ...documentTarget,
      contentRevision: revision,
    }).then(
      (nextArtifact) => {
        if (generation !== selectedLoadGenerationRef.current) return
        setSelectedArtifact(nextArtifact)
        setSelectedContentLoading(false)
      },
      () => {
        if (generation !== selectedLoadGenerationRef.current) return
        setVersionError('历史版本暂时无法加载。')
        setSelectedArtifact(null)
        setSelectedContentLoading(false)
      },
    )
  }, [artifact, documentTarget, props.adapter.loadCanvasTextArtifact])

  /** 采用已选择的历史 revision，并直接接管返回的权威图与正文。 */
  const adoptRevision = React.useCallback(async (revision: number): Promise<void> => {
    if (!artifact || !props.writable || revision === artifact.target.contentRevision) return
    setActionState('adopting')
    setError(null)
    try {
      const result = await props.adapter.adoptCanvasArtifactRevision(createCanvasDocumentAdoptInput({
        node: { ...props.node, contentRevision: artifact.target.contentRevision },
        target: props.target,
        canvasRevision: effectiveCanvasRevision,
        revision,
        operationId: createCanvasDocumentOperationId(),
      }))
      acceptMutationResult(result)
    } catch (caughtError) {
      const actionError = getCanvasDocumentActionError(caughtError, '版本采用失败，请重试。')
      setError(actionError.message)
      setConflict(actionError.conflict)
    } finally {
      setActionState('idle')
    }
  }, [acceptMutationResult, artifact, effectiveCanvasRevision, props.adapter.adoptCanvasArtifactRevision, props.node, props.target, props.writable])

  /** 导出始终使用当前已采用正文 revision。 */
  const exportArtifact = React.useCallback(async (): Promise<void> => {
    if (!artifact) return
    setActionState('exporting')
    setError(null)
    try {
      await props.adapter.exportCanvasArtifact(artifact.target)
    } catch (caughtError) {
      setError(getCanvasDocumentActionError(caughtError, '文档导出失败，请重试。').message)
    } finally {
      setActionState('idle')
    }
  }, [artifact, props.adapter.exportCanvasArtifact])

  /** 重试仅清理刷新提示并重发当前目标，始终保留编辑基线与草稿。 */
  const retryLoad = React.useCallback((): void => {
    artifactRequest.clearAcceptedTargets()
    setRefreshError(null)
    setRetryGeneration((current) => current + 1)
  }, [artifactRequest])

  /** 用户确认放弃本地草稿后，显式接管远端 pending 正文。 */
  const acceptPendingArtifact = React.useCallback((): void => {
    setEditorState((current) => acceptPendingCanvasDocumentArtifact(current))
    setError(null)
    setRefreshError(null)
    setConflict(false)
  }, [])

  if (phase === 'loading') {
    return (
      <div
        className="flex h-full items-center justify-center gap-2 text-xs text-muted-foreground"
        aria-label="文档工作台内容"
        data-workspace-writable={String(props.writable)}
        role="status"
      >
        <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
        <span>正在加载文档</span>
      </div>
    )
  }

  if (phase === 'error' || !artifact) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center" aria-label="文档工作台内容">
        <FileText className="size-5 text-muted-foreground" aria-hidden="true" />
        <p className="max-w-80 text-xs text-destructive" role="alert">{error ?? '文档暂时无法加载。'}</p>
        <Button type="button" size="sm" variant="outline" onClick={retryLoad}>
          <RefreshCw aria-hidden="true" />重新加载
        </Button>
      </div>
    )
  }

  return (
    <div
      className="grid h-full min-h-0 grid-rows-[auto_minmax(0,1fr)] bg-background"
      aria-label="文档工作台内容"
      data-workspace-writable={String(props.writable)}
    >
      <div className="flex min-w-0 items-center gap-1 border-b border-border px-3 py-2">
        <div className="flex rounded-sm bg-muted p-0.5" aria-label="文档工作台视图">
          <Button type="button" size="sm" variant={mode === 'edit' ? 'secondary' : 'ghost'} aria-pressed={mode === 'edit'} onClick={() => setMode('edit')}>编辑</Button>
          <Button type="button" size="sm" variant={mode === 'versions' ? 'secondary' : 'ghost'} aria-pressed={mode === 'versions'} onClick={() => setMode('versions')}>版本</Button>
        </div>
        <span className="ml-2 min-w-0 flex-1 truncate text-[11px] text-muted-foreground">
          {!props.writable ? '只读' : dirty ? '有未保存更改' : `已保存 v${artifact.target.contentRevision}`}
        </span>
        <Button type="button" size="sm" variant="ghost" disabled={actionState !== 'idle'} onClick={() => { void exportArtifact() }}>
          <Download aria-hidden="true" />导出
        </Button>
        <Button type="button" size="sm" disabled={!props.writable || !dirty || actionState !== 'idle' || conflict} onClick={() => { void saveDraft().catch(() => undefined) }}>
          {actionState === 'saving' ? <LoaderCircle className="animate-spin" aria-hidden="true" /> : <Save aria-hidden="true" />}
          保存
        </Button>
      </div>

      <div className="relative min-h-0">
        {(pendingArtifact || refreshError || error) && (
          <div className="absolute inset-x-3 top-3 z-10 flex flex-col gap-2">
            {pendingArtifact && (
              <div className="flex items-center justify-between gap-3 rounded-sm border border-border bg-background px-3 py-2 text-xs shadow-sm" role="alert">
                <span className="min-w-0 break-words">
                  检测到文档新版本 v{pendingArtifact.target.contentRevision}，本地草稿已保留。
                </span>
                <Button type="button" size="sm" variant="outline" className="shrink-0" onClick={acceptPendingArtifact}>
                  放弃草稿并加载
                </Button>
              </div>
            )}
            {refreshError && (
              <div className="flex items-center justify-between gap-3 rounded-sm border border-border bg-background px-3 py-2 text-xs shadow-sm" role="alert">
                <span className="min-w-0 break-words">{refreshError}</span>
                <Button type="button" size="sm" variant="outline" className="shrink-0" onClick={retryLoad}>
                  <RefreshCw aria-hidden="true" />重试刷新
                </Button>
              </div>
            )}
            {error && (
              <div className={cn(
                'flex items-center justify-between gap-3 rounded-sm border px-3 py-2 text-xs shadow-sm',
                conflict ? 'border-destructive/40 bg-destructive/10 text-destructive' : 'border-border bg-background text-destructive',
              )} role="alert">
                <span className="min-w-0 break-words">{error}</span>
                {conflict && (
                  <Button type="button" size="sm" variant="outline" className="shrink-0" onClick={retryLoad}>
                    <RefreshCw aria-hidden="true" />重新加载
                  </Button>
                )}
              </div>
            )}
          </div>
        )}
        {mode === 'edit' ? (
          <div className="flex h-full min-h-0 flex-col p-3 pt-3">
            {!props.writable && <p className="mb-2 text-xs text-muted-foreground">当前项目只读，仍可查看和导出文档。</p>}
            {!draft && <p className="mb-2 text-xs text-muted-foreground">空文档，可以从正文区开始输入。</p>}
            <div className="min-h-0 flex-1 overflow-hidden rounded-sm border border-border bg-background" aria-label="文档正文编辑器">
              <LiveMarkdownEditor
                value={draft}
                readOnly={!props.writable || conflict}
                className="h-full min-h-0"
                onChange={setDraft}
                onSave={() => { void saveDraft().catch(() => undefined) }}
              />
            </div>
          </div>
        ) : (
          <CanvasArtifactVersionPanel
            revisions={revisions}
            currentRevision={artifact.target.contentRevision}
            selectedRevision={selectedRevision}
            loading={versionsLoading}
            writable={props.writable && !conflict && !dirty}
            adopting={actionState === 'adopting'}
            error={versionError}
            currentContent={artifact.content}
            selectedContent={selectedArtifact?.content}
            selectedContentLoading={selectedContentLoading}
            onSelect={selectRevision}
            onAdopt={(revision) => { void adoptRevision(revision) }}
          />
        )}
      </div>
    </div>
  )
}
