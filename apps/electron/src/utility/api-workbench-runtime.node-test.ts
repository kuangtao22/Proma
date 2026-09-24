import assert from 'node:assert/strict'
import { createDecipheriv, randomBytes } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, test } from 'node:test'
import { gzipSync } from 'node:zlib'
import type { ApiResolvedRequest } from '@proma/shared'
import { executeApiRuntimeRun } from './api-workbench-runtime.ts'

/** 测试结束时关闭回环端口和临时产物。 */
const servers = new Set<Server>()
const directories = new Set<string>()
afterEach(async () => {
  for (const server of servers) { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())) }
  servers.clear()
  await Promise.all([...directories].map((directory) => rm(directory, { recursive: true, force: true })))
  directories.clear()
})

/** 启动本机 HTTP 夹具。 */
async function listen(server: Server): Promise<string> {
  servers.add(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('回环服务未取得端口')
  return `http://127.0.0.1:${address.port}`
}

/** 创建受管临时产物目录。 */
async function artifactDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'proma-api-runtime-'))
  directories.add(directory)
  return directory
}

/** 创建固定的 resolved request。 */
function request(url: string): ApiResolvedRequest {
  return { method: 'GET', url, headers: [], body: '', timeoutMs: 2_000, followRedirects: false, maxRedirects: 0, sensitiveHeaderNames: [], sensitiveQueryNames: [] }
}

/** 解密 API1 + IV + ciphertext + authTag 格式，验证产物可读性。 */
async function decrypt(path: string, key: Buffer): Promise<Buffer> {
  const encrypted = await readFile(path)
  assert.equal(encrypted.subarray(0, 4).toString('ascii'), 'API1')
  const iv = encrypted.subarray(4, 16)
  const ciphertext = encrypted.subarray(16, -16)
  const authTag = encrypted.subarray(-16)
  const decipher = createDecipheriv('aes-256-gcm', key, iv)
  decipher.setAuthTag(authTag)
  return Buffer.concat([decipher.update(ciphertext), decipher.final()])
}

describe('api-workbench utility artifacts', () => {
  test('Given 事件流响应，When 运行，Then 逐帧回调并把计数事实写进结果', async () => {
    const baseUrl = await listen(createServer((_incoming, response) => {
      response.writeHead(200, { 'Content-Type': 'text/event-stream' })
      response.write(': ping\n\n')
      response.write('data: 一\n\n')
      response.end('data: 二\n\n')
    }))
    const received: string[] = []

    const result = await executeApiRuntimeRun(
      { type: 'api-workbench.run', requestId: 'request-sse', request: request(baseUrl) },
      undefined,
      (event) => received.push(`${event.comment}|${event.data}`),
    )

    assert.equal(result.state, 'completed', JSON.stringify(result.error))
    assert.deepEqual(received, ['ping|', '|一', '|二'])
    assert.equal(result.sse?.totalEvents, 3)
    assert.equal(result.sse?.endedReason, 'completed')
  })

  test('Given gzip 响应与 artifacts，When 运行成功，Then 原始和解码真实字节分别写入 GCM 文件', async () => {
    const decoded = Buffer.from('utility encrypted body'.repeat(64))
    const encoded = gzipSync(decoded)
    const baseUrl = await listen(createServer((_incoming, response) => {
      response.writeHead(200, { 'Content-Encoding': 'gzip' })
      response.end(encoded)
    }))
    const directory = await artifactDirectory()
    const key = randomBytes(32)

    const result = await executeApiRuntimeRun({
      type: 'api-workbench.run', requestId: 'request-1', request: request(baseUrl),
      artifacts: { directory, keyBase64: key.toString('base64') },
    })

    assert.equal(result.state, 'completed')
    assert.deepEqual(await decrypt(join(directory, 'raw.bin.enc'), key), encoded)
    assert.deepEqual(await decrypt(join(directory, 'decoded.bin.enc'), key), decoded)
    assert.equal(JSON.stringify(result).includes(directory), false)
    assert.equal(JSON.stringify(result).includes(key.toString('base64')), false)
  })

  test('Given 流式响应已收到部分字节，When 取消，Then 关闭文件并留下可认证的 partial 产物', async () => {
    const baseUrl = await listen(createServer((_incoming, response) => {
      response.writeHead(200)
      response.write('partial')
    }))
    const directory = await artifactDirectory()
    const key = randomBytes(32)
    const controller = new AbortController()
    setTimeout(() => controller.abort(), 30)

    const result = await executeApiRuntimeRun({
      type: 'api-workbench.run', requestId: 'request-2', request: request(baseUrl),
      artifacts: { directory, keyBase64: key.toString('base64') },
    }, controller.signal)

    assert.equal(result.state, 'cancelled')
    assert.equal((await decrypt(join(directory, 'raw.bin.enc'), key)).toString(), 'partial')
    assert.equal((await decrypt(join(directory, 'decoded.bin.enc'), key)).toString(), 'partial')
    await rm(directory, { recursive: true })
    directories.delete(directory)
  })

  test('Given artifact 目录不可写入，When 初始化，Then 不发网络并明确产物不可用', async () => {
    let requested = false
    const baseUrl = await listen(createServer((_incoming, response) => { requested = true; response.end('unexpected') }))
    const directory = join(await artifactDirectory(), 'missing-child')

    const result = await executeApiRuntimeRun({
      type: 'api-workbench.run', requestId: 'request-3', request: request(baseUrl),
      artifacts: { directory, keyBase64: randomBytes(32).toString('base64') },
    })

    assert.equal(result.state, 'failed')
    assert.equal(result.error?.code, 'API_ARTIFACT_UNAVAILABLE')
    assert.equal(requested, false)
  })
})
