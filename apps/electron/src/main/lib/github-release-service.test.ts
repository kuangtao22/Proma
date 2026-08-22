import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import type { GitHubRelease, GitHubReleaseListOptions } from '@proma/shared'
import {
  clearReleaseCache,
  getLatestRelease,
  getReleaseByTag,
  listReleases,
} from './github-release-service'

/** 测试开始前保存的原始 fetch，用于避免污染其他测试。 */
const originalFetch = globalThis.fetch

/** 安装满足 Bun 完整 fetch 类型合同的测试替身。 */
function installFetchMock(
  handler: (input: RequestInfo | URL) => Response | Promise<Response>
): void {
  /** 保留 Bun fetch 静态能力的类型安全替身。 */
  const fetchMock: typeof fetch = Object.assign(
    async (input: RequestInfo | URL): Promise<Response> => handler(input),
    { preconnect: originalFetch.preconnect }
  )
  globalThis.fetch = fetchMock
}

/** 创建字段完整的 GitHub Release 测试数据。 */
function createRelease(
  id: number,
  tagName: string,
  options: { draft?: boolean; prerelease?: boolean } = {}
): GitHubRelease {
  return {
    id,
    tag_name: tagName,
    name: `Release ${tagName}`,
    body: `Notes for ${tagName}`,
    draft: options.draft ?? false,
    prerelease: options.prerelease ?? false,
    created_at: '2026-08-22T00:00:00.000Z',
    published_at: '2026-08-22T01:00:00.000Z',
    html_url: `https://github.com/example/Proma/releases/tag/${tagName}`,
  }
}

/** 创建包含 JSON 响应体的成功响应。 */
function jsonResponse(data: GitHubRelease | GitHubRelease[]): Response {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

beforeEach(() => {
  clearReleaseCache()
})

afterEach(() => {
  globalThis.fetch = originalFetch
  clearReleaseCache()
})

describe('GitHub Release 双来源历史', () => {
  test('Given 未指定来源，When 查询历史，Then 请求 Bone 仓库并只返回最近的 Bone 正式标签', async () => {
    const requestedUrls: string[] = []
    const releases = [
      createRelease(1, 'v0.17.55'),
      createRelease(2, 'v00.17.55-bone.5'),
      createRelease(3, 'v0.017.55-bone.4'),
      createRelease(4, 'v0.17.055-bone.4'),
      createRelease(5, 'v0.17.55-bone.0'),
      createRelease(6, 'v0.17.55-bone.01'),
      createRelease(7, 'v0.17.55-bone.3'),
      createRelease(8, 'v0.17.55-bone.2', { draft: true }),
      createRelease(9, 'v0.17.55-bone.1'),
      createRelease(10, 'v0.17.55-bone.0-beta'),
    ]
    installFetchMock(async input => {
      requestedUrls.push(String(input))
      return jsonResponse(releases)
    })

    const result = await listReleases({ perPage: 2 })

    expect(requestedUrls).toHaveLength(1)
    expect(requestedUrls[0]).toContain('/repos/kuangtao22/Proma/releases?')
    expect(requestedUrls[0]).toContain('per_page=100')
    expect(result.map(release => release.tag_name)).toEqual([
      'v0.17.55-bone.3',
      'v0.17.55-bone.1',
    ])
  })

  test('Given 首页恰好 100 条且有效版本不足，When 查询两条历史，Then 请求第二页补足并在短页停止', async () => {
    const requestedPages: string[] = []
    /** 第一页仅保留一条符合 official 合同的 Release。 */
    const firstPage = Array.from({ length: 100 }, (_, index) =>
      createRelease(
        index + 1,
        index === 0 ? 'v1.0.0' : `v1.0.${index}-bone.1`
      )
    )
    installFetchMock(async input => {
      /** 当前请求的 GitHub 原始页码。 */
      const githubPage = new URL(String(input)).searchParams.get('page') ?? ''
      requestedPages.push(githubPage)
      return jsonResponse(
        githubPage === '1' ? firstPage : [createRelease(101, 'v0.9.0')]
      )
    })

    const result = await listReleases({ source: 'official', perPage: 2 })

    expect(requestedPages).toEqual(['1', '2'])
    expect(result.map(release => release.tag_name)).toEqual([
      'v1.0.0',
      'v0.9.0',
    ])
  })

  test('Given 首页恰好 100 条且已足额，When 查询两条历史，Then 不请求第二页', async () => {
    const requestedPages: string[] = []
    /** 第一页前两条符合 official 合同，其余均为 Bone 标签。 */
    const firstPage = Array.from({ length: 100 }, (_, index) =>
      createRelease(
        index + 1,
        index < 2 ? `v1.0.${1 - index}` : `v1.0.${index}-bone.1`
      )
    )
    installFetchMock(async input => {
      requestedPages.push(
        new URL(String(input)).searchParams.get('page') ?? ''
      )
      return jsonResponse(firstPage)
    })

    const result = await listReleases({ source: 'official', perPage: 2 })

    expect(requestedPages).toEqual(['1'])
    expect(result.map(release => release.tag_name)).toEqual([
      'v1.0.1',
      'v1.0.0',
    ])
  })

  test('Given 包含预发布与草稿，When 允许预发布，Then 仍始终排除草稿', async () => {
    installFetchMock(async () =>
      jsonResponse([
        createRelease(1, 'v1.0.1', { draft: true }),
        createRelease(2, 'v1.0.0', { prerelease: true }),
      ])
    )

    const result = await listReleases({
      source: 'official',
      includePrerelease: true,
    })

    expect(result.map(release => release.tag_name)).toEqual(['v1.0.0'])
  })

  test('Given official 来源，When 查询历史，Then 请求官方仓库并只返回普通正式标签', async () => {
    const requestedUrls: string[] = []
    const releases = [
      createRelease(1, 'v0.17.56-bone.1'),
      createRelease(2, 'v00.17.57'),
      createRelease(3, 'v0.017.57'),
      createRelease(4, 'v0.17.057'),
      createRelease(5, 'v0.17.56'),
      createRelease(6, 'v0.17.55', { prerelease: true }),
      createRelease(7, 'v0.17.54'),
      createRelease(8, '0.17.53'),
    ]
    installFetchMock(async input => {
      requestedUrls.push(String(input))
      return jsonResponse(releases)
    })

    const result = await listReleases({ source: 'official', perPage: 2 })

    expect(requestedUrls).toHaveLength(1)
    expect(requestedUrls[0]).toContain('/repos/ErlichLiu/Proma/releases?')
    expect(result.map(release => release.tag_name)).toEqual([
      'v0.17.56',
      'v0.17.54',
    ])
  })

  test('Given 两个来源均已查询，When 再次查询，Then 各自命中独立缓存', async () => {
    const requestedUrls: string[] = []
    installFetchMock(async input => {
      const url = String(input)
      requestedUrls.push(url)
      return jsonResponse([
        createRelease(
          requestedUrls.length,
          url.includes('/ErlichLiu/') ? 'v0.17.55' : 'v0.17.55-bone.1'
        ),
      ])
    })

    await listReleases({ source: 'bone' })
    await listReleases({ source: 'official' })
    await listReleases({ source: 'bone' })
    await listReleases({ source: 'official' })

    expect(requestedUrls).toHaveLength(2)
  })

  test('Given 当前来源缓存已过期，When 该来源请求失败，Then 只回退当前来源缓存', async () => {
    const originalDateNow = Date.now
    let now = 1_000
    Date.now = () => now
    try {
      installFetchMock(async input =>
        jsonResponse([
          createRelease(
            1,
            String(input).includes('/ErlichLiu/')
              ? 'v0.17.55'
              : 'v0.17.55-bone.1'
          ),
        ])
      )
      await listReleases({ source: 'official' })
      await listReleases({ source: 'bone' })

      now += 31 * 60 * 1000
      installFetchMock(async () => new Response(null, { status: 500 }))

      const result = await listReleases({ source: 'official' })

      expect(result.map(release => release.tag_name)).toEqual(['v0.17.55'])
    } finally {
      Date.now = originalDateNow
    }
  })
})

describe('GitHub Release 查询参数校验', () => {
  test('Given IPC 传入未知来源，When 查询历史，Then 返回明确错误且不发起请求', async () => {
    let requestCount = 0
    installFetchMock(async () => {
      requestCount += 1
      return jsonResponse([])
    })
    /** 模拟越过 TypeScript 类型系统的 IPC 未知输入。 */
    const options = {
      source: 'community',
    } as unknown as GitHubReleaseListOptions

    await expect(listReleases(options)).rejects.toThrow(
      'Release 历史来源必须是 bone 或 official'
    )
    expect(requestCount).toBe(0)
  })

  test.each([0, -1, 1.5, 101])(
    'Given perPage=%s，When 查询历史，Then 拒绝非 1 到 100 的整数',
    async perPage => {
      installFetchMock(async () => jsonResponse([]))

      await expect(listReleases({ perPage })).rejects.toThrow(
        '每页数量必须是 1 到 100 的整数'
      )
    }
  )

  test.each([0, -1, 1.5])(
    'Given page=%s，When 查询历史，Then 拒绝非正整数页码',
    async page => {
      installFetchMock(async () => jsonResponse([]))

      await expect(listReleases({ page })).rejects.toThrow(
        '页码必须是正整数'
      )
    }
  )
})

describe('GitHub Release 自动更新仓库', () => {
  test('Given 自动更新查询，When 获取 latest 与指定 tag，Then 两次请求都固定使用 Bone 仓库', async () => {
    const requestedUrls: string[] = []
    installFetchMock(async input => {
      const url = String(input)
      requestedUrls.push(url)
      return jsonResponse(createRelease(1, 'v0.17.55-bone.1'))
    })

    await getLatestRelease()
    await getReleaseByTag('v0.17.55-bone.1')

    expect(requestedUrls).toHaveLength(2)
    expect(
      requestedUrls.every(url => url.includes('/repos/kuangtao22/Proma/'))
    ).toBe(true)
  })

  test('Given 列表与标签已有缓存，When 清除缓存后再次查询，Then 两类请求都会重新访问 GitHub', async () => {
    const requestedUrls: string[] = []
    installFetchMock(async input => {
      const url = String(input)
      requestedUrls.push(url)
      return url.includes('/releases?')
        ? jsonResponse([createRelease(1, 'v0.17.55-bone.1')])
        : jsonResponse(createRelease(1, 'v0.17.55-bone.1'))
    })

    await listReleases()
    await getReleaseByTag('v0.17.55-bone.1')
    await listReleases()
    await getReleaseByTag('v0.17.55-bone.1')
    clearReleaseCache()
    await listReleases()
    await getReleaseByTag('v0.17.55-bone.1')

    expect(
      requestedUrls.filter(url => url.includes('/releases?'))
    ).toHaveLength(2)
    expect(
      requestedUrls.filter(url => url.includes('/releases/tags/'))
    ).toHaveLength(2)
  })
})
