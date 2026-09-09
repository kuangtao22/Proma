import '@fontsource-variable/inter/index.css'
import * as React from 'react'
import { createRoot } from 'react-dom/client'
import type { CanvasNodeActivityState, CanvasNodeKind } from '@proma/shared'
import { ReactFlowProvider } from '@xyflow/react'
import existingPreviewUrl from '../src/renderer/assets/onboarding/hopper-seaside-white-house.png'
import { Button } from '../src/renderer/components/ui/button'
import { CanvasNodeCard } from '../src/renderer/components/design/CanvasNodeCard'
import '../src/renderer/styles/globals.css'

/** 隔离页面覆盖全部节点类型，验证统一卡片壳而非某一种业务节点。 */
const NODE_FIXTURES: ReadonlyArray<{ kind: CanvasNodeKind; title: string }> = [
  { kind: 'agent', title: '创作 Agent' },
  { kind: 'image', title: '首次生成图片' },
  { kind: 'audio', title: '配乐' },
  { kind: 'video', title: '分镜视频' },
  { kind: 'document', title: '脚本文档' },
  { kind: 'webview', title: '页面原型' },
]

/** fixture 只切换本地活动态，不调用任何应用 API。 */
function Fixture(): React.ReactElement {
  /** 当前活动态由可见按钮驱动，便于真实交互验证状态收口。 */
  const [activityState, setActivityState] = React.useState<CanvasNodeActivityState>('idle')
  return (
    <main className="design-canvas min-h-screen bg-background p-5 text-foreground">
      <div className="mx-auto max-w-[980px]">
        <header className="mb-5 flex flex-wrap items-center gap-2">
          <h1 className="mr-auto text-base font-semibold">Canvas 节点运行反馈</h1>
          <Button type="button" variant="outline" onClick={() => setActivityState('queued')}>排队</Button>
          <Button type="button" variant="outline" onClick={() => setActivityState('running')}>运行</Button>
          <Button type="button" variant="outline" onClick={() => setActivityState('idle')}>终态</Button>
        </header>
        <p data-smoke-state className="mb-4 text-sm text-muted-foreground">当前状态：{activityState}</p>
        <ReactFlowProvider>
          <section className="grid grid-cols-1 gap-5 md:grid-cols-2 xl:grid-cols-3">
            {NODE_FIXTURES.map(({ kind, title }) => (
              <div key={kind} data-smoke-node={kind} className="min-w-0 overflow-visible p-2">
                <CanvasNodeCard
                  id={`${kind}-smoke`}
                  kind={kind}
                  title={title}
                  statusLabel={activityState === 'idle' ? '已完成' : activityState === 'queued' ? '排队中' : '运行中'}
                  activityState={activityState}
                  summary="隔离组件验证"
                  selected={false}
                  canOpenWorkbench={false}
                  canCreateChild={false}
                  {...(kind === 'image' ? { previewUrl: existingPreviewUrl } : {})}
                />
              </div>
            ))}
          </section>
        </ReactFlowProvider>
      </div>
    </main>
  )
}

createRoot(document.getElementById('root')!).render(<Fixture />)
