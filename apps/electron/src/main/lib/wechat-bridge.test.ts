import { afterAll, beforeAll, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import * as os from 'node:os'
import { join } from 'node:path'

/** 微信模块类型，用于延迟导入后保持类型检查。 */
type WeChatBridgeModule = typeof import('./wechat-bridge')

/** 模拟用户 home，包含指向离线盘的数据根定位文件。 */
let homeDir: string
/** 动态导入得到的微信模块。 */
let wechatBridgeModule: WeChatBridgeModule

mock.module('node:os', () => ({
  ...os,
  homedir: () => homeDir,
}))

mock.module('electron', () => ({
  app: { isPackaged: true },
  BrowserWindow: { getAllWindows: () => [] },
  clipboard: {},
  dialog: {},
  nativeImage: { createFromPath: () => ({}) },
  nativeTheme: {},
  powerMonitor: {},
  powerSaveBlocker: {},
  screen: {},
  shell: {},
  utilityProcess: {},
  MessageChannelMain: class {},
  net: {},
  session: {},
  WebContentsView: class {},
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (value: string) => Buffer.from(value),
    decryptString: (value: Buffer) => value.toString('utf-8'),
  },
}))

beforeAll(async () => {
  homeDir = mkdtempSync(join(os.tmpdir(), 'proma-wechat-offline-root-'))
  /** 定位文件合法，但活动根不存在，模拟移动盘离线。 */
  const offlineRoot = join(homeDir, 'offline-volume', 'Proma Data')
  writeFileSync(
    join(homeDir, '.proma-location.json'),
    JSON.stringify({ version: 1, activeRoot: offlineRoot }),
    'utf-8',
  )
  wechatBridgeModule = await import('./wechat-bridge')
})

afterAll(() => {
  rmSync(homeDir, { recursive: true, force: true })
})

test('Given 自定义数据根离线 When 仅导入微信业务模块 Then 不抢跑读取业务路径', () => {
  expect(wechatBridgeModule.wechatBridge.getStatus()).toEqual({ status: 'disconnected' })
})
