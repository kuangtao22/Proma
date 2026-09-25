/**
 * 把「每条请求都硬编码的同一个主机」抽成集合变量。
 *
 * 批量导入最常见的劣化：126 条请求各自写着 `http://127.0.0.1:18080`，换环境要改 126 处。
 * 这里做一次纯函数级的改写：选出出现次数最多的主机 → 在集合变量里声明 `baseUrl`（或复用同名变量）
 * → 把这些请求的 URL 前缀换成 `{{baseUrl}}`。已经是变量的 URL、其它主机一律不动。
 */

import type { ApiCatalog, ApiRequestDefinition } from './api-workbench'

/** 抽变量的结果：改写后的目录、变量名、被改写的请求数与被识别的主机。 */
export interface ApiBaseUrlExtraction {
  catalog: ApiCatalog
  /** 选中的变量名；没有可抽取的主机时为 undefined。 */
  variableName?: string
  /** 抽出来的主机值。 */
  origin?: string
  /** 被改写的请求条数。 */
  updated: number
  /** 无法处理时的说明（例如同名变量已有别的值）。 */
  message?: string
}

/** 只认字面量 http(s) 主机；已经是 `{{var}}` 开头的 URL 天然不会被选中。 */
function literalOrigin(url: string): string | undefined {
  return /^(https?:\/\/[^/\s]+)\//i.exec(url.trim())?.[1]
}

/**
 * 为一个集合抽取公共主机变量。
 * @param catalog 当前目录。
 * @param collectionId 目标集合。
 * @param variableName 变量名，默认 `baseUrl`。
 * @returns 改写后的目录与事实说明；没有可抽取的主机时 catalogs 原样返回。
 */
export function extractApiBaseUrlVariable(catalog: ApiCatalog, collectionId: string, variableName = 'baseUrl'): ApiBaseUrlExtraction {
  const collection = catalog.collections.find((item) => item.id === collectionId)
  if (!collection) return { catalog, updated: 0, message: '集合不存在' }
  /** 统计该集合里每个字面量主机的出现次数与被引用的请求。 */
  const counts = new Map<string, { origin: string; count: number; requests: ApiRequestDefinition[] }>()
  for (const request of catalog.requests) {
    if (request.collectionId !== collectionId) continue
    const origin = literalOrigin(request.url)
    if (!origin) continue
    const key = origin.toLowerCase()
    const entry = counts.get(key) ?? { origin, count: 0, requests: [] }
    entry.count += 1
    entry.requests.push(request)
    counts.set(key, entry)
  }
  const best = [...counts.values()].sort((a, b) => b.count - a.count || a.origin.localeCompare(b.origin))[0]
  if (!best) return { catalog, updated: 0, message: '这个集合里没有硬编码主机的请求' }
  /** 同名变量已存在时只在值一致时复用，值不同就拒绝，避免把别人的环境地址悄悄改掉。 */
  const existing = collection.variables.find((item) => item.name === variableName)
  if (existing && existing.value !== best.origin) {
    return { catalog, updated: 0, message: `集合里已有变量 ${variableName}=${existing.value}，与要抽取的 ${best.origin} 不一致；请先改名或手动处理` }
  }
  const prefix = `{{${variableName}}}`
  /** 只替换完全匹配该主机的 URL 前缀，路径与查询串原样保留。 */
  const rewritten = catalog.requests.map((request) => {
    if (request.collectionId !== collectionId) return request
    const origin = literalOrigin(request.url)
    if (!origin || origin.toLowerCase() !== best.origin.toLowerCase()) return request
    return { ...request, url: `${prefix}${request.url.trim().slice(origin.length)}` }
  })
  const updated = rewritten.filter((request, index) => request.url !== catalog.requests[index]!.url).length
  const variables = existing
    ? collection.variables
    : [...collection.variables, { id: `var_${variableName}`.replace(/[^A-Za-z0-9_-]/g, '_'), name: variableName, value: best.origin, enabled: true }]
  return {
    catalog: {
      ...catalog,
      collections: catalog.collections.map((item) => item.id === collectionId ? { ...item, variables } : item),
      requests: rewritten,
    },
    variableName,
    origin: best.origin,
    updated,
  }
}
