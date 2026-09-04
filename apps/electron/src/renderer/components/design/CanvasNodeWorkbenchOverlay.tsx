import * as React from 'react'
import type { CanvasNode, CanvasNodeKind } from '@proma/shared'
import { MoveDiagonal2, X } from 'lucide-react'
import { Button } from '@/components/ui/button'

/** 工作台可调整尺寸的宽高值。 */
export interface CanvasWorkbenchSize {
  width: number
  height: number
}

/** 工作台在 Canvas surface 内的屏幕像素位置。 */
export interface CanvasWorkbenchPosition {
  x: number
  y: number
}

/** 工作台所属节点在 Canvas surface 内的实时屏幕锚点。 */
export interface CanvasWorkbenchNodeAnchor {
  x: number
  y: number
}

/** 工作台双向缩放计算所需的稳定输入。 */
export interface CanvasWorkbenchResizeInput {
  initialSize: CanvasWorkbenchSize
  pointerDelta: { x: number; y: number }
  canvasScale: { x: number; y: number }
  availableSize: CanvasWorkbenchSize
}

/** 工作台标题拖动计算所需的稳定输入。 */
export interface CanvasWorkbenchMoveInput {
  initialPosition: CanvasWorkbenchPosition
  pointerDelta: CanvasWorkbenchPosition
  workbenchSize: CanvasWorkbenchSize
  surfaceSize: CanvasWorkbenchSize
}

/** 工作台在正常桌面窗口下仍可操作的最小宽度。 */
const CANVAS_WORKBENCH_MIN_WIDTH = 360
/** 工作台在正常桌面窗口下仍可操作的最小高度。 */
const CANVAS_WORKBENCH_MIN_HEIGHT = 320
/** 浮窗与 Canvas surface 边界保持的最小屏幕间距。 */
const CANVAS_WORKBENCH_SURFACE_MARGIN = 12
/** 浮窗与目标节点之间保持的最小屏幕间距。 */
const CANVAS_WORKBENCH_NODE_GAP = 12

/** 单次指针拖拽期间保持不变的尺寸与画布边界。 */
/** 工作台缩放手势控制器依赖。 */
export interface CanvasWorkbenchResizeGestureDependencies {
  /** 高频 move 仅更新 Overlay 局部预览。 */
  onPreview: (size: CanvasWorkbenchSize) => void
  /** 手势结束时把最终尺寸提交到 session view。 */
  onCommit: (size: CanvasWorkbenchSize) => void
}

/** 工作台缩放手势控制器。 */
export interface CanvasWorkbenchResizeGestureController {
  start: (input: CanvasWorkbenchResizeInput) => void
  move: (pointerDelta: CanvasWorkbenchResizeInput['pointerDelta']) => void
  finish: () => void
}

/** 工作台移动手势控制器依赖。 */
export interface CanvasWorkbenchMoveGestureDependencies {
  onPreview: (position: CanvasWorkbenchPosition) => void
  onCommit: (position: CanvasWorkbenchPosition) => void
}

/** 工作台移动手势控制器。 */
export interface CanvasWorkbenchMoveGestureController {
  start: (input: Omit<CanvasWorkbenchMoveInput, 'pointerDelta'>) => void
  move: (pointerDelta: CanvasWorkbenchPosition) => void
  finish: () => void
}

/**
 * 创建只在手势结束时提交全局尺寸的缩放控制器。
 * @param dependencies 局部预览与最终提交回调。
 * @returns 可重复开始、移动和结束的轻量手势控制器。
 */
export function createCanvasWorkbenchResizeGestureController(
  dependencies: CanvasWorkbenchResizeGestureDependencies,
): CanvasWorkbenchResizeGestureController {
  let input: CanvasWorkbenchResizeInput | null = null
  let latestSize: CanvasWorkbenchSize | null = null
  return {
    start: (nextInput) => {
      input = nextInput
      latestSize = nextInput.initialSize
    },
    move: (pointerDelta) => {
      if (!input) return
      latestSize = calculateCanvasWorkbenchResize({ ...input, pointerDelta })
      dependencies.onPreview(latestSize)
    },
    finish: () => {
      if (!input || !latestSize) return
      const finalSize = latestSize
      input = null
      latestSize = null
      dependencies.onCommit(finalSize)
    },
  }
}

/**
 * 创建只在标题拖动结束时提交会话位置的控制器。
 * @param dependencies 局部预览与最终提交回调。
 * @returns 可重复开始、移动和结束的轻量手势控制器。
 */
export function createCanvasWorkbenchMoveGestureController(
  dependencies: CanvasWorkbenchMoveGestureDependencies,
): CanvasWorkbenchMoveGestureController {
  let input: Omit<CanvasWorkbenchMoveInput, 'pointerDelta'> | null = null
  let latestPosition: CanvasWorkbenchPosition | null = null
  return {
    start: (nextInput) => {
      input = nextInput
      latestPosition = nextInput.initialPosition
    },
    move: (pointerDelta) => {
      if (!input) return
      latestPosition = calculateCanvasWorkbenchMove({ ...input, pointerDelta })
      dependencies.onPreview(latestPosition)
    },
    finish: () => {
      if (!input || !latestPosition) return
      const finalPosition = latestPosition
      input = null
      latestPosition = null
      dependencies.onCommit(finalPosition)
    },
  }
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
  /** 浮窗已经位于屏幕空间，Canvas zoom 不参与指针位移换算。 */
  return {
    width: clampCanvasWorkbenchDimension(
      input.initialSize.width + input.pointerDelta.x,
      CANVAS_WORKBENCH_MIN_WIDTH,
      input.availableSize.width,
    ),
    height: clampCanvasWorkbenchDimension(
      input.initialSize.height + input.pointerDelta.y,
      CANVAS_WORKBENCH_MIN_HEIGHT,
      input.availableSize.height,
    ),
  }
}

/** 根据节点类型返回稳定的首次屏幕像素尺寸。 */
export function resolveCanvasWorkbenchDefaultSize(node: CanvasNode): CanvasWorkbenchSize {
  if (node.kind === 'agent') return { width: 760, height: 640 }
  if (node.kind === 'image') return { width: 960, height: 700 }
  if (node.kind === 'document') return { width: 900, height: 700 }
  return node.devicePreset === 'mobile'
    ? { width: 520, height: 720 }
    : { width: 960, height: 720 }
}

/** 将默认或自定义尺寸收进 surface，极小 surface 仍保留 12px 四周边距。 */
export function clampCanvasWorkbenchSizeToSurface(
  size: CanvasWorkbenchSize,
  surfaceSize: CanvasWorkbenchSize,
): CanvasWorkbenchSize {
  const availableSize = {
    width: Math.max(1, surfaceSize.width - CANVAS_WORKBENCH_SURFACE_MARGIN * 2),
    height: Math.max(1, surfaceSize.height - CANVAS_WORKBENCH_SURFACE_MARGIN * 2),
  }
  return calculateCanvasWorkbenchResize({
    initialSize: size,
    pointerDelta: { x: 0, y: 0 },
    canvasScale: { x: 1, y: 1 },
    availableSize,
  })
}

/** 将浮窗位置限制在 surface 内，保证标题栏与缩放手柄可达。 */
export function clampCanvasWorkbenchPosition(
  position: CanvasWorkbenchPosition,
  workbenchSize: CanvasWorkbenchSize,
  surfaceSize: CanvasWorkbenchSize,
): CanvasWorkbenchPosition {
  const maximumX = Math.max(
    CANVAS_WORKBENCH_SURFACE_MARGIN,
    surfaceSize.width - workbenchSize.width - CANVAS_WORKBENCH_SURFACE_MARGIN,
  )
  const maximumY = Math.max(
    CANVAS_WORKBENCH_SURFACE_MARGIN,
    surfaceSize.height - workbenchSize.height - CANVAS_WORKBENCH_SURFACE_MARGIN,
  )
  return {
    x: Math.min(Math.max(position.x, CANVAS_WORKBENCH_SURFACE_MARGIN), maximumX),
    y: Math.min(Math.max(position.y, CANVAS_WORKBENCH_SURFACE_MARGIN), maximumY),
  }
}

/** 根据目标节点屏幕矩形选择右侧、左侧或居中的首次浮窗位置。 */
export function calculateCanvasWorkbenchInitialPosition(input: {
  nodeRect: Pick<DOMRectReadOnly, 'left' | 'right' | 'top'>
  surfaceSize: CanvasWorkbenchSize
  workbenchSize: CanvasWorkbenchSize
}): CanvasWorkbenchPosition {
  const rightPosition = input.nodeRect.right + CANVAS_WORKBENCH_NODE_GAP
  if (rightPosition + input.workbenchSize.width + CANVAS_WORKBENCH_SURFACE_MARGIN <= input.surfaceSize.width) {
    return clampCanvasWorkbenchPosition(
      { x: rightPosition, y: input.nodeRect.top }, input.workbenchSize, input.surfaceSize,
    )
  }
  const leftPosition = input.nodeRect.left - CANVAS_WORKBENCH_NODE_GAP - input.workbenchSize.width
  if (leftPosition >= CANVAS_WORKBENCH_SURFACE_MARGIN) {
    return clampCanvasWorkbenchPosition(
      { x: leftPosition, y: input.nodeRect.top }, input.workbenchSize, input.surfaceSize,
    )
  }
  return clampCanvasWorkbenchPosition({
    x: (input.surfaceSize.width - input.workbenchSize.width) / 2,
    y: (input.surfaceSize.height - input.workbenchSize.height) / 2,
  }, input.workbenchSize, input.surfaceSize)
}

/** 根据标题栏屏幕位移计算并约束浮窗位置。 */
export function calculateCanvasWorkbenchMove(input: CanvasWorkbenchMoveInput): CanvasWorkbenchPosition {
  return clampCanvasWorkbenchPosition({
    x: input.initialPosition.x + input.pointerDelta.x,
    y: input.initialPosition.y + input.pointerDelta.y,
  }, input.workbenchSize, input.surfaceSize)
}

/**
 * 使用节点实时锚点与节点级相对偏移派生工作台屏幕位置。
 * @param nodeAnchor 当前节点左上角的屏幕像素坐标。
 * @param offset 用户为当前节点保存的屏幕像素偏移。
 * @returns 不受 surface 边界夹紧的工作台屏幕位置。
 */
export function resolveCanvasWorkbenchScreenPosition(
  nodeAnchor: CanvasWorkbenchNodeAnchor,
  offset: CanvasWorkbenchPosition,
): CanvasWorkbenchPosition {
  return {
    x: nodeAnchor.x + offset.x,
    y: nodeAnchor.y + offset.y,
  }
}

/**
 * 把工作台最终屏幕位置转换为当前节点独立的相对偏移。
 * @param nodeAnchor 拖动开始时捕获的节点屏幕锚点。
 * @param screenPosition 工作台最终屏幕位置。
 * @returns 可在节点后续移动时复用的屏幕像素偏移。
 */
export function resolveCanvasWorkbenchOffset(
  nodeAnchor: CanvasWorkbenchNodeAnchor,
  screenPosition: CanvasWorkbenchPosition,
): CanvasWorkbenchPosition {
  return {
    x: screenPosition.x - nodeAnchor.x,
    y: screenPosition.y - nodeAnchor.y,
  }
}

/** 节点工作台壳的最小受控输入。 */
export interface CanvasNodeWorkbenchOverlayProps {
  node: CanvasNode
  dirty: boolean
  surfaceSize?: CanvasWorkbenchSize
  nodeScreenRect?: Pick<DOMRectReadOnly, 'left' | 'right' | 'top'>
  /** 当前节点保存的相对偏移；null 表示首次打开。 */
  offset?: CanvasWorkbenchPosition | null
  /** 当前节点保存的自定义尺寸；null 表示使用类型默认值。 */
  size?: CanvasWorkbenchSize | null
  onOffsetChange?: (offset: CanvasWorkbenchPosition) => void
  onSizeChange?: (size: CanvasWorkbenchSize) => void
  /** 迁移期旧调用只用于避免 SSR 崩溃，Workspace 接线完成后不再使用。 */
  workbenchSize?: CanvasWorkbenchSize | null
  onWorkbenchSizeChange?: (size: CanvasWorkbenchSize) => void
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

/** 渲染位于 Canvas surface 上层、不继承 XYFlow transform 的单一工作台壳。 */
export function CanvasNodeWorkbenchOverlay(
  props: CanvasNodeWorkbenchOverlayProps,
): React.ReactElement {
  /** 工作台标签只由稳定节点类型决定。 */
  const label = getCanvasNodeKindLabel(props.node.kind)
  /** SSR 与首次测量前使用稳定桌面边界，客户端 ResizeObserver 随后接管。 */
  const surfaceSize = props.surfaceSize ?? { width: 1_200, height: 800 }
  const nodeScreenRect = props.nodeScreenRect ?? { left: 12, right: 300, top: 12 }
  /** 节点锚点始终来自最新 viewport 投影，负责驱动工作台跟随。 */
  const nodeAnchor = { x: nodeScreenRect.left, y: nodeScreenRect.top }
  /** 默认与自定义尺寸都先受当前 surface 屏幕边界约束。 */
  const effectiveSize = clampCanvasWorkbenchSizeToSurface(
    props.size ?? props.workbenchSize ?? resolveCanvasWorkbenchDefaultSize(props.node),
    surfaceSize,
  )
  /** 已有偏移不做视口夹紧，节点移出视口时工作台必须同步移出。 */
  const effectivePosition = props.offset
    ? resolveCanvasWorkbenchScreenPosition(nodeAnchor, props.offset)
    : calculateCanvasWorkbenchInitialPosition({
        nodeRect: nodeScreenRect,
        surfaceSize,
        workbenchSize: effectiveSize,
      })
  const onSizeChangeRef = React.useRef(props.onSizeChange ?? props.onWorkbenchSizeChange ?? (() => undefined))
  onSizeChangeRef.current = props.onSizeChange ?? props.onWorkbenchSizeChange ?? (() => undefined)
  const onOffsetChangeRef = React.useRef(props.onOffsetChange ?? (() => undefined))
  onOffsetChangeRef.current = props.onOffsetChange ?? (() => undefined)
  /** 指针捕获期间的起点，避免每帧读取 DOM 或全局状态。 */
  const resizeSessionRef = React.useRef<{ pointerId: number; pointerOrigin: CanvasWorkbenchPosition } | null>(null)
  const moveSessionRef = React.useRef<{ pointerId: number; pointerOrigin: CanvasWorkbenchPosition } | null>(null)
  /** 拖动期间固定节点锚点，避免 viewport 同时变化时提交错误偏移。 */
  const moveNodeAnchorRef = React.useRef<CanvasWorkbenchNodeAnchor>(nodeAnchor)
  /** 拖拽预览只更新 Overlay 自身，避免每帧重写全局 view Map。 */
  const [previewSize, setPreviewSize] = React.useState<CanvasWorkbenchSize>(effectiveSize)
  const [previewPosition, setPreviewPosition] = React.useState<CanvasWorkbenchPosition>(effectivePosition)
  const resizeGestureRef = React.useRef<CanvasWorkbenchResizeGestureController | null>(null)
  if (!resizeGestureRef.current) {
    resizeGestureRef.current = createCanvasWorkbenchResizeGestureController({
      onPreview: setPreviewSize,
      onCommit: (size) => onSizeChangeRef.current(size),
    })
  }
  const moveGestureRef = React.useRef<CanvasWorkbenchMoveGestureController | null>(null)
  if (!moveGestureRef.current) {
    moveGestureRef.current = createCanvasWorkbenchMoveGestureController({
      onPreview: setPreviewPosition,
      onCommit: (position) => onOffsetChangeRef.current(
        resolveCanvasWorkbenchOffset(moveNodeAnchorRef.current, position),
      ),
    })
  }
  React.useEffect(() => {
    /** 非手势更新继续服从受控 session view 尺寸。 */
    if (resizeSessionRef.current === null) setPreviewSize(effectiveSize)
    if (moveSessionRef.current === null) setPreviewPosition(effectivePosition)
  }, [effectivePosition.x, effectivePosition.y, effectiveSize.height, effectiveSize.width])
  /** 非标题拖动期间直接使用节点实时投影，避免等待 effect 造成一帧跟随延迟。 */
  const renderedPosition = moveSessionRef.current === null ? effectivePosition : previewPosition
  React.useEffect(() => {
    /** 首次计算后保存节点相对偏移，后续 viewport 更新只重新派生屏幕位置。 */
    if (props.offset === null) {
      onOffsetChangeRef.current(resolveCanvasWorkbenchOffset(nodeAnchor, effectivePosition))
    }
  }, [effectivePosition.x, effectivePosition.y, nodeAnchor.x, nodeAnchor.y, props.offset])

  /** 开始双向缩放并捕获指针，防止拖出手柄后丢失移动事件。 */
  const handleResizePointerDown = React.useCallback((event: React.PointerEvent<HTMLButtonElement>): void => {
    if (event.button !== 0) return
    event.preventDefault()
    event.stopPropagation()
    event.currentTarget.setPointerCapture(event.pointerId)
    resizeSessionRef.current = {
      pointerId: event.pointerId,
      pointerOrigin: { x: event.clientX, y: event.clientY },
    }
    resizeGestureRef.current?.start({
      initialSize: previewSize,
      pointerDelta: { x: 0, y: 0 },
      canvasScale: { x: 1, y: 1 },
      availableSize: {
        width: Math.max(1, surfaceSize.width - previewPosition.x - CANVAS_WORKBENCH_SURFACE_MARGIN),
        height: Math.max(1, surfaceSize.height - previewPosition.y - CANVAS_WORKBENCH_SURFACE_MARGIN),
      },
    })
  }, [previewPosition.x, previewPosition.y, previewSize, surfaceSize.height, surfaceSize.width])

  /** 使用指针位移更新当前工作台宽高，不触发画布节点拖动或文档保存。 */
  const handleResizePointerMove = React.useCallback((event: React.PointerEvent<HTMLButtonElement>): void => {
    const session = resizeSessionRef.current
    if (!session || session.pointerId !== event.pointerId) return
    event.preventDefault()
    event.stopPropagation()
    resizeGestureRef.current?.move({
        x: event.clientX - session.pointerOrigin.x,
        y: event.clientY - session.pointerOrigin.y,
      })
  }, [])

  /** 标题栏按下时开始屏幕空间拖动，关闭按钮不会触发移动。 */
  const handleMovePointerDown = React.useCallback((event: React.PointerEvent<HTMLElement>): void => {
    if (event.button !== 0 || (event.target as HTMLElement).closest('button')) return
    event.preventDefault()
    event.stopPropagation()
    event.currentTarget.setPointerCapture(event.pointerId)
    moveSessionRef.current = {
      pointerId: event.pointerId,
      pointerOrigin: { x: event.clientX, y: event.clientY },
    }
    moveNodeAnchorRef.current = nodeAnchor
    moveGestureRef.current?.start({
      initialPosition: previewPosition,
      workbenchSize: previewSize,
      surfaceSize,
    })
  }, [nodeAnchor, previewPosition, previewSize, surfaceSize])

  /** 标题栏移动只更新 Overlay 局部位置。 */
  const handleMovePointerMove = React.useCallback((event: React.PointerEvent<HTMLElement>): void => {
    const session = moveSessionRef.current
    if (!session || session.pointerId !== event.pointerId) return
    event.preventDefault()
    event.stopPropagation()
    moveGestureRef.current?.move({
      x: event.clientX - session.pointerOrigin.x,
      y: event.clientY - session.pointerOrigin.y,
    })
  }, [])

  /** 标题栏松开时只提交一次最终会话位置。 */
  const finishMove = React.useCallback((event: React.PointerEvent<HTMLElement>): void => {
    const session = moveSessionRef.current
    if (!session || session.pointerId !== event.pointerId) return
    event.preventDefault()
    event.stopPropagation()
    moveSessionRef.current = null
    moveGestureRef.current?.finish()
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
  }, [])

  /** 结束当前缩放手势并释放指针捕获。 */
  const finishResize = React.useCallback((event: React.PointerEvent<HTMLButtonElement>): void => {
    const session = resizeSessionRef.current
    if (!session || session.pointerId !== event.pointerId) return
    event.preventDefault()
    event.stopPropagation()
    resizeSessionRef.current = null
    resizeGestureRef.current?.finish()
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
  }, [])

  return (
    <section
      className="nodrag nopan nowheel absolute z-30 cursor-auto overflow-hidden rounded-[8px] border border-border bg-background text-foreground shadow-xl"
      aria-label={`${label}工作台`}
      data-workbench-kind={props.node.kind}
      data-workbench-dirty={props.dirty || undefined}
      style={{ width: previewSize.width, height: previewSize.height, left: renderedPosition.x, top: renderedPosition.y }}
    >
      <header
        className="flex h-11 shrink-0 touch-none cursor-move items-center justify-between gap-2 border-b border-border px-3"
        onPointerDown={handleMovePointerDown}
        onPointerMove={handleMovePointerMove}
        onPointerUp={finishMove}
        onPointerCancel={finishMove}
        onLostPointerCapture={() => {
          moveSessionRef.current = null
          moveGestureRef.current?.finish()
        }}
      >
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
        onLostPointerCapture={() => {
          resizeSessionRef.current = null
          resizeGestureRef.current?.finish()
        }}
      >
        <MoveDiagonal2 className="size-3.5" aria-hidden="true" />
      </button>
    </section>
  )
}
