import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SDKMessage } from '@proma/shared'
import type { DesignPathResolver, DesignPaths } from './design-paths'
import { DesignTraceStore } from './design-trace-store'

const IMAGE_TOOL = 'mcp__nano_banana__generate_image'

/** 构造测试项目的可信 Design 路径集合。 */
function createPaths(root: string): DesignPaths {
  const designRoot = join(root, 'project', '.proma', 'design')
  const cacheRoot = join(root, 'cache', 'project-1')
  return {
    projectId: 'project-1', projectRoot: join(root, 'project'), designRoot,
    canvasPath: join(designRoot, 'canvas.json'), assetsDir: join(designRoot, 'assets'),
    annotationsDir: join(designRoot, 'annotations'), cacheRoot,
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
      if (message.type !== 'assistant') return message
      return {
        ...message,
        message: { ...message.message, content: message.message.content.filter((block) => block.type !== 'thinking') },
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

  test('Given trace 已存在 When 删除两次 Then 幂等完成', () => {
    store.writeFromMessages('project-1', 'job-1', createSdkMessages())

    store.delete('project-1', 'job-1')
    store.delete('project-1', 'job-1')

    expect(existsSync(join(paths.tracesDir, 'job-1.jsonl'))).toBe(false)
  })
})
