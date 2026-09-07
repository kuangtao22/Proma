import { join } from 'node:path'
import {
  parseCanvasMediaCandidate,
  parseCanvasMediaModuleConfig,
  parseCanvasNodeContentMeta,
} from '@proma/shared'
import type { CanvasMediaTarget, CanvasNodeContentMeta, MediaRunSourceReference } from '@proma/shared'
import { runStableDirectoryNative } from '../stable-directory-native-host'
import type {
  StableDirectoryAuthorization,
  StableDirectoryNativeRequest,
  StableDirectoryNativeResult,
} from '../stable-directory-native-host'
import { acquireMediaFileLock } from '../media/media-file-lock'
import type { CanvasDocumentStore, CanvasTrustedDirectoryCapability } from './canvas-document-store'
import type {
  CanvasMediaModuleState,
  CanvasMediaModuleStore,
  CanvasMediaOperation,
} from './canvas-media-service'

const MAX_MEDIA_STATE_LENGTH = 2 * 1024 * 1024
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/

/** Store 使用受管 Canvas 内容目录和 native 原子文件协议。 */
export interface CanvasMediaStoreDependencies {
  store: Pick<CanvasDocumentStore, 'loadWithDirectoryCapability'>
  runStableDirectoryNative?: (
    request: StableDirectoryNativeRequest,
    authorizeOpenedRoots: StableDirectoryAuthorization,
  ) => Promise<StableDirectoryNativeResult>
  now?: () => number
  /** 两个文件完成提交后通知 Host 广播模块 revision。 */
  onChanged?: (target: CanvasMediaTarget, state: CanvasMediaModuleState) => void | Promise<void>
}

/** 判断磁盘对象字段集合完全匹配。 */
function hasExactKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const actual = Object.keys(value).sort()
  const expected = [...keys].sort()
  return actual.length === expected.length && actual.every((key, index) => key === expected[index])
}

/** 运行来源只接受已发布 profile 或项目草稿 revision。 */
function parseOperationSource(value: unknown): MediaRunSourceReference {
  if (hasExactKeys(value, ['kind', 'profileId', 'profileRevision']) && value.kind === 'profile-version'
    && typeof value.profileId === 'string' && ID_PATTERN.test(value.profileId)
    && Number.isSafeInteger(value.profileRevision) && Number(value.profileRevision) >= 1) {
    return { kind: 'profile-version', profileId: value.profileId, profileRevision: Number(value.profileRevision) }
  }
  if (hasExactKeys(value, ['kind', 'workflowId', 'workflowRevision', 'connectionId', 'mediaKind'])
    && value.kind === 'project-draft-revision' && typeof value.workflowId === 'string' && ID_PATTERN.test(value.workflowId)
    && typeof value.connectionId === 'string' && ID_PATTERN.test(value.connectionId)
    && Number.isSafeInteger(value.workflowRevision) && Number(value.workflowRevision) >= 1
    && (value.mediaKind === 'image' || value.mediaKind === 'audio' || value.mediaKind === 'video')) {
    return { kind: 'project-draft-revision', workflowId: value.workflowId,
      workflowRevision: Number(value.workflowRevision), connectionId: value.connectionId, mediaKind: value.mediaKind }
  }
  throw new Error('CANVAS_MEDIA_STATE_INVALID')
}

/** 严格解析运行登记，配置快照与候选使用同一输出合同解析器。 */
function parseOperation(value: unknown): CanvasMediaOperation {
  const legacy = !!value && typeof value === 'object' && !Array.isArray(value) && !Object.hasOwn(value, 'sourceRef')
  const hasProfile = !!value && typeof value === 'object' && !Array.isArray(value) && Object.hasOwn(value, 'profile')
  if (!hasExactKeys(value, legacy
    ? ['operationId', 'runId', 'sourceConfigRevision', 'profile', 'outputs', 'createdAt']
    : ['operationId', 'runId', 'sourceConfigRevision', 'sourceRef', ...(hasProfile ? ['profile'] : []), 'outputs', 'createdAt'])
    || typeof value.operationId !== 'string' || !ID_PATTERN.test(value.operationId)
    || typeof value.runId !== 'string' || !ID_PATTERN.test(value.runId)
    || typeof value.sourceConfigRevision !== 'number' || !Number.isSafeInteger(value.sourceConfigRevision) || value.sourceConfigRevision < 0
    || typeof value.createdAt !== 'number' || !Number.isSafeInteger(value.createdAt) || value.createdAt < 0) {
    throw new Error('CANVAS_MEDIA_STATE_INVALID')
  }
  if (!Array.isArray(value.outputs)) throw new Error('CANVAS_MEDIA_STATE_INVALID')
  /** selector 私有字段拆出后，复用共享配置 parser 校验公开输出合同。 */
  const selectors = value.outputs.map((output) => {
    if (!output || typeof output !== 'object' || Array.isArray(output)) throw new Error('CANVAS_MEDIA_STATE_INVALID')
    const record = output as Record<string, unknown>
    const keys = ['key', 'mediaKind', 'role', 'order', 'nodeId', 'outputIndex', ...(record.bundle === undefined ? [] : ['bundle'])]
    if (!hasExactKeys(record, keys)
      || typeof record.nodeId !== 'string' || !ID_PATTERN.test(record.nodeId)
      || typeof record.outputIndex !== 'number' || !Number.isSafeInteger(record.outputIndex) || record.outputIndex < 0) {
      throw new Error('CANVAS_MEDIA_STATE_INVALID')
    }
    return {
      nodeId: record.nodeId,
      outputIndex: record.outputIndex,
      binding: {
        key: record.key,
        mediaKind: record.mediaKind,
        role: record.role,
        order: record.order,
        ...(record.bundle === undefined ? {} : { bundle: record.bundle }),
      },
    }
  })
  const primaryKind = selectors.find((selector) => (
    (selector.binding as { role?: unknown }).role === 'primary'
  ))?.binding.mediaKind
  const validation = parseCanvasMediaModuleConfig({
    schemaVersion: 1,
    contentId: 'operation-validation',
    mediaKind: primaryKind,
    revision: value.sourceConfigRevision,
    createdAt: value.createdAt,
    updatedAt: value.createdAt,
    profile: hasProfile ? value.profile : null,
    inputs: [],
    outputs: selectors.map((selector) => selector.binding),
    adoptedOutputs: [],
  })
  const sourceRef = legacy
    ? { kind: 'profile-version' as const, ...(() => {
        if (!validation.profile) throw new Error('CANVAS_MEDIA_STATE_INVALID')
        return validation.profile
      })() }
    : parseOperationSource(value.sourceRef)
  if ((sourceRef.kind === 'profile-version' && (!validation.profile
      || validation.profile.profileId !== sourceRef.profileId || validation.profile.profileRevision !== sourceRef.profileRevision))
    || (sourceRef.kind === 'project-draft-revision' && validation.profile)) throw new Error('CANVAS_MEDIA_STATE_INVALID')
  return {
    operationId: value.operationId,
    runId: value.runId,
    sourceConfigRevision: value.sourceConfigRevision,
    sourceRef,
    ...(validation.profile ? { profile: validation.profile } : {}),
    outputs: validation.outputs.map((binding, index) => ({
      ...binding,
      nodeId: selectors[index]!.nodeId,
      outputIndex: selectors[index]!.outputIndex,
    })),
    createdAt: value.createdAt,
  }
}

/** 严格解析模块内部状态并验证唯一 operation/run/candidate。 */
export function parseCanvasMediaModuleState(value: unknown, target: CanvasMediaTarget): CanvasMediaModuleState {
  if (!hasExactKeys(value, [
    'schemaVersion', 'revision', 'config', 'operations', 'candidates', 'pendingAdoptionProjection',
  ])
    || value.schemaVersion !== 1
    || typeof value.revision !== 'number' || !Number.isSafeInteger(value.revision) || value.revision < 0
    || !Array.isArray(value.operations) || value.operations.length > 256
    || !Array.isArray(value.candidates) || value.candidates.length > 256) throw new Error('CANVAS_MEDIA_STATE_INVALID')
  const config = parseCanvasMediaModuleConfig(value.config)
  const operations = value.operations.map(parseOperation)
  const candidates = value.candidates.map(parseCanvasMediaCandidate)
  const pendingAdoptionProjection = value.pendingAdoptionProjection === null
    ? null
    : parsePendingAdoptionProjection(value.pendingAdoptionProjection, config)
  if (config.contentId !== target.mediaModuleId || config.mediaKind !== target.mediaKind
    || new Set(operations.map((operation) => operation.operationId)).size !== operations.length
    || new Set(operations.map((operation) => operation.runId)).size !== operations.length
    || new Set(candidates.map((candidate) => candidate.id)).size !== candidates.length
    || new Set(candidates.map((candidate) => candidate.runId)).size !== candidates.length) {
    throw new Error('CANVAS_MEDIA_STATE_INVALID')
  }
  return { schemaVersion: 1, revision: value.revision, config, operations, candidates, pendingAdoptionProjection }
}

/** 严格解析采用传播 marker，并复核它只引用当前正式输出。 */
function parsePendingAdoptionProjection(
  value: unknown,
  config: ReturnType<typeof parseCanvasMediaModuleConfig>,
): CanvasMediaModuleState['pendingAdoptionProjection'] {
  if (!hasExactKeys(value, [
    'configRevision', 'candidateId', 'runId', 'selectedKeys', 'outputs', 'adoptedAt',
  ])
    || typeof value.configRevision !== 'number' || !Number.isSafeInteger(value.configRevision) || value.configRevision < 1
    || value.configRevision !== config.revision
    || typeof value.candidateId !== 'string' || !ID_PATTERN.test(value.candidateId)
    || typeof value.runId !== 'string' || !ID_PATTERN.test(value.runId)
    || !Array.isArray(value.selectedKeys) || value.selectedKeys.length < 1
    || typeof value.adoptedAt !== 'number' || !Number.isSafeInteger(value.adoptedAt) || value.adoptedAt < 0
    || !Array.isArray(value.outputs)) throw new Error('CANVAS_MEDIA_STATE_INVALID')
  const selectedKeys = value.selectedKeys as unknown[]
  if (!selectedKeys.every((key) => typeof key === 'string' && ID_PATTERN.test(key))
    || new Set(selectedKeys).size !== selectedKeys.length) throw new Error('CANVAS_MEDIA_STATE_INVALID')
  const validation = parseCanvasMediaModuleConfig({ ...config, adoptedOutputs: value.outputs })
  if (validation.adoptedOutputs.length !== selectedKeys.length
    || validation.adoptedOutputs.some((output) => !selectedKeys.includes(output.key)
      || output.candidateId !== value.candidateId || output.runId !== value.runId)) {
    throw new Error('CANVAS_MEDIA_STATE_INVALID')
  }
  return {
    configRevision: value.configRevision,
    candidateId: value.candidateId,
    runId: value.runId,
    selectedKeys: [...selectedKeys] as string[],
    outputs: validation.adoptedOutputs,
    adoptedAt: value.adoptedAt,
  }
}

/** 创建尚未选择预设的新音视频模块状态。 */
export function createInitialCanvasMediaModuleState(
  target: Pick<CanvasMediaTarget, 'mediaModuleId' | 'mediaKind'>,
  createdAt: number,
): CanvasMediaModuleState {
  if (!Number.isSafeInteger(createdAt) || createdAt < 0) throw new Error('CANVAS_MEDIA_TIME_INVALID')
  return {
    schemaVersion: 1,
    revision: 0,
    config: {
      schemaVersion: 1,
      contentId: target.mediaModuleId,
      mediaKind: target.mediaKind,
      revision: 0,
      createdAt,
      updatedAt: createdAt,
      profile: null,
      inputs: [],
      outputs: [],
      adoptedOutputs: [],
    },
    operations: [],
    candidates: [],
    pendingAdoptionProjection: null,
  }
}

/** 创建跨进程 CAS 的受管 Canvas 媒体 Store。 */
export function createCanvasMediaStore(dependencies: CanvasMediaStoreDependencies): CanvasMediaModuleStore {
  const runNative = dependencies.runStableDirectoryNative ?? runStableDirectoryNative

  /** 加载并验证图节点归属，公开 mutation 无法借此替换正式输出。 */
  const loadScope = (target: CanvasMediaTarget): CanvasTrustedDirectoryCapability => {
    const loaded = dependencies.store.loadWithDirectoryCapability(target)
    const node = loaded.snapshot.document.nodes.find((candidate) => candidate.id === target.nodeId)
    if (!node || (node.kind !== 'audio' && node.kind !== 'video')
      || node.kind !== target.mediaKind || node.mediaModuleId !== target.mediaModuleId) {
      throw new Error('CANVAS_MEDIA_TARGET_INVALID')
    }
    const capability = loaded.openSingleChildDirectory('nodes')
    capability.assertValid()
    return capability
  }

  /** 通过无路径 native helper 读取固定模块文件。 */
  const read = async (capability: CanvasTrustedDirectoryCapability, target: CanvasMediaTarget, fileName: 'config.json' | 'meta.json'): Promise<string> => {
    capability.assertValid()
    const result = await runNative({
      mode: 'canvas-content-read', roots: [capability.rootPath], childName: 'nodes',
      entryId: target.mediaModuleId, fileName,
    }, capability.authorizeOpenedRoots)
    capability.assertValid()
    if (!result.readOutcome || result.readOutcome.status !== 'ok'
      || result.readOutcome.content.length > MAX_MEDIA_STATE_LENGTH) throw new Error('CANVAS_MEDIA_STATE_INVALID')
    return result.readOutcome.content
  }

  /** 通过 native helper 原子替换固定模块文件。 */
  const write = async (capability: CanvasTrustedDirectoryCapability, target: CanvasMediaTarget, fileName: 'config.json' | 'meta.json', content: string): Promise<void> => {
    const result = await runNative({
      mode: 'canvas-content-write', roots: [capability.rootPath], childName: 'nodes',
      entryId: target.mediaModuleId, fileName, content, maxEntries: 512,
    }, capability.authorizeOpenedRoots)
    if (!result.writeOutcome?.commitVisible) throw new Error('CANVAS_MEDIA_SAVE_FAILED')
    capability.assertValid()
    if (result.writeOutcome.durabilityUncertain) throw new Error('CANVAS_MEDIA_SAVE_UNCERTAIN')
  }

  /** 变化通知是提交后的旁路副作用，失败不得把已提交事实伪装为保存失败。 */
  const notifyChanged = async (target: CanvasMediaTarget, state: CanvasMediaModuleState): Promise<void> => {
    try {
      await dependencies.onChanged?.(structuredClone(target), structuredClone(state))
    } catch (error) {
      console.error('[CanvasMediaStore] 模块变化通知失败，磁盘提交已完成', error)
    }
  }

  /** 同一 capability 下读取 state 和公共 meta 并复核 revision。 */
  const loadOwned = async (capability: CanvasTrustedDirectoryCapability, target: CanvasMediaTarget): Promise<CanvasMediaModuleState> => {
    const state = parseCanvasMediaModuleState(JSON.parse(await read(capability, target, 'config.json')) as unknown, target)
    const meta = parseCanvasNodeContentMeta(JSON.parse(await read(capability, target, 'meta.json')) as unknown)
    if (meta.kind !== target.mediaKind || meta.contentId !== target.mediaModuleId
      || meta.createdAt !== state.config.createdAt) {
      throw new Error('CANVAS_MEDIA_IDENTITY_CONFLICT')
    }
    if (meta.revision === state.revision - 1 && meta.updatedAt <= state.config.updatedAt) {
      /** config 已原子提交而 meta 尚未提交时，以严格解析后的唯一业务事实修复提交标记。 */
      const repaired: CanvasNodeContentMeta = {
        schemaVersion: 1,
        kind: target.mediaKind,
        contentId: target.mediaModuleId,
        revision: state.revision,
        createdAt: state.config.createdAt,
        updatedAt: state.config.updatedAt,
      }
      await write(capability, target, 'meta.json', `${JSON.stringify(repaired, null, 2)}\n`)
      await notifyChanged(target, state)
    } else if (meta.revision !== state.revision || meta.updatedAt !== state.config.updatedAt) {
      throw new Error('CANVAS_MEDIA_IDENTITY_CONFLICT')
    }
    return state
  }

  return {
    load: async (target) => {
      const capability = loadScope(target)
      const release = acquireMediaFileLock(join(capability.path, target.mediaModuleId, '.canvas-media.lock'))
      try {
        return await loadOwned(capability, target)
      } finally {
        release()
      }
    },
    compareAndSwap: async (target, expectedRevision, requested) => {
      const capability = loadScope(target)
      /** 锁文件位于已验证模块目录，跨窗口和进程共享同一 CAS owner。 */
      const release = acquireMediaFileLock(join(capability.path, target.mediaModuleId, '.canvas-media.lock'))
      try {
        capability.assertValid()
        const current = await loadOwned(capability, target)
        if (current.revision !== expectedRevision) throw new Error('CANVAS_MEDIA_STATE_CONFLICT')
        const next = parseCanvasMediaModuleState(requested, target)
        if (next.revision !== current.revision + 1 || next.config.createdAt !== current.config.createdAt
          || next.config.updatedAt < current.config.updatedAt) throw new Error('CANVAS_MEDIA_STATE_INVALID')
        await write(capability, target, 'config.json', `${JSON.stringify(next, null, 2)}\n`)
        const meta: CanvasNodeContentMeta = {
          schemaVersion: 1,
          kind: target.mediaKind,
          contentId: target.mediaModuleId,
          revision: next.revision,
          createdAt: next.config.createdAt,
          updatedAt: next.config.updatedAt,
        }
        await write(capability, target, 'meta.json', `${JSON.stringify(meta, null, 2)}\n`)
        await notifyChanged(target, next)
        return next
      } finally {
        release()
      }
    },
  }
}
