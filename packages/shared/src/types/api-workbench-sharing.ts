import type {
  ApiCatalog,
  ApiCollection,
  ApiEnvironment,
  ApiField,
  ApiRequestDefinition,
} from './api-workbench'
import { API_LIMITS, parseApiCatalog } from './api-workbench'

/** 快照内容标记，用于把集合快照与 cURL 文本区分开。 */
export const API_CATALOG_SNAPSHOT_KIND = 'proma-api-catalog'
/** 集合与环境数量沿用目录合同的上限。 */
const MAX_CATALOG_GROUPS = 64
/** 为导入资产生成新 ID 的最大尝试次数。 */
const MAX_ID_ATTEMPTS = 10_000

/** 导出或导入时发现的可分享快照。 */
export interface ApiCatalogSnapshot {
  kind: typeof API_CATALOG_SNAPSHOT_KIND
  version: 1
  exportedAt: number
  catalog: ApiCatalog
}

/** 导出结果：文本与需要重新填写的秘密位置。 */
export interface ApiCatalogSnapshotExport {
  text: string
  emptiedSecrets: string[]
}

/** 合并结果：新目录、增量统计与需要重新填写的秘密位置。 */
export interface ApiCatalogSnapshotMerge {
  catalog: ApiCatalog
  added: { collections: number; environments: number; requests: number }
  emptiedSecrets: string[]
}

/** 快照摘要：导入前展示的新增规模与需要重填的秘密位置。 */
export interface ApiCatalogSnapshotSummary {
  counts: { collections: number; environments: number; requests: number }
  emptiedSecrets: string[]
}

/** 导入与合并的稳定错误；原因面向用户，不回显字段值。 */
function invalidImport(reason: string): never {
  throw new Error(`API_IMPORT_INVALID: ${reason}`)
}

/**
 * 生成秘密字段的公开投影。
 * @param rows 待处理的字段行。
 * @param locate 为每个字段生成人类可读位置。
 * @param emptied 收集位置的可变数组。
 * @returns 清空秘密值、剥离秘密引用的新数组。
 */
function redactFields(
  rows: readonly ApiField[],
  locate: (field: ApiField) => string,
  emptied: string[],
): ApiField[] {
  return rows.map((field) => {
    if (field.secret !== true && field.secretRef === undefined) return { ...field }
    emptied.push(locate(field))
    return { id: field.id, name: field.name, enabled: field.enabled, value: '', secret: true }
  })
}

/**
 * 清空目录中的全部秘密值并记录位置。
 * @param catalog 已通过合同校验的目录。
 * @returns 可公开分享的目录与需要重新填写的位置。
 */
function redactCatalog(catalog: ApiCatalog): { catalog: ApiCatalog; emptied: string[] } {
  const emptied: string[] = []
  const collections = catalog.collections.map((collection) => ({
    ...collection,
    variables: redactFields(collection.variables, (field) => `集合「${collection.name}」变量 ${field.name}`, emptied),
  }))
  const environments = catalog.environments.map((environment) => ({
    ...environment,
    variables: redactFields(environment.variables, (field) => `环境「${environment.name}」变量 ${field.name}`, emptied),
  }))
  const requests = catalog.requests.map((definition) => {
    const authSensitive = definition.auth.value.secret === true || definition.auth.value.secretRef !== undefined
    if (authSensitive) emptied.push(`请求「${definition.name}」鉴权`)
    return {
      ...definition,
      query: redactFields(definition.query, (field) => `请求「${definition.name}」查询参数 ${field.name}`, emptied),
      headers: redactFields(definition.headers, (field) => `请求「${definition.name}」请求头 ${field.name}`, emptied),
      body: {
        ...definition.body,
        fields: redactFields(definition.body.fields, (field) => `请求「${definition.name}」表单字段 ${field.name}`, emptied),
      },
      auth: authSensitive
        ? { ...definition.auth, value: { value: '', secret: true } }
        : { ...definition.auth },
    }
  })
  return { catalog: { ...catalog, collections, environments, requests }, emptied }
}

/**
 * 把工作区目录导出为可分享的快照文本。
 * @param catalog 当前目录。
 * @param exportedAt 导出时间戳，由调用方提供以便测试。
 * @returns 文本与需要重新填写的秘密位置。
 */
export function createApiCatalogSnapshotExport(catalog: ApiCatalog, exportedAt: number): ApiCatalogSnapshotExport {
  const validated = parseApiCatalog(catalog)
  const redacted = redactCatalog(validated)
  const snapshot: ApiCatalogSnapshot = {
    kind: API_CATALOG_SNAPSHOT_KIND,
    version: 1,
    exportedAt,
    catalog: redacted.catalog,
  }
  const text = JSON.stringify(snapshot, null, 2)
  if (text.length > API_LIMITS.catalogBytes) {
    throw new Error('API_SNAPSHOT_EXPORT_INVALID: 导出内容超过目录大小上限')
  }
  return { text, emptiedSecrets: redacted.emptied }
}

/**
 * 解析粘贴或读取到的快照文本。
 * @param text 待解析文本。
 * @returns 通过严格校验的快照。
 */
export function parseApiCatalogSnapshot(text: string): ApiCatalogSnapshot {
  if (text.length > API_LIMITS.catalogBytes) invalidImport(`快照超过 ${API_LIMITS.catalogBytes} 字符上限`)
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return invalidImport('不是合法 JSON')
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalidImport('顶层必须是对象')
  const record = value as Record<string, unknown>
  if (Object.keys(record).some((key) => !['kind', 'version', 'exportedAt', 'catalog'].includes(key))) {
    return invalidImport('包含未知字段')
  }
  if (record.kind !== API_CATALOG_SNAPSHOT_KIND) return invalidImport('不是 Proma 接口集合快照')
  if (record.version !== 1) return invalidImport('快照版本不受支持')
  const exportedAt = record.exportedAt
  if (typeof exportedAt !== 'number' || !Number.isSafeInteger(exportedAt) || exportedAt < 0) {
    return invalidImport('导出时间非法')
  }
  try {
    return { kind: API_CATALOG_SNAPSHOT_KIND, version: 1, exportedAt, catalog: parseApiCatalog(record.catalog) }
  } catch (error) {
    return invalidImport(`目录不符合合同：${error instanceof Error ? error.message : '未知原因'}`)
  }
}

/**
 * 分配一个不与现有资产冲突的新 ID。
 * @param original 快照中的原始 ID。
 * @param taken 已占用 ID 集合，命中后会被写入。
 * @returns 新的稳定 ID。
 */
function allocateId(original: string, taken: Set<string>): string {
  for (let index = 1; index <= MAX_ID_ATTEMPTS; index += 1) {
    const candidate = `${original.slice(0, 120)}-i${index}`
    if (!taken.has(candidate)) {
      taken.add(candidate)
      return candidate
    }
  }
  return invalidImport('无法为导入资产分配新 ID')
}

/** 收集秘密值已被清空、需要用户重新填写的位置。 */
function collectEmptiedSecrets(catalog: ApiCatalog): string[] {
  const emptied: string[] = []
  for (const collection of catalog.collections) {
    for (const field of collection.variables) {
      if (field.secret === true && field.value === '') emptied.push(`集合「${collection.name}」变量 ${field.name}`)
    }
  }
  for (const environment of catalog.environments) {
    for (const field of environment.variables) {
      if (field.secret === true && field.value === '') emptied.push(`环境「${environment.name}」变量 ${field.name}`)
    }
  }
  for (const definition of catalog.requests) {
    const groups: [readonly ApiField[], string][] = [
      [definition.query, '查询参数'],
      [definition.headers, '请求头'],
      [definition.body.fields, '表单字段'],
    ]
    for (const [fields, label] of groups) {
      for (const field of fields) {
        if (field.secret === true && field.value === '') emptied.push(`请求「${definition.name}」${label} ${field.name}`)
      }
    }
    if (definition.auth.value.secret === true && definition.auth.value.value === '') {
      emptied.push(`请求「${definition.name}」鉴权`)
    }
  }
  return emptied
}

/**
 * 把快照追加到当前目录；同名资产保留，ID 冲突时分配新 ID。
 * @param current 当前工作区目录。
 * @param snapshot 已解析的快照。
 * @returns 新目录与增量统计；目录 revision 保持不变，由调用方比较。
 */
export function mergeApiCatalogSnapshot(current: ApiCatalog, snapshot: ApiCatalogSnapshot): ApiCatalogSnapshotMerge {
  const base = parseApiCatalog(current)
  const incoming = parseApiCatalog(snapshot.catalog)
  const collectionCount = base.collections.length + incoming.collections.length
  const environmentCount = base.environments.length + incoming.environments.length
  const requestCount = base.requests.length + incoming.requests.length
  if (collectionCount > MAX_CATALOG_GROUPS) invalidImport(`集合数量超出 ${MAX_CATALOG_GROUPS} 个上限，请先删除不再使用的集合`)
  if (environmentCount > MAX_CATALOG_GROUPS) invalidImport(`环境数量超出 ${MAX_CATALOG_GROUPS} 个上限，请先删除不再使用的环境`)
  if (requestCount > API_LIMITS.maxRequests) invalidImport(`请求数量超出 ${API_LIMITS.maxRequests} 条上限，请先删除不再使用的请求`)

  /** 三类资产各自维护已占用 ID，导入资产一律重新分配。 */
  const takenCollectionIds = new Set(base.collections.map((item) => item.id))
  const takenEnvironmentIds = new Set(base.environments.map((item) => item.id))
  const takenRequestIds = new Set(base.requests.map((item) => item.id))
  const collectionIdMap = new Map<string, string>()
  for (const collection of incoming.collections) {
    collectionIdMap.set(collection.id, allocateId(collection.id, takenCollectionIds))
  }

  const importedCollections: ApiCollection[] = incoming.collections.map((collection) => ({
    ...collection,
    id: collectionIdMap.get(collection.id)!,
  }))
  const importedEnvironments: ApiEnvironment[] = incoming.environments.map((environment) => ({
    ...environment,
    id: allocateId(environment.id, takenEnvironmentIds),
  }))
  const importedRequests: ApiRequestDefinition[] = incoming.requests.map((definition) => ({
    ...definition,
    id: allocateId(definition.id, takenRequestIds),
    collectionId: collectionIdMap.get(definition.collectionId) ?? definition.collectionId,
  }))

  const imported: ApiCatalog = {
    ...base,
    collections: importedCollections,
    environments: importedEnvironments,
    requests: importedRequests,
  }
  const catalog = parseApiCatalog({
    ...base,
    collections: [...base.collections, ...importedCollections],
    environments: [...base.environments, ...importedEnvironments],
    requests: [...base.requests, ...importedRequests],
  })
  return {
    catalog,
    added: {
      collections: importedCollections.length,
      environments: importedEnvironments.length,
      requests: importedRequests.length,
    },
    emptiedSecrets: collectEmptiedSecrets(imported),
  }
}

/**
 * 读取快照摘要，供导入前展示。
 * @param snapshot 已解析的快照。
 * @returns 新增规模与需要重新填写的秘密位置。
 */
export function describeApiCatalogSnapshot(snapshot: ApiCatalogSnapshot): ApiCatalogSnapshotSummary {
  const catalog = parseApiCatalog(snapshot.catalog)
  return {
    counts: {
      collections: catalog.collections.length,
      environments: catalog.environments.length,
      requests: catalog.requests.length,
    },
    emptiedSecrets: collectEmptiedSecrets(catalog),
  }
}

/**
 * 判断粘贴内容属于集合快照还是 cURL 文本。
 * @param text 待识别文本。
 * @returns 快照优先，无法识别为快照时按 cURL 处理。
 */
export function detectApiWorkbenchImportKind(text: string): 'curl' | 'catalog' {
  const trimmed = text.trim()
  if (trimmed.startsWith('{')) {
    try {
      const value: unknown = JSON.parse(trimmed)
      if (value && typeof value === 'object' && !Array.isArray(value)
        && (value as Record<string, unknown>).kind === API_CATALOG_SNAPSHOT_KIND) {
        return 'catalog'
      }
    } catch {
      // 非法 JSON 交给 cURL 路径给出更具体的提示。
    }
  }
  return 'curl'
}
