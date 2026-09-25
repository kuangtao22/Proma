/** multipart 待发计划里的一个部分：文本字段直接带值，文件部分只带引用与元数据。 */
export type ApiMultipartPlanPart =
  | { kind: 'field'; name: string; value: string }
  | { kind: 'file'; name: string; fileName: string; contentType: string; sizeBytes: number; ref: string }

/** 字段名与文件名里出现换行会破坏协议，直接拒绝而不是转义成另一种意思。 */
function assertSafePartName(value: string, path: string): string {
  if (!value || /[\r\n\x00]/.test(value)) throw new Error(`API_WORKBENCH_MULTIPART_NAME_INVALID: ${path}`)
  return value
}

/** `Content-Disposition` 里的引号按 RFC 7578 反斜杠转义。 */
function quote(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

/** 生成一个不可预测的边界；同一请求每次准备都重新生成。 */
export function createMultipartBoundary(suffix: string): string {
  return `----proma${suffix.replaceAll('-', '')}`
}

/**
 * 生成 multipart 的**结构摘要**：文件字节不进运行记录，这里如实描述发了什么。
 * @param boundary 本次请求的边界。
 * @param parts 待发计划。
 * @returns 可安全展示与留存的正文摘要。
 */
export function summarizeMultipart(boundary: string, parts: readonly ApiMultipartPlanPart[]): string {
  const lines: string[] = []
  for (const part of parts) {
    const name = assertSafePartName(part.name, 'field')
    lines.push(`--${boundary}`)
    if (part.kind === 'field') {
      lines.push(`Content-Disposition: form-data; name="${quote(name)}"`, '', part.value)
    } else {
      lines.push(
        `Content-Disposition: form-data; name="${quote(name)}"; filename="${quote(assertSafePartName(part.fileName, 'fileName'))}"`,
        `Content-Type: ${part.contentType}`,
        '',
        `<文件内容未留存：${part.fileName}（${part.sizeBytes} 字节）>`,
      )
    }
  }
  lines.push(`--${boundary}--`)
  return lines.join('\r\n')
}

/**
 * 合成真正要发送的 multipart 正文。
 * @param boundary 本次请求的边界。
 * @param parts 待发计划。
 * @param readFile 按引用读取文件字节；引用失效时必须抛出稳定错误。
 * @returns 完整正文；超过请求体上限由调用方在合成前把关。
 */
export function composeMultipartBody(
  boundary: string,
  parts: readonly ApiMultipartPlanPart[],
  readFile: (ref: string) => Buffer,
): Buffer {
  const chunks: Buffer[] = []
  for (const part of parts) {
    const name = assertSafePartName(part.name, 'field')
    chunks.push(Buffer.from(`--${boundary}\r\n`))
    if (part.kind === 'field') {
      chunks.push(Buffer.from(`Content-Disposition: form-data; name="${quote(name)}"\r\n\r\n${part.value}\r\n`))
      continue
    }
    chunks.push(Buffer.from(`Content-Disposition: form-data; name="${quote(name)}"; filename="${quote(assertSafePartName(part.fileName, 'fileName'))}"\r\nContent-Type: ${part.contentType}\r\n\r\n`))
    chunks.push(readFile(part.ref))
    chunks.push(Buffer.from('\r\n'))
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`))
  return Buffer.concat(chunks)
}
