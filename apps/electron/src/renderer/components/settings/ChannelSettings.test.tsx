import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import type { Channel } from '@proma/shared'
import * as channelSettingsModule from './ChannelSettings'

/** 设置页加载状态测试期望的新模块合同。 */
interface ExpectedChannelSettingsModule {
  reduceChannelSettingsLoadState: (
    state: { channels: Channel[]; error: string | null },
    action:
      | { type: 'load-succeeded'; channels: Channel[] }
      | { type: 'load-failed'; message: string },
  ) => { channels: Channel[]; error: string | null }
}

/** RED 阶段通过可选合同访问待实现导出，确保失败来自缺少目标行为。 */
function getExpectedModule(): ExpectedChannelSettingsModule {
  return channelSettingsModule as unknown as ExpectedChannelSettingsModule
}

/** 创建设置页状态测试使用的存量渠道。 */
function createExistingChannel(): Channel {
  return {
    id: 'existing-channel',
    name: '现有渠道',
    provider: 'custom',
    baseUrl: 'https://example.com/v1/chat/completions',
    apiKey: 'encrypted-key',
    models: [{ id: 'existing-model', name: 'Existing Model', enabled: true }],
    enabled: true,
    createdAt: 1,
    updatedAt: 1,
  }
}

test('Given 已显示存量渠道 When 刷新加载失败 Then 保留渠道并展示真实错误', () => {
  /** 待验证的渠道设置状态归约器。 */
  const { reduceChannelSettingsLoadState } = getExpectedModule()
  /** 加载失败前已经成功显示的渠道。 */
  const existingChannel = createExistingChannel()

  /** 加载失败后的界面状态。 */
  const state = reduceChannelSettingsLoadState(
    { channels: [existingChannel], error: null },
    { type: 'load-failed', message: '读取渠道配置失败' },
  )

  expect(state.channels).toEqual([existingChannel])
  expect(state.error).toBe('读取渠道配置失败')
})

test('Given 上次加载失败 When 重试成功 Then 替换渠道并清除错误', () => {
  /** 待验证的渠道设置状态归约器。 */
  const { reduceChannelSettingsLoadState } = getExpectedModule()
  /** 重试成功后服务端返回的新渠道。 */
  const nextChannel = { ...createExistingChannel(), id: 'next-channel' }

  /** 重试成功后的界面状态。 */
  const state = reduceChannelSettingsLoadState(
    { channels: [], error: '读取渠道配置失败' },
    { type: 'load-succeeded', channels: [nextChannel] },
  )

  expect(state.channels).toEqual([nextChannel])
  expect(state.error).toBeNull()
})

test('Given 设置列表 When 渲染模型配置 Then 生图设置位于渠道区块之后', () => {
  const source = readFileSync(new URL('./ChannelSettings.tsx', import.meta.url), 'utf8')
  expect(source.indexOf('title="模型配置"'))
    .toBeLessThan(source.indexOf('<ImageGenerationModelSettings />'))
  expect(source).toContain('<ImageGenerationModelSettings />')
})
