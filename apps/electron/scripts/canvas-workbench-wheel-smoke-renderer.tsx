import '@fontsource-variable/inter/index.css'
import * as React from 'react'
import { applyCanvasMutations, createEmptyCanvasDocument } from '@proma/shared'
import type { CanvasDocument, CanvasMutation, CanvasNode, DesignViewport } from '@proma/shared'
import { atom, Provider, useAtom } from 'jotai'
import { createRoot } from 'react-dom/client'
import { ScrollArea } from '../src/renderer/components/ui/scroll-area'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../src/renderer/components/ui/select'
import { CanvasNodeWorkbenchOverlay } from '../src/renderer/components/design/CanvasNodeWorkbenchOverlay'
import { NativeCanvasGraph } from '../src/renderer/components/design/NativeCanvasGraph'
import '../src/renderer/styles/globals.css'

/** 生产工作台模块会读取 preload 方法引用；隔离 fixture 禁止任何真实 IPC。 */
Object.defineProperty(window, 'electronAPI', { value: new Proxy({}, {
  get: (_target, property) => property === 'platform' ? 'darwin' : () => {
    throw new Error(`工作台滚轮 fixture 意外调用 IPC：${String(property)}`)
  },
}) })
/** preload 占位准备完成后再载入 iframe 生产组件。 */
const { CanvasWebviewPreviewFrame, createSandboxedCanvasWebviewHtml } = await import(
  '../src/renderer/components/design/CanvasWebviewWorkbench'
)

/** 真实 Graph 与详情共同使用的文档节点。 */
const workbenchNode: CanvasNode = {
  id: 'wheel-workbench', kind: 'document', documentId: 'wheel-document', contentRevision: 0,
  title: '滚轮交互详情', position: { x: 120, y: 20 },
}
/** 每次场景从同一稳定低倍视口开始，便于精确比较位移。 */
const initialViewport: DesignViewport = { x: 0, y: 0, zoom: 0.5 }
/** 创建彼此隔离的测试文档，避免 atom 初始值与重置共享可变引用。 */
function createFixtureDocument(): CanvasDocument {
  const document = createEmptyCanvasDocument('wheel-project', 'wheel-canvas', 1)
  document.viewport = { ...initialViewport }
  document.nodes = [workbenchNode]
  return document
}
/** fixture 的唯一文档事实源，视口结束提交也回显给生产 Graph。 */
const documentAtom = atom<CanvasDocument>(createFixtureDocument())

/** Electron 脚本只读取隔离状态，不接触 preload 或用户工作区。 */
interface CanvasWorkbenchWheelSmokeApi {
  viewportMutations: number
  graphMutations: number
  closeCalls: number
  lastWorkbenchWheelPrevented: boolean | null
  reset: () => void
  document: () => CanvasDocument
}

declare global {
  interface Window { __canvasWorkbenchWheelSmoke: CanvasWorkbenchWheelSmokeApi }
}

/** 提供真实溢出区、编辑控件与 Portal 菜单，覆盖详情内的冲突边界。 */
function WorkbenchBody(): React.ReactElement {
  const [selection, setSelection] = React.useState('option-1')
  return <div data-smoke-blank className="grid h-full min-h-0 grid-cols-2 gap-3 overflow-hidden p-3 text-sm"
    onWheel={(event) => { window.__canvasWorkbenchWheelSmoke.lastWorkbenchWheelPrevented = event.defaultPrevented }}>
    <div className="flex min-h-0 flex-col gap-3">
      <ScrollArea data-smoke-scroll className="h-40 rounded border border-border bg-muted/30">
        <div className="space-y-2 p-3">
          {Array.from({ length: 24 }, (_, index) => <p key={index}>滚动列表第 {index + 1} 行</p>)}
        </div>
      </ScrollArea>
      <ScrollArea data-smoke-nonoverflow className="h-24 rounded border border-border bg-muted/30">
        <p className="p-3">无溢出列表空白</p>
      </ScrollArea>
      <Select value={selection} onValueChange={setSelection}>
        <SelectTrigger data-smoke-select aria-label="测试选择菜单"><SelectValue /></SelectTrigger>
        <SelectContent className="max-h-44">
          {Array.from({ length: 20 }, (_, index) => <SelectItem key={index} value={`option-${index + 1}`}>选项 {index + 1}</SelectItem>)}
        </SelectContent>
      </Select>
    </div>
    <div className="flex min-h-0 flex-col gap-3">
      <textarea data-smoke-textarea className="h-32 resize-none overflow-auto rounded border border-border bg-background p-2"
        defaultValue={Array.from({ length: 20 }, (_, index) => `编辑内容第 ${index + 1} 行`).join('\n')} />
      <input data-smoke-number className="h-9 rounded border border-border bg-background px-2" type="number" defaultValue="12" />
      <input data-smoke-range type="range" defaultValue="40" />
      <video data-smoke-media className="h-16 w-full bg-black" controls />
      <CanvasWebviewPreviewFrame
        title="滚轮 iframe"
        className="h-20 w-full border border-border bg-background"
        frameState={{
          key: 'wheel-iframe',
          srcDoc: createSandboxedCanvasWebviewHtml('<style>body{margin:0;height:600px;font:14px sans-serif}</style><p>原型内部滚动</p>'),
        }}
      />
      <div className="min-h-12 flex-1 rounded border border-dashed border-border p-3">详情空白区域</div>
    </div>
  </div>
}

/** 真实生产组件只用 Jotai 内存文档承接 mutation，避免测试触发持久化。 */
function Fixture(): React.ReactElement {
  const [document, setDocument] = useAtom(documentAtom)
  const [revision, setRevision] = React.useState(0)
  const documentRef = React.useRef(document)
  documentRef.current = document

  /** 生产 Graph 的最终视口写回同一 atom；其它 mutation 视为测试失败证据。 */
  const handleMutation = React.useCallback((mutation: CanvasMutation): void => {
    if (mutation.type === 'set-viewport') window.__canvasWorkbenchWheelSmoke.viewportMutations += 1
    else window.__canvasWorkbenchWheelSmoke.graphMutations += 1
    setDocument((current) => applyCanvasMutations(current, [mutation]))
  }, [setDocument])

  window.__canvasWorkbenchWheelSmoke.reset = () => {
    setDocument((current) => ({ ...current, viewport: { ...initialViewport } }))
    setRevision((current) => current + 1)
  }
  window.__canvasWorkbenchWheelSmoke.document = () => documentRef.current

  return <main className="h-screen overflow-hidden bg-background text-foreground">
    <NativeCanvasGraph
      key={revision}
      document={document}
      writable
      activeTool="pan"
      selectedNodeId={workbenchNode.id}
      onMutation={handleMutation}
      onNodeSelect={() => undefined}
      onConversationNodeChange={() => undefined}
      workbenchNode={workbenchNode}
      renderWorkbench={(node, nodeBounds, viewport) => <CanvasNodeWorkbenchOverlay
        node={node}
        nodeBounds={nodeBounds}
        viewport={viewport}
        surfaceSize={{ width: innerWidth, height: innerHeight }}
        size={{ width: 760, height: 560 }}
        dirty={false}
        onDirtyChange={() => undefined}
        onClose={() => { window.__canvasWorkbenchWheelSmoke.closeCalls += 1 }}
      ><WorkbenchBody /></CanvasNodeWorkbenchOverlay>}
    />
  </main>
}

window.__canvasWorkbenchWheelSmoke = {
  viewportMutations: 0,
  graphMutations: 0,
  closeCalls: 0,
  lastWorkbenchWheelPrevented: null,
  reset: () => undefined,
  document: createFixtureDocument,
}

createRoot(document.getElementById('root')!).render(<Provider><Fixture /></Provider>)
