import type { CanvasAgentTarget, SkillMeta } from '@proma/shared'
import { runStableDirectoryNative } from '../stable-directory-native-host'
import type {
  StableDirectoryNativeRequest,
  StableDirectoryNativeResult,
  StableDirectoryNativeWriteOutcome,
} from '../stable-directory-native-host'
import type {
  CanvasDocumentStore,
  CanvasTrustedDirectoryCapability,
} from './canvas-document-store'

/** Canvas Agent 职责正文的 UTF-8 字节上限。 */
const MAX_INSTRUCTION_BYTES = 8 * 1024
/** 单个 Canvas Agent 最多启用的 Skill 数量。 */
const MAX_SKILL_NAMES = 16
/** Canvas 与配置使用的稳定 ID 边界。 */
const STABLE_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/
/** Skill 名称允许命名空间分隔符，但不得包含路径或空白。 */
const STABLE_SKILL_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/
/** 渠道与供应商模型 ID 的有限长度，允许模型目录中的斜杠和点号。 */
const MAX_MODEL_SELECTION_ID_LENGTH = 256
/** 配置文件允许的完整字段集合。 */
const CONFIG_KEYS = [
  'schemaVersion',
  'projectId',
  'canvasId',
  'nodeId',
  'revision',
  'instruction',
  'skillNames',
  'channelId',
  'modelId',
  'updatedAt',
] as const
/** 更新 patch 允许的完整字段集合。 */
const PATCH_KEYS = ['instruction', 'skillNames', 'channelId', 'modelId'] as const

/** Canvas Agent 可重复执行的长期配置，不包含任何授权事实。 */
export interface CanvasAgentConfig {
  schemaVersion: 1
  projectId: string
  canvasId: string
  nodeId: string
  revision: number
  instruction: string
  skillNames: string[]
  channelId: string | null
  modelId: string | null
  updatedAt: number
}

/** Canvas Agent 配置允许独立修改的有限字段。 */
export interface CanvasAgentConfigPatch {
  instruction?: string
  skillNames?: string[]
  channelId?: string | null
  modelId?: string | null
}

/** Canvas Agent 配置更新的图与配置双基线输入。 */
export interface UpdateCanvasAgentConfigInput extends CanvasAgentTarget {
  expectedGraphRevision: number
  expectedConfigRevision: number
  patch: CanvasAgentConfigPatch
}

/** Canvas Agent 长期配置的窄业务接口。 */
export interface CanvasAgentConfigStore {
  load: (target: CanvasAgentTarget) => Promise<CanvasAgentConfig>
  update: (input: UpdateCanvasAgentConfigInput) => Promise<CanvasAgentConfig>
}

/** Canvas Agent 配置 Store 的可测试依赖。 */
export interface CanvasAgentConfigStoreDependencies {
  store: Pick<CanvasDocumentStore, 'loadWithDirectoryCapability'>
  /** 与 Canvas 图、候选批次及节点写操作共享的 keyed-exclusive 临界区。 */
  runExclusive: <T>(target: CanvasAgentTarget, effect: () => Promise<T>) => Promise<T>
  runStableDirectoryNative?: (
    request: StableDirectoryNativeRequest,
    authorize: CanvasTrustedDirectoryCapability['authorizeOpenedRoots'],
  ) => Promise<StableDirectoryNativeResult>
  getWorkspaceSkills: (projectId: string) => readonly SkillMeta[]
  assertChannelAvailable: (channelId: string) => void
  assertModelAvailable: (channelId: string, modelId: string) => void
  now?: () => number
}

/** 单次操作绑定的权威图和 agent-configs capability。 */
interface CanvasAgentConfigScope {
  graphRevision: number
  capability: CanvasTrustedDirectoryCapability
}

/** 创建保留底层 scope 或复读失败原因的提交未确认错误。 */
function configCommitUnconfirmed(detail: string, cause: unknown): Error {
  return new Error(`CANVAS_AGENT_CONFIG_COMMIT_UNCONFIRMED: ${detail}`, { cause })
}

/** 判断未知值是否为无未知字段的普通记录。 */
function hasExactKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  /** 实际字段集合。 */
  const actual = Object.keys(value).sort()
  /** 期望字段集合。 */
  const expected = [...keys].sort()
  return actual.length === expected.length && actual.every((key, index) => key === expected[index])
}

/** 校验不可信稳定 ID 并返回收窄后的字符串。 */
function requireStableId(value: unknown, errorCode: string): string {
  if (typeof value !== 'string' || !STABLE_ID_PATTERN.test(value)) throw new Error(errorCode)
  return value
}

/** 校验非负安全整数。 */
function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

/** 校验职责正文的 UTF-8 字节边界。 */
function requireInstruction(value: unknown): string {
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > MAX_INSTRUCTION_BYTES) {
    throw new Error('CANVAS_AGENT_CONFIG_INSTRUCTION_INVALID')
  }
  return value
}

/** 校验 Skill 名称数量、稳定格式与唯一性。 */
function requireSkillNames(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > MAX_SKILL_NAMES) {
    throw new Error('CANVAS_AGENT_CONFIG_SKILLS_INVALID')
  }
  /** 重建后的稳定 Skill 名称。 */
  const skillNames: string[] = []
  /** 用于拒绝重复选择的有限集合。 */
  const seen = new Set<string>()
  for (const item of value) {
    if (typeof item !== 'string' || !STABLE_SKILL_NAME_PATTERN.test(item) || seen.has(item)) {
      throw new Error('CANVAS_AGENT_CONFIG_SKILLS_INVALID')
    }
    seen.add(item)
    skillNames.push(item)
  }
  return skillNames
}

/** 校验可空的渠道或模型有界 ID，不限制供应商合法分隔符。 */
function requireOptionalModelSelectionId(value: unknown): string | null {
  if (value === null) return null
  if (typeof value !== 'string'
    || value.length === 0
    || value.length > MAX_MODEL_SELECTION_ID_LENGTH
    || value.trim() !== value
    || value.includes('\0')) {
    throw new Error('CANVAS_AGENT_CONFIG_MODEL_INVALID')
  }
  return value
}

/** 判断 patch 是否为仅含允许字段的普通记录。 */
function isConfigPatch(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  return Object.keys(value).every((key) => PATCH_KEYS.includes(key as typeof PATCH_KEYS[number]))
}

/** 创建缺失文件对应的只读默认配置。 */
function createDefaultConfig(target: CanvasAgentTarget): CanvasAgentConfig {
  return {
    schemaVersion: 1,
    projectId: target.projectId,
    canvasId: target.canvasId,
    nodeId: target.nodeId,
    revision: 0,
    instruction: '',
    skillNames: [],
    channelId: null,
    modelId: null,
    updatedAt: 0,
  }
}

/** 严格解析配置 JSON，并校验三重身份不漂移。 */
function parseConfig(content: string, target: CanvasAgentTarget): CanvasAgentConfig {
  /** 配置文件中的未知 JSON 值。 */
  let value: unknown
  try {
    value = JSON.parse(content) as unknown
  } catch (error: unknown) {
    throw new Error('CANVAS_AGENT_CONFIG_CORRUPT: invalid JSON', { cause: error })
  }
  if (!hasExactKeys(value, CONFIG_KEYS)) {
    throw new Error('CANVAS_AGENT_CONFIG_CORRUPT')
  }
  /** exact-key 通过后的字段语义解析结果。 */
  let parsed: CanvasAgentConfig
  try {
    if (value.schemaVersion !== 1) throw new Error('CANVAS_AGENT_CONFIG_SCHEMA_INVALID')
    if (!isNonNegativeInteger(value.revision)) throw new Error('CANVAS_AGENT_CONFIG_REVISION_INVALID')
    if (!isNonNegativeInteger(value.updatedAt)) throw new Error('CANVAS_AGENT_CONFIG_TIME_INVALID')
    /** 从磁盘重新验证的项目身份。 */
    const projectId = requireStableId(value.projectId, 'CANVAS_AGENT_CONFIG_PROJECT_ID_INVALID')
    /** 从磁盘重新验证的 Canvas 身份。 */
    const canvasId = requireStableId(value.canvasId, 'CANVAS_AGENT_CONFIG_CANVAS_ID_INVALID')
    /** 从磁盘重新验证的节点身份。 */
    const nodeId = requireStableId(value.nodeId, 'CANVAS_AGENT_CONFIG_NODE_ID_INVALID')
    /** 从磁盘重新构造的职责正文。 */
    const instruction = requireInstruction(value.instruction)
    /** 从磁盘重新构造的 Skill 列表。 */
    const skillNames = requireSkillNames(value.skillNames)
    /** 从磁盘重新构造的渠道选择。 */
    const channelId = requireOptionalModelSelectionId(value.channelId)
    /** 从磁盘重新构造的模型选择。 */
    const modelId = requireOptionalModelSelectionId(value.modelId)
    if (channelId === null && modelId !== null) throw new Error('CANVAS_AGENT_CONFIG_ROUTE_INVALID')
    parsed = {
      schemaVersion: 1,
      projectId,
      canvasId,
      nodeId,
      revision: value.revision,
      instruction,
      skillNames,
      channelId,
      modelId,
      updatedAt: value.updatedAt,
    }
  } catch (error: unknown) {
    throw new Error('CANVAS_AGENT_CONFIG_CORRUPT: invalid fields', { cause: error })
  }
  const { projectId, canvasId, nodeId } = parsed
  if (projectId !== target.projectId || canvasId !== target.canvasId || nodeId !== target.nodeId) {
    throw new Error('CANVAS_AGENT_CONFIG_IDENTITY_CONFLICT')
  }
  return parsed
}

/** 校验公开目标的全部稳定 ID。 */
function requireTarget(target: CanvasAgentTarget): CanvasAgentTarget {
  return {
    projectId: requireStableId(target.projectId, 'CANVAS_AGENT_CONFIG_TARGET_INVALID'),
    canvasId: requireStableId(target.canvasId, 'CANVAS_AGENT_CONFIG_TARGET_INVALID'),
    nodeId: requireStableId(target.nodeId, 'CANVAS_AGENT_CONFIG_TARGET_INVALID'),
  }
}

/** 创建 Canvas Agent 长期配置 Store。 */
export function createCanvasAgentConfigStore(
  dependencies: CanvasAgentConfigStoreDependencies,
): CanvasAgentConfigStore {
  /** Native helper 调用边界。 */
  const runNative = dependencies.runStableDirectoryNative ?? runStableDirectoryNative
  /** 有界时间来源。 */
  const now = dependencies.now ?? Date.now

  /** 每次操作从同一次权威 LOAD 验证图身份并取得配置 capability。 */
  const loadScope = (untrustedTarget: CanvasAgentTarget): CanvasAgentConfigScope => {
    /** 经过稳定 ID 校验的目标。 */
    const target = requireTarget(untrustedTarget)
    /** 本次操作唯一的权威 Canvas LOAD。 */
    const loaded = dependencies.store.loadWithDirectoryCapability({
      projectId: target.projectId,
      canvasId: target.canvasId,
    })
    /** LOAD 返回的权威图文档。 */
    const document = loaded.snapshot.document
    if (document.projectId !== target.projectId || document.canvasId !== target.canvasId) {
      throw new Error('CANVAS_AGENT_TARGET_INVALID')
    }
    /** 目标必须在当前图中唯一且仍为 Agent。 */
    const matchingNodes = document.nodes.filter((node) => node.id === target.nodeId && node.kind === 'agent')
    if (matchingNodes.length !== 1) throw new Error('CANVAS_AGENT_TARGET_INVALID')
    /** Agent 配置只能位于独立受管目录。 */
    const capability = loaded.openSingleChildDirectory('agent-configs')
    capability.assertValid()
    return { graphRevision: document.revision, capability }
  }

  /** 从固定 nodeId/config.json 读取受管配置。 */
  const readConfig = async (
    capability: CanvasTrustedDirectoryCapability,
    target: CanvasAgentTarget,
  ): Promise<CanvasAgentConfig | null> => {
    capability.assertValid()
    /** helper 的固定相对读取结果。 */
    const result = await runNative({
      mode: 'canvas-content-read',
      roots: [capability.rootPath],
      childName: 'agent-configs',
      entryId: target.nodeId,
      fileName: 'config.json',
    }, capability.authorizeOpenedRoots)
    capability.assertValid()
    if (!result.readOutcome) throw new Error('CANVAS_AGENT_CONFIG_PROTOCOL_INVALID')
    if (result.readOutcome.status === 'missing') return null
    if (result.readOutcome.status !== 'ok') {
      throw new Error(`CANVAS_AGENT_CONFIG_CORRUPT: ${result.readOutcome.error}`)
    }
    return parseConfig(result.readOutcome.content, target)
  }

  /** 校验 helper 提交三态并在返回后复验 capability。 */
  const confirmWrite = (
    capability: CanvasTrustedDirectoryCapability,
    outcome: StableDirectoryNativeWriteOutcome | undefined,
  ): Error | null => {
    if (!outcome) throw new Error('CANVAS_AGENT_CONFIG_PROTOCOL_INVALID')
    /** 保留 helper 已报告的提交事实。 */
    const committedOutcome = outcome
    /** helper 返回后的 capability 复验错误，不能覆盖已经发生的提交阶段。 */
    let scopeError: unknown
    try {
      capability.assertValid()
    } catch (error: unknown) {
      scopeError = error
    }
    if (!committedOutcome.commitVisible) {
      throw new Error(
        `CANVAS_AGENT_CONFIG_WRITE_FAILED: ${committedOutcome.error}`,
        scopeError === undefined ? undefined : { cause: scopeError },
      )
    }
    if (committedOutcome.durabilityUncertain) {
      if (scopeError !== undefined) {
        throw configCommitUnconfirmed('write visible but scope revalidation failed', scopeError)
      }
      return new Error(`CANVAS_AGENT_CONFIG_DURABILITY_UNCERTAIN: ${committedOutcome.error}`)
    }
    if (scopeError !== undefined) {
      throw configCommitUnconfirmed('durable write scope revalidation failed', scopeError)
    }
    return null
  }

  /** 保存前验证当前仍安装启用的 Skill 与完整模型选择。 */
  const validateDependencies = (config: CanvasAgentConfig): void => {
    /** 当前项目已安装且启用的 Skill 名称。 */
    const availableSkillNames = new Set(
      dependencies.getWorkspaceSkills(config.projectId)
        .filter((skill) => skill.enabled)
        .map((skill) => skill.name),
    )
    for (const skillName of config.skillNames) {
      if (!availableSkillNames.has(skillName)) {
        throw new Error(`CANVAS_AGENT_CONFIG_SKILL_UNAVAILABLE: ${skillName}`)
      }
    }
    if (config.channelId === null) return
    if (config.modelId === null) dependencies.assertChannelAvailable(config.channelId)
    else dependencies.assertModelAvailable(config.channelId, config.modelId)
  }

  return {
    load: async (untrustedTarget) => {
      /** 经过稳定 ID 校验的目标。 */
      const target = requireTarget(untrustedTarget)
      /** 与本次权威图绑定的配置 scope。 */
      const scope = loadScope(target)
      return (await readConfig(scope.capability, target)) ?? createDefaultConfig(target)
    },

    update: async (input) => {
      /** 经过稳定 ID 校验的目标。 */
      const target = requireTarget(input)
      if (!isNonNegativeInteger(input.expectedGraphRevision)
        || !isNonNegativeInteger(input.expectedConfigRevision)
        || !isConfigPatch(input.patch)) {
        throw new Error('CANVAS_AGENT_CONFIG_UPDATE_INVALID')
      }
      return dependencies.runExclusive(target, async () => {
        /** 与本次权威图绑定的配置 scope。 */
        const scope = loadScope(target)
        if (scope.graphRevision !== input.expectedGraphRevision) {
          throw new Error('CANVAS_AGENT_GRAPH_REVISION_CONFLICT')
        }
        /** 缺失文件按 revision 0 默认值参与首次 CAS 创建。 */
        const current = (await readConfig(scope.capability, target)) ?? createDefaultConfig(target)
        if (current.revision !== input.expectedConfigRevision) {
          throw new Error('CANVAS_AGENT_CONFIG_REVISION_CONFLICT')
        }
        if (current.revision >= Number.MAX_SAFE_INTEGER) {
          throw new Error('CANVAS_AGENT_CONFIG_REVISION_OVERFLOW')
        }
        /** patch 是否显式携带 channelId。 */
        const hasChannelId = Object.prototype.hasOwnProperty.call(input.patch, 'channelId')
        /** patch 是否显式携带 modelId。 */
        const hasModelId = Object.prototype.hasOwnProperty.call(input.patch, 'modelId')
        /** 合并后的渠道选择。 */
        const channelId = hasChannelId
          ? requireOptionalModelSelectionId(input.patch.channelId)
          : current.channelId
        if (hasChannelId && channelId !== current.channelId && channelId !== null && !hasModelId) {
          throw new Error('CANVAS_AGENT_CONFIG_MODEL_PATCH_REQUIRED')
        }
        /** 清空渠道强制清空模型，否则按显式 patch 或当前值合并。 */
        const modelId = channelId === null
          ? null
          : hasModelId
            ? requireOptionalModelSelectionId(input.patch.modelId)
            : current.modelId
        /** 合并并重新构造的下一版配置。 */
        const next: CanvasAgentConfig = {
          ...current,
          revision: current.revision + 1,
          instruction: Object.prototype.hasOwnProperty.call(input.patch, 'instruction')
            ? requireInstruction(input.patch.instruction)
            : current.instruction,
          skillNames: Object.prototype.hasOwnProperty.call(input.patch, 'skillNames')
            ? requireSkillNames(input.patch.skillNames)
            : [...current.skillNames],
          channelId,
          modelId,
          updatedAt: now(),
        }
        if (!isNonNegativeInteger(next.updatedAt)) throw new Error('CANVAS_AGENT_CONFIG_TIME_INVALID')
        validateDependencies(next)
        /** 固定字段顺序的待提交 JSON 正文。 */
        const serialized = JSON.stringify(next, null, 2)
        /** helper 原子写结果。 */
        const result = await runNative({
          mode: 'canvas-content-write',
          roots: [scope.capability.rootPath],
          childName: 'agent-configs',
          entryId: target.nodeId,
          fileName: 'config.json',
          content: serialized,
        }, scope.capability.authorizeOpenedRoots)
        /** durability 不确定时先复读对账，一致后仍按不确定阶段返回错误。 */
        const durabilityError = confirmWrite(scope.capability, result.writeOutcome)
        if (durabilityError) {
          try {
            const committed = await readConfig(scope.capability, target)
            if (committed === null || JSON.stringify(committed) !== JSON.stringify(next)) {
              throw new Error('committed config does not match requested config')
            }
          } catch (error: unknown) {
            throw configCommitUnconfirmed('write visible but config verification failed', error)
          }
          throw durabilityError
        }
        /** 已确认耐久的写仍须从同一 capability 复读并严格比较完整配置。 */
        try {
          const reread = await readConfig(scope.capability, target)
          if (reread === null || JSON.stringify(reread) !== JSON.stringify(next)) {
            throw new Error('committed config does not match requested config')
          }
          return reread
        } catch (error: unknown) {
          throw configCommitUnconfirmed('durable write content verification failed', error)
        }
      })
    },
  }
}
