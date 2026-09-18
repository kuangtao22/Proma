import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { MediaApiModelCatalogResult, MediaApiModelProfile } from '@proma/shared'
import { runImageModelLegacyCleanup } from './image-model-legacy-cleanup'

/** 每个测试使用独立真实目录。 */
let directory = ''
let markerPath = ''
let backupPath = ''

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'proma-image-cleanup-'))
  markerPath = join(directory, 'marker.json')
  backupPath = join(directory, 'backup.json')
})

afterEach(() => {
  rmSync(directory, { recursive: true, force: true })
})

/** 构造统一媒体目录条目。 */
function createEntry(id: string, name: string, protocol: MediaApiModelProfile['protocol'], mediaKind: MediaApiModelProfile['mediaKind']): { profile: MediaApiModelProfile } {
  return {
    profile: {
      id,
      name,
      mediaKind,
      protocol,
      channelId: 'channel-1',
      modelId: 'gpt-image-2',
      capabilities: ['text-to-image'],
      enabled: true,
      createdAt: 1,
      updatedAt: 2,
    } as MediaApiModelProfile,
  }
}

/** 构造可注入目录，并记录写回内容。 */
function createCatalog(entries: Array<{ profile: MediaApiModelProfile }>): {
  listCatalog: () => MediaApiModelCatalogResult
  replaceProfiles: (profiles: MediaApiModelProfile[], expectedRevision: number) => MediaApiModelCatalogResult
  writes: MediaApiModelProfile[][]
} {
  const writes: MediaApiModelProfile[][] = []
  return {
    writes,
    listCatalog: () => ({ revision: 7, entries } as unknown as MediaApiModelCatalogResult),
    replaceProfiles: (profiles, expectedRevision) => {
      expect(expectedRevision).toBe(7)
      writes.push(profiles)
      return { revision: 8, entries: [] } as unknown as MediaApiModelCatalogResult
    },
  }
}

describe('旧渠道型生图条目一次性清理', () => {
  test('Given 存在旧条目 When 清理 Then 先备份再删除并写标记', () => {
    const catalog = createCatalog([
      createEntry('legacy-1', '老沈GPT', 'openai-images', 'image'),
      createEntry('keep-1', '保留的视频', 'minimax-video', 'video'),
    ])
    const outcome = runImageModelLegacyCleanup({
      markerPath, backupPath, now: () => 1000,
      listCatalog: catalog.listCatalog, replaceProfiles: catalog.replaceProfiles,
    })

    expect(outcome).toEqual({ status: 'cleaned', count: 1 })
    /** 只移除渠道型生图条目，其它媒体类型原样保留。 */
    expect(catalog.writes[0]!.map((profile) => profile.id)).toEqual(['keep-1'])
    const backup = JSON.parse(readFileSync(backupPath, 'utf8')) as { migratedAt: number; entries: Array<{ id: string; name: string }> }
    expect(backup.migratedAt).toBe(1000)
    expect(backup.entries.map((entry) => entry.name)).toEqual(['老沈GPT'])
    expect(existsSync(markerPath)).toBeTrue()
  })

  test('Given 已写标记 When 再次运行 Then 跳过且不再读写目录', () => {
    writeFileSync(markerPath, JSON.stringify({ migratedAt: 1, cleaned: 1 }))
    const catalog = createCatalog([createEntry('legacy-1', '老沈GPT', 'openai-images', 'image')])
    const outcome = runImageModelLegacyCleanup({
      markerPath, backupPath, listCatalog: catalog.listCatalog, replaceProfiles: catalog.replaceProfiles,
    })
    expect(outcome).toEqual({ status: 'skipped' })
    expect(catalog.writes).toHaveLength(0)
    expect(existsSync(backupPath)).toBeFalse()
  })

  test('Given 没有旧条目 When 清理 Then 直接写标记且不改目录', () => {
    const catalog = createCatalog([createEntry('keep-1', '视频', 'minimax-video', 'video')])
    const outcome = runImageModelLegacyCleanup({
      markerPath, backupPath, listCatalog: catalog.listCatalog, replaceProfiles: catalog.replaceProfiles,
    })
    expect(outcome).toEqual({ status: 'clean' })
    expect(catalog.writes).toHaveLength(0)
    expect(JSON.parse(readFileSync(markerPath, 'utf8'))).toMatchObject({ cleaned: 0 })
  })

  test('Given 写回失败 When 清理 Then 不写标记以便下次重试', () => {
    const catalog = createCatalog([createEntry('legacy-1', '老沈GPT', 'openai-images', 'image')])
    const outcome = runImageModelLegacyCleanup({
      markerPath, backupPath,
      listCatalog: catalog.listCatalog,
      replaceProfiles: () => { throw new Error('IMAGE_MODEL_REVISION_CONFLICT') },
    })
    expect(outcome).toEqual({ status: 'failed', message: 'IMAGE_MODEL_REVISION_CONFLICT' })
    expect(existsSync(markerPath)).toBeFalse()
    /** 备份已写入，便于人工核对。 */
    expect(existsSync(backupPath)).toBeTrue()
  })
})
