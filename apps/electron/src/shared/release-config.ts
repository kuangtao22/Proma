/** Proma fork 的唯一 Release 仓库配置。 */
export const PROMA_RELEASE_REPOSITORY = {
  owner: 'kuangtao22',
  repo: 'Proma',
  webUrl: 'https://github.com/kuangtao22/Proma',
} as const

/** Proma fork 的最新 Release 页面，更新下载入口统一跳转到这里。 */
export const PROMA_DOWNLOAD_URL = `${PROMA_RELEASE_REPOSITORY.webUrl}/releases/latest`

/** Proma 官方版本历史的固定 Release 仓库配置。 */
export const PROMA_OFFICIAL_RELEASE_REPOSITORY = {
  owner: 'proma-ai',
  repo: 'Proma',
  webUrl: 'https://github.com/proma-ai/Proma',
} as const

/**
 * 已**完整合入**的上游内容基线（不是 package.json 里的版本号）。
 *
 * 版本号只表达 SemVer：本地版本可能写着 0.19.53，但完整合入的上游内容停在 0.19.31，
 * 其后的官方改动是按需挑选移植的。合入新的官方版本时必须同步更新这个常量，
 * 否则「关于」页会对用户给出错误的上游进度。
 */
export const UPSTREAM_CONTENT_BASELINE = 'v0.19.31（2026-09-05）'
