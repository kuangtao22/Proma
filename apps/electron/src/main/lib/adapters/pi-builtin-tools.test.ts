import { beforeAll, describe, expect, mock, test } from 'bun:test'
import type { ToolDefinition } from '@earendil-works/pi-coding-agent'
import type { ServerOpsAgentFacade } from '../server-ops/server-ops-agent-facade'

type PiBuiltinToolsModule = typeof import('./pi-builtin-tools')
let buildServerOpsTools: PiBuiltinToolsModule['buildServerOpsTools']
let buildPiBuiltinTools: PiBuiltinToolsModule['buildPiBuiltinTools']

mock.module('electron', () => ({
  app: { isPackaged: false, getPath: () => '/tmp', getName: () => 'Proma Test' },
  BrowserWindow: { getAllWindows: () => [] },
  WebContentsView: class {},
  MessageChannelMain: class {},
  utilityProcess: {},
  ipcMain: { handle: () => undefined, removeHandler: () => undefined },
  shell: { openExternal: async () => undefined, openPath: async () => '' },
  dialog: {}, clipboard: {}, nativeImage: {}, screen: {}, globalShortcut: {},
  powerSaveBlocker: {}, powerMonitor: {}, systemPreferences: {}, Menu: {},
  Notification: class {},
  net: {},
  session: {},
  safeStorage: { isEncryptionAvailable: () => false },
  default: {},
}))

mock.module('../web-search-service', () => ({
  fetchWebPage: async () => ({}),
  formatFetchResults: () => '',
  formatSearchResults: () => '',
  isWebSearchEnabledForAgent: () => false,
  searchWeb: async () => ({}),
}))

mock.module('../builtin-mcp/settings', () => ({
  isBuiltinMcpDefaultDisabled: () => false,
  isBuiltinMcpUserEnabled: () => false,
  setBuiltinMcpUserEnabled: () => undefined,
}))

mock.module('../vision-relay-service', () => ({
  getVisionRelayRouteLabel: () => '',
  inspectImageWithVisionRelay: async () => ({}),
  isVisionRelayConfigured: () => false,
  isVisionRelayEligibleForModel: () => false,
}))

beforeAll(async () => {
  ;({ buildServerOpsTools, buildPiBuiltinTools } = await import('./pi-builtin-tools'))
})

const sdk = {
  defineTool: (definition: ToolDefinition) => definition,
} as typeof import('@earendil-works/pi-coding-agent')

describe('Pi Server Ops 工具合同', () => {
  test('Given 已初始化 facade When 构建工具 Then 只注册五个无 sessionId/credentialRef 输入的工具', () => {
    const facade = {} as ServerOpsAgentFacade
    const tools = buildServerOpsTools(sdk, facade)

    expect(tools.map((tool) => tool.name)).toEqual([
      'server_list', 'server_status', 'server_connect', 'server_exec', 'server_disconnect',
    ])
    expect(JSON.stringify(tools.map((tool) => tool.parameters))).not.toMatch(/sessionId|credentialRef|candidateId/)
  })

  test.each([
    [undefined, true],
    ['user', true],
    ['automation', false],
    ['delegation', false],
    ['external', false],
  ] as const)('Given triggeredBy=%s 且错误传入 facade When 构建内置工具 Then Server Ops 注册状态为 %s', async (triggeredBy, expected) => {
    const result = await buildPiBuiltinTools(sdk, {
      sessionId: 'session-1',
      channelId: 'channel-1',
      triggeredBy,
      serverOpsFacade: {} as ServerOpsAgentFacade,
      productivityTools: { todosEnabled: false, calendarEnabled: false, obsidianEnabled: false },
    })
    const registeredNames = result.tools.map((tool) => tool.name)
    expect(registeredNames.includes('server_list')).toBe(expected)
    expect(registeredNames.includes('server_exec')).toBe(expected)
  })
})
