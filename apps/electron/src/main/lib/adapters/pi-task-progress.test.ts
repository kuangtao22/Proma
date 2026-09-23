import { beforeAll, describe, expect, mock, test } from 'bun:test'

type PiAdapterModule = typeof import('./pi-agent-adapter')
let resolvePromaTaskId: PiAdapterModule['resolvePromaTaskId']

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
  ;({ resolvePromaTaskId } = await import('./pi-agent-adapter'))
})

describe('Pi 任务标识', () => {
  test('Given TaskCreate 未显式传入 ID When Pi 执行工具 Then 使用稳定 toolCallId 关联结果和后续更新', () => {
    expect(resolvePromaTaskId({ subject: '检查实现' }, 'tool-call-stable')).toBe('tool-call-stable')
  })

  test('Given 旧格式 TaskCreate 显式传入 ID When Pi 执行工具 Then 保留旧调用兼容', () => {
    expect(resolvePromaTaskId({ taskId: 'legacy-task' }, 'tool-call-stable')).toBe('legacy-task')
  })
})
