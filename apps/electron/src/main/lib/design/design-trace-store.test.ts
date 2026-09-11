import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SDKAssistantMessage, SDKMessage } from '@proma/shared'
import type { DesignPathResolver, DesignPaths } from './design-paths'
import { DesignTraceStore } from './design-trace-store'

const IMAGE_TOOL = 'mcp__nano_banana__generate_image'

/** 构造测试项目的可信 Design 路径集合。 */
function createPaths(root: string): DesignPaths {
  const designRoot = join(root, 'project', '.proma', 'design')
  const cacheRoot = join(root, 'cache', 'project-1')
  /** 项目内多 Canvas 正式数据根。 */
  const canvasesRoot = join(designRoot, 'canvases')
  /** 项目内可移植创作资料根。 */
  const contextRoot = join(designRoot, 'context')
  return {
    projectId: 'project-1', projectRoot: join(root, 'project'), designRoot,
    canvasPath: join(designRoot, 'canvas.json'), canvasesRoot,
    canvasSessionsIndexPath: join(canvasesRoot, 'index.json'), assetsDir: join(designRoot, 'assets'),
    annotationsDir: join(designRoot, 'annotations'), cacheRoot,
    contextRoot, contextManifestPath: join(contextRoot, 'manifest.json'),
    contextDocumentsDir: join(contextRoot, 'documents'), contextReferencesDir: join(contextRoot, 'references'),
    preferencesPath: join(cacheRoot, 'preferences.json'), thumbnailsDir: join(cacheRoot, 'thumbnails'),
    jobsDir: join(cacheRoot, 'jobs'), tracesDir: join(cacheRoot, 'traces'), stagingDir: join(cacheRoot, 'staging'),
  }
}

/** 构造包含真实 Thinking、图片工具输入和结果的 SDK 消息序列。 */
function createSdkMessages(): SDKMessage[] {
  return [{
    type: 'assistant', parent_tool_use_id: null,
    message: { content: [
      { type: 'thinking', thinking: '先建立信息层级' },
      { type: 'tool_use', id: 'tool-1', name: IMAGE_TOOL, input: {
        prompt: 'A quiet desktop agent dashboard, exact layout...',
        designSummary: '突出产品主操作并保持安静层级',
        apiKey: 'secret-key',
        headers: { Authorization: 'Bearer secret-token' },
        image: 'data:image/png;base64,AAAA',
        outputPath: '/Users/example/generated.png',
      } },
    ] },
  }, {
    type: 'user', parent_tool_use_id: null,
    message: { content: [{
      type: 'tool_result', tool_use_id: 'tool-1', content: 'saved /Users/example/generated.png',
      imageAttachments: [{ localPath: '/Users/example/generated.png', filename: 'generated.png', mediaType: 'image/png' }],
    }] },
    tool_use_result: { base64: 'AAAA', headers: { Authorization: 'Bearer secret-token' } },
  }]
}

describe('DesignTraceStore', () => {
  /** 每个测试独立使用的缓存根。 */
  let tempDir: string
  /** 测试使用的可信路径。 */
  let paths: DesignPaths
  /** 被测 trace store。 */
  let store: DesignTraceStore

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'proma-design-trace-'))
    paths = createPaths(tempDir)
    mkdirSync(paths.tracesDir, { recursive: true })
    /** 只允许固定测试项目，模拟生产路径解析器。 */
    const pathResolver: Pick<DesignPathResolver, 'resolve'> = {
      resolve: (projectId) => {
        if (projectId !== paths.projectId) throw new Error('项目不存在')
        return paths
      },
    }
    store = new DesignTraceStore({ pathResolver, now: () => 100 })
  })

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true })
  })

  test('Given Pi 返回 Thinking 与图片工具参数 When 转存 trace Then 摘要只来自真实消息', () => {
    const result = store.writeFromMessages('project-1', 'job-1', createSdkMessages())

    expect(result.summary).toEqual({
      designSummary: '突出产品主操作并保持安静层级',
      finalImagePrompt: 'A quiet desktop agent dashboard, exact layout...',
      rawThinkingAvailable: true,
    })
    expect(store.read('project-1', 'job-1')).toContainEqual(expect.objectContaining({
      type: 'thinking', content: '先建立信息层级',
    }))
  })

  test('Given 旧项目尚未创建 traces 目录 When 转存 trace Then 自动补齐目录并完成写入', () => {
    rmSync(paths.tracesDir, { recursive: true, force: true })

    store.writeFromMessages('project-1', 'job-1', createSdkMessages())

    expect(existsSync(join(paths.tracesDir, 'job-1.jsonl'))).toBe(true)
  })

  test('Given Pi 只有错误 result When 转存 trace Then 保留失败原因而不是写空文件', () => {
    /** 复现没有图片工具调用的规划模型失败。 */
    const result = store.writeFromMessages('project-1', 'job-1', [{
      type: 'result', subtype: 'error_during_execution', errors: ['Request timed out.'],
    }])

    expect(result.entryCount).toBe(1)
    expect(store.read('project-1', 'job-1')).toEqual([{
      timestamp: 100, type: 'error', title: 'Agent 执行失败',
      content: '设计任务执行失败：模型请求超时。Request timed out.', isError: true,
    }])
  })

  test('Given 上游错误包含凭据路径和长正文 When 转存 trace Then 有界脱敏并保留 HTTP 原因', () => {
    store.writeFromMessages('project-1', 'job-1', [{
      type: 'result', subtype: 'error_during_execution', errors: [
        'HTTP 503: unavailable Authorization: Bearer secret-token apiKey="secret-key" '
        + '/Users/example/request.json https://user:password@example.test/api?key=secret '
        + 'x'.repeat(10_000),
      ],
    }])
    /** 直接检查落盘内容，不能依赖详情接口再次脱敏。 */
    const persisted = readFileSync(join(paths.tracesDir, 'job-1.jsonl'), 'utf8')

    expect(persisted).toContain('HTTP 503: unavailable')
    expect(persisted).not.toContain('secret')
    expect(persisted).not.toContain('/Users/example')
    expect(persisted).not.toContain('password')
    expect(persisted.length).toBeLessThan(1024)
  })

  test('Given Pi 只保存 TypedError 消息 When 转存 trace Then 使用结构化错误而非自然语言正文', () => {
    store.writeFromMessages('project-1', 'job-1', [{
      type: 'assistant', parent_tool_use_id: null,
      message: { content: [{ type: 'text', text: '未执行的图片生成计划' }] },
      error: { message: 'Request timed out.', errorType: 'network_error' },
    }])

    expect(store.read('project-1', 'job-1')).toEqual([{
      timestamp: 100, type: 'error', title: 'Agent 执行失败',
      content: '设计任务执行失败：模型请求超时。Request timed out.', isError: true,
    }])
  })

  test('Given 异常早于 SDK result When 保存任务终态 Then 留下可读失败证据供清理后查看', () => {
    store.writeFromMessages('project-1', 'job-1', [], {
      status: 'failed', error: '设计任务执行失败：模型请求超时。Request timed out.', completedAt: 123,
    })

    expect(store.read('project-1', 'job-1')).toEqual([{
      timestamp: 123, type: 'error', title: '设计任务失败',
      content: '设计任务执行失败：模型请求超时。Request timed out.', isError: true,
    }])
  })

  test('Given 工具详情含敏感和大字段 When 写入 trace Then 只保存白名单事实', () => {
    const result = store.writeFromMessages('project-1', 'job-1', createSdkMessages())

    const persisted = readFileSync(join(paths.tracesDir, 'job-1.jsonl'), 'utf8')
    expect(persisted).not.toContain('secret-key')
    expect(persisted).not.toContain('Authorization')
    expect(persisted).not.toContain('Bearer secret-token')
    expect(persisted).not.toContain('base64')
    expect(persisted).not.toContain('/Users/example')
    expect(result.summary.finalImagePrompt).toBe('A quiet desktop agent dashboard, exact layout...')
  })

  test('Given 模型没有 Thinking When 转存 trace Then 不伪造原始思考', () => {
    const messages = createSdkMessages().map((message) => {
      if (message.type !== 'assistant' || !('message' in message)) return message
      const assistant = message as SDKAssistantMessage
      return {
        ...assistant,
        message: {
          ...assistant.message,
          content: assistant.message.content.filter((block) => block.type !== 'thinking'),
        },
      }
    })

    const result = store.writeFromMessages('project-1', 'job-1', messages)

    expect(result.summary.rawThinkingAvailable).toBe(false)
    expect(store.read('project-1', 'job-1').some((entry) => entry.type === 'thinking')).toBe(false)
  })

  test('Given trace 任一行损坏 When 读取和探测 Then fail closed', () => {
    const tracePath = join(paths.tracesDir, 'job-1.jsonl')
    writeFileSync(tracePath, '{"type":"status"}\nnot-json\n', 'utf8')

    expect(store.isReadable('project-1', 'job-1')).toBe(false)
    expect(() => store.read('project-1', 'job-1')).toThrow('Design trace 文件损坏')
  })

  test('Given trace 超过单页上限 When 按游标读取 Then 每页最多 50 条并返回后续游标', () => {
    const tracePath = join(paths.tracesDir, 'job-1.jsonl')
    const lines = Array.from({ length: 75 }, (_, index) => JSON.stringify({
      timestamp: index,
      type: 'status',
      title: `状态 ${index}`,
    }))
    writeFileSync(tracePath, `${lines.join('\n')}\n`, 'utf8')

    const first = store.readPage('project-1', 'job-1', { limit: 80, maxBytes: 64 * 1024 })
    const second = store.readPage('project-1', 'job-1', {
      cursor: first.nextCursor,
      limit: 50,
      maxBytes: 64 * 1024,
    })

    expect(first.entries).toHaveLength(50)
    expect(first.entries[0]?.title).toBe('状态 0')
    expect(first.nextCursor).toBeString()
    expect(first.truncated).toBe(true)
    expect(second.entries).toHaveLength(25)
    expect(second.entries[0]?.title).toBe('状态 50')
    expect(second.nextCursor).toBeUndefined()
    expect(second.truncated).toBe(false)
  })

  test('Given 条目映射后尺寸扩大 When 按最终公开尺寸分页 Then cursor 不越过未返回日志', () => {
    const tracePath = join(paths.tracesDir, 'job-1.jsonl')
    const lines = Array.from({ length: 5 }, (_, index) => JSON.stringify({
      timestamp: index,
      type: 'status',
      title: `状态 ${index}`,
    }))
    writeFileSync(tracePath, `${lines.join('\n')}\n`, 'utf8')
    /** 模拟服务层白名单重建后增加固定公开正文，预算必须使用最终条目。 */
    const transformEntry = (entry: ReturnType<typeof store.read>[number]) => ({
      ...entry,
      content: 'x'.repeat(300),
    })

    const first = store.readPage('project-1', 'job-1', {
      limit: 5,
      maxBytes: 700,
      transformEntry,
    })
    const second = store.readPage('project-1', 'job-1', {
      cursor: first.nextCursor,
      limit: 5,
      maxBytes: 700,
      transformEntry,
    })

    expect(first.entries.map((entry) => entry.title)).toEqual(['状态 0'])
    expect(second.entries[0]?.title).toBe('状态 1')
  })

  test('Given 单条 trace 超过字节预算 When 有界读取 Then 跳过超大行且内存结果不携带正文', () => {
    const tracePath = join(paths.tracesDir, 'job-1.jsonl')
    writeFileSync(tracePath, [
      JSON.stringify({ timestamp: 1, type: 'thinking', title: '超大', content: 'x'.repeat(70_000) }),
      JSON.stringify({ timestamp: 2, type: 'status', title: '完成' }),
    ].join('\n') + '\n', 'utf8')

    const page = store.readPage('project-1', 'job-1', { limit: 50, maxBytes: 1024 })

    expect(page.entries).toEqual([expect.objectContaining({ title: '完成' })])
    expect(page.omittedEntryCount).toBe(1)
    expect(JSON.stringify(page).length).toBeLessThan(2_000)
  })

  test('Given trace 游标落在 JSON 行中间 When 读取 Then 拒绝伪造游标', () => {
    store.writeFromMessages('project-1', 'job-1', createSdkMessages())

    expect(() => store.readPage('project-1', 'job-1', {
      cursor: '3', limit: 10, maxBytes: 1024,
    })).toThrow('Design trace 文件损坏或不可读')
  })

  test('Given trace 已存在 When 删除两次 Then 幂等完成', () => {
    store.writeFromMessages('project-1', 'job-1', createSdkMessages())

    store.delete('project-1', 'job-1')
    store.delete('project-1', 'job-1')

    expect(existsSync(join(paths.tracesDir, 'job-1.jsonl'))).toBe(false)
  })
})
