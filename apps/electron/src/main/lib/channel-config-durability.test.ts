import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import * as os from 'node:os'
import { dirname, join } from 'node:path'
import * as safeFileModule from './safe-file'

type ChannelManagerModule = typeof import('./channel-manager')

/** 动态加载的渠道管理模块，确保测试先安装文件系统与 Electron mock。 */
let channelManager: ChannelManagerModule
/** 每个测试独占的模拟用户目录。 */
let tempHome: string
/** 控制原子写 mock 是否模拟持久化失败。 */
let atomicWriteError: Error | undefined
/** 进入测试前的 HOME，用于结束时恢复进程环境。 */
const originalHome = process.env.HOME
/** 进入测试前的开发模式标记，用于结束时恢复进程环境。 */
const originalPromaDev = process.env.PROMA_DEV

mock.module('electron', () => ({
  app: {
    isPackaged: true,
    getPath: () => join(process.env.HOME ?? tempHome, 'Library', 'Application Support'),
  },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (value: string) => Buffer.from(value),
    decryptString: (value: Buffer) => value.toString('utf-8'),
  },
  shell: {
    openExternal: async () => undefined,
  },
}))

mock.module('node:os', () => ({
  ...os,
  homedir: () => tempHome,
}))

mock.module('./safe-file', () => ({
  ...safeFileModule,
  /** 模拟原子 JSON 写入，并允许测试精确注入持久化异常。 */
  writeJsonFileAtomic: (filePath: string, value: unknown): void => {
    if (atomicWriteError) throw atomicWriteError
    mkdirSync(dirname(filePath), { recursive: true })
    writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf-8')
  },
}))

/** 返回测试渠道配置文件路径。 */
function getChannelsPath(): string {
  return join(tempHome, '.proma', 'channels.json')
}

/** 写入指定的渠道配置原文，用于构造升级和损坏场景。 */
function writeChannelsSource(source: string): void {
  /** 当前测试使用的渠道配置路径。 */
  const configPath = getChannelsPath()
  mkdirSync(dirname(configPath), { recursive: true })
  writeFileSync(configPath, source, 'utf-8')
}

beforeAll(async () => {
  tempHome = mkdtempSync(join(os.tmpdir(), 'proma-channel-config-durability-'))
  process.env.HOME = tempHome
  process.env.PROMA_DEV = '0'
  channelManager = await import('./channel-manager')
})

beforeEach(() => {
  atomicWriteError = undefined
  rmSync(join(tempHome, '.proma'), { recursive: true, force: true })
})

afterAll(() => {
  if (originalHome === undefined) {
    delete process.env.HOME
  } else {
    process.env.HOME = originalHome
  }
  if (originalPromaDev === undefined) {
    delete process.env.PROMA_DEV
  } else {
    process.env.PROMA_DEV = originalPromaDev
  }
  rmSync(tempHome, { recursive: true, force: true })
})

describe('渠道配置持久化失败保护', () => {
  test('Given 旧渠道可解析但迁移回写失败 When 加载列表 Then 保留旧渠道且不写入预设', () => {
    /** 模拟覆盖安装前已经存在的自定义渠道配置。 */
    const source = JSON.stringify({
      version: 2,
      channels: [{
        id: 'existing-channel',
        name: '现有自定义渠道',
        provider: 'custom',
        baseUrl: 'https://example.com/v1/chat/completions',
        apiKey: 'encrypted-key',
        models: [{ id: 'existing-model', name: 'Existing Model', enabled: true }],
        enabled: true,
        createdAt: 1,
        updatedAt: 1,
      }],
    })
    writeChannelsSource(source)
    atomicWriteError = new Error('模拟迁移回写失败')

    /** 回写失败后仍应交付给界面的原渠道列表。 */
    const channels = channelManager.listChannels()

    expect(channels.map((channel) => channel.id)).toEqual(['existing-channel'])
    expect(readFileSync(getChannelsPath(), 'utf-8')).toBe(source)
  })

  test('Given 渠道配置无法解析 When 加载列表 Then 抛出真实错误且不覆盖原文件', () => {
    /** 模拟被中断或外部程序破坏的配置原文。 */
    const source = '{"version":5,"channels":['
    writeChannelsSource(source)

    expect(() => channelManager.listChannels()).toThrow('读取渠道配置失败')
    expect(readFileSync(getChannelsPath(), 'utf-8')).toBe(source)
  })
})
