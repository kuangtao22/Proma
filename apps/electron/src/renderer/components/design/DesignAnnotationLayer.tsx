import * as React from 'react'
import type {
  DesignAnnotation,
  DesignPoint,
  DesignViewport,
} from '@proma/shared'
import type { DesignProjectState } from '@/atoms/design-atoms'
import { cn } from '@/lib/utils'

/** 批注身份由交互层调用方生成，手势控制器不读取时间或 UUID。 */
export interface DesignAnnotationIdentity {
  id: string
  createdAt: number
}

/** animation frame 调度接口，测试可注入确定性 scheduler。 */
export interface DesignFrameScheduler {
  requestFrame: (callback: FrameRequestCallback) => number
  cancelFrame: (frameId: number) => void
}

/** 蒙版点 rAF 批处理器依赖。 */
export interface MaskPointBatcherOptions extends DesignFrameScheduler {
  onFlush: (points: DesignPoint[]) => void
}

/** 蒙版点 rAF 批处理器公开操作。 */
export interface MaskPointBatcher {
  push: (point: DesignPoint) => void
  flushNow: () => void
  cancel: () => void
}

/** 计算两个画布点之间的欧氏距离。 */
function pointDistance(left: DesignPoint, right: DesignPoint): number {
  return Math.hypot(right.x - left.x, right.y - left.y)
}

/** 去除与前一个保留点距离小于 1px 的相邻采样。 */
function filterAdjacentMaskPoints(points: DesignPoint[], previous?: DesignPoint): DesignPoint[] {
  /** 上一个已保留点跨帧延续，保证全手势去噪一致。 */
  let last = previous
  /** 当前批次通过距离阈值的点。 */
  const filtered: DesignPoint[] = []
  for (const point of points) {
    if (!last || pointDistance(last, point) >= 1) {
      filtered.push(point)
      last = point
    }
  }
  return filtered
}

/**
 * 创建每帧最多 flush 一次的蒙版点批处理器。
 * @param options 可替换的帧调度与批次回调。
 * @returns 支持入队、同步收尾和取消的批处理器。
 */
export function createMaskPointBatcher(options: MaskPointBatcherOptions): MaskPointBatcher {
  /** 尚未交给草稿的同帧采样点。 */
  let pending: DesignPoint[] = []
  /** 已安排的唯一 animation frame。 */
  let frameId: number | null = null
  /** 跨帧最后一个保留点，用于过滤帧边界附近噪点。 */
  let lastFlushedPoint: DesignPoint | undefined

  /** 同步提交当前批次并清空帧状态。 */
  const flush = (): void => {
    frameId = null
    if (pending.length === 0) return
    /** 复制当前队列，避免回调重入影响本批。 */
    const batch = pending
    pending = []
    /** 当前帧去除相邻亚像素抖动后的采样。 */
    const filtered = filterAdjacentMaskPoints(batch, lastFlushedPoint)
    if (filtered.length === 0) return
    lastFlushedPoint = filtered.at(-1)
    options.onFlush(filtered)
  }

  return {
    push: (point) => {
      pending.push(point)
      if (frameId !== null) return
      frameId = options.requestFrame(() => { flush() })
    },
    flushNow: () => {
      if (frameId !== null) options.cancelFrame(frameId)
      flush()
    },
    cancel: () => {
      if (frameId !== null) options.cancelFrame(frameId)
      frameId = null
      pending = []
      lastFlushedPoint = undefined
    },
  }
}

/** 箭头或蒙版手势控制器依赖。 */
export interface AnnotationGestureControllerOptions extends DesignFrameScheduler {
  tool: 'arrow' | 'mask'
  color: string
  createIdentity: () => DesignAnnotationIdentity
  onDraftChange: (points: DesignPoint[]) => void
  onCreate: (annotation: DesignAnnotation) => void
}

/** 批注手势控制器公开的 pointer 生命周期。 */
export interface AnnotationGestureController {
  pointerDown: (point: DesignPoint) => void
  pointerMove: (point: DesignPoint) => void
  pointerUp: (point: DesignPoint) => void
  cancel: () => void
}

/**
 * 创建独立于 React 和 DOM 的批注手势控制器。
 * @param options 当前工具、主题色、身份工厂和输出回调。
 * @returns 可直接转发 pointer 坐标的控制器。
 */
export function createAnnotationGestureController(
  options: AnnotationGestureControllerOptions,
): AnnotationGestureController {
  /** 当前手势起点；undefined 表示没有活动 pointer。 */
  let startPoint: DesignPoint | undefined
  /** 当前蒙版已进入草稿的去噪点。 */
  let maskPoints: DesignPoint[] = []
  /** 每帧批量追加蒙版采样，避免 pointermove 高频写状态。 */
  const maskBatcher = createMaskPointBatcher({
    requestFrame: options.requestFrame,
    cancelFrame: options.cancelFrame,
    onFlush: (points) => {
      /** 继续按上一草稿点过滤帧边界亚像素采样。 */
      const appended = filterAdjacentMaskPoints(points, maskPoints.at(-1))
      if (appended.length === 0) return
      maskPoints = [...maskPoints, ...appended]
      options.onDraftChange(maskPoints)
    },
  })

  /** 清空当前手势与可见草稿。 */
  const clear = (): void => {
    startPoint = undefined
    maskPoints = []
    maskBatcher.cancel()
    options.onDraftChange([])
  }

  return {
    pointerDown: (point) => {
      maskBatcher.cancel()
      startPoint = point
      maskPoints = options.tool === 'mask' ? [point] : []
      options.onDraftChange(options.tool === 'arrow' ? [point, point] : maskPoints)
    },
    pointerMove: (point) => {
      if (!startPoint) return
      if (options.tool === 'arrow') {
        options.onDraftChange([startPoint, point])
        return
      }
      maskBatcher.push(point)
    },
    pointerUp: (point) => {
      if (!startPoint) return
      if (options.tool === 'arrow') {
        /** 小于 4px 的拖动视为误触，不创建历史。 */
        const shouldCreate = pointDistance(startPoint, point) >= 4
        /** 箭头起点在清理前保存，避免闭包状态被重置。 */
        const from = startPoint
        clear()
        if (!shouldCreate) return
        const identity = options.createIdentity()
        options.onCreate({
          ...identity,
          kind: 'arrow',
          from,
          to: point,
          color: options.color,
          width: 12,
        })
        return
      }

      maskBatcher.flushNow()
      /** pointerup 终点也参加相邻点过滤。 */
      const finalPoints = [...maskPoints, ...filterAdjacentMaskPoints([point], maskPoints.at(-1))]
      clear()
      if (finalPoints.length < 2) return
      const identity = options.createIdentity()
      options.onCreate({
        ...identity,
        kind: 'mask',
        points: finalPoints,
        color: options.color,
        width: 12,
      })
    },
    cancel: clear,
  }
}

export interface DesignAnnotationLayerProps {
  /** 当前文档中已持久化的批注。 */
  annotations: DesignAnnotation[]
  /** 当前交互工具。 */
  activeTool: DesignProjectState['activeTool']
  /** 只读画布不捕获批注 pointer。 */
  writable: boolean
  /** 当前 XYFlow 视口，用于屏幕坐标和画布坐标互转。 */
  viewport: DesignViewport
  /** 当前项目 atom 中保存的手势草稿。 */
  draft?: DesignPoint[]
  /** 项目级草稿点更新回调。 */
  onDraftChange: (points: DesignPoint[]) => void
  /** 完成一个手势后创建单个批注。 */
  onCreate: (annotation: DesignAnnotation) => void
  /** 由调用方生成稳定批注 ID 与创建时间。 */
  createIdentity: () => DesignAnnotationIdentity
}

/** 把 SVG 本地屏幕坐标换算为持久化画布坐标。 */
function toCanvasPoint(
  event: React.PointerEvent<SVGSVGElement>,
  viewport: DesignViewport,
): DesignPoint {
  /** SVG 边界用于扣除容器在窗口内的偏移。 */
  const bounds = event.currentTarget.getBoundingClientRect()
  return {
    x: (event.clientX - bounds.left - viewport.x) / viewport.zoom,
    y: (event.clientY - bounds.top - viewport.y) / viewport.zoom,
  }
}

/** 把点数组序列化为 SVG polyline points。 */
function serializePoints(points: DesignPoint[]): string {
  return points.map((point) => `${point.x},${point.y}`).join(' ')
}

/** 渲染一个持久化批注。 */
function renderAnnotation(annotation: DesignAnnotation): React.ReactNode {
  if (annotation.kind === 'arrow') {
    return (
      <line
        key={annotation.id}
        x1={annotation.from.x}
        y1={annotation.from.y}
        x2={annotation.to.x}
        y2={annotation.to.y}
        stroke={annotation.color}
        strokeWidth={annotation.width}
        strokeLinecap="round"
        markerEnd="url(#design-annotation-arrowhead)"
      />
    )
  }
  return (
    <polyline
      key={annotation.id}
      points={serializePoints(annotation.points)}
      fill="none"
      stroke={annotation.color}
      strokeWidth={annotation.width}
      strokeLinecap="round"
      strokeLinejoin="round"
      opacity={0.38}
    />
  )
}

/** 覆盖在 XYFlow 上方的箭头和蒙版批注交互层。 */
export function DesignAnnotationLayer({
  annotations,
  activeTool,
  writable,
  viewport,
  draft = [],
  onDraftChange,
  onCreate,
  createIdentity,
}: DesignAnnotationLayerProps): React.ReactElement {
  /** 只有可写批注工具捕获 pointer。 */
  const editable = writable && (activeTool === 'arrow' || activeTool === 'mask')
  /** 工具使用已有主题语义色，深浅主题无需额外分支。 */
  const color = activeTool === 'arrow'
    ? 'hsl(var(--destructive))'
    : 'hsl(var(--accent-foreground))'
  /** 当前工具配置对应的手势控制器。 */
  const controller = React.useMemo(() => createAnnotationGestureController({
    tool: activeTool === 'arrow' ? 'arrow' : 'mask',
    color,
    createIdentity,
    requestFrame: (callback) => window.requestAnimationFrame(callback),
    cancelFrame: (frameId) => window.cancelAnimationFrame(frameId),
    onDraftChange: (points) => {
      onDraftChange(points)
    },
    onCreate,
  }), [activeTool, color, createIdentity, onCreate, onDraftChange])

  React.useEffect(() => () => { controller.cancel() }, [controller])

  /** 当前草稿在画布坐标系中按工具样式绘制。 */
  const draftShape = draft.length >= 2 && activeTool === 'arrow'
    ? (
        <line
          x1={draft[0]!.x}
          y1={draft[0]!.y}
          x2={draft.at(-1)!.x}
          y2={draft.at(-1)!.y}
          stroke={color}
          strokeWidth={12}
          strokeLinecap="round"
          markerEnd="url(#design-annotation-arrowhead)"
          opacity={0.7}
        />
      )
    : draft.length >= 2
      ? (
          <polyline
            points={serializePoints(draft)}
            fill="none"
            stroke={color}
            strokeWidth={12}
            strokeLinecap="round"
            strokeLinejoin="round"
            opacity={0.38}
          />
        )
      : null

  return (
    <svg
      className={cn(
        'absolute inset-0 z-[5] size-full touch-none',
        editable ? 'pointer-events-auto cursor-crosshair' : 'pointer-events-none',
      )}
      aria-label="设计批注层"
      style={{ color }}
      onPointerDown={(event) => {
        if (!editable || event.button !== 0) return
        event.currentTarget.setPointerCapture(event.pointerId)
        controller.pointerDown(toCanvasPoint(event, viewport))
      }}
      onPointerMove={(event) => {
        if (!editable || !event.currentTarget.hasPointerCapture(event.pointerId)) return
        controller.pointerMove(toCanvasPoint(event, viewport))
      }}
      onPointerUp={(event) => {
        if (!editable || !event.currentTarget.hasPointerCapture(event.pointerId)) return
        controller.pointerUp(toCanvasPoint(event, viewport))
        event.currentTarget.releasePointerCapture(event.pointerId)
      }}
      onPointerCancel={() => { controller.cancel() }}
    >
      <defs>
        <marker
          id="design-annotation-arrowhead"
          markerWidth="8"
          markerHeight="8"
          refX="7"
          refY="4"
          orient="auto"
          markerUnits="strokeWidth"
        >
          <path d="M 0 0 L 8 4 L 0 8 z" fill="context-stroke" />
        </marker>
      </defs>
      <g transform={`translate(${viewport.x} ${viewport.y}) scale(${viewport.zoom})`}>
        {annotations.map(renderAnnotation)}
        {draftShape}
      </g>
    </svg>
  )
}
