/**
 * Agent 显式声明的待上传文件（B12b）。
 *
 * 这是**唯一**允许路径字符串从 Agent 侧进入系统的入口，因此单独成模块并做严格校验：
 * - 只接受固定键 `id/name/path/contentType?`，未知键一律按非法参数拒绝，避免模型顺手塞 `ref` 或其它字段；
 * - 解析结果只交给 facade：facade 立即把它登记成文件引用，路径只留在「审批快照 + 文件仓库」两处；
 * - 工具 schema 与这里保持同一份约束（数量、身份白名单、路径长度）。
 */

import { API_LIMITS, apiRecord, parseApiId } from '@proma/shared'

/** 一个由 Agent 声明的待上传文件；路径只在审批快照与文件仓库里出现。 */
export interface ApiAgentDeclaredFile {
  /** 编辑身份，与请求定义里的文件行一一对应。 */
  id: string
  /** 目标表单字段名，例如 `file`。 */
  name: string
  /** 本机绝对路径（可为符号链接；登记时按 realpath 展开）。 */
  path: string
  /** 可选的 Content-Type 覆盖；缺省按扩展名推断。 */
  contentType?: string
}

/** 与共享解析器一致风格的稳定错误：只回显字段路径，不回显字段值。 */
function invalid(path: string): never {
  throw new Error(`API_WORKBENCH_INVALID: ${path}`)
}

/** 有界文本字段：拒绝非字符串、超长与控制字符。 */
function text(value: unknown, path: string, max: number): string {
  if (typeof value !== 'string' || value.length > max || value.includes('\0')) return invalid(path)
  return value
}

/**
 * 解析 Agent 在 `request.body.files` 里声明的文件；没有声明时返回空数组。
 *
 * @param body 工具入参里的 `request.body`（未知类型，按严格白名单校验）。
 * @returns 与入参同序的声明；空数组表示这次没有 Agent 指定的文件。
 */
export function parseApiAgentDeclaredFiles(body: unknown): ApiAgentDeclaredFile[] {
  if (body === undefined) return []
  const record = apiRecord(body, ['kind', 'text', 'fields', 'files'], 'body')
  if (record.files === undefined) return []
  if (!Array.isArray(record.files) || record.files.length > API_LIMITS.maxFileParts) return invalid('body.files')
  const files = record.files.map((item, index) => {
    const entry = apiRecord(item, ['id', 'name', 'path', 'contentType'], `body.files[${index}]`)
    return {
      id: parseApiId(entry.id),
      /** 字段名可以为空字符串之外的任意短文本；换行会由 multipart 合成阶段再拒绝。 */
      name: text(entry.name, `body.files[${index}].name`, 256),
      /** 路径必须是本机绝对路径；相对路径会随 cwd 漂移，直接拒绝。 */
      path: absolutePath(text(entry.path, `body.files[${index}].path`, 4096), `body.files[${index}].path`),
      ...(entry.contentType === undefined ? {} : { contentType: text(entry.contentType, `body.files[${index}].contentType`, 256) }),
    }
  })
  /** 身份必须唯一且非空，否则请求定义里的文件行无法一一对应。 */
  if (files.some((file) => file.name === '')) return invalid('body.files.name')
  if (new Set(files.map((file) => file.id)).size !== files.length) return invalid('body.files.duplicateId')
  return files
}

/** 只接受绝对路径：`/` 开头或 Windows 盘符，避免相对路径被解释成其它文件。 */
function absolutePath(value: string, path: string): string {
  const windows = /^[A-Za-z]:[\\/]/.test(value)
  if (!windows && !value.startsWith('/')) return invalid(path)
  return value
}
