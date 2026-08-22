import { describe, expect, test } from 'bun:test'
import type { GitHubRelease, GitHubReleaseHistorySource, GitHubReleaseListOptions } from '@proma/shared'
import {
  createInitialVersionHistoryState,
  loadVersionHistory,
  reduceVersionHistoryState,
  sanitizeVersionHistoryError,
  shouldLoadVersionHistory,
} from './version-history-state'

/** 创建版本历史测试使用的 Release。 */
function createRelease(id: number): GitHubRelease {
  return {
    id,
    tag_name: `v1.0.${id}`,
    name: `版本 ${id}`,
    body: `说明 ${id}`,
    draft: false,
    prerelease: false,
    created_at: '2026-08-22T00:00:00.000Z',
    published_at: '2026-08-22T00:00:00.000Z',
    html_url: `https://example.com/releases/${id}`,
  }
}

describe('version-history-state', () => {
  test('Given 初始版本历史 When 创建状态 Then Bone 与官方均为空且未加载', () => {
    const state = createInitialVersionHistoryState()

    expect(state).toEqual({
      bone: { releases: [], loading: false, loaded: false, error: null, expandedIds: new Set() },
      official: { releases: [], loading: false, loaded: false, error: null, expandedIds: new Set() },
    })
  })

  test('Given Bone 已加载 When 官方开始并成功加载 Then 两个来源状态互不覆盖', () => {
    const boneRelease = createRelease(1)
    const officialRelease = createRelease(2)
    const boneLoaded = reduceVersionHistoryState(createInitialVersionHistoryState(), {
      type: 'load-success',
      source: 'bone',
      releases: [boneRelease],
    })
    const officialLoading = reduceVersionHistoryState(boneLoaded, {
      type: 'load-start',
      source: 'official',
    })
    const state = reduceVersionHistoryState(officialLoading, {
      type: 'load-success',
      source: 'official',
      releases: [officialRelease],
    })

    expect(state.bone.releases).toEqual([boneRelease])
    expect(state.bone.loaded).toBe(true)
    expect(state.official.releases).toEqual([officialRelease])
    expect(state.official.loaded).toBe(true)
  })

  test('Given 两个来源均有同 ID Release When 展开 Bone Then 官方展开状态保持隔离', () => {
    const state = reduceVersionHistoryState(createInitialVersionHistoryState(), {
      type: 'toggle-expanded',
      source: 'bone',
      releaseId: 7,
    })

    expect(state.bone.expandedIds.has(7)).toBe(true)
    expect(state.official.expandedIds.has(7)).toBe(false)
    expect(reduceVersionHistoryState(state, {
      type: 'toggle-expanded',
      source: 'bone',
      releaseId: 7,
    }).bone.expandedIds.has(7)).toBe(false)
  })

  test('Given 来源已有版本 When 刷新失败 Then 保留版本并记录已清洗错误', () => {
    const release = createRelease(3)
    const loaded = reduceVersionHistoryState(createInitialVersionHistoryState(), {
      type: 'load-success',
      source: 'official',
      releases: [release],
    })
    const state = reduceVersionHistoryState(loaded, {
      type: 'load-error',
      source: 'official',
      error: '网络不可用',
    })

    expect(state.official.releases).toEqual([release])
    expect(state.official.error).toBe('网络不可用')
    expect(state.official.loading).toBe(false)
    expect(state.bone).toBe(loaded.bone)
  })

  test('Given Electron IPC 英文错误前缀 When 清洗错误 Then 仅保留实际原因', () => {
    expect(sanitizeVersionHistoryError(
      new Error("Error invoking remote method 'github-release:list': Error: 无法连接 GitHub"),
    )).toBe('无法连接 GitHub')
    expect(sanitizeVersionHistoryError(new Error('普通错误'))).toBe('普通错误')
    expect(sanitizeVersionHistoryError('未知值')).toBe('加载失败')
  })

  test('Given 来源未加载或已失败 When 判断懒加载 Then 未加载可重试且已加载不重复请求', () => {
    const initial = createInitialVersionHistoryState()
    const loaded = reduceVersionHistoryState(initial, {
      type: 'load-success',
      source: 'bone',
      releases: [],
    })
    const failed = reduceVersionHistoryState(initial, {
      type: 'load-error',
      source: 'official',
      error: '失败',
    })

    expect(shouldLoadVersionHistory(initial.bone)).toBe(true)
    expect(shouldLoadVersionHistory(loaded.bone)).toBe(false)
    expect(shouldLoadVersionHistory(failed.official)).toBe(true)
    expect(shouldLoadVersionHistory(loaded.bone, true)).toBe(true)
    expect(shouldLoadVersionHistory({ ...initial.bone, loading: true }, true)).toBe(false)
  })

  test('Given 指定来源 When 加载版本历史 Then API 收到来源、三条与排除预发布参数', async () => {
    /** 记录 API 收到的查询参数。 */
    const calls: GitHubReleaseListOptions[] = []
    /** 模拟 Electron Release 列表 API。 */
    const listReleases = async (options?: GitHubReleaseListOptions): Promise<GitHubRelease[]> => {
      calls.push(options ?? {})
      return [createRelease(9)]
    }

    const releases = await loadVersionHistory('official', listReleases)

    expect(releases).toHaveLength(1)
    expect(calls).toEqual([{ source: 'official', perPage: 3, includePrerelease: false }])
  })

  test('Given 未显式指定来源 When 加载版本历史 Then 默认请求 Bone', async () => {
    /** 记录默认加载来源。 */
    let requestedSource: GitHubReleaseHistorySource | undefined
    await loadVersionHistory(undefined, async (options) => {
      requestedSource = options?.source
      return []
    })

    expect(requestedSource).toBe('bone')
  })
})
