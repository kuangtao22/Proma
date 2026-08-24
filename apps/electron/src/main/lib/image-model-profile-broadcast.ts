import { DESIGN_IPC_CHANNELS } from '@proma/shared'

/** 接收无敏感 payload 模型目录变化事件的最小窗口能力。 */
export interface ImageModelProfileBroadcastTarget {
  isDestroyed: () => boolean
  send: (channel: string, value?: unknown) => void
}

interface UpdateToolCredentialsWithImageModelBroadcastInput {
  /** 当前被更新的 Chat 工具 ID。 */
  toolId: string
  /** 仅交给凭据持久化函数，不进入广播。 */
  credentials: Record<string, string>
  /** 主进程现有凭据持久化边界。 */
  updateCredentials: (toolId: string, credentials: Record<string, string>) => void | Promise<void>
  /** 列出本次应接收无 payload 通知的相关窗口。 */
  listTargets: () => ImageModelProfileBroadcastTarget[]
}

interface ChannelMutationWithImageModelBroadcastInput<Result> {
  /** 执行渠道创建、更新或删除事务，并返回原始结果。 */
  mutate: () => Result | Promise<Result>
  /** 列出本次应接收无 payload 通知的相关窗口。 */
  listTargets: () => ImageModelProfileBroadcastTarget[]
}

/** 向全部存活窗口广播既有模型目录变化事件，不携带任何凭据或目录内容。 */
export function broadcastImageModelProfilesChanged(
  targets: readonly ImageModelProfileBroadcastTarget[],
): void {
  for (const target of targets) {
    if (target.isDestroyed()) continue
    try {
      target.send(DESIGN_IPC_CHANNELS.IMAGE_MODEL_PROFILES_CHANGED)
    } catch (error) {
      console.error('[DesignIPC] 生图模型目录变化广播失败:', error)
    }
  }
}

/** 成功保存 Nano Banana 凭据后统一触发跨窗口模型可用性刷新。 */
export async function updateToolCredentialsWithImageModelBroadcast(
  input: UpdateToolCredentialsWithImageModelBroadcastInput,
): Promise<void> {
  await input.updateCredentials(input.toolId, input.credentials)
  if (input.toolId !== 'nano-banana') return
  broadcastImageModelProfilesChanged(input.listTargets())
}

/** 只在渠道事务成功后通知 Renderer 重算生图 profile 可用性。 */
export async function runChannelMutationWithImageModelBroadcast<Result>(
  input: ChannelMutationWithImageModelBroadcastInput<Result>,
): Promise<Result> {
  /** 保留渠道管理器的原始返回值和错误语义。 */
  const result = await input.mutate()
  broadcastImageModelProfilesChanged(input.listTargets())
  return result
}
