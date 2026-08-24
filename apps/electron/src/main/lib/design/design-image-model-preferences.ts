import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import type {
  DesignImageModelSelection,
  DesignImageModelSelectionChangeEvent,
  UpdateDesignImageModelSelectionInput,
} from '@proma/shared'
import { writeJsonFileAtomic } from '../safe-file'
import type { ImageGenerationModelCatalog } from '../image-generation-model-catalog'
import type { DesignPathResolver } from './design-paths'

/** 项目生图模型偏好文件的当前 schema 版本。 */
const DESIGN_PROJECT_PREFERENCES_SCHEMA_VERSION = 1

/** 项目级生图模型偏好的最小持久化结构。 */
interface DesignProjectPreferencesFile {
  schemaVersion: 1
  imageModelProfileId?: string
  updatedAt: number
}

/** 项目生图模型偏好服务所需的窄依赖。 */
export interface DesignImageModelPreferencesDependencies {
  pathResolver: Pick<DesignPathResolver, 'resolve'>
  imageModels: Pick<ImageGenerationModelCatalog, 'listOptions'>
  now?: () => number
}

/** 持久化并解析每个 Design 项目独立的生图模型选择。 */
export class DesignImageModelPreferences {
  /** 成功写入偏好后收到通知的进程内监听器。 */
  private readonly listeners = new Set<(event: DesignImageModelSelectionChangeEvent) => void>()

  constructor(private readonly dependencies: DesignImageModelPreferencesDependencies) {}

  /**
   * 读取项目当前选择，并同时返回 Catalog 的全部公开选项。
   * @param projectId 已授权项目的稳定 ID。
   * @returns 不包含路径或凭据的项目模型选择。
   */
  getSelection(projectId: string): DesignImageModelSelection {
    /** 路径只能由受信任项目解析器生成。 */
    const preferencesPath = this.dependencies.pathResolver.resolve(projectId).preferencesPath
    /** Catalog 已清洗且不含凭据的全部选项副本。 */
    const options = this.dependencies.imageModels.listOptions().map((option) => ({ ...option }))
    if (!existsSync(preferencesPath)) {
      /** 首次使用只在内存选择第一个可用项，不制造隐式磁盘写入。 */
      const defaultOption = options.find((option) => option.available)
      return {
        projectId,
        options,
        ...(defaultOption ? { selectedProfileId: defaultOption.profileId } : {}),
      }
    }

    /** 已存在文件必须从主文件严格解析，禁止隐式恢复候选。 */
    const preferences = readPreferencesFile(preferencesPath)
    if (preferences.imageModelProfileId === undefined) return { projectId, options }
    /** 只有仍存在且当前 available 的选项可以作为有效选择。 */
    const selectedOption = options.find((option) => (
      option.profileId === preferences.imageModelProfileId && option.available
    ))
    return selectedOption
      ? { projectId, options, selectedProfileId: selectedOption.profileId }
      : { projectId, options, invalidSelectedProfileId: preferences.imageModelProfileId }
  }

  /**
   * 验证并原子保存项目选择。
   * @param input 项目 ID 与当前可用的稳定 profile ID。
   * @returns 保存后的公开选择状态。
   */
  setSelection(input: UpdateDesignImageModelSelectionInput): DesignImageModelSelection {
    /** 项目偏好只写入该项目受信任的缓存路径。 */
    const paths = this.dependencies.pathResolver.resolve(input.projectId)
    if (existsSync(paths.preferencesPath)) {
      /** 覆盖前先验证当前主文件，损坏事实必须由用户显式处理。 */
      readPreferencesFile(paths.preferencesPath)
    }
    /** 单次 Catalog 快照同时用于可用性校验和成功返回，避免提交后再次读取配置或凭据。 */
    const options = this.dependencies.imageModels.listOptions().map((option) => ({ ...option }))
    /** Renderer 只能选择当前目录中存在且可用的公开 profile。 */
    const selectedOption = options.find((option) => option.profileId === input.imageModelProfileId)
    if (!selectedOption) throw new Error(`生图模型不存在: ${input.imageModelProfileId}`)
    if (!selectedOption.available) {
      /** 保持目录服务既有的稳定业务错误，供 IPC 安全透传。 */
      const reason = selectedOption.unavailableReason ?? '生图模型不可用'
      if (reason === '模型已停用') throw new Error(`生图模型已停用: ${input.imageModelProfileId}`)
      throw new Error(`${reason}: ${input.imageModelProfileId}`)
    }
    /** 返回值在持久化前完整构造，提交后不再执行可能失败的配置读取。 */
    const selection: DesignImageModelSelection = {
      projectId: input.projectId,
      options,
      selectedProfileId: selectedOption.profileId,
    }
    /** 写入前确认时间戳满足持久化 schema，避免先落盘再在回读时报错。 */
    const updatedAt = (this.dependencies.now ?? Date.now)()
    if (!isFiniteNonNegativeNumber(updatedAt)) {
      throw new Error('Design 项目生图模型偏好 updatedAt 必须是有限非负数')
    }
    mkdirSync(paths.cacheRoot, { recursive: true })
    /** 持久化内容固定为公开 ID、版本和时间戳，不包含模型详情或凭据。 */
    const preferences: DesignProjectPreferencesFile = {
      schemaVersion: DESIGN_PROJECT_PREFERENCES_SCHEMA_VERSION,
      imageModelProfileId: input.imageModelProfileId,
      updatedAt,
    }
    writeJsonFileAtomic(paths.preferencesPath, preferences)
    /** 写入成功后才通知窗口，失败路径不会产生伪变化事件。 */
    const event: DesignImageModelSelectionChangeEvent = { projectId: input.projectId }
    for (const listener of this.listeners) {
      try {
        listener(event)
      } catch (error) {
        console.error('[DesignImageModelPreferences] 生图模型选择变化监听器执行失败:', error)
      }
    }
    return selection
  }

  /**
   * 订阅成功的项目选择变化。
   * @param listener 只接收项目 ID 的业务监听器。
   * @returns 使用同一监听器引用解除订阅的函数。
   */
  onChanged(listener: (event: DesignImageModelSelectionChangeEvent) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
}

/** 直接读取并严格解析偏好主文件。 */
function readPreferencesFile(preferencesPath: string): DesignProjectPreferencesFile {
  /** 主文件原始文本，读取失败应直接向调用方传播。 */
  const raw = readFileSync(preferencesPath, 'utf8')
  /** JSON 解析后的未知值，随后进入精确 schema 校验。 */
  let parsed: unknown
  try {
    parsed = JSON.parse(raw) as unknown
  } catch (error) {
    throw new Error('Design 项目生图模型偏好 JSON 损坏', { cause: error })
  }
  return parsePreferencesFile(parsed)
}

/** 严格解析项目偏好根结构，拒绝未知字段与未知版本。 */
function parsePreferencesFile(value: unknown): DesignProjectPreferencesFile {
  if (!isPlainObject(value)) {
    throw new Error('Design 项目生图模型偏好格式无效：根节点必须是普通对象')
  }
  /** 可选 profile ID 之外，版本和更新时间必须始终存在。 */
  const keys = Object.keys(value)
  const allowedKeys = new Set(['schemaVersion', 'imageModelProfileId', 'updatedAt'])
  if (!keys.includes('schemaVersion')
    || !keys.includes('updatedAt')
    || keys.some((key) => !allowedKeys.has(key))) {
    throw new Error('Design 项目生图模型偏好字段不完整或包含未知字段')
  }
  if (value.schemaVersion !== DESIGN_PROJECT_PREFERENCES_SCHEMA_VERSION) {
    throw new Error(`不支持的 Design 项目生图模型偏好 schemaVersion: ${String(value.schemaVersion)}`)
  }
  if (value.imageModelProfileId !== undefined && !isStableNonEmptyId(value.imageModelProfileId)) {
    throw new Error('Design 项目生图模型偏好 imageModelProfileId 必须是稳定非空 ID')
  }
  if (!isFiniteNonNegativeNumber(value.updatedAt)) {
    throw new Error('Design 项目生图模型偏好 updatedAt 必须是有限非负数')
  }
  return {
    schemaVersion: DESIGN_PROJECT_PREFERENCES_SCHEMA_VERSION,
    ...(value.imageModelProfileId === undefined ? {} : { imageModelProfileId: value.imageModelProfileId }),
    updatedAt: value.updatedAt,
  }
}

/** 判断值是否为无首尾空白的稳定非空 ID。 */
function isStableNonEmptyId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value === value.trim()
}

/** 判断值是否为有限非负数字。 */
function isFiniteNonNegativeNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

/** 判断未知值是否为可安全枚举字段的普通对象。 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  /** 只接受标准对象或无原型对象，拒绝类实例。 */
  const prototype = Object.getPrototypeOf(value) as unknown
  return prototype === Object.prototype || prototype === null
}
