/**
 * IPC 处理器模块
 *
 * 负责注册主进程和渲染进程之间的通信处理器
 */

import { ipcMain, nativeTheme, shell, dialog, BrowserWindow, app, clipboard, nativeImage } from 'electron'
import type { OpenDialogOptions, SaveDialogOptions, WebContents } from 'electron'
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  ftruncateSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { IPC_CHANNELS, CHANNEL_IPC_CHANNELS, CHAT_IPC_CHANNELS, AGENT_IPC_CHANNELS, AGENT_ISLAND_IPC_CHANNELS, ENVIRONMENT_IPC_CHANNELS, INSTALLER_IPC_CHANNELS, PROXY_IPC_CHANNELS, GITHUB_RELEASE_IPC_CHANNELS, SYSTEM_PROMPT_IPC_CHANNELS, CHAT_TOOL_IPC_CHANNELS, FEISHU_IPC_CHANNELS, DINGTALK_IPC_CHANNELS, WECHAT_IPC_CHANNELS, AUTOMATION_IPC_CHANNELS, PLANNING_IPC_CHANNELS, VAULT_IPC_CHANNELS, PLANNING_CONFLICT_ERROR, MAX_ATTACHMENT_SIZE, CANVAS_IPC_CHANNELS, DESIGN_IPC_CHANNELS, isPromaPermissionMode, normalizePathForCompare, parseCanvasNodeContentMeta, TERMINAL_IPC_CHANNELS } from '@proma/shared'
import { USER_PROFILE_IPC_CHANNELS, SETTINGS_IPC_CHANNELS, SCRATCH_PAD_IPC_CHANNELS, QUICK_TASK_IPC_CHANNELS, VOICE_DICTATION_IPC_CHANNELS, APP_ICON_IPC_CHANNELS, DOCK_BADGE_IPC_CHANNELS, STORAGE_IPC_CHANNELS, WINDOWS_AGENT_ISLAND_IPC_CHANNELS, TRAY_IPC_CHANNELS } from '../types'
import type {
  QuickTaskSubmitInput,
  VoiceDictationAudioChunkInput,
  VoiceDictationCommitInput,
  VoiceDictationCommitResult,
  VoiceDictationPreviewInput,
  VoiceDictationResizeInput,
  VoiceDictationSettings,
  VoiceDictationSettingsUpdate,
  VoiceDictationStartInput,
  VoiceDictationStopInput,
  VoiceDictationTestResult,
  VoiceDictationTextDeliveryInput,
  VoiceDictationToggleInput,
  MicPermissionResult,
} from '../types'
import type {
  RuntimeStatus,
  GitRepoStatus,
  Channel,
  ChannelCreateInput,
  ChannelUpdateInput,
  ChannelTestResult,
  ChannelDirectTestInput,
  FetchModelsInput,
  FetchModelsResult,
  ConversationMeta,
  ChatMessage,
  ChatSendInput,
  GenerateTitleInput,
  AttachmentSaveInput,
  AttachmentSaveResult,
  FileDialogResult,
  FileOrFolderDialogResult,
  RecentMessagesResult,
  AgentSessionMeta,
  AgentActiveSessionSnapshot,
  SetAgentSessionActiveWorktreeInput,
  AgentSendInput,
  AgentThinkingLevel,
  AgentWorkspace,
  AgentGenerateTitleInput,
  AgentSaveFilesInput,
  AgentSaveWorkspaceFilesInput,
  AgentSavedFile,
  AgentAttachDirectoryInput,
  AgentAttachFileInput,
  WorkspaceAttachDirectoryInput,
  WorkspaceAttachFileInput,
  WorkspaceMcpConfig,
  SkillMeta,
  BulkImportSkillItemResult,
  BulkImportSkillsResult,
  BulkImportWorkspaceSelection,
  SkillFileContent,
  WorkspaceCapabilities,
  WorkspaceMemorySummary,
  FileEntry,
  FileSearchResult,
  EnvironmentCheckResult,
  InstallerManifest,
  InstallerDownloadRequest,
  InstallerDownloadResult,
  ProxyConfig,
  SystemProxyDetectResult,
  GitHubRelease,
  GitHubReleaseListOptions,
  PermissionResponse,
  PromaPermissionMode,
  AskUserResponse,
  ExitPlanModeResponse,
  SystemPromptConfig,
  SystemPrompt,
  SystemPromptCreateInput,
  SystemPromptUpdateInput,
  ChatToolInfo,
  ChatToolState,
  ChatToolMeta,
  MoveSessionToWorkspaceInput,
  ForkSessionInput,
  RewindSessionInput,
  RewindSessionResult,
  AgentSessionReferenceSearchInput,
  FeishuConfigInput,
  FeishuConfig,
  FeishuBridgeState,
  FeishuTestResult,
  FeishuChatBinding,
  FeishuPresenceReport,
  FeishuUpdateBindingInput,
  FeishuRegisterAppQRCode,
  FeishuRegisterAppStatus,
  FeishuRegisterAppResult,
  DingTalkConfigInput,
  DingTalkConfig,
  DingTalkBridgeState,
  DingTalkTestResult,
  WeChatConfig,
  WeChatBridgeState,
  SDKMessage,
  GetFileDiffInput,
  DetachedPreviewWindowInput,
  RevertFileInput,
  FileAccessOptions,
  ResolvedFileUrl,
  Automation,
  CreateAutomationInput,
  UpdateAutomationInput,
  Todo,
  TodoListQuery,
  CalendarEvent,
  CalendarEventListQuery,
  PlanningGroup,
  PlanningGroupScope,
  PlanningChangeResource,
  PlanningTag,
  PlanningReminder,
  ActivePlanningReminder,
  CreateTodoInput,
  StartTodoAgentInput,
  StartTodoAgentResult,
  TodoAgentSessionActivation,
  UpdateTodoInput,
  CreateCalendarEventInput,
  UpdateCalendarEventInput,
  CreatePlanningGroupInput,
  UpdatePlanningGroupInput,
  SnoozePlanningReminderInput,
  PlanningNativeSyncEntity,
  PlanningNativeSyncStatus,
  PlanningNativeSyncPermissionResult,
  PlanningNativeSyncTarget,
  PlanningNativeConnection,
  PlanningNativeSyncConflict,
  ConnectPlanningNativeConnectionInput,
  ResolvePlanningNativeSyncConflictInput,
  PlanningSyncProfile,
  SavePlanningSyncProfileInput,
  BrowserViewState,
  BrowserViewLayout,
  BrowserNavigateInput,
  BrowserTabInput,
  BrowserCreateTabInput,
  CanvasChangeEvent,
  AgentCanvasBindingChangeEvent,
  CanvasSessionChangeEvent,
} from '@proma/shared'
import type { UserProfile, AppSettings } from '../types'
import { getRuntimeStatus, getGitRepoStatus, reinitializeRuntime } from './lib/runtime-init'
import { browserController } from './lib/browser-controller'
import { acknowledgeTerminalOutput, closeTerminalsForSession, createTerminal, getTerminalSnapshot, killTerminal, resizeTerminal, writeTerminal } from './lib/terminal-service'
import { getMainWindow } from './lib/main-window-store'
import { resolveBrowserProfileKey } from './lib/browser-profile-policy'
import { getUnstagedChanges, invalidateGitDiffCache, getFileDiff, getUntrackedContent, revertFile, getDiffContents, listWorktrees, getWorktreeChanges, getMainRepoRoot } from './lib/git-diff-service'
import {
  registerPromaDirectoryPath,
  registerPromaAuthorizedFile,
  registerPromaFilePath,
  registerRetainedPromaDirectoryPaths,
  revokePromaPathUrl,
} from './lib/local-file-protocol'
import {
  runStableDirectoryNative,
  type StableDirectoryNativeEntry,
  type StableDirectoryOpenedRoot,
} from './lib/stable-directory-native-host'
import { DesignAssetService } from './lib/design/design-asset-service'
import { DesignContextCatalog } from './lib/design/design-context-catalog'
import { DesignContextOrchestrator } from './lib/design/design-context-orchestrator'
import { DesignImageModelPreferences } from './lib/design/design-image-model-preferences'
import { registerDesignIpcHandlers } from './lib/design/design-ipc'
import { registerCanvasSessionIpcHandlers } from './lib/design/canvas-session-ipc'
import { CanvasSessionStore } from './lib/design/canvas-session-store'
import {
  cleanupDeletedAgentSessionCanvasBindings,
  cleanupDeletedCanvasBindings,
  registerAgentCanvasBindingIpcHandlers,
} from './lib/design/agent-canvas-binding-ipc'
import { AgentCanvasBindingStore } from './lib/design/agent-canvas-binding-store'
import { createCanvasToolAccessFacade } from './lib/design/canvas-tool-access-facade'
import {
  createCanvasOperationSerializer,
  registerCanvasDocumentIpcHandlers,
} from './lib/design/canvas-document-ipc'
import { createCanvasAgentBatchOperationService } from './lib/design/canvas-agent-batch-operation'
import { createCanvasDocumentStore } from './lib/design/canvas-document-store'
import { CanvasAgentNodeCreationService } from './lib/design/canvas-agent-node-creation'
import { createCanvasNodeContentStore } from './lib/design/canvas-node-content-store'
import { createCanvasContentNodeLifecycle } from './lib/design/canvas-content-node-lifecycle'
import { createCanvasImageModuleStore } from './lib/design/canvas-image-module-store'
import { createCanvasImageJobTargetAdapter } from './lib/design/canvas-image-job-target'
import { createCanvasImageInputResolver } from './lib/design/canvas-image-input-resolver'
import {
  runChannelMutationWithImageModelBroadcast,
  updateToolCredentialsWithImageModelBroadcast,
} from './lib/image-model-profile-broadcast'
import { DesignSessionBridge } from './lib/design/design-session-bridge'
import { DesignExecutionSessionLifecycle } from './lib/design/design-execution-session-lifecycle'
import {
  DesignJobManager,
  resolveOwnedDesignJobOutputPath,
  setDefaultDesignJobManager,
} from './lib/design/design-job-manager'
import { designPathResolver } from './lib/design/design-paths'
import { DesignProjectTextIndex } from './lib/design/design-project-text-index'
import { designStore } from './lib/design/design-store'
import { DesignTraceStore } from './lib/design/design-trace-store'
import { ImageGenerationModelCatalog } from './lib/image-generation-model-catalog'
import {
  authorizeDiscoveredVault,
  configureVault,
  createUntitledVaultFile,
  createUntitledVaultFileInFolder,
  createVaultFolder,
  discoverObsidianVaultCandidates,
  discoverVaultCandidates,
  selectDefaultVault,
  getConfiguredVaultFileSystem,
  getVaultSummary,
  setVaultUserContext,
  clearVaultUserContext,
} from './lib/vault-service'
import { registerUpdaterIpc } from './lib/updater/updater-ipc'
import { createLanBridgeIpcDependencies, registerLanBridgeIpcHandlers } from './lib/lan-bridge/lan-bridge-ipc'
import {
  listChannels,
  createChannel,
  updateChannel,
  deleteChannel,
  decryptApiKey,
  testChannel,
  testChannelDirect,
  fetchModels,
  getChannelById,
  getChannelPlanQuota,
} from './lib/channel-manager'
import { loginCodexOAuth, cancelCodexOAuthLogin } from './lib/codex-oauth-service'
import { loginXaiOAuth, cancelXaiOAuthLogin } from './lib/xai-oauth-service'
import { resolvePiReasoningCapability } from './lib/adapters/pi-model-registry'
import { serializeCodexCredentials, serializeXaiCredentials } from '@proma/shared'
import type { CodexOAuthDeviceCode, CodexOAuthLoginMethod, XaiOAuthDeviceCode } from '@proma/shared'
import {
  listConversations,
  createConversation,
  getConversationMessages,
  getRecentMessages,
  updateConversationMeta,
  deleteConversation,
  deleteMessage,
  truncateMessagesFrom,
  updateContextDividers,
  autoArchiveConversations,
  searchConversationMessages,
} from './lib/conversation-manager'
import { sendMessage, stopGeneration, generateTitle } from './lib/chat-service'
import {
  saveAttachment,
  readAttachmentAsBase64,
  deleteAttachment,
  openFileDialog,
  openFileOrFolderDialog,
} from './lib/attachment-service'
import { extractTextFromAttachment } from './lib/document-parser'
import { getTutorialContent, createWelcomeConversation } from './lib/tutorial-service'
import { getUserProfile, updateUserProfile } from './lib/user-profile-service'
import { getSettings, updateSettings } from './lib/settings-service'
import { refreshAgentIslandConfiguration, markAgentIslandSessionViewed } from './lib/agent-island-service'
import { getAgentStatusHoverWindow } from './agent-status-hover-window'
import { setBuiltinMcpUserEnabled } from './lib/builtin-mcp/settings'
import { setDockBadgeCount } from './lib/dock-badge-service'

import { checkEnvironment } from './lib/environment-checker'
import { fetchInstallerManifest, findInstallerSource } from './lib/installer-manifest'
import {
  cancelInstallerDownload,
  downloadInstaller,
  launchInstaller,
} from './lib/installer-downloader'
import { getEffectiveProxyUrl, getProxySettings, saveProxySettings } from './lib/proxy-settings-service'
import { getFetchFn } from './lib/proxy-fetch'
import { detectSystemProxy } from './lib/system-proxy-detector'
import {
  listAutomations,
  getAutomation,
  createAutomation,
  getEffectiveAutomationScheduleFields,
  validateExplicitAutomationScheduleFields,
  updateAutomation,
  deleteAutomation,
} from './lib/automation-manager'
import { runAutomationNow, broadcastChanged as broadcastAutomationsChanged } from './lib/automation-scheduler'
import {
  listTodos,
  getTodo,
  createTodo,
  updateTodo,
  deleteTodo,
  listCalendarEvents,
  createCalendarEvent,
  updateCalendarEvent,
  deleteCalendarEvent,
  listPlanningGroups,
  createPlanningGroup,
  updatePlanningGroup,
  deletePlanningGroup,
  listPlanningTags,
  listActivePlanningReminders,
  acknowledgePlanningReminder,
  snoozePlanningReminder,
  listPlanningSyncProfiles,
  listPlanningNativeConnections,
  connectPlanningNativeConnection,
  disconnectPlanningNativeConnection,
  listPlanningNativeSyncConflicts,
  resolvePlanningNativeSyncConflict,
  savePlanningSyncProfile,
} from './lib/planning-manager'
import { broadcastPlanningChanged } from './lib/planning-events'
import {
  getPlanningNativeSyncStatus,
  listPlanningNativeSyncTargets,
  listPlanningNativeConnectionTargets,
  requestPlanningNativeSyncAccess,
} from './lib/planning-native-sync-service'
import { runPlanningNativeSync } from './lib/planning-native-sync-coordinator'
import {
  listAgentSessions,
  listVisibleAgentSessions,
  listActiveAgentSessions,
  listArchivedAgentSessions,
  countArchivedAgentSessions,
  createAgentSession,
  createAgentSessionWithMetadata,
  getAgentSessionMeta,
  getAgentSessionMessages,
  getAgentSessionSDKMessages,
  resolveAgentCwd,
  updateAgentSessionMeta,
  deleteAgentSession,
  migrateChatToAgentSession,
  moveSessionToWorkspace,
  forkAgentSession,
  autoArchiveAgentSessions,
  cleanupStaleAttachedPaths,
  searchAgentSessionMessages,
  searchAgentSessionReferences,
} from './lib/agent-session-manager'
import {
  assertEnabledModelForChannel,
  listEnabledAgentModelsForChannel,
} from './lib/agent-model-selection'
import { isAgentSessionUserVisible, requireUserVisibleAgentSession } from './lib/agent-session-visibility'
import { agentEventBus, prepareAgentRun, runAgent, runPreparedAgent, runAgentHeadless, stopAgent, generateAgentTitle, saveFilesToAgentSession, saveFilesToWorkspaceFiles, isAgentSessionActive, isAgentSessionBusy, listActiveAgentSessionSnapshots, reserveAgentSessionStart, listActiveCanvasAgentRuns, hasActiveAgentSessions, hasActiveAgentDataWrites, queueAgentMessage, submitOrEnqueueAgentMessage, enqueueAgentQueuedMessage, cancelAgentQueuedMessage, moveAgentQueuedMessage, clearAgentQueuedMessages, updateAgentPermissionMode, rewindAgentSession, setVisibleAgentSession } from './lib/agent-service'
import { registerAgentMessageIpcHandlers } from './lib/agent-message-ipc'
import { registerPathManagementIpcHandlers } from './lib/path-management-ipc'
import {
  getDefaultWorkspaceProjectRelocator,
  listWorkspacePathStates,
  relinkWorkspaceProjectRoot,
} from './lib/workspace-project-relocator-production'
import { replaceAttachedDirectoryWatcher } from './lib/workspace-watcher'
import { getMainWindow as getStoredMainWindow } from './lib/main-window-store'
import { getDefaultDataRootInstanceLeaseRegistry } from './lib/data-root-instance-lease'
import { hasRunningAutomations } from './lib/automation-scheduler'
import { permissionService } from './lib/agent-permission-service'
import { askUserService } from './lib/agent-ask-user-service'
import { exitPlanService } from './lib/agent-exit-plan-service'
import { getAgentSessionWorkspacePath, getAgentWorkspacesDir, getConfigDir, getConversationAttachmentsDir, getWorkspaceSkillsDir, getScratchPadPath, getImageGenerationModelsPath, resolveAttachmentPath } from './lib/config-paths'
import { getCachedDefaultAppInfo, saveCachedDefaultAppInfo } from './lib/default-app-cache'
import { calculateStorageStats, cleanupStorage, cleanupTempFiles } from './lib/storage-service'
import type { CleanupOptions } from './lib/storage-service'
import {
  listAgentWorkspaces,
  createAgentWorkspace,
  updateAgentWorkspace,
  relinkAgentWorkspaceProjectRoot,
  restoreAgentWorkspaceProjectRoot,
  deleteAgentWorkspace,
  reorderAgentWorkspaces,
  ensureDefaultWorkspace,
  getWorkspaceMcpConfig,
  saveWorkspaceMcpConfig,
  getDisabledCliIntegrationIds,
  setCliIntegrationEnabled,
  getAllWorkspaceSkills,
  getOtherWorkspaceSkills,
  getDefaultSkillSlugs,
  getWorkspaceCapabilities,
  getAgentWorkspace,
  getAgentWorkspaceBySlug,
  getLocalProjectRootStatus,
  getProjectFilesPath,
  deleteWorkspaceSkill,
  importSkillFromWorkspace,
  batchImportSkillsFromWorkspaces,
  updateSkillFromSource,
  readWorkspaceSkillContent,
  writeWorkspaceSkillContent,
  toggleWorkspaceSkill,
  listSkillFiles,
  readSkillFile,
  writeSkillFile,
  createSkillEntry,
  deleteSkillEntry,
  renameSkillEntry,
  getWorkspaceMemorySummary,
  readWorkspaceAgentsMd,
  writeWorkspaceAgentsMd,
  listWorkspaceAutoMemoryFiles,
  readWorkspaceAutoMemoryFile,
  writeWorkspaceAutoMemoryFile,
  approveWorkspaceProjectKnowledgeMaintenance,
  getWorkspaceAttachedDirectories,
  getWorkspaceAttachedFiles,
  attachWorkspaceDirectory,
  attachWorkspaceFile,
  detachWorkspaceDirectory,
  detachWorkspaceFile,
  getWorktreeRepos,
  addWorktreeRepo,
  removeWorktreeRepo,
  cleanupStaleWorkspaceAttachedPaths,
} from './lib/agent-workspace-manager'
import { getWorkspaceOperationBlockReason } from './lib/workspace-operation-lock'
import { createWorkspaceOperationGuard } from './lib/workspace-operation-guard'
import { movePathSafely } from './lib/file-move-service'
import { subscribeWorkspaceMemoryChanges } from './lib/workspace-memory-change-watcher'
import { confirmWorkspaceMemoryWindowClose, markWorkspaceMemoryWindowReady } from './lib/workspace-memory-window'
import { deleteMcpCredential, startMcpOAuth, saveMcpApiKey } from './lib/mcp-oauth-service'

/**
 * 每次保存或刷新都会推进工作区代数，使较早的异步 MCP 刷新不能回写较新的配置。
 * 该代数仅用于进程内竞态保护，不写入用户的 mcp.json。
 */
const workspaceMcpRefreshGenerations = new Map<string, number>()
const workspaceMcpPendingValidations = new Map<string, Map<string, import('@proma/shared').McpServerEntry>>()

function advanceWorkspaceMcpRefreshGeneration(workspaceSlug: string): number {
  const generation = (workspaceMcpRefreshGenerations.get(workspaceSlug) ?? 0) + 1
  workspaceMcpRefreshGenerations.set(workspaceSlug, generation)
  return generation
}

function getWorkspaceMcpPendingValidation(workspaceSlug: string, name: string): import('@proma/shared').McpServerEntry | undefined {
  return workspaceMcpPendingValidations.get(workspaceSlug)?.get(name)
}

function setWorkspaceMcpPendingValidation(workspaceSlug: string, name: string, entry: import('@proma/shared').McpServerEntry): void {
  const pending = workspaceMcpPendingValidations.get(workspaceSlug) ?? new Map<string, import('@proma/shared').McpServerEntry>()
  pending.set(name, entry)
  workspaceMcpPendingValidations.set(workspaceSlug, pending)
}

function clearWorkspaceMcpPendingValidation(workspaceSlug: string, name: string): void {
  const pending = workspaceMcpPendingValidations.get(workspaceSlug)
  if (!pending) return
  pending.delete(name)
  if (pending.size === 0) workspaceMcpPendingValidations.delete(workspaceSlug)
}

function clearMissingWorkspaceMcpPendingValidations(workspaceSlug: string, serverNames: ReadonlySet<string>): void {
  const pending = workspaceMcpPendingValidations.get(workspaceSlug)
  if (!pending) return
  for (const name of pending.keys()) {
    if (!serverNames.has(name)) pending.delete(name)
  }
  if (pending.size === 0) workspaceMcpPendingValidations.delete(workspaceSlug)
}

function isWorkspaceMcpRefreshCurrent(workspaceSlug: string, generation: number): boolean {
  return workspaceMcpRefreshGenerations.get(workspaceSlug) === generation
}

import { getAllToolInfos } from './lib/chat-tool-registry'
import { updateToolState, updateToolCredentials, getToolCredentials, addCustomTool, deleteCustomTool } from './lib/chat-tool-config'
import {
  getSystemPromptConfig,
  createSystemPrompt,
  updateSystemPrompt,
  deleteSystemPrompt,
  updateAppendSetting,
  setDefaultPrompt,
} from './lib/system-prompt-manager'
import {
  getLatestRelease,
  listReleases as listGitHubReleases,
  getReleaseByTag,
} from './lib/github-release-service'
import { watchAttachedDirectory, unwatchAttachedDirectory } from './lib/workspace-watcher'
import {
  getFeishuConfig,
  saveFeishuConfig,
  getDecryptedAppSecret,
  getFeishuMultiBotConfig,
  saveFeishuBotConfig,
  removeFeishuBot,
  getDecryptedBotAppSecret,
} from './lib/feishu-config'
import { feishuBridgeManager } from './lib/feishu-bridge-manager'
import { syncFeishuSyncSleepBlocker } from './lib/feishu-sleep-blocker'
import { presenceService } from './lib/feishu-presence'
import { getDingTalkConfig, saveDingTalkConfig, getDecryptedClientSecret, getDingTalkMultiBotConfig, saveDingTalkBotConfig, removeDingTalkBot, getDecryptedBotClientSecret } from './lib/dingtalk-config'
import { dingtalkBridgeManager } from './lib/dingtalk-bridge-manager'
import { listShallowDirectory } from './lib/directory-listing'
import { getWeChatConfig } from './lib/wechat-config'
import { wechatBridge } from './lib/wechat-bridge'

/** 进程级唯一的生图模型目录与项目偏好服务。 */
interface DesignImageModelServices {
  imageModels: ImageGenerationModelCatalog
  imagePreferences: DesignImageModelPreferences
}

/** 延迟创建的进程级唯一实例，避免模块加载阶段提前解析活动配置根。 */
let designImageModelServices: DesignImageModelServices | undefined

/** 获取 Design IPC 与后续任务流程共享的生图模型服务实例。 */
function getDesignImageModelServices(): DesignImageModelServices {
  if (designImageModelServices) return designImageModelServices
  /** 系统目录只保存公开 profile，凭据继续按需从 Nano Banana 工具配置读取。 */
  const imageModels = new ImageGenerationModelCatalog({
    configPath: getImageGenerationModelsPath(),
    getNanoBananaCredentials: () => getToolCredentials('nano-banana'),
    listChannels,
    decryptChannelApiKey: decryptApiKey,
  })
  /** 项目偏好与系统目录共享同一 Catalog，保证选择和任务预检口径一致。 */
  const imagePreferences = new DesignImageModelPreferences({
    pathResolver: designPathResolver,
    imageModels,
  })
  designImageModelServices = { imageModels, imagePreferences }
  return designImageModelServices
}

/** 按渲染进程隔离工作区记忆订阅，并在显式清理或渲染进程销毁时释放。 */
const workspaceMemoryWatchSubscriptions = new Map<number, Map<string, () => void>>()
const workspaceMemoryWatchDestroyedListeners = new Set<number>()

function stopWorkspaceMemoryWatch(webContentsId: number, workspaceSlug: string): void {
  const subscriptions = workspaceMemoryWatchSubscriptions.get(webContentsId)
  if (!subscriptions) return
  const unsubscribe = subscriptions.get(workspaceSlug)
  if (!unsubscribe) return
  unsubscribe()
  subscriptions.delete(workspaceSlug)
  if (subscriptions.size === 0) workspaceMemoryWatchSubscriptions.delete(webContentsId)
}

/** 已知编辑器应用名称白名单（macOS） */
const KNOWN_EDITORS = [
  'Visual Studio Code', 'Cursor', 'Sublime Text', 'Windsurf',
  'Zed', 'CotEditor', 'IntelliJ IDEA', 'Xcode', 'TextEdit',
]

/**
 * 检查路径是否在允许的目录范围内（解析 symlink）
 *
 * extraAllowedPaths 来自 renderer 的 basePaths（用户通过 UI 附加的目录），
 * 虽然 renderer 不可信，但附加目录功能本身就允许用户授权 workspaces 外的路径访问。
 * 攻击者需要先控制 renderer 才能伪造 basePaths，此时已有更大的攻击面。
 */
function realpathOrResolve(path: string): string {
  try {
    return realpathSync(resolve(path))
  } catch {
    return resolve(path)
  }
}

/**
 * 判断 Renderer 是否显式提交了 sessionId 字段。
 * 空字符串、空白字符串和非字符串值也算显式提交，后续必须 fail closed。
 */
function hasExplicitSessionId(value?: FileAccessOptions | string[]): boolean {
  return Boolean(
    value
      && !Array.isArray(value)
      && typeof value === 'object'
      && Object.prototype.hasOwnProperty.call(value, 'sessionId'),
  )
}

/** 单次 Renderer 文件 IPC 固化的会话、工作区与授权根快照。 */
interface RendererFileAccessSnapshot {
  options?: FileAccessOptions
  sessionsById: Map<string, AgentSessionMeta>
  workspacesById: Map<string, AgentWorkspace>
  workspacesBySlug: Map<string, AgentWorkspace>
  managedRoot: string
  authorizedRoots: string[]
}

/** 已打开且完成 Renderer 授权的普通文件；消费方只能读取该稳定 fd。 */
interface AuthorizedRendererFile {
  canonicalPath: string
  byteSize: number
  modifiedAt: number
  readBytes: () => Buffer
  writeText: (content: string) => void
  close: () => void
}

/** 文件读取 guard 的结果，授权快照与实际打开对象属于同一次 IPC。 */
interface RendererFileReadAccessSnapshot extends RendererFileAccessSnapshot {
  authorizedFiles: Map<string, AuthorizedRendererFile>
}

/** 托管路径归属判定；managed=true 且无 owner 表示孤儿或损坏布局。 */
interface ManagedAgentPathOwner {
  managed: boolean
  owner?: AgentSessionMeta
}

/** 只把路径缺失视为可向现有祖先回溯，权限与 IO 故障继续向上抛。 */
function isMissingFileSystemPath(error: unknown): boolean {
  return error instanceof Error
    && 'code' in error
    && (error.code === 'ENOENT' || error.code === 'ENOTDIR')
}

/**
 * 通过最近存在祖先解析 canonical 路径，兼容尚未创建的写入目标。
 * @param filePath Renderer 提交的绝对或相对路径。
 * @returns 消除已有祖先 symlink 后的绝对路径。
 */
function canonicalizeAccessPath(filePath: string): string {
  const suffix: string[] = []
  let cursor = resolve(filePath)
  while (true) {
    try {
      return resolve(realpathSync(cursor), ...suffix.reverse())
    } catch (error) {
      if (!isMissingFileSystemPath(error)) throw error
      const parent = dirname(cursor)
      if (parent === cursor) throw error
      suffix.push(basename(cursor))
      cursor = parent
    }
  }
}

/** 文件系统对象的稳定身份，用于绑定授权与实际消费。 */
interface StableFileSystemIdentity {
  dev: number
  ino: number
}

/** 工作区级共享项不属于任何会话，owner 解析时必须与 session 目录区分。 */
const MANAGED_WORKSPACE_SHARED_ENTRIES = new Set([
  'workspace-files',
  'skills',
  'skills-inactive',
  '.claude',
  'memory',
  'AGENTS.md',
  'CLAUDE.md',
  'mcp.json',
  'config.json',
])

/** 普通 Renderer 缺少跨平台原子 no-replace 能力，文件变更统一 fail closed。 */
const RENDERER_FILE_MUTATION_DISABLED_MESSAGE = 'Renderer 暂不支持删除、重命名或移动文件；请通过 Agent 或系统文件管理器操作'
const RENDERER_GIT_REVERT_DISABLED_MESSAGE = 'Renderer 暂不支持还原文件；请通过 Agent 或 Git 工具操作'

/** 使用同一 Renderer 快照授权 helper 已经打开的全部 canonical root。 */
function authorizeStableDirectoryRoots(
  openedRoots: readonly StableDirectoryOpenedRoot[],
  requestedPaths: readonly string[],
  snapshot: RendererFileAccessSnapshot,
): boolean {
  return openedRoots.length === requestedPaths.length && openedRoots.every((root, index) => (
    root.requestedPath === requestedPaths[index]
      && isPathAllowed(root.canonicalPath, snapshot.options, snapshot)
  ))
}

/** 通过两阶段原生 helper 浅层列出一个已授权目录。 */
async function listStableDirectory(
  directoryPath: string,
  snapshot: RendererFileAccessSnapshot,
): Promise<FileEntry[]> {
  const result = await runStableDirectoryNative(
    {
      mode: 'list',
      roots: [directoryPath],
      maxDepth: 0,
      maxEntries: 10_000,
      ignoreFiles: ['.DS_Store', 'Thumbs.db'],
    },
    (openedRoots) => authorizeStableDirectoryRoots(openedRoots, [directoryPath], snapshot)
      && openedRoots[0]?.isDirectory === true,
  )
  const entries = result.entries.map((entry): FileEntry => ({
    name: entry.name,
    path: entry.path,
    isDirectory: entry.isDirectory,
    size: entry.size,
  }))
  entries.sort((left, right) => {
    if (left.isDirectory !== right.isDirectory) return left.isDirectory ? -1 : 1
    if (left.name.startsWith('.') !== right.name.startsWith('.')) return left.name.startsWith('.') ? 1 : -1
    return left.name.localeCompare(right.name)
  })
  return entries
}

/** 捕获实际文件或目录身份，符号链接不视为可消费对象。 */
function captureStablePathIdentity(filePath: string): StableFileSystemIdentity {
  const stats = lstatSync(filePath)
  if (stats.isSymbolicLink() || (!stats.isFile() && !stats.isDirectory())) throw new Error('文件身份已变化')
  return { dev: stats.dev, ino: stats.ino }
}

/** 复验路径仍指向授权时的同一文件系统对象。 */
function assertStablePathIdentity(filePath: string, expected: StableFileSystemIdentity): void {
  let current: ReturnType<typeof lstatSync>
  try {
    current = lstatSync(filePath)
  } catch (error) {
    throw new Error('文件身份已变化', { cause: error })
  }
  if (current.isSymbolicLink() || current.dev !== expected.dev || current.ino !== expected.ino) {
    throw new Error('文件身份已变化')
  }
}

/** 使用 no-follow fd 读取授权时的同一普通文件。 */
function readStableFile(filePath: string, maxSize: number, afterAuthorized?: () => void): Buffer {
  const safePath = resolve(filePath)
  const fileIdentity = captureStablePathIdentity(safePath)
  const parentPath = dirname(safePath)
  const parentIdentity = captureStablePathIdentity(parentPath)
  afterAuthorized?.()
  let descriptor: number | null = null
  try {
    descriptor = openSync(safePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    const opened = fstatSync(descriptor)
    if (!opened.isFile() || opened.dev !== fileIdentity.dev || opened.ino !== fileIdentity.ino) {
      throw new Error('文件身份已变化')
    }
    assertStablePathIdentity(parentPath, parentIdentity)
    if (opened.size > maxSize) throw new Error('文件过大')
    const content = readFileSync(descriptor)
    const completed = fstatSync(descriptor)
    if (completed.dev !== fileIdentity.dev || completed.ino !== fileIdentity.ino) throw new Error('文件身份已变化')
    return content
  } finally {
    if (descriptor !== null) closeSync(descriptor)
  }
}

/** 严格解码稳定读取的文本内容，拒绝伪装成 UTF-8 的二进制文件。 */
function decodeStablePreviewText(content: Buffer): string | null {
  if (content.includes(0)) return null
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(content)
  } catch {
    return null
  }
  let unsafeControlCount = 0
  for (let index = 0; index < content.length; index++) {
    const byte = content[index]!
    if (byte < 0x20 && byte !== 0x09 && byte !== 0x0a && byte !== 0x0d) {
      if (byte === 0x1b && content[index + 1] === 0x5b) continue
      unsafeControlCount += 1
    }
  }
  return unsafeControlCount > Math.max(4, Math.floor(content.length * 0.01)) ? null : text
}

/** 普通 Renderer IPC 只能访问用户可见的 Agent 会话。 */
function requireVisibleSession(sessionId: string, sessionsById?: ReadonlyMap<string, AgentSessionMeta>): AgentSessionMeta {
  return requireUserVisibleAgentSession(sessionsById?.get(sessionId) ?? getAgentSessionMeta(sessionId))
}

/**
 * 解析 Proma 托管 Agent cwd 的会话 owner，不读取目标文件内容。
 * @param filePath 待访问路径，可为 cwd 本身或其任意后代。
 * @param snapshot 本次 IPC 固化的会话与工作区索引。
 * @returns 是否属于托管 session 形态，以及已验证的 owner。
 */
function getManagedAgentSessionPathOwner(
  filePath: string,
  snapshot: RendererFileAccessSnapshot,
): ManagedAgentPathOwner {
  return getManagedAgentSessionCanonicalPathOwner(canonicalizeAccessPath(filePath), snapshot)
}

/** 使用已验证的 canonical 路径解析托管 owner，避免授权后再次跟随可变路径。 */
function getManagedAgentSessionCanonicalPathOwner(
  canonicalPath: string,
  snapshot: RendererFileAccessSnapshot,
): ManagedAgentPathOwner {
  const relativePath = relative(snapshot.managedRoot, canonicalPath)
  if (!relativePath || relativePath === '..' || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
    return { managed: false }
  }
  /** 托管布局固定为 agent-workspaces/{workspaceSlug}/{sessionId}/...。 */
  const pathSegments = relativePath.split(sep)
  if (pathSegments.length < 2) return { managed: false }
  const workspace = snapshot.workspacesBySlug.get(pathSegments[0]!)
  if (!workspace) return { managed: true }
  if (MANAGED_WORKSPACE_SHARED_ENTRIES.has(pathSegments[1]!)) return { managed: false }
  const candidateSessionId = pathSegments[1]
  const owner = candidateSessionId ? snapshot.sessionsById.get(candidateSessionId) : undefined
  if (!owner || owner.workspaceId !== workspace.id) return { managed: true }
  return { managed: true, owner }
}

/** 校验 canonical 路径的 session owner，供所有 file access 边界兜底。 */
function isManagedAgentSessionPathAllowed(filePath: string, snapshot: RendererFileAccessSnapshot): boolean {
  const result = getManagedAgentSessionPathOwner(filePath, snapshot)
  if (!result.managed) return true
  if (!result.owner || !hasExplicitSessionId(snapshot.options)) return false
  const declaredSession = snapshot.sessionsById.get(snapshot.options?.sessionId ?? '')
  return Boolean(
    declaredSession
      && isAgentSessionUserVisible(declaredSession)
      && isAgentSessionUserVisible(result.owner)
      && declaredSession.id === result.owner.id,
  )
}

function getAuthorizedRoots(
  options?: FileAccessOptions,
  accessSnapshot?: Omit<RendererFileAccessSnapshot, 'authorizedRoots'>,
): string[] {
  const sessionsById = accessSnapshot?.sessionsById ?? new Map(listAgentSessions().map((session) => [session.id, session]))
  const workspaces = accessSnapshot ? [...accessSnapshot.workspacesById.values()] : listAgentWorkspaces()
  const workspacesById = accessSnapshot?.workspacesById ?? new Map(workspaces.map((workspace) => [workspace.id, workspace]))
  const workspacesBySlug = accessSnapshot?.workspacesBySlug ?? new Map(workspaces.map((workspace) => [workspace.slug, workspace]))
  const roots: string[] = [join(tmpdir(), 'proma-preview')]

  if (options?.sessionId) {
    const meta = sessionsById.get(options.sessionId)
    if (meta?.attachedDirectories) {
      roots.push(...meta.attachedDirectories)
    }
    if (meta?.activeWorktree?.path) {
      roots.push(meta.activeWorktree.path)
    }
    if (meta?.attachedFiles) {
      roots.push(...meta.attachedFiles)
    }
    if (meta?.workspaceId) {
      const workspace = workspacesById.get(meta.workspaceId)
      if (workspace?.slug) {
        roots.push(join(getConfigDir(), 'agent-workspaces', workspace.slug, meta.id))
        roots.push(getProjectFilesPath(workspace.slug))
        roots.push(...getWorkspaceAttachedDirectories(workspace.slug))
        roots.push(...getWorkspaceAttachedFiles(workspace.slug))
      }
    }
  }

  if (options?.workspaceSlug) {
    const workspace = workspacesBySlug.get(options.workspaceSlug)
    if (!workspace) return roots
    const workspaceRoot = join(getConfigDir(), 'agent-workspaces', workspace.slug)
    roots.push(...[...MANAGED_WORKSPACE_SHARED_ENTRIES].map((entry) => join(workspaceRoot, entry)))
    roots.push(...getWorkspaceAttachedDirectories(workspace.slug))
    roots.push(...getWorkspaceAttachedFiles(workspace.slug))
  }

  return roots
}

/** 每个文件 IPC 只读取一次 session/workspace 索引并预计算授权根。 */
function createRendererFileAccessSnapshot(access?: FileAccessOptions | string[]): RendererFileAccessSnapshot {
  const options = normalizeFileAccessOptions(access)
  const sessionsById = new Map(listAgentSessions().map((session) => [session.id, session]))
  const workspaces = listAgentWorkspaces()
  const workspacesById = new Map(workspaces.map((workspace) => [workspace.id, workspace]))
  const workspacesBySlug = new Map(workspaces.map((workspace) => [workspace.slug, workspace]))
  const baseSnapshot = {
    options,
    sessionsById,
    workspacesById,
    workspacesBySlug,
    managedRoot: canonicalizeAccessPath(join(getConfigDir(), 'agent-workspaces')),
  }
  const authorizedRoots = getAuthorizedRoots(options, baseSnapshot).flatMap((root) => {
    try {
      return [canonicalizeAccessPath(root)]
    } catch {
      return []
    }
  })
  return { ...baseSnapshot, authorizedRoots }
}

/** 在任何路径解析或文件系统访问前验证声明会话与目标 cwd owner。 */
function requireVisibleFileAccess(
  access?: FileAccessOptions | string[],
  targetPaths: readonly string[] = [],
): RendererFileAccessSnapshot {
  const snapshot = createRendererFileAccessSnapshot(access)
  const sessionIdWasProvided = hasExplicitSessionId(access)
  const declaredSession = sessionIdWasProvided
    ? requireVisibleSession(snapshot.options?.sessionId ?? '', snapshot.sessionsById)
    : undefined
  for (const targetPath of targetPaths) {
    const result = getManagedAgentSessionPathOwner(targetPath, snapshot)
    if (!result.managed) continue
    if (!result.owner) throw new Error('Agent 会话不存在')
    const visibleOwner = requireUserVisibleAgentSession(result.owner)
    if (!declaredSession || declaredSession.id !== visibleOwner.id) throw new Error('Agent 会话不存在')
  }
  return snapshot
}

/** 生成不触碰文件系统的候选路径，实际存在性只由稳定 open 决定。 */
function getRendererFileCandidates(filePath: string, candidateBasePaths?: readonly string[]): string[] {
  if (isAbsolute(filePath)) return [resolve(filePath)]
  const candidates: string[] = []
  for (const basePath of candidateBasePaths ?? []) {
    if (!basePath) continue
    const firstSegment = filePath.split(/[\\/]/)[0]
    if (firstSegment && basename(basePath) === firstSegment) {
      candidates.push(resolve(dirname(basePath), filePath))
    }
    candidates.push(resolve(basePath, filePath))
  }
  return [...new Set(candidates)]
}

/** 判断已打开对象的 canonical 路径是否属于本次固定授权快照。 */
function isCanonicalPathAllowed(
  canonicalPath: string,
  options: FileAccessOptions | undefined,
  snapshot: RendererFileAccessSnapshot,
): boolean {
  const owner = getManagedAgentSessionCanonicalPathOwner(canonicalPath, snapshot)
  if (owner.managed) {
    if (!owner.owner || !hasExplicitSessionId(options)) return false
    const declaredSession = snapshot.sessionsById.get(options?.sessionId ?? '')
    if (!declaredSession || declaredSession.id !== owner.owner.id) return false
  }
  if (options?.unrestricted) return true
  return snapshot.authorizedRoots.some((root) => {
    const relativePath = relative(root, canonicalPath)
    return relativePath === '' || (
      relativePath !== '..'
      && !relativePath.startsWith(`..${sep}`)
      && !isAbsolute(relativePath)
    )
  })
}

/**
 * 先打开实际文件，再用 fd 身份与 canonical 路径完成 owner/root 授权。
 * @param access Renderer 提供的会话或工作区上下文。
 * @param filePath Renderer 提供的绝对或相对文件路径。
 * @param candidateBasePaths 已由授权快照派生的候选根。
 * @param maxSize 最大允许读取字节数。
 * @returns 包含唯一稳定文件 lease 的单次访问快照。
 */
function requireVisibleFileReadAccess(
  access: FileAccessOptions | string[] | undefined,
  filePath: string,
  candidateBasePaths: readonly string[] | undefined,
  maxSize: number,
  existingSnapshot?: RendererFileAccessSnapshot,
  openFlags = constants.O_RDONLY,
): RendererFileReadAccessSnapshot {
  const snapshot = existingSnapshot ?? requireVisibleFileAccess(access)
  const effectiveBasePaths = candidateBasePaths ?? getPreviewCandidateBasePaths(snapshot.options, snapshot)
  const candidates = getRendererFileCandidates(filePath, effectiveBasePaths)
  let lastError: unknown
  for (const candidatePath of candidates) {
    let descriptor: number | undefined
    try {
      descriptor = openSync(candidatePath, openFlags | (constants.O_NOFOLLOW ?? 0))
      const openedStat = fstatSync(descriptor)
      if (!openedStat.isFile()) throw new Error('目标不是普通文件')
      const canonicalPath = realpathSync(candidatePath)
      const pathStat = lstatSync(canonicalPath)
      if (
        !pathStat.isFile()
        || pathStat.isSymbolicLink()
        || pathStat.dev !== openedStat.dev
        || pathStat.ino !== openedStat.ino
        || pathStat.size !== openedStat.size
      ) throw new Error('文件授权校验期间已变化')
      if (!isCanonicalPathAllowed(canonicalPath, snapshot.options, snapshot)) {
        throw new Error('访问路径超出当前会话的授权范围')
      }
      let closed = false
      const stableDescriptor = descriptor
      const authorizedFile: AuthorizedRendererFile = {
        canonicalPath,
        byteSize: openedStat.size,
        modifiedAt: openedStat.mtimeMs,
        readBytes: () => {
          if (closed) throw new Error('Renderer 文件稳定句柄已关闭')
          if (openedStat.size > maxSize) throw new Error('文件过大')
          const beforeReadStat = fstatSync(stableDescriptor)
          if (
            beforeReadStat.dev !== openedStat.dev
            || beforeReadStat.ino !== openedStat.ino
            || beforeReadStat.size !== openedStat.size
          ) throw new Error('文件身份已变化')
          const content = Buffer.alloc(openedStat.size)
          let offset = 0
          while (offset < content.byteLength) {
            const bytesRead = readSync(stableDescriptor, content, offset, content.byteLength - offset, offset)
            if (bytesRead === 0) throw new Error('文件身份已变化')
            offset += bytesRead
          }
          const completedStat = fstatSync(stableDescriptor)
          if (
            completedStat.dev !== openedStat.dev
            || completedStat.ino !== openedStat.ino
            || completedStat.size !== openedStat.size
          ) {
            throw new Error('文件身份已变化')
          }
          return content
        },
        writeText: (content) => {
          if (closed) throw new Error('Renderer 文件稳定句柄已关闭')
          ftruncateSync(stableDescriptor, 0)
          writeFileSync(stableDescriptor, content, 'utf8')
          const completedStat = fstatSync(stableDescriptor)
          if (completedStat.dev !== openedStat.dev || completedStat.ino !== openedStat.ino) {
            throw new Error('文件身份已变化')
          }
        },
        close: () => {
          if (closed) return
          closed = true
          closeSync(stableDescriptor)
        },
      }
      descriptor = undefined
      return {
        ...snapshot,
        authorizedFiles: new Map([
          [filePath, authorizedFile],
          [canonicalPath, authorizedFile],
        ]),
      }
    } catch (error) {
      lastError = error
    } finally {
      if (descriptor !== undefined) closeSync(descriptor)
    }
  }
  throw new Error('文件不存在或不在当前会话的授权范围内', { cause: lastError })
}

/** 打开可写稳定 fd，并沿用读取 guard 的同一对象授权证明。 */
function requireVisibleFileWriteAccess(
  access: FileAccessOptions | string[] | undefined,
  filePath: string,
): RendererFileReadAccessSnapshot {
  return requireVisibleFileReadAccess(
    access,
    filePath,
    undefined,
    Number.MAX_SAFE_INTEGER,
    undefined,
    constants.O_RDWR,
  )
}

function isUnderRoot(resolvedPath: string, root: string): boolean {
  const resolvedRoot = realpathOrResolve(root)
  const relativePath = relative(resolvedRoot, resolvedPath)
  return relativePath === '' || (
    relativePath !== '..'
    && !relativePath.startsWith(`..${sep}`)
    && !isAbsolute(relativePath)
  )
}

function isPathAllowed(
  filePath: string,
  options?: FileAccessOptions,
  accessSnapshot?: RendererFileAccessSnapshot,
): boolean {
  let resolved: string
  try {
    resolved = realpathSync(resolve(filePath))
  } catch {
    return false
  }
  const snapshot = accessSnapshot ?? createRendererFileAccessSnapshot(options)
  if (!isManagedAgentSessionPathAllowed(resolved, snapshot)) return false
  // 文件面板应反映 Agent 实际可访问的路径。调用方已明确开启 unrestricted 时，
  // 保留 realpath 校验以拒绝不存在的目标，但不再按会话附件重复收窄范围。
  if (options?.unrestricted) return true
  return snapshot.authorizedRoots.some((root) => isUnderRoot(resolved, root))
}

function normalizeFileAccessOptions(value?: FileAccessOptions | string[]): FileAccessOptions | undefined {
  if (!value || Array.isArray(value) || typeof value !== 'object') return undefined
  const normalized: FileAccessOptions = {
    workspaceSlug: typeof value.workspaceSlug === 'string' ? value.workspaceSlug : undefined,
    workspaceSkillSlug: typeof value.workspaceSkillSlug === 'string' ? value.workspaceSkillSlug : undefined,
    legacySkillFilePath: typeof value.legacySkillFilePath === 'string' ? value.legacySkillFilePath : undefined,
    candidateBasePaths: Array.isArray(value.candidateBasePaths)
      ? value.candidateBasePaths.filter((p): p is string => typeof p === 'string' && p.length > 0)
      : undefined,
    unrestricted: value.unrestricted === true,
  }
  if (hasExplicitSessionId(value)) {
    normalized.sessionId = typeof value.sessionId === 'string' ? value.sessionId : ''
  }
  return normalized
}

function getWorkspaceSlugsForAccess(
  options?: FileAccessOptions,
  accessSnapshot?: RendererFileAccessSnapshot,
): string[] {
  const workspaceSlugs = new Set<string>()
  if (options?.sessionId) {
    const meta = accessSnapshot?.sessionsById.get(options.sessionId) ?? getAgentSessionMeta(options.sessionId)
    if (meta?.workspaceId) {
      const workspace = accessSnapshot?.workspacesById.get(meta.workspaceId) ?? getAgentWorkspace(meta.workspaceId)
      if (workspace?.slug) workspaceSlugs.add(workspace.slug)
    }
  }
  if (options?.workspaceSlug) {
    workspaceSlugs.add(options.workspaceSlug)
  }
  return Array.from(workspaceSlugs)
}

function getManagedSkillBasePath(
  options?: FileAccessOptions,
  accessSnapshot?: RendererFileAccessSnapshot,
): string | undefined {
  const workspaceSlug = options?.workspaceSkillSlug
  if (!workspaceSlug || !getWorkspaceSlugsForAccess(options, accessSnapshot).includes(workspaceSlug)) return undefined
  const workspace = accessSnapshot?.workspacesBySlug.get(workspaceSlug)
    ?? listAgentWorkspaces().find((item) => item.slug === workspaceSlug)
  return workspace ? getWorkspaceSkillsDir(workspace.slug) : undefined
}

function getAllowedCandidateBasePaths(
  options?: FileAccessOptions,
  accessSnapshot?: RendererFileAccessSnapshot,
): string[] | undefined {
  const allowed = (getPreviewCandidateBasePaths(options, accessSnapshot) ?? [])
    .filter((p) => isPathAllowed(p, options, accessSnapshot))
  return allowed.length > 0 ? allowed : undefined
}

function getLegacySkillBasePath(options?: FileAccessOptions): string | undefined {
  const legacyFilePath = options?.legacySkillFilePath
  if (!legacyFilePath) return undefined
  const normalized = legacyFilePath.replace(/\\/g, '/')
  return normalized.match(/^(.*\/skills)\/[^/]+\/SKILL\.md$/i)?.[1]
}

function getPreviewCandidateBasePaths(
  options?: FileAccessOptions,
  accessSnapshot?: RendererFileAccessSnapshot,
): string[] | undefined {
  const bases = options?.candidateBasePaths?.filter((p) => typeof p === 'string' && p.length > 0) ?? []
  const managedSkillBasePath = getManagedSkillBasePath(options, accessSnapshot)
  if (managedSkillBasePath && !bases.includes(managedSkillBasePath)) {
    bases.unshift(managedSkillBasePath)
  }
  const legacySkillBasePath = getLegacySkillBasePath(options)
  if (legacySkillBasePath && !bases.includes(legacySkillBasePath)) {
    bases.push(legacySkillBasePath)
  }
  return bases.length > 0 ? bases : undefined
}

/** Resolve preview-only relative paths before handing them to OS-level file actions. */
async function resolveFileAccessPath(
  filePath: string,
  options?: FileAccessOptions,
  accessSnapshot?: RendererFileAccessSnapshot,
): Promise<string> {
  const [{ resolve }, { resolveFilePath }] = await Promise.all([
    import('node:path'),
    import('./lib/file-preview-service'),
  ])
  return resolveFilePath(filePath, getPreviewCandidateBasePaths(options, accessSnapshot)) ?? resolve(filePath)
}

async function getAccessRootMainRepo(root: string): Promise<string | null> {
  if (!existsSync(root)) return null
  let probePath = root
  try {
    const stats = statSync(probePath)
    if (stats.isFile()) probePath = dirname(probePath)
  } catch {
    return null
  }
  return getMainRepoRoot(probePath)
}

function ensurePathAllowed(
  filePath: string,
  options?: FileAccessOptions,
  accessSnapshot?: RendererFileAccessSnapshot,
): boolean {
  if (isPathAllowed(filePath, options, accessSnapshot)) return true
  console.warn('[IPC] 拒绝越界路径:', filePath)
  return false
}

/**
 * 在 ensurePathAllowed 基础上，额外放行「已授权仓库的 worktree」。
 *
 * worktree 常被放在主仓库之外（如 ~/proma-dev/worktrees/xxx），其路径不在任何
 * 授权根下，会被 ensurePathAllowed 拒绝。但只要它回溯到的主仓库已被授权，就应放行。
 * 用 git 自身背书（--git-common-dir），避免粗暴跳过安全检查。
 */
async function ensurePathAllowedWithWorktree(
  filePath: string,
  options?: FileAccessOptions,
  accessSnapshot?: RendererFileAccessSnapshot,
): Promise<boolean> {
  const snapshot = accessSnapshot ?? createRendererFileAccessSnapshot(options)
  if (isPathAllowed(filePath, options, snapshot)) return true
  const mainRepo = await getMainRepoRoot(filePath)
  if (mainRepo && isPathAllowed(mainRepo, options, snapshot)) return true
  if (mainRepo) {
    const targetMainRepo = normalizePathForCompare(realpathOrResolve(mainRepo))
    for (const root of snapshot.authorizedRoots) {
      const authorizedMainRepo = await getAccessRootMainRepo(root)
      if (!authorizedMainRepo) continue
      const authorizedRoot = normalizePathForCompare(realpathOrResolve(authorizedMainRepo))
      if (authorizedRoot === targetMainRepo) return true
    }
    for (const workspaceSlug of getWorkspaceSlugsForAccess(options, snapshot)) {
      let repos: import('@proma/shared').WorkspaceWorktreeRepo[]
      try {
        repos = await getWorktreeRepos(workspaceSlug)
      } catch {
        continue
      }
      for (const repo of repos) {
        const repoMain = await getMainRepoRoot(repo.repoPath)
        const repoRoot = normalizePathForCompare(realpathOrResolve(repoMain ?? repo.repoPath))
        if (repoRoot === targetMainRepo) return true
      }
    }
  }
  console.warn('[IPC] 拒绝越界路径:', filePath)
  return false
}

/**
 * 注册 IPC 处理器
 *
 * 注册的通道：
 * - runtime:get-status: 获取运行时状态
 * - git:get-repo-status: 获取指定目录的 Git 仓库状态
 * - channel:*: 渠道管理相关
 * - chat:*: 对话管理 + 消息发送 + 流式事件
 */
/**
 * 打包内置资源目录
 * dev: __dirname/resources（build:resources 阶段拷贝）
 * prod: process.resourcesPath（electron-builder extraResources 产物）
 */
function getBundledResourcesDir(): string {
  return app.isPackaged ? process.resourcesPath : join(__dirname, 'resources')
}

/**
 * 默认 App 探测结果按文件后缀缓存，避免反复 spawn Swift / 注册表查询。
 * 成功结果会落盘；失败只做短暂内存冷却，避免一次瞬时失败导致整会话都隐藏按钮。
 */
const defaultAppCache = new Map<string, import('@proma/shared').DefaultAppInfo>()
const defaultAppFailureCache = new Map<string, number>()
const DEFAULT_APP_FAILURE_RETRY_MS = 60_000

function extOf(filePath: string): string {
  const base = filePath.split(/[\\/]/).pop() ?? ''
  const dot = base.lastIndexOf('.')
  return dot > 0 ? base.slice(dot).toLowerCase() : ''
}

async function getAppIconDataUrl(appPath: string): Promise<string> {
  // macOS: 用 sips 把 App bundle 的 .icns 转成 64×64 PNG 再读。
  // 不要用 nativeImage.createFromPath(.icns) + resize ——某些 Electron 版本对多分辨率 .icns
  // resize 时会 SIGTRAP 直接崩主进程。
  if (process.platform === 'darwin' && appPath.endsWith('.app')) {
    const dataUrl = await getMacAppIconViaSips(appPath)
    if (dataUrl) return dataUrl
  }

  const icon = await app.getFileIcon(appPath, { size: 'large' })
  if (icon.isEmpty()) return ''
  return icon.toDataURL()
}

async function getMacAppIconViaSips(appPath: string): Promise<string> {
  const { existsSync, readFileSync, unlinkSync, mkdtempSync } = await import('node:fs')
  const { join } = await import('node:path')
  const { tmpdir } = await import('node:os')

  // 找 .icns 文件
  const resourcesDir = join(appPath, 'Contents', 'Resources')
  const plistPath = join(appPath, 'Contents', 'Info.plist')
  let iconName: string | null = null
  if (existsSync(plistPath)) {
    const r = await runCmd('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleIconFile', plistPath], { timeoutMs: 2000 })
    if (r.status === 0) iconName = r.stdout.trim()
  }
  const candidates: string[] = []
  if (iconName) candidates.push(join(resourcesDir, iconName.endsWith('.icns') ? iconName : `${iconName}.icns`))
  candidates.push(join(resourcesDir, 'AppIcon.icns'), join(resourcesDir, 'app.icns'), join(resourcesDir, 'icon.icns'))
  const icnsPath = candidates.find((p) => existsSync(p))
  if (!icnsPath) return ''

  const tmp = mkdtempSync(join(tmpdir(), 'proma-icon-'))
  const outPath = join(tmp, 'icon.png')
  try {
    const r = await runCmd('sips', ['-s', 'format', 'png', '-Z', '64', icnsPath, '--out', outPath], { timeoutMs: 4000 })
    if (r.status !== 0 || !existsSync(outPath)) return ''
    const buf = readFileSync(outPath)
    return `data:image/png;base64,${buf.toString('base64')}`
  } finally {
    try { if (existsSync(outPath)) unlinkSync(outPath) } catch { /* ignore */ }
  }
}

/** 异步执行外部命令，超时即 kill；不经 shell，避免 shell 元字符注入。 */
async function runCmd(
  bin: string,
  args: string[],
  opts: { timeoutMs?: number; stdin?: string } = {},
): Promise<{ status: number | null; stdout: string }> {
  const { spawn } = await import('node:child_process')
  const { timeoutMs = 4000, stdin } = opts
  return new Promise((resolvePromise) => {
    const child = spawn(bin, args, {
      stdio: [stdin !== undefined ? 'pipe' : 'ignore', 'pipe', 'ignore'],
    })
    let stdout = ''
    let settled = false
    const finish = (status: number | null) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolvePromise({ status, stdout })
    }
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL') } catch { /* ignore */ }
      finish(null)
    }, timeoutMs)
    child.on('error', () => finish(null))
    child.on('close', (code) => finish(code))
    if (child.stdout) {
      child.stdout.setEncoding('utf8')
      child.stdout.on('data', (chunk: string) => { stdout += chunk })
    }
    if (stdin !== undefined && child.stdin) {
      child.stdin.end(stdin)
    }
  })
}

type CliCommandResult = { status: number | null; stdout: string }
type CliCommandRunner = (bin: string, args: string[], opts: { timeoutMs?: number }) => Promise<CliCommandResult>

/**
 * npm-installed CLIs are commonly exposed as .cmd shims on Windows. Keep the
 * cmd.exe path isolated to fixed catalog commands instead of enabling a shell
 * for the general-purpose runCmd helper.
 */
export function getCliProbeInvocation(
  bin: string,
  args: string[],
  platform = process.platform,
  comSpec = process.env.ComSpec,
): { bin: string; args: string[] } {
  if (platform !== 'win32') return { bin, args }
  return {
    bin: comSpec || 'cmd.exe',
    args: ['/d', '/s', '/c', [bin, ...args].join(' ')],
  }
}

async function runCliCommand(bin: string, args: string[], opts: { timeoutMs?: number }): Promise<CliCommandResult> {
  const invocation = getCliProbeInvocation(bin, args)
  return runCmd(invocation.bin, invocation.args, opts)
}

interface McpRefreshValidation {
  name: string
  fingerprint: string
  lastTestResult: NonNullable<import('@proma/shared').McpServerEntry['lastTestResult']>
}

/**
 * 生成 MCP 可运行配置的稳定摘要。摘要只用于内存中比较，绝不记录或返回，避免暴露 headers/env 中的敏感值。
 */
export function getMcpEntryFingerprint(entry: import('@proma/shared').McpServerEntry): string {
  const sortedEntries = (record: Record<string, string> | undefined): Array<[string, string]> =>
    Object.entries(record ?? {}).sort(([left], [right]) => left.localeCompare(right))

  const canonical = {
    type: entry.type,
    command: entry.command ?? null,
    args: entry.args ? [...entry.args] : null,
    url: entry.url ?? null,
    headers: sortedEntries(entry.headers),
    env: sortedEntries(entry.env),
    timeout: entry.timeout ?? null,
    enabled: entry.enabled,
    isBuiltin: entry.isBuiltin ?? false,
  }
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex')
}

/** 在固定上限内并发执行任务，保留输入顺序，避免同时启动过多 MCP 进程或网络连接。 */
export async function mapWithConcurrency<T, R>(
  values: readonly T[],
  maxConcurrency: number,
  mapper: (value: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (!Number.isInteger(maxConcurrency) || maxConcurrency < 1) {
    throw new Error('maxConcurrency 必须是正整数')
  }

  const results = new Array<R>(values.length)
  let nextIndex = 0
  const worker = async (): Promise<void> => {
    while (nextIndex < values.length) {
      const index = nextIndex++
      results[index] = await mapper(values[index]!, index)
    }
  }
  await Promise.all(Array.from({ length: Math.min(maxConcurrency, values.length) }, worker))
  return results
}

/**
 * 只合并仍与验证开始时完全一致的条目。调用方还必须检查 refresh generation，
 * 因而同名服务器被编辑、禁用、删除或被后一次刷新取代时，旧结果不会落盘。
 */
export function mergeMcpRefreshResults(
  currentConfig: import('@proma/shared').WorkspaceMcpConfig,
  validations: readonly McpRefreshValidation[],
): import('@proma/shared').WorkspaceMcpConfig {
  const servers = { ...currentConfig.servers }
  for (const validation of validations) {
    const currentEntry = servers[validation.name]
    if (currentEntry?.enabled && getMcpEntryFingerprint(currentEntry) === validation.fingerprint) {
      servers[validation.name] = {
        ...currentEntry,
        enabled: validation.lastTestResult.success,
        lastTestResult: validation.lastTestResult,
      }
    }
  }
  return { servers }
}

/**
 * Validates an enabled candidate while the persisted entry remains disabled. If
 * the configuration changed while validation was in flight, return that latest
 * snapshot instead of overwriting it. A failed validation is persisted as a
 * disabled entry, so invalid MCPs are never loaded by the runtime.
 */
async function validateAndConditionallyPersistMcp(
  workspaceSlug: string,
  name: string,
  candidateEntry: import('@proma/shared').McpServerEntry,
  expectedPersistedFingerprint: string,
  expectedRefreshGeneration: number,
): Promise<import('@proma/shared').McpConnectionMutationResult> {
  const { validateMcpServer } = await import('./lib/mcp-validator')
  const result = await validateMcpServer(name, candidateEntry, workspaceSlug)
  const verification = {
    success: result.valid,
    message: result.valid ? (result.message ?? 'MCP 连接成功') : (result.reason ?? 'MCP 连接失败'),
  }
  const current = getWorkspaceMcpConfig(workspaceSlug)
  const currentEntry = current.servers[name]
  if (
    !isWorkspaceMcpRefreshCurrent(workspaceSlug, expectedRefreshGeneration) ||
    !currentEntry ||
    getMcpEntryFingerprint(currentEntry) !== expectedPersistedFingerprint
  ) {
    return { config: current, verification }
  }

  const nextEntry = {
    ...candidateEntry,
    enabled: verification.success,
    lastTestResult: { ...verification, timestamp: Date.now() },
  }
  const config = { servers: { ...current.servers, [name]: nextEntry } }
  clearWorkspaceMcpPendingValidation(workspaceSlug, name)
  saveWorkspaceMcpConfig(workspaceSlug, config)
  return { config, verification }
}

async function runCliProbe(
  runner: CliCommandRunner,
  bin: string,
  args: string[],
): Promise<CliCommandResult> {
  try {
    return await runner(bin, args, { timeoutMs: 2_000 })
  } catch {
    return { status: null, stdout: '' }
  }
}

/**
 * `dws auth status --format json` 是官方的非交互认证探测。只接受其完整、成功且 token 有效的结果；
 * 不读取、返回或持久化 CLI 输出中的任何身份字段。
 */
function isDingTalkCliAuthenticated(result: CliCommandResult): boolean {
  if (result.status !== 0) return false

  try {
    const status = JSON.parse(result.stdout) as {
      success?: unknown
      authenticated?: unknown
      token_valid?: unknown
    }
    return status.success === true && status.authenticated === true && status.token_valid === true
  } catch {
    return false
  }
}

/**
 * 仅将可由 CLI 本身的认证探测确认的集成标记为已连接；命令不存在、超时、未认证和未知探测均保守为 false。
 */
export async function getCliIntegrationStatuses(
  runner: CliCommandRunner = runCliCommand,
  disabledIds: ReadonlySet<string> = new Set(),
): Promise<import('@proma/shared').CliIntegrationStatus[]> {
  const [wecom, dingtalk, github, feishu] = await Promise.all([
    runCliProbe(runner, 'wecom-cli', ['auth', 'show', '--status']),
    runCliProbe(runner, 'dws', ['auth', 'status', '--format', 'json']),
    runCliProbe(runner, 'gh', ['auth', 'status', '--active']),
    runCliProbe(runner, 'lark-cli', ['auth', 'status', '--verify']),
  ])

  return [
    { id: 'wecom-cli', connected: wecom.status === 0 && wecom.stdout.trim().toLowerCase() === 'authorized', enabled: !disabledIds.has('wecom-cli') },
    { id: 'dingtalk-cli', connected: isDingTalkCliAuthenticated(dingtalk), enabled: !disabledIds.has('dingtalk-cli') },
    { id: 'github-cli', connected: github.status === 0, enabled: !disabledIds.has('github-cli') },
    { id: 'feishu-cli', connected: feishu.status === 0, enabled: !disabledIds.has('feishu-cli') },
  ]
}

function parseWindowsRegistryValue(stdout: string): string {
  for (const line of stdout.split(/\r?\n/)) {
    const match = line.match(/\s+REG_\w+\s+(.+)$/)
    if (match?.[1]) return match[1].trim()
  }
  return ''
}

function expandWindowsEnvPath(filePath: string): string {
  return filePath.replace(/%([^%]+)%/g, (token, name: string) => {
    const foundKey = Object.keys(process.env).find((key) => key.toLowerCase() === name.toLowerCase())
    return foundKey ? process.env[foundKey] ?? token : token
  })
}

function parseWindowsExecutablePath(command: string): string {
  const match = command.match(/"([^"]+\.exe)"|([^\s"]+\.exe)/i)
  return expandWindowsEnvPath((match?.[1] || match?.[2] || '').trim())
}

function isSafeWindowsProgId(progId: string): boolean {
  return /^[a-zA-Z0-9_.+-]+$/.test(progId)
}

async function getWindowsDefaultAppCommand(progId: string): Promise<string> {
  if (!isSafeWindowsProgId(progId)) return ''

  const registryResult = await runCmd('reg', [
    'query',
    `HKCR\\${progId}\\shell\\open\\command`,
    '/ve',
  ])
  const registryCommand = parseWindowsRegistryValue(registryResult.stdout)
  if (registryCommand) return registryCommand

  const ftypeResult = await runCmd('cmd', ['/c', `ftype ${progId}`])
  return (ftypeResult.stdout || '').split('=').slice(1).join('=').trim()
}

async function getWindowsDefaultAppInfo(filePath: string): Promise<{ appPath: string; appName: string; isUwp?: boolean } | null> {
  const ext = extOf(filePath)
  // ext 来自渲染进程的 filePath，必须严格校验：cmd /c "assoc ${ext}" 中 & | > < 等会触发命令链
  if (!/^\.[a-zA-Z0-9]+$/.test(ext)) {
    console.log('[DefaultApp] ext 校验失败:', ext)
    return null
  }

  const userChoiceResult = await runCmd('reg', [
    'query',
    `HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\FileExts\\${ext}\\UserChoice`,
    '/v',
    'ProgId',
  ])
  let progId = parseWindowsRegistryValue(userChoiceResult.stdout)
  console.log('[DefaultApp] ext=%s UserChoice progId=%s', ext, progId)

  if (!progId) {
    const assoc = await runCmd('cmd', ['/c', `assoc ${ext}`])
    progId = (assoc.stdout || '').split('=').slice(1).join('=').trim()
    console.log('[DefaultApp] assoc fallback progId=%s', progId)
  }
  // 第三 fallback：HKCU OpenWithList MRU（取最近使用的 exe，与 Windows 设置显示一致）
  if (!progId) {
    const mruResult = await runCmd('reg', [
      'query',
      `HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\FileExts\\${ext}\\OpenWithList`,
    ])
    const mruLine = mruResult.stdout.split(/\r?\n/).find((l) => /\s+MRUList\s+REG_SZ\s+/.test(l))
    const mruOrder = mruLine?.split(/\s+REG_SZ\s+/)[1]?.trim() ?? ''
    if (mruOrder) {
      const firstKey = mruOrder[0]
      const exeLine = mruResult.stdout.split(/\r?\n/).find((l) => new RegExp(`\\s+${firstKey}\\s+REG_SZ\\s+`).test(l))
      const exeName = exeLine?.split(/\s+REG_SZ\s+/)[1]?.trim() ?? ''
      if (exeName && /^[a-zA-Z0-9 _.+()-]+\.exe$/i.test(exeName)) {
        // 从 App Paths 把 exe 名转成 progId（取 exe 对应的 HKCR 下注册的 ProgId）
        // 直接用 exe 名（去掉 .exe）当 appName，appPath 从 App Paths 查
        const appName = exeName.replace(/\.exe$/i, '')
        const apResult = await runCmd('reg', [
          'query', `HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\${exeName}`, '/ve',
        ])
        let exePath = parseWindowsRegistryValue(apResult.stdout)
        if (!exePath) {
          const apResult2 = await runCmd('reg', [
            'query', `HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\${exeName}`, '/ve',
          ])
          exePath = parseWindowsRegistryValue(apResult2.stdout)
        }
        console.log('[DefaultApp] OpenWithList MRU fallback: exe=%s path=%s', exeName, exePath)
        if (exePath) return { appPath: exePath, appName }
      }
    }
  }
  // 第四 fallback：HKCU OpenWithProgids（无 UserChoice 但有文件类型关联时）
  if (!progId) {
    const owpResult = await runCmd('reg', [
      'query',
      `HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\FileExts\\${ext}\\OpenWithProgids`,
    ])
    // 取第一个非空值名（跳过空行和路径行）
    for (const line of owpResult.stdout.split(/\r?\n/)) {
      const m = line.match(/^\s+(\S+)\s+REG_/)
      if (m && m[1] && isSafeWindowsProgId(m[1])) {
        progId = m[1]
        console.log('[DefaultApp] OpenWithProgids fallback progId=%s', progId)
        break
      }
    }
  }
  if (!progId || !isSafeWindowsProgId(progId)) {
    console.log('[DefaultApp] progId 无效或不安全:', progId)
    return null
  }

  // UWP 应用：shell\open\command 下只有 DelegateExecute，没有传统 exe 路径
  // 从 Application 子键读 ApplicationName 作为 appName
  if (progId.startsWith('AppX')) {
    const nameResult = await runCmd('reg', [
      'query', `HKCR\\${progId}\\Application`, '/v', 'ApplicationName',
    ])
    let appName = parseWindowsRegistryValue(nameResult.stdout)
    // ApplicationName 通常是资源引用 "@{...?ms-resource://...}"，取最后一段
    if (appName.startsWith('@{')) {
      const appIdResult = await runCmd('reg', [
        'query', `HKCR\\${progId}\\Application`, '/v', 'AppUserModelId',
      ])
      const appUserModelId = parseWindowsRegistryValue(appIdResult.stdout)
      // AppUserModelId 形如 "Microsoft.ZuneVideo_8wekyb3d8bbwe!Microsoft.ZuneVideo"
      // 取 ! 之后的部分作为名字，再去掉前缀
      const parts = appUserModelId.split('!')
      appName = (parts[1] ?? parts[0] ?? '').replace(/^Microsoft\./, '').replace(/^Windows\./, '') || 'UWP App'
    }
    console.log('[DefaultApp] UWP app, appName=%s', appName)
    return { appPath: '', appName, isUwp: true }
  }

  const command = await getWindowsDefaultAppCommand(progId)
  console.log('[DefaultApp] open command:', command)
  const appPath = parseWindowsExecutablePath(command)
  console.log('[DefaultApp] parsed appPath:', appPath)
  if (!appPath) {
    // Fallback：从 HKCR\<progId> 默认值取 app 名，从 App Paths 找 exe
    const rootResult = await runCmd('reg', ['query', `HKCR\\${progId}`, '/ve'])
    const rootName = parseWindowsRegistryValue(rootResult.stdout)
    // AppUserModelId 字段（非 UWP 也可能有，如 Quark）
    const appModelResult = await runCmd('reg', ['query', `HKCR\\${progId}`, '/v', 'AppUserModelId'])
    const appModelId = parseWindowsRegistryValue(appModelResult.stdout)
    const candidateAppName = (appModelId || rootName || '').replace(/\s+(HTML?\s+)?(Document|File)$/i, '').trim()
    if (!candidateAppName || !/^[a-zA-Z0-9 _.+-]+$/.test(candidateAppName)) return null
    // 从 App Paths 找 exe（应用注册了 App Paths 就能找到）
    const appPathsResult = await runCmd('reg', [
      'query', `HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\${candidateAppName}.exe`, '/ve',
    ])
    let exePath = parseWindowsRegistryValue(appPathsResult.stdout)
    if (!exePath) {
      const appPathsResult2 = await runCmd('reg', [
        'query', `HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\${candidateAppName}.exe`, '/ve',
      ])
      exePath = parseWindowsRegistryValue(appPathsResult2.stdout)
    }
    console.log('[DefaultApp] App Paths fallback: candidateAppName=%s exePath=%s', candidateAppName, exePath)
    if (!exePath) return null
    const base = exePath.split(/[\\/]/).pop() || ''
    return { appPath: exePath, appName: base.replace(/\.exe$/i, '') }
  }

  const base = appPath.split(/[\\/]/).pop() || ''
  return { appPath, appName: base.replace(/\.exe$/i, '') }
}

async function getDefaultAppInfoForFile(
  absPath: string,
): Promise<import('@proma/shared').DefaultAppInfo | null> {
  const cacheKey = `${process.platform}:${extOf(absPath) || absPath}`
  const cachedInfo = defaultAppCache.get(cacheKey) ?? getCachedDefaultAppInfo(cacheKey)
  if (cachedInfo) {
    defaultAppCache.set(cacheKey, cachedInfo)
    return cachedInfo
  }
  if (isFailureCacheFresh(cacheKey)) return null

  let appPath = ''
  let appName = ''

  if (process.platform === 'darwin') {
    // 通过 swift + AppKit/NSWorkspace.urlForApplication(toOpen:) 调 LaunchServices。
    // 比 AppleScript 的 `default application of (file as alias)` 稳得多——后者在 macOS 14+
    // 经常返回 -1700（无法转 alias），即便文件存在、默认 App 已正确设置。
    // swift 通过 stdin 接收脚本，文件路径作为 argv[1]，杜绝任何字符串拼接注入。
    const swiftSrc = `import Foundation
import AppKit
let path = CommandLine.arguments.dropFirst().first ?? ""
let url = URL(fileURLWithPath: path)
if let appUrl = NSWorkspace.shared.urlForApplication(toOpen: url) {
  print(appUrl.path)
} else {
  exit(1)
}`
    const r = await runCmd('swift', ['-', absPath], { stdin: swiftSrc, timeoutMs: 6000 })
    if (r.status === 0) {
      appPath = r.stdout.trim().replace(/\/$/, '')
    }
    console.log('[DefaultApp] darwin swift 结果: status=%s appPath=%s', r.status, appPath)
    if (appPath.endsWith('.app')) {
      const base = appPath.split('/').pop() || ''
      appName = base.replace(/\.app$/, '')
    }
  } else if (process.platform === 'win32') {
    const info = await getWindowsDefaultAppInfo(absPath)
    console.log('[DefaultApp] win32 getWindowsDefaultAppInfo 结果:', info)
    if (!info) return cacheNull(cacheKey)
    appPath = info.isUwp ? absPath : info.appPath
    appName = info.appName
  } else {
    const mimeRes = await runCmd('xdg-mime', ['query', 'filetype', absPath])
    const mime = mimeRes.stdout.trim()
    if (!mime) return cacheNull(cacheKey)
    const defRes = await runCmd('xdg-mime', ['query', 'default', mime])
    const desktop = defRes.stdout.trim()
    if (!desktop) return cacheNull(cacheKey)
    const { homedir } = await import('node:os')
    const candidates = [
      `${homedir()}/.local/share/applications/${desktop}`,
      `/usr/share/applications/${desktop}`,
      `/usr/local/share/applications/${desktop}`,
    ]
    const { existsSync, readFileSync } = await import('node:fs')
    const desktopPath = candidates.find((p) => existsSync(p))
    if (!desktopPath) return cacheNull(cacheKey)
    const text = readFileSync(desktopPath, 'utf8')
    const execLine = text.split('\n').find((l) => l.startsWith('Exec='))?.slice(5) || ''
    const nameLine = text.split('\n').find((l) => l.startsWith('Name='))?.slice(5) || ''
    appPath = execLine.split(/\s+/)[0] || ''
    appName = nameLine || (appPath.split('/').pop() ?? '')
  }

  if (!appPath || !appName) {
    console.log('[DefaultApp] appPath 或 appName 为空，返回 null. appPath=%s appName=%s', appPath, appName)
    return cacheNull(cacheKey)
  }

  const iconDataUrl = await getAppIconDataUrl(appPath).catch((e) => { console.warn('[DefaultApp] getAppIconDataUrl 失败:', e); return '' })
  console.log('[DefaultApp] iconDataUrl 长度:', iconDataUrl?.length)
  if (!iconDataUrl) return cacheNull(cacheKey)

  const info: import('@proma/shared').DefaultAppInfo = { name: appName, appPath, iconDataUrl }
  defaultAppCache.set(cacheKey, info)
  defaultAppFailureCache.delete(cacheKey)
  saveCachedDefaultAppInfo(cacheKey, info)
  return info
}

function isFailureCacheFresh(key: string): boolean {
  const failedAt = defaultAppFailureCache.get(key)
  if (failedAt === undefined) return false
  if (Date.now() - failedAt < DEFAULT_APP_FAILURE_RETRY_MS) return true
  defaultAppFailureCache.delete(key)
  return false
}

function cacheNull(key: string): null {
  defaultAppFailureCache.set(key, Date.now())
  return null
}

/**
 * 解析应用图标变体的文件路径
 */
export function resolveAppIconPath(variantId: string): string | null {
  const resourcesDir = getBundledResourcesDir()
  if (!variantId || variantId === 'default') {
    return join(resourcesDir, 'icon.png')
  }
  return join(resourcesDir, 'proma-logos', `proma-${variantId}.png`)
}

function releaseDirectoryWatcherIfUnreferenced(dirPath: string): void {
  const isStillReferenced = listAgentWorkspaces().some((workspace) =>
    workspace.projectRootPath === dirPath
    || getWorkspaceAttachedDirectories(workspace.slug).includes(dirPath)
    || getWorkspaceAttachedFiles(workspace.slug).some((filePath) => dirname(filePath) === dirPath),
  ) || listAgentSessions().some((session) =>
    session.attachedDirectories?.includes(dirPath)
    || session.attachedFiles?.some((filePath) => dirname(filePath) === dirPath),
  )

  if (!isStillReferenced) unwatchAttachedDirectory(dirPath)
}

function releaseAttachedFileWatchers(filePaths: readonly string[] | undefined): void {
  for (const dirPath of new Set((filePaths ?? []).map((filePath) => dirname(filePath)))) {
    releaseDirectoryWatcherIfUnreferenced(dirPath)
  }
}

async function withOAuthDeviceCodeQr<T extends CodexOAuthDeviceCode | XaiOAuthDeviceCode>(deviceCode: T): Promise<T> {
  try {
    const QRCode = (await import('qrcode')).default
    return { ...deviceCode, qrCodeData: await QRCode.toDataURL(deviceCode.verificationUri, { width: 240, margin: 1 }) }
  } catch (error) {
    console.warn('[OAuth] 生成设备码二维码失败:', error)
    return deviceCode
  }
}

/** 内容节点删除命中活动 Agent 时使用的稳定内部错误。 */
class CanvasContentAgentBusyError extends Error {
  readonly code = 'AGENT_SESSION_BUSY' as const

  constructor() {
    super('Canvas Agent 仍在运行')
    this.name = 'CanvasContentAgentBusyError'
  }
}

/** Agent-Canvas 关联在主进程内只保留一个 Store 实例，避免缓存和 CAS 基线分叉。 */
const agentCanvasBindingStore = new AgentCanvasBindingStore()

export function registerIpcHandlers(): void {
  // ===== 本地终端（仅主 renderer 可操作，不能指定可执行文件） =====
  const assertMainTerminalRenderer = (senderId: number): void => {
    const mainWindow = getMainWindow()
    if (!mainWindow || mainWindow.webContents.id !== senderId) {
      throw new Error('仅主窗口可以操作本地终端。')
    }
  }
  ipcMain.handle(TERMINAL_IPC_CHANNELS.CREATE, async (event, input) => {
    assertMainTerminalRenderer(event.sender.id)
    requireVisibleSession(input.sessionId)
    return createTerminal(input)
  })
  ipcMain.handle(TERMINAL_IPC_CHANNELS.INPUT, async (event, input) => {
    assertMainTerminalRenderer(event.sender.id)
    return writeTerminal(input)
  })
  ipcMain.handle(TERMINAL_IPC_CHANNELS.RESIZE, async (event, input) => {
    assertMainTerminalRenderer(event.sender.id)
    return resizeTerminal(input)
  })
  ipcMain.handle(TERMINAL_IPC_CHANNELS.KILL, async (event, terminalId: string) => {
    assertMainTerminalRenderer(event.sender.id)
    return killTerminal(terminalId)
  })
  ipcMain.handle(TERMINAL_IPC_CHANNELS.SNAPSHOT, async (event, terminalId: string) => {
    assertMainTerminalRenderer(event.sender.id)
    return getTerminalSnapshot(terminalId)
  })
  ipcMain.on(TERMINAL_IPC_CHANNELS.ACK_OUTPUT, (event, input) => {
    assertMainTerminalRenderer(event.sender.id)
    acknowledgeTerminalOutput(input)
  })

  console.log('[IPC] 正在注册 IPC 处理器...')

  /** normal 模式共享的实例 lease，用于迁移前排除 dev/prod 其他进程。 */
  const dataRootInstanceLease = getDefaultDataRootInstanceLeaseRegistry()
  /** 写 IPC 统一按会话、slug 或 ID 解析工作区并检查迁移独占锁。 */
  const workspaceOperationGuard = createWorkspaceOperationGuard({
    getWorkspaceIdBySessionId: (sessionId) => {
      const sessionMeta = getAgentSessionMeta(sessionId)
      return sessionMeta ? sessionMeta.workspaceId ?? null : undefined
    },
    getWorkspaceIdBySlug: (slug) => getAgentWorkspaceBySlug(slug)?.id,
    getWorkspaceOperationBlockReason,
  })
  /** Canvas 顶层会话使用独立索引，禁止写入 Agent 会话索引。 */
  const canvasSessionStore = new CanvasSessionStore({ pathResolver: designPathResolver })
  /** 原生 Canvas 文档复用同一会话索引作为项目与 Canvas 双身份授权事实。 */
  const canvasDocumentStore = createCanvasDocumentStore({ sessions: canvasSessionStore })
  /** Canvas 与 legacy Design 共用仍存活主窗口授权边界。 */
  const listAuthorizedDesignWebContents = (): WebContents[] => {
    /** 销毁窗口不能继续调用 handler 或接收广播。 */
    const contents = getStoredMainWindow()?.webContents
    return contents && !contents.isDestroyed() ? [contents] : []
  }
  /** 图片任务直接更新 Canvas 节点后发布准确 revision，驱动折叠节点即时刷新。 */
  const publishCanvasImageGraphChange = (event: CanvasChangeEvent): void => {
    for (const contents of listAuthorizedDesignWebContents()) {
      try {
        contents.send(CANVAS_IPC_CHANNELS.CHANGED, event)
      } catch (error) {
        console.error('[IPC] Canvas 图片节点变化广播失败:', error)
      }
    }
  }
  /** 非 Agent 内容目录与图文档共享唯一 Store 实例和目录 capability。 */
  const canvasNodeContentStore = createCanvasNodeContentStore({ store: canvasDocumentStore })
  /** 新图片节点默认模型复用现有项目级可用选择，不读取或复制凭据。 */
  const canvasImagePreferences = getDesignImageModelServices().imagePreferences
  /** Canvas 图片配置复用图文档 capability 与稳定目录 helper。 */
  const canvasImageModuleStore = createCanvasImageModuleStore({ store: canvasDocumentStore })
  /** 图片任务输出采用与 Canvas 节点投影共用同一 Store。 */
  const canvasImageJobTarget = createCanvasImageJobTargetAdapter({
    canvasStore: canvasDocumentStore,
    imageStore: canvasImageModuleStore,
    onCanvasChanged: publishCanvasImageGraphChange,
  })
  /** 从受管节点目录读取已提交正文，meta.json 始终作为身份和 revision 事实。 */
  const readCommittedCanvasContent = async (
    target: { projectId: string; canvasId: string },
    contentId: string,
    fileName: 'content.md' | 'index.html',
  ): Promise<{ revision: number; content: string }> => {
    const loaded = canvasDocumentStore.loadWithDirectoryCapability(target)
    const capability = loaded.openSingleChildDirectory('nodes')
    capability.assertValid()
    /** meta 与正文在同一 capability 生命周期内读取，目录换绑会 fail closed。 */
    const readFile = async (managedFileName: 'meta.json' | 'content.md' | 'index.html'): Promise<string> => {
      const result = await runStableDirectoryNative({
        mode: 'canvas-content-read',
        roots: [capability.rootPath],
        childName: 'nodes',
        entryId: contentId,
        fileName: managedFileName,
      }, capability.authorizeOpenedRoots)
      capability.assertValid()
      if (result.readOutcome?.status !== 'ok') throw new Error('CANVAS_IMAGE_INPUT_CONTENT_INVALID')
      return result.readOutcome.content
    }
    const meta = parseCanvasNodeContentMeta(JSON.parse(await readFile('meta.json')) as unknown)
    const expectedKind = fileName === 'content.md' ? 'document' : 'webview'
    if (meta.contentId !== contentId || meta.kind !== expectedKind) {
      throw new Error('CANVAS_IMAGE_INPUT_CONTENT_INVALID')
    }
    return { revision: meta.revision, content: await readFile(fileName) }
  }
  /** 直接入边解析器只读取已提交 Agent JSONL、图片配置和受管正文。 */
  const canvasImageInputResolver = createCanvasImageInputResolver({
    canvasStore: canvasDocumentStore,
    imageStore: canvasImageModuleStore,
    getAgentOutput: async (sessionId) => {
      const session = getAgentSessionMeta(sessionId)
      if (!session) throw new Error('CANVAS_IMAGE_INPUT_AGENT_INVALID')
      return { revision: session.updatedAt, messages: getAgentSessionSDKMessages(sessionId) }
    },
    readDocument: async (target, documentId) => {
      const committed = await readCommittedCanvasContent(target, documentId, 'content.md')
      return { revision: committed.revision, markdown: committed.content }
    },
    readPrototype: async (target, prototypeId) => {
      const committed = await readCommittedCanvasContent(target, prototypeId, 'index.html')
      /** 原型摘要只提取有界可见文本，不执行 HTML 或脚本。 */
      const summary = committed.content
        .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
        .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 4_000)
      return { revision: committed.revision, summary: summary || '已提交原型无可见文本' }
    },
  })
  /** Canvas Agent 创建事务复用现有 Agent 索引与模型可用性事实。 */
  const canvasAgentNodeCreation = new CanvasAgentNodeCreationService({
    store: canvasDocumentStore,
    getSettings,
    assertModelAvailable: (channelId, modelId) => {
      /** 即使 modelId 为空也必须先验证渠道存在且启用。 */
      listEnabledAgentModelsForChannel(channelId, 'Canvas Agent ')
      assertEnabledModelForChannel({ channelId, modelId, purpose: 'Canvas Agent ' })
    },
    getSession: getAgentSessionMeta,
    createSession: createAgentSessionWithMetadata,
    deleteSession: deleteAgentSession,
  })
  /** 项目离线或迁移时返回稳定 Design/Canvas 只读原因。 */
  const getDesignProjectReadOnlyReason = (projectId: string): string | undefined => {
    /** 未登记项目仍交给路径解析器或 store 抛出明确的项目不存在错误。 */
    const workspace = getAgentWorkspace(projectId)
    if (!workspace) return undefined
    /** 外部项目不可访问时禁止创建同名替代目录。 */
    const rootStatus = getLocalProjectRootStatus(workspace.projectRootPath)
    if (rootStatus && rootStatus !== 'available') {
      return '项目路径不可访问，设计工作区已切换为只读'
    }
    /** 项目迁移期间保留最后状态，只暂停索引、媒体重绑和画布写入。 */
    if (getWorkspaceOperationBlockReason(projectId)) {
      return '项目路径不可访问，设计工作区已切换为只读'
    }
    return undefined
  }
  /** Design IPC 的模型目录和项目偏好在进程内只创建一次。 */
  const { imageModels, imagePreferences } = getDesignImageModelServices()
  /** 长期创作资料和项目文本索引只在 Design 任务按需调用时读取。 */
  const designContextCatalog = new DesignContextCatalog({ pathResolver: designPathResolver })
  const designProjectTextIndex = new DesignProjectTextIndex({ pathResolver: designPathResolver })
  /** Design 素材服务只接受可信项目路径、原子 store 和目录级媒体授权。 */
  let cleanupSuccessfulDesignTask: ((projectId: string, sourceJobId: string) => void) | undefined
  const designAssetService = new DesignAssetService({
    pathResolver: designPathResolver,
    store: designStore,
    runWorkspaceWrite: (projectId, effect) => workspaceOperationGuard.runWorkspaceWrite(projectId, effect),
    registerDirectoryPath: registerPromaDirectoryPath,
    registerRetainedDirectoryPaths: registerRetainedPromaDirectoryPaths,
    revokePathUrl: revokePromaPathUrl,
    isContextAssetReferenced: (projectId, assetId) => designContextCatalog.isAssetReferenced(projectId, assetId),
    onSuccessfulJobAssetDeleted: (projectId, sourceJobId) => {
      cleanupSuccessfulDesignTask?.(projectId, sourceJobId)
    },
  })
  /** Design trace 独立落在本机 cache，列表和普通 Agent 投影不直接读取。 */
  const designTraceStore = new DesignTraceStore({ pathResolver: designPathResolver })
  const designContextOrchestrator = new DesignContextOrchestrator({
    catalog: designContextCatalog,
    textIndex: designProjectTextIndex,
  })
  /** trace 提交后统一清理内部会话关联的全部交互资源。 */
  const designExecutionSessionLifecycle = new DesignExecutionSessionLifecycle({
    getSession: getAgentSessionMeta,
    clearPermission: (sessionId) => {
      permissionService.clearSessionWhitelist(sessionId)
      permissionService.clearSessionPending(sessionId)
    },
    clearAskUser: (sessionId) => { askUserService.clearSessionPending(sessionId) },
    clearExitPlan: (sessionId) => { exitPlanService.clearSessionPending(sessionId) },
    clearQueue: clearAgentQueuedMessages,
    closeBrowser: (sessionId) => browserController.close(sessionId),
    deleteSession: deleteAgentSession,
  })
  /** Design Job 复用可见 Pi 会话和同一素材/Store 边界，不创建第二套 runtime。 */
  const designJobManager = new DesignJobManager({
    pathResolver: designPathResolver,
    store: designStore,
    assetService: designAssetService,
    canvasImageTargetAdapter: canvasImageJobTarget,
    canvasImageInputResolver,
    imageModels,
    contextOrchestrator: designContextOrchestrator,
    getSettings,
    getSession: getAgentSessionMeta,
    getSessionMessages: getAgentSessionSDKMessages,
    createSession: (input) => createAgentSessionWithMetadata({
      title: input.title,
      channelId: input.channelId,
      workspaceId: input.projectId,
      modelId: input.modelId,
      sourceDesignProjectId: input.projectId,
      sourceDesignJobId: input.sourceDesignJobId,
    }),
    runHeadless: runAgentHeadless,
    stopAgent,
    traceStore: designTraceStore,
    sessionLifecycle: designExecutionSessionLifecycle,
    resolveOwnedOutputPath: resolveOwnedDesignJobOutputPath,
    listProjectIds: () => listAgentWorkspaces().map((workspace) => workspace.id),
    runWorkspaceWrite: (projectId, effect) => workspaceOperationGuard.runWorkspaceWrite(projectId, effect),
  })
  /** 内容节点可恢复生命周期只在唯一 Job Manager 就绪后创建，删除图片可先取消活动任务。 */
  const canvasContentNodeLifecycle = createCanvasContentNodeLifecycle({
    store: canvasDocumentStore,
    contentStore: canvasNodeContentStore,
    assertAgentNodeIdle: (nodeId, sessionId) => {
      /** 节点或会话任一命中活动事实都必须拒绝删除。 */
      const activeRuns = listActiveCanvasAgentRuns()
      const busy = activeRuns.owners.some((owner) => (
        owner.nodeId === nodeId || owner.sessionId === sessionId
      )) || activeRuns.internalInvalidRuns.some((run) => run.sessionId === sessionId)
      if (busy) throw new CanvasContentAgentBusyError()
    },
    cancelActiveImageJobs: async (target) => {
      /** 同一图片目标正常最多一个活动任务；逐项取消可兼容异常恢复出的重复 journal。 */
      const activeJobs = designJobManager.listCanvasImageJobs(target).filter((job) => (
        job.status === 'queued' || job.status === 'running'
      ))
      for (const job of activeJobs) {
        await designJobManager.cancel(target.projectId, job.id)
      }
      /** 取消返回后重新读取权威索引，任何残留活动任务都必须阻断删除。 */
      const remainsActive = designJobManager.listCanvasImageJobs(target).some((job) => (
        job.status === 'queued' || job.status === 'running'
      ))
      if (remainsActive) throw new Error('Canvas 图片任务仍在运行，节点未删除')
    },
    resolveDefaultImageModelProfileId: (projectId) => (
      canvasImagePreferences.getSelection(projectId).selectedProfileId ?? null
    ),
  })
  /** 批处理、LOAD、SAVE 与单节点操作共享唯一 Canvas 串行器。 */
  const canvasOperationSerializer = createCanvasOperationSerializer()
  /** 批量事务服务在主进程只实例化一次，后续工具 Provider 必须复用该实例。 */
  const canvasAgentBatchOperation = createCanvasAgentBatchOperationService({
    store: canvasDocumentStore,
    runExclusive: (target, effect) => canvasOperationSerializer.run(target, () => (
      workspaceOperationGuard.runWorkspaceWrite(target.projectId, effect)
    )),
    publish: (target, document, source) => {
      /** 每个窗口独立 best-effort，单个发送失败不得阻断后续窗口或 revision。 */
      for (const contents of listAuthorizedDesignWebContents()) {
        try {
          contents.send(CANVAS_IPC_CHANNELS.CHANGED, {
            projectId: target.projectId,
            canvasId: target.canvasId,
            revision: document.revision,
            cause: 'graph',
            source: {
              sessionId: source.sessionId,
              runStartedAt: source.runStartedAt,
              toolCallId: source.toolCallId,
            },
          })
        } catch (error) {
          console.error('[CanvasBatch] 画布批量事实广播失败:', error)
        }
      }
    },
    contentLifecycle: canvasContentNodeLifecycle,
    agentNodeCreation: canvasAgentNodeCreation,
  })
  cleanupSuccessfulDesignTask = (projectId, sourceJobId) => {
    designJobManager.cleanupTaskAfterSuccessfulAssetDeletion(projectId, sourceJobId)
  }
  /** Design 与 Agent 会话共用主进程持久化事实，不向 Renderer 暴露路径推断能力。 */
  const designSessionBridge = new DesignSessionBridge({
    getSession: getAgentSessionMeta,
    getMessages: getAgentSessionMessages,
    resolveAgentImagePath: (localPath) => isAbsolute(localPath) ? localPath : resolveAttachmentPath(localPath),
    getAllowedRoots: (session) => {
      /** 只允许当前会话附件和该会话实际 Agent cwd 的生成目录。 */
      const workspace = session.workspaceId ? getAgentWorkspace(session.workspaceId) : undefined
      const agentCwd = resolveAgentCwd(workspace, session.id, session.agentCwdMode, session.activeWorktree)
      return [
        getConversationAttachmentsDir(session.id),
        ...(agentCwd ? [join(agentCwd, 'generated-images')] : []),
      ]
    },
    store: designStore,
    assets: designAssetService,
  })
  setDefaultDesignJobManager(designJobManager)
  /** Canvas 会话 IPC 与 Agent 工具共享同一公开事件通道。 */
  const broadcastCanvasSessionChange = (event: CanvasSessionChangeEvent): void => {
    for (const contents of listAuthorizedDesignWebContents()) {
      try {
        contents.send(DESIGN_IPC_CHANNELS.CANVAS_SESSION_CHANGED, event)
      } catch {
        console.error('[IPC] Canvas 会话变化广播失败')
      }
    }
  }
  /** Agent 关联 IPC、删除清理与 Agent 工具共享同一公开事件通道。 */
  const broadcastAgentCanvasBindingChange = (event: AgentCanvasBindingChangeEvent): void => {
    for (const contents of listAuthorizedDesignWebContents()) {
      try {
        contents.send(CANVAS_IPC_CHANNELS.AGENT_BINDINGS_CHANGED, event)
      } catch {
        console.error('[IPC] Agent-Canvas 关联变化广播失败')
      }
    }
  }
  /** 普通 Agent 引用和五个 Canvas 工具只消费生产唯一 Store 与守卫。 */
  const canvasToolAccess = createCanvasToolAccessFacade({
    getAgentSession: getAgentSessionMeta,
    assertProjectAuthorized: (projectId) => {
      if (!getAgentWorkspace(projectId)) throw new Error('CANVAS_PROJECT_ACCESS_DENIED')
    },
    getProjectReadOnlyReason: getDesignProjectReadOnlyReason,
    runProjectMutation: (projectId, effect) => workspaceOperationGuard.runWorkspaceWrite(projectId, effect),
    sessions: canvasSessionStore,
    bindings: agentCanvasBindingStore,
    loadCanvas: (target) => canvasDocumentStore.load(target),
    broadcastSession: broadcastCanvasSessionChange,
    broadcastBinding: broadcastAgentCanvasBindingChange,
  })
  /** 删除生命周期与 LIST 对账共用同一 Store 和固定广播边界。 */
  const agentCanvasBindingCleanup = {
    store: agentCanvasBindingStore,
    runProjectMutation: <T>(projectId: string, effect: () => T): T => (
      workspaceOperationGuard.runWorkspaceWrite(projectId, effect)
    ),
    broadcast: broadcastAgentCanvasBindingChange,
  }
  registerAgentCanvasBindingIpcHandlers({
    ipcMain,
    store: agentCanvasBindingStore,
    getAgentSession: getAgentSessionMeta,
    /** 关联读路径只枚举当前索引，legacy 投影由受守卫 mutation 显式负责。 */
    listCanvasSessions: (projectId) => canvasSessionStore.list({ projectId }),
    ensureLegacyCanvasSession: (projectId) => canvasSessionStore.ensureLegacySession(projectId),
    getProjectReadOnlyReason: getDesignProjectReadOnlyReason,
    runProjectMutation: (projectId, effect) => workspaceOperationGuard.runWorkspaceWrite(projectId, effect),
    assertSenderProjectAccess: (sender, projectId) => {
      /** 仅仍存活的当前主窗口可访问已登记项目。 */
      const authorized = listAuthorizedDesignWebContents().some((contents) => (
        contents.id === sender.id && !contents.isDestroyed()
      ))
      if (!authorized || sender.isDestroyed() || !getAgentWorkspace(projectId)) {
        throw new Error('无权访问 Agent-Canvas 关联')
      }
    },
    broadcast: agentCanvasBindingCleanup.broadcast,
  })
  registerCanvasSessionIpcHandlers({
    ipc: ipcMain,
    listAuthorizedWebContents: listAuthorizedDesignWebContents,
    guard: workspaceOperationGuard,
    initializeLegacyDesign: (projectId) => {
      designStore.initialize(projectId)
    },
    sessions: canvasSessionStore,
    getProjectReadOnlyReason: getDesignProjectReadOnlyReason,
    broadcast: broadcastCanvasSessionChange,
    assertCanvasIdle: (projectId, canvasId) => {
      /** Agent 与图片任务任一仍运行时都保留画布，避免删除执行中的事实源。 */
      const hasBusyAgent = listAgentSessions().some((session) => (
        session.sourceCanvasProjectId === projectId
        && session.sourceCanvasId === canvasId
        && isAgentSessionBusy(session.id)
      ))
      const hasBusyImageJob = designJobManager.list(projectId).some((job) => (
        job.target?.kind === 'canvas-image'
        && job.target.canvasId === canvasId
        && (job.status === 'queued' || job.status === 'running')
      ))
      if (hasBusyAgent || hasBusyImageJob) {
        throw new Error('Canvas 仍有任务运行，请先停止后再删除')
      }
    },
    cleanupBindings: (projectId, canvasId) => {
      /** Canvas 删除后先撤销所有普通 Agent 授权，再回收内部节点会话。 */
      cleanupDeletedCanvasBindings(agentCanvasBindingCleanup, projectId, canvasId)
    },
    cleanupInternalSessions: async (projectId, canvasId) => {
      /** 内部 Agent 会话严格按完整 Canvas 归属筛选，不能波及其它画布或普通会话。 */
      const sessions = listAgentSessions().filter((session) => (
        session.sourceCanvasProjectId === projectId && session.sourceCanvasId === canvasId
      ))
      for (const session of sessions) {
        try {
          permissionService.clearSessionWhitelist(session.id)
          permissionService.clearSessionPending(session.id)
          askUserService.clearSessionPending(session.id)
          exitPlanService.clearSessionPending(session.id)
          clearAgentQueuedMessages(session.id)
          await browserController.close(session.id)
          deleteAgentSession(session.id)
        } catch (error) {
          /** Canvas 索引已经删除，单会话清理失败只能隔离记录并继续其它会话。 */
          console.error(`[Canvas 会话] 内部 Agent 清理失败 (${session.id}):`, error)
        }
      }
    },
  })
  registerCanvasDocumentIpcHandlers({
    ipc: ipcMain,
    listAuthorizedWebContents: listAuthorizedDesignWebContents,
    guard: workspaceOperationGuard,
    store: canvasDocumentStore,
    batch: canvasAgentBatchOperation,
    operationSerializer: canvasOperationSerializer,
    creation: canvasAgentNodeCreation,
    contentLifecycle: canvasContentNodeLifecycle,
    imageModules: canvasImageModuleStore,
    imageJobs: designJobManager,
    imageJobTarget: canvasImageJobTarget,
    imageAssets: {
      list: (projectId) => designStore.requireStableAuthoritativeDocument(projectId).assets,
      createMediaAccess: (projectId) => designAssetService.createMediaAccess(projectId),
    },
    agent: {
      listActiveRuns: listActiveCanvasAgentRuns,
      getSession: getAgentSessionMeta,
      getMessages: getAgentSessionSDKMessages,
      reserveStart: reserveAgentSessionStart,
      run: runAgent,
      stop: stopAgent,
    },
    getProjectReadOnlyReason: getDesignProjectReadOnlyReason,
    toolAccess: canvasToolAccess,
  })
  registerDesignIpcHandlers({
    ipc: ipcMain,
    listAuthorizedWebContents: listAuthorizedDesignWebContents,
    guard: workspaceOperationGuard,
    store: designStore,
    assets: designAssetService,
    jobs: designJobManager,
    context: designContextCatalog,
    imageModels,
    imagePreferences,
    sessionBridge: designSessionBridge,
    getProjectReadOnlyReason: getDesignProjectReadOnlyReason,
    pickImageFiles: async (sender) => {
      /** 图片路径只由主进程系统选择器产生，renderer 无法注入任意路径。 */
      const owner = BrowserWindow.fromWebContents(sender)
      const options: OpenDialogOptions = {
        title: '导入设计素材',
        properties: ['openFile', 'multiSelections'],
        filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp'] }],
      }
      const result = owner
        ? await dialog.showOpenDialog(owner, options)
        : await dialog.showOpenDialog(options)
      return result.canceled ? [] : result.filePaths
    },
    pickMarkdownFile: async (sender) => {
      /** Markdown 导入路径只存在于本次主进程调用，不进入 Renderer 或 manifest。 */
      const owner = BrowserWindow.fromWebContents(sender)
      const options: OpenDialogOptions = {
        title: '导入创作资料',
        properties: ['openFile'],
        filters: [{ name: 'Markdown', extensions: ['md'] }],
      }
      const result = owner
        ? await dialog.showOpenDialog(owner, options)
        : await dialog.showOpenDialog(options)
      return result.canceled ? null : result.filePaths[0] ?? null
    },
    pickRelinkImageFile: async (sender) => {
      /** 重新定位严格选择单文件，旧素材关系由素材服务保留。 */
      const owner = BrowserWindow.fromWebContents(sender)
      const options: OpenDialogOptions = {
        title: '重新定位设计素材',
        properties: ['openFile'],
        filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp'] }],
      }
      const result = owner
        ? await dialog.showOpenDialog(owner, options)
        : await dialog.showOpenDialog(options)
      return result.canceled ? null : result.filePaths[0] ?? null
    },
    pickExportPath: async (sender, filename) => {
      /** 导出目标同样由主进程选择器决定。 */
      const owner = BrowserWindow.fromWebContents(sender)
      const options: SaveDialogOptions = { title: '导出设计素材', defaultPath: filename }
      const result = owner
        ? await dialog.showSaveDialog(owner, options)
        : await dialog.showSaveDialog(options)
      return result.canceled ? null : result.filePath ?? null
    },
  })
  registerPathManagementIpcHandlers({
    mode: 'normal',
    ipc: ipcMain,
    app,
    dialog,
    shell,
    getExpectedWebContents: () => getStoredMainWindow()?.webContents ?? null,
    hasActiveTasks: () => hasActiveAgentDataWrites() || hasRunningAutomations(),
    hasOtherPromaInstance: () => dataRootInstanceLease.hasOtherActiveLease(),
    acquireMigrationGuard: () => dataRootInstanceLease.acquireMigrationGuard(),
    workspaceRelocator: getDefaultWorkspaceProjectRelocator(),
    listWorkspacePathStates,
    relinkWorkspace: relinkWorkspaceProjectRoot,
    switchWorkspaceWatcher: replaceAttachedDirectoryWatcher,
    refreshWorkspaceRenderer: () => {
      getStoredMainWindow()?.webContents.send(AGENT_IPC_CHANNELS.WORKSPACE_FILES_CHANGED, [])
    },
  })

  // ===== 运行时相关 =====

  // 获取运行时状态
  ipcMain.handle(
    IPC_CHANNELS.GET_RUNTIME_STATUS,
    async (): Promise<RuntimeStatus | null> => {
      return getRuntimeStatus()
    }
  )

  // 重新初始化运行时（用户安装完 Git/Node 后触发，Windows 场景常用）
  ipcMain.handle(
    IPC_CHANNELS.REINIT_RUNTIME,
    async (): Promise<RuntimeStatus> => {
      return reinitializeRuntime()
    }
  )

  // 获取指定目录的 Git 仓库状态
  ipcMain.handle(
    IPC_CHANNELS.GET_GIT_REPO_STATUS,
    async (_, dirPath: string, access?: FileAccessOptions): Promise<GitRepoStatus | null> => {
      if (!dirPath || typeof dirPath !== 'string') {
        console.warn('[IPC] git:get-repo-status 收到无效的目录路径')
        return null
      }
      const accessSnapshot = requireVisibleFileAccess(access, [dirPath])
      if (!isPathAllowed(dirPath, accessSnapshot.options, accessSnapshot)) return null
      return getGitRepoStatus(dirPath)
    }
  )

  // 获取未暂存的变更文件列表
  ipcMain.handle(
    IPC_CHANNELS.GET_UNSTAGED_CHANGES,
    async (_, dirPath: string, sessionPath?: string, workspaceFilesPath?: string, extraPaths?: string[], sessionId?: string) => {
      if (!dirPath || typeof dirPath !== 'string') {
        console.warn('[IPC] git:get-unstaged-changes 收到无效的目录路径')
        return { isGitRepo: false, files: [], untrackedFiles: [], gitRootNames: [] }
      }
      const rawAccess = sessionId !== undefined ? { sessionId } : undefined
      /** 在 guard 前仅使用表达式组装参数，不引入未审计的函数调用。 */
      const targetPaths = [
        dirPath,
        ...(sessionPath ? [sessionPath] : []),
        ...(workspaceFilesPath ? [workspaceFilesPath] : []),
        ...(extraPaths ?? []),
      ]
      const accessSnapshot = requireVisibleFileAccess(rawAccess, targetPaths)
      const access = accessSnapshot.options
      if (!ensurePathAllowed(dirPath, access, accessSnapshot)) {
        return { isGitRepo: false, files: [], untrackedFiles: [], gitRootNames: [] }
      }
      const allowedSessionPath = sessionPath && isPathAllowed(sessionPath, access, accessSnapshot) ? sessionPath : undefined
      const allowedWorkspaceFilesPath = workspaceFilesPath && isPathAllowed(workspaceFilesPath, access, accessSnapshot) ? workspaceFilesPath : undefined
      const allowedExtraPaths = extraPaths?.filter((p) => isPathAllowed(p, access, accessSnapshot))
      return getUnstagedChanges(dirPath, allowedSessionPath, allowedWorkspaceFilesPath, allowedExtraPaths)
    }
  )

  // Agent 写入、Git 变更及窗口重新聚焦前主动失效，避免长寿命缓存显示旧 Diff。
  ipcMain.handle(
    IPC_CHANNELS.INVALIDATE_GIT_DIFF_CACHE,
    async (_, changedPath?: string) => {
      if (changedPath && typeof changedPath === 'string') {
        // 仅影响进程内缓存，不读写目标路径；允许刚删除的文件路径参与失效。
        invalidateGitDiffCache(changedPath)
        return
      }
      invalidateGitDiffCache()
    },
  )

  // 获取单个文件的 diff
  ipcMain.handle(
    IPC_CHANNELS.GET_FILE_DIFF,
    async (_, input: GetFileDiffInput) => {
      const { dirPath, filePath, gitRoot, sessionId } = input
      if (!dirPath || !filePath || typeof dirPath !== 'string' || typeof filePath !== 'string') {
        console.warn('[IPC] git:get-file-diff 收到无效参数')
        return ''
      }
      const accessSnapshot = requireVisibleFileAccess({ sessionId }, [dirPath, ...(gitRoot ? [gitRoot] : [])])
      const access = accessSnapshot.options
      if (!(await ensurePathAllowedWithWorktree(dirPath, access, accessSnapshot)) || (gitRoot && !(await ensurePathAllowedWithWorktree(gitRoot, access, accessSnapshot)))) return ''
      return getFileDiff(dirPath, filePath, gitRoot)
    }
  )

  // 获取未追踪文件内容
  ipcMain.handle(
    IPC_CHANNELS.GET_UNTRACKED_CONTENT,
    async (_, input: GetFileDiffInput) => {
      const { dirPath, filePath, gitRoot, sessionId } = input
      if (!dirPath || !filePath || typeof dirPath !== 'string' || typeof filePath !== 'string') {
        console.warn('[IPC] git:get-untracked-content 收到无效参数')
        return ''
      }
      const accessSnapshot = requireVisibleFileAccess({ sessionId }, [dirPath, ...(gitRoot ? [gitRoot] : [])])
      const access = accessSnapshot.options
      if (!(await ensurePathAllowedWithWorktree(dirPath, access, accessSnapshot)) || (gitRoot && !(await ensurePathAllowedWithWorktree(gitRoot, access, accessSnapshot)))) return ''
      return getUntrackedContent(dirPath, filePath, gitRoot, {
        readFile: (workingTreePath, maxSize) => {
          const readSnapshot = requireVisibleFileReadAccess(access, workingTreePath, undefined, maxSize, accessSnapshot)
          const authorizedFile = readSnapshot.authorizedFiles.get(workingTreePath)
          if (!authorizedFile) throw new Error('工作树文件授权失败')
          try {
            return authorizedFile.readBytes()
          } finally {
            authorizedFile.close()
          }
        },
      })
    }
  )

  // 还原文件变更
  ipcMain.handle(
    IPC_CHANNELS.REVERT_FILE,
    async (_, input: RevertFileInput) => {
      const { dirPath, filePath } = input
      if (!dirPath || !filePath || typeof dirPath !== 'string' || typeof filePath !== 'string') {
        console.warn('[IPC] git:revert-file 收到无效参数')
        return
      }
      throw new Error(RENDERER_GIT_REVERT_DISABLED_MESSAGE)
    }
  )

  // 获取文件新旧版本内容
  ipcMain.handle(
    IPC_CHANNELS.GET_DIFF_CONTENTS,
    async (_, input: GetFileDiffInput) => {
      const { dirPath, filePath, gitRoot, sessionId } = input
      if (!dirPath || !filePath || typeof dirPath !== 'string' || typeof filePath !== 'string') {
        console.warn('[IPC] git:get-diff-contents 收到无效参数')
        return null
      }
      const accessSnapshot = requireVisibleFileAccess({ sessionId }, [dirPath, ...(gitRoot ? [gitRoot] : [])])
      const access = accessSnapshot.options
      if (!(await ensurePathAllowedWithWorktree(dirPath, access, accessSnapshot)) || (gitRoot && !(await ensurePathAllowedWithWorktree(gitRoot, access, accessSnapshot)))) return null
      return getDiffContents(dirPath, filePath, gitRoot, input.baseRef, {
        readFile: (workingTreePath, maxSize) => {
          const readSnapshot = requireVisibleFileReadAccess(access, workingTreePath, undefined, maxSize, accessSnapshot)
          const authorizedFile = readSnapshot.authorizedFiles.get(workingTreePath)
          if (!authorizedFile) throw new Error('工作树文件授权失败')
          try {
            return authorizedFile.readBytes()
          } finally {
            authorizedFile.close()
          }
        },
      })
    }
  )

  // 列出 Git Worktree（只读取 worktree 元信息，不涉及文件内容，跳过路径安全检查）
  ipcMain.handle(
    IPC_CHANNELS.LIST_WORKTREES,
    async (_, repoPath: string, sessionId: string) => {
      if (!repoPath || typeof repoPath !== 'string') return []
      const accessSnapshot = requireVisibleFileAccess({ sessionId }, [repoPath])
      if (!(await ensurePathAllowedWithWorktree(repoPath, accessSnapshot.options, accessSnapshot))) return []
      return await listWorktrees(repoPath)
    }
  )

  // 获取 Worktree 相对于基准分支的全量变更
  ipcMain.handle(
    IPC_CHANNELS.GET_WORKTREE_CHANGES,
    async (_, worktreePath: string, baseBranch: string, sessionId: string) => {
      if (!worktreePath || typeof worktreePath !== 'string') {
        return { isGitRepo: false, files: [], untrackedFiles: [], gitRootNames: [] }
      }
      const accessSnapshot = requireVisibleFileAccess({ sessionId }, [worktreePath])
      const access = accessSnapshot.options
      if (!(await ensurePathAllowedWithWorktree(worktreePath, access, accessSnapshot))) {
        return { isGitRepo: false, files: [], untrackedFiles: [], gitRootNames: [] }
      }
      return getWorktreeChanges(worktreePath, baseBranch)
    }
  )

  // 打开独立预览窗口
  ipcMain.handle(
    IPC_CHANNELS.OPEN_DETACHED_PREVIEW,
    async (event, input: DetachedPreviewWindowInput): Promise<string | null> => {
      if (!input || typeof input.sessionId !== 'string' || typeof input.filePath !== 'string' || typeof input.dirPath !== 'string') {
        console.warn('[IPC] preview:open-detached 收到无效参数')
        return null
      }
      requireVisibleFileAccess({ sessionId: input.sessionId }, [input.filePath, input.dirPath])
      const { openDetachedPreviewWindow } = await import('./lib/detached-preview-window')
      const sourceWindow = BrowserWindow.fromWebContents(event.sender)
      return openDetachedPreviewWindow(input, sourceWindow)
    }
  )

  // 获取独立预览窗口数据
  ipcMain.handle(
    IPC_CHANNELS.GET_DETACHED_PREVIEW_DATA,
    async (_, previewId: string) => {
      if (!previewId || typeof previewId !== 'string') return null
      const { getDetachedPreviewWindowData } = await import('./lib/detached-preview-window')
      return getDetachedPreviewWindowData(previewId)
    }
  )

  // 截图导出
  ipcMain.handle(
    IPC_CHANNELS.SCREENSHOT_CAPTURE,
    async (_, input: { html: string; isDark: boolean; width?: number; mode: 'clipboard' | 'file'; css?: string; themeClass?: string }) => {
      const { captureScreenshot } = await import('./lib/screenshot-service')
      return captureScreenshot(input)
    }
  )

  // 在系统默认浏览器中打开外部链接
  ipcMain.handle(
    IPC_CHANNELS.OPEN_EXTERNAL,
    async (_, url: string): Promise<void> => {
      if (!url || typeof url !== 'string') {
        console.warn('[IPC] shell:open-external 收到无效的 URL')
        return
      }
      // 仅允许 http/https 协议，防止安全风险
      if (!url.startsWith('http://') && !url.startsWith('https://')) {
        console.warn('[IPC] shell:open-external 仅支持 http/https 协议:', url)
        return
      }
      await shell.openExternal(url)
    }
  )

  // 在系统剪贴板中写入纯文本
  ipcMain.handle(
    IPC_CHANNELS.WRITE_CLIPBOARD_TEXT,
    async (_, text: string): Promise<void> => {
      if (typeof text !== 'string') {
        throw new TypeError('剪贴板文本必须是字符串')
      }
      clipboard.writeText(text)
    }
  )

  // 用系统默认应用打开任意文件（appName 需在 KNOWN_EDITORS 白名单内）
  ipcMain.handle(
    IPC_CHANNELS.SYSTEM_OPEN_FILE,
    async (_, filePath: string, appName?: string, access?: FileAccessOptions | string[]): Promise<void> => {
      const accessSnapshot = requireVisibleFileAccess(access, [filePath])
      const options = accessSnapshot.options
      const absPath = await resolveFileAccessPath(filePath, options, accessSnapshot)
      if (!isPathAllowed(absPath, options, accessSnapshot)) {
        console.warn('[IPC] shell:system-open-file 拒绝越界路径:', absPath)
        return
      }
      if (process.platform === 'darwin') {
        const { spawnSync } = await import('node:child_process')
        if (appName) {
          if (!KNOWN_EDITORS.includes(appName)) {
            console.warn('[IPC] shell:system-open-file 拒绝未知应用:', appName)
            return
          }
          spawnSync('open', ['-a', appName, absPath], { timeout: 5000 })
        } else {
          spawnSync('open', [absPath], { timeout: 5000 })
        }
      } else {
        await shell.openPath(absPath)
      }
    }
  )

  // 扫描系统中的编辑器应用（仅 macOS）
  ipcMain.handle(
    IPC_CHANNELS.SCAN_EDITORS,
    async (): Promise<import('@proma/shared').EditorApp[]> => {
      if (process.platform !== 'darwin') return []
      const { existsSync } = await import('node:fs')
      const { homedir } = await import('node:os')
      const home = homedir()

      const editors = KNOWN_EDITORS.map((name) => {
        const searchPaths = name === 'Xcode' || name === 'TextEdit'
          ? [`/Applications/${name}.app`]
          : [`/Applications/${name}.app`, `${home}/Applications/${name}.app`]
        return { name, paths: searchPaths }
      })

      return editors
        .filter((e) => e.paths.some((p) => existsSync(p)))
        .map((e) => ({ name: e.name, path: e.paths.find((p) => existsSync(p))! }))
    }
  )

  // 查询某个文件在本机的默认打开应用信息（带图标）
  ipcMain.handle(
    IPC_CHANNELS.GET_DEFAULT_APP_FOR_FILE,
    async (_, filePath: string, access?: FileAccessOptions | string[]): Promise<import('@proma/shared').DefaultAppInfo | null> => {
      if (!filePath || typeof filePath !== 'string') return null
      const accessSnapshot = requireVisibleFileAccess(access, [filePath])
      const options = accessSnapshot.options
      try {
        const resolvedPath = await resolveFileAccessPath(filePath, options, accessSnapshot)
        if (!isPathAllowed(resolvedPath, options, accessSnapshot)) {
          console.warn('[IPC] shell:get-default-app-for-file 拒绝越界路径:', resolvedPath)
          return null
        }
        console.log('[IPC] get-default-app-for-file 收到请求:', resolvedPath)
        const result = await getDefaultAppInfoForFile(resolvedPath)
        console.log('[IPC] get-default-app-for-file 返回:', result ? `name=${result.name} appPath=${result.appPath} iconLen=${result.iconDataUrl?.length}` : 'null')
        return result
      } catch (err) {
        console.warn('[IPC] shell:get-default-app-for-file 失败:', err)
        return null
      }
    }
  )

  // ===== 渠道管理相关 =====

  // 获取所有渠道（apiKey 保持加密态）
  ipcMain.handle(
    CHANNEL_IPC_CHANNELS.LIST,
    async (): Promise<Channel[]> => {
      return listChannels()
    }
  )

  // 创建渠道
  ipcMain.handle(
    CHANNEL_IPC_CHANNELS.CREATE,
    async (_, input: ChannelCreateInput): Promise<Channel> => {
      return runChannelMutationWithImageModelBroadcast({
        mutate: () => createChannel(input),
        listTargets: () => BrowserWindow.getAllWindows().map((window) => window.webContents),
      })
    }
  )

  // 更新渠道
  ipcMain.handle(
    CHANNEL_IPC_CHANNELS.UPDATE,
    async (_, id: string, input: ChannelUpdateInput): Promise<Channel> => {
      return runChannelMutationWithImageModelBroadcast({
        mutate: () => updateChannel(id, input),
        listTargets: () => BrowserWindow.getAllWindows().map((window) => window.webContents),
      })
    }
  )

  // 删除渠道
  ipcMain.handle(
    CHANNEL_IPC_CHANNELS.DELETE,
    async (_, id: string): Promise<void> => {
      return runChannelMutationWithImageModelBroadcast({
        mutate: () => deleteChannel(id),
        listTargets: () => BrowserWindow.getAllWindows().map((window) => window.webContents),
      })
    }
  )

  // 解密 API Key（仅在用户查看时调用）
  ipcMain.handle(
    CHANNEL_IPC_CHANNELS.DECRYPT_KEY,
    async (_, channelId: string): Promise<string> => {
      return decryptApiKey(channelId)
    }
  )

  // 测试渠道连接
  ipcMain.handle(
    CHANNEL_IPC_CHANNELS.TEST,
    async (_, channelId: string): Promise<ChannelTestResult> => {
      return testChannel(channelId)
    }
  )

  // 直接测试连接（无需已保存渠道，传入明文凭证）
  ipcMain.handle(
    CHANNEL_IPC_CHANNELS.TEST_DIRECT,
    async (_, input: ChannelDirectTestInput): Promise<ChannelTestResult> => {
      return testChannelDirect(input)
    }
  )

  // 从供应商拉取可用模型列表（直接传入凭证，无需已保存渠道）
  ipcMain.handle(
    CHANNEL_IPC_CHANNELS.FETCH_MODELS,
    async (_, input: FetchModelsInput): Promise<FetchModelsResult> => {
      return fetchModels(input)
    }
  )

  // 查询订阅 Plan 额度（用于 Agent Context 圆环 hover 信息）
  ipcMain.handle(
    CHANNEL_IPC_CHANNELS.GET_PLAN_QUOTA,
    async (_, channelId: string): Promise<import('@proma/shared').ChannelPlanQuotaResult> => {
      return getChannelPlanQuota(channelId)
    }
  )

  // 发起 ChatGPT (Codex) OAuth 登录。登录在主进程执行（Pi SDK 用 Node crypto +
  // 本地 :1455 回调服务）；成功后返回序列化的凭据 JSON（明文），由渲染层作为
  // apiKey 传给 create/update，channel-manager 加密后存储——与现有 apiKey 明文回传模式一致。
  ipcMain.handle(
    CHANNEL_IPC_CHANNELS.CODEX_OAUTH_LOGIN,
    async (event, requestedMethod?: CodexOAuthLoginMethod): Promise<import('@proma/shared').CodexOAuthLoginResult> => {
      const method: CodexOAuthLoginMethod = requestedMethod === 'device_code' ? 'device_code' : 'browser'
      try {
        const credentials = await loginCodexOAuth({
          method,
          onDeviceCode: (deviceCode) => {
            void withOAuthDeviceCodeQr(deviceCode).then((payload) => {
              if (!event.sender.isDestroyed()) {
                event.sender.send(CHANNEL_IPC_CHANNELS.CODEX_OAUTH_DEVICE_CODE, payload)
              }
            }).catch((error) => console.warn('[OAuth] 发送 Codex device code 失败:', error))
          },
        })
        return {
          success: true,
          credentials: serializeCodexCredentials(credentials),
          ...(credentials.accountId ? { accountId: credentials.accountId } : {}),
        }
      } catch (error) {
        return {
          success: false,
          message: error instanceof Error ? error.message : String(error),
        }
      }
    }
  )

  // 取消进行中的 ChatGPT OAuth 登录流程
  ipcMain.handle(
    CHANNEL_IPC_CHANNELS.CODEX_OAUTH_CANCEL,
    async (): Promise<void> => {
      cancelCodexOAuthLogin()
    }
  )

  // 发起 xAI（Grok/X 订阅）OAuth device-code 登录。Pi 会通过 device-code 事件给出
  // 预填的浏览器授权链接；成功后的凭据沿用 Channel.apiKey 加密存储。
  ipcMain.handle(
    CHANNEL_IPC_CHANNELS.XAI_OAUTH_LOGIN,
    async (event): Promise<import('@proma/shared').XaiOAuthLoginResult> => {
      try {
        const credentials = await loginXaiOAuth({
          onDeviceCode: (deviceCode) => {
            void withOAuthDeviceCodeQr(deviceCode).then((payload) => {
              if (!event.sender.isDestroyed()) {
                event.sender.send(CHANNEL_IPC_CHANNELS.XAI_OAUTH_DEVICE_CODE, payload)
              }
            }).catch((error) => console.warn('[OAuth] 发送 xAI device code 失败:', error))
          },
        })
        return { success: true, credentials: serializeXaiCredentials(credentials) }
      } catch (error) {
        return { success: false, message: error instanceof Error ? error.message : String(error) }
      }
    }
  )

  ipcMain.handle(
    CHANNEL_IPC_CHANNELS.XAI_OAUTH_CANCEL,
    async (): Promise<void> => {
      cancelXaiOAuthLogin()
    }
  )

  // ===== 对话管理相关 =====

  // 获取对话列表
  ipcMain.handle(
    CHAT_IPC_CHANNELS.LIST_CONVERSATIONS,
    async (): Promise<ConversationMeta[]> => {
      return listConversations()
    }
  )

  // 创建对话
  ipcMain.handle(
    CHAT_IPC_CHANNELS.CREATE_CONVERSATION,
    async (_, title?: string, modelId?: string, channelId?: string): Promise<ConversationMeta> => {
      return createConversation(title, modelId, channelId)
    }
  )

  // 获取对话消息
  ipcMain.handle(
    CHAT_IPC_CHANNELS.GET_MESSAGES,
    async (_, id: string): Promise<ChatMessage[]> => {
      return getConversationMessages(id)
    }
  )

  // 获取对话最近 N 条消息（分页加载）
  ipcMain.handle(
    CHAT_IPC_CHANNELS.GET_RECENT_MESSAGES,
    async (_, id: string, limit: number): Promise<RecentMessagesResult> => {
      return getRecentMessages(id, limit)
    }
  )

  // 更新对话标题
  ipcMain.handle(
    CHAT_IPC_CHANNELS.UPDATE_TITLE,
    async (_, id: string, title: string): Promise<ConversationMeta> => {
      return updateConversationMeta(id, { title })
    }
  )

  // 更新对话使用的模型/渠道
  ipcMain.handle(
    CHAT_IPC_CHANNELS.UPDATE_MODEL,
    async (_, id: string, modelId: string, channelId: string): Promise<ConversationMeta> => {
      return updateConversationMeta(id, { modelId, channelId })
    }
  )

  // 删除对话
  ipcMain.handle(
    CHAT_IPC_CHANNELS.DELETE_CONVERSATION,
    async (_, id: string): Promise<void> => {
      return deleteConversation(id)
    }
  )

  // 切换对话置顶状态
  ipcMain.handle(
    CHAT_IPC_CHANNELS.TOGGLE_PIN,
    async (_, id: string): Promise<ConversationMeta> => {
      const conversations = listConversations()
      const current = conversations.find((c) => c.id === id)
      if (!current) throw new Error(`对话不存在: ${id}`)
      const newPinned = !current.pinned
      // 置顶时自动取消归档
      const updates: Partial<ConversationMeta> = { pinned: newPinned }
      if (newPinned && current.archived) {
        updates.archived = false
      }
      return updateConversationMeta(id, updates)
    }
  )

  // 切换对话归档状态
  ipcMain.handle(
    CHAT_IPC_CHANNELS.TOGGLE_ARCHIVE,
    async (_, id: string): Promise<ConversationMeta> => {
      const conversations = listConversations()
      const current = conversations.find((c) => c.id === id)
      if (!current) throw new Error(`对话不存在: ${id}`)
      const newArchived = !current.archived
      // 归档时自动取消置顶
      const updates: Partial<ConversationMeta> = { archived: newArchived }
      if (newArchived && current.pinned) {
        updates.pinned = false
      }
      return updateConversationMeta(id, updates)
    }
  )

  // 搜索对话消息内容
  ipcMain.handle(
    CHAT_IPC_CHANNELS.SEARCH_MESSAGES,
    async (_, query: string) => {
      return searchConversationMessages(query)
    }
  )

  // 获取教程内容
  ipcMain.handle(
    CHAT_IPC_CHANNELS.GET_TUTORIAL_CONTENT,
    async (): Promise<string | null> => {
      return getTutorialContent()
    }
  )

  // 创建欢迎对话（含教程附件）
  ipcMain.handle(
    CHAT_IPC_CHANNELS.CREATE_WELCOME_CONVERSATION,
    async (): Promise<ConversationMeta | null> => {
      return createWelcomeConversation()
    }
  )

  // 发送消息（触发 AI 流式响应）
  // 注意：通过 event.sender 获取 webContents 用于推送流式事件
  ipcMain.handle(
    CHAT_IPC_CHANNELS.SEND_MESSAGE,
    async (event, input: ChatSendInput): Promise<void> => {
      await sendMessage(input, event.sender)
    }
  )

  // 中止生成
  ipcMain.handle(
    CHAT_IPC_CHANNELS.STOP_GENERATION,
    async (_, conversationId: string): Promise<void> => {
      stopGeneration(conversationId)
    }
  )

  // 删除消息
  ipcMain.handle(
    CHAT_IPC_CHANNELS.DELETE_MESSAGE,
    async (_, conversationId: string, messageId: string): Promise<ChatMessage[]> => {
      return deleteMessage(conversationId, messageId)
    }
  )

  // 从指定消息开始截断（包含该消息）
  ipcMain.handle(
    CHAT_IPC_CHANNELS.TRUNCATE_MESSAGES_FROM,
    async (
      _,
      conversationId: string,
      messageId: string,
      preserveFirstMessageAttachments?: boolean,
    ): Promise<ChatMessage[]> => {
      return truncateMessagesFrom(
        conversationId,
        messageId,
        preserveFirstMessageAttachments ?? false,
      )
    }
  )

  // 更新上下文分隔线
  ipcMain.handle(
    CHAT_IPC_CHANNELS.UPDATE_CONTEXT_DIVIDERS,
    async (_, conversationId: string, dividers: string[]): Promise<ConversationMeta> => {
      return updateContextDividers(conversationId, dividers)
    }
  )

  // 生成对话标题
  ipcMain.handle(
    CHAT_IPC_CHANNELS.GENERATE_TITLE,
    async (_, input: GenerateTitleInput): Promise<string | null> => {
      return generateTitle(input)
    }
  )

  // ===== 附件管理相关 =====

  // 保存附件到本地
  ipcMain.handle(
    CHAT_IPC_CHANNELS.SAVE_ATTACHMENT,
    async (_, input: AttachmentSaveInput): Promise<AttachmentSaveResult> => {
      return saveAttachment(input)
    }
  )

  // 读取附件（返回 base64）
  ipcMain.handle(
    CHAT_IPC_CHANNELS.READ_ATTACHMENT,
    async (_, localPath: string): Promise<string> => {
      return readAttachmentAsBase64(localPath)
    }
  )

  // 另存图片到用户选择的位置（原生 Save As 对话框）
  ipcMain.handle(
    CHAT_IPC_CHANNELS.SAVE_IMAGE_AS,
    async (event, localPath: string, defaultFilename: string): Promise<boolean> => {
      const { dialog, BrowserWindow } = await import('electron')
      const { writeFileSync } = await import('node:fs')
      const { extname: pathExtname } = await import('node:path')

      const win = BrowserWindow.fromWebContents(event.sender)
      const ext = pathExtname(defaultFilename).replace('.', '').toLowerCase()
      const filterMap: Record<string, string> = { jpg: 'JPEG', jpeg: 'JPEG', png: 'PNG', gif: 'GIF', webp: 'WebP', bmp: 'BMP' }
      const filterName = filterMap[ext] ?? 'Image'

      const result = await dialog.showSaveDialog(win ?? BrowserWindow.getFocusedWindow()!, {
        defaultPath: defaultFilename,
        filters: [
          { name: `${filterName} 图片`, extensions: [ext || 'png'] },
          { name: '所有文件', extensions: ['*'] },
        ],
      })

      if (result.canceled || !result.filePath) return false

      const base64 = readAttachmentAsBase64(localPath)
      writeFileSync(result.filePath, Buffer.from(base64, 'base64'))
      return true
    }
  )

  // 保存应用内置资源文件到用户选择的位置（原生 Save As 对话框）
  ipcMain.handle(
    CHAT_IPC_CHANNELS.SAVE_RESOURCE_FILE_AS,
    async (event, resourceRelativePath: string, defaultFilename: string): Promise<boolean> => {
      const { dialog, BrowserWindow } = await import('electron')
      const { writeFileSync, readFileSync, existsSync } = await import('node:fs')
      const { join, normalize, sep, extname: pathExtname } = await import('node:path')

      // 解析到应用内置 resources 目录（dev 用 __dirname/resources，prod 用 process.resourcesPath）
      const resourcesDir = normalize(getBundledResourcesDir())
      const fullPath = normalize(join(resourcesDir, resourceRelativePath))

      // 安全校验：防止路径穿越（追加 sep 防止 resources-evil 绕过）
      if (!fullPath.startsWith(resourcesDir + sep)) {
        throw new Error('Path traversal not allowed')
      }
      if (!existsSync(fullPath)) {
        throw new Error(`Resource not found: ${resourceRelativePath}`)
      }

      const win = BrowserWindow.fromWebContents(event.sender)
      const ext = pathExtname(defaultFilename).replace('.', '').toLowerCase()
      const filterMap: Record<string, string> = { jpg: 'JPEG', jpeg: 'JPEG', png: 'PNG', gif: 'GIF', webp: 'WebP' }
      const filterName = filterMap[ext] ?? 'Image'

      const result = await dialog.showSaveDialog(win ?? BrowserWindow.getFocusedWindow()!, {
        defaultPath: defaultFilename,
        filters: [
          { name: `${filterName} 图片`, extensions: [ext || 'png'] },
          { name: '所有文件', extensions: ['*'] },
        ],
      })

      if (result.canceled || !result.filePath) return false

      writeFileSync(result.filePath, readFileSync(fullPath))
      return true
    }
  )

  // 删除附件
  ipcMain.handle(
    CHAT_IPC_CHANNELS.DELETE_ATTACHMENT,
    async (_, localPath: string): Promise<void> => {
      deleteAttachment(localPath)
    }
  )

  // 打开文件选择对话框
  ipcMain.handle(
    CHAT_IPC_CHANNELS.OPEN_FILE_DIALOG,
    async (): Promise<FileDialogResult> => {
      return openFileDialog()
    }
  )

  // 提取附件文档的文本内容
  ipcMain.handle(
    CHAT_IPC_CHANNELS.EXTRACT_ATTACHMENT_TEXT,
    async (_, localPath: string): Promise<string> => {
      return extractTextFromAttachment(localPath)
    }
  )

  // ===== 用户档案相关 =====

  // 获取用户档案
  ipcMain.handle(
    USER_PROFILE_IPC_CHANNELS.GET,
    async (): Promise<UserProfile> => {
      return getUserProfile()
    }
  )

  // 更新用户档案
  ipcMain.handle(
    USER_PROFILE_IPC_CHANNELS.UPDATE,
    async (_, updates: Partial<UserProfile>): Promise<UserProfile> => {
      return updateUserProfile(updates)
    }
  )

  // ===== 应用设置相关 =====

  // 获取应用设置
  ipcMain.handle(
    SETTINGS_IPC_CHANNELS.GET,
    async (): Promise<AppSettings> => {
      return getSettings()
    }
  )

  // 更新应用设置
  ipcMain.handle(
    SETTINGS_IPC_CHANNELS.UPDATE,
    async (event, updates: Partial<AppSettings>): Promise<AppSettings> => {
      const result = await updateSettings(updates)

      if (updates.feishuSessionMirror !== undefined) {
        syncFeishuSyncSleepBlocker(result)
      }
      if (updates.agentIsland !== undefined) {
        refreshAgentIslandConfiguration()
      }

      // 主题相关设置变化时，广播给所有窗口（跨窗口同步，如 Quick Task 面板）
      if (updates.themeMode !== undefined || updates.themeStyle !== undefined) {
        const payload = {
          themeMode: result.themeMode,
          themeStyle: result.themeStyle,
        }
        BrowserWindow.getAllWindows().forEach((win) => {
          // 跳过发起者窗口，避免重复应用
          if (win.webContents.id !== event.sender.id) {
            win.webContents.send(SETTINGS_IPC_CHANNELS.ON_THEME_SETTINGS_CHANGED, payload)
          }
        })
      }

      return result
    }
  )

  // 同步更新应用设置（用于 beforeunload 场景）
  ipcMain.on(
    SETTINGS_IPC_CHANNELS.UPDATE_SYNC,
    (event, updates: Partial<AppSettings>) => {
      try {
        const result = updateSettings(updates)
        if (updates.feishuSessionMirror !== undefined) {
          syncFeishuSyncSleepBlocker(result)
        }
        if (updates.agentIsland !== undefined) {
          refreshAgentIslandConfiguration()
        }
        event.returnValue = true
      } catch {
        event.returnValue = false
      }
    }
  )

  // 获取系统主题（是否深色模式）
  ipcMain.handle(
    SETTINGS_IPC_CHANNELS.GET_SYSTEM_THEME,
    async (): Promise<boolean> => {
      return nativeTheme.shouldUseDarkColors
    }
  )

  // 监听系统主题变化，推送给所有渲染进程窗口
  nativeTheme.on('updated', () => {
    const isDark = nativeTheme.shouldUseDarkColors
    console.log(`[设置] 系统主题变化: ${isDark ? '深色' : '浅色'}`)
    BrowserWindow.getAllWindows().forEach((win) => {
      win.webContents.send(SETTINGS_IPC_CHANNELS.ON_SYSTEM_THEME_CHANGED, isDark)
    })
  })

  // ===== Scratch Pad 持久化 =====

  // 从磁盘加载 scratch-pad.md
  ipcMain.handle(
    SCRATCH_PAD_IPC_CHANNELS.LOAD,
    async (): Promise<string> => {
      const path = getScratchPadPath()
      try {
        if (!existsSync(path)) return ''
        return readFileSync(path, 'utf-8')
      } catch (err) {
        console.error('[ScratchPad] 加载失败:', err)
        return ''
      }
    }
  )

  // 异步保存 scratch-pad.md
  ipcMain.handle(
    SCRATCH_PAD_IPC_CHANNELS.SAVE,
    async (_, content: string): Promise<boolean> => {
      const path = getScratchPadPath()
      try {
        await writeFile(path, content, 'utf-8')
        return true
      } catch (err) {
        console.error('[ScratchPad] 保存失败:', err)
        return false
      }
    }
  )

  // 同步保存 scratch-pad.md（beforeunload 场景）
  ipcMain.on(
    SCRATCH_PAD_IPC_CHANNELS.SAVE_SYNC,
    (event, content: string) => {
      try {
        writeFileSync(getScratchPadPath(), content, 'utf-8')
        event.returnValue = true
      } catch (err) {
        console.error('[ScratchPad] 同步保存失败:', err)
        event.returnValue = false
      }
    }
  )

  // 导出为 Markdown 到指定目录
  ipcMain.handle(
    SCRATCH_PAD_IPC_CHANNELS.EXPORT,
    async (_, markdown: string, dirPath: string, filename: string): Promise<string> => {
      let filePath: string
      if (!filename) {
        // 完整文件路径模式（来自保存对话框）
        filePath = dirPath
        const dir = dirname(filePath)
        if (!existsSync(dir)) {
          mkdirSync(dir, { recursive: true })
        }
      } else {
        if (!existsSync(dirPath)) {
          mkdirSync(dirPath, { recursive: true })
        }
        filePath = join(dirPath, filename)
      }
      writeFileSync(filePath, markdown, 'utf-8')
      console.log('[ScratchPad] 已导出:', filePath)
      return filePath
    }
  )

  // 打开保存对话框，返回用户选择的路径
  ipcMain.handle(
    SCRATCH_PAD_IPC_CHANNELS.CHOOSE_EXPORT_PATH,
    async (_, defaultName: string): Promise<string | null> => {
      const win = BrowserWindow.getFocusedWindow()
      if (!win) return null
      const result = await dialog.showSaveDialog(win, {
        title: '导出 Scratch Pad 为 Markdown',
        defaultPath: defaultName,
        filters: [
          { name: 'Markdown', extensions: ['md'] },
          { name: '所有文件', extensions: ['*'] },
        ],
      })
      return result.canceled ? null : result.filePath
    }
  )

  // 将图片 data URL 写入系统剪贴板
  ipcMain.handle(
    SCRATCH_PAD_IPC_CHANNELS.COPY_IMAGE,
    async (_, dataUrl: string): Promise<{ success: boolean; message?: string }> => {
      try {
        if (!dataUrl || typeof dataUrl !== 'string') {
          return { success: false, message: '无效的图片数据' }
        }
        const img = nativeImage.createFromDataURL(dataUrl)
        if (img.isEmpty()) {
          return { success: false, message: '该格式图片暂不支持复制' }
        }
        clipboard.writeImage(img)
        return { success: true }
      } catch (err) {
        console.error('[ScratchPad] 复制图片到剪贴板失败:', err)
        return { success: false, message: '复制失败' }
      }
    }
  )

  // ===== 应用图标切换 =====

  ipcMain.handle(
    APP_ICON_IPC_CHANNELS.SET,
    async (_, variantId: string): Promise<boolean> => {
      try {
        // 解析图标文件路径
        const iconPath = resolveAppIconPath(variantId)
        if (!iconPath || !existsSync(iconPath)) {
          console.warn('[图标] 图标文件不存在:', iconPath)
          return false
        }

        // macOS: 设置 Dock 图标
        if (process.platform === 'darwin' && app.dock) {
          app.dock.setIcon(iconPath)
        }

        // 持久化到设置
        await updateSettings({ appIconVariant: variantId })
        console.log(`[图标] 已切换到: ${variantId}`)
        return true
      } catch (error) {
        console.error('[图标] 切换失败:', error)
        return false
      }
    }
  )

  // ===== Dock/Launcher 角标 =====

  ipcMain.handle(
    DOCK_BADGE_IPC_CHANNELS.SET_COUNT,
    async (_, count: number): Promise<boolean> => {
      return setDockBadgeCount(count)
    }
  )

  // ===== 环境检测相关 =====

  // 执行环境检测
  ipcMain.handle(
    ENVIRONMENT_IPC_CHANNELS.CHECK,
    async (): Promise<EnvironmentCheckResult> => {
      const result = await checkEnvironment()
      // 自动保存检测结果到设置
      await updateSettings({
        lastEnvironmentCheck: result,
      })
      return result
    }
  )

  // ===== 第三方安装包（Git / Node.js）相关 =====

  ipcMain.handle(
    INSTALLER_IPC_CHANNELS.MANIFEST,
    async (): Promise<InstallerManifest> => {
      return fetchInstallerManifest()
    }
  )

  ipcMain.handle(
    INSTALLER_IPC_CHANNELS.DOWNLOAD,
    async (event, req: InstallerDownloadRequest): Promise<InstallerDownloadResult> => {
      const manifest = await fetchInstallerManifest()
      const source = findInstallerSource(manifest, req.id, req.arch)
      if (!source) {
        throw new Error(`未找到安装包：id=${req.id}, arch=${req.arch}`)
      }
      const window = BrowserWindow.fromWebContents(event.sender)
      if (!window) {
        throw new Error('发起下载的窗口已关闭')
      }
      const key = `${req.id}:${req.arch}`
      return downloadInstaller(source, key, window)
    }
  )

  ipcMain.handle(
    INSTALLER_IPC_CHANNELS.CANCEL,
    async (_event, key: string): Promise<boolean> => {
      return cancelInstallerDownload(key)
    }
  )

  ipcMain.handle(
    INSTALLER_IPC_CHANNELS.LAUNCH,
    async (_event, filePath: string): Promise<void> => {
      await launchInstaller(filePath)
    }
  )

  // ===== 代理配置相关 =====

  // 获取代理配置
  ipcMain.handle(
    PROXY_IPC_CHANNELS.GET_SETTINGS,
    async (): Promise<ProxyConfig> => {
      return getProxySettings()
    }
  )

  // 更新代理配置
  ipcMain.handle(
    PROXY_IPC_CHANNELS.UPDATE_SETTINGS,
    async (_, config: ProxyConfig): Promise<void> => {
      await saveProxySettings(config)
    }
  )

  // 检测系统代理
  ipcMain.handle(
    PROXY_IPC_CHANNELS.DETECT_SYSTEM,
    async (): Promise<SystemProxyDetectResult> => {
      return detectSystemProxy()
    }
  )

  // ===== Agent 会话管理相关 =====

  /** 一次读取会话索引；存储故障必须向上抛，不能伪装成 pending 为空。 */
  const createVisibleSessionIdSet = (): Set<string> => new Set(
    listAgentSessions().filter(isAgentSessionUserVisible).map((session) => session.id),
  )

  /** 使用同一 visible ID Set 过滤 pending 与活跃快照，避免逐项重复读取会话索引。 */
  const getUserVisiblePendingRequests = <T extends { sessionId: string }>(
    records: T[],
    visibleSessionIds: ReadonlySet<string>,
  ): T[] => records.filter((record) => visibleSessionIds.has(record.sessionId))

  // 获取 Agent 会话列表
  ipcMain.handle(
    AGENT_IPC_CHANNELS.LIST_SESSIONS,
    async (): Promise<AgentSessionMeta[]> => listVisibleAgentSessions()
  )

  // 获取未归档会话列表（侧栏 active 视图）
  ipcMain.handle(
    AGENT_IPC_CHANNELS.LIST_ACTIVE_SESSIONS,
    async (): Promise<AgentSessionMeta[]> => listActiveAgentSessions(),
  )

  // 获取当前主进程仍在执行的 Agent 会话快照，供 renderer 重载后恢复运行态
  ipcMain.handle(
    AGENT_IPC_CHANNELS.ACTIVE_SESSIONS_SNAPSHOT,
    async (): Promise<AgentActiveSessionSnapshot[]> => getUserVisiblePendingRequests(
      listActiveAgentSessionSnapshots(),
      createVisibleSessionIdSet(),
    ),
  )

  // 获取归档会话列表（进入归档视图时按需加载）
  ipcMain.handle(
    AGENT_IPC_CHANNELS.LIST_ARCHIVED_SESSIONS,
    async (): Promise<AgentSessionMeta[]> => listArchivedAgentSessions(),
  )

  // 获取归档会话数量（active 视图只展示计数）
  ipcMain.handle(
    AGENT_IPC_CHANNELS.COUNT_ARCHIVED_SESSIONS,
    async (): Promise<number> => countArchivedAgentSessions(),
  )

  // 创建 Agent 会话
  ipcMain.handle(
    AGENT_IPC_CHANNELS.CREATE_SESSION,
    async (_, title?: string, channelId?: string, workspaceId?: string, modelId?: string): Promise<AgentSessionMeta> => {
      const session = createAgentSession(title, channelId, workspaceId, modelId)
      feishuBridgeManager.ensureSessionMirror(session).catch((error) => {
        console.error('[飞书 Session 镜像] 新会话建群失败:', error)
      })
      return session
    }
  )

  // 受管浏览器：renderer 只能投影状态和更新 slot 布局，不能取得 WebContents/CDP。
  const assertMainRenderer = async (senderId: number): Promise<void> => {
    const { getMainWindow } = await import('./index')
    const mainWindow = getMainWindow()
    if (!mainWindow || mainWindow.isDestroyed() || mainWindow.webContents.id !== senderId) {
      throw new Error('仅主窗口可以操作受管浏览器。')
    }
  }
  const assertBrowserSessionAccess = async (senderId: number, sessionId: string): Promise<void> => {
    const session = requireVisibleSession(sessionId)
    await assertMainRenderer(senderId)
    // 自动任务与协作子会话同样可以使用受管浏览器；仅校验会话仍存在。
    browserController.configureSession(sessionId, {
      profileKey: resolveBrowserProfileKey(session.workspaceId, sessionId),
      executionSource: session.sourceDelegationId ? 'delegation' : session.sourceAutomationId ? 'automation' : 'user',
    })
  }

  ipcMain.handle(
    AGENT_IPC_CHANNELS.OPEN_BROWSER,
    async (event, sessionId: string): Promise<BrowserViewState> => {
      await assertBrowserSessionAccess(event.sender.id, sessionId)
      return browserController.open(sessionId)
    },
  )
  ipcMain.handle(
    AGENT_IPC_CHANNELS.GET_BROWSER_STATE,
    async (event, sessionId: string): Promise<BrowserViewState | null> => {
      await assertBrowserSessionAccess(event.sender.id, sessionId)
      return browserController.getState(sessionId)
    },
  )
  ipcMain.handle(
    AGENT_IPC_CHANNELS.SET_BROWSER_LAYOUT,
    async (event, layout: BrowserViewLayout): Promise<void> => {
      if (!layout || typeof layout.sessionId !== 'string' || !layout.bounds || !Number.isSafeInteger(layout.revision)) throw new Error('无效的浏览器布局。')
      await assertBrowserSessionAccess(event.sender.id, layout.sessionId)
      browserController.setLayout(layout)
    },
  )
  ipcMain.handle(
    AGENT_IPC_CHANNELS.MINIMIZE_BROWSER,
    async (event, sessionId: string): Promise<void> => {
      await assertBrowserSessionAccess(event.sender.id, sessionId)
      browserController.minimize(sessionId)
    },
  )
  ipcMain.handle(
    AGENT_IPC_CHANNELS.NAVIGATE_BROWSER,
    async (event, input: BrowserNavigateInput): Promise<BrowserViewState> => {
      await assertBrowserSessionAccess(event.sender.id, input.sessionId)
      return browserController.navigateDisplay(input.sessionId, input.url, input.tabId)
    },
  )
  ipcMain.handle(AGENT_IPC_CHANNELS.GO_BACK_BROWSER, async (event, sessionId: string) => {
    await assertBrowserSessionAccess(event.sender.id, sessionId)
    return browserController.goBackDisplay(sessionId)
  })
  ipcMain.handle(AGENT_IPC_CHANNELS.GO_FORWARD_BROWSER, async (event, sessionId: string) => {
    await assertBrowserSessionAccess(event.sender.id, sessionId)
    return browserController.goForwardDisplay(sessionId)
  })
  ipcMain.handle(AGENT_IPC_CHANNELS.RELOAD_BROWSER, async (event, sessionId: string) => {
    await assertBrowserSessionAccess(event.sender.id, sessionId)
    return browserController.reloadDisplay(sessionId)
  })
  ipcMain.handle(AGENT_IPC_CHANNELS.CLOSE_BROWSER, async (event, sessionId: string): Promise<void> => {
    await assertBrowserSessionAccess(event.sender.id, sessionId)
    await browserController.close(sessionId)
  })
  ipcMain.handle(AGENT_IPC_CHANNELS.LIST_BROWSER_TABS, async (event, sessionId: string): Promise<BrowserViewState> => {
    await assertBrowserSessionAccess(event.sender.id, sessionId)
    return browserController.listTabs(sessionId)
  })
  ipcMain.handle(AGENT_IPC_CHANNELS.CREATE_BROWSER_TAB, async (event, input: BrowserCreateTabInput): Promise<BrowserViewState> => {
    await assertBrowserSessionAccess(event.sender.id, input.sessionId)
    return browserController.createDisplayTab(input.sessionId, input.url)
  })
  ipcMain.handle(AGENT_IPC_CHANNELS.SELECT_BROWSER_TAB, async (event, input: BrowserTabInput): Promise<BrowserViewState> => {
    await assertBrowserSessionAccess(event.sender.id, input.sessionId)
    if (!input.tabId) throw new Error('tabId 必填。')
    return browserController.selectTab(input.sessionId, input.tabId)
  })
  ipcMain.handle(AGENT_IPC_CHANNELS.CLOSE_BROWSER_TAB, async (event, input: BrowserTabInput): Promise<BrowserViewState | null> => {
    await assertBrowserSessionAccess(event.sender.id, input.sessionId)
    if (!input.tabId) throw new Error('tabId 必填。')
    return browserController.closeTab(input.sessionId, input.tabId)
  })


  // 获取 Agent 会话 SDKMessage（Phase 4 新格式）
  ipcMain.handle(
    AGENT_IPC_CHANNELS.GET_SDK_MESSAGES,
    async (_, id: string): Promise<SDKMessage[]> => {
      requireVisibleSession(id)
      return getAgentSessionSDKMessages(id)
    }
  )

  // 更新 Agent 会话标题
  ipcMain.handle(
    AGENT_IPC_CHANNELS.UPDATE_TITLE,
    async (_, id: string, title: string): Promise<AgentSessionMeta> => {
      requireVisibleSession(id)
      return updateAgentSessionMeta(id, { title })
    }
  )

  // 更新 Agent 会话模型选择
  ipcMain.handle(
    AGENT_IPC_CHANNELS.UPDATE_SESSION_MODEL,
    async (_, id: string, channelId?: string, modelId?: string): Promise<AgentSessionMeta> => {
      requireVisibleSession(id)
      // 模型切换允许在运行中提交；当前 query 继续使用启动时的模型，下一轮读取新配置。
      return updateAgentSessionMeta(id, { channelId, modelId })
    }
  )

  // 选择或清除 Agent 会话的活动 worktree
  ipcMain.handle(
    AGENT_IPC_CHANNELS.SET_ACTIVE_WORKTREE,
    async (_, input: SetAgentSessionActiveWorktreeInput): Promise<AgentSessionMeta> => {
      if (!input || typeof input.sessionId !== 'string' || (input.worktreePath !== null && typeof input.worktreePath !== 'string')) {
        throw new Error('活动 worktree 参数无效')
      }
      const session = requireVisibleSession(input.sessionId)
      if (input.worktreePath === null) {
        return updateAgentSessionMeta(input.sessionId, { activeWorktree: undefined })
      }

      const access = normalizeFileAccessOptions({ sessionId: input.sessionId })
      if (!(await ensurePathAllowedWithWorktree(input.worktreePath, access))) {
        throw new Error('无权将该目录设为活动 worktree')
      }

      const requestedPath = normalizePathForCompare(realpathOrResolve(input.worktreePath))
      const selected = (await listWorktrees(input.worktreePath)).find((worktree) =>
        !worktree.isMain && normalizePathForCompare(realpathOrResolve(worktree.path)) === requestedPath,
      )
      if (!selected) throw new Error('指定目录不是可用的 linked worktree')

      const mainRepoRoot = await getMainRepoRoot(selected.path)
      if (!mainRepoRoot) throw new Error('无法确认 worktree 的主仓库')
      return updateAgentSessionMeta(input.sessionId, {
        activeWorktree: {
          path: realpathOrResolve(selected.path),
          mainRepoRoot: realpathOrResolve(mainRepoRoot),
          branch: selected.branch,
          selectedAt: Date.now(),
        },
      })
    },
  )

  // 生成 Agent 会话标题
  ipcMain.handle(
    AGENT_IPC_CHANNELS.GENERATE_TITLE,
    async (_, input: AgentGenerateTitleInput): Promise<string | null> => {
      return generateAgentTitle(input)
    }
  )

  // 删除 Agent 会话
  ipcMain.handle(
    AGENT_IPC_CHANNELS.DELETE_SESSION,
    async (_, id: string): Promise<void> => {
      const deletingSession = requireVisibleSession(id)
      const attachedFiles = deletingSession.attachedFiles
      // 清理权限服务中该会话的白名单
      permissionService.clearSessionWhitelist(id)
      permissionService.clearSessionPending(id)
      // 清理 AskUser 服务中的待处理请求
      askUserService.clearSessionPending(id)
      // 清理 ExitPlanMode 服务中的待处理请求
      exitPlanService.clearSessionPending(id)
      clearAgentQueuedMessages(id)
      await browserController.close(id)
      closeTerminalsForSession(id)
      deleteAgentSession(id)
      /** 复用关联准入规则，只在普通顶层 Agent 删除成功后清理。 */
      cleanupDeletedAgentSessionCanvasBindings(agentCanvasBindingCleanup, deletingSession)
      releaseAttachedFileWatchers(attachedFiles)
    }
  )

  // 迁移 Chat 对话记录到 Agent 会话
  ipcMain.handle(
    AGENT_IPC_CHANNELS.MIGRATE_CHAT_TO_AGENT,
    async (_, conversationId: string, agentSessionId: string): Promise<void> => {
      requireVisibleSession(agentSessionId)
      migrateChatToAgentSession(conversationId, agentSessionId)
    }
  )

  // 切换 Agent 会话置顶状态
  ipcMain.handle(
    AGENT_IPC_CHANNELS.TOGGLE_PIN,
    async (_, id: string): Promise<AgentSessionMeta> => {
      const current = requireVisibleSession(id)
      const newPinned = !current.pinned
      // 置顶时自动取消归档
      const updates: Partial<AgentSessionMeta> = { pinned: newPinned }
      if (newPinned && current.archived) {
        updates.archived = false
      }
      return updateAgentSessionMeta(id, updates)
    }
  )

  // 切换 Agent 会话星标状态
  ipcMain.handle(
    AGENT_IPC_CHANNELS.TOGGLE_STAR,
    async (_, id: string): Promise<AgentSessionMeta> => {
      const current = requireVisibleSession(id)
      return updateAgentSessionMeta(id, { starred: !current.starred })
    }
  )

  // 清除 Agent 会话完成状态（兼容清除旧版 manualWorking）
  ipcMain.handle(
    AGENT_IPC_CHANNELS.CLEAR_COMPLETION_STATE,
    async (_, id: string): Promise<AgentSessionMeta> => {
      const current = requireVisibleSession(id)
      const updates: Partial<AgentSessionMeta> = {}
      if (current.manualWorking) updates.manualWorking = false
      if (current.completedButUnconfirmed) updates.completedButUnconfirmed = false
      if (Object.keys(updates).length === 0) return current
      return updateAgentSessionMeta(id, updates)
    }
  )

  // 切换 Agent 会话归档状态
  ipcMain.handle(
    AGENT_IPC_CHANNELS.TOGGLE_ARCHIVE,
    async (_, id: string): Promise<AgentSessionMeta> => {
      const current = requireVisibleSession(id)
      const newArchived = !current.archived
      // 归档时自动取消置顶
      const updates: Partial<AgentSessionMeta> = { archived: newArchived }
      if (newArchived && current.pinned) {
        updates.pinned = false
      }
      return updateAgentSessionMeta(id, updates)
    }
  )

  // 搜索 Agent 会话消息内容
  ipcMain.handle(
    AGENT_IPC_CHANNELS.SEARCH_MESSAGES,
    async (_, query: string) => {
      return searchAgentSessionMessages(query)
    }
  )

  // 搜索可引用的 Agent 会话；省略 workspaceId 时跨工作区搜索。
  ipcMain.handle(
    AGENT_IPC_CHANNELS.SEARCH_SESSION_REFERENCES,
    async (_, input: AgentSessionReferenceSearchInput) => {
      return searchAgentSessionReferences(input)
    }
  )

  // 迁移 Agent 会话到另一个工作区
  ipcMain.handle(
    AGENT_IPC_CHANNELS.MOVE_SESSION_TO_WORKSPACE,
    async (_, input: MoveSessionToWorkspaceInput): Promise<AgentSessionMeta> => {
      requireVisibleSession(input.sessionId)
      if (isAgentSessionBusy(input.sessionId)) {
        throw new Error('会话正在启动、运行或仍有排队消息，请停止或清空队列后再迁移')
      }
      const moved = moveSessionToWorkspace(input.sessionId, input.targetWorkspaceId)
      feishuBridgeManager.syncWorkspaceForSession(moved.id, moved.workspaceId!)
      return moved
    }
  )

  // 分叉 Agent 会话
  ipcMain.handle(
    AGENT_IPC_CHANNELS.FORK_SESSION,
    async (_, input: ForkSessionInput): Promise<AgentSessionMeta> => {
      requireVisibleSession(input.sessionId)
      const session = await forkAgentSession(input)
      // Fork 直接在 session manager 内创建元数据，绕过 CREATE_SESSION 的镜像生命周期。
      // 将它作为新的桌面会话处理，确保 Pi fork 也会立即获得可双向续聊的飞书群。
      feishuBridgeManager.ensureSessionMirror(session).catch((error) => {
        console.error('[飞书 Session 镜像] 分叉会话建群失败:', error)
      })
      return session
    }
  )

  // 快照回退（同一会话内回退到指定点）
  ipcMain.handle(
    AGENT_IPC_CHANNELS.REWIND_SESSION,
    async (_, input: RewindSessionInput): Promise<RewindSessionResult> => {
      requireVisibleSession(input.sessionId)
      return rewindAgentSession(
        input.sessionId,
        input.assistantMessageUuid,
      )
    }
  )

  // ===== Agent 工作区管理相关 =====

  // 确保默认工作区存在
  ensureDefaultWorkspace()

  // 获取 Agent 工作区列表
  ipcMain.handle(
    AGENT_IPC_CHANNELS.LIST_WORKSPACES,
    async (): Promise<AgentWorkspace[]> => {
      const workspaces = listAgentWorkspaces()
      for (const workspace of workspaces) {
        if (workspace.projectRootPath) watchAttachedDirectory(workspace.projectRootPath)
        for (const filePath of getWorkspaceAttachedFiles(workspace.slug)) {
          watchAttachedDirectory(dirname(filePath))
        }
      }
      return workspaces
    }
  )

  // 创建 Agent 工作区（保留给迁移与低层管理调用；交互式项目创建应使用 CREATE_PROJECT）。
  ipcMain.handle(
    AGENT_IPC_CHANNELS.CREATE_WORKSPACE,
    async (_, input: import('@proma/shared').CreateAgentWorkspaceInput): Promise<AgentWorkspace> => {
      const workspace = createAgentWorkspace(input)
      if (workspace.projectRootPath) watchAttachedDirectory(workspace.projectRootPath)
      return workspace
    }
  )

  // 创建项目时同时生成其首个 Agent 会话，避免项目以无会话状态进入界面。
  ipcMain.handle(
    AGENT_IPC_CHANNELS.CREATE_PROJECT,
    async (_, input: import('@proma/shared').CreateAgentWorkspaceInput, channelId?: string, modelId?: string): Promise<import('@proma/shared').CreateAgentProjectResult> => {
      const workspace = createAgentWorkspace(input)
      if (workspace.projectRootPath) watchAttachedDirectory(workspace.projectRootPath)

      try {
        const session = createAgentSession(undefined, channelId, workspace.id, modelId)
        feishuBridgeManager.ensureSessionMirror(session).catch((error) => {
          console.error('[飞书 Session 镜像] 项目首个会话建群失败:', error)
        })
        return { workspace, session }
      } catch (error) {
        try {
          deleteAgentWorkspace(workspace.id)
        } catch (rollbackError) {
          console.error('[项目创建] 首个会话创建失败后的项目回滚失败:', rollbackError)
        }
        throw error
      }
    }
  )

  // 更新 Agent 工作区
  ipcMain.handle(
    AGENT_IPC_CHANNELS.UPDATE_WORKSPACE,
    async (_, id: string, updates: { name: string }): Promise<AgentWorkspace> => {
      return updateAgentWorkspace(id, updates)
    }
  )

  // 重新选择本地项目根目录，保留原项目、会话和配置。
  ipcMain.handle(
    AGENT_IPC_CHANNELS.RELINK_WORKSPACE_PROJECT_ROOT,
    async (_, id: string, projectRootPath: string): Promise<AgentWorkspace> => {
      return workspaceOperationGuard.runWorkspaceWrite(id, () => {
        const previousRoot = getAgentWorkspace(id)?.projectRootPath
        const updated = relinkAgentWorkspaceProjectRoot(id, projectRootPath)
        if (previousRoot && previousRoot !== updated.projectRootPath) {
          releaseDirectoryWatcherIfUnreferenced(previousRoot)
        }
        if (updated.projectRootPath) watchAttachedDirectory(updated.projectRootPath)
        return updated
      })
    }
  )

  // 在缺失本地项目的原路径恢复空目录。
  ipcMain.handle(
    AGENT_IPC_CHANNELS.RESTORE_WORKSPACE_PROJECT_ROOT,
    async (_, id: string): Promise<AgentWorkspace> => {
      return workspaceOperationGuard.runWorkspaceWrite(id, () => {
        const updated = restoreAgentWorkspaceProjectRoot(id)
        if (updated.projectRootPath) watchAttachedDirectory(updated.projectRootPath)
        return updated
      })
    }
  )

  // 删除 Agent 工作区
  ipcMain.handle(
    AGENT_IPC_CHANNELS.DELETE_WORKSPACE,
    async (_, id: string): Promise<void> => {
      return workspaceOperationGuard.runWorkspaceWrite(id, () => {
        const deletingWorkspace = getAgentWorkspace(id)
        if (!deletingWorkspace) {
          return deleteAgentWorkspace(id)
        }
        // 守卫前置：在删除任何会话/自动任务前就拦截不可删除的工作区，
        // 否则会先把绑定数据删光、再由 deleteAgentWorkspace 抛错，造成数据丢失与状态不一致
        if (deletingWorkspace.slug === 'default') {
          throw new Error('默认项目不能删除')
        }
        if (listAgentWorkspaces().length <= 1) {
          throw new Error('至少需要保留一个项目')
        }

        const affectedSessions = listAgentSessions()
          .filter((session) => session.workspaceId === id)
        const affectedSessionIds = affectedSessions.map((session) => session.id)
        const deletedAttachedFiles = [
          ...affectedSessions.flatMap((session) => session.attachedFiles ?? []),
          ...getWorkspaceAttachedFiles(deletingWorkspace.slug),
        ]
        const affectedAutomationIds = listAutomations()
          .filter((automation) => automation.workspaceId === id)
          .map((automation) => automation.id)
        const deletedProjectRoot = deletingWorkspace.projectRootPath
        const removedDingTalkBindings = dingtalkBridgeManager.removeBindingsForDeletedWorkspace(id, affectedSessionIds)
        const removedWeChatBindings = wechatBridge.removeBindingsForDeletedWorkspace(id, affectedSessionIds)
        const removedFeishuBindings = feishuBridgeManager.removeBindingsForDeletedWorkspace(id, affectedSessionIds)

        if (removedDingTalkBindings > 0) {
          console.log(`[项目删除] 已移除 ${removedDingTalkBindings} 条钉钉聊天绑定`)
        }
        if (removedWeChatBindings > 0) {
          console.log(`[项目删除] 已移除 ${removedWeChatBindings} 条微信聊天绑定`)
        }
        if (removedFeishuBindings > 0) {
          console.log(`[项目删除] 已移除 ${removedFeishuBindings} 条飞书聊天绑定`)
        }

        for (const sessionId of affectedSessionIds) {
          if (isAgentSessionActive(sessionId)) {
            stopAgent(sessionId)
          }
          closeTerminalsForSession(sessionId)
          deleteAgentSession(sessionId)
          /** 每个会话主删除成功后独立 best-effort 清理，不阻断工作区删除。 */
          const deletedSession = affectedSessions.find((session) => session.id === sessionId)
          if (deletedSession) {
            cleanupDeletedAgentSessionCanvasBindings(agentCanvasBindingCleanup, deletedSession)
          }
        }
        for (const automationId of affectedAutomationIds) {
          deleteAutomation(automationId)
        }
        if (affectedAutomationIds.length > 0) {
          broadcastAutomationsChanged()
        }
        deleteAgentWorkspace(id)

        releaseAttachedFileWatchers(deletedAttachedFiles)
        if (deletedProjectRoot) releaseDirectoryWatcherIfUnreferenced(deletedProjectRoot)
      })
    }
  )

  // 重排工作区顺序
  ipcMain.handle(
    AGENT_IPC_CHANNELS.REORDER_WORKSPACES,
    async (_, orderedIds: string[]): Promise<AgentWorkspace[]> => {
      return reorderAgentWorkspaces(orderedIds)
    }
  )

  // ===== 工作区能力（MCP + Skill） =====

  // 获取工作区能力摘要
  ipcMain.handle(
    AGENT_IPC_CHANNELS.GET_CAPABILITIES,
    async (_, workspaceSlug: string): Promise<WorkspaceCapabilities> => {
      return getWorkspaceCapabilities(workspaceSlug)
    }
  )

  // 获取工作区 MCP 配置
  ipcMain.handle(
    AGENT_IPC_CHANNELS.GET_MCP_CONFIG,
    async (_, workspaceSlug: string): Promise<WorkspaceMcpConfig> => {
      return getWorkspaceMcpConfig(workspaceSlug)
    }
  )

  // Save full MCP configurations defensively: renderer-provided test results are
  // display data, not authorization to load an MCP. Newly enabled or changed
  // entries are persisted disabled and receive the same real validation as a
  // card toggle before they can become enabled.
  ipcMain.handle(
    AGENT_IPC_CHANNELS.SAVE_MCP_CONFIG,
    async (_, workspaceSlug: string, config: WorkspaceMcpConfig, options?: import('@proma/shared').SaveWorkspaceMcpConfigOptions): Promise<void> => {
      for (const name of options?.explicitlyDisabledServerNames ?? []) {
        clearWorkspaceMcpPendingValidation(workspaceSlug, name)
      }
      const pendingValidations: Array<{ name: string; candidate: import('@proma/shared').McpServerEntry }> = []
      const servers: WorkspaceMcpConfig['servers'] = {}

      const configServerNames = new Set(Object.keys(config.servers))
      clearMissingWorkspaceMcpPendingValidations(workspaceSlug, configServerNames)
      for (const [name, entry] of Object.entries(config.servers)) {
        const entryWithoutTestResult = { ...entry }
        delete entryWithoutTestResult.lastTestResult
        const candidate = { ...entryWithoutTestResult, enabled: true }
        if (entry.enabled) {
          // `lastTestResult` is renderer-visible display data, not proof that an
          // MCP can be loaded. Re-validate every enabled entry, including
          // configs created by earlier app versions or manually edited on disk.
          servers[name] = { ...entryWithoutTestResult, enabled: false }
          pendingValidations.push({ name, candidate })
          setWorkspaceMcpPendingValidation(workspaceSlug, name, candidate)
        } else {
          const pendingCandidate = getWorkspaceMcpPendingValidation(workspaceSlug, name)
          const pendingEntry = pendingCandidate ? { ...pendingCandidate, enabled: false } : undefined
          if (pendingEntry && getMcpEntryFingerprint(pendingEntry) === getMcpEntryFingerprint(entry)) {
            servers[name] = pendingEntry
            pendingValidations.push({ name, candidate: pendingCandidate! })
          } else {
            clearWorkspaceMcpPendingValidation(workspaceSlug, name)
            // Do not persist renderer-provided verification data for disabled entries.
            servers[name] = entryWithoutTestResult
          }
        }
      }

      const pendingConfig = { servers }
      const refreshGeneration = advanceWorkspaceMcpRefreshGeneration(workspaceSlug)
      saveWorkspaceMcpConfig(workspaceSlug, pendingConfig)
      for (const validation of pendingValidations) {
        await validateAndConditionallyPersistMcp(
          workspaceSlug,
          validation.name,
          validation.candidate,
          getMcpEntryFingerprint(pendingConfig.servers[validation.name]!),
          refreshGeneration,
        )
      }
    }
  )

  // Atomically toggle one MCP. Any later save advances the workspace refresh
  // generation, while fingerprint matching protects this entry's validation writeback.
  ipcMain.handle(
    AGENT_IPC_CHANNELS.SET_MCP_ENABLED_AND_VALIDATE,
    async (_, workspaceSlug: string, name: string, enabled: boolean): Promise<import('@proma/shared').McpConnectionMutationResult> => {
      const current = getWorkspaceMcpConfig(workspaceSlug)
      const entry = current.servers[name]
      if (!entry) throw new Error('找不到 MCP 配置')

      const entryWithoutTestResult = { ...entry }
      delete entryWithoutTestResult.lastTestResult
      if (!enabled) {
        const config = { servers: { ...current.servers, [name]: { ...entry, enabled: false } } }
        advanceWorkspaceMcpRefreshGeneration(workspaceSlug)
        clearWorkspaceMcpPendingValidation(workspaceSlug, name)
        saveWorkspaceMcpConfig(workspaceSlug, config)
        return { config, verification: { success: true, message: 'MCP 已关闭' } }
      }

      // Keep the entry disabled until the real handshake succeeds. This prevents
      // the runtime from repeatedly starting a known-invalid server.
      const pendingEntry = { ...entryWithoutTestResult, enabled: false }
      const pendingConfig = { servers: { ...current.servers, [name]: pendingEntry } }
      // Keep this candidate in memory so an unrelated full-config save during
      // the handshake preserves and resumes the validation instead of treating
      // the temporary disabled entry as a user-requested disable.
      const refreshGeneration = advanceWorkspaceMcpRefreshGeneration(workspaceSlug)
      setWorkspaceMcpPendingValidation(workspaceSlug, name, { ...entryWithoutTestResult, enabled: true })
      saveWorkspaceMcpConfig(workspaceSlug, pendingConfig)
      return validateAndConditionallyPersistMcp(
        workspaceSlug,
        name,
        { ...entryWithoutTestResult, enabled: true },
        getMcpEntryFingerprint(pendingEntry),
        refreshGeneration,
      )
    },
  )

  // Atomically install a catalog MCP. Existing configs win instead of being
  // replaced by a stale renderer snapshot.
  ipcMain.handle(
    AGENT_IPC_CHANNELS.INSTALL_MCP_AND_VALIDATE,
    async (_, workspaceSlug: string, name: string, entry: import('@proma/shared').McpServerEntry): Promise<import('@proma/shared').McpInstallMutationResult> => {
      const current = getWorkspaceMcpConfig(workspaceSlug)
      if (current.servers[name]) {
        return {
          installed: false,
          config: current,
          verification: { success: Boolean(current.servers[name]?.lastTestResult?.success), message: 'MCP 已存在' },
        }
      }

      const entryWithoutTestResult = { ...entry }
      delete entryWithoutTestResult.lastTestResult
      if (!entry.enabled) {
        const config = { servers: { ...current.servers, [name]: entryWithoutTestResult } }
        advanceWorkspaceMcpRefreshGeneration(workspaceSlug)
        saveWorkspaceMcpConfig(workspaceSlug, config)
        return { installed: true, config, verification: { success: true, message: 'MCP 已添加，等待配置' } }
      }

      // Newly installed catalog MCPs are also kept disabled until validation.
      const pendingEntry = { ...entryWithoutTestResult, enabled: false }
      const pendingConfig = { servers: { ...current.servers, [name]: pendingEntry } }
      // Keep this candidate in memory so an unrelated full-config save during
      // the handshake preserves and resumes the validation instead of treating
      // the temporary disabled entry as a user-requested disable.
      const refreshGeneration = advanceWorkspaceMcpRefreshGeneration(workspaceSlug)
      setWorkspaceMcpPendingValidation(workspaceSlug, name, { ...entryWithoutTestResult, enabled: true })
      saveWorkspaceMcpConfig(workspaceSlug, pendingConfig)
      const result = await validateAndConditionallyPersistMcp(
        workspaceSlug,
        name,
        { ...entryWithoutTestResult, enabled: true },
        getMcpEntryFingerprint(pendingEntry),
        refreshGeneration,
      )
      return { installed: true, ...result }
    },
  )

  // 刷新并持久化工作区 MCP 真实连接状态
  ipcMain.handle(
    AGENT_IPC_CHANNELS.REFRESH_MCP_CONNECTIONS,
    async (_, workspaceSlug: string): Promise<WorkspaceMcpConfig> => {
      const refreshGeneration = advanceWorkspaceMcpRefreshGeneration(workspaceSlug)
      const config = getWorkspaceMcpConfig(workspaceSlug)
      const entries = Object.entries(config.servers).filter(([, entry]) => entry.enabled)
      const { validateMcpServer } = await import('./lib/mcp-validator')
      const validations = await mapWithConcurrency(entries, 4, async ([name, entry]) => {
        const result = await validateMcpServer(name, entry, workspaceSlug)
        return {
          name,
          fingerprint: getMcpEntryFingerprint(entry),
          lastTestResult: {
            success: result.valid,
            message: result.valid ? (result.message ?? 'MCP 连接成功') : (result.reason ?? 'MCP 连接失败'),
            timestamp: Date.now(),
          },
        }
      })

      // 保存或更晚发起的刷新会使本次 generation 过期；直接返回最新完整配置，不写任何旧验证结果。
      if (!isWorkspaceMcpRefreshCurrent(workspaceSlug, refreshGeneration)) {
        return getWorkspaceMcpConfig(workspaceSlug)
      }

      const refreshed = mergeMcpRefreshResults(getWorkspaceMcpConfig(workspaceSlug), validations)
      saveWorkspaceMcpConfig(workspaceSlug, refreshed)
      return refreshed
    },
  )

  ipcMain.handle(
    AGENT_IPC_CHANNELS.START_MCP_OAUTH,
    async (_, input: import('@proma/shared').StartMcpOAuthInput): Promise<import('@proma/shared').McpOAuthStartResult> => {
      return startMcpOAuth(input)
    }
  )

  ipcMain.handle(
    AGENT_IPC_CHANNELS.SAVE_MCP_API_KEY,
    async (_, input: import('@proma/shared').SaveMcpApiKeyInput): Promise<void> => {
      return saveMcpApiKey(input)
    }
  )

  // The renderer removes the transport config first, then calls this handler
  // to remove only the matching encrypted Keychain payload.
  ipcMain.handle(
    AGENT_IPC_CHANNELS.DELETE_MCP_CREDENTIAL,
    async (_, workspaceSlug: string, serverName: string): Promise<void> => {
      return deleteMcpCredential(workspaceSlug, serverName)
    }
  )

  ipcMain.handle(
    AGENT_IPC_CHANNELS.GET_CLI_INTEGRATION_STATUSES,
    async (_, workspaceSlug: string): Promise<import('@proma/shared').CliIntegrationStatus[]> => {
      return getCliIntegrationStatuses(undefined, getDisabledCliIntegrationIds(workspaceSlug))
    }
  )

  ipcMain.handle(
    AGENT_IPC_CHANNELS.SET_CLI_INTEGRATION_ENABLED,
    async (_, workspaceSlug: string, id: string, enabled: boolean): Promise<import('@proma/shared').CliIntegrationStatus[]> => {
      setCliIntegrationEnabled(workspaceSlug, id, enabled)
      return getCliIntegrationStatuses(undefined, getDisabledCliIntegrationIds(workspaceSlug))
    },
  )

  // 测试 MCP 服务器连接
  ipcMain.handle(
    AGENT_IPC_CHANNELS.TEST_MCP_SERVER,
    async (_, workspaceSlug: string, name: string, entry: import('@proma/shared').McpServerEntry): Promise<{ success: boolean; message: string }> => {
      const { validateMcpServer } = await import('./lib/mcp-validator')
      const result = await validateMcpServer(name, entry, workspaceSlug)
      return {
        success: result.valid,
        message: result.valid ? (result.message ?? '连接成功') : (result.reason || '连接失败'),
      }
    }
  )

  // 启用或关闭 Proma 内置 MCP
  ipcMain.handle(
    AGENT_IPC_CHANNELS.SET_BUILTIN_MCP_ENABLED,
    async (_, workspaceSlug: string, id: string, enabled: boolean): Promise<WorkspaceCapabilities> => {
      setBuiltinMcpUserEnabled(id, enabled)
      return getWorkspaceCapabilities(workspaceSlug)
    }
  )

  // 获取工作区 Skill 列表（含活跃和不活跃，设置页 UI 用）
  ipcMain.handle(
    AGENT_IPC_CHANNELS.GET_SKILLS,
    async (_, workspaceSlug: string): Promise<SkillMeta[]> => {
      return getAllWorkspaceSkills(workspaceSlug)
    }
  )

  // 获取工作区 Skills 目录绝对路径
  ipcMain.handle(
    AGENT_IPC_CHANNELS.GET_SKILLS_DIR,
    async (_, workspaceSlug: string): Promise<string> => {
      return getWorkspaceSkillsDir(workspaceSlug)
    }
  )

  // 删除工作区 Skill
  ipcMain.handle(
    AGENT_IPC_CHANNELS.DELETE_SKILL,
    async (_, workspaceSlug: string, skillSlug: string): Promise<void> => {
      return deleteWorkspaceSkill(workspaceSlug, skillSlug)
    }
  )

  // 切换工作区 Skill 启用/禁用
  ipcMain.handle(
    AGENT_IPC_CHANNELS.TOGGLE_SKILL,
    async (_, workspaceSlug: string, skillSlug: string, enabled: boolean): Promise<void> => {
      return toggleWorkspaceSkill(workspaceSlug, skillSlug, enabled)
    }
  )

  // 获取其他工作区的 Skill 列表
  ipcMain.handle(
    AGENT_IPC_CHANNELS.GET_OTHER_WORKSPACE_SKILLS,
    async (_, currentSlug: string) => {
      return getOtherWorkspaceSkills(currentSlug)
    }
  )

  // 获取默认 Skills 的 slug 列表（来自 ~/.proma/default-skills/）
  ipcMain.handle(
    AGENT_IPC_CHANNELS.GET_DEFAULT_SKILL_SLUGS,
    async () => {
      return getDefaultSkillSlugs()
    }
  )

  // 从其他工作区导入 Skill
  ipcMain.handle(
    AGENT_IPC_CHANNELS.IMPORT_SKILL_FROM_WORKSPACE,
    async (_, targetSlug: string, sourceSlug: string, skillSlug: string): Promise<SkillMeta> => {
      return importSkillFromWorkspace(targetSlug, sourceSlug, skillSlug)
    }
  )

  // 从其他工作区批量导入多个 Skill
  ipcMain.handle(
    AGENT_IPC_CHANNELS.BATCH_IMPORT_SKILLS_FROM_WORKSPACES,
    async (_, targetSlug: string, selections: BulkImportWorkspaceSelection[]): Promise<BulkImportSkillsResult> => {
      return batchImportSkillsFromWorkspaces(targetSlug, selections)
    }
  )

  // 从源工作区同步更新已导入的 Skill
  ipcMain.handle(
    AGENT_IPC_CHANNELS.UPDATE_SKILL_FROM_SOURCE,
    async (_, targetSlug: string, skillSlug: string): Promise<SkillMeta> => {
      return updateSkillFromSource(targetSlug, skillSlug)
    }
  )

  ipcMain.handle(
    AGENT_IPC_CHANNELS.READ_SKILL_CONTENT,
    async (_, workspaceSlug: string, skillSlug: string): Promise<string> => {
      return readWorkspaceSkillContent(workspaceSlug, skillSlug)
    }
  )

  ipcMain.handle(
    AGENT_IPC_CHANNELS.WRITE_SKILL_CONTENT,
    async (_, workspaceSlug: string, skillSlug: string, content: string): Promise<void> => {
      writeWorkspaceSkillContent(workspaceSlug, skillSlug, content)
    }
  )

  // ===== Skill 子文件管理 =====

  ipcMain.handle(
    AGENT_IPC_CHANNELS.LIST_SKILL_FILES,
    async (_, workspaceSlug: string, skillSlug: string) => {
      return listSkillFiles(workspaceSlug, skillSlug)
    }
  )

  ipcMain.handle(
    AGENT_IPC_CHANNELS.READ_SKILL_FILE,
    async (_, workspaceSlug: string, skillSlug: string, relativePath: string) => {
      return readSkillFile(workspaceSlug, skillSlug, relativePath)
    }
  )

  ipcMain.handle(
    AGENT_IPC_CHANNELS.WRITE_SKILL_FILE,
    async (_, workspaceSlug: string, skillSlug: string, relativePath: string, content: string): Promise<void> => {
      writeSkillFile(workspaceSlug, skillSlug, relativePath, content)
    }
  )

  ipcMain.handle(
    AGENT_IPC_CHANNELS.CREATE_SKILL_ENTRY,
    async (_, workspaceSlug: string, skillSlug: string, relativePath: string, type: 'file' | 'directory'): Promise<void> => {
      createSkillEntry(workspaceSlug, skillSlug, relativePath, type)
    }
  )

  ipcMain.handle(
    AGENT_IPC_CHANNELS.DELETE_SKILL_ENTRY,
    async (_, workspaceSlug: string, skillSlug: string, relativePath: string): Promise<void> => {
      deleteSkillEntry(workspaceSlug, skillSlug, relativePath)
    }
  )

  ipcMain.handle(
    AGENT_IPC_CHANNELS.RENAME_SKILL_ENTRY,
    async (_, workspaceSlug: string, skillSlug: string, fromRelative: string, toRelative: string): Promise<void> => {
      renameSkillEntry(workspaceSlug, skillSlug, fromRelative, toRelative)
    }
  )

  // ===== 工作区记忆文件管理 =====

  ipcMain.handle(
    AGENT_IPC_CHANNELS.GET_WORKSPACE_MEMORY_SUMMARY,
    async (_, workspaceSlug: string): Promise<WorkspaceMemorySummary> => {
      return getWorkspaceMemorySummary(workspaceSlug)
    }
  )

  ipcMain.handle(
    AGENT_IPC_CHANNELS.READ_WORKSPACE_AGENTS_MD,
    async (_, workspaceSlug: string): Promise<SkillFileContent> => {
      return readWorkspaceAgentsMd(workspaceSlug)
    }
  )

  ipcMain.handle(
    AGENT_IPC_CHANNELS.WRITE_WORKSPACE_AGENTS_MD,
    async (_, workspaceSlug: string, content: string, expectedContent?: string): Promise<void> => {
      writeWorkspaceAgentsMd(workspaceSlug, content, expectedContent)
    }
  )

  ipcMain.handle(
    AGENT_IPC_CHANNELS.LIST_WORKSPACE_AUTO_MEMORY_FILES,
    async (_, workspaceSlug: string) => {
      return listWorkspaceAutoMemoryFiles(workspaceSlug)
    }
  )

  ipcMain.handle(
    AGENT_IPC_CHANNELS.READ_WORKSPACE_AUTO_MEMORY_FILE,
    async (_, workspaceSlug: string, relativePath: string): Promise<SkillFileContent> => {
      return readWorkspaceAutoMemoryFile(workspaceSlug, relativePath)
    }
  )

  ipcMain.handle(
    AGENT_IPC_CHANNELS.WRITE_WORKSPACE_AUTO_MEMORY_FILE,
    async (_, workspaceSlug: string, relativePath: string, content: string, expectedContent?: string): Promise<void> => {
      writeWorkspaceAutoMemoryFile(workspaceSlug, relativePath, content, expectedContent)
    }
  )

  ipcMain.handle(AGENT_IPC_CHANNELS.OPEN_WORKSPACE_MEMORY_WINDOW, async (_, workspaceSlug: string, relativePath?: string): Promise<void> => {
    // 先经既有受限访问层核验 slug；若指定文件，也用受限路径解析器验证。
    getWorkspaceMemorySummary(workspaceSlug)
    if (relativePath !== undefined) {
      if (typeof relativePath !== 'string' || !relativePath) throw new Error('记忆文件路径非法')
      readWorkspaceAutoMemoryFile(workspaceSlug, relativePath)
    }
    const { showWorkspaceMemoryWindow } = await import('./lib/workspace-memory-window')
    showWorkspaceMemoryWindow(workspaceSlug, relativePath)
  })

  ipcMain.handle(
    AGENT_IPC_CHANNELS.WORKSPACE_MEMORY_WINDOW_READY,
    async (event, workspaceSlug: string): Promise<void> => {
      if (!markWorkspaceMemoryWindowReady(workspaceSlug, event.sender.id)) {
        throw new Error('记忆窗口不存在或不属于当前渲染进程')
      }
    },
  )

  ipcMain.handle(
    AGENT_IPC_CHANNELS.CONFIRM_WORKSPACE_MEMORY_WINDOW_CLOSE,
    async (event, workspaceSlug: string): Promise<void> => {
      if (!confirmWorkspaceMemoryWindowClose(workspaceSlug, event.sender.id)) {
        throw new Error('记忆窗口不存在或不属于当前渲染进程')
      }
    },
  )

  ipcMain.handle(
    AGENT_IPC_CHANNELS.START_WORKSPACE_MEMORY_WATCH,
    async (event, workspaceSlug: string): Promise<void> => {
      const webContents = event.sender
      stopWorkspaceMemoryWatch(webContents.id, workspaceSlug)
      const unsubscribe = subscribeWorkspaceMemoryChanges(workspaceSlug, (change) => {
        if (!webContents.isDestroyed()) {
          webContents.send(AGENT_IPC_CHANNELS.WORKSPACE_MEMORY_FILE_CHANGED, { workspaceSlug, change })
        }
      })
      const subscriptions = workspaceMemoryWatchSubscriptions.get(webContents.id) ?? new Map<string, () => void>()
      subscriptions.set(workspaceSlug, unsubscribe)
      workspaceMemoryWatchSubscriptions.set(webContents.id, subscriptions)
      if (!workspaceMemoryWatchDestroyedListeners.has(webContents.id)) {
        workspaceMemoryWatchDestroyedListeners.add(webContents.id)
        webContents.once('destroyed', () => {
          const active = workspaceMemoryWatchSubscriptions.get(webContents.id)
          if (active) {
            for (const stop of active.values()) stop()
            workspaceMemoryWatchSubscriptions.delete(webContents.id)
          }
          workspaceMemoryWatchDestroyedListeners.delete(webContents.id)
        })
      }
    },
  )

  ipcMain.handle(
    AGENT_IPC_CHANNELS.STOP_WORKSPACE_MEMORY_WATCH,
    async (event, workspaceSlug: string): Promise<void> => {
      stopWorkspaceMemoryWatch(event.sender.id, workspaceSlug)
    },
  )

  // 发送 Agent 消息（触发 Agent SDK 流式响应）
  ipcMain.handle(
    AGENT_IPC_CHANNELS.APPROVE_WORKSPACE_PROJECT_KNOWLEDGE_MAINTENANCE,
    async (_, workspaceSlug: string): Promise<void> => {
      approveWorkspaceProjectKnowledgeMaintenance(workspaceSlug)
    },
  )

  registerAgentMessageIpcHandlers({
    ipc: ipcMain,
    requireVisibleSession,
    prepareRun: prepareAgentRun,
    reserveStart: reserveAgentSessionStart,
    startSessionMirrorRun: (session) => feishuBridgeManager.startSessionMirrorRun(session),
    runPrepared: runPreparedAgent,
    queueMessage: queueAgentMessage,
    submitOrEnqueue: submitOrEnqueueAgentMessage,
  })

  // renderer 的当前 Agent Tab 决定 partial 消息是前台 20fps 还是后台 4fps。
  ipcMain.handle(
    AGENT_IPC_CHANNELS.SET_VISIBLE_STREAM_SESSION,
    async (event, sessionId: string | null): Promise<void> => {
      if (sessionId !== null && (typeof sessionId !== 'string' || sessionId.length === 0)) {
        throw new Error('可见 Agent 会话 ID 非法')
      }
      if (sessionId !== null) requireVisibleSession(sessionId)
      setVisibleAgentSession(event.sender, sessionId)
    },
  )

  // 中止 Agent 执行
  ipcMain.handle(
    AGENT_IPC_CHANNELS.STOP_AGENT,
    async (_, sessionId: string): Promise<void> => {
      requireVisibleSession(sessionId)
      feishuBridgeManager.stopSessionMirrorRun(sessionId)
      stopAgent(sessionId)
    }
  )

  // ===== Agent 队列消息 =====

  // 兼容旧调用：将消息交给主进程 deferred queue。
  ipcMain.handle(
    AGENT_IPC_CHANNELS.ENQUEUE_QUEUED_MESSAGE,
    async (event, input: import('@proma/shared').AgentDeferredQueueMessageInput): Promise<void> => {
      requireVisibleSession(input.sessionId)
      enqueueAgentQueuedMessage(input, event.sender)
    },
  )

  ipcMain.handle(
    AGENT_IPC_CHANNELS.CANCEL_QUEUED_MESSAGE,
    async (_, input: import('@proma/shared').AgentQueuedMessageControlInput): Promise<boolean> => {
      requireVisibleSession(input.sessionId)
      return cancelAgentQueuedMessage(input)
    },
  )

  ipcMain.handle(
    AGENT_IPC_CHANNELS.MOVE_QUEUED_MESSAGE,
    async (_, input: import('@proma/shared').AgentMoveQueuedMessageInput): Promise<boolean> => {
      requireVisibleSession(input.sessionId)
      return moveAgentQueuedMessage(input)
    },
  )

  // ===== Agent 权限系统 =====

  // 响应权限请求
  ipcMain.handle(
    AGENT_IPC_CHANNELS.PERMISSION_RESPOND,
    async (event, response: PermissionResponse): Promise<void> => {
      const { requestId, behavior, alwaysAllow } = response
      const ownerSessionId = permissionService.getPendingRequestOwner(requestId)
      requireVisibleSession(ownerSessionId ?? '')
      const sessionId = permissionService.respondToPermission(requestId, behavior, alwaysAllow)

      // 发送 permission_resolved 事件给渲染进程
      if (sessionId) {
        event.sender.send(AGENT_IPC_CHANNELS.STREAM_EVENT, {
          sessionId,
          payload: { kind: 'proma_event', event: { type: 'permission_resolved', requestId, behavior } },
        })
      }
    }
  )

  // 热切换指定会话的权限模式（运行中生效，不广播）
  ipcMain.handle(
    AGENT_IPC_CHANNELS.UPDATE_SESSION_PERMISSION_MODE,
    async (_, sessionId: string, mode: PromaPermissionMode): Promise<void> => {
      if (!isPromaPermissionMode(mode)) {
        throw new Error(`无效的权限模式: ${mode}`)
      }
      // 会话不存在时直接抛错（避免 updateAgentSessionMeta 的通用异常被降级为 warn）
      requireVisibleSession(sessionId)
      // 持久化到 session meta（重启后可恢复，即使 session 未运行也要写）。
      // 这里的 catch 仅用于兜底磁盘 I/O 类异常，不影响后续热切换。
      try {
        updateAgentSessionMeta(sessionId, { permissionMode: mode })
      } catch (err) {
        console.warn(`[IPC] 持久化 session 权限模式失败: sessionId=${sessionId}`, err)
      }
      // 若 session 正在跑，同步热切换运行时模式
      if (isAgentSessionActive(sessionId)) {
        await updateAgentPermissionMode(sessionId, mode).catch((err) => {
          console.warn(`[IPC] 运行中权限模式切换失败: sessionId=${sessionId}`, err)
          throw err
        })
      }
    }
  )

  // 切换指定会话的 Agent runtime（空闲后下一轮生效）
  ipcMain.handle(
    AGENT_IPC_CHANNELS.UPDATE_SESSION_CODEX_FAST_MODE,
    async (_, sessionId: string, enabled: boolean): Promise<AgentSessionMeta> => {
      if (typeof enabled !== 'boolean') {
        throw new Error(`无效的 Codex Fast Mode 状态: ${String(enabled)}`)
      }
      requireVisibleSession(sessionId)
      if (isAgentSessionActive(sessionId)) {
        throw new Error('Agent 正在运行，完成后再切换快速模式')
      }
      return updateAgentSessionMeta(sessionId, { codexFastMode: enabled })
    }
  )

  ipcMain.handle(
    AGENT_IPC_CHANNELS.GET_PI_REASONING_CAPABILITY,
    async (_, channelId: string, modelId: string) => {
      if (!channelId || !modelId) return undefined
      const channel = getChannelById(channelId)
      if (!channel) return undefined
      return resolvePiReasoningCapability(channel.provider, modelId)
    }
  )

  ipcMain.handle(
    AGENT_IPC_CHANNELS.UPDATE_SESSION_REASONING_LEVEL,
    async (_, sessionId: string, thinkingLevel: AgentThinkingLevel): Promise<AgentSessionMeta> => {
      const validThinkingLevels: AgentThinkingLevel[] = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']
      if (!validThinkingLevels.includes(thinkingLevel)) {
        throw new Error(`无效的 Codex 思考深度: ${String(thinkingLevel)}`)
      }
      requireVisibleSession(sessionId)
      // 当前运行已在启动时读取推理深度；此处只更新会话的下一轮配置。
      return updateAgentSessionMeta(sessionId, { reasoningLevel: thinkingLevel })
    }
  )



  // ===== Chat 工具管理 =====

  // 获取所有工具信息
  ipcMain.handle(
    CHAT_TOOL_IPC_CHANNELS.GET_ALL_TOOLS,
    async (): Promise<ChatToolInfo[]> => {
      return getAllToolInfos()
    }
  )

  // 获取工具凭据
  ipcMain.handle(
    CHAT_TOOL_IPC_CHANNELS.GET_TOOL_CREDENTIALS,
    async (_, toolId: string): Promise<Record<string, string>> => {
      return getToolCredentials(toolId)
    }
  )

  // 更新工具开关状态
  ipcMain.handle(
    CHAT_TOOL_IPC_CHANNELS.UPDATE_TOOL_STATE,
    async (_, toolId: string, state: ChatToolState): Promise<void> => {
      updateToolState(toolId, state)
    }
  )

  // 更新工具凭据
  ipcMain.handle(
    CHAT_TOOL_IPC_CHANNELS.UPDATE_TOOL_CREDENTIALS,
    async (_, toolId: string, credentials: Record<string, string>): Promise<void> => {
      await updateToolCredentialsWithImageModelBroadcast({
        toolId,
        credentials,
        updateCredentials: (currentToolId, currentCredentials) => {
          updateToolCredentials(currentToolId, currentCredentials)
        },
        listTargets: () => BrowserWindow.getAllWindows().map((window) => window.webContents),
      })
    }
  )

  // 创建自定义工具
  ipcMain.handle(
    CHAT_TOOL_IPC_CHANNELS.CREATE_CUSTOM_TOOL,
    async (_, meta: ChatToolMeta): Promise<void> => {
      addCustomTool(meta)
    }
  )

  // 删除自定义工具
  ipcMain.handle(
    CHAT_TOOL_IPC_CHANNELS.DELETE_CUSTOM_TOOL,
    async (_, toolId: string): Promise<void> => {
      deleteCustomTool(toolId)
    }
  )

  // 测试工具连接
  ipcMain.handle(
    CHAT_TOOL_IPC_CHANNELS.TEST_TOOL,
    async (_, toolId: string): Promise<{ success: boolean; message: string }> => {
      // 联网搜索工具测试
      if (toolId === 'web-search') {
        const { getToolCredentials: getCredentials } = await import('./lib/chat-tool-config')
        const credentials = getCredentials('web-search')
        if (!credentials.apiKey) {
          return { success: false, message: '请先填写 Tavily API Key' }
        }
        try {
          const response = await getFetchFn(await getEffectiveProxyUrl())('https://api.tavily.com/search', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${credentials.apiKey}`,
            },
            body: JSON.stringify({
              query: 'test connection',
              search_depth: 'basic',
              max_results: 1,
            }),
          })
          if (!response.ok) {
            const errorText = await response.text()
            return { success: false, message: `API 请求失败 (${response.status}): ${errorText}` }
          }
          return { success: true, message: '连接成功，Tavily 搜索 API 可用' }
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error)
          return { success: false, message: `连接失败: ${msg}` }
        }
      }
      // Nano Banana 生图工具测试
      if (toolId === 'nano-banana') {
        const { getToolCredentials: getCredentials } = await import('./lib/chat-tool-config')
        const credentials = getCredentials('nano-banana')
        if (!credentials.apiKey) {
          return { success: false, message: '请先填写 Gemini API Key' }
        }
        try {
          const baseUrl = credentials.baseUrl?.trim() || 'https://generativelanguage.googleapis.com'
          const model = credentials.model?.trim() || 'gemini-3.1-flash-image-preview'
          const url = `${baseUrl}/v1beta/models/${model}:generateContent?key=${credentials.apiKey}`
          const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              contents: [{ role: 'user', parts: [{ text: 'Hi' }] }],
              generationConfig: { maxOutputTokens: 10 },
            }),
          })
          if (!response.ok) {
            const errorText = await response.text()
            return { success: false, message: `API 请求失败 (${response.status}): ${errorText.slice(0, 200)}` }
          }
          return { success: true, message: `连接成功，模型 ${model} 可用` }
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error)
          return { success: false, message: `连接失败: ${msg}` }
        }
      }
      return { success: false, message: `工具 ${toolId} 不支持测试` }
    }
  )

  // ===== AskUserQuestion 交互式问答 =====

  // 响应 AskUser 请求
  ipcMain.handle(
    AGENT_IPC_CHANNELS.ASK_USER_RESPOND,
    async (event, response: AskUserResponse): Promise<void> => {
      const { requestId, answers } = response
      const ownerSessionId = askUserService.getPendingRequestOwner(requestId)
      requireVisibleSession(ownerSessionId ?? '')
      const sessionId = askUserService.respondToAskUser(requestId, answers)

      if (sessionId) {
        event.sender.send(AGENT_IPC_CHANNELS.STREAM_EVENT, {
          sessionId,
          payload: { kind: 'proma_event', event: { type: 'ask_user_resolved', requestId } },
        })
      }
    }
  )

  // ===== ExitPlanMode 计划审批 =====

  // 响应 ExitPlanMode 请求
  ipcMain.handle(
    AGENT_IPC_CHANNELS.EXIT_PLAN_MODE_RESPOND,
    async (event, response: ExitPlanModeResponse): Promise<void> => {
      const ownerSessionId = exitPlanService.getPendingRequestOwner(response.requestId)
      requireVisibleSession(ownerSessionId ?? '')
      const result = exitPlanService.respondToExitPlanMode(response)

      if (result) {
        const { sessionId, targetMode } = result

        // 通知渲染进程请求已处理
        event.sender.send(AGENT_IPC_CHANNELS.STREAM_EVENT, {
          sessionId,
          payload: { kind: 'proma_event', event: { type: 'exit_plan_mode_resolved', requestId: response.requestId } },
        })

        // 如果用户选择了新的权限模式，通知渲染进程更新 UI
        if (targetMode) {
          const meta = getAgentSessionMeta(sessionId)
          // 持久化到 session meta，和 cycleMode 路径保持一致（重启后该 session 能恢复）
          if (meta) {
            try {
              updateAgentSessionMeta(sessionId, { permissionMode: targetMode })
            } catch (err) {
              console.warn(`[IPC] ExitPlanMode 持久化 session 权限模式失败: sessionId=${sessionId}`, err)
            }
          }
          event.sender.send(AGENT_IPC_CHANNELS.STREAM_EVENT, {
            sessionId,
            payload: { kind: 'proma_event', event: { type: 'permission_mode_changed', mode: targetMode } },
          })
          console.log(`[IPC] ExitPlanMode 权限模式切换: ${targetMode}`)
        }
      }
    }
  )

  // ===== 待处理请求恢复 =====

  // 获取所有待处理的交互请求快照（渲染进程重载后恢复状态）
  ipcMain.handle(
    AGENT_IPC_CHANNELS.GET_PENDING_REQUESTS,
    async (): Promise<import('@proma/shared').PendingRequestsSnapshot> => {
      const visibleSessionIds = createVisibleSessionIdSet()
      return {
        permissions: getUserVisiblePendingRequests(permissionService.getPendingRequests(), visibleSessionIds),
        askUsers: getUserVisiblePendingRequests(askUserService.getPendingRequests(), visibleSessionIds),
        exitPlans: getUserVisiblePendingRequests(exitPlanService.getPendingRequests(), visibleSessionIds),
      }
    }
  )

  // ===== Agent 附件 =====

  // 保存文件到 Agent session 工作目录
  ipcMain.handle(
    AGENT_IPC_CHANNELS.SAVE_FILES_TO_SESSION,
    async (_, input: AgentSaveFilesInput): Promise<AgentSavedFile[]> => {
      requireVisibleSession(input.sessionId)
      return saveFilesToAgentSession(input)
    }
  )

  // 保存文件到工作区文件目录
  ipcMain.handle(
    AGENT_IPC_CHANNELS.SAVE_FILES_TO_WORKSPACE,
    async (_, input: AgentSaveWorkspaceFilesInput): Promise<AgentSavedFile[]> => {
      return saveFilesToWorkspaceFiles(input)
    }
  )

  // 获取工作区文件目录路径
  ipcMain.handle(
    AGENT_IPC_CHANNELS.GET_WORKSPACE_FILES_PATH,
    async (_, workspaceSlug: string): Promise<string> => {
      return getProjectFilesPath(workspaceSlug)
    }
  )

  // 打开文件夹选择对话框
  ipcMain.handle(
    AGENT_IPC_CHANNELS.OPEN_FOLDER_DIALOG,
    async (): Promise<{ path: string; name: string } | null> => {
      const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
      if (!win) return null

      const result = await dialog.showOpenDialog(win, {
        properties: ['openDirectory'],
        title: '选择文件夹',
      })

      if (result.canceled || result.filePaths.length === 0) return null

      const folderPath = result.filePaths[0]!
      const name = basename(folderPath) || 'folder'
      return { path: folderPath, name }
    }
  )

  // 打开支持文件与文件夹混合选择的 Composer 对话框
  ipcMain.handle(
    AGENT_IPC_CHANNELS.OPEN_FILE_OR_FOLDER_DIALOG,
    async (): Promise<FileOrFolderDialogResult> => {
      return openFileOrFolderDialog()
    }
  )

  // 附加外部目录到 Agent 会话
  ipcMain.handle(
    AGENT_IPC_CHANNELS.ATTACH_DIRECTORY,
    async (_, input: AgentAttachDirectoryInput): Promise<string[]> => {
      requireVisibleSession(input.sessionId)
      return workspaceOperationGuard.runSessionWrite(input.sessionId, () => {
        const meta = getAgentSessionMeta(input.sessionId)
        if (!meta) throw new Error(`会话不存在: ${input.sessionId}`)

        const existing = meta.attachedDirectories ?? []
        if (existing.includes(input.directoryPath)) return existing

        const updated = [...existing, input.directoryPath]
        updateAgentSessionMeta(input.sessionId, { attachedDirectories: updated })
        // 启动附加目录文件监听
        watchAttachedDirectory(input.directoryPath)
        return updated
      })
    }
  )

  // 移除会话的附加目录
  ipcMain.handle(
    AGENT_IPC_CHANNELS.DETACH_DIRECTORY,
    async (_, input: AgentAttachDirectoryInput): Promise<string[]> => {
      requireVisibleSession(input.sessionId)
      return workspaceOperationGuard.runSessionWrite(input.sessionId, () => {
        const meta = getAgentSessionMeta(input.sessionId)
        if (!meta) throw new Error(`会话不存在: ${input.sessionId}`)

        const existing = meta.attachedDirectories ?? []
        const updated = existing.filter((d) => d !== input.directoryPath)
        updateAgentSessionMeta(input.sessionId, { attachedDirectories: updated })
        releaseDirectoryWatcherIfUnreferenced(input.directoryPath)
        return updated
      })
    }
  )

  // 附加外部文件到 Agent 会话
  ipcMain.handle(
    AGENT_IPC_CHANNELS.ATTACH_FILE,
    async (_, input: AgentAttachFileInput): Promise<string[]> => {
      requireVisibleSession(input.sessionId)
      return workspaceOperationGuard.runSessionWrite(input.sessionId, () => {
        const meta = getAgentSessionMeta(input.sessionId)
        if (!meta) throw new Error(`会话不存在: ${input.sessionId}`)

        const safePath = realpathSync(resolve(input.filePath))
        const stats = statSync(safePath)
        if (!stats.isFile()) throw new Error('只能附加文件')

        const existing = meta.attachedFiles ?? []
        if (existing.includes(safePath)) return existing

        const updated = [...existing, safePath]
        updateAgentSessionMeta(input.sessionId, { attachedFiles: updated })
        watchAttachedDirectory(dirname(safePath))
        return updated
      })
    }
  )

  // 移除会话的附加文件
  ipcMain.handle(
    AGENT_IPC_CHANNELS.DETACH_FILE,
    async (_, input: AgentAttachFileInput): Promise<string[]> => {
      requireVisibleSession(input.sessionId)
      return workspaceOperationGuard.runSessionWrite(input.sessionId, () => {
        const meta = getAgentSessionMeta(input.sessionId)
        if (!meta) throw new Error(`会话不存在: ${input.sessionId}`)

        const existing = meta.attachedFiles ?? []
        const updated = existing.filter((f) => f !== input.filePath)
        updateAgentSessionMeta(input.sessionId, { attachedFiles: updated })
        releaseDirectoryWatcherIfUnreferenced(dirname(input.filePath))
        return updated
      })
    }
  )

  // 附加外部目录到工作区（所有会话可访问）
  ipcMain.handle(
    AGENT_IPC_CHANNELS.ATTACH_WORKSPACE_DIRECTORY,
    async (_, input: WorkspaceAttachDirectoryInput): Promise<string[]> => {
      return workspaceOperationGuard.runWorkspaceSlugWrite(input.workspaceSlug, () => {
        const updated = attachWorkspaceDirectory(input.workspaceSlug, input.directoryPath)
        watchAttachedDirectory(input.directoryPath)
        return updated
      })
    }
  )

  // 移除工作区的附加目录
  ipcMain.handle(
    AGENT_IPC_CHANNELS.DETACH_WORKSPACE_DIRECTORY,
    async (_, input: WorkspaceAttachDirectoryInput): Promise<string[]> => {
      return workspaceOperationGuard.runWorkspaceSlugWrite(input.workspaceSlug, () => {
        const updated = detachWorkspaceDirectory(input.workspaceSlug, input.directoryPath)
        releaseDirectoryWatcherIfUnreferenced(input.directoryPath)
        return updated
      })
    }
  )

  // 附加外部文件到工作区（所有会话可访问）
  ipcMain.handle(
    AGENT_IPC_CHANNELS.ATTACH_WORKSPACE_FILE,
    async (_, input: WorkspaceAttachFileInput): Promise<string[]> => {
      return workspaceOperationGuard.runWorkspaceSlugWrite(input.workspaceSlug, () => {
        const safePath = realpathSync(resolve(input.filePath))
        const stats = statSync(safePath)
        if (!stats.isFile()) throw new Error('只能附加文件')

        const updated = attachWorkspaceFile(input.workspaceSlug, safePath)
        watchAttachedDirectory(dirname(safePath))
        return updated
      })
    }
  )

  // 移除工作区的附加文件
  ipcMain.handle(
    AGENT_IPC_CHANNELS.DETACH_WORKSPACE_FILE,
    async (_, input: WorkspaceAttachFileInput): Promise<string[]> => {
      return workspaceOperationGuard.runWorkspaceSlugWrite(input.workspaceSlug, () => {
        const updated = detachWorkspaceFile(input.workspaceSlug, input.filePath)
        releaseDirectoryWatcherIfUnreferenced(dirname(input.filePath))
        return updated
      })
    }
  )

  // 获取工作区附加目录列表
  ipcMain.handle(
    AGENT_IPC_CHANNELS.GET_WORKSPACE_DIRECTORIES,
    async (_, workspaceSlug: string): Promise<string[]> => {
      return getWorkspaceAttachedDirectories(workspaceSlug)
    }
  )

  // 获取工作区附加文件列表
  ipcMain.handle(
    AGENT_IPC_CHANNELS.GET_WORKSPACE_ATTACHED_FILES,
    async (_, workspaceSlug: string): Promise<string[]> => {
      return getWorkspaceAttachedFiles(workspaceSlug)
    }
  )

  // ===== Worktree 仓库配置管理 =====

  ipcMain.handle(
    AGENT_IPC_CHANNELS.GET_WORKTREE_REPOS,
    async (_, workspaceSlug: string) => {
      return await getWorktreeRepos(workspaceSlug)
    }
  )

  ipcMain.handle(
    AGENT_IPC_CHANNELS.ADD_WORKTREE_REPO,
    async (_, workspaceSlug: string, repo: import('@proma/shared').WorkspaceWorktreeRepo) => {
      return addWorktreeRepo(workspaceSlug, repo)
    }
  )

  ipcMain.handle(
    AGENT_IPC_CHANNELS.REMOVE_WORKTREE_REPO,
    async (_, workspaceSlug: string, repoPath: string) => {
      return removeWorktreeRepo(workspaceSlug, repoPath)
    }
  )

  // ===== Agent 文件系统操作 =====

  // 获取 session 工作路径
  ipcMain.handle(
    AGENT_IPC_CHANNELS.GET_SESSION_PATH,
    async (_, workspaceId: string, sessionId: string): Promise<string | null> => {
      const session = requireVisibleSession(sessionId)
      if (!session.workspaceId || session.workspaceId !== workspaceId) return null
      const ws = getAgentWorkspace(session.workspaceId)
      if (!ws) return null
      return getAgentSessionWorkspacePath(ws.slug, sessionId)
    }
  )

  // 列出目录内容（浅层，安全校验）
  ipcMain.handle(
    AGENT_IPC_CHANNELS.LIST_DIRECTORY,
    async (_, dirPath: string, access?: FileAccessOptions): Promise<FileEntry[]> => {
      const accessSnapshot = requireVisibleFileAccess(access, [dirPath])
      const safePath = resolve(dirPath)
      return listStableDirectory(safePath, accessSnapshot)
    }
  )

  // 删除文件或目录
  ipcMain.handle(
    AGENT_IPC_CHANNELS.DELETE_FILE,
    async (_, filePath: string, access?: FileAccessOptions): Promise<void> => {
      requireVisibleFileAccess(access)
      throw new Error(RENDERER_FILE_MUTATION_DISABLED_MESSAGE)
    }
  )

  // 用系统默认应用打开文件
  ipcMain.handle(
    AGENT_IPC_CHANNELS.OPEN_FILE,
    async (_, filePath: string, access?: FileAccessOptions): Promise<void> => {
      const accessSnapshot = requireVisibleFileAccess(access, [filePath])

      const safePath = resolve(filePath)
      if (!isPathAllowed(safePath, accessSnapshot.options, accessSnapshot)) {
        throw new Error('访问路径超出当前会话的授权范围')
      }

      await shell.openPath(safePath)
    }
  )

  // 将剪贴板文本写入临时预览文件
  ipcMain.handle(
    AGENT_IPC_CHANNELS.WRITE_CLIPBOARD_PREVIEW,
    async (_, filename: string, content: string): Promise<string> => {
      if (typeof filename !== 'string' || !filename) {
        throw new Error('filename 必须是非空字符串')
      }
      if (typeof content !== 'string') {
        throw new Error('content 必须是字符串')
      }

      const { isAbsolute, join, relative, resolve } = await import('node:path')
      const { tmpdir } = await import('node:os')
      const { existsSync, mkdirSync } = await import('node:fs')
      const { writeFile } = await import('node:fs/promises')

      const tmpDir = join(tmpdir(), 'proma-preview')
      if (!existsSync(tmpDir)) {
        mkdirSync(tmpDir, { recursive: true })
      }

      // 安全文件名：替换路径分隔符和特殊字符，防止目录穿越
      const safeFilename = filename.replace(/[<>:"/\\|?*]/g, '_').replace(/^\.+/, '_')
      const tmpPath = resolve(tmpDir, safeFilename)

      // 确保 resolve 后的路径仍在 tmpDir 内，兼容 Windows 路径分隔符
      const relativePath = relative(tmpDir, tmpPath)
      if (!relativePath || relativePath.startsWith('..') || isAbsolute(relativePath)) {
        throw new Error('文件名越界')
      }

      await writeFile(tmpPath, content, 'utf-8')
      console.log(`[IPC] clipboard 预览文件已写入: ${tmpPath}`)
      return tmpPath
    }
  )

  // 在系统文件管理器中显示文件
  ipcMain.handle(
    AGENT_IPC_CHANNELS.SHOW_IN_FOLDER,
    async (_, filePath: string, access?: FileAccessOptions): Promise<void> => {
      const accessSnapshot = requireVisibleFileAccess(access, [filePath])

      const safePath = resolve(filePath)
      if (!isPathAllowed(safePath, accessSnapshot.options, accessSnapshot)) {
        throw new Error('访问路径超出当前会话的授权范围')
      }

      shell.showItemInFolder(safePath)
    }
  )

  // 使用 macOS 系统 Terminal 在指定工作目录打开会话/工作区文件夹
  ipcMain.handle(
    AGENT_IPC_CHANNELS.OPEN_FOLDER_IN_TERMINAL,
    async (_, folderPath: string, access?: FileAccessOptions): Promise<void> => {
      const accessSnapshot = requireVisibleFileAccess(access, [folderPath])
      if (process.platform !== 'darwin') {
        throw new Error('当前仅支持在 macOS 终端中打开文件夹')
      }
      if (!isPathAllowed(folderPath, accessSnapshot.options, accessSnapshot)) {
        throw new Error('访问路径超出当前会话的授权范围')
      }

      const safePath = realpathSync(resolve(folderPath))
      if (!statSync(safePath).isDirectory()) {
        throw new Error('只能在终端中打开文件夹')
      }

      const { spawn } = await import('node:child_process')
      await new Promise<void>((resolvePromise, reject) => {
        const child = spawn('open', ['-a', 'Terminal', safePath], { detached: true, stdio: 'ignore' })
        child.once('error', reject)
        child.once('spawn', () => {
          child.unref()
          resolvePromise()
        })
      })
    }
  )

  // 在系统文件管理器中显示当前会话或工作区已授权的路径
  ipcMain.handle(
    IPC_CHANNELS.SHOW_ITEM_IN_FOLDER,
    async (_, filePath: string, access?: FileAccessOptions): Promise<boolean> => {
      const accessSnapshot = requireVisibleFileAccess(access, [filePath])
      const { resolve } = await import('node:path')
      const { existsSync } = await import('node:fs')
      const { resolveTargetPath } = await import('./lib/file-preview-service')

      const candidateBasePaths = getPreviewCandidateBasePaths(accessSnapshot.options, accessSnapshot)
      const resolvedPath = resolveTargetPath(filePath, candidateBasePaths?.length ? candidateBasePaths : undefined)
      if (!existsSync(resolvedPath) || !isPathAllowed(resolvedPath, accessSnapshot.options, accessSnapshot)) {
        console.warn('[IPC] shell:show-item-in-folder 路径不存在:', resolvedPath)
        return false
      }
      shell.showItemInFolder(resolve(resolvedPath))
      return true
    }
  )

  // 解析文件路径并读取内容（供内联预览使用）
  ipcMain.handle(
    'file:resolve-and-read',
    async (_, filePath: string, access?: FileAccessOptions | string[]): Promise<import('@proma/shared').FilePreviewReadResult | null> => {
      const maxSize = 5 * 1024 * 1024
      const accessSnapshot = requireVisibleFileReadAccess(access, filePath, undefined, maxSize)
      const authorizedFile = accessSnapshot.authorizedFiles.get(filePath)
      if (!authorizedFile) return null
      const metadata = {
        name: basename(authorizedFile.canonicalPath),
        extension: extname(authorizedFile.canonicalPath).toLowerCase(),
        size: authorizedFile.byteSize,
        modifiedAt: authorizedFile.modifiedAt,
      }
      try {
        if (authorizedFile.byteSize > maxSize) {
          return { resolvedPath: authorizedFile.canonicalPath, content: '', isBinary: false, isTooLarge: true, metadata }
        }
        const rawContent = authorizedFile.readBytes()
        const content = decodeStablePreviewText(rawContent)
        return content === null
          ? { resolvedPath: authorizedFile.canonicalPath, content: '', isBinary: true, isTooLarge: false, metadata }
          : { resolvedPath: authorizedFile.canonicalPath, content, isBinary: false, isTooLarge: false, metadata }
      } catch (error) {
        if (error instanceof Error && error.message === '文件过大') {
          return { resolvedPath: authorizedFile.canonicalPath, content: '', isBinary: false, isTooLarge: true, metadata }
        }
        throw error
      } finally {
        authorizedFile.close()
      }
    }
  )

  // 写入文本文件（供 Markdown 内联编辑使用）
  ipcMain.handle(
    'file:write-text',
    async (_, filePath: string, content: string, access?: FileAccessOptions | string[]): Promise<boolean> => {
      if (typeof content !== 'string') return false
      const accessSnapshot = requireVisibleFileWriteAccess(access, filePath)
      const authorizedFile = accessSnapshot.authorizedFiles.get(filePath)
      if (!authorizedFile) return false
      try {
        authorizedFile.writeText(content)
        return true
      } finally {
        authorizedFile.close()
      }
    }
  )

  // 仅解析文件路径（供 PDF/图片等用 proma-file:// 加载）
  ipcMain.handle(
    'file:resolve-path',
    async (_, filePath: string, access?: FileAccessOptions | string[]): Promise<ResolvedFileUrl | null> => {
      const accessSnapshot = requireVisibleFileReadAccess(access, filePath, undefined, 100 * 1024 * 1024)
      const authorizedFile = accessSnapshot.authorizedFiles.get(filePath)
      if (!authorizedFile) return null
      try {
        const content = authorizedFile.readBytes()
        return { url: registerPromaAuthorizedFile(authorizedFile.canonicalPath, content) }
      } catch (err) {
        console.warn('[IPC] file:resolve-path 无法注册稳定文件，跳过:', err instanceof Error ? err.message : err)
        return null
      } finally {
        authorizedFile.close()
      }
    }
  )

  // HTML 相对资源需要目录级路径能力，当前无法绑定稳定目录对象，因此明确 fail closed。
  ipcMain.handle(
    'file:resolve-html-preview-path',
    async (): Promise<ResolvedFileUrl | null> => {
      throw new Error('HTML 目录预览已禁用：无法安全绑定相对资源目录')
    }
  )

  // 为内联 PDF 预览生成临时 HTML 文件，返回文件路径
  ipcMain.handle(
    'file:prepare-pdf-preview',
    async (_, filePath: string, access?: FileAccessOptions | string[]): Promise<{ tmpHtmlUrl: string } | null> => {
      const accessSnapshot = requireVisibleFileReadAccess(access, filePath, undefined, 50 * 1024 * 1024)
      const authorizedFile = accessSnapshot.authorizedFiles.get(filePath)
      if (!authorizedFile) return null
      let stableContent: Buffer
      try {
        stableContent = authorizedFile.readBytes()
      } finally {
        authorizedFile.close()
      }
      const { preparePdfPreview } = await import('./lib/file-preview-service')
      const result = await preparePdfPreview(authorizedFile.canonicalPath, undefined, stableContent)
      return result ? { tmpHtmlUrl: result.tmpHtmlUrl } : null
    }
  )

  // DOCX 转 HTML（内联预览使用 mammoth）
  ipcMain.handle(
    'file:docx-to-html',
    async (_, filePath: string, access?: FileAccessOptions | string[]): Promise<{ resolvedPath: string; html: string } | null> => {
      const accessSnapshot = requireVisibleFileReadAccess(access, filePath, undefined, 50 * 1024 * 1024)
      const authorizedFile = accessSnapshot.authorizedFiles.get(filePath)
      if (!authorizedFile) return null
      let stableContent: Buffer
      try {
        stableContent = authorizedFile.readBytes()
      } finally {
        authorizedFile.close()
      }
      const { convertDocxToHtml } = await import('./lib/file-preview-service')
      const result = await convertDocxToHtml(authorizedFile.canonicalPath, undefined, stableContent)
      return result
    }
  )

  // Office 文件转高保真 HTML（内联预览；失败时由服务层降级到内置解析器）
  ipcMain.handle(
    'file:office-to-html',
    async (_, filePath: string, access?: FileAccessOptions | string[]): Promise<import('@proma/shared').OfficePreviewResult | null> => {
      const accessSnapshot = requireVisibleFileReadAccess(access, filePath, undefined, 50 * 1024 * 1024)
      const authorizedFile = accessSnapshot.authorizedFiles.get(filePath)
      if (!authorizedFile) return null
      let stableContent: Buffer
      try {
        stableContent = authorizedFile.readBytes()
      } finally {
        authorizedFile.close()
      }
      const { convertOfficeToHtml } = await import('./lib/file-preview-service')
      return convertOfficeToHtml(authorizedFile.canonicalPath, undefined, stableContent)
    }
  )

  // 读取文件为 base64（供内联图片预览等使用）
  ipcMain.handle(
    'file:read-binary-base64',
    async (_, filePath: string, access?: FileAccessOptions | string[], maxSize?: number): Promise<string | null> => {
      // 该接口会把原始文件内容送回 renderer，只允许读取已授权路径；不能接受
      // 预览场景使用的 unrestricted 标志，避免 renderer 借此读取任意本地文件。
      const options = normalizeFileAccessOptions(access)
      const restrictedOptions = options?.unrestricted ? { ...options, unrestricted: false } : options
      const requestedMaxSize = typeof maxSize === 'number' && Number.isFinite(maxSize) && maxSize > 0
        ? maxSize
        : MAX_ATTACHMENT_SIZE
      const effectiveMaxSize = Math.min(requestedMaxSize, MAX_ATTACHMENT_SIZE)
      try {
        const accessSnapshot = requireVisibleFileReadAccess(restrictedOptions, filePath, undefined, effectiveMaxSize)
        const authorizedFile = accessSnapshot.authorizedFiles.get(filePath)
        if (!authorizedFile) return null
        try {
          return authorizedFile.readBytes().toString('base64')
        } finally {
          authorizedFile.close()
        }
      } catch (error) {
        if (error instanceof Error && error.message === '文件过大') return null
        throw error
      }
    }
  )

  // 重命名文件/目录
  ipcMain.handle(
    AGENT_IPC_CHANNELS.RENAME_FILE,
    async (_, filePath: string, newName: string, access?: FileAccessOptions): Promise<void> => {
      requireVisibleFileAccess(access)
      throw new Error(RENDERER_FILE_MUTATION_DISABLED_MESSAGE)
    }
  )

  // 移动文件/目录到目标目录
  ipcMain.handle(
    AGENT_IPC_CHANNELS.MOVE_FILE,
    async (_, filePath: string, targetDir: string, access?: FileAccessOptions): Promise<void> => {
      requireVisibleFileAccess(access)
      throw new Error(RENDERER_FILE_MUTATION_DISABLED_MESSAGE)
    }
  )

  // 列出附加目录内容
  ipcMain.handle(
    AGENT_IPC_CHANNELS.LIST_ATTACHED_DIRECTORY,
    async (_, dirPath: string, access?: FileAccessOptions | string[]): Promise<FileEntry[]> => {
      const accessSnapshot = requireVisibleFileAccess(access, [dirPath])
      const safePath = resolve(dirPath)
      const options = accessSnapshot.options
      if (!isPathAllowed(safePath, options, accessSnapshot)) {
        // 已解绑或被删除的附加目录不应让文件面板持续报错。
        if (!existsSync(safePath)) return []
        throw new Error('访问路径不在允许范围内')
      }

      return listShallowDirectory(safePath)
    }
  )

  // 读取附加目录文件内容为 base64（限制在已附加目录范围内，用于侧面板添加到聊天）
  ipcMain.handle(
    AGENT_IPC_CHANNELS.READ_ATTACHED_FILE,
    async (_, filePath: string, sessionId?: string, workspaceSlug?: string): Promise<string> => {
      if (!filePath || typeof filePath !== 'string') {
        throw new Error('无效的文件路径')
      }
      const MAX_FILE_SIZE = 20 * 1024 * 1024 // 20 MB
      const access: FileAccessOptions = { workspaceSlug }
      if (sessionId !== undefined) access.sessionId = sessionId
      const accessSnapshot = requireVisibleFileReadAccess(access, filePath, undefined, MAX_FILE_SIZE)
      const authorizedFile = accessSnapshot.authorizedFiles.get(filePath)
      if (!authorizedFile) throw new Error(`文件不存在: ${filePath}`)
      try {
        return authorizedFile.readBytes().toString('base64')
      } catch (error) {
        if (error instanceof Error && error.message === '文件过大') throw new Error('文件过大，最大支持 20MB')
        throw error
      } finally {
        authorizedFile.close()
      }
    }
  )

  // 在文件管理器中显示附加目录文件
  ipcMain.handle(
    AGENT_IPC_CHANNELS.SHOW_ATTACHED_IN_FOLDER,
    async (_, filePath: string, access?: FileAccessOptions | string[]): Promise<void> => {
      const accessSnapshot = requireVisibleFileAccess(access, [filePath])
      const safePath = resolve(filePath)
      const options = accessSnapshot.options
      if (!isPathAllowed(safePath, options, accessSnapshot)) {
        console.warn('[IPC] show-attached-in-folder 拒绝越界路径:', safePath)
        return
      }
      shell.showItemInFolder(safePath)
    }
  )

  // 重命名附加目录文件/目录
  ipcMain.handle(
    AGENT_IPC_CHANNELS.RENAME_ATTACHED_FILE,
    async (_, filePath: string, newName: string, access?: FileAccessOptions | string[]): Promise<void> => {
      requireVisibleFileAccess(access)
      throw new Error(RENDERER_FILE_MUTATION_DISABLED_MESSAGE)
    }
  )

  // 移动附加目录文件/目录
  ipcMain.handle(
    AGENT_IPC_CHANNELS.MOVE_ATTACHED_FILE,
    async (_, filePath: string, targetDir: string, access?: FileAccessOptions | string[]): Promise<void> => {
      requireVisibleFileAccess(access)
      throw new Error(RENDERER_FILE_MUTATION_DISABLED_MESSAGE)
    }
  )

  // 检查路径类型（文件 or 目录），用于拖拽检测
  ipcMain.handle(
    AGENT_IPC_CHANNELS.CHECK_PATHS_TYPE,
    async (_, paths: string[], access?: FileAccessOptions): Promise<{ directories: string[]; files: string[] }> => {
      const accessSnapshot = requireVisibleFileAccess(access, paths)
      const { statSync } = await import('node:fs')
      const directories: string[] = []
      const files: string[] = []
      for (const p of paths) {
        try {
          if (!isPathAllowed(p, accessSnapshot.options, accessSnapshot)) continue
          const stat = statSync(p)
          if (stat.isDirectory()) {
            directories.push(p)
          } else {
            files.push(p)
          }
        } catch {
          // 无法访问的路径忽略
        }
      }
      return { directories, files }
    }
  )

  // 搜索工作区文件（用于 @ 引用，递归扫描，支持附加目录）
  type WorkspaceFileSearchEntry = {
    name: string
    path: string
    type: 'file' | 'dir'
    source: 'session' | 'workspace'
  }
  const workspaceFileSearchIndexCache = new Map<string, {
    expiresAt: number
    openedRoots: StableDirectoryOpenedRoot[]
    rootEntries: WorkspaceFileSearchEntry[]
    workspaceEntries: WorkspaceFileSearchEntry[]
  }>()
  const WORKSPACE_FILE_INDEX_CACHE_TTL_MS = 3_000
  const WORKSPACE_FILE_INDEX_CACHE_MAX_ENTRIES = 20

  ipcMain.handle(
    AGENT_IPC_CHANNELS.SEARCH_WORKSPACE_FILES,
    async (_, rootPath: string, query: string, limit = 20, additionalPaths?: string[], sessionPaths?: string[], access?: FileAccessOptions): Promise<FileSearchResult> => {
      const targetPaths = [rootPath, ...(additionalPaths ?? []), ...(sessionPaths ?? [])]
      const accessSnapshot = requireVisibleFileAccess(access, targetPaths)
      const { resolve, relative, basename } = await import('node:path')

      const safeRoot = resolve(rootPath)
      const resolvedAdditionalPaths = (additionalPaths ?? []).map((entry) => resolve(entry))
      const resolvedSessionPaths = (sessionPaths ?? []).map((entry) => resolve(entry))
      const orderedRoots = [safeRoot, ...resolvedSessionPaths, ...resolvedAdditionalPaths]
      const ignoreDirs = new Set(['node_modules', '.git', 'dist', '.next', '__pycache__', '.venv', 'build', '.cache'])
      const ignoreFiles = new Set(['.DS_Store', '.Spotlight-V100', '.Trashes', 'Thumbs.db', 'desktop.ini'])
      const BROWSE_LIMIT_PER_GROUP = 2000
      const BROWSE_TOTAL_CAP = 3000
      const INDEX_ENTRY_CAP_PER_GROUP = 10_000

      // 按来源分组收集文件
      type Entry = WorkspaceFileSearchEntry
      let rootEntries: Entry[] = []
      let workspaceEntries: Entry[] = []

      const cacheKey = JSON.stringify([safeRoot, resolvedAdditionalPaths, resolvedSessionPaths])
      const now = Date.now()
      const cachedIndex = workspaceFileSearchIndexCache.get(cacheKey)
      if (cachedIndex && cachedIndex.expiresAt > now) {
        if (!authorizeStableDirectoryRoots(cachedIndex.openedRoots, orderedRoots, accessSnapshot)
          || cachedIndex.openedRoots[0]?.isDirectory !== true) {
          throw new Error('访问路径超出当前会话的授权范围')
        }
        // 查询排序会原地修改数组；每次从缓存复制外壳，索引条目本身保持只读复用。
        rootEntries = [...cachedIndex.rootEntries]
        workspaceEntries = [...cachedIndex.workspaceEntries]
      } else {
        /** 单次 helper 请求先稳定打开全部 root，再由同一快照原子授权。 */
        const nativeResult = await runStableDirectoryNative(
          {
            mode: 'scan',
            roots: orderedRoots,
            maxDepth: 10,
            maxEntries: INDEX_ENTRY_CAP_PER_GROUP * 2,
            ignoreDirectories: [...ignoreDirs],
            ignoreFiles: [...ignoreFiles],
          },
          (openedRoots) => authorizeStableDirectoryRoots(openedRoots, orderedRoots, accessSnapshot)
            && openedRoots[0]?.isDirectory === true,
        )
        /** 按 rootIndex 分组，业务层只负责来源标签与相对路径呈现。 */
        const entriesByRoot = new Map<number, StableDirectoryNativeEntry[]>()
        for (const entry of nativeResult.entries) {
          const entries = entriesByRoot.get(entry.rootIndex) ?? []
          entries.push(entry)
          entriesByRoot.set(entry.rootIndex, entries)
        }
        const appendRootEntries = (
          rootIndex: number,
          target: Entry[],
          source: 'session' | 'workspace',
          includeRoot: boolean,
        ): void => {
          const openedRoot = nativeResult.roots[rootIndex]
          if (!openedRoot || target.length >= INDEX_ENTRY_CAP_PER_GROUP) return
          const rootName = basename(openedRoot.canonicalPath)
          if (includeRoot && !ignoreFiles.has(rootName) && (!openedRoot.isDirectory || !ignoreDirs.has(rootName))) {
            target.push({
              name: rootName === 'workspace-files' ? '项目文件' : rootName,
              path: openedRoot.canonicalPath,
              type: openedRoot.isDirectory ? 'dir' : 'file',
              source,
            })
          }
          if (!openedRoot.isDirectory) return
          for (const entry of entriesByRoot.get(rootIndex) ?? []) {
            if (target.length >= INDEX_ENTRY_CAP_PER_GROUP) break
            target.push({
              name: entry.name,
              path: rootIndex === 0 ? relative(openedRoot.canonicalPath, entry.path) : entry.path,
              type: entry.isDirectory ? 'dir' : 'file',
              source,
            })
          }
        }

        appendRootEntries(0, rootEntries, 'session', false)
        for (let index = 0; index < resolvedSessionPaths.length; index += 1) {
          appendRootEntries(1 + index, rootEntries, 'session', true)
        }
        for (let index = 0; index < resolvedAdditionalPaths.length; index += 1) {
          appendRootEntries(1 + resolvedSessionPaths.length + index, workspaceEntries, 'workspace', true)
        }

        for (const [key, cached] of workspaceFileSearchIndexCache) {
          if (cached.expiresAt <= now) workspaceFileSearchIndexCache.delete(key)
        }
        while (workspaceFileSearchIndexCache.size >= WORKSPACE_FILE_INDEX_CACHE_MAX_ENTRIES) {
          const oldestKey = workspaceFileSearchIndexCache.keys().next().value
          if (typeof oldestKey !== 'string') break
          workspaceFileSearchIndexCache.delete(oldestKey)
        }
        workspaceFileSearchIndexCache.set(cacheKey, {
          expiresAt: now + WORKSPACE_FILE_INDEX_CACHE_TTL_MS,
          openedRoots: nativeResult.roots.map((root) => ({ ...root })),
          rootEntries: [...rootEntries],
          workspaceEntries: [...workspaceEntries],
        })
      }

      // 连续排序：来源仅用于解析与 badge，不作为结果分组依据。
      function sortEntries(entries: Entry[], q: string): void {
        entries.sort((a, b) => {
          const aStartsWith = a.name.toLowerCase().startsWith(q) ? 0 : 1
          const bStartsWith = b.name.toLowerCase().startsWith(q) ? 0 : 1
          if (aStartsWith !== bStartsWith) return aStartsWith - bStartsWith
          if (a.type === 'dir' && b.type !== 'dir') return -1
          if (a.type !== 'dir' && b.type === 'dir') return 1
          const byPathLength = a.path.length - b.path.length
          if (byPathLength !== 0) return byPathLength
          const byName = a.name.localeCompare(b.name)
          if (byName !== 0) return byName
          return a.path.localeCompare(b.path)
        })
      }

      function matchEntries(entries: Entry[], q: string): Entry[] {
        return entries.filter((entry) => {
          const nameLower = entry.name.toLowerCase()
          const pathLower = entry.path.toLowerCase()
          if (nameLower.startsWith(q)) return true
          if (nameLower.includes(q) || pathLower.includes(q)) return true
          let qi = 0
          for (let i = 0; i < nameLower.length && qi < q.length; i++) {
            if (nameLower[i] === q[qi]) qi++
          }
          return qi === q.length
        })
      }

      // 目录优先排序：确保截断前所有目录（特别是顶层目录）排在前面
      function sortDirsFirst(entries: Entry[]): void {
        entries.sort((a, b) => {
          if (a.type === 'dir' && b.type !== 'dir') return -1
          if (a.type !== 'dir' && b.type === 'dir') return 1
          return a.path.length - b.path.length || a.name.localeCompare(b.name)
        })
      }

      const q = query.toLowerCase()

      if (!q) {
        // 空 query：目录优先排序后再截断，保证文件夹结构完整可见
        sortDirsFirst(rootEntries)
        sortDirsFirst(workspaceEntries)
        const maxPerGroup = Math.max(limit, BROWSE_LIMIT_PER_GROUP)
        const sessionSlice = rootEntries.slice(0, maxPerGroup)
        const workspaceSlice = workspaceEntries.slice(0, maxPerGroup)
        const combined = [...sessionSlice, ...workspaceSlice]
        sortEntries(combined, '')
        const capped = combined.length > BROWSE_TOTAL_CAP ? combined.slice(0, BROWSE_TOTAL_CAP) : combined
        return {
          entries: capped,
          total: rootEntries.length + workspaceEntries.length,
          sessionEntries: sessionSlice,
          workspaceEntries: workspaceSlice,
        }
      }

      const sessionMatched = matchEntries(rootEntries, q)
      const workspaceMatched = matchEntries(workspaceEntries, q)
      sortEntries(sessionMatched, q)
      sortEntries(workspaceMatched, q)

      const totalMatched = sessionMatched.length + workspaceMatched.length
      let sessionSlice: Entry[]
      let workspaceSlice: Entry[]
      if (totalMatched <= limit) {
        sessionSlice = sessionMatched
        workspaceSlice = workspaceMatched
      } else {
        const sessionQuota = Math.max(
          sessionMatched.length > 0 ? 1 : 0,
          Math.round(limit * sessionMatched.length / totalMatched),
        )
        const workspaceQuota = Math.max(
          workspaceMatched.length > 0 ? 1 : 0,
          limit - sessionQuota,
        )
        sessionSlice = sessionMatched.slice(0, sessionQuota)
        workspaceSlice = workspaceMatched.slice(0, workspaceQuota)
      }

      const entries = [...sessionSlice, ...workspaceSlice]
      sortEntries(entries, q)
      return {
        entries,
        total: sessionMatched.length + workspaceMatched.length,
        sessionEntries: sessionSlice,
        workspaceEntries: workspaceSlice,
      }
    }
  )

  // ===== 系统提示词管理 =====

  // 获取系统提示词配置
  ipcMain.handle(
    SYSTEM_PROMPT_IPC_CHANNELS.GET_CONFIG,
    async (): Promise<SystemPromptConfig> => {
      return getSystemPromptConfig()
    }
  )

  // 创建提示词
  ipcMain.handle(
    SYSTEM_PROMPT_IPC_CHANNELS.CREATE,
    async (_, input: SystemPromptCreateInput): Promise<SystemPrompt> => {
      return createSystemPrompt(input)
    }
  )

  // 更新提示词
  ipcMain.handle(
    SYSTEM_PROMPT_IPC_CHANNELS.UPDATE,
    async (_, id: string, input: SystemPromptUpdateInput): Promise<SystemPrompt> => {
      return updateSystemPrompt(id, input)
    }
  )

  // 删除提示词
  ipcMain.handle(
    SYSTEM_PROMPT_IPC_CHANNELS.DELETE,
    async (_, id: string): Promise<void> => {
      return deleteSystemPrompt(id)
    }
  )

  // 更新追加日期时间和用户名开关
  ipcMain.handle(
    SYSTEM_PROMPT_IPC_CHANNELS.UPDATE_APPEND_SETTING,
    async (_, enabled: boolean): Promise<void> => {
      return updateAppendSetting(enabled)
    }
  )

  // 设置默认提示词
  ipcMain.handle(
    SYSTEM_PROMPT_IPC_CHANNELS.SET_DEFAULT,
    async (_, id: string | null): Promise<void> => {
      return setDefaultPrompt(id)
    }
  )

  // ===== GitHub Release =====

  // 获取最新 Release
  ipcMain.handle(
    GITHUB_RELEASE_IPC_CHANNELS.GET_LATEST_RELEASE,
    async (): Promise<GitHubRelease | null> => {
      return getLatestRelease()
    }
  )

  // 获取 Release 列表
  ipcMain.handle(
    GITHUB_RELEASE_IPC_CHANNELS.LIST_RELEASES,
    async (_, options?: GitHubReleaseListOptions): Promise<GitHubRelease[]> => {
      return listGitHubReleases(options)
    }
  )

  // 获取指定版本的 Release
  ipcMain.handle(
    GITHUB_RELEASE_IPC_CHANNELS.GET_RELEASE_BY_TAG,
    async (_, tag: string): Promise<GitHubRelease | null> => {
      return getReleaseByTag(tag)
    }
  )

  // ===== 飞书集成 =====

  // --- 旧 API（向后兼容，操作 bots[0]）---

  // 获取飞书配置
  ipcMain.handle(
    FEISHU_IPC_CHANNELS.GET_CONFIG,
    async (): Promise<FeishuConfig> => {
      return getFeishuConfig()
    }
  )

  // 获取解密后的 App Secret
  ipcMain.handle(
    FEISHU_IPC_CHANNELS.GET_DECRYPTED_SECRET,
    async (): Promise<string> => {
      return getDecryptedAppSecret()
    }
  )

  // 保存飞书配置（旧格式，操作 bots[0]）
  ipcMain.handle(
    FEISHU_IPC_CHANNELS.SAVE_CONFIG,
    async (_, input: FeishuConfigInput): Promise<FeishuConfig> => {
      const config = saveFeishuConfig(input)
      // 配置变更后，重启对应的 Bot
      const multi = getFeishuMultiBotConfig()
      const firstBot = multi.bots[0]
      if (firstBot) {
        if (input.enabled && input.appId && input.appSecret) {
          await feishuBridgeManager.restartBot(firstBot.id)
        } else if (!input.enabled) {
          feishuBridgeManager.stopBot(firstBot.id)
        }
      }
      return config
    }
  )

  // 启动飞书 Bridge（旧格式，启动所有 Bot）
  ipcMain.handle(
    FEISHU_IPC_CHANNELS.START_BRIDGE,
    async (): Promise<void> => {
      await feishuBridgeManager.startAll()
    }
  )

  // 停止飞书 Bridge（旧格式，停止所有 Bot）
  ipcMain.handle(
    FEISHU_IPC_CHANNELS.STOP_BRIDGE,
    async (): Promise<void> => {
      feishuBridgeManager.stopAll()
    }
  )

  // 获取飞书 Bridge 状态（旧格式，返回第一个 Bot 状态）
  ipcMain.handle(
    FEISHU_IPC_CHANNELS.GET_STATUS,
    async (): Promise<FeishuBridgeState> => {
      const states = feishuBridgeManager.getStates()
      const first = Object.values(states.bots)[0]
      return first ?? { status: 'disconnected', activeBindings: 0 }
    }
  )

  // --- 新 API（多 Bot v2）---

  // 获取多 Bot 配置
  ipcMain.handle(
    FEISHU_IPC_CHANNELS.GET_MULTI_CONFIG,
    async () => {
      return getFeishuMultiBotConfig()
    }
  )

  // 保存单个 Bot 配置
  ipcMain.handle(
    FEISHU_IPC_CHANNELS.SAVE_BOT_CONFIG,
    async (_, input: import('@proma/shared').FeishuBotConfigInput) => {
      const saved = saveFeishuBotConfig(input)
      feishuBridgeManager.setSessionMirrorOperator(saved.id, input.operatorOpenId)
      // 配置变更后自动重启或停止（不阻塞保存结果）
      if (saved.enabled && saved.appId && saved.appSecret) {
        feishuBridgeManager.restartBot(saved.id).catch((err) => {
          console.error(`[飞书 IPC] Bot "${saved.name}" 重启失败:`, err)
        })
      } else {
        feishuBridgeManager.stopBot(saved.id)
      }
      return saved
    }
  )

  // 删除 Bot
  ipcMain.handle(
    FEISHU_IPC_CHANNELS.REMOVE_BOT,
    async (_, botId: string) => {
      feishuBridgeManager.stopBot(botId)
      return removeFeishuBot(botId)
    }
  )

  // 获取单个 Bot 解密 Secret
  ipcMain.handle(
    FEISHU_IPC_CHANNELS.GET_BOT_DECRYPTED_SECRET,
    async (_, botId: string) => {
      return getDecryptedBotAppSecret(botId)
    }
  )

  // 启动单个 Bot
  ipcMain.handle(
    FEISHU_IPC_CHANNELS.START_BOT,
    async (_, botId: string) => {
      await feishuBridgeManager.startBot(botId)
    }
  )

  // 停止单个 Bot
  ipcMain.handle(
    FEISHU_IPC_CHANNELS.STOP_BOT,
    async (_, botId: string) => {
      feishuBridgeManager.stopBot(botId)
    }
  )

  // 获取多 Bot 状态
  ipcMain.handle(
    FEISHU_IPC_CHANNELS.GET_MULTI_STATUS,
    async () => {
      return feishuBridgeManager.getStates()
    }
  )

  // 测试飞书连接
  ipcMain.handle(
    FEISHU_IPC_CHANNELS.TEST_CONNECTION,
    async (_, appId: string, appSecret: string, domain?: import('@proma/shared').FeishuDomain): Promise<FeishuTestResult> => {
      return feishuBridgeManager.testConnection(appId, appSecret, domain)
    }
  )

  // 获取绑定列表（包含已归档，前端按视图过滤）
  ipcMain.handle(
    FEISHU_IPC_CHANNELS.LIST_BINDINGS,
    async (): Promise<FeishuChatBinding[]> => {
      return feishuBridgeManager.listAllBindings()
    }
  )

  // 更新绑定（工作区/会话）
  ipcMain.handle(
    FEISHU_IPC_CHANNELS.UPDATE_BINDING,
    async (_, input: FeishuUpdateBindingInput): Promise<FeishuChatBinding | null> => {
      if (input.sessionId !== undefined) requireVisibleSession(input.sessionId)
      const bridge = feishuBridgeManager.findBridgeByChatId(input.chatId)
      return bridge?.updateBinding(input) ?? null
    }
  )

  // 移除绑定
  ipcMain.handle(
    FEISHU_IPC_CHANNELS.REMOVE_BINDING,
    async (_, chatId: string): Promise<boolean> => {
      const bridge = feishuBridgeManager.findBridgeByChatId(chatId)
      return bridge?.removeBinding(chatId) ?? false
    }
  )

  // 上报用户在场状态
  ipcMain.handle(
    FEISHU_IPC_CHANNELS.REPORT_PRESENCE,
    async (_, report: FeishuPresenceReport): Promise<void> => {
      presenceService.updatePresence(report)
    }
  )

  // ===== 飞书扫码注册 =====

  /** 当前进行中的注册流程的 AbortController（同一时间只允许一个） */
  let activeRegisterAbort: AbortController | null = null

  ipcMain.handle(
    FEISHU_IPC_CHANNELS.REGISTER_APP_START,
    async (event): Promise<FeishuRegisterAppResult> => {
      // 同一时间只允许一个注册流程
      if (activeRegisterAbort) {
        activeRegisterAbort.abort()
      }
      const abort = new AbortController()
      activeRegisterAbort = abort

      try {
        const lark = await import('@larksuiteoapi/node-sdk')
        const QRCode = (await import('qrcode')).default
        const result = await lark.registerApp({
          source: 'proma',
          signal: abort.signal,
          onQRCodeReady: async (info) => {
            if (event.sender.isDestroyed()) return
            try {
              const dataUrl = await QRCode.toDataURL(info.url, { width: 280, margin: 2, errorCorrectionLevel: 'M' })
              if (event.sender.isDestroyed()) return
              const payload: FeishuRegisterAppQRCode = {
                url: info.url,
                dataUrl,
                expireIn: info.expireIn,
              }
              event.sender.send(FEISHU_IPC_CHANNELS.REGISTER_APP_QRCODE, payload)
            } catch (err) {
              console.error('[飞书扫码注册] QRCode 生成失败:', err)
              if (event.sender.isDestroyed()) return
              // 兜底：仍把 url 发过去，渲染层可用浏览器打开
              event.sender.send(FEISHU_IPC_CHANNELS.REGISTER_APP_QRCODE, {
                url: info.url,
                dataUrl: '',
                expireIn: info.expireIn,
              })
            }
          },
          onStatusChange: (info) => {
            if (event.sender.isDestroyed()) return
            const payload: FeishuRegisterAppStatus = {
              status: info.status,
              interval: info.interval,
            }
            event.sender.send(FEISHU_IPC_CHANNELS.REGISTER_APP_STATUS, payload)
          },
        })
        return {
          appId: result.client_id,
          appSecret: result.client_secret,
          tenantBrand: result.user_info?.tenant_brand,
          operatorOpenId: result.user_info?.open_id,
        }
      } finally {
        if (activeRegisterAbort === abort) {
          activeRegisterAbort = null
        }
      }
    }
  )

  ipcMain.handle(
    FEISHU_IPC_CHANNELS.REGISTER_APP_CANCEL,
    async (): Promise<void> => {
      activeRegisterAbort?.abort()
      activeRegisterAbort = null
    }
  )

  // ===== 钉钉集成 =====

  // 获取钉钉配置（旧 API，向后兼容）
  ipcMain.handle(
    DINGTALK_IPC_CHANNELS.GET_CONFIG,
    async (): Promise<DingTalkConfig> => {
      return getDingTalkConfig()
    }
  )

  // 获取解密后的 Client Secret（旧 API，向后兼容）
  ipcMain.handle(
    DINGTALK_IPC_CHANNELS.GET_DECRYPTED_SECRET,
    async (): Promise<string> => {
      return getDecryptedClientSecret()
    }
  )

  // 保存钉钉配置（旧 API，向后兼容）
  ipcMain.handle(
    DINGTALK_IPC_CHANNELS.SAVE_CONFIG,
    async (_, input: DingTalkConfigInput): Promise<DingTalkConfig> => {
      return saveDingTalkConfig(input)
    }
  )

  // 测试钉钉连接
  ipcMain.handle(
    DINGTALK_IPC_CHANNELS.TEST_CONNECTION,
    async (_, clientId: string, clientSecret: string): Promise<DingTalkTestResult> => {
      return dingtalkBridgeManager.testConnection(clientId, clientSecret)
    }
  )

  // 启动钉钉 Bridge（旧 API，启动第一个 Bot）
  ipcMain.handle(
    DINGTALK_IPC_CHANNELS.START_BRIDGE,
    async (): Promise<void> => {
      await dingtalkBridgeManager.startAll()
    }
  )

  // 停止钉钉 Bridge（旧 API，停止所有 Bot）
  ipcMain.handle(
    DINGTALK_IPC_CHANNELS.STOP_BRIDGE,
    async (): Promise<void> => {
      dingtalkBridgeManager.stopAll()
    }
  )

  // 获取钉钉 Bridge 状态（旧 API，返回第一个 Bot 状态）
  ipcMain.handle(
    DINGTALK_IPC_CHANNELS.GET_STATUS,
    async (): Promise<DingTalkBridgeState> => {
      const states = dingtalkBridgeManager.getStates()
      const first = Object.values(states.bots)[0]
      return first ?? { status: 'disconnected' }
    }
  )

  // --- 钉钉多 Bot v2 API ---

  // 获取多 Bot 配置
  ipcMain.handle(
    DINGTALK_IPC_CHANNELS.GET_MULTI_CONFIG,
    async () => {
      return getDingTalkMultiBotConfig()
    }
  )

  // 保存单个 Bot 配置
  ipcMain.handle(
    DINGTALK_IPC_CHANNELS.SAVE_BOT_CONFIG,
    async (_, input: import('@proma/shared').DingTalkBotConfigInput) => {
      const saved = saveDingTalkBotConfig(input)
      // 配置变更后自动重启或停止（不阻塞保存结果）
      if (saved.enabled && saved.clientId && saved.clientSecret) {
        dingtalkBridgeManager.restartBot(saved.id).catch((err) => {
          console.error(`[钉钉 IPC] Bot "${saved.name}" 重启失败:`, err)
        })
      } else {
        dingtalkBridgeManager.stopBot(saved.id)
      }
      return saved
    }
  )

  // 删除 Bot
  ipcMain.handle(
    DINGTALK_IPC_CHANNELS.REMOVE_BOT,
    async (_, botId: string) => {
      dingtalkBridgeManager.stopBot(botId)
      return removeDingTalkBot(botId)
    }
  )

  // 获取单个 Bot 解密 Secret
  ipcMain.handle(
    DINGTALK_IPC_CHANNELS.GET_BOT_DECRYPTED_SECRET,
    async (_, botId: string) => {
      return getDecryptedBotClientSecret(botId)
    }
  )

  // 启动单个 Bot
  ipcMain.handle(
    DINGTALK_IPC_CHANNELS.START_BOT,
    async (_, botId: string) => {
      await dingtalkBridgeManager.startBot(botId)
    }
  )

  // 停止单个 Bot
  ipcMain.handle(
    DINGTALK_IPC_CHANNELS.STOP_BOT,
    async (_, botId: string) => {
      dingtalkBridgeManager.stopBot(botId)
    }
  )

  // 获取多 Bot 状态
  ipcMain.handle(
    DINGTALK_IPC_CHANNELS.GET_MULTI_STATUS,
    async () => {
      return dingtalkBridgeManager.getStates()
    }
  )

  // ===== 微信集成 =====

  // 获取微信配置
  ipcMain.handle(
    WECHAT_IPC_CHANNELS.GET_CONFIG,
    async (): Promise<WeChatConfig> => {
      return getWeChatConfig()
    }
  )

  // 开始扫码登录
  ipcMain.handle(
    WECHAT_IPC_CHANNELS.START_LOGIN,
    async (): Promise<void> => {
      await wechatBridge.startLogin()
    }
  )

  // 登出
  ipcMain.handle(
    WECHAT_IPC_CHANNELS.LOGOUT,
    async (): Promise<void> => {
      wechatBridge.logout()
    }
  )

  // 启动 Bridge（用已有凭证）
  ipcMain.handle(
    WECHAT_IPC_CHANNELS.START_BRIDGE,
    async (): Promise<void> => {
      await wechatBridge.start()
    }
  )

  // 停止 Bridge
  ipcMain.handle(
    WECHAT_IPC_CHANNELS.STOP_BRIDGE,
    async (): Promise<void> => {
      wechatBridge.stop()
    }
  )

  // 获取 Bridge 状态
  ipcMain.handle(
    WECHAT_IPC_CHANNELS.GET_STATUS,
    async (): Promise<WeChatBridgeState> => {
      return wechatBridge.getStatus()
    }
  )

  console.log('[IPC] IPC 处理器注册完成')

  // 注册更新 IPC 处理器
  registerUpdaterIpc()

  // 启动时自动归档 + 每 24 小时定期检查
  const runAutoArchive = (): void => {
    try {
      const settings = getSettings()
      const days = settings.archiveAfterDays ?? 7
      if (days > 0) {
        const archivedChats = autoArchiveConversations(days)
        const archivedSessions = autoArchiveAgentSessions(days)
        if (archivedChats + archivedSessions > 0) {
          console.log(`[自动归档] 已归档 ${archivedChats} 个对话, ${archivedSessions} 个 Agent 会话`)
        }
      }
    } catch (error) {
      console.error('[自动归档] 自动归档失败:', error)
    }
  }

  runAutoArchive()
  setInterval(runAutoArchive, 24 * 60 * 60 * 1000)

  // 启动时清理不存在的附加目录/文件（如已删除的 worktree）
  try {
    cleanupStaleAttachedPaths()
    cleanupStaleWorkspaceAttachedPaths()
  } catch (error) {
    console.error('[启动清理] 清理失效附加路径失败:', error)
  }

  // ===== 存储管理 =====

  ipcMain.handle(STORAGE_IPC_CHANNELS.GET_STATS, async () => {
    return calculateStorageStats()
  })

  ipcMain.handle(STORAGE_IPC_CHANNELS.CLEANUP, async (_, options: CleanupOptions) => {
    return cleanupStorage(options)
  })

  ipcMain.handle(STORAGE_IPC_CHANNELS.CLEANUP_TEMP, async () => {
    return cleanupTempFiles()
  })

  // 启动时自动清理临时文件
  const runStartupCleanup = async (): Promise<void> => {
    try {
      const settings = getSettings()
      if (settings.autoCleanupTempOnStart !== false) {
        const result = await cleanupTempFiles()
        if (result.freedBytes > 0) {
          console.log(`[存储清理] 启动时清理了 ${(result.freedBytes / 1024 / 1024).toFixed(1)} MB 临时文件`)
        }
      }
      const archiveDays = settings.autoCleanupArchivedDays ?? 0
      if (archiveDays > 0) {
        const result = await cleanupStorage({
          categories: ['agent-sessions', 'sdk-config'],
          orphansOnly: false,
          archivedBeforeDays: archiveDays,
        })
        if (result.freedBytes > 0) {
          console.log(`[存储清理] 启动时清理了 ${(result.freedBytes / 1024 / 1024).toFixed(1)} MB 归档数据`)
        }
      }
    } catch (e) {
      console.error('[存储清理] 启动时清理失败:', e)
    }
  }
  runStartupCleanup()

  // ===== 快速任务窗口 =====

  // 提交快速任务 → 隐藏窗口 + 转发到主窗口（由渲染进程创建会话并发送消息）
  ipcMain.handle(
    QUICK_TASK_IPC_CHANNELS.SUBMIT,
    async (_, input: QuickTaskSubmitInput): Promise<void> => {
      const { hideQuickTaskWindow } = await import('./lib/quick-task-window')
      const { getMainWindow } = await import('./index')
      hideQuickTaskWindow()

      const mainWin = getMainWindow()
      if (mainWin && !mainWin.isDestroyed()) {
        // 转发到主窗口渲染进程，由 GlobalShortcuts 创建会话并触发发送
        mainWin.webContents.send('quick-task:open-session', {
          mode: input.mode,
          text: input.text,
          files: input.files,
        })
        mainWin.show()
        mainWin.focus()
      }
    }
  )

  // 隐藏快速任务窗口
  ipcMain.handle(
    QUICK_TASK_IPC_CHANNELS.HIDE,
    async (): Promise<void> => {
      const { hideQuickTaskWindow } = await import('./lib/quick-task-window')
      hideQuickTaskWindow()
    }
  )

  // 重新注册全局快捷键（设置中修改快捷键后调用）
  ipcMain.handle(
    QUICK_TASK_IPC_CHANNELS.REREGISTER_GLOBAL_SHORTCUTS,
    async (): Promise<Record<string, boolean>> => {
      const { reregisterAllGlobalShortcuts } = await import('./lib/global-shortcut-service')
      return reregisterAllGlobalShortcuts()
    }
  )

  // 查询系统实际接受的全局快捷键，供快捷键地图标示未注册项。
  ipcMain.handle(
    QUICK_TASK_IPC_CHANNELS.GET_GLOBAL_SHORTCUT_REGISTRATION_STATUS,
    async (): Promise<Record<string, boolean>> => {
      const { getGlobalShortcutRegistrationStatus } = await import('./lib/global-shortcut-service')
      return getGlobalShortcutRegistrationStatus()
    }
  )

  // ===== 语音输入 =====

  ipcMain.handle(
    VOICE_DICTATION_IPC_CHANNELS.GET_SETTINGS,
    async (): Promise<VoiceDictationSettings> => {
      const { getVoiceDictationSettings } = await import('./lib/voice-dictation-settings-service')
      return getVoiceDictationSettings()
    }
  )

  ipcMain.handle(
    VOICE_DICTATION_IPC_CHANNELS.UPDATE_SETTINGS,
    async (_, updates: VoiceDictationSettingsUpdate): Promise<VoiceDictationSettings> => {
      const { updateVoiceDictationSettings } = await import('./lib/voice-dictation-settings-service')
      return updateVoiceDictationSettings(updates)
    }
  )

  ipcMain.handle(
    VOICE_DICTATION_IPC_CHANNELS.TEST_CONNECTION,
    async (_, updates?: VoiceDictationSettingsUpdate): Promise<VoiceDictationTestResult> => {
      const { getVoiceDictationSettings } = await import('./lib/voice-dictation-settings-service')
      const { testDoubaoAsrConnection } = await import('./lib/doubao-asr-service')
      const settings = { ...getVoiceDictationSettings(), ...(updates ?? {}) }
      return testDoubaoAsrConnection(settings)
    }
  )

  ipcMain.handle(
    VOICE_DICTATION_IPC_CHANNELS.TOGGLE,
    async (event, input?: VoiceDictationToggleInput): Promise<void> => {
      const { toggleVoiceDictationWindow } = await import('./lib/voice-dictation-window')
      const sourceWindow = BrowserWindow.fromWebContents(event.sender)
      const sourceInputId = typeof input?.sourceInputId === 'string' && input.sourceInputId.length > 0 && input.sourceInputId.length <= 512
        ? input.sourceInputId
        : undefined
      toggleVoiceDictationWindow({ targetIsProma: !!sourceWindow, sourceInputId })
    }
  )

  ipcMain.handle(
    VOICE_DICTATION_IPC_CHANNELS.START,
    async (event, input: VoiceDictationStartInput): Promise<void> => {
      const { getVoiceDictationSettings } = await import('./lib/voice-dictation-settings-service')
      const { startDoubaoAsrSession } = await import('./lib/doubao-asr-service')
      const win = BrowserWindow.fromWebContents(event.sender)
      if (!win) throw new Error('语音输入窗口不存在')
      await startDoubaoAsrSession(input.sessionId, getVoiceDictationSettings(), win)
    }
  )

  ipcMain.handle(
    VOICE_DICTATION_IPC_CHANNELS.SEND_AUDIO,
    async (_, input: VoiceDictationAudioChunkInput): Promise<void> => {
      const { sendDoubaoAsrAudio } = await import('./lib/doubao-asr-service')
      sendDoubaoAsrAudio(input.sessionId, input.data)
    }
  )

  ipcMain.on(VOICE_DICTATION_IPC_CHANNELS.REPORT_VOLUME, (event, volume: unknown) => {
    void Promise.all([
      import('./index'),
      import('./lib/voice-dictation-window'),
    ]).then(([{ getMainWindow }, { updateVoiceDictationIndicatorVolume }]) => {
      const mainWindow = getMainWindow()
      if (!mainWindow || mainWindow.isDestroyed() || event.sender.id !== mainWindow.webContents.id) return
      updateVoiceDictationIndicatorVolume(typeof volume === 'number' ? volume : 0)
    }).catch(console.error)
  })

  ipcMain.on(VOICE_DICTATION_IPC_CHANNELS.REPORT_TRANSCRIPT, (event, text: unknown) => {
    void Promise.all([
      import('./index'),
      import('./lib/voice-dictation-window'),
    ]).then(([{ getMainWindow }, { updateVoiceDictationIndicatorTranscript }]) => {
      const mainWindow = getMainWindow()
      if (!mainWindow || mainWindow.isDestroyed() || event.sender.id !== mainWindow.webContents.id) return
      updateVoiceDictationIndicatorTranscript(typeof text === 'string' ? text.slice(-4_000) : '')
    }).catch(console.error)
  })

  ipcMain.handle(
    VOICE_DICTATION_IPC_CHANNELS.STOP,
    async (_, input: VoiceDictationStopInput): Promise<void> => {
      const { stopDoubaoAsrSession } = await import('./lib/doubao-asr-service')
      await stopDoubaoAsrSession(input.sessionId)
    }
  )

  ipcMain.handle(
    VOICE_DICTATION_IPC_CHANNELS.CANCEL,
    async (_, input: VoiceDictationStopInput): Promise<void> => {
      const { cancelDoubaoAsrSession } = await import('./lib/doubao-asr-service')
      const { clearVoiceDictationPreview } = await import('./lib/text-output-service')
      clearVoiceDictationPreview(
        input.previewSessionId ?? input.sessionId,
        input.targetInputId,
        input.outputContextId,
      )
      cancelDoubaoAsrSession(input.sessionId)
    }
  )

  ipcMain.handle(
    VOICE_DICTATION_IPC_CHANNELS.PREVIEW,
    async (_, input: VoiceDictationPreviewInput): Promise<void> => {
      const { getVoiceDictationSettings } = await import('./lib/voice-dictation-settings-service')
      const { previewVoiceDictationText } = await import('./lib/text-output-service')
      previewVoiceDictationText(input, getVoiceDictationSettings())
    }
  )

  ipcMain.on(VOICE_DICTATION_IPC_CHANNELS.ACK_INSERT_TEXT, (event, input: VoiceDictationTextDeliveryInput) => {
    void Promise.all([
      import('./index'),
      import('./lib/text-output-service'),
    ]).then(([{ getMainWindow }, { acknowledgeVoiceDictationTextDelivery }]) => {
      const mainWindow = getMainWindow()
      if (!mainWindow || mainWindow.isDestroyed() || event.sender.id !== mainWindow.webContents.id) return
      if (!input || typeof input.sessionId !== 'string' || typeof input.delivered !== 'boolean') return
      acknowledgeVoiceDictationTextDelivery(input.sessionId, input.delivered)
    }).catch(console.error)
  })

  ipcMain.handle(
    VOICE_DICTATION_IPC_CHANNELS.COMMIT,
    async (_, input: VoiceDictationCommitInput): Promise<VoiceDictationCommitResult> => {
      const { getVoiceDictationSettings } = await import('./lib/voice-dictation-settings-service')
      const { commitVoiceDictationText } = await import('./lib/text-output-service')
      return commitVoiceDictationText(input, getVoiceDictationSettings())
    }
  )

  ipcMain.handle(
    VOICE_DICTATION_IPC_CHANNELS.HIDE,
    async (): Promise<void> => {
      const { hideVoiceDictationWindow } = await import('./lib/voice-dictation-window')
      hideVoiceDictationWindow()
    }
  )

  ipcMain.handle(
    VOICE_DICTATION_IPC_CHANNELS.RESIZE,
    async (_, input: VoiceDictationResizeInput): Promise<void> => {
      const { resizeVoiceDictationWindow } = await import('./lib/voice-dictation-window')
      resizeVoiceDictationWindow(input.height)
    }
  )

  ipcMain.handle(
    VOICE_DICTATION_IPC_CHANNELS.CHECK_MIC_PERMISSION,
    async (): Promise<MicPermissionResult> => {
      const { checkMicrophonePermission } = await import('./lib/microphone-permission-service')
      return checkMicrophonePermission()
    }
  )

  ipcMain.handle(
    VOICE_DICTATION_IPC_CHANNELS.REQUEST_MIC_PERMISSION,
    async (): Promise<MicPermissionResult> => {
      const { requestMicrophonePermission } = await import('./lib/microphone-permission-service')
      return requestMicrophonePermission()
    }
  )

  // ===== 窗口控制（Windows 自定义标题栏按钮）=====

  ipcMain.handle(
    IPC_CHANNELS.WINDOW_MINIMIZE,
    async (event) => {
      const win = BrowserWindow.fromWebContents(event.sender)
      if (win && !win.isDestroyed()) win.minimize()
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.WINDOW_MAXIMIZE,
    async (event) => {
      const win = BrowserWindow.fromWebContents(event.sender)
      if (win && !win.isDestroyed()) {
        win.isMaximized() ? win.unmaximize() : win.maximize()
      }
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.WINDOW_CLOSE,
    async (event) => {
      const win = BrowserWindow.fromWebContents(event.sender)
      if (win && !win.isDestroyed()) win.close()
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.WINDOW_IS_MAXIMIZED,
    async (event) => {
      const win = BrowserWindow.fromWebContents(event.sender)
      return win && !win.isDestroyed() ? win.isMaximized() : false
    }
  )

  // ===== LAN Bridge IPC Handlers =====
  registerLanBridgeIpcHandlers(ipcMain, createLanBridgeIpcDependencies(agentEventBus))

  // ===== 任务 / 日程（Planning）=====

  const isPlanningTitle = (value: unknown): value is string =>
    typeof value === 'string' && value.trim().length > 0 && value.trim().length <= 500
  const isPlanningTimestamp = (value: unknown): value is number =>
    typeof value === 'number' && Number.isFinite(value) && value > 0
  const isTodoPriority = (value: unknown): value is 'low' | 'medium' | 'high' =>
    value === 'low' || value === 'medium' || value === 'high'
  const isTodoStatus = (value: unknown): value is 'open' | 'completed' =>
    value === 'open' || value === 'completed'
  const parseTodoListQuery = (input: unknown): TodoListQuery => {
    if (input === undefined) return {}
    if (!input || typeof input !== 'object') throw new Error('Todo 查询参数非法')
    const query = input as TodoListQuery
    if (query.status !== undefined && !isTodoStatus(query.status)) throw new Error('Todo status 非法')
    if (query.dueBefore !== undefined && !isPlanningTimestamp(query.dueBefore)) throw new Error('Todo dueBefore 非法')
    if (query.limit !== undefined && (!Number.isInteger(query.limit) || query.limit < 1)) throw new Error('Todo limit 非法')
    return query
  }
  const parseCalendarEventListQuery = (input: unknown): CalendarEventListQuery => {
    if (input === undefined) return {}
    if (!input || typeof input !== 'object') throw new Error('日程查询参数非法')
    const query = input as CalendarEventListQuery
    if (query.from !== undefined && !isPlanningTimestamp(query.from)) throw new Error('日程 from 非法')
    if (query.to !== undefined && !isPlanningTimestamp(query.to)) throw new Error('日程 to 非法')
    if (query.from !== undefined && query.to !== undefined && query.from > query.to) throw new Error('日程范围非法')
    if (query.limit !== undefined && (!Number.isInteger(query.limit) || query.limit < 1)) throw new Error('日程 limit 非法')
    return query
  }

  ipcMain.handle(PLANNING_IPC_CHANNELS.LIST_TODOS, async (_, input?: unknown): Promise<Todo[]> => listTodos(parseTodoListQuery(input)))
  ipcMain.handle(PLANNING_IPC_CHANNELS.CREATE_TODO, async (_, input: CreateTodoInput): Promise<Todo> => {
    if (!input || !isPlanningTitle(input.title)) throw new Error('Todo 标题不能为空且不能超过 500 字')
    if (input.priority !== undefined && !isTodoPriority(input.priority)) throw new Error('Todo priority 非法')
    if (input.dueAt !== undefined && !isPlanningTimestamp(input.dueAt)) throw new Error('Todo dueAt 非法')
    if (input.sessionId !== undefined && (typeof input.sessionId !== 'string' || !input.sessionId.trim())) throw new Error('Todo sessionId 非法')
    const todo = createTodo(input)
    broadcastPlanningChanged(['todos', 'reminders'])
    return todo
  })
  // Todo 项目归属更新与 Agent 会话创建必须在一次主进程同步处理内完成，
  // 避免项目选择、Todo 更新与会话创建之间出现状态竞争。
  ipcMain.handle(PLANNING_IPC_CHANNELS.START_TODO_AGENT, (event, input: StartTodoAgentInput): StartTodoAgentResult => {
    if (!input || typeof input.todoId !== 'string' || !input.todoId.trim()) throw new Error('Todo id 必填')
    if (typeof input.workspaceId !== 'string' || !input.workspaceId.trim()) throw new Error('项目 id 必填')
    if (!isPlanningTimestamp(input.expectedUpdatedAt)) throw new Error('Todo expectedUpdatedAt 非法')
    if (typeof input.channelId !== 'string' || !input.channelId.trim()) throw new Error('Agent 渠道必填')
    if (input.modelId !== undefined && (typeof input.modelId !== 'string' || !input.modelId.trim())) throw new Error('Agent 模型非法')
    if (!getAgentWorkspace(input.workspaceId)) throw new Error('所选项目已不可用，请重新选择')

    const existing = getTodo(input.todoId)
    if (!existing) throw new Error('Todo 不存在')
    if (existing.updatedAt !== input.expectedUpdatedAt) throw new Error(PLANNING_CONFLICT_ERROR)

    const todo = existing.workspaceId === input.workspaceId
      ? existing
      : updateTodo({
        id: existing.id,
        workspaceId: input.workspaceId,
        expectedUpdatedAt: existing.updatedAt,
      })
    if (!todo) throw new Error('Todo 不存在')
    if (todo !== existing) broadcastPlanningChanged(['todos', 'reminders'], { todo })

    const session = createAgentSession(
      `处理：${todo.title}`,
      input.channelId,
      input.workspaceId,
      input.modelId,
    )
    // 对齐普通 Agent 会话创建入口；镜像初始化异步执行，不打断上面的原子状态转换。
    feishuBridgeManager.ensureSessionMirror(session).catch((error) => {
      console.error('[飞书 Session 镜像] Todo 启动会话建群失败:', error)
    })

    // 独立规划窗口没有 AgentView，由主窗口接手打开会话并消费自动启动提示。
    try {
      const sourceWindowKind = new URL(event.sender.getURL()).searchParams.get('window')
      if (sourceWindowKind === 'planning') {
        const mainWindow = BrowserWindow.getAllWindows().find((win) => {
          if (win.isDestroyed() || win.webContents.id === event.sender.id) return false
          return new URL(win.webContents.getURL()).searchParams.get('window') === null
        })
        if (mainWindow) {
          if (mainWindow.isMinimized()) mainWindow.restore()
          mainWindow.show()
          mainWindow.focus()
          const activation: TodoAgentSessionActivation = { todo, session }
          mainWindow.webContents.send(PLANNING_IPC_CHANNELS.TODO_AGENT_SESSION_READY, activation)
        }
      }
    } catch (error) {
      console.error('[任务/日程] 转交 Todo Agent 会话到主窗口失败:', error)
    }

    return { todo, session }
  })
  ipcMain.handle(PLANNING_IPC_CHANNELS.UPDATE_TODO, async (_, input: UpdateTodoInput): Promise<Todo | undefined> => {
    if (!input || typeof input.id !== 'string' || !input.id) throw new Error('Todo id 必填')
    if (input.title !== undefined && !isPlanningTitle(input.title)) throw new Error('Todo 标题不能为空且不能超过 500 字')
    if (input.priority !== undefined && !isTodoPriority(input.priority)) throw new Error('Todo priority 非法')
    if (input.status !== undefined && !isTodoStatus(input.status)) throw new Error('Todo status 非法')
    if (input.dueAt !== undefined && input.dueAt !== null && !isPlanningTimestamp(input.dueAt)) throw new Error('Todo dueAt 非法')
    if (input.expectedUpdatedAt !== undefined && !isPlanningTimestamp(input.expectedUpdatedAt)) throw new Error('Todo expectedUpdatedAt 非法')
    const todo = updateTodo(input)
    if (todo) broadcastPlanningChanged(['todos', 'reminders'], { todo })
    return todo
  })
  ipcMain.handle(PLANNING_IPC_CHANNELS.DELETE_TODO, async (_, id: string): Promise<boolean> => {
    if (!id || typeof id !== 'string') throw new Error('Todo id 必填')
    const deleted = deleteTodo(id)
    // calendar_events.todo_id 使用 ON DELETE SET NULL，删除后必须同步刷新关联日程。
    if (deleted) broadcastPlanningChanged(['todos', 'calendar_events', 'reminders'])
    return deleted
  })

  ipcMain.handle(PLANNING_IPC_CHANNELS.LIST_CALENDAR_EVENTS, async (_, input?: unknown): Promise<CalendarEvent[]> => listCalendarEvents(parseCalendarEventListQuery(input)))
  ipcMain.handle(PLANNING_IPC_CHANNELS.CREATE_CALENDAR_EVENT, async (_, input: CreateCalendarEventInput): Promise<CalendarEvent> => {
    if (!input || !isPlanningTitle(input.title) || !isPlanningTimestamp(input.startAt)) throw new Error('日程标题和 startAt 必填')
    if (input.endAt !== undefined && (!isPlanningTimestamp(input.endAt) || input.endAt < input.startAt)) throw new Error('日程 endAt 非法')
    const event = createCalendarEvent(input)
    broadcastPlanningChanged(['calendar_events', 'reminders'])
    return event
  })
  ipcMain.handle(PLANNING_IPC_CHANNELS.UPDATE_CALENDAR_EVENT, async (_, input: UpdateCalendarEventInput): Promise<CalendarEvent | undefined> => {
    if (!input || typeof input.id !== 'string' || !input.id) throw new Error('日程 id 必填')
    if (input.title !== undefined && !isPlanningTitle(input.title)) throw new Error('日程标题不能为空且不能超过 500 字')
    if (input.startAt !== undefined && !isPlanningTimestamp(input.startAt)) throw new Error('日程 startAt 非法')
    if (input.endAt !== undefined && input.endAt !== null && !isPlanningTimestamp(input.endAt)) throw new Error('日程 endAt 非法')
    if (input.expectedUpdatedAt !== undefined && !isPlanningTimestamp(input.expectedUpdatedAt)) throw new Error('日程 expectedUpdatedAt 非法')
    const event = updateCalendarEvent(input)
    if (event) broadcastPlanningChanged(['calendar_events', 'reminders'])
    return event
  })
  ipcMain.handle(PLANNING_IPC_CHANNELS.DELETE_CALENDAR_EVENT, async (_, id: string): Promise<boolean> => {
    if (!id || typeof id !== 'string') throw new Error('日程 id 必填')
    const deleted = deleteCalendarEvent(id)
    if (deleted) broadcastPlanningChanged(['calendar_events', 'reminders'])
    return deleted
  })

  const isPlanningShortName = (value: unknown): value is string =>
    typeof value === 'string' && value.trim().length > 0 && value.trim().length <= 100
  const isPlanningGroupScope = (value: unknown): value is PlanningGroupScope => value === 'todo' || value === 'calendar'
  const isOptionalColor = (value: unknown): boolean => value === undefined || value === null || typeof value === 'string'
  // 分组变更需要让对应列表和提醒同时失效，统一映射可避免各 handler 漏项。
  function getPlanningGroupChangeResources(scope: PlanningGroupScope): PlanningChangeResource[] {
    if (scope === 'todo') return ['todo_groups', 'todos', 'reminders']
    return ['calendar_groups', 'calendar_events', 'reminders']
  }

  ipcMain.handle(PLANNING_IPC_CHANNELS.LIST_GROUPS, async (_, scope: PlanningGroupScope): Promise<PlanningGroup[]> => {
    if (!isPlanningGroupScope(scope)) throw new Error('分组范围非法')
    return listPlanningGroups(scope)
  })
  ipcMain.handle(PLANNING_IPC_CHANNELS.CREATE_GROUP, async (_, input: CreatePlanningGroupInput): Promise<PlanningGroup> => {
    if (!input || !isPlanningGroupScope(input.scope) || !isPlanningShortName(input.name) || !isOptionalColor(input.color)) {
      throw new Error('分组参数非法')
    }
    const group = createPlanningGroup(input)
    broadcastPlanningChanged(getPlanningGroupChangeResources(input.scope))
    return group
  })
  ipcMain.handle(PLANNING_IPC_CHANNELS.UPDATE_GROUP, async (_, input: UpdatePlanningGroupInput): Promise<PlanningGroup | undefined> => {
    if (
      !input
      || !isPlanningGroupScope(input.scope)
      || typeof input.id !== 'string'
      || (input.name !== undefined && !isPlanningShortName(input.name))
      || !isOptionalColor(input.color)
    ) {
      throw new Error('分组参数非法')
    }
    const group = updatePlanningGroup(input)
    if (group) broadcastPlanningChanged(getPlanningGroupChangeResources(input.scope))
    return group
  })
  ipcMain.handle(PLANNING_IPC_CHANNELS.DELETE_GROUP, async (_, scope: PlanningGroupScope, id: string): Promise<boolean> => {
    if (!isPlanningGroupScope(scope) || !id || typeof id !== 'string') throw new Error('分组参数非法')
    const deleted = deletePlanningGroup(scope, id)
    if (deleted) broadcastPlanningChanged(getPlanningGroupChangeResources(scope))
    return deleted
  })

  ipcMain.handle(PLANNING_IPC_CHANNELS.LIST_TAGS, async (): Promise<PlanningTag[]> => listPlanningTags())

  ipcMain.handle(PLANNING_IPC_CHANNELS.LIST_ACTIVE_REMINDERS, async (): Promise<ActivePlanningReminder[]> => listActivePlanningReminders())
  ipcMain.handle(PLANNING_IPC_CHANNELS.ACKNOWLEDGE_REMINDER, async (_, id: string): Promise<PlanningReminder | undefined> => {
    if (!id || typeof id !== 'string') throw new Error('提醒 id 必填')
    const reminder = acknowledgePlanningReminder(id)
    if (reminder) broadcastPlanningChanged(['todos', 'calendar_events', 'reminders'])
    return reminder
  })
  ipcMain.handle(PLANNING_IPC_CHANNELS.SNOOZE_REMINDER, async (_, input: SnoozePlanningReminderInput): Promise<PlanningReminder | undefined> => {
    if (!input || typeof input.id !== 'string' || !Number.isInteger(input.minutes) || input.minutes < 1 || input.minutes > 10080) throw new Error('推迟分钟数非法')
    const reminder = snoozePlanningReminder(input.id, input.minutes)
    if (reminder) broadcastPlanningChanged(['todos', 'calendar_events', 'reminders'])
    return reminder
  })

  // ===== macOS Calendar / Reminders 同步（授权、受管目标与单向发布） =====
  const isPlanningNativeSyncEntity = (value: unknown): value is PlanningNativeSyncEntity => value === 'calendar' || value === 'reminder'
  ipcMain.handle(PLANNING_IPC_CHANNELS.GET_NATIVE_SYNC_STATUS, async (): Promise<PlanningNativeSyncStatus> => getPlanningNativeSyncStatus())
  ipcMain.handle(PLANNING_IPC_CHANNELS.REQUEST_NATIVE_SYNC_ACCESS, async (_, entity: unknown): Promise<PlanningNativeSyncPermissionResult> => {
    if (!isPlanningNativeSyncEntity(entity)) throw new Error('同步实体类型非法')
    return requestPlanningNativeSyncAccess(entity)
  })
  ipcMain.handle(PLANNING_IPC_CHANNELS.OPEN_NATIVE_SYNC_PRIVACY_SETTINGS, async (_, entity: unknown): Promise<void> => {
    if (!isPlanningNativeSyncEntity(entity)) throw new Error('同步实体类型非法')
    if (process.platform !== 'darwin') return
    await shell.openExternal(entity === 'calendar'
      ? 'x-apple.systempreferences:com.apple.preference.security?Privacy_Calendars'
      : 'x-apple.systempreferences:com.apple.preference.security?Privacy_Reminders')
  })
  ipcMain.handle(PLANNING_IPC_CHANNELS.LIST_NATIVE_SYNC_TARGETS, async (_, entity: unknown): Promise<PlanningNativeSyncTarget[]> => {
    if (!isPlanningNativeSyncEntity(entity)) throw new Error('同步实体类型非法')
    return listPlanningNativeSyncTargets(entity)
  })
  ipcMain.handle(PLANNING_IPC_CHANNELS.LIST_NATIVE_CONNECTION_TARGETS, async (_, entity: unknown): Promise<PlanningNativeSyncTarget[]> => {
    if (!isPlanningNativeSyncEntity(entity)) throw new Error('同步实体类型非法')
    return listPlanningNativeConnectionTargets(entity)
  })
  ipcMain.handle(PLANNING_IPC_CHANNELS.LIST_NATIVE_CONNECTIONS, async (_, entity?: unknown): Promise<PlanningNativeConnection[]> => {
    if (entity !== undefined && !isPlanningNativeSyncEntity(entity)) throw new Error('同步实体类型非法')
    return listPlanningNativeConnections(entity)
  })
  ipcMain.handle(PLANNING_IPC_CHANNELS.CONNECT_NATIVE_CONNECTION, async (_, input: ConnectPlanningNativeConnectionInput): Promise<PlanningNativeConnection> => {
    if (!input || !isPlanningNativeSyncEntity(input.entity) || !input.target || typeof input.target.id !== 'string') throw new Error('连接参数非法')
    // renderer 不可信：用 EventKit 当前返回的完整目标覆盖传入元数据。
    const target = (await listPlanningNativeConnectionTargets(input.entity)).find((item) => item.id === input.target.id)
    if (!target) throw new Error('系统集合不存在或尚未授权')
    const connection = connectPlanningNativeConnection({ entity: input.entity, target })
    // 用户刚确认连接时必须立刻回流，不能被全局定期同步 cooldown 延后。
    void runPlanningNativeSync(true)
    return connection
  })
  ipcMain.handle(PLANNING_IPC_CHANNELS.DISCONNECT_NATIVE_CONNECTION, async (_, id: unknown): Promise<boolean> => {
    if (typeof id !== 'string' || !id) throw new Error('连接 id 非法')
    const disconnected = disconnectPlanningNativeConnection(id)
    if (disconnected) broadcastPlanningChanged(['todos', 'calendar_events'])
    return disconnected
  })
  ipcMain.handle(PLANNING_IPC_CHANNELS.LIST_NATIVE_SYNC_CONFLICTS, async (): Promise<PlanningNativeSyncConflict[]> => listPlanningNativeSyncConflicts())
  ipcMain.handle(PLANNING_IPC_CHANNELS.RESOLVE_NATIVE_SYNC_CONFLICT, async (_, input: ResolvePlanningNativeSyncConflictInput): Promise<boolean> => {
    if (!input || typeof input.id !== 'string' || !['keep_proma', 'keep_system'].includes(input.resolution)) throw new Error('冲突解决参数非法')
    const resolved = resolvePlanningNativeSyncConflict(input)
    if (resolved) {
      broadcastPlanningChanged(['todos', 'calendar_events'])
      void runPlanningNativeSync(true)
    }
    return resolved
  })
  ipcMain.handle(PLANNING_IPC_CHANNELS.LIST_SYNC_PROFILES, async (): Promise<PlanningSyncProfile[]> => listPlanningSyncProfiles())
  ipcMain.handle(PLANNING_IPC_CHANNELS.SAVE_SYNC_PROFILE, async (_, input: SavePlanningSyncProfileInput): Promise<PlanningSyncProfile> => {
    if (!input || !isPlanningNativeSyncEntity(input.entity) || !input.target || typeof input.target.id !== 'string' || typeof input.target.title !== 'string' || typeof input.target.sourceTitle !== 'string' || (input.enabled !== undefined && typeof input.enabled !== 'boolean')) throw new Error('同步目标参数非法')
    // renderer 不可信：必须由主进程重新确认目标仍存在且可写，不能接受伪造的 Calendar/List 标识。
    const target = (await listPlanningNativeSyncTargets(input.entity)).find((item) => item.id === input.target.id)
    if (!target) throw new Error('同步目标不存在、不可写或尚未授权')
    const profile = savePlanningSyncProfile({ ...input, target })
    // 受管 Calendar 的系统存量也必须立即回流；不能被 30 秒 reconcile 冷却窗口延后。
    void runPlanningNativeSync(true)
    return profile
  })

  // ===== 定时任务（Automation）=====

  // 渲染进程可能被注入内容污染（XSS via markdown / MCP tool output），主进程必须自己校验入参，
  // 否则 NaN / -Infinity / 越界值会污染 ~/.proma/automations.json，无法回滚。
  const isNonEmptyString = (v: unknown): v is string => typeof v === 'string' && v.length > 0
  const isNonBlankString = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0
  const isFiniteInt = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && Number.isInteger(v)
  const validScheduleType = (v: unknown): v is 'interval' | 'daily' | 'weekly' | 'monthly' | 'once' =>
    v === 'interval' || v === 'daily' || v === 'weekly' || v === 'monthly' || v === 'once'
  const validPermissionMode = (v: unknown): v is 'bypassPermissions' =>
    v === 'bypassPermissions'
  const validAutomationNotificationTrigger = (v: unknown): v is 'always' | 'success' | 'error' =>
    v === 'always' || v === 'success' || v === 'error'
  const validTimeOfDay = (v: unknown): boolean => typeof v === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(v)

  const validateAutomationNotificationTargets = (targets: unknown): void => {
    if (targets === undefined) return
    if (!Array.isArray(targets)) throw new Error('notificationTargets 必须是数组')
    if (targets.length > 5) throw new Error('notificationTargets 最多 5 个')

    for (const target of targets) {
      if (!target || typeof target !== 'object') throw new Error('notificationTargets 包含非法目标')
      const t = target as Record<string, unknown>
      if (t.type !== 'feishu') throw new Error(`不支持的通知目标: ${String(t.type)}`)
      if (typeof t.enabled !== 'boolean') throw new Error('notificationTargets.enabled 必须是 boolean')
      if (!validAutomationNotificationTrigger(t.trigger)) {
        throw new Error(`非法的 notificationTargets.trigger: ${String(t.trigger)}`)
      }
      if (!isNonEmptyString(t.botId)) throw new Error('notificationTargets.botId 必填')
      if (!isNonEmptyString(t.chatId)) throw new Error('notificationTargets.chatId 必填')
    }
  }

  const validateAutomationFields = (i: Partial<CreateAutomationInput | UpdateAutomationInput>): void => {
    if (i.scheduleType !== undefined && !validScheduleType(i.scheduleType)) {
      throw new Error(`非法的 scheduleType: ${String(i.scheduleType)}`)
    }
    if (i.intervalMinutes !== undefined && (!isFiniteInt(i.intervalMinutes) || i.intervalMinutes < 1)) {
      throw new Error(`非法的 intervalMinutes: ${String(i.intervalMinutes)}`)
    }
    if (i.timeOfDay !== undefined && !validTimeOfDay(i.timeOfDay)) {
      throw new Error(`非法的 timeOfDay: ${String(i.timeOfDay)}`)
    }
    if (i.activeWindowStart !== undefined && i.activeWindowStart !== null && !validTimeOfDay(i.activeWindowStart)) {
      throw new Error(`非法的 activeWindowStart: ${String(i.activeWindowStart)}`)
    }
    if (i.activeWindowEnd !== undefined && i.activeWindowEnd !== null && !validTimeOfDay(i.activeWindowEnd)) {
      throw new Error(`非法的 activeWindowEnd: ${String(i.activeWindowEnd)}`)
    }
    if (i.activeWeekdays !== undefined && i.activeWeekdays !== null && (!Array.isArray(i.activeWeekdays) || i.activeWeekdays.some((day) => !isFiniteInt(day) || day < 0 || day > 6))) {
      throw new Error(`非法的 activeWeekdays: ${String(i.activeWeekdays)}`)
    }
    if (i.dayOfWeek !== undefined && (!isFiniteInt(i.dayOfWeek) || i.dayOfWeek < 0 || i.dayOfWeek > 6)) {
      throw new Error(`非法的 dayOfWeek: ${String(i.dayOfWeek)}`)
    }
    if (i.dayOfMonth !== undefined && (!isFiniteInt(i.dayOfMonth) || i.dayOfMonth < 1 || i.dayOfMonth > 31)) {
      throw new Error(`非法的 dayOfMonth: ${String(i.dayOfMonth)}`)
    }
    if (i.scheduledAt !== undefined && (typeof i.scheduledAt !== 'number' || !Number.isFinite(i.scheduledAt) || i.scheduledAt <= 0)) {
      throw new Error(`非法的 scheduledAt: ${String(i.scheduledAt)}`)
    }
    if (i.maxRuns !== undefined && i.maxRuns !== null && (!isFiniteInt(i.maxRuns) || i.maxRuns < 1)) {
      throw new Error(`非法的 maxRuns: ${String(i.maxRuns)}`)
    }
    if (i.permissionMode !== undefined && !validPermissionMode(i.permissionMode)) {
      throw new Error(`非法的 permissionMode: ${String(i.permissionMode)}`)
    }
    if (i.sessionMode !== undefined && i.sessionMode !== 'daily' && i.sessionMode !== 'reuse') {
      throw new Error(`非法的 sessionMode: ${String(i.sessionMode)}`)
    }
    validateAutomationNotificationTargets(i.notificationTargets)
  }

  const validateAutomationScheduleComplete = (
    input: Partial<CreateAutomationInput | UpdateAutomationInput>,
    existing?: Automation,
  ): void => {
    const scheduleType = input.scheduleType ?? existing?.scheduleType
    if (!scheduleType) throw new Error('scheduleType 必填')
    validateExplicitAutomationScheduleFields(input, scheduleType)
    const effective = getEffectiveAutomationScheduleFields(input, existing)
    if (effective.scheduleType === 'interval') {
      if (!isFiniteInt(effective.intervalMinutes) || effective.intervalMinutes < 1) throw new Error('scheduleType=interval 时 intervalMinutes 必填')
    }
    if ((effective.activeWindowStart === undefined) !== (effective.activeWindowEnd === undefined)) {
      throw new Error('activeWindowStart 与 activeWindowEnd 必须同时设置或同时清除')
    }
    if (effective.activeWeekdays !== undefined && effective.activeWeekdays.length > 0 && effective.scheduleType !== 'interval') {
      throw new Error('周内运行日限制仅支持 scheduleType=interval')
    }
    if (effective.activeWindowStart !== undefined && effective.activeWindowEnd !== undefined) {
      if (effective.scheduleType !== 'interval') throw new Error('每日执行窗口仅支持 scheduleType=interval')
      if (!validTimeOfDay(effective.activeWindowStart) || !validTimeOfDay(effective.activeWindowEnd) || effective.activeWindowStart >= effective.activeWindowEnd) {
        throw new Error('每日执行窗口必须是同一天内有效的 HH:MM 范围，且开始早于结束')
      }
    }
    if (effective.scheduleType === 'daily' || effective.scheduleType === 'weekly' || effective.scheduleType === 'monthly') {
      if (!validTimeOfDay(effective.timeOfDay)) throw new Error('scheduleType=daily/weekly/monthly 时 timeOfDay 必填')
    }
    if (effective.scheduleType === 'weekly' && !isFiniteInt(effective.dayOfWeek)) {
      throw new Error('scheduleType=weekly 时 dayOfWeek 必填')
    }
    if (effective.scheduleType === 'monthly' && !isFiniteInt(effective.dayOfMonth)) {
      throw new Error('scheduleType=monthly 时 dayOfMonth 必填')
    }
    if (effective.scheduleType === 'once' && (typeof effective.scheduledAt !== 'number' || !Number.isFinite(effective.scheduledAt) || effective.scheduledAt <= 0)) {
      throw new Error('scheduleType=once 时 scheduledAt 必填')
    }
  }

  ipcMain.handle(
    AUTOMATION_IPC_CHANNELS.LIST,
    async (): Promise<Automation[]> => listAutomations()
  )

  ipcMain.handle(
    AUTOMATION_IPC_CHANNELS.CREATE,
    async (_, input: CreateAutomationInput): Promise<Automation> => {
      if (!input || typeof input !== 'object') throw new Error('input 必须是对象')
      if (!isNonEmptyString(input.name)) throw new Error('name 必填')
      if (!isNonEmptyString(input.prompt)) throw new Error('prompt 必填')
      // channelId / workspaceId 允许为空（草稿态），但此时任务不能被启用
      validateAutomationFields(input)
      validateAutomationScheduleComplete(input)
      const a = createAutomation(input)
      broadcastAutomationsChanged()
      return a
    }
  )

  ipcMain.handle(
    AUTOMATION_IPC_CHANNELS.UPDATE,
    async (_, input: UpdateAutomationInput): Promise<Automation | undefined> => {
      if (!input || typeof input !== 'object') throw new Error('input 必须是对象')
      if (!isNonEmptyString(input.id)) throw new Error('id 必填')
      if (input.name !== undefined && !isNonBlankString(input.name)) throw new Error('name 不能为空')
      if (input.prompt !== undefined && !isNonBlankString(input.prompt)) throw new Error('prompt 不能为空')
      const existing = getAutomation(input.id)
      if (!existing) return undefined
      validateAutomationFields(input)
      validateAutomationScheduleComplete(input, existing)
      const a = updateAutomation(input)
      broadcastAutomationsChanged()
      return a
    }
  )

  ipcMain.handle(
    AUTOMATION_IPC_CHANNELS.DELETE,
    async (_, id: string): Promise<boolean> => {
      if (!isNonEmptyString(id)) throw new Error('id 必填')
      const ok = deleteAutomation(id)
      broadcastAutomationsChanged()
      return ok
    }
  )

  ipcMain.handle(
    AUTOMATION_IPC_CHANNELS.TOGGLE,
    async (_, id: string, active: boolean): Promise<Automation | undefined> => {
      if (!isNonEmptyString(id)) throw new Error('id 必填')
      if (typeof active !== 'boolean') throw new Error('active 必须是 boolean')
      const a = updateAutomation({ id, active })
      broadcastAutomationsChanged()
      return a
    }
  )

  ipcMain.handle(
    AUTOMATION_IPC_CHANNELS.RUN_NOW,
    async (_, id: string): Promise<void> => {
      if (!isNonEmptyString(id)) throw new Error('id 必填')
      await runAutomationNow(id)
    }
  )

  // ===== Agent Island =====

  // Renderer 在主窗口创建后即可上报“已查看”，而 Island 状态机稍后才初始化，
  // 且在不支持的平台也不会初始化。handler 必须在 IPC 注册阶段无条件存在，避免启动竞态。
  ipcMain.handle(
    AGENT_ISLAND_IPC_CHANNELS.MARK_SESSION_VIEWED,
    async (_, sessionId: unknown): Promise<void> => {
      if (!isNonEmptyString(sessionId)) return
      requireVisibleSession(sessionId)
      markAgentIslandSessionViewed(sessionId)
    }
  )

  // ===== 用户授权的 Markdown Vault =====

  ipcMain.handle(VAULT_IPC_CHANNELS.GET_CONFIG, async () => getVaultSummary())

  ipcMain.handle(VAULT_IPC_CHANNELS.SELECT_DEFAULT, async () => selectDefaultVault())

  ipcMain.handle(VAULT_IPC_CHANNELS.LIST_CANDIDATES, async () => discoverVaultCandidates())

  ipcMain.handle(VAULT_IPC_CHANNELS.SELECT, async (_, options: unknown) => {
    const input = options && typeof options === 'object' ? options as Record<string, unknown> : {}
    const inboxPath = typeof input.inboxPath === 'string' ? input.inboxPath : undefined
    const allowAgentWrites = input.allowAgentWrites === true
    const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
    if (!win) return null
    const result = await dialog.showOpenDialog(win, {
      properties: ['openDirectory'],
      title: '选择 Vault 文件夹',
    })
    if (result.canceled || result.filePaths.length === 0) return null
    return configureVault(result.filePaths[0]!, { inboxPath, allowAgentWrites })
  })

  ipcMain.handle(VAULT_IPC_CHANNELS.AUTHORIZE_CANDIDATE, async (_, rootPath: unknown, options: unknown) => {
    if (typeof rootPath !== 'string') throw new Error('Vault 候选路径非法')
    const input = options && typeof options === 'object' ? options as Record<string, unknown> : {}
    return authorizeDiscoveredVault(rootPath, {
      inboxPath: typeof input.inboxPath === 'string' ? input.inboxPath : undefined,
      allowAgentWrites: input.allowAgentWrites === true,
    })
  })


  ipcMain.handle(VAULT_IPC_CHANNELS.LIST_FILES, async () => getConfiguredVaultFileSystem().listFiles())

  ipcMain.handle(VAULT_IPC_CHANNELS.READ_FILE, async (_, relativePath: unknown) => {
    if (typeof relativePath !== 'string') throw new Error('Vault relativePath 必填')
    return getConfiguredVaultFileSystem().readFile(relativePath)
  })

  ipcMain.handle(VAULT_IPC_CHANNELS.WRITE_FILE, async (_, input: unknown) => {
    if (!input || typeof input !== 'object') throw new Error('Vault 写入参数非法')
    const value = input as Record<string, unknown>
    if (typeof value.relativePath !== 'string' || typeof value.content !== 'string') {
      throw new Error('Vault relativePath 和 content 必填')
    }
    return getConfiguredVaultFileSystem().writeFile({
      relativePath: value.relativePath,
      content: value.content,
      expectedSha256: typeof value.expectedSha256 === 'string' ? value.expectedSha256 : undefined,
      createOnly: value.createOnly === true,
    })
  })


  ipcMain.handle(VAULT_IPC_CHANNELS.CREATE_UNTITLED_FILE, async () => createUntitledVaultFile())

  ipcMain.handle(VAULT_IPC_CHANNELS.CREATE_UNTITLED_FILE_IN_FOLDER, async (_, folderPath: unknown) => {
    if (typeof folderPath !== 'string') throw new Error('Vault 文件夹路径非法')
    return createUntitledVaultFileInFolder(folderPath)
  })

  ipcMain.handle(VAULT_IPC_CHANNELS.CREATE_FOLDER, async (_, relativePath: unknown): Promise<void> => {
    if (typeof relativePath !== 'string') throw new Error('Vault 文件夹路径非法')
    createVaultFolder(relativePath)
  })

  ipcMain.handle(VAULT_IPC_CHANNELS.RENAME_FILE, async (_, input: unknown) => {
    if (!input || typeof input !== 'object') throw new Error('Vault 重命名参数非法')
    const value = input as Record<string, unknown>
    if (typeof value.relativePath !== 'string' || typeof value.name !== 'string') {
      throw new Error('Vault relativePath 和 name 必填')
    }
    return getConfiguredVaultFileSystem().renameFile({
      relativePath: value.relativePath,
      name: value.name,
      expectedSha256: typeof value.expectedSha256 === 'string' ? value.expectedSha256 : undefined,
    })
  })

  ipcMain.handle(VAULT_IPC_CHANNELS.DELETE_FILE, async (_, input: unknown): Promise<void> => {
    if (!input || typeof input !== 'object') throw new Error('Vault 删除参数非法')
    const value = input as Record<string, unknown>
    if (typeof value.relativePath !== 'string') throw new Error('Vault relativePath 必填')
    getConfiguredVaultFileSystem().deleteFile({
      relativePath: value.relativePath,
      expectedSha256: typeof value.expectedSha256 === 'string' ? value.expectedSha256 : undefined,
    })
  })



  ipcMain.handle(VAULT_IPC_CHANNELS.SET_USER_CONTEXT, async (_, sessionId: unknown, focus: unknown, open: unknown): Promise<void> => {
    if (typeof sessionId !== 'string' || sessionId.trim().length === 0) throw new Error('Vault 会话 ID 非法')
    requireVisibleSession(sessionId)
    if (open === false || focus === null || focus === undefined) {
      clearVaultUserContext(sessionId)
      return
    }
    if (!focus || typeof focus !== 'object') throw new Error('Vault focus 非法')
    const value = focus as Record<string, unknown>
    if (
      (value.kind !== 'file' && value.kind !== 'folder')
      || typeof value.relativePath !== 'string'
      || !Number.isSafeInteger(value.sequence)
    ) {
      throw new Error('Vault focus 非法')
    }
    setVaultUserContext(sessionId, {
      kind: value.kind,
      relativePath: value.relativePath,
      sequence: value.sequence as number,
    })
  })

  // ===== Windows Agent Island =====

  ipcMain.handle(
    WINDOWS_AGENT_ISLAND_IPC_CHANNELS.OPEN_SESSION,
    async (_, sessionId: unknown, title: unknown): Promise<void> => {
      if (!isNonEmptyString(sessionId)) return
      requireVisibleSession(sessionId)
      markAgentIslandSessionViewed(sessionId)
      const { getMainWindow } = await import('./index')
      const mainWindow = getMainWindow()
      if (!mainWindow) return
      mainWindow.webContents.send(TRAY_IPC_CHANNELS.OPEN_AGENT_SESSION, {
        sessionId,
        title: typeof title === 'string' ? title : '',
      })
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.show()
      mainWindow.focus()
    }
  )

  ipcMain.on(WINDOWS_AGENT_ISLAND_IPC_CHANNELS.MOUSE_ENTER, () => {
    getAgentStatusHoverWindow().onHoverMouseEnter()
  })
  ipcMain.on(WINDOWS_AGENT_ISLAND_IPC_CHANNELS.MOUSE_LEAVE, () => {
    getAgentStatusHoverWindow().onHoverMouseLeave()
  })
}
