import '@fontsource-variable/inter/index.css'
import * as React from 'react'
import { createRoot } from 'react-dom/client'
import { createEmptyCanvasDocument, inspectCanvasMediaInputConnections } from '@proma/shared'
import type { CanvasDocument, CanvasMediaModuleConfig, CanvasMediaPreparationStatus, CanvasMediaTarget, CanvasNode } from '@proma/shared'
import { CanvasMediaWorkbench, type CanvasMediaWorkbenchAdapter } from '../src/renderer/components/design/CanvasMediaWorkbench'
import { CanvasMediaSourcePicker, type CanvasMediaSourcePickerValue } from '../src/renderer/components/design/CanvasMediaSourcePicker'
import { NativeCanvasToolbar } from '../src/renderer/components/design/NativeCanvasToolbar'
import { useCanvasMediaNodeProgress } from '../src/renderer/components/design/use-media-run-progress'
import { connectCanvasMediaInputs } from '../src/renderer/components/design/canvas-media-connect-command'
import '../src/renderer/styles/globals.css'

/** 隔离的七个镜头身份，不访问业务目录。 */
const targets: CanvasMediaTarget[] = Array.from({ length: 7 }, (_, index) => ({
  projectId: 'organization-project', canvasId: 'organization-canvas', nodeId: `shot-${index + 1}`,
  mediaModuleId: `module-${index + 1}`, mediaKind: 'video',
}))
/** 所有数据驻留内存；图初始只接文档边，故每个镜头缺两条图片边。 */
let graph: CanvasDocument = {
  ...createEmptyCanvasDocument(targets[0]!.projectId, targets[0]!.canvasId),
  nodes: [
    ...targets.map((target, index): CanvasNode => ({ id: target.nodeId, kind: 'video', mediaModuleId: target.mediaModuleId, title: `S${index + 1} 视频`, position: { x: 500, y: index * 150 } })),
    ...[1, 2].map((index): CanvasNode => ({ id: `image-${index}`, kind: 'image', imageModuleId: `image-module-${index}`, adoptedAssetId: `asset-${index}`, title: index === 1 ? '首帧 · 室内远景' : '尾帧 · 人物近景', position: { x: 0, y: index * 150 } })),
    { id: 'prompt', kind: 'document', documentId: 'prompt-content', contentRevision: 1, title: '镜头动态提示词', position: { x: 0, y: 450 } },
    ...['a', 'b'].map((key): CanvasNode => ({ id: `source-${key}`, kind: 'video', mediaModuleId: `source-module-${key}`, title: `预合成 ${key.toUpperCase()}`, position: { x: 0, y: 650 } })),
  ],
  edges: targets.map((target) => ({ id: `text-${target.nodeId}`, sourceNodeId: 'prompt', sourcePort: 'document.markdown', targetNodeId: target.nodeId, targetPort: 'context.text', relation: 'depends-on' })),
}
/** 每份草稿包含需保留的标量，验证未绑定工作流时保存不丢字段。 */
const configs = new Map<string, CanvasMediaModuleConfig>(targets.map((target) => [target.mediaModuleId, {
  schemaVersion: 1, contentId: target.mediaModuleId, mediaKind: 'video', revision: 1, createdAt: 1, updatedAt: 1,
  profile: null, workflow: null, preparation: null, adoptedOutputs: [],
  inputs: [
    { key: 'first', kind: 'image', source: { type: 'canvas-output', nodeId: 'image-1', outputKey: 'image.asset' } },
    { key: 'last', kind: 'image', source: { type: 'canvas-output', nodeId: 'image-2', outputKey: 'image.asset' } },
    { key: 'prompt', kind: 'text', source: { type: 'canvas-output', nodeId: 'prompt', outputKey: 'document.markdown' } },
    { key: 'seed', kind: 'number', source: { type: 'literal', value: 42 } },
    { key: 'sound', kind: 'boolean', source: { type: 'literal', value: true } },
    { key: 'note', kind: 'text', source: { type: 'literal', value: '保留镜头备注' } },
  ], outputs: [{ key: 'clip', mediaKind: 'video', role: 'primary', order: 0 }],
}]))
/** 模块通知复用生产适配器事件边界。 */
const listeners = new Set<Parameters<CanvasMediaWorkbenchAdapter['onCanvasMediaChanged']>[0]>()
/** 测试驱动只观察调用与控制延迟，不接触文件或真实媒体服务。 */
const smoke = {
  saves: [] as Parameters<CanvasMediaWorkbenchAdapter['canvasMediaSave']>[0][],
  graphSaves: 0, locked: false, runCalls: 0, loadCalls: 0, configReads: [] as string[],
  delayedOutputs: [] as Array<() => void>, delayedPreparation: [] as Array<() => void>,
  /** 延迟旧节点保存，复现切换详情后的命令回调交错。 */
  delayedSaves: [] as Array<() => void>, holdSave: false,
  holdOutputs: true, holdPreparation: false, ready: false,
  selection: null as CanvasMediaSourcePickerValue | null,
  graph: () => graph, config: () => configs.get('module-1')!,
  setGraph: (_graph: CanvasDocument): void => {}, setReadonly: (_readonly: boolean): void => {},
  setTargetIndex: (_index: number): void => {},
  unmount: (): void => {},
}
/** 只读准备结果以调用时配置与图为准，允许延迟返回来测试过期响应。 */
async function checkPreparation(target: CanvasMediaTarget): Promise<CanvasMediaPreparationStatus> {
  const config = configs.get(target.mediaModuleId)!
  const connected = inspectCanvasMediaInputConnections(graph, target, config.inputs).connected
  const status: CanvasMediaPreparationStatus = { configRevision: config.revision,
    workflowBound: smoke.ready, inputsReady: connected, ready: smoke.ready && connected,
    issues: smoke.ready ? [] : [{ code: 'CANVAS_MEDIA_SOURCE_REQUIRED', message: '尚未绑定工作流，请先选择工作流。' }] }
  return smoke.holdPreparation ? new Promise((resolve) => smoke.delayedPreparation.push(() => resolve(status))) : status
}
/** 完整生产组件的内存适配器：写操作保留 revision，运行入口只计数。 */
const adapter: CanvasMediaWorkbenchAdapter = {
  canvasMediaLoad: async (target) => {
    smoke.loadCalls += 1
    return { target, config: structuredClone(configs.get(target.mediaModuleId)!), candidates: [], runs: [], assets: [] }
  },
  canvasMediaReadConfig: async (target) => {
    smoke.configReads.push(target.nodeId)
    const config: CanvasMediaModuleConfig = { ...structuredClone(configs.get('module-1')!), contentId: target.mediaModuleId,
      outputs: [{ key: `${target.nodeId}.final`, mediaKind: 'video', role: 'primary', order: 0 },
        { key: `${target.nodeId}.preview`, mediaKind: 'video', role: 'preview', order: 1 }] }
    return smoke.holdOutputs ? new Promise((resolve) => smoke.delayedOutputs.push(() => resolve(config))) : config
  },
  canvasMediaCheckPreparation: checkPreparation,
  canvasMediaSave: async (input) => {
    smoke.saves.push(structuredClone(input))
    if (smoke.holdSave) await new Promise<void>((resolve) => smoke.delayedSaves.push(resolve))
    const previous = configs.get(input.mediaModuleId)!
    if (input.expectedConfigRevision !== previous.revision) throw new Error('CANVAS_MEDIA_CONFIG_CONFLICT')
    const config = { ...previous, revision: previous.revision + 1, profile: input.profile, workflow: input.workflow,
      inputs: input.inputs, outputs: input.outputs }
    configs.set(input.mediaModuleId, config)
    for (const listener of listeners) listener({ target: input, revision: config.revision })
    return structuredClone(config)
  },
  canvasMediaRun: async () => { smoke.runCalls += 1; throw new Error('隔离夹具不执行生成') },
  canvasMediaCancel: async () => { throw new Error('没有运行') },
  canvasMediaAdopt: async () => { throw new Error('没有候选') },
  canvasMediaReadPreview: async () => { throw new Error('没有预览') },
  canvasMediaReleasePreview: async () => {},
  canvasMediaExportOutput: async () => ({ cancelled: true }),
  onCanvasMediaChanged: (listener) => { listeners.add(listener); return () => { listeners.delete(listener) } },
  mediaGetSettings: async () => ({ schemaVersion: 1, revision: 1, authorizationMode: 'ask', connections: [], workflows: [], profiles: [] }),
  mediaWatchProject: async () => {}, mediaUnwatchProject: async () => {}, onMediaRunChanged: () => () => {},
}
/** 使用已有授权图片URL，避免向主进程请求用户图片。 */
const previews = [1, 2].map((index) => ({ assetId: `asset-${index}`, width: 256, height: 256, previewUrl: new URL('../resources/proma-logos/proma-emerald.png', import.meta.url).href }))
/** fixture 装配真实工作台、进度 hook、补线命令与 Radix 来源选择器。 */
function Fixture(): React.ReactElement {
  const [document, setDocument] = React.useState(graph)
  const [readonly, setReadonly] = React.useState(false)
  const [selection, setSelection] = React.useState<CanvasMediaSourcePickerValue | null>(null)
  /** 切换同一组件的真实媒体身份，不通过强制卸载掩盖过期回调。 */
  const [targetIndex, setTargetIndex] = React.useState(0)
  const activeTarget = targets[targetIndex]!
  const progress = useCanvasMediaNodeProgress(targets, adapter, document)
  smoke.setReadonly = setReadonly
  smoke.setGraph = (next) => { graph = next; setDocument(next) }
  smoke.selection = selection
  smoke.setTargetIndex = setTargetIndex
  return <main className="h-screen space-y-3 overflow-auto bg-muted p-4 text-foreground">
    <div className="relative" style={{ height: 52 }}><NativeCanvasToolbar activeTool="select" writable={!readonly} canDelete={false} issueCount={1}
      mediaPreparationCount={[...progress.values()].filter((item) => item.preparation?.needsAttention).length}
      onFocusMediaPreparation={() => {}} onToolChange={() => {}} onAddNode={() => {}} onDelete={() => {}} onFocusFirstIssue={() => {}} /></div>
    <section className="overflow-hidden border border-border bg-background" style={{ height: 660 }} data-smoke-shell>
      <CanvasMediaWorkbench target={activeTarget} writable={!readonly} adapter={adapter} canvasDocument={document} imagePreviews={previews}
        onConnectInputs={(config) => connectCanvasMediaInputs({ target: activeTarget, config,
          createOperationId: () => crypto.randomUUID(),
          getCurrentContext: () => ({ workspaceKey: 'fixture', document: graph, permissionWritable: !readonly, blockedNodeIds: new Set() }),
          beginOperation: () => { if (smoke.locked) return false; smoke.locked = true; return true },
          endOperation: () => { smoke.locked = false }, checkPreparation,
          save: async (input) => {
            if (input.expectedRevision !== graph.revision) throw new Error('CANVAS_REVISION_CONFLICT')
            smoke.graphSaves += 1
            return { ...graph, revision: graph.revision + 1, edges: [...graph.edges, ...input.mutations.flatMap((mutation) => mutation.type === 'upsert-edges' ? mutation.edges : [])] }
          }, onSuccess: smoke.setGraph,
        })} />
    </section>
    <section className="w-96 rounded border border-border bg-background p-3" aria-label="多输出选择验证">
      <CanvasMediaSourcePicker document={document} value={selection} inputKind="video" targetNodeId="shot-1" label="预合成" disabled={readonly}
        loadMediaConfig={async (node) => (await adapter.canvasMediaReadConfig!({ ...targets[0]!, nodeId: node.id, mediaModuleId: node.mediaModuleId })).outputs}
        onChange={setSelection} />
    </section>
  </main>
}
Object.assign(window, { __canvasOrganizationSmoke: smoke })
document.documentElement.classList.toggle('dark', new URLSearchParams(location.search).get('theme') !== 'light')
/** 根句柄仅用于验证卸载后的迟到响应不会更新组件。 */
const root = createRoot(document.getElementById('root')!)
smoke.unmount = () => root.unmount()
root.render(<Fixture />)
