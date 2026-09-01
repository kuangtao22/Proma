import { createHash } from 'node:crypto'
import type {
  CanvasDocument,
  CanvasImageInputReference,
  CanvasImageTarget,
  CanvasNode,
  SDKMessage,
} from '@proma/shared'
import type { CanvasDocumentStore } from './canvas-document-store'
import type { CanvasImageModuleStore } from './canvas-image-module-store'

/** 单次任务最多固化的直接入边数量。 */
export const CANVAS_IMAGE_INPUT_MAX_REFERENCES = 8
/** 所有输入摘要合计字符上限。 */
export const CANVAS_IMAGE_INPUT_MAX_TEXT = 8_000
/** 单次任务最多固化的媒体素材引用数量。 */
export const CANVAS_IMAGE_INPUT_MAX_MEDIA = 4
/** 单项摘要字符上限，避免一个上游独占全部预算。 */
const CANVAS_IMAGE_INPUT_MAX_ITEM_TEXT = 2_000

/** Agent 已提交 JSONL 输出的权威快照。 */
export interface CanvasAgentCommittedOutput {
  revision: number
  messages: SDKMessage[]
  assetId?: string
}

/** 已提交 Markdown 的权威快照。 */
export interface CanvasDocumentCommittedOutput {
  revision: number
  markdown: string
}

/** 已提交原型的安全摘要快照。 */
export interface CanvasPrototypeCommittedOutput {
  revision: number
  summary: string
}

/** Canvas 图片任务直接输入解析器。 */
export interface CanvasImageInputResolver {
  resolve: (target: CanvasImageTarget) => Promise<CanvasImageInputReference[]>
}

/** 解析器只读取各节点已经提交的事实，不接触 Renderer 草稿。 */
export interface CanvasImageInputResolverDependencies {
  canvasStore: Pick<CanvasDocumentStore, 'requireStableAuthoritativeDocument'>
  imageStore: Pick<CanvasImageModuleStore, 'load'>
  getAgentOutput: (sessionId: string) => Promise<CanvasAgentCommittedOutput>
  readDocument: (
    target: { projectId: string; canvasId: string },
    documentId: string,
  ) => Promise<CanvasDocumentCommittedOutput>
  readPrototype: (
    target: { projectId: string; canvasId: string },
    prototypeId: string,
  ) => Promise<CanvasPrototypeCommittedOutput>
}

/** 判断未知值是否为普通对象。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 从权威 SDK JSONL 中选择最近一条明确 assistant 文本输出。 */
function resolveLatestAgentSummary(messages: SDKMessage[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    /** 单条持久化消息只通过结构化字段读取公开文本。 */
    const message = messages[index]
    if (!message || message.type !== 'assistant' || !isRecord(message.message)) continue
    const content = message.message.content
    if (!Array.isArray(content)) continue
    /** 同一 assistant 消息内的文本块按原顺序组成明确输出。 */
    const text = content.flatMap((block) => (
      isRecord(block) && block.type === 'text' && typeof block.text === 'string'
        ? [block.text.trim()]
        : []
    )).filter(Boolean).join('\n')
    if (text) return text
  }
  return 'Agent 已提交输出为空'
}

/** 规范化摘要空白并限制单项和剩余总预算。 */
function truncateSummary(value: string, remaining: number): string {
  const normalized = value.replace(/\s+/g, ' ').trim()
  return normalized.slice(0, Math.min(CANVAS_IMAGE_INPUT_MAX_ITEM_TEXT, remaining))
}

/** 计算固化摘要的稳定 SHA-256。 */
function hashSummary(summary: string): string {
  return createHash('sha256').update(summary, 'utf8').digest('hex')
}

/** 验证内容 revision 是可固化的非负安全整数。 */
function requireRevision(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('CANVAS_IMAGE_INPUT_REVISION_INVALID')
  return value
}

/** 创建只解析直接入边已提交快照的输入解析器。 */
export function createCanvasImageInputResolver(
  dependencies: CanvasImageInputResolverDependencies,
): CanvasImageInputResolver {
  /** 把单个上游节点解析为未应用全局预算的输入引用。 */
  const resolveNode = async (
    target: CanvasImageTarget,
    node: CanvasNode,
  ): Promise<Omit<CanvasImageInputReference, 'summaryHash'> | undefined> => {
    if (node.kind === 'agent') {
      /** Agent revision 和消息必须来自同一次权威 JSONL 快照。 */
      const output = await dependencies.getAgentOutput(node.agentSessionId)
      return {
        nodeId: node.id,
        kind: node.kind,
        revision: requireRevision(output.revision),
        summary: resolveLatestAgentSummary(output.messages),
        ...(output.assetId ? { assetId: output.assetId } : {}),
      }
    }
    if (node.kind === 'image') {
      /** 图片配置是当前采用素材的权威事实，节点字段仅作 UI 投影。 */
      const config = await dependencies.imageStore.load({
        projectId: target.projectId,
        canvasId: target.canvasId,
        nodeId: node.id,
        imageModuleId: node.imageModuleId,
      })
      if (!config.adoptedAssetId) return undefined
      return {
        nodeId: node.id,
        kind: node.kind,
        revision: requireRevision(config.revision),
        summary: `当前采用图片素材 ${config.adoptedAssetId}`,
        assetId: config.adoptedAssetId,
      }
    }
    if (node.kind === 'document') {
      /** Markdown reader 只返回已提交正文和对应 revision。 */
      const output = await dependencies.readDocument(target, node.documentId)
      if (output.revision !== node.contentRevision) throw new Error('CANVAS_IMAGE_INPUT_REVISION_CONFLICT')
      return {
        nodeId: node.id,
        kind: node.kind,
        revision: requireRevision(output.revision),
        summary: output.markdown,
      }
    }
    /** 原型 reader 负责把已提交 HTML/meta 投影为不执行脚本的安全摘要。 */
    const output = await dependencies.readPrototype(target, node.prototypeId)
    if (output.revision !== node.contentRevision) throw new Error('CANVAS_IMAGE_INPUT_REVISION_CONFLICT')
    return {
      nodeId: node.id,
      kind: node.kind,
      revision: requireRevision(output.revision),
      summary: output.summary,
    }
  }

  return {
    resolve: async (target) => {
      /** 单次权威图读取决定直接入边集合，禁止递归扩散。 */
      const document: CanvasDocument = dependencies.canvasStore.requireStableAuthoritativeDocument(target)
      /** 单次建表把目标与候选节点查询从重复线性扫描降为常数时间。 */
      const nodesById = new Map(document.nodes.map((node) => [node.id, node]))
      const targetNode = nodesById.get(target.nodeId)
      if (!targetNode || targetNode.kind !== 'image'
        || targetNode.imageModuleId !== target.imageModuleId) {
        throw new Error('CANVAS_IMAGE_TARGET_INVALID')
      }
      /** 边顺序决定稳定输入顺序，重复源节点只解析一次。 */
      const sourceIds = [...new Set(document.edges
        .filter((edge) => edge.targetNodeId === target.nodeId && edge.relation === 'reference')
        .map((edge) => edge.sourceNodeId))]
        .slice(0, CANVAS_IMAGE_INPUT_MAX_REFERENCES)
      /** 逐项消费固定引用、文本和媒体预算。 */
      const references: CanvasImageInputReference[] = []
      let textLength = 0
      let mediaCount = 0
      for (const sourceId of sourceIds) {
        if (references.length >= CANVAS_IMAGE_INPUT_MAX_REFERENCES
          || textLength >= CANVAS_IMAGE_INPUT_MAX_TEXT) break
        const node = nodesById.get(sourceId)
        if (!node) continue
        /** 图片媒体预算已满时不触发模块 Store 读取。 */
        if (node.kind === 'image' && mediaCount >= CANVAS_IMAGE_INPUT_MAX_MEDIA) continue
        const resolved = await resolveNode(target, node)
        if (!resolved) continue
        if (resolved.assetId && mediaCount >= CANVAS_IMAGE_INPUT_MAX_MEDIA) continue
        const summary = truncateSummary(resolved.summary, CANVAS_IMAGE_INPUT_MAX_TEXT - textLength)
        if (!summary) continue
        references.push({ ...resolved, summary, summaryHash: hashSummary(summary) })
        textLength += summary.length
        if (resolved.assetId) mediaCount += 1
      }
      return references
    },
  }
}
