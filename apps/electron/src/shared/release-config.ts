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
