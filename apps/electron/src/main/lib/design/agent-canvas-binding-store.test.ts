import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentCanvasBinding } from '@proma/shared'
import type { AtomicFileState } from '../safe-file'
import { writeJsonFileAtomicSecure } from '../safe-file'
import { AgentCanvasBindingStore } from './agent-canvas-binding-store'

/** 测试配置文件的固定虚拟路径，不访问真实用户目录。 */
const CONFIG_PATH = '/tmp/proma-agent-canvas-binding-store.json'
/** 真实 safe-file 测试创建的临时目录，结束后统一清理。 */
const temporaryDirectories: string[] = []

/** 测试写入调用，保留每次原子提交的深拷贝。 */
interface WriteCall {
  path: string
  value: object
}

/** 为纯内存 Store fixture 构造可比较的 CAS 文件状态。 */
function createTestFileState(value: unknown, revision = 1): AtomicFileState {
  return {
    dev: 1,
    ino: 1,
    size: JSON.stringify(value).length,
    mtimeMs: revision,
    ctimeMs: revision,
  }
}

/** 创建纯内存依赖，稳定验证读取、写入与 no-op 行为。 */
function createHarness(initial: unknown = null, nowValues: number[] = [100]) {
  /** 模拟磁盘当前 JSON 值。 */
  let diskValue = initial
  /** 原子写入调用历史。 */
  const writes: WriteCall[] = []
  /** 当前时间读取位置。 */
  let nowIndex = 0
  /** 模拟每次原子提交后的文件状态版本。 */
  let diskRevision = 1
  /** 供测试使用的 Store。 */
  const store = new AgentCanvasBindingStore({
    configPath: CONFIG_PATH,
    now: () => nowValues[Math.min(nowIndex++, nowValues.length - 1)] ?? 0,
    readState: () => diskValue === null ? null : createTestFileState(diskValue, diskRevision),
    readFile: () => JSON.stringify(diskValue),
    readJson: () => diskValue,
    writeJson: (path, value) => {
      /** 模拟 JSON 原子写跨边界后的隔离副本。 */
      const copied = JSON.parse(JSON.stringify(value)) as object
      writes.push({ path, value: copied })
      diskValue = copied
      diskRevision += 1
      return 'directory'
    },
    warn: () => undefined,
  })
  return { store, writes, getDiskValue: () => diskValue }
}

/** 建立关联命令的最小工厂。 */
function linkInput(
  sessionId: string,
  canvasId: string,
  makeDefault = false,
  projectId = 'project-1',
) {
  return { projectId, sessionId, canvasId, makeDefault }
}

/** 创建包含单个会话关联的合法 schema v1 文件。 */
function createBindingFile(canvasIds: string[]) {
  /** 首项作为默认和最近画布，空数组仅用于空索引。 */
  const firstCanvasId = canvasIds[0]
  return {
    version: 1,
    bindings: firstCanvasId
      ? [{
          projectId: 'project-1',
          sessionId: 'session-1',
          defaultCanvasId: firstCanvasId,
          linkedCanvasIds: canvasIds,
          lastActiveCanvasId: firstCanvasId,
          updatedAt: 10,
        }]
      : [],
  }
}

beforeEach(() => {
  // 测试保持无全局 mock，避免 Bun 组合运行时污染其它 Store。
})

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe('AgentCanvasBindingStore', () => {
  test('Given 两个 Agent 共享同一画布 When 清理其中一个会话 Then 另一关联保持', () => {
    const { store } = createHarness(null, [10, 20])
    store.link(linkInput('session-a', 'canvas-shared'))
    store.link(linkInput('session-b', 'canvas-shared'))

    store.clearSession('project-1', 'session-a')

    expect(store.get('project-1', 'session-a')).toBeNull()
    expect(store.get('project-1', 'session-b')?.linkedCanvasIds).toEqual(['canvas-shared'])
  })

  test('Given 首次关联 makeDefault false When 建立关联 Then 仍产生可用默认和最近画布', () => {
    const { store } = createHarness()

    expect(store.link(linkInput('session-1', 'canvas-a', false))).toEqual({
      projectId: 'project-1',
      sessionId: 'session-1',
      defaultCanvasId: 'canvas-a',
      linkedCanvasIds: ['canvas-a'],
      lastActiveCanvasId: 'canvas-a',
      updatedAt: 100,
    })
  })

  test('Given 已有默认画布 When 以 false 关联新画布 Then 默认与最近画布不变', () => {
    const { store } = createHarness(null, [10, 20])
    store.link(linkInput('session-1', 'canvas-a', false))

    const result = store.link(linkInput('session-1', 'canvas-b', false))

    expect(result.defaultCanvasId).toBe('canvas-a')
    expect(result.lastActiveCanvasId).toBe('canvas-a')
    expect(result.linkedCanvasIds).toEqual(['canvas-a', 'canvas-b'])
  })

  test('Given 已有关联 When 以 true 关联画布 Then 同时更新默认和最近画布', () => {
    const { store } = createHarness(null, [10, 20])
    store.link(linkInput('session-1', 'canvas-a'))
    store.link(linkInput('session-1', 'canvas-b'))

    const result = store.link(linkInput('session-1', 'canvas-b', true))

    expect(result.defaultCanvasId).toBe('canvas-b')
    expect(result.lastActiveCanvasId).toBe('canvas-b')
  })

  test('Given 删除默认或最近画布 When 仍有关联 Then 按首现稳定顺序选择替代项', () => {
    const { store } = createHarness(null, [10, 20, 30, 40])
    store.link(linkInput('session-1', 'canvas-a'))
    store.link(linkInput('session-1', 'canvas-b'))
    store.link(linkInput('session-1', 'canvas-c', true))

    const afterDefaultRemoval = store.unlink({
      projectId: 'project-1', sessionId: 'session-1', canvasId: 'canvas-c',
    })

    expect(afterDefaultRemoval?.linkedCanvasIds).toEqual(['canvas-a', 'canvas-b'])
    expect(afterDefaultRemoval?.defaultCanvasId).toBe('canvas-a')
    expect(afterDefaultRemoval?.lastActiveCanvasId).toBe('canvas-a')
  })

  test('Given 最后一个关联 When 解除关联 Then 返回 null 并删除记录', () => {
    const { store } = createHarness(null, [10, 20])
    store.link(linkInput('session-1', 'canvas-a'))

    expect(store.unlink({
      projectId: 'project-1', sessionId: 'session-1', canvasId: 'canvas-a',
    })).toBeNull()
    expect(store.listByProject('project-1')).toEqual([])
  })

  test('Given 已关联与未知画布 When 设置默认 Then 只允许已关联画布', () => {
    const { store } = createHarness(null, [10, 20, 30])
    store.link(linkInput('session-1', 'canvas-a'))
    store.link(linkInput('session-1', 'canvas-b'))

    expect(store.setDefault({
      projectId: 'project-1', sessionId: 'session-1', canvasId: 'canvas-b',
    }).lastActiveCanvasId).toBe('canvas-b')
    expect(() => store.setDefault({
      projectId: 'project-1', sessionId: 'session-1', canvasId: 'canvas-unknown',
    })).toThrow('AGENT_CANVAS_BINDING_NOT_FOUND')
  })

  test('Given 多项目共享画布 ID When 清理项目画布 Then 仅修改目标项目并维护替代项', () => {
    const { store } = createHarness(null, [10, 20, 30, 40])
    store.link(linkInput('session-a', 'canvas-shared', false, 'project-1'))
    store.link(linkInput('session-a', 'canvas-keep', false, 'project-1'))
    store.link(linkInput('session-b', 'canvas-shared', false, 'project-1'))
    store.link(linkInput('session-c', 'canvas-shared', false, 'project-2'))

    store.clearCanvas('project-1', 'canvas-shared')

    expect(store.get('project-1', 'session-a')).toMatchObject({
      linkedCanvasIds: ['canvas-keep'],
      defaultCanvasId: 'canvas-keep',
      lastActiveCanvasId: 'canvas-keep',
    })
    expect(store.get('project-1', 'session-b')).toBeNull()
    expect(store.get('project-2', 'session-c')?.linkedCanvasIds).toEqual(['canvas-shared'])
  })

  test('Given 同项目同时存在失效会话与画布 When 批量对账 Then 单次 fresh-read 与单次原子写完成全部清理', () => {
    const { store, writes } = createHarness(null, [10, 20, 30, 40])
    store.link(linkInput('session-valid', 'canvas-valid'))
    store.link(linkInput('session-valid', 'canvas-stale'))
    store.link(linkInput('session-stale', 'canvas-valid'))
    writes.length = 0

    const result = store.reconcileProject(
      'project-1',
      (sessionId) => sessionId === 'session-valid',
      (canvasId) => canvasId === 'canvas-valid',
    )

    expect(writes).toHaveLength(1)
    expect(result.bindings).toEqual([expect.objectContaining({
      sessionId: 'session-valid',
      linkedCanvasIds: ['canvas-valid'],
    })])
    expect(result.changes).toEqual([{
      sessionId: 'session-stale',
      cause: 'session-cleared',
      binding: null,
    }, {
      sessionId: 'session-valid',
      cause: 'canvas-cleared',
      binding: expect.objectContaining({ linkedCanvasIds: ['canvas-valid'] }),
    }])
  })

  test('Given 批量对账 CAS 冲突 When 赢家抢先提交 Then 不覆盖赢家且下一次可基于权威磁盘重试', () => {
    const directory = mkdtempSync(join(tmpdir(), 'proma-agent-canvas-reconcile-conflict-'))
    temporaryDirectories.push(directory)
    const configPath = join(directory, 'agent-canvas-bindings.json')
    const baselineFile = createBindingFile(['canvas-valid', 'canvas-stale'])
    const winnerFile = createBindingFile(['canvas-valid', 'canvas-stale', 'canvas-winner'])
    writeFileSync(configPath, JSON.stringify(baselineFile), 'utf8')
    let shouldConflict = true
    const store = new AgentCanvasBindingStore({
      configPath,
      writeJson: (filePath, value, options) => writeJsonFileAtomicSecure(filePath, value, {
        ...options,
        beforeRename: () => {
          if (!shouldConflict) return
          shouldConflict = false
          writeFileSync(filePath, JSON.stringify(winnerFile), 'utf8')
        },
      }),
    })

    expect(() => store.reconcileProject(
      'project-1',
      () => true,
      (canvasId) => canvasId !== 'canvas-stale',
    )).toThrow('安全原子写入目标状态冲突')
    expect(JSON.parse(readFileSync(configPath, 'utf8'))).toEqual(winnerFile)

    expect(store.reconcileProject(
      'project-1',
      () => true,
      (canvasId) => canvasId !== 'canvas-stale',
    ).bindings[0]?.linkedCanvasIds).toEqual(['canvas-valid', 'canvas-winner'])
  })

  test('Given 损坏配置 When 读取后执行有效写入 Then 先降级为空且写操作重建 schema v1', () => {
    /** 损坏内容必须在首次读取时保持原样，不能由恢复读取覆盖。 */
    let rawContent = '{broken-json'
    /** 原子写调用次数。 */
    let writeCount = 0
    const store = new AgentCanvasBindingStore({
      configPath: CONFIG_PATH,
      now: () => 123,
      readState: () => createTestFileState(rawContent),
      readFile: () => rawContent,
      readJson: () => { throw new Error('损坏主文件不应进入恢复提升') },
      writeJson: (_path, value) => {
        writeCount += 1
        rawContent = JSON.stringify(value)
        return 'directory'
      },
      warn: () => undefined,
    })

    expect(store.listByProject('project-1')).toEqual([])
    expect(rawContent).toBe('{broken-json')

    store.link(linkInput('session-1', 'canvas-a'))

    expect(writeCount).toBe(1)
    expect(JSON.parse(rawContent)).toEqual({
      version: 1,
      bindings: [store.get('project-1', 'session-1')],
    })
  })

  test('Given 主文件合法且存在 When 首次读取 Then 只读取主文件一次且不触发恢复 reader', () => {
    /** 合法主文件值。 */
    const file = createBindingFile(['canvas-a'])
    /** 主文件读取次数。 */
    let readFileCalls = 0
    /** 恢复 reader 调用次数。 */
    let recoveryReadCalls = 0
    const store = new AgentCanvasBindingStore({
      configPath: CONFIG_PATH,
      readState: () => createTestFileState(file),
      readFile: () => {
        readFileCalls += 1
        return JSON.stringify(file)
      },
      readJson: () => {
        recoveryReadCalls += 1
        throw new Error('合法主文件不应触发恢复 reader')
      },
      warn: () => undefined,
    })

    expect(store.listByProject('project-1')).toEqual(file.bindings)
    expect(readFileCalls).toBe(1)
    expect(recoveryReadCalls).toBe(0)
  })

  test('Given 含敏感哨兵的损坏主文件 When 降级为空 Then warning 只有稳定中文类别', () => {
    /** 不得进入 warning 参数的敏感哨兵。 */
    const sensitiveSentinel = 'SECRET_SENTINEL_DO_NOT_LOG'
    /** 捕获 warning 的全部参数以验证没有 error 或原文。 */
    const warningArguments: unknown[][] = []
    const store = new AgentCanvasBindingStore({
      configPath: CONFIG_PATH,
      readState: () => createTestFileState(sensitiveSentinel),
      readFile: () => `{${sensitiveSentinel}`,
      readJson: () => { throw new Error('损坏主文件不应触发恢复 reader') },
      warn: (...args: unknown[]) => { warningArguments.push(args) },
    })

    expect(store.listByProject('project-1')).toEqual([])
    expect(warningArguments).toHaveLength(1)
    expect(warningArguments[0]).toHaveLength(1)
    expect(JSON.stringify(warningArguments)).not.toContain(sensitiveSentinel)
  })

  test('Given 缺失主文件的恢复 rename 已提交但 durability 抛错 When 重试 Then 传播后重载磁盘事实', () => {
    /** 恢复 reader 提交后可见的旧关联文件。 */
    let diskValue: unknown = null
    /** 恢复 reader 调用次数，主文件可见后不应再次调用。 */
    let recoveryReadCalls = 0
    const store = new AgentCanvasBindingStore({
      configPath: CONFIG_PATH,
      now: () => 20,
      readState: () => diskValue === null ? null : createTestFileState(diskValue),
      readFile: () => JSON.stringify(diskValue),
      readJson: () => {
        recoveryReadCalls += 1
        diskValue = createBindingFile(['canvas-old'])
        throw new Error('RECOVERY_DURABILITY_UNCERTAIN')
      },
      writeJson: (_path, value) => {
        diskValue = JSON.parse(JSON.stringify(value)) as object
        return 'directory'
      },
      warn: () => undefined,
    })

    expect(() => store.get('project-1', 'session-1')).toThrow('RECOVERY_DURABILITY_UNCERTAIN')
    expect(store.get('project-1', 'session-1')?.linkedCanvasIds).toEqual(['canvas-old'])
    expect(store.link(linkInput('session-1', 'canvas-new')).linkedCanvasIds).toEqual([
      'canvas-old', 'canvas-new',
    ])
    expect(recoveryReadCalls).toBe(1)
  })

  test('Given 两个 Store 都缓存空索引 When 先后写入 Then 后写者 fresh reload 不丢前者关联', () => {
    /** 真实 secure writer 需要已存在的父目录。 */
    const directory = mkdtempSync(join(tmpdir(), 'proma-agent-canvas-concurrent-'))
    temporaryDirectories.push(directory)
    /** 两个 Store 共享的真实索引路径。 */
    const configPath = join(directory, 'agent-canvas-bindings.json')
    const storeA = new AgentCanvasBindingStore({ configPath, now: () => 10 })
    const storeB = new AgentCanvasBindingStore({ configPath, now: () => 20 })
    expect(storeA.listByProject('project-1')).toEqual([])
    expect(storeB.listByProject('project-1')).toEqual([])

    storeA.link(linkInput('session-1', 'canvas-a'))
    storeB.link(linkInput('session-1', 'canvas-b'))

    expect(new AgentCanvasBindingStore({ configPath }).get(
      'project-1', 'session-1',
    )?.linkedCanvasIds).toEqual(['canvas-a', 'canvas-b'])
  })

  test('Given 当前客户端已缓存空关联 When 另一客户端写入关联 Then 当前客户端公开读立即采用磁盘最新事实', () => {
    /** 两个客户端共享同一真实配置文件，复现开发版与正式版并行运行。 */
    const directory = mkdtempSync(join(tmpdir(), 'proma-agent-canvas-fresh-read-'))
    temporaryDirectories.push(directory)
    const configPath = join(directory, 'agent-canvas-bindings.json')
    const currentClient = new AgentCanvasBindingStore({ configPath, now: () => 10 })
    const otherClient = new AgentCanvasBindingStore({ configPath, now: () => 20 })
    expect(currentClient.get('project-1', 'session-1')).toBeNull()
    expect(currentClient.listByProject('project-1')).toEqual([])

    otherClient.link(linkInput('session-1', 'canvas-new'))

    expect(currentClient.get('project-1', 'session-1')?.linkedCanvasIds).toEqual(['canvas-new'])
    expect(currentClient.listByProject('project-1').map((binding) => binding.sessionId)).toEqual(['session-1'])
  })

  test('Given fresh 读取后另一写者抢先提交 When CAS 写入 Then 明确冲突且不覆盖赢家', () => {
    /** 真实 secure CAS 竞争使用的已存在父目录。 */
    const directory = mkdtempSync(join(tmpdir(), 'proma-agent-canvas-cas-conflict-'))
    temporaryDirectories.push(directory)
    /** 竞争双方共享的索引路径。 */
    const configPath = join(directory, 'agent-canvas-bindings.json')
    /** mutation fresh 读取时看到的基线。 */
    const baselineFile = createBindingFile(['canvas-base'])
    /** beforeRename 阶段由赢家发布的新事实。 */
    const winnerFile = createBindingFile(['canvas-base', 'canvas-winner'])
    writeFileSync(configPath, JSON.stringify(baselineFile), 'utf8')
    const store = new AgentCanvasBindingStore({
      configPath,
      writeJson: (filePath, value, options) => writeJsonFileAtomicSecure(
        filePath,
        value,
        {
          ...options,
          beforeRename: () => writeFileSync(filePath, JSON.stringify(winnerFile), 'utf8'),
        },
      ),
    })

    expect(() => store.link(linkInput('session-1', 'canvas-loser'))).toThrow(
      '安全原子写入目标状态冲突',
    )
    expect(JSON.parse(readFileSync(configPath, 'utf8'))).toEqual(winnerFile)
    expect(store.get('project-1', 'session-1')?.linkedCanvasIds).toEqual([
      'canvas-base', 'canvas-winner',
    ])
  })

  test('Given 主文件缺失、错误版本 tmp 与合法 bak When 读取 Then 跳过 tmp 并从 bak 恢复合法主文件', () => {
    /** 真实文件系统临时目录用于运行 safe-file 恢复合同。 */
    const directory = mkdtempSync(join(tmpdir(), 'proma-agent-canvas-recovery-'))
    temporaryDirectories.push(directory)
    /** safe-file 主文件及其固定候选路径。 */
    const configPath = join(directory, 'agent-canvas-bindings.json')
    /** 合法备份中唯一的关联记录。 */
    const backupFile = {
      version: 1,
      bindings: [{
        projectId: 'project-1',
        sessionId: 'session-backup',
        defaultCanvasId: 'canvas-backup',
        linkedCanvasIds: ['canvas-backup'],
        lastActiveCanvasId: 'canvas-backup',
        updatedAt: 10,
      }],
    }
    writeFileSync(`${configPath}.tmp`, JSON.stringify({ version: 2, bindings: [] }), 'utf8')
    writeFileSync(`${configPath}.bak`, JSON.stringify(backupFile), 'utf8')

    const result = new AgentCanvasBindingStore({ configPath }).listByProject('project-1')

    expect(result).toEqual(backupFile.bindings)
    expect(JSON.parse(readFileSync(configPath, 'utf8'))).toEqual(backupFile)
    expect(existsSync(`${configPath}.tmp`)).toBe(false)
  })

  test('Given 主文件缺失与合法 tmp When 读取 Then safe-file 提升 tmp 为主文件', () => {
    /** 真实文件系统临时目录用于运行 safe-file tmp 提升合同。 */
    const directory = mkdtempSync(join(tmpdir(), 'proma-agent-canvas-tmp-'))
    temporaryDirectories.push(directory)
    /** safe-file 主文件及其固定临时候选路径。 */
    const configPath = join(directory, 'agent-canvas-bindings.json')
    /** 合法临时索引值。 */
    const temporaryFile = {
      version: 1,
      bindings: [{
        projectId: 'project-1',
        sessionId: 'session-tmp',
        linkedCanvasIds: ['canvas-tmp'],
        updatedAt: 20,
      }],
    }
    writeFileSync(`${configPath}.tmp`, JSON.stringify(temporaryFile), 'utf8')

    const result = new AgentCanvasBindingStore({ configPath }).listByProject('project-1')

    expect(result).toEqual(temporaryFile.bindings)
    expect(JSON.parse(readFileSync(configPath, 'utf8'))).toEqual(temporaryFile)
    expect(existsSync(`${configPath}.tmp`)).toBe(false)
  })

  test('Given 首次原子写在提交前失败 When 重试同一关联 Then 缓存保持旧状态且第二次仍写入', () => {
    /** 写入前已有的稳定磁盘索引。 */
    let diskValue: unknown = {
      version: 1,
      bindings: [{
        projectId: 'project-1',
        sessionId: 'session-1',
        defaultCanvasId: 'canvas-a',
        linkedCanvasIds: ['canvas-a'],
        lastActiveCanvasId: 'canvas-a',
        updatedAt: 10,
      }],
    }
    /** 记录两次原子写尝试，第一次模拟 rename 前失败。 */
    let writeAttempts = 0
    const store = new AgentCanvasBindingStore({
      configPath: CONFIG_PATH,
      now: () => 20,
      readState: () => createTestFileState(diskValue),
      readFile: () => JSON.stringify(diskValue),
      readJson: () => diskValue,
      writeJson: (_path, value) => {
        writeAttempts += 1
        if (writeAttempts === 1) throw new Error('PRECOMMIT_WRITE_FAILED')
        diskValue = JSON.parse(JSON.stringify(value)) as object
        return 'directory'
      },
      warn: () => undefined,
    })

    expect(() => store.link(linkInput('session-1', 'canvas-b'))).toThrow(
      'PRECOMMIT_WRITE_FAILED',
    )
    expect(store.get('project-1', 'session-1')?.linkedCanvasIds).toEqual(['canvas-a'])

    expect(store.link(linkInput('session-1', 'canvas-b')).linkedCanvasIds).toEqual([
      'canvas-a', 'canvas-b',
    ])
    expect(writeAttempts).toBe(2)
  })

  test('Given 原子写提交后 durability 抛错 When 再读取与追加 Then 从磁盘重载已提交事实', () => {
    /** 模拟主文件当前可见内容，writer 会在抛错前先更新它。 */
    let diskValue: unknown = {
      version: 1,
      bindings: [{
        projectId: 'project-1',
        sessionId: 'session-1',
        defaultCanvasId: 'canvas-a',
        linkedCanvasIds: ['canvas-a'],
        lastActiveCanvasId: 'canvas-a',
        updatedAt: 10,
      }],
    }
    /** 原子写尝试次数，第一次模拟 rename 后 durability 不确定。 */
    let writeAttempts = 0
    const store = new AgentCanvasBindingStore({
      configPath: CONFIG_PATH,
      now: () => 20 + writeAttempts,
      readState: () => createTestFileState(diskValue),
      readFile: () => JSON.stringify(diskValue),
      readJson: () => diskValue,
      writeJson: (_path, value) => {
        writeAttempts += 1
        diskValue = JSON.parse(JSON.stringify(value)) as object
        if (writeAttempts === 1) throw new Error('POSTCOMMIT_DURABILITY_UNCERTAIN')
        return 'directory'
      },
      warn: () => undefined,
    })

    expect(() => store.link(linkInput('session-1', 'canvas-b'))).toThrow(
      'POSTCOMMIT_DURABILITY_UNCERTAIN',
    )
    expect(store.get('project-1', 'session-1')?.linkedCanvasIds).toEqual([
      'canvas-a', 'canvas-b',
    ])

    expect(store.link(linkInput('session-1', 'canvas-c')).linkedCanvasIds).toEqual([
      'canvas-a', 'canvas-b', 'canvas-c',
    ])
    expect(writeAttempts).toBe(2)
  })

  test.each([
    ['错误版本', { version: 2, bindings: [] }],
    ['未知字段', { version: 1, bindings: [], extra: true }],
    ['重复身份', {
      version: 1,
      bindings: [
        { projectId: 'project-1', sessionId: 'session-1', linkedCanvasIds: ['canvas-a'], updatedAt: 1 },
        { projectId: 'project-1', sessionId: 'session-1', linkedCanvasIds: ['canvas-b'], updatedAt: 2 },
      ],
    }],
  ])('Given %s配置 When 读取 Then 拒绝整份文件而不选择冲突记录', (_name, value) => {
    const { store, writes } = createHarness(value)

    expect(store.listByProject('project-1')).toEqual([])
    expect(writes).toHaveLength(0)
  })

  test('Given 重复或未知操作 When 执行 Then no-op 不写磁盘', () => {
    const { store, writes } = createHarness(null, [10, 20])
    store.link(linkInput('session-1', 'canvas-a'))
    expect(writes).toHaveLength(1)

    store.link(linkInput('session-1', 'canvas-a', false))
    expect(store.unlink({
      projectId: 'project-1', sessionId: 'session-1', canvasId: 'canvas-unknown',
    })?.linkedCanvasIds).toEqual(['canvas-a'])
    store.clearSession('project-1', 'session-unknown')
    store.clearCanvas('project-1', 'canvas-unknown')

    expect(writes).toHaveLength(1)
  })

  test('Given 多项目记录 When 写入 Then 使用固定 schema、原子依赖和稳定身份排序', () => {
    const { store, writes } = createHarness(null, [30, 10, 20])
    store.link(linkInput('session-z', 'canvas-z', false, 'project-z'))
    store.link(linkInput('session-b', 'canvas-b', false, 'project-a'))
    store.link(linkInput('session-a', 'canvas-a', false, 'project-a'))

    expect(writes.at(-1)?.path).toBe(CONFIG_PATH)
    expect((writes.at(-1)?.value as { version: number }).version).toBe(1)
    expect((writes.at(-1)?.value as { bindings: AgentCanvasBinding[] }).bindings.map(
      (binding) => `${binding.projectId}/${binding.sessionId}`,
    )).toEqual(['project-a/session-a', 'project-a/session-b', 'project-z/session-z'])
  })

  test('Given 返回对象 When 调用方修改数组 Then 不泄漏 Store 内部状态', () => {
    const { store } = createHarness()
    const linked = store.link(linkInput('session-1', 'canvas-a'))

    linked.linkedCanvasIds.push('canvas-injected')
    const listed = store.listByProject('project-1')
    listed[0]?.linkedCanvasIds.push('canvas-listed-injected')

    expect(store.get('project-1', 'session-1')?.linkedCanvasIds).toEqual(['canvas-a'])
  })
})
