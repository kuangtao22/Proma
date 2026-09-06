import { describe, expect, test } from 'bun:test'
import {
  SERVER_OPS_IPC_CHANNELS,
  isServerOpsAuditRecord,
  isServerOpsHostList,
  parseServerOpsLogExportInput,
  parseServerOpsLogExportResult,
  parseServerOpsLogExitEvent,
  parseServerOpsLogIdentity,
  parseServerOpsLogOutputAck,
  parseServerOpsLogOutputEvent,
  parseServerOpsLogStartInput,
  parseServerOpsLogStartResult,
  parseServerOpsOverviewInput,
  parseServerOpsOverviewResult,
  parseServerOpsServiceActionInput,
  parseServerOpsServiceActionResult,
  parseServerOpsServiceDetailInput,
  parseServerOpsServiceDetailResult,
  parseServerOpsServiceListInput,
  parseServerOpsServiceListResult,
  parseServerOpsSystemdUnitId,
  parseServerOpsConnectInput,
  parseServerOpsHostInput,
  parseServerOpsSaveHostInput,
  parseServerOpsAgentAccessInput,
  parseServerOpsAuditListInput,
  parseServerOpsAuditListResult,
} from './server-ops'
import type { ServerOpsAuditRecord, ServerOpsOverviewResult } from './server-ops'

describe('服务器运维共享合同', () => {
  test('严格解析 Agent 服务器授权合同并拒绝未知字段或非法 ID', () => {
    expect(parseServerOpsAgentAccessInput({ sessionId: 'session-1', hostId: 'host-1', granted: true }))
      .toEqual({ sessionId: 'session-1', hostId: 'host-1', granted: true })
    expect(() => parseServerOpsAgentAccessInput({ sessionId: 'session-1', hostId: 'host-1', granted: true, extra: 1 })).toThrow()
    expect(() => parseServerOpsAgentAccessInput({ sessionId: 'session.1', hostId: 'host-1', granted: true })).toThrow()
    expect(() => parseServerOpsAgentAccessInput({ sessionId: 'session-1', hostId: 'host-1', granted: 'yes' })).toThrow()
  })

  test('规范化合法 Linux SSH 主机输入', () => {
    expect(parseServerOpsHostInput({
      name: '  生产 API  ',
      address: '  10.0.0.8  ',
      port: 22,
      username: '  deploy  ',
      authMethod: 'ssh-agent',
      tags: [' 生产 ', 'api', '生产'],
    })).toEqual({
      name: '生产 API',
      address: '10.0.0.8',
      port: 22,
      username: 'deploy',
      authMethod: 'ssh-agent',
      tags: ['生产', 'api'],
    })
  })

  test('公开主机合同支持密码认证且不接收私钥路径', () => {
    expect(parseServerOpsHostInput({
      name: '数据库',
      address: 'db.internal',
      port: 2222,
      username: 'ops',
      authMethod: 'private-key',
      tags: [],
    })).toMatchObject({
      authMethod: 'private-key',
    })

    expect(() => parseServerOpsHostInput({
      name: '数据库',
      address: 'db.internal',
      port: 22,
      username: 'ops',
      authMethod: 'private-key',
      keyPath: '/Users/demo/.ssh/id_ed25519',
      tags: [],
    })).toThrow('SERVER_OPS_HOST_INPUT_INVALID')

    expect(parseServerOpsHostInput({
      name: '密码主机',
      address: '10.0.0.9',
      port: 22,
      username: 'root',
      authMethod: 'password',
      tags: [],
    }).authMethod).toBe('password')
  })

  test('连接请求严格解析一次性凭据和终端尺寸', () => {
    expect(parseServerOpsConnectInput({
      hostId: 'host-1',
      cols: 120,
      rows: 36,
      credential: {
        kind: 'password',
        password: 'secret-canary',
        remember: false,
      },
    })).toEqual({
      hostId: 'host-1',
      cols: 120,
      rows: 36,
      credential: {
        kind: 'password',
        password: 'secret-canary',
        remember: false,
      },
    })

    expect(() => parseServerOpsConnectInput({
      hostId: 'host-1',
      cols: 0,
      rows: 36,
    })).toThrow('SERVER_OPS_TERMINAL_SIZE_INVALID')
    expect(() => parseServerOpsConnectInput({
      hostId: 'host-1',
      cols: 80,
      rows: 24,
      credential: { kind: 'password', password: 'secret', remember: false, leak: true },
    })).toThrow('SERVER_OPS_CREDENTIAL_INPUT_INVALID')
  })

  test('服务器保存请求把公开主机字段与持久化凭据变更分离', () => {
    expect(parseServerOpsSaveHostInput({
      host: {
        name: ' 生产 API ',
        address: '10.0.0.8',
        port: 22,
        username: 'deploy',
        authMethod: 'password',
        tags: [],
      },
      credentialUpdate: {
        action: 'replace',
        credential: { kind: 'password', password: 'password-canary' },
      },
    })).toEqual({
      host: {
        name: '生产 API',
        address: '10.0.0.8',
        port: 22,
        username: 'deploy',
        authMethod: 'password',
        tags: [],
      },
      credentialUpdate: {
        action: 'replace',
        credential: { kind: 'password', password: 'password-canary' },
      },
    })

    expect(parseServerOpsSaveHostInput({
      host: {
        id: 'host-1',
        name: '生产 API',
        address: '10.0.0.8',
        port: 22,
        username: 'deploy',
        authMethod: 'private-key',
        tags: [],
      },
      credentialUpdate: { action: 'keep' },
    }).credentialUpdate).toEqual({ action: 'keep' })

    expect(parseServerOpsSaveHostInput({
      host: {
        name: 'Agent 主机',
        address: '10.0.0.9',
        port: 22,
        username: 'deploy',
        authMethod: 'ssh-agent',
        tags: [],
      },
      credentialUpdate: { action: 'clear' },
    }).credentialUpdate).toEqual({ action: 'clear' })
  })

  test('服务器保存请求拒绝缺失、错配和越界的凭据变更', () => {
    /** 新建密码服务器的公开字段。 */
    const passwordHost = {
      name: '生产 API',
      address: '10.0.0.8',
      port: 22,
      username: 'deploy',
      authMethod: 'password',
      tags: [],
    } as const

    expect(() => parseServerOpsSaveHostInput({
      host: passwordHost,
      credentialUpdate: { action: 'keep' },
    })).toThrow('SERVER_OPS_CREDENTIAL_REQUIRED')
    expect(() => parseServerOpsSaveHostInput({
      host: passwordHost,
      credentialUpdate: {
        action: 'replace',
        credential: { kind: 'private-key', keyPath: '~/.ssh/id_ed25519' },
      },
    })).toThrow('SERVER_OPS_CREDENTIAL_METHOD_MISMATCH')
    expect(() => parseServerOpsSaveHostInput({
      host: passwordHost,
      credentialUpdate: {
        action: 'replace',
        credential: { kind: 'password', password: 'password-canary', remember: true },
      },
    })).toThrow('SERVER_OPS_CREDENTIAL_INPUT_INVALID')
    expect(() => parseServerOpsSaveHostInput({
      host: passwordHost,
      credentialUpdate: { action: 'replace', credential: { kind: 'password', password: 'password-canary' } },
      password: 'leak',
    })).toThrow('SERVER_OPS_HOST_INPUT_INVALID')
  })

  test('拒绝越界端口、未知字段和密码字段', () => {
    const baseInput = {
      name: '生产 API',
      address: '10.0.0.8',
      username: 'deploy',
      authMethod: 'ssh-agent',
      tags: [],
    } as const

    expect(() => parseServerOpsHostInput({ ...baseInput, port: 0 })).toThrow('SERVER_OPS_HOST_PORT_INVALID')
    expect(() => parseServerOpsHostInput({ ...baseInput, port: 65_536 })).toThrow('SERVER_OPS_HOST_PORT_INVALID')
    expect(() => parseServerOpsHostInput({ ...baseInput, port: 22, password: 'secret' })).toThrow('SERVER_OPS_HOST_INPUT_INVALID')
  })

  test('主机列表校验要求完整持久化字段且不允许凭据', () => {
    const host = {
      id: 'host-1',
      name: '生产 API',
      address: '10.0.0.8',
      port: 22,
      username: 'deploy',
      authMethod: 'ssh-agent',
      tags: ['生产'],
      createdAt: 1_000,
      updatedAt: 2_000,
    }

    expect(isServerOpsHostList([host])).toBe(true)
    expect(isServerOpsHostList([{ ...host, password: 'secret' }])).toBe(false)
    expect(isServerOpsHostList([{ ...host, updatedAt: -1 }])).toBe(false)
  })

  test('IPC 通道保持在独立 server-ops 命名空间', () => {
    expect(SERVER_OPS_IPC_CHANNELS).toEqual({
      LIST_HOSTS: 'server-ops:list-hosts',
      UPSERT_HOST: 'server-ops:upsert-host',
      DELETE_HOST: 'server-ops:delete-host',
      CONNECT: 'server-ops:connect',
      CONFIRM_HOST_KEY: 'server-ops:confirm-host-key',
      DISCONNECT: 'server-ops:disconnect',
      WRITE_TERMINAL: 'server-ops:write-terminal',
      RESIZE_TERMINAL: 'server-ops:resize-terminal',
      ACK_TERMINAL_OUTPUT: 'server-ops:ack-terminal-output',
      TERMINAL_SNAPSHOT: 'server-ops:terminal-snapshot',
      CONNECTION_STATE: 'server-ops:connection-state',
      TERMINAL_OUTPUT: 'server-ops:terminal-output',
      TERMINAL_EXIT: 'server-ops:terminal-exit',
      GET_AGENT_ACCESS: 'server-ops:get-agent-access',
      SET_AGENT_ACCESS: 'server-ops:set-agent-access',
      REVOKE_AGENT_ACCESS_SESSION: 'server-ops:revoke-agent-access-session',
      AGENT_ACCESS_CHANGED: 'server-ops:agent-access-changed',
      LIST_AUDIT: 'server-ops:list-audit',
      GET_OVERVIEW: 'server-ops:get-overview',
      LIST_SERVICES: 'server-ops:list-services',
      GET_SERVICE_DETAIL: 'server-ops:get-service-detail',
      RUN_SERVICE_ACTION: 'server-ops:run-service-action',
      START_LOG_STREAM: 'server-ops:start-log-stream',
      STOP_LOG_STREAM: 'server-ops:stop-log-stream',
      ACK_LOG_OUTPUT: 'server-ops:ack-log-output',
      LOG_OUTPUT: 'server-ops:log-output',
      LOG_EXIT: 'server-ops:log-exit',
      EXPORT_LOG: 'server-ops:export-log',
    })
  })

  test('Given 合法概览快照 When preload 解析 Then 返回深拷贝且拒绝内部连接字段', () => {
    /** 主进程返回的最小合法概览。 */
    const input: ServerOpsOverviewResult = {
      hostId: 'host-1',
      capturedAt: 1,
      sampleWindowMs: 250,
      system: { hostname: 'edge-1', osName: 'Ubuntu', osVersion: '24.04', kernel: '6.8.0', arch: 'x86_64', uptimeSeconds: 10 },
      cpu: { cores: 4, usagePercent: 12.5, load1: 0.1, load5: 0.2, load15: 0.3 },
      memory: { totalBytes: 1024, usedBytes: 512, availableBytes: 512, cacheBytes: 128 },
      swap: { totalBytes: 0, usedBytes: 0 },
      filesystems: [{ device: '/dev/sda1', mountPoint: '/', filesystem: 'ext4', totalBytes: 1024, usedBytes: 512, availableBytes: 512, usagePercent: 50 }],
      network: { receiveBytesPerSecond: 10, transmitBytesPerSecond: 20 },
      processes: [{ pid: 1, name: 'systemd', cpuPercent: 0.1, memoryPercent: 0.2 }],
      warnings: ['CPU_PARTIAL', 'CPU_PARTIAL'],
    }
    /** 经过合同解析的独立概览快照。 */
    const parsed = parseServerOpsOverviewResult(input)
    expect(parsed).toEqual({ ...input, warnings: ['CPU_PARTIAL'] })
    expect(parsed).not.toBe(input)
    expect(parsed.filesystems).not.toBe(input.filesystems)
    expect(parsed.filesystems[0]).not.toBe(input.filesystems[0])
    expect(parsed.processes).not.toBe(input.processes)
    expect(parsed.system).not.toBe(input.system)
    expect(parseServerOpsOverviewInput({ hostId: 'host-1' })).toEqual({ hostId: 'host-1' })
    expect(() => parseServerOpsOverviewInput({ hostId: 'host-1', generation: 1 })).toThrow('SERVER_OPS_OVERVIEW_INPUT_INVALID')
    expect(() => parseServerOpsOverviewResult({ ...input, connectionId: 'secret' })).toThrow('SERVER_OPS_OVERVIEW_RESULT_INVALID')
    expect(() => parseServerOpsOverviewResult({ ...input, filesystems: Array.from({ length: 129 }, () => input.filesystems[0]) })).toThrow('SERVER_OPS_OVERVIEW_RESULT_INVALID')
    expect(() => parseServerOpsOverviewResult({ ...input, processes: Array.from({ length: 11 }, () => input.processes[0]) })).toThrow('SERVER_OPS_OVERVIEW_RESULT_INVALID')
    expect(() => parseServerOpsOverviewResult({ ...input, cpu: { ...input.cpu, usagePercent: 100.1 } })).toThrow('SERVER_OPS_OVERVIEW_RESULT_INVALID')
    expect(() => parseServerOpsOverviewResult({ ...input, memory: { ...input.memory, usedBytes: -1 } })).toThrow('SERVER_OPS_OVERVIEW_RESULT_INVALID')
    expect(parseServerOpsOverviewResult({ ...input, processes: [{ ...input.processes[0]!, cpuPercent: 250 }] }).processes[0]?.cpuPercent).toBe(250)
    expect(() => parseServerOpsOverviewResult({ ...input, processes: [{ ...input.processes[0]!, cpuPercent: 6_553_600.1 }] })).toThrow('SERVER_OPS_OVERVIEW_RESULT_INVALID')
  })

  test('Given systemd unit 含注入、路径或非法转义 When 解析 Then fail closed', () => {
    for (const unitId of ['nginx.service;reboot', '../nginx.service', String.raw`bad\q.service`, 'nginx.socket', 'white space.service']) {
      expect(() => parseServerOpsSystemdUnitId(unitId)).toThrow('SERVER_OPS_SYSTEMD_UNIT_INVALID')
      expect(() => parseServerOpsServiceDetailInput({ hostId: 'host-1', unitId })).toThrow('SERVER_OPS_SYSTEMD_UNIT_INVALID')
    }
    expect(parseServerOpsServiceDetailInput({ hostId: 'host-1', unitId: String.raw`dbus-\x2dapi.service` })).toEqual({
      hostId: 'host-1', unitId: String.raw`dbus-\x2dapi.service`,
    })
    expect(() => parseServerOpsSystemdUnitId(`${'a'.repeat(249)}.service`)).toThrow('SERVER_OPS_SYSTEMD_UNIT_INVALID')
  })

  test('Given 服务列表、详情和动作 When 解析 Then exact keys 与资源上限生效', () => {
    /** 合法的最小 systemd 服务摘要。 */
    const service = {
      unitId: 'nginx.service', description: 'Web server', loadState: 'loaded', activeState: 'active', subState: 'running',
      enabled: true, mainPid: 42, activeSince: '2026-09-05 10:00:00 CST',
    } as const
    expect(parseServerOpsServiceListInput({ hostId: 'host-1' })).toEqual({ hostId: 'host-1' })
    expect(parseServerOpsServiceListResult({ hostId: 'host-1', capability: 'available', services: [service], warnings: [] }))
      .toEqual({ hostId: 'host-1', capability: 'available', services: [service], warnings: [] })
    expect(parseServerOpsServiceDetailResult({ hostId: 'host-1', capability: 'available', service, statusLines: ['ok'], recentLogLines: ['ready'], warnings: [] }))
      .toMatchObject({ hostId: 'host-1', service })
    expect(parseServerOpsServiceActionInput({ sessionId: 'session-1', hostId: 'host-1', unitId: 'nginx.service', action: 'restart' }))
      .toEqual({ sessionId: 'session-1', hostId: 'host-1', unitId: 'nginx.service', action: 'restart' })
    expect(parseServerOpsServiceActionResult({ hostId: 'host-1', unitId: 'nginx.service', action: 'restart', service, warnings: [] }))
      .toMatchObject({ hostId: 'host-1', unitId: 'nginx.service', action: 'restart' })
    expect(() => parseServerOpsServiceListInput({ hostId: 'host-1', filter: 'all' })).toThrow('SERVER_OPS_SERVICE_LIST_INPUT_INVALID')
    expect(() => parseServerOpsServiceListResult({ hostId: 'host-1', capability: 'available', services: Array.from({ length: 1_001 }, () => service), warnings: [] })).toThrow('SERVER_OPS_SERVICE_LIST_RESULT_INVALID')
    expect(() => parseServerOpsServiceDetailResult({ hostId: 'host-1', capability: 'available', service, statusLines: Array.from({ length: 201 }, () => 'ok'), recentLogLines: [], warnings: [] })).toThrow('SERVER_OPS_SERVICE_DETAIL_RESULT_INVALID')
    expect(() => parseServerOpsServiceActionInput({ sessionId: 'session-1', hostId: 'host-1', unitId: 'nginx.service', action: 'reload' })).toThrow('SERVER_OPS_SERVICE_ACTION_INPUT_INVALID')
    expect(() => parseServerOpsServiceActionResult({ hostId: 'host-1', unitId: 'nginx.service', action: 'restart', warnings: [], connectionId: 'secret' })).toThrow('SERVER_OPS_SERVICE_ACTION_RESULT_INVALID')
    expect(() => parseServerOpsServiceActionResult({
      hostId: 'host-1', unitId: 'nginx.service', action: 'restart', warnings: [], service: { ...service, unitId: 'redis.service' },
    })).toThrow('SERVER_OPS_SERVICE_ACTION_RESULT_INVALID')
  })

  test('Given 日志筛选、ACK 和导出内容 When 解析 Then 应用枚举与 UTF-8 资源上限', () => {
    expect(parseServerOpsLogStartInput({
      hostId: 'host-1', source: { kind: 'unit', unitId: 'nginx.service' }, since: '1h', priority: 'warning', tailLines: 200,
    })).toEqual({ hostId: 'host-1', source: { kind: 'unit', unitId: 'nginx.service' }, since: '1h', priority: 'warning', tailLines: 200 })
    expect(parseServerOpsLogStartResult({ hostId: 'host-1', streamId: 'stream-1' })).toEqual({ hostId: 'host-1', streamId: 'stream-1' })
    expect(parseServerOpsLogIdentity({ hostId: 'host-1', streamId: 'stream-1' })).toEqual({ hostId: 'host-1', streamId: 'stream-1' })
    expect(parseServerOpsLogOutputAck({ hostId: 'host-1', streamId: 'stream-1', sequence: 0 })).toEqual({ hostId: 'host-1', streamId: 'stream-1', sequence: 0 })
    expect(parseServerOpsLogOutputEvent({ hostId: 'host-1', streamId: 'stream-1', sequence: 1, data: '日志' })).toMatchObject({ sequence: 1, data: '日志' })
    expect(parseServerOpsLogExitEvent({ hostId: 'host-1', streamId: 'stream-1', reason: 'stopped' })).toEqual({ hostId: 'host-1', streamId: 'stream-1', reason: 'stopped' })
    expect(parseServerOpsLogExportResult({ saved: true })).toEqual({ saved: true })
    expect(() => parseServerOpsLogStartInput({ hostId: 'host-1', source: { kind: 'system' }, since: 'forever', priority: 'debug', tailLines: 200 })).toThrow('SERVER_OPS_LOG_START_INPUT_INVALID')
    expect(() => parseServerOpsLogStartInput({ hostId: 'host-1', source: { kind: 'system' }, since: '15m', priority: 'verbose', tailLines: 200 })).toThrow('SERVER_OPS_LOG_START_INPUT_INVALID')
    expect(() => parseServerOpsLogStartInput({ hostId: 'host-1', source: { kind: 'system' }, since: '15m', priority: 'debug', tailLines: 2_001 })).toThrow('SERVER_OPS_LOG_START_INPUT_INVALID')
    expect(() => parseServerOpsLogOutputEvent({ hostId: 'host-1', streamId: 'stream-1', sequence: 1, data: '你'.repeat(10_923) })).toThrow('SERVER_OPS_LOG_OUTPUT_INVALID')
    expect(() => parseServerOpsLogOutputAck({ hostId: 'host-1', streamId: 'stream-1', sequence: -1 })).toThrow('SERVER_OPS_LOG_ACK_INVALID')
    expect(() => parseServerOpsLogExportInput({ hostId: 'host-1', content: '你'.repeat(699_051) })).toThrow('SERVER_OPS_LOG_EXPORT_INPUT_INVALID')
    expect(() => parseServerOpsLogExportInput({ hostId: 'host-1', content: 'x'.repeat(2 * 1_024 * 1_024 + 1) })).toThrow('SERVER_OPS_LOG_EXPORT_INPUT_INVALID')
    expect(() => parseServerOpsLogExportInput({ hostId: 'host-1', content: 'x', generation: 1 })).toThrow('SERVER_OPS_LOG_EXPORT_INPUT_INVALID')
  })

  test('Given Agent 与用户服务记录 When 校验审计 v2 Then actor、筛选和 operation 必须匹配', () => {
    /** 合法用户服务动作记录。 */
    const serviceRecord: ServerOpsAuditRecord = {
      id: 'audit-1', timestamp: 1, sessionId: 'session-1', hostId: 'host-1', actor: 'user',
      operation: 'service-restart', unitId: 'nginx.service', phase: 'result', outcome: 'success', durationMs: 20,
    }
    expect(isServerOpsAuditRecord(serviceRecord)).toBe(true)
    expect(isServerOpsAuditRecord({ ...serviceRecord, command: 'systemctl restart nginx' })).toBe(false)
    expect(isServerOpsAuditRecord({ ...serviceRecord, actor: 'agent' })).toBe(false)
    expect(isServerOpsAuditRecord({ ...serviceRecord, unitId: undefined })).toBe(false)
    expect(isServerOpsAuditRecord({ ...serviceRecord, exitCode: 0 })).toBe(false)
    expect(isServerOpsAuditRecord({ ...serviceRecord, signal: 'SIGTERM' })).toBe(false)
    expect(isServerOpsAuditRecord({ ...serviceRecord, operation: 'exec', actor: 'user', command: 'id', commandTruncated: false })).toBe(false)
    expect(isServerOpsAuditRecord({ ...serviceRecord, operation: 'connect', actor: 'agent', unitId: undefined })).toBe(true)
    expect(parseServerOpsAuditListInput({ actor: 'user', operation: 'service-restart' })).toEqual({ actor: 'user', operation: 'service-restart' })
    expect(() => parseServerOpsAuditListInput({ actor: 'user', operation: 'exec' })).toThrow('SERVER_OPS_AUDIT_LIST_INPUT_INVALID')
  })

  test('审计列表输入严格筛选 host、operation 与 5000 条上限', () => {
    expect(parseServerOpsAuditListInput({ hostId: 'host-1', operation: 'exec', limit: 100 }))
      .toEqual({ hostId: 'host-1', operation: 'exec', limit: 100 })
    expect(parseServerOpsAuditListInput({})).toEqual({})
    expect(() => parseServerOpsAuditListInput({ operation: 'shell' })).toThrow('SERVER_OPS_AUDIT_LIST_INPUT_INVALID')
    expect(() => parseServerOpsAuditListInput({ limit: 5_001 })).toThrow('SERVER_OPS_AUDIT_LIST_INPUT_INVALID')
    expect(() => parseServerOpsAuditListInput({ limit: 1, extra: true })).toThrow('SERVER_OPS_AUDIT_LIST_INPUT_INVALID')
  })

  test('审计列表结果拒绝输出、连接标识和越界字符串', () => {
    const record = {
      id: 'audit-1', timestamp: 1, sessionId: 'session-1', hostId: 'host-1',
      actor: 'agent',
      operation: 'exec', phase: 'result', outcome: 'success', durationMs: 20,
      command: 'echo ok', exitCode: 0,
      commandTruncated: false,
    } as const
    expect(parseServerOpsAuditListResult({ records: [record] })).toEqual({ records: [record] })
    expect(() => parseServerOpsAuditListResult({ records: [{ ...record, stdout: 'leak' }] })).toThrow('SERVER_OPS_AUDIT_LIST_RESULT_INVALID')
    expect(() => parseServerOpsAuditListResult({ records: [{ ...record, connectionId: 'connection-1' }] })).toThrow('SERVER_OPS_AUDIT_LIST_RESULT_INVALID')
    expect(() => parseServerOpsAuditListResult({ records: [{ ...record, command: 'x'.repeat(513) }] })).toThrow('SERVER_OPS_AUDIT_LIST_RESULT_INVALID')
    expect(() => parseServerOpsAuditListResult({ records: [{ ...record, timestamp: Number.MAX_SAFE_INTEGER }] })).toThrow('SERVER_OPS_AUDIT_LIST_RESULT_INVALID')
    expect(() => parseServerOpsAuditListResult({ records: [{ ...record, resultCode: '0' }] })).toThrow('SERVER_OPS_AUDIT_LIST_RESULT_INVALID')
    const { commandTruncated: _flag, ...missingFlag } = record
    expect(() => parseServerOpsAuditListResult({ records: [missingFlag] })).toThrow('SERVER_OPS_AUDIT_LIST_RESULT_INVALID')
    expect(() => parseServerOpsAuditListResult({ records: [{ ...record, command: 'short', commandTruncated: true }] })).toThrow('SERVER_OPS_AUDIT_LIST_RESULT_INVALID')
    expect(() => parseServerOpsAuditListResult({ records: [{ ...record, command: undefined, commandTruncated: false }] })).toThrow('SERVER_OPS_AUDIT_LIST_RESULT_INVALID')
  })

  test('审计结果严格区分退出码、signal 与稳定错误码，并校验 outcome 语义', () => {
    const base = {
      id: 'audit-1', timestamp: 1, sessionId: 'session-1', hostId: 'host-1',
      actor: 'agent',
      operation: 'exec', phase: 'result', durationMs: 20,
      command: 'run task', commandTruncated: false,
    } as const

    expect(parseServerOpsAuditListResult({ records: [{ ...base, outcome: 'success', exitCode: 0 }] }).records[0])
      .toMatchObject({ outcome: 'success', exitCode: 0 })
    expect(parseServerOpsAuditListResult({ records: [{ ...base, outcome: 'error', exitCode: 23 }] }).records[0])
      .toMatchObject({ outcome: 'error', exitCode: 23 })
    expect(parseServerOpsAuditListResult({ records: [{ ...base, outcome: 'error', signal: 'SIGTERM' }] }).records[0])
      .toMatchObject({ outcome: 'error', signal: 'SIGTERM' })
    expect(parseServerOpsAuditListResult({ records: [{ ...base, outcome: 'error', errorCode: 'SERVER_OPS_EXEC_TRANSPORT_FAILED' }] }).records[0])
      .toMatchObject({ outcome: 'error', errorCode: 'SERVER_OPS_EXEC_TRANSPORT_FAILED' })
    expect(() => parseServerOpsAuditListResult({ records: [{ ...base, outcome: 'success', exitCode: 2 }] }))
      .toThrow('SERVER_OPS_AUDIT_LIST_RESULT_INVALID')
    expect(() => parseServerOpsAuditListResult({ records: [{ ...base, outcome: 'success', signal: 'SIGTERM' }] }))
      .toThrow('SERVER_OPS_AUDIT_LIST_RESULT_INVALID')
    expect(() => parseServerOpsAuditListResult({ records: [{ ...base, outcome: 'success', errorCode: 'REMOTE_FAILED' }] }))
      .toThrow('SERVER_OPS_AUDIT_LIST_RESULT_INVALID')
  })
})
