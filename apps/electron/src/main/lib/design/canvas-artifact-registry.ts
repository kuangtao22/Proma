import type {
  CanvasContentKind,
  CanvasImageArtifactVersion,
  CanvasImageModuleConfig,
  CanvasImageTarget,
  DesignAsset,
  DesignJobRecord,
  ExportCanvasImageArtifactInput,
  SaveCanvasImageModuleInput,
} from '@proma/shared'
import {
  deriveCanvasImageArtifactVersions,
} from './canvas-image-module-store'

/** Canvas 产物在阶段一可由统一编排层请求的能力。 */
export type CanvasArtifactCapability =
  | 'create'
  | 'read'
  | 'update'
  | 'version'
  | 'preview'
  | 'run'
  | 'adopt'
  | 'export'

/** 单类 Canvas 产物的进程内固定能力描述。 */
export interface CanvasArtifactDescriptor<Kind extends CanvasContentKind = CanvasContentKind> {
  readonly kind: Kind
  readonly capabilities: readonly CanvasArtifactCapability[]
}

/** 具体产物适配器的最小公共合同，后续业务适配器可扩展真实方法。 */
export interface CanvasArtifactAdapter<Kind extends CanvasContentKind = CanvasContentKind> {
  readonly descriptor: CanvasArtifactDescriptor<Kind>
  /** 具体适配器可按固定能力矩阵扩展真实方法。 */
  readonly [method: string]: unknown
}

/** Canvas 产物适配器的只读查询与能力路由入口。 */
export interface CanvasArtifactRegistry {
  /** 返回目标产物不可变的阶段一能力描述。 */
  describe: (kind: CanvasContentKind) => CanvasArtifactDescriptor
  /** 校验目标能力并返回注册时对应的真实适配器。 */
  requireCapability: (
    kind: CanvasContentKind,
    capability: CanvasArtifactCapability,
  ) => CanvasArtifactAdapter
}

/** 图片统一导出在主进程选择路径后使用的内部输入。 */
export interface ExportCanvasImageArtifactToPathInput extends ExportCanvasImageArtifactInput {
  targetPath: string
}

/** 图片产物对 Registry 暴露的真实业务能力。 */
export interface CanvasImageArtifactAdapter extends CanvasArtifactAdapter<'image'> {
  read: (target: CanvasImageTarget) => Promise<CanvasImageModuleConfig>
  update: (input: SaveCanvasImageModuleInput) => Promise<CanvasImageModuleConfig>
  listVersions: (
    target: CanvasImageTarget,
    facts?: { jobs: readonly DesignJobRecord[]; assets: readonly DesignAsset[] },
  ) => Promise<CanvasImageArtifactVersion[]>
  run: (target: CanvasImageTarget) => Promise<void>
  adopt: (
    target: CanvasImageTarget,
    expectedConfigRevision: number,
    assetId: string,
  ) => Promise<unknown>
  export: (input: ExportCanvasImageArtifactToPathInput) => Promise<void>
}

/** 图片适配器只持有既有 Store、Job 与素材服务的窄依赖。 */
export interface CanvasImageArtifactAdapterDependencies {
  read: CanvasImageArtifactAdapter['read']
  update: CanvasImageArtifactAdapter['update']
  listJobs: (target: CanvasImageTarget) => DesignJobRecord[]
  listAssets: (projectId: string) => DesignAsset[]
  run: CanvasImageArtifactAdapter['run']
  adopt: CanvasImageArtifactAdapter['adopt']
  export: (input: ExportCanvasImageArtifactToPathInput) => Promise<void>
}

/** 文档阶段一能力只覆盖正文生命周期，不支持预览和运行。 */
export const DOCUMENT_ARTIFACT_DESCRIPTOR: CanvasArtifactDescriptor<'document'> = Object.freeze({
  kind: 'document',
  capabilities: Object.freeze([
    'create', 'read', 'update', 'version', 'adopt', 'export',
  ] satisfies CanvasArtifactCapability[]),
})

/** WebView 阶段一能力在文本生命周期外增加隔离预览。 */
export const WEBVIEW_ARTIFACT_DESCRIPTOR: CanvasArtifactDescriptor<'webview'> = Object.freeze({
  kind: 'webview',
  capabilities: Object.freeze([
    'create', 'read', 'update', 'version', 'preview', 'adopt', 'export',
  ] satisfies CanvasArtifactCapability[]),
})

/** 图片阶段一能力复用现有生成任务，并保持统一版本、采用和导出入口。 */
export const IMAGE_ARTIFACT_DESCRIPTOR: CanvasArtifactDescriptor<'image'> = Object.freeze({
  kind: 'image',
  capabilities: Object.freeze([
    'create', 'read', 'update', 'version', 'run', 'adopt', 'export',
  ] satisfies CanvasArtifactCapability[]),
})

/** 三类产物的唯一代码能力事实，不写入节点或业务 JSON。 */
const ARTIFACT_DESCRIPTORS: Readonly<Record<CanvasContentKind, CanvasArtifactDescriptor>> = Object.freeze({
  document: DOCUMENT_ARTIFACT_DESCRIPTOR,
  webview: WEBVIEW_ARTIFACT_DESCRIPTOR,
  image: IMAGE_ARTIFACT_DESCRIPTOR,
})

/** 固定的产物类别顺序用于完整性检查和稳定诊断。 */
const ARTIFACT_KINDS: readonly CanvasContentKind[] = Object.freeze([
  'document', 'webview', 'image',
])

/**
 * 创建复用现有图片服务的 Registry 适配器。
 * @param dependencies 图片配置、任务和素材服务的窄依赖。
 * @returns 不复制任务、素材或图片文件的统一图片适配器。
 */
export function createCanvasImageArtifactAdapter(
  dependencies: CanvasImageArtifactAdapterDependencies,
): CanvasImageArtifactAdapter {
  return {
    descriptor: IMAGE_ARTIFACT_DESCRIPTOR,
    read: dependencies.read,
    update: dependencies.update,
    listVersions: async (target, facts) => {
      /** LOAD 可传入同轮已验证事实，避免二次读取造成版本快照竞态。 */
      const jobs = facts?.jobs ?? dependencies.listJobs(target)
      /** 未提供同轮事实时，独立 Registry 调用仍读取现有素材服务。 */
      const assets = facts?.assets ?? dependencies.listAssets(target.projectId)
      return deriveCanvasImageArtifactVersions(target, jobs, assets)
    },
    run: dependencies.run,
    adopt: dependencies.adopt,
    export: async (input) => {
      /** 当前 adopted 配置和现存素材必须同时证明可导出身份。 */
      const config = await dependencies.read(input)
      if (config.adoptedAssetId !== input.assetId) throw new Error('CANVAS_IMAGE_ASSET_TARGET_CONFLICT')
      /** 旧项目的 adopted 素材可能早于 Canvas Job，存在性由素材事实独立证明。 */
      if (!dependencies.listAssets(input.projectId).some((asset) => asset.id === input.assetId)) {
        throw new Error('CANVAS_IMAGE_ASSET_TARGET_CONFLICT')
      }
      await dependencies.export(input)
    },
  }
}

/** 判断适配器声明是否与代码中的固定能力矩阵完全一致。 */
function matchesFixedDescriptor(descriptor: CanvasArtifactDescriptor): boolean {
  /** 目标类别对应的权威能力描述。 */
  const expected = ARTIFACT_DESCRIPTORS[descriptor.kind]
  return descriptor.capabilities.length === expected.capabilities.length
    && descriptor.capabilities.every((capability, index) => capability === expected.capabilities[index])
}

/**
 * 在保持基础 Registry 其余路由不变时替换单类真实适配器。
 * @param registry 已完成三类完整性验证的基础 Registry。
 * @param adapter 新的单类真实适配器。
 * @returns 仍使用固定能力矩阵的只读 Registry 视图。
 */
export function replaceCanvasArtifactAdapter(
  registry: CanvasArtifactRegistry,
  adapter: CanvasArtifactAdapter,
): CanvasArtifactRegistry {
  if (!matchesFixedDescriptor(adapter.descriptor)) throw new Error('CANVAS_ARTIFACT_ADAPTER_INVALID')
  /** 替换类别在闭包中固定，避免后续外部篡改改变路由。 */
  const replacementKind = adapter.descriptor.kind
  return Object.freeze({
    describe: registry.describe,
    requireCapability: (kind: CanvasContentKind, capability: CanvasArtifactCapability) => {
      /** 基础 Registry 先执行固定能力校验，替换不能扩展能力矩阵。 */
      const current = registry.requireCapability(kind, capability)
      return kind === replacementKind ? adapter : current
    },
  })
}

/**
 * 创建进程内 Canvas 产物注册表。
 * @param adapters 三类具体产物适配器，每类必须且只能注册一次。
 * @returns 只暴露固定能力描述和受校验适配器路由的注册表。
 */
export function createCanvasArtifactRegistry(
  adapters: readonly CanvasArtifactAdapter[],
): CanvasArtifactRegistry {
  /** 按产物类别建立常量规模的适配器索引。 */
  const adaptersByKind = new Map<CanvasContentKind, CanvasArtifactAdapter>()

  for (const adapter of adapters) {
    /** 当前适配器声明的产物类别。 */
    const { kind } = adapter.descriptor
    if (!ARTIFACT_KINDS.includes(kind) || !matchesFixedDescriptor(adapter.descriptor)) {
      throw new Error('CANVAS_ARTIFACT_ADAPTER_INVALID')
    }
    if (adaptersByKind.has(kind)) {
      throw new Error('CANVAS_ARTIFACT_ADAPTER_DUPLICATE')
    }
    /** 以不可替换属性绑定权威冻结描述，同时保留适配器对象身份和其它业务方法。 */
    try {
      Object.defineProperty(adapter, 'descriptor', {
        value: ARTIFACT_DESCRIPTORS[kind],
        writable: false,
        configurable: false,
        enumerable: true,
      })
    } catch {
      throw new Error('CANVAS_ARTIFACT_ADAPTER_INVALID')
    }
    adaptersByKind.set(kind, adapter)
  }

  if (ARTIFACT_KINDS.some((kind) => !adaptersByKind.has(kind))) {
    throw new Error('CANVAS_ARTIFACT_ADAPTER_MISSING')
  }

  return Object.freeze({
    describe: (kind: CanvasContentKind) => ARTIFACT_DESCRIPTORS[kind],
    requireCapability: (kind: CanvasContentKind, capability: CanvasArtifactCapability) => {
      /** 请求类别的权威能力描述。 */
      const descriptor = ARTIFACT_DESCRIPTORS[kind]
      if (!descriptor.capabilities.includes(capability)) {
        throw new Error('CANVAS_ARTIFACT_CAPABILITY_UNSUPPORTED')
      }
      /** 初始化已验证完整性，因此目标适配器必然存在。 */
      const adapter = adaptersByKind.get(kind)
      if (!adapter) throw new Error('CANVAS_ARTIFACT_ADAPTER_MISSING')
      return adapter
    },
  })
}
