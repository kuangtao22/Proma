/** OpenAI Images 请求在外发前提供给主进程的可信审计信息。 */
export interface ImageRequestAudit {
  /** 产生本次请求的执行器；独立供应商各自记录来源，便于审计归因。 */
  executor: 'openai-images' | 'minimax-image'
  modelId: string
  prompt: string
  referenceImages: Array<{
    path: string
    sha256: string
    byteSize: number
  }>
}
