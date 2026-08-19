import { appendFileSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  assertBoneReleaseTag,
  createBoneReleaseTitle,
} from '../src/shared/release-version'

/** GitHub Actions 后续任务需要的发布信息。 */
export interface ValidatedReleaseVersion {
  /** 完整应用版本。 */
  version: string
  /** 当前官方基线。 */
  upstreamVersion: string
  /** 字符串形式的 Bone 构建号。 */
  boneBuild: string
  /** GitHub Release 用户可读标题。 */
  releaseTitle: string
}

/**
 * 校验应用版本与 Git 标签并生成 Actions 输出数据。
 * @param version package.json 中的完整版本。
 * @param tag 触发工作流的 Git 标签。
 * @returns 后续构建和 Release 任务使用的数据。
 */
export function validateReleaseVersion(version: string, tag: string): ValidatedReleaseVersion {
  /** 经过格式和标签一致性校验的发布版本。 */
  const release = assertBoneReleaseTag(version, tag)
  return {
    version: release.fullVersion,
    upstreamVersion: release.upstreamVersion,
    boneBuild: String(release.boneBuild),
    releaseTitle: createBoneReleaseTitle(version),
  }
}

if (import.meta.main) {
  /** Electron workspace package.json 的绝对路径。 */
  const packagePath = resolve(import.meta.dir, '../package.json')
  /** package.json 中本脚本需要的最小元数据。 */
  const metadata = JSON.parse(readFileSync(packagePath, 'utf8')) as { version?: unknown }
  if (typeof metadata.version !== 'string') {
    throw new Error('apps/electron/package.json 缺少有效版本')
  }

  /** 当前工作流的触发标签。 */
  const tag = process.env.GITHUB_REF_NAME
  if (!tag) throw new Error('GitHub Actions 缺少 GITHUB_REF_NAME')

  /** GitHub Actions 跨步骤输出文件。 */
  const outputPath = process.env.GITHUB_OUTPUT
  if (!outputPath) throw new Error('GitHub Actions 缺少 GITHUB_OUTPUT')

  /** 已完成校验的发布信息。 */
  const release = validateReleaseVersion(metadata.version, tag)
  /** 写入 GITHUB_OUTPUT 的稳定键值行。 */
  const outputLines = [
    `version=${release.version}`,
    `upstream_version=${release.upstreamVersion}`,
    `bone_build=${release.boneBuild}`,
    `release_title=${release.releaseTitle}`,
  ]
  appendFileSync(outputPath, `${outputLines.join('\n')}\n`, 'utf8')
  console.log(`[发布校验] ${release.releaseTitle} (${tag})`)
}
