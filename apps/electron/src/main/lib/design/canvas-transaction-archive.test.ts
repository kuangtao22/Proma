import { describe, expect, test } from 'bun:test'
import {
  createCanvasTransactionArchive,
  isCanvasTransactionArchivable,
  type CanvasTransactionArchiveStorage,
} from './canvas-transaction-archive'

/** 创建最小 JSON 事务正文。 */
function record(value: object): string {
  return `${JSON.stringify(value)}\n`
}

describe('Canvas 事务终态归档', () => {
  test('Given 各类终态与未决事务 When 判断归档资格 Then 只接受无待恢复副作用的终态', () => {
    expect(isCanvasTransactionArchivable('agent-node-11111111-1111-4111-8111-111111111111.json', record({ state: 'committed' }))).toBe(true)
    expect(isCanvasTransactionArchivable('agent-node-rebuild-11111111-1111-4111-8111-111111111111.json', record({ state: 'session-created' }))).toBe(false)
    expect(isCanvasTransactionArchivable('content-node-operation-1.json', record({ state: 'committed' }))).toBe(true)
    expect(isCanvasTransactionArchivable('image-candidate-adoption-operation-1.json', record({ state: 'graph-committed' }))).toBe(false)
    expect(isCanvasTransactionArchivable('image-candidate-batch-batch-1.json', record({ status: 'ready' }))).toBe(false)
    expect(isCanvasTransactionArchivable('image-candidate-batch-batch-1.json', record({ status: 'adopted' }))).toBe(true)
    expect(isCanvasTransactionArchivable('artifact-export-11111111-1111-4111-8111-111111111111.json', record({ state: 'prepared' }))).toBe(false)
    expect(isCanvasTransactionArchivable('artifact-export-11111111-1111-4111-8111-111111111111.json', record({ state: 'completed' }))).toBe(true)
    expect(isCanvasTransactionArchivable('canvas-batch-operation-1.json', record({
      state: 'rolled-back',
      preparedResources: [{ createdByOperation: true, state: 'cleanup-pending' }],
    }))).toBe(false)
    expect(isCanvasTransactionArchivable('canvas-batch-operation-1.json', record({
      state: 'rolled-back',
      preparedResources: [{ createdByOperation: true, state: 'cleaned' }],
    }))).toBe(true)
  })

  test('Given 2000 条混合历史 When 分批归档 Then 单次工作有固定条数上限且未决记录保留', async () => {
    const active = new Map<string, string>()
    const archived = new Map<string, string>()
    for (let index = 0; index < 2_000; index += 1) {
      active.set(`content-node-operation-${index}.json`, record({ state: index % 5 === 0 ? 'prepared' : 'committed' }))
    }
    const storage: CanvasTransactionArchiveStorage = {
      writeArchived: async (fileName, content) => { archived.set(fileName, content) },
      readArchived: async (fileName) => archived.get(fileName) ?? null,
      removeActive: async (fileName) => { active.delete(fileName) },
    }
    const archive = createCanvasTransactionArchive(storage, { maxRecordsPerPass: 64, maxBytesPerPass: 1024 * 1024 })

    const result = await archive.archiveEntries([...active].map(([name, content]) => ({ name, content })))

    expect(result.archivedCount).toBe(64)
    expect(active.size).toBe(1_936)
    expect([...active.values()].filter((content) => content.includes('"prepared"')).length).toBe(400)
  })

  test('Given 归档写入或读回失败 When 推进归档 Then 不移除 active 并可重复恢复', async () => {
    let archived = ''
    let removes = 0
    const storage: CanvasTransactionArchiveStorage = {
      writeArchived: async (_fileName, content) => { archived = content },
      readArchived: async () => `${archived}corrupt`,
      removeActive: async () => { removes += 1 },
    }
    const archive = createCanvasTransactionArchive(storage)
    const entry = { name: 'content-node-operation-1.json', content: record({ state: 'committed' }) }

    await expect(archive.archiveEntries([entry])).rejects.toThrow('CANVAS_TRANSACTION_ARCHIVE_READBACK_MISMATCH')
    expect(removes).toBe(0)
  })

  test('Given active 删除阶段崩溃后归档已存在 When 重试 Then 覆盖同一归档并最终收敛', async () => {
    const archived = new Map<string, string>()
    let failRemove = true
    let removes = 0
    const storage: CanvasTransactionArchiveStorage = {
      writeArchived: async (fileName, content) => { archived.set(fileName, content) },
      readArchived: async (fileName) => archived.get(fileName) ?? null,
      removeActive: async () => {
        removes += 1
        if (failRemove) throw new Error('crash')
      },
    }
    const archive = createCanvasTransactionArchive(storage)
    const entry = { name: 'content-node-operation-1.json', content: record({ state: 'committed' }) }

    await expect(archive.archiveEntries([entry])).rejects.toThrow('crash')
    failRemove = false
    await expect(archive.archiveEntries([entry])).resolves.toMatchObject({ archivedCount: 1 })
    expect(archived.size).toBe(1)
    expect(removes).toBe(2)
  })

  test('Given 已归档 operation When 精确读取 Then 不扫描其它分片并返回原始证据', async () => {
    let reads = 0
    const content = record({ state: 'committed', operationId: 'operation-1' })
    const archive = createCanvasTransactionArchive({
      writeArchived: async () => {},
      readArchived: async (fileName) => {
        reads += 1
        return fileName === 'content-node-operation-1.json' ? content : null
      },
      removeActive: async () => {},
    })

    await expect(archive.load('content-node-operation-1.json')).resolves.toBe(content)
    expect(reads).toBe(1)
  })
})
