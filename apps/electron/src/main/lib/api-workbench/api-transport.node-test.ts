import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { afterEach, describe, test } from 'node:test'
import { brotliCompressSync, deflateSync, gzipSync } from 'node:zlib'
import { createServer, type Server } from 'node:http'
import { createServer as createHttpsServer } from 'node:https'
import type { Socket } from 'node:net'
import { join } from 'node:path'
import type { ApiResolvedRequest, ApiSseEvent } from '@proma/shared'
import { executeApiTransport } from './api-transport.ts'

/** 测试结束时统一关闭回环服务，避免监听句柄污染后续测试。 */
const servers = new Set<Server>()

afterEach(async () => {
  await Promise.all([...servers].map((server) => new Promise<void>((resolve) => {
    server.close(() => resolve())
    server.closeAllConnections()
  })))
  servers.clear()
})

/** 启动仅绑定本机的 HTTP/1.1 合成服务。 */
async function listen(server: Server): Promise<string> {
  servers.add(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('回环服务未取得端口')
  return `http://127.0.0.1:${address.port}`
}

/** 创建传输层已经解析完成的固定请求快照。 */
function request(url: string, overrides: Partial<ApiResolvedRequest> = {}): ApiResolvedRequest {
  return {
    method: 'GET', url, headers: [], body: '', timeoutMs: 2_000,
    followRedirects: false, maxRedirects: 5,
    sensitiveHeaderNames: [], sensitiveQueryNames: [], ...overrides,
  }
}

describe('executeApiTransport', () => {
  test('Given 重复查询和 Header，When 收到 401，Then 保留服务端看到的请求与原始响应事实', async () => {
    let observedRawHeaders: string[] = []
    let observedUrl = ''
    const baseUrl = await listen(createServer((incoming, response) => {
      observedRawHeaders = incoming.rawHeaders
      observedUrl = incoming.url ?? ''
      response.statusCode = 401
      response.setHeader('Content-Type', 'text/plain; charset=utf-8')
      response.setHeader('X-Repeat', ['first', 'second'])
      response.setHeader('Trailer', 'X-Final')
      response.setHeader('Transfer-Encoding', 'chunked')
      response.write('需要鉴权')
      response.addTrailers({ 'X-Final': 'done' })
      response.end()
    }))

    const result = await executeApiTransport(request(`${baseUrl}/auth?tag=one&tag=two`, {
      method: 'POST', body: 'payload',
      headers: [
        { name: 'X-Test', value: 'one', source: 'user' },
        { name: 'X-Test', value: 'two', source: 'user' },
      ],
    }))

    assert.equal(result.state, 'completed')
    assert.equal(result.hops.length, 1)
    assert.equal(result.hops[0]?.status, 401)
    assert.equal(result.hops[0]?.requestHeadersSource, 'configured')
    assert.deepEqual(result.hops[0]?.responseHeaders.filter((header) => header.name === 'X-Repeat'), [
      { name: 'X-Repeat', value: 'first' },
      { name: 'X-Repeat', value: 'second' },
    ])
    assert.deepEqual(result.hops[0]?.trailers, [{ name: 'X-Final', value: 'done' }])
    assert.equal(result.body.preview, '需要鉴权')
    assert.equal(observedUrl, '/auth?tag=one&tag=two')
    assert.deepEqual(observedRawHeaders, result.hops[0]?.requestHeaders.flatMap((header) => [header.name, header.value]))
    assert.deepEqual(result.hops[0]?.requestHeaders.filter((header) => header.source === 'generated').map((header) => header.name), [
      'Host', 'Connection', 'Content-Length',
    ])
  })

  for (const [encoding, compress] of [
    ['gzip', gzipSync],
    ['deflate', deflateSync],
    ['br', brotliCompressSync],
  ] as const) test(`Given ${encoding} 正文，When 流式接收，Then 分开统计原始和解码字节`, async () => {
    const decoded = Buffer.from('压缩响应'.repeat(128))
    const encoded = compress(decoded)
    const baseUrl = await listen(createServer((_incoming, response) => {
      response.writeHead(200, { 'Content-Encoding': encoding, 'Content-Type': 'text/plain; charset=utf-8' })
      response.end(encoded)
    }))
    const rawChunks: Uint8Array[] = []
    const decodedChunks: Uint8Array[] = []

    const result = await executeApiTransport(request(baseUrl), {
      onRawChunk: (chunk) => { rawChunks.push(chunk) },
      onDecodedChunk: (chunk) => { decodedChunks.push(chunk) },
    })

    assert.equal(result.state, 'completed')
    assert.equal(result.body.rawBytes, encoded.byteLength)
    assert.equal(result.body.decodedBytes, decoded.byteLength)
    assert.equal(result.body.decoded, true)
    assert.equal(Buffer.concat(rawChunks).equals(encoded), true)
    assert.equal(Buffer.concat(decodedChunks).equals(decoded), true)
  })

  test('Given 压缩正文解码后超过预算，When 读取，Then 失败并停止 socket', async () => {
    let serverSocket: Socket | undefined
    let resolveClosed!: () => void
    const closed = new Promise<void>((resolve) => { resolveClosed = resolve })
    const baseUrl = await listen(createServer((incoming, response) => {
      serverSocket = incoming.socket
      incoming.socket.once('close', resolveClosed)
      response.writeHead(200, { 'Content-Encoding': 'gzip' })
      response.end(gzipSync(Buffer.alloc(8_192, 65)))
    }))
    const result = await executeApiTransport(request(baseUrl), { maxBodyBytes: 1_024 })

    assert.equal(result.state, 'failed')
    assert.equal(result.error?.code, 'API_DECODED_BODY_LIMIT')
    assert.equal(result.body.complete, false)
    await closed
    assert.equal(serverSocket?.destroyed, true)
  })

  test('Given 同源重定向，When 依次遇到 302/303/307，Then 按规则逐跳保留或改写方法', async () => {
    const observed: Array<{ path: string; method: string; body: string }> = []
    const baseUrl = await listen(createServer((incoming, response) => {
      const chunks: Buffer[] = []
      incoming.on('data', (chunk) => chunks.push(Buffer.from(chunk)))
      incoming.on('end', () => {
        const path = incoming.url ?? ''
        observed.push({ path, method: incoming.method ?? '', body: Buffer.concat(chunks).toString() })
        if (path === '/start') response.writeHead(302, { Location: '/after-302' }).end()
        else if (path === '/after-302') response.writeHead(303, { Location: '/after-303' }).end()
        else if (path === '/after-303') response.writeHead(307, { Location: '/final' }).end()
        else response.end('finished')
      })
    }))

    const result = await executeApiTransport(request(`${baseUrl}/start`, {
      method: 'PUT', body: 'keep-me', followRedirects: true,
    }))

    assert.equal(result.state, 'completed')
    assert.deepEqual(result.hops.map((hop) => [hop.status, hop.method]), [[302, 'PUT'], [303, 'PUT'], [307, 'GET'], [200, 'GET']])
    assert.deepEqual(observed, [
      { path: '/start', method: 'PUT', body: 'keep-me' },
      { path: '/after-302', method: 'PUT', body: 'keep-me' },
      { path: '/after-303', method: 'GET', body: '' },
      { path: '/final', method: 'GET', body: '' },
    ])
    assert.equal(result.body.preview, 'finished')
  })

  for (const [status, initialMethod, expectedMethod, expectedBody] of [
    [301, 'POST', 'GET', ''],
    [302, 'POST', 'GET', ''],
    [303, 'HEAD', 'HEAD', ''],
    [307, 'POST', 'POST', 'preserved'],
    [308, 'POST', 'POST', 'preserved'],
  ] as const) test(`Given ${status} 重定向，When 初始方法为 ${initialMethod}，Then 下一跳使用 ${expectedMethod}`, async () => {
    let finalMethod = ''
    let finalBody = ''
    const baseUrl = await listen(createServer((incoming, response) => {
      const chunks: Buffer[] = []
      incoming.on('data', (chunk) => chunks.push(Buffer.from(chunk)))
      incoming.on('end', () => {
        if (incoming.url === '/start') { response.writeHead(status, { Location: '/final' }).end(); return }
        finalMethod = incoming.method ?? ''
        finalBody = Buffer.concat(chunks).toString()
        response.end('ok')
      })
    }))

    const result = await executeApiTransport(request(`${baseUrl}/start`, {
      method: initialMethod, body: initialMethod === 'HEAD' ? '' : 'preserved', followRedirects: true,
    }))

    assert.equal(result.state, 'completed')
    assert.equal(finalMethod, expectedMethod)
    assert.equal(finalBody, expectedBody)
  })

  test('Given 跨来源重定向，When 开启自动跟随，Then 在第二个来源收到请求前拒绝', async () => {
    let leaked = false
    const targetUrl = await listen(createServer((_incoming, response) => { leaked = true; response.end('leaked') }))
    const sourceUrl = await listen(createServer((_incoming, response) => {
      response.writeHead(302, { Location: `${targetUrl}/secret?token=server-value` }).end()
    }))

    const result = await executeApiTransport(request(`${sourceUrl}/start?token=client-secret`, {
      method: 'POST', body: 'private-body', followRedirects: true,
      headers: [{ name: 'Authorization', value: 'Bearer private', source: 'user' }],
      sensitiveHeaderNames: ['authorization'], sensitiveQueryNames: ['token'],
    }))

    assert.equal(result.state, 'failed')
    assert.equal(result.error?.code, 'API_REDIRECT_CROSS_ORIGIN')
    assert.equal(result.hops.length, 1)
    assert.equal(leaked, false)
  })

  test('Given 受信 HTTPS 直连，When 收到响应，Then 记录 TLS 事实并拒绝降级跳转', async () => {
    const fixtureDirectory = join(process.cwd(), 'apps/electron/src/utility/server-ops/fixtures')
    const tlsOptions = {
      key: readFileSync(join(fixtureDirectory, 'server-ops-tls-fixture-key.pem')),
      cert: readFileSync(join(fixtureDirectory, 'server-ops-tls-fixture-cert.pem')),
    }
    let downgraded = false
    const httpUrl = await listen(createServer((_incoming, response) => { downgraded = true; response.end('unsafe') }))
    const httpsUrl = await listen(createHttpsServer(tlsOptions, (incoming, response) => {
      if (incoming.url === '/redirect') { response.writeHead(302, { Location: httpUrl }).end(); return }
      response.end('secure')
    }))
    const secureUrl = httpsUrl.replace('http://', 'https://')

    const secure = await executeApiTransport(request(secureUrl))
    assert.equal(secure.state, 'completed', JSON.stringify(secure))
    assert.equal(secure.hops[0]?.connection.tls?.authorized, true)
    assert.notEqual(secure.hops[0]?.connection.tls?.protocol, '')
    assert.notEqual(secure.hops[0]?.connection.tls?.cipher, '')
    /** 首跳各阶段必须互斥，阶段和不得重复计入 TLS 建链时间。 */
    const secureTimings = secure.hops[0]!.timings
    /** 收到响应头前可观测阶段的总耗时。 */
    const stagedTotal = [
      secureTimings.dnsMs,
      secureTimings.connectMs,
      secureTimings.tlsMs,
      secureTimings.sendMs,
      secureTimings.ttfbMs,
    ].reduce<number>((total, duration) => total + (duration ?? 0), 0)
    assert.ok(stagedTotal <= secureTimings.totalMs + 0.001, JSON.stringify(secureTimings))

    const downgrade = await executeApiTransport(request(`${secureUrl}/redirect`, { followRedirects: true }))
    assert.equal(downgrade.state, 'failed')
    assert.equal(downgrade.error?.code, 'API_REDIRECT_DOWNGRADE')
    assert.equal(downgraded, false)
  })

  test('Given 调用方取消，When 响应仍在流式输出，Then 返回前底层 socket 已关闭', async () => {
    const controller = new AbortController()
    let closed = false
    let resolveClosed!: () => void
    const serverObservedClose = new Promise<void>((resolve) => { resolveClosed = resolve })
    const baseUrl = await listen(createServer((incoming, response) => {
      incoming.socket.once('close', () => { closed = true; resolveClosed() })
      response.writeHead(200)
      response.write('partial')
    }))

    const result = await executeApiTransport(request(baseUrl), {
      signal: controller.signal,
      onDecodedChunk: () => { controller.abort() },
    })

    assert.equal(result.state, 'cancelled')
    assert.equal(result.body.preview, 'partial')
    assert.equal(result.body.complete, false)
    await serverObservedClose
    assert.equal(closed, true)
  })

  test('Given 未知 Content-Encoding，When 接收，Then 保留可读预览但不声称已解码', async () => {
    const baseUrl = await listen(createServer((_incoming, response) => {
      response.writeHead(200, { 'Content-Encoding': 'custom' })
      response.end('opaque but readable')
    }))

    const result = await executeApiTransport(request(baseUrl))

    assert.equal(result.state, 'completed')
    assert.equal(result.body.preview, 'opaque but readable')
    assert.equal(result.body.decoded, false)
    assert.equal(result.body.encoding, 'custom')
  })

  test('Given 二进制正文包含 NUL，When 接收，Then 有界预览保留字节投影且不声称解码', async () => {
    const binary = Buffer.from([65, 0, 66, 255])
    const baseUrl = await listen(createServer((_incoming, response) => {
      response.writeHead(200, { 'Content-Type': 'application/octet-stream' })
      response.end(binary)
    }))

    const result = await executeApiTransport(request(baseUrl))

    assert.equal(result.state, 'completed')
    assert.equal(Buffer.from(result.body.preview).subarray(0, 3).equals(Buffer.from([65, 0, 66])), true)
    assert.equal(result.body.decoded, false)
  })

  test('Given 响应 Header 大于 Node 默认值但小于 64 KiB，When 接收，Then 按工作台预算成功保留', async () => {
    const headerValue = 'a'.repeat(32 * 1024)
    const baseUrl = await listen(createServer((_incoming, response) => {
      response.writeHead(200, { 'X-Large': headerValue })
      response.end('ok')
    }))

    const result = await executeApiTransport(request(baseUrl))

    assert.equal(result.state, 'completed', JSON.stringify(result.error))
    assert.equal(result.hops[0]?.responseHeaders.find((header) => header.name === 'X-Large')?.value.length, headerValue.length)
  })

  test('Given 冲突长度、Transfer-Encoding 或 CRLF，When 发送，Then 在建链前拒绝', async () => {
    const invalidRequests: ApiResolvedRequest[] = [
      request('http://127.0.0.1:9', { method: 'POST', body: 'abc', headers: [{ name: 'Content-Length', value: '2' }] }),
      request('http://127.0.0.1:9', { headers: [{ name: 'Content-Length', value: '0' }, { name: 'content-length', value: '0' }] }),
      request('http://127.0.0.1:9', { headers: [{ name: 'Transfer-Encoding', value: 'chunked' }] }),
      request('http://127.0.0.1:9', { headers: [{ name: 'X-Test', value: 'ok\r\nInjected: yes' }] }),
    ]

    for (const invalid of invalidRequests) {
      const result = await executeApiTransport(invalid)
      assert.equal(result.state, 'failed')
      assert.equal(result.error?.phase, 'request')
    }
  })

  test('Given 事件流响应，When 逐帧到达，Then 回调保留帧事实并给出计数与首事件耗时', async () => {
    const baseUrl = await listen(createServer((_incoming, response) => {
      response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' })
      response.write(': keep-alive\n\n')
      response.write('event: delta\nid: 1\ndata: 第一段\n\n')
      response.write('data: 第二段\n\n')
      response.end()
    }))
    const received: ApiSseEvent[] = []

    const result = await executeApiTransport(request(baseUrl), { onSseEvent: (event) => { received.push(event) } })

    assert.equal(result.state, 'completed', JSON.stringify(result.error))
    assert.equal(received.length, 3)
    assert.equal(received[0]?.comment, 'keep-alive')
    assert.equal(received[1]?.event, 'delta')
    assert.equal(received[1]?.id, '1')
    assert.equal(received[1]?.data, '第一段')
    assert.deepEqual(received.map((event) => event.index), [0, 1, 2])
    assert.ok((received[2]?.receivedMs ?? -1) >= (received[1]?.receivedMs ?? 0))
    assert.equal(result.sse?.totalEvents, 3)
    assert.equal(result.sse?.endedReason, 'completed')
    assert.ok((result.sse?.firstEventMs ?? -1) >= 0)
  })

  test('Given 事件流中途取消，When 关闭连接，Then 保留已收到事件并标记取消', async () => {
    const controller = new AbortController()
    const baseUrl = await listen(createServer((_incoming, response) => {
      response.writeHead(200, { 'Content-Type': 'text/event-stream' })
      response.write('data: 第一帧\n\n')
      setTimeout(() => response.write('data: 第二帧\n\n'), 20)
    }))
    const received: ApiSseEvent[] = []

    const result = await executeApiTransport(request(baseUrl), {
      signal: controller.signal,
      onSseEvent: (event) => { received.push(event); controller.abort() },
    })

    assert.equal(result.state, 'cancelled')
    assert.equal(received.length, 1)
    assert.equal(received[0]?.data, '第一帧')
    assert.equal(result.sse?.totalEvents, 1)
    assert.equal(result.sse?.endedReason, 'cancelled')
  })

  test('Given 普通 JSON 响应，When 接收，Then 不产生事件流事实也不触发回调', async () => {
    const baseUrl = await listen(createServer((_incoming, response) => {
      response.writeHead(200, { 'Content-Type': 'application/json' })
      response.end('{"ok":true}')
    }))
    let calls = 0

    const result = await executeApiTransport(request(baseUrl), { onSseEvent: () => { calls += 1 } })

    assert.equal(result.state, 'completed')
    assert.equal(calls, 0)
    assert.equal(result.sse, undefined)
  })

  test('Given 分块边界切断多字节字符与帧，When 接收，Then 事件内容不乱码也不丢帧', async () => {
    const baseUrl = await listen(createServer((_incoming, response) => {
      response.writeHead(200, { 'Content-Type': 'text/event-stream' })
      /** 手动按字节切开 UTF-8 与帧边界，验证解码与分帧都能跨 chunk。 */
      const payload = Buffer.from('data: 中文内容\n\ndata: 后续\n\n', 'utf8')
      response.write(payload.subarray(0, 8))
      setTimeout(() => response.write(payload.subarray(8, 17)), 10)
      setTimeout(() => { response.write(payload.subarray(17)); response.end() }, 20)
    }))
    const received: ApiSseEvent[] = []

    const result = await executeApiTransport(request(baseUrl), { onSseEvent: (event) => { received.push(event) } })

    assert.equal(result.state, 'completed')
    assert.deepEqual(received.map((event) => event.data), ['中文内容', '后续'])
  })
})
