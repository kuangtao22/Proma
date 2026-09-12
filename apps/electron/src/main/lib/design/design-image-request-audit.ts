import { IMAGE_GENERATION_MODEL_ID_MAX_LENGTH } from '@proma/shared'
import { isSafeDesignStableId } from './design-paths'

/** 请求外发前持久化的元数据；不包含路径、凭据或图片正文。 */
export interface DesignImageRequestAudit {
  executor: 'openai-images'
  modelId: string
  promptSha256: string
  preparedAt: number
  referenceImages: Array<{
    assetId: string
    sha256: string
    byteSize: number
  }>
}

/** 校验 journal 中的审计白名单和大小边界；旧任务可完全没有此字段。 */
export function isDesignImageRequestAudit(value: unknown): value is DesignImageRequestAudit {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  /** 未知持久化输入必须逐项收窄，不沿用 TypeScript 类型断言作为验证。 */
  const record = value as Record<string, unknown>
  if (Object.keys(record).length !== 5 || record.executor !== 'openai-images'
    || typeof record.modelId !== 'string' || !record.modelId.trim()
    || record.modelId.length > IMAGE_GENERATION_MODEL_ID_MAX_LENGTH
    || typeof record.promptSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(record.promptSha256)
    || typeof record.preparedAt !== 'number' || !Number.isFinite(record.preparedAt)
    || !Array.isArray(record.referenceImages) || record.referenceImages.length > 16) return false
  return record.referenceImages.every((image: unknown) => {
    if (!image || typeof image !== 'object' || Array.isArray(image)) return false
    /** 每张图片只允许身份、实际字节哈希与长度。 */
    const reference = image as Record<string, unknown>
    return Object.keys(reference).length === 3 && isSafeDesignStableId(reference.assetId)
      && typeof reference.sha256 === 'string' && /^[a-f0-9]{64}$/.test(reference.sha256)
      && typeof reference.byteSize === 'number' && Number.isSafeInteger(reference.byteSize)
      && reference.byteSize > 0 && reference.byteSize <= 100 * 1024 * 1024
  })
}
