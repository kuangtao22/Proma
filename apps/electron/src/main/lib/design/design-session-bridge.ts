import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
} from 'node:fs'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import type {
  AgentMessage,
  AgentSessionMeta,
  SDKMessage,
  SDKAssistantMessage,
  SDKToolResultBlock,
  SDKToolUseBlock,
  SDKUserMessage,
  DesignAsset,
  DesignCanvasNode,
  DesignWorkspaceSnapshot,
  ImportAgentImageInput,
  PrepareDesignAssetForSessionInput,
  PreparedDesignAssetMention,
} from '@proma/shared'
import type {
  DesignAssetImportBatch,
  DesignAssetService,
  DesignAuthorizedImageSource,
} from './design-asset-service'
import type { DesignStore } from './design-store'

/** 会话桥只使用素材服务的受控导入与路径解析能力。 */
interface DesignSessionBridgeAssetService extends Pick<
  DesignAssetService,
  'resolveAssetPath' | 'importAuthorizedImageSources'
> {}

/** 会话桥只使用权威文档读取与 revision mutation。 */
interface DesignSessionBridgeStore extends Pick<
  DesignStore,
  'requireStableAuthoritativeDocument' | 'mutate'
> {}

/** 与 Design Asset Service 保持一致的单图片读取上限。 */
const MAX_AGENT_IMAGE_BYTES = 64 * 1024 * 1024

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

/** 从已打开的稳定 fd 读取，并复核读取前后文件身份与大小未变化。 */
function readStableAgentImage(descriptor: number, expected: { dev: number; ino: number; size: number }): Buffer {
  const before = fstatSync(descriptor)
  if (!before.isFile()
    || before.dev !== expected.dev
    || before.ino !== expected.ino
    || before.size !== expected.size
    || before.size > MAX_AGENT_IMAGE_BYTES) {
    throw new Error('Agent 图片文件身份已变化')
  }
  const bytes = readFileSync(descriptor)
  const after = fstatSync(descriptor)
  if (after.dev !== before.dev
    || after.ino !== before.ino
    || after.size !== before.size
    || bytes.byteLength !== before.size) {
    throw new Error('Agent 图片读取期间已变化')
  }
  return bytes
}

/** 从指定会话持久化消息中寻找精确 localPath 的图片归属证据。 */
function findOwnedImage(messages: Array<AgentMessage | SDKMessage>, localPath: string): { mediaType: string } | undefined {
  /** 新 SDK JSONL 仍需以同一序列中的 Nano tool_use 复核附件字段。 */
  const sdkToolNames = new Map<string, string>()
  for (const message of messages) {
    if (!('type' in message)) {
      for (const event of message.events ?? []) {
        if (event.type !== 'tool_result' || event.toolName !== 'mcp__nano_banana__generate_image') continue
        /** 同字符串只在当前 session 的持久化事件中出现才构成所有权。 */
        const image = event.imageAttachments?.find((candidate) => candidate.localPath === localPath)
        if (image) return { mediaType: image.mediaType }
      }
      continue
    }
    if (message.type === 'assistant') {
      const content = (message as SDKAssistantMessage).message?.content
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block.type === 'tool_use') {
            const toolUse = block as SDKToolUseBlock
            sdkToolNames.set(toolUse.id, toolUse.name)
          }
        }
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
      if (sdkToolNames.get(result.tool_use_id) !== 'mcp__nano_banana__generate_image') continue
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
    const requestedPath = resolve(this.dependencies.resolveAgentImagePath(input.localPath))
    /** 先 canonicalize 授权根；之后用稳定 fd 的身份反向证明打开对象属于其中。 */
    const allowedRoots = this.dependencies.getAllowedRoots(session, input.projectId).flatMap((root) => {
      try {
        return [realpathSync(resolve(root))]
      } catch {
        return []
      }
    })
    let descriptor: number | undefined
    let descriptorHandedOff = false
    /** 只有本次调用创建的 promotion 批次允许在失败路径回滚。 */
    let importBatch: DesignAssetImportBatch | undefined
    try {
      /** O_NOFOLLOW 拒绝叶子链接；fd 一旦建立，后续祖先或叶子置换不会改变读取对象。 */
      descriptor = openSync(requestedPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
      const openedStat = fstatSync(descriptor)
      if (!openedStat.isFile()) throw new Error('Agent 图片不是普通文件')
      if (openedStat.size > MAX_AGENT_IMAGE_BYTES) throw new Error('图片不能超过 64 MiB')
      /** 打开后重新解析当前路径，并以 dev/ino 证明 canonical 路径与稳定 fd 是同一文件。 */
      const imagePath = realpathSync(requestedPath)
      const pathStat = lstatSync(imagePath)
      if (!pathStat.isFile()
        || pathStat.isSymbolicLink()
        || pathStat.dev !== openedStat.dev
        || pathStat.ino !== openedStat.ino
        || pathStat.size !== openedStat.size) {
        throw new Error('Agent 图片授权校验期间已变化')
      }
      if (!allowedRoots.some((root) => isPathWithinRoot(imagePath, root))) {
        throw new Error('图片不在指定 Agent 会话的授权目录内')
      }
      let closed = false
      const authorizedSource: DesignAuthorizedImageSource = {
        sourcePath: imagePath,
        byteSize: openedStat.size,
        readBytes: () => {
          if (closed || descriptor === undefined) throw new Error('Agent 图片稳定句柄已关闭')
          return readStableAgentImage(descriptor, openedStat)
        },
        close: () => {
          if (closed || descriptor === undefined) return
          closed = true
          closeSync(descriptor)
        },
      }
      descriptorHandedOff = true
      importBatch = await this.dependencies.assets.importAuthorizedImageSources(
        input.projectId,
        [authorizedSource],
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
    } finally {
      if (!descriptorHandedOff && descriptor !== undefined) closeSync(descriptor)
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
