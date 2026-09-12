import { beforeAll, describe, expect, mock, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
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
  test('Given 文件与 Docker 服务已接通 When 构建工具 Then 只公开受限字段且内部运行不注册新能力', async () => {
    /** 用已存在的窄 Facade 方法证明能力按真实服务注册。 */
    const facade = {
      filesList: async () => ({ hostId: 'host-1', path: '/', entries: [] }),
      filesRead: async () => { throw new Error('unused') },
      filesMutate: async () => { throw new Error('unused') },
      dockerResources: async () => { throw new Error('unused') },
      dockerDetail: async () => { throw new Error('unused') },
      dockerAction: async () => { throw new Error('unused') },
    } as unknown as ServerOpsAgentFacade
    const tools = buildServerOpsTools(sdk, facade)
    expect(tools.map((tool) => tool.name)).toEqual([
      'server_list', 'server_status', 'server_connect', 'server_exec', 'server_disconnect',
      'server_docker_resources', 'server_docker_detail', 'server_docker_action',
      'server_files_list', 'server_files_read', 'server_files_mutate',
    ])
    const schemas = JSON.stringify(tools.slice(5).map((tool) => tool.parameters))
    expect(schemas).not.toMatch(/sessionId|credentialRef|ownerKey|connectionId|candidateId|localPath/)
    expect(schemas).toContain('editToken')
    const internal = await buildPiBuiltinTools(sdk, {
      sessionId: 'session-1', channelId: 'channel-1', triggeredBy: 'automation', serverOpsFacade: facade,
      productivityTools: { todosEnabled: false, calendarEnabled: false, obsidianEnabled: false },
    })
    expect(internal.tools.some((tool) => tool.name.startsWith('server_'))).toBe(false)
  })
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

describe('Pi 图片工具运行上下文', () => {
  test('Given Host 固化参考图和请求审计 When 构建 Nano 工具 Then 适配层完整透传两个字段', () => {
    const source = readFileSync(join(import.meta.dir, 'pi-builtin-tools.ts'), 'utf8')
    const start = source.indexOf("  if (ctx.trustedImageRoute || isBuiltinMcpUserEnabled('nano-banana'))")
    const body = source.slice(start, source.indexOf('\n  const cloudTools', start))

    expect(body).toContain('trustedReferenceImagePaths: ctx.trustedReferenceImagePaths')
    expect(body).toContain('trustedImageParameters: ctx.trustedImageParameters')
    expect(body).toContain('captureDesignImageRequest: ctx.captureDesignImageRequest')
  })
})
