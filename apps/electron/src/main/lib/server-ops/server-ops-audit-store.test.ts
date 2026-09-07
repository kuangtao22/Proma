import { describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  getServerOpsAuditErrorCode,
  ServerOpsAuditStore as ProductionServerOpsAuditStore,
  sanitizeServerOpsAuditCommand,
} from './server-ops-audit-store'
import type { ServerOpsAuditStoreDependencies } from './server-ops-audit-store'

interface Deferred<T> {
  promise: Promise<T>
  resolve: (value: T) => void
}

/** 创建可控 Promise，用于验证异步旧实例 guard 等待期间的权威重读。 */
function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((nextResolve) => { resolve = nextResolve })
  return { promise, resolve }
}

/** Store 单元测试复用已独立验证的事务合同，只隔离原生 addon 装载。 */
class ServerOpsAuditStore extends ProductionServerOpsAuditStore {
  constructor(configDir?: string, dependencies: Partial<ServerOpsAuditStoreDependencies> = {}) {
    super(configDir, { transaction: (callback) => callback(), ...dependencies })
  }
}

/** 创建隔离的 Proma 配置根，避免测试读写真实用户审计文件。 */
function createConfigDir(): string {
  return mkdtempSync(join(tmpdir(), 'proma-server-ops-audit-'))
}

describe('Server Ops Agent 审计 Store', () => {
  test('Given 命令包含多种秘密 When 脱敏 Then 先全量脱敏再截断到 512 字符', () => {
    const command = `${'x'.repeat(500)} --token secret-after-boundary password=hunter2 https://example.test?a=1&api_key=url-secret Authorization: Bearer bearer-secret`
    const sanitized = sanitizeServerOpsAuditCommand(command)

    expect(sanitized.length).toBeLessThanOrEqual(512)
    expect(sanitized).not.toMatch(/secret-after-boundary|hunter2|url-secret|bearer-secret/)
    expect(sanitizeServerOpsAuditCommand('curl --pass phrase --api-key=abc -token xyz')).not.toMatch(/phrase|abc|xyz/)
  })

  test('Given secret key 经过引号或 shell 拼接 When 脱敏 Then 统一词法分类且不保留 payload 秘密', () => {
    /** 覆盖 quoted flag、拼接 flag、拼接赋值和 JSON data payload 的真实反例。 */
    const command = [
      'curl "--password" "hunter2"',
      'curl --pa"ss"word=joined-secret',
      'PA"SS"WORD=env-secret env',
      `curl -d '{"password":"json-secret"}' https://x`,
    ].join('\n')
    /** 统一 shell word 扫描后的公开命令摘要。 */
    const sanitized = sanitizeServerOpsAuditCommand(command)

    expect(sanitized).not.toMatch(/hunter2|joined-secret|env-secret|json-secret/)
  })

  test('Given Authorization header 使用独立、同词或反斜杠拼接 When 脱敏 Then 完整 header word 不泄漏秘密', () => {
    /** 覆盖 curl header 参数的 quoted、joined 与 escaped 三种真实反例。 */
    const command = [
      'curl -H "Authorization: Bearer header-secret" https://x',
      "curl --header='Authorization: Bearer joined-header-secret' https://x",
      'curl -H Authorization:Bearer\\ header-escaped-secret https://x',
    ].join('\n')
    /** 统一 shell word 扫描后的公开命令摘要。 */
    const sanitized = sanitizeServerOpsAuditCommand(command)

    expect(sanitized).not.toMatch(/header-secret|joined-header-secret|header-escaped-secret/)
  })

  test('Given 常见 CLI 使用专用认证参数 When 脱敏 Then 参数值和凭据文件路径均不进入审计', () => {
    /** 覆盖 curl、sshpass 与 redis-cli 的短参数、长参数及等号形式。 */
    const command = [
      'curl -u admin:curl-short-secret https://x',
      'curl -uadmin:curl-attached-secret https://x',
      'curl -u"admin:curl-quoted-attached-secret" https://x',
      'curl --user admin:curl-long-secret https://x',
      'curl --user=admin:curl-equals-secret https://x',
      'sshpass -p sshpass-short-secret ssh deploy@host',
      'sshpass -psshpass-attached-secret ssh deploy@host',
      'sshpass -f /Users/alice/private/sshpass-secret.txt ssh deploy@host',
      'sshpass -f/Users/alice/private/sshpass-attached-secret.txt ssh deploy@host',
      'SSHPASS=sshpass-env-secret sshpass -e ssh deploy@host',
      'redis-cli -a redis-short-secret PING',
      'redis-cli -aredis-attached-secret PING',
      'redis-cli --pass redis-long-secret PING',
      'redis-cli --pass=redis-equals-secret PING',
      'custom-cli --db-password db-password-secret --auth-token auth-token-secret --client-secret=client-secret-value',
      'ssh -p 2222 deploy@host',
    ].join('\n')
    /** 对完整命令统一生成公开审计摘要。 */
    const sanitized = sanitizeServerOpsAuditCommand(command)

    expect(sanitized).not.toMatch(/curl-short-secret|curl-attached-secret|curl-quoted-attached-secret|curl-long-secret|curl-equals-secret/)
    expect(sanitized).not.toMatch(/sshpass-short-secret|sshpass-attached-secret|sshpass-secret|sshpass-env-secret|alice/)
    expect(sanitized).not.toMatch(/redis-short-secret|redis-attached-secret|redis-long-secret|redis-equals-secret/)
    expect(sanitized).not.toMatch(/db-password-secret|auth-token-secret|client-secret-value/)
    expect(sanitizeServerOpsAuditCommand('ssh -p 2222 deploy@host')).toBe('ssh -p 2222 deploy@host')

    /** 同一命令进入真实 Store 后也不得在 JSON 中保留粘连凭据。 */
    const configDir = createConfigDir()
    const store = new ServerOpsAuditStore(configDir, { uuid: () => 'audit-attached', now: () => 1 })
    store.append({
      actor: 'agent', sessionId: 'session-1', hostId: 'host-1', operation: 'exec', phase: 'start', outcome: 'success', command,
    })
    expect(readFileSync(join(configDir, 'server-ops', 'audit.json'), 'utf8'))
      .not.toMatch(/curl-attached-secret|curl-quoted-attached-secret|sshpass-attached-secret|redis-attached-secret/)
  })

  test('Given 未知错误 code 或 message 含秘密 When 生成审计错误码 Then 一律返回稳定通用码', () => {
    expect(getServerOpsAuditErrorCode(Object.assign(new Error('message-secret'), { code: 'VENDOR_secret_canary' })))
      .toBe('SERVER_OPS_REMOTE_OPERATION_FAILED')
    expect(getServerOpsAuditErrorCode(new Error('SERVER_OPS_SECRET_CANARY')))
      .toBe('SERVER_OPS_REMOTE_OPERATION_FAILED')
    expect(getServerOpsAuditErrorCode({ code: 'SERVER_OPS_EXEC_TIMEOUT' })).toBe('SERVER_OPS_EXEC_TIMEOUT')
  })

  test('Given URI userinfo、环境变量、heredoc、重定向和私钥路径 When 写审计 Then 文件不保留秘密或完整路径', () => {
    const configDir = createConfigDir()
    const store = new ServerOpsAuditStore(configDir, { uuid: () => 'audit-1', now: () => 1 })
    const command = [
      'DATABASE_URL=postgres://db-user:uri-secret@db.internal/app NORMAL_VALUE=env-secret',
      'curl https://deploy:uri-direct-secret@example.test/status',
      "cat <<'PRIVATE_EOF' > /Users/alice/private/output.txt",
      'heredoc-secret-content',
      'PRIVATE_EOF',
      'cat <<< redirect-secret-content',
      'ssh -i /Users/alice/.ssh/id_ed25519 host.internal',
      'inspect-key /opt/secrets/server-private.pem',
      'inspect-key /home/alice/.ssh/custom_private_key',
    ].join('\n')

    const record = store.append({
      actor: 'agent', sessionId: 'session-1', hostId: 'host-1', operation: 'exec', phase: 'start', outcome: 'success', command,
    })
    const persisted = readFileSync(join(configDir, 'server-ops', 'audit.json'), 'utf8')

    expect(record.command).toContain('[REDACTED]')
    expect(persisted).not.toMatch(/uri-secret|uri-direct-secret|env-secret|heredoc-secret-content|redirect-secret-content/)
    expect(persisted).not.toContain('/Users/alice/private/output.txt')
    expect(persisted).not.toContain('/Users/alice/.ssh/id_ed25519')
    expect(persisted).not.toContain('/opt/secrets/server-private.pem')
    expect(persisted).not.toContain('/home/alice/.ssh/custom_private_key')
  })

  test('Given heredoc 标签含标点或引号 When 写审计 Then 正文秘密被保守整段脱敏', () => {
    const configDir = createConfigDir()
    const store = new ServerOpsAuditStore(configDir, { uuid: () => 'audit-1', now: () => 1 })
    const command = [
      "cat <<'END-MARKER'",
      'quoted-heredoc-secret',
      'END-MARKER',
      'cat <<EOF.SECRET',
      'dotted-heredoc-secret',
      'EOF.SECRET',
    ].join('\n')

    store.append({
      actor: 'agent', sessionId: 'session-1', hostId: 'host-1', operation: 'exec', phase: 'start', outcome: 'success', command,
    })
    const persisted = readFileSync(join(configDir, 'server-ops', 'audit.json'), 'utf8')

    expect(persisted).not.toMatch(/quoted-heredoc-secret|dotted-heredoc-secret/)
  })

  test('Given 同一命令行声明多个 heredoc When 写审计 Then 按声明顺序脱敏全部正文', () => {
    /** 隔离本用例的 Proma 配置根。 */
    const configDir = createConfigDir()
    /** 使用确定 ID 与时间的审计 Store。 */
    const store = new ServerOpsAuditStore(configDir, { uuid: () => 'audit-1', now: () => 1 })
    /** 两个 heredoc 正文按 shell 声明顺序紧随命令行。 */
    const command = [
      'cat <<FIRST <<SECOND',
      'first-secret',
      'FIRST',
      'second-secret',
      'SECOND',
    ].join('\n')

    store.append({
      actor: 'agent', sessionId: 'session-1', hostId: 'host-1', operation: 'exec', phase: 'start', outcome: 'success', command,
    })
    /** 原子文件中最终持久化的公开审计文本。 */
    const persisted = readFileSync(join(configDir, 'server-ops', 'audit.json'), 'utf8')

    expect(persisted).not.toMatch(/first-secret|second-secret/)
  })

  test('Given 同一命令行混合引号标点与 strip-tabs heredoc When 写审计 Then 全部正文不泄漏', () => {
    /** 隔离本用例的 Proma 配置根。 */
    const configDir = createConfigDir()
    /** 使用确定 ID 与时间的审计 Store。 */
    const store = new ServerOpsAuditStore(configDir, { uuid: () => 'audit-1', now: () => 1 })
    /** 混合复杂 delimiter 与 `<<-` tab 结束边界的命令。 */
    const command = [
      "cat <<'FIRST-MARK' <<-SECOND.PART",
      'quoted-first-secret',
      'FIRST-MARK',
      '\tstrip-tabs-second-secret',
      '\tSECOND.PART',
    ].join('\n')

    store.append({
      actor: 'agent', sessionId: 'session-1', hostId: 'host-1', operation: 'exec', phase: 'start', outcome: 'success', command,
    })
    /** 原子文件中最终持久化的公开审计文本。 */
    const persisted = readFileSync(join(configDir, 'server-ops', 'audit.json'), 'utf8')

    expect(persisted).not.toMatch(/quoted-first-secret|strip-tabs-second-secret/)
  })

  test('Given shell word 使用反斜杠空格 When 写审计 Then 环境值、重定向路径和私钥路径不泄漏任何残片', () => {
    const configDir = createConfigDir()
    const store = new ServerOpsAuditStore(configDir, { uuid: () => 'audit-1', now: () => 1 })
    const command = [
      'FOO=top\\ secret env',
      'cat > /Users/alice/private\\ output/redirect-secret.txt',
      'ssh -i /Users/alice/.ssh/id\\ ed25519 host.internal',
    ].join('\n')

    store.append({
      actor: 'agent', sessionId: 'session-1', hostId: 'host-1', operation: 'exec', phase: 'start', outcome: 'success', command,
    })
    const persisted = readFileSync(join(configDir, 'server-ops', 'audit.json'), 'utf8')

    expect(persisted).not.toMatch(/top|secret|private|output|redirect|alice|ed25519/)
  })

  test('Given 脱敏后摘要是否超过 512 字符 When 写审计 Then Store 计算 commandTruncated 且覆盖伪造值', () => {
    const configDir = createConfigDir()
    let uuid = 0
    const store = new ServerOpsAuditStore(configDir, { uuid: () => `audit-${++uuid}`, now: () => uuid })

    const shortRecord = store.append({
      actor: 'agent', sessionId: 'session-1', hostId: 'host-1', operation: 'exec', phase: 'start', outcome: 'success',
      command: 'echo ok', commandTruncated: true,
    } as never)
    const exactRecord = store.append({
      actor: 'agent', sessionId: 'session-1', hostId: 'host-1', operation: 'exec', phase: 'start', outcome: 'success', command: 'x'.repeat(512),
    })
    const longRecord = store.append({
      actor: 'agent', sessionId: 'session-1', hostId: 'host-1', operation: 'exec', phase: 'start', outcome: 'success', command: 'x'.repeat(513),
    })

    expect(shortRecord.commandTruncated).toBe(false)
    expect(exactRecord.commandTruncated).toBe(false)
    expect(longRecord.command).toHaveLength(512)
    expect(longRecord.commandTruncated).toBe(true)
  })

  test('Given 可写空 Store When 追加超过上限 Then 固定保留最近 5000 条并返回深拷贝', () => {
    const configDir = createConfigDir()
    const directory = join(configDir, 'server-ops')
    mkdirSync(directory, { recursive: true })
    let now = 1
    let uuid = 0
    /** 直接准备上限快照，只用两次真实追加验证 rotation，避免 O(n²) 测试写盘。 */
    const initialRecords = Array.from({ length: 5_000 }, (_, index) => ({
      id: `initial-${index}`, timestamp: index, sessionId: 'session-1', hostId: 'host-1', actor: 'agent',
      operation: 'exec', phase: 'start', outcome: 'pending', command: `echo ${index}`, commandTruncated: false,
    }))
    writeFileSync(join(directory, 'audit.json'), JSON.stringify({ version: 3, records: initialRecords }))
    const store = new ServerOpsAuditStore(configDir, {
      now: () => now++,
      uuid: () => `audit-${++uuid}`,
    })
    store.append({ actor: 'agent', sessionId: 'session-1', hostId: 'host-1', operation: 'exec', phase: 'start', outcome: 'success', command: 'echo new-1' })
    store.append({ actor: 'agent', sessionId: 'session-1', hostId: 'host-1', operation: 'exec', phase: 'start', outcome: 'success', command: 'echo new-2' })

    const records = store.list({ limit: 5_000 }).records
    expect(records).toHaveLength(5_000)
    expect(records[0]?.id).toBe('initial-2')
    records[0]!.command = 'mutated'
    expect(store.list({ limit: 5_000 }).records[0]?.command).not.toBe('mutated')
    expect(JSON.parse(readFileSync(join(directory, 'audit.json'), 'utf8'))).toMatchObject({ version: 3 })
  })

  test('Given 默认写入依赖 When 追加记录 Then 使用版本 3 原子 JSON 文件', () => {
    const configDir = createConfigDir()
    const store = new ServerOpsAuditStore(configDir, { uuid: () => 'audit-1', now: () => 1 })

    store.append({ actor: 'agent', sessionId: 'session-1', hostId: 'host-1', operation: 'connect', phase: 'start', outcome: 'success' })

    expect(JSON.parse(readFileSync(join(configDir, 'server-ops', 'audit.json'), 'utf8'))).toMatchObject({ version: 3 })
  })

  test('Given strict Store 尚未准备且审计文件不存在 When 直接追加 Then 拒绝且不创建文件', () => {
    const configDir = createConfigDir()
    const filePath = join(configDir, 'server-ops', 'audit.json')
    const store = new ServerOpsAuditStore(configDir, { requirePreparedSchema: true })

    expect(() => store.append({
      actor: 'agent', sessionId: 'session-1', hostId: 'host-1',
      operation: 'connect', phase: 'start', outcome: 'pending',
    })).toThrow('SERVER_OPS_AUDIT_SCHEMA_NOT_PREPARED')
    expect(existsSync(filePath)).toBe(false)
  })

  test.each([1, 2] as const)('Given strict Store 面对 v%s 文件 When 直接追加 Then 拒绝且不升级', (version) => {
    const configDir = createConfigDir()
    const directory = join(configDir, 'server-ops')
    const filePath = join(directory, 'audit.json')
    mkdirSync(directory, { recursive: true })
    const content = JSON.stringify({ version, records: [] })
    writeFileSync(filePath, content)
    const store = new ServerOpsAuditStore(configDir, { requirePreparedSchema: true })

    expect(() => store.append({
      actor: 'agent', sessionId: 'session-1', hostId: 'host-1',
      operation: 'connect', phase: 'start', outcome: 'pending',
    })).toThrow('SERVER_OPS_AUDIT_SCHEMA_NOT_PREPARED')
    expect(readFileSync(filePath, 'utf8')).toBe(content)
  })

  test('Given v1 文件且 guard 正在等待 When 另一方追加旧记录 Then prepare fresh-read 后完整迁移为 v3', async () => {
    const configDir = createConfigDir()
    const directory = join(configDir, 'server-ops')
    const filePath = join(directory, 'audit.json')
    mkdirSync(directory, { recursive: true })
    writeFileSync(filePath, JSON.stringify({ version: 1, records: [] }))
    const acquired = createDeferred<void>()
    const store = new ServerOpsAuditStore(configDir, { requirePreparedSchema: true })

    const preparing = store.prepareForWrites(async () => {
      await acquired.promise
      return () => {}
    })
    writeFileSync(filePath, JSON.stringify({ version: 1, records: [{
      id: 'audit-legacy', timestamp: 1, sessionId: 'session-1', hostId: 'host-1',
      operation: 'connect', phase: 'result', outcome: 'success',
    }] }))
    acquired.resolve()
    await preparing

    expect(JSON.parse(readFileSync(filePath, 'utf8'))).toMatchObject({
      version: 3,
      records: [{ id: 'audit-legacy', actor: 'agent', operation: 'connect' }],
    })
  })

  test('Given guard 等待期间另一方已升级 v3 When prepare 获准 Then 不重复写文件', async () => {
    const configDir = createConfigDir()
    const directory = join(configDir, 'server-ops')
    const filePath = join(directory, 'audit.json')
    mkdirSync(directory, { recursive: true })
    writeFileSync(filePath, JSON.stringify({ version: 2, records: [] }))
    const acquired = createDeferred<void>()
    let writes = 0
    const store = new ServerOpsAuditStore(configDir, {
      requirePreparedSchema: true,
      writeJson: () => { writes += 1 },
    })

    const preparing = store.prepareForWrites(async () => {
      await acquired.promise
      return () => {}
    })
    writeFileSync(filePath, JSON.stringify({ version: 3, records: [] }))
    acquired.resolve()
    await preparing

    expect(writes).toBe(0)
    expect(JSON.parse(readFileSync(filePath, 'utf8')).version).toBe(3)
  })

  test('Given schema 迁移已提交但 guard release 失败 When prepare 返回 Then 已提交事实仍可继续追加', async () => {
    const configDir = createConfigDir()
    const directory = join(configDir, 'server-ops')
    const filePath = join(directory, 'audit.json')
    mkdirSync(directory, { recursive: true })
    writeFileSync(filePath, JSON.stringify({ version: 2, records: [] }))
    const store = new ServerOpsAuditStore(configDir, {
      requirePreparedSchema: true,
      uuid: () => 'audit-1',
      now: () => 1,
    })

    await expect(store.prepareForWrites(async () => () => { throw new Error('release failed') })).resolves.toBeUndefined()
    expect(() => store.append({
      actor: 'agent', sessionId: 'session-1', hostId: 'host-1',
      operation: 'connect', phase: 'start', outcome: 'pending',
    })).not.toThrow()
    expect(JSON.parse(readFileSync(filePath, 'utf8'))).toMatchObject({ version: 3, records: [{ id: 'audit-1' }] })
  })

  test('Given 损坏或未知版本文件 When 构造 Store Then 保留原文件并以稳定错误阻断 list 与 append', () => {
    for (const content of ['{broken', JSON.stringify({ version: 4, records: [] })]) {
      const configDir = createConfigDir()
      const directory = join(configDir, 'server-ops')
      const filePath = join(directory, 'audit.json')
      mkdirSync(directory, { recursive: true })
      writeFileSync(filePath, content)

      const store = new ServerOpsAuditStore(configDir)

      expect(() => store.list({})).toThrow('SERVER_OPS_AUDIT_READ_FAILED')
      expect(() => store.append({ actor: 'agent', sessionId: 'session-1', hostId: 'host-1', operation: 'connect', phase: 'start', outcome: 'success' }))
        .toThrow('SERVER_OPS_AUDIT_READ_FAILED')
      expect(readFileSync(filePath, 'utf8')).toBe(content)
      expect(existsSync(`${filePath}.bak`)).toBe(false)
    }
  })

  test('Given 主审计文件损坏但备份有效 When 构造 Store Then 不用备份覆盖坏文件且仍阻断操作', () => {
    const configDir = createConfigDir()
    const directory = join(configDir, 'server-ops')
    const filePath = join(directory, 'audit.json')
    mkdirSync(directory, { recursive: true })
    writeFileSync(filePath, '{broken-primary')
    writeFileSync(`${filePath}.bak`, JSON.stringify({ version: 2, records: [] }))

    const store = new ServerOpsAuditStore(configDir)

    expect(() => store.list()).toThrow('SERVER_OPS_AUDIT_READ_FAILED')
    expect(readFileSync(filePath, 'utf8')).toBe('{broken-primary')
  })

  test('Given 公开审计输入包含输出或秘密字段 When 追加 Then 严格拒绝且不写盘', () => {
    const configDir = createConfigDir()
    const store = new ServerOpsAuditStore(configDir)
    const unsafe = {
      actor: 'agent', sessionId: 'session-1', hostId: 'host-1', operation: 'exec', phase: 'result', outcome: 'success',
      stdout: 'secret output', credentialRef: 'credential-1', connectionId: 'connection-1', candidateId: 'candidate-1',
    } as const

    expect(() => store.append(unsafe)).toThrow('SERVER_OPS_AUDIT_RECORD_INVALID')
  })

  test('Given 合法 v1 审计文件 When 加载 Then 只读迁移并补 actor=agent', () => {
    const configDir = createConfigDir()
    const directory = join(configDir, 'server-ops')
    const filePath = join(directory, 'audit.json')
    mkdirSync(directory, { recursive: true })
    writeFileSync(filePath, JSON.stringify({
      version: 1,
      records: [{
        id: 'audit-1', timestamp: 1, sessionId: 'session-1', hostId: 'host-1',
        operation: 'connect', phase: 'result', outcome: 'success', durationMs: 10,
      }],
    }))

    const store = new ServerOpsAuditStore(configDir)

    expect(store.list().records).toEqual([{
      id: 'audit-1', timestamp: 1, sessionId: 'session-1', hostId: 'host-1', actor: 'agent',
      operation: 'connect', phase: 'result', outcome: 'success', durationMs: 10,
    }])
    expect(JSON.parse(readFileSync(filePath, 'utf8')).version).toBe(1)
  })

  test('Given 合法 v2 审计文件 When 加载 Then 直接返回已有主体记录', () => {
    const configDir = createConfigDir()
    const directory = join(configDir, 'server-ops')
    mkdirSync(directory, { recursive: true })
    writeFileSync(join(directory, 'audit.json'), JSON.stringify({
      version: 2,
      records: [{
        id: 'audit-2', timestamp: 2, sessionId: 'session-1', hostId: 'host-1', actor: 'user',
        unitId: 'nginx.service', operation: 'service-restart', phase: 'result', outcome: 'success', durationMs: 20,
      }],
    }))

    expect(new ServerOpsAuditStore(configDir).list().records[0]).toMatchObject({
      id: 'audit-2', actor: 'user', operation: 'service-restart', unitId: 'nginx.service',
    })
  })

  test('Given 合法 v2 主文件 When 构造 Store Then 不提前迁移或改写文件', () => {
    const configDir = createConfigDir()
    const directory = join(configDir, 'server-ops')
    mkdirSync(directory, { recursive: true })
    const filePath = join(directory, 'audit.json')
    const raw = JSON.stringify({ version: 2, records: [] })
    writeFileSync(filePath, raw)

    const store = new ServerOpsAuditStore(configDir)

    expect(store.list()).toEqual({ records: [] })
    expect(readFileSync(filePath, 'utf8')).toBe(raw)
  })

  test('Given v2 记录缺 actor 或含未知字段 When 加载 Then 保留主文件并 fail closed', () => {
    const validRecord = {
      id: 'audit-2', timestamp: 2, sessionId: 'session-1', hostId: 'host-1', actor: 'agent',
      operation: 'connect', phase: 'result', outcome: 'success',
    } as const
    const invalidRecords = [
      { id: 'audit-2', timestamp: 2, sessionId: 'session-1', hostId: 'host-1', operation: 'connect', phase: 'result', outcome: 'success' },
      { ...validRecord, stdout: 'secret' },
    ]

    for (const record of invalidRecords) {
      const configDir = createConfigDir()
      const directory = join(configDir, 'server-ops')
      const filePath = join(directory, 'audit.json')
      mkdirSync(directory, { recursive: true })
      const content = JSON.stringify({ version: 2, records: [record] })
      writeFileSync(filePath, content)

      expect(() => new ServerOpsAuditStore(configDir).list()).toThrow('SERVER_OPS_AUDIT_READ_FAILED')
      expect(readFileSync(filePath, 'utf8')).toBe(content)
    }
  })

  test('Given v1 记录含非法字段、actor 或服务动作 When 加载 Then 逐条严格拒绝', () => {
    const legacyBase = {
      id: 'audit-1', timestamp: 1, sessionId: 'session-1', hostId: 'host-1',
      operation: 'connect', phase: 'result', outcome: 'success',
    } as const
    const invalidRecords = [
      { ...legacyBase, stdout: 'secret' },
      { ...legacyBase, actor: 'agent' },
      { ...legacyBase, operation: 'service-restart', unitId: 'nginx.service' },
    ]

    for (const record of invalidRecords) {
      const configDir = createConfigDir()
      const directory = join(configDir, 'server-ops')
      mkdirSync(directory, { recursive: true })
      writeFileSync(join(directory, 'audit.json'), JSON.stringify({ version: 1, records: [record] }))

      expect(() => new ServerOpsAuditStore(configDir).list()).toThrow('SERVER_OPS_AUDIT_READ_FAILED')
    }
  })

  test('Given v1 只读迁移 When 首次追加升级 v3 写失败 Then 保留旧文件并持续 fail closed', () => {
    const configDir = createConfigDir()
    const directory = join(configDir, 'server-ops')
    mkdirSync(directory, { recursive: true })
    writeFileSync(join(directory, 'audit.json'), JSON.stringify({ version: 1, records: [] }))
    const store = new ServerOpsAuditStore(configDir, {
      writeJson: () => { throw new Error('disk failure') },
    })

    expect(store.list()).toEqual({ records: [] })
    expect(() => store.append({
      actor: 'agent', sessionId: 'session-1', hostId: 'host-1',
      operation: 'connect', phase: 'start', outcome: 'success',
    })).toThrow('SERVER_OPS_AUDIT_WRITE_FAILED')
    expect(JSON.parse(readFileSync(join(directory, 'audit.json'), 'utf8')).version).toBe(1)
  })

  test('Given append 原子替换后 durability 同步失败 When 再次访问 Then 保留磁盘新记录并持续 fail closed', () => {
    const configDir = createConfigDir()
    const filePath = join(configDir, 'server-ops', 'audit.json')
    let writeCount = 0
    const store = new ServerOpsAuditStore(configDir, {
      uuid: () => 'audit-1',
      now: () => 1,
      writeJson: (_targetPath, data) => {
        writeCount += 1
        writeFileSync(filePath, JSON.stringify(data))
        throw new Error('directory sync failed')
      },
    })

    expect(() => store.append({
      actor: 'agent', sessionId: 'session-1', hostId: 'host-1',
      operation: 'connect', phase: 'start', outcome: 'success',
    })).toThrow('SERVER_OPS_AUDIT_WRITE_FAILED')
    const persistedAfterFailure = readFileSync(filePath, 'utf8')
    expect(JSON.parse(persistedAfterFailure)).toMatchObject({
      version: 3,
      records: [{ id: 'audit-1', actor: 'agent', operation: 'connect' }],
    })
    expect(() => store.list()).toThrow('SERVER_OPS_AUDIT_WRITE_FAILED')
    expect(() => store.append({
      actor: 'agent', sessionId: 'session-1', hostId: 'host-1',
      operation: 'disconnect', phase: 'start', outcome: 'success',
    })).toThrow('SERVER_OPS_AUDIT_WRITE_FAILED')
    expect(writeCount).toBe(1)
    expect(readFileSync(filePath, 'utf8')).toBe(persistedAfterFailure)
  })

  test('Given 用户重启服务 When 追加开始和结果 Then 只持久化结构化服务字段', () => {
    const configDir = createConfigDir()
    let uuid = 0
    const store = new ServerOpsAuditStore(configDir, { uuid: () => `audit-${++uuid}`, now: () => uuid })
    store.append({
      actor: 'user', sessionId: 'session-1', hostId: 'host-1', unitId: 'nginx.service',
      operation: 'service-restart', phase: 'start', outcome: 'success',
    })
    store.append({
      actor: 'user', sessionId: 'session-1', hostId: 'host-1', unitId: 'nginx.service',
      operation: 'service-restart', phase: 'result', outcome: 'error', durationMs: 20,
      errorCode: 'SERVER_OPS_SERVICE_ACTION_FAILED',
    })

    const persisted = JSON.parse(readFileSync(join(configDir, 'server-ops', 'audit.json'), 'utf8')) as {
      version: number
      records: Array<Record<string, unknown>>
    }
    expect(persisted.version).toBe(3)
    expect(Object.keys(persisted.records[1]!).sort()).toEqual([
      'actor', 'durationMs', 'errorCode', 'hostId', 'id', 'operation', 'outcome',
      'phase', 'sessionId', 'timestamp', 'unitId',
    ])
    expect(JSON.stringify(persisted)).not.toMatch(/command|stdout|stderr|connectionId/)
  })

  test('Given 多主体多主机记录 When 按 actor、host、operation 和 limit 查询 Then 组合筛选后取最近记录', () => {
    const configDir = createConfigDir()
    let uuid = 0
    const store = new ServerOpsAuditStore(configDir, { uuid: () => `audit-${++uuid}`, now: () => uuid })
    store.append({ actor: 'agent', sessionId: 'session-1', hostId: 'host-1', operation: 'connect', phase: 'start', outcome: 'success' })
    store.append({ actor: 'user', sessionId: 'session-1', hostId: 'host-1', unitId: 'nginx.service', operation: 'service-restart', phase: 'start', outcome: 'success' })
    store.append({ actor: 'user', sessionId: 'session-1', hostId: 'host-2', unitId: 'redis.service', operation: 'service-restart', phase: 'start', outcome: 'success' })
    store.append({ actor: 'user', sessionId: 'session-1', hostId: 'host-1', unitId: 'nginx.service', operation: 'service-restart', phase: 'result', outcome: 'success', durationMs: 5 })
    store.append({ actor: 'agent', sessionId: 'session-1', hostId: 'host-1', operation: 'disconnect', phase: 'result', outcome: 'success', durationMs: 6 })

    expect(store.list({ actor: 'user', hostId: 'host-1', limit: 1 }).records)
      .toMatchObject([{ id: 'audit-4', actor: 'user', hostId: 'host-1', operation: 'service-restart' }])
    expect(store.list({ actor: 'user', hostId: 'host-1', operation: 'service-restart', limit: 1 }).records)
      .toMatchObject([{ id: 'audit-4', actor: 'user', hostId: 'host-1', operation: 'service-restart' }])
  })

  test('Given 下一阶段稳定错误码 When 生成审计错误码 Then 允许公开且未知值继续降级', () => {
    const codes = [
      'SERVER_OPS_CONNECTION_CHANGED',
      'SERVER_OPS_SYSTEMD_UNSUPPORTED',
      'SERVER_OPS_SYSTEMD_PERMISSION_DENIED',
      'SERVER_OPS_SYSTEMD_OUTPUT_INVALID',
      'SERVER_OPS_SERVICE_ACTION_FAILED',
      'SERVER_OPS_SERVICE_ACTION_UNKNOWN',
      'SERVER_OPS_DOCKER_ACTION_FAILED',
      'SERVER_OPS_DOCKER_ACTION_UNKNOWN',
      'SERVER_OPS_AUDIT_READ_FAILED',
      'SERVER_OPS_AUDIT_WRITE_FAILED',
    ]

    expect(codes.map((code) => getServerOpsAuditErrorCode({ code }))).toEqual(codes)
    expect(getServerOpsAuditErrorCode({ code: 'SERVER_OPS_UNKNOWN_INTERNAL' }))
      .toBe('SERVER_OPS_REMOTE_OPERATION_FAILED')
  })

  test('Given 用户重启 Docker 容器 When 追加审计 Then 持久化窗口、完整容器身份与操作配对', () => {
    const configDir = createConfigDir()
    let uuid = 0
    const store = new ServerOpsAuditStore(configDir, { uuid: () => `audit-${++uuid}`, now: () => uuid })
    /** 同一次容器动作的稳定操作身份。 */
    const operationId = 'docker-operation-1'
    /** Docker 只接受完整容器 ID。 */
    const containerId = 'a'.repeat(64)
    store.append({ actor: 'user', operationId, windowId: 7, hostId: 'host-1', resourceType: 'docker-container',
      containerId, operation: 'docker-restart', phase: 'start', outcome: 'pending' })
    store.append({ actor: 'user', operationId, windowId: 7, hostId: 'host-1', resourceType: 'docker-container',
      containerId, operation: 'docker-restart', phase: 'result', outcome: 'unknown', durationMs: 30_000,
      errorCode: 'SERVER_OPS_DOCKER_ACTION_UNKNOWN' })

    expect(store.list({ operation: 'docker-restart' }).records).toMatchObject([
      { operationId, windowId: 7, containerId, phase: 'start', outcome: 'pending' },
      { operationId, windowId: 7, containerId, phase: 'result', outcome: 'unknown' },
    ])
    expect(() => store.append({ actor: 'user', operationId: 'docker-operation-2', windowId: 7, hostId: 'host-1',
      resourceType: 'docker-container', containerId: 'web-1', operation: 'docker-stop', phase: 'start', outcome: 'pending' }))
      .toThrow('SERVER_OPS_AUDIT_RECORD_INVALID')
  })

  test('Given 两个已构造审计 Store When 依次追加 Then fresh-read 保留双方记录并关联 operationId', () => {
    const configDir = createConfigDir()
    let nextId = 0
    const transaction = <T>(callback: () => T): T => callback()
    const first = new ServerOpsAuditStore(configDir, { transaction, uuid: () => `audit-${++nextId}`, now: () => nextId })
    const second = new ServerOpsAuditStore(configDir, { transaction, uuid: () => `audit-${++nextId}`, now: () => nextId })

    first.append({ actor: 'agent', sessionId: 'session-1', hostId: 'host-1', operationId: 'operation-1', operation: 'connect', phase: 'start', outcome: 'pending' })
    second.append({ actor: 'agent', sessionId: 'session-2', hostId: 'host-2', operationId: 'operation-2', operation: 'connect', phase: 'start', outcome: 'success' })

    expect(first.list().records).toMatchObject([
      { id: 'audit-1', operationId: 'operation-1', outcome: 'pending' },
      { id: 'audit-2', operationId: 'operation-2', outcome: 'pending' },
    ])
    expect(JSON.parse(readFileSync(join(configDir, 'server-ops', 'audit.json'), 'utf8')).version).toBe(3)
  })

  test('Given v1 与 v2 旧审计 When 只读加载 Then 内存归一 start 且不改写原文件', () => {
    for (const legacy of [
      { version: 1, records: [{ id: 'audit-1', timestamp: 1, sessionId: 'session-1', hostId: 'host-1', operation: 'connect', phase: 'start', outcome: 'success' }] },
      { version: 2, records: [{ id: 'audit-2', timestamp: 2, sessionId: 'legacy-user-session', hostId: 'host-1', actor: 'user', operation: 'service-stop', unitId: 'nginx.service', phase: 'start', outcome: 'success' }] },
    ]) {
      const configDir = createConfigDir()
      const opsDir = join(configDir, 'server-ops')
      const filePath = join(opsDir, 'audit.json')
      mkdirSync(opsDir, { recursive: true })
      const raw = JSON.stringify(legacy)
      writeFileSync(filePath, raw)

      const record = new ServerOpsAuditStore(configDir, { transaction: (callback) => callback() }).list().records[0]

      expect(record?.outcome).toBe('pending')
      expect(record?.sessionId).toBe(legacy.version === 1 ? 'session-1' : 'legacy-user-session')
      expect(record?.operationId).toBeUndefined()
      expect(readFileSync(filePath, 'utf8')).toBe(raw)
    }
  })

  test('Given 新用户信任操作 When 追加开始与未知结果 Then 使用窗口来源且禁止伪造 session', () => {
    const configDir = createConfigDir()
    let nextId = 0
    const store = new ServerOpsAuditStore(configDir, {
      transaction: (callback) => callback(), uuid: () => `audit-${++nextId}`, now: () => nextId,
    })
    store.append({
      actor: 'user', windowId: 9, hostId: 'host-1', operationId: 'operation-1', operation: 'trust-replace',
      resourceType: 'host-trust', phase: 'start', outcome: 'pending',
    })
    store.append({
      actor: 'user', windowId: 9, hostId: 'host-1', operationId: 'operation-1', operation: 'trust-replace',
      resourceType: 'host-trust', phase: 'result', outcome: 'unknown', durationMs: 10,
    })

    expect(store.list().records).toMatchObject([
      { operationId: 'operation-1', windowId: 9, outcome: 'pending' },
      { operationId: 'operation-1', windowId: 9, outcome: 'unknown' },
    ])
    expect(() => store.append({
      actor: 'user', sessionId: 'session-1', hostId: 'host-1', operationId: 'operation-2', operation: 'trust-revoke',
      resourceType: 'host-trust', phase: 'start', outcome: 'pending',
    } as never)).toThrow('SERVER_OPS_AUDIT_RECORD_INVALID')
  })
})
