/**
 * 配置路径工具
 *
 * 管理 Proma 应用的本地配置文件路径。
 * 所有用户配置默认存储在 ~/.proma/，也可由固定 locator 指向自定义数据根。
 *
 */

import { createHash } from 'node:crypto'
import { join, basename, relative, resolve } from 'node:path'
import { mkdirSync, existsSync, cpSync, rmSync, readdirSync, readFileSync, copyFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { rmSyncWithRetry } from './fs-retry'
import { DataRootLocator, type RequireActiveRootOptions } from './data-root-locator'
import { readJsonFileSafe, writeJsonFileAtomic } from './safe-file'

/** 配置路径只依赖活动数据根解析能力，便于测试按实例隔离。 */
export interface ConfigRootResolver {
  /** 返回当前进程固定使用的活动数据根。 */
  requireActiveRoot(options?: RequireActiveRootOptions): string
}

/** 默认定位器延迟到首次路径调用创建，之后进程内唯一且不会热切换。 */
let defaultConfigRootResolver: ConfigRootResolver | null = null

/** 获取进程级默认定位器，模块导入本身不会读取 home 或 locator。 */
function getDefaultConfigRootResolver(): ConfigRootResolver {
  if (defaultConfigRootResolver === null) {
    defaultConfigRootResolver = new DataRootLocator({ homeDir: homedir() })
  }
  return defaultConfigRootResolver
}

/**
 * 获取配置目录名称
 *
 * 开发版与打包版统一返回 '.proma'，共享 Skills、模型、渠道和会话等业务配置。
 * Electron 的 userData 目录仍由主进程独立管理，不受这里影响。
 */
export function getConfigDirName(): string {
  return '.proma'
}

/**
 * 获取配置目录路径
 *
 * 开发版与打包版默认返回 ~/.proma/，配置自定义数据根后返回其绝对路径。
 * 缺失的默认根会按需创建；已配置但不可用的自定义根不会静默回退。
 *
 * @param resolver 活动数据根解析器；测试可注入独立实例，生产使用进程级默认实例。
 */
export function getConfigDir(resolver?: ConfigRootResolver): string {
  /** 显式注入优先，否则首次调用时创建进程级默认 locator。 */
  const activeResolver = resolver ?? getDefaultConfigRootResolver()
  return activeResolver.requireActiveRoot({ createDefault: true })
}

/**
 * 获取渠道配置文件路径
 *
 * @returns 默认路径为 ~/.proma/channels.json
 */
export function getChannelsPath(): string {
  return join(getConfigDir(), 'channels.json')
}

/**
 * 获取对话索引文件路径
 *
 * @returns 默认路径为 ~/.proma/conversations.json
 */
export function getConversationsIndexPath(): string {
  return join(getConfigDir(), 'conversations.json')
}

/**
 * 获取对话消息目录路径
 *
 * 如果目录不存在则自动创建。
 *
 * @returns 默认路径为 ~/.proma/conversations/
 */
export function getConversationsDir(): string {
  const dir = join(getConfigDir(), 'conversations')

  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
    console.log(`[配置] 已创建对话目录: ${dir}`)
  }

  return dir
}

/**
 * 获取指定对话的消息文件路径
 *
 * @param id 对话 ID
 * @returns 默认路径为 ~/.proma/conversations/{id}.jsonl
 */
export function getConversationMessagesPath(id: string): string {
  assertSafeSessionPathSegment(id)
  return resolveContainedDataFile(getConversationsDir(), id)
}

/**
 * 获取附件存储根目录
 *
 * 如果目录不存在则自动创建。
 *
 * @returns 默认路径为 ~/.proma/attachments/
 */
export function getAttachmentsDir(): string {
  const dir = join(getConfigDir(), 'attachments')

  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
    console.log(`[配置] 已创建附件目录: ${dir}`)
  }

  return dir
}

/**
 * 获取指定对话的附件目录
 *
 * 如果目录不存在则自动创建。
 *
 * @param conversationId 对话 ID
 * @returns 默认路径为 ~/.proma/attachments/{conversationId}/
 */
export function getConversationAttachmentsDir(conversationId: string): string {
  const dir = join(getAttachmentsDir(), conversationId)

  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }

  return dir
}

/**
 * 解析附件相对路径为完整路径
 *
 * @param localPath 相对路径 {conversationId}/{uuid}.ext
 * @returns 默认完整路径为 ~/.proma/attachments/{conversationId}/{uuid}.ext
 */
export function resolveAttachmentPath(localPath: string): string {
  return join(getAttachmentsDir(), localPath)
}

/**
 * 获取应用设置文件路径
 *
 * @returns 默认路径为 ~/.proma/settings.json
 */
export function getSettingsPath(): string {
  return join(getConfigDir(), 'settings.json')
}

/** 返回系统生图模型目录文件，不创建目录或读取凭据。 */
export function getImageGenerationModelsPath(): string {
  return join(getConfigDir(), 'image-generation-models.json')
}

/**
 * 获取用户授权的 Markdown Vault 配置路径。
 * 内容仅保存 Vault 根目录与用户授予的能力，不保存笔记正文或索引。
 */
export function getVaultConfigPath(): string {
  return join(getConfigDir(), 'vault.json')
}

/**
 * 解析 Proma 管理的默认 Markdown Vault 目录。
 */
export function resolveDefaultVaultDir(configDir: string): string {
  return join(configDir, 'vault')
}

/**
 * 获取 Proma 管理的默认 Markdown Vault 目录，并在首次使用时创建。
 *
 * @returns 正式版本 ~/.proma/vault/，开发模式 ~/.proma-dev/vault/
 */
export function getDefaultVaultDir(configDir = getConfigDir()): string {
  const dir = resolveDefaultVaultDir(configDir)
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
    console.log(`[配置] 已创建默认 Vault 目录: ${dir}`)
  }
  return dir
}

/**
 * 获取系统默认 App 探测缓存路径
 *
 * @returns 默认路径为 ~/.proma/default-apps.json
 */
export function getDefaultAppsCachePath(): string {
  return join(getConfigDir(), 'default-apps.json')
}

/**
 * 获取用户档案文件路径
 *
 * @returns 默认路径为 ~/.proma/user-profile.json
 */
export function getUserProfilePath(): string {
  return join(getConfigDir(), 'user-profile.json')
}

/**
 * 获取代理配置文件路径
 *
 * @returns 默认路径为 ~/.proma/proxy-settings.json
 */
export function getProxySettingsPath(): string {
  return join(getConfigDir(), 'proxy-settings.json')
}

/**
 * 获取系统提示词配置文件路径
 *
 * @returns 默认路径为 ~/.proma/system-prompts.json
 */
export function getSystemPromptsPath(): string {
  return join(getConfigDir(), 'system-prompts.json')
}

/**
 * 获取 Chat 工具配置文件路径
 *
 * @returns 默认路径为 ~/.proma/chat-tools.json
 */
export function getChatToolsConfigPath(): string {
  return join(getConfigDir(), 'chat-tools.json')
}

/**
 * 获取第三方 MCP OAuth 凭据的加密索引路径。
 *
 * 文件只保存 Electron safeStorage 加密后的 payload，不会写入任何工作区 mcp.json。
 */
export function getMcpOAuthCredentialsPath(): string {
  return join(getConfigDir(), 'mcp-oauth-credentials.json')
}

/**
 * 获取 Agent 会话索引文件路径
 *
 * @returns 默认路径为 ~/.proma/agent-sessions.json
 */
export function getAgentSessionsIndexPath(): string {
  return join(getConfigDir(), 'agent-sessions.json')
}

/**
 * 获取 Agent 会话消息目录路径
 *
 * 如果目录不存在则自动创建。
 *
 * @returns 默认路径为 ~/.proma/agent-sessions/
 */
export function getAgentSessionsDir(): string {
  const dir = join(getConfigDir(), 'agent-sessions')

  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
    console.log(`[配置] 已创建 Agent 会话目录: ${dir}`)
  }

  return dir
}

/**
 * 获取指定 Agent 会话的消息文件路径
 *
 * @param id 会话 ID
 * @returns 默认路径为 ~/.proma/agent-sessions/{id}.jsonl
 */
export function getAgentSessionMessagesPath(id: string): string {
  assertSafeSessionPathSegment(id)
  return resolveContainedDataFile(getAgentSessionsDir(), id)
}

/**
 * 获取 Agent 工作区索引文件路径
 *
 * @returns 默认路径为 ~/.proma/agent-workspaces.json
 */
export function getAgentWorkspacesIndexPath(): string {
  return join(getConfigDir(), 'agent-workspaces.json')
}

/**
 * 获取 Agent 工作区根目录路径
 *
 * 如果目录不存在则自动创建。
 *
 * @returns 默认路径为 ~/.proma/agent-workspaces/
 */
export function getAgentWorkspacesDir(resolver?: ConfigRootResolver): string {
  /** Agent 工作区根必须与调用方解析出的业务数据根保持一致。 */
  const dir = join(getConfigDir(resolver), 'agent-workspaces')

  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
    console.log(`[配置] 已创建 Agent 工作区目录: ${dir}`)
  }

  return dir
}

/**
 * 获取指定 Agent 工作区的目录路径
 *
 * 如果目录不存在则自动创建。
 *
 * @param slug 工作区 slug
 * @param resolver 活动数据根解析器；测试可注入独立实例。
 * @returns 默认路径为 ~/.proma/agent-workspaces/{slug}/
 */
export function getAgentWorkspacePath(
  slug: string,
  resolver?: ConfigRootResolver,
): string {
  /** 指定工作区必须沿用同一次调用传入的数据根解析器。 */
  const dir = join(getAgentWorkspacesDir(resolver), slug)

  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
    console.log(`[配置] 已创建 Agent 工作区: ${dir}`)
  }

  return dir
}

/**
 * 获取指定工作区的 MCP 配置文件路径
 *
 * @param slug 工作区 slug
 * @returns 默认路径为 ~/.proma/agent-workspaces/{slug}/mcp.json
 */
export function getWorkspaceMcpPath(slug: string): string {
  return join(getAgentWorkspacePath(slug), 'mcp.json')
}

/**
 * 获取指定工作区的 Skills 目录路径
 *
 * 如果目录不存在则自动创建。
 *
 * @param slug 工作区 slug
 * @returns 默认路径为 ~/.proma/agent-workspaces/{slug}/skills/
 */
export function getWorkspaceSkillsDir(slug: string): string {
  const dir = join(getAgentWorkspacePath(slug), 'skills')

  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }

  return dir
}

/**
 * 获取工作区文件目录路径
 *
 * 工作区内所有会话可访问的文件存放于此。
 * 如果目录不存在则自动创建。
 *
 * @param slug 工作区 slug
 * @returns 默认路径为 ~/.proma/agent-workspaces/{slug}/workspace-files/
 */
export function getWorkspaceFilesDir(slug: string): string {
  const dir = join(getAgentWorkspacePath(slug), 'workspace-files')

  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }

  return dir
}

/**
 * 解析工作区文件目录路径（只读，不创建目录）
 *
 * 与 getWorkspaceFilesDir 的区别：不会触发 mkdir 副作用，
 * 适用于 /now 等只读查询场景。
 *
 * @param slug 工作区 slug
 * @returns 默认路径为 ~/.proma/agent-workspaces/{slug}/workspace-files/
 */
export function resolveWorkspaceFilesDir(slug: string): string {
  return join(getConfigDir(), 'agent-workspaces', slug, 'workspace-files')
}

/**
 * 解析 Agent 会话工作目录路径（只读，不创建目录）
 *
 * 与 getAgentSessionWorkspacePath 的区别：不会触发 mkdir 副作用，
 * 适用于 /now 等只读查询场景。
 *
 * @param slug 工作区 slug
 * @param sessionId 会话 ID
 * @returns 默认路径为 ~/.proma/agent-workspaces/{slug}/{sessionId}/
 */
export function resolveAgentSessionWorkspacePath(slug: string, sessionId: string): string {
  assertSafeSessionPathSegment(sessionId)
  return resolveContainedSessionPath(join(getConfigDir(), 'agent-workspaces', slug), sessionId)
}

/**
 * 获取工作区不活跃 Skills 目录路径
 *
 * 禁用的 Skill 会被移动到此目录，Agent SDK 不会扫描该目录。
 * 如果目录不存在则自动创建。
 *
 * @param slug 工作区 slug
 * @returns 默认路径为 ~/.proma/agent-workspaces/{slug}/skills-inactive/
 */
export function getInactiveSkillsDir(slug: string): string {
  const dir = join(getAgentWorkspacePath(slug), 'skills-inactive')

  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }

  return dir
}

/**
 * 获取默认 Skills 模板目录路径
 *
 * 新建工作区时自动复制此目录的内容到工作区 skills/ 下。
 *
 * @returns 默认路径为 ~/.proma/default-skills/
 */
export function getDefaultSkillsDir(): string {
  const dir = join(getConfigDir(), 'default-skills')

  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }

  return dir
}

/**
 * 获取打包进 App 的 proma CLI 二进制路径。
 *
 * 打包模式下从 process.resourcesPath/bin 取（electron-builder extraResources 注入）。
 * 开发模式下没有编译二进制——返回 undefined，由调用方回退到源码运行
 * （bun apps/cli/src/index.ts）。
 *
 * @returns 二进制绝对路径；不存在时返回 undefined
 */
export function getBundledCliPath(): string | undefined {
  const { app } = require('electron')
  if (!app.isPackaged) return undefined
  const binName = process.platform === 'win32' ? 'proma.exe' : 'proma'
  const cliPath = join(process.resourcesPath, 'bin', binName)
  return existsSync(cliPath) ? cliPath : undefined
}

/**
 * 从 SKILL.md 的 YAML frontmatter 中解析 version 字段
 *
 * 无 version 字段时返回 '0.0.0'（确保旧 Skill 会被更新）。
 */
export function parseSkillVersion(skillDir: string): string {
  const skillMdPath = join(skillDir, 'SKILL.md')
  if (!existsSync(skillMdPath)) return '0.0.0'

  try {
    let content = readFileSync(skillMdPath, 'utf-8')
    if (content.charCodeAt(0) === 0xFEFF) content = content.slice(1)
    const fmMatch = content.match(/^---\s*\n([\s\S]*?)\n---/)
    if (!fmMatch?.[1]) return '0.0.0'

    for (const line of fmMatch[1].split('\n')) {
      const colonIdx = line.indexOf(':')
      if (colonIdx === -1) continue
      const key = line.slice(0, colonIdx).trim()
      const value = line.slice(colonIdx + 1).trim().replace(/^["']|["']$/g, '')
      if (key === 'version' && value) return value
    }
  } catch {
    // 解析失败视为最低版本
  }

  return '0.0.0'
}

/** 比较两个 semver 版本字符串
 *
 * @returns 正数表示 a > b，0 表示相等，负数表示 a < b
 */
function compareSemver(a: string, b: string): number {
  const pa = a.split('.').map(Number)
  const pb = b.split('.').map(Number)
  for (let i = 0; i < 3; i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (diff !== 0) return diff
  }
  return 0
}

/**
 * 已从 App bundle 移除、但仍需在既有用户目录中清理的默认 Skills。
 *
 * 不根据 bundle 中缺失的目录自动删除，避免误删用户自行安装的 Skills；
 * 后续退役某个内置 Skill 时，显式把它的 slug 加到这里。
 */
export const RETIRED_DEFAULT_SKILL_SLUGS: readonly string[] = [
  'brainstorming',
  'vault',
]

const RETIRED_DEFAULT_SKILL_SLUG_SET = new Set(RETIRED_DEFAULT_SKILL_SLUGS)

export function isRetiredDefaultSkill(slug: string): boolean {
  return RETIRED_DEFAULT_SKILL_SLUG_SET.has(slug)
}

/** 清理默认数据根 default-skills/ 中已退役的内置 Skill 缓存。 */
export function removeRetiredDefaultSkills(dir = getDefaultSkillsDir()): void {
  for (const slug of RETIRED_DEFAULT_SKILL_SLUGS) {
    const target = join(dir, slug)
    if (!existsSync(target)) continue

    try {
      rmSyncWithRetry(target, { recursive: true, force: true })
      console.log(`[配置] 已移除退役默认 Skill: ${slug}`)
    } catch (err) {
      console.warn(`[配置] 移除退役默认 Skill 失败 (${slug}):`, err)
    }
  }
}

/** 防御性目录基名集合：复制 default skills 时永远跳过这些目录，避免
 *  .git 0444 文件、node_modules 文件爆炸等场景把启动期同步链路炸掉。 */
const DEFAULT_SKILL_COPY_BLOCKLIST = new Set([
  '.git',
  '.DS_Store',
  'node_modules',
  'dist',
  '.next',
  '.cache',
  '.turbo',
  '__pycache__',
])

function defaultSkillCopyFilter(src: string): boolean {
  return !DEFAULT_SKILL_COPY_BLOCKLIST.has(basename(src))
}

/**
 * 从 app bundle 同步默认 Skills 到活动数据根的 default-skills/
 *
 * 打包模式下从 process.resourcesPath/default-skills 复制。
 * 开发模式下从源码 default-skills/ 目录复制。
 *
 * - 缺失的 Skill：直接复制
 * - 已存在的 Skill：比较 SKILL.md 中的 version，bundled 更新时才覆盖
 *   （避免每次启动同步 4MB+ 文件阻塞主进程）
 */
export function seedDefaultSkills(): void {
  const { app } = require('electron')
  const bundledDir = app.isPackaged
    ? join(process.resourcesPath, 'default-skills')
    : join(__dirname, '../default-skills')
  const userDir = getDefaultSkillsDir()

  removeRetiredDefaultSkills(userDir)

  if (!existsSync(bundledDir)) {
    console.log('[配置] 未找到内置 default-skills 目录，跳过')
    return
  }

  try {
    const entries = readdirSync(bundledDir, { withFileTypes: true })

    for (const entry of entries) {
      if (!entry.isDirectory()) continue

      const source = join(bundledDir, entry.name)
      const target = join(userDir, entry.name)

      try {
        if (!existsSync(target)) {
          cpSync(source, target, { recursive: true, filter: defaultSkillCopyFilter })
          console.log(`[配置] 已同步默认 Skill: ${entry.name}`)
          continue
        }

        const bundledVer = parseSkillVersion(source)
        const existingVer = parseSkillVersion(target)

        if (compareSemver(bundledVer, existingVer) > 0) {
          // rm-then-cp：rmSync 不依赖目标文件写权限（只读 .git/objects/ 等
          // 0444 文件用 cpSync({ force: true }) 无法覆盖会 EACCES，但
          // rmSync({ force: true }) 只需父目录可写就能 unlink）。
          rmSync(target, { recursive: true, force: true })
          cpSync(source, target, { recursive: true, filter: defaultSkillCopyFilter })
          console.log(`[配置] 已升级默认 Skill: ${entry.name} (${existingVer} → ${bundledVer})`)
        }
      } catch (err) {
        // 单 skill 失败不影响其他 skill 同步。这里吞错是为了防止启动期 bootstrap
        // 链路被任意一个 skill 的同步异常掀翻——窗口和托盘必须先出来。
        console.warn(`[配置] 同步默认 Skill 失败 (${entry.name})，跳过:`, err)
      }
    }
  } catch (err) {
    console.warn('[配置] 同步默认 Skills 失败:', err)
  }
}

/**
 * 获取微信配置文件路径
 *
 * @returns 默认路径为 ~/.proma/wechat.json
 */
export function getWeChatConfigPath(): string {
  return join(getConfigDir(), 'wechat.json')
}

/**
 * 获取微信长轮询同步游标路径
 *
 * @returns 默认路径为 ~/.proma/wechat-sync.json
 */
export function getWeChatSyncPath(): string {
  return join(getConfigDir(), 'wechat-sync.json')
}

/**
 * 获取微信聊天绑定持久化路径
 *
 * @returns 默认路径为 ~/.proma/wechat-bindings.json
 */
export function getWeChatBindingsPath(): string {
  return join(getConfigDir(), 'wechat-bindings.json')
}

/**
 * 获取钉钉配置文件路径
 *
 * @returns 默认路径为 ~/.proma/dingtalk.json
 */
export function getDingTalkConfigPath(): string {
  return join(getConfigDir(), 'dingtalk.json')
}

/**
 * 获取某个钉钉 Bot 的聊天绑定持久化路径
 *
 * @returns 默认路径为 ~/.proma/dingtalk-bindings-{botId}.json
 */
export function getDingTalkBotBindingsPath(botId: string): string {
  return join(getConfigDir(), `dingtalk-bindings-${botId}.json`)
}

/**
 * 获取飞书配置文件路径
 *
 * @returns 默认路径为 ~/.proma/feishu.json
 */
export function getFeishuConfigPath(): string {
  return join(getConfigDir(), 'feishu.json')
}

/**
 * 获取飞书聊天绑定持久化路径
 *
 * @returns 默认路径为 ~/.proma/feishu-bindings.json
 */
export function getFeishuBindingsPath(): string {
  return join(getConfigDir(), 'feishu-bindings.json')
}

/**
 * 获取某个飞书 Bot 的聊天绑定持久化路径
 *
 * @returns 默认路径为 ~/.proma/feishu-bindings-{botId}.json
 */
export function getFeishuBotBindingsPath(botId: string): string {
  return join(getConfigDir(), `feishu-bindings-${botId}.json`)
}

/**
 * 获取某个飞书 Bot 的运行时元数据持久化路径
 *
 * 用于保存最近交互用户 open_id 等需要跨进程重启恢复的状态。
 *
 * @returns 默认路径为 ~/.proma/feishu-metadata-{botId}.json
 */
export function getFeishuBotMetadataPath(botId: string): string {
  return join(getConfigDir(), `feishu-metadata-${botId}.json`)
}

/**
 * 获取指定 Agent 会话的工作路径
 *
 * 在工作区目录下创建以 sessionId 命名的子文件夹，
 * 作为该会话的独立 Agent cwd。如果目录不存在则自动创建。
 *
 * @param workspaceSlug 工作区 slug
 * @param sessionId 会话 ID
 * @returns 默认路径为 ~/.proma/agent-workspaces/{slug}/{sessionId}/
 */
export function getAgentSessionWorkspacePath(workspaceSlug: string, sessionId: string): string {
  assertSafeSessionPathSegment(sessionId)
  const dir = resolveContainedSessionPath(getAgentWorkspacePath(workspaceSlug), sessionId)

  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
    console.log(`[配置] 已创建 Agent 会话工作目录: ${dir}`)
  }

  return dir
}

/** 拒绝可改变目录层级或平台路径语义的会话 ID。 */
function assertSafeSessionPathSegment(sessionId: string): void {
  if (!sessionId || sessionId === '.' || sessionId === '..'
    || sessionId.includes('/') || sessionId.includes('\\') || sessionId.includes('\0')) {
    throw new Error('无效的会话 ID')
  }
}

/** 解析会话目录并再次确认结果仍严格位于工作区根目录内。 */
function resolveContainedSessionPath(workspacePath: string, sessionId: string): string {
  /** 绝对化根目录，避免相对路径影响包含关系判断。 */
  const root = resolve(workspacePath)
  /** 使用 resolve 后再做 relative 判断，阻止其他调用者绕过入口校验。 */
  const candidate = resolve(root, sessionId)
  const relativePath = relative(root, candidate)
  if (!relativePath || relativePath.startsWith('..') || relativePath.includes('/') || relativePath.includes('\\')) {
    throw new Error('无效的会话 ID')
  }
  return candidate
}

/** 解析单实体 JSONL 文件并确认结果仍位于指定数据目录内。 */
function resolveContainedDataFile(dataDirectory: string, entityId: string): string {
  /** 文件扩展名由应用固定追加，调用方只能控制已验证的单段 ID。 */
  const root = resolve(dataDirectory)
  const candidate = resolve(root, `${entityId}.jsonl`)
  const relativePath = relative(root, candidate)
  if (!relativePath || relativePath.startsWith('..') || relativePath.includes('/') || relativePath.includes('\\')) {
    throw new Error('无效的会话 ID')
  }
  return candidate
}

/**
 * 获取 SDK 隔离配置目录路径
 *
 * 用于保存 Pi session artifact 等运行时数据，
 * 而不是用户的 ~/.claude.json，实现 Proma 与 Claude Code CLI 的配置隔离。
 *
 * 如果目录不存在则自动创建。
 *
 * @returns 默认路径为 ~/.proma/sdk-config/
 */
export function getSdkConfigDir(): string {
  const dir = join(getConfigDir(), 'sdk-config')

  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
    console.log(`[配置] 已创建 SDK 配置目录: ${dir}`)
  }

  return dir
}

interface ScratchPadMigrationState {
  version: 1
  legacyContentSha256: string
  migratedAt: number
}

function getScratchPadMigrationStatePath(configDir: string): string {
  return join(configDir, 'scratch-pad-migration.json')
}

function scratchPadContentSha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function readScratchPadMigrationState(path: string): ScratchPadMigrationState | null {
  const state = readJsonFileSafe<unknown>(path)
  if (!state || typeof state !== 'object') return null
  const candidate = state as Partial<ScratchPadMigrationState>
  return candidate.version === 1
    && typeof candidate.legacyContentSha256 === 'string'
    && typeof candidate.migratedAt === 'number'
    ? candidate as ScratchPadMigrationState
    : null
}

function nextScratchPadMigrationPath(vaultDir: string): string {
  const firstPath = join(vaultDir, '草稿.md')
  if (!existsSync(firstPath)) return firstPath
  let suffix = 2
  while (existsSync(join(vaultDir, `草稿 ${suffix}.md`))) suffix += 1
  return join(vaultDir, `草稿 ${suffix}.md`)
}

/** Returns a previous destination for recovery when a crash happened after copying but before writing the marker. */
function findScratchPadMigrationDestination(vaultDir: string, legacyContentSha256: string): string | null {
  const candidates = readdirSync(vaultDir)
    .filter((name) => name.endsWith('.md'))
    .sort()

  for (const candidate of candidates) {
    const path = join(vaultDir, candidate)
    try {
      if (scratchPadContentSha256(path) === legacyContentSha256) return path
    } catch {
      // An unreadable candidate cannot establish successful migration; keep looking.
    }
  }
  return null
}

/**
 * 获取 Scratch Pad 文件路径。
 *
 * 保留原始旧版 scratch-pad.md，并按其内容指纹仅复制到 Proma 管理的默认 Vault 一次。
 * 已存在的 Vault 内容绝不覆盖；旧文件优先复制为草稿.md，重名时使用草稿 N.md。
 * 内容复制成功后以崩溃安全的状态文件记录指纹；重启或重复调用只返回 canonical Vault 路径。
 * 迁移失败时继续使用旧路径，以便下次安全重试。
 *
 * @returns 当前活动数据根下的 vault/scratch-pad.md
 */
export function getScratchPadPath(configDir = getConfigDir()): string {
  const legacyPath = join(configDir, 'scratch-pad.md')
  const vaultDir = getDefaultVaultDir(configDir)
  const vaultPath = join(vaultDir, 'scratch-pad.md')
  if (!existsSync(legacyPath)) return vaultPath

  try {
    const legacyContentSha256 = scratchPadContentSha256(legacyPath)
    const migrationStatePath = getScratchPadMigrationStatePath(configDir)
    const previousMigration = readScratchPadMigrationState(migrationStatePath)
    if (previousMigration?.legacyContentSha256 === legacyContentSha256) return vaultPath

    const recoveredDestination = findScratchPadMigrationDestination(vaultDir, legacyContentSha256)
    const destination = recoveredDestination ?? nextScratchPadMigrationPath(vaultDir)

    if (!recoveredDestination) {
      copyFileSync(legacyPath, destination)
      console.log(`[配置] 已复制旧 Scratch Pad 到默认 Vault: ${destination}`)
    }

    try {
      writeJsonFileAtomic(migrationStatePath, {
        version: 1,
        legacyContentSha256,
        migratedAt: Date.now(),
      } satisfies ScratchPadMigrationState)
    } catch (error) {
      // The copied destination is content-identifiable and will be marked on the next access without another import.
      console.error(`[配置] Scratch Pad 迁移标记写入失败，将在下次访问恢复: ${migrationStatePath}`, error)
    }

    return vaultPath
  } catch (error) {
    console.error(`[配置] Scratch Pad 迁移失败，继续使用旧文件: ${legacyPath}`, error)
    return legacyPath
  }
}

/**
 * 获取定时任务（Automation）配置文件路径
 *
 * @returns 默认路径为 ~/.proma/automations.json
 */
export function getAutomationsPath(): string {
  return join(getConfigDir(), 'automations.json')
}

/** 获取任务/日程 SQLite 数据库路径。 */
export function getPlanningDatabasePath(): string {
  return join(getConfigDir(), 'planning.db')
}
