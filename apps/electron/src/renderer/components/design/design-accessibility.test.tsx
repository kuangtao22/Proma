import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createEmptyDesignDocument } from '@proma/shared'
import { createStore, Provider } from 'jotai'
import { renderToStaticMarkup } from 'react-dom/server'
import { createInitialDesignProjectState, designProjectStatesAtom } from '@/atoms/design-atoms'
import { DesignAssetNode } from './DesignAssetNode'
import { DesignInspectorStateView } from './DesignInspector'
import { DesignToolbar } from './DesignToolbar'

/** 渲染可写空检查器，验证 tabs 与导入入口的无障碍合同。 */
function renderInspector(): string {
  const document = createEmptyDesignDocument('project-1', 1)
  return renderToStaticMarkup(
    <DesignInspectorStateView
      state={{
        ...createInitialDesignProjectState(),
        phase: 'ready',
        snapshot: { document, writable: true },
      }}
      onTabChange={() => undefined}
      onImportAssets={() => undefined}
      onDeleteAsset={() => undefined}
      onRelinkAsset={() => undefined}
      onExportAsset={() => undefined}
      targetSessions={[]}
      onGroupSelection={() => undefined}
      onSelectAsset={() => undefined}
      onClearSelection={() => undefined}
      onCreateJob={() => undefined}
      onImageModelChange={() => undefined}
      onConfigureImageModels={() => undefined}
      onRetryImageModels={() => undefined}
    />,
  )
}

describe('Design 无障碍、窄窗口与主题合同', () => {
  test('Given 图标工具栏 When 渲染 Then 每个命令都有 accessible name、Tooltip 和固定 32px 按钮', () => {
    const toolbarSource = readFileSync(join(import.meta.dir, 'DesignToolbar.tsx'), 'utf8')
    const html = renderToStaticMarkup(
      <DesignToolbar
        activeTool="select"
        writable
        canUndo
        canRedo
        onToolChange={() => undefined}
        onUndo={() => undefined}
        onRedo={() => undefined}
        onGroup={() => undefined}
        onUngroup={() => undefined}
        onArrowTool={() => undefined}
        onMaskTool={() => undefined}
        onImportAssets={() => undefined}
      />,
    )

    for (const name of ['选择', '平移', '撤销', '重做', '分组', '取消分组', '箭头批注', '画笔蒙版', '导入图片']) {
      expect(html).toContain(`aria-label="${name}"`)
    }
    expect(toolbarSource).toContain('<Tooltip>')
    expect(toolbarSource).toContain('<TooltipContent side="bottom">{label}</TooltipContent>')
    expect(html).toContain('h-8 w-8')
    expect(html).toContain('flex-wrap')
  })

  test('Given 工具栏命令不可用 When 键盘导航 Then Tooltip 包装元素可聚焦且按钮保持原生禁用', () => {
    const html = renderToStaticMarkup(
      <DesignToolbar
        activeTool="select"
        writable
        canUndo={false}
        canRedo={false}
        onToolChange={() => undefined}
        onUndo={() => undefined}
      />,
    )

    expect(html).toMatch(
      /<span(?=[^>]*tabindex="0")(?=[^>]*aria-description="撤销不可用")[^>]*><button(?=[^>]*aria-label="撤销")(?=[^>]*disabled)[^>]*>/,
    )
  })

  test('Given 检查器 When 渲染 Then tabs 与导入按钮具有稳定 accessible name 且不嵌套 card', () => {
    const html = renderInspector()

    for (const name of ['素材', 'AI 编辑', '版本', '导入图片']) expect(html).toContain(name)
    expect(html).toContain('role="tablist"')
    expect(html).toContain('aria-label="导入图片"')
    expect(html).not.toContain('data-design-inspector-card')
  })

  test('Given 生图模型字段 When 检查源码 Then 复用 Select、固定 32px 与 4px 圆角且保留焦点样式', () => {
    const inspectorSource = readFileSync(join(import.meta.dir, 'DesignInspector.tsx'), 'utf8')

    expect(inspectorSource).toContain('id="design-image-model"')
    expect(inspectorSource).toContain('disabled:opacity-100')
    expect(inspectorSource).toContain('disabled:bg-muted/40')
    expect(inspectorSource).toContain('disabled:text-muted-foreground')
    expect(inspectorSource).toContain('disabled:border-border/60')
    expect(inspectorSource).toContain('<Tooltip>')
    expect(inspectorSource).not.toContain('onKeyDown=')
    expect(inspectorSource).toContain("setSettingsTab('tools')")
    expect(inspectorSource).toContain("setToolSettingsFocus('nano-banana')")
    expect(inspectorSource).toContain('setSettingsOpen(true)')
  })

  test('Given 失败与运行任务 When 渲染 Then 状态、retry 和 cancel 同时提供文字与 accessible name', () => {
    const store = createStore()
    const failed = renderToStaticMarkup(
      <Provider store={store}>
        <DesignAssetNode
          id="failed-node"
          type="designAsset"
          selected={false}
          dragging={false}
          draggable
          selectable
          deletable={false}
          zIndex={0}
          isConnectable={false}
          positionAbsoluteX={0}
          positionAbsoluteY={0}
          data={{
            kind: 'job', status: 'failed', title: '图片任务', projectId: 'project-1',
            jobId: 'job-1', writable: true, authoritativeRecoveryState: 'idle',
          }}
        />
      </Provider>,
    )
    const running = renderToStaticMarkup(
      <Provider store={store}>
        <DesignAssetNode
          id="running-node"
          type="designAsset"
          selected={false}
          dragging={false}
          draggable
          selectable
          deletable={false}
          zIndex={0}
          isConnectable={false}
          positionAbsoluteX={0}
          positionAbsoluteY={0}
          data={{
            kind: 'job', status: 'running', title: '图片任务', projectId: 'project-1',
            jobId: 'job-2', writable: true, authoritativeRecoveryState: 'idle',
          }}
        />
      </Provider>,
    )

    expect(failed).toContain('生成失败')
    expect(failed).toContain('重试生成')
    expect(running).toContain('正在生成')
    expect(running).toContain('取消生成')
  })

  test('Given 960px 以下窗口 When 检查布局源码 Then 右栏最多 300px、元数据可换行且主题只用变量', () => {
    const inspectorSource = readFileSync(join(import.meta.dir, 'DesignInspector.tsx'), 'utf8')
    const toolbarSource = readFileSync(join(import.meta.dir, 'DesignToolbar.tsx'), 'utf8')
    const assetNodeSource = readFileSync(join(import.meta.dir, 'DesignAssetNode.tsx'), 'utf8')
    const sources = `${inspectorSource}\n${toolbarSource}\n${assetNodeSource}`

    expect(inspectorSource).toContain('max-[960px]:max-w-[300px]')
    expect(inspectorSource).toContain('min-w-0 break-words')
    expect(toolbarSource).toContain('flex-wrap')
    expect(sources).not.toMatch(/(?:text|bg)-\[(?:#|rgb|hsl)/)
    expect(sources).not.toMatch(/(?:text|bg)-(?:white|black)\b/)
  })
})
