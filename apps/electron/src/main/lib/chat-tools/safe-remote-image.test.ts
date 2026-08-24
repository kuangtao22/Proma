import { describe, expect, test } from 'bun:test'
import {
  downloadSafeRemoteImage,
  type RemoteImageResponse,
  type SafeRemoteImageDependencies,
} from './safe-remote-image'

const PNG_BYTES = Buffer.from('89504e470d0a1a0a', 'hex')

/** 创建不访问真实网络的远程响应。 */
function createResponse(
  statusCode: number,
  headers: Record<string, string>,
  bytes: Buffer,
): RemoteImageResponse {
  return {
    statusCode,
    headers,
    body: (async function* stream(): AsyncGenerator<Uint8Array> {
      yield bytes
    })(),
  }
}

/** 创建默认解析到公网图片的测试依赖。 */
function createSafeDependencies(): SafeRemoteImageDependencies {
  return {
    lookup: async () => [{ address: '93.184.216.34', family: 4 }],
    request: async () => createResponse(
      200,
      { 'content-type': 'image/png' },
      PNG_BYTES,
    ),
  }
}

describe('safe remote image', () => {
  test('Given 响应 URL 解析到私网 When 下载 Then 在请求前拒绝', async () => {
    let requested = false
    await expect(downloadSafeRemoteImage('https://images.example/result.png', {
      lookup: async () => [{ address: '127.0.0.1', family: 4 }],
      request: async () => {
        requested = true
        return createResponse(200, { 'content-type': 'image/png' }, PNG_BYTES)
      },
    })).rejects.toThrow('图片下载地址不允许访问本地或私有网络')
    expect(requested).toBe(false)
  })

  test('Given DNS 同时返回公网和私网 When 下载 Then 拒绝整组地址', async () => {
    const dependencies = createSafeDependencies()
    let requested = false
    await expect(downloadSafeRemoteImage('https://images.example/result.png', {
      ...dependencies,
      lookup: async () => [
        { address: '93.184.216.34', family: 4 },
        { address: '169.254.169.254', family: 4 },
      ],
      request: async () => {
        requested = true
        return createResponse(200, { 'content-type': 'image/png' }, PNG_BYTES)
      },
    })).rejects.toThrow('图片下载地址不允许访问本地或私有网络')
    expect(requested).toBe(false)
  })

  test('Given 公网图片与一次公网重定向 When 下载 Then 固定已校验地址并返回图片', async () => {
    /** 记录每一跳使用的原始主机名和固定公网地址。 */
    const calls: string[] = []
    const image = await downloadSafeRemoteImage('https://images.example/start', {
      lookup: async (hostname) => [{
        address: hostname === 'images.example' ? '93.184.216.34' : '151.101.1.69',
        family: 4,
      }],
      request: async (request) => {
        calls.push(`${request.url.hostname}:${request.address}`)
        return calls.length === 1
          ? createResponse(302, { location: 'https://cdn.example/result.png' }, Buffer.alloc(0))
          : createResponse(200, { 'content-type': 'image/png' }, PNG_BYTES)
      },
    })

    expect(image.mediaType).toBe('image/png')
    expect(image.bytes).toEqual(PNG_BYTES)
    expect(calls).toEqual(['images.example:93.184.216.34', 'cdn.example:151.101.1.69'])
  })

  test('Given 非 HTTPS、非图片 MIME 或超过附件上限 When 下载 Then 拒绝结果', async () => {
    const base = createSafeDependencies()
    await expect(downloadSafeRemoteImage('http://images.example/result', base))
      .rejects.toThrow('远程图片只允许使用 HTTPS')
    await expect(downloadSafeRemoteImage('https://images.example/result', {
      ...base,
      request: async () => createResponse(200, { 'content-type': 'text/html' }, Buffer.from('html')),
    })).rejects.toThrow('远程响应不是受支持的图片')
    await expect(downloadSafeRemoteImage('https://images.example/result', {
      ...base,
      maxBytes: 4,
      request: async () => createResponse(200, { 'content-type': 'image/png' }, Buffer.alloc(5)),
    })).rejects.toThrow('远程图片超过大小限制')
  })

  test('Given 重定向超过限制或指向私网 When 下载 Then 每一跳重新校验并拒绝', async () => {
    const base = createSafeDependencies()
    await expect(downloadSafeRemoteImage('https://images.example/start', {
      ...base,
      maxRedirects: 0,
      request: async () => createResponse(302, { location: 'https://cdn.example/result.png' }, Buffer.alloc(0)),
    })).rejects.toThrow('远程图片重定向次数过多')

    let requestCount = 0
    await expect(downloadSafeRemoteImage('https://images.example/start', {
      lookup: async (hostname) => [{
        address: hostname === 'images.example' ? '93.184.216.34' : '::1',
        family: hostname === 'images.example' ? 4 : 6,
      }],
      request: async () => {
        requestCount += 1
        return createResponse(302, { location: 'https://private.example/result.png' }, Buffer.alloc(0))
      },
    })).rejects.toThrow('图片下载地址不允许访问本地或私有网络')
    expect(requestCount).toBe(1)
  })
})
