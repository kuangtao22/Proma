import { describe, expect, test } from 'bun:test'
import type { ToolDefinition } from '@earendil-works/pi-coding-agent'
import type { AgentToolResult } from '@earendil-works/pi-agent-core'
import type { DesignContextEntry } from '@proma/shared'
import type { DesignContextCatalogContract } from './design-context-catalog'
import {
  DESIGN_CONTEXT_TOOL_NAMES,
  DesignContextOrchestrator,
} from './design-context-orchestrator'
import type {
  DesignProjectTextEntry,
  DesignProjectTextIndexContract,
} from './design-project-text-index'

/** 测试可直接执行的 Pi 工具窄类型。 */
interface ExecutableTool {
  name: string
  execute: (
    toolCallId: string,
    params: Record<string, unknown>,
    signal: AbortSignal | undefined,
    onUpdate: undefined,
    context: never,
  ) => Promise<AgentToolResult<unknown>>
}

/** 使用真实工具 execute 合同执行指定 Design 上下文工具。 */
async function executeTool(
  tools: ToolDefinition[],
  name: string,
  input: Record<string, unknown>,
): Promise<AgentToolResult<unknown>> {
  /** 按完整工具名定位被测定义。 */
  const tool = tools.find((candidate) => candidate.name === name) as unknown as ExecutableTool | undefined
  if (!tool) throw new Error(`测试工具不存在: ${name}`)
  return tool.execute('tool-call-1', input, undefined, undefined, {} as never)
}

/** 构造可独立控制项目文件与上下文条目的策略测试夹具。 */
function createFixture(options: {
  projectFiles?: Record<string, string>
  contextEntries?: DesignContextEntry[]
} = {}) {
  /** 当前项目文件内容，只用于模拟已由安全索引授权的读取。 */
  const projectFiles = new Map(Object.entries(options.projectFiles ?? {}))
  /** 当前项目长期上下文条目。 */
  const contextEntries = options.contextEntries ?? []
  /** 从内容长度生成完整索引元数据。 */
  const listEntries = (): DesignProjectTextEntry[] => [...projectFiles.entries()].map(([relativePath, content]) => ({
    relativePath,
    byteSize: Buffer.byteLength(content),
    modifiedAt: 100,
    identity: `identity:${relativePath}`,
  }))
  /** 保留 list/search/read 行为的内存文本索引。 */
  const textIndex: DesignProjectTextIndexContract = {
    list: () => listEntries(),
    search: (_projectId, query, limit = 20) => listEntries()
      .filter((entry) => entry.relativePath.includes(query) || projectFiles.get(entry.relativePath)?.includes(query))
      .slice(0, limit),
    read: (_projectId, relativePath, maxBytes) => {
      const content = projectFiles.get(relativePath)
      if (content === undefined) throw new Error(`项目文件不存在: ${relativePath}`)
      return Buffer.from(content).subarray(0, maxBytes).toString('utf8')
    },
    invalidate: () => undefined,
  }
  /** 保留目录查询与文档读取行为的内存上下文库。 */
  const catalog: DesignContextCatalogContract = {
    list: () => contextEntries.map((entry) => ({ ...entry, tags: [...entry.tags] })),
    readDocument: (_projectId, entryId) => {
      const entry = contextEntries.find((candidate) => candidate.id === entryId)
      if (!entry || entry.kind !== 'document') throw new Error(`创作上下文不存在: ${entryId}`)
      return `# ${entry.title}`
    },
    upsertDocument: () => { throw new Error('测试未使用写入') },
    importDocument: () => { throw new Error('测试未使用导入') },
    updateMetadata: () => { throw new Error('测试未使用更新') },
    registerAsset: () => { throw new Error('测试未使用素材登记') },
    delete: () => undefined,
    isAssetReferenced: () => false,
  }
  /** 使用固定时间和 ID 的被测编排器。 */
  const orchestrator = new DesignContextOrchestrator({
    textIndex,
    catalog,
    now: () => 100,
    createReferenceId: (key) => `reference:${key}`,
  })
  return { orchestrator }
}

describe('DesignContextOrchestrator', () => {
  test('Given none 模式 When 创建运行 Then 不提供项目工具且不产生审计引用', () => {
    const { orchestrator } = createFixture({ projectFiles: { 'src/App.tsx': 'content' } })

    const run = orchestrator.createRun({ projectId: 'project-1', mode: 'none', originalRequest: '生成海报' })

    expect(run.tools).toEqual([])
    expect(run.allowedToolNames).toEqual([])
    expect(run.getReferences()).toEqual([])
    expect(() => run.assertReadyForImageCall()).not.toThrow()
  })

  test('Given project 模式且没有可用资料 When 预检 Then 在图片调用前失败', () => {
    const { orchestrator } = createFixture()

    expect(() => orchestrator.createRun({
      projectId: 'project-1',
      mode: 'project',
      originalRequest: '使用项目生成首页',
    })).toThrow('当前项目没有可用的创作上下文')
  })

  test('Given project 模式存在候选但尚未读取 When 图片调用前检查 Then 明确阻断', () => {
    const { orchestrator } = createFixture({ projectFiles: { 'src/App.tsx': 'homepage' } })
    const run = orchestrator.createRun({ projectId: 'project-1', mode: 'project', originalRequest: '生成首页' })

    expect(() => run.assertReadyForImageCall()).toThrow('使用项目模式必须先读取至少一项创作上下文')
  })

  test('Given auto 模式明确依赖当前项目 When 所有读取均未成功 Then 图片调用前阻断', () => {
    const { orchestrator } = createFixture({ projectFiles: { 'src/App.tsx': 'homepage' } })
    const dependentRun = orchestrator.createRun({
      projectId: 'project-1',
      mode: 'auto',
      originalRequest: '生成当前项目的首页效果图',
    })
    const standaloneRun = orchestrator.createRun({
      projectId: 'project-1',
      mode: 'auto',
      originalRequest: '生成一张极简音乐节海报',
    })

    expect(() => dependentRun.assertReadyForImageCall()).toThrow('当前要求依赖项目上下文，但 Agent 尚未成功读取资料')
    expect(() => standaloneRun.assertReadyForImageCall()).not.toThrow()
  })

  test('Given auto 模式 When Agent 读取项目文件 Then 记录唯一审计引用并允许图片调用', async () => {
    const { orchestrator } = createFixture({ projectFiles: { 'src/App.tsx': 'export const App = "首页"' } })
    const run = orchestrator.createRun({
      projectId: 'project-1',
      mode: 'auto',
      originalRequest: '生成当前项目首页',
    })

    const first = await executeTool(run.tools, 'design_read_project_file', {
      relativePath: 'src/App.tsx',
      purpose: '确认首页结构',
    })
    await executeTool(run.tools, 'design_read_project_file', {
      relativePath: 'src/App.tsx',
      purpose: '重复确认',
    })

    expect(first.details).toMatchObject({ relativePath: 'src/App.tsx', truncated: false })
    expect(run.getReferences()).toEqual([expect.objectContaining({
      sourceKind: 'project-file',
      relativePath: 'src/App.tsx',
      purpose: '确认首页结构',
    })])
    expect(() => run.assertReadyForImageCall()).not.toThrow()
  })

  test('Given 读取超过累计预算 When 再读文件 Then 返回截断结果并保留已读引用', async () => {
    const { orchestrator } = createFixture({
      projectFiles: Object.fromEntries(Array.from({ length: 9 }, (_, index) => [
        `docs/${index}.md`,
        String(index).repeat(64 * 1024),
      ])),
    })
    const run = orchestrator.createRun({ projectId: 'project-1', mode: 'auto', originalRequest: '整理视觉资料' })
    for (let index = 0; index < 8; index += 1) {
      await executeTool(run.tools, 'design_read_project_file', { relativePath: `docs/${index}.md` })
    }

    const result = await executeTool(run.tools, 'design_read_project_file', { relativePath: 'docs/8.md' })

    expect(result.details).toMatchObject({ truncated: true, reason: 'total-bytes', returnedBytes: 0 })
    expect(run.getReferences()).toHaveLength(8)
    expect(run.getWarnings()).toContain('项目文本累计读取已达到 512 KiB 上限')
  })

  test('Given 上下文含文档和视觉标准 When 读取 Then 分别记录文档与素材审计来源', async () => {
    /** 可读 Markdown 条目。 */
    const documentEntry: DesignContextEntry = {
      id: 'context-story', projectId: 'project-1', category: 'story', kind: 'document',
      title: '故事设定', relativePath: 'documents/context-story.md', tags: [], source: 'user', updatedAt: 1,
    }
    /** 只引用现有素材的视觉标准条目。 */
    const assetEntry: DesignContextEntry = {
      id: 'context-visual', projectId: 'project-1', category: 'reference', kind: 'asset',
      title: '首页视觉', assetId: 'asset-1', tags: [], source: 'design-asset', updatedAt: 1,
    }
    const { orchestrator } = createFixture({ contextEntries: [documentEntry, assetEntry] })
    const run = orchestrator.createRun({ projectId: 'project-1', mode: 'auto', originalRequest: '沿用视觉标准' })

    await executeTool(run.tools, 'design_read_context_entry', { entryId: documentEntry.id })
    await executeTool(run.tools, 'design_read_context_entry', { entryId: assetEntry.id })

    expect(run.getReferences()).toEqual([
      expect.objectContaining({ sourceKind: 'context-document', id: `reference:context:${documentEntry.id}` }),
      expect.objectContaining({ sourceKind: 'design-asset', assetId: 'asset-1' }),
    ])
  })

  test('Given auto 或 project 模式 When 查看工具白名单 Then 只有四个 Design 只读工具', () => {
    const { orchestrator } = createFixture({ projectFiles: { 'README.md': 'project' } })
    const run = orchestrator.createRun({ projectId: 'project-1', mode: 'auto', originalRequest: '设计' })

    expect(run.allowedToolNames).toEqual(DESIGN_CONTEXT_TOOL_NAMES)
    expect(run.tools.map((tool) => tool.name)).toEqual([...DESIGN_CONTEXT_TOOL_NAMES])
    expect(run.allowedToolNames).not.toContain('Read')
    expect(run.allowedToolNames).not.toContain('Bash')
    expect(run.allowedToolNames).not.toContain('Write')
  })
})
