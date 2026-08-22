/**
 * GitHub Release 服务
 *
 * 从 GitHub API 获取项目的发布日志（Release Notes）
 */

import type {
  GitHubRelease,
  GitHubReleaseHistorySource,
  GitHubReleaseListOptions,
} from '@proma/shared'
import {
  PROMA_OFFICIAL_RELEASE_REPOSITORY,
  PROMA_RELEASE_REPOSITORY,
} from '../../shared/release-config'

/** GitHub API 基础 URL */
const GITHUB_API_BASE = 'https://api.github.com'

/** GitHub API 请求需要的仓库标识。 */
interface GitHubRepository {
  owner: string
  repo: string
}

/** 不同历史来源对应的固定仓库，避免调用方注入任意仓库。 */
const RELEASE_HISTORY_REPOSITORIES: Record<
  GitHubReleaseHistorySource,
  GitHubRepository
> = {
  bone: PROMA_RELEASE_REPOSITORY,
  official: PROMA_OFFICIAL_RELEASE_REPOSITORY,
}

/** GitHub Release 列表单次请求允许的最大数量。 */
const GITHUB_RELEASE_PAGE_SIZE = 100

/** Bone Release 标签必须严格符合带构建号的版本格式。 */
const BONE_RELEASE_TAG_PATTERN =
  /^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)-bone\.\d+$/

/** 官方 Release 标签必须严格符合普通正式版本格式。 */
const OFFICIAL_RELEASE_TAG_PATTERN =
  /^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/

/** Release 缓存 */
interface ReleaseCache {
  data: GitHubRelease[]
  timestamp: number
  /** 是否已经读取到 GitHub 列表末尾。 */
  complete: boolean
}

/** Release 列表缓存按来源隔离，防止不同仓库的数据互相污染。 */
const releaseCache = new Map<GitHubReleaseHistorySource, ReleaseCache>()

/** 单个 Release 缓存（按 tag） */
const tagCache = new Map<string, { data: GitHubRelease; timestamp: number }>()

/** 缓存有效期（30 分钟） */
const CACHE_TTL = 30 * 60 * 1000

/** Rate limit 冷却标记 */
let rateLimitUntil = 0

/**
 * 从 GitHub API 获取 releases
 *
 * @param repository - 固定 GitHub 仓库
 * @param endpoint - API 端点
 * @returns Release 数据
 */
async function fetchFromGitHub<T>(
  repository: GitHubRepository,
  endpoint: string
): Promise<T> {
  // Rate limit 冷却期内直接跳过
  if (Date.now() < rateLimitUntil) {
    throw new Error('GitHub API 请求过于频繁，请稍后再试')
  }

  const url = `${GITHUB_API_BASE}/repos/${repository.owner}/${repository.repo}${endpoint}`

  console.log(`[GitHub Release] 正在请求: ${url}`)

  const response = await fetch(url, {
    headers: {
      'Accept': 'application/vnd.github+json',
      'User-Agent': 'Proma-Desktop-App',
    },
  })

  if (response.status === 403 || response.status === 429) {
    // Rate limited — 冷却 15 分钟
    rateLimitUntil = Date.now() + 15 * 60 * 1000
    throw new Error('GitHub API 请求过于频繁，请 15 分钟后重试')
  }

  if (!response.ok) {
    throw new Error(
      `GitHub API 请求失败 (${response.status})，请检查网络连接后重试`
    )
  }

  return response.json() as Promise<T>
}

/**
 * 获取最新的 Release
 *
 * @returns 最新的 Release，如果没有则返回 null
 */
export async function getLatestRelease(): Promise<GitHubRelease | null> {
  try {
    const release = await fetchFromGitHub<GitHubRelease>(
      PROMA_RELEASE_REPOSITORY,
      '/releases/latest'
    )
    console.log(`[GitHub Release] 获取最新 Release: v${release.tag_name}`)
    return release
  } catch (error) {
    console.error('[GitHub Release] 获取最新 Release 失败:', error)
    return null
  }
}

/**
 * 判断 Release 是否符合指定来源及预发布策略。
 *
 * @param release - GitHub Release 数据
 * @param source - 固定历史来源
 * @param includePrerelease - 是否包含 GitHub 标记的预发布版本
 * @returns 是否应向调用方返回该 Release
 */
function isReleaseVisible(
  release: GitHubRelease,
  source: GitHubReleaseHistorySource,
  includePrerelease: boolean
): boolean {
  if (release.draft || (!includePrerelease && release.prerelease)) {
    return false
  }

  /** 当前来源要求的严格标签格式。 */
  const tagPattern = source === 'bone'
    ? BONE_RELEASE_TAG_PATTERN
    : OFFICIAL_RELEASE_TAG_PATTERN
  return tagPattern.test(release.tag_name)
}

/**
 * 按来源和预发布策略过滤 Release。
 *
 * @param releases - 待过滤的 GitHub Release 列表
 * @param source - 固定历史来源
 * @param includePrerelease - 是否包含预发布版本
 * @returns 符合当前历史合同的 Release 列表
 */
function filterReleases(
  releases: GitHubRelease[],
  source: GitHubReleaseHistorySource,
  includePrerelease: boolean
): GitHubRelease[] {
  return releases.filter(release =>
    isReleaseVisible(release, source, includePrerelease)
  )
}

/**
 * 获取 Release 列表
 *
 * @param options - 查询选项
 * @returns Release 列表
 */
export async function listReleases(
  options: GitHubReleaseListOptions = {}
): Promise<GitHubRelease[]> {
  const {
    source = 'bone',
    perPage = 10,
    page = 1,
    includePrerelease = false,
  } = options

  /** 当前筛选页之前需要跳过的有效 Release 数量。 */
  const resultOffset = (page - 1) * perPage
  /** 为当前筛选页准备的有效 Release 总数。 */
  const requiredResultCount = resultOffset + perPage
  /** 当前来源对应的固定仓库。 */
  const repository = RELEASE_HISTORY_REPOSITORIES[source]
  /** 当前来源的列表缓存。 */
  const cached = releaseCache.get(source)

  try {
    // 检查缓存
    if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
      /** 缓存中符合当前策略的 Release。 */
      const cachedFiltered = filterReleases(
        cached.data,
        source,
        includePrerelease
      )
      if (cached.complete || cachedFiltered.length >= requiredResultCount) {
        console.log(`[GitHub Release] 使用 ${source} 缓存的 Release 列表`)
        return cachedFiltered.slice(resultOffset, requiredResultCount)
      }
    }

    /** 从 GitHub 第一页开始收集的原始 Release。 */
    const releases: GitHubRelease[] = []
    /** GitHub 原始列表的当前页码。 */
    let githubPage = 1
    /** 是否已经读取到 GitHub 列表末尾。 */
    let complete = false

    while (
      filterReleases(releases, source, includePrerelease).length <
      requiredResultCount
    ) {
      /** 当前 GitHub 页的查询参数，固定按最大容量过取。 */
      const params = new URLSearchParams({
        per_page: String(GITHUB_RELEASE_PAGE_SIZE),
        page: String(githubPage),
      })
      /** 当前 GitHub 页返回的原始 Release。 */
      const batch = await fetchFromGitHub<GitHubRelease[]>(
        repository,
        `/releases?${params.toString()}`
      )
      releases.push(...batch)
      if (batch.length < GITHUB_RELEASE_PAGE_SIZE) {
        complete = true
        break
      }
      githubPage += 1
    }

    console.log(
      `[GitHub Release] 获取到 ${releases.length} 个 ${source} Releases`
    )

    releaseCache.set(source, {
      data: releases,
      timestamp: Date.now(),
      complete,
    })

    return filterReleases(releases, source, includePrerelease).slice(
      resultOffset,
      requiredResultCount
    )
  } catch (error) {
    console.error('[GitHub Release] 获取 Release 列表失败:', error)
    // 如果当前来源有缓存，即使过期也返回
    if (cached) {
      console.log(`[GitHub Release] API 请求失败，使用 ${source} 过期缓存`)
      return filterReleases(cached.data, source, includePrerelease).slice(
        resultOffset,
        requiredResultCount
      )
    }
    // 没有缓存时抛出异常，让前端知道加载失败
    throw error instanceof Error ? error : new Error(String(error))
  }
}

/**
 * 根据标签名获取指定的 Release
 *
 * @param tag - 标签名（版本号）
 * @returns 指定的 Release，如果没有则返回 null
 */
export async function getReleaseByTag(tag: string): Promise<GitHubRelease | null> {
  try {
    // 检查缓存
    const cached = tagCache.get(tag)
    if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
      return cached.data
    }

    const release = await fetchFromGitHub<GitHubRelease>(
      PROMA_RELEASE_REPOSITORY,
      `/releases/tags/${tag}`
    )
    console.log(`[GitHub Release] 获取 Release: ${tag}`)

    tagCache.set(tag, { data: release, timestamp: Date.now() })
    return release
  } catch (error) {
    console.error(`[GitHub Release] 获取 Release ${tag} 失败:`, error)
    // 返回过期缓存
    const cached = tagCache.get(tag)
    if (cached) return cached.data
    return null
  }
}

/**
 * 清除缓存
 */
export function clearReleaseCache(): void {
  releaseCache.clear()
  tagCache.clear()
  console.log('[GitHub Release] 缓存已清除')
}
