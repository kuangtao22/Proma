import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { TooltipProvider } from '@/components/ui/tooltip'
import { TurnFileChangesSummary } from './TurnFileChangesSummary'

/** 渲染汇总块并返回静态 HTML，用于断言可见文案。 */
function renderSummary(props: Parameters<typeof TurnFileChangesSummary>[0]): string {
  // 文件 chip 复用应用内的 Tooltip，静态渲染同样需要 Provider 包裹。
  return renderToStaticMarkup(
    <TooltipProvider>
      <TurnFileChangesSummary {...props} />
    </TooltipProvider>,
  )
}

describe('本轮文件改动汇总渲染', () => {
  test('Given 已完整跟踪且无改动 When 渲染 Then 只断言受管范围内没有改动', () => {
    const html = renderSummary({ turnMessages: [], runObserved: true })

    // 证据源只覆盖受管根/附加目录/项目根与写类工具入参，不能断言「本轮没有任何改动」。
    expect(html).toContain('本轮未检测到受管范围内的文件改动')
  })

  test('Given 本轮用过命令行且无改动 When 渲染 Then 追加范围说明', () => {
    const html = renderSummary({
      turnMessages: [{
        type: 'assistant',
        parent_tool_use_id: null,
        message: {
          content: [{
            type: 'tool_use',
            id: 'call-shell',
            name: 'Bash',
            input: { command: "python3 - <<'PY'\nopen('/tmp/a','w').write('x')\nPY" },
          }],
        },
      } as unknown as Parameters<typeof TurnFileChangesSummary>[0]['turnMessages'][number]],
      runObserved: true,
    })

    expect(html).toContain('本轮未检测到受管范围内的文件改动')
    expect(html).toContain('本轮有命令行工具调用，工作区外的写入不计入这里')
  })

  test('Given 本轮只用写类工具且无改动 When 渲染 Then 不追加范围说明', () => {
    const html = renderSummary({
      turnMessages: [{
        type: 'assistant',
        parent_tool_use_id: null,
        message: {
          content: [{ type: 'tool_use', id: 'call-edit', name: 'Edit', input: { file_path: '/p/a.ts' } }],
        },
      } as unknown as Parameters<typeof TurnFileChangesSummary>[0]['turnMessages'][number]],
      runObserved: true,
    })

    expect(html).toContain('本轮未检测到受管范围内的文件改动')
    expect(html).not.toContain('本轮有命令行工具调用')
  })

  test('Given 共享目录有改动但无法归属 When 渲染 Then 不再断言未检测到改动', () => {
    const html = renderSummary({
      turnMessages: [{
        type: 'assistant',
        parent_tool_use_id: null,
        message: { content: [{ type: 'tool_use', id: 'call-bash', name: 'Bash', input: { command: 'ls /repo' } }] },
      } as unknown as Parameters<typeof TurnFileChangesSummary>[0]['turnMessages'][number]],
      runObserved: true,
      runUnattributed: true,
    })

    expect(html).toContain('本轮检测到共享目录有改动，但无法归属到本会话')
    expect(html).not.toContain('本轮未检测到受管范围内的文件改动')
    // 已有更准确的解释，不再叠加命令行范围说明。
    expect(html).not.toContain('本轮有命令行工具调用')
  })

  test('Given 未完整跟踪且无改动 When 渲染 Then 保持静默不写结论', () => {
    const html = renderSummary({ turnMessages: [], runObserved: false })

    expect(html).toBe('')
  })

  test('Given 仅有监听器归属路径 When 渲染 Then 进入汇总并显示数量', () => {
    const html = renderSummary({
      turnMessages: [],
      runPaths: ['/project/generated/report.md'],
      runObserved: true,
    })

    expect(html).toContain('本轮文件改动 1')
    expect(html).toContain('report.md')
  })

  test('Given 业务代码与构建产物混在一起 When 渲染 Then 按分类分行展示', () => {
    const html = renderSummary({
      turnMessages: [],
      runPaths: [
        '/project/src/BSJSEngine.swift',
        '/project/dist/app.min.js',
        '/project/README.md',
      ],
      runObserved: true,
    })

    expect(html).toContain('本轮文件改动 3')
    expect(html).toContain('代码 1')
    expect(html).toContain('配置与文档 1')
    expect(html).toContain('资源与生成物 1')
  })

  test('Given 工具路径与监听器路径指向同一文件 When 渲染 Then 只计一次', () => {
    const toolMessage = {
      type: 'assistant',
      parent_tool_use_id: null,
      message: {
        content: [{
          type: 'tool_use',
          id: 'call-1',
          name: 'Write',
          input: { file_path: '/project/report.md' },
        }],
      },
    } as unknown as Parameters<typeof TurnFileChangesSummary>[0]['turnMessages'][number]
    const toolResult = {
      type: 'user',
      parent_tool_use_id: null,
      message: {
        content: [{ type: 'tool_result', tool_use_id: 'call-1', is_error: false, content: 'ok' }],
      },
    } as unknown as Parameters<typeof TurnFileChangesSummary>[0]['turnMessages'][number]

    const html = renderSummary({
      turnMessages: [toolMessage, toolResult],
      runPaths: ['/project/report.md'],
      runObserved: true,
    })

    expect(html).toContain('本轮文件改动 1')
  })
})
