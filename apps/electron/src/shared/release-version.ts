/** Bone 发布版本的结构化信息。 */
export interface BoneReleaseVersion {
  /** 完整应用版本。 */
  fullVersion: string
  /** 当前合入的官方版本。 */
  upstreamVersion: string
  /** fork 发布构建号。 */
  boneBuild: number
}

/** 只接受无前导零且构建号从 1 开始的 Bone SemVer。 */
const BONE_RELEASE_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)-bone\.([1-9]\d*)$/

/**
 * 解析完整 Bone 发布版本。
 * @param version 完整版本字符串。
 * @returns 合法版本信息；格式非法时返回 null。
 */
export function parseBoneReleaseVersion(version: string): BoneReleaseVersion | null {
  /** 正则捕获的主版本、次版本、补丁版本和 Bone 构建号。 */
  const match = BONE_RELEASE_PATTERN.exec(version)
  if (!match) return null
  /** 与当前 fork 发布对应的官方三段版本。 */
  const upstreamVersion = `${match[1]}.${match[2]}.${match[3]}`
  return { fullVersion: version, upstreamVersion, boneBuild: Number(match[4]) }
}

/**
 * 校验 Git 标签与应用版本严格一致。
 * @param version package.json 中的完整版本。
 * @param tag GitHub Actions 触发标签。
 * @returns 已解析的 Bone 发布版本。
 */
export function assertBoneReleaseTag(version: string, tag: string): BoneReleaseVersion {
  /** 经过格式校验的 Bone 发布信息。 */
  const release = parseBoneReleaseVersion(version)
  if (!release) throw new Error(`应用版本 ${version} 不是合法的 Bone 发布版本`)
  if (tag !== `v${version}`) throw new Error(`发布标签 ${tag} 与应用版本 ${version} 不一致`)
  return release
}

/**
 * 生成用户可读的 GitHub Release 标题。
 * @param version 完整 Bone 发布版本。
 * @returns 同时包含官方版本和 Bone 构建号的标题。
 */
export function createBoneReleaseTitle(version: string): string {
  /** 用于生成人类可读标题的 Bone 发布信息。 */
  const release = parseBoneReleaseVersion(version)
  if (!release) throw new Error(`应用版本 ${version} 不是合法的 Bone 发布版本`)
  return `Proma ${release.upstreamVersion} · Bone ${release.boneBuild}`
}
