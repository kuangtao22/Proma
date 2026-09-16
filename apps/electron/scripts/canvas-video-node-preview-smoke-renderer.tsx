import * as React from 'react'
import { createRoot } from 'react-dom/client'
import { ReactFlowProvider } from '@xyflow/react'
import { createEmptyCanvasDocument } from '@proma/shared'
import type { CanvasMediaPreloadApi, CanvasMediaOutputPreview, CanvasMutation, ReadCanvasMediaOutputPreviewInput, MediaAssetRecord } from '@proma/shared'
import { NativeCanvasGraph } from '../src/renderer/components/design/NativeCanvasGraph'
import type { MediaRunProgressProjection } from '../src/renderer/components/design/use-media-run-progress'
import '../src/renderer/styles/globals.css'
import '@xyflow/react/dist/style.css'

/** 完整内存 fixture 状态，Electron 验证不连接真实客户端或生成服务。 */
interface VideoCardSmoke {
  reads: ReadCanvasMediaOutputPreviewInput[]
  released: string[]
  leases: Map<string, { candidateId: string; url: string }>
  mutations: CanvasMutation[]
  delayNext: boolean
  failNext: boolean
  corruptNext: boolean
  resolvePending: (() => void) | null
  setCandidate: (candidate: string | null) => void
  setVisible: (visible: boolean) => void
  progress: () => void
  unmount: () => void
}
declare global { interface Window { __videoCardSmoke: VideoCardSmoke } }

/** 录制真实彩色视频首帧，用于验证解码而非只有 video 标签。 */
async function createVideoBlob(width = 320, height = 180): Promise<Blob> {
  /** 内存画布及其录制上下文。 */
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const context = canvas.getContext('2d')
  if (!context) throw new Error('Canvas 2D 不可用')
  /** 仅生成本地测试媒体，录制后停止所有 track。 */
  const stream = canvas.captureStream(12)
  const recorder = new MediaRecorder(stream, { mimeType: 'video/webm;codecs=vp8' })
  const chunks: Blob[] = []
  recorder.ondataavailable = (event) => { if (event.data.size) chunks.push(event.data) }
  const stopped = new Promise<void>((resolve) => { recorder.onstop = () => resolve() })
  recorder.start()
  for (let frame = 0; frame < 8; frame += 1) {
    context.fillStyle = '#0f766e'
    context.fillRect(0, 0, width, height)
    context.fillStyle = '#ffffff'
    context.font = 'bold 28px sans-serif'
    context.fillText('Proma', 24, height / 2)
    await new Promise<void>((resolve) => setTimeout(resolve, 45))
  }
  recorder.stop()
  await stopped
  stream.getTracks().forEach((track) => track.stop())
  return new Blob(chunks, { type: 'video/webm' })
}
/** 当前页生命周期内共享录制字节，每次读取仍申请独立 URL。 */
const videoBlob = await createVideoBlob()
/** 竖屏采用版本用于验证真实媒体比例切换。 */
const portraitVideoBlob = await createVideoBlob(180, 320)
/** 合法公开资产元数据；内容完全来自内存录制。 */
const asset: MediaAssetRecord = { id: 'asset-video', revision: 1, hash: 'a'.repeat(64), filename: 'fixture.webm',
  byteSize: videoBlob.size, mediaType: 'video/webm', createdAt: 1, mediaKind: 'video',
  metadata: { width: 320, height: 180, durationMs: 360, fps: 12, codec: 'vp8', hasAudio: false } }
/** 计数和控制器跨 React 渲染稳定，便于验证请求去重。 */
const smoke: VideoCardSmoke = { reads: [], released: [], leases: new Map(), mutations: [],
  delayNext: false, failNext: false, corruptNext: false, resolvePending: null,
  setCandidate: () => undefined, setVisible: () => undefined, progress: () => undefined, unmount: () => undefined }
window.__videoCardSmoke = smoke
/** 预览读取提供真实可解码 Blob，并支持迟到、读取失败和解码失败。 */
const readPreview: CanvasMediaPreloadApi['canvasMediaReadPreview'] = async (input) => {
  smoke.reads.push(input)
  if (smoke.failNext) { smoke.failNext = false; throw new Error('fixture read failure') }
  if (smoke.delayNext) {
    smoke.delayNext = false
    await new Promise<void>((resolve) => { smoke.resolvePending = () => { smoke.resolvePending = null; resolve() } })
  }
  /** 授权与实际媒体 URL 成对分配，坏媒体只用于确定性错误态验证。 */
  const mediaLeaseId = crypto.randomUUID()
  const mediaUrl = URL.createObjectURL(smoke.corruptNext ? new Blob(['invalid video'], { type: 'video/webm' })
    : input.candidateId === 'candidate-b' ? portraitVideoBlob : videoBlob)
  smoke.corruptNext = false
  smoke.leases.set(mediaLeaseId, { candidateId: input.candidateId, url: mediaUrl })
  return { candidateId: input.candidateId, outputKey: input.outputKey, outputOrder: input.outputOrder,
    asset: input.candidateId === 'candidate-b' ? { ...asset, metadata: { ...asset.metadata, width: 180, height: 320 } } : asset,
    mediaLeaseId, mediaUrl } satisfies CanvasMediaOutputPreview
}
/** 每次释放必须有独占 lease，重复释放直接暴露为测试错误。 */
const releasePreview: CanvasMediaPreloadApi['canvasMediaReleasePreview'] = async (input) => {
  const lease = smoke.leases.get(input.mediaLeaseId)
  if (!lease) throw new Error('fixture duplicate release')
  URL.revokeObjectURL(lease.url)
  smoke.leases.delete(input.mediaLeaseId)
  smoke.released.push(input.mediaLeaseId)
}
/** 真实 Graph 的文档与运行态入口；默认离屏验证零请求。 */
function Fixture(): React.ReactElement {
  const [canvas, setCanvas] = React.useState(() => {
    const initial = createEmptyCanvasDocument('smoke-project', 'smoke-canvas', 1)
    initial.viewport = { x: -3000, y: 0, zoom: 1 }
    initial.nodes = [
      { id: 'video-1', kind: 'video', title: '当前采用的视频', mediaModuleId: 'module-1', position: { x: 100, y: 80 } },
      { id: 'video-empty', kind: 'video', title: '只有候选，尚未采用', mediaModuleId: 'module-empty', position: { x: 460, y: 80 } },
    ]
    initial.edges = [{ id: 'video-reference', sourceNodeId: 'video-1', sourcePort: 'output', targetNodeId: 'video-empty', targetPort: 'input', relation: 'reference' }]
    return initial
  })
  /** 采用身份和进度分别更新，复现运行事件不改变素材的情况。 */
  const [candidate, setCandidate] = React.useState<string | null>('candidate-a')
  const [tick, setTick] = React.useState(0)
  smoke.setCandidate = setCandidate
  smoke.progress = () => setTick((value) => value + 1)
  smoke.setVisible = (visible) => setCanvas((value) => ({ ...value, viewport: { x: visible ? 0 : -3000, y: 0, zoom: 1 } }))
  /** 每次事件都构造新目标对象，验证生产组件按精确标量身份去重。 */
  const progress = new Map<string, MediaRunProgressProjection>([
    ['video-1', { phase: tick ? 'running' : 'pending', phaseLabel: tick ? '运行中' : '已有素材',
      ...(tick ? { nodeProgressLabel: `当前节点 sampler · ${tick}/20` } : {}),
      hasAdoptedOutput: Boolean(candidate), ...(candidate && candidate !== 'candidate-no-metadata' ? {
        adoptedVideoDimensions: candidate === 'candidate-b' ? { width: 180, height: 320 } : { width: 320, height: 180 },
      } : {}), ...(candidate ? { adoptedVideo: {
        projectId: canvas.projectId, canvasId: canvas.canvasId, nodeId: 'video-1', mediaModuleId: 'module-1',
        mediaKind: 'video' as const, candidateId: candidate, outputKey: 'video', outputOrder: 0,
      } } : {}),
    }],
    ['video-empty', { phase: 'succeeded', phaseLabel: '生成完成' }],
  ])
  return <div className="h-screen w-screen bg-background text-foreground">
    <NativeCanvasGraph document={canvas} writable selectedNodeId={null} onNodeSelect={() => undefined}
      onConversationNodeChange={() => undefined} onMutation={(mutation) => smoke.mutations.push(mutation)}
      mediaProgressByNodeId={progress} readCanvasVideoPreview={readPreview} releaseCanvasVideoPreview={releasePreview} />
  </div>
}
/** 使用真实 XYFlow 宿主验证剪裁、视口变化和节点内容。 */
const root = createRoot(document.getElementById('root')!)
smoke.unmount = () => root.unmount()
if (new URLSearchParams(location.search).get('theme') !== 'light') document.documentElement.classList.add('dark')
root.render(<ReactFlowProvider><Fixture /></ReactFlowProvider>)
