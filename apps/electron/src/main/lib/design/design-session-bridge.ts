import { lstatSync, readFileSync, realpathSync } from 'node:fs'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import type {
  AgentMessage,
  AgentSessionMeta,
  SDKMessage,
  SDKToolResultBlock,
  SDKUserMessage,
  DesignAsset,
  DesignCanvasNode,
  DesignWorkspaceSnapshot,
  ImportAgentImageInput,
  PrepareDesignAssetForSessionInput,
  PreparedDesignAssetMention,
} from '@proma/shared'
import { isValidImageBytes } from '../image-content-validation'
import type { DesignAssetImportBatch, DesignAssetService } from './design-asset-service'
import type { DesignStore } from './design-store'

/** 会话桥只使用素材服务的受控导入与路径解析能力。 */
interface DesignSessionBridgeAssetService extends Pick<
  DesignAssetService,
  'resolveAssetPath' | 'importAuthorizedFiles'
> {}

/** 会话桥只使用权威文档读取与 revision mutation。 */
interface DesignSessionBridgeStore extends Pick<
  DesignStore,
  'requireStableAuthoritativeDocument' | 'mutate'
> {}

/** Design 与 Agent 会话双向传递所需的可信主进程依赖。 */
export interface DesignSessionBridgeDependencies {
  getSession: (sessionId: string) => AgentSessionMeta | undefined
  getMessages: (sessionId: string) => Array<AgentMessage | SDKMessage>
  /** 把持久化附件相对路径解析为绝对路径；绝对路径保持原语义。 */
  resolveAgentImagePath: (localPath: string) => string
  /** 返回当前会话运行时可读取的可信根目录。 */
  getAllowedRoots: (session: AgentSessionMeta, projectId: string) => string[]
  store: DesignSessionBridgeStore
  assets: DesignSessionBridgeAssetService
  createId?: () => string
}

/** 判断真实路径是否位于允许根目录本身或其后代。 */
function isPathWithinRoot(candidate: string, root: string): boolean {
  /** 使用 path.relative 同时兼容 POSIX 与 Windows 分隔符。 */
  const relativePath = relative(root, candidate)
  return relativePath === ''
    || (relativePath !== '..' && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath))
}

/** 从指定会话持久化消息中寻找精确 localPath 的图片归属证据。 */
function findOwnedImage(messages: Array<AgentMessage | SDKMessage>, localPath: string): { mediaType: string } | undefined {
  for (const message of messages) {
    if (!('type' in message)) {
      for (const event of message.events ?? []) {
        if (event.type !== 'tool_result') continue
        /** 同字符串只在当前 session 的持久化事件中出现才构成所有权。 */
        const image = event.imageAttachments?.find((candidate) => candidate.localPath === localPath)
        if (image) return { mediaType: image.mediaType }
      }
      continue
    }
    if (message.type !== 'user') continue
    /** 新版 JSONL 直接保存 SDK user/tool_result 块。 */
    const content = (message as SDKUserMessage).message?.content
    if (!Array.isArray(content)) continue
    for (const block of content) {
      if (block.type !== 'tool_result') continue
      const result = block as SDKToolResultBlock
      const image = result.imageAttachments?.find((candidate) => candidate.localPath === localPath)
      if (image) return { mediaType: image.mediaType }
    }
  }
  return undefined
}

/** 验证会话存在且仍属于请求项目。 */
function requireProjectSession(
  getSession: DesignSessionBridgeDependencies['getSession'],
  projectId: string,
  sessionId: string,
): AgentSessionMeta {
  /** 会话必须来自主进程索引，Renderer 不能构造临时会话身份。 */
  const session = getSession(sessionId)
  if (!session) throw new Error(`Agent 会话不存在: ${sessionId}`)
  if (session.workspaceId !== projectId) throw new Error('Agent 会话不属于当前项目')
  return session
}

/** 项目级 Design 素材与 Agent 会话之间的主进程归属桥。 */
export class DesignSessionBridge {
  private readonly createId: () => string

  constructor(private readonly dependencies: DesignSessionBridgeDependencies) {
    this.createId = dependencies.createId ?? (() => globalThis.crypto.randomUUID())
  }

  /** 准备只填入会话 composer 的受管项目素材引用，不修改任何会话状态。 */
  prepareAssetForSession(input: PrepareDesignAssetForSessionInput): PreparedDesignAssetMention {
    requireProjectSession(this.dependencies.getSession, input.projectId, input.sessionId)
    /** 权威文档读取同时验证项目存在、稳定且素材属于该项目。 */
    const document = this.dependencies.store.requireStableAuthoritativeDocument(input.projectId)
    const asset = document.assets.find((candidate) => candidate.id === input.assetId)
    if (!asset) throw new Error(`素材不存在: ${input.assetId}`)
    /** 素材服务从可信相对路径解析并 no-follow 校验原图叶子。 */
    const resolvedPath = this.dependencies.assets.resolveAssetPath(input.projectId, input.assetId)
    if (!isAbsolute(resolvedPath)) throw new Error('设计素材路径不是绝对路径')
    const assetPath = realpathSync(resolvedPath)
    return {
      sessionId: input.sessionId,
      path: assetPath,
      name: asset.filename,
      isDirectory: false,
      scope: 'project',
    }
  }

  /** 把当前 Agent 会话持久化拥有的图片导入项目画布，不扫描任何目录。 */
  async importAgentImage(input: ImportAgentImageInput): Promise<DesignWorkspaceSnapshot> {
    const session = requireProjectSession(
      this.dependencies.getSession,
      input.projectId,
      input.sessionId,
    )
    /** 先用持久化消息建立精确归属，再触碰文件系统。 */
    const ownedImage = findOwnedImage(this.dependencies.getMessages(input.sessionId), input.localPath)
    if (!ownedImage) throw new Error('图片不属于指定 Agent 会话')
    /** 项目必须在任何素材 staging 前处于稳定权威状态。 */
    const currentDocument = this.dependencies.store.requireStableAuthoritativeDocument(input.projectId)
    const requestedPath = this.dependencies.resolveAgentImagePath(input.localPath)
    const imagePath = realpathSync(resolve(requestedPath))
    /** 真实叶子必须是普通文件，拒绝目录和其它特殊文件。 */
    if (!lstatSync(imagePath).isFile()) throw new Error('Agent 图片不是普通文件')
    /** 每个允许根都先 canonicalize，符号链接不能越过会话授权边界。 */
    const allowed = this.dependencies.getAllowedRoots(session, input.projectId).some((root) => {
      try {
        return isPathWithinRoot(imagePath, realpathSync(resolve(root)))
      } catch {
        return false
      }
    })
    if (!allowed) throw new Error('图片不在指定 Agent 会话的授权目录内')
    if (!isValidImageBytes(ownedImage.mediaType, readFileSync(imagePath))) {
      throw new Error('Agent 图片内容无效')
    }

    /** 只有本次调用创建的 promotion 批次允许在失败路径回滚。 */
    let importBatch: DesignAssetImportBatch | undefined
    try {
      importBatch = await this.dependencies.assets.importAuthorizedFiles(
        input.projectId,
        [imagePath],
        { kind: 'agent', sourceSessionId: input.sessionId },
      )
      /** 新节点从权威文档当前最大层级之后开始。 */
      const firstZIndex = Math.max(-1, ...currentDocument.nodes.map((node) => node.zIndex)) + 1
      /** 单图导入仍按批次构建，保持素材服务未来返回多素材时的事务完整性。 */
      const nodes = importBatch.map((asset, index) => this.createAssetNode(
        asset,
        input.position,
        firstZIndex + index,
      ))
      const document = importBatch.length === 0
        ? currentDocument
        : this.dependencies.store.mutate(input.projectId, currentDocument.revision, [
            { type: 'upsert-assets', assets: importBatch },
            { type: 'upsert-nodes', nodes },
          ])
      importBatch.commit()
      return { document, writable: true }
    } catch (error) {
      importBatch?.rollback()
      throw error
    }
  }

  /** 为主进程已验证并导入的素材创建固定画布节点。 */
  private createAssetNode(asset: DesignAsset, position: ImportAgentImageInput['position'], zIndex: number): DesignCanvasNode {
    return {
      id: this.createId(),
      kind: 'asset',
      assetId: asset.id,
      position,
      width: 320,
      height: 240,
      zIndex,
    }
  }
}
