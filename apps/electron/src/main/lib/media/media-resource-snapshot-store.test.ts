import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import {
  chmodSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MediaResourceSnapshotStore } from './media-resource-snapshot-store'

/** 每个用例使用独立目录，模拟可重建的本地媒体资源快照。 */
let directory = ''

beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'proma-media-resource-snapshot-')) })
afterEach(() => { rmSync(directory, { recursive: true, force: true }) })

/** 测试解析器只接受预期的节点目录形状。 */
function parseCatalog(value: unknown): { nodes: string[] } {
  if (!value || typeof value !== 'object' || !('nodes' in value)) throw new Error('CATALOG_INVALID')
  const nodes = (value as { nodes?: unknown }).nodes
  if (!Array.isArray(nodes) || !nodes.every((node) => typeof node === 'string')) throw new Error('CATALOG_INVALID')
  return { nodes }
}

describe('媒体资源持久快照', () => {
  test('Given 首次同步成功 When 进程重建后读取 Then 返回本地快照且身份明文不落盘', () => {
    const key = JSON.stringify({ connectionId: 'gpu', authorization: 'Bearer secret-token', source: 'nodes' })
    const expectedName = `${createHash('sha256').update(key).digest('hex')}.json`
    new MediaResourceSnapshotStore(() => directory).write(key, { nodes: ['KSampler', 'LoadImage'] })

    expect(readdirSync(directory)).toEqual([expectedName])
    expect(readFileSync(join(directory, expectedName), 'utf8')).not.toContain(key)
    expect(readFileSync(join(directory, expectedName), 'utf8')).not.toContain('secret-token')
    expect(lstatSync(join(directory, expectedName)).mode & 0o777).toBe(0o600)
    expect(new MediaResourceSnapshotStore(directory).read(key, parseCatalog)).toEqual({ nodes: ['KSampler', 'LoadImage'] })
  })

  test('Given 快照身份或内容摘要被篡改 When 读取 Then 返回空以便上层重新同步', () => {
    const key = 'catalog-key'
    const store = new MediaResourceSnapshotStore(directory)
    store.write(key, { nodes: ['KSampler'] })
    const path = join(directory, readdirSync(directory)[0]!)
    const original = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>

    writeFileSync(path, JSON.stringify({ ...original, keyHash: '0'.repeat(64) }), 'utf8')
    expect(store.read(key, parseCatalog)).toBeNull()

    writeFileSync(path, JSON.stringify({ ...original, payload: { nodes: ['AttackerNode'] } }), 'utf8')
    expect(store.read(key, parseCatalog)).toBeNull()
  })

  test('Given 快照无法通过当前解析器 When 读取 Then 返回空而不暴露陈旧结构', () => {
    const store = new MediaResourceSnapshotStore(directory)
    store.write('catalog-key', { incompatible: true })
    expect(store.read('catalog-key', parseCatalog)).toBeNull()
  })

  test('Given 客户端返回 null prototype 与重复引用 When 写入 Then 作为合法 JSON 保存', () => {
    const shared = { type: 'IMAGE' }
    const payload = Object.create(null) as Record<string, unknown>
    payload.first = shared
    payload.second = shared
    const store = new MediaResourceSnapshotStore(directory)

    store.write('workflow-body', payload)
    expect(store.read('workflow-body', (value) => value)).toEqual({
      first: { type: 'IMAGE' },
      second: { type: 'IMAGE' },
    })
  })

  test('Given 快照路径被替换为符号链接 When 读写 Then 不跟随且外部文件保持不变', () => {
    const key = 'catalog-key'
    const name = `${createHash('sha256').update(key).digest('hex')}.json`
    const path = join(directory, name)
    const outsidePath = join(directory, 'outside.json')
    writeFileSync(outsidePath, 'outside', 'utf8')
    symlinkSync(outsidePath, path)
    const store = new MediaResourceSnapshotStore(directory)

    expect(store.read(key, parseCatalog)).toBeNull()
    expect(() => store.write(key, { nodes: ['KSampler'] })).toThrow()
    expect(readFileSync(outsidePath, 'utf8')).toBe('outside')
  })

  test('Given 已有可用快照 When 新值不是普通 JSON 或超过 16 MiB Then 拒绝且保留旧文件', () => {
    const key = 'catalog-key'
    const store = new MediaResourceSnapshotStore(directory)
    store.write(key, { nodes: ['KSampler'] })
    const path = join(directory, readdirSync(directory)[0]!)
    const original = readFileSync(path, 'utf8')
    const invalid = { createdAt: new Date() }
    const disguised: string[] & { toJSON?: () => string[] } = ['Changed']
    disguised.toJSON = () => ['Injected']
    const cyclic: { self?: unknown } = {}
    cyclic.self = cyclic

    expect(() => store.write(key, invalid)).toThrow('MEDIA_RESOURCE_SNAPSHOT_JSON_INVALID')
    expect(() => store.write(key, disguised)).toThrow('MEDIA_RESOURCE_SNAPSHOT_JSON_INVALID')
    expect(() => store.write(key, cyclic)).toThrow('MEDIA_RESOURCE_SNAPSHOT_JSON_INVALID')
    expect(() => store.write(key, { content: 'x'.repeat(16 * 1024 * 1024) })).toThrow('MEDIA_RESOURCE_SNAPSHOT_SIZE_LIMIT')
    expect(readFileSync(path, 'utf8')).toBe(original)
    expect(store.read(key, parseCatalog)).toEqual({ nodes: ['KSampler'] })
  })

  test('Given 快照目录长期产生不同变体 When 超过容量 Then 只保留最近 256 个快照', () => {
    const store = new MediaResourceSnapshotStore(directory)
    for (let index = 0; index < 257; index += 1) store.write(`catalog-${index}`, { index })

    expect(readdirSync(directory).filter((name) => /^[a-f0-9]{64}\.json$/.test(name))).toHaveLength(256)
    expect(store.read('catalog-256', (value) => value)).toEqual({ index: 256 })
  })

  test('Given 伪装目录项与只读损坏文件 When 清理超量快照 Then 不删除非本存储文件', () => {
    const store = new MediaResourceSnapshotStore(directory)
    const unrelated = join(directory, 'keep-me.json')
    writeFileSync(unrelated, 'foreign', 'utf8')
    chmodSync(unrelated, 0o400)
    for (let index = 0; index < 257; index += 1) store.write(`variant-${index}`, { index })

    expect(readFileSync(unrelated, 'utf8')).toBe('foreign')
  })
})
