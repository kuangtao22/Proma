import { describe, expect, test } from 'bun:test'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { ServerOpsProject } from '@proma/shared'
import { ServerOpsConnectionMoveForm } from './ServerOpsConnectionMoveDialog'
import type { ServerOpsConnection } from './server-ops-connections'

/** 当前连接样本。 */
const connection: ServerOpsConnection = {
  id: 'data:source-1',
  kind: 'database',
  projectId: 'project-1',
  label: '业务主库',
  detail: '127.0.0.1:3306 · 本机直连',
  sourceId: 'source-1',
}

/** 项目样本，包含当前项目和两个可移动目标。 */
const projects: readonly ServerOpsProject[] = [
  { id: 'project-1', name: '生产环境', createdAt: 1, updatedAt: 1 },
  { id: 'project-2', name: '预发环境', createdAt: 2, updatedAt: 2 },
  { id: 'project-3', name: '测试环境', createdAt: 3, updatedAt: 3 },
]

/** 渲染可服务端测试的移动表单。 */
function renderForm(overrides: Partial<React.ComponentProps<typeof ServerOpsConnectionMoveForm>> = {}): string {
  return renderToStaticMarkup(
    <ServerOpsConnectionMoveForm
      connection={connection}
      projects={projects}
      targetProjectId="project-2"
      submitting={false}
      error={null}
      onTargetChange={() => undefined}
      onSubmit={() => undefined}
      onClose={() => undefined}
      {...overrides}
    />,
  )
}

/** 在元素树里递归查找原生表单元素。 */
function findElement(
  node: React.ReactNode,
  type: 'form' | 'button',
  predicate: (element: React.ReactElement<Record<string, unknown>>) => boolean,
): React.ReactElement<Record<string, unknown>> | null {
  /** 当前递归分支命中的元素。 */
  let found: React.ReactElement<Record<string, unknown>> | null = null
  React.Children.forEach(node, (child) => {
    if (found || !React.isValidElement<Record<string, unknown> & { children?: React.ReactNode }>(child)) return
    if (child.type === type && predicate(child)) {
      found = child
      return
    }
    found = findElement(child.props.children, type, predicate)
  })
  return found
}

describe('运维连接移动表单', () => {
  test('Given 当前连接和多个项目 When 渲染 Then 显示连接与当前项目且目标排除当前项目', () => {
    const html = renderForm()
    expect(html).toContain('业务主库')
    expect(html).toContain('生产环境')
    expect(html).toContain('移动仅更改归属')
    expect(html).toContain('原连接和跳板关系保持不变')

    /** Radix Portal 不进入 SSR 字符串，直接检查表单元素树里的候选项目。 */
    const tree = ServerOpsConnectionMoveForm({
      connection,
      projects,
      targetProjectId: 'project-2',
      submitting: false,
      error: null,
      onTargetChange: () => undefined,
      onSubmit: () => undefined,
      onClose: () => undefined,
    })
    expect(findDataValues(tree, 'data-server-ops-move-target')).toEqual(['project-2', 'project-3'])
  })

  test('Given 只有当前项目 When 渲染 Then 说明先添加项目并禁用确认', () => {
    const html = renderForm({ projects: projects.slice(0, 1), targetProjectId: '' })
    expect(html).toContain('请先添加其他项目')
    expect(html).toMatch(/<button[^>]*type="submit"[^>]*disabled=""/)
  })

  test('Given 未选择、过期目标或同项目 When 渲染 Then 禁用确认', () => {
    for (const targetProjectId of ['', 'missing-project', connection.projectId]) {
      const html = renderForm({ targetProjectId })
      expect(html).toMatch(/<button[^>]*type="submit"[^>]*disabled=""/)
    }
  })

  test('Given 已选目标被删除 When 重新渲染 Then Select 保持受控空值而不残留旧显示', () => {
    /** 过期目标对应的表单元素树。 */
    const tree = ServerOpsConnectionMoveForm({
      connection,
      projects,
      targetProjectId: 'missing-project',
      submitting: false,
      error: null,
      onTargetChange: () => undefined,
      onSubmit: () => undefined,
      onClose: () => undefined,
    })
    /** Radix Select 根节点以 onValueChange 标识，受控值必须显式回落为空字符串。 */
    const select = findElementWithProp(tree, 'onValueChange')
    expect(select?.props.value).toBe('')
  })

  test('Given 多 Pane 各自渲染表单 When 传入不同目标字段 ID Then Label 与 Trigger 不会冲突', () => {
    const firstHtml = renderForm({ targetId: 'move-target-pane-a' })
    const secondHtml = renderForm({ targetId: 'move-target-pane-b' })
    expect(firstHtml).toContain('for="move-target-pane-a"')
    expect(firstHtml).toContain('id="move-target-pane-a"')
    expect(secondHtml).toContain('for="move-target-pane-b"')
    expect(secondHtml).toContain('id="move-target-pane-b"')
    expect(firstHtml).not.toContain('move-target-pane-b')
    expect(secondHtml).not.toContain('move-target-pane-a')
  })

  test('Given 正在提交或提交失败 When 渲染 Then 锁定表单并内联展示错误', () => {
    const submittingHtml = renderForm({ submitting: true })
    expect(submittingHtml).toContain('aria-busy="true"')
    expect(submittingHtml).toContain('正在移动')
    expect(submittingHtml).toMatch(/<button[^>]*type="button"[^>]*disabled=""/)

    const errorHtml = renderForm({ error: '目标项目已经不存在' })
    expect(errorHtml).toContain('role="alert"')
    expect(errorHtml).toContain('目标项目已经不存在')
  })

  test('Given 有效目标 When 提交表单 Then 调用确认回调', () => {
    /** 确认调用次数。 */
    let submitCount = 0
    const tree = ServerOpsConnectionMoveForm({
      connection,
      projects,
      targetProjectId: 'project-2',
      submitting: false,
      error: null,
      onTargetChange: () => undefined,
      onSubmit: () => { submitCount += 1 },
      onClose: () => undefined,
    })
    const form = findElement(tree, 'form', () => true)
    expect(form).not.toBeNull()
    /** React 表单回调只依赖 preventDefault，可用最小事件对象验证受控提交。 */
    const onSubmit = form?.props.onSubmit as ((event: { preventDefault: () => void }) => void) | undefined
    onSubmit?.({ preventDefault: () => undefined })
    expect(submitCount).toBe(1)
  })
})

/**
 * 收集元素树里指定 data 属性的字符串值。
 *
 * @param node 元素树
 * @param attribute data 属性名
 * @returns 按渲染顺序排列的属性值
 */
function findDataValues(node: React.ReactNode, attribute: string): string[] {
  /** 当前分支收集到的属性值。 */
  const values: string[] = []
  React.Children.forEach(node, (child) => {
    if (!React.isValidElement<Record<string, unknown> & { children?: React.ReactNode }>(child)) return
    if (typeof child.props[attribute] === 'string') values.push(child.props[attribute])
    values.push(...findDataValues(child.props.children, attribute))
  })
  return values
}

/**
 * 查找包含指定属性的第一个 React 元素。
 *
 * @param node 元素树
 * @param property 属性名
 * @returns 首个匹配元素；未找到时为 null
 */
function findElementWithProp(node: React.ReactNode, property: string): React.ReactElement<Record<string, unknown>> | null {
  /** 当前递归分支命中的元素。 */
  let found: React.ReactElement<Record<string, unknown>> | null = null
  React.Children.forEach(node, (child) => {
    if (found || !React.isValidElement<Record<string, unknown> & { children?: React.ReactNode }>(child)) return
    if (property in child.props) {
      found = child
      return
    }
    found = findElementWithProp(child.props.children, property)
  })
  return found
}
