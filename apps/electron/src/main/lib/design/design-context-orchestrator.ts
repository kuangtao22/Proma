import { randomUUID } from 'node:crypto'
import type { ToolDefinition } from '@earendil-works/pi-coding-agent'
import type { AgentToolResult } from '@earendil-works/pi-agent-core'
import type {
  DesignContextMode,
  DesignContextReference,
} from '@proma/shared'
import { Type } from 'typebox'
import type { TSchema } from 'typebox'
import type { DesignContextCatalogContract } from './design-context-catalog'
import type { DesignProjectTextIndexContract } from './design-project-text-index'

/** 单次 Design 运行最多读取的不同文本资料数量。 */
const MAX_TEXT_FILES = 24
/** 单份项目或上下文文本最多返回的 UTF-8 字节数。 */
const MAX_FILE_BYTES = 64 * 1024
/** 单次 Design 运行累计最多返回的文本字节数。 */
const MAX_TOTAL_TEXT_BYTES = 512 * 1024
/** 累计读取预算耗尽时展示的稳定警告。 */
const TOTAL_BYTES_WARNING = '项目文本累计读取已达到 512 KiB 上限'
/** 不同文本资料数量耗尽时展示的稳定警告。 */
const FILE_COUNT_WARNING = '项目文本读取已达到 24 个不同文件上限'

/** Design 内部 Agent 唯一允许获得的四个项目上下文工具。 */
export const DESIGN_CONTEXT_TOOL_NAMES = [
  'design_list_project_files',
  'design_search_project_text',
  'design_read_project_file',
  'design_read_context_entry',
] as const

/** 单次运行的上下文策略输入。 */
export interface CreateDesignContextRunInput {
  projectId: string
  mode: DesignContextMode
  originalRequest?: string
}

/** 单次 Design 运行向 Job Manager 暴露的工具与审计状态。 */
export interface DesignContextRun {
  tools: ToolDefinition[]
  allowedToolNames: readonly string[]
  getReferences: () => DesignContextReference[]
  getWarnings: () => string[]
  assertReadyForImageCall: () => void
}

/** 上下文策略编排器的可替换依赖。 */
export interface DesignContextOrchestratorDependencies {
  textIndex: DesignProjectTextIndexContract
  catalog: DesignContextCatalogContract
  now?: () => number
  createReferenceId?: (key: string) => string
}

/** 文本预算截断的结构化原因。 */
type DesignContextTruncationReason = 'file-bytes' | 'total-bytes' | 'file-count'

/** 单次读取预算计算结果。 */
interface TextReadBudget {
  allowedBytes: number
  blockedReason?: DesignContextTruncationReason
}

/** 保留工具参数推断且不在 Electron CJS 主进程同步加载 ESM-only Pi SDK。 */
function defineDesignTool<TParams extends TSchema, TDetails = unknown>(
  tool: ToolDefinition<TParams, TDetails>,
): ToolDefinition<TParams, TDetails> {
  return tool
}

/** 单次 Design 内部 Agent 的上下文访问策略、预算和审计编排器。 */
export class DesignContextOrchestrator {
  /** 返回审计时间，测试可使用固定值。 */
  private readonly now: () => number
  /** 为唯一审计引用生成稳定 ID。 */
  private readonly createReferenceId: (key: string) => string

  constructor(private readonly dependencies: DesignContextOrchestratorDependencies) {
    this.now = dependencies.now ?? Date.now
    this.createReferenceId = dependencies.createReferenceId ?? (() => randomUUID())
  }

  /**
   * 为一次 Design Job 创建隔离的上下文工具与预算状态。
   * @param input 项目 ID、三态模式和用户原始要求。
   * @returns 仅属于本次运行的工具、审计与图片调用前检查。
   */
  createRun(input: CreateDesignContextRunInput): DesignContextRun {
    if (input.mode === 'none') {
      return {
        tools: [],
        allowedToolNames: [],
        getReferences: () => [],
        getWarnings: () => [],
        assertReadyForImageCall: () => undefined,
      }
    }

    if (input.mode === 'project') this.assertProjectHasCandidates(input.projectId)

    /** 以真实来源 key 去重的审计引用。 */
    const references = new Map<string, DesignContextReference>()
    /** 单次运行已读取的不同文本来源 key。 */
    const distinctTextKeys = new Set<string>()
    /** 去重后的预算与上下文警告。 */
    const warnings = new Set<string>()
    /** 本轮已经返回给模型的累计 UTF-8 字节数。 */
    let totalTextBytes = 0
    /** 工具回调闭包绑定的安全文本索引。 */
    const textIndex = this.dependencies.textIndex
    /** 工具回调闭包绑定的项目上下文库。 */
    const catalog = this.dependencies.catalog

    /** 读取前计算不同文件数和累计字节的剩余预算。 */
    const reserveReadBudget = (key: string): TextReadBudget => {
      if (!distinctTextKeys.has(key) && distinctTextKeys.size >= MAX_TEXT_FILES) {
        warnings.add(FILE_COUNT_WARNING)
        return { allowedBytes: 0, blockedReason: 'file-count' }
      }
      /** 累计预算可能已由此前多个 64 KiB 文件耗尽。 */
      const remainingBytes = MAX_TOTAL_TEXT_BYTES - totalTextBytes
      if (remainingBytes <= 0) {
        warnings.add(TOTAL_BYTES_WARNING)
        return { allowedBytes: 0, blockedReason: 'total-bytes' }
      }
      return { allowedBytes: Math.min(MAX_FILE_BYTES, remainingBytes) }
    }

    /** 提交一次成功文本读取的预算占用。 */
    const commitTextRead = (key: string, content: string): number => {
      /** 以实际返回字符串重新计算字节数，防止多字节字符放大预算。 */
      const returnedBytes = Buffer.byteLength(content, 'utf8')
      distinctTextKeys.add(key)
      totalTextBytes += returnedBytes
      if (totalTextBytes >= MAX_TOTAL_TEXT_BYTES) warnings.add(TOTAL_BYTES_WARNING)
      return returnedBytes
    }

    /** 只在首次成功读取某个来源时记录审计引用。 */
    const recordReference = (key: string, reference: Omit<DesignContextReference, 'id' | 'readAt'>): void => {
      if (references.has(key)) return
      references.set(key, {
        ...reference,
        id: this.createReferenceId(key),
        readAt: this.now(),
      })
    }

    /** Design 专用只读工具共享的文本结果构造器。 */
    const textResult = (content: string, details: Record<string, unknown>): AgentToolResult<unknown> => ({
      content: [{ type: 'text', text: content }],
      details,
    })

    /** 只返回相对路径和元数据的项目文件列表工具。 */
    const listProjectFiles = defineDesignTool({
      name: DESIGN_CONTEXT_TOOL_NAMES[0],
      label: '列出项目文本文件',
      description: '列出当前 Design 项目中允许读取的普通文本文件。不会返回绝对路径、敏感文件、依赖或构建产物。',
      promptSnippet: '先按需列出项目文件，再只读取与当前视觉任务直接相关的少量内容。',
      parameters: Type.Object({
        relativeDirectory: Type.Optional(Type.String({ description: '可选的项目内相对目录，禁止绝对路径和 ..。' })),
      }),
      async execute(_toolCallId, params) {
        /** 运行时参数只接受字符串相对目录。 */
        const relativeDirectory = typeof params.relativeDirectory === 'string'
          ? params.relativeDirectory
          : undefined
        const entries = textIndex.list(input.projectId, relativeDirectory)
        return textResult(JSON.stringify(entries, null, 2), { entries })
      },
    })

    /** 搜索项目文件名和受限文本首段的工具。 */
    const searchProjectText = defineDesignTool({
      name: DESIGN_CONTEXT_TOOL_NAMES[1],
      label: '搜索项目文本',
      description: '在当前 Design 项目的安全文本索引中搜索文件名和文本首段，只返回相对路径元数据。',
      promptSnippet: '使用简短业务或界面关键词定位相关项目文件。',
      parameters: Type.Object({
        query: Type.String({ minLength: 1, maxLength: 200, description: '1-200 字符的搜索词。' }),
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
      }),
      async execute(_toolCallId, params) {
        /** TypeBox 已校验后的搜索词和可选结果上限。 */
        const entries = textIndex.search(input.projectId, params.query, params.limit)
        return textResult(JSON.stringify(entries, null, 2), { entries })
      },
    })

    /** 按预算读取单个项目文本文件并留下真实引用。 */
    const readProjectFile = defineDesignTool({
      name: DESIGN_CONTEXT_TOOL_NAMES[2],
      label: '读取项目文本文件',
      description: '按已建立索引的项目相对路径读取最多 64 KiB 文本，并记录本次 Design 任务的实际引用。',
      promptSnippet: '只读取完成当前视觉任务必需的文件，并用 purpose 简述读取原因。',
      parameters: Type.Object({
        relativePath: Type.String({ minLength: 1, description: '项目内相对文件路径。' }),
        purpose: Type.Optional(Type.String({ maxLength: 400, description: '本次读取与视觉任务的关系。' })),
      }),
      async execute(_toolCallId, params) {
        /** 先通过 list 固定当前文件身份并获取大小元数据。 */
        const entry = textIndex.list(input.projectId)
          .find((candidate) => candidate.relativePath === params.relativePath)
        if (!entry) throw new Error(`项目文件不可读取: ${params.relativePath}`)
        /** 项目文件来源在本次运行内的唯一预算和审计 key。 */
        const key = `project:${entry.relativePath}`
        const budget = reserveReadBudget(key)
        if (budget.blockedReason) {
          return textResult('', {
            relativePath: entry.relativePath,
            byteSize: entry.byteSize,
            returnedBytes: 0,
            truncated: true,
            reason: budget.blockedReason,
          })
        }
        const content = textIndex.read(input.projectId, entry.relativePath, budget.allowedBytes)
        const returnedBytes = commitTextRead(key, content)
        /** 文件大于本次允许读取字节数时标记具体截断原因。 */
        const truncated = entry.byteSize > returnedBytes
        const reason: DesignContextTruncationReason | undefined = truncated
          ? budget.allowedBytes < MAX_FILE_BYTES ? 'total-bytes' : 'file-bytes'
          : undefined
        if (reason === 'total-bytes') warnings.add(TOTAL_BYTES_WARNING)
        recordReference(key, {
          category: 'code',
          sourceKind: 'project-file',
          label: entry.relativePath,
          relativePath: entry.relativePath,
          purpose: normalizePurpose(params.purpose, input.originalRequest),
        })
        return textResult(content, {
          relativePath: entry.relativePath,
          byteSize: entry.byteSize,
          returnedBytes,
          truncated,
          ...(reason && { reason }),
        })
      },
    })

    /** 读取长期 Markdown 资料或 Design 素材标准元数据并审计。 */
    const readContextEntry = defineDesignTool({
      name: DESIGN_CONTEXT_TOOL_NAMES[3],
      label: '读取创作上下文条目',
      description: '读取当前项目上下文库中的 Markdown 资料或视觉标准元数据，并记录真实引用。',
      promptSnippet: '按任务选择品牌、产品、角色、故事、场景、连续性或参考资料，不要批量读取全部条目。',
      parameters: Type.Object({
        entryId: Type.String({ minLength: 1, description: '上下文条目的稳定 ID。' }),
        purpose: Type.Optional(Type.String({ maxLength: 400, description: '本次读取与视觉任务的关系。' })),
      }),
      async execute(_toolCallId, params) {
        /** 目录列表只返回当前项目条目，不接受 Agent 提供项目 ID。 */
        const entry = catalog.list(input.projectId)
          .find((candidate) => candidate.id === params.entryId)
        if (!entry) throw new Error(`创作上下文不存在: ${params.entryId}`)
        /** 上下文条目在本次运行内的唯一预算和审计 key。 */
        const key = `context:${entry.id}`
        const budget = reserveReadBudget(key)
        if (budget.blockedReason) {
          return textResult('', {
            entryId: entry.id,
            returnedBytes: 0,
            truncated: true,
            reason: budget.blockedReason,
          })
        }
        /** 文档返回受限正文，素材只返回非敏感可移植元数据。 */
        const fullContent = entry.kind === 'document'
          ? catalog.readDocument(input.projectId, entry.id)
          : JSON.stringify({
              id: entry.id,
              category: entry.category,
              title: entry.title,
              assetId: entry.assetId,
              tags: entry.tags,
            }, null, 2)
        const content = truncateUtf8(fullContent, budget.allowedBytes)
        const returnedBytes = commitTextRead(key, content)
        const fullBytes = Buffer.byteLength(fullContent, 'utf8')
        const truncated = fullBytes > returnedBytes
        const reason: DesignContextTruncationReason | undefined = truncated
          ? budget.allowedBytes < MAX_FILE_BYTES ? 'total-bytes' : 'file-bytes'
          : undefined
        if (reason === 'total-bytes') warnings.add(TOTAL_BYTES_WARNING)
        recordReference(key, {
          category: entry.category,
          sourceKind: entry.kind === 'document' ? 'context-document' : 'design-asset',
          label: entry.title,
          ...(entry.relativePath && { relativePath: entry.relativePath }),
          ...(entry.assetId && { assetId: entry.assetId }),
          purpose: normalizePurpose(params.purpose, input.originalRequest),
        })
        return textResult(content, {
          entryId: entry.id,
          kind: entry.kind,
          returnedBytes,
          truncated,
          ...(reason && { reason }),
        })
      },
    })

    /** 工具顺序与公开白名单常量保持一致，便于审计和测试。 */
    const tools: ToolDefinition[] = [
      listProjectFiles,
      searchProjectText,
      readProjectFile,
      readContextEntry,
    ]
    return {
      tools,
      allowedToolNames: DESIGN_CONTEXT_TOOL_NAMES,
      getReferences: () => [...references.values()].map((reference) => ({ ...reference })),
      getWarnings: () => [...warnings],
      assertReadyForImageCall: () => {
        if (input.mode === 'project' && references.size === 0) {
          throw new Error('使用项目模式必须先读取至少一项创作上下文')
        }
        if (input.mode === 'auto'
          && requestRequiresProjectContext(input.originalRequest)
          && references.size === 0) {
          throw new Error('当前要求依赖项目上下文，但 Agent 尚未成功读取资料')
        }
      },
    }
  }

  /** project 模式创建时即确认项目至少存在一项可读候选。 */
  private assertProjectHasCandidates(projectId: string): void {
    /** 项目文本和长期目录都没有候选时不应启动 Agent 或图片调用。 */
    const projectEntries = this.dependencies.textIndex.list(projectId)
    const contextEntries = this.dependencies.catalog.list(projectId)
    if (projectEntries.length === 0 && contextEntries.length === 0) {
      throw new Error('当前项目没有可用的创作上下文')
    }
  }
}

/** 把任意 UTF-8 文本截断到最大原始字节数。 */
function truncateUtf8(content: string, maxBytes: number): string {
  /** Buffer 截断可能落在多字节字符中间，循环移除末尾替代字符。 */
  let text = Buffer.from(content, 'utf8').subarray(0, maxBytes).toString('utf8')
  while (text.endsWith('\uFFFD')) text = text.slice(0, -1)
  return text
}

/** 规范化审计用途，优先使用 Agent 明确说明，其次使用原始要求。 */
function normalizePurpose(purpose: string | undefined, originalRequest: string | undefined): string {
  return purpose?.trim() || originalRequest?.trim() || '理解当前创作要求'
}

/** 判断 auto 模式的原始要求是否明确依赖当前项目或既有创作连续性。 */
function requestRequiresProjectContext(originalRequest: string | undefined): boolean {
  if (!originalRequest) return false
  return /(?:当前|这个|本)(?:项目|页面|产品|品牌|角色|故事|场景)|沿用|保持.{0,8}(?:一致|统一)|继续.{0,8}(?:角色|故事|场景|风格|视觉)|现有.{0,8}(?:设计|品牌|角色|页面|产品)/i
    .test(originalRequest)
}
