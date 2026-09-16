import '@fontsource-variable/inter/index.css'
import * as React from 'react'
import { createRoot } from 'react-dom/client'
import { createStore, Provider, useAtomValue } from 'jotai'
import { createEmptyCanvasDocument } from '@proma/shared'
import type { CanvasWorkspaceSnapshot } from '@proma/shared'
import type { NativeCanvasAdapter } from '../src/renderer/components/design/NativeCanvasWorkspace'
import { agentCanvasViewStatesAtom, createAgentCanvasViewKey, updateAgentCanvasViewStateAtom } from '../src/renderer/atoms/agent-canvas-atoms'
import { createNativeCanvasKey, nativeCanvasStatesAtom } from '../src/renderer/atoms/native-canvas-atoms'
import '../src/renderer/styles/globals.css'

/** 纯内存画布使用真实 Workspace、Graph 与 Jotai；无 preload 或业务连接。 */
const target = { projectId: 'smoke-project', canvasId: 'smoke-canvas' }
const sessionId = 'smoke-session'
const store = createStore()
const stateKey = createNativeCanvasKey(target.projectId, target.canvasId)
const viewKey = createAgentCanvasViewKey(sessionId, target.projectId, target.canvasId)
const documentFixture = createEmptyCanvasDocument(target.projectId, target.canvasId, 1)
documentFixture.viewport = { x: 0, y: 0, zoom: 0.1 }
documentFixture.nodes = [
  { id: 'node-a', kind: 'image', imageModuleId: 'image-a', title: '首帧母版', position: { x: 0, y: 0 } },
  { id: 'node-b', kind: 'video', mediaModuleId: 'video-b', title: '镜头', position: { x: 4400, y: -2300 } },
  { id: 'node-c', kind: 'document', documentId: 'doc-c', contentRevision: 0, title: '镜头', position: { x: 8000, y: 5000 } },
  { id: 'node-d', kind: 'document', documentId: 'doc-d', contentRevision: 0, title: '独立备注', position: { x: 9000, y: 5000 } },
]
documentFixture.edges = [
  { id: 'edge-a-b', sourceNodeId: 'node-a', sourcePort: 'image.asset', targetNodeId: 'node-b', targetPort: 'context.image', relation: 'depends-on' },
  { id: 'edge-b-c', sourceNodeId: 'node-b', sourcePort: '', targetNodeId: 'node-c', targetPort: '', relation: 'association' },
]
/** 任何意外图保存都会被测试观察；这里从不运行真实生成。 */
const smoke = {
  saveCalls: 0,
  view: () => store.get(agentCanvasViewStatesAtom).get(viewKey),
  graph: () => store.get(nativeCanvasStatesAtom).get(stateKey)?.snapshot?.document,
  /** 替换权威快照仅用于测试权限、空图和迟到菜单目标。 */
  replace: (empty: boolean, writable: boolean): void => {
    const previous = store.get(nativeCanvasStatesAtom).get(stateKey)
    if (!previous) return
    const snapshot: CanvasWorkspaceSnapshot = { document: { ...documentFixture,
      nodes: empty ? [] : documentFixture.nodes, edges: empty ? [] : documentFixture.edges }, writable, nodeIssues: [] }
    store.set(nativeCanvasStatesAtom, new Map(store.get(nativeCanvasStatesAtom)).set(stateKey, { ...previous, snapshot }))
  },
}
/** 缺省能力保持未连接，load/save 全部落在隔离内存。 */
const adapter: NativeCanvasAdapter = {
  loadCanvas: async () => ({ document: documentFixture, writable: true, nodeIssues: [] }),
  saveCanvas: async () => { smoke.saveCalls += 1; return documentFixture },
  onCanvasChanged: () => () => {},
}
/** 依赖模块可读取 preload 方法引用，任何实际 IPC 都应令隔离测试失败。 */
Object.defineProperty(window, 'electronAPI', { value: new Proxy({}, {
  get: (_target, property) => property === 'platform' ? 'darwin'
    : property === 'onMediaRunChanged' || property === 'onAgentCanvasBindingChanged' ? () => () => {}
    : property === 'listAgentCanvasBindings' ? async () => ({ ok: true, value: [{ ...target, sessionId, linkedCanvasIds: [target.canvasId], updatedAt: 1 }] }) : () => {
    throw new Error(`测试页面意外调用 IPC：${String(property)}`)
  },
}) })
Object.assign(window, { __canvasNavigationSmoke: smoke })
/** preload 引用准备好后才加载包含生产依赖的 Workspace。 */
const { NativeCanvasWorkspace } = await import('../src/renderer/components/design/NativeCanvasWorkspace')
document.documentElement.classList.toggle('dark', new URLSearchParams(location.search).get('theme') === 'dark')

const { AgentCanvasChangeNotice } = await import('../src/renderer/components/agent/AgentCanvasChangeNotice')
const { agentSessionsAtom, currentAgentSessionIdAtom, agentSidePanelOpenAtomFamily, agentDiffPanelTabAtom, agentStreamingStatesAtom } = await import('../src/renderer/atoms/agent-atoms')
const { createAgentCanvasChangeConsumer, agentCanvasChangeNoticesAtom } = await import('../src/renderer/lib/agent-canvas-change-navigation')
store.set(agentSessionsAtom, [{ id: sessionId, title: '修改导航测试', workspaceId: target.projectId, createdAt: 1, updatedAt: 1 }])
store.set(currentAgentSessionIdAtom, sessionId)
store.set(agentSidePanelOpenAtomFamily(sessionId), false)
/** 关联来自隔离 fixture，不接通实际 IPC。 */
const consumer = createAgentCanvasChangeConsumer(store, { listBindings: async () => [{ ...target, sessionId, linkedCanvasIds: [target.canvasId], updatedAt: 1 }] })
store.set(agentSidePanelOpenAtomFamily(sessionId), false)
Object.assign(smoke, {
  start: (id: string): void => consumer.handle(sessionId, { type: 'tool_start', toolUseId: id, toolName: 'canvas_update_artifact', input: {} }),
  change: (id: string, nodeIds: string[], revision = 0): void => consumer.handle(sessionId, { type: 'tool_result', toolUseId: id, isError: false,
    result: JSON.stringify({ navigation: { status: 'changed', ...target, nodeIds, revision, sourceToolCallId: id } }) }),
  run: (startedAt: number): void => { store.set(agentStreamingStatesAtom, new Map([[sessionId, { running: true, startedAt }]])); consumer.beginRun(sessionId) },
  dirty: (dirty: boolean): void => store.set(updateAgentCanvasViewStateAtom, { key: viewKey, update: { workbenchDraft: dirty ? { nodeId: 'node-c', dirty } : null } }),
  tab: () => store.get(agentDiffPanelTabAtom).get(sessionId),
  notice: () => store.get(agentCanvasChangeNoticesAtom).get(viewKey),
  graphRevision: (revision: number): void => {
    const previous = store.get(nativeCanvasStatesAtom).get(stateKey)!
    store.set(nativeCanvasStatesAtom, new Map(store.get(nativeCanvasStatesAtom)).set(stateKey, { ...previous,
      snapshot: { ...previous.snapshot!, document: { ...previous.snapshot!.document, revision } } }))
  },
})
/** 回执之前未挂载画布，验证自动打开后的真实 LOAD 与居中链路。 */
function Fixture(): React.ReactElement {
  const open = useAtomValue(agentSidePanelOpenAtomFamily(sessionId))
  return <main className="h-screen flex flex-col bg-background text-foreground">
    <AgentCanvasChangeNotice sessionId={sessionId} projectId={target.projectId} canvasTitles={[{ id: target.canvasId, title: '短片设计' }]} />
    <div className="flex-1 min-h-0">{open && <NativeCanvasWorkspace target={target} sessionId={sessionId} title="画布修改验证" adapter={adapter} />}</div>
  </main>
}
createRoot(document.getElementById('root')!).render(<Provider store={store}><Fixture /></Provider>)
