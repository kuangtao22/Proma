import { describe, expect, test } from 'bun:test'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { ServerOpsProjectForm } from './ServerOpsProjectDialog'

/** 用公开表单验证可访问字段和删除边界，不依赖 Portal 的服务端行为。 */
function renderForm(overrides: Partial<React.ComponentProps<typeof ServerOpsProjectForm>> = {}): string {
  return renderToStaticMarkup(<ServerOpsProjectForm
    dialog={{ kind: 'create' }} submitting={false} error={null}
    projectCount={2} connectionCount={0} onSubmit={() => undefined} onClose={() => undefined}
    {...overrides}
  />)
}

/** 删除目标只使用隔离示例身份。 */
const project = { id: 'project-demo', name: '测试环境', createdAt: 1, updatedAt: 1 }

describe('运维项目管理表单', () => {
  test('Given 创建或重命名 When 渲染 Then 名称可输入且编辑回显原名称', () => {
    expect(renderForm()).toContain('项目名称')
    expect(renderForm()).toContain('maxLength="60"')
    expect(renderForm({ dialog: { kind: 'rename', project } })).toContain('value="测试环境"')
  })
  test('Given 空项目 When 删除 Then 确认显示准确名称和明确删除按钮', () => {
    /** 空项目允许确认，不能误画出重命名字段。 */
    const html = renderForm({ dialog: { kind: 'delete', project } })
    expect(html).toContain('测试环境')
    expect(html).toContain('确认删除')
    expect(html).not.toContain('<input')
    expect(html).not.toContain('disabled=""')
  })
  test('Given 非空或最后一个项目 When 删除 Then 显示原因并阻止确认', () => {
    /** 前端显示防误操作原因，后端仍须权威校验。 */
    const nonempty = renderForm({ dialog: { kind: 'delete', project }, connectionCount: 3 })
    expect(nonempty).toContain('3 个连接')
    expect(nonempty).toContain('disabled=""')
    expect(renderForm({ dialog: { kind: 'delete', project }, projectCount: 1 })).toContain('至少保留一个项目')
  })
  test('Given 正在提交或保存失败 When 展示 Then 可感知忙态和可恢复错误', () => {
    expect(renderForm({ submitting: true })).toContain('aria-busy="true"')
    expect(renderForm({ error: '项目名称已存在，请换一个名称' })).toContain('role="alert"')
  })
})
