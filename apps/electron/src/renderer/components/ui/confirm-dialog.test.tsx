import { describe, expect, test } from 'bun:test'
import * as React from 'react'
import { AlertDialogAction } from '@/components/ui/alert-dialog'
import { ConfirmDialog } from './confirm-dialog'

/** 从 ConfirmDialog 真实组件输出中递归查找确认 Action。 */
function findConfirmAction(node: React.ReactNode): React.ReactElement<{ onClick: (event: React.MouseEvent<HTMLButtonElement>) => void }> | null {
  let found: React.ReactElement<{ onClick: (event: React.MouseEvent<HTMLButtonElement>) => void }> | null = null
  React.Children.forEach(node, (child) => {
    if (found || !React.isValidElement<{ children?: React.ReactNode }>(child)) return
    if (child.type === AlertDialogAction) {
      found = child as React.ReactElement<{ onClick: (event: React.MouseEvent<HTMLButtonElement>) => void }>
      return
    }
    found = findConfirmAction(child.props.children)
  })
  return found
}

describe('ConfirmDialog', () => {
  test('Given 受控关闭模式 When 点击确认 Then 先阻止 Radix 自动关闭再调用确认', () => {
    /** 顺序记录确保异步确认开始前弹窗已切换为受控关闭。 */
    const calls: string[] = []
    const view = ConfirmDialog({
      open: true,
      onOpenChange: () => undefined,
      title: '删除生图模型？',
      closeOnConfirm: false,
      onConfirm: () => { calls.push('confirm') },
    })
    const action = findConfirmAction(view)
    expect(action).not.toBeNull()
    action?.props.onClick({ preventDefault: () => { calls.push('prevent') } } as React.MouseEvent<HTMLButtonElement>)
    expect(calls).toEqual(['prevent', 'confirm'])
  })

  test('Given 默认模式 When 点击确认 Then 保持现有自动关闭行为', () => {
    let prevented = false
    let confirmed = false
    const view = ConfirmDialog({
      open: true,
      onOpenChange: () => undefined,
      title: '确认操作？',
      onConfirm: () => { confirmed = true },
    })
    const action = findConfirmAction(view)
    expect(action).not.toBeNull()
    action?.props.onClick({ preventDefault: () => { prevented = true } } as React.MouseEvent<HTMLButtonElement>)
    expect(prevented).toBeFalse()
    expect(confirmed).toBeTrue()
  })
})
