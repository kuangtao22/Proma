import '@fontsource-variable/inter/index.css'
import * as React from 'react'
import { createRoot } from 'react-dom/client'
import type {
  CanvasMediaModuleConfig,
  CanvasMediaModuleSnapshot,
  CanvasMediaOutputPreview,
  CanvasMediaTarget,
  MediaAssetRecord,
  MediaAssetRef,
  MediaPreloadApi,
  MediaRunSnapshot,
  MediaSettingsSnapshot,
  MediaWorkflowVersion,
} from '@proma/shared'
import { CanvasMediaWorkbench, type CanvasMediaWorkbenchAdapter } from '../src/renderer/components/design/CanvasMediaWorkbench'
import '../src/renderer/styles/globals.css'

/** 隔离页面可切换的工作台状态。 */
type FixtureMode = 'normal' | 'readonly' | 'empty' | 'error' | 'preview-error'

/** 使用仓库内图片作为三份真实参考图，避免访问用户项目或远端服务。 */
const imageBytes = new Uint8Array(await (await fetch(new URL('../resources/proma-logos/proma-emerald.png', import.meta.url))).arrayBuffer())
/** 长提示词用于证明右栏独立滚动时表单内容完整保留。 */
const longPrompt = '固定机位，角色轻微抬头并克制地点赞，桌面道具保持静止；保持参考图人物、服装、材质、灯光与镜头关系一致，不新增文字、数字、Logo、旁白或音乐。'.repeat(5)
/** 三份参考图记录使用不同稳定身份。 */
const imageAssets: MediaAssetRecord[] = [137, 139, 144].map((nodeId, index) => ({
  id: `reference-${nodeId}`,
  revision: 1,
  hash: `${index + 1}`.repeat(64),
  filename: `参考图-${nodeId}.png`,
  byteSize: imageBytes.byteLength,
  mediaType: 'image/png',
  mediaKind: 'image',
  metadata: { width: 1024, height: 768 },
  createdAt: 1,
}))
/** 候选视频的公共资产记录。 */
const videoAsset: MediaAssetRecord = {
  id: 'candidate-video', revision: 1, hash: 'a'.repeat(64), filename: '候选成片.webm',
  byteSize: 1, mediaType: 'video/webm', mediaKind: 'video', createdAt: 2,
  metadata: { width: 320, height: 180, durationMs: 500, fps: 12, codec: 'vp8', hasAudio: false },
}
/** 候选音频的公共资产记录。 */
const audioAsset: MediaAssetRecord = {
  id: 'candidate-audio', revision: 1, hash: 'b'.repeat(64), filename: '候选配音.wav',
  byteSize: 1, mediaType: 'audio/wav', mediaKind: 'audio', createdAt: 2,
  metadata: { durationMs: 300, sampleRate: 8_000, channels: 1, codec: 'pcm_s16le' },
}
/** 由公共资产创建运行时不可变引用。 */
function assetRef(asset: MediaAssetRecord): MediaAssetRef {
  return { assetId: asset.id, revision: asset.revision, hash: asset.hash, mediaKind: asset.mediaKind }
}

/** 真实工作流字段覆盖三张参考图、长提示词和需要折叠的数值参数。 */
const workflow: MediaWorkflowVersion = {
  id: 'layout-workflow', name: 'MiniMax Ref 左右布局测试', projectId: null, revision: 3,
  hash: 'c'.repeat(64), createdAt: 1,
  definition: {
    schemaVersion: 1,
    prompt: {
      '137': { class_type: 'LoadImage', inputs: { image: imageAssets[0]!.id } },
      '139': { class_type: 'LoadImage', inputs: { image: imageAssets[1]!.id } },
      '144': { class_type: 'LoadImage', inputs: { image: imageAssets[2]!.id } },
      '131': { class_type: 'TextNode', inputs: { expression: longPrompt } },
      '138': { class_type: 'FrameNode', inputs: { value: 73 } },
    },
    bindings: [
      { key: '137.image', kind: 'image', nodeId: '137', input: 'image', loader: 'LoadImage', field: { classType: 'LoadImage', valueKind: 'string', label: '首帧参考图', controlType: 'image', required: true } },
      { key: '139.image', kind: 'image', nodeId: '139', input: 'image', loader: 'LoadImage', field: { classType: 'LoadImage', valueKind: 'string', label: '角色参考图', controlType: 'image', required: true } },
      { key: '144.image', kind: 'image', nodeId: '144', input: 'image', loader: 'LoadImage', field: { classType: 'LoadImage', valueKind: 'string', label: '场景参考图', controlType: 'image', required: true } },
      { key: '131.expression', kind: 'text', nodeId: '131', input: 'expression', field: { classType: 'TextNode', valueKind: 'string', label: '提示词', controlType: 'text', required: true } },
      { key: '138.value', kind: 'number', nodeId: '138', input: 'value', field: { classType: 'FrameNode', valueKind: 'number', label: '帧数', controlType: 'number', required: true, min: 17, max: 289, step: 8 } },
    ],
    outputs: [
      { key: '92.video', nodeId: '92', outputIndex: 0, mediaType: 'video' },
      { key: '92.audio', nodeId: '92', outputIndex: 1, mediaType: 'audio' },
    ],
  },
}
/** 测试目标只存在于隔离内存。 */
const target: CanvasMediaTarget = {
  projectId: 'layout-project', canvasId: 'layout-canvas', nodeId: 'layout-node',
  mediaModuleId: 'layout-media', mediaKind: 'video',
}
/** 初始配置完整可运行，便于检查主操作及参数不被布局改写。 */
const initialConfig: CanvasMediaModuleConfig = {
  schemaVersion: 1, contentId: target.mediaModuleId, mediaKind: 'video', revision: 4,
  createdAt: 1, updatedAt: 1, profile: null, preparation: null,
  workflow: { workflowId: workflow.id, workflowRevision: workflow.revision, connectionId: 'gpu-layout' },
  inputs: [
    ...imageAssets.map((asset, index) => ({ key: `${[137, 139, 144][index]}.image`, kind: 'image' as const, source: { type: 'literal' as const, value: assetRef(asset) } })),
    { key: '131.expression', kind: 'text', source: { type: 'literal', value: longPrompt } },
    { key: '138.value', kind: 'number', source: { type: 'literal', value: 73 } },
  ],
  outputs: [
    { key: '92.video', mediaKind: 'video', role: 'primary', order: 0, bundle: 'final' },
    { key: '92.audio', mediaKind: 'audio', role: 'auxiliary', order: 1, bundle: 'final' },
  ],
  adoptedOutputs: [{
    key: '92.video', mediaKind: 'video', role: 'primary', order: 0, bundle: 'final',
    candidateId: 'candidate-1', runId: 'run-1', asset: assetRef(videoAsset), selectionOrigin: 'initial',
  }],
}
/** 两组候选确保左栏存在可滚动的音视频历史。 */
const initialCandidates: CanvasMediaModuleSnapshot['candidates'] = [1, 2].map((index) => ({
  id: `candidate-${index}`, operationId: `operation-${index}`, runId: `run-${index}`,
  sourceConfigRevision: 3 + index, createdAt: index,
  outputs: [
    { key: '92.video', mediaKind: 'video', role: 'primary', order: 0, bundle: 'final', asset: assetRef(videoAsset) },
    { key: '92.audio', mediaKind: 'audio', role: 'auxiliary', order: 1, bundle: 'final', asset: assetRef(audioAsset) },
  ],
}))
/** 已完成运行只提供稳定状态，不参与任何远端提交。 */
const succeededRun: MediaRunSnapshot = {
  id: 'run-2', projectId: target.projectId, revision: 2, phase: 'succeeded',
  createdAt: 1, updatedAt: 2, outputs: [], error: null, progress: null,
}
/** 媒体目录只包含 fixture 工作流和连接。 */
const settings: MediaSettingsSnapshot = {
  schemaVersion: 1, revision: 1, authorizationMode: 'ask',
  connections: [{ id: 'gpu-layout', name: '隔离 ComfyUI', driver: 'comfyui', baseUrl: 'http://127.0.0.1:1',
    enabled: true, auth: { kind: 'none' }, revision: 1, instanceGeneration: 'layout', updatedAt: 1,
    credentialConfigured: false }],
  workflows: [workflow], profiles: [],
}

/** 生成含真实彩色画面的短 WebM，验证 video 预览能够完成元数据解码。 */
async function createVideoBlob(): Promise<Blob> {
  const canvas = document.createElement('canvas')
  canvas.width = 320
  canvas.height = 180
  const context = canvas.getContext('2d')
  if (!context) throw new Error('Canvas 2D 不可用')
  const stream = canvas.captureStream(12)
  const mimeType = MediaRecorder.isTypeSupported('video/webm;codecs=vp8') ? 'video/webm;codecs=vp8' : 'video/webm'
  const recorder = new MediaRecorder(stream, { mimeType })
  const chunks: Blob[] = []
  recorder.ondataavailable = (event) => { if (event.data.size > 0) chunks.push(event.data) }
  const stopped = new Promise<void>((resolve) => { recorder.onstop = () => resolve() })
  recorder.start()
  for (let frame = 0; frame < 8; frame += 1) {
    context.fillStyle = frame % 2 === 0 ? '#10b981' : '#111827'
    context.fillRect(0, 0, canvas.width, canvas.height)
    context.fillStyle = '#ffffff'
    context.font = '600 28px sans-serif'
    context.fillText(`Proma ${frame + 1}`, 86, 98)
    await new Promise<void>((resolve) => setTimeout(resolve, 45))
  }
  recorder.stop()
  await stopped
  stream.getTracks().forEach((track) => track.stop())
  return new Blob(chunks, { type: mimeType })
}

/** 生成短 PCM WAV，确保 audio 候选不是伪造文本 URL。 */
function createAudioBlob(): Blob {
  const sampleRate = 8_000
  const sampleCount = 2_400
  const buffer = new ArrayBuffer(44 + sampleCount * 2)
  const view = new DataView(buffer)
  const writeText = (offset: number, value: string): void => {
    for (let index = 0; index < value.length; index += 1) view.setUint8(offset + index, value.charCodeAt(index))
  }
  writeText(0, 'RIFF'); view.setUint32(4, 36 + sampleCount * 2, true); writeText(8, 'WAVE')
  writeText(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true)
  view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true)
  writeText(36, 'data'); view.setUint32(40, sampleCount * 2, true)
  for (let index = 0; index < sampleCount; index += 1) {
    view.setInt16(44 + index * 2, Math.round(Math.sin(2 * Math.PI * 440 * index / sampleRate) * 4_000), true)
  }
  return new Blob([buffer], { type: 'audio/wav' })
}

/** 视频字节在页面启动时一次生成，预览点击只创建独立 lease URL。 */
const videoBlob = await createVideoBlob()
/** 音频字节与视频同样完全驻留在 fixture 内存。 */
const audioBlob = createAudioBlob()
/** 工作台当前权威配置由内存 CAS 更新。 */
let config = structuredClone(initialConfig)
/** 当前候选集合可切换为空状态。 */
let candidates = structuredClone(initialCandidates)
/** 当前运行列表允许从运行切换到取消。 */
let runs: MediaRunSnapshot[] = [structuredClone(succeededRun)]
/** 已分配的预览 URL 按 lease 精确回收。 */
const previewUrls = new Map<string, string>()
/** 暴露给 Electron 断言的纯内存调用记录。 */
const smoke = {
  mode: 'normal' as FixtureMode,
  width: 1040,
  height: 720,
  generation: 0,
  previewCalls: [] as Array<{ candidateId: string; outputKey: string; outputOrder: number }>,
  releasedLeases: [] as string[],
  saveCalls: [] as Parameters<CanvasMediaWorkbenchAdapter['canvasMediaSave']>[0][],
  runCalls: [] as Parameters<CanvasMediaWorkbenchAdapter['canvasMediaRun']>[0][],
  cancelCalls: [] as Parameters<CanvasMediaWorkbenchAdapter['canvasMediaCancel']>[0][],
  exportCalls: [] as Parameters<CanvasMediaWorkbenchAdapter['canvasMediaExportOutput']>[0][],
  adoptCalls: [] as Parameters<CanvasMediaWorkbenchAdapter['canvasMediaAdopt']>[0][],
  previewUrls,
  failNextSave: false,
  failNextPreview: false,
  setMode: (_mode: FixtureMode): void => {},
  setWidth: (_width: number): void => {},
  setHeight: (_height: number): void => {},
  unmount: (): void => {},
}

/** 返回独立快照，防止组件偶然修改 fixture 权威数据。 */
function createSnapshot(): CanvasMediaModuleSnapshot {
  return { target, config: structuredClone(config), candidates: structuredClone(candidates), runs: structuredClone(runs), assets: structuredClone(imageAssets) }
}
/** 内存适配器保持生产 IPC 参数和 revision 语义，但不访问用户数据。 */
const adapter: CanvasMediaWorkbenchAdapter = {
  canvasMediaLoad: async () => {
    if (smoke.mode === 'error') throw new Error('隔离加载失败')
    return createSnapshot()
  },
  canvasMediaSave: async (input) => {
    smoke.saveCalls.push(structuredClone(input))
    if (smoke.failNextSave) {
      smoke.failNextSave = false
      throw new Error('保存失败：隔离服务器拒绝了当前配置。请检查工作流版本、服务器连接和全部输入参数后重试；当前草稿仍保留，不会提交运行。'.repeat(3))
    }
    config = { ...config, revision: config.revision + 1, updatedAt: Date.now(), profile: input.profile,
      workflow: input.workflow, preparation: input.preparation ?? null,
      inputs: structuredClone(input.inputs), outputs: structuredClone(input.outputs) }
    return structuredClone(config)
  },
  canvasMediaRun: async (input) => {
    smoke.runCalls.push(structuredClone(input))
    const running: MediaRunSnapshot = { id: 'run-live', projectId: target.projectId, revision: 1, phase: 'running',
      createdAt: Date.now(), updatedAt: Date.now(), outputs: [], error: null, progress: { nodeId: '92', value: 4, max: 8 } }
    runs = [running, ...runs]
    return structuredClone(running)
  },
  canvasMediaCancel: async (input) => {
    smoke.cancelCalls.push(structuredClone(input))
    const cancelled: MediaRunSnapshot = { ...runs.find((run) => run.id === input.runId)!, revision: 2, phase: 'cancelled', updatedAt: Date.now() }
    runs = runs.map((run) => run.id === input.runId ? cancelled : run)
    return structuredClone(cancelled)
  },
  canvasMediaAdopt: async (input) => {
    smoke.adoptCalls.push(structuredClone(input))
    const candidate = candidates.find((item) => item.id === input.candidateId)!
    config = { ...config, revision: config.revision + 1, updatedAt: Date.now(), adoptedOutputs: candidate.outputs
      .filter((output) => input.selectedKeys.includes(output.key))
      .map((output) => ({ ...output, candidateId: candidate.id, runId: candidate.runId })) }
    return structuredClone(config)
  },
  canvasMediaReadPreview: async (input): Promise<CanvasMediaOutputPreview> => {
    smoke.previewCalls.push({ candidateId: input.candidateId, outputKey: input.outputKey, outputOrder: input.outputOrder })
    if (smoke.failNextPreview) {
      smoke.failNextPreview = false
      throw new Error('隔离预览读取失败')
    }
    const mediaLeaseId = `layout-lease-${smoke.previewCalls.length}`
    const isAudio = input.outputKey === '92.audio'
    const mediaUrl = URL.createObjectURL(isAudio ? audioBlob : videoBlob)
    previewUrls.set(mediaLeaseId, mediaUrl)
    return { candidateId: input.candidateId, outputKey: input.outputKey, outputOrder: input.outputOrder,
      asset: structuredClone(isAudio ? audioAsset : videoAsset), mediaLeaseId, mediaUrl }
  },
  canvasMediaReleasePreview: async (input) => {
    smoke.releasedLeases.push(input.mediaLeaseId)
    const mediaUrl = previewUrls.get(input.mediaLeaseId)
    if (mediaUrl) URL.revokeObjectURL(mediaUrl)
    previewUrls.delete(input.mediaLeaseId)
  },
  canvasMediaExportOutput: async (input) => { smoke.exportCalls.push(structuredClone(input)); return { cancelled: false } },
  onCanvasMediaChanged: () => () => undefined,
  mediaGetSettings: async () => structuredClone(settings),
  mediaWatchProject: async () => undefined,
  mediaUnwatchProject: async () => undefined,
  onMediaRunChanged: () => () => undefined,
}
/** 图片选择器只读取 fixture 字节，导入按钮在 smoke 中不触发。 */
const mediaApi: Pick<MediaPreloadApi, 'mediaReadAssetThumbnail' | 'mediaImportLocalAsset'> = {
  mediaReadAssetThumbnail: async () => ({ bytes: imageBytes, contentType: 'image/png' }),
  mediaImportLocalAsset: async () => null,
}
Object.assign(window, { electronAPI: mediaApi, __mediaWorkbenchLayoutSmoke: smoke })

/** 固定 1100px 页面内改变工作台容器宽度，验证 container 响应式布局。 */
function Fixture(): React.ReactElement {
  const [mode, setMode] = React.useState<FixtureMode>('normal')
  const [width, setWidth] = React.useState(1040)
  const [height, setHeight] = React.useState(720)
  const [generation, setGeneration] = React.useState(0)
  smoke.mode = mode
  smoke.width = width
  smoke.height = height
  smoke.generation = generation
  smoke.setMode = (nextMode) => {
    config = structuredClone(initialConfig)
    candidates = nextMode === 'empty' ? [] : structuredClone(initialCandidates)
    runs = [structuredClone(succeededRun)]
    smoke.failNextPreview = nextMode === 'preview-error'
    setMode(nextMode)
    setGeneration((value) => value + 1)
  }
  smoke.setWidth = setWidth
  smoke.setHeight = setHeight
  return <main className="flex h-screen items-center justify-center overflow-hidden bg-muted p-6 text-foreground">
    <section data-smoke-shell className="max-h-full overflow-hidden border border-border bg-background shadow-sm" style={{ width, height }}>
      <CanvasMediaWorkbench key={`${mode}-${generation}`} target={target} writable={mode !== 'readonly'} adapter={adapter} defaultComfyuiConnectionId="gpu-layout" />
    </section>
  </main>
}

document.documentElement.classList.toggle('dark', new URLSearchParams(location.search).get('theme') !== 'light')
/** 显式卸载入口用于验证当前媒体 lease 在组件结束时释放。 */
const root = createRoot(document.getElementById('root')!)
smoke.unmount = () => root.unmount()
root.render(<Fixture />)
