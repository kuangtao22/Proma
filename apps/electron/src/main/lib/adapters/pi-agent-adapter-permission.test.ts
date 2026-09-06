import { beforeAll, expect, mock, test } from 'bun:test'
import type { ExtensionContext, ToolDefinition } from '@earendil-works/pi-coding-agent'
import type { ServerOpsAgentFacade } from '../server-ops/server-ops-agent-facade'

type PiAdapterModule = typeof import('./pi-agent-adapter')
type PiBuiltinToolsModule = typeof import('./pi-builtin-tools')
let wrapCustomToolDefinitions: PiAdapterModule['wrapCustomToolDefinitions']
let buildServerOpsTools: PiBuiltinToolsModule['buildServerOpsTools']

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

beforeAll(async () => {
  ;({ wrapCustomToolDefinitions } = await import('./pi-agent-adapter'))
  ;({ buildServerOpsTools } = await import('./pi-builtin-tools'))
})

const sdk = {
  defineTool: (definition: ToolDefinition) => definition,
} as typeof import('@earendil-works/pi-coding-agent')

test('Given 真实 Pi custom tool wrapper When updatedInput 篡改 hostId Then 权限参数被记录但 Facade 授权边界仍拒绝', async () => {
  const statusCalls: string[] = []
  const facade = {
    status: ({ hostId }: { hostId: string }) => {
      statusCalls.push(hostId)
      if (hostId !== 'host-1') throw new Error('SERVER_OPS_AGENT_ACCESS_REQUIRED')
      return { hostId, phase: 'connected' as const }
    },
  } as ServerOpsAgentFacade
  const permissionCalls: Array<{ toolName: string; input: Record<string, unknown>; toolUseID: string }> = []
  const wrapped = wrapCustomToolDefinitions(buildServerOpsTools(sdk, facade), async (toolName, input, options) => {
    permissionCalls.push({ toolName, input, toolUseID: options.toolUseID })
    return { behavior: 'allow', updatedInput: { ...input, hostId: 'host-2' } }
  })
  const statusTool = wrapped.find((tool) => tool.name === 'server_status')!

  await expect(statusTool.execute(
    'tool-use-1', { hostId: 'host-1' }, new AbortController().signal,
    undefined, {} as ExtensionContext,
  )).rejects.toThrow('SERVER_OPS_AGENT_ACCESS_REQUIRED')
  expect(permissionCalls).toEqual([{
    toolName: 'server_status', input: { hostId: 'host-1' }, toolUseID: 'tool-use-1',
  }])
  expect(statusCalls).toEqual(['host-2'])
})
