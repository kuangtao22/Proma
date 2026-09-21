import { readFileSync } from 'node:fs'
import { createServer as createTcpServer, type Server } from 'node:net'
import { createSecureContext, createServer as createTlsServer, TLSSocket } from 'node:tls'
import type { Server as TlsServer } from 'node:tls'

/** TLS fixture 一次 MySQL protocol packet 的解析结果。 */
interface MySqlPacket {
  sequenceId: number
  payload: Buffer
}

/** 运行时 TLS 夹具的监听信息与可观测计数。 */
interface MySqlTlsFixture {
  port: number
  authenticatedCount(): number
  versionQueryCount(): number
  close(): Promise<void>
}

/** Redis TLS 夹具的监听信息与 INFO 命令计数。 */
interface RedisTlsFixture {
  port: number
  infoCommandCount(): number
  close(): Promise<void>
}

/** 测试证书只用于本机 loopback TLS 协商，私钥不含用户或生产凭据。 */
const tlsFixtureCertificate = readFileSync(new URL('./fixtures/server-ops-tls-fixture-cert.pem', import.meta.url))
/** 测试私钥与上方公开证书配对，固定后使 TLS 回归测试可重复。 */
const tlsFixturePrivateKey = readFileSync(new URL('./fixtures/server-ops-tls-fixture-key.pem', import.meta.url))

/** 将 MySQL protocol payload 封装为含长度和 sequence id 的网络包。 */
function encodeMySqlPacket(sequenceId: number, payload: Buffer): Buffer {
  const header = Buffer.allocUnsafe(4)
  header.writeUIntLE(payload.length, 0, 3)
  header[3] = sequenceId
  return Buffer.concat([header, payload])
}

/** 从累计的网络字节中取出一个完整 MySQL packet；不足时保留原 buffer。 */
function takeMySqlPacket(buffer: Buffer): { packet: MySqlPacket | null; remaining: Buffer } {
  if (buffer.length < 4) return { packet: null, remaining: buffer }
  const length = buffer.readUIntLE(0, 3)
  if (buffer.length < length + 4) return { packet: null, remaining: buffer }
  return {
    packet: { sequenceId: buffer[3]!, payload: buffer.subarray(4, length + 4) },
    remaining: buffer.subarray(length + 4),
  }
}

/** 编码 MySQL length-encoded string，满足最小握手与结果集的字段格式。 */
function encodeMySqlLengthString(value: string): Buffer {
  const text = Buffer.from(value, 'utf8')
  if (text.length >= 251) throw new Error('TEST_MYSQL_TLS_FIELD_TOO_LONG')
  return Buffer.concat([Buffer.from([text.length]), text])
}

/** 构造 `SELECT VERSION()` 单列结果的 Field Definition packet。 */
function createMySqlVersionColumn(): Buffer {
  const charset = Buffer.allocUnsafe(2)
  charset.writeUInt16LE(45)
  const length = Buffer.allocUnsafe(4)
  length.writeUInt32LE(128)
  const flags = Buffer.allocUnsafe(2)
  flags.writeUInt16LE(0)
  return Buffer.concat([
    encodeMySqlLengthString('def'), encodeMySqlLengthString(''), encodeMySqlLengthString(''), encodeMySqlLengthString(''),
    encodeMySqlLengthString('version'), encodeMySqlLengthString('version'), Buffer.from([0x0c]), charset, length,
    Buffer.from([0xfd]), flags, Buffer.from([0, 0, 0]),
  ])
}

/** 在已认证 TLS stream 上写入版本查询的最小合法文本结果。 */
function writeMySqlTlsVersionResult(socket: TLSSocket): void {
  socket.write(encodeMySqlPacket(1, Buffer.from([1])))
  socket.write(encodeMySqlPacket(2, createMySqlVersionColumn()))
  socket.write(encodeMySqlPacket(3, Buffer.from([0xfe, 0, 0, 2, 0])))
  socket.write(encodeMySqlPacket(4, encodeMySqlLengthString('8.0.36-tls')))
  socket.write(encodeMySqlPacket(5, Buffer.from([0xfe, 0, 0, 2, 0])))
}

/** 构造声明 CLIENT_SSL 的 MySQL 初始握手；认证 token 仅为协议填充，不校验密码。 */
function createMySqlTlsHandshake(): Buffer {
  const capabilityFlags = 1 | 4 | 8 | 512 | 2_048 | 8_192 | 32_768 | 524_288
  const lowerCapabilities = Buffer.allocUnsafe(2)
  lowerCapabilities.writeUInt16LE(capabilityFlags & 0xffff)
  const upperCapabilities = Buffer.allocUnsafe(2)
  upperCapabilities.writeUInt16LE(capabilityFlags >>> 16)
  const connectionId = Buffer.allocUnsafe(4)
  connectionId.writeUInt32LE(1)
  const statusFlags = Buffer.allocUnsafe(2)
  statusFlags.writeUInt16LE(2)
  return Buffer.concat([
    Buffer.from([10]), Buffer.from('8.0.36-tls\0', 'utf8'), connectionId, Buffer.from('proma-tl'), Buffer.from([0]),
    lowerCapabilities, Buffer.from([45]), statusFlags, upperCapabilities, Buffer.from([21]), Buffer.alloc(10),
    Buffer.from('s-fixture-12'), Buffer.from([0]), Buffer.from('mysql_native_password\0', 'utf8'),
  ])
}

/** 启动仅覆盖 MySQL SSLRequest 升级、认证确认与 VERSION 查询的回环 TLS 服务。 */
export async function startMySqlTlsFixture(behavior: 'normal' | 'broken-tls' | 'auth-failed' | 'stall' = 'normal'): Promise<MySqlTlsFixture> {
  /** 认证回执数量用于证明 TLS 建连完成后才发送认证材料。 */
  let authenticated = 0
  /** 版本查询次数用于防止 preferred 回退后重放已发送的 SQL。 */
  let versionQueries = 0
  const secureContext = createSecureContext({ cert: tlsFixtureCertificate, key: tlsFixturePrivateKey })
  /** 清理路径追踪所有客户端，失败测试也不能遗留监听。 */
  const sockets = new Set<import('node:net').Socket>()
  const server: Server = createTcpServer((socket) => {
    sockets.add(socket)
    socket.once('close', () => { sockets.delete(socket) })
    /** 初始明文阶段只接受 mysql2 的 SSLRequest packet。 */
    let plainBuffer: Buffer = Buffer.alloc(0)
    const onPlainData = (chunk: Buffer): void => {
      plainBuffer = Buffer.concat([plainBuffer, chunk])
      const parsed = takeMySqlPacket(plainBuffer)
      if (parsed.packet === null) return
      plainBuffer = parsed.remaining
      /** SSLRequest 只有 32 字节 payload，且必须由 client sequence 1 发送。 */
      if (parsed.packet.sequenceId !== 1 || parsed.packet.payload.length !== 32) {
        socket.destroy()
        return
      }
      socket.pause()
      socket.off('data', onPlainData)
      if (behavior === 'broken-tls') { socket.end('this is not TLS'); return }
      if (behavior === 'stall') return
      if (plainBuffer.length > 0) socket.unshift(plainBuffer)
      /** TLS 包装从刚才已消费的 SSLRequest 之后继续读取，避免明文响应认证。 */
      const secureSocket = new TLSSocket(socket, { isServer: true, secureContext })
      let secureBuffer: Buffer = Buffer.alloc(0)
      let authenticatedThisConnection = false
      secureSocket.on('error', () => undefined)
      secureSocket.on('data', (chunk: Buffer) => {
        secureBuffer = Buffer.concat([secureBuffer, chunk])
        for (;;) {
          const next = takeMySqlPacket(secureBuffer)
          if (next.packet === null) return
          secureBuffer = next.remaining
          if (!authenticatedThisConnection) {
            /** HandshakeResponse 必须在 TLS 内出现，收到后才确认认证成功。 */
            if (next.packet.sequenceId !== 2 || next.packet.payload.length <= 32) {
              secureSocket.destroy()
              return
            }
            authenticatedThisConnection = true
            authenticated += 1
            if (behavior === 'auth-failed') {
              /** MySQL ERR 1045，证明认证失败不会触发 preferred 明文回退。 */
              secureSocket.write(encodeMySqlPacket(3, Buffer.concat([Buffer.from([0xff, 0x15, 0x04]), Buffer.from('#28000Denied')])))
              return
            }
            /** OK packet 的 server sequence 为 3，完成 mysql2 connect promise。 */
            secureSocket.write(encodeMySqlPacket(3, Buffer.from([0, 0, 0, 2, 0, 0, 0])))
            continue
          }
          /** COM_QUERY 的首字节为 3；fixture 只允许 runtime 的版本探测语句。 */
          const command = next.packet.payload[0]
          const sql = next.packet.payload.subarray(1).toString('utf8')
          if (command === 3 && sql === 'SELECT VERSION() AS version') {
            versionQueries += 1
            writeMySqlTlsVersionResult(secureSocket)
            continue
          }
          secureSocket.destroy()
          return
        }
      })
      secureSocket.resume()
    }
    socket.on('error', () => undefined)
    socket.on('data', onPlainData)
    socket.write(encodeMySqlPacket(0, createMySqlTlsHandshake()))
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('TEST_MYSQL_TLS_FIXTURE_ADDRESS_MISSING')
  return {
    port: address.port,
    authenticatedCount: () => authenticated,
    versionQueryCount: () => versionQueries,
    close: () => new Promise<void>((resolve) => {
      for (const socket of sockets) socket.destroy()
      server.close(() => resolve())
    }),
  }
}

/** 启动最小回环 Redis TLS 服务，只接受 runtime 探测使用的 INFO 命令。 */
export async function startRedisTlsFixture(): Promise<RedisTlsFixture> {
  /** 实际收到 INFO 的次数，用于证明驱动确实已在 TLS 上完成协议读取。 */
  let infoCommands = 0
  const server: TlsServer = createTlsServer({ cert: tlsFixtureCertificate, key: tlsFixturePrivateKey }, (secureSocket) => {
    /** Redis 连接一建立即 TLS；它没有 MySQL 式的 SSLRequest 升级包。 */
    let commandBuffer = ''
    secureSocket.on('error', () => undefined)
    secureSocket.on('data', (chunk: Buffer) => {
      commandBuffer += chunk.toString('utf8')
      if (!commandBuffer.includes('INFO\r\n')) return
      infoCommands += 1
      commandBuffer = ''
      /** INFO 的最小 RESP bulk string，足以让 runtime 读出 redis_version。 */
      const info = '# Server\r\nredis_version:7.2.4\r\n'
      secureSocket.write(`$${Buffer.byteLength(info)}\r\n${info}\r\n`)
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('TEST_REDIS_TLS_FIXTURE_ADDRESS_MISSING')
  return {
    port: address.port,
    infoCommandCount: () => infoCommands,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}
