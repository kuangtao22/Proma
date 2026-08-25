import { describe, expect, test } from 'bun:test'
import { closeSync, constants, existsSync, fstatSync, ftruncateSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import type { AgentSessionMeta, FileAccessOptions } from '@proma/shared'
import ts from 'typescript'
import { requireUserVisibleAgentSession } from './agent-session-visibility'

/** 普通会话 handler 中允许出现在可见性 guard 之前的纯参数校验调用。 */
const PURE_VALIDATION_CALLS = new Set([
  'Array.isArray',
  'Number.isFinite',
  'Number.isSafeInteger',
  'Object.keys',
  'String',
  'Math.min',
  'isPromaPermissionMode',
  'normalizeFileAccessOptions',
  'validThinkingLevels.includes',
])

/** 参数名为 id、且语义上表示 Agent session 的既有通道。 */
const SESSION_ID_ALIAS_CHANNELS = new Set([
  'GET_SDK_MESSAGES',
  'UPDATE_TITLE',
  'UPDATE_SESSION_MODEL',
  'DELETE_SESSION',
  'TOGGLE_PIN',
  'TOGGLE_STAR',
  'CLEAR_COMPLETION_STATE',
  'TOGGLE_ARCHIVE',
])

/** 参数名为 id、但语义上表示 workspace 等非 session 身份的通道。 */
const NON_SESSION_ID_ALIAS_CHANNELS = new Set([
  'DELETE_WORKSPACE',
  'RELINK_WORKSPACE_PROJECT_ROOT',
  'RESTORE_WORKSPACE_PROJECT_ROOT',
  'SET_BUILTIN_MCP_ENABLED',
  'UPDATE_WORKSPACE',
])

/** requestId 间接指向 session，必须先查 owner 再验证的响应通道。 */
const OWNER_RESPONSE_CHANNELS = new Set([
  'PERMISSION_RESPOND',
  'ASK_USER_RESPOND',
  'EXIT_PLAN_MODE_RESPOND',
])

/** 不带 session 参数、但返回的 pending 项必须按 owner 可见性过滤。 */
const FILTERED_SNAPSHOT_CHANNELS = new Set(['GET_PENDING_REQUESTS'])

/** 直接读写本地路径的非 Agent 通道，必须纳入同一文件访问边界。 */
const NON_AGENT_FILE_CHANNELS = new Set([
  'GET_GIT_REPO_STATUS',
  'GET_UNSTAGED_CHANGES',
  'GET_FILE_DIFF',
  'GET_UNTRACKED_CONTENT',
  'REVERT_FILE',
  'GET_DIFF_CONTENTS',
  'LIST_WORKTREES',
  'GET_WORKTREE_CHANGES',
  'OPEN_DETACHED_PREVIEW',
  'SYSTEM_OPEN_FILE',
  'GET_DEFAULT_APP_FOR_FILE',
  'file:resolve-and-read',
  'file:write-text',
  'file:resolve-path',
  'file:resolve-html-preview-path',
  'file:prepare-pdf-preview',
  'file:docx-to-html',
  'file:office-to-html',
  'file:read-binary-base64',
])

/** 显式展开 namespace/channel，新增 handler 必须先完成安全语义登记。 */
function defineRendererHandlerKeys(namespace: string, channels: readonly string[]): string[] {
  return channels.map((channel) => `${namespace}:${channel}`)
}

/** ipc.ts 当前全部 Renderer handler 的审计基线；严禁按参数名动态推断分类。 */
const ALL_RENDERER_HANDLER_KEYS = [
  ...defineRendererHandlerKeys('AGENT_IPC_CHANNELS', [
    'ADD_WORKTREE_REPO',
    'APPROVE_WORKSPACE_PROJECT_KNOWLEDGE_MAINTENANCE',
    'ASK_USER_RESPOND',
    'ATTACH_DIRECTORY',
    'ATTACH_FILE',
    'ATTACH_WORKSPACE_DIRECTORY',
    'ATTACH_WORKSPACE_FILE',
    'BATCH_IMPORT_SKILLS_FROM_WORKSPACES',
    'CANCEL_QUEUED_MESSAGE',
    'CHECK_PATHS_TYPE',
    'CLEAR_COMPLETION_STATE',
    'CLOSE_BROWSER',
    'CLOSE_BROWSER_TAB',
    'CONFIRM_WORKSPACE_MEMORY_WINDOW_CLOSE',
    'COUNT_ARCHIVED_SESSIONS',
    'CREATE_BROWSER_TAB',
    'CREATE_PROJECT',
    'CREATE_SESSION',
    'CREATE_SKILL_ENTRY',
    'CREATE_WORKSPACE',
    'DELETE_FILE',
    'DELETE_SESSION',
    'DELETE_SKILL',
    'DELETE_SKILL_ENTRY',
    'DELETE_WORKSPACE',
    'DETACH_DIRECTORY',
    'DETACH_FILE',
    'DETACH_WORKSPACE_DIRECTORY',
    'DETACH_WORKSPACE_FILE',
    'ENQUEUE_QUEUED_MESSAGE',
    'EXIT_PLAN_MODE_RESPOND',
    'FORK_SESSION',
    'GENERATE_TITLE',
    'GET_BROWSER_STATE',
    'GET_CAPABILITIES',
    'GET_DEFAULT_SKILL_SLUGS',
    'GET_MCP_CONFIG',
    'GET_OTHER_WORKSPACE_SKILLS',
    'GET_PENDING_REQUESTS',
    'GET_PI_REASONING_CAPABILITY',
    'GET_SDK_MESSAGES',
    'GET_SESSION_PATH',
    'GET_SKILLS',
    'GET_SKILLS_DIR',
    'GET_WORKSPACE_ATTACHED_FILES',
    'GET_WORKSPACE_DIRECTORIES',
    'GET_WORKSPACE_FILES_PATH',
    'GET_WORKSPACE_MEMORY_SUMMARY',
    'GET_WORKTREE_REPOS',
    'GO_BACK_BROWSER',
    'GO_FORWARD_BROWSER',
    'IMPORT_SKILL_FROM_WORKSPACE',
    'LIST_ACTIVE_SESSIONS',
    'LIST_ARCHIVED_SESSIONS',
    'LIST_ATTACHED_DIRECTORY',
    'LIST_BROWSER_TABS',
    'LIST_DIRECTORY',
    'LIST_SESSIONS',
    'LIST_SKILL_FILES',
    'LIST_WORKSPACES',
    'LIST_WORKSPACE_AUTO_MEMORY_FILES',
    'MIGRATE_CHAT_TO_AGENT',
    'MINIMIZE_BROWSER',
    'MOVE_ATTACHED_FILE',
    'MOVE_FILE',
    'MOVE_QUEUED_MESSAGE',
    'MOVE_SESSION_TO_WORKSPACE',
    'NAVIGATE_BROWSER',
    'OPEN_BROWSER',
    'OPEN_FILE',
    'OPEN_FILE_OR_FOLDER_DIALOG',
    'OPEN_FOLDER_DIALOG',
    'OPEN_FOLDER_IN_TERMINAL',
    'OPEN_WORKSPACE_MEMORY_WINDOW',
    'PERMISSION_RESPOND',
    'QUEUE_MESSAGE',
    'READ_ATTACHED_FILE',
    'READ_SKILL_CONTENT',
    'READ_SKILL_FILE',
    'READ_WORKSPACE_AGENTS_MD',
    'READ_WORKSPACE_AUTO_MEMORY_FILE',
    'RELINK_WORKSPACE_PROJECT_ROOT',
    'RELOAD_BROWSER',
    'REMOVE_WORKTREE_REPO',
    'RENAME_ATTACHED_FILE',
    'RENAME_FILE',
    'RENAME_SKILL_ENTRY',
    'REORDER_WORKSPACES',
    'RESTORE_WORKSPACE_PROJECT_ROOT',
    'REWIND_SESSION',
    'SAVE_FILES_TO_SESSION',
    'SAVE_FILES_TO_WORKSPACE',
    'SAVE_MCP_CONFIG',
    'SEARCH_MESSAGES',
    'SEARCH_SESSION_REFERENCES',
    'SEARCH_WORKSPACE_FILES',
    'SELECT_BROWSER_TAB',
    'SEND_MESSAGE',
    'SET_ACTIVE_WORKTREE',
    'SET_BROWSER_LAYOUT',
    'SET_BUILTIN_MCP_ENABLED',
    'SET_VISIBLE_STREAM_SESSION',
    'SHOW_ATTACHED_IN_FOLDER',
    'SHOW_IN_FOLDER',
    'START_WORKSPACE_MEMORY_WATCH',
    'STOP_AGENT',
    'STOP_WORKSPACE_MEMORY_WATCH',
    'SUBMIT_OR_ENQUEUE_MESSAGE',
    'TEST_MCP_SERVER',
    'TOGGLE_ARCHIVE',
    'TOGGLE_PIN',
    'TOGGLE_SKILL',
    'TOGGLE_STAR',
    'UPDATE_SESSION_CODEX_FAST_MODE',
    'UPDATE_SESSION_MODEL',
    'UPDATE_SESSION_PERMISSION_MODE',
    'UPDATE_SESSION_REASONING_LEVEL',
    'UPDATE_SKILL_FROM_SOURCE',
    'UPDATE_TITLE',
    'UPDATE_WORKSPACE',
    'WORKSPACE_MEMORY_WINDOW_READY',
    'WRITE_CLIPBOARD_PREVIEW',
    'WRITE_SKILL_CONTENT',
    'WRITE_SKILL_FILE',
    'WRITE_WORKSPACE_AGENTS_MD',
    'WRITE_WORKSPACE_AUTO_MEMORY_FILE',
  ]),
  ...defineRendererHandlerKeys('APP_ICON_IPC_CHANNELS', [
    'SET',
  ]),
  ...defineRendererHandlerKeys('AUTOMATION_IPC_CHANNELS', [
    'CREATE',
    'DELETE',
    'LIST',
    'RUN_NOW',
    'TOGGLE',
    'UPDATE',
  ]),
  ...defineRendererHandlerKeys('CHANNEL_IPC_CHANNELS', [
    'CODEX_OAUTH_CANCEL',
    'CODEX_OAUTH_LOGIN',
    'CREATE',
    'DECRYPT_KEY',
    'DELETE',
    'FETCH_MODELS',
    'GET_PLAN_QUOTA',
    'LIST',
    'TEST',
    'TEST_DIRECT',
    'UPDATE',
    'XAI_OAUTH_CANCEL',
    'XAI_OAUTH_LOGIN',
  ]),
  ...defineRendererHandlerKeys('CHAT_IPC_CHANNELS', [
    'CREATE_CONVERSATION',
    'CREATE_WELCOME_CONVERSATION',
    'DELETE_ATTACHMENT',
    'DELETE_CONVERSATION',
    'DELETE_MESSAGE',
    'EXTRACT_ATTACHMENT_TEXT',
    'GENERATE_TITLE',
    'GET_MESSAGES',
    'GET_RECENT_MESSAGES',
    'GET_TUTORIAL_CONTENT',
    'LIST_CONVERSATIONS',
    'OPEN_FILE_DIALOG',
    'READ_ATTACHMENT',
    'SAVE_ATTACHMENT',
    'SAVE_IMAGE_AS',
    'SAVE_RESOURCE_FILE_AS',
    'SEARCH_MESSAGES',
    'SEND_MESSAGE',
    'STOP_GENERATION',
    'TOGGLE_ARCHIVE',
    'TOGGLE_PIN',
    'TRUNCATE_MESSAGES_FROM',
    'UPDATE_CONTEXT_DIVIDERS',
    'UPDATE_MODEL',
    'UPDATE_TITLE',
  ]),
  ...defineRendererHandlerKeys('CHAT_TOOL_IPC_CHANNELS', [
    'CREATE_CUSTOM_TOOL',
    'DELETE_CUSTOM_TOOL',
    'GET_ALL_TOOLS',
    'GET_TOOL_CREDENTIALS',
    'TEST_TOOL',
    'UPDATE_TOOL_CREDENTIALS',
    'UPDATE_TOOL_STATE',
  ]),
  ...defineRendererHandlerKeys('DINGTALK_IPC_CHANNELS', [
    'GET_BOT_DECRYPTED_SECRET',
    'GET_CONFIG',
    'GET_DECRYPTED_SECRET',
    'GET_MULTI_CONFIG',
    'GET_MULTI_STATUS',
    'GET_STATUS',
    'REMOVE_BOT',
    'SAVE_BOT_CONFIG',
    'SAVE_CONFIG',
    'START_BOT',
    'START_BRIDGE',
    'STOP_BOT',
    'STOP_BRIDGE',
    'TEST_CONNECTION',
  ]),
  ...defineRendererHandlerKeys('DOCK_BADGE_IPC_CHANNELS', [
    'SET_COUNT',
  ]),
  ...defineRendererHandlerKeys('ENVIRONMENT_IPC_CHANNELS', [
    'CHECK',
  ]),
  ...defineRendererHandlerKeys('FEISHU_IPC_CHANNELS', [
    'GET_BOT_DECRYPTED_SECRET',
    'GET_CONFIG',
    'GET_DECRYPTED_SECRET',
    'GET_MULTI_CONFIG',
    'GET_MULTI_STATUS',
    'GET_STATUS',
    'LIST_BINDINGS',
    'REGISTER_APP_CANCEL',
    'REGISTER_APP_START',
    'REMOVE_BINDING',
    'REMOVE_BOT',
    'REPORT_PRESENCE',
    'SAVE_BOT_CONFIG',
    'SAVE_CONFIG',
    'START_BOT',
    'START_BRIDGE',
    'STOP_BOT',
    'STOP_BRIDGE',
    'TEST_CONNECTION',
    'UPDATE_BINDING',
  ]),
  ...defineRendererHandlerKeys('GITHUB_RELEASE_IPC_CHANNELS', [
    'GET_LATEST_RELEASE',
    'GET_RELEASE_BY_TAG',
    'LIST_RELEASES',
  ]),
  ...defineRendererHandlerKeys('INSTALLER_IPC_CHANNELS', [
    'CANCEL',
    'DOWNLOAD',
    'LAUNCH',
    'MANIFEST',
  ]),
  ...defineRendererHandlerKeys('IPC_CHANNELS', [
    'GET_DEFAULT_APP_FOR_FILE',
    'GET_DETACHED_PREVIEW_DATA',
    'GET_DIFF_CONTENTS',
    'GET_FILE_DIFF',
    'GET_GIT_REPO_STATUS',
    'GET_RUNTIME_STATUS',
    'GET_UNSTAGED_CHANGES',
    'GET_UNTRACKED_CONTENT',
    'GET_WORKTREE_CHANGES',
    'INVALIDATE_GIT_DIFF_CACHE',
    'LIST_WORKTREES',
    'OPEN_DETACHED_PREVIEW',
    'OPEN_EXTERNAL',
    'REINIT_RUNTIME',
    'REVERT_FILE',
    'SCAN_EDITORS',
    'SCREENSHOT_CAPTURE',
    'SHOW_ITEM_IN_FOLDER',
    'SYSTEM_OPEN_FILE',
    'WINDOW_CLOSE',
    'WINDOW_IS_MAXIMIZED',
    'WINDOW_MAXIMIZE',
    'WINDOW_MINIMIZE',
    'WRITE_CLIPBOARD_TEXT',
  ]),
  ...defineRendererHandlerKeys('PLANNING_IPC_CHANNELS', [
    'ACKNOWLEDGE_REMINDER',
    'CONNECT_NATIVE_CONNECTION',
    'CREATE_CALENDAR_EVENT',
    'CREATE_GROUP',
    'CREATE_TODO',
    'DELETE_CALENDAR_EVENT',
    'DELETE_GROUP',
    'DELETE_TODO',
    'DISCONNECT_NATIVE_CONNECTION',
    'GET_NATIVE_SYNC_STATUS',
    'LIST_ACTIVE_REMINDERS',
    'LIST_CALENDAR_EVENTS',
    'LIST_GROUPS',
    'LIST_NATIVE_CONNECTIONS',
    'LIST_NATIVE_CONNECTION_TARGETS',
    'LIST_NATIVE_SYNC_CONFLICTS',
    'LIST_NATIVE_SYNC_TARGETS',
    'LIST_SYNC_PROFILES',
    'LIST_TAGS',
    'LIST_TODOS',
    'OPEN_NATIVE_SYNC_PRIVACY_SETTINGS',
    'OPEN_WINDOW',
    'REQUEST_NATIVE_SYNC_ACCESS',
    'RESOLVE_NATIVE_SYNC_CONFLICT',
    'SAVE_SYNC_PROFILE',
    'SNOOZE_REMINDER',
    'START_TODO_AGENT',
    'UPDATE_CALENDAR_EVENT',
    'UPDATE_GROUP',
    'UPDATE_TODO',
  ]),
  ...defineRendererHandlerKeys('PROXY_IPC_CHANNELS', [
    'DETECT_SYSTEM',
    'GET_SETTINGS',
    'UPDATE_SETTINGS',
  ]),
  ...defineRendererHandlerKeys('QUICK_TASK_IPC_CHANNELS', [
    'GET_GLOBAL_SHORTCUT_REGISTRATION_STATUS',
    'HIDE',
    'REREGISTER_GLOBAL_SHORTCUTS',
    'SUBMIT',
  ]),
  ...defineRendererHandlerKeys('SCRATCH_PAD_IPC_CHANNELS', [
    'CHOOSE_EXPORT_PATH',
    'COPY_IMAGE',
    'EXPORT',
    'LOAD',
    'SAVE',
  ]),
  ...defineRendererHandlerKeys('SETTINGS_IPC_CHANNELS', [
    'GET',
    'GET_SYSTEM_THEME',
    'UPDATE',
  ]),
  ...defineRendererHandlerKeys('STORAGE_IPC_CHANNELS', [
    'CLEANUP',
    'CLEANUP_TEMP',
    'GET_STATS',
  ]),
  ...defineRendererHandlerKeys('SYSTEM_PROMPT_IPC_CHANNELS', [
    'CREATE',
    'DELETE',
    'GET_CONFIG',
    'SET_DEFAULT',
    'UPDATE',
    'UPDATE_APPEND_SETTING',
  ]),
  ...defineRendererHandlerKeys('USER_PROFILE_IPC_CHANNELS', [
    'GET',
    'UPDATE',
  ]),
  ...defineRendererHandlerKeys('VOICE_DICTATION_IPC_CHANNELS', [
    'CANCEL',
    'CHECK_MIC_PERMISSION',
    'COMMIT',
    'GET_SETTINGS',
    'HIDE',
    'PREVIEW',
    'REQUEST_MIC_PERMISSION',
    'RESIZE',
    'SEND_AUDIO',
    'START',
    'STOP',
    'TEST_CONNECTION',
    'TOGGLE',
    'UPDATE_SETTINGS',
  ]),
  ...defineRendererHandlerKeys('WECHAT_IPC_CHANNELS', [
    'GET_CONFIG',
    'GET_STATUS',
    'LOGOUT',
    'START_BRIDGE',
    'START_LOGIN',
    'STOP_BRIDGE',
  ]),
  ...defineRendererHandlerKeys('WINDOWS_AGENT_ISLAND_IPC_CHANNELS', [
    'OPEN_SESSION',
  ]),
  ...defineRendererHandlerKeys('literal', [
    'file:docx-to-html',
    'file:office-to-html',
    'file:prepare-pdf-preview',
    'file:read-binary-base64',
    'file:resolve-and-read',
    'file:resolve-html-preview-path',
    'file:resolve-path',
    'file:write-text',
  ]),
]


type RendererHandlerPolicy =
  | { kind: 'agent-session' | 'path', guards: readonly string[] }
  | { kind: 'exempt', reason: string }

/** 敏感入口逐 key 声明其 guard；其余显式 key 必须提供豁免语义。 */
const GUARDED_RENDERER_HANDLER_POLICIES: Record<string, RendererHandlerPolicy> = {
  'AGENT_IPC_CHANNELS:ASK_USER_RESPOND': { kind: 'agent-session', guards: ['requireVisibleSession'] },
  'AGENT_IPC_CHANNELS:ATTACH_DIRECTORY': { kind: 'agent-session', guards: ['requireVisibleSession'] },
  'AGENT_IPC_CHANNELS:ATTACH_FILE': { kind: 'agent-session', guards: ['requireVisibleSession'] },
  'AGENT_IPC_CHANNELS:CANCEL_QUEUED_MESSAGE': { kind: 'agent-session', guards: ['requireVisibleSession'] },
  'AGENT_IPC_CHANNELS:CHECK_PATHS_TYPE': { kind: 'path', guards: ['requireVisibleFileAccess'] },
  'AGENT_IPC_CHANNELS:CLEAR_COMPLETION_STATE': { kind: 'agent-session', guards: ['requireVisibleSession'] },
  'AGENT_IPC_CHANNELS:CLOSE_BROWSER': { kind: 'agent-session', guards: ['assertBrowserSessionAccess'] },
  'AGENT_IPC_CHANNELS:CLOSE_BROWSER_TAB': { kind: 'agent-session', guards: ['assertBrowserSessionAccess'] },
  'AGENT_IPC_CHANNELS:CREATE_BROWSER_TAB': { kind: 'agent-session', guards: ['assertBrowserSessionAccess'] },
  'AGENT_IPC_CHANNELS:DELETE_FILE': { kind: 'path', guards: ['requireVisibleFileAccess'] },
  'AGENT_IPC_CHANNELS:DELETE_SESSION': { kind: 'agent-session', guards: ['requireVisibleSession'] },
  'AGENT_IPC_CHANNELS:DETACH_DIRECTORY': { kind: 'agent-session', guards: ['requireVisibleSession'] },
  'AGENT_IPC_CHANNELS:DETACH_FILE': { kind: 'agent-session', guards: ['requireVisibleSession'] },
  'AGENT_IPC_CHANNELS:ENQUEUE_QUEUED_MESSAGE': { kind: 'agent-session', guards: ['requireVisibleSession'] },
  'AGENT_IPC_CHANNELS:EXIT_PLAN_MODE_RESPOND': { kind: 'agent-session', guards: ['requireVisibleSession'] },
  'AGENT_IPC_CHANNELS:FORK_SESSION': { kind: 'agent-session', guards: ['requireVisibleSession'] },
  'AGENT_IPC_CHANNELS:GET_BROWSER_STATE': { kind: 'agent-session', guards: ['assertBrowserSessionAccess'] },
  'AGENT_IPC_CHANNELS:GET_PENDING_REQUESTS': { kind: 'agent-session', guards: ['getUserVisiblePendingRequests'] },
  'AGENT_IPC_CHANNELS:GET_SDK_MESSAGES': { kind: 'agent-session', guards: ['requireVisibleSession'] },
  'AGENT_IPC_CHANNELS:GET_SESSION_PATH': { kind: 'agent-session', guards: ['requireVisibleSession'] },
  'AGENT_IPC_CHANNELS:GO_BACK_BROWSER': { kind: 'agent-session', guards: ['assertBrowserSessionAccess'] },
  'AGENT_IPC_CHANNELS:GO_FORWARD_BROWSER': { kind: 'agent-session', guards: ['assertBrowserSessionAccess'] },
  'AGENT_IPC_CHANNELS:LIST_ATTACHED_DIRECTORY': { kind: 'path', guards: ['requireVisibleFileAccess'] },
  'AGENT_IPC_CHANNELS:LIST_BROWSER_TABS': { kind: 'agent-session', guards: ['assertBrowserSessionAccess'] },
  'AGENT_IPC_CHANNELS:LIST_DIRECTORY': { kind: 'path', guards: ['requireVisibleFileAccess'] },
  'AGENT_IPC_CHANNELS:MIGRATE_CHAT_TO_AGENT': { kind: 'agent-session', guards: ['requireVisibleSession'] },
  'AGENT_IPC_CHANNELS:MINIMIZE_BROWSER': { kind: 'agent-session', guards: ['assertBrowserSessionAccess'] },
  'AGENT_IPC_CHANNELS:MOVE_ATTACHED_FILE': { kind: 'path', guards: ['requireVisibleFileAccess'] },
  'AGENT_IPC_CHANNELS:MOVE_FILE': { kind: 'path', guards: ['requireVisibleFileAccess'] },
  'AGENT_IPC_CHANNELS:MOVE_QUEUED_MESSAGE': { kind: 'agent-session', guards: ['requireVisibleSession'] },
  'AGENT_IPC_CHANNELS:MOVE_SESSION_TO_WORKSPACE': { kind: 'agent-session', guards: ['requireVisibleSession'] },
  'AGENT_IPC_CHANNELS:NAVIGATE_BROWSER': { kind: 'agent-session', guards: ['assertBrowserSessionAccess'] },
  'AGENT_IPC_CHANNELS:OPEN_BROWSER': { kind: 'agent-session', guards: ['assertBrowserSessionAccess'] },
  'AGENT_IPC_CHANNELS:OPEN_FILE': { kind: 'path', guards: ['requireVisibleFileAccess'] },
  'AGENT_IPC_CHANNELS:OPEN_FOLDER_IN_TERMINAL': { kind: 'path', guards: ['requireVisibleFileAccess'] },
  'AGENT_IPC_CHANNELS:PERMISSION_RESPOND': { kind: 'agent-session', guards: ['requireVisibleSession'] },
  'AGENT_IPC_CHANNELS:QUEUE_MESSAGE': { kind: 'agent-session', guards: ['requireVisibleSession'] },
  'AGENT_IPC_CHANNELS:READ_ATTACHED_FILE': { kind: 'path', guards: ['requireVisibleFileReadAccess'] },
  'AGENT_IPC_CHANNELS:RELOAD_BROWSER': { kind: 'agent-session', guards: ['assertBrowserSessionAccess'] },
  'AGENT_IPC_CHANNELS:RENAME_ATTACHED_FILE': { kind: 'path', guards: ['requireVisibleFileAccess'] },
  'AGENT_IPC_CHANNELS:RENAME_FILE': { kind: 'path', guards: ['requireVisibleFileAccess'] },
  'AGENT_IPC_CHANNELS:REWIND_SESSION': { kind: 'agent-session', guards: ['requireVisibleSession'] },
  'AGENT_IPC_CHANNELS:SAVE_FILES_TO_SESSION': { kind: 'agent-session', guards: ['requireVisibleSession'] },
  'AGENT_IPC_CHANNELS:SEARCH_WORKSPACE_FILES': { kind: 'path', guards: ['requireVisibleFileAccess'] },
  'AGENT_IPC_CHANNELS:SELECT_BROWSER_TAB': { kind: 'agent-session', guards: ['assertBrowserSessionAccess'] },
  'AGENT_IPC_CHANNELS:SEND_MESSAGE': { kind: 'agent-session', guards: ['requireVisibleSession'] },
  'AGENT_IPC_CHANNELS:SET_ACTIVE_WORKTREE': { kind: 'agent-session', guards: ['requireVisibleSession'] },
  'AGENT_IPC_CHANNELS:SET_BROWSER_LAYOUT': { kind: 'agent-session', guards: ['assertBrowserSessionAccess'] },
  'AGENT_IPC_CHANNELS:SET_VISIBLE_STREAM_SESSION': { kind: 'agent-session', guards: ['requireVisibleSession'] },
  'AGENT_IPC_CHANNELS:SHOW_ATTACHED_IN_FOLDER': { kind: 'path', guards: ['requireVisibleFileAccess'] },
  'AGENT_IPC_CHANNELS:SHOW_IN_FOLDER': { kind: 'path', guards: ['requireVisibleFileAccess'] },
  'AGENT_IPC_CHANNELS:STOP_AGENT': { kind: 'agent-session', guards: ['requireVisibleSession'] },
  'AGENT_IPC_CHANNELS:SUBMIT_OR_ENQUEUE_MESSAGE': { kind: 'agent-session', guards: ['requireVisibleSession'] },
  'AGENT_IPC_CHANNELS:TOGGLE_ARCHIVE': { kind: 'agent-session', guards: ['requireVisibleSession'] },
  'AGENT_IPC_CHANNELS:TOGGLE_PIN': { kind: 'agent-session', guards: ['requireVisibleSession'] },
  'AGENT_IPC_CHANNELS:TOGGLE_STAR': { kind: 'agent-session', guards: ['requireVisibleSession'] },
  'AGENT_IPC_CHANNELS:UPDATE_SESSION_CODEX_FAST_MODE': { kind: 'agent-session', guards: ['requireVisibleSession'] },
  'AGENT_IPC_CHANNELS:UPDATE_SESSION_MODEL': { kind: 'agent-session', guards: ['requireVisibleSession'] },
  'AGENT_IPC_CHANNELS:UPDATE_SESSION_PERMISSION_MODE': { kind: 'agent-session', guards: ['requireVisibleSession'] },
  'AGENT_IPC_CHANNELS:UPDATE_SESSION_REASONING_LEVEL': { kind: 'agent-session', guards: ['requireVisibleSession'] },
  'AGENT_IPC_CHANNELS:UPDATE_TITLE': { kind: 'agent-session', guards: ['requireVisibleSession'] },
  'FEISHU_IPC_CHANNELS:UPDATE_BINDING': { kind: 'agent-session', guards: ['requireVisibleSession'] },
  'IPC_CHANNELS:GET_DEFAULT_APP_FOR_FILE': { kind: 'path', guards: ['requireVisibleFileAccess'] },
  'IPC_CHANNELS:GET_DIFF_CONTENTS': { kind: 'path', guards: ['requireVisibleFileAccess'] },
  'IPC_CHANNELS:GET_FILE_DIFF': { kind: 'path', guards: ['requireVisibleFileAccess'] },
  'IPC_CHANNELS:GET_GIT_REPO_STATUS': { kind: 'path', guards: ['requireVisibleFileAccess'] },
  'IPC_CHANNELS:GET_UNSTAGED_CHANGES': { kind: 'path', guards: ['requireVisibleFileAccess'] },
  'IPC_CHANNELS:GET_UNTRACKED_CONTENT': { kind: 'path', guards: ['requireVisibleFileAccess'] },
  'IPC_CHANNELS:GET_WORKTREE_CHANGES': { kind: 'path', guards: ['requireVisibleFileAccess'] },
  'IPC_CHANNELS:LIST_WORKTREES': { kind: 'path', guards: ['requireVisibleFileAccess'] },
  'IPC_CHANNELS:OPEN_DETACHED_PREVIEW': { kind: 'path', guards: ['requireVisibleFileAccess'] },
  'IPC_CHANNELS:REVERT_FILE': { kind: 'path', guards: ['requireVisibleFileAccess'] },
  'IPC_CHANNELS:SHOW_ITEM_IN_FOLDER': { kind: 'path', guards: ['requireVisibleFileAccess'] },
  'IPC_CHANNELS:SYSTEM_OPEN_FILE': { kind: 'path', guards: ['requireVisibleFileAccess'] },
  'WINDOWS_AGENT_ISLAND_IPC_CHANNELS:OPEN_SESSION': { kind: 'agent-session', guards: ['requireVisibleSession'] },
  'literal:file:docx-to-html': { kind: 'path', guards: ['requireVisibleFileReadAccess'] },
  'literal:file:office-to-html': { kind: 'path', guards: ['requireVisibleFileReadAccess'] },
  'literal:file:prepare-pdf-preview': { kind: 'path', guards: ['requireVisibleFileReadAccess'] },
  'literal:file:read-binary-base64': { kind: 'path', guards: ['requireVisibleFileReadAccess'] },
  'literal:file:resolve-and-read': { kind: 'path', guards: ['requireVisibleFileReadAccess'] },
  'literal:file:resolve-html-preview-path': { kind: 'path', guards: ['Error'] },
  'literal:file:resolve-path': { kind: 'path', guards: ['requireVisibleFileReadAccess'] },
  'literal:file:write-text': { kind: 'path', guards: ['requireVisibleFileWriteAccess'] },
}

/** 各 IPC 域的显式豁免边界；只描述该域未列入 guarded 表的入口。 */
const EXEMPT_REASON_BY_NAMESPACE: Record<string, string> = {
  AGENT_IPC_CHANNELS: '入口使用 workspace、skill、dialog 或已单独验证的 request owner 能力，不接收未校验的普通 Agent sessionId/文件读取能力',
  APP_ICON_IPC_CHANNELS: '只更新应用图标，不接收 sessionId 或文件路径',
  AUTOMATION_IPC_CHANNELS: 'ID 属于 Automation 任务，不是 Agent 会话 ID；任务存储自行校验输入',
  CHANNEL_IPC_CHANNELS: 'ID 与凭据属于模型渠道配置，不是 Agent 会话或 Renderer 文件能力',
  CHAT_IPC_CHANNELS: 'session/conversation ID 属于旧 Chat 域，不是普通 Agent 会话 ID；附件由 Chat 存储边界管理',
  CHAT_TOOL_IPC_CHANNELS: 'ID 属于自定义工具配置，不是 Agent 会话或 Renderer 文件能力',
  DINGTALK_IPC_CHANNELS: 'ID 属于钉钉 Bot/连接，不是 Agent 会话或 Renderer 文件能力',
  DOCK_BADGE_IPC_CHANNELS: '只更新 Dock 数字，不接收 sessionId 或文件路径',
  ENVIRONMENT_IPC_CHANNELS: '只检查本机运行环境，不接收 sessionId 或 Renderer 文件路径',
  FEISHU_IPC_CHANNELS: '除显式绑定入口外，ID 属于飞书 Bot/chat/注册流程，不是 Agent 会话 ID',
  GITHUB_RELEASE_IPC_CHANNELS: '参数属于发布版本查询，不是 Agent 会话或 Renderer 文件能力',
  INSTALLER_IPC_CHANNELS: '参数属于受管安装任务/产物，不是 Agent 会话或任意 Renderer 文件读取能力',
  IPC_CHANNELS: '入口属于窗口、运行时或系统能力；所有 Renderer 文件路径入口已逐 key 列入 guarded 表',
  PLANNING_IPC_CHANNELS: 'ID 属于 Todo、日历、同步连接或提醒，不是 Agent 会话 ID；无任意文件读取能力',
  PROXY_IPC_CHANNELS: '只管理代理配置，不接收 sessionId 或文件路径',
  QUICK_TASK_IPC_CHANNELS: 'Quick Task 使用自身窗口与提交模型，不接收普通 Agent 会话 ID 或任意文件读取能力',
  SCRATCH_PAD_IPC_CHANNELS: '路径来自主进程选择的导出 capability，不是任意 Renderer 文件读取入口',
  SETTINGS_IPC_CHANNELS: '只管理应用设置，不接收 sessionId 或文件路径',
  STORAGE_IPC_CHANNELS: '只执行受管存储统计/清理，不接收 Renderer 指定路径',
  SYSTEM_PROMPT_IPC_CHANNELS: 'ID 属于系统提示词配置，不是 Agent 会话或 Renderer 文件能力',
  USER_PROFILE_IPC_CHANNELS: '只管理用户资料，不接收 sessionId 或文件路径',
  VOICE_DICTATION_IPC_CHANNELS: 'sessionId 是 ASR 流实例 ID，不是 Agent 会话 ID；音频数据由语音模块自行隔离',
  WECHAT_IPC_CHANNELS: 'ID 属于微信桥接登录/连接，不是 Agent 会话或 Renderer 文件能力',
}

/** 说明显式豁免项为何不属于普通 Agent 会话或敏感文件访问。 */
function getRendererHandlerPolicy(key: string): RendererHandlerPolicy {
  const guarded = GUARDED_RENDERER_HANDLER_POLICIES[key]
  if (guarded) return guarded
  const namespace = key.slice(0, key.indexOf(':'))
  return { kind: 'exempt', reason: EXEMPT_REASON_BY_NAMESPACE[namespace] ?? '' }
}

interface RegisteredHandler {
  channel: string
  namespace: string
  handler: ts.ArrowFunction | ts.FunctionExpression
}

interface AgentHandlerIndex {
  checker: ts.TypeChecker
  handlers: RegisteredHandler[]
  source: ts.SourceFile
}

/** 缓存 TypeScript Program，避免同一测试文件重复解析整个 Electron 工程。 */
let cachedHandlerIndex: AgentHandlerIndex | undefined

function getCallName(call: ts.CallExpression): string {
  return call.expression.getText()
}

function containsSessionId(type: ts.Type, checker: ts.TypeChecker, seen = new Set<ts.Type>()): boolean {
  if (seen.has(type)) return false
  seen.add(type)
  if (type.isUnionOrIntersection()) {
    return type.types.some((member) => containsSessionId(member, checker, seen))
  }
  return checker.getPropertyOfType(type, 'sessionId') !== undefined
}

/** 收集 handler 当前执行路径上的调用，跳过回调和嵌套函数体。 */
function collectTopLevelExecutionCalls(node: ts.Node): ts.CallExpression[] {
  const calls: ts.CallExpression[] = []
  const visit = (candidate: ts.Node): void => {
    if (candidate !== node && ts.isFunctionLike(candidate)) return
    if (ts.isCallExpression(candidate)) calls.push(candidate)
    ts.forEachChild(candidate, visit)
  }
  visit(node)
  return calls.sort((left, right) => left.getStart() - right.getStart())
}

function loadAgentHandlers(): AgentHandlerIndex {
  if (cachedHandlerIndex) return cachedHandlerIndex
  const ipcPath = join(import.meta.dir, '..', 'ipc.ts')
  const configPath = ts.findConfigFile(join(import.meta.dir, '../../../..'), ts.sys.fileExists, 'tsconfig.json')
  if (!configPath) throw new Error('找不到仓库 tsconfig.json')
  const config = ts.readConfigFile(configPath, ts.sys.readFile)
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, join(configPath, '..'))
  const program = ts.createProgram([ipcPath], parsed.options)
  const checker = program.getTypeChecker()
  const source = program.getSourceFile(ipcPath)
  if (!source) throw new Error('无法解析 ipc.ts')
  const handlers: RegisteredHandler[] = []

  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node)
      && node.expression.getText(source) === 'ipcMain.handle'
      && node.arguments.length >= 2
    ) {
      const channelArg = node.arguments[0]
      const handlerArg = node.arguments[1]
      if (channelArg && handlerArg && (ts.isArrowFunction(handlerArg) || ts.isFunctionExpression(handlerArg))) {
        if (ts.isPropertyAccessExpression(channelArg)) {
          handlers.push({
            channel: channelArg.name.text,
            namespace: channelArg.expression.getText(source),
            handler: handlerArg,
          })
        } else if (ts.isStringLiteral(channelArg)) {
          handlers.push({ channel: channelArg.text, namespace: 'literal', handler: handlerArg })
        }
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  cachedHandlerIndex = { checker, handlers, source }
  return cachedHandlerIndex
}

function compileLocalFunction<T>(source: ts.SourceFile, functionName: string, dependencies: Record<string, unknown>): T {
  let initializer: ts.Expression | undefined
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === functionName) {
      initializer = node.initializer
      return
    }
    if (ts.isFunctionDeclaration(node) && node.name?.text === functionName) {
      initializer = ts.factory.createFunctionExpression(
        undefined,
        node.asteriskToken,
        node.name,
        node.typeParameters,
        node.parameters,
        node.type,
        node.body!,
      )
      return
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  if (!initializer) throw new Error(`找不到局部函数: ${functionName}`)
  const dependencyNames = Object.keys(dependencies)
  const functionSource = initializer.pos >= 0
    ? initializer.getText(source)
    : ts.createPrinter().printNode(ts.EmitHint.Expression, initializer, source)
  const executable = ts.transpileModule(`const __target = ${functionSource}`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText
  const factory = new Function(...dependencyNames, `${executable}\nreturn __target`) as (...args: unknown[]) => unknown
  return factory(...dependencyNames.map((name) => dependencies[name])) as T
}

function compileHandler<T>(registered: RegisteredHandler, dependencies: Record<string, unknown>): T {
  const dependencyNames = Object.keys(dependencies)
  const executable = ts.transpileModule(`const __target = ${registered.handler.getText()}`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText
  const factory = new Function(...dependencyNames, `${executable}\nreturn __target`) as (...args: unknown[]) => unknown
  return factory(...dependencyNames.map((name) => dependencies[name])) as T
}

function handlerReceivesSessionId(handler: RegisteredHandler, checker: ts.TypeChecker): boolean {
  if (SESSION_ID_ALIAS_CHANNELS.has(handler.channel)) return true
  return handler.handler.parameters.slice(1).some((parameter) => {
    if (/sessionId/i.test(parameter.name.getText())) return true
    return containsSessionId(checker.getTypeAtLocation(parameter), checker)
  })
}

describe('普通 Renderer Agent IPC 会话访问矩阵', () => {
  test('Given 不存在、Design、Canvas 或半归属会话 When 进入普通入口 Then 统一表现为会话不存在', () => {
    const internalSessions = [
      undefined,
      { id: 'design', title: 'Design', sourceDesignProjectId: 'p', sourceDesignJobId: 'j', createdAt: 1, updatedAt: 1 },
      { id: 'canvas', title: 'Canvas', workspaceId: 'p', sourceCanvasProjectId: 'p', sourceCanvasId: 'c', sourceCanvasNodeId: 'n', createdAt: 1, updatedAt: 1 },
      { id: 'partial', title: 'Partial', sourceCanvasProjectId: 'p', createdAt: 1, updatedAt: 1 },
    ]

    for (const candidate of internalSessions) {
      expect(() => requireUserVisibleAgentSession(candidate)).toThrow('Agent 会话不存在')
    }
    expect(requireUserVisibleAgentSession({ id: 'visible', title: '普通会话', createdAt: 1, updatedAt: 1 }).id).toBe('visible')
  })

  test('Given 普通 AGENT handler 接收 sessionId When 检查顶层执行路径 Then guard 先于业务调用', () => {
    const { checker, handlers } = loadAgentHandlers()
    const sessionHandlers = handlers.filter((handler) => (
      handler.namespace === 'AGENT_IPC_CHANNELS' && handlerReceivesSessionId(handler, checker)
    ))
    expect(sessionHandlers.length).toBeGreaterThan(25)

    for (const { channel, handler } of sessionHandlers) {
      const calls = collectTopLevelExecutionCalls(handler.body)
      const guardIndex = calls.findIndex((call) => [
        'requireVisibleSession',
        'requireVisibleFileAccess',
        'requireVisibleFileReadAccess',
        'assertBrowserSessionAccess',
      ].includes(getCallName(call)))
      expect(guardIndex, `${channel} 缺少普通会话可见性 guard`).toBeGreaterThanOrEqual(0)

      const callsBeforeGuard = calls
        .slice(0, guardIndex)
        .map(getCallName)
        .filter((name) => !PURE_VALIDATION_CALLS.has(name) && name !== 'Error')
      expect(callsBeforeGuard, `${channel} 在 guard 前执行了业务调用`).toEqual([])
    }
  })

  test('Given ipc.ts 注册全部 Renderer handler When 枚举访问矩阵 Then 非 Agent 文件入口也在业务调用前 guard', () => {
    const { handlers } = loadAgentHandlers()
    expect(handlers.length).toBeGreaterThan(180)

    for (const channel of NON_AGENT_FILE_CHANNELS) {
      const registered = handlers.find((handler) => handler.channel === channel)
      expect(registered, `${channel} 未纳入全量 ipcMain.handle 矩阵`).toBeDefined()
      const calls = collectTopLevelExecutionCalls(registered!.handler.body)
      if (channel === 'file:resolve-html-preview-path') {
        expect(registered!.handler.body.getText()).toContain('throw new Error')
        continue
      }
      const guardIndex = calls.findIndex((call) => [
        'requireVisibleFileAccess',
        'requireVisibleFileReadAccess',
        'requireVisibleFileWriteAccess',
      ].includes(getCallName(call)))
      expect(guardIndex, `${channel} 缺少文件访问 guard`).toBeGreaterThanOrEqual(0)
      const businessCallsBeforeGuard = calls
        .slice(0, guardIndex)
        .map(getCallName)
        .filter((name) => !PURE_VALIDATION_CALLS.has(name) && name !== 'Error' && name !== 'console.warn')
      expect(businessCallsBeforeGuard, `${channel} 在 guard 前执行了业务调用`).toEqual([])
    }
  })

  test('Given ipc.ts 的全部 Renderer handler When 对照显式策略矩阵 Then 新增、遗漏或重复 key 均失败', () => {
    const { handlers } = loadAgentHandlers()
    const actualKeys = handlers.map(({ namespace, channel }) => `${namespace}:${channel}`).sort()
    const declaredKeys = [...ALL_RENDERER_HANDLER_KEYS].sort()

    expect(new Set(declaredKeys).size).toBe(declaredKeys.length)
    expect(actualKeys).toEqual(declaredKeys)
    for (const registered of handlers) {
      const key = `${registered.namespace}:${registered.channel}`
      const policy = getRendererHandlerPolicy(key)
      if (policy.kind === 'exempt') {
        expect(policy.reason.length, `${key} 的 exempt 必须说明非 Agent/非敏感语义`).toBeGreaterThan(0)
        continue
      }
      if (policy.guards.includes('Error')) {
        expect(registered.handler.body.getText(), `${key} 必须明确 fail closed`).toContain('throw new Error')
        continue
      }
      const calls = collectTopLevelExecutionCalls(registered.handler.body).map(getCallName)
      const guardIndex = calls.findIndex((name) => policy.guards.includes(name))
      expect(guardIndex, `${key} 缺少声明的 ${policy.kind} guard`).toBeGreaterThanOrEqual(0)
    }
  })

  test('Given 路径检查、搜索与系统显示入口 When 检查顶层执行路径 Then guard 先于 stat、readdir、cache 与 shell', () => {
    const { handlers } = loadAgentHandlers()
    for (const channel of ['CHECK_PATHS_TYPE', 'SEARCH_WORKSPACE_FILES', 'SHOW_ITEM_IN_FOLDER']) {
      const registered = handlers.find((handler) => handler.channel === channel)
      expect(registered).toBeDefined()
      const calls = collectTopLevelExecutionCalls(registered!.handler.body)
      const guardIndex = calls.findIndex((call) => getCallName(call) === 'requireVisibleFileAccess')
      expect(guardIndex, `${channel} 缺少路径 guard`).toBeGreaterThanOrEqual(0)
      const businessCallsBeforeGuard = calls
        .slice(0, guardIndex)
        .map(getCallName)
        .filter((name) => !PURE_VALIDATION_CALLS.has(name) && name !== 'Error' && name !== 'console.warn')
      expect(businessCallsBeforeGuard, `${channel} 在 guard 前执行了业务调用`).toEqual([])
    }
  })

  test('Given Windows Agent Island 收到内部会话 When 打开会话 Then guard 失败且窗口与已读状态零副作用', async () => {
    const { handlers } = loadAgentHandlers()
    const registered = handlers.find((handler) => handler.channel === 'OPEN_SESSION')
    expect(registered).toBeDefined()
    let sideEffectCount = 0
    const handler = compileHandler<(event: object, sessionId: string, title: string) => Promise<void>>(registered!, {
      isNonEmptyString: () => true,
      requireVisibleSession: () => { throw new Error('Agent 会话不存在') },
      markAgentIslandSessionViewed: () => { sideEffectCount += 1 },
      getMainWindow: () => { sideEffectCount += 1; return null },
    })

    await expect(handler({}, 'canvas', 'Canvas')).rejects.toThrow('Agent 会话不存在')
    expect(sideEffectCount).toBe(0)
  })

  test('Given Git、独立预览与 file handler 收到内部或未知会话 When 执行真实 handler Then 业务副作用为零', async () => {
    const { handlers } = loadAgentHandlers()
    for (const channel of ['GET_FILE_DIFF', 'OPEN_DETACHED_PREVIEW', 'file:resolve-and-read']) {
      const registered = handlers.find((handler) => handler.channel === channel)
      expect(registered).toBeDefined()
      let businessCallCount = 0
      const handler = compileHandler<(...args: unknown[]) => Promise<unknown>>(registered!, {
        requireVisibleFileAccess: () => { throw new Error('Agent 会话不存在') },
        requireVisibleFileReadAccess: () => { throw new Error('Agent 会话不存在') },
        normalizeFileAccessOptions: (value: unknown) => value,
        ensurePathAllowedWithWorktree: async () => { businessCallCount += 1; return true },
        getFileDiff: () => { businessCallCount += 1; return '' },
        BrowserWindow: { fromWebContents: () => { businessCallCount += 1; return null } },
      })
      const args = channel === 'GET_FILE_DIFF'
        ? [{}, { dirPath: '/cwd', filePath: 'a.ts', sessionId: 'canvas' }]
        : channel === 'OPEN_DETACHED_PREVIEW'
          ? [{ sender: {} }, { dirPath: '/cwd', filePath: '/cwd/a.ts', sessionId: 'canvas' }]
          : [{}, '/cwd/a.ts', { sessionId: 'missing' }]
      await expect(handler(...args)).rejects.toThrow('Agent 会话不存在')
      expect(businessCallCount, `${channel} 在 guard 失败后仍执行副作用`).toBe(0)
    }
  })

  test('Given 文件 guard 已打开授权对象 When 路径在首次读取前被替换 Then resolve-and-read 绝不读取替换内容', async () => {
    const { handlers } = loadAgentHandlers()
    const registered = handlers.find((handler) => handler.channel === 'file:resolve-and-read')
    expect(registered).toBeDefined()
    const root = mkdtempSync(join(tmpdir(), 'proma-renderer-guard-read-race-'))
    const authorizedPath = join(root, 'authorized.txt')
    const replacementPath = join(root, 'replacement.txt')
    writeFileSync(authorizedPath, 'authorized-content')
    writeFileSync(replacementPath, 'replacement-content')
    let descriptor: number | undefined
    try {
      /** 模拟 guard：先打开授权 inode，再让攻击者替换路径，随后才返回给 handler。 */
      const openAccessSnapshot = () => {
        descriptor = openSync(authorizedPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
        renameSync(replacementPath, authorizedPath)
        return {
          options: undefined,
          authorizedFiles: new Map([[authorizedPath, {
            canonicalPath: authorizedPath,
            readBytes: () => readFileSync(descriptor!),
            close: () => undefined,
          }]]),
        }
      }
      const handler = compileHandler<(event: object, filePath: string) => Promise<{ content: string } | null>>(registered!, {
        requireVisibleFileAccess: openAccessSnapshot,
        requireVisibleFileReadAccess: openAccessSnapshot,
        getPreviewCandidateBasePaths: () => [],
        resolveFilePath: () => authorizedPath,
        isPathAllowed: () => true,
        readStableFile: (filePath: string) => readFileSync(filePath),
        decodeStablePreviewText: (content: Buffer) => content.toString('utf8'),
      })

      const result = await handler({}, authorizedPath)
      expect(result?.content).toBe('authorized-content')
      expect(result?.content).not.toBe('replacement-content')
    } finally {
      if (descriptor !== undefined) closeSync(descriptor)
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('Given 授权时文件为 1B When 同一 inode 增长到 10B Then 固定大小读取拒绝返回增长内容', () => {
    const { source } = loadAgentHandlers()
    const root = mkdtempSync(join(tmpdir(), 'proma-renderer-fixed-size-'))
    const filePath = join(root, 'growing.txt')
    writeFileSync(filePath, 'a')
    try {
      const requireVisibleFileReadAccess = compileLocalFunction<(
        access: FileAccessOptions | undefined,
        filePath: string,
        candidateBasePaths: readonly string[],
        maxSize: number,
      ) => { authorizedFiles: Map<string, { readBytes: () => Buffer, close: () => void }> }>(
        source,
        'requireVisibleFileReadAccess',
        {
          requireVisibleFileAccess: () => ({ options: undefined }),
          getPreviewCandidateBasePaths: () => [root],
          getRendererFileCandidates: () => [filePath],
          openSync,
          constants,
          fstatSync,
          realpathSync: (value: string) => value,
          lstatSync,
          isCanonicalPathAllowed: () => true,
          closeSync,
          readFileSync,
          ftruncateSync: () => undefined,
          writeFileSync,
        },
      )
      const snapshot = requireVisibleFileReadAccess(undefined, filePath, [root], 2)
      const authorizedFile = snapshot.authorizedFiles.get(filePath)!

      writeFileSync(filePath, '0123456789')

      expect(() => authorizedFile.readBytes()).toThrow('文件身份已变化')
      authorizedFile.close()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('Given resolve-path guard 返回后路径被替换 When 注册协议 token Then 只注册授权 Buffer', async () => {
    const { handlers } = loadAgentHandlers()
    const registered = handlers.find(({ channel }) => channel === 'file:resolve-path')
    expect(registered).toBeDefined()
    const root = mkdtempSync(join(tmpdir(), 'proma-renderer-resolve-path-race-'))
    const filePath = join(root, 'preview.png')
    const replacementPath = join(root, 'replacement.png')
    writeFileSync(filePath, 'authorized-content')
    writeFileSync(replacementPath, 'replacement-content')
    let descriptor: number | undefined
    let registeredContent = ''
    try {
      const requireVisibleFileReadAccess = () => {
        descriptor = openSync(filePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
        renameSync(replacementPath, filePath)
        return {
          authorizedFiles: new Map([[filePath, {
            canonicalPath: filePath,
            readBytes: () => readFileSync(descriptor!),
            close: () => closeSync(descriptor!),
          }]]),
        }
      }
      const handler = compileHandler<(event: object, path: string) => Promise<{ url: string } | null>>(registered!, {
        requireVisibleFileAccess: () => ({ options: undefined }),
        requireVisibleFileReadAccess,
        getPreviewCandidateBasePaths: () => [root],
        isPathAllowed: () => true,
        registerPromaFilePath: (path: string) => {
          registeredContent = readFileSync(path, 'utf8')
          return 'proma-file://path-token'
        },
        registerPromaAuthorizedFile: (_path: string, content: Buffer) => {
          registeredContent = content.toString('utf8')
          return 'proma-file://buffer-token'
        },
        console,
      })

      await expect(handler({}, filePath)).resolves.toEqual({ url: 'proma-file://buffer-token' })
      expect(registeredContent).toBe('authorized-content')
      expect(() => fstatSync(descriptor!)).toThrow()
    } finally {
      if (descriptor !== undefined) {
        try { closeSync(descriptor) } catch { /* handler 已关闭授权句柄 */ }
      }
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('Given HTML 目录无法绑定稳定授权对象 When 请求预览 Then 明确禁用且不注册目录', async () => {
    const { handlers } = loadAgentHandlers()
    const registered = handlers.find(({ channel }) => channel === 'file:resolve-html-preview-path')
    expect(registered).toBeDefined()
    let registerCallCount = 0
    const handler = compileHandler<(event: object, path: string) => Promise<unknown>>(registered!, {
      requireVisibleFileAccess: () => ({ options: undefined }),
      requireVisibleFileReadAccess: () => { throw new Error('不应打开文件') },
      getPreviewCandidateBasePaths: () => [],
      isPathAllowed: () => true,
      registerPromaDirectoryPath: () => { registerCallCount += 1; return 'proma-file://directory-token' },
      dirname,
      basename: (value: string) => value,
      console,
    })

    await expect(handler({}, '/tmp/preview.html')).rejects.toThrow('HTML 目录预览已禁用：无法安全绑定相对资源目录')
    expect(registerCallCount).toBe(0)
  })

  test('Given 附件 guard 返回后路径被替换 When 读取附件 Then 只消费授权 fd', async () => {
    const { handlers } = loadAgentHandlers()
    const registered = handlers.find(({ channel }) => channel === 'READ_ATTACHED_FILE')
    expect(registered).toBeDefined()
    const root = mkdtempSync(join(tmpdir(), 'proma-renderer-attached-race-'))
    const filePath = join(root, 'attached.txt')
    const replacementPath = join(root, 'replacement.txt')
    writeFileSync(filePath, 'authorized-content')
    writeFileSync(replacementPath, 'replacement-content')
    let descriptor: number | undefined
    try {
      const requireVisibleFileReadAccess = () => {
        descriptor = openSync(filePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
        renameSync(replacementPath, filePath)
        return {
          authorizedFiles: new Map([[filePath, {
            canonicalPath: filePath,
            readBytes: () => readFileSync(descriptor!),
            close: () => closeSync(descriptor!),
          }]]),
        }
      }
      const handler = compileHandler<(event: object, path: string) => Promise<string>>(registered!, {
        requireVisibleFileAccess: requireVisibleFileReadAccess,
        requireVisibleFileReadAccess,
        resolve,
        isPathAllowed: () => true,
        readStableFile: (path: string) => readFileSync(path),
      })

      const result = await handler({}, filePath)
      expect(Buffer.from(result, 'base64').toString('utf8')).toBe('authorized-content')
    } finally {
      if (descriptor !== undefined) {
        try { closeSync(descriptor) } catch { /* handler 已关闭授权句柄 */ }
      }
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('Given 飞书绑定包含 Agent sessionId When 会话不可见 Then 修改副作用为零', async () => {
    const { handlers } = loadAgentHandlers()
    const registered = handlers.find(({ namespace, channel }) => (
      namespace === 'FEISHU_IPC_CHANNELS' && channel === 'UPDATE_BINDING'
    ))
    expect(registered).toBeDefined()
    let sideEffectCount = 0
    const handler = compileHandler<(event: object, input: { chatId: string, sessionId?: string }) => Promise<unknown>>(registered!, {
      requireVisibleSession: () => { throw new Error('Agent 会话不存在') },
      feishuBridgeManager: {
        findBridgeByChatId: () => {
          sideEffectCount += 1
          return { updateBinding: () => { sideEffectCount += 1; return null } }
        },
      },
    })

    await expect(handler({}, { chatId: 'chat-1', sessionId: 'canvas' })).rejects.toThrow('Agent 会话不存在')
    expect(sideEffectCount).toBe(0)
  })

  test.each([
    ['DELETE_FILE', ['/source.txt', undefined]],
    ['RENAME_FILE', ['/source.txt', 'renamed.txt', undefined]],
    ['MOVE_FILE', ['/source.txt', '/target', undefined]],
    ['RENAME_ATTACHED_FILE', ['/source.txt', 'renamed.txt', undefined]],
    ['MOVE_ATTACHED_FILE', ['/source.txt', '/target', undefined]],
  ])('Given Renderer 调用 %s 且源或目标可能并发变化 When 执行 handler Then 明确拒绝并保持文件零损伤', async (channel, args) => {
    const { handlers } = loadAgentHandlers()
    const registered = handlers.find((handler) => handler.channel === channel)
    expect(registered).toBeDefined()
    const root = mkdtempSync(join(tmpdir(), 'proma-renderer-disabled-mutation-'))
    const sourcePath = join(root, 'source.txt')
    const targetDir = join(root, 'target')
    const concurrentTarget = join(targetDir, 'source.txt')
    mkdirSync(targetDir)
    writeFileSync(sourcePath, 'source-content')
    writeFileSync(concurrentTarget, 'concurrent-target-content')
    let mutationCallCount = 0
    try {
      const handler = compileHandler<(...handlerArgs: unknown[]) => Promise<void>>(registered!, {
        requireVisibleFileAccess: () => ({ options: undefined }),
        resolve: (value: string) => value === '/source.txt' ? sourcePath : value === '/target' ? targetDir : value,
        isPathAllowed: () => true,
        dirname,
        join,
        sep: '/',
        removeStablePath: () => { mutationCallCount += 1 },
        renameStablePath: () => { mutationCallCount += 1 },
        moveStablePath: () => { mutationCallCount += 1; return concurrentTarget },
        RENDERER_FILE_MUTATION_DISABLED_MESSAGE: 'Renderer 暂不支持删除、重命名或移动文件；请通过 Agent 或系统文件管理器操作',
      })

      await expect(handler({}, ...args)).rejects.toThrow('Renderer 暂不支持删除、重命名或移动文件')
      expect(mutationCallCount).toBe(0)
      expect(readFileSync(sourcePath, 'utf8')).toBe('source-content')
      expect(readFileSync(concurrentTarget, 'utf8')).toBe('concurrent-target-content')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('Given 路径型 Preload API When 检查四层合同 Then 类型、bridge 与调用端都传入 FileAccessOptions', () => {
    const electronRoot = join(import.meta.dir, '../..')
    const preloadSource = readFileSync(join(electronRoot, 'preload/index.ts'), 'utf8')
    const sourceByPath = new Map([
      ['AgentView', readFileSync(join(electronRoot, 'renderer/components/agent/AgentView.tsx'), 'utf8')],
      ['FileDropZone', readFileSync(join(electronRoot, 'renderer/components/file-browser/FileDropZone.tsx'), 'utf8')],
      ['FileSearchBar', readFileSync(join(electronRoot, 'renderer/components/file-browser/FileSearchBar.tsx'), 'utf8')],
      ['FileMentionSuggestion', readFileSync(join(electronRoot, 'renderer/components/file-browser/file-mention-suggestion.tsx'), 'utf8')],
      ['RichTextInput', readFileSync(join(electronRoot, 'renderer/components/ai-elements/rich-text-input.tsx'), 'utf8')],
      ['FilePathChip', readFileSync(join(electronRoot, 'renderer/components/ai-elements/file-path-chip.tsx'), 'utf8')],
      ['WorkspaceMemoryTab', readFileSync(join(electronRoot, 'renderer/components/agent-skills/WorkspaceMemoryTab.tsx'), 'utf8')],
    ])

    expect(preloadSource).toMatch(/checkPathsType:\s*\(paths: string\[\], access\?: import\('@proma\/shared'\)\.FileAccessOptions\)/)
    expect(preloadSource).toMatch(/searchWorkspaceFiles:[\s\S]*sessionPaths\?: string\[\],[\s\S]*access\?: import\('@proma\/shared'\)\.FileAccessOptions/)
    expect(preloadSource).toMatch(/showItemInFolder:\s*\(filePath: string, access\?: import\('@proma\/shared'\)\.FileAccessOptions\)/)
    expect(sourceByPath.get('AgentView')).toMatch(/checkPathsType\(paths,\s*\{\s*sessionId\s*\}\)/)
    expect(sourceByPath.get('FileDropZone')).toMatch(/const access = sessionId \? \{ sessionId, workspaceSlug \} : \{ workspaceSlug \}/)
    expect(sourceByPath.get('FileDropZone')).toContain('checkPathsType(paths, access)')
    expect(sourceByPath.get('FileSearchBar')).toMatch(/searchWorkspaceFiles\([\s\S]*\{\s*sessionId\s*\}/)
    expect(sourceByPath.get('FileMentionSuggestion')).toMatch(/searchWorkspaceFiles\([\s\S]*\{\s*sessionId:\s*currentSessionIdRef\?\.current/)
    expect(sourceByPath.get('RichTextInput')).toContain('currentSessionIdRef,')
    expect(sourceByPath.get('FilePathChip')).toMatch(/showItemInFolder\(cleanPath,\s*\{[\s\S]*sessionId:[\s\S]*candidateBasePaths:/)
    expect(sourceByPath.get('WorkspaceMemoryTab')).toMatch(/showItemInFolder\(selected\.absolutePath,\s*\{\s*workspaceSlug\s*\}\)/)
  })

  test('Given AGENT handler 使用裸 id 参数 When 检查矩阵 Then 每个 id 都必须显式归类', () => {
    const { handlers } = loadAgentHandlers()
    const bareIdChannels = handlers
      .filter(({ namespace }) => namespace === 'AGENT_IPC_CHANNELS')
      .filter(({ handler }) => handler.parameters.slice(1).some((parameter) => parameter.name.getText() === 'id'))
      .map(({ channel }) => channel)
      .sort()
    const classifiedChannels = [...SESSION_ID_ALIAS_CHANNELS, ...NON_SESSION_ID_ALIAS_CHANNELS].sort()
    expect(bareIdChannels).toEqual(classifiedChannels)
  })

  test('Given 浏览器 wrapper 收到不存在或内部会话 When 执行实际 wrapper Then Renderer 与浏览器副作用为零', async () => {
    const { source } = loadAgentHandlers()
    const sessions = new Map<string, AgentSessionMeta>([
      ['design', { id: 'design', title: 'Design', sourceDesignProjectId: 'p', sourceDesignJobId: 'j', createdAt: 1, updatedAt: 1 }],
      ['canvas', { id: 'canvas', title: 'Canvas', workspaceId: 'p', sourceCanvasProjectId: 'p', sourceCanvasId: 'c', sourceCanvasNodeId: 'n', createdAt: 1, updatedAt: 1 }],
      ['partial', { id: 'partial', title: 'Partial', sourceCanvasProjectId: 'p', createdAt: 1, updatedAt: 1 }],
    ])
    let rendererCallCount = 0
    let browserCallCount = 0
    const wrapper = compileLocalFunction<(senderId: number, sessionId: string) => Promise<void>>(source, 'assertBrowserSessionAccess', {
      requireVisibleSession: (sessionId: string) => requireUserVisibleAgentSession(sessions.get(sessionId)),
      assertMainRenderer: async () => { rendererCallCount += 1 },
      browserController: { configureSession: () => { browserCallCount += 1 } },
      resolveBrowserProfileKey: () => 'profile',
    })

    for (const sessionId of ['missing', 'design', 'canvas', 'partial']) {
      await expect(wrapper(1, sessionId)).rejects.toThrow('Agent 会话不存在')
    }
    expect(rendererCallCount).toBe(0)
    expect(browserCallCount).toBe(0)
  })

  test('Given 文件入口显式非法 session 或目标属于内部/其他会话 When 执行实际 wrapper Then 业务副作用为零', () => {
    const { source } = loadAgentHandlers()
    const sessions = new Map<string, AgentSessionMeta>([
      ['visible-a', { id: 'visible-a', title: 'A', createdAt: 1, updatedAt: 1 }],
      ['visible-b', { id: 'visible-b', title: 'B', createdAt: 1, updatedAt: 1 }],
      ['canvas', { id: 'canvas', title: 'Canvas', workspaceId: 'p', sourceCanvasProjectId: 'p', sourceCanvasId: 'c', sourceCanvasNodeId: 'n', createdAt: 1, updatedAt: 1 }],
      ['design', { id: 'design', title: 'Design', sourceDesignProjectId: 'p', sourceDesignJobId: 'j', createdAt: 1, updatedAt: 1 }],
    ])
    const owners = new Map<string, AgentSessionMeta>([
      ['/canvas-cwd', sessions.get('canvas')!],
      ['/visible-b-cwd', sessions.get('visible-b')!],
      ['/visible-a-cwd', sessions.get('visible-a')!],
    ])
    const requireVisibleFileAccess = compileLocalFunction<(access: FileAccessOptions | undefined, targetPaths: string[]) => void>(
      source,
      'requireVisibleFileAccess',
      {
        createRendererFileAccessSnapshot: (access: FileAccessOptions | undefined) => ({
          options: access,
          sessionsById: sessions,
        }),
        hasExplicitSessionId: (access: FileAccessOptions | undefined) => access !== undefined && Object.prototype.hasOwnProperty.call(access, 'sessionId'),
        getManagedAgentSessionPathOwner: (path: string) => ({ managed: owners.has(path), owner: owners.get(path) }),
        requireVisibleSession: (sessionId: string) => requireUserVisibleAgentSession(sessions.get(sessionId)),
        requireUserVisibleAgentSession,
      },
    )
    let businessCallCount = 0
    const runFileOperation = (access: FileAccessOptions | undefined, path: string): void => {
      requireVisibleFileAccess(access, [path])
      businessCallCount += 1
    }

    const rejectedCases: Array<[string, FileAccessOptions | undefined, string]> = [
      ['空 sessionId', { sessionId: '' }, '/workspace-file'],
      ['空白 sessionId', { sessionId: '   ' }, '/workspace-file'],
      ['未知 sessionId', { sessionId: 'missing' }, '/workspace-file'],
      ['缺失 context 访问 Canvas cwd', undefined, '/canvas-cwd'],
      ['普通会话跨 session cwd', { sessionId: 'visible-a' }, '/visible-b-cwd'],
      ['unrestricted 跨 session cwd', { sessionId: 'visible-a', unrestricted: true }, '/visible-b-cwd'],
      ['Design session context', { sessionId: 'design' }, '/workspace-file'],
    ]
    for (const [_label, access, path] of rejectedCases) {
      expect(() => runFileOperation(access, path)).toThrow('Agent 会话不存在')
    }
    expect(businessCallCount).toBe(0)

    runFileOperation(undefined, '/workspace-file')
    runFileOperation(undefined, '/tmp-file')
    runFileOperation({ sessionId: 'visible-a' }, '/visible-a-cwd')
    expect(businessCallCount).toBe(3)
  })

  test('Given 文件入口未提供 session context When 计算授权根 Then 仅保留 workspace-files 与 tmp', () => {
    const { source } = loadAgentHandlers()
    const getAuthorizedRoots = compileLocalFunction<(access?: FileAccessOptions) => string[]>(source, 'getAuthorizedRoots', {
      tmpdir: () => '/tmp',
      join,
      getConfigDir: () => '/config',
      listAgentSessions: () => [],
      listAgentWorkspaces: () => [{ id: 'a', slug: 'alpha' }, { id: 'b', slug: 'beta' }],
      getAgentSessionMeta: () => undefined,
      getAgentWorkspace: () => undefined,
      getProjectFilesPath: () => '',
      getWorkspaceAttachedDirectories: () => [],
      getWorkspaceAttachedFiles: () => [],
    })

    expect(getAuthorizedRoots()).toEqual([
      '/tmp/proma-preview',
      '/config/agent-workspaces/alpha/workspace-files',
      '/config/agent-workspaces/beta/workspace-files',
    ])
    expect(getAuthorizedRoots()).not.toContain('/config/agent-workspaces')
  })

  test('Given Git worktree 进入兜底授权分支 When 获取工作区 slug Then 复用当前 IPC 快照', () => {
    const { source } = loadAgentHandlers()
    const sourceText = source.getFullText()

    expect(sourceText).toContain('getWorkspaceSlugsForAccess(options, snapshot)')
    expect(sourceText).not.toContain('getWorkspaceSlugsForAccess(options))')
  })

  test('Given canonical 托管根包含孤儿或 workspace 不匹配 cwd When 解析 owner Then fail closed 且前缀相似路径不误判', () => {
    const { source } = loadAgentHandlers()
    const visible = { id: 'visible', title: 'A', workspaceId: 'workspace-a', createdAt: 1, updatedAt: 1 }
    const mismatch = { id: 'mismatch', title: 'B', workspaceId: 'workspace-b', createdAt: 1, updatedAt: 1 }
    const snapshot = {
      managedRoot: '/real/config/agent-workspaces',
      workspacesBySlug: new Map([['alpha', { id: 'workspace-a', slug: 'alpha' }]]),
      sessionsById: new Map([['visible', visible], ['mismatch', mismatch]]),
    }
    const canonicalPaths = new Map([
      ['/linked/config/agent-workspaces/alpha/visible/file.ts', '/real/config/agent-workspaces/alpha/visible/file.ts'],
    ])
    const resolveOwner = compileLocalFunction<(path: string, accessSnapshot: typeof snapshot) => { managed: boolean, owner?: AgentSessionMeta }>(
      source,
      'getManagedAgentSessionPathOwner',
      {
        relative: (root: string, path: string) => path.startsWith(`${root}/`) ? path.slice(root.length + 1) : '../outside',
        sep: '/',
        isAbsolute: (path: string) => path.startsWith('/'),
        canonicalizeAccessPath: (path: string) => canonicalPaths.get(path) ?? path,
        getManagedAgentSessionCanonicalPathOwner: compileLocalFunction(
          source,
          'getManagedAgentSessionCanonicalPathOwner',
          {
            relative: (root: string, path: string) => path.startsWith(`${root}/`) ? path.slice(root.length + 1) : '../outside',
            sep: '/',
            isAbsolute: (path: string) => path.startsWith('/'),
            MANAGED_WORKSPACE_SHARED_ENTRIES: new Set([
              'workspace-files', 'skills', 'skills-inactive', '.claude', 'memory',
              'AGENTS.md', 'CLAUDE.md', 'mcp.json', 'config.json',
            ]),
          },
        ),
        MANAGED_WORKSPACE_SHARED_ENTRIES: new Set([
          'workspace-files', 'skills', 'skills-inactive', '.claude', 'memory',
          'AGENTS.md', 'CLAUDE.md', 'mcp.json', 'config.json',
        ]),
      },
    )

    expect(resolveOwner('/linked/config/agent-workspaces/alpha/visible/file.ts', snapshot).owner?.id).toBe('visible')
    expect(resolveOwner('/real/config/agent-workspaces/alpha/workspace-files/file.ts', snapshot)).toEqual({ managed: false })
    expect(resolveOwner('/real/config/agent-workspaces/alpha/skills/example/SKILL.md', snapshot)).toEqual({ managed: false })
    expect(resolveOwner('/real/config/agent-workspaces/alpha/skills-inactive/example/SKILL.md', snapshot)).toEqual({ managed: false })
    expect(resolveOwner('/real/config/agent-workspaces/alpha/.claude/settings.json', snapshot)).toEqual({ managed: false })
    expect(resolveOwner('/real/config/agent-workspaces/alpha/memory/MEMORY.md', snapshot)).toEqual({ managed: false })
    expect(resolveOwner('/real/config/agent-workspaces/alpha/AGENTS.md', snapshot)).toEqual({ managed: false })
    expect(resolveOwner('/real/config/agent-workspaces/alpha/CLAUDE.md', snapshot)).toEqual({ managed: false })
    expect(resolveOwner('/real/config/agent-workspaces/alpha/mcp.json', snapshot)).toEqual({ managed: false })
    expect(resolveOwner('/real/config/agent-workspaces/alpha/config.json', snapshot)).toEqual({ managed: false })
    expect(resolveOwner('/real/config/agent-workspaces/alpha/orphan/file.ts', snapshot)).toEqual({ managed: true })
    expect(resolveOwner('/real/config/agent-workspaces/alpha/mismatch/file.ts', snapshot)).toEqual({ managed: true })
    expect(resolveOwner('/real/config/agent-workspaces-evil/alpha/visible/file.ts', snapshot)).toEqual({ managed: false })
  })

  test('Given Renderer 为可见会话伪造其他 workspaceId When 获取 session path Then 不拼接攻击者工作区路径', async () => {
    const { handlers } = loadAgentHandlers()
    const registered = handlers.find((handler) => handler.channel === 'GET_SESSION_PATH')
    expect(registered).toBeDefined()
    let pathCallCount = 0
    const handler = compileHandler<(event: object, workspaceId: string, sessionId: string) => Promise<string | null>>(
      registered!,
      {
        requireVisibleSession: () => ({ id: 'visible', title: 'A', workspaceId: 'workspace-a', createdAt: 1, updatedAt: 1 }),
        getAgentWorkspace: (workspaceId: string) => ({ id: workspaceId, slug: workspaceId === 'workspace-a' ? 'alpha' : 'attacker' }),
        getAgentSessionWorkspacePath: () => { pathCallCount += 1; return '/attacker/visible' },
      },
    )

    await expect(handler({}, 'workspace-b', 'visible')).resolves.toBeNull()
    expect(pathCallCount).toBe(0)
  })

  test('Given 文件 handler 收到非法 context 或 Canvas/跨会话 cwd When 执行已注册 handler Then 文件业务函数零调用', async () => {
    const { handlers, source } = loadAgentHandlers()
    const sessions = new Map<string, AgentSessionMeta>([
      ['visible-a', { id: 'visible-a', title: 'A', createdAt: 1, updatedAt: 1 }],
      ['visible-b', { id: 'visible-b', title: 'B', createdAt: 1, updatedAt: 1 }],
      ['canvas', { id: 'canvas', title: 'Canvas', workspaceId: 'p', sourceCanvasProjectId: 'p', sourceCanvasId: 'c', sourceCanvasNodeId: 'n', createdAt: 1, updatedAt: 1 }],
    ])
    const owners = new Map<string, AgentSessionMeta>([
      ['/canvas-cwd', sessions.get('canvas')!],
      ['/visible-b-cwd', sessions.get('visible-b')!],
    ])
    const requireVisibleFileAccess = compileLocalFunction<(access: FileAccessOptions | undefined, targetPaths: string[]) => void>(
      source,
      'requireVisibleFileAccess',
      {
        createRendererFileAccessSnapshot: (access: FileAccessOptions | undefined) => ({
          options: access,
          sessionsById: sessions,
        }),
        hasExplicitSessionId: (access: FileAccessOptions | undefined) => access !== undefined && Object.prototype.hasOwnProperty.call(access, 'sessionId'),
        getManagedAgentSessionPathOwner: (path: string) => ({ managed: owners.has(path), owner: owners.get(path) }),
        requireVisibleSession: (sessionId: string) => requireUserVisibleAgentSession(sessions.get(sessionId)),
        requireUserVisibleAgentSession,
      },
    )
    let resolveCallCount = 0
    let listCallCount = 0
    const listHandlerNode = handlers.find(({ channel }) => channel === 'LIST_DIRECTORY')
    expect(listHandlerNode).toBeDefined()
    const listHandler = compileHandler<(
      event: object,
      path: string,
      access?: FileAccessOptions,
    ) => Promise<unknown>>(listHandlerNode!, {
      requireVisibleFileAccess,
      resolve: (path: string) => { resolveCallCount += 1; return path },
      existsSync: () => true,
      normalizeFileAccessOptions: (access: FileAccessOptions | undefined) => access,
      isPathAllowed: () => true,
      listShallowDirectory: () => { listCallCount += 1; return [] },
    })

    const rejectedCases: Array<[string, FileAccessOptions | undefined]> = [
      ['/workspace-file', { sessionId: '' }],
      ['/canvas-cwd', undefined],
      ['/visible-b-cwd', { sessionId: 'visible-a' }],
      ['/visible-b-cwd', { sessionId: 'visible-a', unrestricted: true }],
    ]
    for (const [path, access] of rejectedCases) {
      await expect(listHandler({}, path, access)).rejects.toThrow('Agent 会话不存在')
    }
    expect(resolveCallCount).toBe(0)
    expect(listCallCount).toBe(0)

    await expect(listHandler({}, '/workspace-file')).resolves.toEqual([])
    await expect(listHandler({}, '/tmp-file')).resolves.toEqual([])
    expect(resolveCallCount).toBe(2)
    expect(listCallCount).toBe(2)

    const readHandlerNode = handlers.find(({ channel }) => channel === 'READ_ATTACHED_FILE')
    expect(readHandlerNode).toBeDefined()
    const readHandler = compileHandler<(
      event: object,
      path: string,
      sessionId?: string,
      workspaceSlug?: string,
    ) => Promise<string>>(readHandlerNode!, {
      requireVisibleFileAccess,
      requireVisibleFileReadAccess: (access: FileAccessOptions | undefined, path: string) => {
        requireVisibleFileAccess(access, [path])
        return { authorizedFiles: new Map() }
      },
    })
    await expect(readHandler({}, '/workspace-file', '')).rejects.toThrow('Agent 会话不存在')
    await expect(readHandler({}, '/canvas-cwd')).rejects.toThrow('Agent 会话不存在')
    await expect(readHandler({}, '/visible-b-cwd', 'visible-a')).rejects.toThrow('Agent 会话不存在')
    expect(resolveCallCount).toBe(2)
    expect(listCallCount).toBe(2)
  })

  test('Given 文件授权后叶子或祖先被替换 When 稳定读取 Then 不消费替换后的对象', () => {
    const { source } = loadAgentHandlers()
    const root = mkdtempSync(join(tmpdir(), 'proma-renderer-file-race-'))
    try {
      const captureStablePathIdentity = compileLocalFunction<(path: string) => { dev: number, ino: number }>(source, 'captureStablePathIdentity', { lstatSync })
      const assertStablePathIdentity = compileLocalFunction<(path: string, identity: { dev: number, ino: number }) => void>(source, 'assertStablePathIdentity', { lstatSync })
      const sharedDependencies = { resolve, dirname, captureStablePathIdentity, assertStablePathIdentity, existsSync }
      const readStableFile = compileLocalFunction<(path: string, maxSize: number, hook?: () => void) => Buffer>(source, 'readStableFile', {
        ...sharedDependencies, openSync, constants, fstatSync, readFileSync, closeSync,
      })
      const authorized = join(root, 'authorized.txt')
      const replacement = join(root, 'replacement.txt')
      writeFileSync(authorized, 'authorized')
      writeFileSync(replacement, 'replacement')
      expect(() => readStableFile(authorized, 1024, () => renameSync(replacement, authorized))).toThrow('文件身份已变化')

      const ancestor = join(root, 'ancestor')
      const movedAncestor = join(root, 'ancestor-old')
      const outside = join(root, 'outside')
      mkdirSync(ancestor)
      mkdirSync(outside)
      writeFileSync(join(ancestor, 'secret.txt'), 'authorized')
      writeFileSync(join(outside, 'secret.txt'), 'outside-secret')
      expect(() => readStableFile(join(ancestor, 'secret.txt'), 1024, () => {
        renameSync(ancestor, movedAncestor)
        symlinkSync(outside, ancestor)
      })).toThrow('文件身份已变化')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('Given requestId 响应与 pending 快照入口 When 检查顶层执行路径 Then owner 校验先于消费且快照过滤不可见 owner', () => {
    const { handlers } = loadAgentHandlers()
    for (const channel of OWNER_RESPONSE_CHANNELS) {
      const registered = handlers.find((handler) => handler.channel === channel)
      expect(registered, `${channel} 未注册`).toBeDefined()
      const calls = collectTopLevelExecutionCalls(registered!.handler.body).map(getCallName)
      const ownerIndex = calls.findIndex((name) => name.endsWith('.getPendingRequestOwner'))
      const guardIndex = calls.indexOf('requireVisibleSession')
      const respondIndex = calls.findIndex((name) => name.includes('respondTo'))
      expect(ownerIndex, `${channel} 缺少只读 owner 查询`).toBeGreaterThanOrEqual(0)
      expect(guardIndex, `${channel} 缺少 owner 可见性校验`).toBeGreaterThan(ownerIndex)
      expect(respondIndex, `${channel} 在校验前消费了请求`).toBeGreaterThan(guardIndex)
    }

    for (const channel of FILTERED_SNAPSHOT_CHANNELS) {
      const registered = handlers.find((handler) => handler.channel === channel)
      expect(registered, `${channel} 未注册`).toBeDefined()
      const calls = collectTopLevelExecutionCalls(registered!.handler.body).map(getCallName)
      expect(calls).toContain('getUserVisiblePendingRequests')
    }
  })

  test('Given pending 过滤读取会话索引故障 When 构造快照 Then 异常向上抛而非吞掉请求', () => {
    const { source } = loadAgentHandlers()
    const createVisibleSessionIdSet = compileLocalFunction<() => Set<string>>(
      source,
      'createVisibleSessionIdSet',
      {
        listAgentSessions: () => { throw new Error('会话索引读取失败') },
        isAgentSessionUserVisible: () => true,
      },
    )

    expect(() => createVisibleSessionIdSet()).toThrow('会话索引读取失败')
  })

  test('Given 默认应用查询创建授权快照失败 When 执行真实 handler Then 存储异常向上抛', async () => {
    const { handlers } = loadAgentHandlers()
    const registered = handlers.find((handler) => handler.channel === 'GET_DEFAULT_APP_FOR_FILE')
    expect(registered).toBeDefined()
    const handler = compileHandler<(event: object, filePath: string) => Promise<unknown>>(registered!, {
      requireVisibleFileAccess: () => { throw new Error('会话索引读取失败') },
    })

    await expect(handler({}, '/workspace/file.ts')).rejects.toThrow('会话索引读取失败')
  })

  test('Given 三类 pending 请求 When 执行真实快照 handler Then session 索引仅扫描一次并复用 visible ID Set', async () => {
    const { handlers } = loadAgentHandlers()
    const registered = handlers.find((handler) => handler.channel === 'GET_PENDING_REQUESTS')
    expect(registered).toBeDefined()
    let sessionScanCount = 0
    const pending = [{ sessionId: 'visible' }, { sessionId: 'canvas' }]
    const handler = compileHandler<(event: object) => Promise<{ permissions: unknown[], askUsers: unknown[], exitPlans: unknown[] }>>(
      registered!,
      {
        createVisibleSessionIdSet: () => {
          sessionScanCount += 1
          return new Set(['visible'])
        },
        getUserVisiblePendingRequests: (requests: Array<{ sessionId: string }>, visibleIds: Set<string>) => (
          requests.filter((request) => visibleIds.has(request.sessionId))
        ),
        permissionService: { getPendingRequests: () => pending },
        askUserService: { getPendingRequests: () => pending },
        exitPlanService: { getPendingRequests: () => pending },
      },
    )

    const result = await handler({})
    expect(sessionScanCount).toBe(1)
    expect(result.permissions).toEqual([{ sessionId: 'visible' }])
    expect(result.askUsers).toEqual([{ sessionId: 'visible' }])
    expect(result.exitPlans).toEqual([{ sessionId: 'visible' }])
  })

  test.each([
    ['PERMISSION_RESPOND', 'permissionService', 'respondToPermission'],
    ['ASK_USER_RESPOND', 'askUserService', 'respondToAskUser'],
    ['EXIT_PLAN_MODE_RESPOND', 'exitPlanService', 'respondToExitPlanMode'],
  ])('Given %s 的 owner 内部、未知或已删除 When 执行实际 handler Then owner 传入 guard 且请求不消费', async (channel, serviceName, respondName) => {
    const { handlers } = loadAgentHandlers()
    const registered = handlers.find((handler) => handler.channel === channel)
    expect(registered).toBeDefined()

    for (const ownerSessionId of ['canvas-owner', 'unknown-owner', 'deleted-owner']) {
      let guardedSessionId = ''
      let respondCallCount = 0
      const service = {
        getPendingRequestOwner: () => ownerSessionId === 'unknown-owner' ? null : ownerSessionId,
        [respondName]: () => {
          respondCallCount += 1
          return null
        },
      }
      const handler = compileHandler<(event: { sender: { send: () => void } }, response: Record<string, unknown>) => Promise<void>>(
        registered!,
        {
          [serviceName]: service,
          requireVisibleSession: (sessionId: string) => {
            guardedSessionId = sessionId
            throw new Error('Agent 会话不存在')
          },
        },
      )

      await expect(handler(
        { sender: { send: () => undefined } },
        { requestId: 'request-1', answers: {}, behavior: 'allow', alwaysAllow: false, action: 'deny' },
      )).rejects.toThrow('Agent 会话不存在')
      expect(guardedSessionId).toBe(ownerSessionId === 'unknown-owner' ? '' : ownerSessionId)
      expect(respondCallCount).toBe(0)
    }
  })
})
