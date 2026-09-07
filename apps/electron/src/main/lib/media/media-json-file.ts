import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs'

/** 从稳定普通文件读取有界 JSON；拒绝符号链接、设备和读取期间变化。 */
export function readMediaJsonFile(path: string, maximumBytes: number): unknown {
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const before = fstatSync(descriptor)
    if (!before.isFile() || before.size > maximumBytes) throw new Error('MEDIA_FILE_INVALID')
    const bytes = Buffer.alloc(before.size + 1)
    let offset = 0
    while (offset < bytes.length) {
      const count = readSync(descriptor, bytes, offset, bytes.length - offset, offset)
      if (count === 0) break
      offset += count
    }
    const after = fstatSync(descriptor)
    if (offset !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs) throw new Error('MEDIA_FILE_CHANGED')
    return JSON.parse(bytes.subarray(0, offset).toString('utf8')) as unknown
  } finally { closeSync(descriptor) }
}
