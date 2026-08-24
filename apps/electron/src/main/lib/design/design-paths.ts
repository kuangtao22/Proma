import { isAbsolute, join } from 'node:path'
import type { AgentWorkspace } from '@proma/shared'
import { getAgentWorkspace, getProjectFilesPath } from '../agent-workspace-manager'
import { getConfigDir } from '../config-paths'

/** Design 路径解析后的项目正式目录与全局缓存目录。 */
export interface DesignPaths {
  projectId: string
  projectRoot: string
  designRoot: string
  canvasPath: string
  assetsDir: string
  annotationsDir: string
  cacheRoot: string
  preferencesPath: string
  thumbnailsDir: string
  jobsDir: string
  stagingDir: string
}

/** Design 路径解析器，只接受已登记项目 ID。 */
export interface DesignPathResolver {
  /** 根据项目 ID 解析受信任路径，不接受 Renderer 提供的路径。 */
  resolve: (projectId: string) => DesignPaths
}

/** 路径解析器依赖，测试可注入隔离目录。 */
export interface DesignPathResolverDependencies {
  /** 按稳定 ID 查询已登记工作区。 */
  getWorkspace: (projectId: string) => AgentWorkspace | undefined
  /** 按工作区不可变 slug 解析项目文件根。 */
  getProjectFilesPath: (workspaceSlug: string) => string
  /** 返回 Proma 当前活动配置根。 */
  getConfigDir: () => string
}

/** 可安全用作单级文件或目录名的 Design 稳定 ID 规则。 */
const SAFE_DESIGN_STABLE_ID_PATTERN = /^[A-Za-z0-9_-]+$/

/**
 * 判断未知值是否为可安全用作单级路径片段的 Design 稳定 ID。
 * @param value 待校验的项目、任务或实体 ID。
 * @returns 仅非空 ASCII 字母数字、下划线和连字符组成时返回 true。
 */
export function isSafeDesignStableId(value: unknown): value is string {
  return typeof value === 'string' && SAFE_DESIGN_STABLE_ID_PATTERN.test(value)
}

/**
 * 创建仅依赖可信工作区索引的 Design 路径解析器。
 * @param dependencies 工作区索引、项目根和配置根解析依赖。
 * @returns 可按项目稳定 ID 解析正式目录和缓存目录的解析器。
 */
export function createDesignPathResolver(
  dependencies: DesignPathResolverDependencies,
): DesignPathResolver {
  return {
    resolve(projectId: string): DesignPaths {
      if (!isSafeDesignStableId(projectId)) {
        throw new Error(`项目 ID 非法: ${projectId}`)
      }
      /** 只有已登记工作区才拥有正式项目根。 */
      const workspace = dependencies.getWorkspace(projectId)
      if (!workspace || workspace.id !== projectId) {
        throw new Error(`项目不存在: ${projectId}`)
      }

      /** 正式数据根只由工作区 slug 解析，禁止把项目 ID 当文件路径。 */
      const projectRoot = dependencies.getProjectFilesPath(workspace.slug)
      /** 缓存根只由活动配置根和已校验的稳定 ID 组成。 */
      const configRoot = dependencies.getConfigDir()
      if (!isAbsolute(projectRoot) || !isAbsolute(configRoot)) {
        throw new Error('Design 路径必须位于绝对目录')
      }

      /** 项目内可移植的 Design 正式数据根。 */
      const designRoot = join(projectRoot, '.proma', 'design')
      /** 全局可重建的项目 Design 缓存根。 */
      const cacheRoot = join(configRoot, 'design-cache', projectId)
      return {
        projectId,
        projectRoot,
        designRoot,
        canvasPath: join(designRoot, 'canvas.json'),
        assetsDir: join(designRoot, 'assets'),
        annotationsDir: join(designRoot, 'annotations'),
        cacheRoot,
        preferencesPath: join(cacheRoot, 'preferences.json'),
        thumbnailsDir: join(cacheRoot, 'thumbnails'),
        jobsDir: join(cacheRoot, 'jobs'),
        stagingDir: join(cacheRoot, 'staging'),
      }
    },
  }
}

/** 生产 Design 路径解析器，统一复用现有工作区与活动数据根。 */
export const designPathResolver = createDesignPathResolver({
  getWorkspace: getAgentWorkspace,
  getProjectFilesPath,
  getConfigDir,
})
