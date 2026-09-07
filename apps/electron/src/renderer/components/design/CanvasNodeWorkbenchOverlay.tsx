import * as React from 'react'
import type { CanvasLayoutRect, CanvasNode, CanvasNodeKind, DesignViewport } from '@proma/shared'
import { MoveDiagonal2, X } from 'lucide-react'
import { Button } from '@/components/ui/button'

/** 工作台在画布坐标系中的宽高。 */
export interface CanvasWorkbenchSize {
  width: number
  height: number
}

/** 工作台双向缩放计算所需的稳定输入。 */
export interface CanvasWorkbenchResizeInput {
  initialSize: CanvasWorkbenchSize
  pointerDelta: { x: number; y: number }
  canvasScale: { x: number; y: number }
  /** 资源上限而非视口剩余空间，详情越界后由画布裁剪。 */
  availableSize: CanvasWorkbenchSize
}

/** 工作台常规最小宽高，已在高倍缩放下打开的更小尺寸不会跳大。 */
const CANVAS_WORKBENCH_MIN_WIDTH = 360
const CANVAS_WORKBENCH_MIN_HEIGHT = 320
/** 世界尺寸保持有界，同时容纳 5% 缩放时首次展开的详情面积。 */
const CANVAS_WORKBENCH_MAX_DIMENSION = 32_768
/** 卡片与详情之间的固定画布间距，随卡片共同缩放。 */
const CANVAS_WORKBENCH_NODE_GAP = 12
/** 首次打开时在屏幕四周预留的空间，不约束后续移动或自定义尺寸。 */
const CANVAS_WORKBENCH_INITIAL_MARGIN = 12

/** 工作台缩放手势控制器依赖。 */
export interface CanvasWorkbenchResizeGestureDependencies {
  /** 高频 move 仅更新当前详情的局部预览。 */
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

/** 创建只在手势结束时提交全局尺寸的控制器，重复结束不会二次提交。 */
export function createCanvasWorkbenchResizeGestureController(
  dependencies: CanvasWorkbenchResizeGestureDependencies,
): CanvasWorkbenchResizeGestureController {
  /** 起始尺寸与缩放只在本次手势内有效。 */
  let input: CanvasWorkbenchResizeInput | null = null
  /** 最新局部预览供结束时一次提交。 */
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

/** 非法缩放按 1 处理，防止除零或产生非有限 CSS 尺寸。 */
function validCanvasScale(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 1
}

/** 将尺寸限制在正数资源上限内，不使用详情当前屏幕位置。 */
function clampCanvasWorkbenchDimension(value: number, minimum: number, maximum: number): number {
  const safeMaximum = Math.max(1, maximum)
  return Math.min(Math.max(value, Math.min(minimum, safeMaximum)), safeMaximum)
}

/** 将屏幕指针位移换算为画布尺寸，保留最小尺寸和调用方资源上限。 */
export function calculateCanvasWorkbenchResize(input: CanvasWorkbenchResizeInput): CanvasWorkbenchSize {
  return {
    width: clampCanvasWorkbenchDimension(
      input.initialSize.width + input.pointerDelta.x / validCanvasScale(input.canvasScale.x),
      Math.min(CANVAS_WORKBENCH_MIN_WIDTH, input.initialSize.width), input.availableSize.width,
    ),
    height: clampCanvasWorkbenchDimension(
      input.initialSize.height + input.pointerDelta.y / validCanvasScale(input.canvasScale.y),
      Math.min(CANVAS_WORKBENCH_MIN_HEIGHT, input.initialSize.height), input.availableSize.height,
    ),
  }
}

/** 根据节点类型返回首次打开所需的屏幕像素尺寸。 */
export function resolveCanvasWorkbenchDefaultSize(node: CanvasNode): CanvasWorkbenchSize {
  if (node.kind === 'agent') return { width: 760, height: 640 }
  if (node.kind === 'image') return { width: 960, height: 700 }
  if (node.kind === 'audio') return { width: 720, height: 560 }
  if (node.kind === 'video') return { width: 960, height: 700 }
  if (node.kind === 'document') return { width: 900, height: 700 }
  return node.devicePreset === 'mobile' ? { width: 520, height: 720 } : { width: 960, height: 720 }
}

/** 将首次屏幕面积换算为画布尺寸；之后交由同一 viewport transform 缩放。 */
function initialCanvasWorkbenchSize(node: CanvasNode, surface: CanvasWorkbenchSize, zoom: number): CanvasWorkbenchSize {
  const defaults = resolveCanvasWorkbenchDefaultSize(node)
  return {
    width: Math.min(CANVAS_WORKBENCH_MAX_DIMENSION, Math.max(1,
      Math.min(defaults.width, surface.width - CANVAS_WORKBENCH_INITIAL_MARGIN * 2)) / validCanvasScale(zoom)),
    height: Math.min(CANVAS_WORKBENCH_MAX_DIMENSION, Math.max(1,
      Math.min(defaults.height, surface.height - CANVAS_WORKBENCH_INITIAL_MARGIN * 2)) / validCanvasScale(zoom)),
  }
}

/** 固定在卡片下方的详情壳，位置没有独立的用户状态。 */
export interface CanvasNodeWorkbenchOverlayProps {
  node: CanvasNode
  dirty: boolean
  /** 卡片基准世界矩形与真实尺寸；尚未提交的拖动位移由外层位置壳补偿。 */
  nodeBounds: CanvasLayoutRect
  /** 仅首次展开时用于换算尺寸；平移缩放由 ViewportPortal 处理。 */
  viewport?: DesignViewport
  surfaceSize?: CanvasWorkbenchSize
  /** 节点保存的世界尺寸；null 表示首次打开。 */
  size?: CanvasWorkbenchSize | null
  onSizeChange?: (size: CanvasWorkbenchSize) => void
  onDirtyChange: (dirty: boolean) => void
  onClose: () => void
  /** 草稿确认期间暂停外部点击关闭，避免再次点击打断保存或取消操作。 */
  dismissOnOutsideClick?: boolean
  children?: React.ReactNode
}

/** 返回四类节点的稳定中文名称。 */
export function getCanvasNodeKindLabel(kind: CanvasNodeKind): string {
  if (kind === 'agent') return 'Agent'
  if (kind === 'image') return '生图'
  if (kind === 'audio') return '音频'
  if (kind === 'video') return '视频'
  if (kind === 'document') return '文档'
  return '原型'
}

/** 返回非 Agent 基础工作台的稳定下一步，不读取节点正文。 */
function getCanvasNodeNextAction(kind: Exclude<CanvasNodeKind, 'agent'>): string {
  if (kind === 'image') return '下一步：配置提示词并选择模型'
  if (kind === 'audio') return '下一步：配置音频工作流'
  if (kind === 'video') return '下一步：配置视频工作流'
  if (kind === 'document') return '下一步：开始撰写内容'
  return '下一步：创建 HTML 原型'
}

/** 渲染与卡片共用画布变换的详情，仅调整大小，不支持独立移动。 */
export function CanvasNodeWorkbenchOverlay(props: CanvasNodeWorkbenchOverlayProps): React.ReactElement {
  /** 初始尺寸只计算一次，避免 viewport 变化时反向抵消画布缩放。 */
  const [initialSize] = React.useState(() => initialCanvasWorkbenchSize(
    props.node, props.surfaceSize ?? { width: 1_200, height: 800 }, props.viewport?.zoom ?? 1,
  ))
  /** 已保存尺寸不受当前可视范围限制。 */
  const effectiveSize = props.size ?? initialSize
  const label = getCanvasNodeKindLabel(props.node.kind)
  /** 手势开始时测量一次真实缩放，后续 move 不读取 DOM。 */
  const sectionRef = React.useRef<HTMLElement>(null)
  /** 文档监听器保持稳定，关闭操作始终使用当前会话的回调。 */
  const onCloseRef = React.useRef(props.onClose)
  onCloseRef.current = props.onClose
  React.useEffect(() => {
    if (props.dismissOnOutsideClick === false) return
    /** 仅展开详情期间订阅一次点击，不监听高频移动或遍历画布节点。 */
    const section = sectionRef.current
    if (!section) return
    /** 使用冒泡阶段：详情内部及其 React Portal 菜单会先停止事件传播。 */
    const handleOutsideClick = (event: MouseEvent): void => {
      if (event.button !== 0 || event.defaultPrevented) return
      if (event.target instanceof Node && section.contains(event.target)) return
      onCloseRef.current()
    }
    section.ownerDocument.addEventListener('click', handleOutsideClick)
    return () => section.ownerDocument.removeEventListener('click', handleOutsideClick)
  }, [props.dismissOnOutsideClick])
  const resizeSessionRef = React.useRef<{ pointerId: number; pointerOrigin: { x: number; y: number } } | null>(null)
  /** 高频尺寸预览不进入会话 atom 或图文档。 */
  const [previewSize, setPreviewSize] = React.useState(effectiveSize)
  const onSizeChangeRef = React.useRef(props.onSizeChange)
  onSizeChangeRef.current = props.onSizeChange
  const resizeGestureRef = React.useRef<CanvasWorkbenchResizeGestureController | null>(null)
  if (!resizeGestureRef.current) {
    resizeGestureRef.current = createCanvasWorkbenchResizeGestureController({
      onPreview: setPreviewSize,
      onCommit: (size) => onSizeChangeRef.current?.(size),
    })
  }
  React.useEffect(() => {
    if (resizeSessionRef.current === null) setPreviewSize(effectiveSize)
  }, [effectiveSize.width, effectiveSize.height])
  React.useEffect(() => {
    /** 首次尺寸按节点保存，关闭重开或改变缩放后保持相同画布几何。 */
    if (props.size == null) onSizeChangeRef.current?.(initialSize)
  }, [initialSize, props.size])
  /** 非手势期间直接读取受控尺寸，避免等待 effect 产生一帧闪动。 */
  const renderedSize = resizeSessionRef.current === null ? effectiveSize : previewSize

  /** 捕获缩放手势并冻结当前比例；越界时指针仍可继续操作。 */
  const handleResizePointerDown = React.useCallback((event: React.PointerEvent<HTMLButtonElement>): void => {
    if (event.button !== 0) return
    event.preventDefault()
    event.stopPropagation()
    event.currentTarget.setPointerCapture(event.pointerId)
    resizeSessionRef.current = { pointerId: event.pointerId, pointerOrigin: { x: event.clientX, y: event.clientY } }
    const rect = sectionRef.current?.getBoundingClientRect()
    resizeGestureRef.current?.start({
      initialSize: renderedSize, pointerDelta: { x: 0, y: 0 },
      canvasScale: {
        x: rect ? rect.width / renderedSize.width : 1,
        y: rect ? rect.height / renderedSize.height : 1,
      },
      availableSize: { width: CANVAS_WORKBENCH_MAX_DIMENSION, height: CANVAS_WORKBENCH_MAX_DIMENSION },
    })
  }, [renderedSize])

  /** 只更新当前详情尺寸，不改变卡片坐标或写入图文档。 */
  const handleResizePointerMove = React.useCallback((event: React.PointerEvent<HTMLButtonElement>): void => {
    const session = resizeSessionRef.current
    if (!session || session.pointerId !== event.pointerId) return
    event.preventDefault()
    event.stopPropagation()
    resizeGestureRef.current?.move({ x: event.clientX - session.pointerOrigin.x, y: event.clientY - session.pointerOrigin.y })
  }, [])

  /** 松开、取消或失去捕获时只提交一次最终尺寸。 */
  const finishResize = React.useCallback((event: React.PointerEvent<HTMLButtonElement>): void => {
    const session = resizeSessionRef.current
    if (!session || session.pointerId !== event.pointerId) return
    event.preventDefault()
    event.stopPropagation()
    resizeSessionRef.current = null
    resizeGestureRef.current?.finish()
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
  }, [])

  return <section
    ref={sectionRef}
    className="nodrag nopan nowheel pointer-events-auto absolute z-30 cursor-auto select-text overflow-hidden rounded-[8px] border border-border bg-background text-foreground shadow-xl"
    aria-label={`${label}工作台`}
    data-workbench-kind={props.node.kind}
    data-workbench-dirty={props.dirty || undefined}
    style={{ width: renderedSize.width, height: renderedSize.height, left: props.nodeBounds.x, top: props.nodeBounds.y + props.nodeBounds.height + CANVAS_WORKBENCH_NODE_GAP }}
    onClick={(event) => event.stopPropagation()}
    onDoubleClick={(event) => event.stopPropagation()}
  >
    <header className="flex h-11 shrink-0 items-center justify-between gap-2 border-b border-border px-3">
      <span className="min-w-0 truncate text-sm font-medium">{props.node.title}</span>
      <Button type="button" size="icon" variant="ghost" aria-label={`收起${label}工作台`} onClick={props.onClose}>
        <X className="size-4" aria-hidden="true" />
      </Button>
    </header>
    <div className="relative h-[calc(100%-2.75rem)] min-h-0 [&>aside]:static [&>aside]:h-full [&>aside]:max-w-none [&>aside]:border-l-0 [&>aside]:shadow-none [&>aside>header]:hidden">
      {props.children ?? <div className="flex h-full flex-col items-center justify-center gap-2 p-4 text-center text-sm text-muted-foreground">
        <p>{label}节点已创建</p>
        <p>{props.node.kind === 'agent' ? 'Agent 对话暂不可用' : getCanvasNodeNextAction(props.node.kind)}</p>
      </div>}
    </div>
    <button type="button"
      className="nodrag nopan nowheel absolute bottom-1 right-1 z-40 flex size-6 touch-none items-center justify-center rounded-sm border border-border bg-background/90 text-muted-foreground shadow-sm cursor-se-resize hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      aria-label="调整工作台大小" title="拖拽调整工作台大小"
      onPointerDown={handleResizePointerDown} onPointerMove={handleResizePointerMove}
      onPointerUp={finishResize} onPointerCancel={finishResize}
      onLostPointerCapture={() => { resizeSessionRef.current = null; resizeGestureRef.current?.finish() }}
    ><MoveDiagonal2 className="size-3.5" aria-hidden="true" /></button>
  </section>
}
