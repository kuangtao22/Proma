import { describe, expect, test } from 'bun:test'
import { Provider, createStore } from 'jotai'
import { renderToStaticMarkup } from 'react-dom/server'

/** 提供移动端 atoms 初始化所需的最小浏览器存储。 */
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: { getItem: () => null },
})

/** 提供移动端默认连接地址所需的最小页面环境。 */
Object.defineProperty(globalThis, 'window', {
  configurable: true,
  value: { location: { hostname: '127.0.0.1' } },
})

describe('移动端输入区', () => {
  test('Given 输入区禁用 When 渲染 Then 输入和发送控制具有稳定名称与禁用状态', async () => {
    const { activeConvAtom, channelsAtom, streamingAtom } = await import('../../atoms')
    const { InputBar } = await import('./InputBar')
    /** 独立 store 提供输入区渲染所需的最小会话状态。 */
    const store = createStore()
    store.set(activeConvAtom, { id: 'conv-1', title: '测试', type: 'agent', updatedAt: 1 })
    store.set(streamingAtom, false)
    store.set(channelsAtom, [])
    /** 静态标记用于验证无需浏览器交互的控制状态。 */
    const markup = renderToStaticMarkup(
      <Provider store={store}><InputBar disabled /></Provider>,
    )

    expect(markup).toContain('aria-label="消息输入"')
    expect(markup).toContain('aria-label="选择模型"')
    expect(markup).toContain('aria-label="发送消息"')
    expect(markup).toMatch(/<textarea[^>]*disabled=""/)
    expect(markup).toMatch(/<button[^>]*aria-label="发送消息"[^>]*disabled=""/)
  })

  test('Given 没有可用模型 When 渲染模型选择器 Then 展示搜索与真实空态', async () => {
    const { ModelPicker } = await import('./InputBar')
    /** 空渠道直接验证模型选择器的搜索入口和空状态。 */
    const markup = renderToStaticMarkup(
      <ModelPicker channelId={null} modelId={null} channels={[]} onSelect={() => undefined} />,
    )

    expect(markup).toContain('aria-label="搜索模型"')
    expect(markup).toContain('未找到模型')
  })

  test('Given Agent 正在运行且本地流未恢复 When 渲染 Then 仍展示停止按钮', async () => {
    const { activeConvAtom, channelsAtom, streamingAtom } = await import('../../atoms')
    const { InputBar } = await import('./InputBar')
    /** 重连后本地 streaming 可能为 false，权威 Agent 状态仍应驱动停止按钮。 */
    const store = createStore()
    store.set(activeConvAtom, {
      id: 'agent-running',
      title: '运行中',
      type: 'agent',
      updatedAt: 1,
      runtimeStatus: 'running',
    })
    store.set(streamingAtom, false)
    store.set(channelsAtom, [])

    const markup = renderToStaticMarkup(
      <Provider store={store}><InputBar /></Provider>,
    )

    expect(markup).toContain('aria-label="停止生成"')
    expect(markup).not.toContain('aria-label="发送消息"')
  })

  test('Given Chat 正在生成 When 渲染 Then 继续使用本地流状态展示停止按钮', async () => {
    const { activeConvAtom, channelsAtom, streamingAtom } = await import('../../atoms')
    const { InputBar } = await import('./InputBar')
    /** Chat 不具备 Agent 运行态，保持原 streamingAtom 行为。 */
    const store = createStore()
    store.set(activeConvAtom, { id: 'chat-running', title: 'Chat', type: 'chat', updatedAt: 1 })
    store.set(streamingAtom, true)
    store.set(channelsAtom, [])

    const markup = renderToStaticMarkup(
      <Provider store={store}><InputBar /></Provider>,
    )

    expect(markup).toContain('aria-label="停止生成"')
  })

  test('Given 模型弹层打开 When 渲染 Then 提供模态语义和明确关闭动作', async () => {
    const { ModelPickerDialog } = await import('./InputBar')
    /** 空渠道足以验证原生模态容器和关闭入口。 */
    const markup = renderToStaticMarkup(
      <ModelPickerDialog
        channelId={null}
        modelId={null}
        channels={[]}
        onSelect={() => undefined}
        onClose={() => undefined}
      />,
    )

    expect(markup).toContain('role="dialog"')
    expect(markup).toContain('aria-modal="true"')
    expect(markup).toContain('aria-label="模型选择"')
    expect(markup).toContain('aria-label="关闭模型选择"')
    expect(markup).toContain('max-height:calc(min(70dvh, 560px) - 44px - var(--safe-b))')
  })
})
