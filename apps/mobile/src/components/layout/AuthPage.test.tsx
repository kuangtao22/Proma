import { describe, expect, test } from 'bun:test'

/** 提供 AuthPage 模块初始化所需的最小浏览器存储。 */
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: { getItem: () => null },
})

/** 提供移动端默认服务器地址所需的最小页面位置。 */
Object.defineProperty(globalThis, 'window', {
  configurable: true,
  value: { location: { hostname: '127.0.0.1' } },
})

describe('移动端配对表单可访问性', () => {
  test('Given 配对表单 When 渲染 Then 每个可见标签关联唯一输入框', async () => {
    const { renderToStaticMarkup } = await import('react-dom/server')
    const { AuthPage } = await import('./AuthPage')
    /** 静态标记用于验证浏览器和读屏依赖的原生标签关联。 */
    const markup = renderToStaticMarkup(<AuthPage onSuccess={() => undefined} />)
    /** 每个可见字段应使用稳定且互不重复的输入框标识。 */
    const fields = [
      { label: '地址', id: 'auth-host' },
      { label: '端口', id: 'auth-port' },
      { label: 'PIN 码', id: 'auth-pin' },
    ]

    for (const field of fields) {
      expect(markup).toMatch(new RegExp(`<label[^>]*for="${field.id}"[^>]*>${field.label}</label>`))
      expect(markup).toMatch(new RegExp(`<input[^>]*id="${field.id}"[^>]*>`))
      expect(markup.match(new RegExp(`id="${field.id}"`, 'g'))).toHaveLength(1)
    }
  })

  test('Given 默认或扫码验证中 When 渲染连接按钮 Then 名称保持连接且仅等待时禁用', async () => {
    const { renderToStaticMarkup } = await import('react-dom/server')
    const { AuthPage } = await import('./AuthPage')
    /** 默认表单保留可提交的连接按钮。 */
    const readyMarkup = renderToStaticMarkup(<AuthPage onSuccess={() => undefined} />)
    /** 扫码验证期间按钮仍保留名称并通过 disabled 阻止重复提交。 */
    const pendingMarkup = renderToStaticMarkup(
      <AuthPage onSuccess={() => undefined} pairingPending />,
    )

    expect(readyMarkup).toMatch(/<button[^>]*type="submit"[^>]*>连接<\/button>/)
    expect(readyMarkup).not.toMatch(/<button[^>]*disabled=""[^>]*>连接<\/button>/)
    expect(pendingMarkup).toMatch(/<button[^>]*type="submit"[^>]*disabled=""[^>]*>连接<\/button>/)
  })
})
