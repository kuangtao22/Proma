import * as React from 'react'
import type {
  CanvasDocument,
  CanvasNodeLifecycleResult,
  CanvasTarget,
  CanvasTrashEntry,
  DesignPoint,
  RestoreCanvasNodeInput,
} from '@proma/shared'
import { ArchiveRestore, LoaderCircle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  findNativeCanvasGlobalAppendPosition,
  overlapsNativeCanvasNodes,
} from './native-canvas-model'

/** 回收区列表和单项恢复共享的轻量 UI 状态。 */
export interface NativeCanvasTrashState {
  entries: CanvasTrashEntry[]
  loading: boolean
  restoringTrashId: string | null
  error: string | null
}

/** 回收区控制器依赖，所有异步结果通过代次隔离 Canvas 切换。 */
export interface NativeCanvasTrashControllerDependencies {
  target: CanvasTarget
  listTrash: (target: CanvasTarget) => Promise<CanvasTrashEntry[]>
  restoreNode: (input: RestoreCanvasNodeInput) => Promise<CanvasNodeLifecycleResult>
  createId: () => string
  getDocument: () => CanvasDocument
  getEmptyCanvasCenter: () => DesignPoint
  onStateChange: (state: NativeCanvasTrashState) => void
  onRestored: (result: CanvasNodeLifecycleResult, nodeId: string) => void
}

/** 回收区按需加载和恢复命令。 */
export interface NativeCanvasTrashController {
  load: () => Promise<void>
  restore: (entry: CanvasTrashEntry) => Promise<void>
  cancel: () => void
}

/**
 * 计算恢复位置；原位置仍空闲时不改变，发生占用才显式全局追加。
 * @param entry 待恢复条目的删除前位置。
 * @param document 当前权威 Canvas 文档。
 * @param emptyCanvasCenter 空图中心，仅为算法完整性保留。
 * @returns 主进程恢复命令使用的显式位置。
 */
export function resolveNativeCanvasTrashRestorePosition(
  entry: CanvasTrashEntry,
  document: CanvasDocument,
  emptyCanvasCenter: DesignPoint,
): DesignPoint {
  if (!overlapsNativeCanvasNodes(entry.position, document.nodes)) return entry.position
  return findNativeCanvasGlobalAppendPosition(emptyCanvasCenter, document.nodes)
}

/** 创建只在调用 load 时访问回收区的控制器。 */
export function createNativeCanvasTrashController(
  dependencies: NativeCanvasTrashControllerDependencies,
): NativeCanvasTrashController {
  let state: NativeCanvasTrashState = {
    entries: [],
    loading: false,
    restoringTrashId: null,
    error: null,
  }
  let generation = 0
  let disposed = false
  /** 同一恢复失败重试必须复用完整 operation。 */
  const restoreOperations = new Map<string, RestoreCanvasNodeInput>()
  /** 只发布当前控制器代次的完整状态，避免局部字段漂移。 */
  const updateState = (update: Partial<NativeCanvasTrashState>): void => {
    state = { ...state, ...update }
    dependencies.onStateChange(state)
  }
  return {
    load: async () => {
      const requestGeneration = generation
      updateState({ loading: true, error: null })
      try {
        const entries = await dependencies.listTrash(dependencies.target)
        if (disposed || generation !== requestGeneration) return
        updateState({ entries, loading: false, error: null })
      } catch {
        if (disposed || generation !== requestGeneration) return
        updateState({ loading: false, error: '回收区暂时无法加载。' })
      }
    },
    restore: async (entry) => {
      if (state.restoringTrashId) return
      const requestGeneration = generation
      let operation = restoreOperations.get(entry.trashId)
      if (!operation) {
        const document = dependencies.getDocument()
        operation = {
          ...dependencies.target,
          operationId: dependencies.createId(),
          trashId: entry.trashId,
          expectedRevision: document.revision,
          position: resolveNativeCanvasTrashRestorePosition(
            entry,
            document,
            dependencies.getEmptyCanvasCenter(),
          ),
        }
        restoreOperations.set(entry.trashId, operation)
      }
      updateState({ restoringTrashId: entry.trashId, error: null })
      try {
        const result = await dependencies.restoreNode(operation)
        if (disposed || generation !== requestGeneration) return
        restoreOperations.delete(entry.trashId)
        updateState({
          entries: state.entries.filter((current) => current.trashId !== entry.trashId),
          restoringTrashId: null,
          error: null,
        })
        dependencies.onRestored(result, entry.nodeId)
      } catch {
        if (disposed || generation !== requestGeneration) return
        updateState({ restoringTrashId: null, error: '节点恢复失败，请重试。' })
      }
    },
    cancel: () => {
      disposed = true
      generation += 1
      restoreOperations.clear()
    },
  }
}

/** 回收区弹窗输入；数据加载由 Workspace 在 open 边界显式触发。 */
export interface NativeCanvasTrashDialogProps extends NativeCanvasTrashState {
  open: boolean
  onOpenChange: (open: boolean) => void
  onRestore: (entry: CanvasTrashEntry) => void
}

/** 回收列表展示输入，供弹窗与无 DOM 测试共用真实内容。 */
export interface NativeCanvasTrashEntriesProps extends NativeCanvasTrashState {
  onRestore: (entry: CanvasTrashEntry) => void
}

/** 回收条目类型的稳定中文标签。 */
const TRASH_KIND_LABELS: Record<CanvasTrashEntry['kind'], string> = {
  image: '生图',
  document: '文档',
  webview: '原型',
}

/** 以本地中文格式展示删除时间，不持久化派生文案。 */
function formatCanvasTrashDeletedAt(deletedAt: number): string {
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit',
    hour12: false,
  }).format(deletedAt)
}

/** 渲染回收区的加载、空、错误和恢复中状态。 */
export function NativeCanvasTrashEntries({
  entries,
  loading,
  restoringTrashId,
  error,
  onRestore,
}: NativeCanvasTrashEntriesProps): React.ReactElement {
  if (loading) {
    return (
      <div className="flex min-h-32 items-center justify-center gap-2 text-sm text-muted-foreground" role="status">
        <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />正在加载
      </div>
    )
  }
  if (error && entries.length === 0) {
    return <p className="py-8 text-center text-sm text-destructive" role="alert">{error}</p>
  }
  if (entries.length === 0) return <p className="py-8 text-center text-sm text-muted-foreground">回收区为空</p>
  return (
    <>
      {error ? <p className="pb-2 text-sm text-destructive" role="alert">{error}</p> : null}
      <ul className="divide-y divide-border">
        {entries.map((entry) => {
          const restoring = restoringTrashId === entry.trashId
          return (
            <li key={entry.trashId} className="flex min-w-0 items-center gap-3 py-3">
              <div className="min-w-0 flex-1">
                <div className="flex min-w-0 items-center gap-2">
                  <span className="shrink-0 text-xs font-medium text-primary">{TRASH_KIND_LABELS[entry.kind]}</span>
                  <span className="truncate text-sm font-medium">{entry.title}</span>
                </div>
                <p className="mt-1 text-xs text-muted-foreground">删除于 {formatCanvasTrashDeletedAt(entry.deletedAt)}</p>
              </div>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={restoringTrashId !== null}
                aria-label={`恢复 ${entry.title}`}
                onClick={() => onRestore(entry)}
              >
                {restoring ? <LoaderCircle className="animate-spin" aria-hidden="true" /> : <ArchiveRestore aria-hidden="true" />}
                {restoring ? '恢复中' : '恢复'}
              </Button>
            </li>
          )
        })}
      </ul>
    </>
  )
}

/** 展示内容节点回收区的加载、空、错误和恢复中状态。 */
export function NativeCanvasTrashDialog({
  open,
  entries,
  loading,
  restoringTrashId,
  error,
  onOpenChange,
  onRestore,
}: NativeCanvasTrashDialogProps): React.ReactElement {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>回收区</DialogTitle>
          <DialogDescription>恢复内容节点及其稳定内容身份。</DialogDescription>
        </DialogHeader>
        <div className="max-h-[min(60vh,28rem)] min-h-32 overflow-y-auto">
          <NativeCanvasTrashEntries
            entries={entries}
            loading={loading}
            restoringTrashId={restoringTrashId}
            error={error}
            onRestore={onRestore}
          />
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>关闭</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
