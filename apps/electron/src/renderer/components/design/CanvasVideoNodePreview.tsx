import * as React from 'react'
import type {
  CanvasMediaOutputPreview,
  CanvasMediaPreloadApi,
  ReadCanvasMediaOutputPreviewInput,
} from '@proma/shared'
import { LoaderCircle, Video } from 'lucide-react'
import type { MediaRunProgressProjection } from './use-media-run-progress'

/** 卡片只接收已采用输出的精确身份，不读取或自动选择候选列表。 */
export interface CanvasVideoNodePreviewProps {
  /** 当前正式采用的视频目标，包含候选和输出顺序。 */
  target: ReadCanvasMediaOutputPreviewInput
  /** 按目标申请临时媒体授权，不暴露本地路径。 */
  readPreview: CanvasMediaPreloadApi['canvasMediaReadPreview']
  /** 回收当前或迟到的预览授权。 */
  releasePreview: CanvasMediaPreloadApi['canvasMediaReleasePreview']
  /** 卡片标题沿用节点展示名称。 */
  title: string
  /** 没有运行投影时的静态素材状态。 */
  statusLabel: string
  /** 运行阶段独立于已采用素材，重跑时仍保留旧视频。 */
  mediaProgress?: MediaRunProgressProjection
}

/** 单次可见期的视频资源输入，身份变化通过 React key 强制释放旧实例。 */
interface VisibleVideoPreviewProps extends Pick<CanvasVideoNodePreviewProps, 'target' | 'readPreview' | 'releasePreview' | 'title'> {}

/**
 * 可见期间加载一份暂停的视频首帧。
 * @param props 精确采用目标与对应授权接口。
 * @returns 不接管拖动、点击或缩放的只读预览，卸载时回收解码器与授权。
 */
function VisibleVideoPreview({ target, readPreview, releasePreview, title }: VisibleVideoPreviewProps): React.ReactElement {
  /** video 始终挂载，Effect 能持有元素并在 React 清空 ref 后继续释放解码资源。 */
  const videoRef = React.useRef<HTMLVideoElement>(null)
  /** 加载状态不参与请求依赖，解码失败不会导致自动重试循环。 */
  const [phase, setPhase] = React.useState<'loading' | 'ready' | 'error'>('loading')

  React.useEffect(() => {
    /** 本次可见期拥有的元素，清理不能依赖卸载后已为 null 的 ref。 */
    const video = videoRef.current
    if (!video) return
    /** 离屏、切换目标或卸载后，迟到读取只执行释放。 */
    let disposed = false
    /** 本次 Effect 独占的媒体授权；置空保证错误与卸载不会重复释放。 */
    let current: CanvasMediaOutputPreview | null = null
    setPhase('loading')

    /** 回收指定授权；失败不向 React 泄漏未处理的 Promise。 */
    const release = (preview: CanvasMediaOutputPreview): void => {
      void releasePreview({ ...target, mediaLeaseId: preview.mediaLeaseId }).catch(() => {
        console.warn('[CanvasVideoNodePreview] 视频预览授权释放失败')
      })
    }
    /** 停止读取并解除元素对媒体的引用，再释放当前授权。 */
    const clearVideo = (): void => {
      video.pause()
      video.removeAttribute('src')
      video.load()
      if (current) {
        release(current)
        current = null
      }
    }
    /** 首帧可解码后才隐藏加载提示；不启动播放。 */
    const onLoaded = (): void => { if (!disposed && current) setPhase('ready') }
    /** 解码失败仍保留“已采用”的事实，但立即释放无用资源。 */
    const onError = (): void => {
      if (disposed || !current) return
      setPhase('error')
      clearVideo()
    }
    video.addEventListener('loadeddata', onLoaded)
    video.addEventListener('error', onError)
    void (async () => {
      try {
        /** 请求仅来自当前正式输出，不能退回其它未采用候选。 */
        const preview = await readPreview(target)
        if (disposed) { release(preview); return }
        if (preview.candidateId !== target.candidateId
          || preview.outputKey !== target.outputKey
          || preview.outputOrder !== target.outputOrder
          || preview.asset.mediaKind !== 'video') {
          release(preview)
          setPhase('error')
          return
        }
        current = preview
        video.src = preview.mediaUrl
      } catch {
        if (!disposed) setPhase('error')
      }
    })()
    return () => {
      disposed = true
      video.removeEventListener('loadeddata', onLoaded)
      video.removeEventListener('error', onError)
      clearVideo()
    }
  }, [target, readPreview, releasePreview])

  return (
    <div className="absolute inset-0" data-preview-state={phase}>
      <video
        ref={videoRef}
        aria-label={`${title}已采用视频预览`}
        className="pointer-events-none h-full w-full select-none object-contain"
        muted
        playsInline
        preload="metadata"
        tabIndex={-1}
      />
      {phase !== 'ready' ? (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center gap-1.5 pb-7 text-xs text-muted-foreground" role="status">
          {phase === 'loading' ? <LoaderCircle className="size-3.5 animate-spin motion-reduce:animate-none" aria-hidden="true" /> : null}
          <span>{phase === 'loading' ? '正在加载视频预览' : '视频预览暂不可用，请展开查看'}</span>
        </div>
      ) : null}
    </div>
  )
}

/**
 * 在进入真实可视区域后才挂载视频，沿用投影的媒体比例尺寸和原画布交互。
 * @param props 当前已采用输出、稳定预览回调和轻量节点状态。
 * @returns 带标题、采用事实与运行阶段的视频卡片内容。
 */
export function CanvasVideoNodePreview({
  target, readPreview, releasePreview, title, statusLabel, mediaProgress,
}: CanvasVideoNodePreviewProps): React.ReactElement {
  /** 观察内容区与画布裁剪边界的交集，不增加 viewport 的逐帧 React 更新。 */
  const containerRef = React.useRef<HTMLDivElement>(null)
  /** 初始离屏不读取媒体，进入可视区域后才申请授权。 */
  const [visible, setVisible] = React.useState(false)
  /** 按标量稳定目标引用，避免进度事件创建的新对象重复读取同一视频。 */
  const stableTarget = React.useMemo<ReadCanvasMediaOutputPreviewInput>(() => ({
    projectId: target.projectId,
    canvasId: target.canvasId,
    nodeId: target.nodeId,
    mediaModuleId: target.mediaModuleId,
    mediaKind: target.mediaKind,
    candidateId: target.candidateId,
    outputKey: target.outputKey,
    outputOrder: target.outputOrder,
  }), [target.projectId, target.canvasId, target.nodeId, target.mediaModuleId, target.mediaKind, target.candidateId, target.outputKey, target.outputOrder])
  /** 完整身份变化立即移除旧画面；相同采用版本不受其它运行状态影响。 */
  const targetKey = JSON.stringify(stableTarget)
  /** 当前运行状态仅作为辅助信息，不改变已采用视频。 */
  const progressLabel = mediaProgress?.phaseLabel ?? statusLabel

  React.useEffect(() => {
    /** 当前元素由本次 observer 独占，卸载时一起断开。 */
    const container = containerRef.current
    if (!container) return
    if (typeof IntersectionObserver === 'undefined') { setVisible(true); return }
    /** 默认 viewport 会同时计算画布等 overflow 祖先的裁剪。 */
    const observer = new IntersectionObserver((entries) => {
      setVisible(entries.some((entry) => entry.isIntersecting && entry.intersectionRatio > 0))
    })
    observer.observe(container)
    return () => observer.disconnect()
  }, [])

  return (
    <div ref={containerRef} data-canvas-video-preview className="relative h-full min-h-0 overflow-hidden bg-muted/40">
      {visible ? (
        <VisibleVideoPreview key={targetKey} target={stableTarget} readPreview={readPreview} releasePreview={releasePreview} title={title} />
      ) : <Video className="pointer-events-none absolute left-1/2 top-1/2 size-5 -translate-x-1/2 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />}
      <span className="pointer-events-none absolute left-2 top-1 rounded bg-background/85 px-1.5 py-0.5 text-[10px] text-foreground">已采用</span>
      <div className="pointer-events-none absolute inset-x-0 bottom-0 flex min-w-0 items-center gap-2 border-t border-border/60 bg-background/90 px-3 py-1 text-xs">
        <p className="min-w-0 flex-1 truncate font-medium text-foreground" title={title}>{title}</p>
        <span className="min-w-0 shrink text-right text-muted-foreground" role="status" title={mediaProgress?.nodeProgressLabel}>
          <span className="block truncate">{progressLabel}</span>
          {mediaProgress?.nodeProgressLabel ? <span className="block max-w-40 truncate text-[10px]">{mediaProgress.nodeProgressLabel}</span> : null}
        </span>
      </div>
    </div>
  )
}
