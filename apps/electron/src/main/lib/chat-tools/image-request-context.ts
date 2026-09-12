/** OpenAI Images 请求在外发前提供给主进程的可信审计信息。 */
export interface ImageRequestAudit {
  executor: 'openai-images'
  modelId: string
  prompt: string
  referenceImages: Array<{
    path: string
    sha256: string
    byteSize: number
  }>
}
