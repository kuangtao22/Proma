import { describe, expect, test } from 'bun:test'
import { DESIGN_IPC_CHANNELS } from '@proma/shared'
import * as broadcastModule from './image-model-profile-broadcast'

/** 创建广播测试使用的窗口发送目标。 */
function createTarget(id: number, destroyed = false): {
  id: number
  isDestroyed: () => boolean
  send: (channel: string, value?: unknown) => void
  sent: Array<{ channel: string; value?: unknown }>
} {
  /** 记录目标收到的通道和 payload。 */
  const sent: Array<{ channel: string; value?: unknown }> = []
  return {
    id,
    isDestroyed: () => destroyed,
    send: (channel, value) => { sent.push({ channel, value }) },
    sent,
  }
}

describe('image model profile broadcast', () => {
  test('Given Nano Banana 凭据成功持久化 When 更新工具凭据 Then 两个窗口收到无凭据事件', async () => {
    const { updateToolCredentialsWithImageModelBroadcast } = broadcastModule
    /** 两个仍存活的相关窗口。 */
    const targets = [createTarget(1), createTarget(2)]
    /** 记录主进程是否先完成凭据持久化。 */
    const calls: string[] = []

    await updateToolCredentialsWithImageModelBroadcast({
      toolId: 'nano-banana',
      credentials: { apiKey: 'secret', model: 'legacy-model' },
      updateCredentials: () => { calls.push('saved') },
      listTargets: () => targets,
    })

    expect(calls).toEqual(['saved'])
    for (const target of targets) {
      expect(target.sent).toEqual([{
        channel: DESIGN_IPC_CHANNELS.IMAGE_MODEL_PROFILES_CHANGED,
        value: undefined,
      }])
      expect(JSON.stringify(target.sent)).not.toContain('secret')
    }
  })

  test('Given 非 Nano Banana 凭据或持久化失败 When 更新 Then 不广播模型目录变化', async () => {
    const { updateToolCredentialsWithImageModelBroadcast } = broadcastModule
    /** 记录任何不应发生的广播。 */
    const target = createTarget(1)

    await updateToolCredentialsWithImageModelBroadcast({
      toolId: 'web-search',
      credentials: { apiKey: 'secret' },
      updateCredentials: () => undefined,
      listTargets: () => [target],
    })
    expect(target.sent).toEqual([])

    expect(updateToolCredentialsWithImageModelBroadcast({
      toolId: 'nano-banana',
      credentials: { apiKey: 'secret' },
      updateCredentials: () => { throw new Error('持久化失败') },
      listTargets: () => [target],
    })).rejects.toThrow('持久化失败')
    expect(target.sent).toEqual([])
  })
})
