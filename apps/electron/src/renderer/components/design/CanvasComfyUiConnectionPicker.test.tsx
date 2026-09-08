import { describe, expect, test } from 'bun:test'
import type { MediaConnectionSummary } from '@proma/shared'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  buildCanvasComfyUiConnectionOptions,
  CanvasComfyUiConnectionPicker,
  resolveInheritableCanvasComfyUiConnection,
} from './CanvasComfyUiConnectionPicker'

/** 创建服务器选择器使用的公开连接摘要。 */
function createConnection(id: string, enabled: boolean): MediaConnectionSummary {
  return {
    id, name: id === 'connection-enabled' ? '制作服务器' : '旧服务器',
    driver: 'comfyui', enabled, revision: 1, instanceGeneration: 'generation-1',
    credentialConfigured: true,
  }
}

describe('CanvasComfyUiConnectionPicker', () => {
  test('Given 全局连接含停用项 When 画布未绑定 Then 只列启用服务器且不自动选择第一项', () => {
    const options = buildCanvasComfyUiConnectionOptions([
      createConnection('connection-enabled', true),
      createConnection('connection-disabled', false),
    ], null)
    expect(options).toEqual([
      { id: 'connection-enabled', name: '制作服务器', available: true },
    ])
    expect(renderToStaticMarkup(
      <CanvasComfyUiConnectionPicker connections={options} connectionId={null} disabled={false} onChange={() => undefined} />,
    )).toContain('不绑定服务器')
  })

  test('Given 当前绑定已停用或被移除 When 构建并渲染 Then 保留选择并明确显示不可用', () => {
    const disabled = buildCanvasComfyUiConnectionOptions([
      createConnection('connection-enabled', true),
      createConnection('connection-disabled', false),
    ], 'connection-disabled')
    expect(disabled).toContainEqual({ id: 'connection-disabled', name: '旧服务器', available: false })

    const missing = buildCanvasComfyUiConnectionOptions([], 'connection-missing')
    const html = renderToStaticMarkup(
      <CanvasComfyUiConnectionPicker connections={missing} connectionId="connection-missing" disabled={false} onChange={() => undefined} />,
    )
    expect(html).toContain('connection-missing')
    expect(html).toContain('不可用')
    expect(resolveInheritableCanvasComfyUiConnection(missing, 'connection-missing')).toBeNull()
  })

  test('Given 当前绑定仍启用 When 新建工作流 Then 允许继承该连接', () => {
    const options = buildCanvasComfyUiConnectionOptions([
      createConnection('connection-enabled', true),
    ], 'connection-enabled')
    expect(resolveInheritableCanvasComfyUiConnection(options, 'connection-enabled'))
      .toBe('connection-enabled')
  })
})
