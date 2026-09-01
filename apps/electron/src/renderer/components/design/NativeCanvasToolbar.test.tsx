import * as React from 'react'
import { describe, expect, mock, test } from 'bun:test'
import type { CanvasNodeKind } from '@proma/shared'
import { renderToStaticMarkup } from 'react-dom/server'
import { Tooltip } from '@/components/ui/tooltip'
import {
  NATIVE_CANVAS_NODE_TYPE_OPTIONS,
  NativeCanvasToolbar,
  createNativeCanvasNodeTypeSelectHandler,
} from './NativeCanvasToolbar'

/** 创建工具栏测试使用的稳定基础属性。 */
function createToolbarProps(): React.ComponentProps<typeof NativeCanvasToolbar> {
  return {
    activeTool: 'select',
    writable: true,
    canDelete: true,
    canReferenceSelection: false,
    issueCount: 0,
    onToolChange: () => undefined,
    onAddNode: () => undefined,
    onDelete: () => undefined,
    onReferenceSelection: () => undefined,
    arrangeSelectionCount: 2,
    arrangeVisibleCount: 4,
    arrangeAllCount: 6,
    onArrangeSelection: () => undefined,
    onArrangeVisible: () => undefined,
    onArrangeAll: () => undefined,
    onFocusFirstIssue: () => undefined,
  }
}

/** 在未挂载的 React 元素树中查找指定属性，覆盖 Radix Portal 的结构合同。 */
function hasElementProperty(
  node: React.ReactNode,
  propertyName: string,
  propertyValue: unknown,
): boolean {
  if (!React.isValidElement<Record<string, unknown>>(node)) return false
  if (node.props[propertyName] === propertyValue) return true
  return React.Children.toArray(node.props.children as React.ReactNode).some(
    (child) => hasElementProperty(child, propertyName, propertyValue),
  )
}

/** 查找目标属性所在元素到根节点的路径，用于验证浮层触发器没有互相嵌套。 */
function findElementPathByProperty(
  node: React.ReactNode,
  propertyName: string,
  propertyValue: unknown,
  path: React.ReactElement<Record<string, unknown>>[] = [],
): React.ReactElement<Record<string, unknown>>[] | undefined {
  if (!React.isValidElement<Record<string, unknown>>(node)) return undefined
  /** 当前元素加入路径后再判断，返回值包含目标元素自身。 */
  const currentPath = [...path, node]
  if (node.props[propertyName] === propertyValue) return currentPath
  for (const child of React.Children.toArray(node.props.children as React.ReactNode)) {
    /** 找到首条目标路径后立即返回，工具栏中的 aria-label 保持唯一。 */
    const childPath = findElementPathByProperty(child, propertyName, propertyValue, currentPath)
    if (childPath) return childPath
  }
  return undefined
}

describe('原生 Canvas 顶部工具栏', () => {
  test('Given 可写 Canvas When 渲染工具栏 Then 添加入口公开悬浮菜单语义并保留既有命令', () => {
    const html = renderToStaticMarkup(<NativeCanvasToolbar {...createToolbarProps()} />)

    expect(html).toContain('aria-label="选择工具"')
    expect(html).toContain('aria-pressed="true"')
    expect(html).toContain('aria-label="平移工具"')
    expect(html).toContain('aria-label="添加节点"')
    expect(html).toContain('aria-haspopup="dialog"')
    expect(html).toContain('aria-label="删除节点"')
  })

  test('Given 添加节点悬浮菜单 When 渲染触发器 Then 不与 Tooltip 浮层嵌套竞争', () => {
    const elementTree = NativeCanvasToolbar(createToolbarProps())
    /** 添加按钮的祖先链用于锁定 Popover 之外没有 Tooltip 浮层。 */
    const addButtonPath = findElementPathByProperty(elementTree, 'aria-label', '添加节点')

    expect(addButtonPath).toBeDefined()
    expect(addButtonPath?.some((element) => element.type === Tooltip)).toBeFalse()
  })

  test('Given 添加节点入口 When 渲染工具栏 Then 提供按钮下方的紧凑悬浮菜单', () => {
    const elementTree = NativeCanvasToolbar(createToolbarProps())

    expect(hasElementProperty(elementTree, 'data-canvas-node-picker', 'popover')).toBeTrue()
    expect(hasElementProperty(elementTree, 'data-canvas-node-picker-width', 'compact')).toBeTrue()
    expect(hasElementProperty(elementTree, 'side', 'bottom')).toBeTrue()
    expect(hasElementProperty(elementTree, 'align', 'center')).toBeTrue()
  })

  test('Given 多类型节点基础层 When 读取添加选项 Then 固定五项顺序且仅视频禁用', () => {
    expect(NATIVE_CANVAS_NODE_TYPE_OPTIONS).toEqual([
      { kind: 'agent', label: 'Agent', enabled: true },
      { kind: 'image', label: '生图', enabled: true },
      { kind: 'document', label: '文档', enabled: true },
      { kind: 'webview', label: '原型', enabled: true },
      { kind: 'video', label: '视频', enabled: false },
    ])
  })

  test('Given 四个可用类型 When 选择悬浮菜单选项 Then 分别回传精确节点类型', () => {
    const selected: CanvasNodeKind[] = []
    const onAddNode = (kind: CanvasNodeKind): void => { selected.push(kind) }

    for (const option of NATIVE_CANVAS_NODE_TYPE_OPTIONS) {
      const handler = createNativeCanvasNodeTypeSelectHandler(option, onAddNode)
      if (option.enabled) handler?.()
    }

    expect(selected).toEqual(['agent', 'image', 'document', 'webview'])
  })

  test('Given 视频尚未开放 When 尝试取得选择处理器 Then 不绑定回调', () => {
    const onAddNode = mock(() => undefined)
    const videoOption = NATIVE_CANVAS_NODE_TYPE_OPTIONS[4]

    const handler = createNativeCanvasNodeTypeSelectHandler(videoOption, onAddNode)
    handler?.()

    expect(videoOption).toEqual({ kind: 'video', label: '视频', enabled: false })
    expect(handler).toBeUndefined()
    expect(onAddNode).not.toHaveBeenCalled()
  })

  test('Given 两个问题节点 When 渲染工具栏 Then 显示可聚焦的问题入口', () => {
    const html = renderToStaticMarkup(
      <NativeCanvasToolbar {...createToolbarProps()} activeTool="pan" canDelete={false} issueCount={2} />,
    )

    expect(html).toContain('2 个节点需要处理')
    expect(html).toContain('aria-label="聚焦首个问题节点"')
  })

  test('Given 多选节点 When 渲染工具栏 Then 提供引用选中节点动作', () => {
    const html = renderToStaticMarkup(
      <NativeCanvasToolbar {...createToolbarProps()} canReferenceSelection />,
    )

    expect(html).toContain('aria-label="引用选中节点"')
    expect(html).toContain('引用选中节点')
  })

  test.each([
    { writable: false, canAdd: true },
    { writable: true, canAdd: false },
  ])('Given 添加不允许 When 渲染工具栏 Then 添加入口禁用且悬浮菜单不可打开', ({ writable, canAdd }) => {
    const html = renderToStaticMarkup(
      <NativeCanvasToolbar {...createToolbarProps()} writable={writable} canAdd={canAdd} />,
    )

    expect(html).toMatch(/<button[^>]*aria-label="添加节点"[^>]*disabled=""/u)
    const deleteDisabled = /<button[^>]*aria-label="删除节点"[^>]*disabled=""/u.test(html)
    expect(deleteDisabled).toBe(!writable)
  })

  test('Given 窄窗口 When 渲染工具栏 Then 工具栏和悬浮菜单宽度受限且状态文本可截断', () => {
    const html = renderToStaticMarkup(
      <NativeCanvasToolbar {...createToolbarProps()} issueCount={12} />,
    )
    const elementTree = NativeCanvasToolbar({ ...createToolbarProps(), issueCount: 12 })

    expect(html).toContain('max-w-[calc(100%-1rem)]')
    expect(html).toContain('max-w-36 truncate')
    expect(hasElementProperty(elementTree, 'data-canvas-node-picker-width', 'compact')).toBeTrue()
  })

  test('Given 画布有多个节点 When 渲染工具栏 Then 提供三个明确整理范围', () => {
    const html = renderToStaticMarkup(<NativeCanvasToolbar {...createToolbarProps()} />)
    const elementTree = NativeCanvasToolbar(createToolbarProps())

    expect(html).toContain('aria-label="整理布局"')
    expect(hasElementProperty(elementTree, 'aria-label', '整理选中节点')).toBeTrue()
    expect(hasElementProperty(elementTree, 'aria-label', '整理当前可见节点')).toBeTrue()
    expect(hasElementProperty(elementTree, 'aria-label', '整理整个画布')).toBeTrue()
  })

  test('Given 选区不足两个节点 When 渲染整理菜单 Then 选区整理保持禁用', () => {
    const elementTree = NativeCanvasToolbar(
      { ...createToolbarProps(), arrangeSelectionCount: 1 },
    )
    const path = findElementPathByProperty(elementTree, 'aria-label', '整理选中节点')

    expect(path?.at(-1)?.props.disabled).toBeTrue()
  })
})
