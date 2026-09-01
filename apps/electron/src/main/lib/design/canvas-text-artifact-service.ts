import { isAbsolute, extname } from 'node:path'
import {
  CANVAS_TEXT_ARTIFACT_CONTENT_MAX_BYTES,
  parseCanvasBatchOperationEnvelope,
} from '@proma/shared'
import type {
  AdoptCanvasTextArtifactRevisionInput,
  CanvasArtifactAuthor,
  CanvasArtifactRevisionSummary,
  CanvasBatchOperationEnvelope,
  CanvasChangeSource,
  CanvasDocument,
  CanvasDocumentNode,
  CanvasTarget,
  CanvasTextArtifactIdentity,
  CanvasTextArtifactKind,
  CanvasTextArtifactMutationResult,
  CanvasTextArtifactSnapshot,
  CanvasTextArtifactTarget,
  CanvasWebviewNode,
  CanvasWorkspaceSnapshot,
  UpdateCanvasTextArtifactInput,
} from '@proma/shared'
import { writeTextFileAtomic } from '../safe-file'
import type { CanvasDocumentStore } from './canvas-document-store'
import type {
  CanvasArtifactRevisionRecord,
  CanvasArtifactRevisionSnapshot,
  CanvasArtifactRevisionStore,
} from './canvas-artifact-revision-store'
import type { CanvasBatchOperationResult } from './canvas-agent-batch-operation'
import {
  DOCUMENT_ARTIFACT_DESCRIPTOR,
  WEBVIEW_ARTIFACT_DESCRIPTOR,
  type CanvasArtifactAdapter,
  type CanvasArtifactDescriptor,
} from './canvas-artifact-registry'

/** 文本产物变更的可信调用来源。 */
export type CanvasTextArtifactChangeSource =
  | { type: 'user' }
  | { type: 'agent'; sessionId: string; runStartedAt: number; toolCallId: string }

/** 文本产物更新在共享输入之外携带可信来源。 */
export interface CanvasTextArtifactServiceUpdateInput extends UpdateCanvasTextArtifactInput {
  source: CanvasTextArtifactChangeSource
}

/** 单节点图提交使用的内部严格输入。 */
export interface CanvasTextArtifactGraphCommitInput extends CanvasTarget {
  operationId: string
  expectedCanvasRevision: number
  node: CanvasDocumentNode | CanvasWebviewNode
  source?: CanvasChangeSource
}

/** 文本产物服务依赖的单节点图写边界。 */
export interface CanvasTextArtifactGraphWriter {
  commit: (input: CanvasTextArtifactGraphCommitInput) => Promise<CanvasDocument>
}

/** 用户图写与 Agent batch 分支使用的依赖。 */
export interface CanvasTextArtifactGraphWriterDependencies {
  documents: Pick<CanvasDocumentStore, 'mutate'>
  batch: {
    execute: (input: CanvasBatchOperationEnvelope) => Promise<CanvasBatchOperationResult>
  }
}

/** 经过 save dialog 授权后的文本产物导出输入。 */
export interface ExportCanvasTextArtifactToPathInput extends CanvasTextArtifactTarget {
  targetPath: string
}

/** 文本产物事务服务的窄依赖。 */
export interface CanvasTextArtifactServiceDependencies {
  documents: {
    load: (target: CanvasTarget) => CanvasWorkspaceSnapshot
  }
  revisions: CanvasArtifactRevisionStore
  graph: CanvasTextArtifactGraphWriter
  writeTextFileAtomic?: (filePath: string, content: string) => unknown
}

/** 文档与 WebView 共享的版本事务能力。 */
export interface CanvasTextArtifactService {
  read: (target: CanvasTextArtifactTarget) => Promise<CanvasTextArtifactSnapshot>
  listVersions: (identity: CanvasTextArtifactIdentity) => Promise<CanvasArtifactRevisionSummary[]>
  update: (input: CanvasTextArtifactServiceUpdateInput) => Promise<CanvasTextArtifactMutationResult>
  adopt: (input: AdoptCanvasTextArtifactRevisionInput) => Promise<CanvasTextArtifactMutationResult>
  export: (input: ExportCanvasTextArtifactToPathInput) => Promise<void>
}

/** 固定类别的文本产物适配器，供 Registry 路由真实业务方法。 */
export interface CanvasTextArtifactAdapter<Kind extends CanvasTextArtifactKind = CanvasTextArtifactKind>
  extends CanvasArtifactAdapter<Kind> {
  readonly descriptor: CanvasArtifactDescriptor<Kind>
  read: (target: CanvasTextArtifactTarget) => Promise<CanvasTextArtifactSnapshot>
  update: (input: CanvasTextArtifactServiceUpdateInput) => Promise<CanvasTextArtifactMutationResult>
  listVersions: (identity: CanvasTextArtifactIdentity) => Promise<CanvasArtifactRevisionSummary[]>
  adopt: (input: AdoptCanvasTextArtifactRevisionInput) => Promise<CanvasTextArtifactMutationResult>
  export: (input: ExportCanvasTextArtifactToPathInput) => Promise<void>
}

/** 文本节点联合只包含拥有不可变正文版本的两类节点。 */
type CanvasTextNode = CanvasDocumentNode | CanvasWebviewNode

/** 从节点判别字段返回其稳定正文 ID。 */
function getNodeContentId(node: CanvasTextNode): string {
  return node.kind === 'document' ? node.documentId : node.prototypeId
}

/** 判断节点是否属于支持不可变正文的产物。 */
function isTextNode(node: CanvasDocument['nodes'][number]): node is CanvasTextNode {
  return node.kind === 'document' || node.kind === 'webview'
}

/** 从权威图严格重建并校验调用方声明的文本节点身份。 */
function requireAuthoritativeNode(
  document: CanvasDocument,
  identity: CanvasTextArtifactIdentity,
): CanvasTextNode {
  /** 节点 ID 对应的当前权威节点。 */
  const node = document.nodes.find((candidate) => candidate.id === identity.nodeId)
  if (!node || !isTextNode(node)
    || node.kind !== identity.kind
    || getNodeContentId(node) !== identity.contentId) {
    throw new Error('CANVAS_TEXT_ARTIFACT_IDENTITY_CONFLICT')
  }
  return node
}

/** 校验图 revision 和当前采用正文 revision 的双重写基线。 */
function requireMutationBaseline(
  document: CanvasDocument,
  identity: CanvasTextArtifactIdentity,
  expectedCanvasRevision: number,
  expectedContentRevision: number,
): CanvasTextNode {
  /** 权威身份校验先于 revision 比较，避免伪造节点被误报为普通冲突。 */
  const node = requireAuthoritativeNode(document, identity)
  if (document.revision !== expectedCanvasRevision
    || node.contentRevision !== expectedContentRevision) {
    throw new Error('CANVAS_ARTIFACT_REVISION_CONFLICT')
  }
  return node
}

/** 只替换节点当前采用 revision，保留类别特有字段和布局。 */
function replaceNodeContentRevision(node: CanvasTextNode, revision: number): CanvasTextNode {
  return { ...node, contentRevision: revision }
}

/** 从内部版本记录构造不含 state/schemaVersion 的公开摘要。 */
function toRevisionSummary(record: CanvasArtifactRevisionRecord): CanvasArtifactRevisionSummary {
  return {
    kind: record.kind,
    contentId: record.contentId,
    revision: record.revision,
    parentRevision: record.parentRevision,
    contentHash: record.contentHash,
    createdBy: record.createdBy,
    createdAt: record.createdAt,
  }
}

/** 校验版本 Store 回读结果没有偏离目标节点身份。 */
function requireRevisionSnapshot(
  snapshot: CanvasArtifactRevisionSnapshot,
  target: CanvasTextArtifactTarget,
): CanvasArtifactRevisionSnapshot {
  if (snapshot.record.kind !== target.kind
    || snapshot.record.contentId !== target.contentId
    || snapshot.record.revision !== target.contentRevision) {
    throw new Error('CANVAS_TEXT_ARTIFACT_IDENTITY_CONFLICT')
  }
  return snapshot
}

/** 把内部版本快照与节点身份组合为公开正文快照。 */
function toArtifactSnapshot(
  target: CanvasTextArtifactTarget,
  snapshot: CanvasArtifactRevisionSnapshot,
): CanvasTextArtifactSnapshot {
  /** 回读结果必须与权威节点目标精确一致。 */
  const verified = requireRevisionSnapshot(snapshot, target)
  if (verified.record.state !== 'committed') {
    throw new Error('CANVAS_ARTIFACT_REVISION_NOT_COMMITTED')
  }
  return { target, revision: toRevisionSummary(verified.record), content: verified.content }
}

/** 校验更新正文的字节上限及 WebView 非空合同。 */
function requireValidContent(kind: CanvasTextArtifactKind, content: unknown): string {
  if (typeof content !== 'string'
    || new TextEncoder().encode(content).byteLength > CANVAS_TEXT_ARTIFACT_CONTENT_MAX_BYTES
    || (kind === 'webview' && content.trim().length === 0)) {
    throw new Error('CANVAS_TEXT_ARTIFACT_CONTENT_INVALID')
  }
  return content
}

/** 从可信变更来源构造不可变修订作者。 */
function toRevisionAuthor(source: CanvasTextArtifactChangeSource): CanvasArtifactAuthor {
  return source.type === 'user'
    ? { type: 'user' }
    : { type: 'agent', sessionId: source.sessionId, toolCallId: source.toolCallId }
}

/** 从 Agent 变更来源构造图变化的公开最小身份。 */
function toCanvasChangeSource(
  source: Extract<CanvasTextArtifactChangeSource, { type: 'agent' }>,
): CanvasChangeSource {
  return {
    sessionId: source.sessionId,
    runStartedAt: source.runStartedAt,
    toolCallId: source.toolCallId,
  }
}

/** 校验导出目标是绝对路径且扩展名与产物类别精确匹配。 */
function assertExpectedExtension(filePath: string, kind: CanvasTextArtifactKind): void {
  /** 两类正文唯一允许的导出扩展名。 */
  const expected = kind === 'document' ? '.md' : '.html'
  if (!isAbsolute(filePath) || extname(filePath) !== expected) {
    throw new Error('CANVAS_ARTIFACT_EXPORT_PATH_INVALID')
  }
}

/** 创建用户直写与 Agent batch 共用的单节点 Graph Writer。 */
export function createCanvasTextArtifactGraphWriter(
  dependencies: CanvasTextArtifactGraphWriterDependencies,
): CanvasTextArtifactGraphWriter {
  return {
    commit: async (input) => {
      /** 单节点更新 mutation 不改变其它节点或边。 */
      const mutation = { type: 'upsert-nodes' as const, nodes: [input.node] }
      if (!input.source) {
        return dependencies.documents.mutate(
          { projectId: input.projectId, canvasId: input.canvasId },
          input.expectedCanvasRevision,
          [mutation],
        )
      }
      /** Agent 分支必须经过现有 batch 的资源与幂等边界。 */
      const envelope = parseCanvasBatchOperationEnvelope({
        projectId: input.projectId,
        canvasId: input.canvasId,
        baseRevision: input.expectedCanvasRevision,
        operations: [mutation],
        sourceSessionId: input.source.sessionId,
        sourceRunStartedAt: input.source.runStartedAt,
        sourceToolCallId: input.source.toolCallId,
      })
      /** batch 返回的文档是本次 Agent 图提交的权威结果。 */
      const result = await dependencies.batch.execute(envelope)
      return result.document
    },
  }
}

/** 创建不自行获取 serializer 或 workspace lease 的文本产物事务服务。 */
export function createCanvasTextArtifactService(
  dependencies: CanvasTextArtifactServiceDependencies,
): CanvasTextArtifactService {
  /** 原子导出写入依赖，生产默认复用 safe-file。 */
  const atomicWrite = dependencies.writeTextFileAtomic ?? writeTextFileAtomic

  /** 加载权威图并校验目标节点身份，允许只读历史 revision。 */
  const loadAuthoritativeTarget = (target: CanvasTextArtifactTarget): {
    snapshot: CanvasWorkspaceSnapshot
    node: CanvasTextNode
  } => {
    /** 当前权威 Canvas 工作区快照。 */
    const snapshot = dependencies.documents.load(target)
    /** 历史读取仍必须绑定同一权威节点和稳定正文 ID。 */
    const node = requireAuthoritativeNode(snapshot.document, target)
    return { snapshot, node }
  }

  /** 加载权威图并校验目标节点当前采用指定 revision。 */
  const loadExactTarget = (target: CanvasTextArtifactTarget): CanvasWorkspaceSnapshot => {
    /** 写入、采用和导出继续要求目标是当前采用版本。 */
    const { snapshot, node } = loadAuthoritativeTarget(target)
    if (node.contentRevision !== target.contentRevision) {
      throw new Error('CANVAS_ARTIFACT_REVISION_CONFLICT')
    }
    return snapshot
  }

  /** 读取已提交正文；历史比较与当前导出通过 requireCurrent 区分语义。 */
  const readCommittedTarget = async (
    target: CanvasTextArtifactTarget,
    requireCurrent: boolean,
  ): Promise<CanvasTextArtifactSnapshot> => {
    if (requireCurrent) loadExactTarget(target)
    else loadAuthoritativeTarget(target)
    /** 正文始终从不可变 revision store 按精确身份读取。 */
    const revision = await dependencies.revisions.read(target, {
      kind: target.kind,
      contentId: target.contentId,
      revision: target.contentRevision,
    })
    return toArtifactSnapshot(target, revision)
  }

  /** 图已提交后提交正文 meta；回执失败时只允许权威重读与 reconcile。 */
  const finalizeRevision = async (
    target: CanvasTextArtifactTarget,
  ): Promise<CanvasWorkspaceSnapshot> => {
    /** 图提交后的权威工作区快照同时用于响应和恢复判断。 */
    let snapshot = loadExactTarget(target)
    if (target.contentRevision === 0) return snapshot
    try {
      await dependencies.revisions.commit(target, {
        kind: target.kind,
        contentId: target.contentId,
        revision: target.contentRevision,
      })
    } catch {
      /** commit 回执失败后重读，禁止使用图提交前的内存基线做恢复。 */
      snapshot = loadExactTarget(target)
      await dependencies.revisions.reconcile(target, snapshot.document)
    }
    return snapshot
  }

  /** 服务公开实现，供 adapter 复用同一实例。 */
  const service: CanvasTextArtifactService = {
    read: async (target) => readCommittedTarget(target, false),
    listVersions: async (identity) => {
      /** 列表同样先从权威图重建 kind 与 contentId。 */
      const snapshot = dependencies.documents.load(identity)
      requireAuthoritativeNode(snapshot.document, identity)
      /** prepared 版本尚未被图采用，不能进入普通历史列表。 */
      const records = await dependencies.revisions.list(identity, {
        kind: identity.kind,
        contentId: identity.contentId,
      })
      return records
        .filter((record) => record.state === 'committed')
        .sort((left, right) => left.revision - right.revision)
        .map(toRevisionSummary)
    },
    update: async (input) => {
      /** 正文在任何持久化或图写前完成有界校验。 */
      const content = requireValidContent(input.kind, input.content)
      /** 更新必须建立在同一次权威图和正文 revision 上。 */
      const current = dependencies.documents.load(input)
      const currentNode = requireMutationBaseline(
        current.document,
        input,
        input.expectedCanvasRevision,
        input.expectedContentRevision,
      )
      /** 新正文先以 prepared 状态写入不可变版本目录。 */
      const prepared = await dependencies.revisions.prepare(input, {
        kind: input.kind,
        contentId: input.contentId,
        parentRevision: input.expectedContentRevision,
        content,
        createdBy: toRevisionAuthor(input.source),
      })
      /** Revision Store 必须返回同身份且从当前父版本派生的新 revision。 */
      if (prepared.record.kind !== input.kind
        || prepared.record.contentId !== input.contentId
        || prepared.record.parentRevision !== input.expectedContentRevision
        || prepared.record.revision <= input.expectedContentRevision) {
        throw new Error('CANVAS_TEXT_ARTIFACT_IDENTITY_CONFLICT')
      }
      /** 图只切换当前节点的采用 revision。 */
      const nextNode = replaceNodeContentRevision(currentNode, prepared.record.revision)
      await dependencies.graph.commit({
        projectId: input.projectId,
        canvasId: input.canvasId,
        operationId: input.operationId,
        expectedCanvasRevision: input.expectedCanvasRevision,
        node: nextNode,
        ...(input.source.type === 'agent'
          ? { source: toCanvasChangeSource(input.source) }
          : {}),
      })
      /** 图提交后使用完整节点身份构造采用目标。 */
      const target: CanvasTextArtifactTarget = {
        projectId: input.projectId,
        canvasId: input.canvasId,
        nodeId: input.nodeId,
        kind: input.kind,
        contentId: input.contentId,
        contentRevision: prepared.record.revision,
      }
      /** commit 回执失败由 reconcile 收敛，正文永不补偿删除。 */
      const snapshot = await finalizeRevision(target)
      /** 使用 prepared 正文和最终公开 committed 事实构造结果。 */
      const committedRevision = await dependencies.revisions.read(target, {
        kind: target.kind,
        contentId: target.contentId,
        revision: target.contentRevision,
      })
      return { snapshot, artifact: toArtifactSnapshot(target, committedRevision) }
    },
    adopt: async (input) => {
      /** 采用也必须建立在权威图与当前正文双重基线上。 */
      const current = dependencies.documents.load(input)
      const currentNode = requireMutationBaseline(
        current.document,
        input,
        input.expectedCanvasRevision,
        input.expectedContentRevision,
      )
      /** 历史正文先精确读取，采用过程不调用 prepare 或复制正文。 */
      const selected = await dependencies.revisions.read(input, {
        kind: input.kind,
        contentId: input.contentId,
        revision: input.revision,
      })
      /** 历史 Store 返回值必须与调用方目标严格一致。 */
      const target: CanvasTextArtifactTarget = {
        projectId: input.projectId,
        canvasId: input.canvasId,
        nodeId: input.nodeId,
        kind: input.kind,
        contentId: input.contentId,
        contentRevision: input.revision,
      }
      requireRevisionSnapshot(selected, target)
      /** 图只切换采用 revision，不创建新历史版本。 */
      await dependencies.graph.commit({
        projectId: input.projectId,
        canvasId: input.canvasId,
        operationId: input.operationId,
        expectedCanvasRevision: input.expectedCanvasRevision,
        node: replaceNodeContentRevision(currentNode, input.revision),
      })
      /** prepared 恢复候选被采用后同样进入 committed 状态。 */
      const snapshot = await finalizeRevision(target)
      /** reconcile 后重新读取，确保返回正文与最终版本事实一致。 */
      const committedRevision = await dependencies.revisions.read(target, {
        kind: target.kind,
        contentId: target.contentId,
        revision: target.contentRevision,
      })
      return { snapshot, artifact: toArtifactSnapshot(target, committedRevision) }
    },
    export: async (input) => {
      assertExpectedExtension(input.targetPath, input.kind)
      /** 导出只能消费节点当前采用版本，历史版本需先显式采用。 */
      const artifact = await readCommittedTarget(input, true)
      atomicWrite(input.targetPath, artifact.content)
    },
  }

  return service
}

/** 运行时固定 adapter 类别，禁止调用方通过宽联合绕过 Registry 路由。 */
function assertTextKind<Kind extends CanvasTextArtifactKind, Input extends { kind: CanvasTextArtifactKind }>(
  input: Input,
  kind: Kind,
): Input & { kind: Kind } {
  if (input.kind !== kind) throw new Error('CANVAS_TEXT_ARTIFACT_KIND_MISMATCH')
  return input as Input & { kind: Kind }
}

/** 创建固定 document 或 webview 类别的真实文本产物适配器。 */
export function createCanvasTextArtifactAdapter<Kind extends CanvasTextArtifactKind>(
  kind: Kind,
  service: CanvasTextArtifactService,
): CanvasTextArtifactAdapter<Kind> {
  /** 固定类别对应的冻结 Registry 描述。 */
  const descriptor = (kind === 'document'
    ? DOCUMENT_ARTIFACT_DESCRIPTOR
    : WEBVIEW_ARTIFACT_DESCRIPTOR) as CanvasArtifactDescriptor<Kind>
  return {
    descriptor,
    read: async (target) => service.read(assertTextKind(target, kind)),
    update: async (input) => service.update(assertTextKind(input, kind)),
    listVersions: async (identity) => service.listVersions(assertTextKind(identity, kind)),
    adopt: async (input) => service.adopt(assertTextKind(input, kind)),
    export: async (input) => service.export(assertTextKind(input, kind)),
  }
}
