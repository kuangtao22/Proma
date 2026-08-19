import { parseBoneReleaseVersion } from '../../shared/release-version'

/** 关于页展示使用的版本信息。 */
export interface AppVersionDisplay {
  /** 完整应用版本。 */
  fullVersion: string
  /** 当前官方基线。 */
  upstreamVersion: string
  /** Bone 构建号；非 Bone 版本不存在。 */
  boneBuild: number | null
}

/**
 * 把完整应用版本转换为关于页展示模型。
 * @param version Vite 注入的完整应用版本。
 * @returns 可分别展示官方版本与 Bone 构建号的数据。
 */
export function createAppVersionDisplay(version: string): AppVersionDisplay {
  /** 合法 Bone 版本可拆分展示；官方纯版本进入回退分支。 */
  const release = parseBoneReleaseVersion(version)
  return release ?? { fullVersion: version, upstreamVersion: version, boneBuild: null }
}
