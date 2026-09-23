import {
  accessSync,
  constants,
  lstatSync,
  mkdirSync,
  realpathSync,
} from 'node:fs'
import { join } from 'node:path'
import type { DataRootStartupIssue } from '@proma/shared'
import { DataRootLocator } from './data-root-locator'
import type { DataRootLocatorResult } from './data-root-locator'
import { prepareNormalDataRoot } from './data-root-marker'

/** 启动时必须稳定存在的 Server Ops 配置子目录。 */
const SERVER_OPS_DIRECTORY_NAME = 'server-ops'

/**
 * 无副作用检查数据根及关键配置目录。
 *
 * @param root 已由 locator 解析出的活动数据根。
 * @returns 首个可向用户展示的问题；子目录缺失由初始化流程处理。
 */
export function inspectDataRootDirectories(root: string): DataRootStartupIssue | undefined {
  /** 根目录问题优先，避免对子路径给出误导性诊断。 */
  const rootIssue = inspectDirectory(root, '应用数据目录', false)
  if (rootIssue) return rootIssue
  return inspectDirectory(join(root, SERVER_OPS_DIRECTORY_NAME), 'Server Ops 配置目录', true)
}

/**
 * 解析启动状态，并仅在显式初始化时准备默认根和关键子目录。
 *
 * @param locator 当前启动或重检使用的全新定位器。
 * @param initialize 是否执行受控且幂等的目录初始化。
 * @returns 可直接用于启动模式判定和恢复页展示的状态。
 */
export function inspectDataRootStartup(
  locator: DataRootLocator,
  initialize = false,
): DataRootLocatorResult {
  /** locator 自身检查不创建目录，迁移状态必须先于目录诊断返回。 */
  const initial = locator.inspect()
  if (initial.status === 'migration' || initial.state.migration !== null) return initial

  /** 损坏 locator 没有可信 activeRoot，直接指向固定 locator 文件。 */
  if (initial.status === 'invalid' || initial.state.activeRoot === null) {
    return withStartupIssue(initial, {
      path: locator.getLocatorPath(),
      code: 'unavailable',
      message: '应用数据目录定位信息无效',
    })
  }

  /** custom 根离线时保持只读，不创建其路径；同时给恢复页具体原因。 */
  if (initial.status === 'unavailable') {
    const issue = inspectDirectory(initial.state.activeRoot, '应用数据目录', false)
      ?? createUnavailableIssue(initial.state.activeRoot, '应用数据目录当前不可用')
    return withStartupIssue(initial, issue)
  }

  /** 只读查询允许受控默认根或关键子目录暂时缺失，不产生副作用。 */
  if (!initialize) {
    if (initial.state.availability === 'missing') return initial
    const issue = inspectDataRootDirectories(initial.state.activeRoot)
    return issue ? withStartupIssue(initial, issue) : initial
  }

  /** normal gate 内先建立默认根身份；custom 根仍沿用 marker 的严格校验。 */
  let activeRoot: string
  try {
    activeRoot = prepareNormalDataRoot(locator, initial)
  } catch (error) {
    /** 创建失败的权限错误比随后 lstat 的 missing 更接近真实原因。 */
    const issue = isPermissionError(error)
      ? createPermissionIssue(initial.state.activeRoot, '应用数据目录')
      : inspectDirectory(initial.state.activeRoot, '应用数据目录', false)
        ?? createUnavailableIssue(initial.state.activeRoot, getErrorMessage(error, '应用数据目录准备失败'))
    return withStartupIssue(initial, issue)
  }

  /** 已存在的文件、链接或不可访问目录必须在任何 mkdir 前被拒绝。 */
  const existingIssue = inspectDataRootDirectories(activeRoot)
  if (existingIssue) return withStartupIssue(initial, existingIssue, activeRoot)

  /** 初始化流程唯一允许自动补建的固定子目录。 */
  const serverOpsDirectory = join(activeRoot, SERVER_OPS_DIRECTORY_NAME)
  try {
    /** 仅补建固定的直接子目录，禁止 recursive 掩盖父路径异常。 */
    mkdirSync(serverOpsDirectory)
  } catch (error) {
    if (!isNodeErrorCode(error, 'EEXIST')) {
      /** mkdir 已明确返回权限问题时，不让缺失路径的二次检查覆盖原因。 */
      const issue = isPermissionError(error)
        ? createPermissionIssue(serverOpsDirectory, 'Server Ops 配置目录')
        : inspectDirectory(serverOpsDirectory, 'Server Ops 配置目录', false)
          ?? createIssueFromError(serverOpsDirectory, 'Server Ops 配置目录', error)
      return withStartupIssue(initial, issue, activeRoot)
    }
  }

  /** mkdir 与检查之间可能发生替换，写后必须用同一规则复验。 */
  const preparedIssue = inspectDataRootDirectories(activeRoot)
  if (preparedIssue) return withStartupIssue(initial, preparedIssue, activeRoot)
  return {
    ...initial,
    status: 'ready',
    state: { ...initial.state, activeRoot, availability: 'available', startupIssue: undefined },
  }
}

/** 检查单个路径为真实、可解析且具备读写进入权限的目录。 */
function inspectDirectory(
  path: string,
  label: '应用数据目录' | 'Server Ops 配置目录',
  allowMissing: boolean,
): DataRootStartupIssue | undefined {
  /** lstat 不跟随最终链接，用于先判定真实路径类型。 */
  let stat: ReturnType<typeof lstatSync>
  try {
    stat = lstatSync(path)
  } catch (error) {
    if (allowMissing && isNodeErrorCode(error, 'ENOENT')) return undefined
    if (isNodeErrorCode(error, 'ENOENT')) return { path, code: 'missing', message: `${label}不存在` }
    return createIssueFromError(path, label, error)
  }
  if (stat.isSymbolicLink()) {
    return { path, code: 'symlink', message: `${label}不能是符号链接或目录联接` }
  }
  if (!stat.isDirectory()) {
    return {
      path,
      code: 'not-directory',
      message: label === 'Server Ops 配置目录' ? 'Server Ops 配置路径被同名文件占用' : '应用数据路径不是目录',
    }
  }
  try {
    accessSync(path, constants.R_OK | constants.W_OK | constants.X_OK)
  } catch {
    return { path, code: 'permission', message: `${label}当前不可读写` }
  }
  try {
    realpathSync(path)
  } catch {
    return createUnavailableIssue(path, `${label}无法安全解析`)
  }
  return undefined
}

/** 将目录问题附加到 locator 状态，并强制进入 recovery 模式。 */
function withStartupIssue(
  result: DataRootLocatorResult,
  issue: DataRootStartupIssue,
  activeRoot = result.state.activeRoot,
): DataRootLocatorResult {
  return {
    ...result,
    status: 'unavailable',
    state: { ...result.state, activeRoot, startupIssue: issue },
  }
}

/** 将底层文件系统错误收敛为稳定的用户可处理分类。 */
function createIssueFromError(path: string, label: string, error: unknown): DataRootStartupIssue {
  if (isPermissionError(error)) return createPermissionIssue(path, label)
  return createUnavailableIssue(path, `${label}当前不可用`)
}

/** 判断错误是否明确表示权限或只读文件系统阻断。 */
function isPermissionError(error: unknown): boolean {
  return isNodeErrorCode(error, 'EACCES')
    || isNodeErrorCode(error, 'EPERM')
    || isNodeErrorCode(error, 'EROFS')
}

/** 创建不会被后续缺失检查覆盖的权限问题。 */
function createPermissionIssue(path: string, label: string): DataRootStartupIssue {
  return { path, code: 'permission', message: `${label}当前不可读写` }
}

/** 创建无法进一步细分的目录问题。 */
function createUnavailableIssue(path: string, message: string): DataRootStartupIssue {
  return { path, code: 'unavailable', message }
}

/** 安全读取 Node 系统错误码。 */
function isNodeErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code
}

/** 提取稳定错误消息，避免把非 Error 值直接传到 renderer。 */
function getErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback
}
