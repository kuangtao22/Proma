/**
 * Installer Manifest 客户端
 *
 * 清单来源是**我们自己的仓库**：`resources/installer-manifest.json` 既是随包发出的兜底清单
 * （构建时打进主进程 bundle），也是运行时优先拉取的远程清单，两者是同一份文件，不会漂。
 *
 * 之前这里请求的是上游商业版接口 `api.proma.cool/api/v1/installers/manifest`——我们的应用
 * 不该代表用户去调用上游服务；换到我们自己的仓库后，版本升级只改一个仓库内的 JSON 即可，
 * 不必重新发版。清单里带官方发布页给出的 sha256 与字节数，下载后由 installer-downloader 校验。
 */

import type { InstallerManifest, InstallerSource } from '@proma/shared'
import { PROMA_RELEASE_REPOSITORY } from '../../shared/release-config'
import bundledManifest from '../../../resources/installer-manifest.json'

/**
 * 远程清单地址：本仓库 main 分支上的同一个 JSON 文件。
 * 仓库改名只需改 `release-config.ts` 里的 owner/repo，这里跟着走。
 */
const MANIFEST_URL = `https://raw.githubusercontent.com/${PROMA_RELEASE_REPOSITORY.owner}/${PROMA_RELEASE_REPOSITORY.repo}/main/apps/electron/resources/installer-manifest.json`
const CACHE_TTL_MS = 5 * 60 * 1000

interface ManifestCache {
  data: InstallerManifest
  timestamp: number
}

let cache: ManifestCache | null = null

/**
 * 校验并归一化清单：只接受字段完整、URL 走 https 的条目，其余丢弃。
 *
 * 远程清单是网络输入，不能直接信任；随包清单也走同一个校验，保证两条路径行为一致。
 *
 * @param value 待校验的原始数据。
 * @returns 归一化后的清单；整体不可用时返回 null。
 */
function normalizeManifest(value: unknown): InstallerManifest | null {
  if (!value || typeof value !== 'object') return null
  const raw = (value as { installers?: unknown }).installers
  if (!Array.isArray(raw)) return null

  const installers: InstallerSource[] = []
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue
    const item = entry as Record<string, unknown>
    const id = typeof item.id === 'string' ? item.id : ''
    const arch = item.arch === 'x64' || item.arch === 'arm64' ? item.arch : null
    const downloadUrl = typeof item.downloadUrl === 'string' ? item.downloadUrl : ''
    const fallbackUrl = typeof item.fallbackUrl === 'string' ? item.fallbackUrl : ''
    /** 至少有一个可下载地址，且必须是 https。 */
    const url = downloadUrl || fallbackUrl
    if (item.platform !== 'win32' || !id || !arch || !url.startsWith('https://')) continue

    installers.push({
      id,
      platform: 'win32',
      arch,
      version: typeof item.version === 'string' ? item.version : '',
      downloadUrl,
      fallbackUrl,
      sha256: typeof item.sha256 === 'string' ? item.sha256 : '',
      sizeBytes: typeof item.sizeBytes === 'number' ? item.sizeBytes : 0,
      filename: typeof item.filename === 'string' ? item.filename : '',
    })
  }

  return installers.length > 0 ? { installers } : null
}

/**
 * 随包发出的兜底清单：断网或远程清单不可用时使用，保证离线也能装上官方 Git / Node。
 * 与远程清单是同一个文件，因此不会出现"内置列表落后于远程列表"的漂移。
 */
const BUILTIN_FALLBACK: InstallerManifest = normalizeManifest(bundledManifest) ?? { installers: [] }

/**
 * 拉取安装包清单：优先本仓库的远程清单，失败回退随包清单。
 * @param force 是否跳过 5 分钟缓存强制刷新。
 */
export async function fetchInstallerManifest(force = false): Promise<InstallerManifest> {
  if (!force && cache && Date.now() - cache.timestamp < CACHE_TTL_MS) {
    return cache.data
  }

  try {
    const response = await fetch(MANIFEST_URL, {
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'DutyDeck-Desktop-App',
      },
    })

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`)
    }

    const manifest = normalizeManifest(await response.json())
    if (!manifest) {
      throw new Error('Manifest format invalid')
    }

    cache = { data: manifest, timestamp: Date.now() }
    console.log(`[Installer Manifest] 远程清单获取成功，共 ${manifest.installers.length} 项`)
    return manifest
  } catch (error) {
    console.warn('[Installer Manifest] 远程清单获取失败，改用随包清单:', error)
    /** 不缓存 fallback，下一次仍然先试远程。 */
    return BUILTIN_FALLBACK
  }
}

/**
 * 从清单中挑出匹配指定 (id, arch) 的条目
 */
export function findInstallerSource(
  manifest: InstallerManifest,
  id: string,
  arch: 'x64' | 'arm64',
): InstallerSource | undefined {
  return manifest.installers.find((s) => s.id === id && s.arch === arch)
}
