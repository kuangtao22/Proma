import '@fontsource-variable/inter/index.css'
import * as React from 'react'
import { createRoot } from 'react-dom/client'
import type {
  CanvasMediaModelScope,
  CanvasMediaModuleConfig,
  CanvasMediaModuleSnapshot,
  CanvasMediaTarget,
  DesignImageModelSelection,
  MediaSettingsSnapshot,
  MediaWorkflowVersion,
} from '@proma/shared'
import { CanvasComfyUiConnectionPicker } from '../src/renderer/components/design/CanvasComfyUiConnectionPicker'
import { CanvasMediaModelPicker } from '../src/renderer/components/design/CanvasMediaModelPicker'
import { NativeCanvasToolbar } from '../src/renderer/components/design/NativeCanvasToolbar'
import { CanvasMediaWorkbench, type CanvasMediaWorkbenchAdapter } from '../src/renderer/components/design/CanvasMediaWorkbench'
import '../src/renderer/styles/globals.css'

/** 仅保存 fixture 内存状态，验收不操作真实配置。 */
const smoke = { connectionId: null as string | null, changes: [] as Array<string | null>,
  scope: { mode: 'all-enabled' } as CanvasMediaModelScope, markUnavailable: () => {},
  mediaSaveCount: 0, mediaRunCount: 0, remountMedia: () => {} }
Object.assign(window, { __comfySmoke: smoke })

/** 隔离验收使用的真实工作流字段合同，包含基础字段、必填素材和两个高级参数。 */
const mediaWorkflow: MediaWorkflowVersion = {
  id: 'smoke-workflow', name: 'Smoke 视频工作流', projectId: null, revision: 1,
  hash: 'a'.repeat(64), createdAt: 1,
  definition: {
    schemaVersion: 1,
    prompt: {
      text: { class_type: 'TextNode', inputs: { text: '模板默认值' } },
      image: { class_type: 'LoadImage', inputs: { image: '' } },
      sampler: { class_type: 'KSampler', inputs: { seed: 1, steps: 20 } },
    },
    bindings: [
      { key: 'prompt', kind: 'text', nodeId: 'text', input: 'text', field: {
        classType: 'TextNode', valueKind: 'string', label: '提示词', controlType: 'text', required: true,
      } },
      { key: 'reference', kind: 'image', nodeId: 'image', input: 'image', loader: 'LoadImage', field: {
        classType: 'LoadImage', valueKind: 'string', label: '参考图', controlType: 'image', required: true,
      } },
      { key: 'seed', kind: 'number', nodeId: 'sampler', input: 'seed', field: {
        classType: 'KSampler', valueKind: 'number', label: '种子', controlType: 'seed', required: true,
      } },
      { key: 'steps', kind: 'number', nodeId: 'sampler', input: 'steps', field: {
        classType: 'KSampler', valueKind: 'number', label: '步数', controlType: 'number', required: true, min: 1, max: 100,
      } },
    ],
    outputs: [{ key: 'video', nodeId: 'save', outputIndex: 0, mediaType: 'video' }],
  },
}

/** 音视频卡片目标只存在于临时 fixture。 */
const mediaTarget: CanvasMediaTarget = {
  projectId: 'smoke', canvasId: 'canvas-smoke', nodeId: 'video-smoke', mediaModuleId: 'media-smoke', mediaKind: 'video',
}
/** 内存配置模拟主进程 CAS，重挂载时仍能读到已保存的部分字段。 */
let mediaConfig: CanvasMediaModuleConfig = {
  schemaVersion: 1, contentId: mediaTarget.mediaModuleId, mediaKind: 'video', revision: 1,
  createdAt: 1, updatedAt: 1, profile: null,
  workflow: { workflowId: mediaWorkflow.id, workflowRevision: 1, connectionId: 'gpu-a' },
  preparation: { code: 'UI_INPUT_UNKNOWN', message: '节点 image 的参考图尚未绑定。' },
  inputs: [
    { key: 'prompt', kind: 'text', source: { type: 'literal', value: '已保存提示词' } },
    { key: 'seed', kind: 'number', source: { type: 'literal', value: 1 } },
    { key: 'steps', kind: 'number', source: { type: 'literal', value: 20 } },
  ],
  outputs: [{ key: 'video', mediaKind: 'video', role: 'primary', order: 0 }], adoptedOutputs: [],
}
const mediaSettings: MediaSettingsSnapshot = {
  schemaVersion: 1, revision: 1,
  connections: [{ id: 'gpu-a', name: 'ComfyUI RTX 3090', driver: 'comfyui', enabled: true,
    revision: 1, instanceGeneration: 'smoke', credentialConfigured: false }],
  workflows: [mediaWorkflow], profiles: [],
}
/** Fake adapter 不接触服务端；canvasMediaRun 只计数，验收不得调用它。 */
const mediaAdapter: CanvasMediaWorkbenchAdapter = {
  canvasMediaLoad: async (): Promise<CanvasMediaModuleSnapshot> => ({
    target: mediaTarget, config: structuredClone(mediaConfig), candidates: [], runs: [{
      id: 'failed-run', projectId: 'smoke', revision: 2, phase: 'failed', createdAt: 1, updatedAt: 2,
      outputs: [], progress: null, error: '远端节点 sampler 执行失败。',
    }],
    assets: [{ id: 'asset-image', revision: 1, hash: 'b'.repeat(64), filename: 'reference.png', byteSize: 10,
      mediaType: 'image/png', mediaKind: 'image', metadata: { width: 16, height: 16 }, createdAt: 1 }],
  }),
  canvasMediaSave: async (input) => {
    smoke.mediaSaveCount += 1
    mediaConfig = { ...mediaConfig, revision: mediaConfig.revision + 1, updatedAt: Date.now(),
      profile: input.profile, workflow: input.workflow, preparation: input.preparation ?? null,
      inputs: structuredClone(input.inputs), outputs: structuredClone(input.outputs) }
    return structuredClone(mediaConfig)
  },
  canvasMediaRun: async () => { smoke.mediaRunCount += 1; throw new Error('SMOKE 不允许提交真实运行') },
  canvasMediaCancel: async () => { throw new Error('SMOKE 没有运行') },
  canvasMediaAdopt: async () => structuredClone(mediaConfig),
  canvasMediaReadPreview: async () => { throw new Error('SMOKE 没有预览') },
  canvasMediaReleasePreview: async () => undefined,
  canvasMediaExportOutput: async () => ({ cancelled: true }),
  onCanvasMediaChanged: () => () => undefined,
  mediaGetSettings: async () => structuredClone(mediaSettings),
  mediaWatchProject: async () => undefined,
  mediaUnwatchProject: async () => undefined,
  onMediaRunChanged: () => () => undefined,
}

/** 静态 API 模型样例，统一弹层验收不会读取用户配置。 */
async function getImageModelSelection(projectId: string): Promise<DesignImageModelSelection> {
  return { projectId, options: [{ profileId: 'image-api', name: 'GPT Image 2', modelId: 'gpt-image-2',
    channelId: 'GPT', executor: 'openai-images', available: true }] }
}

/** 生产工具栏和选择器组合，检查尺寸、选择及失效状态。 */
function Fixture(): React.ReactElement {
  const [connectionId, setConnectionId] = React.useState<string | null>(null)
  const [available, setAvailable] = React.useState(true)
  /** 模型选择和服务器绑定由两个独立状态保存。 */
  const [scope, setScope] = React.useState<CanvasMediaModelScope>(smoke.scope)
  const [mediaGeneration, setMediaGeneration] = React.useState(0)
  smoke.markUnavailable = () => setAvailable(false)
  smoke.remountMedia = () => setMediaGeneration((value) => value + 1)
  return <main className="design-canvas relative h-screen overflow-hidden bg-background text-foreground">
    <NativeCanvasToolbar activeTool="select" writable canDelete={false} issueCount={0}
      onToolChange={() => {}} onAddNode={() => {}} onDelete={() => {}} onFocusFirstIssue={() => {}}
      mediaModelPicker={<CanvasMediaModelPicker projectId="smoke" scope={scope}
        getImageModelSelection={getImageModelSelection}
        onChange={(next) => { smoke.scope = next; setScope(next) }}
        connectionPicker={<CanvasComfyUiConnectionPicker connectionId={connectionId} disabled={false}
          connections={[{ id: 'gpu-a', name: 'ComfyUI RTX 3090', available }, { id: 'gpu-b', name: '远端视频生成服务器 GPU B', available: true }]}
          onChange={(next) => { smoke.connectionId = next; smoke.changes.push(next); setConnectionId(next) }} />}
      />} />
    <section data-smoke-media className="absolute inset-x-4 bottom-4 top-20 overflow-hidden border border-border bg-background shadow-sm sm:left-auto sm:w-[620px]">
      <CanvasMediaWorkbench key={mediaGeneration} target={mediaTarget} writable adapter={mediaAdapter} defaultComfyuiConnectionId="gpu-a" />
    </section>
  </main>
}

/** URL 控制主题，避免改变应用偏好。 */
document.documentElement.classList.toggle('dark', new URLSearchParams(location.search).get('theme') !== 'light')
createRoot(document.getElementById('root')!).render(<Fixture />)
