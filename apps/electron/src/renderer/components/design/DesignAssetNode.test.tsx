import { describe, expect, test } from 'bun:test'
import { createEmptyDesignDocument } from '@proma/shared'
import type { NodeProps } from '@xyflow/react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createInitialDesignProjectState } from '@/atoms/design-atoms'
import { TooltipProvider } from '@/components/ui/tooltip'
import {
  DesignAssetNode,
  type DesignAssetFlowNode,
  type DesignAssetNodeData,
} from './DesignAssetNode'
import { DesignToolbar } from './DesignToolbar'
import { DesignWorkspaceStateView } from './DesignWorkspaceView'

/** 创建 XYFlow 自定义节点静态渲染所需的完整属性。 */
function createNodeProps(data: DesignAssetNodeData): NodeProps<DesignAssetFlowNode> {
  return {
    id: 'node-1',
    type: 'designAsset',
    data,
    width: 320,
    height: 240,
    dragging: false,
    zIndex: 1,
    selectable: true,
    deletable: false,
    selected: false,
    draggable: true,
    isConnectable: false,
    positionAbsoluteX: 0,
    positionAbsoluteY: 0,
  }
}

/** 静态渲染一种节点状态，便于验证无浏览器环境下的稳定 HTML。 */
function renderStatus(data: DesignAssetNodeData): string {
  return renderToStaticMarkup(<DesignAssetNode {...createNodeProps(data)} />)
}

describe('Design 素材节点', () => {
  test('Given 已完成素材 When 渲染 Then 使用固定尺寸且图片不可原生拖拽', () => {
    const html = renderStatus({
      kind: 'asset',
      status: 'success',
      assetId: 'asset-1',
      title: '海报.png',
      pixelWidth: 1600,
      pixelHeight: 1200,
      previewUrl: 'proma-file://thumbs/poster.webp',
    })

    expect(html).toContain('style="width:320px;height:240px"')
    expect(html).toContain('src="proma-file://thumbs/poster.webp"')
    expect(html).toContain('alt="海报.png"')
    expect(html).toContain('draggable="false"')
    expect(html).toContain('已完成')
    expect(html).not.toContain('重试生成')
  })

  test('Given 排队和运行任务 When 渲染 Then 显示明确进度状态且不提供重试', () => {
    const queued = renderStatus({ kind: 'job', status: 'queued', jobId: 'job-1', title: '图片任务' })
    const running = renderStatus({ kind: 'job', status: 'running', jobId: 'job-2', title: '图片任务' })

    expect(queued).toContain('等待生成')
    expect(running).toContain('正在生成')
    expect(queued).not.toContain('重试生成')
    expect(running).not.toContain('重试生成')
  })

  test('Given 失败或取消任务 When 渲染 Then 仅这两态提供重试入口', () => {
    const failed = renderStatus({
      kind: 'job',
      status: 'failed',
      jobId: 'job-1',
      title: '图片任务',
      error: '模型返回失败',
    })
    const cancelled = renderStatus({ kind: 'job', status: 'cancelled', jobId: 'job-2', title: '图片任务' })

    expect(failed).toContain('生成失败')
    expect(failed).toContain('模型返回失败')
    expect(failed).toContain('重试生成')
    expect(cancelled).toContain('已取消')
    expect(cancelled).toContain('重试生成')
  })

  test('Given 素材记录缺失 When 渲染 Then 明确提示素材缺失且不提供任务重试', () => {
    const html = renderStatus({
      kind: 'asset',
      status: 'missing',
      assetId: 'asset-1',
      title: '素材缺失',
    })

    expect(html).toContain('素材缺失')
    expect(html).not.toContain('<img')
    expect(html).not.toContain('重试生成')
  })
})

describe('Design 画布工具栏', () => {
  test('Given 可写画布 When 渲染 Then 提供选择平移分段模式和全部图标命令', () => {
    const html = renderToStaticMarkup(
      <TooltipProvider>
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
          onImportAssets={() => undefined}
        />
      </TooltipProvider>,
    )

    for (const label of ['选择', '平移', '撤销', '重做', '分组', '取消分组', '箭头批注', '画笔蒙版', '导入图片']) {
      expect(html).toContain(`aria-label="${label}"`)
    }
    expect(html).toContain('aria-pressed="true"')
    expect(html).toContain('role="group"')
  })

  test('Given 只读画布 When 渲染 Then 保留导航模式但禁用全部写命令', () => {
    const html = renderToStaticMarkup(
      <TooltipProvider>
        <DesignToolbar
          activeTool="pan"
          writable={false}
          canUndo
          canRedo
          onToolChange={() => undefined}
          onUndo={() => undefined}
          onRedo={() => undefined}
          onGroup={() => undefined}
          onUngroup={() => undefined}
          onImportAssets={() => undefined}
        />
      </TooltipProvider>,
    )

    expect(html).toMatch(/aria-label="选择"[^>]*aria-pressed="false"/)
    expect(html).toMatch(/aria-label="平移"[^>]*aria-pressed="true"/)
    for (const label of ['撤销', '重做', '分组', '取消分组', '箭头批注', '画笔蒙版', '导入图片']) {
      expect(html).toMatch(new RegExp(`aria-label="${label}"[^>]*disabled=""`))
    }
  })
})

describe('Design 工作区画布接入', () => {
  test('Given 可写空项目 When 渲染工作区 Then 同时保留工具栏、画布和两个空画布入口', () => {
    /** 空项目快照用于验证首屏工作流不会被 XYFlow 接入替换。 */
    const document = createEmptyDesignDocument('project-1', 100)
    const html = renderToStaticMarkup(
      <TooltipProvider>
        <DesignWorkspaceStateView
          state={{
            ...createInitialDesignProjectState(),
            phase: 'ready',
            snapshot: { document, writable: true, thumbnailBaseUrl: 'proma-file://thumbs' },
          }}
          onRetry={() => undefined}
          onRetrySave={() => undefined}
          onImportAssets={() => undefined}
          onCreateJob={() => undefined}
        />
      </TooltipProvider>,
    )

    expect(html).toContain('aria-label="画布模式"')
    expect(html).toContain('aria-label="设计画布"')
    expect(html).toContain('导入图片')
    expect(html).toContain('AI 生成')
  })
})
