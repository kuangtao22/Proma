import * as React from 'react'
import type { CanvasNode, CanvasNodeKind } from '@proma/shared'
import { MoveDiagonal2, X } from 'lucide-react'
import { Button } from '@/components/ui/button'

/** 工作台可调整尺寸的宽高值。 */
export interface CanvasWorkbenchSize {
  width: number
  height: number
}

/** 工作台双向缩放计算所需的稳定输入。 */
export interface CanvasWorkbenchResizeInput {
  initialSize: CanvasWorkbenchSize
  pointerDelta: { x: number; y: number }
  canvasScale: { x: number; y: number }
  availableSize: CanvasWorkbenchSize
}

/** 工作台在正常桌面窗口下仍可操作的最小宽度。 */
const CANVAS_WORKBENCH_MIN_WIDTH = 360
/** 工作台在正常桌面窗口下仍可操作的最小高度。 */
const CANVAS_WORKBENCH_MIN_HEIGHT = 320

/** 单次指针拖拽期间保持不变的尺寸与画布边界。 */
interface CanvasWorkbenchResizeSession extends CanvasWorkbenchResizeInput {
  pointerId: number
  pointerOrigin: { x: number; y: number }
}

/** 将数值限制在下限与可用上限之间；窄画布优先保证不越界。 */
function clampCanvasWorkbenchDimension(value: number, minimum: number, maximum: number): number {
  const safeMaximum = Math.max(1, maximum)
  return Math.min(Math.max(value, Math.min(minimum, safeMaximum)), safeMaximum)
}

/**
 * 根据屏幕指针位移计算画布坐标内的工作台尺寸。
 * @param input 初始尺寸、屏幕位移、Canvas 缩放比例与剩余可视空间。
 * @returns 同时受最小尺寸和画布可视边界约束的宽高。
 */
export function calculateCanvasWorkbenchResize(input: CanvasWorkbenchResizeInput): CanvasWorkbenchSize {
  const scaleX = input.canvasScale.x > 0 ? input.canvasScale.x : 1
  const scaleY = input.canvasScale.y > 0 ? input.canvasScale.y : 1
  return {
    width: clampCanvasWorkbenchDimension(
      input.initialSize.width + input.pointerDelta.x / scaleX,
      CANVAS_WORKBENCH_MIN_WIDTH,
      input.availableSize.width,
    ),
    height: clampCanvasWorkbenchDimension(
      input.initialSize.height + input.pointerDelta.y / scaleY,
      CANVAS_WORKBENCH_MIN_HEIGHT,
      input.availableSize.height,
    ),
  }
}

/** 节点工作台壳的最小受控输入。 */
export interface CanvasNodeWorkbenchOverlayProps {
  node: CanvasNode
  dirty: boolean
  onDirtyChange: (dirty: boolean) => void
  onClose: () => void
  children?: React.ReactNode
}

/** 返回四类节点的稳定中文名称。 */
export function getCanvasNodeKindLabel(kind: CanvasNodeKind): string {
  if (kind === 'agent') return 'Agent'
  if (kind === 'image') return '生图'
  if (kind === 'document') return '文档'
  return '原型'
}

/** 返回非 Agent 基础工作台的稳定下一步，不读取节点正文。 */
function getCanvasNodeNextAction(kind: Exclude<CanvasNodeKind, 'agent'>): string {
  if (kind === 'image') return '下一步：配置提示词并选择模型'
  if (kind === 'document') return '下一步：开始撰写内容'
  return '下一步：创建 HTML 原型'
}

/** 渲染随 XYFlow 节点移动的单一工作台壳。 */
export function CanvasNodeWorkbenchOverlay(
  props: CanvasNodeWorkbenchOverlayProps,
): React.ReactElement {
  /** 工作台标签只由稳定节点类型决定。 */
  const label = getCanvasNodeKindLabel(props.node.kind)
  /** 工作台 DOM 用于读取 Canvas 缩放后的真实可视边界。 */
  const workbenchRef = React.useRef<HTMLElement>(null)
  /** 尺寸只在当前工作台挂载期间保留，不写入 Canvas 文档。 */
  const [workbenchSize, setWorkbenchSize] = React.useState<CanvasWorkbenchSize | null>(null)
  /** 指针捕获期间的起点与边界，避免每帧重复测量布局。 */
  const resizeSessionRef = React.useRef<CanvasWorkbenchResizeSession | null>(null)

  /** 从当前布局读取缩放比例和右下方剩余空间。 */
  const readResizeInput = React.useCallback((): Omit<CanvasWorkbenchResizeInput, 'pointerDelta'> | null => {
    const workbench = workbenchRef.current
    if (!workbench) return null
    const workbenchRect = workbench.getBoundingClientRect()
    const layoutWidth = workbench.offsetWidth || workbenchRect.width
    const layoutHeight = workbench.offsetHeight || workbenchRect.height
    /** React Flow 根节点代表实际可见画布；测试或降级环境使用浏览器视口。 */
    const canvasSurface = workbench.closest('.react-flow')
    const canvasRect = canvasSurface?.getBoundingClientRect()
    const viewportWidth = typeof window === 'undefined' ? workbenchRect.right : window.innerWidth
    const viewportHeight = typeof window === 'undefined' ? workbenchRect.bottom : window.innerHeight
    const boundaryRight = canvasRect?.right ?? viewportWidth
    const boundaryBottom = canvasRect?.bottom ?? viewportHeight
    const canvasScale = {
      x: workbenchRect.width > 0 && layoutWidth > 0 ? workbenchRect.width / layoutWidth : 1,
      y: workbenchRect.height > 0 && layoutHeight > 0 ? workbenchRect.height / layoutHeight : 1,
    }
    return {
      initialSize: { width: layoutWidth, height: layoutHeight },
      canvasScale,
      availableSize: {
        width: Math.max(1, (boundaryRight - workbenchRect.left) / canvasScale.x),
        height: Math.max(1, (boundaryBottom - workbenchRect.top) / canvasScale.y),
      },
    }
  }, [])

  React.useEffect(() => {
    /** 首次打开或窗口变化时把详情收进可见画布，确保右下角手柄始终可达。 */
    const clampWorkbenchToCanvas = (): void => {
      const resizeInput = readResizeInput()
      if (!resizeInput) return
      setWorkbenchSize(calculateCanvasWorkbenchResize({
        ...resizeInput,
        pointerDelta: { x: 0, y: 0 },
      }))
    }
    clampWorkbenchToCanvas()
    window.addEventListener('resize', clampWorkbenchToCanvas)
    /** Canvas 容器尺寸改变时同步收敛，不观察工作台自身以避免 resize 反馈循环。 */
    const canvasSurface = workbenchRef.current?.closest('.react-flow')
    const canvasResizeObserver = typeof ResizeObserver === 'undefined' || !canvasSurface
      ? null
      : new ResizeObserver(clampWorkbenchToCanvas)
    if (canvasSurface) canvasResizeObserver?.observe(canvasSurface)
    return () => {
      window.removeEventListener('resize', clampWorkbenchToCanvas)
      canvasResizeObserver?.disconnect()
    }
  }, [readResizeInput])

  /** 开始双向缩放并捕获指针，防止拖出手柄后丢失移动事件。 */
  const handleResizePointerDown = React.useCallback((event: React.PointerEvent<HTMLButtonElement>): void => {
    if (event.button !== 0) return
    const resizeInput = readResizeInput()
    if (!resizeInput) return
    event.preventDefault()
    event.stopPropagation()
    event.currentTarget.setPointerCapture(event.pointerId)
    resizeSessionRef.current = {
      ...resizeInput,
      pointerDelta: { x: 0, y: 0 },
      pointerId: event.pointerId,
      pointerOrigin: { x: event.clientX, y: event.clientY },
    }
  }, [readResizeInput])

  /** 使用指针位移更新当前工作台宽高，不触发画布节点拖动或文档保存。 */
  const handleResizePointerMove = React.useCallback((event: React.PointerEvent<HTMLButtonElement>): void => {
    const session = resizeSessionRef.current
    if (!session || session.pointerId !== event.pointerId) return
    event.preventDefault()
    event.stopPropagation()
    setWorkbenchSize(calculateCanvasWorkbenchResize({
      initialSize: session.initialSize,
      pointerDelta: {
        x: event.clientX - session.pointerOrigin.x,
        y: event.clientY - session.pointerOrigin.y,
      },
      canvasScale: session.canvasScale,
      availableSize: session.availableSize,
    }))
  }, [])

  /** 结束当前缩放手势并释放指针捕获。 */
  const finishResize = React.useCallback((event: React.PointerEvent<HTMLButtonElement>): void => {
    const session = resizeSessionRef.current
    if (!session || session.pointerId !== event.pointerId) return
    event.preventDefault()
    event.stopPropagation()
    resizeSessionRef.current = null
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
  }, [])

  return (
    <section
      ref={workbenchRef}
      className="nodrag nopan nowheel absolute left-0 top-[calc(100%+8px)] z-30 h-[min(620px,calc(100vh-9rem))] w-[min(720px,calc(100vw-2rem))] cursor-auto overflow-hidden rounded-[8px] border border-border bg-background text-foreground shadow-xl"
      aria-label={`${label}工作台`}
      data-workbench-dirty={props.dirty || undefined}
      style={workbenchSize ?? undefined}
    >
      <header className="flex h-11 shrink-0 items-center justify-between gap-2 border-b border-border px-3">
        <span className="min-w-0 truncate text-sm font-medium">{props.node.title}</span>
        <Button
          type="button"
          size="icon"
          variant="ghost"
          aria-label={`收起${label}工作台`}
          onClick={props.onClose}
        >
          <X className="size-4" aria-hidden="true" />
        </Button>
      </header>
      <div className="relative h-[calc(100%-2.75rem)] min-h-0 [&>aside]:static [&>aside]:h-full [&>aside]:max-w-none [&>aside]:border-l-0 [&>aside]:shadow-none [&>aside>header]:hidden">
        {props.children ?? (
          <div className="flex h-full flex-col items-center justify-center gap-2 p-4 text-center text-sm text-muted-foreground">
            <p>{label}节点已创建</p>
            {props.node.kind === 'agent'
              ? <p>Agent 对话暂不可用</p>
              : <p>{getCanvasNodeNextAction(props.node.kind)}</p>}
          </div>
        )}
      </div>
      <button
        type="button"
        className="nodrag nopan nowheel absolute bottom-1 right-1 z-40 flex size-6 touch-none items-center justify-center rounded-sm border border-border bg-background/90 text-muted-foreground shadow-sm cursor-se-resize hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        aria-label="调整工作台大小"
        title="拖拽调整工作台大小"
        onClick={(event) => event.stopPropagation()}
        onPointerDown={handleResizePointerDown}
        onPointerMove={handleResizePointerMove}
        onPointerUp={finishResize}
        onPointerCancel={finishResize}
        onLostPointerCapture={() => { resizeSessionRef.current = null }}
      >
        <MoveDiagonal2 className="size-3.5" aria-hidden="true" />
      </button>
    </section>
  )
}
